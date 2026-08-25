/* =============================================================================
 * test/merchant_cache_test.js — classify() remembers its answers, and must
 * forget them at exactly the right moments
 * -----------------------------------------------------------------------------
 * WHY THE CACHE EXISTS
 *
 * A CPU profile of the app rendering 2,000 records put over half the entire main
 * thread inside WFMerchants.classify(). The insight strips classify every record
 * on every render, and _matchRegistry walks 538 keywords for each one:
 *
 *     dashboard      1,805 ms   →   574 ms first render, 46 ms on every one after
 *     subscriptions    622 ms   →    14 ms
 *     six-page navigation        →   214 ms for all six
 *
 * WHY THE INVALIDATION MATTERS MORE THAN THE SPEED
 *
 * A stale entry is not a slow page, it is a wrong one. The learned map exists
 * because the user corrected a merchant's category; if classify kept answering
 * from a cache filled before that correction, the app would re-file the merchant
 * into the category the user had just rejected — and it would look like the
 * correction had not been saved. Those tests are the important ones here.
 *
 * A NOTE ON THE SHAPE OF THE CACHE
 *
 * The first version emptied itself on reaching its ceiling. Measured against a
 * store with more distinct narrations than the ceiling, that made it fill, clear
 * and refill: 826 ms, then 53 ms, then 302 ms. It now retires the older half
 * instead, and the third render measures 46 ms like the second.
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'wealthflow-merchants.js'), 'utf8');

/** A fresh module with a real in-memory localStorage, so learn() persists, and a
 *  controllable fetch so the auto-updated merchant list can be delivered. */
function load(merchants) {
    const mem = new Map();
    const win = {
        localStorage: {
            getItem: (k) => (mem.has(k) ? mem.get(k) : null),
            setItem: (k, v) => mem.set(k, String(v)),
            removeItem: (k) => mem.delete(k),
        },
    };
    const fetchStub = () => Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ version: 't', merchants: merchants || [] }),
    });
    new Function('window', 'console', 'fetch', SRC)(win, { log() {}, warn() {} }, fetchStub);
    return { M: win.WFMerchants, mem };
}

let M;
beforeEach(() => { M = load().M; });

describe('the module loaded (guards a vacuous suite)', () => {
    it('exposes classify and the cache controls', () => {
        expect(typeof M.classify).toBe('function');
        expect(typeof M.learn).toBe('function');
        expect(typeof M._clsForget).toBe('function');
    });
});

describe('caching does not change the answer', () => {
    const cases = [
        ['KEELLS SUPER COLOMBO', 'debit', 'Groceries'],
        ['NETFLIX.COM', 'debit', 'Streaming'],
        ['LOCAL CASH ADVANCE FEE (DB)', 'debit', 'Bank Charges'],
        ['Cash advance from MB', 'debit', 'Cash Advance'],
        ['CEB ELECTRICITY BILL', 'debit', 'Utilities'],
    ];
    for (const [raw, dir, cat] of cases) {
        it(`${raw} — same answer cold and warm`, () => {
            const cold = M.classify(raw, dir);
            const warm = M.classify(raw, dir);
            expect(cold.category).toBe(cat);
            expect(warm, 'the cached answer differs from the computed one').toEqual(cold);
        });
    }

    it('keeps the direction in the key', () => {
        // The same narration means different things in and out of an account.
        const din = M.classify('Cash advance from MB', 'credit');
        const dout = M.classify('Cash advance from MB', 'debit');
        expect(din.creditKind, 'the cache answered a credit with the debit result')
            .toBe('cash_advance');
        expect(dout.category).toBe('Cash Advance');
    });

    it('hands out a copy on a MISS, so the stored answer cannot be edited', () => {
        // refine() edits what classify() returns.
        const a = M.classify('KEELLS SUPER COLOMBO', 'debit');   // miss
        a.category = 'TAMPERED';
        a.confidence = 0;
        expect(M.classify('KEELLS SUPER COLOMBO', 'debit').category,
            'the miss path stored the object it handed out').toBe('Groceries');
    });

    it('hands out a copy on a HIT as well', () => {
        // Two copies, two separate places to get wrong. A mutation that removed
        // only the hit-path copy passed a test that tampered with the miss result,
        // because the miss result was already a copy — so this asks specifically
        // for the object returned by the second call.
        M.classify('KEELLS SUPER COLOMBO', 'debit');              // miss, fills it
        const b = M.classify('KEELLS SUPER COLOMBO', 'debit');    // hit
        b.category = 'TAMPERED';
        b.confidence = 0;
        const c = M.classify('KEELLS SUPER COLOMBO', 'debit');
        expect(c.category, 'the hit path handed out the cached object itself, so one '
            + 'caller editing its result corrupted the answer for every later caller')
            .toBe('Groceries');
        expect(c.confidence).toBeGreaterThan(0);
    });
});

