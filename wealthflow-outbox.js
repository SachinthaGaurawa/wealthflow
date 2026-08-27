/* =============================================================================
 * wealthflow-outbox.js — answers given while the app was closed
 * -----------------------------------------------------------------------------
 * Tapping "Yes — 127,000" on a lock screen has to work with the app shut, the
 * phone offline, and the vault locked. wealthflow-confirm.js decides WHAT such
 * an answer means; this is where it is kept until the app can act on it.
 *
 * ── WHY THE SERVICE WORKER STORES RAW EVENTS AND DECIDES NOTHING ────────────
 *
 * sw.js is registered as a CLASSIC worker — `register('/sw.js')`, no
 * `{ type: 'module' }`. A classic worker cannot import an ES module, so it
 * cannot call into wealthflow-confirm.js at all. That leaves three options and
 * only one of them is honest:
 *
 *   1. Convert the worker to a module. It is the component whose own policy
 *      rule says a bad version "can brick every installed copy of the app on
 *      broken cached code even after the server is fixed". Changing how it
 *      loads, to save an import, is not a trade worth making.
 *   2. Reimplement the decision inside sw.js. Two copies of the rule that says
 *      what a tapped button records — in the two files that already disagreed
 *      about exactly that. This repository has been bitten by a duplicated rule
 *      twice; a third time would be a choice.
 *   3. Have the worker store the RAW event and decide nothing.
 *
 * Three. The worker writes down which action was tapped and the data that came
 * with the notification, and that is the entire extent of its involvement. All
 * interpretation happens here, in the page, through the one module that owns
 * it. The worker cannot record a wrong amount because it never handles amounts.
 *
 * ── THE SHARED SURFACE IS THREE STRINGS, AND A TEST PINS THEM ───────────────
 *
 * Both sides still have to agree on a database name, a store name and a key
 * shape. That is a duplicated constant, which is the thing that drifts — so
 * test/outbox_test.js reads sw.js and this file and fails if they diverge.
 * Three strings is a surface small enough to pin; a rule is not.
 *
 * ── AND WHAT THIS DOES NOT CLAIM ────────────────────────────────────────────
 *
 * The ledger is not written from the background. It cannot be: it is encrypted
 * with a key that exists only inside the running app, and moving that key into
 * a worker to make a sentence true would be the one trade this project does not
 * make. What happens without the app is that the ANSWER is captured, durably,
 * on the device. The ledger catches up on the next open, which for an installed
 * PWA is the next glance at it.
 * ===========================================================================*/

/* ── the shared surface ───────────────────────────────────────────────────── */

/* These three must match sw.js exactly. Changing one here without changing it
 * there strands every answer the worker has already written. */
export const DB_NAME = 'wf-outbox';
export const DB_VERSION = 1;
export const STORE = 'answers';

/** One row per item per month: a second answer replaces the first. */
export function keyFor(data) {
    const d = data || {};
    return `${d.id == null ? '' : d.id}_${d.month == null ? '' : d.month}`;
}

/* ── opening it ───────────────────────────────────────────────────────────── */

/**
 * Open the database, creating the store on first use.
 *
 * `factory` is injected so this is testable against a fake; in the browser it
 * defaults to the real one. Returns null rather than throwing when IndexedDB is
 * unavailable — a private window, a locked-down browser, a worker context that
 * disallows it. A missing outbox degrades to "notifications need the app open",
 * which is where this feature started; a thrown error would take the boot
 * sequence with it.
 */
export function openOutbox(factory) {
    const idb = factory || (typeof indexedDB !== 'undefined' ? indexedDB : null);
    if (!idb) return Promise.resolve(null);
    return new Promise((resolve) => {
        let req;
        try { req = idb.open(DB_NAME, DB_VERSION); } catch (_) { return resolve(null); }
        req.onupgradeneeded = () => {
            try {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
            } catch (_) { /* the open below will report it */ }
        };
        req.onsuccess = () => resolve(req.result || null);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
    });
}

