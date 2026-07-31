// =============================================================================
// WealthFlow Shadow Test Harness — an insight's call to action must DO something
// =============================================================================
// THE BUG THIS FILE EXISTS TO STOP, reported by the user as issue #46:
//
//     "'Add your income' button please fix that. Urgently fix that issue."
//
// It is not a button. wealthflow-insights.js tile() emits a real <button> ONLY
// when the insight carries a `fix`; otherwise it emits
//
//     <div class="wfx-a" style="color:…">Add your income</div>
//
// Same class, same tone colour, no cursor:pointer, and the click handler binds
// to `.wfx-fix` only. It looks exactly like the one control on the card that
// does work, and it is inert.
//
// Three of the four call-to-action affordances were dead — 'Add your income',
// 'Pay it now' and 'Pay before <date>'. Only 'Merge them' (fix: 'mergeSubs')
// rendered as a control. The user reported one; the same line broke all three.
//
// WHY THE INTERACTION SWEEP DID NOT CATCH IT
//   test/e2e/interaction-sweep.mjs clicks every CONTROL. A <div> with no role
//   and no tabindex is not a control, so these were never in the selector set.
//   A detector that enumerates controls cannot see an affordance that only
//   looks like one — which is why this is asserted here, at the source.
//
// The rule these tests enforce: if an insight offers an action, that action
// must have somewhere to go (`go`) or something to repair (`fix`). Rendering a
// label styled as a button, wired to nothing, is not an option.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/** Load the shipped IIFE with a controllable data layer. */
function loadInsights({ db = {}, cards = {}, showPage = null } = {}) {
    const win = {
        DB: { get: (k) => (Object.prototype.hasOwnProperty.call(db, k) ? db[k] : []) },
        wfCardRegistry: { get: () => cards },
        notify: () => {},
    };
    if (showPage) win.showPage = showPage;
    // renderInto() injects its stylesheet via styleOnce(), which touches
    // `document`. Without this stub the render tests threw ReferenceError —
    // failing for a reason that has nothing to do with the defect under test,
    // which would have made them pass by accident once the harness changed.
    const node = () => ({ id: '', textContent: '', style: {}, appendChild() {}, setAttribute() {} });
    const doc = {
        getElementById: () => null,
        createElement: node,
        head: { appendChild() {} },
        body: { appendChild() {} },
    };
    new Function('window', 'document', 'console', fs.readFileSync('wealthflow-insights.js', 'utf8'))(
        win, doc, { log() {}, warn() {}, error() {} },
    );
    return { W: win, I: win.WFInsights };
}

/**
 * A DOM stand-in just rich enough for renderInto(): it captures the markup and
 * hands back objects for the elements the handler binds to. Enough to prove the
 * wiring exists, without pretending to be a browser.
 */
function fakeEl() {
    let html = '';
    let cache = null;
    const el = {
        style: {},
        // The elements must be the SAME objects across calls. renderInto() looks
        // them up and assigns .onclick; the test then looks them up again to fire
        // it. Returning fresh objects each time — which the first version did —
        // silently dropped the handler and failed with "onclick is not a
        // function", testing the stub rather than the code.
        get innerHTML() { return html; },
        set innerHTML(v) { html = String(v); cache = null; },
        querySelectorAll(sel) {
            const cls = String(sel).replace(/^\./, '');
            if (!cache) {
                cache = [];
                const re = /<button[^>]*>/g;
                let m;
                while ((m = re.exec(html))) {
                    const tag = m[0];
                    cache.push({
                        tag,
                        onclick: null,
                        getAttribute(name) {
                            const a = new RegExp(name + '="([^"]*)"').exec(tag);
                            return a ? a[1] : null;
                        },
                    });
                }
            }
            return cache.filter((b) => new RegExp('class="[^"]*' + cls + '[^"]*"').test(b.tag));
        },
    };
    return el;
}

/** The income card the user was looking at when they filed #46. */
const INCOME_CASE = {
    db: {
        incomeRecv: [],
        income: [{ id: 1, amount: 100 }, { id: 2, amount: 200 }],
        expenses: [{ date: new Date().getFullYear() + '-03-01', amount: 3464337 }],
    },
};

describe('insights: the module loaded (guards against a vacuous pass)', () => {
    it('exposes the API the tests read', () => {
        const { I } = loadInsights(INCOME_CASE);
        expect(typeof I.income).toBe('function');
        expect(typeof I.renderInto).toBe('function');
    });

    it('reproduces the exact card from issue #46', () => {
        // incomeRecv empty + spending present → "Year income reads zero".
        const { I } = loadInsights(INCOME_CASE);
        const items = I.income();
        expect(items).toHaveLength(1);
        expect(items[0].title).toMatch(/income reads zero/i);
        expect(items[0].action).toBe('Add your income');
    });
});

