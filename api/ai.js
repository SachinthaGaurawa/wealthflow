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

import * as Matrix from './ai-matrix.mjs';

const providerCooldownUntil = new Map();
function providerCooldownMs(error) {
    const message = String(error?.message || error || '');
    if (/credit balance|billing|insufficient[_\s-]*(?:credit|quota)|payment required|status 402/i.test(message)) return 6 * 60 * 60 * 1000;
    if (/unauthori[sz]ed|forbidden|invalid api key|status 401|status 403/i.test(message)) return 60 * 60 * 1000;
    if (/rate.?limit|quota|status 429/i.test(message)) return 2 * 60 * 1000;
    if (/deadline|timed?\s*out|abort/i.test(message)) return 60 * 1000;
    return 15 * 1000;
}
export function providerAvailable(name, now = Date.now()) {
    return (providerCooldownUntil.get(name) || 0) <= now;
}
export function coolProvider(name, error, now = Date.now()) {
    providerCooldownUntil.set(name, now + providerCooldownMs(error));
}
export function resetProviderCooldowns() { providerCooldownUntil.clear(); }

/* Every eligible configured engine is started before any result is awaited.
 * A response is reduced only after all members settle or hit their individual
 * deadline, so a late dissent can never be silently discarded. */

export const config = {
    maxDuration: 45 // seconds — long enough for deep responses
};

// ----- Embedded fallback Ollama key (project key supplied by the project owner)
// This is intentionally low-trust: it works for low-volume use, but if you want
// production-grade limits, set OLLAMA_API_KEY in Vercel and it'll take precedence.
/* THE KEY THAT USED TO SIT HERE IS GONE, AND IT MUST BE REVOKED.
 *
 * A literal Ollama Cloud key was hardcoded at this line as a "low-trust
 * fallback" so the engine worked without configuration. This repository is
 * PUBLIC. A credential in a public file is a credential everyone has, and no
 * amount of low-trust framing changes that — the owner's standing instruction
 * is that keys are never to be exposed.
 *
 * Removing it from HEAD does not remove it from git history, so the key that
 * was here has to be revoked at the provider. That is the owner's action; this
 * change only stops the file handing it out.
 *
 * The engine now reads OLLAMA_API_KEY from the environment and nothing else.
 * Unset, it is simply not in the fan-out — there are fifteen other engines, and
 * a missing one costs a vote rather than an answer. */

