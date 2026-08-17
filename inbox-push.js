// =============================================================================
// WealthFlow Inbox Push (server-side) v3.0
//
// Stores a classified transaction in Firestore via the REST API. Uses the
// user's own Firebase project — no new infrastructure. Per-device isolation
// via a hashed token in the document path.
//
// Storage:
//   Path:  wf-inbox/{tokenHash}/items/{msgHash}
//   Doc:   { brain_result, received_at_ms, sms_preview, applied: false }
//   TTL:   none (cleared by the client after apply, via inbox-ack)
//
// Env: FIREBASE_PROJECT_ID (defaults to wealthflow-6dffb), FIREBASE_API_KEY
// -----------------------------------------------------------------------------
// v3.0 — TWO DEFECTS, BOTH OF WHICH REPORTED SUCCESS THEY NEVER ACHIEVED
//
// 1. THE CALLING CONVENTION. This file used to open with:
//
//        export default async function handler(req) {
//            if (!_requireFirebaseKey(res) return;
//
//    `res` was never a parameter. The first statement of every request threw
//    `ReferenceError: res is not defined`; api/router.js caught it and answered
//    500 "Endpoint runtime crash". Every SMS the iOS Shortcut ever forwarded was
//    classified correctly and then dropped here — and sms-ingest.js did not read
//    the status code, so it went on reporting `inboxed: true`.
//
//    The convention is Node's `(req, res)`, NOT the Web Fetch API, despite the
//    `runtime: 'edge'` line this file used to carry. Vercel reads a `config`
//    export only from files it BUILDS as functions; this one is imported by
//    api/router.js, which is a Node function. That export has been removed
//    rather than left to mislead the next reader. See the bridge comment in
//    api/router.js for how the two conventions are now told apart.
//
// 2. A WRITE FAILURE WAS INDISTINGUISHABLE FROM A WRITE. fsPut() answered `true`
//    from inside its own catch block after stashing the item in a per-instance
//    Map, and the handler returned `{ ok: true }` with status 200 regardless.
//    So a Firestore write that was rejected looked exactly like a durable
//    save — and a rejection is the likeliest failure this endpoint has, because
//    it is the one thing about the request that no code here controls. That
//    memory Map is per-instance: the next request almost
//    certainly lands on a different serverless instance and cannot see it, so
//    "saved" meant "lost" and said "saved".
//
//    It now reports what actually happened, and answers 502 when the item is not
//    durable, so a caller checking `res.ok` learns the truth.
// =============================================================================

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'wealthflow-6dffb';
// The Firebase Web apiKey is a public project identifier, not a secret — but it is
// read from the environment here so no credential-shaped literal lives in the repo.
// That keeps the CI secret scanner strict: it can reject every AIzaSy... literal
// outright, instead of needing an allowlist that a real Gemini key could hide behind.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

// Fail loudly, not mysteriously. If the key is not configured, say so plainly
// instead of issuing Firestore requests with `key=undefined` and returning a
// confusing 400.
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

// Fallback in-memory store (shared across endpoint modules via globalThis). It
// only ever helps within one warm instance; it is NOT durability, and nothing in
// this file may report it as such.
const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

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

/** Never let the `key=` query parameter reach a response body or a log line. */
function _scrub(s) {
    return String(s == null ? '' : s).replace(/key=[^&\s"']+/gi, 'key=[redacted]').slice(0, 300);
}

// Convert a plain JSON value to Firestore REST API "fields" format
function toFsValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') {
        return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(toFsValue) } };
    if (typeof v === 'object') {
        const fields = {};
        for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
        return { mapValue: { fields } };
    }
    return { stringValue: String(v) };
}

/** PATCH one document. Returns what happened — never a bare boolean, because
 *  "the write was refused" and "the write landed" were the two states this
 *  function used to collapse into `true`. */
async function fsPut(path, doc, timeoutMs = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: toFsValue(doc).mapValue.fields }),
            signal: ctl.signal,
        });
        if (r.ok) return { ok: true, status: r.status, detail: null };
        let detail = '';
        try {
            const j = await r.json();
            detail = (j && j.error && j.error.message) || '';
        } catch (_) {}
        return { ok: false, status: r.status, detail: _scrub(detail) || `HTTP ${r.status}` };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || ctl.signal.aborted);
        return {
            ok: false,
            status: 0,
            detail: aborted ? `Firestore did not answer within ${timeoutMs}ms` : _scrub(e && e.message),
        };
    } finally {
        clearTimeout(timer);
    }
}

async function tokenHash(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
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

    const brain = body.brain_result;
    if (!brain || !brain.hash) {
        res.status(400).json({ ok: false, error: 'brain_result with hash required' });
        return;
    }

    const tHash = await tokenHash(tok);
    const docPath = `wf-inbox/${tHash}/items/${brain.hash}`;
    const entry = {
        brain_result: brain,
        received_at_ms: body.received_at_ms || Date.now(),
        applied: false,
        sms_preview: String(body.sms || '').slice(0, 140),
    };

    const wrote = await fsPut(docPath, entry);

    // Keep the in-instance copy — it costs nothing and occasionally helps a warm
    // instance serve its own write back — but it is not what success means, so it
    // carries whether the durable write behind it landed. Without that flag,
    // inbox-pull would serve a memory-only item as though it were stored, and the
    // dishonesty this endpoint just stopped would simply move one hop downstream.
    _memStore.set(docPath, { v: entry, exp: Date.now() + WEEK_MS, durable: wrote.ok });


    if (!wrote.ok) {
        // 502, not 200: the item is memory-only, which for a serverless instance
        // means the app polling from a different instance will never see it. The
        // caller has to be able to tell this apart from a durable save.
        res.status(502).json({
            ok: false,
            error: 'inbox_not_durable',
            key: docPath,
            firestore: false,
            durable: false,
            detail: `Firestore refused the write (${wrote.detail}). The item is held in this `
                + 'instance\'s memory only and will not survive; the classification is in this response.',
        });
        return;
    }

    res.status(200).json({ ok: true, key: docPath, firestore: true, durable: true });
}
