import { afterEach, describe, expect, it, vi } from 'vitest';
import handler, { resetProviderCooldowns } from '../api/ai.js';
import { itemwiseReading, unanimousDecision } from '../api/ai-matrix.mjs';
import { invokeBoard, classifySlice } from '../statement-sync.js';
import { ALLOWED_MODULES, CARD_ONLY, INCOME_NAMES, INCOME_ONLY, PROPOSAL, REVIEW, agreedRows, approvedRows, decisionProblem, inVocabulary, reviewPrompt } from '../statement-board.mjs';
import { CLASSIFY_CATEGORIES, incomeCategoryFor } from '../wealthflow-statement-router.js';

/* THE UNIT OF A FINANCIAL DECISION IS A ROW.
 * The statement board used to need its WHOLE answer — up to ten rows — to be identical across every provider: one provider judging one row
 * differently sent all ten back to the rules (production 2026-10-03: five of sixteen boards refused with six or seven providers answering).
 * A row is now released when every valid voter said the same thing about THAT row, and not otherwise. This file holds the rule from the
 * matrix up to the filed record, and shows by simulation what it buys and that it buys it at the same per-row bar. */

afterEach(() => { resetProviderCooldowns(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const names = ['Gemini', 'DeepSeek', 'Groq', 'Mistral', 'Together', 'Fireworks', 'OpenRouterFinance', 'OpenRouterQwen'];
const decisionRow = (index, category = 'Shopping', module = 'expenses') => ({ index, module, category, allocationId: '' });
const live = (name, value) => ({ name, ok: true, reply: JSON.stringify(value) });
const batch = (n, change = {}) => ({ decisions: Array.from({ length: n }, (_, i) => (change[i] ? { ...decisionRow(i), ...change[i] } : decisionRow(i))) });

describe('the rows every voter agreed on (itemwiseReading)', () => {
    const entries = (values) => values.map((value, at) => ({ name: names[at], value }));

    it('one voter judging one row differently holds back that row and no other', () => {
        const values = names.map((_, at) => (at === 2 ? batch(10, { 4: { category: 'Dining' } }) : batch(10)));
        const read = itemwiseReading(entries(values), { path: 'decisions' });
        expect(read.disputed).toEqual([4]);
        expect(read.agreed.map(a => a.id)).toEqual([0, 1, 2, 3, 5, 6, 7, 8, 9]);
        expect(read.vetoed).toBe(false);
        expect(read.voters).toEqual(names);
    });

    it('a row is agreed only when EVERY voter said exactly the same thing: a different value, a different type, an extra key all dispute it', () => {
        for (const odd of [{ category: 'dining' }, { module: 'cconetime' }, { allocationId: 's1' }, { why: 'because' }]) {
            const values = names.map((_, at) => (at === 0 ? batch(3, { 1: odd }) : batch(3)));
            expect(itemwiseReading(entries(values), { path: 'decisions' }).disputed, JSON.stringify(odd)).toEqual([1]);
        }
        // 1 vs "1": the same number is not the same typed value
        const typed = names.map((_, at) => (at === 0 ? { decisions: [{ ...decisionRow(0), index: '0' }] } : { decisions: [decisionRow(0)] }));
        expect(itemwiseReading(entries(typed), { path: 'decisions' }).agreed).toEqual([]);
    });

    it('a voter that leaves a row out DISSENTS on it: silence never lets the others through', () => {
        const values = names.map((_, at) => (at === 5 ? { decisions: batch(10).decisions.slice(0, 9) } : batch(10)));
        const read = itemwiseReading(entries(values), { path: 'decisions' });
        expect(read.disputed).toEqual([9]);
        expect(read.agreed).toHaveLength(9);
    });

    it('key order does not matter, row order does not matter', () => {
        const flipped = { decisions: [...batch(4).decisions].reverse().map(d => ({ allocationId: d.allocationId, category: d.category, module: d.module, index: d.index })) };
        const read = itemwiseReading(entries(names.map((_, at) => (at === 1 ? flipped : batch(4)))), { path: 'decisions' });
        expect(read.agreed.map(a => a.id)).toEqual([0, 1, 2, 3]);
        expect(read.disputed).toEqual([]);
    });

    it('an answer that is not a list of rows is a dissent against the whole batch (a refusal in a shape of its own), as it always was', () => {
        for (const odd of [{ approved: false }, { verdict: 'reject' }, { decisions: [], approved: false }, { decisions: 'none' }, { decisions: batch(3).decisions, note: 'x' }, { decisions: [decisionRow(0), decisionRow(0)] }]) {
            const values = names.map((_, at) => (at === 3 ? odd : batch(3)));
            const read = itemwiseReading(entries(values), { path: 'decisions' });
            expect(read.vetoed, JSON.stringify(odd)).toBe(true);
            expect(read.agreed).toEqual([]);
        }
    });

    it('only a MANGLED answer (the key torn by the model) is set aside, not counted either way', () => {
        const values = names.map((_, at) => (at === 4 ? { 'decisions [{': 0, module: 'expenses' } : batch(3)));
        const read = itemwiseReading(entries(values), { path: 'decisions' });
        expect(read.mangled).toEqual(['Together']);
        expect(read.vetoed).toBe(false);
        expect(read.agreed).toHaveLength(3);
        expect(read.voters).toHaveLength(7);
        // words of its own are not a torn key
        const words = names.map((_, at) => (at === 4 ? { decisions_rejected: 1 } : batch(3)));
        expect(itemwiseReading(entries(words), { path: 'decisions' }).vetoed).toBe(true);
    });

    it('fewer than five valid voters release nothing, however well they agree', () => {
        const four = entries(names.slice(0, 4).map(() => batch(3)));
        expect(itemwiseReading(four, { path: 'decisions' })).toMatchObject({ agreed: [], reason: 'too_few_voters' });
        expect(itemwiseReading(entries(names.slice(0, 5).map(() => batch(3))), { path: 'decisions' }).agreed).toHaveLength(3);
    });

    it('a bad specification or hostile input never throws and never releases', () => {
        for (const spec of [undefined, {}, { path: '' }, { path: 5 }, { path: 'decisions', id: 5 }]) expect(itemwiseReading(entries(names.map(() => batch(2))), spec).agreed).toEqual([]);
        for (const hostile of [null, undefined, 5, 'x', [], [null], [{ value: null }], [{ name: 'a', value: [1] }]]) expect(() => itemwiseReading(hostile, { path: 'decisions' })).not.toThrow();
        expect(itemwiseReading([{ name: 'a', value: { decisions: [null] } }], { path: 'decisions' }).agreed).toEqual([]);
        const huge = { decisions: Array.from({ length: 501 }, (_, i) => decisionRow(i)) };
        expect(itemwiseReading(entries(names.map(() => huge)), { path: 'decisions' }).agreed).toEqual([]);
    });
});

describe('the board\'s own decision is unchanged, and says which rows were agreed when asked', () => {
    const results = (values) => values.map((value, at) => live(names[at], value));
    const decide = (values, extra = {}) => unanimousDecision(results(values), { task: 'extraction', expected: names, minimumProviders: 5, allowUnavailable: true, ...extra });

    it('without the option there is no `items` and nothing else differs', () => {
        const values = names.map((_, at) => (at === 2 ? batch(10, { 4: { category: 'Dining' } }) : batch(10)));
        const plain = decide(values), asked = decide(values, { itemwise: PROPOSAL });
        expect(plain.items).toBeUndefined();
        const { items, ...rest } = asked;
        expect(rest).toEqual(plain);
        expect(plain).toMatchObject({ unanimous: false, reason: 'provider_disagreement', reply: null, fields: null });
        expect(items.disputed).toEqual([4]);
    });

    it('a whole answer that agrees is unanimous as before, and every row of it is agreed', () => {
        const decision = decide(names.map(() => batch(10)), { itemwise: PROPOSAL });
        expect(decision.unanimous).toBe(true);
        expect(decision.items.agreed).toHaveLength(10);
        expect(decision.items.disputed).toEqual([]);
        expect(decision.fields).toEqual(batch(10));
    });

    it('a quorum is needed: with four voters nothing is read by row', () => {
        const values = names.slice(0, 4).map(() => batch(3));
        const decision = unanimousDecision(results(values), { task: 'extraction', expected: names.slice(0, 4), minimumProviders: 5, allowUnavailable: true, itemwise: PROPOSAL });
        expect(decision.items).toBeUndefined();
    });

    it('a non-list unanimous answer (the old yes/no review) is the answer, not a veto', () => {
        const decision = decide(names.map(() => ({ approved: true })), { itemwise: PROPOSAL });
        expect(decision.unanimous).toBe(true);
        expect(decision.items).toMatchObject({ vetoed: false, reason: 'not_a_list', agreed: [] });
    });
});

/* ── the endpoint, with real providers' wire shapes and a stubbed network ─────────────────────────────────────────────── */
function stubProviders(answerFor) {
    for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'CEREBRAS_API_KEY']) vi.stubEnv(key, 'test');
    const asked = [];
    vi.stubGlobal('fetch', vi.fn(async (url, init) => {
        const who = ['googleapis', 'deepseek', 'groq', 'mistral', 'together', 'fireworks', 'openrouter', 'cerebras'].find(k => String(url).includes(k)) || 'other';
        let model = ''; try { model = JSON.parse(init.body).model || ''; } catch (_) { /* gemini carries it in the url */ }
        asked.push(who);
        const text = answerFor(who, model, init);
        if (text instanceof Error) throw text;
        return { ok: true, json: async () => (who === 'googleapis' ? { candidates: [{ content: { parts: [{ text }] } }] } : { choices: [{ message: { content: text } }] }) };
    }));
    return asked;
}
const response = () => ({ setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } });
const ask = async (body) => { const res = response(); await handler({ method: 'POST', body: { prompt: 'Return only JSON. Classify each row.', financialDecision: true, mode: 'unanimous', temperature: 0, deadlineMs: 4000, ...body } }, res); return res; };

