/* =============================================================================
 * test/statement_delete_honesty_test.js — a delete that did not happen may not
 * report success
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 *     await fetch(`${FS_BASE}/s/${id}?key=${API_KEY}`, { method:'DELETE' }).catch(()=>{});
 *     await fetch(`${FS_BASE}/shared_statements/${id}...`, ...).catch(()=>{});
 *     return res.status(200).json({ success: true });
 *
 * Both outcomes were thrown away twice over: `.catch(()=>{})` swallowed any
 * throw, and the resolved Response was never read, so `r.ok` never mattered. A
 * Firestore rules rejection, a 5xx, and a timeout all produced
 * `{ success: true }` with status 200.
 *
 * WHY THIS ONE IS NOT COSMETIC
 *
 * `?s=<id>` is the only thing between the public internet and someone's loan
 * statement or Elite Report PDF. The caller in index.html deleted its local
 * record of the id the moment this endpoint answered. So a failed delete meant
 * all three of:
 *
 *   · the document stayed served to anyone holding the link,
 *   · the owner was told it had been removed,
 *   · the id was erased from the only place it was recorded, so the document
 *     could never be found again in order to delete it.
 *
 * Same family as the fsPut / fsList / fsDelete defects in #111 — a component
 * reporting an outcome it never verified — but with a privacy consequence rather
 * than a lost transaction.
 *
 * NOW VIA THE ADMIN SDK. Over REST this delete carried only the public Web API
 * key, so rules saw it as unauthenticated and `allow delete: if false` refused it
 * outright — revocation was impossible against the deployed rules, and the
 * endpoint could only ever answer its honest 502 while the document stayed
 * public. The service account bypasses rules, so revoking works without
 * reopening delete to the internet.
 *
 * NOTHING HERE TOUCHES THE NETWORK. firebase-admin is replaced by an in-memory
 * stand-in, and `fetch` is replaced too so that a regression back onto REST fails
 * the test that did it rather than reaching the live project.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { makeFakeAdmin, FAKE_SERVICE_ACCOUNT } from './fake-admin.mjs';

process.env.FIREBASE_API_KEY = 'test-key-not-a-real-credential';
process.env.FIREBASE_PROJECT_ID = 'wealthflow-test-does-not-exist';
process.env.FIREBASE_SERVICE_ACCOUNT = FAKE_SERVICE_ACCOUNT;

const ROOT = path.resolve(import.meta.dirname, '..');
const realFetch = globalThis.fetch;
const fake = makeFakeAdmin();

let stubs, blocked, calls;

function jsonRes(status, obj) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(async () => {
    stubs = []; blocked = []; calls = [];
    fake.reset();
    const { _setAdminModule } = await import('../admin-db.mjs');
    _setAdminModule(fake.admin);
    // The document being revoked exists in both collections unless a test says
    // otherwise; delete is idempotent so absence is a success either way.
    fake.docs.set('s/abc12345', { kind: 'html', h: '<p>x</p>' });
    fake.docs.set('shared_statements/abc12345', { html: '<p>x</p>' });
    globalThis.fetch = async (input, init) => {
        const url = String(input && input.url ? input.url : input);
        calls.push({ url, method: String((init && init.method) || 'GET').toUpperCase() });
        for (const [re, make] of stubs) if (re.test(url)) return make(url, init);
        blocked.push(url);
        throw new Error('network blocked in tests: ' + url);
    };
});

afterEach(() => {
    globalThis.fetch = realFetch;
    expect(blocked, `a test reached for the real network:\n  ${blocked.join('\n  ')}`).toEqual([]);
});

function mkRes() {
    const seen = { status: null, body: undefined, ended: false };
    const res = {
        status(c) { seen.status = c; return res; },
        json(o) { seen.body = o; seen.ended = true; return res; },
        send(o) { seen.body = o; seen.ended = true; return res; },
        end(o) { if (o !== undefined) seen.body = o; seen.ended = true; return res; },
        setHeader() { return res; },
        getHeader() { return undefined; },
        get headersSent() { return seen.ended; },
        get writableEnded() { return seen.ended; },
    };
    return { res, seen };
}

/** DELETE /api/statement-store?id=… straight at the handler. */
async function del(id = 'abc12345') {
    const { default: handler } = await import('../statement-store.js');
    const { res, seen } = mkRes();
    await handler({ method: 'DELETE', url: `/api/statement-store?id=${id}`, headers: {}, query: { id }, body: undefined }, res);
    return seen;
}

