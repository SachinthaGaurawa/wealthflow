// =============================================================================
// WealthFlow Inbox Pull (server-side) v3.0
// Reads pending classified transactions from Firestore, plus this instance's
// memory fallback.
// -----------------------------------------------------------------------------
// v3.0 — TWO DEFECTS, BOTH SILENT
//
// 1. THE CALLING CONVENTION. The handler was `handler(req)` and its first
//    statement was `if (!_requireFirebaseKey(res)) return;` — `res` was never
//    declared, so every request threw `ReferenceError: res is not defined` and
//    api/router.js answered 500. The app's poller
//    (wealthflow-autonomous.js → drainServerInbox) does check `r.ok`, so it
//    correctly reported `drained: 0` — into a `catch (_) {}` that nobody reads.
//    Nothing above it ever said the inbox was unreachable.
//
//    The convention is Node's `(req, res)`, NOT the Web Fetch API, despite the
//    `runtime: 'edge'` line this file used to carry. Vercel reads a `config`
//    export only from files it BUILDS as functions; this one is imported by
//    api/router.js, which is a Node function. That export has been removed
//    rather than left to mislead the next reader.
//
// 2. A FAILED READ LOOKED LIKE AN EMPTY INBOX. fsList() returned `[]` from its
//    catch block and `[]` again on `!r.ok`, so "Firestore refused me" and "there
//    is nothing waiting" were the same answer. The poller then reported
//    `drained: 0` — accurate, and completely misleading. This is the most
//    dangerous shape a bug can take here: it suppresses rather than
//    over-reports, and nobody files a report for a transaction they were never
//    shown. It now answers 502 when the read failed, so the caller can tell the
//    difference.
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

async function tokenHash(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Convert Firestore REST "fields" format back to plain JSON
function fromFsValue(v) {
    if (!v || typeof v !== 'object') return null;
    if ('stringValue' in v) return v.stringValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return v.doubleValue;
    if ('nullValue' in v) return null;
    if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromFsValue);
    if ('mapValue' in v) {
        const out = {};
        for (const k of Object.keys(v.mapValue.fields || {})) out[k] = fromFsValue(v.mapValue.fields[k]);
        return out;
    }
    return null;
}

/** List a collection. Returns `{ ok, items, detail }` — never a bare array,
 *  because an empty array cannot say whether it means "nothing waiting" or
 *  "I was not allowed to look". */
async function fsList(collectionPath, timeoutMs = 8000) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
        const r = await fetch(`${FS_BASE}/${collectionPath}?key=${FIREBASE_API_KEY}&pageSize=50`,
            { signal: ctl.signal });
        if (!r.ok) {
            let detail = '';
            try { const j = await r.json(); detail = (j && j.error && j.error.message) || ''; } catch (_) {}
            return { ok: false, items: [], detail: _scrub(detail) || `HTTP ${r.status}` };
        }
        const data = await r.json();
        const items = (data.documents || []).map((d) => ({
            key: d.name.split('/').slice(-4).join('/'),  // wf-inbox/<hash>/items/<msgHash>
            ...fromFsValue({ mapValue: { fields: d.fields } }),
        }));
        return { ok: true, items, detail: null };
    } catch (e) {
        const aborted = e && (e.name === 'AbortError' || ctl.signal.aborted);
        return {
            ok: false,
            items: [],
            detail: aborted ? `Firestore did not answer within ${timeoutMs}ms` : _scrub(e && e.message),
        };
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req, res) {
    if (!_requireFirebaseKey(res)) return;

    // The header is what the app actually sends (wealthflow-autonomous.js).
    // ?token= is retained for the manual-debug path it was added for; it is a
    // weaker channel because query strings land in access logs, which is filed as
    // an open finding rather than changed here without the owner's say-so.
    const tok = String(
        req.headers['x-wf-device-token']
        || (req.query && req.query.token)
        || '',
    ).trim();
    if (!tok || tok.length < 16) {
        res.status(401).json({ ok: false, error: 'Token required' });
        return;
    }

    const tHash = await tokenHash(tok);
    const collection = `wf-inbox/${tHash}/items`;

    const listed = await fsList(collection);

    const memPrefix = `${collection}/`;
    const memItems = [];
    const now = Date.now();
    for (const [k, v] of _memStore.entries()) {
        if (k.startsWith(memPrefix) && (!v.exp || v.exp > now)) memItems.push({ key: k, ...v.v });
    }

    // Deduplicate by key (Firestore wins if both have it)
    const map = new Map();
    for (const i of memItems) map.set(i.key, i);
    for (const i of listed.items) map.set(i.key, i);
    const items = Array.from(map.values());

    if (!listed.ok) {
        // 502 even when the memory fallback produced items: this instance cannot
        // see the durable inbox, so `count` is a floor and not a total. Answering
        // 200 here is what let a broken read read as an empty inbox.
        res.status(502).json({
            ok: false,
            error: 'inbox_read_failed',
            detail: `Firestore refused the read (${listed.detail}). `
                + 'Any items below come from this instance\'s memory only and may be incomplete.',
            count: items.length,
            items,
        });
        return;
    }

    res.status(200).json({ ok: true, count: items.length, items });
}