describe('the endpoint, with ten providers and one disagreeing row', () => {
    it('refuses the batch (422, unchanged) and ALSO says which rows all ten agreed on, when asked', async () => {
        stubProviders((who) => JSON.stringify(batch(10, who === 'groq' ? { 6: { category: 'Dining' } } : {})));
        const asked = await ask({ itemwise: { path: 'decisions', id: 'index' } });
        expect(asked.code).toBe(422);
        expect(asked.body).toMatchObject({ unanimous: false, reason: 'provider_disagreement', reply: null, fields: null, needsReview: true });
        expect(asked.body.items.disputed).toEqual([6]);
        expect(asked.body.items.agreed.map(a => a.id)).toEqual([0, 1, 2, 3, 4, 5, 7, 8, 9]);
        expect(asked.body.items.voters).toHaveLength(10);
        // a caller that does not ask gets exactly what it always got
        const plain = await ask({});
        expect(plain.code).toBe(422);
        expect(plain.body.items).toBeUndefined();
    });

    it('ignores a hostile specification', async () => {
        stubProviders(() => JSON.stringify(batch(3)));
        for (const itemwise of ['decisions', 5, { path: '__proto__x y' }, { path: 'decisions', id: 'a b' }, { path: 'a'.repeat(40) }, null]) {
            const res = await ask({ itemwise });
            expect(res.code, JSON.stringify(itemwise)).toBe(200);
            expect(res.body.items).toBeUndefined();
        }
    });

    it('a row nobody disagrees on and a whole answer that agrees: 200, as before', async () => {
        stubProviders(() => JSON.stringify(batch(10)));
        const res = await ask({ itemwise: PROPOSAL });
        expect(res.code).toBe(200);
        expect(res.body.unanimous).toBe(true);
        expect(res.body.items.agreed).toHaveLength(10);
    });
});

