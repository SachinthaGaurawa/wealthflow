/* =============================================================================
 * tenant-portal.js  ->  /api/tenant-portal
 * -----------------------------------------------------------------------------
 * The one public endpoint behind the page a text message links to (/t/<token>).
 * Public means anyone on the internet can call it, so everything below assumes the
 * caller is hostile. The rules are in tenant-portal.mjs; this file is the HTTP skin.
 *
 *   POST /api/tenant-portal   Content-Type: application/json
 *     { action: 'request',   token, nic }          -> the same answer for every input that is well formed
 *     { action: 'verify',    token, nic, code }    -> 200 + Set-Cookie on success, else one refusal
 *     { action: 'statement', token }               -> the statement, for the cookie's session (which must be this link's)
 *     { action: 'pdf', token }                     -> the same statement as a PDF file (application/pdf, an attachment), same session rule
 *     { action: 'logout', token }                  -> ends the session
 *
 * WHAT IS CHECKED BEFORE ANYTHING ELSE
 *   - POST only, and JSON only: a form posted from another site cannot carry that content type
 *     without a pre-flight this endpoint never grants (no CORS headers are ever sent).
 *   - Origin / Sec-Fetch-Site must be this site's own. The cookie is SameSite=Strict as well;
 *     either alone would do, both is cheap.
 *   - Nothing is cached, nothing is indexed, nothing is framed: every answer says so.
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
import { portalSecret } from './tenant-links.mjs';
import { statementPdf, pdfFileName } from './tenant-pdf.mjs';
import {
    MSG, LIMITS, requestCode, verifyCode, readSession, loadStatement, endSession, hit, ipKey, clearCookie,
} from './tenant-portal.mjs';

const MAX_BODY_CHARS = 2000;
const HOUR = 3600e3;

function send(res, out) {
    res.statusCode = out.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
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
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.end(file);
}

const fail = (status, error, extra = {}) => ({ status, body: { ok: false, error }, ...extra });
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
        const action = String(body.action || '');

        if (action === 'request') {
            const out = await requestCode({ db, client: deps.client(), token: String(body.token || ''), nic: String(body.nic || ''), ip, secret, now, random: deps.randomInt, pad: deps.pad || undefined });
            return send(res, out);
        }
        if (action === 'verify') {
            return send(res, await verifyCode({ db, token: String(body.token || ''), nic: String(body.nic || ''), code: String(body.code || ''), ip, secret, now, randomBytes: deps.randomBytes }));
        }
        if (action === 'statement' || action === 'logout') {
            const gate = await hit(db, `st-${ip}`, LIMITS.statementsPerIpHour, HOUR, now);
            if (!gate.ok) return send(res, { status: 429, body: { ok: false, error: MSG.SLOW_DOWN, retryAfterSec: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)) } });
            const live = await readSession({ db, cookieHeader: header(req, 'cookie'), now });
            if (!live) return send(res, fail(401, MSG.NO_SESSION, { cookie: clearCookie() }));
            // a session belongs to one link: the page of another link does not get to read it (and does not get to end it either)
            if (String(body.token || '') !== live.token) return send(res, fail(401, MSG.NO_SESSION));
            if (action === 'logout') { await endSession({ db, live }); return send(res, { status: 200, body: { ok: true }, cookie: clearCookie() }); }
            const statement = await loadStatement({ db, live, secret, now });
            return send(res, { status: 200, body: { ok: true, statement, expiresAt: Number(live.session.expiresAt) || 0 } });
        }
        if (action === 'pdf') {
            const gate = await hit(db, `pd-${ip}`, LIMITS.pdfsPerIpHour, HOUR, now);
            if (!gate.ok) return send(res, { status: 429, body: { ok: false, error: MSG.SLOW_DOWN, retryAfterSec: Math.max(1, Math.ceil(gate.retryAfterMs / 1000)) } });
            const live = await readSession({ db, cookieHeader: header(req, 'cookie'), now });
            if (!live) return send(res, fail(401, MSG.NO_SESSION, { cookie: clearCookie() }));
            if (String(body.token || '') !== live.token) return send(res, fail(401, MSG.NO_SESSION));
            const statement = await loadStatement({ db, live, secret, now });
            return sendPdf(res, statementPdf(statement, { generatedAt: now }), pdfFileName(statement.asOf));
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
});

export default async function handler(req, res) {
    const deps = defaultDeps();
    deps.pad = padFrom(Date.now());
    return handlePortal(req, res, deps);
}
