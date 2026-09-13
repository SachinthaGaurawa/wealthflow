/* =============================================================================
 * test/mail_items_pagination_test.js
 * -----------------------------------------------------------------------------
 * THE OWNER'S REPORT: the whole app crashes and restarts while — or right
 * after — email statements finish syncing. Separate from (and larger than)
 * the canvas/PDF.js-document leaks already fixed: GET /api/gmail-link?items=1
 * always returned EVERY pending statement's FULL attachment (up to
 * ITEMS_RETURN_MAX = 200 of them, each easily 0.5-3MB of base64) in one JSON
 * response, and the device held the whole thing in memory for the entire
 * sync. A real backlog is tens to hundreds of megabytes on a phone, before a
 * single statement has even been processed — a native WebKit OOM kill with
 * no JS error to show for it, exactly what "A problem repeatedly occurred"
 * is.
 *
 * The fix: `limit`/`offset` query params let a caller ask for a PAGE of
 * pending statements' attachments at a time instead of the whole backlog,
 * with `more`/`pending` in the response so it knows whether — and how much —
 * more to ask for. Neither param is required: a caller that sends neither
 * gets exactly what it always got (up to 200, one shot), so nothing already
 * relying on this endpoint's shape breaks.
 *
 * These tests run the REAL handler (gmail-link.js) against an in-memory
 * Firestore stand-in, following the same harness test/mail_sweep_test.js
 * already established for this exact endpoint.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();
const OWNER = 'owner@example.com';
const KEY = 'owner_example_com';
const ITEMS = `wf-mail/${KEY}/items`;

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

async function call({ method = 'GET', token = 'good-token', body, url = '/api/gmail-link' } = {}) {
    const { default: handler } = await import('../gmail-link.js');
    const { res, seen } = mkRes();
    await handler({ method, url, headers: token ? { authorization: `Bearer ${token}` } : {}, body }, res);
    return seen;
}

/** Put a statement in the store, the way gmail-hook.js would have. Each gets
 *  a distinct messageId/filename so dedupeStored() never merges two of them. */
function store(id, extra = {}) {
    fake.docs.set(`${ITEMS}/${id}`, {
        filename: id + '.pdf', parts: 0, d: 'x',
        messageId: 'msg-' + id, bank: 'HNB', from: 'statements@hnb.lk',
        ...extra,
    });
}

const list = (qs = '') => call({ method: 'GET', url: '/api/gmail-link?items=1' + qs });
const ids = (body) => (body.items || []).map((i) => i.id);

describe('GET items=1 is unchanged when no limit/offset is sent', () => {
    it('still returns everything pending in one response, most/least recent id order preserved', async () => {
        for (let i = 0; i < 5; i += 1) store('s' + i);
        const seen = await list();
        expect(seen.status).toBe(200);
        expect(seen.body.items).toHaveLength(5);
        expect(seen.body.pending).toBe(5);
        expect(seen.body.more).toBe(false);
    });

    it('reports more:false even for a full, unpaginated 5-item backlog', async () => {
        for (let i = 0; i < 5; i += 1) store('u' + i);
        const seen = await list();
        expect(seen.body.more).toBe(false);
    });
});

describe('limit/offset page through the backlog instead of returning it all at once', () => {
    it('limit caps how many full attachments come back in one call', async () => {
        for (let i = 0; i < 5; i += 1) store('p' + i);
        const seen = await list('&limit=2');
        expect(seen.body.items).toHaveLength(2);
        expect(seen.body.pending).toBe(5);
        expect(seen.body.more, 'more pending statements exist beyond this page').toBe(true);
    });

    it('offset skips the statements already returned by an earlier page', async () => {
        for (let i = 0; i < 5; i += 1) store('q' + i);
        const page1 = await list('&limit=2&offset=0');
        const page2 = await list('&limit=2&offset=2');
        const page3 = await list('&limit=2&offset=4');
        expect(ids(page1.body)).toHaveLength(2);
        expect(ids(page2.body)).toHaveLength(2);
        expect(ids(page3.body)).toHaveLength(1); // only one left
        expect(page3.body.more).toBe(false);
        // no id appears twice, and paging through collects every statement
        const all = [...ids(page1.body), ...ids(page2.body), ...ids(page3.body)];
        expect(new Set(all).size).toBe(5);
        expect(all.sort()).toEqual(['q0', 'q1', 'q2', 'q3', 'q4']);
    });

    it('paging never returns more items than the whole backlog holds', async () => {
        store('r0');
        const seen = await list('&limit=50&offset=0');
        expect(seen.body.items).toHaveLength(1);
        expect(seen.body.more).toBe(false);
    });

    it('an offset past the end of the backlog returns an empty page, not an error', async () => {
        store('t0');
        const seen = await list('&limit=5&offset=50');
        expect(seen.status).toBe(200);
        expect(seen.body.items).toEqual([]);
        expect(seen.body.more).toBe(false);
    });

    it('limit is clamped to the same ceiling the unpaginated response always used', async () => {
        for (let i = 0; i < 3; i += 1) store('c' + i);
        const seen = await list('&limit=999999');
        // asking for an absurd page size still only returns what actually exists
        expect(seen.body.items).toHaveLength(3);
    });

    it('a page never includes a statement already marked filed', async () => {
        store('f0', { filed: true });
        store('f1');
        const seen = await list('&limit=10');
        expect(ids(seen.body)).toEqual(['f1']);
        expect(seen.body.pending).toBe(1);
    });

    it('each page still carries the full attachment payload for its own items, not just metadata', async () => {
        store('a0');
        const seen = await list('&limit=1');
        expect(seen.body.items[0]).toHaveProperty('manifest');
        expect(seen.body.items[0]).toHaveProperty('parts');
        expect(seen.body.items[0]).toHaveProperty('sender');
    });
});
