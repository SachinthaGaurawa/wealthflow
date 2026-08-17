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
 * NOTHING HERE TOUCHES THE NETWORK. This endpoint deletes from the live
 * Firestore project, so `fetch` is replaced for every test and any unstubbed URL
 * fails the test that reached for it.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

process.env.FIREBASE_API_KEY = 'test-key-not-a-real-credential';
process.env.FIREBASE_PROJECT_ID = 'wealthflow-test-does-not-exist';

const ROOT = path.resolve(import.meta.dirname, '..');
const realFetch = globalThis.fetch;

let stubs, blocked, calls;

function jsonRes(status, obj) {
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

beforeEach(() => {
    stubs = []; blocked = []; calls = [];
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
        stubs.push([FS, () => jsonRes(200, {})]);
        const r = await del();
        expect(r.status).toBe(200);
        expect(r.body.success).toBe(true);
        expect(r.body.deleted).toBe(2);
    });

    it('attempts BOTH the current and the legacy collection', async () => {
        // A statement lives under s/ or shared_statements/ depending on when it
        // was created; deleting only one leaves the other served.
        stubs.push([FS, () => jsonRes(200, {})]);
        await del('xyz98765');
        const paths = calls.map((c) => c.url.replace(/\?.*$/, ''));
        expect(paths.some((p) => p.endsWith('/s/xyz98765'))).toBe(true);
        expect(paths.some((p) => p.endsWith('/shared_statements/xyz98765'))).toBe(true);
        expect(calls.every((c) => c.method === 'DELETE')).toBe(true);
    });

    it('treats an absent document as gone, not as a failure', async () => {
        // Firestore's REST DELETE is idempotent: removing what is not there is a
        // 200. A statement only ever lives in one of the two collections, so this
        // is the NORMAL case and must not be reported as a partial failure.
        stubs.push([FS, () => jsonRes(200, {})]);
        expect((await del()).status).toBe(200);
    });
});

describe('THE LIE: a delete that failed may not report success', () => {
    it('502, not 200, when Firestore refuses the delete', async () => {
        stubs.push([FS, () => jsonRes(403, { error: { message: 'Missing or insufficient permissions.' } })]);
        const r = await del();
        expect(r.status, 'a refused delete still reports 200').toBe(502);
        expect(r.body.success, 'a refused delete still reports success:true').toBe(false);
        expect(r.body.error).toBe('delete_incomplete');
    });

    it('502 when Firestore never answers, rather than a swallowed throw', async () => {
        // The old `.catch(()=>{})` turned exactly this into `{ success: true }`.
        stubs.push([FS, () => { throw new Error('ECONNRESET'); }]);
        const r = await del();
        expect(r.status).toBe(502);
        expect(r.body.success).toBe(false);
    });

    it('502 when only ONE of the two targets fails', async () => {
        // The dangerous middle case: the statement survives in one collection and
        // is still reachable by its link.
        stubs.push([/\/s\/[^/?]+\?/, () => jsonRes(200, {})]);
        stubs.push([/shared_statements/, () => jsonRes(500, { error: { message: 'backend error' } })]);
        const r = await del();
        expect(r.status).toBe(502);
        expect(r.body.failed).toHaveLength(1);
        expect(r.body.failed[0].target).toMatch(/shared_statements/);
    });

    it('names which target survived, and returns the id so it can be retried', async () => {
        // The id must come back: the caller is about to forget it, and without it
        // the document can never be found again to delete.
        stubs.push([FS, () => jsonRes(403, { error: { message: 'nope' } })]);
        const r = await del('keepthisid');
        expect(r.body.id).toBe('keepthisid');
        expect(r.body.failed.map((f) => f.target).sort()).toEqual(['s/keepthisid', 'shared_statements/keepthisid']);
        expect(String(r.body.detail)).toMatch(/may still be reachable/i);
    });

    it('never puts the API key in the response', async () => {
        // The delete URL carries ?key=<apiKey>, and Firestore error text plus any
        // thrown message can echo the URL.
        stubs.push([FS, () => { throw new Error('failed to fetch https://x/y?key=SUPERSECRET&z=1'); }]);
        const r = await del();
        expect(JSON.stringify(r.body)).not.toMatch(/SUPERSECRET/);
        expect(JSON.stringify(r.body)).toMatch(/key=\[redacted\]/);
    });

    it('still rejects a malformed id before calling Firestore', async () => {
        stubs.push([FS, () => jsonRes(200, {})]);
        for (const bad of ['', 'abc', null]) {
            const { default: handler } = await import('../statement-store.js');
            const { res, seen } = mkRes();
            await handler({ method: 'DELETE', url: '/api/statement-store', headers: {}, query: { id: bad }, body: undefined }, res);
            expect(seen.status).toBe(400);
        }
        expect(calls, 'a malformed id reached Firestore').toEqual([]);
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
