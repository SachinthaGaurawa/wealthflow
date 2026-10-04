import { describe, expect, it } from 'vitest';
import vm from 'node:vm';
import fc from 'fast-check';
import check, { figuresIn, groundingFrom, check as checkReply, correctionNote, revisionPrompt, verify, chipOf } from '../wealthflow-advisor-check.js';
import { renderFactSheet } from '../wealthflow-advisor-facts.js';
import { source, factsOf, page, household, advisorPage } from './helpers/advisor-page.js';

// THE ANSWER IS READ BACK AGAINST THE BOOKS.
//
// The Advisor is given the owner's figures and told to copy them. A model still sometimes writes one of its own: a salary it half-remembers, a sum it adds up wrongly,
// a rate it makes up. wealthflow-advisor-check.js finds every figure in the answer and looks for it in what the model was given. These tests hold that to a table of how
// figures are written (English, Sinhala, rounded, with multipliers), to the real sheet and the real worked block, to one retry that may only make things better, and to
// the wiring in index.html (sendAIMessage) run with stubs.

const kinds = (text, o) => figuresIn(text, o).map((f) => `${f.kind}:${f.value}`);

describe('finding the figures in an answer', () => {
    it.each([
        ['LKR 285,000', ['money:285000']],
        ['Rs. 58,171/=', ['money:58171']],
        ['රු. 214,500 ක්', ['money:214500']],
        ['LKR 2.5M', ['money:2500000']],
        ['2.5 million', ['money:2500000']],
        ['285k', ['money:285000']],
        ['25 lakh', ['money:2500000']],
        ['ලක්ෂ 25', ['money:2500000']],
        ['1.5 crore', ['money:15000000']],
        ['LKR -23,914 a month', ['money:23914']],
        ['21.8%', ['pct:21.8']],
        ['22 percent', ['pct:22']],
        ['36 months', ['span:36']],
        ['a 5-year loan', ['span:60']],
        ['මාස 36', ['span:36']],
        ['55 payments left', ['count:55']],
        ['an LKR 55,000 instalment', ['money:55000']],
        ['LKR 62,000 over 24 months at 14%', ['money:62000', 'span:24', 'pct:14']],
    ])('%s', (text, expected) => expect(kinds(text)).toEqual(expected));

    it.each([
        'on 2026-10-03', 'by 2026-10', 'in 2027', 'at 12:30', 'version v2.5', 'your 3 goals', 'the 2nd of the month', 'item 1. Rent', 'phone 0771234567x',
    ])('not a figure: %s', (text) => expect(kinds(text).filter((k) => !k.startsWith('plain'))).toEqual([]));

    it('a code block (a chart\'s JSON) and the follow-up list are not claims', () => {
        const t = 'Here it is.\n```chart\n{"data":[285000, 214500]}\n```\nFOLLOWUPS: ["What if 500,000?"]';
        expect(figuresIn(t)).toEqual([]);
        expect(figuresIn('```chart\n{"data":[285000')).toEqual([]);      // an unclosed block (a cut-off answer) too
    });
    it('a rounded figure carries its own tolerance: 2.5M stands for 2.45M-2.55M, 285k and 285,000 for 284,500-285,500, 285,431 for itself, and a round figure written in full digits never more than 1%', () => {
        const tol = (s) => figuresIn(s)[0].tol;
        expect(tol('LKR 2.5M')).toBe(50000);
        expect(tol('LKR 285,000')).toBe(500);
        expect(tol('LKR 285,431')).toBe(0.5);
        expect(tol('LKR 500,000')).toBeLessThanOrEqual(5000);            // never more than 1% of the figure
        expect(tol('LKR 100')).toBeLessThanOrEqual(1);
    });
    it('knows which sentence a figure is in, and whether that sentence calls itself an estimate', () => {
        const f = figuresIn('Your income is LKR 285,000. My estimate: about LKR 744,000 a year. Rent is LKR 75,000.');
        expect(f.map((x) => [x.value, x.estimate])).toEqual([[285000, false], [744000, true], [75000, false]]);
        expect(figuresIn('Roughly LKR 90,000.')[0].estimate).toBe(true);
        expect(figuresIn('≈ LKR 90,000')[0].estimate).toBe(true);
        expect(figuresIn('දළ වශයෙන් රු. 90,000')[0].estimate).toBe(true);
        expect(figuresIn('You paid about LKR 90,000.')[0].estimate).toBe(false);       // "about" is not a label
    });
    it('a figure is labelled as it was written, with its currency and unit', () => {
        expect(figuresIn('You are LKR 214,500 short, at 12.5% for 36 months, or 2.5M, 25 lakh, Rs. 90,000/=').map((f) => f.text)).toEqual(['LKR 214,500', '12.5%', '36 months', '2.5M', '25 lakh', 'Rs. 90,000/=']);
    });
    it('plain numbers are returned only when asked for (the owner\'s own words)', () => {
        expect(kinds('I earn 14 on top of 300,000')).toEqual(['money:300000']);
        expect(kinds('I earn 14 on top of 300,000', { plain: true })).toEqual(['plain:14', 'money:300000']);
    });
    it('never throws and never returns a non-finite figure, whatever the text', () => {
        fc.assert(fc.property(fc.fullUnicodeString({ maxLength: 200 }), (s) => { for (const f of figuresIn(s, { plain: true })) { expect(Number.isFinite(f.value)).toBe(true); expect(f.tol).toBeGreaterThan(0); } }), { numRuns: 400 });
        for (const v of [null, undefined, 0, {}, [], NaN]) expect(() => figuresIn(v)).not.toThrow();
    });
});

