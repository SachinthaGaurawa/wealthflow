/* =============================================================================
 * wf-api-guard.mjs — who may call the costly endpoints, and how often
 * -----------------------------------------------------------------------------
 * WHY. /api/ai, /api/vision*, /api/verify, /api/ai-vision, /api/edenai and a few more
 * spend the owner's provider quota (and, on a paid key, money) on every POST, and until
 * now they answered anybody: no sign-in, no limit, from any website. Anyone could burn the
 * free-tier quota of every provider key in Vercel in minutes, which also starves the real
 * users of the AI the app depends on.
 *
 * WHAT THIS ADDS (and what it deliberately does not)
 *   1. A browser on ANOTHER website may not call them. `Sec-Fetch-Site: cross-site` (set by
 *      the browser, not by page script) is refused with 403 unless its Origin is on the CORS
 *      allow-list (wf-cors.mjs). Same-origin, same-site, `none` and requests with no Sec-Fetch
 *      header at all (Shortcuts, cron, CI, curl) are not affected by this rule.
 *   2. A per-caller limit per minute and per day, per endpoint. The caller is the client IP as
 *      Vercel reports it. Limits are GENEROUS on purpose: Sri Lankan mobile networks put many
 *      people behind one address (CGNAT), so the limits stop a script, not a household.
 *   3. A 429 with Retry-After says what happened; nothing is silently dropped.
 *
 * WHAT IT DOES NOT DO. It is per server instance (Vercel keeps several warm), so it is a floor,
 * not a ceiling: it stops one abuser's loop, not a distributed flood. The platform layer
 * (Vercel Firewall rate limit) is the other half. A sign-in requirement is the third; it needs
 * the app to attach its Firebase ID token to these calls first, which is why it is not here.
 *
 * KNOBS (Vercel env, no deploy needed after the first one)
 *   WF_API_GUARD=off          switch the whole guard off (a kill switch, not a setting)
 *   WF_API_LIMIT_SCALE=2      multiply every limit (0.5 halves them); 0.1 .. 20
 *
 * Pure and dependency-free apart from wf-cors.mjs: imported by api/router.js and by the
 * handlers Vercel serves directly from api/. Never imports autonomy/ (it is .vercelignored).
 * ===========================================================================*/

import { allowedOrigins } from './wf-cors.mjs';

/** Per endpoint: [requests per minute, requests per day]. Only POST is counted. */
export const POLICIES = Object.freeze({
    'ai':               [90, 4000],   // the consensus board; one statement can be dozens of calls
    'verify':           [60, 3000],
    'vision':           [30, 1200],
    'vision-scan':      [30, 1200],
    'ai-vision':        [30, 1200],
    'edenai':           [20, 600],
    'classify-charge':  [60, 3000],
    'advisor-research': [20, 600],
    'merchant-search':  [60, 3000],
    'shorten':          [30, 600],
    'adobe-pdf-share':  [15, 300],
    'send-otp':         [5, 30],      // an e-mail each; the account is already signed in
});

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const MAX_KEYS = 5000;               // memory bound for one instance

const minuteHits = new Map();        // key -> number[] (timestamps inside the last minute)
const dayHits = new Map();           // key -> { day, n }

/** A header from a Node request or a Web Request. */
export function headerOf(req, name) {
    try {
        if (!req || !req.headers) return '';
        if (typeof req.headers.get === 'function') return String(req.headers.get(name) || '');
        const v = req.headers[name.toLowerCase()];
        return Array.isArray(v) ? String(v[0] || '') : String(v || '');
    } catch (_) { return ''; }
}

/**
 * The caller's address as Vercel reports it. `x-vercel-forwarded-for` and `x-real-ip` are set by
 * Vercel's edge (a client cannot choose them); a plain `x-forwarded-for` is only the last resort.
 * '' means "no address known" (an in-process call from another handler): that is never limited.
 */
export function clientIp(req) {
    const raw = headerOf(req, 'x-vercel-forwarded-for') || headerOf(req, 'x-real-ip')
        || headerOf(req, 'x-forwarded-for').split(',')[0];
    const ip = String(raw || '').trim().toLowerCase();
    return /^[0-9a-f:.]{3,45}$/.test(ip) ? ip : '';
}

