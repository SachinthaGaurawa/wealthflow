/* =============================================================================
 * autonomy/llm-router.mjs — free-tier multi-provider LLM router with failover
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   The old autonomous-fix-agent.js hard-coded `process.env.GEMINI_API_KEY` and
 *   threw `GEMINI_API_KEY not set` — but the key configured on this project is
 *   named `WealthFlow_API_Key`. One name mismatch silently disabled the entire
 *   autonomous update system for months, and because the workflow step was
 *   `continue-on-error: true` the run still reported ✅ success.
 *
 * THE FIX
 *   One router, every provider, real failover. The system now works if ANY
 *   SINGLE key is present, and keeps working when one provider rate-limits.
 *   Every provider below has a genuinely usable free tier (no card required) or
 *   is already paid for on this project — no new paid dependency is introduced.
 *
 * DESIGN
 *   • Providers are tried in order of free-tier generosity + coding ability.
 *   • A provider with no key is skipped silently; a provider that errors or
 *     rate-limits falls through to the next one. Only if EVERY provider fails
 *     does chat() throw — and then it throws loudly with the full attempt log,
 *     so a broken pipeline can never masquerade as a healthy one again.
 *   • `exclude` lets a reviewer refuse to run on the same provider that wrote
 *     the code, which is what makes the consensus board genuinely independent.
 *   • Model IDs are overridable per provider via env (e.g. GROQ_MODEL) so this
 *     file never needs editing when a provider retires a model name.
 *
 * ZERO dependencies — global fetch only (Node 18+; this project pins Node 24).
 * ===========================================================================*/

const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * Provider registry. `keys` lists every env var name that may hold the
 * credential — the FIRST one present wins. This is what makes the router
 * tolerant of the naming drift that broke the original agent.
 */
export const PROVIDERS = [
    {
        id: 'cerebras',
        label: 'Cerebras',
        keys: ['CEREBRAS_API_KEY'],
        url: 'https://api.cerebras.ai/v1/chat/completions',
        model: () => process.env.CEREBRAS_MODEL || 'qwen-3-coder-480b',
        kind: 'openai',
        strengths: ['code', 'fast'],
    },
    {
        id: 'groq',
        label: 'Groq',
        keys: ['GROQ_API_KEY'],
        url: 'https://api.groq.com/openai/v1/chat/completions',
        model: () => process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
        kind: 'openai',
        strengths: ['fast', 'general'],
    },
    {
        id: 'gemini',
        label: 'Google Gemini',
        // WealthFlow_API_Key is this project's actual Gemini key name.
        keys: ['WealthFlow_API_Key', 'WEALTHFLOW_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY'],
        url: null,                                   // built per-request (key in query string)
        model: () => process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        kind: 'gemini',
        strengths: ['architecture', 'long-context'],
    },
    {
        id: 'deepseek',
        label: 'DeepSeek',
        keys: ['DEEPSEEK_API_KEY'],
        url: 'https://api.deepseek.com/chat/completions',
        model: () => process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        kind: 'openai',
        strengths: ['code', 'security', 'reasoning'],
    },
    {
        id: 'mistral',
        label: 'Mistral',
        keys: ['MISTRAL_API_KEY'],
        url: 'https://api.mistral.ai/v1/chat/completions',
        model: () => process.env.MISTRAL_MODEL || 'codestral-latest',
        kind: 'openai',
        strengths: ['code'],
    },
    {
        id: 'together',
        label: 'Together AI',
        keys: ['TOGETHER_API_KEY'],
        url: 'https://api.together.xyz/v1/chat/completions',
        model: () => process.env.TOGETHER_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
        kind: 'openai',
        strengths: ['code'],
    },
    {
        id: 'openrouter',
        label: 'OpenRouter',
        keys: ['OPENROUTER_API_KEY'],
        url: 'https://openrouter.ai/api/v1/chat/completions',
        model: () => process.env.OPENROUTER_MODEL || 'deepseek/deepseek-chat-v3.1:free',
        kind: 'openai',
        strengths: ['general', 'fallback'],
    },
    {
        id: 'xai',
        label: 'xAI Grok',
        keys: ['XAI_API_KEY'],
        url: 'https://api.x.ai/v1/chat/completions',
        model: () => process.env.XAI_MODEL || 'grok-3-mini',
        kind: 'openai',
        strengths: ['security', 'reasoning'],
    },
    {
        id: 'fireworks',
        label: 'Fireworks',
        keys: ['FIREWORKS_API_KEY'],
        url: 'https://api.fireworks.ai/inference/v1/chat/completions',
        model: () => process.env.FIREWORKS_MODEL || 'accounts/fireworks/models/qwen2p5-coder-32b-instruct',
        kind: 'openai',
        strengths: ['code'],
    },
    {
        id: 'nvidia',
        label: 'NVIDIA NIM',
        keys: ['NVIDIA_API_KEY'],
        url: 'https://integrate.api.nvidia.com/v1/chat/completions',
        model: () => process.env.NVIDIA_MODEL || 'qwen/qwen2.5-coder-32b-instruct',
        kind: 'openai',
        strengths: ['code'],
    },
    {
        id: 'sambanova',
        label: 'SambaNova',
        keys: ['SAMBANOVA_API_KEY'],
        url: 'https://api.sambanova.ai/v1/chat/completions',
        model: () => process.env.SAMBANOVA_MODEL || 'Meta-Llama-3.3-70B-Instruct',
        kind: 'openai',
        strengths: ['fast'],
    },
    {
        id: 'github-models',
        label: 'GitHub Models',
        keys: ['GITHUB_MODELS_TOKEN'],
        url: 'https://models.github.ai/inference/chat/completions',
        model: () => process.env.GITHUB_MODELS_MODEL || 'openai/gpt-4o-mini',
        kind: 'openai',
        strengths: ['general'],
    },
    {
        id: 'huggingface',
        label: 'Hugging Face',
        keys: ['HUGGINGFACE_API_KEY', 'HF_TOKEN'],
        url: 'https://router.huggingface.co/v1/chat/completions',
        model: () => process.env.HUGGINGFACE_MODEL || 'Qwen/Qwen2.5-Coder-32B-Instruct',
        kind: 'openai',
        strengths: ['fallback'],
    },
    {
        id: 'cohere',
        label: 'Cohere',
        keys: ['COHERE_API_KEY'],
        url: 'https://api.cohere.com/v2/chat',
        model: () => process.env.COHERE_MODEL || 'command-r-plus-08-2024',
        kind: 'cohere',
        strengths: ['general'],
    },
    {
        // Last by default: this is the one metered key, so free providers get
        // first refusal on every request. Still available as the final fallback
        // and preferred explicitly by the roles that need the strongest model.
        id: 'anthropic',
        label: 'Anthropic Claude',
        keys: ['ANTHROPIC_API_KEY'],
        url: 'https://api.anthropic.com/v1/messages',
        model: () => process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
        kind: 'anthropic',
        strengths: ['code', 'reasoning', 'strongest'],
    },
];

