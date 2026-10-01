/*  ai-vision.js  →  POST /api/ai-vision
 *  ---------------------------------------------------------------------------
 *  Multi-image vision, performed SERVER-SIDE with keys held in environment
 *  variables. This exists so the browser never has to hold a provider key.
 *
 *  WHAT IT REPLACES
 *    wealthflow-ai-v4.js shipped three live provider credentials to every
 *    visitor's browser:
 *      • two Gemini keys in `_GEMINI_VISION_KEYS`
 *      • one Groq key in `_GROQ_VISION_KEY`
 *    Anyone who opened devtools on the deployed site could read and spend them.
 *
 *    Those two client engines were also DEAD CODE. `callMultiImageAI` is called
 *    with an array of `{ base64, sourceFile, ... }` OBJECTS, but both functions
 *    used each element directly as the image payload:
 *        images.slice(0, 6).forEach(b64 => parts.push({ inline_data: { data: b64 } }))
 *    so `data` received an object, not a base64 string, and every provider
 *    rejected it. The cascade therefore always fell through to the backend
 *    engine. Deleting them removes a real key leak and loses nothing that ever
 *    worked — and this endpoint fixes the payload bug on the way through.
 *
 *  REQUEST   { images: ["<b64>" | {base64:"<b64>"}], prompt: "…" }
 *  RESPONSE  { ok:true, text:"…", provider:"gemini|groq", model:"…" }
 *            { ok:false, error:"…", tried:[…] }
 *
 *  ENV (any subset; tried in order)
 *    GEMINI_API_KEY / WealthFlow_API_Key / GOOGLE_API_KEY   — Gemini vision
 *    GROQ_API_KEY                                            — Groq Llama vision
 */

import { fetchWithTimeout } from './fetch-timeout.mjs';
import { geminiGenerate, mimeOfBase64 } from './gemini-client.mjs';

// Longer than the 10s library default, and deliberately so: these calls send
// images to a vision model, which routinely takes tens of seconds on a large
// receipt or a multi-page statement. The endpoint tries several models in
// sequence, so this is a per-attempt budget — it still has to leave the function
// room to answer inside maxDuration: 60 rather than be killed mid-sentence.
const VISION_TIMEOUT_MS = 30_000;

export const config = { maxDuration: 60, api: { bodyParser: { sizeLimit: '8mb' } } };

const MAX_IMAGES = 6;
const MAX_PROMPT = 8000;

const GROQ_MODELS = [
    'meta-llama/llama-4-scout-17b-16e-instruct',
    'llama-3.2-90b-vision-preview',
    'llama-3.2-11b-vision-preview',
];

/**
 * Accept either raw base64 strings or `{ base64 }` objects, and strip any
 * `data:image/...;base64,` prefix. This tolerance is the whole reason the old
 * client code silently failed.
 */
export function normaliseImages(input) {
    const arr = Array.isArray(input) ? input : (input ? [input] : []);
    const out = [];
    for (const item of arr) {
        let b64 = null;
        if (typeof item === 'string') b64 = item;
        else if (item && typeof item === 'object') b64 = item.base64 || item.data || item.b64 || null;
        if (typeof b64 !== 'string') continue;
        b64 = b64.trim().replace(/^data:[^;]+;base64,/, '');
        if (b64.length > 32) out.push(b64);          // ignore obvious junk
        if (out.length >= MAX_IMAGES) break;
    }
    return out;
}

function firstKey(env, names) {
    for (const n of names) {
        const v = env[n];
        if (v && String(v).trim()) return String(v).trim();
    }
    return null;
}

async function geminiVision(key, images, prompt) {
    const parts = [{ text: prompt }];
    for (const b64 of images) parts.push({ inline_data: { mime_type: mimeOfBase64(b64), data: b64 } });

    // The fast reader, then the strong one. Each finds a live model of its kind by itself, is parked for as long as Google says its
    // quota is spent, and is never asked for a model Google has retired — the five names that used to be tried here, in order, on
    // every call, were most of the 404s and 429s on the project's Gemini dashboard (gemini-client.mjs).
    for (const tier of ['fast', 'pro']) {
        try {
            const result = await geminiGenerate({ key, parts, tier, temperature: 0.2, maxOutputTokens: 8192, generationConfig: { topP: 0.95 }, deadlineMs: VISION_TIMEOUT_MS, fetcher: fetchWithTimeout });
            const text = result.text.trim();
            if (text) return { text, model: result.model };
        } catch (error) {
            if (error && error.kind === 'key') return { fatal: true };        // bad key: nothing else will work either
        }
    }
    return null;
}

async function groqVision(key, images, prompt) {
    const content = [{ type: 'text', text: prompt }];
    for (const b64 of images.slice(0, 5)) {
        content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } });
    }
    for (const model of GROQ_MODELS) {
        try {
            const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model, messages: [{ role: 'user', content }], temperature: 0.25, max_tokens: 4096,
                }),
            }, VISION_TIMEOUT_MS);
            if (!r.ok) continue;
            const d = await r.json();
            const t = d?.choices?.[0]?.message?.content;
            if (t && t.trim()) return { text: t.trim(), model };
        } catch { /* try the next model */ }
    }
    return null;
}

function send(res, body, status = 200) {
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };
    try {
        if (res && res.status) {
            if (res.setHeader) Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v));
            res.status(status).json(body);
            return;
        }
    } catch { /* fall through */ }
    return new Response(JSON.stringify(body), { status, headers });
}

export default async function handler(req, res) {
    if (req?.method === 'OPTIONS') return send(res, { ok: true });
    if (req?.method !== 'POST') return send(res, { ok: false, error: 'POST only' }, 405);

    let body = req?.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { body = {}; } }
    body = body || {};

    const images = normaliseImages(body.images ?? body.image);
    const prompt = String(body.prompt || '').slice(0, MAX_PROMPT).trim()
        || 'Describe everything visible in these images in precise detail.';

    if (!images.length) return send(res, { ok: false, error: 'no usable image data' }, 400);

    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const tried = [];

    const geminiKey = firstKey(env, ['GEMINI_API_KEY', 'WealthFlow_API_Key', 'WEALTHFLOW_API_KEY', 'GOOGLE_API_KEY']);
    if (geminiKey) {
        tried.push('gemini');
        const g = await geminiVision(geminiKey, images, prompt);
        if (g && g.text) return send(res, { ok: true, text: g.text, provider: 'gemini', model: g.model });
    }

    const groqKey = firstKey(env, ['GROQ_API_KEY']);
    if (groqKey) {
        tried.push('groq');
        const q = await groqVision(groqKey, images, prompt);
        if (q && q.text) return send(res, { ok: true, text: q.text, provider: 'groq', model: q.model });
    }

    // Honest failure. The caller shows a real error rather than a chat reply
    // that silently ignores the image.
    return send(res, {
        ok: false,
        error: tried.length
            ? 'every configured vision provider failed'
            : 'no vision provider configured on the server (set GEMINI_API_KEY or GROQ_API_KEY)',
        tried,
    }, 502);
}
