/* =============================================================================
 * test/gmail_hook_test.js
 * -----------------------------------------------------------------------------
 * gmail-hook.js receives Gmail's Pub/Sub push. Most of it is glue — the
 * decisions live in wealthflow-mail-ingest.mjs, which is pure and tested
 * separately. What is tested here is the part that is NOT glue: the check that
 * decides whether the caller is Google.
 *
 * THAT CHECK IS THE ENTIRE SECURITY BOUNDARY.
 *
 * The URL is public. Without verification anyone who learns it can POST a
 * crafted envelope and make the endpoint read a mailbox and write to the
 * database, as often as they like. So the tests below are the ways a caller
 * might try to get past it:
 *
 *   no token at all
 *   a token Google's own tokeninfo rejects
 *   a genuine Google token minted for somebody else's audience
 *   a genuine token from the wrong issuer
 *   a genuine token from a different service account
 *   an expired token
 *   tokeninfo unreachable, so nothing could be checked
 *
 * The last is the one that matters most, and the one an implementation gets
 * wrong by being helpful: when the check cannot run, the answer must be no. A
 * "could not verify, carry on" branch is how a boundary becomes decorative.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot prove the endpoint works end to end. That needs a Google Cloud
 * project, a Pub/Sub subscription and a real mailbox, none of which exist yet.
 * The handler is deliberately thin so that what is untestable here is glue
 * rather than judgement — but "untested glue" is still untested, and this file
 * does not pretend otherwise.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { verifyPush, decodeEnvelope, messagesSince, recentMessages, MAIL_ROOT } from '../gmail-hook.js';

const AUD = 'https://wealthflow-personal.vercel.app/api/gmail-hook';
const SA = 'gmail-push@wf-project.iam.gserviceaccount.com';
const ENV = { GMAIL_PUBSUB_AUDIENCE: AUD, GMAIL_PUBSUB_SA: SA };

/** A stub tokeninfo that returns whatever claims a test wants. */
const tokeninfo = (claims, { ok = true, throws = false } = {}) => async (url) => {
    if (throws) throw new Error('network');
    expect(String(url)).toContain('tokeninfo');
    return { ok, json: async () => claims };
};
const GOOD = {
    aud: AUD, iss: 'https://accounts.google.com', email: SA,
    email_verified: true, exp: String(Math.floor(Date.now() / 1000) + 600),
};

describe('the push is verified before anything happens', () => {
    it('accepts a genuine Pub/Sub token', async () => {
        const r = await verifyPush(`Bearer xyz`, ENV, tokeninfo(GOOD));
        expect(r).toMatchObject({ ok: true, email: SA });
    });

    it.each([
        ['no Authorization header', undefined, GOOD, {}, 'no-bearer-token'],
        ['a header that is not a Bearer', 'Basic abc', GOOD, {}, 'no-bearer-token'],
        ['an empty Bearer', 'Bearer ', GOOD, {}, 'no-bearer-token'],
        ['a token tokeninfo rejects', 'Bearer x', GOOD, { ok: false }, 'token-rejected'],
        ['a token for another audience', 'Bearer x', { ...GOOD, aud: 'https://someone-else/api' }, {}, 'wrong-audience'],
        ['a token from another issuer', 'Bearer x', { ...GOOD, iss: 'https://evil.example' }, {}, 'wrong-issuer'],
        ['an unverified identity', 'Bearer x', { ...GOOD, email_verified: false }, {}, 'unverified-identity'],
        ['another service account', 'Bearer x', { ...GOOD, email: 'someone@else.iam.gserviceaccount.com' }, {}, 'wrong-service-account'],
        ['an expired token', 'Bearer x', { ...GOOD, exp: String(Math.floor(Date.now() / 1000) - 10) }, {}, 'expired'],
    ])('refuses %s', async (_why, header, claims, opts, reason) => {
        const r = await verifyPush(header, ENV, tokeninfo(claims, opts));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(reason);
    });

    it('refuses when tokeninfo cannot be reached, rather than assuming the best', async () => {
        /* THE ONE THAT MATTERS. An implementation that treats "I could not
         * check" as "probably fine" has no boundary at all, and the failure is
         * invisible: everything works, including for the attacker. */
        const r = await verifyPush('Bearer x', ENV, tokeninfo(GOOD, { throws: true }));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('tokeninfo-unreachable');
    });

    it('refuses when no audience is configured, rather than skipping the check', async () => {
        // A missing env var must not become "no audience to compare, so pass".
        const r = await verifyPush('Bearer x', {}, tokeninfo(GOOD));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('audience-not-configured');
    });

    it('still pins the audience when no service account is configured', async () => {
        const noSa = { GMAIL_PUBSUB_AUDIENCE: AUD };
        expect((await verifyPush('Bearer x', noSa, tokeninfo(GOOD))).ok).toBe(true);
        expect((await verifyPush('Bearer x', noSa, tokeninfo({ ...GOOD, aud: 'other' }))).ok).toBe(false);
    });

    it('accepts either spelling of the Google issuer', async () => {
        for (const iss of ['https://accounts.google.com', 'accounts.google.com']) {
            expect((await verifyPush('Bearer x', ENV, tokeninfo({ ...GOOD, iss }))).ok).toBe(true);
        }
    });

    it('never returns the token it was given', async () => {
        const secret = 'eyJhbGciOi.SECRET-TOKEN-VALUE.sig';
        for (const claims of [GOOD, { ...GOOD, aud: 'x' }]) {
            const r = await verifyPush(`Bearer ${secret}`, ENV, tokeninfo(claims));
            expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN-VALUE');
        }
    });
});

