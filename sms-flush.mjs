/* =============================================================================
 * sms-flush.mjs — hand the server the change itself, so the text does not depend on the page staying open
 * -----------------------------------------------------------------------------
 * Reported 2026-10-29: update a debtor or an investment and close the app straight away, and the text that change owed never went.
 *
 * A text is derived on the server from the UPLOADED books (sms-events.mjs). The upload is a Firestore transaction (read, merge, write: several
 * round trips on the page's own connection), and the nudge that tells the server to look (sms-notify) waits a few seconds after it. A phone that
 * is closed, locked or swiped away in that time freezes the page between the two, and the only thing left to send the text is the cron, which
 * runs three times a day and only knows what was uploaded. A change made and closed on is therefore not texted until the app is opened again.
 *
 * What survives a closing page is ONE request: a fetch with `keepalive` is finished by the browser itself. So the page sends, in that one request,
 * the records that changed (never an instruction: the recipient, the amount and the words are still read from the account's own document, exactly
 * as sms-notify.js says), and the server merges them into the account's document the way the page would have, then looks. The page's own upload
 * still happens when it can; it finds the same records already there. Everything here is the page's own merge, record by record: the newest
 * `_ut` wins, a deletion recorded after the edit stays deleted, and a record this request does not name is never touched. Applying the same flush
 * twice, or after the page has uploaded, changes nothing.
 *
 * WHAT IS ACCEPTED. Only the three things a text is derived from: `debtors`, `income` (the investments) and the months of an investment the
 * owner marked received (`incomeReceived`, with the field clocks the page keeps for it), and the page's own tombstones for the first two. Only
 * what is well formed, only what is not stamped in the future, and only up to a size.
 *
 * A DELETION TRAVELS TOO. A debtor or an investment the owner has just deleted must not be texted about from the cloud's stale copy of it while its
 * deletion is still on the way (reported in review of the first version of this file: a flush that carried only the edits swept the old document).
 * The page sends the tombstone it wrote ({ id: time of deletion }), and the server applies it under the page's rule: a record is removed only when
 * the tombstone is at or after the record's own stamp, so a later edit of the same record (from another device) survives. Nothing else is ever
 * removed, and a mark for a month is never taken away.
 *
 * The merge below is a copy of the page's (index.html `_wfMergeRecordArray`); test/sms_flush_test.js runs the page's own functions against
 * this one on the same inputs, so the two cannot drift.
 * ===========================================================================*/

export const FLUSH = Object.freeze({
    RECORD_KEYS: Object.freeze(['debtors', 'income']),
    MAP_KEY: 'incomeReceived',
    MAX_RECORDS: 400,
    MAX_MAP_KEYS: 600,
    MAX_BYTES: 262144,
    FUTURE_SLACK_MS: 864e5,                  // the page never stamps further ahead than a day (index.html _wfObserveStamps)
    KEY_MAX: 200,
    DEPTH: 6,
    MAX_TOMBS: 400,
});

/* ── the page's merge, unchanged ──────────────────────────────────────────── */

/** A record's effective update time: explicit _ut, else parsed createdAt, else 0. */
export function utOf(r) {
    if (!r || typeof r !== 'object') return 0;
    if (typeof r._ut === 'number' && isFinite(r._ut)) return r._ut;
    if (r.createdAt) { const t = Date.parse(r.createdAt); if (!isNaN(t)) return t; }
    if (typeof r.paidAt === 'number') return r.paidAt;
    return 0;
}
/** Content signature of a record IGNORING _ut. */
export function recSig(r) {
    try { const c = Object.assign({}, r); delete c._ut; return JSON.stringify(c); } catch (_) { return ''; }
}
/** Newest _ut wins; the lexicographically greater signature breaks a tie, so every device and this server choose alike. */
export function recPreferred(a, b) {
    const ua = utOf(a), ub = utOf(b);
    if (ua !== ub) return ua > ub ? a : b;
    return recSig(a) >= recSig(b) ? a : b;
}
/** Merge two record arrays by id; a tombstone at or after a record's stamp removes it. */
export function mergeRecordArray(localArr, cloudArr, tombMap) {
    const L = Array.isArray(localArr) ? localArr : [];
    const C = Array.isArray(cloudArr) ? cloudArr : [];
    const byId = new Map();
    const noId = [];
    const put = (r) => {
        if (!r || typeof r !== 'object') return;
        if (r.id == null) { noId.push(r); return; }
        const ex = byId.get(r.id);
        byId.set(r.id, ex ? recPreferred(r, ex) : r);
    };
    C.forEach(put); L.forEach(put);
    const out = [];
    byId.forEach((r, id) => {
        const del = tombMap && tombMap[id];
        if (typeof del === 'number' && del >= utOf(r)) return;
        out.push(r);
    });
    const sigs = new Set();
    noId.forEach((r) => { const s = recSig(r); if (!sigs.has(s)) { sigs.add(s); out.push(r); } });
    return out;
}