const FS = /firestore\.googleapis\.com/;

describe('a delete that succeeded reports success', () => {
    it('200 when both targets are removed', async () => {
        const r = await del();
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.deleted).toBe(2);
    });

    it('attempts BOTH the current and the legacy collection', async () => {
        // A statement lives under s/ or shared_statements/ depending on when it
        // was created; deleting only one leaves the other served.
        await del('xyz98765');
        const deletes = fake.ops.filter((o) => o.op === 'delete').map((o) => o.path);
        expect(deletes).toContain('s/xyz98765');
        expect(deletes).toContain('shared_statements/xyz98765');
    });

    it('treats an absent document as gone, not as a failure', async () => {
        // Deleting what is not there succeeds. A statement only ever lives in one
        // of the two collections, so this is the NORMAL case and must not be
        // reported as a partial failure.
        fake.docs.clear();
        expect((await del()).status).toBe(200);
    });

    it('removes the chunk documents of a chunked PDF, not just the manifest', async () => {
        // Deleting only the manifest would revoke the LINK while leaving the
        // statement itself in the database — not what the owner was told happened.
        fake.docs.clear();
        fake.docs.set('s/chunky12', { kind: 'pdf', chunked: true, parts: 3 });
        for (let i = 0; i < 3; i++) fake.docs.set(`s/chunky12-${i}`, { d: 'x' });
        const r = await del('chunky12');
        expect(r.status).toBe(200);
        for (let i = 0; i < 3; i++) {
            expect(fake.docs.has(`s/chunky12-${i}`), `part ${i} survived the revoke`).toBe(false);
        }
        expect(fake.docs.has('s/chunky12')).toBe(false);
    });
});

describe('THE LIE: a delete that failed may not report success', () => {
    it('502, not 200, when Firestore refuses the delete', async () => {
        fake.setFailOn((_p, op) => (op === 'delete' ? new Error('Missing or insufficient permissions.') : null));
        const r = await del();
        expect(r.status, 'a refused delete still reports 200').toBe(502);
        expect(r.body.success, 'a refused delete still reports success:true').toBe(false);
        expect(r.body.error).toBe('delete_incomplete');
    });

    it('502 when Firestore never answers, rather than a swallowed throw', async () => {
        // The old `.catch(()=>{})` turned exactly this into `{ success: true }`.
        fake.setFailOn((_p, op) => (op === 'delete' ? new Error('ECONNRESET') : null));
        const r = await del();
        expect(r.status).toBe(502);
        expect(r.body.success).toBe(false);
    });

    it('502 when only ONE of the two targets fails', async () => {
        // The dangerous middle case: the statement survives in one collection and
        // is still reachable by its link.
        fake.setFailOn((path, op) => (op === 'delete' && path.startsWith('shared_statements/')
            ? new Error('backend error') : null));
        const r = await del();
        expect(r.status).toBe(502);
        expect(r.body.failed).toHaveLength(1);
        expect(r.body.failed[0].target).toMatch(/shared_statements/);
    });

    it('names which target survived, and returns the id so it can be retried', async () => {
        // The id must come back: the caller is about to forget it, and without it
        // the document can never be found again to delete.
        fake.setFailOn((_p, op) => (op === 'delete' ? new Error('nope') : null));
        const r = await del('keepthisid');
        expect(r.body.id).toBe('keepthisid');
        expect(r.body.failed.map((f) => f.target).sort()).toEqual(['s/keepthisid', 'shared_statements/keepthisid']);
        expect(String(r.body.detail)).toMatch(/may still be reachable/i);
    });

    it('never puts the API key in the response', async () => {
        // The delete URL carries ?key=<apiKey>, and Firestore error text plus any
        // thrown message can echo the URL.
        fake.setFailOn((_p, op) => (op === 'delete'
            ? new Error('failed to fetch https://x/y?key=SUPERSECRET&z=1') : null));
        const r = await del();
        expect(JSON.stringify(r.body)).not.toMatch(/SUPERSECRET/);
        expect(JSON.stringify(r.body)).toMatch(/key=\[redacted\]/);
    });

    it('still rejects a malformed id before calling Firestore', async () => {
        for (const bad of ['', 'abc', null]) {
            const { default: handler } = await import('../statement-store.js');
            const { res, seen } = mkRes();
            await handler({ method: 'DELETE', url: '/api/statement-store', headers: {}, query: { id: bad }, body: undefined }, res);
            expect(seen.status).toBe(400);
        }
        expect(fake.ops, 'a malformed id reached Firestore').toEqual([]);
    });
});

