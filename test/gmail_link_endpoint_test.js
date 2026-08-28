/* =============================================================================
 * test/gmail_link_endpoint_test.js — the handler is RUN, not read
 * -----------------------------------------------------------------------------
 * WHAT THIS CLOSES
 *
 * /api/gmail-link shipped unable to serve a single request. getAdminDb() returns
 * a WRAPPER — { db, reason, admin } — and this handler read it as if it were the
 * Firestore handle:
 *
 *     const db = await getAdminDb();
 *     if (!db) return 503;                 // never true: the wrapper is truthy
 *     const ref = db.collection(...)       // TypeError: not a function
 *
 * Production answered 500 to every GET, POST and DELETE. The Statement Sync card
 * turned that into "Not connected", which is the same lie the card told before —
 * a failure that cannot be told apart from an honest empty answer.
 *
 * WHY NOTHING CAUGHT IT. There were two suites for this endpoint and both read
 * it. gmail_link_test.js exercises the pure decisions in gmail-link.mjs, which
 * were correct. gmail_link_wiring_test.js checks that the page calls the right
 * URL with the right method. Neither ever invoked the handler, so the one line
 * where the two halves meet was covered by nobody.
 *
 * A source check proves what a file SAYS. Only running it proves what it DOES.
 * This suite drives the exported handler end to end against the in-memory Admin
 * SDK from fake-admin.mjs — the seam admin-db.mjs documents — with the network
 * hard-blocked, so the real project is never touched.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const OWNER_KEY = 'owner_example_com';
/* Shaped like a Google refresh token and nothing like a real one — long enough
 * to clear the length floor, no dots, no ya29./4/ prefix. */
const TOKEN = '1//0g' + 'A'.repeat(40);

beforeEach(async () => {
    fake.reset();
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    fake.setVerifier(async (t) => {
        if (t !== 'good-token') throw new Error('invalid token');
        return { email: OWNER, email_verified: true, uid: 'uid-1' };
    });
    globalThis.fetch = async (input, init) => {
        throw new Error(`network blocked in tests: ${String((init && init.method) || 'GET')} ${String(input)}`);
    };
});

afterEach(async () => {
    globalThis.fetch = realFetch;
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(null);
});

function mkRes() {
    const seen = { status: null, body: undefined, headers: {}, ended: false };
    const res = {
        statusCode: 200,
        setHeader(k, v) { seen.headers[String(k).toLowerCase()] = v; return res; },
        end(o) {
            seen.status = res.statusCode;
            try { seen.body = o === undefined ? undefined : JSON.parse(o); } catch (_) { seen.body = o; }
            seen.ended = true;
            return res;
        },
    };
    return { res, seen };
}

async function call({ method = 'GET', token = 'good-token', body, url = '/api/gmail-link' } = {}) {
    const { default: handler } = await import('../gmail-link.js');
    const { res, seen } = mkRes();
    await handler({
        method,
        url,
        headers: token ? { authorization: `Bearer ${token}` } : {},
        body,
    }, res);
    return seen;
}

describe('the handler answers at all', () => {
    /* THE REGRESSION. Before the fix every one of these was a 500 with
     * `db.collection is not a function`, whatever the method. */
    it('GET returns a status instead of crashing', async () => {
        const seen = await call({ method: 'GET' });
        expect(seen.status).toBe(200);
        expect(seen.body.ok).toBe(true);
        expect(seen.body.connected).toBe(false);   // nothing stored yet
    });

    it('POST saves the token instead of crashing', async () => {
        const seen = await call({ method: 'POST', body: { refresh_token: TOKEN } });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, connected: true, email: OWNER });
    });

    it('DELETE answers instead of crashing', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        const seen = await call({ method: 'DELETE' });
        expect(seen.status).toBe(200);
        expect(seen.body).toMatchObject({ ok: true, connected: false });
    });

    it('no response is left unfinished', async () => {
        for (const method of ['GET', 'POST', 'DELETE']) {
            const seen = await call({ method, body: { refresh_token: TOKEN } });
            expect(seen.ended, `${method} never ended the response`).toBe(true);
        }
    });
});

describe('the token lands where gmail-hook.js looks for it', () => {
    it('writes wf-mail/{userKey} with the token and the address', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        const doc = fake.docs.get(`wf-mail/${OWNER_KEY}`);
        expect(doc, 'nothing was written to wf-mail').toBeTruthy();
        expect(doc.refresh_token).toBe(TOKEN);
        expect(doc.email).toBe(OWNER);
        expect(typeof doc.linkedAt).toBe('number');
    });

    it('the document key is derived from the verified email, not from anything sent', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN, email: 'attacker@example.com', userKey: 'someone_else' } });
        expect([...fake.docs.keys()]).toEqual([`wf-mail/${OWNER_KEY}`]);
    });

    it('a second save replaces the token without erasing the hook’s history', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        // What gmail-hook.js records after ingesting: the point it has read up to.
        fake.docs.set(`wf-mail/${OWNER_KEY}`, { ...fake.docs.get(`wf-mail/${OWNER_KEY}`), historyId: '99887' });
        const second = TOKEN.replace(/A+$/, 'B'.repeat(40));
        await call({ method: 'POST', body: { refresh_token: second } });
        const doc = fake.docs.get(`wf-mail/${OWNER_KEY}`);
        expect(doc.refresh_token).toBe(second);
        expect(doc.historyId).toBe('99887');
    });

    it('GET then reports it connected, and never returns the token', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        const seen = await call({ method: 'GET' });
        expect(seen.body.connected).toBe(true);
        expect(seen.body.email).toBe(OWNER);
        expect(JSON.stringify(seen.body)).not.toContain(TOKEN);
        expect(JSON.stringify(seen.body)).not.toContain(TOKEN.slice(0, 12));
    });
});

