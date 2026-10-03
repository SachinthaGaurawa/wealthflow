import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import briefingApi, { briefing, pills, render, RULES } from '../wealthflow-advisor-briefing.js';
import { renderFactSheet } from '../wealthflow-advisor-facts.js';
import { check } from '../wealthflow-advisor-check.js';
import { readScenario } from '../wealthflow-advisor-scenarios.js';
import { html, source, page, household, factsOf, advisorPage, EMPTY } from './helpers/advisor-page.js';

// WHAT THE ADVISOR SHOWS BEFORE IT IS ASKED ANYTHING.
//
// Opening the Advisor used to show a greeting and the same five questions to everyone. wealthflow-advisor-briefing.js turns the fact sheet's findings into a short card of the
// few things worth a look, each with the question to ask about it, and into suggested questions that name the owner's own loan and goal. No model is involved, so these tests hold
// it to the real fact sheet (the card may show only figures the sheet holds), to the decision lab (a suggested what-if must be one the lab reads), to hostile names, and to the
// wiring in index.html, run with a real DOM.

const facts = (data = household()) => factsOf(page(data).ctx);
const sheetOf = (f) => renderFactSheet(f);
const cardText = (b) => [b.headline, ...b.stats.map((s) => `${s.label}: ${s.value}`), ...b.items.flatMap((i) => [i.title, i.detail])];
const moneyIn = (s) => Number(String(s).replace(/[^0-9.-]/g, ''));

/** The same household, but earning well and with its goal met: nothing should be flagged. */
function comfortable() {
    const d = household();
    d.incomeRecv.forEach((r) => { r.amount = 700000; });
    d.targets = [];
    d.loans = [];
    d.balance = { total: 3000000, flows: [] };
    return d;
}

describe('the card, from the real fact sheet', () => {
    const f = facts();
    const b = briefing(f);

    it('opens with the most serious finding, with the owner\'s own figure', () => {
        expect(b.ok).toBe(true);
        expect(b.asOf).toBe('2026-10-03');
        expect(b.items[0].id).toBe('short-after-debt');
        expect(b.items[0].tone).toBe('high');
        expect(b.items[0].title).toBe('Each month ends LKR 23,914 short after debts');
        expect(b.headline).toBe('4 things worth a look');
    });

    it('lists the findings most serious first, at most MAX_ITEMS, then what is already committed in the next 30 days', () => {
        const findings = b.items.filter((i) => i.id !== 'next-30');
        expect(findings.map((i) => i.id)).toEqual(['short-after-debt', 'cover-low', 'goal:Emergency fund', 'outflow-rising']);
        expect(findings.length).toBeLessThanOrEqual(RULES.MAX_ITEMS);
        const rank = { high: 0, medium: 1, low: 2, good: 3, info: 4 };
        const tones = b.items.map((i) => rank[i.tone]);
        expect(tones).toEqual([...tones].sort((x, y) => x - y));
        const last = b.items[b.items.length - 1];
        expect(last.id).toBe('next-30');
        expect(last.title).toBe('Next 30 days: LKR 140,200 already committed');
        expect(last.detail).toBe('Soonest: Rent (1 Nov), Honda Vezel Loan — instalment... (1 Nov).');
    });

    it('leaves out the worst case the engine itself says is not a forecast', () => {
        expect(f.flags.some((x) => x.id === 'runway-no-income')).toBe(true);
        expect(b.items.some((i) => i.id === 'runway-no-income')).toBe(false);
    });

    it('shows figures that add up: income, less living costs, less loans and cards, is what is left', () => {
        const by = Object.fromEntries(b.stats.map((s) => [s.label, moneyIn(s.value)]));
        expect(by['Typical income'] - by['Living costs'] - by['Loans and cards']).toBe(by['Left each month']);
        expect(by['Left each month']).toBe(-23914);
        expect(by['On hand']).toBe(640000);
    });

    it('shows only figures the fact sheet holds (read back through the answer checker)', () => {
        const r = check(cardText(b).join('\n'), [sheetOf(f)], []);
        expect(r.counted).toBe(true);
        expect(r.unknown).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.checked).toBeGreaterThanOrEqual(10);
    });

    it('every question it offers is one whose figures are the owner\'s own', () => {
        for (const i of b.items) {
            const r = check(i.ask, [sheetOf(f)], []);
            expect(r.unknown, i.ask).toEqual([]);
        }
    });

    it('is deterministic: the same books give the same card', () => {
        expect(briefing(facts())).toEqual(b);
    });

    it('respects a smaller cap on findings', () => {
        const small = briefing(f, { max: 2 });
        expect(small.items.filter((i) => i.id !== 'next-30').map((i) => i.id)).toEqual(['short-after-debt', 'cover-low']);
    });
});