/* ── what a request may carry ─────────────────────────────────────────────── */

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const sizeOf = (v) => { try { return JSON.stringify(v).length; } catch (_) { return Infinity; } };

/** A value as Firestore can hold it: plain data only, no function, no undefined, no field name Firestore refuses. */
function plainCopy(v, depth = 0) {
    if (depth > FLUSH.DEPTH) return undefined;
    if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
    if (Array.isArray(v)) return v.map((x) => { const c = plainCopy(x, depth + 1); return c === undefined ? null : c; });
    if (isPlain(v)) {
        const o = {};
        for (const k of Object.keys(v)) {
            if (!k || k.length > FLUSH.KEY_MAX || /^__.*__$/.test(k) || k.includes('/')) continue;
            const c = plainCopy(v[k], depth + 1);
            if (c !== undefined) o[k] = c;
        }
        return o;
    }
    return undefined;
}

/**
 * What a flush body says, reduced to what may be merged.
 *   body: { records:{ debtors:[...], income:[...] }, incomeReceived:{ key: value }, kuf:{ key: stamp } }
 * @returns {{ok:boolean, reason?:string, records:{debtors:object[], income:object[]}, received:object, kuf:object, dropped:number}}
 */
export function cleanFlush(body, now = Date.now()) {
    const b = isPlain(body) ? body : {};
    const out = { ok: true, records: { debtors: [], income: [] }, received: {}, kuf: {}, tombs: { debtors: {}, income: {} }, dropped: 0 };
    if (sizeOf(b) > FLUSH.MAX_BYTES) return { ...out, ok: false, reason: 'too-large' };
    const ceiling = now + FLUSH.FUTURE_SLACK_MS;
    const recs = isPlain(b.records) ? b.records : {};
    for (const key of FLUSH.RECORD_KEYS) {
        const list = Array.isArray(recs[key]) ? recs[key] : [];
        if (list.length > FLUSH.MAX_RECORDS) return { ...out, ok: false, reason: 'too-many' };
        for (const r of list) {
            const id = r && r.id;
            const okId = (typeof id === 'string' && id.length > 0 && id.length <= FLUSH.KEY_MAX) || (typeof id === 'number' && Number.isFinite(id));
            if (!isPlain(r) || !okId || typeof r._ut !== 'number' || !Number.isFinite(r._ut) || r._ut <= 0 || r._ut > ceiling) { out.dropped += 1; continue; }
            const c = plainCopy(r);
            if (c) out.records[key].push(c); else out.dropped += 1;
        }
    }
    const dead = isPlain(b.tombs) ? b.tombs : {};
    for (const key of FLUSH.RECORD_KEYS) {
        const m = isPlain(dead[key]) ? dead[key] : {};
        const ids = Object.keys(m);
        if (ids.length > FLUSH.MAX_TOMBS) return { ...out, ok: false, reason: 'too-many' };
        for (const id of ids) {
            const t = m[id];
            if (!id || id.length > FLUSH.KEY_MAX || /^__.*__$/.test(id) || id.includes('/') || typeof t !== 'number' || !Number.isFinite(t) || t <= 0 || t > ceiling) { out.dropped += 1; continue; }
            out.tombs[key][id] = t;
        }
    }
    const got = isPlain(b[FLUSH.MAP_KEY]) ? b[FLUSH.MAP_KEY] : {};
    const keys = Object.keys(got);
    if (keys.length > FLUSH.MAX_MAP_KEYS) return { ...out, ok: false, reason: 'too-many' };
    const stamps = isPlain(b.kuf) ? b.kuf : {};
    for (const k of keys) {
        if (!k || k.length > FLUSH.KEY_MAX || /^__.*__$/.test(k) || k.includes('/')) { out.dropped += 1; continue; }
        const v = plainCopy(got[k]);
        const t = stamps[k];
        if (v === undefined || v === null || v === false) { out.dropped += 1; continue; }     // a flush adds a mark; it never takes one away
        out.received[k] = v;
        if (typeof t === 'number' && Number.isFinite(t) && t > 0 && t <= ceiling) out.kuf[k] = t;
    }
    return out;
}

const same = (a, b) => { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } };
/** The stamp the document holds for a month mark: its own, or its parent's, or the key's own clock. */
function stampOf(kufMap, path, fallback) {
    if (!isPlain(kufMap)) return fallback;
    let best = 0;
    const parts = path.split('~');
    for (let n = parts.length; n >= 1; n -= 1) {
        const v = kufMap[parts.slice(0, n).join('~')];
        if (typeof v === 'number' && Number.isFinite(v) && v > best) best = v;
    }
    return best;
}