/** Run one transaction, resolving to `fallback` on any failure. */
function withStore(db, mode, fn, fallback) {
    if (!db) return Promise.resolve(fallback);
    return new Promise((resolve) => {
        let tx;
        try { tx = db.transaction(STORE, mode); } catch (_) { return resolve(fallback); }
        let out = fallback;
        tx.oncomplete = () => resolve(out);
        tx.onerror = () => resolve(fallback);
        tx.onabort = () => resolve(fallback);
        try {
            fn(tx.objectStore(STORE), (v) => { out = v; });
        } catch (_) {
            resolve(fallback);
        }
    });
}

/* ── reading and clearing ─────────────────────────────────────────────────── */

/** Every answer the worker has written and the app has not yet applied. */
export function readAll(db) {
    return withStore(db, 'readonly', (store, set) => {
        const req = store.getAll();
        req.onsuccess = () => set(Array.isArray(req.result) ? req.result : []);
    }, []);
}

/**
 * Remove the answers named, and only those.
 *
 * Deliberately not `store.clear()`. An answer that arrived while the drain was
 * running has not been applied, and clearing the whole store would discard it
 * silently — the owner would have tapped a button that did nothing, with no
 * trace that it ever existed.
 */
export function remove(db, keys) {
    const list = Array.isArray(keys) ? keys.filter((k) => k != null) : [];
    if (!list.length) return Promise.resolve(0);
    return withStore(db, 'readwrite', (store, set) => {
        for (const k of list) { try { store.delete(k); } catch (_) { /* next */ } }
        set(list.length);
    }, 0);
}

/**
 * Write an answer. The page uses this only in tests and for a manual replay;
 * in normal operation the service worker is the writer.
 */
export function put(db, record) {
    if (!record || !record.key) return Promise.resolve(false);
    return withStore(db, 'readwrite', (store, set) => {
        store.put(record);
        set(true);
    }, false);
}

/* ── the drain ────────────────────────────────────────────────────────────── */

/**
 * Apply everything waiting, and clear exactly what was applied.
 *
 * `deps.toIntent(record)` turns a stored raw event into an intent — in the app
 * that is WFConfirm.intentFrom(record.action, record.data). `deps.apply(intent)`
 * files it and returns an outcome string. Both are injected because this module
 * owns storage and nothing else; the meaning lives in one place and it is not
 * here.
 *
 * An answer that still needs a person stays in the store. Anything applied,
 * already recorded, or unreadable is removed — a row that cannot be turned into
 * an intent will never become one, and leaving it would mean draining it on
 * every boot forever.
 */
export async function drainOutbox(deps = {}) {
    const toIntent = deps.toIntent;
    const apply = deps.apply;
    if (typeof toIntent !== 'function' || typeof apply !== 'function') {
        return { ok: false, reason: 'no-handler', applied: 0, kept: 0 };
    }

    const db = deps.db !== undefined ? deps.db : await openOutbox(deps.factory);
    if (!db) return { ok: false, reason: 'no-outbox', applied: 0, kept: 0 };

    const rows = await readAll(db);
    const done = [];
    let applied = 0;
    let kept = 0;

    for (const row of rows) {
        if (!row || !row.key) continue;
        let outcome = null;
        try {
            const intent = toIntent(row);
            outcome = intent ? await apply(intent) : null;
        } catch (_) {
            outcome = null;                      // unreadable; drop it below
        }
        if (outcome === (deps.needsAppOutcome || 'needs-the-app')) { kept += 1; continue; }
        if (outcome) applied += 1;
        done.push(row.key);
    }

    await remove(db, done);
    return { ok: true, applied, kept, cleared: done.length };
}

const API = { DB_NAME, DB_VERSION, STORE, keyFor, openOutbox, readAll, remove, put, drainOutbox };

/* The page reaches this through window, the same way every other wired
 * module here does; the ESM export is what the tests import. */
if (typeof window !== 'undefined') window.WFOutbox = API;

export default API;
