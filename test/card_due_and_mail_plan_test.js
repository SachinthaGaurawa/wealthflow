import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const BATCHES = fs.readFileSync(path.join(process.cwd(), 'wealthflow-batches.js'), 'utf8');
const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
const ai = fs.readFileSync(path.join(process.cwd(), 'wealthflow-ai-v4.js'), 'utf8');

function harness(seed) {
    const state = structuredClone(seed);
    const DB = { get: (k) => state[k], set: (k, v) => { state[k] = structuredClone(v); } };
    const window = { DB, console: { log() {} } };
    new Function('window', BATCHES)(window);
    return { state, WFBatch: window.WFBatch };
}

describe('Undo takes the minimum-payment ask off again', () => {
    const due = { id: 'due-up-hnb-1234-2026-08-20', bank: 'HNB', card_last4: '1234', minimum: 2500, dueDate: '2026-08-20', source: 'upload', _ut: 1 };

    it('removes the ask a batch filed when it is still as the import left it', () => {
        const { state, WFBatch } = harness({ cardDues: [due], importBatches: [] });
        const b = WFBatch.begin('x', 'statement');
        WFBatch.record(b, 'cconetime', 'r1');
        WFBatch.recordDue(b, { id: due.id, prev: null, now: { ...due, _ut: 99 } });
        WFBatch.commit(b);
        const out = WFBatch.undo(b.id);
        expect(state.cardDues).toEqual([]);
        expect(out.removed.cardDues).toBe(1);
    });

    it('puts back the ask it replaced', () => {
        const prev = { ...due, minimum: 2000 };
        const { state, WFBatch } = harness({ cardDues: [due], importBatches: [] });
        const b = WFBatch.begin('x', 'statement');
        WFBatch.record(b, 'cconetime', 'r1');
        WFBatch.recordDue(b, { id: due.id, prev, now: due });
        WFBatch.commit(b);
        WFBatch.undo(b.id);
        expect(state.cardDues).toHaveLength(1);
        expect(state.cardDues[0].minimum).toBe(2000);
    });

    it('leaves an ask the owner has since marked paid', () => {
        const { state, WFBatch } = harness({ cardDues: [{ ...due, paidManually: true }], importBatches: [] });
        const b = WFBatch.begin('x', 'statement');
        WFBatch.record(b, 'cconetime', 'r1');
        WFBatch.recordDue(b, { id: due.id, prev: null, now: due });
        WFBatch.commit(b);
        WFBatch.undo(b.id);
        expect(state.cardDues).toHaveLength(1);
        expect(state.cardDues[0].paidManually).toBe(true);
    });

    it('is not counted as a transaction', () => {
        const { WFBatch } = harness({ cardDues: [due], importBatches: [] });
        const b = WFBatch.begin('x', 'statement');
        WFBatch.recordDue(b, { id: due.id, prev: null, now: due });
        expect(WFBatch.commit(b)).toBeUndefined();
    });

    it('the page records the ask on the batch', () => {
        expect(html).toContain('WFBatch.recordDue(_batch');
    });
});

describe('the e-mail review carries the statement type and plan table too', () => {
    it('the ai module exposes the identity step', () => {
        expect(ai).toContain('window._wfIdentifyParsed = _wfIdentify;');
    });
    it('each ready statement carries them into the review screen', () => {
        expect(html).toContain("window._wfIdentifyParsed(_parsed, typeof res.text === 'string' ? res.text : '', null, null)");
        expect(html).toContain('planTable: first.planTable,');
        expect(html).toContain('statementType: first.statementType,');
    });
});
