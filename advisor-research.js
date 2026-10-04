/* =============================================================================
 * /api/advisor-research — the web lookup behind the Advisor's "what is the rate now?" answers
 * -----------------------------------------------------------------------------
 *   POST { q }   -> { ok, via, query, at, sources: [{ n, title, url, host, snippet, date }], notes }
 *                   or { ok: false, reason }   (reason: no-question, not-configured, empty, failed, timeout, rate)
 *   GET          -> { ok: true, configured: ['tavily', ...] }   which providers have a key, by name; never a value
 *   GET ?check=1 -> the same plus check: { query, at, results: [{ name, ok, sources, hosts, ms, error? }] }   each configured provider asked one fixed public question
 *
 * The lookup itself, the query scrubbing and the clean-up of web text are in advisor-research.mjs. This file is the door: it answers CORS, limits how often one caller can
 * ask (so a script cannot spend the search credits), remembers an answer for fifteen minutes, and never answers with anything but JSON. Nothing about the owner's books
 * arrives here or is looked at: the body is one question, and the question is scrubbed of figures again before it is searched.
 * ===========================================================================*/

import { search, probe, configured, makeLimiter } from './advisor-research.mjs';

export const config = { maxDuration: 20 };

const limiter = makeLimiter();

// GET ?check=1 asks every configured provider one fixed public question, so which of them really works with its key can be seen. It is remembered (ten minutes when
// something worked, two when nothing did) so a visitor cannot spend the search credits by reloading it.
const CHECK_OK_MS = 10 * 60 * 1000, CHECK_FAIL_MS = 2 * 60 * 1000;
let lastCheck = null;

function wantsCheck(req) {
    if (req && req.query && req.query.check != null) return String(req.query.check) !== '' && String(req.query.check) !== '0';
    try { const v = new URL(String((req && req.url) || ''), 'http://x').searchParams.get('check'); return v != null && v !== '' && v !== '0'; } catch (_) { return false; }
}

async function checkProviders(now) {
    if (lastCheck && now - lastCheck.at < (lastCheck.value.results.some((r) => r.ok) ? CHECK_OK_MS : CHECK_FAIL_MS)) return lastCheck.value;
    let value;
    try { value = await probe(); } catch (_) { value = { query: '', at: new Date(now).toISOString(), results: [] }; }
    lastCheck = { at: now, value };
    return value;
}

function callerOf(req) {
    const h = (req && req.headers) || {};
    const fwd = String(h['x-forwarded-for'] || h['x-real-ip'] || '').split(',')[0].trim();
    return fwd || 'unknown';
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Cache-Control', 'no-store');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method === 'GET') {
        const out = { ok: true, configured: configured() };
        if (wantsCheck(req)) out.check = await checkProviders(Date.now());
        return res.status(200).json(out);
    }
    if (req.method !== 'POST') return res.status(405).json({ ok: false, reason: 'method' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    const q = body && typeof body.q === 'string' ? body.q.slice(0, 1000) : '';
    if (q.trim().length < 3) return res.status(200).json({ ok: false, reason: 'no-question' });

    const now = Date.now();
    const key = q.trim().toLowerCase().replace(/\s+/g, ' ');
    const hit = limiter.cached(key, now);
    if (hit) return res.status(200).json(hit);
    if (!limiter.allow(callerOf(req), now)) return res.status(200).json({ ok: false, reason: 'rate' });

    let out;
    try { out = await search(q, { log: (line) => console.info(line) }); }
    catch (_) { out = { ok: false, reason: 'failed' }; }
    limiter.keep(key, out, now);
    return res.status(200).json(out);
}
