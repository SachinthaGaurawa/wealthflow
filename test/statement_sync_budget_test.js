import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { runSteps } from '../statement-budget.mjs';
import { runStatementSync } from '../statement-sync.js';

/* THE HOUSEKEEPING AT THE END OF A RUN STOPS WHEN THE TIME IS UP AND CARRIES ON FROM WHERE IT STOPPED.
 * Production, 2026-10-11 (`/api/statement-sync` GET: 60 s timeout) and 10-12 (`[WF-SLOW]`): the six heals at the end of the daily run were gated once, before the first, and stamped "done"
 * afterwards. A run that began them late could not stop between two of them. */

afterEach(() => vi.restoreAllMocks());

describe('runSteps: the clock is looked at before each step', () => {
    const clock = (start = 1000) => { const c = { t: start, now: () => c.t }; return c; };
    const stepsOf = (c, costs, log = [], fail = []) => costs.map((cost, i) => ({ name: `s${i}`, run: async () => { c.t += cost; log.push(`s${i}`); if (fail.includes(i)) throw new Error('boom'); } }));

    it('runs every step, in order, when there is time — and says it reached the end', async () => {
        const c = clock(), log = [];
        const out = await runSteps({ steps: stepsOf(c, [10, 10, 10], log), until: 1000 + 1000, now: c.now });
        expect(log).toEqual(['s0', 's1', 's2']);
        expect(out).toMatchObject({ done: true, next: 0, failed: [], skipped: [] });
        expect(out.ran).toEqual(['s0', 's1', 's2']);
        expect(out.ms).toEqual({ s0: 10, s1: 10, s2: 10 });
    });
    it('stops BEFORE a step when the time is up, names what is left, and says where to start next', async () => {
        const c = clock(), log = [];
        const out = await runSteps({ steps: stepsOf(c, [400, 400, 400, 400], log), until: 1000 + 700, now: c.now });
        expect(log).toEqual(['s0', 's1']);                                   // s1 began at 400 < 700; s2 would begin at 800 ≥ 700
        expect(out).toMatchObject({ done: false, next: 2, skipped: ['s2', 's3'] });
    });
    it('the next pass starts where the last one stopped, and a pass that reaches the end starts over', async () => {
        const c = clock(), log = [];
        const steps = stepsOf(c, [400, 400, 400, 400], log);
        const first = await runSteps({ steps, until: 1000 + 700, now: c.now });
        const second = await runSteps({ steps, from: first.next, until: c.t + 700, now: c.now });
        expect(log).toEqual(['s0', 's1', 's2', 's3']);                       // nothing skipped, nothing run twice
        expect(second).toMatchObject({ done: true, next: 0, skipped: [] });
        expect(second.ran).toEqual(['s2', 's3']);
    });
    it('with no time at all it starts nothing', async () => {
        const c = clock(), log = [];
        const out = await runSteps({ steps: stepsOf(c, [1, 1], log), until: 1000, now: c.now });
        expect(log).toEqual([]);
        expect(out).toMatchObject({ done: false, next: 0, skipped: ['s0', 's1'] });
    });
    it('a step that throws does not stop the others — it is named, and its message is not carried', async () => {
        const c = clock(), log = [];
        const out = await runSteps({ steps: stepsOf(c, [1, 1, 1], log, [1]), until: 5000, now: c.now });
        expect(log).toEqual(['s0', 's1', 's2']);
        expect(out).toMatchObject({ done: true, failed: ['s1'], ran: ['s0', 's2'] });
        expect(JSON.stringify(out)).not.toMatch(/boom/);
    });
    it.each([[undefined], [null], [-1], [99], [2.5], ['3'], [NaN]])('a place that is not a step number (%s) starts at the first step', async (from) => {
        const c = clock(), log = [];
        await runSteps({ steps: stepsOf(c, [1, 1, 1], log), from, until: 5000, now: c.now });
        expect(log).toEqual(['s0', 's1', 's2']);
    });
});