describe('insights: every action has somewhere to go', () => {
    it('"Add your income" carries a navigation target', () => {
        // THE REGRESSION. On main this insight has `action` and no `fix`/`go`,
        // so tile() renders a dead <div>.
        const [card] = loadInsights(INCOME_CASE).I.income();
        expect(card.go || card.fix, 'the CTA has no target at all').toBeTruthy();
    });

    it('sends the user to the page the insight names', () => {
        // The body says "add them on the Income page", and in the sidebar the
        // Income page is `incRecv` — `income` is Investments, which is the store
        // this insight deliberately EXCLUDES. Navigating there would land the
        // user exactly where the number does not come from.
        const [card] = loadInsights(INCOME_CASE).I.income();
        expect(card.go).toBe('incRecv');
    });

    it('the overdue-card CTAs carry targets too', () => {
        const today = new Date();
        const { I } = loadInsights({
            cards: { 1234: { type: 'credit_card', name: 'AMEX', bank: 'boc', dueDay: Math.max(1, today.getDate() - 3) } },
            db: { cconetime: [{ card_last4: '1234', amount: 50000, paid: false }], ccPayments: [] },
        });
        const withAction = I.cards().filter((x) => x.action);
        expect(withAction.length, 'no card CTA produced — fixture did not trigger one').toBeGreaterThan(0);
        for (const it of withAction) {
            expect(it.go || it.fix, `"${it.action}" has no target`).toBeTruthy();
        }
    });
});

describe('insights: an action renders as a real control', () => {
    const render = (item) => {
        const { I } = loadInsights();
        const el = fakeEl();
        I.renderInto(el, [item], {});
        return el;
    };

    it('emits a <button>, not a look-alike <div>', () => {
        const el = render({ sev: 'high', kind: 'income_zero', title: 't', action: 'Add your income', go: 'incRecv' });
        expect(el.innerHTML).toMatch(/<button[^>]*>Add your income<\/button>/);
        expect(el.innerHTML).not.toMatch(/<div class="wfx-a"[^>]*>Add your income<\/div>/);
    });

    it('looks pressable — a control the user cannot tell is one is still broken', () => {
        const el = render({ sev: 'high', kind: 'income_zero', title: 't', action: 'Add your income', go: 'incRecv' });
        expect(el.innerHTML).toMatch(/cursor:pointer/);
    });

    it('keeps the existing repair actions working', () => {
        const el = render({ sev: 'high', kind: 'sub_dupe', title: 't', action: 'Merge them', fix: 'mergeSubs' });
        expect(el.innerHTML).toMatch(/<button[^>]*data-fix="mergeSubs"/);
    });
});

describe('insights: clicking actually navigates', () => {
    it('calls showPage with the insight\'s target', () => {
        // Binding a handler that calls nothing would pass every assertion above
        // and still leave the user tapping a dead control.
        const seen = [];
        const { I } = loadInsights({ showPage: (p) => seen.push(p) });
        const el = fakeEl();
        I.renderInto(el, [{ sev: 'high', kind: 'income_zero', title: 't', action: 'Add your income', go: 'incRecv' }], {});
        const btns = el.querySelectorAll('.wfx-fix');
        expect(btns.length, 'the handler bound to nothing').toBeGreaterThan(0);
        btns[0].onclick();
        expect(seen).toEqual(['incRecv']);
    });

    it('says so rather than doing nothing when navigation is unavailable', () => {
        // showPage missing is exactly the silent-failure shape this repo keeps
        // finding. The user must not be left pressing a button that no-ops.
        const said = [];
        const { W, I } = loadInsights();
        W.notify = (m, t) => said.push({ m: String(m), t });
        const el = fakeEl();
        I.renderInto(el, [{ sev: 'high', kind: 'income_zero', title: 't', action: 'Add your income', go: 'incRecv' }], {});
        el.querySelectorAll('.wfx-fix')[0].onclick();
        expect(said.length, 'clicked and nothing was reported').toBeGreaterThan(0);
    });
});

describe('insights: the invariant, stated at the source', () => {
    it('no insight declares an action without a target', () => {
        // The class of bug, not the instance. A future insight that adds
        // `action:` and forgets `go:`/`fix:` reintroduces a dead button, and this
        // is the assertion that stops it.
        const src = fs.readFileSync('wealthflow-insights.js', 'utf8');
        const blocks = src.split(/out\.push\(\{/).slice(1);
        const offenders = blocks
            .map((b) => b.slice(0, b.indexOf('});')))
            .filter((b) => /\baction:/.test(b) && !/\b(fix|go):/.test(b))
            .map((b) => (/action:\s*'([^']*)'/.exec(b) || [, '(dynamic)'])[1]);
        expect(offenders, `these CTAs render as dead divs: ${offenders.join(', ')}`).toEqual([]);
    });
});
