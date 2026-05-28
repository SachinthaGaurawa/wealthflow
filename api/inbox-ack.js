// =============================================================================
// WealthFlow Inbox Ack v2.0 — delete applied items from Firestore + memory.
// =============================================================================

export const config = { runtime: 'edge' };

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'wealthflow-6dffb';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
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
