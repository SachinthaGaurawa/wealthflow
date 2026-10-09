/* =============================================================================
 * textlk.mjs — the Text.lk SMS gateway (API v3), and nothing else
 * -----------------------------------------------------------------------------
 * WHAT IT TALKS TO (read from the owner's Text.lk dashboard and docs, 2026-10-05):
 *
 *   OAuth 2.0 API endpoint   https://app.text.lk/api/v3/
 *   send                     POST sms/send   Authorization: Bearer <API token>
 *       { recipient: "94710000000", sender_id: "WealthFlow", type: "plain", message: "..." }
 *   answer                   { status: "success", message, data: { uid, to, from, status, cost, sms_count } }
 *                            { status: "error",   message: "<human readable>" }
 *
 * `https://text.lk` is the marketing site; the endpoint is app.text.lk.
 *
 * ── THREE RULES THAT SHAPE THE FILE ─────────────────────────────────────────
 *
 *  1. THE TOKEN NEVER LEAVES THIS MODULE. It is read from TEXTLK_API_TOKEN, put in
 *     one header, and scrubbed out of anything that is returned, thrown or logged.
 *     A gateway error that echoed it back (some do) cannot reach a log line.
 *
 *  2. A FAILURE IS CLASSIFIED, NEVER JUST "FAILED". The caller decides what to do
 *     (retry in a minute, hold until the balance is topped up, park until somebody
 *     fixes the token, give up on a number that can never receive) from `kind`.
 *     The account has few units left at the time of writing, so "out of credit"
 *     is a normal state this code must hold a message through, not drop it.
 *
 *  3. SUCCESS IS THE GATEWAY SAYING `status === "success"`, compared without
 *     regard to case. An HTTP 200 whose body says "error" is a failure; an HTTP
 *     error whose body cannot be read is a failure; and an answer that is neither
 *     is `unknown` — the message may have been sent, and the caller must not
 *     pretend either way.
 *
 * PURE EXCEPT FOR THE ONE fetch, which is injected, so every branch is tested
 * without a network.
 * ===========================================================================*/

import { readBody } from './fetch-timeout.mjs';

export const DEFAULT_BASE = 'https://app.text.lk/api/v3/';
export const DEFAULT_SENDER = 'WealthFlow';
export const SEND_TIMEOUT_MS = 12000;
export const TOKEN_ENV = 'TEXTLK_API_TOKEN';
export const SENDER_ENV = 'TEXTLK_SENDER_ID';

/** The failure kinds a caller can branch on. */
export const KIND = Object.freeze({
    CONFIG: 'config',                    // no token configured on this deployment
    INVALID_RECIPIENT: 'invalid-recipient',
    INVALID_MESSAGE: 'invalid-message',
    AUTH: 'auth',                        // token rejected: somebody has to fix it
    CREDIT: 'credit',                    // out of units: hold until topped up
    RATE_LIMIT: 'rate-limit',
    NETWORK: 'network',
    TIMEOUT: 'timeout',
    SERVER: 'server',
    SENDER: 'sender',                    // sender id not approved / not active
    BLOCKED: 'blocked',                  // number is blacklisted or can never receive
    DESTINATION: 'destination',          // this account cannot send to that country (no route, not enabled)
    REJECTED: 'rejected',                // the gateway refused this message
    UNKNOWN: 'unknown',                  // an answer that says neither yes nor no
});

/** Kinds worth trying again, and kinds that are not. `unknown` is retried, but the caller flags it as a possible duplicate. */
export const RETRYABLE = new Set([KIND.CREDIT, KIND.AUTH, KIND.RATE_LIMIT, KIND.NETWORK, KIND.TIMEOUT, KIND.SERVER, KIND.SENDER, KIND.UNKNOWN]);

const s = (v) => String(v == null ? '' : v);

/* ── phone numbers: E.164 in, E.164 out, the gateway's digits on the wire ───
 * Live in wealthflow-phone.js, which has no imports, so the page that takes the number and this server client apply ONE rule.
 * Re-exported here because this is where callers have always looked for them. */
