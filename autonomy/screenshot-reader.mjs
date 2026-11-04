/* =============================================================================
 * autonomy/screenshot-reader.mjs — let the fix agent SEE the user's screenshot
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (seen on issue #514, 2026-11-04)
 *   The app attaches a screenshot to a report and feedback-triage.js writes it
 *   into the GitHub issue between `<!-- wf-feedback-image -->` and a code fence.
 *   Nothing ever read that block. The comment said "the fix agent looks for
 *   this marker"; no code did. So an overlap bug that only a picture shows was
 *   handed to a text-only model as a sentence, and the 40,000 characters of
 *   base64 went into every prompt as noise.
 *
 * WHAT THIS DOES
 *   1. finds the screenshot in the issue body and takes it OUT of the text the
 *      other agents read (it is not text);
 *   2. asks the first vision-capable provider that has a key to describe what
 *      is visible: which screen, what looks wrong, the exact words nearby;
 *   3. puts that description back into the issue text, labelled as a machine
 *      reading, so the author knows where to look and does not trust it blindly.
 *
 * HONESTY
 *   A vision model can misread an image. The block it adds says so, and says
 *   which provider read it. If no provider can read the image, the block says
 *   that instead of pretending the screenshot was seen.
 *
 * Zero dependencies (global fetch). The caller may inject `fetchImpl`.
 * ===========================================================================*/

import { PROVIDERS, keyFor } from './llm-router.mjs';

export const IMAGE_MARKER = 'wf-feedback-image';

const MARKER_BLOCK = new RegExp(
    '<!--\\s*' + IMAGE_MARKER + '\\s*-->\\s*<details>[\\s\\S]*?</details>', 'i');
const DATA_URL = /data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}/;

const VISION_TIMEOUT_MS = 45_000;
const MAX_DESCRIPTION = 2400;

/** Vision-capable models per provider, tried in order. Overridable by env. */
export function visionModels(providerId, env = process.env) {
    const pick = (v, list) => [v, ...list].filter(Boolean);
    if (providerId === 'groq') return pick(env.GROQ_VISION_MODEL, ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-90b-vision-preview']);
    if (providerId === 'mistral') return pick(env.MISTRAL_VISION_MODEL, ['mistral-small-latest', 'pixtral-large-latest']);
    if (providerId === 'openrouter') return pick(env.OPENROUTER_VISION_MODEL, ['meta-llama/llama-3.2-11b-vision-instruct:free']);
    if (providerId === 'together') return pick(env.TOGETHER_VISION_MODEL, ['meta-llama/Llama-Vision-Free']);
    return [];
}

/** The screenshot's data URL from an issue body, or ''. */
export function extractScreenshot(body) {
    const block = String(body || '').match(MARKER_BLOCK);
    if (!block) return '';
    const m = block[0].match(DATA_URL);
    return m ? m[0] : '';
}

/** The issue text with the base64 block removed (it is not text and floods prompts). */
export function withoutScreenshot(body) {
    return String(body || '').replace(MARKER_BLOCK, '_(Screenshot data removed from this text; see "What the screenshot shows" below.)_');
}

export function visionPrompt({ title = '', text = '' } = {}) {
    return [
        'You are looking at a screenshot a user attached to a bug report about a personal-finance web app (WealthFlow).',
        'Report title: ' + String(title).slice(0, 200),
        'The user wrote: ' + String(text).slice(0, 800),
        '',
        'Describe ONLY what is visible. Do not guess code. Answer in these short sections:',
        'SCREEN: which page or section, and whether it looks like a phone or a desktop layout.',
        'PROBLEM: what looks wrong, concretely (overlapping elements, cut-off or wrapped text, wrong or missing values, error messages, empty areas, wrong colours). Say which elements collide or are clipped.',
        'TEXT: the exact words and numbers next to the problem, so a developer can search for them.',
        'CONFIDENCE: high, medium or low, and one sentence why.',
        'If the image is blank, unreadable or unrelated, say so plainly. Keep it under 250 words.',
    ].join('\n');
}

async function postJson(fetchImpl, url, headers, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), VISION_TIMEOUT_MS);
    if (typeof t.unref === 'function') t.unref();
    try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
        let data = null;
        try { data = await r.json(); } catch { /* not json */ }
        return { ok: r.ok, status: r.status, data };
    } finally { clearTimeout(t); }
}

