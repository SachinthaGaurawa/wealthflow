/* =============================================================================
 * test/sms_engine_test.js — queue, send, retry, account: nothing omitted, nothing doubled
 * -----------------------------------------------------------------------------
 * Run against an in-memory Firestore whose transactions are SERIALISED, which is what
 * the real one guarantees and what the exactly-once argument rests on: two sweeps
 * racing for one message, the cron and a click, a page open on two devices.
 *
 * The gateway is a stub with the real client's result shapes. Nothing here touches
 * a network.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import {
    sweepUser, enqueue, claim, docIdFor, nextAttemptDelay, STATUS, LEASE_MS, MAX_ATTEMPTS, HOLD_MS, LIMITS, ADMIN_ALERT, CONCURRENCY,
} from '../sms-engine.mjs';
import { deriveEvents, FIELDS } from '../sms-events.mjs';
import { KIND } from '../textlk.mjs';

const T = (iso) => Date.parse(iso);
const UID = 'owner1';
const NOW = T('2026-10-05T05:00:00Z');                          // 10:30 in Colombo: inside the sending window

function makeDb() {
    const fs = createFirestore();
    const db = fs.db;
    const orig = db.runTransaction.bind(db);
    let chain = Promise.resolve();
    db.runTransaction = (fn) => { const p = chain.then(() => orig(fn)); chain = p.catch(() => {}); return p; };     // Firestore serialises conflicting transactions
    return { fs, db };
}
const ledger = (fs) => [...fs.data.entries()].filter(([p]) => p.startsWith(`wf-sms/${UID}/events/`)).map(([p, v]) => ({ path: p, ...v }));
const mirrorDocs = (fs) => [...fs.data.entries()].filter(([p]) => p.startsWith(`users/${UID}/smsLog/`)).map(([p, v]) => ({ id: p.split('/').pop(), ...v }));

function gateway(behaviour = () => ({ ok: true, gatewayId: 'g', cost: 1, segments: 1 }), { configured = true } = {}) {
    const sent = []; let inFlight = 0; let peak = 0; let n = 0;
    return {
        configured, senderId: 'WealthFlow', sent,
        get peak() { return peak; },
        async send({ to, message }) {
            inFlight += 1; peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 2));
            inFlight -= 1;
            n += 1;
            const res = behaviour({ to, message, call: n });
            if (res.ok) sent.push({ to, message });
            return res;
        },
    };
}

function books(extra = {}) {
    return {
        settings: { currency: 'LKR' },
        debtors: [{
            id: 'd1', name: 'Nimal', phone: '077 123 4567', nic: '853400937V',
            [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3,
            events: [
                { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 },
                { id: 'e2', kind: 'repayment', amount: 20000, date: '2026-10-05', confirmed: true, at: NOW - 600e3 },
            ],
        }],
        ...extra,
    };
}
const env = { TENANT_PORTAL_LINKS: 'on', WEALTHFLOW_PUBLIC_ORIGIN: 'https://wealthflow-personal.vercel.app', FIREBASE_SERVICE_ACCOUNT: JSON.stringify({ private_key: 'k'.repeat(64) }) };
const run = (db, user, client, over = {}) => sweepUser({ db, uid: UID, user, client, now: NOW, env, deps: { random: () => 0.5 }, ...over });

describe('exactly once', () => {
    it('sends each owed notice once, and a second sweep sends nothing', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const a = await run(db, books(), gw);
        expect(a).toMatchObject({ derived: 2, sent: 2 });
        expect(gw.sent).toHaveLength(2);
        const b = await run(db, books(), gw);
        expect(b.sent).toBe(0);
        expect(b.enqueued.created).toBe(0);
        expect(gw.sent).toHaveLength(2);
        expect(ledger(fs).every((d) => d.status === STATUS.SENT)).toBe(true);
    });

    it('five sweeps racing for the same messages still send each one once (the cron, a click, two devices)', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await Promise.all([1, 2, 3, 4, 5].map(() => run(db, books(), gw)));
        expect(gw.sent).toHaveLength(2);
        expect(ledger(fs)).toHaveLength(2);
        expect(ledger(fs).every((d) => d.status === STATUS.SENT && d.attempts === 1)).toBe(true);
    });

    it('twin repayments logged at the same instant are two messages, not one and not three', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors[0].events = [
            { id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 },
            { id: 'r1', kind: 'repayment', amount: 10000, date: '2026-10-05', confirmed: true, at: NOW - 60e3 },
            { id: 'r2', kind: 'repayment', amount: 10000, date: '2026-10-05', confirmed: true, at: NOW - 60e3 },          // same amount, same second
        ];
        await Promise.all([run(db, user, gw), run(db, user, gw)]);
        const bodies = gw.sent.map((s) => s.message);
        expect(bodies.filter((b) => b.startsWith('Repayment'))).toHaveLength(2);
        expect(gw.sent).toHaveLength(3);
        expect(new Set(ledger(fs).map((d) => d.key)).size).toBe(3);
        // the balances are each message's own: 40,000 after the first, 30,000 after the second
        expect(bodies.filter((b) => b.startsWith('Repayment')).map((b) => /Balance (LKR [\d,]+\.\d{2})/.exec(b)[1]).sort()).toEqual(['LKR 30,000.00', 'LKR 40,000.00']);
    });

    it('the body is rendered once, at queue time: a retry sends the same words', async () => {
        const { fs, db } = makeDb();
        let first = true; const seen = [];
        const gw = gateway(({ message }) => { seen.push(message); if (first) { first = false; return { ok: false, kind: KIND.SERVER, retryable: true, message: 'oops' }; } return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; });
        const user = books();
        await run(db, user, gw);
        user.debtors[0].events[0].amount = 99999;                                // the books change after queueing
        await run(db, user, gw, { now: NOW + 2 * 3600e3 });
        const body = ledger(fs).find((d) => d.key === 'B:d1:e1:out').body;
        expect(seen.filter((m) => m === body).length).toBeGreaterThanOrEqual(2);
        expect(body).toContain('LKR 50,000.00');
    });
});

describe('held, not lost: out of credit, a rejected token, a missing token', () => {
    it('out of credit holds every message, uses no attempts, and sends them after the top-up', async () => {
        const { fs, db } = makeDb();
        let credit = false;
        const gw = gateway(() => (credit ? { ok: true, gatewayId: 'g', cost: 1, segments: 1 } : { ok: false, kind: KIND.CREDIT, retryable: true, message: 'Insufficient balance' }));
        const a = await run(db, books(), gw);
        expect(a).toMatchObject({ sent: 0, held: 2 });
        for (const d of ledger(fs)) {
            expect(d.status).toBe(STATUS.QUEUED);
            expect(d.attempts).toBe(0);
            expect(d.lastError.kind).toBe(KIND.CREDIT);
            expect(d.nextAttemptAt).toBe(NOW + HOLD_MS);
        }
        expect(mirrorDocs(fs).filter((m) => m.key).every((m) => m.error.kind === KIND.CREDIT)).toBe(true);

        // an hour later, still nothing to try: not yet due, and the gateway is not hammered
        const calls = gw.sent.length;
        await run(db, books(), gw, { now: NOW + 3600e3 });
        expect(gw.sent.length).toBe(calls);

        credit = true;                                                           // the owner tops up
        const b = await run(db, books(), gw, { now: NOW + HOLD_MS + 1000 });
        expect(b.sent).toBe(2);
        expect(ledger(fs).every((d) => d.status === STATUS.SENT)).toBe(true);
    });

    it('a rejected token and an unapproved sender id are held the same way', async () => {
        for (const kind of [KIND.AUTH, KIND.SENDER]) {
            const { fs, db } = makeDb();
            await run(db, books(), gateway(() => ({ ok: false, kind, retryable: true, message: 'no' })));
            expect(ledger(fs).every((d) => d.status === STATUS.QUEUED && d.attempts === 0 && d.nextAttemptAt === NOW + HOLD_MS)).toBe(true);
        }
    });

    it('with no token configured everything is queued and nothing is lost or attempted', async () => {
        const { fs, db } = makeDb(); const gw = gateway(undefined, { configured: false });
        const r = await run(db, books(), gw);
        expect(r).toMatchObject({ derived: 2, configured: false, sent: 0 });
        expect(gw.sent).toHaveLength(0);
        expect(ledger(fs).map((d) => d.status)).toEqual([STATUS.QUEUED, STATUS.QUEUED]);
        // the token arrives: the same messages go out, once
        const gw2 = gateway();
        await run(db, books(), gw2, { now: NOW + 60e3 });
        expect(gw2.sent).toHaveLength(2);
    });

    it('a message held until it is no longer news expires instead of arriving a month late', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })));
        const gw = gateway();
        const later = NOW + 31 * 86400e3;
        const user = books(); user.debtors[0][FIELDS.ENABLED_AT] = NOW - 3600e3;
        await run(db, user, gw, { now: later });
        expect(gw.sent).toHaveLength(0);
        // derivation no longer owes them (too old) so they were cancelled, or expired when claimed: either way never sent
        expect(ledger(fs).every((d) => d.status !== STATUS.SENT)).toBe(true);
    });
});

describe('retry and backoff', () => {
    it('a rate limit retries with growing delays and honours Retry-After when it is longer', async () => {
        const { fs, db } = makeDb();
        let n = 0;
        const gw = gateway(() => { n += 1; return n <= 2 ? { ok: false, kind: KIND.RATE_LIMIT, retryable: true, message: 'slow down', retryAfterMs: 2 * 3600e3 } : { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; });
        const user = { ...books(), debtors: [{ ...books().debtors[0], events: [books().debtors[0].events[0]] }] };
        await run(db, user, gw);
        const d1 = ledger(fs)[0];
        expect(d1).toMatchObject({ status: STATUS.QUEUED, attempts: 1 });
        expect(d1.nextAttemptAt - NOW).toBeGreaterThanOrEqual(2 * 3600e3);       // Retry-After wins over the 1-minute step
    });

    it('nextAttemptDelay: 1m, 5m, 20m, 1h, 3h, 6h, 12h, 24h, then holds are flat', () => {
        const d = (k, a) => nextAttemptDelay(k, a, { random: () => 0.5 });
        expect([1, 2, 3, 4, 5, 6, 7, 8].map((a) => d(KIND.NETWORK, a))).toEqual([60e3, 300e3, 1200e3, 3600e3, 10800e3, 21600e3, 43200e3, 86400e3]);
        expect(d(KIND.NETWORK, 99)).toBe(86400e3);
        expect(d(KIND.CREDIT, 1)).toBe(HOLD_MS);
        expect(d(KIND.NETWORK, 1, {})).toBe(60e3);
        // jitter stays within +/-10%
        const lo = nextAttemptDelay(KIND.SERVER, 2, { random: () => 0 }); const hi = nextAttemptDelay(KIND.SERVER, 2, { random: () => 1 });
        expect(lo).toBe(270e3); expect(hi).toBe(330e3);
    });

    it('network failures retry, then succeed; the message is sent once in total', async () => {
        const { fs, db } = makeDb(); let n = 0;
        const gw = gateway(() => { n += 1; return n < 3 ? { ok: false, kind: KIND.NETWORK, retryable: true, message: 'down' } : { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; });
        const user = { ...books(), debtors: [{ ...books().debtors[0], events: [books().debtors[0].events[0]] }] };
        let now = NOW;
        for (let i = 0; i < 4; i += 1) { await run(db, user, gw, { now }); now += 25 * 3600e3; }
        expect(gw.sent).toHaveLength(1);
        expect(ledger(fs)[0]).toMatchObject({ status: STATUS.SENT, attempts: 3 });
    });

    it('gives up after the attempts are used and says why', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(() => ({ ok: false, kind: KIND.SERVER, retryable: true, message: 'HTTP 500' }));
        const user = { ...books(), debtors: [{ ...books().debtors[0], events: [books().debtors[0].events[0]] }] };
        let now = NOW;
        for (let i = 0; i < MAX_ATTEMPTS + 2; i += 1) { await run(db, user, gw, { now }); now += 25 * 3600e3 - 1000 * 0; if (now - NOW > 25 * 86400e3) break; }
        const d = ledger(fs)[0];
        expect(d.status).toBe(STATUS.FAILED);
        expect(d.lastError.kind).toBe(KIND.SERVER);
        expect(d.attempts).toBe(MAX_ATTEMPTS);
    });

    it('a number that can never receive fails at once, and a corrected number reopens it', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(({ to }) => (to === '+94771234567' ? { ok: false, kind: KIND.BLOCKED, retryable: false, message: 'blacklisted' } : { ok: true, gatewayId: 'g', cost: 1, segments: 1 }));
        const user = { ...books(), debtors: [{ ...books().debtors[0], events: [books().debtors[0].events[0]] }] };
        await run(db, user, gw);
        expect(ledger(fs)[0]).toMatchObject({ status: STATUS.FAILED, lastError: { kind: KIND.BLOCKED } });
        await run(db, user, gw, { now: NOW + 5000 });
        expect(ledger(fs)[0].status).toBe(STATUS.FAILED);                         // same number: stays failed, no loop
        user.debtors[0].phone = '0712345678';                                      // the owner fixes the number
        const r = await run(db, user, gw, { now: NOW + 10000 });
        expect(r.enqueued.reopened).toBe(1);
        expect(ledger(fs)[0]).toMatchObject({ status: STATUS.SENT, to: '+94712345678' });
    });

    it('a queued message follows a corrected number', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })));
        const user = books(); user.debtors[0].phone = '0712345678';
        const gw = gateway();
        await run(db, user, gw, { now: NOW + HOLD_MS + 1000 });
        expect(gw.sent.every((s) => s.to === '+94712345678')).toBe(true);
        expect(gw.sent).toHaveLength(2);
    });
});

describe('a held text whose recipient was corrected goes to, and links to, the corrected person', () => {
    const linkOf = (body) => (/\/t\/([A-Za-z0-9_-]{16})/.exec(body) || [])[1];
    const heldDb = async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })));
        return { fs, db };
    };

    it('the number and the NIC both corrected: the words are built again, so the new number is not sent a link to the old NIC\'s statement', async () => {
        const { fs, db } = await heldDb();
        const oldLinks = ledger(fs).map((d) => linkOf(d.body));
        expect(oldLinks.every(Boolean)).toBe(true);
        const user = books(); user.debtors[0].phone = '0712345678'; user.debtors[0].nic = '902301234V';
        const gw = gateway();
        const r = await run(db, user, gw, { now: NOW + HOLD_MS + 1000 });
        expect(r.enqueued.rephoned).toBe(2);
        expect(gw.sent).toHaveLength(2);
        expect(gw.sent.every((m) => m.to === '+94712345678')).toBe(true);
        const newLinks = gw.sent.map((m) => linkOf(m.message));
        expect(newLinks.every(Boolean)).toBe(true);
        expect(newLinks.some((l) => oldLinks.includes(l))).toBe(false);
    });

    it('only the NIC corrected (same number): the link follows it too', async () => {
        const { fs, db } = await heldDb();
        const oldLinks = ledger(fs).map((d) => linkOf(d.body));
        const user = books(); user.debtors[0].nic = '902301234V';
        const gw = gateway();
        await run(db, user, gw, { now: NOW + HOLD_MS + 1000 });
        expect(gw.sent).toHaveLength(2);
        expect(gw.sent.map((m) => linkOf(m.message)).some((l) => oldLinks.includes(l))).toBe(false);
    });

    it('nothing changed: the held text is left exactly as it was written', async () => {
        const { fs, db } = await heldDb();
        const before = ledger(fs).map((d) => d.body);
        const r = await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })), { now: NOW + HOLD_MS + 1000 });
        expect(r.enqueued.rephoned).toBe(0);
        expect(ledger(fs).map((d) => d.body)).toEqual(before);
    });
});

describe('a worker that dies', () => {
    it('the lease lapses, the message is claimed again, and it is flagged as possibly doubled', async () => {
        const { fs, db } = makeDb();
        const events = deriveEvents(books(), NOW).events;
        await enqueue({ db, uid: UID, events, now: NOW, env });
        const id = docIdFor(events[0].key);
        const first = await claim({ db, uid: UID, id, now: NOW });
        expect(first.doc.status).toBe(STATUS.SENDING);
        // a live lease is respected: nobody else takes it
        expect(await claim({ db, uid: UID, id, now: NOW + LEASE_MS - 1 })).toBeNull();
        // the worker never came back
        const again = await claim({ db, uid: UID, id, now: NOW + LEASE_MS + 1 });
        expect(again.doc).toMatchObject({ status: STATUS.SENDING, attempts: 2, possiblyDuplicated: true });
        expect(ledger(fs).find((d) => d.key === events[0].key).attempts).toBe(2);
    });

    it('a sent message can never be claimed again', async () => {
        const { db } = makeDb(); const gw = gateway();
        await run(db, books(), gw);
        const id = docIdFor('B:d1:e1:out');
        expect(await claim({ db, uid: UID, id, now: NOW + 99999 })).toBeNull();
    });
});

describe('no longer owed', () => {
    it('switching the toggle off before a held message goes cancels it', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })));
        const off = books(); off.debtors[0][FIELDS.ENABLED] = false;
        const gw = gateway();
        const r = await run(db, off, gw, { now: NOW + HOLD_MS + 1000 });
        expect(r.cancelled).toBe(2);
        expect(gw.sent).toHaveLength(0);
        expect(ledger(fs).every((d) => d.status === STATUS.CANCELLED)).toBe(true);
    });

    it('un-confirming a repayment before it goes cancels that message and only that one', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'x' })));
        const user = books(); user.debtors[0].events[1].confirmed = false;
        const gw = gateway();
        await run(db, user, gw, { now: NOW + HOLD_MS + 1000 });
        expect(gw.sent).toHaveLength(1);
        expect(gw.sent[0].message.startsWith('Loan')).toBe(true);
        expect(ledger(fs).find((d) => d.key === 'B:d1:e2:in').status).toBe(STATUS.CANCELLED);
    });

    it('a message already sent is never touched by a later change', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, books(), gw);
        await run(db, { settings: {} }, gw, { now: NOW + 1000 });
        expect(ledger(fs).every((d) => d.status === STATUS.SENT)).toBe(true);
    });
});

describe('owed again, owed many, owed oddly', () => {
    it('a repayment un-confirmed and confirmed again is owed again, once, worded from the books as they now are', async () => {
        const { fs, db } = makeDb();
        const withRepayment = (over) => { const u = books(); u.debtors[0].events.push({ id: 'e3', kind: 'repayment', amount: 5000, date: '2026-10-05', at: NOW - 300e3, confirmed: true, ...over }); return u; };
        // queued but held for credit, so the repayment has not gone yet
        const closed = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'out of credit' }));
        await run(db, withRepayment(), closed);
        expect(ledger(fs).find((d) => d.key === 'B:d1:e3:in').status).toBe(STATUS.QUEUED);
        // the owner un-confirms it: it is cancelled before it ever went
        const open = gateway();
        await run(db, withRepayment({ confirmed: false }), open);
        expect(ledger(fs).find((d) => d.key === 'B:d1:e3:in').status).toBe(STATUS.CANCELLED);
        // and confirms it again, with a corrected amount
        const r = await run(db, withRepayment({ amount: 7000, confirmedAt: NOW - 100e3 }), open, { now: NOW + 1000 });
        expect(r.enqueued.reopened).toBe(1);
        const sent = open.sent.filter((m) => m.message.startsWith('Repayment'));
        expect(sent.map((m) => /Repayment (LKR [\d,.]+?) received/.exec(m.message)[1])).toEqual(expect.arrayContaining(['LKR 7,000.00']));   // the new amount, not the cancelled one
        expect(sent.some((m) => m.message.includes('LKR 5,000.00'))).toBe(false);
        expect(ledger(fs).find((d) => d.key === 'B:d1:e3:in').status).toBe(STATUS.SENT);
        const again = await run(db, withRepayment({ amount: 7000, confirmedAt: NOW - 100e3 }), open, { now: NOW + 2000 });
        expect(again.sent).toBe(0);                                                                  // and only once
    });

    it('more than 100 notices owed: all of them are queued, across runs, none lost past the first hundred', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors = Array.from({ length: 130 }, (_, i) => ({ id: `d${i}`, name: 'N', phone: `0771${String(100000 + i)}`, [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, events: [{ id: 'e', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: NOW - 600e3 + i }] }));
        const limits = { perUserPerDay: 1000, perRecipientPerDay: 12 };
        const first = await run(db, user, gw, { limits });
        expect(first.enqueued.created).toBe(100);
        const second = await run(db, user, gw, { limits });
        expect(second.enqueued.created).toBe(30);
        expect(ledger(fs)).toHaveLength(130);
        const third = await run(db, user, gw, { limits });
        expect(third.enqueued.created).toBe(0);
        expect(gw.sent).toHaveLength(130);
    });

    it('a record that cannot be read is reported and skipped, and every other tenant still gets their notices', async () => {
        const { db } = makeDb(); const gw = gateway();
        const user = books();
        const poison = { id: 'bad', name: 'x', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, phone: '0771234567' };
        Object.defineProperty(poison, 'events', { get() { throw new Error('corrupt'); }, enumerable: true });
        user.debtors.push(poison);
        user.income = [{ id: 'bad2', name: 'y', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, phone: '0771234567', amount: 5, createdAt: new Date(NOW - 60e3).toISOString() }];
        Object.defineProperty(user.income[0], 'rate', { get() { throw new Error('corrupt'); }, enumerable: true });
        const r = await run(db, user, gw);
        expect(r.issues).toBe(2);
        expect(gw.sent).toHaveLength(2);                                                             // the healthy debtor's two notices
    });

    it('a gateway call that throws is a retry, flagged as possibly sent, never a crash that strands the message', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(); let boom = true;
        const real = gw.send.bind(gw);
        gw.send = async (m) => { if (boom) { boom = false; throw new Error('socket hang up'); } return real(m); };
        const r = await run(db, books(), gw);
        expect(r.retry).toBe(1);
        const hit = ledger(fs).find((d) => d.lastError);
        expect(hit.status).toBe(STATUS.QUEUED);
        expect(hit.possiblyDuplicated).toBe(true);
        const next = await run(db, books(), gw, { now: NOW + 2 * 3600e3 });
        expect(next.sent).toBeGreaterThanOrEqual(1);
    });

    it('if the record of a delivery cannot be written the first time, it is tried again before the message can be re-sent', async () => {
        const { fs, db } = makeDb();
        const base = db.runTransaction;
        let failNext = 0;
        db.runTransaction = (fn) => (failNext > 0 ? (failNext -= 1, Promise.reject(new Error('unavailable'))) : base(fn));      // a brief Firestore outage right after the send
        const gw = gateway(() => { failNext = 2; return { ok: true, gatewayId: 'g', cost: 1, segments: 1 }; });
        const user = books(); user.debtors[0].events = user.debtors[0].events.slice(0, 1);
        const r = await run(db, user, gw, { deps: { random: () => 0.5, retryDelayMs: 1 } });
        expect(r.sent).toBe(1);
        expect(ledger(fs).find((d) => d.status === STATUS.SENT)).toBeTruthy();
        expect(gw.sent).toHaveLength(1);                                                             // sent once, and recorded
    });
});

describe('limits', () => {
    it('a number past its daily limit is held until tomorrow, not failed', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors[0].events = Array.from({ length: 5 }, (_, i) => ({ id: `e${i}`, kind: i === 0 ? 'lent' : 'repayment', amount: 1000, date: '2026-10-05', confirmed: true, at: NOW - 60e3 * (10 - i) }));
        user.debtors[0].events[0].amount = 100000;
        const r = await run(db, user, gw, { limits: { ...LIMITS, perRecipientPerDay: 2 } });
        expect(gw.sent).toHaveLength(2);
        expect(r.held).toBe(3);
        const held = ledger(fs).filter((d) => d.status === STATUS.QUEUED);
        expect(held).toHaveLength(3);
        expect(held.every((d) => d.lastError.kind === 'cap' && d.attempts === 0 && d.nextAttemptAt > NOW)).toBe(true);
        const next = await run(db, user, gateway(), { now: NOW + 26 * 3600e3, limits: { ...LIMITS, perRecipientPerDay: 2 } });
        expect(next.sent).toBe(2);
    });

    it('the daily limit holds even when sweeps race: a cap of 2 is never 3, however many are in flight', async () => {
        const { db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors = Array.from({ length: 8 }, (_, i) => ({ id: `d${i}`, name: 'N', phone: `07712345${String(i).padStart(2, '0')}`, [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, events: [{ id: 'e', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: NOW - 600e3 }] }));
        const limits = { perUserPerDay: 3, perRecipientPerDay: 12 };
        await Promise.all([1, 2, 3].map(() => run(db, user, gw, { limits })));
        expect(gw.sent).toHaveLength(3);
    });

    it('a send the gateway refused gives its place in the quota back; a timeout, which may have sent, keeps it', async () => {
        const { fs, db } = makeDb();
        const refuse = gateway(() => ({ ok: false, kind: KIND.SERVER, retryable: true, message: 'oops' }));
        await run(db, books(), refuse);
        const quota = () => [...fs.data.entries()].find(([p]) => p.startsWith(`wf-sms/${UID}/quota/`));
        expect(quota()[1].sent).toBe(0);
        const { fs: fs2, db: db2 } = makeDb();
        const timeout = gateway(() => ({ ok: false, kind: KIND.NETWORK, retryable: true, message: 'timed out', possiblySent: true }));
        await run(db2, books(), timeout);
        const q2 = [...fs2.data.entries()].find(([p]) => p.startsWith(`wf-sms/${UID}/quota/`));
        expect(q2[1].sent).toBe(2);
    });

    it('at most CONCURRENCY messages are in flight at once', async () => {
        const { db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors = Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, name: 'N', phone: `07712345${String(i).padStart(2, '0')}`, [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3, events: [{ id: 'e', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: NOW - 600e3 }] }));
        await run(db, user, gw, { limits: { perUserPerDay: 100, perRecipientPerDay: 100 } });
        expect(gw.sent).toHaveLength(9);
        expect(gw.peak).toBeLessThanOrEqual(CONCURRENCY);
        expect(gw.peak).toBeGreaterThan(1);
    });

    it('stops starting new sends when the time budget is spent and says how many are left', async () => {
        const { db } = makeDb(); const gw = gateway();
        let t = 0;
        const clock = () => { t += 30000; return t; };                           // every look at the clock costs 30 s
        const r = await run(db, books(), gw, { budgetMs: 40000, clock });
        expect(r.remaining).toBeGreaterThan(0);
        expect(r.sent + r.remaining).toBe(2);
    });
});

describe('the quiet hours for scheduled notices', () => {
    const inv = () => ({
        id: 'inv1', name: 'Bond', company: 'Acme', amount: 500000, rate: 24, freq: 'monthly', monthly: 10000, start: '2026-04-15', day: '2026-04-15', createdAt: '2026-04-15T04:00:00Z',
        phone: '0771234567', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: T('2026-10-04T10:00:00Z'),
    });
    it('interest due today but swept at 23:00 Colombo time waits for 08:00', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const night = T('2026-10-15T17:30:00Z');                                // 23:00 local
        const r = await run(db, { income: [inv()] }, gw, { now: night });
        expect(r.sent).toBe(0);
        expect(ledger(fs)[0].nextAttemptAt).toBe(T('2026-10-16T02:30:00Z'));
        const morning = await run(db, { income: [inv()] }, gw, { now: T('2026-10-16T02:31:00Z') });
        expect(morning.sent).toBe(1);
        expect(gw.sent[0].message).toContain('Interest LKR 10,000.00 applied');
    });
    it('a repayment acknowledgement is not held back at night', async () => {
        const { db } = makeDb(); const gw = gateway();
        const night = T('2026-10-05T18:00:00Z');
        const user = books(); user.debtors[0].events = [{ id: 'e1', kind: 'lent', amount: 5, date: '2026-10-05', confirmed: true, at: night - 60e3 }]; user.debtors[0][FIELDS.ENABLED_AT] = night - 3600e3;
        const r = await run(db, user, gw, { now: night });
        expect(r.sent).toBe(1);
    });
});

describe('the portal link in every message', () => {
    it('a tenant with an NIC gets the same unguessable link in every message', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, books(), gw);
        const links = gw.sent.map((s) => /https:\/\/wealthflow-personal\.vercel\.app\/t\/([A-Za-z0-9_-]{16})$/.exec(s.message));
        expect(links.every(Boolean)).toBe(true);
        expect(new Set(links.map((m) => m[1])).size).toBe(1);
        const tenants = [...fs.data.keys()].filter((p) => p.startsWith('wf-tenants/'));
        expect(tenants).toHaveLength(1);
        expect(fs.data.get(tenants[0])).toMatchObject({ uid: UID, active: true });
        expect(JSON.stringify(fs.data.get(tenants[0]))).not.toContain('853400937');   // no NIC in the index
        expect(JSON.stringify(fs.data.get(tenants[0]))).not.toContain('198534000937');
    });

    it('the old-style and new-style spelling of one NIC are one tenant and one link', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const user = books();
        user.debtors.push({ ...user.debtors[0], id: 'd2', nic: '198534000937', phone: '0771234567', events: [{ id: 'x1', kind: 'lent', amount: 7, date: '2026-10-05', confirmed: true, at: NOW - 60e3 }] });
        await run(db, user, gw);
        expect([...fs.data.keys()].filter((p) => p.startsWith('wf-tenants/'))).toHaveLength(1);
    });

    it('two parallel first messages for a new tenant do not mint two tokens', async () => {
        const { fs, db } = makeDb();
        await Promise.all([run(db, books(), gateway()), run(db, books(), gateway())]);
        expect([...fs.data.keys()].filter((p) => p.startsWith('wf-tenant-subjects/'))).toHaveLength(1);
        expect([...fs.data.keys()].filter((p) => p.startsWith('wf-tenants/'))).toHaveLength(1);
    });

    it('no NIC on file: the message still goes, without a dead link', async () => {
        const { db } = makeDb(); const gw = gateway();
        const user = books(); user.debtors[0].nic = '';
        const r = await run(db, user, gw);
        expect(r.sent).toBe(2);
        expect(gw.sent.every((s) => !s.message.includes('http'))).toBe(true);
    });

    it('links are on unless the owner switches them off: the portal ships with them', async () => {
        const { db } = makeDb(); const gw = gateway();
        const { TENANT_PORTAL_LINKS, ...bare } = env;
        await run(db, books(), gw, { env: bare });
        expect(gw.sent.length).toBeGreaterThan(0);
        expect(gw.sent.every((m) => /Statement: https:\/\/wealthflow-personal\.vercel\.app\/t\/[A-Za-z0-9_-]{16}$/.test(m.message))).toBe(true);
    });

    it.each(['off', 'OFF', 'false', '0', 'no', ' off '])('TENANT_PORTAL_LINKS=%j sends without links', async (value) => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, books(), gw, { env: { ...env, TENANT_PORTAL_LINKS: value } });
        expect(gw.sent.length).toBeGreaterThan(0);
        expect(gw.sent.every((s) => !s.message.includes('http'))).toBe(true);
        expect([...fs.data.keys()].filter((k) => k.startsWith('wf-tenants/') || k.startsWith('wf-tenant-subjects/'))).toEqual([]);   // and no link is minted for nothing
    });
});

describe('the owner sees it', () => {
    it('a delivery is mirrored with the admin alert text, the masked number and no unmasked phone', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway());
        const sent = mirrorDocs(fs).filter((m) => m.status === STATUS.SENT);
        expect(sent).toHaveLength(2);
        for (const m of sent) {
            expect(m.alert).toBe(ADMIN_ALERT);
            expect(m.to).toBe('+94*****4567');
            expect(JSON.stringify(m)).not.toContain('771234567');
            expect(m.sentAt).toBe(NOW);
        }
    });

    it('a status card says what is switched on but cannot work', async () => {
        const { fs, db } = makeDb();
        const user = books(); user.debtors[0].phone = '';
        await run(db, user, gateway());
        const status = mirrorDocs(fs).find((m) => m.id === '_status');
        expect(status).toMatchObject({ configured: true });
        expect(status.issues).toEqual([{ recordKind: 'debtor', recordId: 'd1', reason: 'no-phone' }]);
    });

    it('a low-credit reading survives the owner\'s next save: a sweep that did not ask the gateway for the balance leaves it alone', async () => {
        const { fs, db } = makeDb();
        await run(db, books(), gateway(), { deps: { random: () => 0.5, units: 3 } });                   // the daily sweep asked: 3 units left
        expect(mirrorDocs(fs).find((m) => m.id === '_status')).toMatchObject({ units: 3, lowCredit: true });
        await run(db, books(), gateway(), { now: NOW + 60e3 });                                          // the page's nudge after a save did not
        expect(mirrorDocs(fs).find((m) => m.id === '_status')).toMatchObject({ units: 3, lowCredit: true });
        await run(db, books(), gateway(), { now: NOW + 3600e3, deps: { random: () => 0.5, units: 120 } });  // topped up, and the next daily sweep says so
        expect(mirrorDocs(fs).find((m) => m.id === '_status')).toMatchObject({ units: 120, lowCredit: false });
    });

    it('a failure to mirror never fails the delivery', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const realCollection = db.collection;
        db.collection = (name) => { if (name === 'users') throw new Error('mirror down'); return realCollection(name); };
        const r = await run(db, books(), gw);
        expect(r.sent).toBe(2);
        expect(ledger(fs).every((d) => d.status === STATUS.SENT)).toBe(true);
    });
});

describe('the balance the owner asked for', () => {
    const ASKED = NOW - 60e3;
    const asking = (extra = {}) => { const u = books(); u.debtors[0][FIELDS.REQUESTS] = [{ id: 'req-0001', at: ASKED }]; Object.assign(u.debtors[0], extra); return u; };

    it('goes out once, now (not held for the morning), worded from the books, carrying its own shelf life', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const night = T('2026-10-05T19:30:00Z');                     // 01:00 in Colombo: a scheduled notice would wait, a request does not
        const user = asking(); user.debtors[0][FIELDS.REQUESTS] = [{ id: 'req-0001', at: night - 60e3 }];
        const a = await run(db, user, gw, { now: night });
        expect(a.sent).toBeGreaterThanOrEqual(1);
        const doc = ledger(fs).find((d) => d.key === 'B:d1:bal:req-0001');
        expect(doc).toMatchObject({ status: STATUS.SENT, kind: 'B.balance', maxAgeMs: 30 * 60 * 1000, scheduled: false });
        expect(doc.body).toMatch(/^Balance LKR 30,000\.00 as at 06 Oct 2026, ref DEB-[0-9A-F]{6}\. Statement: https:/);
        const again = await run(db, user, gw, { now: night + 5 * 60e3 });
        expect(again.sent).toBe(0);
        expect(gw.sent.filter((m) => m.message.startsWith('Balance'))).toHaveLength(1);
    });

    it('five sweeps racing for it still send one text', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await Promise.all([1, 2, 3, 4, 5].map(() => run(db, asking(), gw)));
        expect(gw.sent.filter((m) => m.message.startsWith('Balance'))).toHaveLength(1);
        expect(ledger(fs).filter((d) => d.kind === 'B.balance')).toHaveLength(1);
    });

    it('held for credit, it is dropped after half an hour rather than sent later with a figure that has moved', async () => {
        const { fs, db } = makeDb();
        const broke = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: false, message: 'out of units' }));
        await run(db, asking(), broke);
        expect(ledger(fs).find((d) => d.key === 'B:d1:bal:req-0001')).toMatchObject({ status: STATUS.QUEUED, lastError: { kind: KIND.CREDIT } });
        // the owner tops up an hour later: the repayment texts go, the stale balance does not
        const gw = gateway();
        const later = await run(db, asking(), gw, { now: NOW + 3600e3 });
        expect(gw.sent.some((m) => m.message.startsWith('Balance'))).toBe(false);
        expect(ledger(fs).find((d) => d.key === 'B:d1:bal:req-0001').status).toBe(STATUS.CANCELLED);
        expect(later.cancelled).toBeGreaterThanOrEqual(1);
    });

    it('a notice with no shelf life of its own keeps the month every other notice gets', async () => {
        const { fs, db } = makeDb();
        const broke = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: false, message: 'out of units' }));
        await run(db, books(), broke);
        const doc = ledger(fs).find((d) => d.key === 'B:d1:e2:in');
        expect(doc.maxAgeMs).toBeUndefined();
        const gw = gateway();
        await run(db, books(), gw, { now: NOW + 7 * 86400e3 });
        expect(ledger(fs).find((d) => d.key === 'B:d1:e2:in').status).toBe(STATUS.SENT);
    });

    it('turning the debtor\'s texts off before it goes cancels it like any other notice', async () => {
        const { fs, db } = makeDb();
        const broke = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: false, message: 'out of units' }));
        await run(db, asking(), broke);
        const off = asking({ [FIELDS.ENABLED]: false });
        await run(db, off, gateway(), { now: NOW + 60e3 });
        expect(ledger(fs).find((d) => d.key === 'B:d1:bal:req-0001').status).toBe(STATUS.CANCELLED);
    });

    it('the daily limit for one number holds for balance texts too', async () => {
        const { db } = makeDb(); const gw = gateway();
        const user = asking();
        user.debtors[0][FIELDS.REQUESTS] = [{ id: 'req-0001', at: ASKED }, { id: 'req-0002', at: ASKED + 1000 }, { id: 'req-0003', at: ASKED + 2000 }];
        await run(db, user, gw, { limits: { ...LIMITS, perRecipientPerDay: 3 } });        // the loan text and the repayment text are two of the three
        expect(gw.sent.length).toBe(3);
        expect(gw.sent.filter((m) => m.message.startsWith('Balance'))).toHaveLength(1);
    });
});

describe('a scheduled text never goes out outside the recipient\'s 08:00-20:00, whenever the sweep happens to run', () => {
    // A debtor in the United Kingdom (UTC+0 here): the daily 04:00 UTC sweep is 04:00 their time, the owner's page nudges at any hour.
    const uk = () => {
        const u = books();
        Object.assign(u.debtors[0], { phone: '+447911123456', dueISO: '2026-10-04', [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: NOW - 86400e3 * 3, [FIELDS.ENABLED_AT]: NOW - 86400e3 * 3 });
        u.debtors[0].events = [{ id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-01', confirmed: true, at: NOW - 3 * 86400e3 }];
        return u;
    };
    const docs = (fs) => ledger(fs).filter((d) => d.kind === 'B.late');
    const reminders = (gw) => gw.sent.filter((m) => m.message.startsWith('Reminder'));

    it('a sweep that runs late at night leaves it queued for the next morning instead of sending it then', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, uk(), gw, { now: T('2026-10-05T03:00:00Z') });                 // 03:00 UK: queued for 08:00
        expect(docs(fs)[0].nextAttemptAt).toBe(T('2026-10-05T08:00:00Z'));
        await run(db, uk(), gw, { now: T('2026-10-05T21:30:00Z') });                 // 21:30 UK: the due time has passed, the window has closed
        expect(reminders(gw)).toHaveLength(0);
        expect(docs(fs)[0]).toMatchObject({ status: STATUS.QUEUED, nextAttemptAt: T('2026-10-06T08:00:00Z') });
    });

    it('goes out when a sweep next runs inside the window, once', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, uk(), gw, { now: T('2026-10-05T03:00:00Z') });
        await run(db, uk(), gw, { now: T('2026-10-05T21:30:00Z') });
        await run(db, uk(), gw, { now: T('2026-10-06T07:30:00Z') });                 // still before 08:00
        expect(reminders(gw)).toHaveLength(0);
        await run(db, uk(), gw, { now: T('2026-10-06T08:00:00Z') });                 // the window opens: 32 h after the day began, still inside its shelf life
        expect(reminders(gw)).toHaveLength(1);
        await run(db, uk(), gw, { now: T('2026-10-06T09:00:00Z') });
        expect(reminders(gw)).toHaveLength(1);
        expect(docs(fs)[0].status).toBe(STATUS.SENT);
    });

    it('a text that is news the moment it happens (a receipt) is not held for the morning', async () => {
        const { db } = makeDb(); const gw = gateway();
        const u = books();
        u.debtors[0][FIELDS.ENABLED_AT] = T('2026-10-04T00:00:00Z');
        u.debtors[0].events[0].at = T('2026-10-04T10:00:00Z');
        u.debtors[0].events[1].at = T('2026-10-05T01:00:00Z');                       // 06:30 in Colombo: before the window, but a receipt is not scheduled
        await run(db, u, gw, { now: T('2026-10-05T01:05:00Z') });
        expect(gw.sent.some((m) => m.message.startsWith('Repayment'))).toBe(true);
    });
});

describe('late-payment reminders through the queue', () => {
    const due = (extra = {}) => {
        const u = books();
        Object.assign(u.debtors[0], { dueISO: '2026-10-04', [FIELDS.REMIND]: true, [FIELDS.REMIND_AT]: NOW - 86400e3 * 3, [FIELDS.ENABLED_AT]: NOW - 86400e3 * 3, ...extra });
        u.debtors[0].events = [{ id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-01', confirmed: true, at: NOW - 3 * 86400e3 }];
        return u;
    };
    const lateDocs = (fs) => ledger(fs).filter((d) => d.kind === 'B.late');

    it('goes out in the morning where the debtor is, once, with the balance and the date, and never twice', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const night = T('2026-10-04T20:00:00Z');                         // 01:30 on the 5th in Colombo: the day after the date has begun, the window has not opened
        await run(db, due(), gw, { now: night });
        expect(lateDocs(fs)).toHaveLength(1);
        expect(lateDocs(fs)[0]).toMatchObject({ status: STATUS.QUEUED, scheduled: true });
        expect(lateDocs(fs)[0].nextAttemptAt).toBe(T('2026-10-05T02:30:00Z'));      // 08:00 Colombo
        expect(gw.sent.some((m) => m.message.startsWith('Reminder'))).toBe(false);

        await run(db, due(), gw, { now: T('2026-10-05T03:00:00Z') });
        const sent = gw.sent.filter((m) => m.message.startsWith('Reminder'));
        expect(sent).toHaveLength(1);
        expect(sent[0].message).toMatch(/^Reminder: LKR 50,000\.00 is still outstanding, due 04 Oct 2026, ref DEB-[0-9A-F]{6}\. Statement: https:/);
        await run(db, due(), gw, { now: T('2026-10-05T09:00:00Z') });
        expect(gw.sent.filter((m) => m.message.startsWith('Reminder'))).toHaveLength(1);
    });

    it('is cancelled before it goes if the money arrives first (the morning\'s payment, confirmed before 08:00)', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, due(), gw, { now: T('2026-10-04T20:00:00Z') });
        expect(lateDocs(fs)[0].status).toBe(STATUS.QUEUED);
        const paid = due();
        paid.debtors[0].events.push({ id: 'e9', kind: 'repayment', amount: 50000, date: '2026-10-05', confirmed: true, at: T('2026-10-04T23:00:00Z') });
        const r = await run(db, paid, gw, { now: T('2026-10-05T03:00:00Z') });
        expect(r.cancelled).toBeGreaterThanOrEqual(1);
        expect(lateDocs(fs)[0].status).toBe(STATUS.CANCELLED);
        expect(gw.sent.some((m) => m.message.startsWith('Reminder'))).toBe(false);
    });

    it('held for credit for more than a day, it is dropped, not sent with a balance that may have moved', async () => {
        const { fs, db } = makeDb();
        const broke = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: false, message: 'out of units' }));
        await run(db, due(), broke, { now: T('2026-10-05T03:00:00Z') });
        expect(lateDocs(fs)[0]).toMatchObject({ status: STATUS.QUEUED, lastError: { kind: KIND.CREDIT } });
        const gw = gateway();
        await run(db, due(), gw, { now: T('2026-10-07T03:00:00Z') });
        expect(gw.sent.some((m) => m.message.startsWith('Reminder'))).toBe(false);
        expect(['cancelled', 'expired']).toContain(lateDocs(fs)[0].status);
    });

    it('the owner\'s message log is told the text is a scheduled one, so it can say why it is waiting', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, due(), gw, { now: T('2026-10-04T20:00:00Z') });
        const row = mirrorDocs(fs).find((m) => m.kind === 'B.late');
        expect(row).toMatchObject({ status: STATUS.QUEUED, scheduled: true });
        await run(db, due(), gw, { now: T('2026-10-05T03:00:00Z') });
        expect(mirrorDocs(fs).find((m) => m.kind === 'B.late')).toMatchObject({ status: STATUS.SENT, scheduled: true });
    });

    it('five sweeps racing for the same reminder send one text', async () => {
        const { db } = makeDb(); const gw = gateway();
        await Promise.all([1, 2, 3, 4, 5].map(() => run(db, due(), gw, { now: T('2026-10-05T03:00:00Z') })));
        expect(gw.sent.filter((m) => m.message.startsWith('Reminder'))).toHaveLength(1);
    });

    it('with the box unticked nothing is queued, however late they are', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, due({ [FIELDS.REMIND]: false }), gw, { now: T('2026-10-05T03:00:00Z') });
        expect(lateDocs(fs)).toHaveLength(0);
    });
});

describe('a second number: every text goes to both, each tracked on its own', () => {
    const with2 = (phone2 = '+44 7911 123456') => { const u = books(); u.debtors[0][FIELDS.PHONE2] = phone2; return u; };
    const settled = (phone2) => {
        const u = with2(phone2);
        u.debtors[0].events[1] = { id: 'e2', kind: 'repayment', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 600e3 };
        return u;
    };

    it('both numbers get each text, once, and a second sweep sends nothing', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        const a = await run(db, with2(), gw);
        expect(a).toMatchObject({ derived: 4, sent: 4 });
        expect(gw.sent.filter((m) => m.to === '+94771234567')).toHaveLength(2);
        expect(gw.sent.filter((m) => m.to === '+447911123456')).toHaveLength(2);
        expect(ledger(fs).filter((d) => d.key.endsWith(':2'))).toHaveLength(2);
        const b = await run(db, with2(), gw);
        expect(b.sent).toBe(0);
        expect(gw.sent).toHaveLength(4);
    });

    it('five sweeps racing still send each text to each number once', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await Promise.all([1, 2, 3, 4, 5].map(() => run(db, with2(), gw)));
        expect(gw.sent).toHaveLength(4);
        expect(ledger(fs).every((d) => d.status === STATUS.SENT && d.attempts === 1)).toBe(true);
    });

    it('the second number is cancelled before it is sent when the owner takes it off, and the first number is untouched', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'Insufficient balance' }));
        await run(db, with2(), gw);
        expect(ledger(fs).every((d) => d.status === STATUS.QUEUED)).toBe(true);
        const gw2 = gateway();
        const r = await run(db, books(), gw2, { now: NOW + HOLD_MS + 1000 });
        expect(r.cancelled).toBe(2);
        expect(ledger(fs).filter((d) => d.key.endsWith(':2')).every((d) => d.status === STATUS.CANCELLED)).toBe(true);
        expect(gw2.sent.map((m) => m.to)).toEqual(['+94771234567', '+94771234567']);
    });

    it('a corrected second number reaches only the second number\'s held texts', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(() => ({ ok: false, kind: KIND.CREDIT, retryable: true, message: 'Insufficient balance' }));
        await run(db, with2('+44 7911 123456'), gw);
        const before = ledger(fs).find((d) => d.key === 'B:d1:e1:out');
        const r = await enqueue({ db, uid: UID, events: deriveEvents(with2('+971 50 123 4567'), NOW).events, now: NOW + 60e3, env, deps: {} });
        expect(r.rephoned).toBe(2);
        const after = ledger(fs);
        expect(after.filter((d) => d.key.endsWith(':2')).every((d) => d.to === '+971501234567')).toBe(true);
        expect(after.find((d) => d.key === 'B:d1:e1:out')).toEqual(before);
    });

    it('a number that can never receive fails on its own: the other number still gets its text and nothing is retried', async () => {
        const { fs, db } = makeDb();
        const gw = gateway(({ to }) => (to === '+447911123456' ? { ok: false, kind: KIND.DESTINATION, retryable: false, message: 'no route to this country' } : { ok: true, gatewayId: 'g', cost: 1, segments: 1 }));
        const a = await run(db, with2(), gw);
        expect(a).toMatchObject({ sent: 2, failed: 2, retry: 0 });
        expect(ledger(fs).filter((d) => d.to === '+94771234567').every((d) => d.status === STATUS.SENT)).toBe(true);
        expect(ledger(fs).filter((d) => d.to === '+447911123456').every((d) => d.status === STATUS.FAILED && d.lastError.kind === KIND.DESTINATION)).toBe(true);
        const calls = gw.sent.length;
        await run(db, with2(), gw, { now: NOW + 3 * 3600e3 });
        expect(gw.sent.length).toBe(calls);
    });

    it('the day\'s limit per number is counted per number: two numbers each get their first text under a limit of one', async () => {
        const { db } = makeDb(); const gw = gateway();
        const u = with2();
        u.debtors[0].events = [{ id: 'e1', kind: 'lent', amount: 50000, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 }];
        const a = await run(db, u, gw, { limits: { ...LIMITS, perRecipientPerDay: 1 } });
        expect(a.sent).toBe(2);
        expect(gw.sent.map((m) => m.to).sort()).toEqual(['+447911123456', '+94771234567']);
    });

    it('the second number is never given a text the first number was not owed (an unconfirmed repayment is neither)', async () => {
        const { db } = makeDb(); const gw = gateway();
        const u = with2();
        u.debtors[0].events[1].confirmed = false;
        await run(db, u, gw);
        expect(gw.sent.filter((m) => m.to === '+447911123456').map((m) => m.message)).toEqual(gw.sent.filter((m) => m.to === '+94771234567').map((m) => m.message));
        expect(gw.sent.every((m) => !/^Repayment/.test(m.message))).toBe(true);
    });

    it('the receipt reaches each number before the "loan closed" text, even when the receipt is the slow one', async () => {
        const { db } = makeDb();
        const arrived = [];
        const gw = {
            configured: true, senderId: 'WealthFlow',
            async send({ to, message }) {
                await new Promise((r) => setTimeout(r, /^Repayment/.test(message) ? 25 : 1));        // the receipt is the slow one
                arrived.push({ to, kind: /^Repayment/.test(message) ? 'receipt' : /settled and closed/.test(message) ? 'closed' : 'other' });
                return { ok: true, gatewayId: 'g', cost: 1, segments: 1 };
            },
        };
        await run(db, settled(), gw);
        for (const to of ['+94771234567', '+447911123456']) {
            const mine = arrived.filter((a) => a.to === to && a.kind !== 'other').map((a) => a.kind);
            expect(mine).toEqual(['receipt', 'closed']);
        }
    });

    it('a loan settled in full sends its closing text to both numbers, and once', async () => {
        const { fs, db } = makeDb(); const gw = gateway();
        await run(db, settled(), gw);
        await run(db, settled(), gw, { now: NOW + 3600e3 });
        const closing = gw.sent.filter((m) => /settled and closed/.test(m.message));
        expect(closing.map((m) => m.to).sort()).toEqual(['+447911123456', '+94771234567']);
        expect(ledger(fs).filter((d) => d.kind === 'B.closed')).toHaveLength(2);
    });
});
