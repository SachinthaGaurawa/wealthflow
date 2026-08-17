// =============================================================================
// WealthFlow Inbox Ack v3.0 — delete applied items from Firestore + memory.
// -----------------------------------------------------------------------------
// v3.0 — TWO DEFECTS
//
// 1. THE CALLING CONVENTION. The handler was `handler(req)` and its first
//    statement was `if (!_requireFirebaseKey(res)) return;` — `res` was never
//    declared, so every request threw `ReferenceError: res is not defined` and
//    api/router.js answered 500. The app's ACK call sits inside
//    `try { ... } catch (_) {}` (wealthflow-autonomous.js), so the failure was
//    swallowed at both ends.
//
//    The convention is Node's `(req, res)`, NOT the Web Fetch API, despite the
//    `runtime: 'edge'` line this file used to carry. Vercel reads a `config`
//    export only from files it BUILDS as functions; this one is imported by
//    api/router.js, which is a Node function. That export has been removed
//    rather than left to mislead the next reader.
//
// 2. `deleted` COUNTED ATTEMPTS, NOT DELETIONS:
//
//        _memStore.delete(k);
//        await fsDelete(k);     // returns false on failure — discarded
//        deleted++;             // incremented anyway
//
//    fsDelete's answer was thrown away, so a Firestore rules rejection produced
//    `{ ok: true, deleted: 5 }` with all five documents still present. The next
//    poll re-pulls them and re-applies them; only the client-side duplicate
//    check stops five transactions being logged twice, and that check is the last
//    line of defence rather than the first. The count now reflects deletions that
//    actually happened, and failures are named.
// =============================================================================

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'wealthflow-6dffb';
// The Firebase Web apiKey is a public project identifier, not a secret — but it is
// read from the environment here so no credential-shaped literal lives in the repo.
// That keeps the CI secret scanner strict: it can reject every AIzaSy... literal
// outright, instead of needing an allowlist that a real Gemini key could hide behind.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

function _requireFirebaseKey(res) {
    if (FIREBASE_API_KEY) return true;
    res.status(503).json({
        ok: false,
        error: 'firebase_key_not_configured',
        detail: 'FIREBASE_API_KEY is not configured on this deployment. '
            + 'Set it in Vercel → Project → Settings → Environment Variables. '
            + '(It is the public Firebase Web apiKey — no longer hardcoded in the repo.)',
    });
    return false;
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

/** Never let the `key=` query parameter reach a response body or a log line. */
function _scrub(s) {
    return String(s == null ? '' : s).replace(/key=[^&\s"']+/gi, 'key=[redacted]').slice(0, 300);
}

/** Vercel hands a Node handler an already-parsed body for JSON content types,
 *  but not for every content type, so cover the shapes it can actually be.
 *  Throws on malformed JSON — the caller turns that into a 400. */
function _jsonBody(req) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
    const text = Buffer.isBuffer(b) ? b.toString('utf8') : (typeof b === 'string' ? b : '');
    if (!text.trim()) throw new Error('empty body');
    return JSON.parse(text);
}

async function tokenHash(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Delete one document. Returns `{ ok, detail }` — the boolean this used to
 *  return was discarded by the caller, which is how the count started lying. */
async function fsDelete(path, timeoutMs = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`,
            { method: 'DELETE', signal: ctl.signal });
        if (r.ok) return { ok: true, detail: null };
        let detail = '';
        try { const j = await r.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
        return { ok: false, detail: _scrub(detail) || `HTTP ${r.status}` };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || ctl.signal.aborted);
        return {
            ok: false,
            detail: aborted ? `Firestore did not answer within ${timeoutMs}ms` : _scrub(e && e.message),
        };
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req, res) {
    if (!_requireFirebaseKey(res)) return;
    if (req.method !== 'POST') {
        res.status(405).json({ ok: false, error: 'POST required' });
        return;
    }

    let body;
    try { body = _jsonBody(req); }
    catch (_) { res.status(400).json({ ok: false, error: 'Invalid JSON' }); return; }

    const tok = String(body.device_token || req.headers['x-wf-device-token'] || '').trim();
    if (!tok || tok.length < 16) {
        res.status(401).json({ ok: false, error: 'Token required' });
        return;
    }

    const keys = Array.isArray(body.keys) ? body.keys : [];
    const tHash = await tokenHash(tok);
    // The capability check: a token can only ever delete under its own hash, so a
    // key naming someone else's prefix — or climbing out with ../ — is refused
    // before it reaches Firestore.
    const expectedPrefix = `wf-inbox/${tHash}/items/`;

    let deleted = 0;
    const rejected = [];
    const failed = [];
    for (const k of keys) {
        const key = String(k == null ? '' : k);
        if (!key.startsWith(expectedPrefix) || key.includes('..')) { rejected.push(key.slice(0, 80)); continue; }
        _memStore.delete(key);
        const gone = await fsDelete(key);
        if (gone.ok) deleted++;
        else failed.push({ key: key.slice(0, 80), detail: gone.detail });
    }

    // A key the caller asked us to delete that is still there will be pulled and
    // applied again, so a partial failure is a real one and gets a real status.
    const status = failed.length ? 502 : 200;
    const out = { ok: failed.length === 0, deleted, requested: keys.length };
    if (rejected.length) out.rejected = rejected;
    if (failed.length) {
        out.error = 'ack_incomplete';
        out.failed = failed;
        out.detail = `${failed.length} of ${keys.length} item(s) could not be deleted and will be pulled again.`;
    }
    res.status(status).json(out);
}