/** The first configured env var name for a provider, or null. */
export function keyFor(provider, env = process.env) {
    for (const name of provider.keys) {
        const v = env[name];
        if (v && String(v).trim()) return { name, value: String(v).trim() };
    }
    return null;
}

/** Providers that actually have a credential in this environment. */
export function availableProviders(env = process.env) {
    return PROVIDERS.filter((p) => keyFor(p, env));
}

/** Human-readable diagnostic — used by /api/autonomy-status and CI summaries. */
export function describeAvailability(env = process.env) {
    const avail = availableProviders(env);
    return {
        count: avail.length,
        providers: avail.map((p) => ({ id: p.id, label: p.label, model: p.model(), via: keyFor(p, env).name })),
        healthy: avail.length > 0,
        missing: PROVIDERS.filter((p) => !keyFor(p, env)).map((p) => p.id),
    };
}

/**
 * Order providers for a role. `prefer` strengths float to the front so the
 * security auditor reaches for a security-strong model and the UI agent does
 * not waste the strongest model on a copy tweak.
 */
export function orderFor({ prefer = [], exclude = [], only = [], env = process.env } = {}) {
    let list = availableProviders(env);
    if (only.length) list = list.filter((p) => only.includes(p.id));
    if (exclude.length) list = list.filter((p) => !exclude.includes(p.id));
    if (!prefer.length) return list;
    const score = (p) => p.strengths.reduce((s, t) => s + (prefer.includes(t) ? 1 : 0), 0);
    return [...list].sort((a, b) => score(b) - score(a));
}

// ── request builders ─────────────────────────────────────────────────────────

function buildOpenAI(provider, key, { system, prompt, maxTokens, temperature }) {
    return {
        url: provider.url,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.value}` },
            body: JSON.stringify({
                model: provider.model(),
                messages: [
                    ...(system ? [{ role: 'system', content: system }] : []),
                    { role: 'user', content: prompt },
                ],
                max_tokens: maxTokens,
                temperature,
                stream: false,
            }),
        },
        extract: (d) => d?.choices?.[0]?.message?.content ?? '',
    };
}

function buildGemini(provider, key, { system, prompt, maxTokens, temperature }) {
    const model = provider.model();
    return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key.value)}`,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
                generationConfig: { temperature, maxOutputTokens: maxTokens },
            }),
        },
        extract: (d) => (d?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join(''),
    };
}

function buildAnthropic(provider, key, { system, prompt, maxTokens, temperature }) {
    return {
        url: provider.url,
        init: {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': key.value,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: provider.model(),
                max_tokens: maxTokens,
                temperature,
                ...(system ? { system } : {}),
                messages: [{ role: 'user', content: prompt }],
            }),
        },
        extract: (d) => (d?.content || []).map((c) => c?.text || '').join(''),
    };
}