import { DEFAULT_COUNTRY, normalizePhone, maskPhone } from './wealthflow-phone.js';
export { DEFAULT_COUNTRY, normalizePhone, maskPhone };

/* ── sender id ────────────────────────────────────────────────────────────── */

/** Alphanumeric, 3 to 11 characters, which is what a sender id is; or null. */
export function normalizeSenderId(raw) {
    const v = s(raw).trim();
    if (!/^[A-Za-z0-9]{3,11}$/.test(v)) return null;
    // The approved id is written "WealthFlow" on the Text.lk dashboard; any other capitalisation of it in an env var (WEALTHFLOW, wealthflow) means the same id and is sent as approved.
    return v.toLowerCase() === DEFAULT_SENDER.toLowerCase() ? DEFAULT_SENDER : v;
}

/** Sender ids are matched without regard to case. */
export const sameSender = (a, b) => s(a).trim().toLowerCase() === s(b).trim().toLowerCase();

/* ── what a message costs: GSM-7 or UCS-2, and how many parts ──────────────── */

const GSM7_BASIC = '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXTENDED = '^{}\\[~]|€';

/** Units, encoding and segment count, the way a gateway bills them. */
export function analyzeSms(text) {
    const t = s(text);
    let units = 0;
    let gsm = true;
    for (const ch of t) {
        if (GSM7_BASIC.includes(ch)) units += 1;
        else if (GSM7_EXTENDED.includes(ch)) units += 2;
        else { gsm = false; break; }
    }
    if (gsm) {
        const segments = units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153);
        return { encoding: 'GSM-7', units, segments };
    }
    const ucs = [...t].reduce((n, ch) => n + (ch.codePointAt(0) > 0xFFFF ? 2 : 1), 0);
    return { encoding: 'UCS-2', units: ucs, segments: ucs === 0 ? 0 : ucs <= 70 ? 1 : Math.ceil(ucs / 67) };
}

/** The most one message may be. A tenant statement notice is one part; the ceiling stops a template bug from turning into a costly wall of text. */
export const MAX_SEGMENTS = 3;

/* ── answers ──────────────────────────────────────────────────────────────── */

/** Remove the token (and its URL-encoded form) from any text before it goes anywhere. */
export function redact(text, token) {
    let out = s(text);
    const t = s(token).trim();
    if (t.length >= 6) {
        out = out.split(t).join('[token]');
        try { out = out.split(encodeURIComponent(t)).join('[token]'); } catch (_) { /* malformed */ }
    }
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=|-]{8,}/gi, 'Bearer [token]').slice(0, 300);
}

/** Classify a gateway failure from the HTTP status and whatever human-readable message came with it. */
export function classifyFailure(httpStatus, message) {
    const m = s(message).toLowerCase();
    if (/insufficient|not enough|enough (?:balance|credit|sms)|low (?:balance|credit)|out of (?:credit|units)|no (?:credit|units)|top.?up|sms units?|(?:balance|credit|units?)\b.{0,30}\b(?:low|exhausted|expired|zero|empty)/.test(m) && !/token|unauthor/.test(m)) return KIND.CREDIT;
    if (/unauthori[sz]ed|unauthenticated|invalid (?:api )?token|token .*(?:invalid|expired|revoked|mismatch)|api token|bearer|access denied/.test(m)) return KIND.AUTH;
    if (/sender/.test(m)) return KIND.SENDER;
    if (/\b(?:country|countries|route|routes|coverage|international|destination)\b.{0,50}\b(?:not|no|unsupported|disabled|restricted|unavailable|available|allowed|enabled|supported|covered)\b|\b(?:not|no|unsupported|disabled|restricted)\b.{0,30}\b(?:country|countries|route|routes|coverage|international|destination)\b/.test(m)) return KIND.DESTINATION;
    if (/blacklist|black list|blocked|opt.?out|dnd|do not disturb/.test(m)) return KIND.BLOCKED;
    if (/too many|rate limit|throttl|slow down/.test(m)) return KIND.RATE_LIMIT;
    if (/invalid (?:phone|recipient|number|destination)|destination (?:number|address)|recipient/.test(m)) return KIND.INVALID_RECIPIENT;
    if (httpStatus === 401 || httpStatus === 403) return KIND.AUTH;
    if (httpStatus === 402) return KIND.CREDIT;
    if (httpStatus === 429) return KIND.RATE_LIMIT;
    if (httpStatus === 408) return KIND.TIMEOUT;
    if (httpStatus >= 500) return KIND.SERVER;
    return KIND.REJECTED;
}

