/* =============================================================================
 * gemini-client.mjs — one way to call Gemini, so that a failed call is a rare event and never a repeated one
 * -----------------------------------------------------------------------------
 * Google's AI Studio dashboard for the project key showed what eleven separate hand-written callers had been doing to it: a wall of
 * 404 (models named in code that Google had retired — gemini-2.0-flash, 1.5-flash, 1.5-pro, a "-preview" that went away), 429
 * (a Pro model asked on a key that has no Pro quota, every scan; a model asked again seconds after it said "retry in 40 s"),
 * 503 (a busy model asked again at once, never moved off), and now and then a 400 or 403. Every one of those is a request the
 * project made KNOWING, or able to know, that it would fail. This module is the place that knows.
 *
 *   · a model that is gone (404/410/"no longer available") is replaced from Google's own model list and never asked again for hours;
 *   · a quota answer is read, not guessed: "retry in 12 s" parks that model for 12 s; a per-DAY quota parks it until the quota
 *     resets (midnight Pacific); "limit: 0" (a model the key has no quota for) parks it for a day. Quota is per model, so the call
 *     moves to another model at once — it is not a reason to fail;
 *   · a busy model (503/500) is asked once more after a short jittered pause, then another model is used;
 *   · a 400 that names a setting this model does not accept (JSON mode, thinking, safety, token limit) is answered by sending the
 *     same request without that setting — once, and remembered, so it is not a 400 again;
 *   · an answer that is empty because the model spent its token budget thinking is asked again with more room;
 *   · a key problem (invalid, leaked, restricted, API disabled) or an unsupported region is NOT retried: another try is another
 *     error, and it says exactly what to fix;
 *   · what a model has been seen to answer, and what it refused, is remembered across callers in the same process (one book).
 *
 * Pure but for the injected `fetcher`, `sleep`, `now`, `log`: nothing here reads the environment except geminiKeyOf().
 * ===========================================================================*/

import { createModelBook, isModelGone, loadModels } from './ai-models.mjs';

export const BASE = 'https://generativelanguage.googleapis.com/v1beta';
/** The model the dashboard shows serving this key today. Used only until the provider's own list says otherwise. */
export const DEFAULT_MODEL = 'gemini-3.8-flash';
export const geminiBook = createModelBook();

const SLOT = { fast: 'Gemini:any', pro: 'Gemini:pro' };
const PROVIDER = { fast: 'Gemini', pro: 'GeminiPro' };
const MAX_ATTEMPTS = 7;
const MIN_ATTEMPT_MS = 1500;
const DAY_MS = 24 * 3600 * 1000;

const SAFETY = Object.freeze([
    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' },
]);

/** The key the project stores Gemini under, in the order the other callers have always looked for it. */
export function geminiKeyOf(env = (typeof process !== 'undefined' && process.env) || {}) {
    for (const name of ['WealthFlow_API_Key', 'WEALTHFLOW_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY']) {
        const v = env[name];
        if (v && String(v).trim()) return String(v).trim();
    }
    return '';
}

/** The image type a base64 body really is (Gemini rejects some mismatches, and a PDF is not a JPEG). */
export function mimeOfBase64(b64, fallback = 'image/jpeg') {
    const s = String(b64 == null ? '' : b64).replace(/^data:[^;]+;base64,/, '').slice(0, 16);
    if (s.startsWith('/9j/')) return 'image/jpeg';
    if (s.startsWith('iVBOR')) return 'image/png';
    if (s.startsWith('UklGR')) return 'image/webp';
    if (s.startsWith('R0lGOD')) return 'image/gif';
    if (s.startsWith('JVBER')) return 'application/pdf';
    if (/^AAAA[A-Za-z0-9+/]{2}[A-Za-z0-9+/]ZnR5/.test(s) || s.slice(4, 12) === 'ZnR5cGhl') return 'image/heic';
    return fallback;
}

/* ── reading Google's answer ──────────────────────────────────────────────────────────────────────────────────────── */

const seconds = (v) => { const m = /^(\d+(?:\.\d+)?)(ms|s)$/.exec(String(v == null ? '' : v).trim()); return m ? Math.round(Number(m[1]) * (m[2] === 's' ? 1000 : 1)) : 0; };