/** True when a browser on another website sent this request. */
export function isCrossSiteBrowser(req, env) {
    const site = headerOf(req, 'sec-fetch-site').toLowerCase();
    const origin = headerOf(req, 'origin').trim().toLowerCase().replace(/\/+$/, '');
    if (site === 'cross-site') return !(origin && allowedOrigins(env).has(origin));
    if (!site && origin && origin !== 'null') {
        // an older browser: no Sec-Fetch-*, so judge by Origin. Same host as the one asked is same-origin.
        const host = headerOf(req, 'host').toLowerCase();
        if (host && origin.replace(/^https?:\/\//, '') === host) return false;
        return !allowedOrigins(env).has(origin);
    }
    return false;
}

function scaleOf(env) {
    const n = Number(env.WF_API_LIMIT_SCALE);
    return Number.isFinite(n) && n >= 0.1 && n <= 20 ? n : 1;
}

function trim(map) {
    if (map.size <= MAX_KEYS) return;
    // Maps iterate in insertion order, so the first keys are the oldest.
    let drop = map.size - MAX_KEYS + 500;
    for (const k of map.keys()) { map.delete(k); if (--drop <= 0) break; }
}

/**
 * Count this call and decide. Returns { ok: true } or { ok: false, status, error, retryAfter }.
 * `now` and `env` are injectable for tests.
 */
export function check(req, name, { now = Date.now(), env = (typeof process !== 'undefined' && process.env) || {} } = {}) {
    if (String(env.WF_API_GUARD || '').toLowerCase() === 'off') return { ok: true, why: 'off' };
    const policy = POLICIES[name];
    const method = String((req && req.method) || 'GET').toUpperCase();
    if (!policy || method !== 'POST') return { ok: true, why: 'not-counted' };

    if (isCrossSiteBrowser(req, env)) {
        return { ok: false, status: 403, error: 'Cross-site requests are not allowed', why: 'cross-site' };
    }
    const ip = clientIp(req);
    if (!ip) return { ok: true, why: 'no-address' };

    const scale = scaleOf(env);
    const perMin = Math.max(1, Math.round(policy[0] * scale));
    const perDay = Math.max(1, Math.round(policy[1] * scale));
    const key = name + '|' + ip;

    const stamps = (minuteHits.get(key) || []).filter((t) => now - t < MINUTE);
    const day = Math.floor(now / DAY);
    const d = dayHits.get(key);
    const today = d && d.day === day ? d : { day, n: 0 };

    if (stamps.length >= perMin) {
        const retryAfter = Math.max(1, Math.ceil((MINUTE - (now - stamps[0])) / 1000));
        minuteHits.set(key, stamps);
        return { ok: false, status: 429, error: 'Too many requests', retryAfter, why: 'per-minute' };
    }
    if (today.n >= perDay) {
        const retryAfter = Math.max(60, Math.ceil(((day + 1) * DAY - now) / 1000));
        return { ok: false, status: 429, error: 'Daily limit reached for this endpoint', retryAfter, why: 'per-day' };
    }
    stamps.push(now);
    today.n += 1;
    minuteHits.set(key, stamps);
    dayHits.set(key, today);
    trim(minuteHits); trim(dayHits);
    return { ok: true, why: 'counted' };
}

/** Forget every count (tests). */
export function resetGuard() { minuteHits.clear(); dayHits.clear(); }

/**
 * Node handler guard: `if (!guardApi(req, res, 'ai')) return;`
 * Writes the refusal itself. Never throws: a guard that crashed would take the endpoint with it.
 */
export function guardApi(req, res, name, opts) {
    let verdict;
    try { verdict = check(req, name, opts); } catch (_) { return true; }
    if (verdict.ok) return true;
    try {
        if (verdict.retryAfter) res.setHeader('Retry-After', String(verdict.retryAfter));
        // the reason, not the address, is logged: nothing identifying reaches the log
        console.warn('[WF-GUARD] /api/' + name + ' refused: ' + verdict.why);
        res.status(verdict.status).json({ error: verdict.error, retryAfter: verdict.retryAfter });
    } catch (_) { /* the response was already gone */ }
    return false;
}
