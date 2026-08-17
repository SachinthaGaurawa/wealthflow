/* =============================================================================
 * test/api_runtime_contract_test.js — the router and its handlers must agree
 * about HOW they are called, not merely that they exist
 * -----------------------------------------------------------------------------
 * WHAT WAS BROKEN
 *
 * Vercel builds exactly one function from api/, and it is a NODE function:
 * api/router.js exports `handler(req, res)`, vercel.json gives it a maxDuration,
 * and `setCors(res)` on its first line would throw on every request if Vercel
 * were passing a Web `Request`. So every handler the router delegates to is
 * invoked with Node's `(req, res)`.
 *
 * Twelve of the 33 routed handlers were written against the Web Fetch API
 * instead, each declaring `export const config = { runtime: 'edge' }` at the top
 * of its own file. That export is dead metadata — Vercel reads `config` only
 * from files it BUILDS as functions, and these live at the repo root, which is
 * the entire reason the router exists. Measured by driving every route through
 * the real router with a faithful Node req/res:
 *
 *   inbox-push / inbox-pull / inbox-ack → 500  ReferenceError: res is not defined
 *   ios-shortcut                        → 500  Invalid URL
 *   the other eight                     → NO ANSWER AT ALL
 *
 * The last group is the worst of the three. Each handler computed the right
 * answer, built a `Response`, and returned it; `return await fn(req, res)`
 * handed that value to Vercel's Node launcher, which ignores a return value and
 * waits for `res` to be written. Nothing ever wrote it, so the request sat until
 * maxDuration and died as FUNCTION_INVOCATION_TIMEOUT — sixty seconds of silence
 * for work that finished in milliseconds.
 *
 * WHY NOTHING CAUGHT IT
 *
 * test/api_contract_test.js compares the two sides as TEXT: every endpoint the
 * client calls has a route, every route names a file that exists, no handler is
 * stranded. All of that was true the whole time. A contract check that reads
 * source can see that two parties were introduced; it cannot see that they
 * disagree about the calling convention. This file closes that by actually
 * invoking them.
 *
 * NOTHING HERE MAY TOUCH THE NETWORK
 *
 * These handlers talk to the live Firestore project and to sibling /api routes,
 * so an unstubbed fetch in a test run is a write against real infrastructure,
 * not a test. `fetch` is therefore replaced for every test in this file, and any
 * URL no stub claims is recorded as a violation that fails the test which caused
 * it. FIREBASE_PROJECT_ID is also pointed at a name that does not exist, so the
 * blocked path cannot name a real database even in principle.
 *
 * This is a hard requirement rather than hygiene: it was learned the expensive
 * way while investigating this defect.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Read before any handler module is imported: each captures FIREBASE_API_KEY
// into a module-level const at load time. The project id is a deliberately
// non-existent one, so even a fetch that somehow escaped the stub below could
// not name the real database.
process.env.FIREBASE_API_KEY = 'test-key-not-a-real-credential';
process.env.FIREBASE_PROJECT_ID = 'wealthflow-test-does-not-exist';

const HOST = 'wealthflow.test';
const TOKEN = 'x'.repeat(24);          // ≥16 chars, so it passes the token gate
const realFetch = globalThis.fetch;

let stubs;        // [RegExp, (url, init) => Response]
let blocked;      // URLs no stub claimed
let calls;        // every request the handlers attempted

function json(status, obj) {
    return new Response(JSON.stringify(obj), {
        status, headers: { 'Content-Type': 'application/json' },
    });
}

beforeEach(() => {
    stubs = [];
    blocked = [];
    calls = [];
    globalThis.fetch = async (input, init) => {
        const url = String(input && input.url ? input.url : input);
        calls.push({ url, method: String((init && init.method) || 'GET').toUpperCase() });
        for (const [re, make] of stubs) if (re.test(url)) return make(url, init);
        blocked.push(url);
        throw new Error('network blocked in tests: ' + url);
    };
    // Captured by reference at module load, so it must be cleared rather than
    // replaced or state leaks between tests.
    if (globalThis.__wfMemStore) globalThis.__wfMemStore.clear();
});

afterEach(() => {
    globalThis.fetch = realFetch;
    expect(blocked, `a test reached for the real network:\n  ${blocked.join('\n  ')}`).toEqual([]);
});

/** Vercel's Node request: req.url is a PATH, req.headers is a plain object,
 *  req.body is already parsed, req.query carries the rewrite's merged query. */