describe('the source no longer discards the outcome', () => {
    const RAW = fs.readFileSync(path.join(ROOT, 'statement-store.js'), 'utf8');

    /* Comments stripped. The fix's own header QUOTES the buggy lines in order to
     * explain them, so asserting against the raw file matches the explanation and
     * fails on a file that is correct — which is exactly what happened when this
     * test was first written. Same trap as the alt-text regex that matched its own
     * regex literal and the workflow guard that matched its own commentary. */
    const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, ' ')
        .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

    it('the comment-stripper did not gut the file it is scanning', () => {
        expect(SRC).toMatch(/req\.method === 'DELETE'/);
        expect(SRC.length).toBeGreaterThan(3000);
    });

    it('has no `.catch(()=>{})` on a delete any more', () => {
        // The precise construct that produced the bug.
        const deleteBlock = SRC.slice(SRC.indexOf("req.method === 'DELETE'"), SRC.indexOf("req.method !== 'POST'"));
        expect(deleteBlock, 'a delete result is being swallowed again').not.toMatch(/\.catch\(\(\)\s*=>\s*\{\s*\}\)/);
    });

    it('does not return an unconditional success', () => {
        expect(SRC).not.toMatch(/return res\.status\(200\)\.json\(\{ success: true \}\);/);
    });

    it('would still catch the unconditional success if it came back', () => {
        // Guard the guard: prove the pattern matches when genuinely present, so
        // the assertion above is not passing because the regex is wrong.
        expect('  return res.status(200).json({ success: true });')
            .toMatch(/return res\.status\(200\)\.json\(\{ success: true \}\);/);
    });

    it('routes deletes through the reporting helper', () => {
        expect(SRC).toMatch(/async function fsDeleteDoc\(/);
        expect(SRC).toMatch(/fsDeleteDoc\(t\)/);
    });

    it('deletes through the Admin SDK, not the public Web API key', () => {
        // Over REST this delete was unauthenticated, so `allow delete: if false`
        // refused it and revocation could not work at all against sealed rules.
        expect(SRC, 'statement-store is back on the Firestore REST API')
            .not.toMatch(/firestore\.googleapis\.com/);
        expect(SRC, 'statement-store still uses the public Web apiKey')
            .not.toMatch(/FIREBASE_API_KEY/);
        expect(SRC, 'statement-store no longer uses the shared Admin bootstrap')
            .toMatch(/from '\.\/admin-db\.mjs'/);
    });
});

describe('the client keeps the id when the server could not delete', () => {
    /* A server that answers an honest 502 achieves nothing if the caller ignores
     * it. index.html deleted its local record of shortId unconditionally, which
     * is what turned a failed delete into an unfindable public document. */
    const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const block = HTML.slice(HTML.indexOf('btnDel.onclick'), HTML.indexOf('row.appendChild(info)'));

    it('found the delete handler (guards a vacuous pass)', () => {
        expect(block.length).toBeGreaterThan(300);
        expect(block).toMatch(/statement-store\?id=/);
    });

    it('no longer fires the request and ignores the answer', () => {
        expect(block, 'the response is being discarded again')
            .not.toMatch(/fetch\('https:\/\/wealthflow-personal\.vercel\.app\/api\/statement-store\?id=' \+ h\.shortId, \{ method: 'DELETE' \}\)\.catch\(\(\)=>\{\}\)/);
    });

    it('checks the status, because fetch does not reject on 5xx', () => {
        expect(block).toMatch(/r\.ok/);
    });

    it('reads success:false even on a 200', () => {
        expect(block).toMatch(/success !== false/);
    });

    it('returns without splicing the history when the delete failed', () => {
        const guard = block.indexOf('if (!serverGone)');
        const splice = block.indexOf('hist.splice(i, 1)');
        expect(guard, 'no failure guard before the local record is dropped').toBeGreaterThan(-1);
        expect(guard, 'the history is spliced before the failure is checked').toBeLessThan(splice);
        expect(block.slice(guard, splice)).toMatch(/return;/);
    });

    it('tells the user the link may still work', () => {
        expect(block).toMatch(/may still work/i);
    });
});
