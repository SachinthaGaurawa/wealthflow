/* =============================================================================
 * test/expense_taxonomy_test.js — one expense taxonomy, four copies of it
 * -----------------------------------------------------------------------------
 * WHAT THIS CLOSES
 *
 * autoCategorizeExpense() returned 'Medical' and 'Clothing'. The Category
 * dropdown offers 'Healthcare' and 'Shopping (Fashion)'. autoDetectCategory()
 * — which fires on every keystroke in the expense description field — only
 * moves the select when the returned name MATCHES an option, so those two
 * rules did nothing whatsoever. A quarter of the vocabulary, silently dead:
 * type "pharmacy" or "shoes" and the category simply did not move.
 *
 * Nothing was corrupted, which is why it survived. It failed as an absence.
 *
 * ── THE SAME DRIFT, ALREADY FIXED ONCE, IN THE OTHER TAXONOMY ──────────────
 *
 * test/merchant_taxonomy_test.js exists because FOUR files each carried their
 * own copy of the MERCHANT category list and one of them "could produce a
 * category the interface could not display and the server would reject". That
 * taxonomy was unified and pinned.
 *
 * The EXPENSE-ENTRY taxonomy — the names in the e_cat dropdown, which is what
 * the owner's own records are filed under — had four copies of its own and
 * never got the same treatment:
 *
 *   1. the e_cat <option> list           26 names
 *   2. autoCategorizeExpense's own list    8 names, two of them wrong
 *   3. merchant-search.js CATEGORIES      24 names, missing Gift and Gold
 *   4. the receipt scanner                 fixed earlier, one call site deep
 *
 * ── WHY THE WFMerchants TAXONOMY IS DELIBERATELY NOT INCLUDED ──────────────
 *
 * wealthflow-merchants.js carries a DIFFERENT 21-name vocabulary — Groceries,
 * Health, Streaming, Gym/Fitness, Leasing, Cash Advance, Bank Charges — which
 * classifies bank-statement lines and routes them with `goesTo`. It is already
 * one definition, already pinned across four files, and already tested.
 *
 * Merging the two would be a product decision about what a category MEANS, not
 * a defect fix, and it would break api/verify.js, the verify panel's picker and
 * merchant_taxonomy_test.js. So the two taxonomies stay separate and this file
 * says so, rather than leaving the omission to look like an oversight.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SEARCH = fs.readFileSync(path.join(ROOT, 'merchant-search.js'), 'utf8');

const unescape = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

/** The one definition, read out of index.html. */
const canonical = (() => {
    const m = HTML.match(/const EXPENSE_CATEGORIES = \[([\s\S]*?)\];/);
    expect(m, 'index.html no longer defines EXPENSE_CATEGORIES').toBeTruthy();
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();

/** What the Category dropdown actually offers. */
const dropdown = (() => {
    const at = HTML.indexOf('id="e_cat"');
    expect(at, 'the expense category dropdown is gone').toBeGreaterThan(-1);
    const block = HTML.slice(at, HTML.indexOf('</select>', at));
    return [...block.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map((x) => unescape(x[1]).trim());
})();

/** The list merchant-search.js allows the model to answer with. */
const search = (() => {
    const m = SEARCH.match(/const CATEGORIES = \[([\s\S]*?)\];/);
    expect(m, 'merchant-search.js no longer defines CATEGORIES').toBeTruthy();
    return m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
})();

/** Every category autoCategorizeExpense can emit, in the order it tries them.
 *
 *  Sliced from `const catMap = {` to its own closing brace. The first version
 *  cut at the first `return null;` — which is the early guard on the line
 *  ABOVE the map, so it read an empty block and reported no categories at all.
 *  A checker that matches nothing passes everything. */
const emitted = (() => {
    const at = HTML.indexOf('async function autoCategorizeExpense');
    expect(at, 'autoCategorizeExpense is gone').toBeGreaterThan(-1);
    const from = HTML.indexOf('const catMap = {', at);
    expect(from, 'autoCategorizeExpense no longer has a catMap').toBeGreaterThan(-1);
    const block = HTML.slice(from, HTML.indexOf('\n            };', from));
    const out = [...block.matchAll(/'\s*:\s*'([^']+)'/g)].map((x) => x[1]);
    expect(out.length, 'the catMap extractor read nothing — it is not checking anything').toBeGreaterThan(0);
    return out;
})();

describe('the three lists are one list', () => {
    it('parsed real values, not three empty arrays', () => {
        expect(canonical.length).toBeGreaterThan(20);
        expect(dropdown.length).toBeGreaterThan(20);
        expect(search.length).toBeGreaterThan(20);
    });

    it('the dropdown offers exactly the canonical categories, in order', () => {
        /* The dropdown is what the owner's existing records are filed under, so
         * it is the thing everything else must match — not the other way round.
         * Renaming a category here renames nothing in the stored data; it just
         * orphans it. */
        expect(dropdown).toEqual(canonical);
    });

    it('merchant-search.js allows exactly the canonical categories', () => {
        expect([...search].sort()).toEqual([...canonical].sort());
    });

    it('THE OMISSION: Gift and Gold are answerable now', () => {
        /* Both are in the dropdown and neither was in the model's allowed list,
         * so a jeweller or a gift shop fell to "Other" at any confidence. */
        expect(search).toContain('Gift');
        expect(search).toContain('Gold');
    });
});

describe('auto-categorise can only return categories that exist', () => {
    it('emits something at all', () => {
        expect(emitted.length).toBeGreaterThan(8);
    });

    it.each(emitted.map((c) => [c]))('%s is a real category', (c) => {
        expect(canonical, `autoCategorizeExpense can return "${c}", which the dropdown does not offer — `
            + 'autoDetectCategory matches on the name, so that rule does nothing').toContain(c);
    });

    it('THE REGRESSION: the two dead names are gone', () => {
        expect(emitted).not.toContain('Medical');
        expect(emitted).not.toContain('Clothing');
        expect(emitted).toContain('Healthcare');
        expect(emitted).toContain('Shopping (Fashion)');
    });
});

describe('a specific rule is never swallowed by a general one', () => {
    /* The matcher returns the FIRST pattern that matches, and Object.entries
     * preserves insertion order. With 'transport' listed before 'fuel', petrol
     * would route to Transport and the Fuel category could never be reached —
     * the same unreachable-category defect as a misspelt name, arrived at by
     * ordering instead. */
    const order = emitted;
    const before = (a, b) => {
        const i = order.indexOf(a);
        const j = order.indexOf(b);
        expect(i, `${a} is not in the map`).toBeGreaterThan(-1);
        expect(j, `${b} is not in the map`).toBeGreaterThan(-1);
        return i < j;
    };

    it('Fuel is tried before Transport', () => expect(before('Fuel', 'Transport')).toBe(true));
    it('Telecom is tried before Utilities', () => expect(before('Telecom', 'Utilities')).toBe(true));
    it('Subscriptions is tried before Entertainment', () => expect(before('Subscriptions', 'Entertainment')).toBe(true));
    it('Dining is tried before Food & Groceries', () => expect(before('Dining', 'Food & Groceries')).toBe(true));
});

describe('the merchant taxonomy is a separate vocabulary, on purpose', () => {
    it('wealthflow-merchants.js still has its own list', () => {
        /* If someone later "fixes" this by pointing WFMerchants at
         * EXPENSE_CATEGORIES, api/verify.js, the verify panel picker and
         * merchant_taxonomy_test.js all break — and a product decision will
         * have been made by accident. */
        const src = fs.readFileSync(path.join(ROOT, 'wealthflow-merchants.js'), 'utf8');
        expect(src).toMatch(/var CATEGORIES = \[/);
        expect(src).toContain("'Cash Advance'");
    });

    it('and it is not the expense-entry list', () => {
        const src = fs.readFileSync(path.join(ROOT, 'wealthflow-merchants.js'), 'utf8');
        const m = src.match(/var CATEGORIES = \[([\s\S]*?)\];/);
        const theirs = m[1].split(',').map((x) => x.trim().replace(/^'|'$/g, '')).filter(Boolean);
        expect(theirs).not.toEqual(canonical);
    });
});

/* ── WHAT IT ACTUALLY RETURNS, NOT WHAT THE MAP LOOKS LIKE ───────────────────
 *
 * The matcher is executed here against real descriptions. The ordering
 * assertions above are necessary and were not sufficient: they compared the
 * pairs I thought of, and "pharmacy bill" still went to Utilities — because a
 * bare `bill` token sat in the Utilities pattern and matched anything ending in
 * the word. That was found by typing the descriptions into the real field in a
 * browser, not by reading the map, so the cases live here now. */
describe('the matcher, run', () => {
    /** autoCategorizeExpense's own catMap, evaluated the way the function does. */
    const match = (() => {
        const at = HTML.indexOf('const catMap = {', HTML.indexOf('async function autoCategorizeExpense'));
        const end = HTML.indexOf('\n            };', at);
        // eslint-disable-next-line no-new-func
        const catMap = new Function(`${HTML.slice(at, end)}\n}; return catMap;`)();
        return (desc) => {
            const lower = String(desc).toLowerCase();
            for (const [keywords, cat] of Object.entries(catMap)) {
                if (new RegExp(keywords).test(lower)) return cat;
            }
            return null;
        };
    })();

    it.each([
        ['pharmacy bill', 'Healthcare'],
        ['hospital bill', 'Healthcare'],
        ['channel a doctor', 'Healthcare'],
        ['new shoes', 'Shopping (Fashion)'],
        ['petrol filling station', 'Fuel'],
        ['diesel', 'Fuel'],
        ['dialog reload', 'Telecom'],
        ['slt broadband bill', 'Telecom'],
        ['netflix', 'Subscriptions'],
        ['keells super', 'Food & Groceries'],
        ['dinner at cafe', 'Dining'],
        ['kfc', 'Dining'],
        ['uber ride', 'Transport'],
        ['electricity bill ceb', 'Utilities'],
        ['salon haircut', 'Personal Care'],
        ['ceylinco insurance premium', 'Insurance'],
        ['monthly rent', 'Rent'],
        ['school tuition', 'Education'],
    ])('%s → %s', (desc, want) => {
        expect(match(desc)).toBe(want);
    });

    it('THE ORDERING BUG: a generic word does not capture another category', () => {
        /* `bill` appears in the phrasing of half these categories. A token that
         * belongs to all of them belongs in none. */
        for (const d of ['pharmacy bill', 'hospital bill', 'phone bill']) {
            expect(match(d), `"${d}" fell to Utilities on the word "bill"`).not.toBe('Utilities');
        }
    });

    it('an unrelated description matches nothing rather than guessing', () => {
        expect(match('zzzz qqqq')).toBe(null);
    });
});