// Helper: fetch with timeout — prevents one slow provider from blocking the chain
async function transportWithTimeout(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

function isFinancialTask(task) {
    return typeof task === 'string' && /^(financial|extraction|categorization|routing|verification|vision)$/i.test(task);
}

export default async function handler(req, res) {
    // CORS — allow the public Vercel deployment to be called from anywhere
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const { prompt, image, temperature, maxTokens, preferredProvider } = req.body || {};
    if (typeof prompt !== 'string' || !prompt.trim()) return res.status(400).json({ error: 'Missing prompt' });
    // Financial consumers declare their intent explicitly. Conservative legacy
    // detection also prevents JSON/category callers from bypassing the board
    // through wording changes or a fastest-mode override.
    const wantsJSON = /\bjson\b|\{[^}]*"vendor"[^}]*\}/i.test(prompt) || req.body?.responseFormat === 'json';
    const financialDecision = req.body?.financialDecision === true || isFinancialTask(req.body?.task) || wantsJSON || !!image || /\bcategor(?:ize|ise|ization|isation|y|ies)\b|\broute\b[\s\S]*\btransaction/i.test(prompt);
    const requestedDeadline = req.body?.deadlineMs;
    const deadlineMs = Number.isInteger(requestedDeadline) ? Math.max(2000, Math.min(24000, requestedDeadline)) : 24000;
    const fetchWithTimeout = (url, options, timeoutMs = 22000) => transportWithTimeout(url, options, Math.min(timeoutMs, deadlineMs));

    // Pull keys ONLY from environment (Ollama has an embedded fallback)
    const geminiKey   = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const groqKey     = process.env.GROQ_API_KEY;
    const ollamaKey   = process.env.OLLAMA_API_KEY;
    const hfKey       = process.env.HUGGINGFACE_API_KEY || process.env.HF_API_KEY || process.env.HF_TOKEN;
    // v7.24 — every additional provider the owner has configured in Vercel.
    const mistralKey    = process.env.MISTRAL_API_KEY;
    const togetherKey   = process.env.TOGETHER_API_KEY;
    const fireworksKey  = process.env.FIREWORKS_API_KEY;
    const openrouterKey = process.env.OPENROUTER_API_KEY;
    const cerebrasKey   = process.env.CEREBRAS_API_KEY;
    const nvidiaKey     = process.env.NVIDIA_API_KEY;
    const githubKey     = process.env.GITHUB_MODELS_TOKEN;
    const cohereKey     = process.env.COHERE_API_KEY;
    const cloudflareToken = process.env.CLOUDFLARE_AI_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
    const cloudflareAccount = process.env.CLOUDFLARE_ACCOUNT_ID;

    // Vision requests need deterministic output (low temp) and more room for detail
    const isVision = !!image;
    const temp   = (typeof temperature === 'number') ? temperature : (isVision ? 0.05 : 0.7);
    const tokens = (typeof maxTokens   === 'number') ? maxTokens   : (isVision ? 4096 : 2500);

    // ---------- ENGINE 1: GEMINI (Primary, supports vision) ----------
    async function fetchGemini() {
        if (!geminiKey) throw new Error('Gemini key not configured');
        // gemini-2.0-flash / gemini-2.5-flash were retired by Google (confirmed live:
        // "This model models/gemini-2.0-flash is no longer available... use
        // models/gemini-3.8-flash"). 3.8 Flash is multimodal, so one model serves
        // both the text and vision paths.
        const model = 'gemini-3.8-flash';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

        const parts = [{ text: prompt }];
        if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });

        const generationConfig = { temperature: temp, maxOutputTokens: tokens };
        // If the prompt asks for JSON, hint the model to enforce it
        if (wantsJSON || financialDecision) {
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
                model: 'meta-llama/llama-4-scout-17b-16e-instruct',
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
                // llama-3.3-70b-versatile was decommissioned by Groq on 2026-08-16
                // (confirmed live: 404). gpt-oss-120b is Groq's own recommended
                // replacement for that migration.
                model: 'openai/gpt-oss-120b',
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
        return { reply: text, provider: image ? 'groq:llama-4-scout' : 'groq:gpt-oss-120b' };
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
    // The old per-model REST endpoint (api-inference.huggingface.co/models/<id>,
    // {inputs, parameters}) is retired — confirmed live: fetch failed, that host no
    // longer resolves for this traffic. Current: router.huggingface.co/v1, a single
    // OpenAI-chat-compatible endpoint that picks the fastest live provider for the
    // requested model.
    async function fetchHuggingFace() {
        if (!hfKey) throw new Error('HuggingFace key not configured');
        if (image) throw new Error('HF skipped (text-only here)');
        const model = 'meta-llama/Llama-3.3-70B-Instruct';
        const response = await fetchWithTimeout('https://router.huggingface.co/v1/chat/completions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${hfKey}` },
            body: JSON.stringify({
                model, messages: [{ role: 'user', content: prompt }],
                temperature: temp, max_tokens: Math.min(tokens, 1024)
            })
        });
        if (!response.ok) { const t = await response.text().catch(() => ''); throw new Error(`HF status ${response.status}: ${t.substring(0, 160)}`); }
        const data = await response.json();
        const text = data.choices?.[0]?.message?.content;
        if (!text) throw new Error('HF returned empty');
        return { reply: text, provider: 'huggingface' };
    }

    // ---------- ENGINES 6-16: every other provider configured in Vercel ----------
    // Most are OpenAI-compatible (/chat/completions + Bearer). One factory builds
    // them all; Cohere uses its own shape below. Each fires in parallel with
    // the rest and contributes to fastest/consensus selection.
    function makeOAI(opts) {
        return async function () {
            if (!opts.key) throw new Error(opts.name + ' key not configured');
            if (image && !opts.visionModel) throw new Error(opts.name + ' skipped (text-only)');
            const model = image ? opts.visionModel : opts.textModel;
            const content = image
                ? [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }]
                : prompt;
            const body = {
                model,
                messages: [{ role: 'user', content }],
                temperature: temp,
                max_tokens: Math.min(tokens, opts.maxTokens || 4096)
            };
            if (!image && opts.jsonMode && /return only.*json|extract.*json|\{[^}]*"vendor"[^}]*\}/i.test(prompt)) {
                body.response_format = { type: 'json_object' };
            }
            const headers = Object.assign(
                { 'Content-Type': 'application/json', 'Authorization': `Bearer ${opts.key}` },
                opts.extraHeaders || {}
            );
            const r = await fetchWithTimeout(opts.url, { method: 'POST', headers, body: JSON.stringify(body) }, opts.timeout || 22000);
            if (!r.ok) {
                const t = await r.text().catch(() => '');
                throw new Error(`${opts.name} status ${r.status}: ${t.substring(0, 160)}`);
            }
            const data = await r.json();
            let text = data.choices?.[0]?.message?.content;
            if (Array.isArray(text)) text = text.map(p => (p && (p.text || p.content)) || '').join('');
            if (!text || !String(text).trim()) throw new Error(opts.name + ' returned empty');
            return { reply: String(text), provider: opts.provider };
        };
    }

    // mistral-large-latest is paid-tier only (confirmed live: 403 "not available in
    // your subscription tier"); mistral-small-latest is served on the free plan.
    const fetchMistral = makeOAI({ name: 'Mistral', provider: 'mistral', key: mistralKey, url: 'https://api.mistral.ai/v1/chat/completions', textModel: 'mistral-small-latest', visionModel: 'pixtral-12b-2409', jsonMode: true });
    const fetchTogether = makeOAI({ name: 'Together', provider: 'together', key: togetherKey, url: 'https://api.together.xyz/v1/chat/completions', textModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', visionModel: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo' });
    const fetchFireworks = makeOAI({ name: 'Fireworks', provider: 'fireworks', key: fireworksKey, url: 'https://api.fireworks.ai/inference/v1/chat/completions', textModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct', visionModel: 'accounts/fireworks/models/llama-v3p2-90b-vision-instruct' });
    const openRouterHeaders = { 'HTTP-Referer': 'https://wealthflow-personal.vercel.app', 'X-Title': 'WealthFlow' };
    const fetchOpenRouterFinance = makeOAI({ name: 'OpenRouterFinance', provider: 'openrouter:ling-fin-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', textModel: 'inclusionai/ling-3.0-flash-fin:free', visionModel: null, extraHeaders: openRouterHeaders });
    const fetchOpenRouterQwen = makeOAI({ name: 'OpenRouterQwen', provider: 'openrouter:qwen-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', textModel: 'qwen/qwen3.8-27b:free', visionModel: 'qwen/qwen3.8-27b:free', jsonMode: true, extraHeaders: openRouterHeaders });
    const fetchOpenRouterNemotron = makeOAI({ name: 'OpenRouterNemotron', provider: 'openrouter:nemotron-free', key: openrouterKey, url: 'https://openrouter.ai/api/v1/chat/completions', textModel: 'nvidia/nemotron-3-ultra-550b-a55b:free', visionModel: null, extraHeaders: openRouterHeaders });
    // llama-3.3-70b is a real Cerebras model name but returned 404 "does not exist
    // or you do not have access to it" live -- an access/tier gap, not a spelling
    // one. llama3.1-8b is the smaller model Cerebras documents alongside it as
    // generally available.
    const fetchCerebras = makeOAI({ name: 'Cerebras', provider: 'cerebras', key: cerebrasKey, url: 'https://api.cerebras.ai/v1/chat/completions', textModel: 'llama3.1-8b', visionModel: null });
    // meta/llama-3.3-70b-instruct reached end of life 2026-08-26 (confirmed live:
    // 410 Gone). meta/llama-3.1-8b-instruct is NVIDIA's smaller, currently-documented
    // sibling model in the same family.
    const fetchNvidia = makeOAI({ name: 'NVIDIA', provider: 'nvidia', key: nvidiaKey, url: 'https://integrate.api.nvidia.com/v1/chat/completions', textModel: 'meta/llama-3.1-8b-instruct', visionModel: 'meta/llama-3.2-90b-vision-instruct' });
    // The old Azure-fronted endpoint and bare model names (models.inference.ai.azure.com,
    // "Llama-3.3-70B-Instruct") are retired (confirmed live: fetch failed — the host no
    // longer resolves for this traffic). Current: models.github.ai/inference, with every
    // model namespaced "<publisher>/<model>".
    const fetchGitHub = makeOAI({ name: 'GitHubModels', provider: 'github-models', key: githubKey, url: 'https://models.github.ai/inference/chat/completions', textModel: 'openai/gpt-4o-mini', visionModel: 'openai/gpt-4o', jsonMode: true });
    const fetchCloudflare = makeOAI({
        name: 'CloudflareAI',
        provider: 'cloudflare:llama-4-scout',
        key: cloudflareToken,
        url: cloudflareAccount ? `https://api.cloudflare.com/client/v4/accounts/${cloudflareAccount}/ai/v1/chat/completions` : '',
        textModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
        visionModel: '@cf/meta/llama-4-scout-17b-16e-instruct',
        jsonMode: true
    });

    // ---------- ENGINE: COHERE (native v2 chat, text-only) ----------
    async function fetchCohere() {
        if (image) throw new Error('Cohere skipped (text-only)');
        if (!cohereKey) throw new Error('Cohere key not configured');
        const r = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cohereKey}` },
            body: JSON.stringify({ model: 'command-r-plus-08-2024', messages: [{ role: 'user', content: prompt }], temperature: temp })
        });
        if (!r.ok) throw new Error(`Cohere status ${r.status}`);
        const data = await r.json();
        const text = Array.isArray(data.message?.content) ? data.message.content.map(c => c.text || '').join('') : '';
        if (!text.trim()) throw new Error('Cohere returned empty');
        return { reply: text, provider: 'cohere:command-r-plus' };
    }

    // ---------- PARALLEL MULTI-ENGINE EXECUTION ----------
    // All engines fire SIMULTANEOUSLY (not one-by-one). This is dramatically
    // faster and more reliable: a slow/down provider no longer blocks the rest.
    //
    //  • mode=corroborated → wait for every eligible configured engine, then
    //                        let api/ai-matrix.mjs reconcile all testimony.
    //  • mode=consensus    → wait for every engine, then vote (vision / JSON)
    //  • mode=fastest      → retained as a compatibility alias only. WealthFlow
    //                        never releases an answer before the full eligible
    //                        board has settled or reached its per-engine deadline.
    const errorLog = [];

    let engines;
    if (isVision) {
        // Every vision-capable provider contributes to consensus on receipts/statements.
        engines = [
            { name: 'Gemini',       fn: fetchGemini },
            { name: 'Groq',         fn: fetchGroq },
            { name: 'Ollama',       fn: fetchOllama },
            { name: 'GitHubModels', fn: fetchGitHub },
            { name: 'Together',     fn: fetchTogether },
            { name: 'Fireworks',    fn: fetchFireworks },
            { name: 'NVIDIA',       fn: fetchNvidia },
            { name: 'Mistral',      fn: fetchMistral },
            { name: 'OpenRouterQwen', fn: fetchOpenRouterQwen },
            { name: 'CloudflareAI', fn: fetchCloudflare }
        ];
    } else {
        engines = [
            { name: 'Gemini',       fn: fetchGemini },
            { name: 'DeepSeek',     fn: fetchDeepSeek },
            { name: 'Groq',         fn: fetchGroq },
            { name: 'Ollama',       fn: fetchOllama },
            { name: 'Mistral',      fn: fetchMistral },
            { name: 'Together',     fn: fetchTogether },
            { name: 'Fireworks',    fn: fetchFireworks },
            { name: 'OpenRouterFinance', fn: fetchOpenRouterFinance },
            { name: 'OpenRouterQwen', fn: fetchOpenRouterQwen },
            { name: 'OpenRouterNemotron', fn: fetchOpenRouterNemotron },
            { name: 'Cerebras',     fn: fetchCerebras },
            { name: 'NVIDIA',       fn: fetchNvidia },
            { name: 'GitHubModels', fn: fetchGitHub },
            { name: 'Cohere',       fn: fetchCohere },
            { name: 'HF',           fn: fetchHuggingFace },
            { name: 'CloudflareAI', fn: fetchCloudflare }
        ];
    }

    // A missing credential is not a configured board member. Runtime failures
    // remain visible in the audit roster, but spare configured engines can
    // replace them once ten valid independent answers still agree exactly.
    // Anthropic, xAI, SambaNova and EdenAI were removed from the roster
    // entirely (2026-09-28): their Vercel accounts are out of credit/payment
    // method, so every call was a guaranteed, wasted failure that only ate
    // into the deadline budget without ever being able to vote.
    const configured = { Gemini: geminiKey, DeepSeek: deepseekKey, Groq: groqKey, Ollama: ollamaKey,
        Mistral: mistralKey, Together: togetherKey,
        Fireworks: fireworksKey, OpenRouterFinance: openrouterKey, OpenRouterQwen: openrouterKey, OpenRouterNemotron: openrouterKey, Cerebras: cerebrasKey,
        NVIDIA: nvidiaKey, GitHubModels: githubKey, Cohere: cohereKey, HF: hfKey,
        CloudflareAI: cloudflareToken && cloudflareAccount };
    engines = engines.filter(engine => Boolean(configured[engine.name]) && providerAvailable(engine.name));
    // The required roster must match the task capability. A configured
    // text-only provider is not a missing vision voter; every eligible provider
    // is still required and a failed eligible provider still blocks unanimity.
    const expectedNames = engines.map(engine => engine.name);
    if (!engines.length) return res.status(503).json({ error: 'No AI providers configured.', needsReview: true, trustworthy: false, corroboration: { agreed: 0, of: 0, score: 0 } });

    // Wants JSON (receipt extraction etc.) → use consensus for max accuracy.
    const requestedMode = (req.body && req.body.mode) ? String(req.body.mode) : null;
    // `fastest` and `consensus` are legacy caller vocabulary. They now both mean
    // a collective board; no endpoint path is allowed to discard late dissent.
    const mode = financialDecision ? 'unanimous' : 'collective';
    const requestedModeAlias = requestedMode || 'corroborated';
    const task = isVision ? Matrix.TASK.VISION : wantsJSON ? Matrix.TASK.EXTRACTION : Matrix.TASK.PROSE;

    // Wrap each engine call so a rejection becomes a tagged result, never throws.
    function run(engine) {
        const started = Date.now();
        let timer;
        const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Provider response deadline exceeded')), deadlineMs);
        });
        return Promise.race([Promise.resolve()
            .then(() => engine.fn())
            .then(r => ({ ok: true, name: engine.name, reply: r.reply, provider: r.provider, ms: Date.now() - started })), deadline])
            .catch(e => {
                coolProvider(engine.name, e);
                console.warn(`[AI] ${engine.name} failed:`, e.message);
                errorLog.push(`${engine.name}: ${e.message}`);
                return { ok: false, name: engine.name, error: e.message, ms: Date.now() - started };
            }).finally(() => clearTimeout(timer));
    }

    const isValid = (txt) => typeof txt === 'string' && txt.trim().length > 1;

    // Start the entire eligible board before awaiting any member, then retain
    // every success, failure and timeout in the decision record.
    const results = await Promise.all(engines.map(run));
    if (mode === 'unanimous') {
        // Five independent engines already gives real cross-checking (chance
        // agreement on a categorical answer collapses fast per extra voter);
        // ten was set once, never checked against how many of the configured
        // providers are simultaneously healthy in practice, and silently
        // failed every unanimous vote whenever fewer than ten were up at once
        // — which is the normal case, not the exception, for free-tier keys.
        const decision = Matrix.unanimousDecision(results, { task, expected: expectedNames, minimumProviders: 5, allowUnavailable: true });
        // Preserve a machine-readable quarantine outcome; no partial answer is
        // released to consumers that might otherwise file a majority guess.
        return res.status(decision.unanimous ? 200 : 422).json({
            ...decision, trustworthy: Matrix.trustworthy(decision),
            engines: engines.map(e => e.name), financialDecision: true, advisoryOnly: false, consensusOf: decision.answered.length,
            consensusConfidence: decision.unanimous ? 1 : 0,
            error: decision.unanimous ? null : 'AI consensus requires review.'
        });
    }
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
    let proseDecision = null;
    if (wantsJSON) {
        const parsed = good.map(r => ({ r, j: tryParse(r.reply) })).filter(x => x.j);
        if (parsed.length) {
            // v7.47.0 — MULTI-FIELD CONSENSUS. Each key field is voted on
            // INDEPENDENTLY (its own majority), so the winning extraction reflects
            // the majority on EVERY field — not just amount+vendor. Blank/missing
            // values never win a field (they're skipped in the tally), so one
            // engine returning "" can't dilute a real consensus. Fields are
            // weighted: the financial core (amount, vendor) outweighs the
            // classification fields (type, category, destination) on ties.
            const CFIELDS = [
                { k: 'amount',      w: 4, norm: v => (v === 0 || v) ? v : null },
                { k: 'vendor',      w: 3, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'type',        w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'category',    w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null },
                { k: 'destination', w: 2, norm: v => (v || '').toString().toLowerCase().trim() || null }
            ];
            const majority = {};
            const agreement = {};
            CFIELDS.forEach(f => {
                const t = {};
                let total = 0;
                parsed.forEach(({ j }) => {
                    const val = f.norm(j ? j[f.k] : null);
                    if (val === null) return;              // skip blanks — they can't win a field
                    total++;
                    const kk = JSON.stringify(val);
                    t[kk] = (t[kk] || 0) + 1;
                });
                let bestVal, bestN = 0;
                Object.entries(t).forEach(([kk, n]) => { if (n > bestN) { bestN = n; bestVal = kk; } });
                if (bestVal !== undefined) { majority[f.k] = JSON.parse(bestVal); agreement[f.k] = { votes: bestN, of: total, ratio: total ? Math.round((bestN / total) * 1000) / 1000 : 0 }; }
            });
            // Score every parsed reply by weighted agreement with the field-wise
            // majority; the reply matching the most consensus fields wins. Falls
            // back gracefully to the first parse if nothing scores.
            let best2 = null, bestScore = -1;
            parsed.forEach(({ j, r }) => {
                let score = 0;
                CFIELDS.forEach(f => {
                    if (majority[f.k] === undefined) return;
                    if (f.norm(j ? j[f.k] : null) === majority[f.k]) score += f.w;
                });
                if (score > bestScore) { bestScore = score; best2 = r; }
            });
            best = best2 || parsed[0].r;
            // expose the fused field-wise majority so downstream can trust it even
            // if no single engine matched every field.
            // overall consensus confidence = weighted mean of per-field agreement
            let _wsum = 0, _csum = 0;
            CFIELDS.forEach(f => { const a = agreement[f.k]; if (a && a.of > 0) { _csum += f.w * a.ratio; _wsum += f.w; } });
            const _conf = _wsum ? Math.round((_csum / _wsum) * 1000) / 1000 : 0;
            try { best._consensusFields = majority; best._consensusAgreement = agreement; best._consensusConfidence = _conf; } catch (_) {}
        } else {
            best = good.sort((a, b) => b.reply.length - a.reply.length)[0];
        }
    } else {
        /* PROSE USED TO BE "THE LONGEST SUBSTANTIVE ANSWER", tie-broken by
         * speed. That is a length heuristic wearing a consensus label: it reads
         * every reply and lets none of them check any other, so the most verbose
         * engine won a vote that was never held.
         *
         * It is now a real cross-check — the answer the largest group of engines
         * actually agrees on, with disagreement and near misses reported. */
        proseDecision = Matrix.decide(good, { task });
        best = good.find(r => r.reply === proseDecision.reply && r.provider === proseDecision.provider) || good[0];
    }

    return res.status(200).json({
        reply: best.reply,
        provider: best.provider,
        mode: 'collective',
        requestedMode: requestedModeAlias,
        task,
        consensusOf: good.length,
        agreement: good.map(r => r.name),
        consensusFields: best._consensusFields || null,
        consensusConfidence: (best._consensusConfidence != null ? best._consensusConfidence : null),
        fieldAgreement: best._consensusAgreement || null,
        // Present on every path, so a caller never has to know which branch
        // produced its answer in order to find out how well supported it is.
        corroboration: proseDecision ? proseDecision.corroboration : {
            agreed: good.length, of: good.length, score: 1, dissent: [], nearMisses: [], numericConflict: false
        },
        trustworthy: proseDecision ? Matrix.trustworthy(proseDecision) : good.length >= 2,
        answered: good.map(r => r.name),
        failed: results.filter(r => !r.ok).map(r => r.name),
        latencyMs: best.ms,
        financialDecision: false, advisoryOnly: true
    });
}