describe('the daily run: the six heals share the time that is left', () => {
    const owner = { uid: 'u', email: 'owner@example.com' };
    const mailPath = 'wf-mail/owner_example_com';
    const T0 = 1_900_000_000_000;

    /** A run with nothing to process, so the tail is all there is. Each read of the owner's document costs `readMs` of the (fake) clock — as a big document did. */
    async function run({ mail = {}, readMs }) {
        const seeded = createFirestore({
            [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: T0, lastCensusMs: T0, lastRecoveryMs: T0, ...mail },
            'users/u': { expenses: [], incomeRecv: [], cconetime: [], ccPayments: [], loans: [] },
        });
        let now = T0;
        vi.spyOn(Date, 'now').mockImplementation(() => now);
        const collection = seeded.db.collection;
        seeded.db.collection = name => { if (name === 'users') now += readMs; return collection(name); };
        const lines = [];
        vi.spyOn(console, 'info').mockImplementation(line => { lines.push(String(line)); });
        const f = async () => ({ ok: true, json: async () => ({ access_token: 'token' }) });
        const result = await runStatementSync({ action: 'drain', interactive: false, budgetMs: 38000, db: seeded.db, owner, env: {}, f, startedAt: now });
        const log = lines.map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).find(l => l && l.evt === 'statement-sync-run');
        return { result, log, mail: seeded.data.get(mailPath), elapsed: now - T0 };
    }

    it('with time to spare all six run, the pass is stamped, and the place to resume from is cleared', async () => {
        const { log, mail } = await run({ readMs: 1 });
        expect(log.tail.heal.ran).toBe(6);
        expect(log.tail.heal.skipped).toBeUndefined();
        expect(mail.lastLoanHealMs).toBeGreaterThan(0);
        expect(mail.loanHealNext).toBe(0);
    });
    it('when the reads are slow the pass stops between two heals, is NOT stamped, and keeps the place it stopped at', async () => {
        const { log, mail, elapsed } = await run({ readMs: 11000 });
        expect(log.tail.heal.ran).toBeLessThan(6);
        expect(log.tail.heal.skipped.length).toBe(6 - log.tail.heal.ran);
        expect(mail.lastLoanHealMs).toBeUndefined();
        expect(mail.loanHealNext).toBe(log.tail.heal.ran);
        expect(elapsed).toBeLessThan(60000);                                 // the run answered inside the platform's limit
    });
    it('the next run carries on from that heal, finishes the pass and starts the half hour from there', async () => {
        const first = await run({ readMs: 11000 });
        vi.restoreAllMocks();
        const second = await run({ readMs: 1, mail: { loanHealNext: first.mail.loanHealNext } });
        expect(second.log.tail.heal.ran).toBe(6 - first.mail.loanHealNext);
        expect(second.mail.lastLoanHealMs).toBeGreaterThan(0);
        expect(second.mail.loanHealNext).toBe(0);
    });
    it('a run with no time left for the tail does not start it at all, and changes nothing', async () => {
        const late = createFirestore({ [mailPath]: { uid: 'u', email: owner.email, refresh_token: 'r', autonomous: true, lastSettleMs: T0, lastCensusMs: T0, lastRecoveryMs: T0 }, 'users/u': { expenses: [] } });
        vi.spyOn(Date, 'now').mockImplementation(() => T0 + 40000);               // the run was started 40 s ago
        vi.spyOn(console, 'info').mockImplementation(() => {});
        await runStatementSync({ action: 'drain', interactive: false, budgetMs: 38000, db: late.db, owner, env: {}, f: async () => ({ ok: true, json: async () => ({ access_token: 'token' }) }), startedAt: T0 });
        expect(late.data.get(mailPath).lastLoanHealMs).toBeUndefined();
        expect(late.data.get(mailPath).loanHealNext).toBeUndefined();
    });
});
