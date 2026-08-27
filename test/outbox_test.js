/* =============================================================================
 * test/outbox_test.js
 * -----------------------------------------------------------------------------
 * The outbox is split across two files that cannot import each other. sw.js is
 * a CLASSIC service worker — index.html registers it with no { type: 'module' }
 * — so it cannot reach wealthflow-outbox.js or wealthflow-confirm.js at all.
 *
 * That split is deliberate and explained in both files: the worker records the
 * raw event and decides nothing, so the rule about what a tapped button means
 * lives in exactly one place. But it leaves a shared surface — a database name,
 * a version, a store name, a key shape, and the list of answers the worker
 * believes it can settle alone — and a shared surface between two files that
 * cannot import each other is precisely what drifts.
 *
 * This repository has been bitten by that twice: two sensitive-path regexes in
 * two workflows, and a notification button whose label disagreed with the
 * amount the app wrote. Both were fixed by a test that reads BOTH files and
 * fails on divergence, so that is what the first block below does — it greps
 * sw.js rather than trusting a comment in it.
 *
 * THE ONE THAT WOULD HURT MOST
 *
 * sw.js keeps a list of actions it will settle without opening the app. If
 * "Different amount" ever appeared on that list, tapping it would write an
 * answer carrying no amount and never open the app to ask for one — the
 * payment would simply never be recorded, silently, and the owner would believe
 * they had answered. There is a test asserting that action is absent, derived
 * from wealthflow-confirm.js's own constant rather than from a literal.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * Prove a real service worker writes to a real IndexedDB with the app closed.
 * That needs a device, a push subscription and a browser that will background
 * the page. What is pinned is the contract between the two halves, and every
 * decision the page half makes once a record exists.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import O, {
    DB_NAME, DB_VERSION, STORE, keyFor,
    openOutbox, readAll, remove, put, drainOutbox,
} from '../wealthflow-outbox.js';
import { ACTION_ID, ANSWER, APPLIED } from '../wealthflow-confirm.js';

const swSource = async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(import.meta.dirname, '../sw.js'), 'utf8');
};

/* ── a fake IndexedDB, just enough of one ─────────────────────────────────── */
/* ORDERING IS THE WHOLE POINT OF THIS FAKE, and the first version got it
 * backwards, twice. Real IndexedDB fires a request's onsuccess FIRST and
 * completes the transaction only once its requests have settled.
 *
 * Attempt one scheduled both with setTimeout(0) and the transaction always won,
 * so every drain test read an empty store — five failures that looked like
 * module bugs and were entirely the harness. Attempt two tried setTimeout(0)
 * for requests against setTimeout(1) for completion, and lost identically: Node
 * clamps a 0ms timer to 1ms, so both landed in the same millisecond and
 * REGISTRATION order decided — and the transaction is created before the
 * request is ever made.
 *
 * Delays cannot express "before" here. A microtask can: it runs ahead of every
 * timer regardless of what was registered first. */