describe('reading an answer back against the real books', () => {
    const { ctx } = page(household());
    const f = factsOf(ctx);
    const sheet = renderFactSheet(f);
    const check1 = (reply, owner = []) => checkReply(reply, [sheet], owner);

    it('an answer that copies the sheet is fully matched', () => {
        const r = check1(`Your typical income is LKR 285,000 and about LKR 282,343 goes out each month, leaving LKR 2,657 (${f.typical.savingsRatePct}%). You hold LKR 640,000, which is ${f.liquidity.monthsOfCover} months of cover. The Honda Vezel Loan asks LKR 62,000 a month at 11%.`);
        expect(r.unknown).toEqual([]);
        expect(r.ok).toBe(true);
        expect(r.given).toBeGreaterThanOrEqual(6);
    });
    it('the figure the old Advisor made up (LKR 214,500 short a month) is caught', () => {
        const r = check1('You are LKR 214,500 a month short.');
        expect(r.unknown.map((u) => u.value)).toEqual([214500]);
        expect(r.ok).toBe(false);
    });
    it('a rounded figure matches the one it rounds, a wrong one does not', () => {
        expect(check1('You earn about 285k a month.').ok).toBe(true);
        expect(check1('You hold LKR 640,000, call it 0.64M.').ok).toBe(true);
        expect(check1('You earn about 300k a month.').ok).toBe(false);          // 5% off is a different figure, not a rounding
        expect(check1('You earn about 290k a month.').ok).toBe(false);
        expect(check1('You earn about 286k a month.').ok).toBe(false);
    });
    it('exact arithmetic on the owner\'s figures is accepted as worked out, wrong arithmetic is not', () => {
        const ok = check1('The loan costs LKR 744,000 a year, and rent plus the loan is LKR 137,000.');     // 62,000 x 12, 75,000 + 62,000
        expect(ok.unknown).toEqual([]);
        expect(ok.derived).toBe(2);
        expect(check1('The loan costs LKR 745,000 a year.').unknown.map((u) => u.value)).toEqual([745000]);
    });
    it('a sentence the model labels an estimate is counted as one and not as a claim about the books', () => {
        const r = check1('My estimate: your debts will cost about LKR 1,234,567 over the period.');
        expect(r.unknown).toEqual([]);
        expect(r.estimates).toBe(1);
    });
    it('a figure the owner typed is theirs; a figure only the model knows is not', () => {
        const mine = ['My salary will be 17.3% higher and I want to spend 1,111,111 on a trip'];
        expect(check1('A 17.3% rise helps; LKR 1,111,111 is your trip budget.', mine).ok).toBe(true);
        expect(check1('A 17.3% rise helps; LKR 1,111,111 is your trip budget.').unknown.length).toBe(2);
    });
    it('dates, years and list numbers are not figures to check', () => {
        expect(check1('1. In 2027-03 you reach the end of 2 goals on 2026-10-03 at 12:30.').checked).toBe(0);
    });
    it('a Sinhala answer is read the same way', () => {
        expect(check1('ඔබේ සාමාන්‍ය ආදායම රු. 285,000 යි.').ok).toBe(true);
        expect(check1('ඔබේ සාමාන්‍ය ආදායම රු. 214,500 යි.').ok).toBe(false);
    });
    it('the same figure written twice counts once', () => {
        const r = check1('LKR 285,000. Again, LKR 285,000.');
        expect(r.checked).toBe(1);
    });
    it('with nothing to check against it claims nothing either way', () => {
        const r = checkReply('You earn LKR 999,999.', [], []);
        expect(r).toMatchObject({ counted: false, ok: true, unknown: [] });
        expect(checkReply('You earn LKR 999,999.', ['no figures here'], []).counted).toBe(false);
    });
    it('every figure taken from the sheet itself is matched (property)', () => {
        const pool = groundingFrom([sheet]).money.filter((v) => v >= 1000);
        expect(pool.length).toBeGreaterThan(10);
        fc.assert(fc.property(fc.constantFrom(...pool), (v) => checkReply(`It is LKR ${Math.round(v).toLocaleString('en-US')}.`, [sheet]).unknown.length === 0), { numRuns: 120 });
    });
    it('figures that are nowhere near anything in the books are caught (fixed odd numbers)', () => {
        for (const v of [9876541, 7654321, 5432109, 3210987, 8765431]) expect(check1(`It is LKR ${v.toLocaleString('en-US')}.`).unknown.map((u) => u.value), String(v)).toEqual([v]);
    });
    it('never throws on any answer', () => {
        fc.assert(fc.property(fc.fullUnicodeString({ maxLength: 300 }), (s) => { expect(() => checkReply(s, [sheet], ['x'])).not.toThrow(); }), { numRuns: 200 });
        for (const v of [null, undefined, 0, {}, []]) expect(() => checkReply(v, [sheet])).not.toThrow();
    });
    it('is fast enough to run on every answer (a long answer against a full sheet)', () => {
        const long = Array.from({ length: 80 }, (_, i) => `Line ${i}: LKR ${(100000 + i * 7919).toLocaleString('en-US')} and ${i % 40}% over ${i % 36} months.`).join('\n');
        const t0 = Date.now();
        checkReply(long, [sheet]);
        expect(Date.now() - t0).toBeLessThan(1500);
    });
});

