// =============================================================================
// WealthFlow Inbox Ack v2.0 — delete applied items from Firestore + memory.
// =============================================================================

export const config = { runtime: 'edge' };

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'wealthflow-6dffb';
// The Firebase Web apiKey is a public project identifier, not a secret — but it is
// read from the environment here so no credential-shaped literal lives in the repo.
// That keeps the CI secret scanner strict: it can reject every AIzaSy... literal
// outright, instead of needing an allowlist that a real Gemini key could hide behind.
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY;

// Fail loudly, not mysteriously. This value moved from a hardcoded literal to an
// environment variable; if it is not configured, say so plainly instead of
// issuing Firestore requests with `key=undefined` and returning a confusing 400.
function _requireFirebaseKey(res) {
    if (FIREBASE_API_KEY) return true;
    const msg = 'FIREBASE_API_KEY is not configured on this deployment. '
        + 'Set it in Vercel → Project → Settings → Environment Variables. '
        + '(It is the public Firebase Web apiKey — no longer hardcoded in the repo.)';
    try {
        if (res && res.status) { res.status(503).json({ ok: false, error: 'firebase_key_not_configured', detail: msg }); return false; }
    } catch (_) {}
    throw new Error(msg);
}

const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

async function tokenHash(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function fsDelete(path) {
    try {
        const r = await fetch(`${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`, { method: 'DELETE' });
        return r.ok;
    } catch (e) { return false; }
}

export default async function handler(req) {
    if (!_requireFirebaseKey(res)) return;
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body;
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }
    const tok = (body.device_token || req.headers.get('x-wf-device-token') || '').trim();
    if (!tok || tok.length < 16) {
        return new Response(JSON.stringify({ ok: false, error: 'Token required' }), {
            status: 401, headers: { 'Content-Type': 'application/json' }
        });
    }
    const keys = Array.isArray(body.keys) ? body.keys : [];
    const tHash = await tokenHash(tok);
    const expectedPrefix = `wf-inbox/${tHash}/items/`;
    let deleted = 0;
    for (const k of keys) {
        if (!k.startsWith(expectedPrefix)) continue;
        _memStore.delete(k);
        await fsDelete(k);
        deleted++;
    }
    return new Response(JSON.stringify({ ok: true, deleted }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
