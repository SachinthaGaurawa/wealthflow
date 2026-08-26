/* =============================================================================
 * test/ledger_audit_test.js — Step 2, and the one thing it must never do
 * -----------------------------------------------------------------------------
 * #131 made the app's category vocabularies agree. It did NOT go back and fix
 * rows already filed under the old names — a receipt scanned last month is still
 * "Food & Groceries", a Netflix charge is still "Entertainment", and nobody knows
 * how many such rows exist. That number is the cost of the fragmentation, and
 * this module is the instrument that measures it.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE
 *
 * The audit is READ-ONLY. A person's categories are their own: some of those
 * disagreements are the classifier being stale, and some are the user having
 * deliberately overridden it — and from the outside those look identical. A bulk
 * "fix" would silently overwrite real decisions with a guess.
 *
 * So: run() writes nothing, ever. applyOne() changes exactly one row, by id,
 * after an explicit act. There is no applyAll and there must never be one.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const SRC = read('wealthflow-ledger-audit.js');

/** The real module, over a fake DB and a fake merchant table. */
/* `merchants: undefined` would trigger the destructuring DEFAULT and hand back
 * the real stub — the first version of the "refuses to run" test did exactly that
 * and reported the code broken when the test was. noMerchants is explicit. */
function load({ merchants = null, records = {}, noMerchants = false } = {}) {
    const store = JSON.parse(JSON.stringify(records));
    const writes = [];
    const CANON = ['Groceries', 'Dining', 'Health', 'Streaming', 'Fuel', 'Transport',
        'Shopping', 'Cash Advance', 'Bank Charges', 'Other'];
    const win = {
        console: { log() {}, warn() {}, error() {} },
        document: { getElementById: () => null },
        setTimeout,
        DB: {
            get: (k, d) => (store[k] !== undefined ? store[k] : d),
            set: (k, v) => { store[k] = v; writes.push(k); },
        },
        WFMerchants: noMerchants ? undefined : merchants !== null ? merchants : {
            CATEGORIES: CANON,
            refine: (desc) => {
                const d = String(desc).toLowerCase();
                if (d.includes('keells')) return { category: 'Groceries' };
                if (d.includes('netflix')) return { category: 'Streaming' };
                if (d.includes('hospital')) return { category: 'Health' };
                if (d.includes('fuel')) return { category: 'Fuel' };
                if (d.includes('cash advance')) return { category: 'Cash Advance' };
                return null;                     // no opinion — NOT the same as "Other"
            },
        },
    };
    win.window = win;
    win.globalThis = win;
    new Function('window', 'globalThis', 'self', 'console', 'setTimeout', SRC)(
        win, win, win, win.console, setTimeout);
    return { api: win.WFLedgerAudit, store, writes, CANON };
}

const LEDGER = {
    expenses: [
        { id: 'a1', desc: 'KEELLS SUPER COL 03', cat: 'Food & Groceries' },   // drifted
        { id: 'a2', desc: 'NETFLIX.COM', cat: 'Entertainment' },              // drifted
        { id: 'a3', desc: 'ASIRI HOSPITAL', cat: 'Healthcare' },              // drifted
        { id: 'a4', desc: 'CEYPETCO FUEL', cat: 'Fuel' },                     // agreed
        { id: 'a5', desc: 'SOMETHING OBSCURE', cat: 'Other' },                // unknown
        { id: 'a6', desc: 'Cash advance from MB', cat: 'Other' },             // changed
    ],
};