describe('the answer to a decision is read against the worked block', () => {
    const ctx = advisorPage();
    ctx.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'Can I buy a car for 2.5M?');
    const g = ctx._wfGrounding;
    it('the prompt left what it was built from, for exactly this turn', () => {
        expect(g.userText).toBe('Can I buy a car for 2.5M?');
        expect(g.parts.length).toBe(2);
        expect(g.parts[0]).toContain("THE OWNER'S BOOKS");
        expect(g.parts[1]).toContain('WHAT-IF, WORKED OUT BY WEALTHFLOW');
        expect(g.owner).toContain('Can I buy a car for 2.5M?');
    });
    it('an answer that copies the block is matched; one that invents an instalment is not', () => {
        const good = 'At 14% over 60 months the instalment would be LKR 58,171 a month, LKR 3,490,238 paid in all and LKR 990,238 of interest. That takes the debt ratio to 42.2%.';
        // 42.2% is the LKR 2.5M loan on top of the owner's existing debt: it is in the block when the loan is 2.5M
        const r = checkReply(good, g.parts, g.owner);
        expect(r.unknown.filter((u) => u.kind === 'money').map((u) => u.value)).toEqual([]);
        const bad = checkReply('At 14% over 60 months the instalment would be LKR 61,000 a month.', g.parts, g.owner);
        expect(bad.unknown.map((u) => u.value)).toEqual([61000]);
    });
    it('a turn without the books leaves no grounding behind (and clears the last one)', () => {
        const c = advisorPage();
        c.WealthFlowAIv6.adaptiveSystemPrompt('finance', 'how am I doing?');
        expect(c._wfGrounding).not.toBeNull();
        c.WealthFlowAIv6.adaptiveSystemPrompt('code', 'write a function');
        expect(c._wfGrounding).toBeNull();
        c.WealthFlowAIv6.adaptiveSystemPrompt('general', 'hello there');
        expect(c._wfGrounding).toBeNull();
    });
});

