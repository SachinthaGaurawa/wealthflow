/* =============================================================================
 * tenant-portal.js  ->  /api/tenant-portal
 * -----------------------------------------------------------------------------
 * The one public endpoint behind the page a text message links to (/t/<token>).
 * Public means anyone on the internet can call it, so everything below assumes the
 * caller is hostile. The rules are in tenant-portal.mjs; this file is the HTTP skin.
 *
 *   POST /api/tenant-portal   Content-Type: application/json
 *     { action: 'request',   token, nic }          -> 200 + the masked phone when the NIC is the link's (a code is sent); 401 for a wrong NIC, an unknown link or a dead link (one answer for all three); 409 when the NIC is right but no text can go out
 *     { action: 'verify',    token, nic, code }    -> 200 + Set-Cookie on success, else one refusal
 *     { action: 'statement', token }               -> the statement, for the cookie's session (which must be this link's)
 *     { action: 'pdf', token, lang? }              -> the same statement as a PDF file (application/pdf, an attachment), same session rule; lang 'si' = Sinhala, anything else English
 *     { action: 'logout', token }                  -> ends the session
 *
 * WHAT IS CHECKED BEFORE ANYTHING ELSE
 *   - POST only, and JSON only: a form posted from another site cannot carry that content type
 *     without a pre-flight this endpoint never grants (no CORS headers are ever sent).
 *   - Origin / Sec-Fetch-Site must be this site's own. The cookie is SameSite=Strict as well;
 *     either alone would do, both is cheap.
 *   - Nothing is cached, nothing is indexed, nothing is framed: every answer says so. No CORS header is ever sent (the router skips
 *     this route for them, and this file removes any that arrive), and a request that is refused in bulk leaves one line a minute in the log.
 *
 * WHAT IS NEVER DONE: logging the NIC, the code, the cookie or the request body. Errors are
 * logged by message only, and the caller gets one fixed sentence.
 *
 * ENV: TEXTLK_API_TOKEN, TEXTLK_SENDER_ID (the code goes out like any other text),
 *      TENANT_PORTAL_SECRET (else OTP_SECRET, else derived), FIREBASE_SERVICE_ACCOUNT.
 * ===========================================================================*/

import crypto from 'node:crypto';
import { getAdminDb } from './admin-db.mjs';
import { TextLkClient } from './textlk.mjs';
import { platformWaitUntil } from './statement-chain.mjs';
import { portalSecret } from './tenant-links.mjs';
import { publicOrigin } from './wealthflow-public-identity.mjs';
import { renderStatementPdf, pdfFileName } from './tenant-pdf.mjs';
import {
    MSG, LIMITS, requestCode, verifyCode, readSession, loadStatement, endSession, hit, ipKey, clearCookie,
} from './tenant-portal.mjs';

const MAX_BODY_CHARS = 2000;
const HOUR = 3600e3;

/**
 * Said on every answer, JSON or file. None of it is needed to read the answer; all of it shuts a door that something else
 * could one day open: another site reading it (Cross-Origin-Resource-Policy), a browser treating it as a page that can run or be
 * framed (the sandboxed, empty policy and X-Frame-Options), a proxy or the back button keeping it (no-store).
 */
const SAFE_HEADERS = Object.freeze({
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'X-Robots-Tag': 'noindex, nofollow',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; sandbox",
});
const putSafeHeaders = (res) => { for (const [k, v] of Object.entries(SAFE_HEADERS)) res.setHeader(k, v); };

/** CORS headers are never sent by this door, whatever put them on the response before it got here (the API router sets them for the other endpoints). */
const CORS_HEADERS = ['Access-Control-Allow-Origin', 'Access-Control-Allow-Methods', 'Access-Control-Allow-Headers', 'Access-Control-Allow-Credentials', 'Access-Control-Expose-Headers', 'Access-Control-Max-Age'];
const dropCors = (res) => { if (res && typeof res.removeHeader === 'function') for (const h of CORS_HEADERS) res.removeHeader(h); };