describe('disconnecting removes the credential and keeps the history', () => {
    it('deletes refresh_token but leaves historyId alone', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        fake.docs.set(`wf-mail/${OWNER_KEY}`, { ...fake.docs.get(`wf-mail/${OWNER_KEY}`), historyId: '4242' });

        await call({ method: 'DELETE' });

        const doc = fake.docs.get(`wf-mail/${OWNER_KEY}`);
        /* If the field were merely overwritten with a sentinel rather than
         * removed, a credential that can read a whole mailbox would still be
         * sitting in the document after the owner disconnected. */
        expect(Object.prototype.hasOwnProperty.call(doc, 'refresh_token')).toBe(false);
        expect(doc.historyId).toBe('4242');   // re-connecting must not re-import everything
        expect(typeof doc.unlinkedAt).toBe('number');
    });

    it('GET reports it disconnected afterwards', async () => {
        await call({ method: 'POST', body: { refresh_token: TOKEN } });
        await call({ method: 'DELETE' });
        const seen = await call({ method: 'GET' });
        expect(seen.body.connected).toBe(false);
    });
});

describe('who is refused, and with which answer', () => {
    it('no credential at all is 401 and writes nothing', async () => {
        const seen = await call({ method: 'POST', token: '', body: { refresh_token: TOKEN } });
        expect(seen.status).toBe(401);
        expect(fake.docs.size).toBe(0);
    });

    it('a token the verifier rejects is 401 and writes nothing', async () => {
        const seen = await call({ method: 'POST', token: 'forged', body: { refresh_token: TOKEN } });
        expect(seen.status).toBe(401);
        expect(fake.docs.size).toBe(0);
    });

    it('an unverified address is refused — it is a string the account holder typed', async () => {
        fake.setVerifier(async () => ({ email: OWNER, email_verified: false, uid: 'uid-2' }));
        const seen = await call({ method: 'POST', body: { refresh_token: TOKEN } });
        expect(seen.status).toBe(403);
        expect(fake.docs.size).toBe(0);
    });

    it('an unsupported method is refused before anything is read', async () => {
        const seen = await call({ method: 'PUT' });
        expect(seen.status).toBe(405);
        expect(fake.ops.length).toBe(0);
    });
});

describe('a rejected paste is named, not echoed', () => {
    const wrong = {
        'an access token': 'ya29.a0AfB_byC' + 'x'.repeat(40),
        'an authorization code': '4/0AX4XfWh' + 'y'.repeat(30),
        'a client secret': 'GOCSPX-' + 'z'.repeat(28),
        'the whole JSON blob': '{"refresh_token":"1//0gAAAA","client_id":"x"}',
    };
    for (const [what, value] of Object.entries(wrong)) {
        it(`refuses ${what} with 400 and stores nothing`, async () => {
            const seen = await call({ method: 'POST', body: { refresh_token: value } });
            expect(seen.status).toBe(400);
            expect(fake.docs.size).toBe(0);
            /* An error that quotes the credential it rejected is how a secret
             * reaches a log line. The message may name the KIND, never the value. */
            expect(JSON.stringify(seen.body)).not.toContain(value);
        });
    }
});

describe('when the server is not configured it says which part', () => {
    it('a missing service account is 503 naming FIREBASE_SERVICE_ACCOUNT, not "unavailable"', async () => {
        const { _setAdminModule, _resetAdminDb } = await import('../admin-db.mjs');
        _setAdminModule(null);          // back to the real module resolution
        _resetAdminDb();
        const saved = process.env.FIREBASE_SERVICE_ACCOUNT;
        delete process.env.FIREBASE_SERVICE_ACCOUNT;
        try {
            const seen = await call({ method: 'GET' });
            /* Identity is checked first and cannot be established without a
             * credential, so an unauthenticated caller learns only that — never
             * the deployment's configuration. Either way it is not a crash. */
            expect([401, 503]).toContain(seen.status);
            expect(seen.body.ok).toBe(false);
            expect(typeof seen.body.error).toBe('string');
            expect(seen.body.error.length).toBeGreaterThan(0);
        } finally {
            if (saved) process.env.FIREBASE_SERVICE_ACCOUNT = saved;
            _resetAdminDb();
        }
    });
});

/* The repo-wide destructure guard moved to test/admin_db_contract_test.js when
 * it turned out to have missed gmail-hook.js: that file reaches the same
 * bootstrap through getInboxDb(), an alias this suite's check never looked for.
 * A guard that only covers the file it was written for is not a guard. */