function mkReq(name, { method = 'GET', body, headers = {}, query = {} } = {}) {
    const h = { host: HOST, 'content-type': 'application/json' };
    for (const k of Object.keys(headers)) h[k.toLowerCase()] = headers[k];
    const q = new URLSearchParams({ path: name, ...query }).toString();
    return { method, url: `/api/router?${q}`, headers: h, query: { path: name, ...query }, body, cookies: {} };
}

/** Vercel's Node response, recording what a real client would receive. */
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

/** Drive one endpoint through the REAL router and report what came back. */
async function call(name, opts) {
    const { default: router } = await import('../api/router.js');
    const { res, seen } = mkRes();
    await router(mkReq(name, opts), res);
    let body = seen.body;
    if (Buffer.isBuffer(body) || typeof body === 'string') {
        try { body = JSON.parse(String(body)); } catch (_) { body = String(body); }
    }
    return { status: seen.status, body, headers: seen.headers, answered: seen.ended };
}

const FS = /firestore\.googleapis\.com/;

// ── 1. every routed endpoint answers at all ──────────────────────────────────

describe('THE BUG: every routed endpoint must write a response', () => {
    /* Before the bridge, eight of these returned a Response the router threw
     * away and four crashed. `answered` false is the production hang. */
    const EVERY = [
        ['inbox-push', { method: 'POST', headers: { 'x-wf-device-token': TOKEN }, body: { brain_result: { hash: 'h' } } }],
        ['inbox-pull', { method: 'GET', headers: { 'x-wf-device-token': TOKEN } }],
        ['inbox-ack', { method: 'POST', headers: { 'x-wf-device-token': TOKEN }, body: { keys: [] } }],
        ['sms-ingest', { method: 'GET' }],
        ['fx-rate', { method: 'GET' }],
        ['ios-shortcut', { method: 'GET' }],
        ['merchant-search', { method: 'GET' }],
        ['feedback', { method: 'POST', body: { type: 'bug', text: '' } }],
        ['fifo-reconcile', { method: 'POST', body: {} }],
        ['predict-wealth', { method: 'POST', body: {} }],
        ['vision-sms', { method: 'POST', body: {} }],
        ['version', { method: 'GET' }],
        ['health', { method: 'GET' }],
        ['autonomy-status', { method: 'GET' }],
    ];

    for (const [name, opts] of EVERY) {
        it(`/api/${name} answers with a real HTTP status`, async () => {
            // Everything outbound is stubbed generously here: this test is about
            // whether an answer arrives at all, not which answer. The catch-all is
            // last, so the specific stubs still shape the common cases — and it is
            // a stub rather than a hole, so nothing escapes to the real network
            // (fx-rate reaches for api.exchangerate.host, which is how this guard
            // proved it was working).
            stubs.push([FS, () => json(200, { documents: [] })]);
            stubs.push([/\/api\//, () => json(200, { ok: true })]);
            stubs.push([/^https?:\/\//, () => json(200, {})]);

            const r = await call(name, opts);
            expect(r.answered, `/api/${name} returned without answering — this is the production hang`).toBe(true);
            expect(typeof r.status, `/api/${name} wrote no status code`).toBe('number');
            expect(r.status).toBeGreaterThanOrEqual(200);
            expect(r.status).toBeLessThan(600);
            // The crash signature of the original defect, asserted by name so a
            // regression cannot hide behind a generic 500.
            const detail = JSON.stringify(r.body || '');
            expect(detail, `/api/${name} still crashes inside the handler`).not.toMatch(/res is not defined/);
            expect(detail).not.toMatch(/Invalid URL/);
            expect(detail).not.toMatch(/Endpoint produced no response/);
        });
    }
});

// ── 2. the inbox trio, by exact status code ──────────────────────────────────

describe('inbox-push answers with real status codes', () => {
    const push = (opts) => call('inbox-push', { method: 'POST', headers: { 'x-wf-device-token': TOKEN }, ...opts });

    it('200 only when Firestore actually accepted the write', async () => {
        stubs.push([FS, () => json(200, { name: 'projects/p/documents/wf-inbox/h/items/abc' })]);
        const r = await push({ body: { brain_result: { hash: 'abc' }, sms: 'LKR 500 debited' } });
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.durable).toBe(true);
        expect(r.body.key).toMatch(/^wf-inbox\/[0-9a-f]{16}\/items\/abc$/);
    });

    it('THE LIE: 502, not 200, when Firestore refuses the write', async () => {
        // The old fsPut() answered `true` from inside its own catch and the
        // handler returned `{ ok: true }` with 200 regardless, so a rules
        // rejection was indistinguishable from a durable save.
        stubs.push([FS, () => json(403, { error: { message: 'Missing or insufficient permissions.' } })]);
        const r = await push({ body: { brain_result: { hash: 'abc' } } });
        expect(r.status, 'a refused write still reports success').toBe(502);
        expect(r.body.ok).toBe(false);
        expect(r.body.durable).toBe(false);
        expect(r.body.error).toBe('inbox_not_durable');
    });

    it('502 when Firestore never answers, rather than hanging', async () => {
        stubs.push([FS, () => { throw new Error('ECONNRESET'); }]);
        const r = await push({ body: { brain_result: { hash: 'abc' } } });
        expect(r.status).toBe(502);
        expect(r.body.durable).toBe(false);
    });

    it('405 on a method it does not serve', async () => {
        const r = await call('inbox-push', { method: 'PUT', headers: { 'x-wf-device-token': TOKEN }, body: {} });
        expect(r.status).toBe(405);
    });

    it('401 with no token and 401 with one that is too short', async () => {
        stubs.push([FS, () => json(200, {})]);
        expect((await call('inbox-push', { method: 'POST', body: { brain_result: { hash: 'a' } } })).status).toBe(401);
        expect((await call('inbox-push', {
            method: 'POST', headers: { 'x-wf-device-token': 'tooshort' }, body: { brain_result: { hash: 'a' } },
        })).status).toBe(401);
    });

    it('400 on a malformed body and 400 with no brain_result', async () => {
        expect((await push({ body: '{not json' })).status).toBe(400);
        expect((await push({ body: {} })).status).toBe(400);
        expect((await push({ body: { brain_result: { no: 'hash' } } })).status).toBe(400);
    });

    it('never writes to Firestore before the token has been checked', async () => {
        // Capability order matters: an unauthenticated caller must not be able to
        // make the server issue a write at all.
        stubs.push([FS, () => json(200, {})]);
        await call('inbox-push', { method: 'POST', body: { brain_result: { hash: 'a' } } });
        expect(calls.filter((c) => FS.test(c.url))).toEqual([]);
    });
});

describe('inbox-pull distinguishes an empty inbox from a failed read', () => {
    const pull = (opts) => call('inbox-pull', { method: 'GET', headers: { 'x-wf-device-token': TOKEN }, ...opts });

    it('200 with count 0 when the inbox is genuinely empty', async () => {
        stubs.push([FS, () => json(200, { documents: [] })]);
        const r = await pull();
        expect(r.status).toBe(200);
        expect(r.body.ok).toBe(true);
        expect(r.body.count).toBe(0);
    });

    it('200 with the items when there are some', async () => {
        stubs.push([FS, () => json(200, {
            documents: [{
                name: 'projects/p/databases/(default)/documents/wf-inbox/abc/items/m1',
                fields: { applied: { booleanValue: false }, sms_preview: { stringValue: 'LKR 500' } },
            }],
        })]);
        const r = await pull();
        expect(r.status).toBe(200);
        expect(r.body.count).toBe(1);
        expect(r.body.items[0].key).toBe('wf-inbox/abc/items/m1');
        expect(r.body.items[0].sms_preview).toBe('LKR 500');
    });

    it('THE SILENT ONE: 502, not an empty list, when the read is refused', async () => {
        // fsList() used to `return []` from its catch AND on !r.ok, so "I was not
        // allowed to look" and "there is nothing waiting" were the same answer.
        // The poller then reported drained: 0 — accurate and utterly misleading.
        stubs.push([FS, () => json(403, { error: { message: 'Missing or insufficient permissions.' } })]);
        const r = await pull();
        expect(r.status, 'a refused read still reads as an empty inbox').toBe(502);
        expect(r.body.ok).toBe(false);
        expect(r.body.error).toBe('inbox_read_failed');
    });

    it('502 when Firestore never answers', async () => {
        stubs.push([FS, () => { throw new Error('ETIMEDOUT'); }]);
        expect((await pull()).status).toBe(502);
    });

    it('401 with no token', async () => {
        expect((await call('inbox-pull', { method: 'GET' })).status).toBe(401);
    });

    it('accepts the token from the query string the rewrite preserves', async () => {
        // The bridge has to carry the client's own query through the
        // /api/router?path=… rewrite, or this token would never arrive.
        stubs.push([FS, () => json(200, { documents: [] })]);
        const r = await call('inbox-pull', { method: 'GET', query: { token: TOKEN } });
        expect(r.status).toBe(200);
    });
});

describe('inbox-ack counts deletions, not attempts', () => {
    const key = (h) => `wf-inbox/${h}/items/m1`;
    const ack = (body) => call('inbox-ack', { method: 'POST', headers: { 'x-wf-device-token': TOKEN }, body });

    /** The bucket hash this TOKEN maps to, computed the way the handler does. */
    async function hashOf(t) {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(t));
        return Array.from(new Uint8Array(buf)).slice(0, 8).map((b) => b.toString(16).padStart(2, '0')).join('');
    }

    it('200 and a true count when the deletes land', async () => {
        stubs.push([FS, () => json(200, {})]);
        const r = await ack({ keys: [key(await hashOf(TOKEN))] });
        expect(r.status).toBe(200);
        expect(r.body).toMatchObject({ ok: true, deleted: 1, requested: 1 });
    });

    it('THE OVERCOUNT: 502 and deleted 0 when Firestore refuses', async () => {
        // `_memStore.delete(k); await fsDelete(k); deleted++;` incremented
        // unconditionally, so `{ ok: true, deleted: 5 }` could mean five
        // documents still present — which get pulled and applied a second time.
        stubs.push([FS, () => json(403, { error: { message: 'Missing or insufficient permissions.' } })]);
        const r = await ack({ keys: [key(await hashOf(TOKEN))] });
        expect(r.status, 'a failed delete still reports success').toBe(502);
        expect(r.body.deleted, 'the count still includes deletions that did not happen').toBe(0);
        expect(r.body.ok).toBe(false);
        expect(r.body.error).toBe('ack_incomplete');
    });

    it('refuses a key belonging to another device, and never calls Firestore for it', async () => {
        stubs.push([FS, () => json(200, {})]);
        const r = await ack({ keys: ['wf-inbox/deadbeefdeadbeef/items/m1'] });
        expect(r.status).toBe(200);
        expect(r.body.deleted).toBe(0);
        expect(r.body.rejected).toHaveLength(1);
        expect(calls.filter((c) => FS.test(c.url)), 'a foreign key reached Firestore').toEqual([]);
    });

    it('refuses a traversal attempt', async () => {
        stubs.push([FS, () => json(200, {})]);
        const h = await hashOf(TOKEN);
        const r = await ack({ keys: [`wf-inbox/${h}/items/../../../system/manifest`] });
        expect(r.body.deleted).toBe(0);
        expect(calls.filter((c) => FS.test(c.url))).toEqual([]);
    });

    it('405 on GET, 401 with no token, 400 on a malformed body', async () => {
        expect((await call('inbox-ack', { method: 'GET', headers: { 'x-wf-device-token': TOKEN } })).status).toBe(405);
        expect((await call('inbox-ack', { method: 'POST', body: { keys: [] } })).status).toBe(401);
        expect((await ack('{not json')).status).toBe(400);
    });
});

// ── 3. sms-ingest must derive `inboxed`, never assert it ─────────────────────

describe('sms-ingest reports whether the hand-off actually happened', () => {
    const SMS = { sms: 'Your card was debited LKR 4,500.00 at KEELLS', sender: 'COMBANK' };
    const ingest = () => call('sms-ingest', {
        method: 'POST', headers: { 'x-wf-device-token': TOKEN }, body: SMS,
    });

    /** The brain always succeeds in these tests; only the inbox varies. */
    function brainOk() {
        stubs.push([/\/api\/autonomous-brain/, () => json(200, { ok: true, hash: 'abc', amount: 4500 })]);
    }

    it('inboxed true only when inbox-push stored the item durably', async () => {
        brainOk();
        stubs.push([/\/api\/inbox-push/, () => json(200, { ok: true, durable: true, key: 'wf-inbox/h/items/abc' })]);
        const r = await ingest();
        expect(r.status).toBe(200);
        expect(r.body.classified).toBe(true);
        expect(r.body.inboxed).toBe(true);
        expect(r.body.inbox_error).toBeUndefined();
    });

    it('THE HARDCODED LITERAL: inboxed false when inbox-push answers 500', async () => {
        // The exact production state. inbox-push threw ReferenceError on every
        // request and answered 500; sms-ingest wrapped the call in try/catch,
        // which fetch never triggers for an HTTP error, and returned the literal
        // `inboxed: true`.
        brainOk();
        stubs.push([/\/api\/inbox-push/, () => json(500, { error: 'Endpoint runtime crash', detail: 'res is not defined' })]);
        const r = await ingest();
        expect(r.status).toBe(200);
        expect(r.body.inboxed, 'sms-ingest still claims the item was inboxed').toBe(false);
        expect(r.body.inbox_error).toMatch(/HTTP 500/);
        // The classification must still reach a caller that reads the response.
        expect(r.body.amount).toBe(4500);
    });

    it('inboxed false when inbox-push says the write was not durable', async () => {
        brainOk();
        stubs.push([/\/api\/inbox-push/, () => json(200, { ok: false, durable: false, error: 'inbox_not_durable' })]);
        const r = await ingest();
        expect(r.body.inboxed).toBe(false);
        expect(r.body.inbox_error).toMatch(/durabl/i);
    });

    it('inboxed false when inbox-push is unreachable', async () => {
        brainOk();
        stubs.push([/\/api\/inbox-push/, () => { throw new Error('ECONNREFUSED'); }]);
        const r = await ingest();
        expect(r.body.inboxed).toBe(false);
        expect(r.body.inbox_error).toMatch(/unreachable/);
    });

    it('a brain payload cannot overwrite the hand-off result', async () => {
        // `...brain` is spread into the response. If it carried `inboxed` and the
        // spread came last, the brain would get to decide a fact only this
        // function knows.
        stubs.push([/\/api\/autonomous-brain/, () => json(200, { ok: true, hash: 'abc', inboxed: true })]);
        stubs.push([/\/api\/inbox-push/, () => json(500, { error: 'boom' })]);
        expect((await ingest()).body.inboxed).toBe(false);
    });

    it('502 when the brain itself fails, instead of a misleading "unreachable"', async () => {
        stubs.push([/\/api\/autonomous-brain/, () => json(500, { ok: false, error: 'model down' })]);
        const r = await ingest();
        expect(r.status).toBe(502);
        expect(r.body.error).toMatch(/HTTP 500/);
    });

    it('builds its sibling calls against the real origin, not the rewrite', async () => {
        // sms-ingest reads `new URL(req.url).origin`. Through the router, req.url
        // is /api/router?path=sms-ingest, so without the bridge rebuilding an
        // absolute URL this throws Invalid URL before any call is made.
        brainOk();
        stubs.push([/\/api\/inbox-push/, () => json(200, { ok: true, durable: true })]);
        await ingest();
        expect(calls.map((c) => c.url)).toEqual([
            `https://${HOST}/api/autonomous-brain`,
            `https://${HOST}/api/inbox-push`,
        ]);
    });

    it('still forwards the device token to the inbox', async () => {
        brainOk();
        let seenToken = null;
        stubs.push([/\/api\/inbox-push/, (_u, init) => {
            seenToken = init && init.headers && init.headers['x-wf-device-token'];
            return json(200, { ok: true, durable: true });
        }]);
        await ingest();
        expect(seenToken).toBe(TOKEN);
    });
});

// ── 4. the bridge itself ─────────────────────────────────────────────────────

describe('the Node ⇄ Web bridge', () => {
    it('passes a POST body through to a Web handler that calls req.json()', async () => {
        // feedback.js reads `await req.json()` and answers 400 on empty text —
        // reaching that 400 proves the body survived the conversion.
        const r = await call('feedback', { method: 'POST', body: { type: 'bug', text: '' } });
        expect(r.status).toBe(400);
    });

    it('lets a Web handler answer 200 with a real body', async () => {
        const r = await call('ios-shortcut', { method: 'GET' });
        expect(r.status).toBe(200);
        expect(r.body).toBeTruthy();
    });

    it('does not leak the router\'s own ?path= key into the handler\'s query', async () => {
        // ios-shortcut builds its payload from searchParams; a phantom `path`
        // the client never sent would be a fabricated input.
        const r = await call('ios-shortcut', { method: 'GET', query: { token: TOKEN } });
        expect(r.status).toBe(200);
        expect(JSON.stringify(r.body)).not.toMatch(/[?&]path=/);
    });

    it('leaves Node-style handlers on the untouched Node objects', async () => {
        // The 21 endpoints that already worked must be unaffected.
        const r = await call('version', { method: 'GET' });
        expect(r.status).toBe(200);
        expect(r.body.version).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('answers OPTIONS without reaching a handler at all', async () => {
        const r = await call('inbox-push', { method: 'OPTIONS' });
        expect(r.status).toBe(204);
        expect(calls).toEqual([]);
    });

    it('still 404s an unknown endpoint and 200s the index', async () => {
        expect((await call('no-such-endpoint', { method: 'GET' })).status).toBe(404);
        const idx = await call('', { method: 'GET' });
        expect(idx.status).toBe(200);
    });

    it('sets CORS headers on a Web handler\'s response too', async () => {
        const r = await call('ios-shortcut', { method: 'GET' });
        // `answered` and `status` first: setCors() runs before dispatch, so the
        // header is present even when the handler's Response was thrown away.
        // Asserting the header alone made this pass against the broken router.
        expect(r.answered).toBe(true);
        expect(r.status).toBe(200);
        expect(r.headers['access-control-allow-origin']).toBe('*');
        expect(String(r.headers['content-type'] || '')).toMatch(/json/);
    });
});

// ── 5. guard the guard ───────────────────────────────────────────────────────

describe('these assertions can actually fail', () => {
    /* A contract test that has never rejected anything is indistinguishable from
     * no contract test. Each defect is re-enacted here so the shape being
     * asserted against is known to be detectable. */

    it('re-enacts the discarded Response, and shows nothing is written', async () => {
        const webStyle = async (_req) => json(200, { ok: true });   // arity 1
        const { res, seen } = mkRes();
        const out = await webStyle(mkReq('x'), res);                // the old `return await fn(req, res)`
        expect(out.status).toBe(200);                               // the answer existed…
        expect(seen.ended, 'the re-enactment wrote a response, so this guard proves nothing').toBe(false);
        expect(seen.status).toBe(null);                             // …and the client never got it
    });

    it('re-enacts the undeclared res, and shows it throws', async () => {
        // Exactly `handler(req)` with a body referencing `res`.
        const brokenSource = 'return async function handler(req) { if (!res) return; };';
        const broken = new Function(brokenSource)();
        expect(broken.length).toBe(1);
        await expect(broken({})).rejects.toThrow(/res is not defined/);
    });

    it('distinguishes the two conventions by arity, the way the router does', async () => {
        const { default: router } = await import('../api/router.js');
        expect(typeof router).toBe('function');
        expect(router.length, 'the router itself is a Node handler').toBe(2);
        for (const f of ['../inbox-push.js', '../inbox-pull.js', '../inbox-ack.js']) {
            const mod = await import(f);
            expect(mod.default.length, `${f} is not a (req, res) handler`).toBe(2);
        }
        expect((await import('../sms-ingest.js')).default.length, 'sms-ingest changed convention').toBe(1);
    });

    it('the converted handlers no longer claim a runtime Vercel will not read', async () => {
        // `export const config = { runtime: 'edge' }` on a (req, res) handler is
        // worse than useless: if the file were ever moved into api/, Vercel would
        // build it as an edge function and the Node-style code would break.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const root = path.resolve(import.meta.dirname, '..');
        for (const f of ['inbox-push.js', 'inbox-pull.js', 'inbox-ack.js']) {
            const src = fs.readFileSync(path.join(root, f), 'utf8');
            expect(src, `${f} declares a runtime it does not run in`).not.toMatch(/^export const config/m);
        }
    });

    it('the network block is real', async () => {
        // If the stub were not installed, every test above could write to the
        // production Firestore — which is exactly what happened during the
        // investigation that produced this file.
        await expect(globalThis.fetch('https://firestore.googleapis.com/v1/anything')).rejects.toThrow(/network blocked/);
        expect(blocked).toHaveLength(1);
        blocked.length = 0;      // consumed deliberately; afterEach asserts empty
    });
});

// ── 6. the not-configured path ───────────────────────────────────────────────

describe('a missing FIREBASE_API_KEY is a 503, not a crash', () => {
    it('says what is missing instead of calling Firestore with key=undefined', async () => {
        const saved = process.env.FIREBASE_API_KEY;
        delete process.env.FIREBASE_API_KEY;
        vi.resetModules();                 // the const is captured at load time
        try {
            const { default: router } = await import('../api/router.js');
            const { res, seen } = mkRes();
            await router(mkReq('inbox-push', {
                method: 'POST', headers: { 'x-wf-device-token': TOKEN }, body: { brain_result: { hash: 'a' } },
            }), res);
            expect(seen.status).toBe(503);
            expect(seen.body.error).toBe('firebase_key_not_configured');
            expect(calls.filter((c) => FS.test(c.url))).toEqual([]);
        } finally {
            process.env.FIREBASE_API_KEY = saved;
            vi.resetModules();
        }
    });
});
