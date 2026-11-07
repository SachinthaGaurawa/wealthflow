import { describe, it, expect } from 'vitest';
import { runAnalysis, parseAnalysis, verifyCitations, qaHints, analysisMarkdown, analysisPrompt, ANALYST_SYSTEM } from '../autonomy/analysis-pass.mjs';
import { CHARTER_MARK } from '../wf-charter.mjs';

const BEFORE = 'function total(rows) {\n  let t = 0;\n  for (const r of rows) t += r.amount;\n  return t;\n}\n';
const AFTER = 'function total(rows) {\n  let t = 0;\n  for (const r of rows) if (!r.dup) t += r.amount;\n  return t;\n}\n';
const CHANGE = '-  for (const r of rows) t += r.amount;\n+  for (const r of rows) if (!r.dup) t += r.amount;';
const good = {
    cause: { statement: 'Duplicate rows are summed twice.', quote: 'for (const r of rows) t += r.amount;' },
    alternatives: [{ hypothesis: 'The rows are fine but the opening balance is wrong', tell: 'if every statement is off by the same amount' }],
    failure_modes: [{ what: 'a row with amount "NaN" turns the total into NaN', noticed_by: 'test', undo: 'revert' }],
    assumptions: ['rows carry a dup flag'], unknowns: ['whether older saved rows have the flag'], edge_cases: ['empty list', 'negative amount'],
};
const chatOk = (j, provider = 'mistral') => async () => ({ text: JSON.stringify(j), provider });

describe('the independent analysis: advice with checked quotes, never a gate', () => {
    it('the analyst reads the charter and the prompt fences the report and shows only the diff', () => {
        expect(ANALYST_SYSTEM.startsWith(CHARTER_MARK)).toBe(true);
        const p = analysisPrompt({ issueText: 'Total is wrong', file: 'a.js', changeText: CHANGE, depth: 'comprehensive' });
        expect(p).toMatch(/<<<UNTRUSTED report/);
        expect(p).toContain(CHANGE);
        expect(p).toMatch(/at most 3\)/);
        expect(analysisPrompt({ issueText: 'x', file: 'a.js', changeText: 'c', depth: 'standard' })).toMatch(/at most 2\)/);
    });

    it('parses the reply, caps every list, and refuses a reply with no cause', () => {
        const a = parseAnalysis('```json\n' + JSON.stringify({ ...good, alternatives: Array(6).fill(good.alternatives[0]), edge_cases: Array(9).fill('x') }) + '\n```');
        expect(a.cause.statement).toMatch(/Duplicate rows/);
        expect(a.alternatives.length).toBe(3);
        expect(a.edgeCases.length).toBe(5);
        expect(parseAnalysis('not json')).toBe(null);
        expect(parseAnalysis(JSON.stringify({ cause: { statement: '' } }))).toBe(null);
        expect(parseAnalysis(JSON.stringify([1, 2]))).toBe(null);
    });

    it('a quote that is in the code is kept; a made-up one is removed and marked', () => {
        const real = verifyCitations(parseAnalysis(JSON.stringify(good)), [BEFORE, AFTER, CHANGE]);
        expect(real.cause.citation).toBe('found');
        expect(real.cause.quote).toMatch(/t \+= r\.amount/);
        // whitespace differences do not matter
        const spaced = verifyCitations(parseAnalysis(JSON.stringify({ ...good, cause: { statement: 's', quote: 'for  (const r of rows)\n t += r.amount;' } })), [BEFORE]);
        expect(spaced.cause.citation).toBe('found');
        const fake = verifyCitations(parseAnalysis(JSON.stringify({ ...good, cause: { statement: 's', quote: 'const ledger = await db.getAll(); // sums twice' } })), [BEFORE, AFTER, CHANGE]);
        expect(fake.cause.citation).toBe('not-found');
        expect(fake.cause.quote).toBe('');
        const none = verifyCitations(parseAnalysis(JSON.stringify({ ...good, cause: { statement: 's', quote: '' } })), [BEFORE]);
        expect(none.cause.citation).toBe('none');
    });

    it('asks a provider that is not the author, and says so when it had to use the author\'s', async () => {
        let seen;
        const ok = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, authorProvider: 'groq', chatImpl: async (o) => { seen = o; return { text: JSON.stringify(good), provider: 'mistral' }; } });
        expect(seen.exclude).toEqual(['groq']);
        expect(seen.system.startsWith(CHARTER_MARK)).toBe(true);
        expect(ok.status).toBe('ok');
        expect(ok.independent).toBe(true);
        expect(ok.cause.citation).toBe('found');
        let n = 0;
        const shared = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, authorProvider: 'groq', chatImpl: async (o) => { if (n++ === 0) throw new Error('no other provider'); return { text: JSON.stringify(good), provider: 'groq' }; } });
        expect(shared.status).toBe('ok');
        expect(shared.independent).toBe(false);
        expect(analysisMarkdown(shared)).toMatch(/SAME provider as the author/);
    });

    it('fails open: no provider, or a reply that is not JSON, never stops the run', async () => {
        const down = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, chatImpl: async () => { throw new Error('all down'); } });
        expect(down).toEqual({ status: 'unavailable', reason: 'no provider answered' });
        const junk = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, chatImpl: async () => ({ text: 'I think it is fine', provider: 'groq' }) });
        expect(junk.status).toBe('unavailable');
        expect(analysisMarkdown(down)).toMatch(/No independent analysis was recorded/);
        expect(analysisMarkdown(null)).toBe('');
        expect(qaHints(down)).toBe('');
        expect(qaHints(null)).toBe('');
    });

    it('its edge cases and failure modes go to the QA seat; the pull request labels it an opinion', async () => {
        const a = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, authorProvider: 'groq', chatImpl: chatOk(good) });
        const h = qaHints(a);
        expect(h).toMatch(/INDEPENDENT ANALYST/);
        expect(h).toMatch(/- empty list/);
        expect(h).toMatch(/- a row with amount "NaN"/);
        const md = analysisMarkdown(a);
        expect(md).toMatch(/### Independent analysis/);
        expect(md).toMatch(/A model's OPINION/);
        expect(md).toMatch(/quote found in the code/);
        expect(md).toMatch(/Other credible cause/);
        expect(md).toMatch(/Could fail by/);
        expect(md).toMatch(/Unknown:/);
        const fake = await runAnalysis({ issueText: 'x', file: 'a.js', before: BEFORE, code: AFTER, changeText: CHANGE, chatImpl: chatOk({ ...good, cause: { statement: 's', quote: 'nowhere in the code' } }) });
        expect(analysisMarkdown(fake)).toMatch(/\*\*not found\*\*/);
    });
});