/* ── invokeBoard: the caller gets the agreed rows only on a disagreement, never on an outage ──────────────────────────── */
describe('invokeBoard', () => {
    const roster = names.map((_, i) => 'e' + i);
    const reply = (status, body) => async (_, res) => res.status(status).json(body);
    const items = (agreed, disputed = [], extra = {}) => ({ agreed: agreed.map(id => ({ id, value: decisionRow(id) })), disputed, voters: roster.slice(0, 7), vetoed: false, reason: null, ...extra });
    const disputed = (extra = {}) => ({ unanimous: false, reason: 'provider_disagreement', expected: roster, fields: null, items: items([0, 1, 3], [2]), ...extra });

    it('returns the agreed rows of a disputed batch, marked partial, only when asked', async () => {
        const out = await invokeBoard('Return only JSON.', reply(422, disputed()), { itemwise: PROPOSAL });
        expect(out.partial).toBe(true);
        expect(out.items.agreed.map(a => a.id)).toEqual([0, 1, 3]);
        await expect(invokeBoard('Return only JSON.', reply(422, disputed()))).rejects.toThrow('ai-consensus-unavailable');
    });

    it('is still an error for an outage, an invalid roster, a veto, too few voters or no agreed row', async () => {
        const cases = [
            disputed({ reason: 'provider_unavailable' }), disputed({ reason: 'insufficient_or_invalid_roster' }), disputed({ reason: 'invalid_response' }),
            disputed({ items: items([0], [], { vetoed: true }) }), disputed({ items: items([0], [], { voters: roster.slice(0, 4) }) }),
            disputed({ items: items([], [0, 1]) }), disputed({ expected: roster.slice(0, 4) }), disputed({ expected: [...roster.slice(0, 4), roster[0]] }), disputed({ items: undefined }),
        ];
        for (const body of cases) await expect(invokeBoard('Return only JSON.', reply(422, body), { itemwise: PROPOSAL })).rejects.toThrow('ai-consensus-unavailable');
        await expect(invokeBoard('Return only JSON.', reply(503, disputed()), { itemwise: PROPOSAL })).rejects.toThrow('ai-consensus-unavailable');
    });

    it('marks an outage as an outage and a disagreement as a disagreement, as before', async () => {
        const outage = await invokeBoard('x', reply(422, { unanimous: false, reason: 'provider_unavailable', expected: roster }), { itemwise: PROPOSAL }).catch(e => e);
        expect(outage.outage).toBe(true);
        const split = await invokeBoard('x', reply(422, disputed({ items: items([], [0]) })), { itemwise: PROPOSAL }).catch(e => e);
        expect(split.outage).toBe(false);
    });
});

