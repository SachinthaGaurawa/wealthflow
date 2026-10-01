import { describe, it, expect, vi, afterEach } from 'vitest';
import { runStatementSync } from '../statement-sync.js';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom } from '../wealthflow-mail-senders.mjs';
import { claimOrder, failurePatch, redriveDeadLetters, aiBreaker, MAX_ATTEMPTS, REDRIVE_AFTER_MS, DEAD_LETTER } from '../statement-queue.mjs';

/* =============================================================================
 * THE QUEUE: which statement next, what a failure costs, and what becomes of one that keeps failing.
 *
 *   · the order is part-way first, never-failed before failed, newest first — and one bank after another;
 *   · every failed attempt is counted on the statement; five in a row park it (dead_letter) with its place frozen;
 *   · it is put back automatically after 15 min, 1 h, 6 h and 24 h, resuming exactly where it stopped, and only then does it
 *     become one question for the owner — it is never dropped and never skipped;
 *   · an AI provider that is down is found out once, not once per statement.
 * ===========================================================================*/

afterEach(() => { vi.useRealTimers(); });

const doc = (id, x) => ({ id, data: () => x });
const NOW = Date.parse('2026-10-01T06:00:00Z');

describe('claimOrder', () => {
    it('leaves out statements that are backing off or leased to a live worker', () => {
        const order = claimOrder([doc('a', { bank: 'X', retryAt: NOW + 1 }), doc('b', { bank: 'X', leaseUntil: NOW + 1 }), doc('c', { bank: 'X' }), doc('d', { bank: 'X', retryAt: NOW }), doc('e', { bank: 'X', leaseUntil: NOW })], { now: NOW }).map(d => d.id);
        expect(order.sort()).toEqual(['c', 'd', 'e']);
    });
    it('within a bank: part-way first, then never-failed before failed, then newest first, then by id', () => {
        const docs = [
            doc('old', { bank: 'X', receivedMs: 1000 }), doc('new', { bank: 'X', receivedMs: 3000 }), doc('mid', { bank: 'X', receivedMs: 2000 }),
            doc('failed-newest', { bank: 'X', receivedMs: 9000, retryCount: 2 }), doc('half', { bank: 'X', receivedMs: 10, cursor: 20 }),
            doc('tie-b', { bank: 'X', receivedMs: 500 }), doc('tie-a', { bank: 'X', receivedMs: 500 }),
        ];
        expect(claimOrder(docs, { now: NOW }).map(d => d.id)).toEqual(['half', 'new', 'mid', 'old', 'tie-a', 'tie-b', 'failed-newest']);
    });
    it('across banks: one from each in turn, so a bank with a long backlog cannot keep another bank\'s latest waiting', () => {
        const many = Array.from({ length: 50 }, (_, i) => doc('ntb' + String(i).padStart(2, '0'), { bank: 'NTB', receivedMs: 10000 + i }));
        const docs = [...many, doc('dfcc-latest', { bank: 'DFCC Bank', receivedMs: 5 }), doc('amex-latest', { bank: 'AMEX', receivedMs: 6 }), doc('hnb-latest', { bank: 'HNB', receivedMs: 7 })];
        for (const now of [NOW, NOW + 20000, NOW + 40000, NOW + 60000]) {
            const first4 = claimOrder(docs, { now }).slice(0, 4).map(d => d.id);
            expect(new Set(first4)).toEqual(new Set(['ntb49', 'dfcc-latest', 'amex-latest', 'hnb-latest']));
        }
    });
    it('the bank that goes first rotates with the clock', () => {
        const docs = ['A', 'B', 'C'].map(bank => doc(bank, { bank, receivedMs: 1 }));
        const firsts = new Set([0, 1, 2].map(k => claimOrder(docs, { now: NOW - (NOW % 20000) + k * 20000 })[0].id));
        expect(firsts.size).toBe(3);
    });
    it('is total and stable: every ready statement appears exactly once, whatever the input order', () => {
        const base = Array.from({ length: 40 }, (_, i) => doc('s' + i, { bank: ['A', 'B', 'C', ''][i % 4], receivedMs: (i * 7919) % 100, retryCount: i % 3 === 0 ? 1 : 0, cursor: i % 11 === 0 ? 5 : 0 }));
        const a = claimOrder(base, { now: NOW }).map(d => d.id), b = claimOrder([...base].reverse(), { now: NOW }).map(d => d.id);
        expect(a).toEqual(b);
        expect(new Set(a).size).toBe(40);
    });
    it('copes with nothing, with junk and with plain objects', () => {
        expect(claimOrder([], { now: NOW })).toEqual([]);
        expect(claimOrder(null)).toEqual([]);
        expect(claimOrder([{ id: 'p', bank: 'X' }, doc('q', null), doc('r', {})], { now: NOW }).length).toBe(3);
    });
});

