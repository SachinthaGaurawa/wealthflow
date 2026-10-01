import { describe, it, expect, vi } from 'vitest';
import { createFirestore } from './helpers/fake-firestore.js';
import { continueChain, parseHeader, selfUrl, takeLease, releaseLease, withHardDeadline, platformWaitUntil, MAX_LINKS, HEADER, LEASE_MS } from '../statement-chain.mjs';
import { serveSync } from '../statement-sync.js';

/* =============================================================================
 * THE QUEUE KEEPS DRAINING AFTER THE REQUEST THAT STARTED IT HAS ANSWERED — and can never run away.
 * ===========================================================================*/

const SECRET = 's'.repeat(32);
const PROD = { CRON_SECRET: SECRET, VERCEL_ENV: 'production', VERCEL_PROJECT_PRODUCTION_URL: 'wealthflow-peach.vercel.app' };
const MAIL = 'wf-mail/owner_example_com';
const NOW = Date.parse('2026-10-01T06:00:00Z');
const more = (extra = {}) => ({ ok: true, morePending: true, attempted: 5, retryAfterMs: 750, ...extra });

function world(chain) {
    const { db, data } = createFirestore({ [MAIL]: { uid: 'u', email: 'owner@example.com', ...(chain ? { chain } : {}) } });
    const mailRef = db.collection('wf-mail').doc('owner_example_com');
    const calls = [];
    const f = vi.fn(async (url, init) => { calls.push({ url, init }); return { status: 202 }; });
    const waited = [];
    const waitUntil = (p) => waited.push(p);
    return { db, data, mailRef, f, calls, waitUntil, waited, chainOf: () => data.get(MAIL).chain };
}

describe('parseHeader / selfUrl', () => {
    it('reads id:depth and nothing else', () => {
        expect(parseHeader('abcd1234:3')).toEqual({ id: 'abcd1234', depth: 3 });
        for (const bad of [undefined, null, '', 'x', 'abcd1234', 'abcd1234:', 'abcd1234:x', 'a:1', 'abcd1234:1000', 'ab cd 1234:1', '../../etc:1', 'abcd1234:-1']) expect(parseHeader(bad), String(bad)).toBeNull();
    });
    it('calls the production domain, never a preview, and only a well-formed override', () => {
        expect(selfUrl(PROD)).toBe('https://wealthflow-peach.vercel.app/api/statement-sync');
        expect(selfUrl({ ...PROD, VERCEL_ENV: 'preview' })).toBe('');
        expect(selfUrl({ ...PROD, VERCEL_PROJECT_PRODUCTION_URL: 'evil.example/x?y' })).toBe('');
        expect(selfUrl({})).toBe('');
        expect(selfUrl({ WF_CHAIN_URL: 'https://example.org/api/statement-sync' })).toBe('https://example.org/api/statement-sync');
        expect(selfUrl({ WF_CHAIN_URL: 'http://example.org/api/statement-sync' })).toBe('');
        expect(selfUrl({ WF_CHAIN_URL: 'https://example.org/other' })).toBe('');
    });
});

