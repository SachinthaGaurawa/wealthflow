/* =============================================================================
 * test/gmail_renew_test.js — the watch renews when nobody opens the app
 * -----------------------------------------------------------------------------
 * THE HOLE THIS CLOSES, AND WHY IT WAS INVISIBLE.
 *
 * A Gmail watch lives seven days. Until now the only thing that renewed one was
 * the page, on a six-day margin — which covers every week the app is opened,
 * and nothing at all in the week it is not. Miss a week and the watch lapses:
 * Google publishes nothing, /api/gmail-hook is never invoked, and the card
 * still says "Connected", because the mailbox IS connected. Nothing is broken
 * enough to report. Statements just stop.
 *
 * That is the same silence as every other defect in this pipeline, and it
 * cannot be caught by reading the code: the endpoint that renews looks correct,
 * and the caller that never runs is the missing half.
 *
 * So the handler is RUN — against the in-memory Admin SDK with the real network
 * hard-blocked — and the tests below are mostly about what it does with the
 * things that go wrong, because a scheduled job nobody watches is exactly where
 * a swallowed failure lives forever.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';
import {
    RENEW_MAX_PER_RUN, RENEW_SCAN_MAX, RENEW_FAIL, dueFrom, renewReport,
} from '../gmail-renew.mjs';
import { WATCH } from '../gmail-watch.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const DAY = 86400000;
const SECRET = 'cron-secret-value';
const ENV = {
    CRON_SECRET: SECRET,
    GOOGLE_OAUTH_CLIENT_ID: 'client-id',
    GOOGLE_OAUTH_CLIENT_SECRET: 'client-secret',
    GCP_PROJECT_ID: 'wf-proj',
    PUB_SUB_TOPIC: 'statements',
};
const TOKEN = '1//0g' + 'A'.repeat(40);

/* ═══════════════════════════════════════════════════════════════════════════
 * WHICH MAILBOXES ARE DUE — decided without a network or a database
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('who is due for renewal', () => {
    const now = 1_800_000_000_000;
    const doc = (key, over) => ({ key, data: { refresh_token: TOKEN, ...over } });

    it('a watch inside the renewal margin is due; one outside it is not', () => {
        const inside = doc('a', { watchExpiry: now + (WATCH.RENEW_WITH_DAYS_LEFT - 0.5) * DAY });
        const outside = doc('b', { watchExpiry: now + (WATCH.MAX_LIFETIME_DAYS - 0.1) * DAY });
        expect(dueFrom([inside, outside], { now }).map((d) => d.key)).toEqual(['a']);
    });

    it('a mailbox that has NEVER been watched is due, and goes first', () => {
        /* It has been delivering nothing since the day it was connected, which
         * is the worst version of this bug and the easiest to overlook — there
         * is no expiry date to notice. */
        const never = doc('never', {});
        const soon = doc('soon', { watchExpiry: now + 0.2 * DAY });
        expect(dueFrom([soon, never], { now }).map((d) => d.key)).toEqual(['never', 'soon']);
    });

    it('the most urgent go first, so a capped run does the ones about to lapse', () => {
        const docs = [
            doc('t5', { watchExpiry: now + 5 * DAY }),
            doc('t1', { watchExpiry: now + 1 * DAY }),
            doc('t3', { watchExpiry: now + 3 * DAY }),
        ];
        expect(dueFrom(docs, { now, max: 2 }).map((d) => d.key)).toEqual(['t1', 't3']);
    });

    it('a document with no refresh token is NOT due', () => {
        /* There is nothing to watch with, and asking Google about it would be a
         * guaranteed failure counted every single day. */
        expect(dueFrom([{ key: 'x', data: { watchExpiry: now } }], { now })).toEqual([]);
    });

    it('an expired watch is due, not skipped as hopeless', () => {
        expect(dueFrom([doc('gone', { watchExpiry: now - 3 * DAY })], { now }).length).toBe(1);
    });

    it('junk in the collection cannot throw', () => {
        expect(dueFrom([null, {}, { key: 'k' }, { data: {} }], { now })).toEqual([]);
        expect(dueFrom(null, { now })).toEqual([]);
        expect(dueFrom(undefined)).toEqual([]);
    });

    it('the cap is below the scan, so ordering is done over the whole store', () => {
        expect(RENEW_MAX_PER_RUN).toBeLessThan(RENEW_SCAN_MAX);
    });
});