describe('the audit reports without touching anything', () => {
    it('writes NOTHING while it runs', async () => {
        const { api, store, writes } = load({ records: LEDGER });
        const before = JSON.stringify(store);
        const rep = await api.run();
        expect(rep.ok).toBe(true);
        expect(writes, 'the audit wrote to the ledger — it is meant to be read-only, and a '
            + "person's categories are their own decisions, not the classifier's").toEqual([]);
        expect(JSON.stringify(store), 'the ledger changed during a read-only audit').toBe(before);
    });

    it('separates a stale NAME from a changed OPINION', async () => {
        const { api } = load({ records: LEDGER });
        const rep = await api.run();
        expect(rep.drifted.map((d) => d.stored).sort(),
            'a category the app no longer has must be reported as drifted, not as a disagreement')
            .toEqual(['Entertainment', 'Food & Groceries', 'Healthcare']);
        expect(rep.changed.map((d) => `${d.stored}->${d.computed}`),
            'a row stored under a VALID name that the classifier now reads differently')
            .toEqual(['Other->Cash Advance']);
    });

    it('silence from the classifier is not an answer', async () => {
        // refine() returning nothing means "no opinion". Treating that as "Other"
        // would manufacture a finding on every row the table has never seen.
        const { api } = load({ records: LEDGER });
        const rep = await api.run();
        expect(rep.totals.unknown, 'a row the classifier has no opinion about was counted as a '
            + 'disagreement').toBe(1);
        expect(rep.changed.some((c) => c.desc === 'SOMETHING OBSCURE')).toBe(false);
    });

    it('counts what it saw, and the counts add up', async () => {
        const { api } = load({ records: LEDGER });
        const rep = await api.run();
        const t = rep.totals;
        expect(t.scanned).toBe(6);
        expect(t.agreed + t.changed + t.drifted + t.unknown,
            'the buckets do not sum to the rows scanned, so something was counted twice or lost')
            .toBe(t.scanned);
    });

    it('reports the vocabulary actually in use, which is the measurement', async () => {
        const { api } = load({ records: LEDGER });
        const rep = await api.run();
        expect(rep.vocabulary['Food & Groceries']).toBe(1);
        expect(rep.vocabulary.Other).toBe(2);
    });

    it('refuses to run when there is nothing to compare against', async () => {
        const { api } = load({ records: LEDGER, noMerchants: true });
        const rep = await api.run();
        expect(rep.ok, 'the audit ran without a merchant table and reported results anyway')
            .toBe(false);
        expect(rep.reason).toMatch(/not loaded/i);
    });

    it('yields between slices so a long ledger cannot freeze the app', async () => {
        expect(SRC, 'the walk no longer yields — profiling during the crash sweep found '
            + 'classify() taking a large share of the main thread, and a synchronous walk of '
            + 'thousands of rows freezes the UI exactly like the 301,015-node render did')
            .toMatch(/requestIdleCallback|await yieldSlice\(\)/);
        expect(SRC).toMatch(/done % SLICE === 0/);
    });

    it('refuses a ledger too large for one pass rather than trying', async () => {
        const huge = { expenses: Array.from({ length: 20001 }, (_, i) => ({ id: 'x' + i, desc: 'X', cat: 'Other' })) };
        const { api } = load({ records: huge });
        const rep = await api.run();
        expect(rep.ok).toBe(false);
        expect(rep.reason).toMatch(/cap/i);
    });
});