/** Milliseconds until the daily quota resets (midnight Pacific), clamped to [10 min, 24 h]. */
export function msUntilQuotaReset(at = Date.now()) {
    try {
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
        const get = (type) => Number((parts.find((p) => p.type === type) || {}).value) || 0;
        const sinceMidnight = (((get('hour') % 24) * 60 + get('minute')) * 60 + get('second')) * 1000;
        return Math.max(10 * 60 * 1000, Math.min(DAY_MS, DAY_MS - sinceMidnight));
    } catch (_) { return 3 * 3600 * 1000; }
}

/**
 * What a failed Gemini call means, as a kind the caller can act on.
 *   gone | quota-minute | quota-day | quota-zero | overloaded | key | region |
 *   bad-json-mode | bad-thinking | bad-safety | bad-tokens | bad-image | too-long | bad-request | other
 */
export function classifyGeminiError(status, text, at = Date.now()) {
    const s = Number(status) || 0, raw = String(text == null ? '' : text);
    let error = null;
    try { const j = JSON.parse(raw); error = (j && j.error) || (Array.isArray(j) && j[0] && j[0].error) || null; } catch (_) { /* not JSON */ }
    const message = String((error && error.message) || raw);
    const code = String((error && error.status) || '');
    const details = Array.isArray(error && error.details) ? error.details : [];
    const retry = details.find((d) => d && /RetryInfo/.test(String(d['@type'])));
    const violation = ((details.find((d) => d && /QuotaFailure/.test(String(d['@type']))) || {}).violations || [])[0] || {};
    const quotaId = String(violation.quotaId || '');
    const quotaValue = Number(violation.quotaValue) || 0;
    let retryAfterMs = retry ? seconds(retry.retryDelay) : 0;
    if (!retryAfterMs) { const m = /retry in ([\d.]+)\s*(ms|s)\b/i.exec(message); if (m) retryAfterMs = Math.round(Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1)); }
    const out = (kind, extra = {}) => ({ kind, status: s, code, message: message.slice(0, 200), retryAfterMs, quotaId, quotaValue, ...extra });

    if (s === 429 || code === 'RESOURCE_EXHAUSTED') {
        if (/limit:\s*0\b/.test(message) || (violation.quotaValue !== undefined && quotaValue === 0 && quotaId)) return out('quota-zero', { parkMs: DAY_MS });
        if (/PerDay|per day|daily|per-day/i.test(quotaId + ' ' + message)) return out('quota-day', { parkMs: msUntilQuotaReset(at) });
        return out('quota-minute', { parkMs: Math.min(5 * 60 * 1000, Math.max(5000, retryAfterMs || 60 * 1000)) });
    }
    // a 400 that names a SETTING (JSON mode, thinking, safety, token limit) is about the request, not about the model being gone
    if (s === 400 && !/API key not valid|API_KEY_INVALID|API key expired/i.test(message)) {
        if (/response ?mime ?type|response_mime_type|json mode|application\/json/i.test(message)) return out('bad-json-mode');
        if (/thinking/i.test(message)) return out('bad-thinking');
        if (/safety|HARM_CATEGORY/i.test(message)) return out('bad-safety');
        if (/max_?output_?tokens|output token/i.test(message)) return out('bad-tokens');
    }
    if (isModelGone(s, raw)) return out('gone');
    if (s === 500 || s === 502 || s === 503 || s === 504 || code === 'UNAVAILABLE' || code === 'INTERNAL' || code === 'DEADLINE_EXCEEDED') return out('overloaded');
    if (/location is not supported|user location/i.test(message)) return out('region');
    if (s === 401 || s === 403 || /API key not valid|API_KEY_INVALID|API key expired|API_KEY_[A-Z_]*BLOCKED|leaked|SERVICE_DISABLED|has not been used in project|is disabled|referer|PERMISSION_DENIED|unregistered callers/i.test(message + ' ' + code)) return out('key');
    if (s === 400) {
        if (/too long|exceeds the maximum|token count|input token/i.test(message)) return out('too-long');
        if (/image|inline_?data|unable to process|base64|mime/i.test(message)) return out('bad-image');
        return out('bad-request');
    }
    return out('other');
}

/* ── what this process has learned a model refuses (so it is a 400 once, not every call) ──────────────────────────── */

const learned = { thinking: new Set(), json: new Set(), safety: new Set() };
export function resetGeminiLearning() { learned.thinking.clear(); learned.json.clear(); learned.safety.clear(); pace.hits.clear(); pace.limit.clear(); }