describe('a household with nothing wrong', () => {
    it('says so, and still shows what is coming', () => {
        const f = facts(comfortable());
        expect(f.flags.filter((x) => x.severity === 'high' || x.severity === 'medium')).toEqual([]);
        const b = briefing(f);
        expect(b.ok).toBe(true);
        expect(b.headline).toBe('All clear');
        expect(b.items[0]).toMatchObject({ id: 'all-clear', tone: 'good', title: 'Nothing urgent in your books' });
        expect(b.items[0].detail).toMatch(/^A typical month leaves LKR [\d,]+/);
        expect(check(cardText(b).join('\n'), [sheetOf(f)], []).unknown).toEqual([]);
    });
});

describe('no records, no card', () => {
    it.each([['empty books', () => facts(EMPTY())], ['null', () => null], ['undefined', () => undefined], ['not ok', () => ({ ok: false })], ['a string', () => 'x'], ['an array', () => []]])('%s', (_n, make) => {
        const b = briefing(make());
        expect(b.ok).toBe(false);
        expect(b.items).toEqual([]);
        expect(b.stats).toEqual([]);
        expect(pills(make())).toEqual([]);
    });
    it('never throws on strange facts', () => {
        for (const f of [{ ok: true }, { ok: true, typical: {} }, { ok: true, typical: { income: 'x' }, flags: [null, {}, { id: 5 }, { id: 'goal:' }] }, { ok: true, typical: { income: 1 }, flags: 'oops', debt: 3, goals: 4 }]) {
            expect(() => briefing(f)).not.toThrow();
            expect(() => pills(f)).not.toThrow();
        }
    });
});