function buildCohere(provider, key, { system, prompt, maxTokens, temperature }) {
    return {
        url: provider.url,
        init: {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key.value}` },
            body: JSON.stringify({
                model: provider.model(),
                messages: [
                    ...(system ? [{ role: 'system', content: system }] : []),
                    { role: 'user', content: prompt },
                ],
                max_tokens: maxTokens,
                temperature,
            }),
        },
        extract: (d) => {
            const c = d?.message?.content;
            if (Array.isArray(c)) return c.map((x) => x?.text || '').join('');
            return d?.text || '';
        },
    };
}

const BUILDERS = { openai: buildOpenAI, gemini: buildGemini, anthropic: buildAnthropic, cohere: buildCohere };

/** One provider, one attempt. Throws on any non-2xx or empty completion. */
async function callProvider(provider, opts) {
    const key = keyFor(provider, opts.env || process.env);
    if (!key) throw new Error(`${provider.id}: no key`);
    const build = BUILDERS[provider.kind];
    if (!build) throw new Error(`${provider.id}: unknown kind ${provider.kind}`);

    const { url, init, extract } = build(provider, key, opts);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
    try {
        const r = await fetch(url, { ...init, signal: ac.signal });
        const raw = await r.text();
        if (!r.ok) {
            // Truncate: provider errors can echo the whole prompt back.
            throw new Error(`${provider.id}: HTTP ${r.status} ${raw.slice(0, 300)}`);
        }
        let data;
        try { data = JSON.parse(raw); } catch { throw new Error(`${provider.id}: non-JSON response`); }
        const text = String(extract(data) || '').trim();
        if (!text) throw new Error(`${provider.id}: empty completion`);
        return { text, provider: provider.id, label: provider.label, model: provider.model() };
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Ask an LLM, trying every configured provider until one answers.
 *
 * @param {object} o
 * @param {string} o.prompt        the user prompt (required)
 * @param {string} [o.system]      system instruction
 * @param {number} [o.maxTokens=8192]
 * @param {number} [o.temperature=0.1]  low by default: this writes production code
 * @param {string[]} [o.prefer]    strength tags to prioritise
 * @param {string[]} [o.exclude]   provider ids to refuse (reviewer independence)
 * @param {string[]} [o.only]      restrict to these provider ids
 * @returns {Promise<{text,provider,label,model,attempts}>}
 */
export async function chat(o) {
    const {
        prompt, system, maxTokens = 8192, temperature = 0.1,
        prefer = [], exclude = [], only = [], timeoutMs, env = process.env,
    } = o || {};
    if (!prompt || !String(prompt).trim()) throw new Error('chat(): prompt is required');

    const order = orderFor({ prefer, exclude, only, env });
    if (!order.length) {
        throw new Error(
            'NO LLM PROVIDER CONFIGURED. Set at least one of: ' +
            PROVIDERS.map((p) => p.keys[0]).join(', ') +
            '. (This is the failure that silently disabled the autonomous system.)'
        );
    }

    const attempts = [];
    for (const provider of order) {
        try {
            const res = await callProvider(provider, { prompt, system, maxTokens, temperature, timeoutMs, env });
            return { ...res, attempts };
        } catch (e) {
            attempts.push({ provider: provider.id, error: String(e && e.message || e).slice(0, 300) });
            // eslint-disable-next-line no-console
            console.warn(`[llm-router] ${provider.id} failed → trying next: ${e && e.message}`);
        }
    }
    const err = new Error(
        `ALL ${order.length} LLM provider(s) failed:\n` +
        attempts.map((a) => `  • ${a.provider}: ${a.error}`).join('\n')
    );
    err.attempts = attempts;
    throw err;
}

/**
 * Ask N *different* providers the same question — the primitive behind the
 * consensus review board. Returns one entry per distinct provider that answered.
 */
export async function chatMany(o, n = 3) {
    const { exclude = [], ...rest } = o || {};
    const used = [...exclude];
    const results = [];
    for (let i = 0; i < n; i++) {
        try {
            const r = await chat({ ...rest, exclude: used });
            results.push(r);
            used.push(r.provider);
        } catch {
            break;                       // ran out of providers — return what we have
        }
    }
    return results;
}

/** Strip markdown fences a model may wrap code in. */
export function stripFences(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-zA-Z0-9_+-]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    return t.trim();
}

/** Pull the first balanced JSON object/array out of a model reply. */
export function extractJson(text) {
    const t = String(text || '');
    const start = t.search(/[[{]/);
    if (start < 0) return null;
    const open = t[start];
    const close = open === '{' ? '}' : ']';
    let depth = 0, inStr = false, esc = false;
    for (let i = start; i < t.length; i++) {
        const c = t[i];
        if (inStr) {
            if (esc) esc = false;
            else if (c === '\\') esc = true;
            else if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') { inStr = true; continue; }
        if (c === open) depth++;
        else if (c === close) {
            depth--;
            if (depth === 0) {
                try { return JSON.parse(t.slice(start, i + 1)); } catch { return null; }
            }
        }
    }
    return null;
}
