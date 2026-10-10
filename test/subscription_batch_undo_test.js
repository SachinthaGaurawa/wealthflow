import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'wealthflow-batches.js'), 'utf8');

function harness(seed) {
    const state = structuredClone(seed);
    const DB = {
        get(key) { return state[key]; },
        set(key, value) { state[key] = structuredClone(value); },
    };
    const window = { DB, console: { log() {} } };
    new Function('window', SRC)(window);
    return { state, batch: window.WFBatch };
}

describe('one-time statement batch undo', () => {
    it('keeps the lifecycle closed when a newer statement payment remains', () => {
        const older = { id: 'old', counts: { subscription: 1 }, ids: {}, loans: [], subs: [{
            subId: 's1', paymentDate: '2026-08-10', amount: 1000, prevAmount: 900,
            previousLifecycle: { paid: undefined, completed: undefined, paidAt: undefined },
        }] };
        const newer = { id: 'new', counts: { subscription: 1 }, ids: {}, loans: [], subs: [{
            subId: 's1', paymentDate: '2026-09-10', amount: 1100, prevAmount: 1000,
        }] };
        const { state, batch } = harness({
            importBatches: [older, newer], subMerchantMap: {},
            subscriptions: [{ id: 's1', cycle: 'once', amount: 1100, paid: true, completed: true,
                paidAt: '2026-09-10', paidSource: 'statement', paidStatementKey: 'new-source',
                history: [
                    { month: '2026-08', date: '2026-08-10', amount: 1000, source: 'statement', statementKey: 'old-source' },
                    { month: '2026-09', date: '2026-09-10', amount: 1100, source: 'statement', statementKey: 'new-source' },
                ], monthOverrides: { '2026-08': 1000, '2026-09': 1100 } }],
        });

        batch.undo('old');

        expect(state.subscriptions[0]).toMatchObject({
            amount: 1100, paid: true, completed: true, paidAt: '2026-09-10',
            paidSource: 'statement', paidStatementKey: 'new-source', reopened: false,
        });
        expect(state.subscriptions[0].history.map((h) => h.date)).toEqual(['2026-09-10']);
    });
});