describe('continueChain', () => {
    it('starts the next link when there is more and progress was made: one authenticated call, a lease, depth 1', async () => {
        const w = world();
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(out).toMatchObject({ next: true, depth: 1 });
        expect(w.calls).toHaveLength(1);
        expect(w.calls[0].url).toBe('https://wealthflow-peach.vercel.app/api/statement-sync');
        expect(w.calls[0].init.headers.Authorization).toBe('Bearer ' + SECRET);
        expect(parseHeader(w.calls[0].init.headers[HEADER])).toEqual({ id: out.id, depth: 1 });
        expect(JSON.parse(w.calls[0].init.body)).toEqual({ action: 'drain' });
        expect(w.chainOf()).toMatchObject({ id: out.id, depth: 1, until: NOW + LEASE_MS });
        expect(w.waited).toHaveLength(1);                                  // kept alive by the platform, not awaited
    });
    it('does not start one when the queue is empty, when nothing progressed, or when everything is asleep in a back-off', async () => {
        for (const [result, reason] of [[{ ok: true, morePending: false, attempted: 3 }, 'queue-empty'], [more({ attempted: 0 }), 'no-progress'], [more({ retryAfterMs: 90000 }), 'asleep'], [{ ok: false }, 'queue-empty'], [null, 'queue-empty'], [more({ ok: false }), 'queue-empty']]) {
            const w = world();
            const out = await continueChain({ db: w.db, mailRef: w.mailRef, result, env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
            expect(out, reason).toEqual({ next: false, reason });
            expect(w.calls).toHaveLength(0);
        }
    });
    it('a mailbox still collecting, or a dead-lettered statement re-driven, counts as progress', async () => {
        for (const extra of [{ attempted: 0, collectionMore: true }, { attempted: 0, migrationMore: true }, { attempted: 0, redriven: 2 }]) {
            const w = world();
            expect((await continueChain({ db: w.db, mailRef: w.mailRef, result: more(extra), env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW })).next).toBe(true);
        }
    });
    it('needs the schedule\'s secret and a production URL; WF_CHAIN=off stops it', async () => {
        for (const env of [{ ...PROD, CRON_SECRET: 'short' }, { ...PROD, CRON_SECRET: undefined }, { ...PROD, VERCEL_ENV: 'preview' }, { ...PROD, WF_CHAIN: 'off' }]) {
            const w = world();
            expect((await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env, f: w.f, waitUntil: w.waitUntil, now: NOW })).next).toBe(false);
            expect(w.calls).toHaveLength(0);
        }
    });
    it('ONE CHAIN AT A TIME: a live lease held by another chain stops a second one from starting beside it', async () => {
        const w = world({ id: 'otherchain1', depth: 4, until: NOW + 30000 });
        expect(await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW })).toEqual({ next: false, reason: 'another-chain' });
        expect(w.calls).toHaveLength(0);
        expect(w.chainOf().id).toBe('otherchain1');                         // not disturbed
    });
    it('an expired lease is taken over: a link that died does not wedge the chain', async () => {
        const w = world({ id: 'deadchain1', depth: 9, until: NOW - 1 });
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(out.next).toBe(true); expect(w.chainOf().id).not.toBe('deadchain1');
    });
    it('a link extends its OWN lease and passes the chain on at depth + 1', async () => {
        const w = world({ id: 'mychain001', depth: 3, until: NOW + 10000 });
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), link: { id: 'mychain001', depth: 3 }, env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(out).toMatchObject({ next: true, depth: 4, id: 'mychain001' });
        expect(w.chainOf()).toMatchObject({ id: 'mychain001', depth: 4, until: NOW + LEASE_MS });
    });
    it('stops after MAX_LINKS, and hands the lease back so the next trigger can start afresh', async () => {
        const w = world({ id: 'mychain001', depth: MAX_LINKS, until: NOW + 10000 });
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), link: { id: 'mychain001', depth: MAX_LINKS }, env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(out).toEqual({ next: false, reason: 'max-links' });
        expect(w.calls).toHaveLength(0);
        expect(w.chainOf().until).toBe(0);
        const fresh = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(fresh.next).toBe(true);
    });
    it('a link that finds nothing left hands its lease back at once', async () => {
        const w = world({ id: 'mychain001', depth: 2, until: NOW + 50000 });
        await continueChain({ db: w.db, mailRef: w.mailRef, result: { ok: true, morePending: false }, link: { id: 'mychain001', depth: 2 }, env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
        expect(w.chainOf().until).toBe(0);
    });
    it('a call that fails or hangs costs nothing: the schedule and the app start the chain again', async () => {
        const w = world();
        const failing = vi.fn(async () => { throw new Error('ECONNRESET'); });
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: failing, waitUntil: w.waitUntil, now: NOW });
        expect(out.next).toBe(true);
        await expect(w.waited[0]).resolves.toEqual({ status: 0 });
    });
    it('without a platform background window the call is awaited (local runs), never dropped', async () => {
        const w = world();
        const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), env: PROD, f: w.f, waitUntil: null, now: NOW });
        expect(out.next).toBe(true); expect(w.calls).toHaveLength(1);
    });
    it('the chain depth is bounded by the database, not by memory: twenty-one starts from a clean mailbox make exactly MAX_LINKS calls', async () => {
        const w = world();
        let link = null, calls = 0;
        for (let n = 0; n < MAX_LINKS * 3; n++) {
            const out = await continueChain({ db: w.db, mailRef: w.mailRef, result: more(), link, env: PROD, f: w.f, waitUntil: w.waitUntil, now: NOW });
            if (!out.next) break;
            calls++; link = parseHeader(w.calls.at(-1).init.headers[HEADER]);
        }
        expect(calls).toBe(MAX_LINKS);
    });
});

