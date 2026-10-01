import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

/* THE HOUSEKEEPING MAY NOT EAT THE WHOLE CALL.
 * 2026-10-01, 18:2x (Sri Lanka): `statement-sync-run {"ms":42509,"interactive":true,"front":true,"processed":0,"attempted":0,"pending":15,…}` —
 * an interactive run spent 42 s of its sixty on the front (intake, coverage, recoveries) and then had no time to read a single one of the
 * fifteen statements waiting. The optional steps now run only while the front has time left. */

afterEach(() => vi.restoreAllMocks());

const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
const TEXT = 'Statement of account\nAccount No 0123456789\nOpening Balance 1,000.00\n03/09/2026 SHOP 100.00 900.00\nClosing Balance 900.00';
const html = '<html><body>' + TEXT.split('\n').map((l) => '<p>' + l + '</p>').join('') + '</body></html>';

function world() {
    const { db } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@bank.example', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'statement.html', from: 'statements@bank.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const f = async (url) => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
    return { db, f };
}
async function interactiveRun({ slowIntakeMs }) {
    const { db, f } = world();
    let now = 1_900_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const intake = async () => { now += slowIntakeMs; return { body: { ok: true, collectionPending: false } }; };
    return runStatementSync({ action: 'collect', interactive: true, budgetMs: 30000, db, owner, env: {}, f, intake, read: readStatement, open: async () => [{ password: 'x', bank: 'HNB' }], settle: settleStatement,
        board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }), maxSteps: 1 });
}

describe('an interactive call keeps its first seconds for the queue', () => {
    it('a front that has already used its time skips the optional steps — says so, and the statement is STILL worked on', async () => {
        const lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
        let result;
        try { result = await interactiveRun({ slowIntakeMs: 20000 }); } finally { info.mockRestore(); }
        expect(result.attempted).toBe(1);                                   // the queue was not starved
        expect(result.morePending).toBe(true); expect(result.retryAfterMs).toBe(750);   // what was skipped comes straight back
        const run = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'statement-sync-run');
        expect(run).toMatchObject({ interactive: true, front: true, attempted: 1, frontIncomplete: true });
    });
    it('a quick front runs every step, and nothing is left over', async () => {
        const lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
        let result;
        try { result = await interactiveRun({ slowIntakeMs: 10 }); } finally { info.mockRestore(); }
        expect(result.attempted).toBe(1);
        const run = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'statement-sync-run');
        expect(run.frontIncomplete).toBeUndefined();
    });
});
