// ==================== WealthFlow AI Engine v6.5 ====================
// Multi-provider AI brain with automatic failover.
// Now with proper Ollama Cloud authentication, expanded vision support,
// and improved error reporting for the new receipt-scanner module.
//
// All API keys MUST be configured as Vercel Environment Variables:
//   - WealthFlow_API_Key       (Gemini) — primary
//   - DEEPSEEK_API_KEY         (DeepSeek) — text fallback
//   - GROQ_API_KEY             (Groq Llama 3.3 + Llava vision)
//   - OLLAMA_API_KEY           (Ollama Cloud — vision + text)
//   - HF_API_KEY               (HuggingFace inference, optional)
//
// Notes on Ollama Cloud:
//   The correct endpoint for hosted models on ollama.com is https://ollama.com/api/chat
//   with `Authorization: Bearer $OLLAMA_API_KEY`. The chat API accepts `images` (base64
//   array) inside the `messages[].images` field for vision models.

export const config = {
    maxDuration: 45 // seconds — long enough for deep responses
};

// ----- Embedded fallback Ollama key (project key supplied by the project owner)
// This is intentionally low-trust: it works for low-volume use, but if you want
// production-grade limits, set OLLAMA_API_KEY in Vercel and it'll take precedence.
const OLLAMA_FALLBACK_KEY = 'f2e8db440e7e4028a40a0aefbf8dbec5.7efl7SycTPjEwR645yJmxTs1';