/** A per-model soft pace: once Google has said "N requests per minute", stay under 80% of N instead of finding out again. */
const pace = { hits: new Map(), limit: new Map() };
function paceWait(model, at) {
    const limit = pace.limit.get(model);
    if (!limit) return 0;
    const recent = (pace.hits.get(model) || []).filter((t) => at - t < 60000);
    pace.hits.set(model, recent);
    return recent.length >= limit ? Math.max(1000, recent[0] + 60000 - at) : 0;
}
const paceNote = (model, at) => { const list = pace.hits.get(model) || []; list.push(at); pace.hits.set(model, list.slice(-200)); };

/** How much thinking to allow a structured (JSON) task: little. The default spends the token budget on thinking and the clock on waiting. */
function thinkingFor(model) {
    if (/^gemini-3/.test(model)) return { thinkingLevel: 'low' };
    if (/^gemini-2\.5-(?:flash|flash-lite)\b/.test(model)) return { thinkingBudget: 0 };
    return null;
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function defaultFetcher(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); } finally { clearTimeout(timer); }
}

function failure(out, c, tried) {
    const error = new Error(`Gemini status ${out.status}: ${String(out.text || '').substring(0, 200)}`);
    error.status = out.status; error.kind = c.kind; error.retryAfterMs = c.retryAfterMs || 0; error.tried = tried;
    return error;
}

/**
 * Ask Gemini once, properly.
 *
 * @param {object} o
 * @param {string} o.key
 * @param {object[]} o.parts                     [{ text }, { inline_data: { mime_type, data } }, …]
 * @param {string} [o.system]
 * @param {boolean} [o.json]                     ask for application/json
 * @param {'low'} [o.thinking]                   allow little thinking (structured tasks) — only sent where the model family takes it
 * @param {'fast'|'pro'} [o.tier]
 * @param {string} [o.model]                     a model the caller prefers (an environment override); it is replaced like any other if it is gone
 * @param {number} [o.temperature]
 * @param {number} [o.maxOutputTokens]
 * @param {object} [o.generationConfig]          extra generationConfig fields (topP …)
 * @param {boolean} [o.safety=true]
 * @param {number} [o.deadlineMs=24000]          the whole call, every retry included
 * @param {number} [o.attemptMs=22000]           one request
 * @returns {Promise<{ text, model, finishReason, usage, tried }>}
 */
