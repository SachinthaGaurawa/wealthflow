/* =============================================================================
 * test/scan_boundary_retry_test.js — two ways the historical sweep could lose a statement without saying so
 * -----------------------------------------------------------------------------
 * ONE. The month-edge strip. gmail-scan.js keeps only mail whose internalDate is inside the window's exact UTC month, while
 * Gmail reads `after:`/`before:` as calendar dates in the ACCOUNT'S timezone. With a query cut at the UTC edge, mail landing
 * in the strip between the two (the account's UTC offset, at every month boundary) was listed by NO window: the later
 * month's query started too late, the earlier month's gate refused it. Never fetched, never held, never reported.
 * These tests model Gmail's date reading for every timezone offset and prove each message is listed by the window that owns it.
 *
 * TWO. A page that failed was abandoned. The loop stopped at the first 504/429/dropped connection. It now repeats the page with
 * backoff, up to ten attempts, and does not hammer a failure repeating cannot mend.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import {
    planWindows, resumeCursor, serializeCursor, startCursor, QUERY_PAD_MS, CURSOR_VERSION,
    isRetryable, backoffMs, sendWithRetry, MAX_PAGE_ATTEMPTS, BACKOFF_CAP_MS,
} from '../wealthflow-backfill.js';

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

/** Seeded, so a failure reproduces. */
function rng(seed) { let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

/** What Gmail does with `after:Y/M/D before:Y/M/D`: midnight of each date, in the account's timezone (offset in minutes east of UTC). */
function gmailLists(query, internalMs, offsetMin) {
    const m = /after:(\d{4})\/(\d\d)\/(\d\d) before:(\d{4})\/(\d\d)\/(\d\d)/.exec(query);
    if (!m) throw new Error('no date range in ' + query);
    const localMidnight = (y, mo, d) => Date.UTC(+y, +mo - 1, +d) - offsetMin * 60000;
    return internalMs >= localMidnight(m[1], m[2], m[3]) && internalMs < localMidnight(m[4], m[5], m[6]);
}
/** What gmail-scan.js does with what came back. */
const gateKeeps = (w, internalMs) => internalMs >= w.after && internalMs < w.before;

const NOW = Date.parse('2026-08-28T10:00:00Z');
const OFFSETS = [-720, -480, -420, -300, 0, 60, 330, 345, 480, 540, 600, 765, 840]; // incl. UTC-12, PST, PDT, Colombo, Nepal, Chatham, UTC+14

/** The shape the query had BEFORE the fix: cut at the exact UTC month edge. */
function unpaddedQuery(w) {
    const ymd = (ms) => { const d = new Date(ms); return `${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${String(d.getUTCDate()).padStart(2, '0')}`; };
    return `has:attachment after:${ymd(w.after)} before:${ymd(w.before)}`;
}

describe('every message is listed by the window that owns it, in every timezone', () => {
    const windows = planWindows({ months: 24, now: NOW, senders: ['from:statements@hnb.lk'] });

    it('the windows tile the timeline: each owns [after, before) and the next starts where it ends', () => {
        for (let i = 0; i < windows.length - 1; i++) expect(windows[i + 1].before).toBe(windows[i].after);
    });

    it('THE BUG, reproduced: with the old query a Colombo message at 00:30 local on the 1st belonged to no window', () => {
        // 2026-08-01 00:30 Colombo = 2026-07-31 19:00 UTC
        const landed = Date.parse('2026-07-31T19:00:00Z');
        const owner = windows.find((w) => gateKeeps(w, landed));      // July
        expect(owner.label).toBe('2026-07');
        const listedOld = gmailLists(unpaddedQuery(owner), landed, 330);
        expect(listedOld, 'the old query did not list it — this is the silent drop').toBe(false);
        expect(gmailLists(owner.query, landed, 330), 'the padded query must list it').toBe(true);
    });

    it('exhaustive: quarter-hour steps around every month edge, for every offset, exactly one window owns and lists it', () => {
        const failures = [];
        for (const offset of OFFSETS) {
            for (let i = 1; i < windows.length; i++) {
                const edge = windows[i].before;                       // the edge between window i (earlier) and i-1
                for (let minute = -36 * 60; minute <= 36 * 60; minute += 15) {
                    const landed = edge + minute * 60000;
                    const owners = windows.filter((w) => gateKeeps(w, landed));
                    if (owners.length !== 1) { failures.push({ offset, landed, owners: owners.length }); continue; }
                    if (!gmailLists(owners[0].query, landed, offset)) failures.push({ offset, landed: new Date(landed).toISOString(), label: owners[0].label, listed: false });
                }
            }
        }
        expect(failures.slice(0, 5)).toEqual([]);
    });

    it('property: 5000 seeded random instants over 24 months x random offsets are all listed by their owner', () => {
        const r = rng(20261002);
        const lo = windows[windows.length - 1].after, hi = windows[0].before;
        let checked = 0;
        for (let n = 0; n < 5000; n++) {
            const landed = Math.floor(lo + r() * (hi - lo));
            const offset = OFFSETS[Math.floor(r() * OFFSETS.length)];
            const owner = windows.find((w) => gateKeeps(w, landed));
            expect(owner, 'no window owns ' + landed).toBeTruthy();
            expect(gmailLists(owner.query, landed, offset), `${new Date(landed).toISOString()} @${offset}`).toBe(true);
            checked++;
        }
        expect(checked).toBe(5000);
    });

    it('padding costs at most one extra day per side, never more', () => {
        for (const w of windows) {
            const m = /after:(\d{4})\/(\d\d)\/(\d\d) before:(\d{4})\/(\d\d)\/(\d\d)/.exec(w.query);
            const a = Date.UTC(+m[1], +m[2] - 1, +m[3]), b = Date.UTC(+m[4], +m[5] - 1, +m[6]);
            expect(w.after - a).toBeLessThanOrEqual(QUERY_PAD_MS);
            expect(b - w.before).toBeLessThanOrEqual(QUERY_PAD_MS);
            expect(a).toBeLessThan(w.after);
            expect(b).toBeGreaterThan(w.before);
        }
    });

    it('still carries the exact approved senders and nothing wider', () => {
        for (const w of windows) {
            expect(w.query).toContain('has:attachment');
            expect(w.query).toContain('from:statements@hnb.lk');
        }
    });
});

describe('a cursor saved before the padded query existed starts over rather than paging a different search', () => {
    it('version 1 is refused; the current version resumes', () => {
        const opts = { months: 6, now: NOW, senders: ['from:statements@hnb.lk'] };
        const c = startCursor(opts); c.index = 2; c.pageToken = 'tok';
        expect(resumeCursor({ ...serializeCursor(c), v: 1 }, opts).index).toBe(0);
        expect(resumeCursor({ ...serializeCursor(c), v: CURSOR_VERSION }, opts).pageToken).toBe('tok');
    });
});

describe('retry policy', () => {
    it('what repeating can mend is retried; what it cannot is not', () => {
        for (const s of [0, 408, 425, 429, 500, 503, 504]) expect(isRetryable(s, null), String(s)).toBe(true);
        for (const s of [200, 400, 401, 403, 404, 409, 502]) expect(isRetryable(s, { ok: false }), String(s)).toBe(false);
        expect(isRetryable(502, { ok: false, retryable: true })).toBe(true);     // Gmail 5xx behind our 502
        expect(isRetryable(503, { ok: false, retryable: false })).toBe(false);   // the server said no
    });

    it('backoff grows, is capped, jitters within 20 %, and honours the server\'s own wait', () => {
        const mid = () => 0.5;                       // jitter factor exactly 1
        expect([1, 2, 3, 4, 5, 6, 7, 8].map((n) => backoffMs(n, { random: mid }))).toEqual([1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]);
        expect(backoffMs(1, { random: () => 0 })).toBe(800);
        expect(backoffMs(1, { random: () => 1 })).toBe(1200);
        expect(backoffMs(1, { retryAfterMs: 5000, random: mid })).toBe(5000);
        expect(backoffMs(1, { retryAfterMs: 9e9, random: mid })).toBe(BACKOFF_CAP_MS);
    });

    it('fuzz: backoff is finite and within [0, cap] for hostile inputs', () => {
        const r = rng(7);
        const junk = [NaN, Infinity, -Infinity, -5, 0, 1e308, null, undefined, 'x', {}, [], 2 ** 53];
        for (let n = 0; n < 2000; n++) {
            const attempt = junk[Math.floor(r() * junk.length)] ?? r() * 100;
            const wait = backoffMs(attempt, { retryAfterMs: junk[Math.floor(r() * junk.length)], random: () => [NaN, -3, 7, r()][Math.floor(r() * 4)] });
            expect(Number.isFinite(wait) && wait >= 0 && wait <= BACKOFF_CAP_MS).toBe(true);
        }
    });

    const noSleep = { sleep: async () => {}, random: () => 0.5 };

    it('succeeds on the attempt after the failures, and says how many it took', async () => {
        const answers = [{ status: 504, body: null }, { status: 0, body: null }, { status: 429, body: { ok: false } }, { status: 200, body: { ok: true, statements: 2 } }];
        let calls = 0;
        const out = await sendWithRetry(async () => answers[calls++], noSleep);
        expect(out).toMatchObject({ ok: true, attempts: 4, gaveUp: false });
        expect(calls).toBe(4);
    });

    it('gives up after exactly ten attempts, waiting between them and not after the last', async () => {
        let calls = 0; const waits = [];
        const out = await sendWithRetry(async () => { calls++; return { status: 504, body: null }; }, { sleep: async (ms) => { waits.push(ms); }, random: () => 0.5 });
        expect(MAX_PAGE_ATTEMPTS).toBe(10);
        expect(calls).toBe(10);
        expect(waits).toHaveLength(9);
        expect(out).toMatchObject({ ok: false, gaveUp: true, attempts: 10 });
    });

    it('does not repeat a failure repeating cannot mend', async () => {
        for (const status of [400, 401, 403, 409]) {
            let calls = 0;
            const out = await sendWithRetry(async () => { calls++; return { status, body: { ok: false, error: 'no' } }; }, noSleep);
            expect(calls).toBe(1);
            expect(out).toMatchObject({ ok: false, gaveUp: false });
        }
    });

    it('a thrown send is a failed attempt, never an exception, and a fuzz of every status settles', async () => {
        const out = await sendWithRetry(async () => { throw new Error('socket hang up'); }, { ...noSleep, max: 3 });
        expect(out).toMatchObject({ ok: false, gaveUp: true, attempts: 3, status: 0 });
        const r = rng(99);
        for (let n = 0; n < 500; n++) {
            const status = Math.floor(r() * 700);
            const res = await sendWithRetry(async () => ({ status, body: r() < 0.3 ? null : { ok: r() < 0.1, retryable: r() < 0.3 ? true : undefined } }), { ...noSleep, max: 4 });
            expect(res.attempts).toBeGreaterThanOrEqual(1);
            expect(res.attempts).toBeLessThanOrEqual(4);
        }
    });

    it('counts what a failed attempt stored, because the retry skips it as already held', async () => {
        const answers = [{ status: 503, body: { ok: false, retryable: true, stored: 2 } }, { status: 503, body: { ok: false, retryable: true, stored: 1 } }, { status: 200, body: { ok: true, statements: 0 } }];
        let calls = 0;
        const out = await sendWithRetry(async () => answers[calls++], noSleep);
        expect(out).toMatchObject({ ok: true, carried: 3, attempts: 3 });
        const none = await sendWithRetry(async () => ({ status: 200, body: { ok: true, statements: 1 } }), noSleep);
        expect(none.carried).toBe(0);
    });

    it('tells the page about each wait', async () => {
        const told = [];
        await sendWithRetry(async () => ({ status: 503, body: null }), { ...noSleep, max: 3, onRetry: (i) => told.push(i) });
        expect(told.map((t) => t.attempt)).toEqual([1, 2]);
        expect(told.every((t) => t.waitMs > 0 && t.status === 503)).toBe(true);
    });
});

/* ── the endpoint says which of its failures are worth repeating ─────────────────────────────────────────────── */
const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';

async function scanWith(gmailListResponse) {
    const { default: handler } = await import('../gmail-scan.js');
    const seen = { status: null, body: undefined };
    const res = { statusCode: 200, setHeader() { return res; }, end(o) { seen.status = res.statusCode; seen.body = JSON.parse(o); return res; } };
    await handler(
        { method: 'POST', url: '/api/gmail-scan', headers: { authorization: 'Bearer good-token' }, body: { months: 6, index: 0, now: NOW } },
        res,
        {
            env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' },
            fetchImpl: async (url) => {
                const u = String(url);
                if (u.includes('oauth2.googleapis.com/token')) return { ok: true, status: 200, async json() { return { access_token: 'ya29' }; } };
                if (u.includes('/messages?')) return gmailListResponse();
                throw new Error('unexpected ' + u);
            },
        },
    );
    return seen;
}

describe('the scan endpoint labels its failures', () => {
    beforeEach(async () => {
        fake.reset();
        const { _setAdminModule } = await import('../admin-db.mjs');
        _setAdminModule(fake.admin);
        fake.setVerifier(async (t) => { if (t !== 'good-token') throw new Error('bad'); return { email: OWNER, email_verified: true, uid: 'u1' }; });
        fake.docs.set('wf-mail/' + KEY, {
            refresh_token: '1//0g' + 'A'.repeat(40), email: OWNER,
            senders: [{ id: 'no-reply@hnb.lk', kind: 'address', domain: 'hnb.lk', name: 'HNB', status: 'approved', source: 'manual', addedMs: 1 }],
        });
        globalThis.fetch = async (i) => { throw new Error('network blocked in tests: ' + String(i)); };
    });
    afterEach(async () => { globalThis.fetch = realFetch; const { _setAdminModule } = await import('../admin-db.mjs'); _setAdminModule(null); });

    it('Gmail 429 and 5xx are retryable (and a 429 names a wait); 403 is not', async () => {
        const quota = await scanWith(() => ({ ok: false, status: 429, async json() { return {}; } }));
        expect(quota.status).toBe(502);
        expect(quota.body).toMatchObject({ ok: false, retryable: true, retryAfterMs: 5000 });
        const down = await scanWith(() => ({ ok: false, status: 503, async json() { return {}; } }));
        expect(down.body.retryable).toBe(true);
        const denied = await scanWith(() => ({ ok: false, status: 403, async json() { return {}; } }));
        expect(denied.body.retryable).toBe(false);
        expect(isRetryable(denied.status, denied.body)).toBe(false);
        expect(isRetryable(quota.status, quota.body)).toBe(true);
    });

    it('a Gmail 403 that is a rate limit is retryable; any other 403 is not', async () => {
        for (const reason of ['userRateLimitExceeded', 'rateLimitExceeded']) {
            const limited = await scanWith(() => ({ ok: false, status: 403, async json() { return { error: { errors: [{ reason }] } }; } }));
            expect(limited.body, reason).toMatchObject({ retryable: true, retryAfterMs: 5000 });
        }
        const forbidden = await scanWith(() => ({ ok: false, status: 403, async json() { return { error: { errors: [{ reason: 'insufficientPermissions' }] } }; } }));
        expect(forbidden.body.retryable).toBe(false);
        const garbled = await scanWith(() => ({ ok: false, status: 403, async json() { throw new Error('not json'); } }));
        expect(garbled.body.retryable).toBe(false);
    });

    it('a token exchange that times out or answers 5xx is retryable; a rejected refresh token is not', async () => {
        const { default: handler } = await import('../gmail-scan.js');
        const run = async (tokenAnswer) => {
            const seen = { body: null };
            const res = { statusCode: 200, setHeader() { return res; }, end(o) { seen.body = JSON.parse(o); return res; } };
            await handler(
                { method: 'POST', url: '/api/gmail-scan', headers: { authorization: 'Bearer good-token' }, body: { months: 6, index: 0, now: NOW } },
                res, { env: { GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret' }, fetchImpl: async () => tokenAnswer() },
            );
            return seen.body;
        };
        expect((await run(() => { throw new Error('timeout'); })).retryable).toBe(true);
        expect((await run(() => ({ ok: false, status: 503, async json() { return {}; } }))).retryable).toBe(true);
        expect((await run(() => ({ ok: false, status: 400, async json() { return { error: 'invalid_grant' }; } }))).retryable).toBe(false);
    });
});
