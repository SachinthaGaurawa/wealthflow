/* =============================================================================
 * test/sms_review_fixes_test.js — what an adversarial read of the text-message pipeline found (2026-10-23), pinned
 * -----------------------------------------------------------------------------
 * Each block is a real input that gave a wrong text, or no text, before: cents that floated, a closing text sent twice, a balance that ignored the order
 * the owner confirmed in, a backfill that sent eight identical receipts, wording from the gateway nobody had seen that killed a text on its first try,
 * a 502 that was retried as "certainly not sent", a scan that never reached notice 601, a closing text that overtook its receipt.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { deriveEvents, FIELDS } from '../sms-events.mjs';
import { sweepUser, enqueue, STATUS } from '../sms-engine.mjs';
import { KINDS } from '../sms-templates.mjs';
import { classifyFailure, redact, KIND, TextLkClient } from '../textlk.mjs';
import { debtorSummary } from '../wealthflow-liquidity.js';

const T = (iso) => Date.parse(iso);
const debtor = (over = {}) => ({ id: 'd1', name: 'Nimal', phone: '0771234567', nic: '198534000937', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: T('2026-10-01T00:00:00Z'), events: [], ...over });
const ev = (id, kind, amount, date, confirmedAt) => ({ id, kind, amount, date, confirmed: true, at: confirmedAt, confirmedAt });

describe('money is cents', () => {
    it('a loan repaid to the cent is settled, not "LKR 0.00 still outstanding"', () => {
        const d = debtor({ events: [ev('e1', 'lent', 45126.98, '2026-10-01', T('2026-10-01T05:00:00Z')), ev('e2', 'repayment', 7842.49, '2026-10-05', T('2026-10-05T05:00:00Z')), ev('e3', 'repayment', 37284.49, '2026-10-09', T('2026-10-09T05:00:00Z'))] });
        expect(debtorSummary(d, new Date('2026-10-20')).outstanding).toBe(0);
        const r = deriveEvents({ debtors: [d] }, T('2026-10-20T10:00:00Z'));
        const last = r.events.find((e) => e.key === 'B:d1:e3:in');
        expect(last).toMatchObject({ balance: 0, settled: true });
        expect(r.events.some((e) => e.key === 'B:d1:e3:closed')).toBe(true);
    });
    it('no late reminder is owed on a loan that is paid to the cent', () => {
        const d = debtor({ dueISO: '2026-10-10', [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: T('2026-10-01T00:00:00Z'), events: [ev('e1', 'lent', 45126.98, '2026-10-01', T('2026-10-01T05:00:00Z')), ev('e2', 'repayment', 7842.49, '2026-10-05', T('2026-10-05T05:00:00Z')), ev('e3', 'repayment', 37284.49, '2026-10-09', T('2026-10-09T05:00:00Z'))] });
        expect(deriveEvents({ debtors: [d] }, T('2026-10-20T10:00:00Z')).events.some((e) => e.kind === KINDS.B_LATE)).toBe(false);
    });
});

describe('the closing text', () => {
    it('is sent once: a further payment on a loan already at nothing is a receipt and no more', () => {
        const d = debtor({ events: [ev('e1', 'lent', 10000, '2026-10-02', T('2026-10-02T05:00:00Z')), ev('e2', 'repayment', 10000, '2026-10-05', T('2026-10-05T05:00:00Z')), ev('e3', 'repayment', 500, '2026-10-06', T('2026-10-06T05:00:00Z'))] });
        const keys = deriveEvents({ debtors: [d] }, T('2026-10-10T10:00:00Z')).events.map((e) => e.key);
        expect(keys.filter((k) => k.endsWith(':closed'))).toEqual(['B:d1:e2:closed']);
    });
    it('a borrowed-on-again and settled-again loan is closed again', () => {
        const d = debtor({ events: [ev('e1', 'lent', 1000, '2026-10-02', T('2026-10-02T05:00:00Z')), ev('e2', 'repayment', 1000, '2026-10-03', T('2026-10-03T05:00:00Z')), ev('e3', 'topup', 500, '2026-10-04', T('2026-10-04T05:00:00Z')), ev('e4', 'repayment', 500, '2026-10-05', T('2026-10-05T05:00:00Z'))] });
        expect(deriveEvents({ debtors: [d] }, T('2026-10-10T10:00:00Z')).events.filter((e) => e.key.endsWith(':closed')).map((e) => e.key)).toEqual(['B:d1:e2:closed', 'B:d1:e4:closed']);
    });
});

describe('the balance in a receipt is the balance when it was confirmed', () => {
    it('a payment dated earlier but confirmed later does not take the balance of the dates', () => {
        const d = debtor({ events: [ev('e1', 'lent', 10000, '2026-10-01', T('2026-10-01T05:00:00Z')), ev('r2', 'repayment', 2000, '2026-10-20', T('2026-10-20T05:00:00Z')), ev('r1', 'repayment', 3000, '2026-10-10', T('2026-10-23T05:00:00Z'))] });
        const r = deriveEvents({ debtors: [d] }, T('2026-10-23T08:00:00Z'));
        expect(r.events.find((e) => e.key === 'B:d1:r2:in').balance).toBe(8000);
        expect(r.events.find((e) => e.key === 'B:d1:r1:in').balance).toBe(5000);
    });
});

describe('past months are bookkeeping, not eight identical receipts', () => {
    it('a month confirmed through the Past months panel is not texted', () => {
        const inv = { id: 'inv1', name: 'Bond', amount: 500000, rate: 24, freq: 'monthly', monthly: 5000, start: '2026-01-15', createdAt: '2026-01-15T04:00:00.000Z', phone: '0771234567', nic: '853400937V', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: T('2026-01-01T00:00:00Z') };
        const received = { 'inv1_2026-09': { confirmedAt: T('2026-10-23T05:00:00Z'), month: '2026-09', amount: 5000, retroactive: true }, 'inv1_2026-10': { confirmedAt: T('2026-10-23T05:00:00Z'), month: '2026-10', amount: 5000 } };
        const keys = deriveEvents({ income: [inv], incomeReceived: received }, T('2026-10-23T08:00:00Z')).events.map((e) => e.key);
        expect(keys).toContain('A:inv1:rcv:2026-10');
        expect(keys).not.toContain('A:inv1:rcv:2026-09');
    });
});

describe('gateway wording nobody has seen', () => {
    it('a balance of nothing, a limit, an inactive account and an outage are held or retried, not refused', () => {
        expect(classifyFailure(200, 'Your SMS balance is 0.00')).toBe(KIND.CREDIT);
        expect(classifyFailure(200, 'Daily sending limit exceeded')).toBe(KIND.CREDIT);
        expect(classifyFailure(200, 'Quota exceeded')).toBe(KIND.CREDIT);
        expect(classifyFailure(200, 'Account is not active')).toBe(KIND.AUTH);
        expect(classifyFailure(200, 'Authentication failed')).toBe(KIND.AUTH);
        expect(classifyFailure(200, 'Service temporarily unavailable')).toBe(KIND.SERVER);
        expect(classifyFailure(200, 'Something went sideways')).toBe(KIND.SERVER);
    });
    it('a refusal that is about the recipient or the message is still final', () => {
        expect(classifyFailure(422, 'The message field is required')).toBe(KIND.REJECTED);
        expect(classifyFailure(400, 'Invalid phone number')).toBe(KIND.INVALID_RECIPIENT);
    });
    it('a gateway that echoes a number or a code does not put it in the stored error', () => {
        expect(redact('Invalid recipient 94771234567 for code 482913', 'tok')).toBe('Invalid recipient [number] for code [digits]');
    });
});

describe('a 5xx or a reset may have been delivered', () => {
    const client = (fetchImpl) => new TextLkClient({ token: 'abcdefgh12345', fetchImpl });
    it('a 502 after the request went out is flagged as possibly sent, a refused connection is not', async () => {
        const bad = await client(async () => ({ status: 502, ok: false, headers: { get: () => '' }, text: async () => 'Bad gateway' })).send({ to: '0771234567', message: 'hello' });
        expect(bad).toMatchObject({ ok: false, kind: KIND.SERVER, possiblySent: true });
        const reset = await client(async () => { throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }); }).send({ to: '0771234567', message: 'hello' });
        expect(reset).toMatchObject({ kind: KIND.NETWORK, possiblySent: true });
        const refused = await client(async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } }); }).send({ to: '0771234567', message: 'hello' });
        expect(refused.possiblySent).toBe(false);
    });
});

describe('a big book is scanned to the end', () => {
    it('a run that stops at its share says where, so the next one reaches the notices after it', async () => {
        const fs = createFirestore();
        const events = Array.from({ length: 700 }, (_, i) => ({ key: `B:d${i}:e1:out`, layer: 'B', kind: KINDS.B_DISBURSED, recordKind: 'debtor', recordId: `d${i}`, ref: `DEB-${i}`, phone: '+94771234567', tzMin: 330, subject: null, scheduled: false, notBefore: 0, occurredAt: 1000 + i, amount: 100, balance: 100, currency: 'LKR', dateISO: '2026-10-05' }));
        let from = 0; let created = 0; let runs = 0;
        do {
            const r = await enqueue({ db: fs.db, uid: 'u', events, now: T('2026-10-05T05:00:00Z'), env: {}, from });
            created += r.created; runs += 1; from = r.resume || 0;
        } while (from && runs < 30);
        expect(created).toBe(700);                                   // every notice, the newest included, with a place kept between runs
    });
});