describe('suggested questions that name the owner\'s own loan and goal', () => {
    const f = facts();
    const ps = pills(f);

    it('are the what-if on the biggest loan, the stress test and the goal', () => {
        expect(ps.map((p) => p.text)).toEqual([
            'What if I pay LKR 16,000 extra a month on Honda Vezel Loan?',
            'How long would my money last if my income fell 30%?',
            'How long will Emergency fund take at my pace?',
        ]);
        expect(ps.length).toBeLessThanOrEqual(RULES.MAX_PILLS);
    });

    it('the extra is a quarter of the instalment to the nearest 1,000, never under 1,000', () => {
        const mk = (monthly) => ({ ok: true, typical: { income: 1 }, debt: { loans: [{ name: 'L', monthly, balance: 10 }] } });
        expect(pills(mk(62000))[0].text).toContain('LKR 16,000');
        expect(pills(mk(20000))[0].text).toContain('LKR 5,000');
        expect(pills(mk(1200))[0].text).toContain('LKR 1,000');
    });

    it('each one is read by the decision lab as the decision it names', () => {
        expect(readScenario(ps[0].ask)).toMatchObject({ kind: 'extra-payment', perMonth: 16000 });
        expect(readScenario(ps[1].ask)).toMatchObject({ kind: 'income-loss', percent: 30 });
    });

    it('and the Advisor then works the answer out in code', () => {
        const ctx = advisorPage();
        const HEAD = '=== WHAT-IF, WORKED OUT BY WEALTHFLOW';
        for (const p of ps.slice(0, 2)) expect(ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', p.ask), p.ask).toContain(HEAD);
        expect(ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', ps[0].ask)).toContain('Paying LKR 16,000 extra every month');
    });

    it('their figures are the owner\'s own (the 30% is the lab\'s test, not a claim about the books)', () => {
        const r = check(`${ps[0].text} ${ps[0].ask}`, [sheetOf(f), 'extra 16,000'], []);
        expect(r.unknown).toEqual([]);
    });

    it('skip a loan that cannot be paid down, a goal that is met, and a book with no balance', () => {
        const base = { ok: true, typical: { income: 100000 }, liquidity: { onHand: 5 } };
        expect(pills({ ...base, debt: { loans: [{ name: 'Bad', monthly: 5000, balance: 9, problem: 'payment-below-interest' }] } }).map((p) => p.text)).toEqual(['How long would my money last if my income fell 30%?']);
        expect(pills({ ...base, goals: [{ name: 'Done', status: 'complete', remaining: 0 }] }).some((p) => /Done/.test(p.text))).toBe(false);
        expect(pills({ ok: true, typical: { income: 100000 }, liquidity: { onHand: null } })).toEqual([]);
    });

    it('name the loan with the most owing, and a name is clipped and cleaned', () => {
        const g = { ok: true, typical: { income: 1 }, debt: { loans: [{ name: 'Small', monthly: 4000, balance: 10 }, { name: 'Big\u0000\n loan with a very long name indeed yes', monthly: 8000, balance: 99 }] } };
        const t = pills(g)[0].text;
        expect(t).toMatch(/^What if I pay LKR 2,000 extra a month on Big loan with a very lo/);
        expect(t).not.toMatch(/[\u0000-\u001f]/);
    });

    it('never offers more than asked for, or the same one twice', () => {
        expect(pills(f, { max: 1 })).toHaveLength(1);
        expect(new Set(ps.map((p) => p.text)).size).toBe(ps.length);
    });
});

describe('drawing the card', () => {
    const make = () => { const { document } = parseHTML('<html><body><div id="aiBriefing"></div></body></html>'); return { document, el: document.getElementById('aiBriefing') }; };
    const f = facts();
    const b = briefing(f);

    it('has the title bar, the figures and one line with an Ask button for each finding', () => {
        const { document, el } = make();
        const card = render(el, b, document);
        expect(card).toBe(el.firstChild);
        expect(el.querySelector('.ai-brief-title').textContent).toBe('Your books today');
        expect(el.querySelector('.ai-brief-sub').textContent).toBe('4 things worth a look');
        expect(el.querySelectorAll('.ai-brief-stat')).toHaveLength(b.stats.length);
        const rows = [...el.querySelectorAll('.ai-brief-item')];
        expect(rows).toHaveLength(b.items.length);
        rows.forEach((row, i) => {
            expect(row.className).toBe(`ai-brief-item ${b.items[i].tone}`);
            expect(row.querySelector('.ai-brief-item-t').textContent).toBe(b.items[i].title);
            expect(row.querySelector('.ai-brief-item-d').textContent).toBe(b.items[i].detail);
            const ask = row.querySelector('button.ai-brief-ask');
            expect(ask.getAttribute('data-q')).toBe(b.items[i].ask);
            expect(ask.getAttribute('type')).toBe('button');
        });
    });

    it('draws again in place: one card, never two', () => {
        const { document, el } = make();
        render(el, b, document);
        render(el, b, document);
        expect(el.querySelectorAll('.ai-brief')).toHaveLength(1);
    });

    it('folds from the title bar, tells the page, and says so to a screen reader', () => {
        const { document, el } = make();
        const seen = [];
        const card = render(el, b, document, { onToggle: (c) => seen.push(c) });
        const head = el.querySelector('.ai-brief-head');
        expect(head.getAttribute('aria-expanded')).toBe('true');
        head.click();
        expect(card.classList.contains('collapsed')).toBe(true);
        expect(head.getAttribute('aria-expanded')).toBe('false');
        head.click();
        expect(card.classList.contains('collapsed')).toBe(false);
        expect(head.getAttribute('aria-expanded')).toBe('true');
        expect(seen).toEqual([true, false]);
    });

    it('a page callback that throws does not break folding', () => {
        const { document, el } = make();
        const card = render(el, b, document, { onToggle: () => { throw new Error('boom'); } });
        expect(() => el.querySelector('.ai-brief-head').click()).not.toThrow();
        expect(card.classList.contains('collapsed')).toBe(true);
    });

    it('starts folded when asked', () => {
        const { document, el } = make();
        const card = render(el, b, document, { collapsed: true });
        expect(card.classList.contains('collapsed')).toBe(true);
        expect(el.querySelector('.ai-brief-head').getAttribute('aria-expanded')).toBe('false');
    });

    it('draws nothing, and clears what was there, when there is nothing to say', () => {
        const { document, el } = make();
        render(el, b, document);
        expect(render(el, briefing(null), document)).toBeNull();
        expect(el.childNodes).toHaveLength(0);
        expect(render(null, b, document)).toBeNull();
        expect(render(el, b, null)).toBeNull();
        expect(render(el, null, document)).toBeNull();
    });

    it('a name is text, never markup', () => {
        const evil = '<img src=x onerror="window.pwned=1"><b>x</b>';
        const g = { ok: true, asOf: '2026-10-03', typical: { income: 100, outflow: 50, living: 50, net: 50 }, liquidity: { onHand: 1 }, debt: { loans: [{ name: evil, monthly: 5000, balance: 9, problem: 'payment-below-interest' }] },
            goals: [{ name: evil, status: 'behind', remaining: 5, pacePerMonth: 1, neededPerMonth: 2, endsOn: '2027-01' }], categories: [{ name: evil, thisMonth: 9, avg3: 3, changePct: 200, spike: true }],
            flags: [{ id: 'loan-below-interest', severity: 'high', text: '' }, { id: `goal:${evil}`, severity: 'medium', text: '' }, { id: `spike:${evil}`, severity: 'medium', text: '' }] };
        const bb = briefing(g);
        expect(bb.items.map((i) => i.id)).toEqual(['loan-below-interest', `goal:${evil}`, `spike:${evil}`]);
        const { document, el } = make();
        render(el, bb, document);
        expect(el.querySelectorAll('img, b')).toHaveLength(0);
        expect(el.textContent).toContain(evil);
        expect(document.defaultView && document.defaultView.pwned).toBeUndefined();
        const asks = [...el.querySelectorAll('[data-q]')].map((n) => n.getAttribute('data-q'));
        expect(asks.every((a) => a.includes(evil))).toBe(true);
    });
});

/* ── the page: index.html's own functions over a real DOM ── */

const escSource = (() => { const i = html.indexOf('function _wfEsc('); return html.slice(i, html.indexOf('\n}\n', i) + 3); })();

function livePage({ data = household(), withModule = true, typed = '', stored = null, throwingStorage = false } = {}) {
    const { ctx } = page(data);
    const { document } = parseHTML('<html><body><div id="aiBriefing"></div><div id="aiSuggestionPills"></div><input id="aiChatInput"></body></html>');
    document.getElementById('aiChatInput').value = typed;
    const timers = [];
    const sent = [];
    const store = new Map(stored === null ? [] : [['wf_ai_brief_collapsed', stored]]);
    Object.assign(ctx, {
        document,
        $: (id) => document.getElementById(id),
        setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
        sendAIMessage: (q) => sent.push(q),
        localStorage: throwingStorage ? { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } : { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
    });
    if (withModule) ctx.WFAdvisorBriefing = briefingApi;
    vm.runInContext([escSource, source('_wfAdvisorFacts'), source('_wfRenderAdvisorBriefing'), source('initAISuggestionPills')].join('\n'), ctx);
    return { ctx, document, timers, sent, store };
}

describe('index.html draws the card', () => {
    it('puts it above the suggestion pills, with the module loaded after the page script', () => {
        expect(html.indexOf('id="aiBriefing"')).toBeGreaterThan(0);
        expect(html.indexOf('id="aiBriefing"')).toBeLessThan(html.indexOf('id="aiSuggestionPills"'));
        expect(html).toMatch(/<script type="module" src="wealthflow-advisor-briefing\.js"><\/script>/);
    });

    it('_initAIPage draws it before anything else', () => {
        expect(source('_initAIPage')).toMatch(/function _initAIPage\(\) \{\s*_wfRenderAdvisorBriefing\(\);\s*initAISuggestionPills\(\);/);
    });

    it('draws the real card from the real books', () => {
        const { ctx, document } = livePage();
        ctx._wfRenderAdvisorBriefing();
        const el = document.getElementById('aiBriefing');
        expect(el.querySelector('.ai-brief-item-t').textContent).toBe('Each month ends LKR 23,914 short after debts');
        expect(el.querySelector('.ai-brief').classList.contains('collapsed')).toBe(false);
    });

    it('remembers a fold, and starts folded next time', () => {
        const a = livePage();
        a.ctx._wfRenderAdvisorBriefing();
        a.document.querySelector('.ai-brief-head').click();
        expect(a.store.get('wf_ai_brief_collapsed')).toBe('1');
        const b = livePage({ stored: '1' });
        b.ctx._wfRenderAdvisorBriefing();
        expect(b.document.querySelector('.ai-brief').classList.contains('collapsed')).toBe(true);
        b.document.querySelector('.ai-brief-head').click();
        expect(b.store.get('wf_ai_brief_collapsed')).toBe('0');
    });

    it('works when the browser blocks storage', () => {
        const { ctx, document } = livePage({ throwingStorage: true });
        expect(() => ctx._wfRenderAdvisorBriefing()).not.toThrow();
        expect(() => document.querySelector('.ai-brief-head').click()).not.toThrow();
        expect(document.querySelector('.ai-brief')).not.toBeNull();
    });

    it('waits for a module that has not loaded yet, tries a bounded number of times, then draws the buttons again', () => {
        const { ctx, document, timers } = livePage({ withModule: false });
        ctx._wfRenderAdvisorBriefing();
        expect(document.querySelector('.ai-brief')).toBeNull();
        expect(timers).toHaveLength(1);
        ctx.WFAdvisorBriefing = briefingApi;
        ctx.initAISuggestionPills();                    // as the page would, once the module is there
        timers.shift().fn();
        expect(document.querySelector('.ai-brief')).not.toBeNull();
        expect(document.getElementById('aiSuggestionPills').textContent).toContain('What if I pay LKR 16,000 extra');
    });

    it('gives up after ten tries when the module never arrives', () => {
        const { ctx, timers } = livePage({ withModule: false });
        ctx._wfRenderAdvisorBriefing();
        let n = 0;
        while (timers.length && n < 50) { timers.shift().fn(); n++; }
        expect(n).toBe(10);
    });

    it('draws nothing, quietly, with no books', () => {
        const { ctx, document } = livePage({ data: EMPTY() });
        expect(() => ctx._wfRenderAdvisorBriefing()).not.toThrow();
        expect(document.querySelector('.ai-brief')).toBeNull();
    });

    it('a page without the container is left alone', () => {
        const { ctx, document } = livePage();
        document.getElementById('aiBriefing').remove();
        expect(() => ctx._wfRenderAdvisorBriefing()).not.toThrow();
    });
});

describe('index.html offers questions that name the owner\'s loan and goal', () => {
    const buttons = (document) => [...document.querySelectorAll('#aiSuggestionPills .ai-suggestion-pill')];

    it('puts them first, at most five buttons, and each sends what it asks', () => {
        const { ctx, document } = livePage();
        ctx.initAISuggestionPills();
        const bs = buttons(document);
        expect(bs.length).toBeGreaterThan(3);
        expect(bs.length).toBeLessThanOrEqual(5);
        expect(bs[0].textContent).toContain('What if I pay LKR 16,000 extra a month on Honda Vezel Loan?');
        expect(bs[0].getAttribute('data-q')).toBe('What if I pay LKR 16,000 extra a month on my Honda Vezel Loan?');
        expect(bs[1].getAttribute('data-q')).toBe('What if my income drops by 30%?');
        expect(bs.some((x) => /financial analysis|focus on this month|cash flow/i.test(x.textContent))).toBe(true);
    });

    it('a name that is markup is shown as text and cannot close the attribute', () => {
        const d = household();
        d.loans[0].name = '"><img src=x onerror=window.pwned=1> Loan';
        d.targets[0].name = 'Fund"><script>window.pwned=2</script>';
        const { ctx, document } = livePage({ data: d });
        ctx.initAISuggestionPills();
        const box = document.getElementById('aiSuggestionPills');
        expect(box.querySelectorAll('img, script')).toHaveLength(0);
        buttons(document).forEach((b) => expect(b.children).toHaveLength(0));
        const first = buttons(document)[0];
        expect(first.textContent).toContain('><img src=x');
        expect(first.getAttribute('data-q')).toContain('><img src=x onerror=window.pwned=1>');
        expect(ctx.pwned).toBeUndefined();
    });

    it('while typing, the suggestions follow what is typed and the old fixed ones are still escaped', () => {
        const { ctx, document } = livePage({ typed: 'loan' });
        ctx.initAISuggestionPills();
        const bs = buttons(document);
        expect(bs.map((x) => x.getAttribute('data-q'))).toContain('Help me with my loan strategy');
        expect(bs.some((x) => /What if I pay LKR 16,000/.test(x.textContent))).toBe(false);
    });

    it('without the module the old default questions are shown, as before', () => {
        const { ctx, document } = livePage({ withModule: false });
        expect(() => ctx.initAISuggestionPills()).not.toThrow();
        const q = buttons(document).map((x) => x.getAttribute('data-q'));
        expect(q).toEqual(['How healthy is my cash flow?', 'Help me with my loan strategy', 'Where can I cut expenses?', 'How to reach my savings goals faster?', 'Give me 3 investment tips for Sri Lanka']);
    });

    it('with no books the defaults are shown and nothing breaks', () => {
        const { ctx, document } = livePage({ data: EMPTY() });
        expect(() => ctx.initAISuggestionPills()).not.toThrow();
        expect(buttons(document).length).toBeGreaterThan(0);
        expect(buttons(document).some((x) => /What if I pay/.test(x.textContent))).toBe(false);
    });

    it('one tap sends one question: the container does not repeat what the document-level handler already sent', () => {
        const { ctx } = livePage();
        const listeners = [];
        const box = { innerHTML: '', addEventListener: (_t, fn) => listeners.push(fn), contains: () => true };
        ctx.$ = (id) => (id === 'aiSuggestionPills' ? box : id === 'aiChatInput' ? { value: '' } : null);
        ctx.initAISuggestionPills();
        expect(listeners).toHaveLength(1);
        const btn = { getAttribute: () => 'What if I pay extra?' };
        const tap = (defaultPrevented) => { const ev = { defaultPrevented, target: { closest: () => btn }, preventDefault() { this.defaultPrevented = true; } }; listeners[0](ev); return ev; };
        const sent = [];
        ctx.sendAIMessage = (q) => sent.push(q);
        tap(true);                                          // the document handler (capture phase) has already sent it
        expect(sent).toEqual([]);
        tap(false);                                         // no document handler: the container sends it, once
        expect(sent).toEqual(['What if I pay extra?']);
        // and the document handler itself is the one that prevents the default before it sends
        const doc = html.slice(html.indexOf('_wfPillGlobalBound = true'), html.indexOf('capture phase'));
        expect(doc.indexOf('ev.preventDefault()')).toBeGreaterThan(0);
        expect(doc.indexOf('ev.preventDefault()')).toBeLessThan(doc.indexOf('sendAIMessage(q)'));
    });

    it('the buttons cannot grow wider than the screen', () => {
        expect(html).toMatch(/\.ai-suggestion-pill \{\s*max-width: 100%; overflow: hidden; text-overflow: ellipsis;/);
    });
});

describe('the module registers itself the way the page expects', () => {
    it('exposes the API on window and as the default export', () => {
        expect(Object.keys(briefingApi).sort()).toEqual(['BRIEFING_VERSION', 'RULES', 'briefing', 'pills', 'render']);
        expect(briefingApi.briefing).toBe(briefing);
    });
});
