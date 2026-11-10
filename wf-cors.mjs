/* =============================================================================
 * wf-cors.mjs — which websites may call this API from a browser
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG (RedSentinel scan of www.wealthflow.lk, 2026-11-07, finding "overly
 * permissive CORS", confirmed against the live site): every /api route answered
 * `Access-Control-Allow-Origin: *`, and three handlers reflected whatever Origin they
 * were given. Any web page on the internet could therefore make a visitor's browser
 * call WealthFlow's API and READ the answer.
 *
 * THE RULE NOW
 *   · A browser request from an allow-listed origin gets that ONE origin echoed back,
 *     with `Vary: Origin` so a cache cannot hand it to another site.
 *   · A browser request from any other origin gets no CORS header at all, so the
 *     browser refuses to show the page the answer. (The request itself is still
 *     delivered; CORS is the browser's rule, not a firewall. The routes that must
 *     not even be attempted by another site refuse on Origin / Sec-Fetch-Site too,
 *     see api-guard.)
 *   · `*` is never sent, and never combined with credentials.
 *   · A request with no Origin (a phone's Shortcuts app, Pub/Sub, Vercel Cron, curl,
 *     the CI workflows) is not a browser cross-site call: CORS does not apply to it
 *     and nothing here changes its behaviour.
 *
 * THE ALLOW-LIST
 *   production  https://www.wealthflow.lk, https://wealthflow.lk
 *   this deploy https://$VERCEL_URL and https://$VERCEL_BRANCH_URL, so a preview
 *               deployment can call its OWN api (and nobody else's preview can)
 *   extras      WF_CORS_ORIGINS, comma separated, https only (e.g. a staging domain)
 * The Capacitor app opens https://www.wealthflow.lk/app (native/capacitor.config.json),
 * so its origin is the production one and needs no entry of its own.
 *
 * Pure and dependency-free: it is imported by api/router.js and by the four handlers
 * Vercel serves directly from api/ (ai, verify, vision, vision-scan).
 * ===========================================================================*/

export const PRODUCTION_ORIGINS = Object.freeze(['https://www.wealthflow.lk', 'https://wealthflow.lk']);

/** Headers a browser page of this app may send. Bearer ID tokens travel in Authorization. */
export const ALLOWED_REQUEST_HEADERS = 'Content-Type, Authorization, X-Requested-With';
export const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';

/** `https://host` for a bare host name such as VERCEL_URL, or '' when it is not a plain host. */
function originOfHost(host) {
    const h = String(host || '').trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(h)) return '';
    return 'https://' + h;
}

/** The exact origins that may read an answer. */
export function allowedOrigins(env = (typeof process !== 'undefined' && process.env) || {}) {
    const set = new Set(PRODUCTION_ORIGINS);
    const own = [originOfHost(env.VERCEL_URL), originOfHost(env.VERCEL_BRANCH_URL)];
    for (const o of own) if (o) set.add(o);
    for (const raw of String(env.WF_CORS_ORIGINS || '').split(',')) {
        const o = raw.trim().toLowerCase().replace(/\/+$/, '');
        // https only, and only a bare origin: no path, no wildcard, no credentials in the URL.
        if (/^https:\/\/[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(o)) set.add(o);
    }
    return set;
}

/** The request's Origin header, from a Node request, a Web Request, or a bare string. */
export function originOf(req) {
    if (typeof req === 'string') return req;
    if (!req || !req.headers) return '';
    try {
        if (typeof req.headers.get === 'function') return String(req.headers.get('origin') || '');
        const v = req.headers.origin || req.headers.Origin || '';
        return Array.isArray(v) ? String(v[0] || '') : String(v);
    } catch (_) { return ''; }
}

/** The origin to echo, or '' when this origin may not read answers. */
export function corsOrigin(req, env) {
    const origin = originOf(req).trim().toLowerCase();
    if (!origin || origin === 'null') return '';
    return allowedOrigins(env).has(origin) ? origin : '';
}

/**
 * The CORS headers for this request as a plain object (usable for a Node `res` and for a
 * Web `Response`). Always carries `Vary: Origin`; carries the Allow-* set only for an
 * allow-listed origin.
 */
export function corsHeaders(req, { methods = ALLOWED_METHODS, headers = ALLOWED_REQUEST_HEADERS, env } = {}) {
    const out = { Vary: 'Origin' };
    const origin = corsOrigin(req, env);
    if (!origin) return out;
    out['Access-Control-Allow-Origin'] = origin;
    out['Access-Control-Allow-Methods'] = methods;
    out['Access-Control-Allow-Headers'] = headers;
    out['Access-Control-Max-Age'] = '600';
    return out;
}

/** Node `res`: write the headers. Never throws (a handler must not die over a header). */
export function applyCors(req, res, opts) {
    try {
        const h = corsHeaders(req, opts);
        for (const k of Object.keys(h)) {
            if (k === 'Vary') {
                const prev = typeof res.getHeader === 'function' ? res.getHeader('Vary') : '';
                const have = String(prev || '').split(',').map((s) => s.trim().toLowerCase());
                if (have.includes('origin') || have.includes('*')) continue;
                res.setHeader('Vary', prev ? String(prev) + ', Origin' : 'Origin');
            } else res.setHeader(k, h[k]);
        }
        return h;
    } catch (_) { return {}; }
}

/** True for a header a handler must not set for itself (the router owns CORS). */
export function isCorsHeader(name) {
    return /^access-control-/i.test(String(name || ''));
}

/**
 * Make `res` ignore any Access-Control-* header a handler tries to set. api/router.js sets the
 * correct ones once, from the allow-list, and then hands `res` to a handler written before this
 * rule existed (about twenty of them set `*` for themselves). Without this the handler's value
 * would win, because it is written later. Idempotent.
 */
export function lockCors(res) {
    try {
        if (!res || res.__wfCorsLocked || typeof res.setHeader !== 'function') return res;
        const set = res.setHeader.bind(res);
        res.setHeader = function (name, value) {
            if (isCorsHeader(name)) return res;
            return set(name, value);
        };
        const head = typeof res.writeHead === 'function' ? res.writeHead.bind(res) : null;
        if (head) {
            res.writeHead = function (status, a, b) {
                const hdrs = (a && typeof a === 'object' && !Array.isArray(a)) ? a : (b && typeof b === 'object' ? b : null);
                if (hdrs) for (const k of Object.keys(hdrs)) if (isCorsHeader(k)) delete hdrs[k];
                return head.apply(res, arguments);
            };
        }
        res.__wfCorsLocked = true;
    } catch (_) { /* a response that cannot be wrapped keeps the handler's own headers */ }
    return res;
}
