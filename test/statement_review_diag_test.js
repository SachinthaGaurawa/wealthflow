import { describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync, shapeOf, skeletonOf } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

/* A statement that goes to the owner "for review" used to say only THAT it did (statement-layout-identity-needs-review, thirty-four times for
 * HNB in the owner's diagnostics) and never WHY: no way to tell an empty extraction from a layout nobody has seen from a document that is not
 * a statement. The log line now carries what the reading saw — as counts and yes/no only, never a word or a figure of the statement. */

const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;
const SECRET_NAME = 'KULASOORIYAGE SACHINTHA', SECRET_ACCOUNT = '074020012388', SECRET_AMOUNT = '4,250.00';
const TEXT = `HNB ACCOUNT ACTIVITY\n${SECRET_NAME}\nAccount ${SECRET_ACCOUNT}\nPage 1 of 2 PIZZA HUT ${SECRET_AMOUNT}`;
const html = '<html><body>' + TEXT.split('\n').map((l) => '<p>' + l + '</p>').join('') + '</body></html>';

function world() {
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@hnb.example', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'HNB', filename: 'statement.html', from: 'statements@hnb.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent: 'stated' },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const run = () => runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'x', bank: 'HNB' }], settle: settleStatement,
        // the board counts the money the rules skipped (it sits on a heading line): the statement is one the rules could not read, and goes to review
        board: async () => ({ fields: { transactionLines: 1 }, unanimous: true }), extract: async () => { throw new Error('ai-extractor-unavailable'); },
        loadAttachment: async () => ({ bytes: Buffer.from(html), filename: 'statement.html', contentSha256: 'x' }), maxSteps: 1 });
    return { run, data };
}

describe('what the log says about a statement that went to review', () => {
    it('carries the shape of what was read — counts and yes/no — and not one word or figure of the statement', async () => {
        const w = world();
        const lines = [];
        const info = vi.spyOn(console, 'info').mockImplementation((line) => { lines.push(String(line)); });
        try { for (let i = 0; i < 4; i++) { const r = await w.run(); if (['needs_review', 'filed'].includes(r.status)) break; } } finally { info.mockRestore(); }
        const item = lines.map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).find((l) => l && l.evt === 'statement-sync-item' && l.status === 'needs_review');
        expect(item, lines.join('\n')).toBeTruthy();
        expect(item.bank).toBe('HNB');
        expect(item.reason).toMatch(/needs-(?:review|confirmation)$/);
        expect(item.diag).toMatchObject({ rows: expect.any(Number), tries: expect.any(Number) });
        expect(item.diag.shape).toMatchObject({ lines: 4, dated: 0, money: 1, stmt: false });
        expect(item.diag.identity).toMatchObject({ verdict: expect.any(String) });
        // the layout without the content: the banking words survive, every digit is a 9, every other word a run of a's
        expect(item.diag).toMatchObject({ intent: 'stated', rec: { open: expect.any(Boolean), close: expect.any(Boolean) } });
        expect(item.diag.skeleton).toMatch(/Account/); expect(item.diag.skeleton).toMatch(/9{3,}/);
        const text = JSON.stringify(item);
        for (const secret of [SECRET_NAME, SECRET_ACCOUNT, SECRET_AMOUNT, 'PIZZA']) expect(text, secret).not.toContain(secret);
    });
});

describe('skeletonOf', () => {
    it('keeps the layout and banking words, masks every digit and every other word', () => {
        const sk = skeletonOf('Statement of Account\nKULASOORIYAGE SACHINTHA\nAccount No: 074-02-12345-88\nOpening Balance 12,345.67\n03/09/2026 PIZZA HUT COLOMBO 4,250.00 8,095.67\nowner@example.com');
        expect(sk).toContain('Statement of Account'); expect(sk).toContain('Opening Balance 99,999.99'); expect(sk).toContain('99/99/9999');
        for (const secret of ['KULASOORIYAGE', 'SACHINTHA', '074-02', '12345', 'PIZZA', 'COLOMBO', 'owner@', '4,250', '8,095']) expect(sk, secret).not.toContain(secret);
        expect(sk).toContain('<email>');
        for (const junk of [null, undefined, 5, {}]) expect(() => skeletonOf(junk)).not.toThrow();
        expect(skeletonOf('x '.repeat(5000)).length).toBeLessThanOrEqual(900);
    });
});

describe('shapeOf', () => {
    it('counts, never quotes', () => {
        const s = shapeOf(TEXT + '\n03/07/2026 CREDIT 250,000.00');
        expect(s).toMatchObject({ lines: 5, dated: 1, money: 2, open: false, close: false, bal: false, cr: true, stmt: false });
        expect(JSON.stringify(s)).not.toContain('PIZZA');
        expect(Object.values(s).every((v) => typeof v === 'number' || typeof v === 'boolean')).toBe(true);
    });
    it('tells an empty extraction from a garbled one from a real statement', () => {
        expect(shapeOf('')).toMatchObject({ chars: 0, lines: 0, dated: 0, money: 0 });
        const garbled = shapeOf('\u0001\u0002�� \u0003\u0004 �'.repeat(50));
        expect(garbled.odd).toBeGreaterThan(garbled.letters);
        const real = shapeOf('Statement of account\nOpening balance 1,000.00\n03 Apr 2026 SHOP 120.50 DR 879.50\nClosing balance 879.50');
        expect(real).toMatchObject({ open: true, close: true, bal: true, stmt: true, dated: 1, dr: true });
        for (const junk of [null, undefined, 5, {}]) expect(() => shapeOf(junk)).not.toThrow();
    });
});
