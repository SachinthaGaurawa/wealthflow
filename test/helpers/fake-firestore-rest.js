/* =============================================================================
 * test/helpers/fake-firestore-rest.js — the account document as Firestore's REST API answers for it
 * -----------------------------------------------------------------------------
 * The page saves and reads the account over documents:batchGet and documents:commit (wealthflow-sync-health.js, "THE ACCOUNT, OVER PLAIN HTTPS"). This is a
 * stand-in for that endpoint that behaves the way the real one does where it matters to a save, as measured against Google's own Firestore emulator
 * (firebase-tools 13, 2026-11-02):
 *   - a document holds fields; the JSON on the wire is Firestore's typed value format ({"integerValue":"12"}, {"mapValue":{"fields":{...}}}),
 *   - a write with an updateMask replaces exactly the listed top-level fields; a listed field that has no value in the write is DELETED; others are untouched,
 *   - currentDocument.updateTime that is not the stored version -> HTTP 400 FAILED_PRECONDITION; currentDocument.exists=false on an existing document -> 409 ALREADY_EXISTS,
 *   - updateTransforms REQUEST_TIME stamps the field with the server's time,
 *   - the version of a document (updateTime) moves on every committed write, and batchGet with a mask returns only those fields but always the updateTime,
 *   - errors come back as { error: { code, message, status } } (batchGet wraps it in an array).
 * It has its OWN encoder and decoder, written independently of the page's, so a mistake in either shows up as a difference here instead of cancelling out.
 *
 * `cloud` is whatever the test holds: { data, version, exists?, offline?, beforeCommit?, commitAttempts?, requests? }. This file only reads and writes those.
 * ===========================================================================*/

export const stamp = (version) => '2026-11-02T10:00:00.' + String(version).padStart(6, '0') + 'Z';

export function encodeValue(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'string') return { stringValue: v };
    if (typeof v === 'number') {
        if (Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER) return { integerValue: String(v) };
        return { doubleValue: Number.isNaN(v) ? 'NaN' : v === Infinity ? 'Infinity' : v === -Infinity ? '-Infinity' : v };
    }
    if (Array.isArray(v)) return { arrayValue: { values: v.map(encodeValue) } };
    return { mapValue: { fields: Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined).map(([k, x]) => [k, encodeValue(x)])) } };
}