describe('asking again, once, and only when it makes the answer better', () => {
    const SHEET = "=== THE OWNER'S BOOKS ===\nTypical month: income LKR 285,000, outflow LKR 282,343, left LKR 2,657. Cash LKR 640,000.\nHonda loan: LKR 62,000 a month at 11%.\n=== END OF THE OWNER'S BOOKS ===";
    const g = (extra = {}) => ({ parts: [SHEET], owner: [], prompt: 'SYSTEM...\n--- CONVERSATION ---\nOwner: how am I doing?\n[REPLY NOW]\nAI:', ...extra });
    const GOOD = 'You earn LKR 285,000 and spend LKR 282,343, so LKR 2,657 is left. Cash is LKR 640,000.';
    const BAD = 'You earn LKR 285,000 and are LKR 214,500 short a month, with LKR 9,999,999 saved.';

    it('a good answer is left alone and nobody is asked anything', async () => {
        let asked = 0;
        const r = await verify(GOOD, g(), async () => { asked++; return GOOD; });
        expect(asked).toBe(0);
        expect(r).toMatchObject({ reply: GOOD, revised: false });
        expect(r.verdict.ok).toBe(true);
    });
    it('a bad answer is sent back once, with the conversation, the answer and the figures that are not theirs', async () => {
        const prompts = [];
        const r = await verify(BAD, g(), async (p) => { prompts.push(p); return GOOD; });
        expect(prompts.length).toBe(1);
        expect(prompts[0]).toContain('--- CONVERSATION ---');
        expect(prompts[0]).toContain(BAD);
        expect(prompts[0]).toContain('ACCURACY CHECK');
        expect(prompts[0]).toContain('214,500');
        expect(prompts[0]).toContain('9,999,999');
        expect(prompts[0]).not.toContain('285,000"');                       // only the figures that are NOT theirs are named
        expect(prompts[0].endsWith('AI:')).toBe(true);
        expect(r).toMatchObject({ reply: GOOD, revised: true });
        expect(r.verdict.ok).toBe(true);
        expect(r.before.unknown.length).toBe(2);
    });
    it('the new answer is used only if it has fewer figures that are not theirs', async () => {
        const same = await verify(BAD, g(), async () => 'You earn LKR 285,000 and are LKR 214,500 short a month, with LKR 9,999,999 saved. Sorry.');
        expect(same).toMatchObject({ reply: BAD, revised: false });
        const worse = await verify('You are LKR 214,500 short.', g(), async () => BAD);
        expect(worse).toMatchObject({ reply: 'You are LKR 214,500 short.', revised: false });
        const better = await verify(BAD, g(), async () => 'You earn LKR 285,000 and are LKR 214,500 short a month.');
        expect(better.revised).toBe(true);
        expect(better.verdict.unknown.length).toBe(1);
    });
    it('a failing, empty, silent or junk second try leaves the first answer, with what is wrong with it shown', async () => {
        for (const ask of [async () => { throw new Error('429'); }, async () => '', async () => null, async () => 'ok', () => new Promise(() => {}), 'not a function']) {
            const r = await verify(BAD, g(), ask, { timeoutMs: 30 });
            expect(r.reply).toBe(BAD);
            expect(r.revised).toBe(false);
            expect(r.verdict.unknown.length).toBe(2);
        }
    });
    it('the second answer has its follow-up list and heading marks stripped', async () => {
        const r = await verify(BAD, g(), async () => `## Summary\n${GOOD}\nFOLLOWUPS: ["a", "b"]`);
        expect(r.reply).toBe(`Summary\n${GOOD}`);
    });
    it('only a money figure or a percentage is worth a second try; a stray count or span is just shown', async () => {
        let asked = 0;
        const r = await verify('It will take 77 months and 31 payments.', g(), async () => { asked++; return GOOD; });
        expect(asked).toBe(0);
        expect(r.verdict.unknown.map((u) => u.kind).sort()).toEqual(['count', 'span']);
    });
    it('no books, no prompt, or no answer: nothing is checked and nothing is asked', async () => {
        let asked = 0;
        const ask = async () => { asked++; return GOOD; };
        for (const [reply, grounding] of [[BAD, null], [BAD, {}], [BAD, { parts: [] }], [BAD, g({ prompt: '' })], ['', g()], [null, g()], [undefined, g()], [BAD, { parts: ['no figures'], prompt: 'x' }]]) {
            const r = await verify(reply, grounding, ask);
            expect(r.revised).toBe(false);
        }
        expect(asked).toBe(0);
    });
    it('never throws, whatever it is given', async () => {
        for (const v of [[1, 2, 3], [{}, {}, {}], [BAD, { parts: 'x' }, 5], [Symbol.iterator.toString(), g(), async () => { throw 1; }]]) await expect(verify(...v)).resolves.toBeTruthy();
    });
    it('the correction note names at most eight figures and carries no quote that could break out', () => {
        const unknown = Array.from({ length: 12 }, (_, i) => ({ text: `LKR "${i}",000`, kind: 'money', value: i }));
        const n = correctionNote(unknown);
        expect(n.match(/"/g).length).toBe(16);                               // eight figures, two quotes each
        expect(n).toContain("it is not in their books");
        expect(revisionPrompt('A\nAI:', 'reply', unknown)).toMatch(/^A\nAI: reply\n\n\[ACCURACY CHECK/);
    });
});

describe('what the owner is told under the answer', () => {
    const verdict = (o) => ({ checked: 0, given: 0, derived: 0, estimates: 0, unknown: [], ok: true, counted: true, ...o });
    it('all figures from the books', () => {
        expect(chipOf({ verdict: verdict({ checked: 4, given: 4 }) })).toEqual({ tone: 'ok', text: 'Checked against your books: 4 figures.' });
        expect(chipOf({ verdict: verdict({ checked: 1, given: 1 }) }).text).toBe('Checked against your books: 1 figure.');
    });
    it('says what was worked out and what was labelled an estimate', () => {
        expect(chipOf({ verdict: verdict({ checked: 5, given: 3, derived: 1, estimates: 1 }) }).text).toBe('Checked against your books: 4 figures (1 worked out from them, 1 labelled as estimate).');
    });
    it('says it was corrected, when it was', () => {
        expect(chipOf({ revised: true, verdict: verdict({ checked: 2, given: 2 }) }).text).toMatch(/^Corrected once, then checked/);
    });
    it('a figure that is not theirs is said so, with the figure', () => {
        const c = chipOf({ verdict: verdict({ checked: 3, given: 2, unknown: [{ text: 'LKR 214,500', kind: 'money', value: 214500 }], ok: false }) });
        expect(c.tone).toBe('warn');
        expect(c.text).toBe("1 figure in this answer is not from your books (LKR 214,500). Treat it as the AI's own estimate.");
        const many = chipOf({ verdict: verdict({ unknown: Array.from({ length: 6 }, (_, i) => ({ text: `LKR ${i}`, kind: 'money', value: i })), ok: false }) });
        expect(many.text).toMatch(/^6 figures in this answer are not from your books \(LKR 0, LKR 1, LKR 2, LKR 3\)/);
    });
    it('nothing to say when nothing was checked', () => {
        for (const r of [null, undefined, {}, { verdict: null }, { verdict: verdict() }, { verdict: verdict({ counted: false }) }, { verdict: verdict({ checked: 2, estimates: 2 }) }]) expect(chipOf(r)).toBeNull();
    });
    it('is text only: a figure with markup in it cannot become markup', () => {
        const c = chipOf({ verdict: verdict({ unknown: [{ text: 'LKR <img src=x>', kind: 'money', value: 1 }], ok: false }) });
        expect(typeof c.text).toBe('string');                                // it goes in with textContent (see the page wiring test below)
    });
});

describe('the page: sendAIMessage reads the answer back and shows the chip', () => {
    /** The real _wfGroundReply, _wfAttachGroundingChip and sendAIMessage from index.html, run with stubs for everything around them. */
    function pageRun({ reply, grounding, askReply, history = [] }) {
        const events = [], shown = [], bubbleChildren = [];
        const win = { WFAdvisorCheck: check, _wfGrounding: null, _wfLastChatPrompt: '' };
        const makeEl = () => ({ className: '', textContent: '', innerHTML: '', children: [], appendChild(c) { this.children.push(c); } });
        const bubble = { appendChild: (c) => bubbleChildren.push(c), insertBefore: (c, anchor) => bubbleChildren.splice(bubbleChildren.indexOf(anchor), 0, c), querySelector: () => bubble.anchor || null };
        const ctx = {
            window: win, console, Date, JSON, String, Promise, Array,
            document: { querySelectorAll: () => [bubble], createElement: makeEl, getElementById: () => null },
            $: () => null, notify() {}, showPage() {}, autoResizeAIInput() {}, showAITyping: (on) => events.push(`typing:${on}`),
            appendAIMessage: (role, text, followups) => { events.push(`show:${role}`); shown.push({ role, text, followups }); },
            getAIHistory: () => history, saveAIHistory: (h) => { events.push('save'); },
            buildFinancialContext: () => ({ userName: 'Owner' }), getAIPersona: () => ({}), buildSystemPrompt: () => 'SYS',
            updateAIPersona() {}, _updateAIContextPills() {}, _ic: (n) => `<svg data-i="${n}"/>`, _lastAIProvider: null,
            callAI: async () => { events.push('callAI'); win._wfGrounding = grounding; win._wfLastChatPrompt = 'SYS\n--- CONVERSATION ---\nOwner: how am I doing?\nAI:'; return reply; },
            callAIRaw: async (p) => { events.push('callAIRaw'); ctx.__raw = p; if (askReply instanceof Error) throw askReply; return askReply; },
        };
        ctx.window.window = win;
        vm.createContext(ctx);
        vm.runInContext('var _lastAIProvider = null;', ctx);
        for (const n of ['_wfGroundReply', '_wfAttachGroundingChip', '_wfResearchFor', '_wfAttachSources', 'sendAIMessage']) vm.runInContext(source(n), ctx);
        return { ctx, events, shown, bubbleChildren, bubble, run: () => vm.runInContext('sendAIMessage', ctx)('how am I doing?') };
    }
    const SHEET = "=== THE OWNER'S BOOKS ===\nTypical month: income LKR 285,000, outflow LKR 282,343, left LKR 2,657. Cash LKR 640,000.\n=== END OF THE OWNER'S BOOKS ===";
    const GROUNDING = { userText: 'how am I doing?', parts: [SHEET], owner: ['how am I doing?'] };
    const GOOD = 'You earn LKR 285,000 and spend LKR 282,343, so LKR 2,657 is left. Cash is LKR 640,000.';
    const BAD = 'You earn LKR 285,000 but are LKR 214,500 short every month.';

    it('a faithful answer is shown as it came, with the green line under it', async () => {
        const t = pageRun({ reply: GOOD, grounding: GROUNDING });
        await t.run();
        expect(t.events).toEqual(expect.arrayContaining(['callAI', 'show:bot', 'typing:false']));
        expect(t.events).not.toContain('callAIRaw');
        expect(t.shown.find((s) => s.role === 'bot').text).toBe(GOOD);
        expect(t.bubbleChildren.length).toBe(1);
        expect(t.bubbleChildren[0].className).toBe('ai-grounding ok');
        expect(t.bubbleChildren[0].children[1].textContent).toMatch(/^Checked against your books: 4 figures/);
    });
    it('an answer with a figure that is not theirs is asked for again once, and the corrected one is shown', async () => {
        const t = pageRun({ reply: BAD, grounding: GROUNDING, askReply: GOOD });
        await t.run();
        expect(t.events.filter((e) => e === 'callAIRaw').length).toBe(1);
        expect(t.ctx.__raw).toContain('ACCURACY CHECK');
        expect(t.ctx.__raw).toContain('214,500');
        expect(t.shown.find((s) => s.role === 'bot').text).toBe(GOOD);
        expect(t.bubbleChildren[0].children[1].textContent).toMatch(/^Corrected once, then checked/);
    });
    it('when the second try fails the first answer is shown with a warning that names the figure', async () => {
        const t = pageRun({ reply: BAD, grounding: GROUNDING, askReply: new Error('429') });
        await t.run();
        expect(t.shown.find((s) => s.role === 'bot').text).toBe(BAD);
        expect(t.bubbleChildren[0].className).toBe('ai-grounding warn');
        expect(t.bubbleChildren[0].children[1].textContent).toContain('LKR 214,500');
        expect(t.events).not.toContain('typing:true-stuck');
        expect(t.events[t.events.length - 1]).toBe('typing:false');
    });
    it('the line goes under the answer and above the pills, the buttons and the time', async () => {
        const t = pageRun({ reply: GOOD, grounding: GROUNDING });
        const actions = { className: 'ai-msg-actions' };
        t.bubble.anchor = actions;
        t.bubbleChildren.push(actions);
        await t.run();
        expect(t.bubbleChildren.map((c) => c.className)).toEqual(['ai-grounding ok', 'ai-msg-actions']);
    });
    it('a turn that did not carry the books is not checked and gets no line', async () => {
        const t = pageRun({ reply: BAD, grounding: null });
        await t.run();
        expect(t.events).not.toContain('callAIRaw');
        expect(t.bubbleChildren.length).toBe(0);
        expect(t.shown.find((s) => s.role === 'bot').text).toBe(BAD);
    });
    it('books left over from another turn are not used for this answer', async () => {
        const t = pageRun({ reply: BAD, grounding: { ...GROUNDING, userText: 'something else' } });
        await t.run();
        expect(t.events).not.toContain('callAIRaw');
        expect(t.bubbleChildren.length).toBe(0);
    });
    it('the line is put in as text, never as markup', async () => {
        const t = pageRun({ reply: 'You earn LKR 285,000 and LKR <img src=x onerror=alert(1)> 9,999,999.', grounding: GROUNDING, askReply: new Error('x') });
        await t.run();
        const label = t.bubbleChildren[0].children[1];
        expect(label.innerHTML).toBe('');
        expect(label.textContent).toContain('9,999,999');
    });
});