/**
 * Merge a cleaned flush into the account's document. Pure.
 * @returns {{patch:object, changed:{debtors:number, income:number, incomeReceived:number}, user:object}}
 *   `patch` is what to write (only keys that changed); `user` is the document as it is after the merge.
 */
export function mergeFlush(cloud, clean) {
    const doc = isPlain(cloud) ? cloud : {};
    const tomb = isPlain(doc._tomb) ? doc._tomb : {};
    const patch = {};
    const changed = { debtors: 0, income: 0, incomeReceived: 0, deleted: 0 };
    let tombPatch = null;

    for (const key of FLUSH.RECORD_KEYS) {
        const incoming = clean.records[key];
        const theirs = clean.tombs[key] || {};
        const have = new Map((Array.isArray(doc[key]) ? doc[key] : []).filter((r) => r && r.id != null).map((r) => [r.id, r]));
        const held = isPlain(tomb[key]) ? tomb[key] : {};
        // the page's merge of two tombstone maps: the newer deletion time per id
        const dead = { ...held };
        let newTomb = false;
        for (const id of Object.keys(theirs)) if (dead[id] == null || theirs[id] > dead[id]) { dead[id] = theirs[id]; newTomb = true; }
        let n = 0;
        for (const r of incoming) {
            const ex = have.get(r.id);
            const del = dead[r.id];
            if (typeof del === 'number' && del >= utOf(r)) continue;                         // deleted after this edit
            if (!ex || (recPreferred(r, ex) === r && recSig(r) !== recSig(ex))) n += 1;
        }
        // a record the document holds that a (new) tombstone now covers goes, by the same rule: deleted at or after its last edit
        let gone = 0;
        if (newTomb) for (const [id, r] of have) { const del = dead[id]; if (typeof del === 'number' && del >= utOf(r)) gone += 1; }
        if (newTomb) { tombPatch = { ...(tombPatch || tomb), [key]: dead }; }
        if (!n && !gone) continue;
        patch[key] = mergeRecordArray(incoming, doc[key], dead);
        changed[key] = n;
        changed.deleted += gone;
    }
    if (tombPatch) patch._tomb = { ...tomb, ...tombPatch };

    const marks = Object.keys(clean.received);
    if (marks.length) {
        const cur = isPlain(doc[FLUSH.MAP_KEY]) ? doc[FLUSH.MAP_KEY] : {};
        const kuf = isPlain(doc._kuf) ? doc._kuf : {};
        const kufMap = isPlain(kuf[FLUSH.MAP_KEY]) ? kuf[FLUSH.MAP_KEY] : {};
        const keyClock = isPlain(doc._kut) && typeof doc._kut[FLUSH.MAP_KEY] === 'number' ? doc._kut[FLUSH.MAP_KEY] : 0;
        const nextMap = { ...cur };
        const nextKuf = { ...kufMap };
        let n = 0;
        for (const k of marks) {
            const v = clean.received[k];
            const theirs = clean.kuf[k] || 0;
            if (!Object.prototype.hasOwnProperty.call(cur, k)) { nextMap[k] = v; if (theirs) nextKuf[k] = theirs; n += 1; continue; }
            if (same(cur[k], v)) continue;
            if (theirs > stampOf(kufMap, k, keyClock)) { nextMap[k] = v; nextKuf[k] = theirs; n += 1; }
        }
        if (n) {
            patch[FLUSH.MAP_KEY] = nextMap;
            patch._kuf = { ...kuf, [FLUSH.MAP_KEY]: nextKuf };
            changed.incomeReceived = n;
        }
    }
    return { patch, changed, user: { ...doc, ...patch } };
}

/**
 * Apply a cleaned flush to `users/{uid}` in one transaction. A missing document is left missing (a flush never creates an account).
 * @returns {Promise<{exists:boolean, changed:object, user:object|null}>}
 */
export async function applyFlush({ db, uid, clean, now = Date.now() }) {
    const ref = db.collection('users').doc(uid);
    return db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists) return { exists: false, changed: { debtors: 0, income: 0, incomeReceived: 0, deleted: 0 }, user: null };
        const cloud = snap.data() || {};
        const { patch, changed, user } = mergeFlush(cloud, clean);
        if (!Object.keys(patch).length) return { exists: true, changed, user: cloud };
        // stamped as a write by "somebody else", so every open copy of the app reads it like any other device's upload
        tx.set(ref, { ...patch, _writeDeviceId: 'server-sms-flush', _writeTs: now }, { merge: true });
        return { exists: true, changed, user };
    });
}

export default { FLUSH, utOf, recSig, recPreferred, mergeRecordArray, cleanFlush, mergeFlush, applyFlush };