/* ── the decision is believed only inside the closed world ───────────────────────────────────────────────────────────── */
describe('what a unanimous board may not say (decisionProblem)', () => {
    const subs = { subscriptions: [{ id: 's1' }, { id: 's2' }, { id: 's2' }] };
    const d = (module, category, allocationId = '', index = 0) => ({ index, module, category, allocationId });

    it('accepts what the prompt asks for', () => {
        for (const ok of [d('expenses', 'Groceries'), d('expenses', 'Rent'), d('expenses', 'Gift'), d('expenses', 'Other'), d('incomeRecv', 'Salary'), d('incomeRecv', 'Rent'), d('incomeRecv', 'Other'), d('incomeRecv', 'Income'),
            d('cconetime', 'Card Purchase'), d('cconetime', 'Fuel'), d('cconetime', 'Cash Advance'), d('ccinstall', 'Card Purchase'), d('ccPayments', 'Card Payment'), d('review', 'Needs Review'), d('subscriptions', 'Entertainment', 's1'), d('loan', 'Other', 'l1'), d('goal', 'Other', 'g1')]) {
            expect(decisionProblem(ok, 0, subs), JSON.stringify(ok)).toBeNull();
        }
    });
    it('refuses a module the prompt does not allow, a category that is not in the list, and a row that is not this one', () => {
        expect(decisionProblem(d('skip', 'Transfer'), 0)).toBe('module-not-allowed');
        expect(decisionProblem(d('expenses', 'Dining out'), 0)).toBe('category-not-in-list');
        expect(decisionProblem(d('expenses', 'Needs Review'), 0)).toBe('category-not-in-list');
        expect(decisionProblem(d('expenses', 'groceries'), 0)).toBe('category-not-in-list');
        expect(decisionProblem(d('expenses', 'Groceries', '', 3), 0)).toBe('wrong-row');
        expect(decisionProblem({ index: 0, module: 'expenses', category: 5, allocationId: '' }, 0)).toBe('malformed');
        for (const hostile of [null, undefined, 5, 'x', [], {}]) expect(decisionProblem(hostile, 0)).not.toBeNull();
    });
    it('refuses a category of the wrong kind of record: income for a payment, a payment for income, card words on a bank row', () => {
        expect(decisionProblem(d('expenses', 'Salary'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('expenses', 'Refund'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('expenses', 'Card Purchase'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('incomeRecv', 'Groceries'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('cconetime', 'Salary'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('cconetime', 'Card Payment'), 0)).toBe('category-of-another-kind');
        expect(decisionProblem(d('ccPayments', 'Groceries'), 0)).toBe('category-of-another-kind');
    });
    it('refuses an allocation that does not exist, is ambiguous, or sits on a row that has none', () => {
        expect(decisionProblem(d('subscriptions', 'Entertainment', 'nope'), 0, subs)).toBe('allocation-does-not-exist');
        expect(decisionProblem(d('subscriptions', 'Entertainment', ''), 0, subs)).toBe('allocation-does-not-exist');
        expect(decisionProblem(d('subscriptions', 'Entertainment', 's2'), 0, subs)).toBe('allocation-does-not-exist');
        expect(decisionProblem(d('subscriptions', 'Entertainment', 's1'), 0, {})).toBe('allocation-does-not-exist');
        expect(decisionProblem(d('expenses', 'Groceries', 's1'), 0, subs)).toBe('allocation-on-a-row-that-has-none');
        expect(decisionProblem(d('incomeRecv', 'Salary', 'g1'), 0)).toBe('allocation-on-a-row-that-has-none');
    });

    it('is held to the router\'s own tables: every category the rules can give is in the vocabulary, and the families do not drift', () => {
        const sampleIncome = ['salary', 'interest credited', 'dividend', 'rent received', 'invoice payment', 'pension', 'gift', 'refund', 'something else'];
        for (const text of sampleIncome) expect(INCOME_NAMES, text).toContain(incomeCategoryFor({ narration: text }) === 'Other' ? 'Rent' : incomeCategoryFor({ narration: text }));
        for (const category of CLASSIFY_CATEGORIES) expect(inVocabulary(category)).toBe(true);
        // an income name the router offers that this module does not know would be mistaken for an expense category
        const unknown = CLASSIFY_CATEGORIES.filter(c => !CARD_ONLY.includes(c) && !INCOME_NAMES.includes(c) && !['Needs Review', 'Other'].includes(c));
        expect(unknown.length).toBeGreaterThan(10);
        for (const category of ['Salary', 'Interest', 'Dividend', 'Rent', 'Business', 'Pension', 'Gift', 'Refund']) expect(CLASSIFY_CATEGORIES).toContain(category);
        for (const category of INCOME_ONLY.filter(c => c !== 'Income')) expect(CLASSIFY_CATEGORIES).toContain(category);
        for (const category of CARD_ONLY) expect(CLASSIFY_CATEGORIES).toContain(category);
        expect(unknown).not.toContain('Salary');
        for (const module of ALLOWED_MODULES) expect(typeof module).toBe('string');
        expect(ALLOWED_MODULES).not.toContain('skip');
    });
});

describe('reading an answer', () => {
    const roster = names.map((_, i) => 'e' + i);
    it('a whole answer that agreed is every one of its rows; an answer with nothing agreed or unreadable is nothing', () => {
        expect([...agreedRows({ unanimous: true, fields: batch(3) }, PROPOSAL).keys()]).toEqual([0, 1, 2]);
        expect(agreedRows({ unanimous: false, fields: batch(3) }, PROPOSAL)).toBeNull();
        expect(agreedRows({ unanimous: true, fields: { decisions: [decisionRow(0), decisionRow(0)] } }, PROPOSAL)).toBeNull();
        expect(agreedRows(null, PROPOSAL)).toBeNull();
        expect(agreedRows({ unanimous: true, fields: { approved: true } }, PROPOSAL)).toBeNull();
        expect(agreedRows({ items: { agreed: [{ id: 0, value: decisionRow(0) }], voters: roster.slice(0, 4) } }, PROPOSAL).size).toBe(0);
        expect([...agreedRows({ items: { agreed: [{ id: 2, value: decisionRow(2) }], voters: roster } }, PROPOSAL).keys()]).toEqual([2]);
    });
    it('a review approves a row only when every reviewer gave exactly {index, approved:true} for it', () => {
        const review = (reviews) => ({ items: { agreed: reviews.map(value => ({ id: value.index, value })), voters: roster } });
        expect([...approvedRows(review([{ index: 0, approved: true }, { index: 1, approved: false }, { index: 2, approved: 'true' }, { index: 3, approved: true, why: 'x' }]))]).toEqual([0]);
        expect(approvedRows(null).size).toBe(0);
        expect(approvedRows({ unanimous: true, fields: { approved: true } }).size).toBe(0);
        expect([...approvedRows({ unanimous: true, fields: { reviews: [{ index: 4, approved: true }] } })]).toEqual([4]);
    });
    it('the review question carries only the rows being reviewed, with their own indexes', () => {
        const prompt = reviewPrompt({ evidence: [{ index: 3, description: 'X' }], allocations: {}, decisions: [decisionRow(3)] });
        expect(prompt.startsWith('Return only JSON. Independently')).toBe(true);
        expect(JSON.parse(prompt.slice(prompt.indexOf('Evidence: ') + 10)).decisions.map(d => d.index)).toEqual([3]);
        expect(prompt).toContain('{"reviews":[{"index":0,"approved":true}]}');
    });
    it('the question and the shapes it asks for are the ones the board reads', () => {
        expect(PROPOSAL).toEqual({ path: 'decisions', id: 'index' });
        expect(REVIEW).toEqual({ path: 'reviews', id: 'index' });
    });
});

/* ── the whole flow: ten rows, real endpoint code, stubbed network ───────────────────────────────────────────────────── */
const bank = { statementType: 'bank_account', card_last4: '', subscriptions: [] };
const unknownRow = (i) => ({ date: '2026-09-14', narration: `ZZYX TRADERS ${i}`, amount: 100 + i, direction: 'debit', directionSource: 'column', needsReview: false });
const rowsSent = (init) => { const prompt = JSON.parse(init.body).messages?.[0]?.content; return prompt; };

describe('ten rows through the real board code', () => {
    // each provider answers every row 'Shopping', except as `odd` says; the review approves every row, except as `refuse` says
    const world = ({ odd = () => null, refuse = () => false } = {}) => stubProviders((who, model, init) => {
        const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
        const text = String(body.messages ? body.messages.map(m => m.content).join('\n') : body.contents ? body.contents.map(c => c.parts.map(p => p.text).join('')).join('\n') : '');
        if (text.includes('Independently peer-review')) {
            const decisions = JSON.parse(text.slice(text.indexOf('Evidence: ') + 10)).decisions;
            return JSON.stringify({ reviews: decisions.map(d => ({ index: d.index, approved: !refuse(who, d.index) })) });
        }
        const sent = JSON.parse(text.slice(text.indexOf('Transactions: ') + 14));
        return JSON.stringify({ decisions: sent.map(t => ({ index: t.index, module: 'expenses', category: odd(who, t.index) || 'Shopping', allocationId: '' })) });
    });

    it('before the change nothing would be released: with one provider disagreeing about row 4 all ten rows kept the rules\' "Other"; now nine are refined', async () => {
        world({ odd: (who, index) => (who === 'groq' && index === 4 ? 'Dining' : null) });
        const rows = Array.from({ length: 10 }, (_, i) => unknownRow(i));
        const out = await classifySlice(rows, bank);
        expect(out.filter(d => d.category === 'Shopping')).toHaveLength(9);
        expect(out[4]).toMatchObject({ module: 'expenses', category: 'Other', verified: true, autoDecided: 'rules' });
        expect(out.map(d => d.verified)).toEqual(Array(10).fill(true));
        // the dissenting provider's category was NOT filed for the row it disputed
        expect(out.some(d => d.category === 'Dining')).toBe(false);
    });

    it('a review that refuses one row refuses that row only', async () => {
        world({ refuse: (who, index) => who === 'mistral' && index === 7 });
        const out = await classifySlice(Array.from({ length: 10 }, (_, i) => unknownRow(i)), bank);
        expect(out.filter(d => d.category === 'Shopping')).toHaveLength(9);
        expect(out[7]).toMatchObject({ category: 'Other', autoDecided: 'rules' });
    });

    it('several rows disputed in the proposal and one more in the review: the others are filed, each only with every voter\'s agreement', async () => {
        world({ odd: (who, index) => (index === 1 && who === 'groq' ? 'Dining' : index === 2 && who === 'gemini' ? 'Health' : index === 2 && who === 'deepseek' ? 'Fuel' : null), refuse: (who, index) => index === 8 && who === 'cerebras' });
        const out = await classifySlice(Array.from({ length: 10 }, (_, i) => unknownRow(i)), bank);
        const refined = out.map((d, i) => (d.category === 'Shopping' ? i : -1)).filter(i => i >= 0);
        expect(refined).toEqual([0, 3, 4, 5, 6, 7, 9]);
        for (const i of [1, 2, 8]) expect(out[i]).toMatchObject({ category: 'Other', autoDecided: 'rules' });
    });

    it('a provider that answers a refusal in a shape of its own vetoes the whole slice, as it always did: the rules answer, nothing is released', async () => {
        stubProviders((who) => (who === 'groq' ? JSON.stringify({ approved: false }) : JSON.stringify({ decisions: [{ index: 0, module: 'expenses', category: 'Shopping', allocationId: '' }] })));
        const out = await classifySlice([unknownRow(0), unknownRow(1)], bank);
        expect(out.map(d => d.category)).toEqual(['Other', 'Other']);
    });

    it('every provider agreeing on something outside the closed world is not believed: a payment is not "Salary", a made-up category is not a category', async () => {
        for (const category of ['Salary', 'Dining out', 'Card Purchase']) {
            world({ odd: () => category });
            const out = await classifySlice([unknownRow(0), unknownRow(1)], bank);
            expect(out.map(d => d.category), category).toEqual(['Other', 'Other']);
            resetProviderCooldowns(); vi.unstubAllGlobals();
        }
    });

    it('a board that cannot reach five voters changes nothing: the rules answer (no row is released on fewer)', async () => {
        for (const key of ['GEMINI_API_KEY', 'GROQ_API_KEY', 'DEEPSEEK_API_KEY']) vi.stubEnv(key, 'test');
        vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => (String(url).includes('googleapis') ? { candidates: [{ content: { parts: [{ text: JSON.stringify(batch(2)) }] } }] } : { choices: [{ message: { content: JSON.stringify(batch(2)) } }] }) })));
        const out = await classifySlice([unknownRow(0), unknownRow(1)], bank);
        expect(out.map(d => d.category)).toEqual(['Other', 'Other']);
    });
});

/* ── what it buys, by simulation, and that it never buys it with a lower bar ────────────────────────────────────────── */
function rng(seed) { let s = seed >>> 0; return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

describe('simulation: seven voters, ten rows a slice', () => {
    const voters = names.slice(0, 7);
    const trial = (random, p, rows = 10) => {
        // every voter names the row's right category with probability p, else one of three wrong ones
        const truth = Array.from({ length: rows }, () => 'Shopping');
        const values = voters.map(() => ({ decisions: truth.map((c, index) => ({ index, module: 'expenses', category: random() < p ? c : ['Dining', 'Health', 'Fuel'][Math.floor(random() * 3)], allocationId: '' })) }));
        const results = values.map((v, at) => live(voters[at], v));
        const whole = unanimousDecision(results, { task: 'extraction', expected: voters, minimumProviders: 5, allowUnavailable: true, itemwise: PROPOSAL });
        return { values, whole };
    };

    it.each([0.95, 0.98, 0.99])('with each voter right %s of the time, rows released per slice rise and no released row is anything but unanimous', (p) => {
        const random = rng(20261003 + Math.round(p * 1000));
        let rowsOld = 0, rowsNew = 0, wrongNew = 0, slices = 2000;
        for (let n = 0; n < slices; n++) {
            const { values, whole } = trial(random, p);
            if (whole.unanimous) rowsOld += 10;
            const released = whole.unanimous ? whole.items.agreed : whole.items.agreed;
            rowsNew += released.length;
            for (const { id, value } of released) {
                // the safety property: every voter said exactly this about this row
                for (const v of values) expect(JSON.stringify(v.decisions[id])).toBe(JSON.stringify(value));
                if (value.category !== 'Shopping') wrongNew += 1;
            }
            // and what the old rule released is released by the new one too
            if (whole.unanimous) expect(released).toHaveLength(10);
        }
        expect(rowsNew).toBeGreaterThanOrEqual(rowsOld);
        const perRow = Math.pow(p, 7);
        // a row is released when all seven are right (or all seven are wrong in the same way, which is rare and no more likely than before)
        expect(rowsNew / (slices * 10)).toBeGreaterThan(perRow - 0.03);
        expect(rowsOld / (slices * 10)).toBeLessThan(Math.pow(perRow, 10) + 0.05);
        // an error released is every voter being wrong in the SAME way, which the old rule released as well
        expect(wrongNew / Math.max(1, rowsNew)).toBeLessThan(0.001);
        console.log(`p=${p}: rows released per slice of ten: old ${(rowsOld / slices).toFixed(2)}, new ${(rowsNew / slices).toFixed(2)}; released rows that were wrong: ${wrongNew}`);
    });
});
