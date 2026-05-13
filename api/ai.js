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
    const hfKey       = process.env.HF_API_KEY;

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

    // ---------- EXECUTION CHAIN ----------
    const errorLog = [];

    // For vision: vision-capable engines first
    let engines;
    if (isVision) {
        engines = [
            { name: 'Gemini',  fn: fetchGemini },
            { name: 'Ollama',  fn: fetchOllama },
            { name: 'Groq',    fn: fetchGroq }
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

    // Honour preferredProvider hint by moving it to the front
    if (preferredProvider) {
        const pref = String(preferredProvider).toLowerCase();
        engines.sort((a, b) => {
            const aMatch = a.name.toLowerCase() === pref ? -1 : 0;
            const bMatch = b.name.toLowerCase() === pref ? -1 : 0;
            return aMatch - bMatch;
        });
    }

    for (const engine of engines) {
        try {
            console.log(`[AI] Attempting ${engine.name}…`);
            const result = await engine.fn();
            console.log(`[AI] ✓ ${engine.name} succeeded`);
            return res.status(200).json({ reply: result.reply, provider: result.provider });
        } catch (e) {
            console.warn(`[AI] ${engine.name} failed:`, e.message);
            errorLog.push(`${engine.name}: ${e.message}`);
        }
    }

    return res.status(503).json({
        error: 'All AI providers are temporarily unavailable.',
        details: errorLog.join(' | ')
    });
}