export async function geminiGenerate(o) {
    const {
        key, parts, system = '', json = false, thinking, tier = 'fast', model: preferred = '', temperature, maxOutputTokens, generationConfig: extra = {}, safety = true,
        deadlineMs = 24000, attemptMs = 22000, fetcher = defaultFetcher, book = geminiBook, loadList, now = Date.now, sleep = defaultSleep,
        log = (line) => { try { console.log(line); } catch (_) { /* a log is advice */ } },
    } = o || {};
    if (!key) throw new Error('Gemini key not configured');
    if (!Array.isArray(parts) || !parts.length) throw new Error('Gemini needs something to read');
    const slot = SLOT[tier] || SLOT.fast, provider = PROVIDER[tier] || PROVIDER.fast;
    const deadlineAt = now() + deadlineMs;
    const tried = [];
    const state = { json: !!json, thinking: thinking === 'low', safety: !!safety, tokens: maxOutputTokens, grewOnce: false, quietOnce: false, tokensClamped: false, busy: new Set() };

    const nextModel = async (failed = '') => book.replacement({
        slot, provider, listKey: 'Gemini', failed,
        load: () => (typeof loadList === 'function' ? loadList() : loadModels({ kind: 'gemini', url: `${BASE}/models?pageSize=200`, key, fetcher })),
    });

    let model = (preferred && !book.isBad(slot, preferred) ? preferred : '') || book.current(slot) || (tier === 'fast' && !book.isBad(slot, DEFAULT_MODEL) ? DEFAULT_MODEL : '');
    let last = null, lastClass = null;
    const note = () => { if (tried.length) { try { log(JSON.stringify({ evt: 'gemini-call', tier, model, tried })); } catch (_) { /* advice */ } } };

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
        const room = deadlineAt - now();
        if (room < MIN_ATTEMPT_MS) break;
        if (!model) { model = await nextModel(); if (!model) break; }
        const wait = paceWait(model, now());
        if (wait > 0) { book.markBad(slot, model, wait); tried.push({ model, status: 0, kind: 'paced' }); model = ''; continue; }

        const config = { ...extra };
        if (temperature !== undefined) config.temperature = temperature;
        if (state.tokens !== undefined) config.maxOutputTokens = state.tokens;
        if (state.json && !learned.json.has(model)) config.responseMimeType = 'application/json';
        const think = state.thinking && !learned.thinking.has(model) ? thinkingFor(model) : null;
        if (think) config.thinkingConfig = think;
        const body = { contents: [{ role: 'user', parts }], generationConfig: config };
        if (system) body.systemInstruction = { parts: [{ text: system }] };
        if (state.safety && !learned.safety.has(model)) body.safetySettings = SAFETY;

        paceNote(model, now());
        let response;
        try {
            response = await fetcher(`${BASE}/models/${model}:generateContent?key=${encodeURIComponent(key)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, Math.min(attemptMs, room - 300));
        } catch (error) {
            // a request that did not finish in time is the caller's deadline, not a reason to ask again
            note();
            throw error;
        }

        if (response.ok) {
            const data = await response.json();
            if (data.promptFeedback && data.promptFeedback.blockReason) { note(); throw new Error('Blocked by Google Safety'); }
            const candidate = (data.candidates || [])[0] || {};
            const text = ((candidate.content && candidate.content.parts) || []).filter((p) => p && typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
            if (text.trim()) { book.remember(slot, model); note(); return { text, model, finishReason: candidate.finishReason || '', usage: data.usageMetadata || null, tried }; }
            const why = String(candidate.finishReason || '');
            if (/SAFETY|PROHIBITED|BLOCKLIST|SPII/.test(why)) { note(); throw new Error('Blocked by Google Safety'); }
            // the model spent its whole budget thinking: ask again with room for the answer
            if (why === 'MAX_TOKENS' && !state.grewOnce) { state.grewOnce = true; state.tokens = Math.min(16384, Math.max(4096, (state.tokens || 2048) * 2)); tried.push({ model, status: 200, kind: 'budget' }); continue; }
            if (!state.quietOnce) { state.quietOnce = true; tried.push({ model, status: 200, kind: 'empty' }); continue; }
            note();
            throw new Error('Gemini returned an empty response');
        }

        const out = { status: response.status, text: await response.text().catch(() => '') };
        const c = classifyGeminiError(out.status, out.text, now());
        tried.push({ model, status: out.status, kind: c.kind });
        last = out; lastClass = c;

        if (c.kind === 'gone') { book.markBad(slot, model); model = ''; continue; }
        if (c.kind === 'quota-minute' || c.kind === 'quota-day' || c.kind === 'quota-zero') {
            if (c.kind === 'quota-minute' && c.quotaValue > 0 && /PerMinute/i.test(c.quotaId)) pace.limit.set(model, Math.max(1, Math.floor(c.quotaValue * 0.8)));
            book.markBad(slot, model, c.parkMs); model = ''; continue;
        }
        if (c.kind === 'overloaded') {
            if (!state.busy.has(model) && deadlineAt - now() > 8000) { state.busy.add(model); await sleep(400 + Math.floor(Math.random() * 800)); continue; }
            book.markBad(slot, model, 30 * 1000); model = ''; continue;
        }
        if (c.kind === 'bad-json-mode' && config.responseMimeType) { learned.json.add(model); continue; }
        if (c.kind === 'bad-thinking' && config.thinkingConfig) { learned.thinking.add(model); continue; }
        if (c.kind === 'bad-safety' && body.safetySettings) { learned.safety.add(model); continue; }
        if (c.kind === 'bad-tokens' && !state.tokensClamped) { state.tokensClamped = true; state.tokens = Math.min(state.tokens || 8192, 8192); continue; }
        break;                                                      // key, region, image, too long, anything unrecognised: asking again is another error
    }
    note();
    if (last) throw failure(last, lastClass, tried);
    const error = new Error(tried.length ? `Gemini status ${tried[tried.length - 1].status}: no model could be tried in time` : 'Gemini deadline exceeded');
    error.tried = tried; error.kind = 'deadline';
    throw error;
}

/** The text of one call, for callers that want nothing else. */
export async function geminiText(o) { return (await geminiGenerate(o)).text; }