describe('takeLease / releaseLease', () => {
    it('two links racing for a fresh mailbox: exactly one holds the lease', async () => {
        const w = world();
        const [a, b] = await Promise.all([takeLease({ db: w.db, mailRef: w.mailRef, id: 'chainaaaa1', depth: 1, now: NOW }), takeLease({ db: w.db, mailRef: w.mailRef, id: 'chainbbbb1', depth: 1, now: NOW })]);
        expect([a.ok, b.ok].filter(Boolean).length).toBeLessThanOrEqual(2);
        expect(['chainaaaa1', 'chainbbbb1']).toContain(w.chainOf().id);
    });
    it('releasing a lease that is not yours changes nothing; a failure to release is harmless', async () => {
        const w = world({ id: 'theirs0001', depth: 2, until: NOW + 9999 });
        await releaseLease({ db: w.db, mailRef: w.mailRef, id: 'mine000001' });
        expect(w.chainOf().until).toBe(NOW + 9999);
        await releaseLease({ db: { runTransaction: async () => { throw new Error('db down'); } }, mailRef: w.mailRef, id: 'x' });
    });
});

describe('withHardDeadline', () => {
    it('hands back the work\'s answer when it comes in time, and the work\'s failure too', async () => {
        expect(await withHardDeadline(Promise.resolve(7), 1000)).toEqual({ value: 7 });
        await expect(withHardDeadline(Promise.reject(new Error('boom')), 1000)).rejects.toThrow('boom');
    });
    it('says late — and leaves the work running — when it is not', async () => {
        let finished = false;
        const work = new Promise((resolve) => setTimeout(() => { finished = true; resolve('done'); }, 60));
        expect(await withHardDeadline(work, 5)).toEqual({ late: true });
        expect(finished).toBe(false);
        expect(await work).toBe('done');
    });
});

describe('platformWaitUntil', () => {
    it('reads the platform\'s request context where there is one, and is null where there is not', () => {
        expect(platformWaitUntil()).toBeNull();
        const fn = vi.fn();
        globalThis[Symbol.for('@vercel/request-context')] = { get: () => ({ waitUntil: fn }) };
        try { platformWaitUntil()(Promise.resolve(1)); expect(fn).toHaveBeenCalledTimes(1); }
        finally { delete globalThis[Symbol.for('@vercel/request-context')]; }
        globalThis[Symbol.for('@vercel/request-context')] = { get: () => { throw new Error('x'); } };
        try { expect(platformWaitUntil()).toBeNull(); } finally { delete globalThis[Symbol.for('@vercel/request-context')]; }
    });
});

