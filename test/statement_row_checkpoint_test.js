import { it, expect } from 'vitest';
import { checkpointRows } from '../statement-sync.js';

function database(initial) {
    let source = structuredClone(initial);
    return { data: () => source, async runTransaction(fn) {
        const writes = [];
        const result = await fn({ get: async () => ({ exists: true, data: () => structuredClone(source) }), set: (_, value) => writes.push(value) });
        writes.forEach(value => { source = { ...source, ...value }; });
        return result;
    } };
}
const rows = [{ date: '2026-09-10', amount: 1, direction: 'debit', narration: 'Merchant A', ref: 'a' }, { date: '2026-09-10', amount: 2, direction: 'debit', narration: 'Merchant B', ref: 'b' }];
it('pins the complete ordered row set before any slice and rejects changed later ordering', async () => {
    const db = database({ uid: 'u', leaseToken: 'lease', cursor: 0 });
    const hash = await checkpointRows(db, {}, 'u', 'lease', rows);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(db.data()).toMatchObject({ rowSetHash: hash, totalRows: 2 });
    await expect(checkpointRows(db, {}, 'u', 'lease', [...rows].reverse())).rejects.toThrow('statement-cursor-or-content-changed');
    await expect(checkpointRows(db, {}, 'u', 'wrong', rows)).rejects.toThrow('statement-lease-lost');
});
it('quarantines legacy partial progress whose prior row ordering was never pinned', async () => {
    const db = database({ uid: 'u', leaseToken: 'lease', cursor: 1 });
    await expect(checkpointRows(db, {}, 'u', 'lease', rows)).rejects.toThrow('statement-cursor-or-content-changed');
    expect(db.data().rowSetHash).toBeUndefined();
});
