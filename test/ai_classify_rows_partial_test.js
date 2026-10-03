import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/* =============================================================================
 * THE APP'S BATCH CLASSIFIER NO LONGER LOSES A WHOLE LIST TO ONE DISPUTED ROW.
 *
 * Live, 2026-10-03 19:28-19:30 UTC: three POST /api/ai refusals (422, provider_disagreement) in two minutes from index.html's
 * _aiClassifyRows. It sent a list of statement lines and required the WHOLE answer to match across at least five providers, so one disputed
 * line threw away the classification of every other line too ("deterministic result stands"). The endpoint can already read a list row by
 * row (`itemwise`, api/ai-matrix.mjs itemwiseReading); the statement pipeline uses it. Now this caller asks for it too, and takes the lines every
 * voter agreed on when the whole was refused over a disagreement. A disputed line, an outage, too few voters or a vetoed answer still change nothing.
 * ===========================================================================*/

const HTML = fs.readFileSync(path.resolve(import.meta.dirname, '..', 'index.html'), 'utf8');
function fn(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let depth = 0;
    for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    return '';
}
const SRC = [fn('_wfWantsJSON'), fn('callAIRaw'), fn('_aiClassifyRows')].join('\n');

const ITEMS = [0, 1, 2, 3].map((n) => ({ date: '2026-09-0' + (n + 1), desc: 'ROW ' + n, amount: 100 + n }));
const sig = (it) => it.date + '|' + it.desc.toLowerCase() + '|' + it.amount;
const rowOf = (i, type, category) => ({ i, type, category });
const ROSTER = ['Gemini', 'DeepSeek', 'Groq', 'Ollama', 'Fireworks', 'NVIDIA'];

function harness(respond) {
    const calls = [];
    const fetch = async (url, init) => { const body = JSON.parse(init.body); calls.push(body); return respond(body); };
    const make = new Function('fetch', 'window', 'location', 'setTimeout', `let _lastAIProvider = ''; ${SRC}\nreturn _aiClassifyRows;`);
    return { classify: make(fetch, {}, { hostname: 'app.example' }, setTimeout), calls };
}
const reply = (status, body) => ({ ok: status < 400, status, json: async () => body });
const unanimous = (rows) => reply(200, { reply: JSON.stringify({ decisions: rows }), trustworthy: true, financialDecision: true, provider: 'parallel-unanimous-board' });
const refused = (items, extra = {}) => reply(422, { reason: 'provider_disagreement', expected: ROSTER, items: { agreed: [], disputed: [], voters: ROSTER, vetoed: false, ...items }, ...extra });

describe('_aiClassifyRows asks row by row and keeps only what every voter agreed on', () => {
    it('the source is found (the test is not vacuous)', () => { expect(SRC).toContain('_aiClassifyRows'); expect(SRC).toContain('itemwise'); });

    it('asks the endpoint to read the list row by row, in unanimous mode', async () => {
        const h = harness(() => unanimous(ITEMS.map((_, i) => rowOf(i, 'purchase', 'Groceries'))));
        await h.classify(ITEMS);
        expect(h.calls[0]).toMatchObject({ mode: 'unanimous', itemwise: { path: 'decisions', id: 'i' } });
    });

    it('a whole unanimous answer is applied exactly as before: every line, in order', async () => {
        const h = harness(() => unanimous(ITEMS.map((_, i) => rowOf(i, i === 1 ? 'fuel' : 'purchase', 'Fuel'))));
        const out = await h.classify(ITEMS);
        expect(Object.keys(out)).toHaveLength(4);
        expect(out[sig(ITEMS[1])]).toEqual({ type: 'fuel', category: 'Fuel' });
    });

    it('a whole answer that skips or reorders a line is still refused as a whole', async () => {
        const h = harness(() => unanimous([rowOf(0, 'purchase', 'Groceries'), rowOf(2, 'purchase', 'Groceries'), rowOf(1, 'purchase', 'Groceries'), rowOf(3, 'purchase', 'Groceries')]));
        expect(await h.classify(ITEMS)).toEqual({});
    });

    it('one disputed line: the lines every voter agreed on are applied, the disputed line and nothing invented', async () => {
        const h = harness(() => refused({ agreed: [{ id: 0, value: rowOf(0, 'purchase', 'Groceries') }, { id: 1, value: rowOf(1, 'fuel', 'Fuel') }, { id: 3, value: rowOf(3, 'service_fee', 'Bank Charges') }], disputed: [2] }));
        const out = await h.classify(ITEMS);
        expect(Object.keys(out).sort()).toEqual([sig(ITEMS[0]), sig(ITEMS[1]), sig(ITEMS[3])].sort());
        expect(out[sig(ITEMS[2])]).toBeUndefined();
        expect(out[sig(ITEMS[3])]).toEqual({ type: 'service_fee', category: 'Bank Charges' });
    });

    it('applies nothing when the refusal is not a disagreement, the roster or voters are too few, the answer was vetoed, or nothing was agreed', async () => {
        const agreed = [{ id: 0, value: rowOf(0, 'purchase', 'Groceries') }];
        const cases = [
            reply(422, { reason: 'provider_unavailable', expected: ROSTER, items: { agreed, disputed: [], voters: ROSTER, vetoed: false } }),
            refused({ agreed, voters: ROSTER.slice(0, 4) }),
            refused({ agreed, vetoed: true, reason: 'misshaped_answer' }),
            refused({ agreed: [] }),
            refused({ agreed }, { expected: ROSTER.slice(0, 4) }),
            reply(422, { reason: 'provider_disagreement', expected: ROSTER }),
            reply(503, {}),
        ];
        for (const [n, response] of cases.entries()) expect(await harness(() => response).classify(ITEMS), 'case ' + n).toEqual({});
    });

    it('a partial answer naming a line that does not exist, or the same line twice, is not applied', async () => {
        const bad = [
            [{ id: 9, value: rowOf(9, 'purchase', 'Groceries') }],
            [{ id: 0, value: rowOf(0, 'purchase', 'Groceries') }, { id: 0, value: rowOf(0, 'fuel', 'Fuel') }],
            [{ id: 0, value: { i: '0', type: 'purchase', category: 'Groceries' } }],
        ];
        for (const [n, agreed] of bad.entries()) expect(await harness(() => refused({ agreed })).classify(ITEMS), 'case ' + n).toEqual({});
    });
});
