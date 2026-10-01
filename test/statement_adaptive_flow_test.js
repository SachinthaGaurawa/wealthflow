import { describe, expect, it } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runStatementSync } from '../statement-sync.js';
import { readStatement } from '../statement-reader.mjs';
import { settleStatement } from '../statement-ledger.mjs';
import { linesOf } from '../statement-adaptive.mjs';

// A bank in another language, with a layout the rule-based reader has no template for. The reader calls it empty; the
// text says otherwise. The model reads it, the document is held up against every word of the reading, the books balance
// to the cent — and only then is a single row filed. The reading is stored, so no second slice and no retry asks again.
const owner = { uid: 'u', email: 'owner@example.com' };
const mailPath = 'wf-mail/owner_example_com', sourcePath = `${mailPath}/items/item0`;

const DOC = ['BANCO DEL SUR', 'Extracto de cuenta', 'Cuenta: 1234567890', 'Periodo: 01 abr 2026 - 30 abr 2026', 'Saldo inicial 1.000,00', 'Fecha Concepto Importe Saldo',
    '03 abr 2026 POS Transaction - SHOP ONE 120,50 879,50', '07 abr 2026 Cash Deposit - BRANCH 2.000,00 2.879,50', '15 abr 2026 CEFTS/6719/FT/NSB/SOME NAME/100175 45,25 2.834,25',
    '22 abr 2026 POS Transaction - SHOP TWO 100,00 2.734,25', 'Saldo final 2.734,25'];
const htmlOf = doc => '<html><body>' + doc.map(l => '<p>' + l + '</p>').join('') + '</body></html>';
const html = htmlOf(DOC);
// the same statement with no running balances and no DR / CR marks: the model can read it, the rules cannot prove a direction
const DOC_NO_BALANCES = DOC.map(l => (/^\d\d abr/.test(l) ? l.replace(/ \S+$/, '') : l)).filter(l => !/^Fecha/.test(l));
const TRUTH = [['2026-04-03', 120.5, 'debit', 879.5], ['2026-04-07', 2000, 'credit', 2879.5], ['2026-04-15', 45.25, 'debit', 2834.25], ['2026-04-22', 100, 'debit', 2734.25]];

function honestModel({ lie = false } = {}) {
    const calls = [];
    const ask = async prompt => {
        calls.push(prompt);
        const doc = linesOf(DOC.join('\n'));
        const rows = TRUTH.map(([date, amount, direction, balance], i) => {
            const idx = 6 + i;                   // the four dated lines, in order
            return { line: idx + 1, date, dateText: doc[idx].split(' ').slice(0, 3).join(' '), description: doc[idx].split(' ').slice(3, -2).join(' '), debit: direction === 'debit' ? amount : 0, credit: direction === 'credit' ? amount : 0, balance };
        });
        if (lie) rows[1].credit = 2500;
        return JSON.stringify({ accounts: [{ account: '1234567890', type: 'bank', opening: 1000, closing: 2734.25, periodStart: '2026-04-01', periodEnd: '2026-04-30', rows }] });
    };
    return { ask, calls };
}

function world({ extract, intent = 'stated', doc = DOC }) {
    const { db, data } = createFirestore({
        [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, senders: [{ id: 'statements@bancosur.example', kind: 'address', status: 'approved' }] },
        'wf-statement-vault/u': { uid: 'u' },
        'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [] },
        [sourcePath]: { uid: 'u', bank: 'Banco del Sur', filename: 'extracto_abril.html', from: 'statements@bancosur.example', messageId: 'm0', status: 'pending', hasReview: false, filed: false, cursor: 0, intent },
    });
    const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
    const loadAttachment = async () => ({ bytes: Buffer.from(htmlOf(doc)), filename: 'extracto_abril.html', contentSha256: 'x' });
    const drain = async () => { let last; for (let i = 0; i < 8; i++) { last = await runStatementSync({ action: 'drain', db, owner, env: {}, f, read: readStatement, open: async () => [{ password: 'x', bank: 'Banco del Sur' }], settle: settleStatement, board: async () => { throw new Error('ai-consensus-unavailable'); }, extract, loadAttachment, maxSteps: 1 }); if (['filed', 'needs_review', 'rejected_non_statement'].includes(last.status)) break; } return last; };
    return { db, drain, data, source: () => data.get(sourcePath), user: () => data.get('users/u'), parts: () => [...data.keys()].filter(k => k.startsWith(`${sourcePath}/adaptive/`)) };
}