/**
 * Someone being refused in bulk should be visible to the owner without the log filling up: one line a minute per kind and per server
 * instance, a count of how many were refused since, and nothing about who (no address, no link, no NIC, no code).
 */
const GUARD_EVERY_MS = 60e3;
const guardSeen = new Map();
export function guardNote(kind, now = Date.now()) {
    const g = guardSeen.get(kind) || { at: 0, n: 0 };
    g.n += 1;
    if (now - g.at >= GUARD_EVERY_MS) {
        console.warn(`[WF-PORTAL-GUARD] refused: ${kind} (${g.n} since the last note)`);
        g.at = now; g.n = 0;
    }
    guardSeen.set(kind, g);
}
const GUARD_KINDS = Object.freeze({ 403: 'request from another site', 429: 'too many attempts or a locked link' });

function send(res, out) {
    res.statusCode = out.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    putSafeHeaders(res);
    if (GUARD_KINDS[out.status]) guardNote(GUARD_KINDS[out.status]);
    if (out.status === 429 && out.body && out.body.retryAfterSec) res.setHeader('Retry-After', String(out.body.retryAfterSec));
    if (out.cookie) res.setHeader('Set-Cookie', out.cookie);
    res.end(JSON.stringify(out.body));
}

/** A log line is a message, never data: digit runs (an NIC, a code, a phone number) are blanked in case an exception ever quotes its input. */
const scrub = (e) => String((e && e.message) || e).replace(/\d{9}[vVxX]/g, '#').replace(/\d{4,}/g, '#').slice(0, 160);

/** The statement file. It is personal, so it is never cached or indexed, and it always downloads (the browser is told not to sniff it into something else). */
function sendPdf(res, file, name) {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.setHeader('Content-Length', String(file.length));
    putSafeHeaders(res);
    res.end(file);
}

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error }, ...extra });
/** A field is text or it is nothing: an object that carries its own toString (or a number, a list, null) is never turned into a string by guesswork, because that is where a hostile body could make String() throw. */
const text = (v) => (typeof v === 'string' ? v : '');
const header = (req, name) => { const v = req.headers && req.headers[name]; return Array.isArray(v) ? v[0] : v; };

/** Only the site's own pages may call this. A caller with no browser headers at all is not a browser, so the cookie is not at risk from it. */
export function sameSite(req) {
    const fetchSite = String(header(req, 'sec-fetch-site') || '').toLowerCase();
    if (fetchSite && fetchSite !== 'same-origin') return false;
    const origin = String(header(req, 'origin') || '');
    if (!origin) return true;
    try { return new URL(origin).host === String(header(req, 'host') || ''); } catch (_) { return false; }
}