/** `Retry-After` in milliseconds, from seconds or an HTTP date; 0 when absent or unusable. Capped at a day. */
export function retryAfterMs(headerValue, now = Date.now()) {
    const v = s(headerValue).trim();
    if (!v) return 0;
    if (/^\d+$/.test(v)) return Math.min(86400000, Number(v) * 1000);
    const at = Date.parse(v);
    return Number.isFinite(at) ? Math.max(0, Math.min(86400000, at - now)) : 0;
}

const headerOf = (response, name) => {
    try { return response && response.headers && typeof response.headers.get === 'function' ? response.headers.get(name) : ''; } catch (_) { return ''; }
};

/* ── the client ───────────────────────────────────────────────────────────── */

export class TextLkClient {
    /**
     * @param {object} cfg
     * @param {string} cfg.token      the API token (TEXTLK_API_TOKEN). Never logged, never returned.
     * @param {string} [cfg.senderId] default WealthFlow
     * @param {string} [cfg.baseUrl]  default https://app.text.lk/api/v3/ (https only)
     * @param {Function} [cfg.fetchImpl] injected for tests
     * @param {number} [cfg.timeoutMs]
     * @param {Function} [cfg.now]
     */
    constructor({ token = '', senderId = DEFAULT_SENDER, baseUrl = DEFAULT_BASE, fetchImpl = null, timeoutMs = SEND_TIMEOUT_MS, now = Date.now } = {}) {
        const tok = s(token).trim();
        // a token pasted with its quotes, a line break or the word "Bearer" is the commonest way to be rejected for no visible reason
        this._token = tok.replace(/^["']+|["']+$/g, '').trim().replace(/^Bearer\s+/i, '').replace(/^["']+|["']+$/g, '').trim();
        this.senderId = normalizeSenderId(senderId) || DEFAULT_SENDER;
        let base = s(baseUrl).trim() || DEFAULT_BASE;
        if (!/^https:\/\/[\w.-]+(?::\d+)?\//.test(base)) base = DEFAULT_BASE;   // never plaintext, never a weird scheme
        this.baseUrl = base.endsWith('/') ? base : base + '/';
        this._fetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
        this.timeoutMs = Number(timeoutMs) > 0 ? Number(timeoutMs) : SEND_TIMEOUT_MS;
        this._now = typeof now === 'function' ? now : Date.now;
    }

    /** The one place the environment is read. */
    static fromEnv(env = process.env, deps = {}) {
        return new TextLkClient({
            token: env && env[TOKEN_ENV],
            senderId: (env && env[SENDER_ENV]) || DEFAULT_SENDER,
            baseUrl: (env && env.TEXTLK_API_BASE) || DEFAULT_BASE,
            ...deps,
        });
    }

    get configured() { return this._token.length >= 8; }

    toJSON() { return { configured: this.configured, senderId: this.senderId, baseUrl: this.baseUrl }; }

    _fail(kind, message, extra = {}) {
        return { ok: false, kind, retryable: RETRYABLE.has(kind), message: redact(message, this._token), ...extra };
    }

    async _call(method, path, body) {
        if (!this.configured) return { problem: this._fail(KIND.CONFIG, `${TOKEN_ENV} is not set on this deployment`) };
        if (typeof this._fetch !== 'function') return { problem: this._fail(KIND.CONFIG, 'no fetch available') };
        let response;
        try {
            response = await this._fetch(this.baseUrl + path, {
                method,
                headers: {
                    Authorization: `Bearer ${this._token}`,
                    Accept: 'application/json',
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: AbortSignal.timeout(this.timeoutMs),
            });
        } catch (e) {
            const timedOut = !!(e && (e.name === 'TimeoutError' || e.name === 'AbortError'));
            return { problem: this._fail(timedOut ? KIND.TIMEOUT : KIND.NETWORK, timedOut ? `no answer within ${this.timeoutMs}ms` : (e && e.message) || 'network error', { possiblySent: timedOut }) };
        }
        let text = '';
        // a body that stalls after the headers is read under the same deadline, and its connection is torn down rather than left half-read
        try { text = await readBody(response, 'text', this.timeoutMs); } catch (_) { text = ''; }
        let json = null;
        try { json = text ? JSON.parse(text) : null; } catch (_) { json = null; }
        return { response, json, text };
    }

    /**
     * Send one SMS.
     * @returns {{ok:true, gatewayId:string, segments:number, cost:number, encoding:string, to:string} | {ok:false, kind:string, retryable:boolean, message:string, retryAfterMs?:number, httpStatus?:number}}
     */
    async send({ to, message } = {}) {
        const phone = normalizePhone(to);
        if (!phone.ok) return this._fail(KIND.INVALID_RECIPIENT, `recipient refused: ${phone.reason}`);
        const text = s(message).replace(/\r\n?/g, '\n').trim();
        if (!text) return this._fail(KIND.INVALID_MESSAGE, 'empty message');
        const a = analyzeSms(text);
        if (a.segments > MAX_SEGMENTS) return this._fail(KIND.INVALID_MESSAGE, `message is ${a.segments} parts (limit ${MAX_SEGMENTS})`);

        const out = await this._call('POST', 'sms/send', { recipient: phone.gateway, sender_id: this.senderId, type: 'plain', message: text });
        if (out.problem) return out.problem;
        const { response, json, text: raw } = out;
        const httpStatus = response.status;
        const status = s(json && json.status).trim().toLowerCase();
        const gatewayMessage = s(json && json.message) || s(raw).slice(0, 200);

        if (status === 'success' && response.ok !== false) {
            const d = (json && json.data && typeof json.data === 'object') ? json.data : {};
            return {
                ok: true,
                gatewayId: s(d.uid || d.id || '').slice(0, 80),
                segments: Number(d.sms_count) > 0 ? Number(d.sms_count) : a.segments,
                cost: Number.isFinite(Number(d.cost)) ? Number(d.cost) : 0,
                encoding: a.encoding,
                to: phone.e164,
            };
        }
        if (status === 'error' || (httpStatus >= 400 && httpStatus < 600)) {
            const kind = classifyFailure(httpStatus, gatewayMessage);
            const after = kind === KIND.RATE_LIMIT ? retryAfterMs(headerOf(response, 'retry-after'), this._now()) : 0;
            return this._fail(kind, gatewayMessage || `HTTP ${httpStatus}`, { httpStatus, ...(after ? { retryAfterMs: after } : {}) });
        }
        // 2xx with a body that says neither success nor error: the message may well have gone
        return this._fail(KIND.UNKNOWN, `unreadable answer (HTTP ${httpStatus}): ${gatewayMessage}`, { httpStatus, possiblySent: true });
    }

    /** Units left on the account. Free to call; never sends. */
    async balance() {
        const out = await this._call('GET', 'balance');
        if (out.problem) return out.problem;
        const { response, json, text } = out;
        const status = s(json && json.status).trim().toLowerCase();
        if (status === 'success' && json && json.data) {
            const d = json.data;
            const units = Number(d.remaining_unit ?? d.remaining ?? d.balance ?? d.sms_balance);
            return { ok: true, units: Number.isFinite(units) ? units : null, expiresOn: s(d.expired_on || d.expires_on || '') || null };
        }
        const kind = classifyFailure(response.status, s(json && json.message) || text);
        return this._fail(kind === KIND.REJECTED && response.status === 404 ? KIND.UNKNOWN : kind, s(json && json.message) || `HTTP ${response.status}`, { httpStatus: response.status });
    }
}

export default { TextLkClient, KIND, RETRYABLE, normalizePhone, maskPhone, normalizeSenderId, sameSender, analyzeSms, classifyFailure, redact, retryAfterMs, DEFAULT_BASE, DEFAULT_SENDER, MAX_SEGMENTS };
