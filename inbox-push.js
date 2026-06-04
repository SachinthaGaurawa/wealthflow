// =============================================================================
// WealthFlow Inbox Push (server-side) v2.0
//
// Stores classified transaction in Firestore via REST API. Uses the
// user's own Firebase project + Firestore — no new infrastructure
// needed. Per-device-token isolation via hashed token in path.
//
// Storage:
//   Path:  artifacts/wealthflow-inbox/{tokenHash}/items/{msgHash}
//   Doc:   { brain_result, received_at_ms, sms_preview, applied: false }
//   TTL:   none (cleared client-side after apply via inbox-ack)
//
// Why Firestore: zero setup, already authenticated, public REST API
// available, free tier covers thousands of writes/day.
//
// Env: FIREBASE_PROJECT_ID (defaults to wealthflow-6dffb)
// =============================================================================

export const config = { runtime: 'edge' };

const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT_ID || 'wealthflow-6dffb';
const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4';
const FS_BASE = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;

// Fallback in-memory store for testing only (shared across endpoint modules
// via globalThis). Production should rely on Firestore.
const _memStore = globalThis.__wfMemStore || (globalThis.__wfMemStore = new Map());

async function tokenHash(t) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
    return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
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

async function fsPut(path, doc) {
    const url = `${FS_BASE}/${path}?key=${FIREBASE_API_KEY}`;
    try {
        const r = await fetch(url, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ fields: toFsValue(doc).mapValue.fields })
        });
        return r.ok;
    } catch (e) {
        // Fall back to in-memory store
        _memStore.set(path, { v: doc, exp: Date.now() + 7*24*60*60*1000 });
        return true;
    }
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
    const brain = body.brain_result;
    if (!brain || !brain.hash) {
        return new Response(JSON.stringify({ ok: false, error: 'brain_result with hash required' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }
    const tHash = await tokenHash(tok);
    const docPath = `wf-inbox/${tHash}/items/${brain.hash}`;
    const entry = {
        brain_result: brain,
        received_at_ms: body.received_at_ms || Date.now(),
        applied: false,
        sms_preview: (body.sms || '').slice(0, 140)
    };
    // Also save to in-memory store as a fallback for current request chain
    _memStore.set(docPath, { v: entry, exp: Date.now() + 7*24*60*60*1000 });
    const fsOk = await fsPut(docPath, entry);
    return new Response(JSON.stringify({ ok: true, key: docPath, firestore: fsOk }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
