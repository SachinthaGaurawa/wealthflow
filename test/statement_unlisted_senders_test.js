import { describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { removeUnlistedSenderStatements, unfileStatement, runStatementSync, EXACT_SENDER_VERSION } from '../statement-sync.js';
import { settleStatement } from '../statement-ledger.mjs';

// The owner's rule: only an address on the Senders list brings a statement in. For a while another desk of an approved bank (via 'sibling' / 'series' / 'evidence') was taken as well, and
// its rows reached the books — the interim statement a bank staff member sent before the official one filled September's income. Whatever came in that way is taken back out, whole.

const owner = { uid: 'u', email: 'owner@example.com' };
const mail = 'wf-mail/owner_example_com';
const at = id => `${mail}/items/${id}`;
const A = (id, name) => ({ id, kind: 'address', status: 'approved', name, domain: id.split('@')[1] });
const SENDERS = [A('statements@dfccbank.com', 'DFCC Bank')];
const item = (extra = {}) => ({ uid: 'u', bank: 'DFCC Bank', filename: 'DFCC Bank Statement - Aug 26.pdf', messageId: 'm', status: 'filed', filed: true, cursor: 3, totalRows: 3, ...extra });
const rec = (id, from, extra = {}) => ({ id, statementKey: at(from), source: 'statement', amount: 100, date: '2026-09-02', ...extra });

function world({ items, senders = SENDERS, extra = {} }) {
    return createFirestore({
        [mail]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders },
        'users/u': {
            expenses: [rec('e1', 'sib', { desc: 'Inward' }), rec('e2', 'ok', { desc: 'kept' }), { id: 'e3', desc: 'typed by the owner', amount: 5, date: '2026-09-03' }, rec('lx', 'sib', { loanLink: { loanId: 'L1', month: '2026-09' } })],
            incomeRecv: [rec('i1', 'sib', { name: 'Inward CEFT Transfer', type: 'Other' }), rec('i2', 'ok', { name: 'salary' })],
            cconetime: [rec('c1', 'sib'), rec('c2', 'ok')], ccPayments: [rec('p1', 'sib')],
            ccinstall: [{ id: 'plan', product: 'tv', payments: [{ month: '2026-09', paid: true, statementKey: at('sib') }, { month: '2026-08', paid: true, statementKey: at('ok') }] }],
            subscriptions: [{ id: 's1', cycle: 'once', paid: true, completed: true, paidAt: '2026-09-02',
                paidSource: 'statement', paidStatementKey: at('sib'),
                history: [{ month: '2026-09', date: '2026-09-02', source: 'statement', statementKey: at('sib') },
                    { month: '2026-08', date: '2026-08-02', source: 'statement', statementKey: at('ok') }] }],
            loans: [{ id: 'L1', payments: [{ month: '2026-09', paid: true, source: 'statement', expenseId: 'lx', via: 'bank' }, { month: '2026-08', paid: true, source: 'statement', expenseId: 'other' }, { month: '2026-07', paid: true, source: 'manual' }] }],
            cheques: [{ id: 'q1', status: 'cleared', clearedDate: '2026-09-01', statementKey: at('sib'), statementRow: 2, no: '1' }, { id: 'q2', status: 'cleared', statementKey: at('ok'), no: '2' }],
            _tomb: { expenses: { old: 1 } },
            ...extra,
        },
        'users/u/statementLedger/l1': { sourcePath: at('sib'), status: 'filed', module: 'expenses', id: 'e1' },
        'users/u/statementLedger/l2': { sourcePath: at('sib'), status: 'filed', module: 'incomeRecv', id: 'i1' },
        'users/u/statementLedger/l3': { sourcePath: at('ok'), status: 'filed', module: 'expenses', id: 'e2' },
        'users/u/statementReview/r1': { uid: 'u', sourcePath: at('sib'), status: 'pending', index: 1 },
        'users/u/statementReview/r2': { uid: 'u', sourcePath: at('ok'), status: 'pending', index: 1 },
        ...Object.fromEntries(Object.entries(items).map(([id, data]) => [at(id), data])),
    });
}
const run = (w, extra = {}) => { const lines = []; return removeUnlistedSenderStatements({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', senders: SENDERS, log: l => lines.push(l), ...extra }).then(out => ({ ...out, lines })); };
const ids = (w, key) => w.data.get('users/u')[key].map(r => r.id);

describe('a statement taken from an address that is not on the list is taken back out, whole', () => {
    const items = () => ({
        sib: item({ via: 'sibling', from: 'Avinash <avinash.dissanayake@dfccbank.com>' }),
        ok: item({ via: 'sibling', from: 'DFCC <statements@dfccbank.com>' }),         // the exact address the owner listed: it stays, whatever mark it carries
        plain: item({ from: 'Someone <someone@else.example>' }),                      // no release mark: another way in, counted below but never removed here
    });
    it('every record it filed leaves the books with a tombstone; the owner\'s typed records and every other statement\'s stay', async () => {
        const w = world({ items: items() });
        const out = await run(w);
        expect(out).toMatchObject({ removed: 1, more: false, pending: 0 });
        expect(ids(w, 'expenses')).toEqual(['e2', 'e3']);
        expect(ids(w, 'incomeRecv')).toEqual(['i2']);
        expect(ids(w, 'cconetime')).toEqual(['c2']);
        expect(ids(w, 'ccPayments')).toEqual([]);
        const user = w.data.get('users/u');
        // nothing a device or a heal could put back
        expect(user._tomb).toMatchObject({ expenses: { old: 1, e1: expect.any(Number), lx: expect.any(Number) }, incomeRecv: { i1: expect.any(Number) }, cconetime: { c1: expect.any(Number) }, ccPayments: { p1: expect.any(Number) } });
        expect(user._lastModifiedBy).toBe('statement-worker');
    });
    it('what it did to a plan, a subscription, a loan month and a cheque is undone, and only that', async () => {
        const w = world({ items: items() });
        await run(w);
        const user = w.data.get('users/u');
        expect(user.ccinstall[0].payments).toEqual([{ month: '2026-08', paid: true, statementKey: at('ok') }]);
        expect(user.subscriptions[0].history).toEqual([{ month: '2026-08', date: '2026-08-02', source: 'statement', statementKey: at('ok') }]);
        expect(user.subscriptions[0]).toMatchObject({ paid: true, completed: true, paidAt: '2026-08-02', paidStatementKey: at('ok') });
        expect(user.loans[0].payments.map(p => p.month)).toEqual(['2026-08', '2026-07']);
        expect(user.cheques.find(c => c.id === 'q1')).toMatchObject({ status: 'pending' });
        expect(user.cheques.find(c => c.id === 'q1').statementKey).toBeUndefined();
        expect(user.cheques.find(c => c.id === 'q1').clearedDate).toBeUndefined();
        expect(user.cheques.find(c => c.id === 'q2')).toMatchObject({ status: 'cleared', statementKey: at('ok') });
    });
    it('its ledger rows are released for a re-decision, its waiting reviews are closed, and the statement is retired with the reason', async () => {
        const w = world({ items: items() });
        await run(w);
        expect(w.data.get('users/u/statementLedger/l1')).toMatchObject({ status: 'superseded_by_layout', supersededBy: 'exact-sender-rule' });
        expect(w.data.get('users/u/statementLedger/l2').status).toBe('superseded_by_layout');
        expect(w.data.get('users/u/statementLedger/l3').status).toBe('filed');
        expect(w.data.get('users/u/statementReview/r1')).toMatchObject({ status: 'resolved', replayStatus: 'sender-not-on-your-list' });
        expect(w.data.get('users/u/statementReview/r2').status).toBe('pending');
        expect(w.data.get(at('sib'))).toMatchObject({ status: 'rejected_unapproved_sender', filed: false, hasReview: false, rejectionReason: 'sender-not-on-your-list', unlistedV: EXACT_SENDER_VERSION });
        expect(w.data.get(at('ok'))).toMatchObject({ status: 'filed', filed: true });
        expect(w.data.get(at('plain'))).toMatchObject({ status: 'filed', filed: true });
    });
    it('says what it did in counts only — no sender, no amount, no description', async () => {
        const w = world({ items: items() });
        const out = await run(w);
        expect(JSON.parse(out.lines[0])).toMatchObject({ evt: 'statement-unlisted-removed', released: 2, removed: 1, records: 5, ledger: 2, reviews: 1, kept: 1, noSender: 0 });
        expect(out.lines[0]).not.toMatch(/avinash|dfccbank|Inward|typed/i);
    });
    it('is done once: the second pass finds nothing left and removes nothing more', async () => {
        const w = world({ items: items() });
        await run(w);
        const before = structuredClone(w.data.get('users/u'));
        const again = await run(w);
        expect(again).toMatchObject({ removed: 0, more: false, pending: 0 });
        expect(w.data.get('users/u')).toEqual(before);
    });
    it('a statement with no sender recorded is read from its message; one whose message is gone was taken as another desk\'s and goes too; one that cannot be asked yet waits', async () => {
        const w = world({ items: {
            a: item({ via: 'series', messageId: 'mA' }),
            b: item({ via: 'evidence', messageId: 'mB' }),
            c: item({ via: 'sibling', messageId: 'mC' }),
            d: item({ via: 'sibling', messageId: 'mD' }),
        } });
        const from = { mA: 'Mallory <x@dfccbank.com>', mC: 'DFCC <statements@dfccbank.com>', mD: '' };
        const f = vi.fn(async url => {
            const id = decodeURIComponent(String(url)).split('/messages/')[1].split('?')[0];
            if (id === 'mB') return { ok: false, status: 404, json: async () => ({}) };
            if (id === 'mD') throw new Error('network');
            return { ok: true, status: 200, json: async () => ({ payload: { headers: [{ name: 'From', value: from[id] }] } }) };
        });
        const out = await run(w, { token: 't', f });
        const status = id => w.data.get(at(id)).status;
        expect(status('a')).toBe('rejected_unapproved_sender');
        expect(status('b')).toBe('rejected_unapproved_sender');
        expect(status('c')).toBe('filed');                         // the exact address, found by lookup
        expect(status('d')).toBe('filed');                         // could not be asked: nothing is removed on a guess
        expect(out).toMatchObject({ removed: 2, pending: 1 });
        expect(f.mock.calls.every(([url]) => String(url).includes('format=metadata&metadataHeaders=From'))).toBe(true);
    });
    it('without a list the owner approved, nothing is removed: an unread or empty list would call every statement unlisted', async () => {
        for (const senders of [[], [{ id: 'statements@dfccbank.com', kind: 'address', status: 'blocked', domain: 'dfccbank.com' }], undefined]) {
            const w = world({ items: items() });
            expect(await run(w, { senders })).toMatchObject({ removed: 0, more: false });
            expect(ids(w, 'expenses')).toEqual(['e1', 'e2', 'e3', 'lx']);
            expect(w.data.get(at('sib')).status).toBe('filed');
        }
    });
    it('at most `limit` statements a pass, and says there is more', async () => {
        const many = Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`s${i}`, item({ via: 'sibling', from: `Staff <staff${i}@dfccbank.com>`, messageId: `m${i}` })]));
        const w = world({ items: many });
        const first = await run(w, { limit: 2 });
        expect(first).toMatchObject({ removed: 2, more: true });
        expect(await run(w, { limit: 10 })).toMatchObject({ removed: 3, more: false });
    });
    it('a statement the owner adds the address of later is read afresh — its rows can be decided again', async () => {
        const w = world({ items: { sib: item({ via: 'sibling', from: 'Avinash <avinash.dissanayake@dfccbank.com>' }) } });
        await run(w);
        expect(w.data.get('users/u/statementLedger/l1').status).toBe('superseded_by_layout');
        // the owner lists the address: it is revived (exact) and the worker files it again like any other
        const { reviveRetiredSources } = await import('../statement-sync.js');
        const listed = [...SENDERS, A('avinash.dissanayake@dfccbank.com', 'DFCC Bank')];
        const out = await reviveRetiredSources({ db: w.db, mailRef: w.db.collection('wf-mail').doc('owner_example_com'), uid: 'u', senders: listed, log: () => {} });
        expect(out.revived).toBe(1);
        expect(w.data.get(at('sib'))).toMatchObject({ status: 'pending', via: '' });
    });
});

