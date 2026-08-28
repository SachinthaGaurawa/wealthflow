/* =============================================================================
 * test/gmail_link_test.js
 * -----------------------------------------------------------------------------
 * gmail-hook.js reads its credential from wf-mail/{userKey}.refresh_token and
 * nothing in this repository has ever written that field. Every environment
 * variable a person could set for it is read by nobody: the hook reads exactly
 * four, and the refresh token is not one of them. So the pipeline could not run
 * however carefully it was configured.
 *
 * This file tests the decisions that fill that gap. The one that matters most is
 * not "does it store the token" — it is WHOSE mailbox a caller may touch.
 *
 * WHY THAT IS THE WHOLE BOUNDARY
 *
 * firestore.rules seals wf-mail to every client, and the server reaches it with
 * the Admin SDK, which bypasses rules entirely. So Firestore no longer gets a
 * vote: whatever document the server addresses is the document that gets read or
 * written. identify() deriving the key from a VERIFIED email on a Firebase ID
 * token is the only thing standing between one account and another's Gmail
 * credential — the same argument inbox-store.mjs makes about wf-inbox, and the
 * reason those checks live in one place and are tested here.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import G, {
    MAIL_ROOT, LINK, userKeyFor, bearerOf, identify,
    looksLikeRefreshToken, linkRecord, statusOf, oauthConfigured, missingConfig,
} from '../gmail-link.mjs';

const req = (auth) => ({ headers: auth ? { authorization: auth } : {} });
const ok = (over = {}) => async () => ({ uid: 'u1', email: 'Person@Gmail.com', email_verified: true, ...over });

/* ═══════════════════════════════════════════════════════════════════════════
 * WHOSE MAILBOX
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a caller can only ever reach their own mailbox', () => {
    it('derives the document key from the token, never from the request body', async () => {
        /* THE BOUNDARY. If the key came from anything the caller supplies, one
         * account could name another's address and read or replace the refresh
         * token that opens their entire mailbox. */
        const r = await identify(req('Bearer abc'), { verifyIdToken: ok() });
        expect(r.ok).toBe(true);
        expect(r.email).toBe('person@gmail.com');
        expect(r.userKey).toBe('person_gmail_com');
        // and nothing in the request influenced it
        const r2 = await identify(
            { headers: { authorization: 'Bearer abc' }, body: { email: 'victim@gmail.com', userKey: 'victim' } },
            { verifyIdToken: ok() },
        );
        expect(r2.userKey).toBe('person_gmail_com');
    });

    it('REFUSES an unverified email address', async () => {
        /* An unverified address is a string the account holder typed. Accepting
         * it would let anyone who can sign up claim any mailbox by naming it. */
        for (const bad of [{ email_verified: false }, { email_verified: undefined }, { email: '' }]) {
            const r = await identify(req('Bearer abc'), { verifyIdToken: ok(bad) });
            expect(r.ok, JSON.stringify(bad)).toBe(false);
            expect(r.reason).toBe(LINK.NO_EMAIL);
            expect(r.status).toBe(403);
        }
    });

    it('accepts the string "true" as verified, which some tokens carry', async () => {
        const r = await identify(req('Bearer abc'), { verifyIdToken: ok({ email_verified: 'true' }) });
        expect(r.ok).toBe(true);
    });

    it('refuses with no credential, and says which mechanism refused', async () => {
        expect(await identify(req(''), { verifyIdToken: ok() })).toMatchObject({ ok: false, reason: LINK.NO_TOKEN, status: 401 });
        expect(await identify(req('Basic xyz'), { verifyIdToken: ok() })).toMatchObject({ reason: LINK.NO_TOKEN });
    });

    it('refuses when the token does not verify', async () => {
        const boom = async () => { throw new Error('expired'); };
        const r = await identify(req('Bearer abc'), { verifyIdToken: boom });
        expect(r).toMatchObject({ ok: false, reason: LINK.BAD_IDENTITY, status: 401 });
    });

    it('refuses rather than trusting anything when no verifier is wired', async () => {
        /* 503, not 401: there is no credential the caller could present that
         * would help, and inviting a retry would be misleading. Failing closed
         * here is the difference between "unconfigured" and "open". */
        const r = await identify(req('Bearer abc'), {});
        expect(r).toMatchObject({ ok: false, reason: LINK.BAD_IDENTITY, status: 503 });
    });

    it('reads the header whatever its capitalisation', () => {
        expect(bearerOf({ headers: { Authorization: 'Bearer x' } })).toBe('x');
        expect(bearerOf({ headers: { authorization: 'bearer y' } })).toBe('y');
        expect(bearerOf({})).toBe('');
        expect(bearerOf(null)).toBe('');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE KEY MUST MATCH THE HOOK
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('both sides address the same document', () => {
    it('uses the same expression gmail-hook.js does, character for character', () => {
        /* The hook writes everything else in this document. If the two derive
         * different keys the token lands where nothing looks for it, and the
         * failure is silent — a mailbox that reports connected and never syncs. */
        const hook = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-hook.js'), 'utf8');
        expect(hook).toContain("replace(/[^a-z0-9]/g, '_')");
        const link = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-link.mjs'), 'utf8');
        expect(link).toContain("replace(/[^a-z0-9]/g, '_')");
    });

    it('does NOT lower-case first, matching the hook even though that is odd', () => {
        /* Capitals map to underscores rather than to letters. That is arguably
         * wrong and it is not this module's to change unilaterally: the hook is
         * the writer of record, and "fixing" one side points them at different
         * documents. */
        expect(userKeyFor('AB@x.com')).toBe('___x_com');   // A, B and @ all become _
        expect(userKeyFor('ab@x.com')).toBe('ab_x_com');
        /* Which is why identify() lower-cases the address BEFORE deriving the
         * key: "Person@Gmail.com" would otherwise map to "_erson__mail_com" and
         * address a document the hook, given the same mailbox by Google in
         * lower case, would never look at. */
        expect(userKeyFor('Person@Gmail.com')).toBe('_erson__mail_com');
    });

    it('names the same root collection', () => {
        const hook = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-hook.js'), 'utf8');
        expect(hook).toContain(`MAIL_ROOT = '${MAIL_ROOT}'`);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS A REFRESH TOKEN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the shape check catches the paste people actually make', () => {
    it('accepts a real-shaped refresh token', () => {
        expect(looksLikeRefreshToken('1//0gYf-EXAMPLE_refresh_token_value_abcdefghijklmnop')).toBe(true);
        expect(looksLikeRefreshToken('a'.repeat(64))).toBe(true);
    });

    it.each([
        ['an ACCESS token', 'ya29.a0ARrdaM-EXAMPLE_access_token_value_here_padding'],
        ['an authorization CODE', '4/0AY0e-g7EXAMPLE_auth_code_value_here_padding_xx'],
        ['a client SECRET', 'GOCSPX-EXAMPLEsecretvaluehere0000'],
        ['the whole JSON blob', '{"refresh_token":"1//0gexample","scope":"https://www.googleapis.com/auth/gmail.readonly"}'],
        ['an ID token / JWT', 'eyJhbGciOi.eyJzdWIiOi.SflKxwRJSM.extra'],
        ['something with whitespace', '1//0g example token'],
        ['far too short', 'abc'],
        ['empty', ''],
        ['null', null],
    ])('rejects %s', (_why, v) => {
        expect(looksLikeRefreshToken(v)).toBe(false);
    });

    it('is the general shape rule that rejects them, not the named prefixes', () => {
        /* HONEST ABOUT WHAT IS DOING THE WORK. Removing the `ya29.` guard
         * entirely changes no outcome, because every value it targets contains
         * a dot and the closing rule is `^1//` or `^[\w-]+$` — a dot matches
         * neither. A mutation deleting that guard survived, correctly.
         *
         * The named prefixes stay because they document which mistakes this is
         * built for, and because the closing rule could be loosened later
         * without anyone noticing they had become the only defence. But the
         * test should not imply they are load-bearing today. */
        const withoutPrefixGuards = (v) => {
            const t = String(v).trim();
            return !(t.length < 20 || t.length > 512 || /\s/.test(t) || t.startsWith('{') || t.startsWith('['))
                && t.split('.').length <= 3
                && /^1\/\/|^[\w-]+$/.test(t);
        };
        for (const v of ['ya29.a0ARrdaM-EXAMPLE_access_token_value_here', '4/0AY0e-g7EXAMPLE_auth_code_value_padding']) {
            expect(withoutPrefixGuards(v), `${v} would pass without the prefix guard`).toBe(false);
        }
        // and the guards are still present, as documentation of intent
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-link.mjs'), 'utf8');
        expect(src).toContain("startsWith('ya29.')");
        expect(src).toContain("startsWith('4/')");
    });

    it('is a SHAPE check and never asks Google', async () => {
        /* Validating for real would turn this endpoint into an oracle for
         * testing tokens against Google. */
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-link.mjs'), 'utf8');
        const fn = src.slice(src.indexOf('export function looksLikeRefreshToken'), src.indexOf('export function linkRecord'));
        expect(fn).not.toMatch(/fetch|http|oauth2\.googleapis/i);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS STORED AND WHAT IS TOLD BACK
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the record, and the answer', () => {
    it('does NOT write a historyId when linking', () => {
        /* gmail-hook.js reads historyId as "everything up to here is already
         * seen" and asks Gmail only for what came after. Writing one at link
         * time would silently skip every statement already in the mailbox. */
        const rec = linkRecord('person@gmail.com', '1//0gtoken_value_padding_here', 1000);
        expect(rec).toEqual({ refresh_token: '1//0gtoken_value_padding_here', email: 'person@gmail.com', linkedAt: 1000 });
        expect(rec).not.toHaveProperty('historyId');
    });

    it('NEVER returns the token, or any part of it', () => {
        /* THE ONE THAT WOULD HURT MOST. A prefix, a suffix or even a length
         * turns this into a way to read a credential back a few bits at a time.
         * That credential opens the owner's entire mailbox. */
        const secret = '1//0gSUPERSECRETrefreshtokenvalue';
        const s = statusOf({ refresh_token: secret, email: 'p@g.com', linkedAt: 5, lastPushMs: 9, historyId: '42' });
        const json = JSON.stringify(s);
        expect(json).not.toContain(secret);
        expect(json).not.toContain('SUPERSECRET');
        expect(json).not.toContain('1//0g');
        expect(s).not.toHaveProperty('refresh_token');
        expect(json).not.toMatch(/\b3[0-9]\b/);          // no length leak
    });

    it('reports connected, and enough to show it is working', () => {
        expect(statusOf({ refresh_token: 'x'.repeat(40), email: 'p@g.com', linkedAt: 5, lastPushMs: 9, historyId: '42' }))
            .toEqual({ connected: true, email: 'p@g.com', linkedAt: 5, lastPushMs: 9, historyId: '42' });
    });

    it('reports not connected for a document with no token', () => {
        for (const d of [null, {}, { email: 'p@g.com' }, { refresh_token: '' }]) {
            expect(statusOf(d)).toEqual({ connected: false });
        }
    });

    it('distinguishes linked from linked-and-working', () => {
        // lastPushMs only appears once the hook has actually run.
        expect(statusOf({ refresh_token: 'x'.repeat(40), linkedAt: 5 }).lastPushMs).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * SAYING WHICH PIECE IS MISSING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the configuration report', () => {
    it('names every variable the hook actually reads', () => {
        /* Reporting a name the pipeline does NOT read would send somebody to set
         * a variable that changes nothing, which is exactly what happened before
         * this existed.
         *
         * The search follows the read rather than one file. accessTokenFrom moved
         * to google-oauth.mjs when /api/gmail-watch needed the identical refresh
         * exchange, so GOOGLE_OAUTH_CLIENT_ID is still read on every push — one
         * import further along. Pinning the check to gmail-hook.js alone would
         * have called that an unread variable and pushed the next person to stop
         * reporting a name the pipeline genuinely requires. */
        const dir = path.resolve(import.meta.dirname, '..');
        const readers = ['gmail-hook.js', 'google-oauth.mjs']
            .map((f) => fs.readFileSync(path.join(dir, f), 'utf8'))
            .join('\n');
        for (const name of missingConfig({})) {
            expect(readers, `${name} is reported missing but nothing on the push path reads it`)
                .toContain(`env.${name}`);
        }
    });

    it('the files it searches are the ones the hook actually pulls in', () => {
        /* Otherwise the check above degrades quietly: add a file to the list and
         * it will find anything, whether or not the hook still uses it. */
        const hook = fs.readFileSync(path.resolve(import.meta.dirname, '../gmail-hook.js'), 'utf8');
        expect(hook).toContain("from './google-oauth.mjs'");
    });

    it('reports nothing missing once they are set', () => {
        expect(missingConfig({
            GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret',
            GMAIL_PUBSUB_AUDIENCE: 'https://example/api/gmail-hook',
        })).toEqual([]);
    });

    it('treats whitespace as unset', () => {
        expect(missingConfig({ GOOGLE_OAUTH_CLIENT_ID: '   ' })).toContain('GOOGLE_OAUTH_CLIENT_ID');
        expect(oauthConfigured({ GOOGLE_OAUTH_CLIENT_ID: ' ', GOOGLE_OAUTH_CLIENT_SECRET: 'x' })).toBe(false);
    });

    it('exports what the endpoint needs', () => {
        for (const fn of ['identify', 'userKeyFor', 'looksLikeRefreshToken', 'linkRecord', 'statusOf', 'missingConfig']) {
            expect(typeof G[fn], fn).toBe('function');
        }
    });
});