// Helper: fetch with timeout — prevents one slow provider from blocking the chain
async function fetchWithTimeout(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req, res) {
    // CORS — allow the public Vercel deployment to be called from anywhere
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { prompt, image, temperature, maxTokens, preferredProvider } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    // Pull keys ONLY from environment (Ollama has an embedded fallback)
    const geminiKey   = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const groqKey     = process.env.GROQ_API_KEY;
    const ollamaKey   = process.env.OLLAMA_API_KEY || OLLAMA_FALLBACK_KEY;
    const hfKey       = process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY || process.env.HF_TOKEN;

    // Vision requests need deterministic output (low temp) and more room for detail
    const isVision = !!image;
    const temp   = (typeof temperature === 'number') ? temperature : (isVision ? 0.05 : 0.7);
    const tokens = (typeof maxTokens   === 'number') ? maxTokens   : (isVision ? 4096 : 2500);

    // ---------- ENGINE 1: GEMINI (Primary, supports vision) ----------
    async function fetchGemini() {
        if (!geminiKey) throw new Error('Gemini key not configured');
        const model = isVision ? 'gemini-2.5-flash' : 'gemini-2.0-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

        const parts = [{ text: prompt }];
        if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });

        const generationConfig = { temperature: temp, maxOutputTokens: tokens };
        // If the prompt asks for JSON, hint the model to enforce it
        if (/\{[^}]*"vendor"[^}]*\}/i.test(prompt) || /return only.*json/i.test(prompt)) {
            generationConfig.responseMimeType = 'application/json';
        }

        const response = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts }],
                generationConfig,
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
                ]
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Gemini status ${response.status}: ${errText.substring(0, 200)}`);
        }

        const data = await response.json();
        if (data.promptFeedback?.blockReason) throw new Error('Blocked by Google Safety');
        const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return { reply: text, provider: `gemini:${model}` };
        throw new Error('Gemini returned an empty response');
    }

    // ---------- ENGINE 2: DEEPSEEK (Fallback, text-only) ----------
    async function fetchDeepSeek() {
        if (image) throw new Error('DeepSeek skipped (text-only)');
        if (!deepseekKey) throw new Error('DeepSeek key not configured');

        const response = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${deepseekKey}`
            },
            body: JSON.stringify({
                model: 'deepseek-chat',
                messages: [{ role: 'user', content: prompt }],
                temperature: temp,
                max_tokens: tokens
            })
        });

        if (!response.ok) throw new Error(`DeepSeek status ${response.status}`);
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('DeepSeek returned empty');
        return { reply: text, provider: 'deepseek' };
    }

    // ---------- ENGINE 3: GROQ (ultra-fast text + vision via Llava) ----------
    async function fetchGroq() {
        if (!groqKey) throw new Error('Groq key not configured');

        // Build payload — text-only vs vision differ
        let payload;
        if (image) {
            payload = {
                model: 'llama-3.2-90b-vision-preview',
                messages: [{
                    role: 'user',
                    content: [
                        { type: 'text', text: prompt },
                        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                    ]
                }],
                temperature: temp,
                max_tokens: Math.min(tokens, 2048)
            };
        } else {
            payload = {
                model: 'llama-3.3-70b-versatile',
                messages: [{ role: 'user', content: prompt }],
                temperature: temp,
                max_tokens: tokens
            };
        }

        const response = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${groqKey}` },
            body: JSON.stringify(payload)
        });

        if (!response.ok) throw new Error(`Groq status ${response.status}`);
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('Groq returned empty');
        return { reply: text, provider: image ? 'groq:llava' : 'groq:llama-3.3' };
    }

    // ---------- ENGINE 4: OLLAMA CLOUD (vision + text, hosted) ----------
    // Correct endpoint for the *hosted* ollama.com API:
    //   POST https://ollama.com/api/chat   (Authorization: Bearer ...)
    // Note: model names like "gpt-oss:120b" or "llama3.2-vision:11b" work directly here.
    async function fetchOllama() {
        if (!ollamaKey) throw new Error('Ollama key not configured');

        const message = { role: 'user', content: prompt };
        if (image) message.images = [image];

        // Pick the right model: vision-capable for images, text-only otherwise
        const model = image ? 'llama3.2-vision' : 'gpt-oss:120b';

        const response = await fetchWithTimeout('https://ollama.com/api/chat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${ollamaKey}`
            },
            body: JSON.stringify({
                model,
                messages: [message],
                stream: false,
                // Suggest JSON output if the prompt hints at it
                ...(/return only.*json|extract.*json/i.test(prompt) ? { format: 'json' } : {}),
                options: { temperature: temp, num_predict: Math.min(tokens, 4096) }
            })
        });

        if (!response.ok) {
            const errText = await response.text().catch(() => '');
            throw new Error(`Ollama status ${response.status}: ${errText.substring(0, 200)}`);
        }
        const data = await response.json();
        const text = data.message?.content;
        if (!text) throw new Error('Ollama returned empty');
        return { reply: text, provider: `ollama:${model}` };
    }

    // ---------- ENGINE 5: HuggingFace Inference (optional, last resort) ----------
    async function fetchHuggingFace() {
        if (!hfKey) throw new Error('HuggingFace key not configured');
        if (image) throw new Error('HF skipped (text-only here)');
        const model = 'meta-llama/Meta-Llama-3-70B-Instruct';
        const response = await fetchWithTimeout(`https://api-inference.huggingface.co/models/${model}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hfKey}` },
            body: JSON.stringify({
                inputs: prompt,
                parameters: { temperature: temp, max_new_tokens: Math.min(tokens, 1024), return_full_text: false }
            })
        });
        if (!response.ok) throw new Error(`HF status ${response.status}`);
        const data = await response.json();
        const text = Array.isArray(data) ? data[0]?.generated_text : data?.generated_text;
        if (!text) throw new Error('HF returned empty');
        return { reply: text, provider: 'huggingface' };
    }

    // ---------- PARALLEL MULTI-ENGINE EXECUTION ----------
    // All engines fire SIMULTANEOUSLY (not one-by-one). This is dramatically
    // faster and more reliable: a slow/down provider no longer blocks the rest.
    //
    //  • mode=fastest  → first valid reply wins (best for chat latency)
    //  • mode=consensus→ collect all replies, pick the best (best for accuracy
    //                     on vision / JSON extraction / critical answers)
    const errorLog = [];

    let engines;
    if (isVision) {
        engines = [
            { name: 'Gemini', fn: fetchGemini },
            { name: 'Ollama', fn: fetchOllama },
            { name: 'Groq',   fn: fetchGroq }
        ];
    } else {
        engines = [
            { name: 'Gemini',   fn: fetchGemini },
            { name: 'DeepSeek', fn: fetchDeepSeek },
            { name: 'Groq',     fn: fetchGroq },
            { name: 'Ollama',   fn: fetchOllama },
            { name: 'HF',       fn: fetchHuggingFace }
        ];
    }

    // Wants JSON (receipt extraction etc.) → use consensus for max accuracy.
    const wantsJSON = /\{[^}]*"vendor"[^}]*\}|return only.*json|extract.*json/i.test(prompt);
    const requestedMode = (req.body && req.body.mode) ? String(req.body.mode) : null;
    const mode = requestedMode || ((isVision || wantsJSON) ? 'consensus' : 'fastest');

    // Wrap each engine call so a rejection becomes a tagged result, never throws.
    function run(engine) {
        const started = Date.now();
        return Promise.resolve()
            .then(() => engine.fn())
            .then(r => ({ ok: true, name: engine.name, reply: r.reply, provider: r.provider, ms: Date.now() - started }))
            .catch(e => {
                console.warn(`[AI] ${engine.name} failed:`, e.message);
                errorLog.push(`${engine.name}: ${e.message}`);
                return { ok: false, name: engine.name, error: e.message, ms: Date.now() - started };
            });
    }

    const isValid = (txt) => typeof txt === 'string' && txt.trim().length > 1;

    // ---- MODE: FASTEST (race — first valid reply wins) ----
    if (mode === 'fastest') {
        const pending = engines.map(run);
        const settled = [];
        // Resolve as soon as ANY engine returns a valid reply.
        const winner = await new Promise((resolve) => {
            let remaining = pending.length;
            pending.forEach(p => p.then(r => {
                settled.push(r);
                if (r.ok && isValid(r.reply)) resolve(r);
                if (--remaining === 0) resolve(null); // all done, none valid
            }));
        });
        if (winner) {
            // Let the remaining engines settle in the background (no-op) — we
            // already have our fast answer.
            return res.status(200).json({
                reply: winner.reply,
                provider: winner.provider,
                mode: 'fastest',
                latencyMs: winner.ms,
                engines: engines.map(e => e.name)
            });
        }
        // Fall through to consensus handling if the race produced nothing.
    }

    // ---- MODE: CONSENSUS (gather all, choose the best) ----
    const results = await Promise.all(engines.map(run));
    const good = results.filter(r => r.ok && isValid(r.reply));

    if (good.length === 0) {
        return res.status(503).json({
            error: 'All AI providers are temporarily unavailable.',
            details: errorLog.join(' | ')
        });
    }

    // Scoring: prefer the response most representative of the set.
    //  • JSON tasks → the one that parses AND agrees with the majority on key fields
    //  • Prose      → the longest substantive answer (proxy for completeness),
    //                 lightly weighted toward faster engines on ties
    function tryParse(s) {
        try {
            const m = s.match(/\{[\s\S]*\}/);
            return m ? JSON.parse(m[0]) : null;
        } catch (_) { return null; }
    }

    let best;
    if (wantsJSON) {
        const parsed = good.map(r => ({ r, j: tryParse(r.reply) })).filter(x => x.j);
        if (parsed.length) {
            // Majority vote on the "amount"/"vendor" fields when present.
            const tally = {};
            parsed.forEach(({ j }) => {
                const key = JSON.stringify([j.amount ?? null, (j.vendor || '').toLowerCase().trim()]);
                tally[key] = (tally[key] || 0) + 1;
            });
            let topKey = null, topN = 0;
            Object.entries(tally).forEach(([k, n]) => { if (n > topN) { topN = n; topKey = k; } });
            const consensusPick = parsed.find(({ j }) =>
                JSON.stringify([j.amount ?? null, (j.vendor || '').toLowerCase().trim()]) === topKey);
            best = (consensusPick || parsed[0]).r;
        } else {
            best = good.sort((a, b) => b.reply.length - a.reply.length)[0];
        }
    } else {
        // Prose: longest substantive wins; tie-break by speed.
        best = good.sort((a, b) => {
            const d = b.reply.trim().length - a.reply.trim().length;
            if (Math.abs(d) > 120) return d;
            return a.ms - b.ms;
        })[0];
    }

    return res.status(200).json({
        reply: best.reply,
        provider: best.provider,
        mode: 'consensus',
        consensusOf: good.length,
        agreement: good.map(r => r.name),
        latencyMs: best.ms
    });
}
