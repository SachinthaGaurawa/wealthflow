import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { checkDelivery, enqueue, sweepUser, STATUS, DELIVERY_CHECKS_PER_RUN, DELIVERY_CONCURRENCY, ENQUEUE_SHARE } from '../sms-engine.mjs';
import { deriveEvents, FIELDS } from '../sms-events.mjs';

/* THE SWEEP KEEPS TO ITS TIME.
 * Production, 2026-10-11: `[WF-SLOW]` on /api/sms-notify. `budgetMs` gated only the START of each send; putting notices in the ledger (a transaction each, up to 600) and asking the gateway what
 * became of recent texts (a request each, up to 25 one after the other, each allowed 12 s) had no limit at all. They now stop when the time is up and leave their work in the ledger for the next run. */

afterEach(() => vi.restoreAllMocks());

const UID = 'owner1', T = iso => Date.parse(iso), NOW = T('2026-10-05T05:00:00Z');
const sentDoc = (n, extra = {}) => ({ key: `K${n}`, kind: 'B.out', ref: `R${n}`, status: STATUS.SENT, gatewayId: `gw-${String(n).padStart(4, '0')}`, sentAt: NOW - 3600e3, dlrPending: true, toMasked: '+94*****4567', body: 'x', ...extra });
function ledgerWith(count, extra) {
    const seed = {};
    for (let n = 1; n <= count; n++) seed[`wf-sms/${UID}/events/doc${String(n).padStart(3, '0')}`] = sentDoc(n, extra && extra(n));
    return createFirestore(seed);
}
const pending = fs => [...fs.data.entries()].filter(([p, v]) => p.startsWith(`wf-sms/${UID}/events/`) && v.dlrPending === true).length;

/** A gateway whose lookups take `cost` ms of a fake clock each, and answer "delivered". */
function slowGateway(clock, cost, state = 'delivered') {
    const seen = []; let inFlight = 0, peak = 0;
    return {
        configured: true, seen, get peak() { return peak; },
        async lookup(id) { inFlight += 1; peak = Math.max(peak, inFlight); clock.t += cost; seen.push(id); await Promise.resolve(); inFlight -= 1; return { ok: true, state, raw: 'Delivered' }; },
    };
}
const fakeClock = (t = 1_000_000) => { const c = { t, now: () => c.t }; return c; };