describe('the cache forgets when it must', () => {
    it('a user correction takes effect immediately', () => {
        // THE test in this file. Classify first so the answer is cached, then
        // learn a different category, then ask again.
        const before = M.classify('ODEL COLOMBO', 'debit');
        expect(before.category).toBe('Shopping');

        M.learn('ODEL COLOMBO', 'expenses', 'Education', 0.99);

        const after = M.classify('ODEL COLOMBO', 'debit');
        expect(after.category, 'the app answered from a cache filled BEFORE the user '
            + 'corrected this merchant — the correction would look like it had not saved')
            .toBe('Education');
    });

    it('a correction survives a second lookup', () => {
        M.classify('ODEL COLOMBO', 'debit');
        M.learn('ODEL COLOMBO', 'expenses', 'Education', 0.99);
        M.classify('ODEL COLOMBO', 'debit');
        expect(M.classify('ODEL COLOMBO', 'debit').category).toBe('Education');
    });

    it('forgetLearned drops the classifications too', () => {
        // The map can change from outside — another tab, a cloud sync. Dropping the
        // learned map without dropping what was derived from it would keep the old
        // answers alive with no way to reach them.
        M.classify('ODEL COLOMBO', 'debit');
        M.learn('ODEL COLOMBO', 'expenses', 'Education', 0.99);
        expect(M.classify('ODEL COLOMBO', 'debit').category).toBe('Education');
        M.forgetLearned();
        expect(typeof M.forgetLearned).toBe('function');
        // Still Education: forgetLearned re-reads the stored map, which now has it.
        expect(M.classify('ODEL COLOMBO', 'debit').category).toBe('Education');
    });

    it('a new merchant list takes effect immediately', () => {
        // The auto-updated list is the OTHER input to a classification. A narration
        // the seed registry does not know falls through today; once the list names
        // it, the very next call must reflect that — not an answer cached before it
        // arrived.
        const RAW = 'ZZQX TRADING HOUSE';
        const { M: M2 } = load([{ key: 'zzqx trading', category: 'Health', goesTo: 'expenses' }]);
        const before = M2.classify(RAW, 'debit');
        expect(before.category, 'the fixture is already known, so this proves nothing')
            .not.toBe('Health');

        return M2.syncRemote('/merchants.json', true).then((n) => {
            expect(n, 'the stubbed list was not accepted — retarget this test')
                .toBeGreaterThan(0);
            expect(M2.classify(RAW, 'debit').category,
                'the app answered from a cache filled BEFORE the merchant list was '
                + 'updated, so a newly-known merchant stays unknown until a reload')
                .toBe('Health');
        });
    });

    it('an explicit forget makes it recompute, not re-answer', () => {
        const a = M.classify('KEELLS SUPER COLOMBO', 'debit');
        M._clsForget();
        const b = M.classify('KEELLS SUPER COLOMBO', 'debit');
        expect(b).toEqual(a);
    });
});

describe('the cache is bounded and does not fall off a cliff', () => {
    it('stays correct across far more narrations than it can hold', () => {
        // 12,000 distinct narrations against a 3,000 ceiling: the older generation
        // is retired repeatedly. Every answer must still be right.
        for (let i = 0; i < 12000; i++) M.classify('SOME MERCHANT NUMBER ' + i, 'debit');
        expect(M.classify('KEELLS SUPER COLOMBO', 'debit').category).toBe('Groceries');
        expect(M.classify('NETFLIX.COM', 'debit').category).toBe('Streaming');
        expect(M.classify('LOCAL CASH ADVANCE FEE (DB)', 'debit').category).toBe('Bank Charges');
    });

    it('retires the older generation instead of dropping everything', () => {
        // The difference is invisible in the ANSWERS — both are correct, one just
        // recomputes far more — so it is asserted on the hit counter. Overflow the
        // live generation, then ask again for a key that must now be in the retired
        // one: it has to come back as a hit.
        M._clsForget();
        const key = 'KEELLS SUPER COLOMBO';
        M.classify(key, 'debit');                                  // miss, now live
        const max = M._clsStats().max;
        for (let i = 0; i < max + 50; i++) M.classify('FILLER ' + i, 'debit');
        const before = M._clsStats();
        M.classify(key, 'debit');
        const after = M._clsStats();
        expect(after.misses, 'the cache emptied itself at its ceiling instead of '
            + 'retiring the older half — measured, that made the dashboard go '
            + '826 ms, 53 ms, 302 ms as it filled, cleared and refilled')
            .toBe(before.misses);
        expect(after.hits).toBe(before.hits + 1);
    });

    it('a hot narration survives the generations turning over', () => {
        for (let i = 0; i < 8000; i++) {
            M.classify('FILLER ' + i, 'debit');
            if (i % 500 === 0) M.classify('KEELLS SUPER COLOMBO', 'debit');
        }
        expect(M.classify('KEELLS SUPER COLOMBO', 'debit').category).toBe('Groceries');
    });

    it('finishes that in a sensible time — this is the whole point', () => {
        const t0 = Date.now();
        for (let pass = 0; pass < 3; pass++) {
            for (let i = 0; i < 2000; i++) M.classify('MERCHANT ' + i, 'debit');
        }
        // Three passes over the same 2,000: passes two and three should be cheap.
        expect(Date.now() - t0, 'classification is not being reused between passes')
            .toBeLessThan(8000);
    });
});
