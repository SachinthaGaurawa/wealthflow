// =============================================================================
// WealthFlow Inbox Pull (server-side) v2.0
// Reads pending classified transactions from Firestore + memory fallback.
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

async function fsList(collectionPath) {
    const url = `${FS_BASE}/${collectionPath}?key=${FIREBASE_API_KEY}&pageSize=50`;
    try {
        const r = await fetch(url);
        if (!r.ok) return [];
        const data = await r.json();
        return (data.documents || []).map(d => ({
            key: d.name.split('/').slice(-4).join('/'),  // wf-inbox/<hash>/items/<msgHash>
            ...fromFsValue({ mapValue: { fields: d.fields } })
        }));
    } catch (e) { return []; }
}

export default async function handler(req) {
    const tok = (
        req.headers.get('x-wf-device-token') ||
        new URL(req.url).searchParams.get('token') ||
        ''
    ).trim();
    if (!tok || tok.length < 16) {
        return new Response(JSON.stringify({ ok: false, error: 'Token required' }), {
            status: 401, headers: { 'Content-Type': 'application/json' }
        });
    }
    const tHash = await tokenHash(tok);
    const collection = `wf-inbox/${tHash}/items`;

    // Combine Firestore results and in-memory fallback
    const fsItems = await fsList(collection);
    const memPrefix = `wf-inbox/${tHash}/items/`;
    const memItems = [];
    const now = Date.now();
    for (const [k, v] of _memStore.entries()) {
        if (k.startsWith(memPrefix) && (!v.exp || v.exp > now)) {
            memItems.push({ key: k, ...v.v });
        }
    }
    // Deduplicate by key (Firestore wins if both exist)
    const map = new Map();
    for (const i of memItems) map.set(i.key, i);
    for (const i of fsItems) map.set(i.key, i);
    const items = Array.from(map.values());

    return new Response(JSON.stringify({
        ok: true,
        count: items.length,
        items
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
