/* =============================================================================
 * ai-models.mjs — a provider that retires a model is not a provider that is down
 * -----------------------------------------------------------------------------
 * Every outage in the logs that was not a quota was a MODEL NAME the provider had retired: NVIDIA's llama-3.1-8b-instruct
 * ("reached its end of life"), OpenRouter's free ling slug ("unavailable for free"), Fireworks' and Cerebras' llama ("model not
 * found"), Gemini's 2.x flash before them. The key was fine every time; the code named a model that was gone, and each
 * replacement was another guess committed by hand until the next retirement.
 *
 * So the code no longer has to guess. When a provider answers "that model is gone" (404, 410, "end of life", "does not exist"),
 * the router asks the provider what it serves NOW (its own /models list, with the same key), chooses the best live model for the
 * role by rule, retries ONCE with it, and remembers the choice for hours — the next call goes straight there. A model that fails
 * is not chosen again for as long as it is remembered as bad. Gemini's quota is per model: a 429 on one flash model moves to
 * another flash model, which has its own.
 *
 * Pure but for the injected `load` (a fetch of the provider's list; its body is read within the same 8 s as the request, so a list that
 * stalls after its headers is no answer rather than a wait). Nothing here throws: no answer from the list, no change.
 * ===========================================================================*/

import { readBody } from './fetch-timeout.mjs';

export const TTL_MS = 6 * 3600 * 1000;
export const QUOTA_BAD_MS = 2 * 60 * 1000;
export const LIST_TTL_MS = 3 * 3600 * 1000;