function fakeIdb({ failOpen = false, failTx = false } = {}) {
    const data = new Map();

    const store = {
        getAll() {
            const r = {};
            r.result = [...data.values()];
            queueMicrotask(() => { if (typeof r.onsuccess === 'function') r.onsuccess(); });
            return r;
        },
        put(rec) { data.set(rec.key, rec); return {}; },
        delete(k) { data.delete(k); return {}; },
    };
    const db = {
        objectStoreNames: { contains: () => true },
        createObjectStore() { return store; },
        transaction() {
            if (failTx) throw new Error('tx refused');
            const tx = { objectStore: () => store };
            setTimeout(() => { if (tx.oncomplete) tx.oncomplete(); }, 1);
            return tx;
        },
    };
    return {
        _data: data,
        open() {
            const req = {};
            setTimeout(() => {
                if (failOpen) { if (req.onerror) req.onerror(); return; }
                req.result = db;
                if (req.onupgradeneeded) req.onupgradeneeded();
                if (req.onsuccess) req.onsuccess();
            }, 0);
            return req;
        },
    };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SHARED SURFACE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the two halves agree, and it is checked rather than asserted in a comment', () => {
    it('uses the same database, version and store as sw.js', async () => {
        const sw = await swSource();
        expect(sw, 'sw.js names a different database').toContain(`'${DB_NAME}'`);
        expect(sw, 'sw.js names a different store').toContain(`'${STORE}'`);
        expect(sw).toMatch(new RegExp(`WF_OUTBOX_VERSION\\s*=\\s*${DB_VERSION}\\b`));
    });

    it('builds the row key the same way on both sides', async () => {
        /* The worker writes `id + '_' + month`; this module reads it back. A
         * different shape on either side does not error — it silently produces
         * rows nothing ever matches, which looks exactly like "no answers
         * waiting". */
        expect(keyFor({ id: 'loan-1', month: '2026-08' })).toBe('loan-1_2026-08');
        const sw = await swSource();
        expect(sw).toContain("(d.id == null ? '' : d.id) + '_' + (d.month == null ? '' : d.month)");
    });

    it('NEVER settles "Different amount" in the background', async () => {
        /* THE ONE THAT WOULD HURT MOST. That answer carries no figure by design.
         * Settling it without the app would record an answer with nothing in it
         * and never ask — the payment would vanish, silently, while the owner
         * believed they had answered.
         *
         * The action id is taken from wealthflow-confirm.js rather than written
         * out here, so renaming it there cannot quietly break this check. */
        const sw = await swSource();
        const list = /WF_SETTLES_IN_BACKGROUND\s*=\s*\[([^\]]*)\]/.exec(sw);
        expect(list, 'sw.js no longer has a background-settling list').toBeTruthy();
        expect(list[1], 'the app would never be opened to ask for the amount')
            .not.toContain(ACTION_ID[ANSWER.DIFFERENT]);
        expect(list[1]).toContain(ACTION_ID[ANSWER.AS_SCHEDULED]);
        expect(list[1]).toContain(ACTION_ID[ANSWER.NOT_YET]);
    });

    it('still opens the app for the answer that needs a person', async () => {
        const sw = await swSource();
        expect(sw).toContain('clients.openWindow');
    });

    it('does not reimplement what a button means', async () => {
        /* The worker must not know about amounts. If it ever starts reading one,
         * the single-source-of-truth argument in both files stops being true. */
        const sw = await swSource();
        const handler = sw.slice(sw.indexOf('_wfRememberAnswer'), sw.indexOf("addEventListener('notificationclose'"));
        expect(handler).not.toMatch(/\bl\.monthly\b|\bs\.monthly\b/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DRAINING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('applying what was answered while the app was shut', () => {
    const row = (id, action = ACTION_ID[ANSWER.AS_SCHEDULED]) => ({
        key: `${id}_2026-08`, action, data: { kind: 'loan', id, month: '2026-08', amount: 127000 }, at: 1,
    });

    const seeded = async (rows) => {
        const idb = fakeIdb();
        const db = await openOutbox(idb);
        for (const r of rows) await put(db, r);
        return { idb, db };
    };

    it('applies each answer and clears it', async () => {
        const { idb, db } = await seeded([row('a'), row('b')]);
        const seen = [];
        const r = await drainOutbox({
            db,
            toIntent: (rec) => ({ id: rec.data.id }),
            apply: (i) => { seen.push(i.id); return APPLIED.RECORDED; },
        });
        expect(r).toMatchObject({ ok: true, applied: 2, kept: 0 });
        expect(seen.sort()).toEqual(['a', 'b']);
        expect(idb._data.size, 'applied answers were left to replay on every boot').toBe(0);
    });

    it('KEEPS an answer that still needs a person', async () => {
        const { idb, db } = await seeded([row('a'), row('b')]);
        const r = await drainOutbox({
            db,
            toIntent: (rec) => ({ id: rec.data.id }),
            apply: (i) => (i.id === 'b' ? APPLIED.NEEDS_APP : APPLIED.RECORDED),
        });
        expect(r.applied).toBe(1);
        expect(r.kept).toBe(1);
        expect([...idb._data.keys()], 'the row needing the app was discarded').toEqual(['b_2026-08']);
    });

    it('drops a row it cannot turn into an intent, rather than retrying it forever', async () => {
        /* A row that will never parse is not a queue item, it is a leak. Kept,
         * it is re-attempted on every single boot for the life of the install. */
        const { idb, db } = await seeded([row('a')]);
        const r = await drainOutbox({ db, toIntent: () => null, apply: () => APPLIED.RECORDED });
        expect(r.applied).toBe(0);
        expect(idb._data.size).toBe(0);
    });

    it('drops a row whose application throws, and still drains the rest', async () => {
        const { db } = await seeded([row('a'), row('boom'), row('c')]);
        const r = await drainOutbox({
            db,
            toIntent: (rec) => ({ id: rec.data.id }),
            apply: (i) => { if (i.id === 'boom') throw new Error('no such loan'); return APPLIED.RECORDED; },
        });
        expect(r.applied).toBe(2);
        expect(r.cleared).toBe(3);
    });

    it('clears only what it applied, never the whole store', async () => {
        /* An answer written while the drain was running has not been applied.
         * store.clear() would discard it silently — a button tapped that did
         * nothing, with no trace it happened. */
        const { idb, db } = await seeded([row('a')]);
        await drainOutbox({
            db,
            toIntent: (rec) => ({ id: rec.data.id }),
            apply: async () => { await put(db, row('late')); return APPLIED.RECORDED; },
        });
        expect([...idb._data.keys()]).toEqual(['late_2026-08']);
    });

    it('reports rather than throws when there is no outbox at all', async () => {
        const r = await drainOutbox({ toIntent: () => ({}), apply: () => 'x', factory: fakeIdb({ failOpen: true }) });
        expect(r).toMatchObject({ ok: false, reason: 'no-outbox' });
    });

    it('reports rather than throws when handlers are missing', async () => {
        expect(await drainOutbox({})).toMatchObject({ ok: false, reason: 'no-handler' });
        expect(await drainOutbox()).toMatchObject({ ok: false, reason: 'no-handler' });
    });

    it('survives a browser that refuses IndexedDB entirely', async () => {
        // A private window, or a locked-down browser. The feature degrades to
        // "notifications need the app open", which is where it started.
        expect(await openOutbox(null)).toBe(null);
        expect(await readAll(null)).toEqual([]);
        expect(await remove(null, ['x'])).toBe(0);
        expect(await put(null, { key: 'x' })).toBe(false);
    });

    it('survives a transaction the browser refuses mid-flight', async () => {
        const db = await openOutbox(fakeIdb({ failTx: true }));
        expect(await readAll(db)).toEqual([]);
        expect(await put(db, { key: 'a' })).toBe(false);
    });

    it('does nothing for an empty removal list', async () => {
        const { db } = await seeded([]);
        expect(await remove(db, [])).toBe(0);
        expect(await remove(db, null)).toBe(0);
    });

    it('refuses to store a record with no key', async () => {
        const { db } = await seeded([]);
        expect(await put(db, { action: 'x' })).toBe(false);
        expect(await put(db, null)).toBe(false);
    });

    it('exports what both the page and the tests need', () => {
        for (const fn of ['openOutbox', 'readAll', 'remove', 'put', 'drainOutbox', 'keyFor']) {
            expect(typeof O[fn], fn).toBe('function');
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WIRED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the page can actually reach it', () => {
    it('is loaded by index.html as a module', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const html = fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
        expect(html).toContain('<script type="module" src="wealthflow-outbox.js"></script>');
    });
});