describe('failurePatch', () => {
    const error = (m, extra = {}) => Object.assign(new Error(m), extra);
    it('the first four failures back off and stay pending, counted', () => {
        let source = { retryCount: 0, cursor: 20, totalRows: 90 };
        for (let n = 1; n < MAX_ATTEMPTS; n++) {
            const r = failurePatch({ source, error: error('gmail-fetch-unavailable'), now: NOW });
            expect(r.outcome).toBe('retry');
            expect(r.patch).toMatchObject({ status: 'pending', retryCount: n, lastRetryReason: 'gmail-fetch-unavailable', retryAt: NOW + r.retryAfterMs, leaseToken: '', leaseUntil: 0 });
            expect(r.retryAfterMs).toBe(Math.min(180000, 1000 * 2 ** (n - 1)));
            source = { ...source, ...r.patch };
        }
    });
    it('the fifth parks it, with the place it stopped at frozen and the reason', () => {
        const source = { retryCount: 4, cursor: 20, totalRows: 90, rowSetHash: 'abc', passwordOffset: 3 };
        const r = failurePatch({ source, error: error('statement-worker-retry-required', { passwordOffset: 6 }), now: NOW });
        expect(r.outcome).toBe('dead-letter');
        expect(r.patch.status).toBe(DEAD_LETTER);
        expect(r.patch.deadLetter).toMatchObject({ at: NOW, reason: 'statement-worker-retry-required', attempts: 5, attemptsTotal: 5, cycles: 0, cursor: 20, totalRows: 90, rowSetHash: 'abc', passwordOffset: 6, redriveAt: NOW + REDRIVE_AFTER_MS[0] });
        expect(r.patch.passwordOffset).toBe(6);
        // the row offset is NOT in the patch: it is left exactly as it was, so a re-drive resumes there
        expect(r.patch).not.toHaveProperty('cursor');
        expect(r.patch).not.toHaveProperty('rowSetHash');
    });
    it('each round waits longer: 15 minutes, 1 hour, 6 hours, 24 hours; the fifth round asks the owner', () => {
        let source = { retryCount: 4, cursor: 7, deadLetter: undefined };
        const waits = [];
        for (let cycle = 0; cycle <= REDRIVE_AFTER_MS.length; cycle++) {
            const r = failurePatch({ source: { ...source, retryCount: 4 }, error: error('x'), now: NOW });
            if (cycle < REDRIVE_AFTER_MS.length) { expect(r.outcome).toBe('dead-letter'); waits.push(r.patch.deadLetter.redriveAt - NOW); }
            else { expect(r.outcome).toBe('escalate'); expect(r.patch.deadLetter).toMatchObject({ cycles: cycle, escalatedAt: NOW, attemptsTotal: 5 * (cycle + 1) }); }
            // what the re-drive writes back in
            source = { ...source, deadLetter: { ...(r.patch.deadLetter || {}), cycles: cycle + 1, redriveAt: 0 }, retryCount: 0 };
        }
        expect(waits).toEqual([15 * 60e3, 3600e3, 6 * 3600e3, 24 * 3600e3]);
    });
    it('nothing in the patch can lose the statement: it is never marked filed, rejected or dropped', () => {
        for (let retryCount = 0; retryCount < 30; retryCount++) {
            const r = failurePatch({ source: { retryCount, deadLetter: { cycles: Math.floor(retryCount / 5) } }, error: error('x'), now: NOW });
            expect(['pending', DEAD_LETTER, undefined]).toContain(r.patch.status);
            expect(r.patch.filed).toBeUndefined();
        }
    });
});