/** Does this failure mean the MODEL is gone (as opposed to the key, the quota or the network)? */
export function isModelGone(status, text) {
    const s = Number(status), t = String(text == null ? '' : text);
    if (s === 410) return true;
    const says = /model[^"\n]{0,60}(?:not found|does not exist|not exist|not available|unavailable|is not supported|not supported)|end of life|decommission|deprecat|no longer (?:available|supported|served)|retired|unavailable for free|not deployed|unknown model|invalid model|model_not_found|does not have access to it/i.test(t);
    if (s === 404) return true;
    return (s === 400 || s === 403) && says;
}

/* ── what each provider's list looks like ─────────────────────────────────────────────────────────────────────────── */

/** Turn a provider's list response into [{ id, free?, methods?, name? }]. Tolerates any shape; returns [] for nonsense. */
export function modelsOf(kind, body) {
    const out = [];
    const add = (id, extra = {}) => { const s = String(id == null ? '' : id).trim(); if (s && s.length <= 200) out.push({ id: s, ...extra }); };
    const list = (v) => (Array.isArray(v) ? v : []);
    try {
        if (kind === 'gemini') for (const m of list(body && body.models)) add(String(m && m.name).replace(/^models\//, ''), { methods: list(m && m.supportedGenerationMethods).map(String) });
        else if (kind === 'ollama') for (const m of list(body && body.models)) add(m && (m.name || m.model));
        else {
            // OpenAI-compatible: { data: [{ id }] }, or a bare array (Together)
            const rows = Array.isArray(body) ? body : list(body && body.data);
            for (const m of rows) {
                const free = m && m.pricing ? (Number(m.pricing.prompt) === 0 && Number(m.pricing.completion) === 0) : undefined;
                add(m && (m.id || m.name), { ...(free !== undefined ? { free } : {}) });
            }
        }
    } catch (_) { /* nonsense in, nothing out */ }
    return out;
}

/* ── choosing ─────────────────────────────────────────────────────────────────────────────────────────────────────── */

const NOT_CHAT = /embed|rerank|guard|moderat|safety|tts|whisper|transcri|asr\b|image|diffus|flux|sdxl|ocr|reward|parse|translat|speech|audio|video|clip|retriev|bge|e5-|nv-|aqa|imagen|veo|lyria|learnlm|live|native-audio|computer-use|robotics/i;
/* Which models can READ AN IMAGE. A list that names only last year's vision models leaves a provider with nothing to heal to the day its
 * vision model is retired (production, 2026-10-10: every vision slug in the book was gone, and Mistral's `mistral-small-latest` — which reads
 * images — was never a candidate because only `pixtral` matched). Current families are named here; a name that matches and cannot read an image
 * answers 400, is set aside by the book, and the next one is tried. */
const VISION = /vision|\bvl\b|-vl-|pixtral|llava|\b4o\b|gpt-4o|gpt-4\.1|gpt-5|gemini|llama-3\.2-(?:11|90)b|llama-4|scout|maverick|gemma-?[34]|multimodal|omni|inkling|kimi|mistral-(?:small|medium|large)|ministral-3|minicpm|molmo|internvl|glm-?\d+(?:\.\d+)?v\b/i;

/** A version number out of an id, for "newest first": gemini-3.8-flash → 3.8; qwen3.8-27b → 3.8. */
const versionOf = (id) => { const m = /(\d+(?:\.\d+)?)/.exec(String(id)); return m ? Number(m[1]) : 0; };

/* Newest families first. A model a provider has retired is still LISTED for a while (NVIDIA lists llama-3.3-70b-instruct after its
 * 2026-08-26 end of life; Cerebras listed llama-3.3-70b to a key that had no access), so the retired generation is the LAST resort,
 * not the first choice — and a choice that fails is marked bad and the next one tried (ai-chat.mjs). */
const PREFER = {
    NVIDIA: [/llama-4-(?:maverick|scout)/, /nemotron.*(?:ultra|super|49b|70b)/, /mistral-(?:large|medium|small)|mixtral-8x22b/, /qwen-?3|qwen2\.5.*(?:72b|32b|instruct)/, /gpt-oss/, /deepseek-v3/, /llama-3\.3-70b-instruct/, /llama-3\.1-70b-instruct/, /llama-3\.1-8b-instruct/, /instruct|chat/],
    Mistral: [/^mistral-small-latest$/, /^mistral-medium-latest$/, /^open-mistral-nemo/, /^ministral-8b-latest$/, /^mistral-large-latest$/, /small|medium|nemo|ministral/, /mistral/],
    DeepSeek: [/^deepseek-chat$/, /deepseek-v\d/, /chat/, /deepseek/],
    Ollama: [/^gpt-oss:120b/, /gpt-oss/, /llama3\.3/, /qwen3/, /deepseek/, /llama/, /./],
    Groq: [/gpt-oss-120b/, /llama-4/, /gpt-oss-20b/, /qwen/, /llama-3\.3-70b/, /70b/, /instruct|chat|versatile/],
    Together: [/llama-3\.3-70b/, /llama-4/, /70b/, /instruct|chat/],
    Fireworks: [/gpt-oss-120b/, /llama4|llama-4/, /qwen-?3.*instruct/, /deepseek-v3/, /kimi.*instruct/, /llama-v3p3-70b/, /70b/, /instruct|chat/],
    Cerebras: [/gpt-oss/, /qwen-?3.*(?:235b|32b)/, /glm/, /llama-?3\.3-70b/, /llama/, /./],
    GitHubModels: [/gpt-4\.1-mini/, /gpt-4o-mini/, /gpt-4\.1$/, /gpt-4o$/, /llama-3\.3-70b/, /gpt|llama|mistral/],
};
const OPENROUTER_ROLE = { Finance: [/ling|fin/, /deepseek/, /gpt-oss/, /llama-3\.3/, /gemma/, /mistral/], Qwen: [/qwen/, /deepseek/, /llama/], Nemotron: [/nemotron/, /llama/, /gpt-oss/] };
const VISION_PREFER = {
    Mistral: [/pixtral-large-latest/, /pixtral.*-latest$/, /pixtral/, /^mistral-small-latest$/, /^mistral-medium-latest$/, /mistral-(?:small|medium)/, /mistral-large/],
    NVIDIA: [/llama-3\.2-90b-vision/, /llama-3\.2-11b-vision/, /llama-4/, /gemma-?4/, /phi-.*(?:vision|multimodal)/, /gemma-?3/, /vision|vl|omni/],
    Ollama: [/qwen.*vl/, /gemma-?4/, /mistral-large-[34]/, /gemma-?3/, /kimi/, /llama3\.2-vision/, /llava/, /vision/],
    OpenRouter: [/gemma-?4/, /nemotron.*omni/, /qwen.*vl|qwen3/, /inkling/, /gemma-3/, /llama-4|llama-3\.2/, /gemini/, /vision|vl/],
    Groq: [/llama-4-scout/, /llama-4-maverick/, /llama-4/, /vision|vl/],
    Together: [/llama-4/, /llama-3\.2-90b-vision/, /llama-3\.2-11b-vision/, /qwen.*vl/, /vision|vl/],
    Fireworks: [/llama4|llama-4/, /qwen.*vl/, /llama-v3p2-90b-vision/, /phi-3-vision/, /vision|vl/],
    GitHubModels: [/gpt-4o$/, /gpt-4\.1$/, /gpt-5/, /4o/, /llama-3\.2.*vision/],
};

/**
 * The best live model for this role, or ''.
 *   provider  Gemini | GeminiPro | NVIDIA | Mistral | DeepSeek | Ollama | Groq | Together | Fireworks | Cerebras | OpenRouter<Role>
 *   models    [{ id, free?, methods? }] — what the provider serves now
 *   exclude   ids not to choose (the one that just failed, and any remembered as bad)
 */
export function choose({ provider, vision = false, models = [], exclude = [] }) {
    const bad = new Set(exclude);
    let pool = (Array.isArray(models) ? models : []).filter((m) => m && m.id && !bad.has(m.id));
    if (!pool.length) return '';
    if (provider === 'Gemini' || provider === 'GeminiPro') {
        pool = pool.filter((m) => /^gemini-/i.test(m.id) && !NOT_CHAT.test(m.id) && (!m.methods || m.methods.includes('generateContent')));
        // flash, then flash-lite, then pro — and a preview or experiment only after the stable model of the next kind down
        // (a preview can vanish a week later; a stable lite model will not), then the newest version.
        // GeminiPro (the slot a caller that wants the strongest reader uses) puts pro first and keeps the same preview rule.
        const kind = provider === 'GeminiPro'
            ? (m) => (/pro/.test(m.id) ? 0 : /flash(?!-lite)/.test(m.id) ? 1 : /flash-lite/.test(m.id) ? 2 : 3)
            : (m) => (/flash(?!-lite)/.test(m.id) ? 0 : /flash-lite/.test(m.id) ? 1 : /pro/.test(m.id) ? 2 : 3);
        const rank = (m) => kind(m) + (/preview|exp|-0\d{2}$/i.test(m.id) ? 1.5 : 0);
        pool.sort((a, b) => rank(a) - rank(b) || versionOf(b.id) - versionOf(a.id) || a.id.localeCompare(b.id));
        return pool.length ? pool[0].id : '';
    }
    const isOpenRouter = /^OpenRouter/.test(provider);
    if (isOpenRouter) pool = pool.filter((m) => m.free === true || /:free$/.test(m.id));
    pool = pool.filter((m) => !NOT_CHAT.test(m.id));
    if (vision) pool = pool.filter((m) => VISION.test(m.id));
    else pool = pool.filter((m) => !/vision|-vl\b|-vl-|\bvl\b|pixtral|llava|ocr/i.test(m.id) || isOpenRouter);
    if (!pool.length) return '';
    const key = isOpenRouter ? 'OpenRouter' : provider;
    const prefs = vision ? (VISION_PREFER[key] || []) : isOpenRouter ? (OPENROUTER_ROLE[provider.replace(/^OpenRouter/, '')] || []) : (PREFER[key] || []);
    const score = (m) => { const at = prefs.findIndex((re) => re.test(m.id)); return at < 0 ? prefs.length : at; };
    // a model that thinks and has no setting to think less is the last of its provider's models for a text role (it spends the budget thinking)
    const thinks = (m) => (!isOpenRouter && !vision && /-r1\b|r1-|thinking|reasoning|qwq|magistral/i.test(m.id) ? 1 : 0);
    pool.sort((a, b) => thinks(a) - thinks(b) || score(a) - score(b) || versionOf(b.id) - versionOf(a.id) || a.id.localeCompare(b.id));
    // a model nothing in the preference list names is only a last resort, and only if the provider has nothing better
    return pool[0].id;
}

/* ── the book: what is remembered, for how long ───────────────────────────────────────────────────────────────────── */

/**
 * @param {object} o
 * @param {()=>number} [o.now]
 */
export function createModelBook({ now = Date.now } = {}) {
    const chosen = new Map();      // slot → { id, at }
    const bad = new Map();         // slot → Map(id → until)
    const lists = new Map();       // provider → { at, models, pending }

    const badIds = (slot) => { const m = bad.get(slot); if (!m) return []; const t = now(); const out = []; for (const [id, until] of m) { if (until > t) out.push(id); else m.delete(id); } return out; };
    return {
        /** The model remembered for this slot (a provider + text or vision), if it is still fresh. */
        current(slot) { const c = chosen.get(slot); return c && now() - c.at < TTL_MS ? c.id : ''; },
        remember(slot, id) { chosen.set(slot, { id, at: now() }); },
        forget(slot) { chosen.delete(slot); },
        markBad(slot, id, ms = TTL_MS) { if (!id) return; if (!bad.has(slot)) bad.set(slot, new Map()); bad.get(slot).set(id, now() + ms); const c = chosen.get(slot); if (c && c.id === id) chosen.delete(slot); },
        isBad(slot, id) { return badIds(slot).includes(id); },
        /** Forget everything (a deployment's cold start, and the tests). */
        reset() { chosen.clear(); bad.clear(); lists.clear(); },
        badList: badIds,
        /**
         * The model to try instead of `failed`: ask the provider what it serves (cached, one request at a time per provider),
         * choose by rule, never a model remembered as bad. '' when there is nothing to try.
         */
        async replacement({ slot, provider, listKey = provider, vision = false, failed = '', load }) {
            let entry = lists.get(listKey);
            // a list already being fetched is waited for, not fetched again: four callers that find the model gone share ONE request
            if (entry && entry.pending) { try { await entry.pending; } catch (_) { /* below */ } entry = lists.get(listKey); }
            if (!entry || now() - entry.at >= LIST_TTL_MS) {
                const pending = (async () => { try { const models = await load(); return Array.isArray(models) ? models : []; } catch (_) { return []; } })();
                lists.set(listKey, { at: now(), models: [], pending });
                const models = await pending;
                // an empty or failed list is not remembered for long: asked again soon
                lists.set(listKey, { at: models.length ? now() : now() - LIST_TTL_MS + 60 * 1000, models });
                entry = lists.get(listKey);
            }
            const models = (entry && entry.models) || [];
            return choose({ provider, vision, models, exclude: [failed, ...badIds(slot)] });
        },
    };
}

/**
 * Fetch and parse a provider's model list. `fetcher` is the endpoint's own timeout-bound fetch; returns [] on any failure.
 *   kind    'openai' | 'gemini' | 'ollama'
 */
export async function loadModels({ kind, url, key, headers = {}, fetcher }) {
    try {
        const target = kind === 'gemini' ? `${url}${url.includes('?') ? '&' : '?'}key=${encodeURIComponent(key)}` : url;
        const auth = kind === 'gemini' ? {} : { Authorization: `Bearer ${key}` };
        const startedAt = Date.now();
        const response = await fetcher(target, { method: 'GET', headers: { Accept: 'application/json', ...auth, ...headers } }, 8000);
        if (!response || !response.ok) return [];
        // 8 s for the whole load: the body gets what the request left, not a second 8 s
        return modelsOf(kind, await readBody(response, 'json', Math.max(8000 - (Date.now() - startedAt), 500)));
    } catch (_) { return []; }
}