export function decodeValue(x) {
    if ('nullValue' in x) return null;
    if ('booleanValue' in x) return x.booleanValue;
    if ('stringValue' in x) return x.stringValue;
    if ('integerValue' in x) return Number(x.integerValue);
    if ('doubleValue' in x) return typeof x.doubleValue === 'string' ? Number(x.doubleValue) : x.doubleValue;
    if ('timestampValue' in x) return new Date(x.timestampValue).getTime();
    if ('arrayValue' in x) return (x.arrayValue.values || []).map(decodeValue);
    if ('mapValue' in x) return Object.fromEntries(Object.entries(x.mapValue.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
    throw new Error('the fake account cannot read ' + JSON.stringify(x).slice(0, 60));
}

const errorBody = (code, status, message) => ({ error: { code, message, status } });
const clone = (v) => JSON.parse(JSON.stringify(v));

/**
 * What the account answers to one request: { status, json }. Throws a TypeError("Failed to fetch") when the cloud is "offline", as a dead network does.
 * `cloud` is any object with `data`, `version` and `exists` (plain properties or accessors), plus the optional switches named at the top.
 */
export async function restHandle(cloud, url, init = {}) {
    cloud.requests = (cloud.requests || 0) + 1;
    if (cloud.offline) throw new TypeError('Failed to fetch');
    const u = String(url);
    const headers = init.headers || {};
    const auth = headers.Authorization || headers.authorization;
    const reply = (status, json) => ({ status, json });
    if (!/^Bearer \S+/.test(auth || '')) return reply(401, errorBody(401, 'UNAUTHENTICATED', 'no sign-in token'));
    if (cloud.refuseToken) return reply(401, errorBody(401, 'UNAUTHENTICATED', 'the token was refused'));
    const body = JSON.parse(init.body || '{}');
    const exists = cloud.exists !== false;

    if (/:batchGet(\?|$)/.test(u)) {
        cloud.reads = (cloud.reads || 0) + 1;
        if (body.mask) cloud.probes = (cloud.probes || 0) + 1;
        if (!exists) return reply(200, [{ missing: body.documents[0], readTime: stamp(cloud.version) }]);
        let data = clone(cloud.data);
        if (body.mask && body.mask.fieldPaths) data = Object.fromEntries(Object.entries(data).filter(([k]) => body.mask.fieldPaths.includes(k)));
        const fields = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encodeValue(v)]));
        return reply(200, [{ found: { name: body.documents[0], fields, createTime: stamp(1), updateTime: stamp(cloud.version) }, readTime: stamp(cloud.version) }]);
    }

    if (/:commit(\?|$)/.test(u)) {
        cloud.commitAttempts = (cloud.commitAttempts || 0) + 1;
        cloud.lastCommitBytes = String(init.body || '').length;
        if (cloud.beforeCommit) await cloud.beforeCommit(cloud.commitAttempts);   // somebody else writes between this device's read and its save
        if (cloud.offline) throw new TypeError('Failed to fetch');
        if (cloud.failCommit) return reply(cloud.failCommit.status || 400, errorBody(cloud.failCommit.status || 400, cloud.failCommit.code || 'INVALID_ARGUMENT', cloud.failCommit.message || 'refused'));
        const w = body.writes && body.writes[0];
        if (!w || !w.update) return reply(400, errorBody(400, 'INVALID_ARGUMENT', 'no write'));
        // a write to some other document (the connection check's probe) is accepted and kept nowhere
        if (!/\/documents\/users\/[^/]+$/.test(w.update.name)) return reply(200, { writeResults: [{ updateTime: stamp(cloud.version) }], commitTime: stamp(cloud.version) });
        const pre = w.currentDocument;
        const stillExists = cloud.exists !== false;
        if (pre && pre.updateTime !== undefined) {
            if (!stillExists || pre.updateTime !== stamp(cloud.version)) return reply(400, errorBody(400, 'FAILED_PRECONDITION', 'the stored version does not match the required base version'));
        }
        if (pre && pre.exists === false && stillExists) return reply(409, errorBody(409, 'ALREADY_EXISTS', 'Document already exists'));
        if (pre && pre.exists === true && !stillExists) return reply(404, errorBody(404, 'NOT_FOUND', 'No document to update'));
        const sent = w.update.fields || {};
        const mask = (w.updateMask && w.updateMask.fieldPaths) || null;
        if (stillExists === false) { cloud.exists = true; cloud.data = {}; }
        const next = clone(cloud.data);
        if (mask) {
            for (const p of mask) {
                if (p.includes('.') && !p.startsWith('`')) throw new Error('the fake account only takes top-level paths, got ' + p);
                const name = p.startsWith('`') ? p.slice(1, -1).replace(/\\`/g, '`').replace(/\\\\/g, '\\') : p;
                if (name in sent) next[name] = decodeValue(sent[name]); else delete next[name];
            }
        } else { for (const k of Object.keys(next)) delete next[k]; for (const [k, v] of Object.entries(sent)) next[k] = decodeValue(v); }
        for (const t of w.updateTransforms || []) if (t.setToServerValue === 'REQUEST_TIME') next[t.fieldPath] = Date.now();
        cloud.data = next; cloud.version++; cloud.commits = (cloud.commits || 0) + 1;
        if (typeof cloud.onCommit === 'function') cloud.onCommit(Object.keys(sent));
        return reply(200, { writeResults: [{ updateTime: stamp(cloud.version) }], commitTime: stamp(cloud.version) });
    }
    return reply(404, errorBody(404, 'NOT_FOUND', 'the fake account does not know ' + u));
}

/** A fetch() that answers as the account would. */
export function makeRestFetch(cloud) {
    return async function fakeFetch(url, init = {}) {
        const { status, json } = await restHandle(cloud, url, init);
        return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(json) };
    };
}