describe('the Pub/Sub envelope', () => {
    const wrap = (obj) => ({ message: { data: Buffer.from(JSON.stringify(obj)).toString('base64'), messageId: 'PS1' } });

    it('decodes a real notification', () => {
        expect(decodeEnvelope(wrap({ emailAddress: 'Me@Gmail.com', historyId: '90210' })))
            .toEqual({ emailAddress: 'me@gmail.com', historyId: '90210', messageId: 'PS1' });
    });

    it.each([
        ['no body', undefined],
        ['no message', {}],
        ['no data', { message: {} }],
        ['data that is not base64 JSON', { message: { data: 'not-base64-json' } }],
        ['JSON that is not an object', { message: { data: Buffer.from('"hi"').toString('base64') } }],
        ['a notification with no historyId', { message: { data: Buffer.from('{"emailAddress":"a@b.c"}').toString('base64') } }],
        ['a notification with no mailbox', { message: { data: Buffer.from('{"historyId":"1"}').toString('base64') } }],
    ])('returns null for %s', (_why, body) => {
        expect(decodeEnvelope(body)).toBe(null);
    });

    it('never throws on hostile input', () => {
        for (const bad of [null, 0, 'x', [], { message: { data: '!!!!' } }]) {
            expect(() => decodeEnvelope(bad)).not.toThrow();
        }
    });
});

describe('asking Gmail what changed', () => {
    const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

    it('collects the ids of added messages, without duplicates', async () => {
        const f = async () => resp(200, {
            historyId: '999',
            history: [
                { messagesAdded: [{ message: { id: 'A' } }, { message: { id: 'B' } }] },
                { messagesAdded: [{ message: { id: 'A' } }] },
            ],
        });
        const r = await messagesSince('tok', '1', f);
        expect(r.ok).toBe(true);
        expect(r.ids.sort()).toEqual(['A', 'B']);
        expect(r.historyId).toBe('999');
    });

    it('treats a 404 as "too much has happened", not as a failure', async () => {
        /* Gmail returns 404 when the history id has aged out. Retrying that
         * request forever is the wrong answer; the caller falls back to a
         * bounded recent listing instead. */
        const r = await messagesSince('tok', '1', async () => resp(404, {}));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe('history-too-old');
    });

    it('reports any other failure as retryable', async () => {
        const r = await messagesSince('tok', '1', async () => resp(503, {}));
        expect(r.reason).toBe('history-unavailable');
        expect(r.status).toBe(503);
    });

    it('keeps the caller’s bookmark when Gmail returns no new historyId', async () => {
        const r = await messagesSince('tok', '77', async () => resp(200, { history: [] }));
        expect(r.historyId, 'the bookmark went backwards, so the next push would re-scan')
            .toBe('77');
    });

    it('asks for the history id in the query, not the path', async () => {
        let seen = '';
        await messagesSince('tok', '12 34', async (url) => { seen = String(url); return resp(200, {}); });
        expect(seen).toContain('startHistoryId=12%2034');
        expect(seen).toContain('historyTypes=messageAdded');
    });

    it('sends the access token and nothing else', async () => {
        let headers = null;
        await messagesSince('SECRET-ACCESS', '1', async (_u, o) => { headers = o.headers; return resp(200, {}); });
        expect(headers.Authorization).toBe('Bearer SECRET-ACCESS');
    });

    it('bounds the fallback listing rather than reading a whole mailbox', async () => {
        let seen = '';
        await recentMessages('tok', async (url) => { seen = String(url); return resp(200, { messages: [{ id: 'A' }] }); });
        expect(seen).toMatch(/maxResults=\d+/);
        expect(Number(/maxResults=(\d+)/.exec(seen)[1])).toBeLessThanOrEqual(50);
        expect(seen, 'listing everything would scan mail that cannot be a statement')
            .toContain('has:attachment');
    });

    it('returns an empty list, not a failure, when there is nothing recent', async () => {
        const r = await recentMessages('tok', async () => resp(200, {}));
        expect(r).toEqual({ ok: true, ids: [] });
    });
});

describe('where statements are stored', () => {
    it('is its own root, not the transaction inbox', () => {
        /* wf-inbox items are classified transactions with a brain_result. A
         * statement payload is a different shape entirely, and inbox-pull would
         * choke on it. Separate roots so neither can be read as the other. */
        expect(MAIL_ROOT).toBe('wf-mail');
        expect(MAIL_ROOT).not.toBe('wf-inbox');
    });
});

describe('the endpoint is registered where Vercel will find it', () => {
    it('is in the router table', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const router = fs.readFileSync(
            path.resolve(import.meta.dirname, '../api/router.js'), 'utf8');
        /* Every server file lives at the repo root, and Vercel only turns files
         * inside /api into functions. A handler that is not in this table is
         * not reachable — the defect that left twelve endpoints dead for
         * months while every gate stayed green. */
        expect(router).toContain("'gmail-hook': () => import('../gmail-hook.js')");
    });
});