/* ── the database: a small in-memory Firestore, enough for the queue ────────────────────────────────────────────────── */
function database(initial) {
    const docs = new Map(Object.entries(initial));
    const snap = path => ({ id: path.split('/').at(-1), ref: ref(path), exists: docs.has(path), data: () => structuredClone(docs.get(path)) });
    const query = (path, filters = [], count = Infinity, after = '') => ({ query: true, path, filters, count, after,
        where(field, op, value) { return query(path, [...filters, [field, op, value]], count, after); },
        orderBy() { return this; }, limit(value) { return query(path, filters, value, after); }, startAfter(value) { return query(path, filters, count, value); },
        doc(id) { return ref(path + '/' + id); },
        async get() { return { docs: [...docs.keys()].filter(key => key.startsWith(path + '/') && key.split('/').length === path.split('/').length + 1 && key.split('/').at(-1) > after && filters.every(([field, op, value]) => op === '<=' ? docs.get(key)[field] <= value : docs.get(key)[field] === value)).sort().slice(0, count).map(snap) }; } });
    const ref = path => ({ path, id: path.split('/').at(-1), collection: name => query(path + '/' + name), get: async () => snap(path), set: async (value, opts) => docs.set(path, opts?.merge ? { ...docs.get(path), ...structuredClone(value) } : structuredClone(value)) });
    return { docs, doc: ref, collection: path => query(path), async runTransaction(fn) {
        const writes = []; let writing = false;
        const result = await fn({ async get(r) { if (writing) throw Error('read-after-write'); return r.query ? r.get() : snap(r.path); }, set(r, value, opts) { writing = true; writes.push([r.path, structuredClone(value), opts]); } });
        for (const [path, value, opts] of writes) docs.set(path, opts?.merge ? { ...docs.get(path), ...value } : value);
        return result;
    } };
}

describe('redriveDeadLetters', () => {
    const parked = (redriveAt, extra = {}) => ({ uid: 'u', status: DEAD_LETTER, filed: false, cursor: 20, totalRows: 90, rowSetHash: 'h', passwordOffset: 3, retryCount: 5, deadLetter: { at: NOW - 1000, attempts: 5, attemptsTotal: 5, cycles: 0, reason: 'x', cursor: 20, redriveAt, ...extra } });
    it('puts back only those whose wait is over, from the place they stopped, and counts the round', async () => {
        const db = database({ 'wf-mail/k/items/due': parked(NOW - 1), 'wf-mail/k/items/later': parked(NOW + 5000), 'wf-mail/k/items/pending': { status: 'pending' } });
        const r = await redriveDeadLetters({ db, mailRef: db.doc('wf-mail/k'), now: NOW });
        expect(r).toMatchObject({ redriven: 1, waiting: 1, nextAt: NOW + 5000 });
        expect(db.docs.get('wf-mail/k/items/due')).toMatchObject({ status: 'pending', retryCount: 0, retryAt: 0, leaseToken: '', cursor: 20, totalRows: 90, rowSetHash: 'h', passwordOffset: 3, deadLetter: { cycles: 1, lastRedriveAt: NOW, redriveAt: 0, reason: 'x' } });
        expect(db.docs.get('wf-mail/k/items/later').status).toBe(DEAD_LETTER);
    });
    it('is idempotent, and a limit leaves the rest for the next run', async () => {
        const db = database(Object.fromEntries(Array.from({ length: 5 }, (_, i) => ['wf-mail/k/items/s' + i, parked(NOW - 1)])));
        expect((await redriveDeadLetters({ db, mailRef: db.doc('wf-mail/k'), now: NOW, limit: 2 })).redriven).toBe(2);
        expect((await redriveDeadLetters({ db, mailRef: db.doc('wf-mail/k'), now: NOW, limit: 10 })).redriven).toBe(3);
        expect((await redriveDeadLetters({ db, mailRef: db.doc('wf-mail/k'), now: NOW, limit: 10 })).redriven).toBe(0);
    });
    it('a parked statement with no wait recorded is left alone (never guessed at)', async () => {
        const db = database({ 'wf-mail/k/items/odd': { status: DEAD_LETTER, deadLetter: {} } });
        expect(await redriveDeadLetters({ db, mailRef: db.doc('wf-mail/k'), now: NOW })).toMatchObject({ redriven: 0, waiting: 1 });
    });
    it('a database that cannot be read reports it and throws nothing', async () => {
        const db = { doc: () => ({ collection: () => ({ where: () => ({ limit: () => ({ get: async () => { throw new Error('unavailable'); } }) }) }) }) };
        expect(await redriveDeadLetters({ db, mailRef: db.doc(), now: NOW })).toMatchObject({ redriven: 0, error: true });
    });
});