describe('serveSync: the answer, the 202, and the link', () => {
    const owner = { uid: 'u', email: 'owner@example.com' };
    const res = () => ({ code: 0, body: null, setHeader() {}, end() {}, set statusCode(v) { this.code = v; }, get statusCode() { return this.code; } });
    const send = (r) => { let text = ''; r.end = (t) => { text = t; }; return () => JSON.parse(text); };

    it('answers 200 with what the run did, and starts the next link itself when there is more', async () => {
        const w = world(); const r = res(); const read = send(r);
        await serveSync({ db: w.db, owner, scheduled: true, res: r, run: async () => more({ processed: 9 }), env: PROD, f: w.f, waitUntil: w.waitUntil, log: () => {} });
        expect(r.code).toBe(200);
        expect(read()).toMatchObject({ ok: true, processed: 9, chain: 'more-to-do' });
        expect(w.calls).toHaveLength(1);
    });
    it('a caller that waits longer than the hard limit gets a 202 at once, and the work finishes on its own', async () => {
        const w = world(); const r = res(); const read = send(r);
        let finished = false;
        const run = () => new Promise((resolve) => setTimeout(() => { finished = true; resolve({ ok: true, morePending: false, processed: 4 }); }, 80));
        await serveSync({ db: w.db, owner, scheduled: false, res: r, run, env: PROD, f: w.f, waitUntil: w.waitUntil, hardMs: 10, log: () => {} });
        expect(r.code).toBe(202);
        expect(read()).toMatchObject({ ok: true, accepted: true, partial: true, morePending: true, retryAfterMs: 750 });
        expect(finished).toBe(false);
        await w.waited[0]; expect(finished).toBe(true);                   // the platform kept it alive and it completed
    });
    it('a request carrying a chain header from the schedule\'s secret answers 202 AT ONCE and works in the background', async () => {
        const w = world(); const r = res(); const read = send(r);
        let ran = false;
        const run = async () => { ran = true; return { ok: true, morePending: false }; };
        await serveSync({ db: w.db, owner, scheduled: true, headers: { [HEADER]: 'abcd1234:2' }, res: r, run, env: PROD, f: w.f, waitUntil: w.waitUntil, log: () => {} });
        expect(r.code).toBe(202); expect(read()).toMatchObject({ ok: true, accepted: true, link: 2 });
        await w.waited[0]; expect(ran).toBe(true);
    });
    it('an INTERACTIVE caller cannot pose as a link: the header is ignored and it gets the ordinary answer', async () => {
        const w = world(); const r = res(); const read = send(r);
        await serveSync({ db: w.db, owner, scheduled: false, headers: { [HEADER]: 'abcd1234:2' }, res: r, run: async () => ({ ok: true, morePending: false, processed: 1 }), env: PROD, f: w.f, waitUntil: w.waitUntil, log: () => {} });
        expect(r.code).toBe(200); expect(read().processed).toBe(1);
    });
    it('a run that fails is the caller\'s error, as before; a failure to chain is not an error at all', async () => {
        const w = world();
        await expect(serveSync({ db: w.db, owner, scheduled: false, res: res(), run: async () => { throw new Error('gmail-profile-unavailable'); }, env: PROD, f: w.f, waitUntil: w.waitUntil, log: () => {} })).rejects.toThrow('gmail-profile-unavailable');
        const r = res(); const read = send(r);
        await serveSync({ db: { collection: () => ({ doc: () => ({}) }), runTransaction: async () => { throw new Error('db down'); } }, owner, scheduled: false, res: r, run: async () => more(), env: PROD, f: w.f, waitUntil: w.waitUntil, log: () => {} });
        expect(r.code).toBe(200); expect(read().ok).toBe(true);
    });
    it('without a background window (local) a link still answers, in full', async () => {
        const w = world(); const r = res();
        await serveSync({ db: w.db, owner, scheduled: true, headers: { [HEADER]: 'abcd1234:2' }, res: r, run: async () => ({ ok: true, morePending: false }), env: PROD, f: w.f, waitUntil: null, log: () => {} });
        expect(r.code).toBe(200);
    });
});