describe('asking the gateway what became of the recent texts', () => {
    it('with no time at all it asks nothing and changes nothing', async () => {
        const { fs, db } = (({ db, data }) => ({ fs: { data }, db }))(ledgerWith(10));
        const clock = fakeClock(), gw = slowGateway(clock, 1000);
        const out = await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: clock.t, clock: clock.now });
        expect(out).toEqual({ checked: 0, delivered: 0, undelivered: 0 });
        expect(gw.seen).toEqual([]);
        expect(pending(fs)).toBe(10);
    });
    it('stops starting lookups when the time is up, leaves the rest waiting, and the next run takes them up — each text asked about once', async () => {
        const { db, data } = ledgerWith(20), fs = { data };
        const clock = fakeClock(), gw = slowGateway(clock, 3000);
        const first = await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: clock.t + 10000, clock: clock.now });
        expect(first.checked).toBeGreaterThan(0); expect(first.checked).toBeLessThan(20);
        expect(pending(fs)).toBe(20 - first.delivered);                      // what was not reached is still waiting for the gateway's word
        let guard = 0;
        while (pending(fs) > 0 && guard++ < 20) await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: clock.t + 10000, clock: clock.now });
        expect(pending(fs)).toBe(0);
        expect(gw.seen).toHaveLength(20);
        expect(new Set(gw.seen).size).toBe(20);                              // none asked twice, none missed
    });
    it('asks a few at a time — more than one, never more than the limit', async () => {
        const { db } = ledgerWith(25);
        const clock = fakeClock(), gw = slowGateway(clock, 1);
        await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: clock.t + 1e9, clock: clock.now });
        expect(gw.peak).toBeGreaterThan(1);
        expect(gw.peak).toBeLessThanOrEqual(DELIVERY_CONCURRENCY);
    });
    it('a run asks about at most DELIVERY_CHECKS_PER_RUN texts, as before', async () => {
        const { db } = ledgerWith(60);
        const clock = fakeClock(), gw = slowGateway(clock, 1);
        const out = await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: clock.t + 1e9, clock: clock.now });
        expect(out.checked).toBe(DELIVERY_CHECKS_PER_RUN); expect(gw.seen).toHaveLength(DELIVERY_CHECKS_PER_RUN);
    });
    it('a gateway that never answers cannot hold the sweep past its time', async () => {
        const { db, data } = ledgerWith(5), fs = { data };
        const gw = { configured: true, lookup: () => new Promise(() => {}) };
        const began = Date.now();
        const out = await checkDelivery({ db, uid: UID, client: gw, now: NOW, until: began + 80 });
        expect(Date.now() - began).toBeLessThan(2000);
        expect(out.delivered + out.undelivered).toBe(0);
        expect(pending(fs)).toBe(5);                                         // nothing is decided on no answer
    });
    it('a lookup that throws changes nothing and does not stop the others', async () => {
        const { db, data } = ledgerWith(4), fs = { data };
        let n = 0;
        const gw = { configured: true, lookup: async () => { n += 1; if (n === 2) throw new Error('boom'); return { ok: true, state: 'delivered', raw: 'Delivered' }; } };
        const out = await checkDelivery({ db, uid: UID, client: gw, now: NOW });
        expect(out).toMatchObject({ checked: 4, delivered: 3 });
        expect(pending(fs)).toBe(1);
    });
    it('without a deadline it behaves exactly as it always did (no limit but the per-run count)', async () => {
        const { db, data } = ledgerWith(8), fs = { data };
        const clock = fakeClock(), gw = slowGateway(clock, 60000);
        const out = await checkDelivery({ db, uid: UID, client: gw, now: NOW });
        expect(out).toMatchObject({ checked: 8, delivered: 8 }); expect(pending(fs)).toBe(0);
    });
    it('texts the gateway can no longer be asked about are closed while there is time, and left for the next run when there is not', async () => {
        const old = n => ({ sentAt: NOW - 5 * 86400e3, ...(n > 0 ? {} : {}) });
        const first = ledgerWith(3, old), clock = fakeClock();
        await checkDelivery({ db: first.db, uid: UID, client: slowGateway(clock, 1), now: NOW, until: clock.t + 1e9, clock: clock.now });
        expect(pending({ data: first.data })).toBe(0);
        const second = ledgerWith(3, old);
        await checkDelivery({ db: second.db, uid: UID, client: slowGateway(clock, 1), now: NOW, until: clock.t, clock: clock.now });
        expect(pending({ data: second.data })).toBe(3);
    });
});

describe('putting the owed notices in the ledger', () => {
    function books(count) {
        return {
            settings: { currency: 'LKR' },
            debtors: Array.from({ length: count }, (_, i) => ({
                id: `d${i}`, name: `Person ${i}`, phone: `077 ${String(1000000 + i)}`, nic: '', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3,
                events: [{ id: 'e1', kind: 'lent', amount: 1000 + i, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 }],
            })),
        };
    }
    const ledgerKeys = data => [...data.keys()].filter(p => p.startsWith(`wf-sms/${UID}/events/`));

    it('stops looking when the time is up, says how many it left and where, and each next run takes the list from there — all queued, none twice', async () => {
        const { db, data } = createFirestore();
        const { events } = deriveEvents(books(30), NOW);
        expect(events.length).toBe(30);
        const clock = fakeClock(), tick = db.runTransaction.bind(db);
        db.runTransaction = fn => { clock.t += 1000; return tick(fn); };    // each transaction costs a second of the fake clock
        const first = await enqueue({ db, uid: UID, events, now: NOW, env: {}, until: clock.t + 8000, clock: clock.now });
        expect(first.created).toBeGreaterThan(0); expect(first.created).toBeLessThan(30);
        expect(first.deferred).toBe(30 - first.created);
        expect(first.resume).toBe(first.created);                            // the first notice it had no time for
        let total = first.created, guard = 0, last = first;
        while (total < 30 && guard++ < 20) { last = await enqueue({ db, uid: UID, events, now: NOW, env: {}, until: clock.t + 8000, clock: clock.now, from: last.resume }); total += last.created; }
        expect(total).toBe(30);
        expect(ledgerKeys(data)).toHaveLength(30);                           // none twice (the ones already there are only looked at)
        // given the time, a run takes the whole list and has nothing to resume
        const whole = await enqueue({ db, uid: UID, events, now: NOW, env: {}, until: clock.t + 60000, clock: clock.now, from: 7 });
        expect(whole).toMatchObject({ created: 0, existing: 30 }); expect(whole.deferred).toBeUndefined(); expect(whole.resume).toBeUndefined();
    });
    it('a place to resume from that no longer fits the list starts at the first notice', async () => {
        const { db } = createFirestore();
        const { events } = deriveEvents(books(5), NOW);
        for (const from of [-3, 0, 5, 99, 2.5, NaN, undefined, '3']) {
            const out = await enqueue({ db, uid: UID, events, now: NOW, env: {}, from });
            expect(out.created + out.existing).toBe(5);
        }
    });
    it('with no deadline nothing is deferred, as before', async () => {
        const { db, data } = createFirestore();
        const { events } = deriveEvents(books(12), NOW);
        const out = await enqueue({ db, uid: UID, events, now: NOW, env: {} });
        expect(out.created).toBe(12); expect(out.deferred).toBeUndefined(); expect(ledgerKeys(data)).toHaveLength(12);
    });
});