describe('what the run reports', () => {
    it('nothing due is a successful run', () => {
        expect(renewReport({ scanned: 3, due: 0, outcomes: [] }).ok).toBe(true);
    });

    it('SOMETHING DUE AND NOTHING RENEWED IS A FAILED RUN', () => {
        /* The whole point of scheduling this. A green cron over a pipeline that
         * has stopped is the failure it was built to end. */
        const r = renewReport({ scanned: 2, due: 2, outcomes: [{ ok: false, reason: RENEW_FAIL.TOKEN }, { ok: false }] });
        expect(r.ok).toBe(false);
        expect(r.failed).toBe(2);
    });

    it('one dead mailbox does not fail a run that renewed the rest', () => {
        const r = renewReport({ scanned: 3, due: 3, outcomes: [{ ok: true }, { ok: true }, { ok: false, reason: RENEW_FAIL.TOKEN }] });
        expect(r.ok).toBe(true);
        expect(r.renewed).toBe(2);
        expect(r.failures[RENEW_FAIL.TOKEN]).toBe(1);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HANDLER, RUN
 * ═══════════════════════════════════════════════════════════════════════════*/

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
let calls;

function stubFetch(over = {}) {
    return async (url, init) => {
        const u = String(url);
        calls.push({ url: u, init });
        if (u.includes('oauth2.googleapis.com/token')) {
            if (over.tokenFails) return { ok: false, status: 400, async json() { return {}; }, async text() { return 'invalid_grant'; } };
            return { ok: true, status: 200, async json() { return { access_token: 'ya29.access' }; } };
        }
        if (u.includes('/users/me/watch')) {
            if (over.watchFails) return { ok: false, status: 403, async json() { return {}; }, async text() { return 'no publish rights'; } };
            return { ok: true, status: 200, async json() { return { historyId: '99', expiration: String(Date.now() + 7 * DAY) }; } };
        }
        throw new Error(`unexpected call: ${u}`);
    };
}

beforeEach(async () => {
    fake.reset();
    calls = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    globalThis.fetch = async (input) => { throw new Error(`network blocked in tests: ${String(input)}`); };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

function mkRes() {
    const seen = { status: null, body: undefined, ended: false };
    const res = {
        statusCode: 200,
        setHeader() { return res; },
        end(o) {
            seen.status = res.statusCode;
            try { seen.body = o === undefined ? undefined : JSON.parse(o); } catch (_) { seen.body = o; }
            seen.ended = true;
            return res;
        },
    };
    return { res, seen };
}

async function run({ method = 'GET', secret = SECRET, env = ENV, over = {} } = {}) {
    const { default: handler } = await import('../gmail-renew.js');
    const { res, seen } = mkRes();
    await handler(
        { method, url: '/api/gmail-renew', headers: secret ? { authorization: 'Bearer ' + secret } : {} },
        res,
        { env, fetchImpl: stubFetch(over) },
    );
    return seen;
}

/** A connected mailbox whose watch is about to lapse. */
function mailbox(key, over = {}) {
    fake.docs.set(`wf-mail/${key}`, {
        refresh_token: TOKEN, email: key.replace('_', '@'),
        watchExpiry: Date.now() + 0.5 * DAY, historyId: '10', ...over,
    });
}

describe('the scheduled renewal', () => {
    it('renews a mailbox nobody has opened the app for', async () => {
        mailbox('owner_example_com');
        const seen = await run();
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, due: 1, renewed: 1, failed: 0 });
        expect(calls.some((c) => c.url.includes('/users/me/watch'))).toBe(true);
        const doc = fake.docs.get('wf-mail/owner_example_com');
        expect(doc.watchExpiry).toBeGreaterThan(Date.now() + 6 * DAY);
        expect(doc.renewedBy).toBe('schedule');
    });

    it('leaves a mailbox that does not need it completely alone', async () => {
        mailbox('fresh_example_com', { watchExpiry: Date.now() + 6.9 * DAY });
        const before = { ...fake.docs.get('wf-mail/fresh_example_com') };
        const seen = await run();
        expect(seen.body).toMatchObject({ due: 0, renewed: 0 });
        expect(calls).toEqual([]);                    // Google was not called at all
        expect(fake.docs.get('wf-mail/fresh_example_com')).toEqual(before);
    });

    it('renews several mailboxes in one run', async () => {
        mailbox('a_example_com');
        mailbox('b_example_com');
        const seen = await run();
        expect(seen.body).toMatchObject({ due: 2, renewed: 2 });
    });

    it('THE BOOKMARK IS LEFT WHERE IT IS — the lapse window is the whole point', async () => {
        /* A renewal from the page advances `historyId` to Gmail's current
         * point, which is right there: it renews while the pipeline is running
         * and there is nothing in between. A SCHEDULED renewal is the one that
         * runs after a lapse, and the gap it is closing is exactly where mail
         * arrived with nobody notified. Advancing the bookmark past that window
         * is the one action that guarantees the hook never sees it — silently.
         *
         * The cost of leaving it: a bookmark too old for Gmail's retention
         * answers 404, and the hook falls back to a bounded recent listing.
         * That is a cost. Skipping is a loss. */
        mailbox('owner_example_com', { historyId: '4242' });
        await run();
        expect(fake.docs.get('wf-mail/owner_example_com').historyId).toBe('4242');
    });

    it('and a mailbox with no bookmark is not given one either', async () => {
        /* gmail-link.mjs owns what a fresh link looks like; writing a bookmark
         * from here would skip whatever arrived before this run. */
        mailbox('new_example_com', { historyId: undefined });
        fake.docs.set('wf-mail/new_example_com', { refresh_token: TOKEN });
        await run();
        expect(fake.docs.get('wf-mail/new_example_com').historyId).toBeUndefined();
    });

    it('a revoked token is recorded on that mailbox, for its own card to show', async () => {
        mailbox('owner_example_com');
        const seen = await run({ over: { tokenFails: true } });
        expect(seen.status).toBe(502);
        expect(seen.body.failures[RENEW_FAIL.TOKEN]).toBe(1);
        const doc = fake.docs.get('wf-mail/owner_example_com');
        expect(doc.renewError).toMatch(/connect the mailbox again/i);
        expect(typeof doc.renewErrorAt).toBe('number');
    });

    it('and the note is CLEARED by the next successful renewal', async () => {
        mailbox('owner_example_com', { renewError: 'Gmail refused the saved token.' });
        await run();
        expect(fake.docs.get('wf-mail/owner_example_com').renewError).toBe('');
    });

    it('Gmail refusing the watch is a failure, not a quiet 200', async () => {
        mailbox('owner_example_com');
        const seen = await run({ over: { watchFails: true } });
        expect(seen.status).toBe(502);
        expect(seen.body.ok).toBe(false);
        expect(seen.body.failures[RENEW_FAIL.GMAIL]).toBe(1);
    });

    it('NO CREDENTIAL, NO SECRET, NO ADDRESS EVER LEAVES THIS ENDPOINT', async () => {
        mailbox('owner_example_com');
        const seen = await run({ over: { tokenFails: true } });
        const said = JSON.stringify(seen.body);
        expect(said).not.toContain(TOKEN);
        expect(said).not.toContain(TOKEN.slice(0, 10));
        expect(said).not.toContain('owner_example_com');
        expect(said).not.toContain('owner@example.com');
        expect(said).not.toContain(SECRET);
    });
});

describe('who may run it', () => {
    it('an unauthenticated caller is refused and nothing is read', async () => {
        mailbox('owner_example_com');
        const seen = await run({ secret: '' });
        expect(seen.status).toBe(401);
        expect(fake.ops.filter((o) => o.op === 'query')).toEqual([]);
    });

    it('a wrong secret is refused', async () => {
        mailbox('owner_example_com');
        expect((await run({ secret: 'not-it' })).status).toBe(401);
        expect(calls).toEqual([]);
    });

    it('AN UNCONFIGURED GUARD REFUSES EVERYTHING', async () => {
        /* The opposite — open when unset — is a defect this repository has
         * already produced more than once. */
        const seen = await run({ env: { ...ENV, CRON_SECRET: '' }, secret: 'anything' });
        expect(seen.status).toBe(503);
        expect(seen.body.error).toMatch(/CRON_SECRET/);
    });

    it('the credential is checked BEFORE the configuration is described', async () => {
        /* An unauthorised caller learns nothing about this deployment — not
         * whether a topic is set, not how many mailboxes it holds. */
        const seen = await run({ secret: 'not-it', env: { CRON_SECRET: SECRET } });
        expect(seen.status).toBe(401);
        expect(JSON.stringify(seen.body)).not.toMatch(/PUB_SUB_TOPIC|missing/);
    });

    it('an unsupported method is refused', async () => {
        expect((await run({ method: 'DELETE' })).status).toBe(405);
    });
});

describe('when the deployment is not configured it says which part', () => {
    it('a missing topic is named, not reported as "0 renewed"', async () => {
        mailbox('owner_example_com');
        const seen = await run({ env: { CRON_SECRET: SECRET, GOOGLE_OAUTH_CLIENT_ID: 'x' } });
        expect(seen.status).toBe(503);
        expect(seen.body.error).toMatch(/topic/i);
        expect(Array.isArray(seen.body.missing)).toBe(true);
        expect(calls).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCHEDULE ITSELF — the half that is always missing
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('something actually calls it', () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
    const router = fs.readFileSync(path.join(ROOT, 'api', 'router.js'), 'utf8');

    it('is registered on a cron', () => {
        /* THE DEFECT THIS REPOSITORY REPEATS: a facility built and wired to
         * nobody. An endpoint that renews watches and is never called renews
         * nothing, and looks perfectly correct while doing it. */
        const cron = (vercel.crons || []).find((c) => c.path === '/api/gmail-renew');
        expect(cron, '/api/gmail-renew is on no schedule — it would never run').toBeTruthy();
        expect(typeof cron.schedule).toBe('string');
    });

    it('runs at least daily, well inside the seven-day lifetime', () => {
        const cron = (vercel.crons || []).find((c) => c.path === '/api/gmail-renew');
        const [, , dom, month, dow] = cron.schedule.trim().split(/\s+/);
        expect([dom, month, dow]).toEqual(['*', '*', '*']);
    });

    it('stays within the two cron jobs a Hobby project may have', () => {
        expect((vercel.crons || []).length).toBeLessThanOrEqual(2);
    });

    it('the path resolves to a handler', () => {
        expect(router).toContain("'gmail-renew': () => import('../gmail-renew.js')");
    });

    it('costs nothing from the Actions budget — it is not a workflow', () => {
        const wf = path.join(ROOT, '.github', 'workflows');
        const uses = fs.existsSync(wf)
            ? fs.readdirSync(wf).filter((f) => fs.readFileSync(path.join(wf, f), 'utf8').includes('gmail-renew'))
            : [];
        expect(uses).toEqual([]);
    });
});

describe('the card can say why renewal stopped', () => {
    it('gmail-watch reports the recorded reason to the mailbox’s owner', () => {
        /* The scheduled run has no screen. It writes the reason on the
         * document; this is the line that puts it in front of a person. */
        const watch = fs.readFileSync(path.join(ROOT, 'gmail-watch.js'), 'utf8');
        expect(watch).toContain('record.renewError');
    });

    it('and the card renders it', () => {
        const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
        expect(html).toContain('_mailWatch.error');
    });
});
