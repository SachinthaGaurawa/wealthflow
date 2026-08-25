/* =============================================================================
 * test/merchant_taxonomy_test.js — one taxonomy, and a cash advance that
 * classifies itself
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * Importing a real Nations Trust / AmEx statement left exactly two lines for the
 * user to categorise by hand:
 *
 *     Cash advance from MB            50% sure   "only one engine answered"
 *     LOCAL CASH ADVANCE FEE (DB)     60% sure   "only one engine answered"
 *
 * Both are the bank describing its own product. Neither needs an AI, a web
 * search or a human — and neither could be answered by a human anyway, because
 * the picker offered seventeen merchant categories and not one of them was
 * "Cash Advance" or "Bank Charges". The system asked the only question it could
 * not answer itself, and then made it unanswerable.
 *
 * TWO CAUSES, BOTH DRIFT
 *
 *  1. The FEE vocabulary in wealthflow-merchants.js knew twenty kinds of bank
 *     charge and not "cash advance fee" — while wealthflow-route.js had listed
 *     it since the day it was written. One module knew; the one that decides
 *     did not.
 *  2. FOUR files each carried their own copy of the category list:
 *     wealthflow-merchants.js VALID_CATS, the sentence in its AI prompt, the
 *     picker in wealthflow-verify-panel.js, and api/verify.js. VALID_CATS had
 *     already grown 'Bank Charges' and 'Cash Withdrawal'; the other three never
 *     heard about it. So the classifier could produce a category the interface
 *     could not display and the server would reject.
 *
 * The taxonomy is now ONE array, VALID_CATS and the prompt are derived from it,
 * the picker reads it at runtime, and the two files that genuinely cannot import
 * it are pinned to it here.
 * ===========================================================================*/

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

let M;
beforeAll(() => {
    const win = { localStorage: { getItem: () => null, setItem: () => {} } };
    new Function('window', 'console', read('wealthflow-merchants.js'))(win, { log() {}, warn() {} });
    M = win.WFMerchants;
});

