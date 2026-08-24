/* =============================================================================
 * test/statement_chunk_test.js — large PDFs stay on WealthFlow's own Firestore
 * -----------------------------------------------------------------------------
 * WHAT THIS REPLACES
 *
 * Sharing an Elite Report used to run a two-stage chain. Stage A stored the PDF
 * in one Firestore document; Stage B — reached whenever Stage A produced no URL,
 * which INCLUDED every PDF too large for a single document — uploaded the report
 * to file.io / 0x0.st / tmpfiles, public zero-auth file hosts, and returned their
 * domain as the "share" link. statement-store had the same 0x0.st fallback of its
 * own. The bigger the report, the likelier a month of someone's finances was
 * published to a pastebin.
 *
 * A large PDF now CHUNKS across sibling Firestore documents s/<id>-0 … s/<id>-N
 * with a manifest s/<id> written LAST, and statement-view reassembles it. No
 * third party, and no size limit that would send anyone to one.
 *
 * NOTHING HERE TOUCHES THE NETWORK. `fetch` is replaced with an in-memory
 * Firestore that BOTH handlers drive, so a store→view round-trip is exercised
 * end to end; any URL that is not this fake Firestore fails the test that reached
 * for it — which is also how "uploads to no third party" is proven at runtime.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import crypto from 'node:crypto';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

process.env.FIREBASE_API_KEY = 'test-key-not-a-real-credential';
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

/* WRITES go through the Admin SDK now, so firebase-admin is mocked. READS stay on
 * the REST API — statement-view.js serves a public link and has no service
 * account — so fetch is still stubbed, and the split is itself the assertion:
 * a write that reached for fetch, or a read that reached the real network, fails
 * the test that did it. */
const fake = makeFakeAdmin();

const realFetch = globalThis.fetch;
const FS_HOST = 'firestore.googleapis.com';

function jsonRes(status, obj) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

/** Serve statement-view's REST GETs out of the SAME store the Admin writes went
 *  into, so a store→view round-trip is genuinely end to end. */
function restRead(url) {
    const after = url.split('/documents/')[1] || '';
    const path = after.split('?')[0];
    if (!fake.docs.has(path)) return jsonRes(404, { error: { message: 'NOT_FOUND' } });
    const data = fake.docs.get(path);
    const fields = {};
    for (const [k, v] of Object.entries(data)) {
        if (typeof v === 'string') fields[k] = { stringValue: v };
        else if (typeof v === 'boolean') fields[k] = { booleanValue: v };
        else if (typeof v === 'number') fields[k] = { integerValue: String(v) };
    }
    return jsonRes(200, { name: path, fields });
}

let calls, blocked;

beforeEach(async () => {
    fake.reset();
    calls = [];
    blocked = [];
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);           // inject the in-memory Firestore
    globalThis.fetch = async (input, init) => {
        const url = String(input && input.url ? input.url : input);
        const method = String((init && init.method) || 'GET').toUpperCase();
        calls.push(url);
        if (url.includes(FS_HOST) && method === 'GET') return restRead(url);
        if (url.includes(FS_HOST) && method === 'PATCH') return jsonRes(200, {});  // view counter
        blocked.push(`${method} ${url}`);
        throw new Error('network blocked in tests: ' + url);
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
    expect(blocked, `a test reached the network or wrote over REST:\n  ${blocked.join('\n  ')}`).toEqual([]);
});

function mkRes() {
    const seen = { status: null, body: undefined, headers: {}, ended: false };
    const res = {
        status(c) { seen.status = c; return res; },
        json(o) { seen.body = o; seen.ended = true; return res; },
        send(o) { seen.body = o; seen.ended = true; return res; },
        end(o) { if (o !== undefined) seen.body = o; seen.ended = true; return res; },
        setHeader(k, v) { seen.headers[String(k).toLowerCase()] = v; return res; },
        getHeader(k) { return seen.headers[String(k).toLowerCase()]; },
        get headersSent() { return seen.ended; },
        get writableEnded() { return seen.ended; },
    };
    return { res, seen };
}

async function store(body) {
    const { default: handler } = await import('../statement-store.js');
    const { res, seen } = mkRes();
    await handler({ method: 'POST', url: '/api/statement-store', headers: {}, query: {}, body }, res);
    return seen;
}

async function view(query) {
    const { default: handler } = await import('../statement-view.js');
    const { res, seen } = mkRes();
    await handler({ method: 'GET', url: '/api/statement-view', headers: {}, query }, res);
    return seen;
}

const BANNED = ['file.io', '0x0.st', 'tmpfiles.org', 'dpaste.com', 'transfer.sh'];
function assertNoThirdParty() {
    for (const host of BANNED) {
        expect(calls.filter((u) => u.includes(host)),
            `a request was made to ${host}`).toEqual([]);
    }
}