describe('the settle pass does it by itself and then marks the mailbox, so it is not looked for again', () => {
    it('removes what came in by another desk, logs a count and sets exactSenderV', async () => {
        const w = world({ items: { sib: item({ via: 'sibling', from: 'Avinash <avinash.dissanayake@dfccbank.com>' }) }, extra: {} });
        w.data.set(mail, { ...w.data.get(mail), lastSettleMs: 0 });
        const lines = []; const spy = vi.spyOn(console, 'info').mockImplementation(l => lines.push(String(l)));
        const f = async url => (String(url).includes('/profile') ? { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '1' }) } : { ok: true, json: async () => ({ access_token: 'token' }) });
        const go = () => runStatementSync({ action: 'collect', db: w.db, owner, env: {}, f, intake: async () => ({ body: { ok: true } }), open: async () => [], maxSteps: 1, budgetMs: 40000, settle: settleStatement,
            board: async () => { throw new Error('ai-consensus-unavailable'); }, extract: async () => { throw new Error('ai-extractor-unavailable'); } });
        for (let i = 0; i < 6 && !(w.data.get(mail).exactSenderV >= EXACT_SENDER_VERSION); i++) { w.data.set(mail, { ...w.data.get(mail), lastSettleMs: 0 }); await go(); }
        spy.mockRestore();
        expect(w.data.get(mail).exactSenderV).toBe(EXACT_SENDER_VERSION);
        expect(w.data.get(at('sib')).status).toBe('rejected_unapproved_sender');
        expect(ids(w, 'expenses')).toEqual(['e2', 'e3']);
        expect(lines.some(l => /"evt":"statement-settle"/.test(l) && /"unlistedRemoved":1/.test(l))).toBe(true);
    });
});

describe('unfileStatement on its own', () => {
    it('a statement that does not exist, or belongs to another owner, is left alone', async () => {
        const w = world({ items: { other: item({ uid: 'someone-else', via: 'sibling', from: 'x@dfccbank.com' }) } });
        expect(await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(at('nothing')) })).toMatchObject({ records: 0, done: false });
        expect(await unfileStatement({ db: w.db, uid: 'u', itemRef: w.db.doc(at('other')) })).toMatchObject({ records: 0, done: false });
        expect(w.data.get(at('other')).status).toBe('filed');
    });
});