/** Every string literal in an array assigned to `name`, in file order. */
function listIn(src, name) {
    const i = src.indexOf(name);
    expect(i, `${name} is gone — retarget this test`).toBeGreaterThan(-1);
    const open = src.indexOf('[', i);
    const close = src.indexOf('];', open);
    expect(close).toBeGreaterThan(open);
    return [...src.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

describe('the module loaded and publishes its taxonomy (guards a vacuous pass)', () => {
    it('exposes CATEGORIES and classify', () => {
        expect(typeof M.classify).toBe('function');
        expect(Array.isArray(M.CATEGORIES)).toBe(true);
        expect(M.CATEGORIES.length).toBeGreaterThan(15);
    });
});

describe('there is ONE category list', () => {
    it('the picker offers exactly what the classifier can produce', () => {
        const fb = listIn(read('wealthflow-verify-panel.js'), 'CATS_FALLBACK');
        expect(fb, 'the picker fallback has drifted from WFMerchants.CATEGORIES — a '
            + 'category the classifier produces would be unofferable again')
            .toEqual(M.CATEGORIES);
    });

    it('the server accepts exactly what the classifier can produce', () => {
        const api = listIn(read('api/verify.js'), 'const CATEGORIES');
        expect(api, 'api/verify.js has drifted from WFMerchants.CATEGORIES — it would '
            + 'reject a category the app itself uses').toEqual(M.CATEGORIES);
    });

    it('the picker reads the live list rather than only its fallback', () => {
        expect(read('wealthflow-verify-panel.js'),
            'the picker no longer asks WFMerchants for the taxonomy')
            .toMatch(/WFMerchants\s*&&\s*W?\.?\s*WFMerchants\.CATEGORIES|WFMerchants\.CATEGORIES/);
    });

    it('the AI is told the same list, not a hand-written copy of it', () => {
        expect(read('wealthflow-merchants.js'),
            'the prompt spells the categories out again — it will drift')
            .toContain("CATEGORIES.join(', ')");
    });

    it('the categories the classifier actually emits are all offerable', () => {
        // Not a source scan: run the thing and check what comes out.
        const emitted = new Set();
        [['LOCAL CASH ADVANCE FEE (DB)', 'debit'], ['Cash advance from MB', 'debit'],
         ['ATM WITHDRAWAL COLOMBO', 'debit'], ['KEELLS SUPER COLOMBO', 'debit'],
         ['NETFLIX.COM', 'debit'], ['CEB ELECTRICITY BILL', 'debit'],
         ['STAMP DUTY', 'debit'], ['POS TRANSACTION FEE', 'debit']]
            .forEach(([raw, dir]) => {
                const c = M.classify(raw, dir);
                if (c && c.category) emitted.add(c.category);
            });
        expect(emitted.size).toBeGreaterThan(4);
        emitted.forEach((c) => {
            expect(M.CATEGORIES, `the classifier emits "${c}", which the picker cannot offer`)
                .toContain(c);
        });
    });
});

describe('a cash advance and its fee classify themselves', () => {
    it('the fee is a bank charge, at a confidence that never reaches a human', () => {
        const c = M.classify('LOCAL CASH ADVANCE FEE (DB)', 'debit');
        expect(c.category, 'the exact line from the real statement is still unclassified')
            .toBe('Bank Charges');
        expect(c.type).toBe('service_fee');
        expect(c.confidence, 'below the 0.95 write gate it goes back to manual review')
            .toBeGreaterThanOrEqual(M.WRITE_GATE);
    });

    it('the advance itself is a Cash Advance, not a purchase', () => {
        const c = M.classify('Cash advance from MB', 'debit');
        expect(c.category).toBe('Cash Advance');
        expect(c.type, 'index.html computes the bank fee off this type — as a "purchase" '
            + 'it gets no fee at all').toBe('cash_advance');
        expect(c.confidence).toBeGreaterThanOrEqual(M.WRITE_GATE);
    });

    it('the FEE is read as the fee, not as a second advance', () => {
        // Both lines contain "cash advance". If the advance rule ran first, the
        // fee would be filed as another drawdown and the money counted twice.
        expect(M.classify('LOCAL CASH ADVANCE FEE (DB)', 'debit').category).toBe('Bank Charges');
        expect(M.classify('CASH ADVANCE FEE', 'debit').category).toBe('Bank Charges');
        expect(M.classify('LOCAL CASH ADVANCE (DB)', 'debit').category).toBe('Cash Advance');
    });

    it('an advance landing in the bank account is borrowed, never income', () => {
        const c = M.classify('Cash advance from MB', 'credit');
        expect(c.creditKind, 'a card cash advance counted as income overstates earnings '
            + 'and hides the debt in the same movement').toBe('cash_advance');
        expect(c.goesTo).not.toBe('income');
        expect(c.category).not.toBe('Salary');
    });

    it('cash ADVANCE and cash WITHDRAWAL stay two different things', () => {
        // Borrowed at card rates vs your own money out of a machine. Different
        // fees, different meaning; collapsing them would be a comfortable blur.
        expect(M.classify('ATM WITHDRAWAL COLOMBO', 'debit').category).toBe('Cash Withdrawal');
        expect(M.classify('CASH ADVANCE COLOMBO', 'debit').category).toBe('Cash Advance');
    });

    /* A SHORT single-word key may only match on a word boundary. The rule is
     * stated in a comment in hasKey() and had no test, so a refactor that
     * precomputed the per-key facts could drop it and every suite stayed green.
     * These two are the failures it prevents, verified by running the classifier
     * with the rule removed. */
    it('a short key does not match inside a longer word', () => {
        expect(M.classify('MODEL TOWN', 'debit').category,
            "'odel' matched inside MODEL — every merchant whose name contains a "
            + 'short key as a substring would be mis-filed')
            .not.toBe('Shopping');
        expect(M.classify('CRIBBAGE CLUB', 'debit').category,
            "'crib' matched inside CRIBBAGE").not.toBe('Government');
    });

    it('but a short key still matches as a whole word', () => {
        // The rule must not be so strict that it stops the key working at all.
        expect(M.classify('ODEL COLOMBO', 'debit').category).toBe('Shopping');
        expect(M.classify('CRIB REPORT FEE', 'debit').category).not.toBe(null);
    });

    it('does not turn ordinary merchants into fees or advances', () => {
        expect(M.classify('KEELLS SUPER COLOMBO', 'debit').category).toBe('Groceries');
        expect(M.classify('NETFLIX.COM', 'debit').category).toBe('Streaming');
        expect(M.classify('ADVANCE AUTO PARTS', 'debit').category).not.toBe('Cash Advance');
    });
});