describe('a statement in a layout nobody wrote a template for', () => {
    it('is first called empty by the rules — which is why it must be read, not assumed', async () => {
        const r = await readStatement({ bytes: Buffer.from(html), filename: 'x.html', passwords: [], bank: 'Banco' });
        expect(r.parsed.rows).toHaveLength(0);
    });
    it('is read by the model, checked against the document, filed row by row, and stored so nobody asks twice', async () => {
        const m = honestModel();
        const w = world({ extract: m.ask });
        const first = await w.drain();
        expect(first.status, JSON.stringify({ first, src: w.source() })).toBe('filed');
        const filed = [...w.user().expenses, ...w.user().incomeRecv];
        expect(filed.map(r => [r.date, r.amount]).sort()).toEqual([['2026-04-03', 120.5], ['2026-04-07', 2000], ['2026-04-15', 45.25], ['2026-04-22', 100]].sort());
        expect(w.source()).toMatchObject({ status: 'filed', filed: true, adaptive: { v: 1, rows: 4 }, proof: { math: 'passed', method: 'ai-checked', rows: 4 } });
        expect(w.source().proof.key).toMatch(/^[0-9a-f]{64}$/);
        expect(w.parts().length).toBeGreaterThan(0);
        // one reading, however many slices and retries it took
        const asked = m.calls.length;
        expect(asked).toBeGreaterThan(0);
        expect(asked).toBeLessThanOrEqual(2);
    });
    it('a model whose reading does not balance is never filed — and where the rules can read the statement themselves, THEY file it, exactly', async () => {
        const w = world({ extract: honestModel({ lie: true }).ask });
        const out = await w.drain();
        expect(out.status, JSON.stringify({ out, src: w.source() })).toBe('filed');
        // not one figure of the lie (a credit of 2,500) reached the ledger: the rules' own reading did
        const filed = [...w.user().expenses, ...w.user().incomeRecv];
        expect(filed.map(r => [r.date, r.amount]).sort()).toEqual([['2026-04-03', 120.5], ['2026-04-07', 2000], ['2026-04-15', 45.25], ['2026-04-22', 100]].sort());
        expect(w.source().adaptive).toMatchObject({ strategy: 'programmatic' });
    });
    it('is NOT filed when the model\'s reading does not balance and the rules cannot read it either: nothing reaches the ledger and the owner is asked', async () => {
        const w = world({ extract: honestModel({ lie: true }).ask, doc: DOC_NO_BALANCES });
        const out = await w.drain();
        expect(['needs_review', 'retry_pending']).toContain(out.status);
        expect(w.user().expenses).toEqual([]);
        expect(w.user().incomeRecv).toEqual([]);
        expect(w.source().adaptive).toBeUndefined();
        expect(w.source()).toMatchObject({ adaptiveTries: 1, adaptiveResult: { reason: 'did-not-balance' } });
    });
    it('goes to the owner exactly as before when no model is reachable and the rules cannot read it, and is tried again later', async () => {
        const w = world({ extract: async () => { throw new Error('down'); }, doc: DOC_NO_BALANCES });
        const out = await w.drain();
        expect(['needs_review', 'rejected_non_statement']).toContain(out.status);
        expect(w.user().expenses).toEqual([]);
        expect(w.source().adaptiveTries).toBeUndefined();          // an outage is not a failed reading: nothing is counted against the statement
    });
    it('with NO model reachable, a statement with running balances is still read — by the rules, held to the same account — and filed', async () => {
        const w = world({ extract: async () => { throw new Error('every provider is down'); } });
        const out = await w.drain();
        expect(out.status, JSON.stringify({ out, src: w.source() })).toBe('filed');
        const filed = [...w.user().expenses, ...w.user().incomeRecv];
        expect(filed.map(r => [r.date, r.amount]).sort()).toEqual([['2026-04-03', 120.5], ['2026-04-07', 2000], ['2026-04-15', 45.25], ['2026-04-22', 100]].sort());
        expect(w.source()).toMatchObject({ status: 'filed', filed: true, adaptive: { strategy: 'programmatic' }, proof: { math: 'passed', method: 'ai-checked' } });
    });
});

describe('one serverless invocation has sixty seconds', () => {
    it('does not start a reading it cannot finish: the statement waits for the next invocation and nothing is counted against it', async () => {
        const m = honestModel();
        const w = world({ extract: m.ask });
        // an invocation that is nearly out of time
        const out = await runStatementSync({ action: 'drain', db: w.db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), read: readStatement, open: async () => [{ password: 'x', bank: 'Banco del Sur' }], settle: settleStatement, board: async () => { throw new Error('x'); }, extract: m.ask,
            loadAttachment: async () => ({ bytes: Buffer.from(html), filename: 'extracto_abril.html', contentSha256: 'x' }), maxSteps: 1, budgetMs: 45000, startedAt: Date.now() - 40000 });
        expect(m.calls.length).toBe(0);
        expect(out.status).toBe('retry_pending');
        expect(w.source().adaptiveTries).toBeUndefined();
    });
});