describe('the whole sweep', () => {
    const user = (count = 16) => ({
        settings: { currency: 'LKR' },
        debtors: Array.from({ length: count }, (_, i) => ({
            id: `d${i}`, name: `Person ${i}`, phone: `077 ${String(1000000 + i)}`, nic: '', [FIELDS.ENABLED]: true, [FIELDS.ENABLED_AT]: NOW - 3600e3,
            events: [{ id: 'e1', kind: 'lent', amount: 1000 + i, date: '2026-10-05', confirmed: true, at: NOW - 1800e3 }],
        })),
    });
    const gateway = () => { const sent = []; return { configured: true, senderId: 'WealthFlow', sent, balanceCalls: 0, async send({ to, message }) { sent.push({ to, message }); return { ok: true, gatewayId: `g${sent.length}x`, cost: 1, segments: 1 }; }, async balance() { this.balanceCalls += 1; return { ok: true, units: 500 }; } }; };

    it('says where its time went', async () => {
        const { db } = createFirestore();
        const summary = await sweepUser({ db, uid: UID, user: user(), client: gateway(), now: NOW, env: {} });
        expect(Object.keys(summary.phases)).toEqual(['derive', 'enqueue', 'send', 'delivery', 'status', 'total']);
        for (const value of Object.values(summary.phases)) expect(Number.isFinite(value) && value >= 0).toBe(true);
    });
    it('a sweep that is out of time while queueing defers the rest, keeps where it stopped, and the sweeps that follow lose none and send none twice', async () => {
        const { db, data } = createFirestore();
        let wall = 1_900_000_000_000;
        vi.spyOn(Date, 'now').mockImplementation(() => wall);
        const tick = db.runTransaction.bind(db);
        db.runTransaction = fn => { wall += 300; return tick(fn); };          // each transaction costs 0.3 s
        const gw = gateway(), people = user(45);
        const sweep = () => sweepUser({ db, uid: UID, user: people, client: gw, now: NOW, env: {}, budgetMs: 10000, deps: { random: () => 0.5 } });
        const first = await sweep();
        expect(first.enqueued.deferred).toBeGreaterThan(0);
        expect(data.get(`wf-sms/${UID}`).enqueueFrom).toBe(first.enqueued.resume);
        expect(ENQUEUE_SHARE).toBeLessThan(1);
        let guard = 0, last = first;
        while (gw.sent.length < 45 && guard++ < 80) last = await sweep();
        expect(gw.sent).toHaveLength(45);
        expect(new Set(gw.sent.map(m => m.to)).size).toBe(45);                // forty-five people, one text each
        expect([...data.keys()].filter(p => p.startsWith(`wf-sms/${UID}/events/`))).toHaveLength(45);
        // a sweep with the time for the whole list finishes the round, and the next one starts from the first notice again
        const whole = await sweepUser({ db, uid: UID, user: people, client: gw, now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(whole.enqueued.deferred).toBeUndefined();
        expect(data.get(`wf-sms/${UID}`).enqueueFrom).toBe(0);
        expect(last).toBeTruthy();
    });
    it('a small list never reads or writes a place to resume from', async () => {
        const { db, data } = createFirestore();
        await sweepUser({ db, uid: UID, user: user(5), client: gateway(), now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(data.has(`wf-sms/${UID}`)).toBe(false);
    });
    it('does not ask for the balance when the time is spent, and does when there is plenty', async () => {
        const spent = gateway(), plenty = gateway();
        await sweepUser({ db: createFirestore().db, uid: UID, user: user(), client: spent, now: NOW, env: {}, budgetMs: 2000, deps: { random: () => 0.5 } });
        await sweepUser({ db: createFirestore().db, uid: UID, user: user(), client: plenty, now: NOW, env: {}, deps: { random: () => 0.5 } });
        expect(spent.balanceCalls).toBe(0);
        expect(plenty.balanceCalls).toBe(1);
    });
});