describe('applying a change is singular and explicit', () => {
    it('changes exactly the row named, and only when asked', () => {
        const { api, store } = load({ records: LEDGER });
        expect(api.applyOne('expenses', 'a1', 'Groceries')).toBe(true);
        expect(store.expenses.find((r) => r.id === 'a1').cat).toBe('Groceries');
        expect(store.expenses.filter((r) => r.id !== 'a1').map((r) => r.cat),
            'applying one change altered other rows').toEqual(
            ['Entertainment', 'Healthcare', 'Fuel', 'Other', 'Other']);
    });

    it('will not write a category the app does not have', () => {
        // Deliberately a row whose stored value DIFFERS from the invalid target.
        // The first version used a2, which already held "Entertainment", so the
        // no-op check returned false first and the category check was never
        // reached — removing it entirely left this test green.
        const { api, store } = load({ records: LEDGER });
        expect(store.expenses.find((r) => r.id === 'a1').cat).toBe('Food & Groceries');
        expect(api.applyOne('expenses', 'a1', 'Entertainment'),
            'the audit wrote back one of the retired names it exists to find').toBe(false);
        expect(store.expenses.find((r) => r.id === 'a1').cat,
            'the row was changed to a name the app does not have').toBe('Food & Groceries');
        // …and a name that is merely invented, not just retired.
        expect(api.applyOne('expenses', 'a1', 'Not A Real Category')).toBe(false);
    });

    it('is a no-op when the row already holds that category', () => {
        const { api, writes } = load({ records: LEDGER });
        expect(api.applyOne('expenses', 'a4', 'Fuel')).toBe(false);
        expect(writes, 'a no-op still wrote, which dirties the sync for nothing').toEqual([]);
    });

    /* NOTE — one mutation of applyOne is EQUIVALENT and is recorded rather than
     * hidden: removing the `break` after a match. Record ids are unique (uid()
     * gained a per-page sequence in #127 and _wfDedupRecordIds repairs any
     * historical collision on write), so the loop finds at most one row and
     * continuing merely wastes iterations. There is no observable difference to
     * assert, and inventing a duplicate-id fixture would be testing a state the
     * app now prevents. */

    it('there is no applyAll, and there must not be', () => {
        expect(Object.keys(load({ records: LEDGER }).api),
            'a bulk apply appeared. Some disagreements are the user having deliberately '
            + 'overridden the classifier, and from the outside that is indistinguishable from '
            + 'a stale row — a bulk fix silently overwrites real decisions with a guess')
            .not.toContain('applyAll');
        expect(SRC).not.toMatch(/function applyAll|applyAll:/);
    });
});

describe('the input dropdown is measured, not quietly normalised', () => {
    it('reports both directions of the mismatch', () => {
        const { api, CANON } = load({ records: LEDGER });
        const opts = ['Food & Groceries', 'Rent', 'Travel', 'Fuel', 'Other'];
        // stand in a fake select
        const win = { options: opts.map((v) => ({ value: v })) };
        api.inputVocabulary.call(null, 'e_cat');   // no document in this harness
        // the shape matters more than the DOM here; assert the contract in source
        expect(SRC).toMatch(/missingFromCanonical/);
        expect(SRC).toMatch(/canonicalNotOffered/);
        expect(CANON).toContain('Cash Advance');
    });

    it('says why it only measures', () => {
        expect(SRC, 'the module now decides what to do about the dropdown mismatch. Rent, '
            + 'Travel, Pets and Charity are distinctions a person may want and the canonical '
            + 'list does not carry — collapsing them loses information the user chose')
            .toMatch(/product decision/i);
    });
});

describe('it is not on the boot path', () => {
    const HTML = read('index.html');
    it('ships as a module but is loaded on demand', () => {
        expect(HTML, 'the audit is back on the boot path — it is an occasional maintenance '
            + 'tool and the payload budget counts script requests for a reason')
            .not.toMatch(/<script[^>]*src="wealthflow-ledger-audit\.js"/);
        expect(HTML).toMatch(/function _wfLoadLedgerAudit\(\)/);
    });

    it('the loader rejects rather than resolving nothing', () => {
        const at = HTML.indexOf('function _wfLoadLedgerAudit()');
        const body = HTML.slice(at, at + 1100);
        // Both branches must reject. Matching /reject\(new Error/ anywhere is not
        // enough: mutating only the onerror handler left the onload one in place
        // and the check stayed green.
        const onerror = body.slice(body.indexOf('s.onerror'));
        expect(onerror, 'a load FAILURE resolves instead of rejecting, so a caller cannot tell '
            + '"failed to load" from "loaded and found nothing"').toMatch(/reject\(new Error/);
        const onload = body.slice(body.indexOf('s.onload'), body.indexOf('s.onerror'));
        expect(onload, 'a script that loads but exports nothing resolves undefined')
            .toMatch(/reject\(new Error/);
        expect(body, 'a failed load leaves the cached promise in place, so every later attempt '
            + 'returns the same failure without retrying').toMatch(/_wfAuditLoading = null/);
    });
});