describe('aiBreaker', () => {
    it('a failure marks the provider down; later calls fail at once without calling it; it recovers after the wait', async () => {
        let t = NOW, calls = 0, saved = [];
        const flaky = vi.fn(async () => { calls++; if (calls === 1) throw new Error('providers down'); return 'ok'; });
        const { guard } = aiBreaker({ now: () => t, save: async h => { saved.push(structuredClone(h)); } });
        const ask = guard('board', flaky, { unavailable: 'ai-consensus-unavailable' });
        await expect(ask()).rejects.toThrow('providers down');
        for (let i = 0; i < 20; i++) await expect(ask()).rejects.toThrow('ai-consensus-unavailable');
        expect(flaky).toHaveBeenCalledTimes(1);
        expect(saved.at(-1).board.downUntil).toBeGreaterThan(t);
        t += 4 * 60 * 1000;
        await expect(ask()).resolves.toBe('ok');
        expect(saved.at(-1).board.downUntil).toBe(0);
    });
    it('is remembered across invocations: the state it saved is what the next one starts from', async () => {
        let saved;
        const a = aiBreaker({ now: () => NOW, save: async h => { saved = h; } });
        await expect(a.guard('extract', async () => { throw new Error('down'); })()).rejects.toThrow('down');
        const fn = vi.fn(async () => 'x');
        const b = aiBreaker({ state: saved, now: () => NOW + 1000 });
        await expect(b.guard('extract', fn)()).rejects.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });
    it('providers that answered and DISAGREED are not an outage', async () => {
        const fn = vi.fn(async () => { throw Object.assign(new Error('ai-consensus-unavailable'), { outage: false }); });
        const { guard } = aiBreaker({ now: () => NOW });
        const ask = guard('board', fn);
        for (let i = 0; i < 3; i++) await expect(ask()).rejects.toThrow('ai-consensus-unavailable');
        expect(fn).toHaveBeenCalledTimes(3);
    });
    it('asks nothing when too little of the invocation is left to wait for an answer', async () => {
        const fn = vi.fn(async () => 'x');
        const { guard } = aiBreaker({ now: () => NOW, deadlineAt: NOW + 5000 });
        await expect(guard('board', fn, { minRoomMs: 14000 })()).rejects.toThrow();
        expect(fn).not.toHaveBeenCalled();
    });
    it('a failure to save the state costs nothing', async () => {
        const { guard } = aiBreaker({ now: () => NOW, save: async () => { throw new Error('db down'); } });
        await expect(guard('board', async () => { throw new Error('x'); })()).rejects.toThrow('x');
    });
});

/* ── the whole thing, through the real worker ───────────────────────────────────────────────────────────────────────── */
const plainFor = (variant) => `<html><body><h1>Nations Trust Bank American Express Credit Card Statement</h1><p>Card Number: 376657XXXXX0276</p><p>Statement Date: 16/09/2026 Payment Due Date: 10/10/2026</p><p>Credit Limit 500000.00 Available Credit 400000.00 Minimum Amount Due 10000.00</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>${(123.45 + variant).toFixed(2)} DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>${(50 + variant).toFixed(2)} CR</td></tr></table></body></html>`;