/** The body as an object, or null. Anything that is not a small JSON object is refused. */
export function readBody(req) {
    const type = String(header(req, 'content-type') || '').toLowerCase();
    if (!type.startsWith('application/json')) return null;
    let body = req.body;
    if (typeof body === 'string') {
        if (body.length > MAX_BODY_CHARS) return null;
        try { body = JSON.parse(body); } catch (_) { return null; }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (JSON.stringify(body).length > MAX_BODY_CHARS) return null;
    return body;
}

export async function handlePortal(req, res, deps) {
    try {
        dropCors(res);
        if (String(req.method || '').toUpperCase() !== 'POST') { res.setHeader('Allow', 'POST'); return send(res, fail(405, 'method not allowed')); }
        if (!sameSite(req)) return send(res, fail(403, MSG.FAILED));
        const body = readBody(req);
        if (!body) return send(res, fail(400, MSG.FAILED));

        let secret;
        try { secret = portalSecret(deps.env); } catch (_) { return send(res, fail(503, MSG.UNAVAILABLE)); }
        const { db, reason } = await deps.getAdminDb();
        if (!db) { console.warn('[WF-PORTAL] database unavailable:', scrub(reason)); return send(res, fail(503, MSG.UNAVAILABLE)); }

        const now = deps.now();
        const ip = ipKey(req, secret);
        const action = text(body.action);

        if (action === 'request') {
            const out = await requestCode({ db, client: deps.client(), token: text(body.token), nic: text(body.nic), ip, secret, now, random: deps.randomInt, pad: deps.pad || undefined, defer: deps.waitUntil ? deps.waitUntil() : null, host: new URL(publicOrigin(deps.env)).host });
            return send(res, out);
        }
        if (action === 'verify') {
            const out = await verifyCode({ db, token: text(body.token), nic: text(body.nic), code: text(body.code), ip, secret, now, randomBytes: deps.randomBytes, defer: deps.waitUntil ? deps.waitUntil() : null });
            // The person who has just proved who they are is going to ask for the statement next: it is read now and sent with this answer, so the
            // page needs no second trip. If it cannot be read, the answer is the same without it and the page asks for it the usual way.
            if (out.status === 200 && out.ctx) {
                try { out.body = { ...out.body, statement: await loadStatement({ db, live: out.ctx, secret, now }) }; }
                catch (e) { console.warn('[WF-PORTAL] statement not bundled:', scrub(e)); }
            }
            return send(res, out);
        }
        if (action === 'statement' || action === 'logout') {
            const gate = await hit(db, `st-${ip}`, LIMITS.statementsPerIpHour, HOUR, now);
            if (!gate.ok) return send(res, { status: 429, body: { ok: false, error: MSG.SLOW_DOWN, retryAfterSec: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)) } });
            const live = await readSession({ db, cookieHeader: header(req, 'cookie'), now });
            if (!live) return send(res, fail(401, MSG.NO_SESSION, { cookie: clearCookie() }));
            // a session belongs to one link: the page of another link does not get to read it (and does not get to end it either)
            if (text(body.token) !== live.token) return send(res, fail(401, MSG.NO_SESSION));
            if (action === 'logout') { await endSession({ db, live }); return send(res, { status: 200, body: { ok: true }, cookie: clearCookie() }); }
            const statement = await loadStatement({ db, live, secret, now });
            return send(res, { status: 200, body: { ok: true, statement, expiresAt: Number(live.session.expiresAt) || 0 } });
        }
        if (action === 'pdf') {
            const gate = await hit(db, `pd-${ip}`, LIMITS.pdfsPerIpHour, HOUR, now);
            if (!gate.ok) return send(res, { status: 429, body: { ok: false, error: MSG.SLOW_DOWN, retryAfterSec: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)) } });
            const live = await readSession({ db, cookieHeader: header(req, 'cookie'), now });
            if (!live) return send(res, fail(401, MSG.NO_SESSION, { cookie: clearCookie() }));
            if (text(body.token) !== live.token) return send(res, fail(401, MSG.NO_SESSION));
            const statement = await loadStatement({ db, live, secret, now });
            // the language the person is reading the page in: anything but 'si' is English, so a request cannot choose what it should not
            const lang = body.lang === 'si' ? 'si' : 'en';
            return sendPdf(res, await (deps.renderPdf || renderStatementPdf)(statement, { generatedAt: now, lang }), pdfFileName(statement.asOf));
        }
        return send(res, fail(400, MSG.FAILED));
    } catch (e) {
        console.error('[WF-PORTAL] failed:', scrub(e));
        return send(res, fail(500, MSG.FAILED));
    }
}

/** Waits until `started + ms`, so a request that does nothing is not visibly faster than one that texts. */
const padFrom = (now) => async (ms) => {
    const wait = ms - (Date.now() - now);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
};

export const defaultDeps = () => ({
    client: () => TextLkClient.fromEnv(process.env),
    getAdminDb,
    env: process.env,
    now: () => Date.now(),
    randomInt: crypto.randomInt,
    randomBytes: crypto.randomBytes,
    pad: null,
    waitUntil: platformWaitUntil,
});

export default async function handler(req, res) {
    const deps = defaultDeps();
    deps.pad = padFrom(Date.now());
    return handlePortal(req, res, deps);
}
