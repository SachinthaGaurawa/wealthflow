import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { ntbDoc, savingsRows } from './helpers/embedded-statements.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';

// When the mail itself does not say what its attachment is (or talks about a purchase and never says "statement"), the
// attachment has to vouch for itself. A document that has text and none of a statement's shape is retired, counted and
// named — it is never put in front of the owner as a statement that "needs review" — and a real statement is never
// retired by this, whatever the mail said. The bytes are checked too: a program called statement.pdf is refused.
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;

function world({ intent, bytes, filename = 'Consolidated_eStatement_2026JAN.html' }) {
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@nationstrust.com', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'NTB', filename, from: 'statements@nationstrust.com', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, ...(intent ? { intent } : {}) },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes, filename, contentSha256: 'x' });
    const drain = async () => { let last; for (let i = 0; i < 6; i++) { last = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'fixture-password', bank: 'NTB' }], settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, loadAttachment, maxSteps: 1 }); if (['filed', 'needs_review', 'rejected_non_statement'].includes(last.status)) break; } return last; };
    return { drain, source: () => data.get(sourcePath), user: () => data.get('users/u'), data };
}

const real = () => Buffer.from(ntbDoc({ accounts: [{ number: '200550088057', opening: 2405889, rows: savingsRows }] }));
const terms = () => Buffer.from('<html><body><h1>Terms and conditions of the Smart Saver product</h1><p>' + 'These terms govern the use of the product and apply from the date of opening. '.repeat(12) + '</p></body></html>');
const brochure = () => Buffer.from('<html><body><h1>Introducing our new rewards programme</h1><p>' + 'Earn more every time you shop with your card, anywhere in the world, on every purchase. '.repeat(10) + '</p></body></html>');

describe('a document the mail did not vouch for has to vouch for itself', () => {
    it.each(['unproven', 'suspect'])('a real statement is filed whatever the mail said (%s)', async (intent) => {
        const w = world({ intent, bytes: real() });
        expect((await w.drain()).status).toBe('filed');
        expect(w.source()).toMatchObject({ status: 'filed', filed: true });
        expect(w.user().expenses.length + w.user().incomeRecv.length).toBe(4);
    });
    it('a document with text and no statement shape is retired when nothing in the mail called it a statement', async () => {
        const w = world({ intent: 'unproven', bytes: terms(), filename: 'Smart_Saver_Terms.html' });
        expect((await w.drain()).status).toBe('rejected_non_statement');
        expect(w.source()).toMatchObject({ status: 'rejected_non_statement', filed: false });
        expect(w.source().rejectionReason).toMatch(/nothing in the mail calls it a statement/);
        expect(w.user().expenses).toEqual([]);
        expect(w.data.has(`${sourcePath.replace('/items/item0', '')}/reviews`)).toBe(false);
    });
    it('the same document is kept for review (as before) when the mail DID call it a statement', async () => {
        const w = world({ intent: 'stated', bytes: terms(), filename: 'Smart_Saver_Terms.html' });
        expect((await w.drain()).status).toBe('needs_review');
    });
    it('a legacy item written before the field existed is treated as stated', async () => {
        const w = world({ intent: undefined, bytes: terms(), filename: 'Smart_Saver_Terms.html' });
        expect((await w.drain()).status).toBe('needs_review');
    });
    it('a mail that talked about a purchase needs PROOF, not merely the absence of proof against', async () => {
        const w = world({ intent: 'suspect', bytes: brochure(), filename: 'Offer.html' });
        expect((await w.drain()).status).toBe('rejected_non_statement');
        expect(w.source().rejectionReason).toMatch(/purchase or subscription/);
    });
    it('the bytes have the last word: a program called statement.pdf never reaches a reader', async () => {
        for (const intent of ['stated', 'unproven', 'suspect', undefined]) {
            const w = world({ intent, bytes: Buffer.concat([Buffer.from('MZ\x90\x00\x03'), Buffer.alloc(200, 65)]), filename: 'Statement_2026JAN.pdf' });
            expect((await w.drain()).status).toBe('rejected_non_statement');
            expect(w.source().rejectionReason).toMatch(/not a PDF or HTML/);
            expect(w.user().expenses).toEqual([]);
        }
    });
});

describe('a short statement in a language the vocabulary does not know is never retired for lack of proof', () => {
    it('one dated amount is enough to keep it for review instead', async () => {
        const doc = Buffer.from('<html><body><p>BANCO DEL SUR</p><p>Extracto de cuenta abril</p><p>03 abr 2026 PAGO COMERCIO 120,50</p><p>Cuenta 123456 servicios de banca digital disponibles para todos los clientes</p></body></html>');
        const w = world({ intent: 'unproven', bytes: doc, filename: 'extracto_abril.html' });
        expect((await w.drain()).status).not.toBe('rejected_non_statement');
    });
});