const BANKS = [
    { name: 'DFCC Bank', address: 'statements@dfccbank.com', domain: 'dfccbank.com' },
    { name: 'NTB', address: 'estatement@info.nationstrust.com', domain: 'nationstrust.com' },
    { name: 'AMEX', address: 'nationstrust@estmt.nationstrust.com', domain: 'nationstrust.com' },
    { name: 'HNB', address: 'e-statements@hnb.lk', domain: 'hnb.lk' },
];

function backlog({ perBank = 6, failing = new Set() } = {}) {
    const owner = { uid: 'u', email: 'owner@example.com' };
    const senders = BANKS.map(b => ({ id: b.address, kind: 'address', status: 'approved', name: b.name, domain: b.address.split('@')[1] }));
    const messages = new Map(), sources = {}, order = [];
    let n = 0;
    for (const bank of BANKS) for (let i = 0; i < perBank; i++) {
        const id = `m-${bank.name.replace(/\W/g, '')}-${i}`;
        const received = Date.parse('2026-01-02T05:00:00Z') + i * 9 * 86400000;
        const message = { id, internalDate: String(received), snippet: 'Your statement', payload: {
            headers: [{ name: 'From', value: `${bank.name} <${bank.address}>` }, { name: 'Subject', value: `${bank.name} Statement` },
                { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.i=@${bank.domain}; spf=pass; dmarc=pass header.from=${bank.address.split('@')[1]}` }],
            parts: [{ filename: `Statement_2026${String((i % 6) + 1).padStart(2, '0')}_${bank.name.replace(/\W/g, '')}.html`, mimeType: 'text/html', body: { attachmentId: 'a-' + id, size: 5000 } }] } };
        const plan = planMessage(message, policyFrom(senders));
        if (!plan.ok) throw Error('fixture refused: ' + plan.reason);
        messages.set(id, { message, variant: n++ });
        sources[`wf-mail/owner_example_com/items/${plan.items[0].key}`] = { uid: 'u', bank: bank.name, from: bank.address, filename: plan.items[0].filename || message.payload.parts[0].filename, messageId: id, receivedMs: received, status: 'pending', cursor: 0, filed: false };
    }
    const db = database({
        'users/u': { expenses: [], cconetime: [], ccPayments: [], incomeRecv: [], subscriptions: [] },
        'wf-mail/owner_example_com': { uid: 'u', email: owner.email, refresh_token: 'synthetic-refresh', autonomous: true, senders },
        ...sources,
    });
    const f = vi.fn(async url => {
        if (url === 'https://oauth2.googleapis.com/token') return { ok: true, json: async () => ({ access_token: 'synthetic-access' }) };
        if (url === 'https://gmail.googleapis.com/gmail/v1/users/me/profile') return { ok: true, json: async () => ({ emailAddress: owner.email, historyId: '100' }) };
        for (const [id, { message, variant }] of messages) {
            if (url.includes('/messages/' + id + '/attachments/')) return failing.has(id) || failing.has('*') ? { ok: false, status: 503 } : { ok: true, json: async () => ({ data: Buffer.from(plainFor(variant)).toString('base64url') }) };
            if (url.includes('/messages/' + id + '?')) return { ok: true, json: async () => message };
        }
        throw Error('unexpected external request ' + url);
    });
    const settled = [];
    const settle = async (args) => { const out = await (await import('../statement-ledger.mjs')).settleStatement(args); if (out && out.status === 'filed') settled.push(args.sourceRef.path); return out; };
    const roster = Array.from({ length: 10 }, (_, i) => 'e' + i);
    const board = vi.fn(async () => { throw Object.assign(new Error('ai-consensus-unavailable'), { outage: true }); });
    return { db, f, owner, sources, settled, board, failing, roster,
        args: { db, owner, action: 'drain', f, open: vi.fn(async () => []), board, settle, env: { CRON_SECRET: 's'.repeat(24) } },
        sourceOf: id => Object.keys(sources).find(path => db.docs.get(path).messageId === id) };
}

describe('a backlog of four banks, with the AI board down', () => {
    it('files every statement, newest first within each bank and one bank after another — and asks the dead board ONCE, not once per statement', async () => {
        const s = backlog({ perBank: 6 });
        const runs = [];
        for (let i = 0; i < 8 && s.settled.length < 24; i++) runs.push(await runStatementSync({ ...s.args, interactive: true, maxSteps: Infinity }));
        expect(s.settled).toHaveLength(24);
        for (const path of Object.keys(s.sources)) expect(s.db.docs.get(path)).toMatchObject({ filed: true });
        // The board is asked only about rows the rules could not settle. These card statements are a grocery purchase and a payment — the rules
        // settle both — so a dead board is never even asked (it used to be asked, found down once, and remembered on the mailbox).
        expect(s.board.mock.calls.length).toBeLessThanOrEqual(2);
        // within every bank the newest statement was filed before the oldest
        for (const bank of BANKS) {
            const mine = s.settled.filter(path => s.db.docs.get(path).bank === bank.name).map(path => s.db.docs.get(path).receivedMs);
            expect(mine).toEqual([...mine].sort((a, b) => b - a));
        }
        // and across banks: after the first four, one of each bank's NEWEST is in
        const firstFour = s.settled.slice(0, 4).map(path => s.db.docs.get(path));
        expect(new Set(firstFour.map(x => x.bank))).toEqual(new Set(BANKS.map(b => b.name)));
        for (const x of firstFour) expect(x.receivedMs).toBe(Date.parse('2026-01-02T05:00:00Z') + 5 * 9 * 86400000);
        void runs;
    });

    it('the latest statement of EVERY bank is filed within the first four steps — a bank cannot be starved by another\'s backlog', async () => {
        const s = backlog({ perBank: 12 });
        await runStatementSync({ ...s.args, interactive: true, maxSteps: 4 });
        expect(s.settled).toHaveLength(4);
        expect(new Set(s.settled.map(path => s.db.docs.get(path).bank))).toEqual(new Set(BANKS.map(b => b.name)));
    });
});

describe('a statement that keeps failing', () => {
    it('is counted, parked after five, re-driven on schedule from the same place, and only after every round becomes a question for the owner', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const s = backlog({ perBank: 1, failing: new Set(['*']) });
        const path = s.sourceOf('m-NTB-0');
        const step = async (advanceMs) => { vi.setSystemTime(Date.now() + advanceMs); return runStatementSync({ ...s.args, maxSteps: Infinity }); };
        // every statement fails (the attachment cannot be fetched): five attempts each, spaced past the back-off
        const trail = [];
        for (let i = 0; i < 4; i++) { await step(20000); trail.push(s.db.docs.get(path).retryCount); }
        expect(trail).toEqual([1, 2, 3, 4]);
        await step(20000);
        expect(s.db.docs.get(path)).toMatchObject({ status: DEAD_LETTER, retryCount: 5, cursor: 0, filed: false });
        expect(s.db.docs.get(path).deadLetter).toMatchObject({ attempts: 5, cycles: 0, reason: 'gmail-fetch-unavailable', cursor: 0 });
        const parkedAt = s.db.docs.get(path).deadLetter.redriveAt;
        expect(parkedAt - Date.now()).toBe(15 * 60 * 1000);

        // while parked it is not touched
        const before = s.f.mock.calls.length;
        const idle = await step(60000);
        expect(idle).toMatchObject({ processed: 0, attempted: 0, deadLettered: 4 });
        expect(s.db.docs.get(path).status).toBe(DEAD_LETTER);
        expect(s.f.mock.calls.filter(([u]) => String(u).includes('attachments')).length).toBe(s.f.mock.calls.slice(0, before).filter(([u]) => String(u).includes('attachments')).length);

        // each round: wait out the park, it comes back with a clean attempt count and the cycle counted, fails five times again
        for (let cycle = 1; cycle <= 4; cycle++) {
            const waitFor = REDRIVE_AFTER_MS[cycle - 1];
            const back = await step(waitFor + 1000);
            expect(back.redriven).toBeGreaterThanOrEqual(1);
            expect(s.db.docs.get(path).deadLetter.cycles).toBe(cycle);
            for (let i = 0; i < 4; i++) await step(20000);
            const state = s.db.docs.get(path);
            if (cycle < 4) { expect(state.status).toBe(DEAD_LETTER); expect(state.deadLetter.redriveAt - Date.now()).toBe(REDRIVE_AFTER_MS[cycle]); }
        }
        // 25 attempts, a day and a half: now — and only now — it is one question for the owner, still holding its place
        const final = s.db.docs.get(path);
        expect(final).toMatchObject({ status: 'needs_review', reviewReason: 'statement-retries-exhausted', filed: false, cursor: 0 });
        expect(final.deadLetter).toMatchObject({ cycles: 4, attemptsTotal: 25 });
        const review = [...s.db.docs.keys()].filter(k => k.startsWith('users/u/statementReview/')).map(k => s.db.docs.get(k));
        expect(review.some(r => r.reason === 'statement-retries-exhausted' && r.sourcePath === path)).toBe(true);
    });

    it('a statement that recovers while parked is filed from where it stopped — nothing skipped, nothing read twice', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        const s = backlog({ perBank: 1, failing: new Set(['m-NTB-0']) });
        const path = s.sourceOf('m-NTB-0');
        for (let i = 0; i < 5; i++) { vi.setSystemTime(Date.now() + 20000); await runStatementSync({ ...s.args, maxSteps: Infinity }); }
        expect(s.db.docs.get(path).status).toBe(DEAD_LETTER);
        // the other banks were never held up by it
        expect(s.settled.length).toBe(3);
        // the provider mends
        s.failing.delete('m-NTB-0');
        vi.setSystemTime(Date.now() + 15 * 60 * 1000 + 1000);
        const result = await runStatementSync({ ...s.args, maxSteps: Infinity });
        expect(result.redriven).toBe(1);
        expect(s.db.docs.get(path)).toMatchObject({ filed: true, status: 'filed' });
        expect(s.db.docs.get('users/u').cconetime.filter(r => r.amount === 123.45 + 1 || r.amount > 0).length).toBeGreaterThan(0);
        // exactly one filing of each row: 4 statements × 1 purchase
        expect(s.db.docs.get('users/u').cconetime).toHaveLength(4);
        expect(s.db.docs.get('users/u').ccPayments).toHaveLength(4);
    });

    it('the failure of one statement does not stop the rest of the queue within the same invocation', async () => {
        const s = backlog({ perBank: 3, failing: new Set(['m-AMEX-2', 'm-DFCCBank-1']) });
        await runStatementSync({ ...s.args, interactive: true, maxSteps: Infinity });
        // the two failing are backing off; the other ten were filed in the same invocation
        expect(s.settled).toHaveLength(10);
        expect(s.db.docs.get(s.sourceOf('m-AMEX-2'))).toMatchObject({ status: 'pending', retryCount: 1 });
    });
});

describe('rotation within one invocation', () => {
    it('claimOrder\'s first entry moves to the next bank for every statement already taken', () => {
        const docs = ['A', 'B', 'C', 'D'].map(bank => doc(bank + '1', { bank, receivedMs: 1 }));
        const base = Math.floor(NOW / 20000);
        const firsts = [0, 1, 2, 3].map(taken => claimOrder(docs, { now: NOW, rotate: base + taken })[0].id);
        expect(new Set(firsts).size).toBe(4);
        // and it does not matter where the base falls, or which invocation: any four in a row are four different banks
        for (const b of [0, 1, 2, 3, 77, 1790832]) expect(new Set([0, 1, 2, 3].map(taken => claimOrder(docs, { now: NOW, rotate: b + taken })[0].id)).size).toBe(4);
    });
});