describe('a small PDF is stored inline in one document and served back', () => {
    it('round-trips byte-for-byte', async () => {
        const original = crypto.randomBytes(100 * 1024);   // base64 ≈ 133 KB < single-doc cap
        const b64 = original.toString('base64');

        const s = await store({ pdfBase64: b64, name: 'Small Report' });
        expect(s.status).toBe(200);
        expect(s.body.kind).toBe('pdf');
        const id = s.body.id;

        // exactly one document, inline, not chunked
        expect(fake.order).toEqual([`s/${id}`]);
        const doc = fake.docs.get(`s/${id}`);
        expect(doc.pdf).toBe(b64);
        expect(doc.chunked).toBeUndefined();

        const v = await view({ id });
        expect(v.status, 'a PDF document must serve, not 404 on the empty-HTML guard').toBe(200);
        expect(v.headers['content-type']).toBe('application/pdf');
        expect(Buffer.isBuffer(v.body)).toBe(true);
        expect(Buffer.compare(v.body, original)).toBe(0);
        assertNoThirdParty();
    });
});

describe('a large PDF chunks across sibling documents and reassembles', () => {
    it('round-trips byte-for-byte through the chunk store', async () => {
        const original = crypto.randomBytes(1_200_000);    // base64 ≈ 1.6 MB → 3 chunks
        const b64 = original.toString('base64');

        const s = await store({ pdfBase64: b64, name: 'Elite Report — July 2026' });
        expect(s.status).toBe(200);
        const id = s.body.id;

        const manifest = fake.docs.get(`s/${id}`);
        expect(manifest, 'no manifest was written').toBeTruthy();
        expect(manifest.chunked).toBe(true);
        const parts = manifest.parts;
        expect(parts).toBeGreaterThan(1);
        expect(manifest.pdf, 'the manifest must not also carry the payload').toBeUndefined();

        // every part exists, and the manifest is the LAST thing written
        for (let i = 0; i < parts; i++) expect(fake.docs.has(`s/${id}-${i}`), `part ${i} missing`).toBe(true);
        expect(fake.order[fake.order.length - 1], 'manifest was not written last').toBe(`s/${id}`);

        const v = await view({ id });
        expect(v.status).toBe(200);
        expect(v.headers['content-type']).toBe('application/pdf');
        expect(Buffer.compare(v.body, original), 'reassembled PDF differs from the original').toBe(0);
        assertNoThirdParty();
    });

    it('reports meta for a chunked PDF instead of 404', async () => {
        const original = crypto.randomBytes(1_200_000);
        const s = await store({ pdfBase64: original.toString('base64'), name: 'Meta' });
        const m = await view({ id: s.body.id, meta: '1' });
        expect(m.status).toBe(200);
        expect(m.body.kind).toBe('pdf');
        expect(m.body.chunked).toBe(true);
        expect(m.body.parts).toBeGreaterThan(1);
    });
});

describe('the manifest is the proof of a complete upload', () => {
    it('a failed chunk write leaves NO manifest, so nothing partial can be read', async () => {
        // Fail the write of chunk -1. Promise.all rejects, the manifest is never
        // written, and there is no third-party fallback — the share fails honestly.
        fake.setFailOn((path, op) => (op === 'create' && /-1$/.test(path)) ? new Error('injected failure') : null);

        const original = crypto.randomBytes(1_200_000);
        const s = await store({ pdfBase64: original.toString('base64'), name: 'Broken' });

        expect(s.status, 'a failed store must not report success').toBe(502);
        expect(s.body.error).toBe('all_hosts_failed');

        // orphan chunks may exist, but NO manifest (8-char alnum id, no dash)
        const manifestKeys = [...fake.docs.keys()].filter((k) => /^s\/[A-Za-z0-9]{8}$/.test(k));
        expect(manifestKeys, 'a manifest was written despite an incomplete upload').toEqual([]);
        assertNoThirdParty();
    });

    it('a chunk that goes missing after the fact yields 502, never a truncated PDF', async () => {
        const original = crypto.randomBytes(1_200_000);
        const s = await store({ pdfBase64: original.toString('base64'), name: 'Losspart' });
        const id = s.body.id;

        fake.docs.delete(`s/${id}-1`);            // simulate a part becoming unreadable
        const v = await view({ id });
        expect(v.status).toBe(502);
        expect(v.body.error).toBe('chunk_unavailable');
    });
});

describe('statement-store reaches for no third-party host at all', () => {
    it('stores a large PDF using only Firestore', async () => {
        const original = crypto.randomBytes(2_000_000);   // base64 ≈ 2.7 MB → 4 chunks
        const s = await store({ pdfBase64: original.toString('base64'), name: 'Big' });
        expect(s.status).toBe(200);
        expect(calls.filter((u) => !u.includes(FS_HOST)), 'a non-Firestore URL was fetched').toEqual([]);
        assertNoThirdParty();
    });
});