async function askOpenAiStyle(provider, key, model, dataUrl, prompt, fetchImpl) {
    const r = await postJson(fetchImpl, provider.url, { Authorization: 'Bearer ' + key }, {
        model, temperature: 0.2, max_tokens: 700,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    });
    const text = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    return { ok: r.ok && typeof text === 'string' && text.trim().length > 0, status: r.status, text: String(text || '').trim() };
}

async function askGemini(key, dataUrl, prompt, fetchImpl, env) {
    const m = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
    const model = env.GEMINI_VISION_MODEL || env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await postJson(fetchImpl,
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {},
        { contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 700 } });
    const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('').trim() : '';
    return { ok: r.ok && text.length > 0, status: r.status, text, model };
}

/**
 * Ask each provider that has a key and a vision model, in order, until one reads the image.
 * @returns {{ ok:boolean, text?:string, provider?:string, model?:string, tried:string[] }}
 */
export async function describeScreenshot({ dataUrl, title, text, env = process.env, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    const tried = [];
    if (!dataUrl) return { ok: false, tried };
    const prompt = visionPrompt({ title, text });
    const order = ['gemini', 'mistral', 'groq', 'openrouter', 'together'];
    for (const id of order) {
        const provider = PROVIDERS.find((p) => p.id === id);
        const k = provider && keyFor(provider, env);
        if (!k) continue;
        const models = id === 'gemini' ? [null] : visionModels(id, env);
        for (const model of models) {
            try {
                const r = id === 'gemini'
                    ? await askGemini(k.value, dataUrl, prompt, fetchImpl, env)
                    : await askOpenAiStyle(provider, k.value, model, dataUrl, prompt, fetchImpl);
                const used = r.model || model || id;
                if (r.ok) return { ok: true, text: r.text.slice(0, MAX_DESCRIPTION), provider: id, model: used, tried };
                tried.push(`${id}/${used}: HTTP ${r.status}`);
                if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 402) break; // same key, same answer
            } catch (e) {
                tried.push(`${id}/${model || 'default'}: ${String((e && e.message) || e).slice(0, 80)}`);
                break;
            }
        }
    }
    log(`[screenshot] no provider read the image (${tried.join('; ') || 'no vision-capable key'})`);
    return { ok: false, tried };
}

/**
 * The one call the agent makes. Returns the issue body to give the other agents
 * and a one-line `note` for the attempt comment.
 * @returns {Promise<{ body:string, status:'none'|'read'|'unreadable'|'oversize', note:string, provider?:string }>}
 */
export async function screenshotContext({ issue, env = process.env, fetchImpl, log = () => {} } = {}) {
    const body = String((issue && issue.body) || '');
    const dataUrl = extractScreenshot(body);
    if (!dataUrl) {
        const oversize = /A screenshot was attached \(~\d+ KB\) but exceeds/.test(body);
        return {
            body, status: oversize ? 'oversize' : 'none',
            note: oversize ? 'A screenshot was attached but was too large to embed in the issue, so it could not be read.' : '',
        };
    }
    const stripped = withoutScreenshot(body);
    const r = await describeScreenshot({ dataUrl, title: issue && issue.title, text: stripped.slice(0, 1200), env, fetchImpl, log });
    if (r.ok) {
        return {
            body: stripped + '\n\n### What the screenshot shows\n' +
                `_Read from the user's screenshot by a vision model (${r.provider}/${r.model}). It is a machine reading and can be wrong: use it to decide where to look, and trust the code over it._\n\n` + r.text + '\n',
            status: 'read', provider: r.provider,
            note: `Screenshot read by ${r.provider}/${r.model}.`,
        };
    }
    return {
        body: stripped + '\n\n### What the screenshot shows\n_A screenshot is attached but no vision model could read it' +
            (r.tried.length ? ` (tried ${r.tried.join('; ')})` : ' (no vision-capable provider key is configured)') + '. Work from the written report only._\n',
        status: 'unreadable',
        note: 'A screenshot is attached but no vision model could read it' + (r.tried.length ? ` (${r.tried.join('; ')})` : ' (no vision-capable key configured)') + '.',
    };
}
