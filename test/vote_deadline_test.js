/* =============================================================================
 * test/vote_deadline_test.js — one slow provider must cost a vote, never the request
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * `/api/classify-charge` asks ~18 AI providers at once and waits for all of them
 * (`Promise.allSettled`). Each call had an 18 s deadline — but the helper that
 * applied it cleared its timer the moment the response HEADERS arrived, and the
 * body was read afterwards with `await resp.json()` and no deadline of its own.
 * A provider that sent headers and then went quiet therefore never settled, so
 * neither did the vote, and the router's 60 s limit killed the request:
 * `[WF-SLOW] /api/classify-charge (POST)` + "Task timed out after 60 seconds",
 * 2026-10-04 20:15 UTC, one user. (It was the last of 14 -> 3 -> 1 timeouts a day.)
 *
 * The first test below reproduces exactly that against a real socket: a server
 * that writes `200` and half a JSON body and then stops.
 *
 * WHAT THIS ASSERTS
 *   · the new helpers end a stalled body read at the deadline (real socket)
 *   · a vote with a stalled member still answers, with the members that answered,
 *     whether the stalled member honours the abort or ignores it entirely
 *   · when every member answers in time the result is what it was before
 *   · the same pattern is gone from the other multi-provider paths
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

import { createDeadline, fetchWithBodyDeadline, readBody, fetchWithTimeout } from '../fetch-timeout.mjs';
import { geminiGenerate, resetGeminiLearning } from '../gemini-client.mjs';
import { loadModels } from '../ai-models.mjs';
import classify, { VOTE_DEADLINE_MS } from '../classify-charge.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const enc = new TextEncoder();

/** A provider that sends headers and the first bytes of a JSON body, then nothing, ever. */
function stalledServer() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.write('{"choices":[{"message":{"content":"');
    });
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => { server.closeAllConnections && server.closeAllConnections(); server.close(); },
    })));
}

/** What the caller sees of a read: how it ended and how long it took (a cap, so a bug fails instead of hanging the suite). */
async function outcome(promise, capMs = 3000) {
    const t0 = Date.now();
    const how = await Promise.race([
        promise.then(() => 'resolved', (e) => `rejected:${e && e.name}`),
        new Promise((r) => setTimeout(() => r('STILL PENDING'), capMs)),
    ]);
    return { how, ms: Date.now() - t0 };
}

describe('THE BUG, reproduced against a real socket: headers arrive, the body never finishes', () => {
    let srv;
    beforeEach(async () => { srv = await stalledServer(); });
    afterEach(() => srv.close());

    it('fetchWithTimeout (headers only) leaves the body read hanging — the defect, pinned so it is not "fixed" by accident', async () => {
        const r = await fetchWithTimeout(srv.url, {}, 150);
        const { how } = await outcome(r.json(), 800);
        expect(how).toBe('STILL PENDING');
    });

    it('fetchWithBodyDeadline ends the same read at the deadline', async () => {
        const r = await fetchWithBodyDeadline(srv.url, {}, 150);
        const { how, ms } = await outcome(r.json());
        expect(how).toMatch(/^rejected:/);
        expect(ms).toBeLessThan(1500);
    });

    it('createDeadline().fetch ends it at the GROUP deadline, not the (longer) per-call one', async () => {
        const vote = createDeadline(150);
        try {
            const r = await vote.fetch(srv.url, {}, 60_000);
            const { how, ms } = await outcome(r.json());
            expect(how).toMatch(/^rejected:/);
            expect(ms).toBeLessThan(1500);
            expect(vote.expired()).toBe(true);
        } finally { vote.done(); }
    });

    it('readBody ends it too, for a response whose fetch was not bounded at all', async () => {
        const r = await fetch(srv.url);
        const { how, ms } = await outcome(readBody(r, 'json', 150));
        expect(how).toBe('rejected:TimeoutError');
        expect(ms).toBeLessThan(1500);
    });
});

describe('the helpers', () => {
    const realFetch = globalThis.fetch;
    afterEach(() => { globalThis.fetch = realFetch; });

    it('readBody passes a normal body through, and a bad one through unchanged', async () => {
        expect(await readBody(new Response('{"a":1}'), 'json', 500)).toEqual({ a: 1 });
        expect(await readBody(new Response('plain'), 'text', 500)).toBe('plain');
        await expect(readBody(new Response('not json'), 'json', 500)).rejects.toThrow(SyntaxError);
    });

    it('readBody names a timeout distinctly, and works on a bare object with no stream (a test double)', async () => {
        const e = await readBody({ json: () => new Promise(() => {}) }, 'json', 40).catch((x) => x);
        expect(e).toMatchObject({ name: 'TimeoutError', timedOut: true, timeoutMs: 40 });
    });

    it('fetchWithBodyDeadline still honours a caller signal, and still does not throw on 4xx/5xx', async () => {
        globalThis.fetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        const caller = new AbortController();
        const p = fetchWithBodyDeadline('https://example.test/slow', { signal: caller.signal }, 60_000);
        caller.abort();
        const e = await p.catch((x) => x);
        expect(e.timedOut, 'a caller abort was reported as a timeout').toBeUndefined();

        globalThis.fetch = async () => new Response('nope', { status: 503 });
        const r = await fetchWithBodyDeadline('https://example.test/x', {}, 5000);
        expect(r.status).toBe(503);
    });

    it('a timed-out connect says which address and never leaks a query string', async () => {
        globalThis.fetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        const e = await fetchWithBodyDeadline('https://example.test/v1/x?key=SUPERSECRET', {}, 30).catch((x) => x);
        expect(e).toMatchObject({ name: 'TimeoutError', timedOut: true });
        expect(e.message).toMatch(/example\.test\/v1\/x/);
        expect(e.message).not.toMatch(/SUPERSECRET/);
    });

    it('createDeadline: onExpire runs before members can react, whenExpired resolves, later calls fail at once, done() stops the timer', async () => {
        globalThis.fetch = (_u, init) => new Promise((_res, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
        const waiting = new Set(['a']);
        let seen = null;
        const vote = createDeadline(40, () => { seen = [...waiting]; });
        const member = vote.fetch('https://example.test/a').catch((e) => { waiting.delete('a'); return e; });
        await vote.whenExpired;
        expect(seen, 'the waiting list must be read before the members clean up').toEqual(['a']);
        expect(vote.expired()).toBe(true);
        expect((await member).timedOut).toBe(true);
        const late = await vote.fetch('https://example.test/b').catch((e) => e);
        expect(late.timedOut).toBe(true);
        vote.done();

        const quick = createDeadline(50_000);
        quick.done();   // a vote that finished early leaves nothing armed (vitest would otherwise wait 50 s)
        expect(quick.expired()).toBe(false);
    });
});

describe('the other places a body is read under a call deadline', () => {
    afterEach(() => { vi.useRealTimers(); resetGeminiLearning(); });

    it('geminiGenerate gives up on a reply that stalls after its headers, at the call deadline', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const fetcher = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}), text: () => new Promise(() => {}) });
        const logged = [];
        const run = geminiGenerate({ key: 'k', parts: [{ text: 'hi' }], model: 'gemini-test', deadlineMs: 5000, fetcher, loadList: async () => [], log: (l) => logged.push(l) });
        const settled = run.then(() => 'resolved', (e) => `rejected:${e.name}`);
        await vi.advanceTimersByTimeAsync(5200);
        expect(await settled).toBe('rejected:TimeoutError');
        expect(logged.join('\n')).toContain('body-stalled');                       // the call's own log says what happened, with the model
    });

    it('geminiGenerate on an error status does not wait for a stalled error body either: the status still classifies', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const fetcher = async () => ({ ok: false, status: 401, json: () => new Promise(() => {}), text: () => new Promise(() => {}) });
        const run = geminiGenerate({ key: 'k', parts: [{ text: 'hi' }], model: 'gemini-test', deadlineMs: 5000, fetcher, loadList: async () => [], log: () => {} });
        const settled = run.then(() => 'resolved', (e) => `${e.kind}:${e.status}`);
        await vi.advanceTimersByTimeAsync(3200);                                    // an error body is allowed 3 s, not the whole call
        expect(await settled).toBe('key:401');
    });

    it('loadModels treats a model list that stalls after its headers as "no list", not a wait', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const fetcher = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) });
        const p = loadModels({ kind: 'openai', url: 'https://example.test/models', key: 'k', fetcher });
        await vi.advanceTimersByTimeAsync(8200);
        expect(await p).toEqual([]);
    });
});

/* ── the endpoint itself ─────────────────────────────────────────────────── */

const ENGINE_KEYS = ['GROQ_API_KEY', 'DEEPSEEK_API_KEY', 'MISTRAL_API_KEY', 'TOGETHER_API_KEY', 'TOGETHERAI_API_KEY', 'FIREWORKS_API_KEY', 'OPENROUTER_API_KEY', 'OPEN_ROUTER_API_KEY',
    'CEREBRAS_API_KEY', 'SAMBANOVA_API_KEY', 'NVIDIA_API_KEY', 'GITHUB_MODELS_TOKEN', 'GITHUB_TOKEN', 'DEEPINFRA_API_KEY', 'DEEPINFRA_TOKEN', 'HYPERBOLIC_API_KEY',
    'NOVITA_API_KEY', 'OPENAI_API_KEY', 'OPENAI_KEY', 'COHERE_API_KEY', 'XAI_API_KEY', 'GROK_API_KEY', 'WealthFlow_API_Key', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY'];

const AMBIGUOUS = ['ZZQ UNKNOWN MERCHANT 12', 'XJ OUTLET 7788'];
const CERTAIN = 'MORAWAKA FUEL STATION';     // the knowledge base settles this one, no AI call

const chatReply = (rows) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(rows) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const verdicts = (type, category) => AMBIGUOUS.map((_, i) => ({ i, type, category }));

/** Headers and the first bytes, then silence. `honoursAbort: false` is the worst case: a body that cannot be cancelled at all. */
function stalledReply(signal, honoursAbort) {
    const body = new ReadableStream({
        start(controller) {
            controller.enqueue(enc.encode('{"choices":[{"message":{"content":"['));
            if (honoursAbort && signal) signal.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
    });
    return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function call(descriptions) {
    const req = { method: 'POST', body: { descriptions } };
    const out = { status: 0, body: null, headers: {} };
    const res = {
        setHeader: (k, v) => { out.headers[k] = v; },
        status(code) { out.status = code; return this; },
        json(b) { out.body = b; return this; },
        end() { return this; },
    };
    return { promise: classify(req, res).then(() => out), out };
}

describe('/api/classify-charge: a provider that stalls costs a vote, not the request', () => {
    const realFetch = globalThis.fetch;
    const saved = {};
    let warn;

    beforeEach(() => {
        for (const k of ENGINE_KEYS) { saved[k] = process.env[k]; delete process.env[k]; }
        warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    });
    afterEach(() => {
        vi.useRealTimers();
        globalThis.fetch = realFetch;
        warn.mockRestore();
        for (const k of ENGINE_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    });

    /** Route by provider host; `plan[host]` is a function (init) => Response. Records which hosts were asked. */
    function install(plan) {
        const asked = [];
        globalThis.fetch = async (url, init) => {
            const host = new URL(String(url)).host;
            asked.push(host);
            if (!plan[host]) throw new Error('unexpected provider ' + host);
            return plan[host](init || {});
        };
        return asked;
    }

    it('the deadline is under the router\'s 50 s watchdog and 60 s limit, with room to answer', () => {
        expect(VOTE_DEADLINE_MS).toBeGreaterThanOrEqual(10_000);
        expect(VOTE_DEADLINE_MS).toBeLessThan(50_000);
    });

    it('every engine answers in time: the result is the plain majority, engines listed in their usual order', async () => {
        process.env.GROQ_API_KEY = 'g'; process.env.DEEPSEEK_API_KEY = 'd'; process.env.MISTRAL_API_KEY = 'm';
        install({
            'api.groq.com': () => chatReply(verdicts('purchase', 'Shopping')),
            'api.deepseek.com': () => chatReply(verdicts('purchase', 'Shopping')),
            'api.mistral.ai': () => chatReply(verdicts('service_fee', 'Fees')),
        });
        const { promise } = call([CERTAIN, ...AMBIGUOUS]);
        const out = await promise;
        expect(out.status).toBe(200);
        expect(out.body.mode).toBe('kb+consensus');
        expect(out.body.engines).toEqual(['groq', 'deepseek', 'mistral']);
        expect(out.body.results[0]).toMatchObject({ type: 'fuel', source: 'kb' });          // the KB-certain row is never touched by the vote
        expect(out.body.results[1]).toMatchObject({ type: 'purchase', category: 'Shopping', source: 'consensus', engineVotes: { purchase: 2, service_fee: 1 } });
        expect(warn).not.toHaveBeenCalled();                                              // nothing stalled, nothing logged
    });

    for (const [label, honoursAbort] of [['a body that stops when aborted', true], ['a body that cannot be cancelled at all', false]]) {
        it(`one provider stalls after its headers (${label}): the others still vote, and the request ends at the deadline`, async () => {
            process.env.GROQ_API_KEY = 'g'; process.env.DEEPSEEK_API_KEY = 'd'; process.env.MISTRAL_API_KEY = 'm';
            install({
                'api.groq.com': () => chatReply(verdicts('purchase', 'Shopping')),
                'api.deepseek.com': (init) => stalledReply(init.signal, honoursAbort),
                'api.mistral.ai': () => chatReply(verdicts('purchase', 'Shopping')),
            });
            const { promise, out } = call(AMBIGUOUS);
            await vi.advanceTimersByTimeAsync(VOTE_DEADLINE_MS - 1);
            expect(out.body, 'the request ended before the deadline although a provider was still stalled').toBeNull();
            await vi.advanceTimersByTimeAsync(5);
            const done = await promise;
            expect(done.status).toBe(200);
            expect(done.body.mode).toBe('kb+consensus');
            expect(done.body.engines).toEqual(['groq', 'mistral']);                        // deepseek is dropped, the rest kept
            expect(done.body.results.map((r) => r.type)).toEqual(['purchase', 'purchase']);
            expect(done.body.results[0].engineVotes).toEqual({ purchase: 2 });
            // one line, naming the provider and nothing from the request
            const lines = warn.mock.calls.map((c) => c.join(' ')).filter((l) => l.includes('[WF-VOTE]'));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toContain('deepseek');
            expect(lines[0]).not.toMatch(/groq|mistral|ZZQ|OUTLET/);
        });
    }

    it('every provider stalls: the knowledge base answer stands and the request still ends', async () => {
        process.env.GROQ_API_KEY = 'g'; process.env.DEEPSEEK_API_KEY = 'd';
        install({
            'api.groq.com': (init) => stalledReply(init.signal, false),
            'api.deepseek.com': (init) => stalledReply(init.signal, true),
        });
        const { promise } = call(AMBIGUOUS);
        await vi.advanceTimersByTimeAsync(VOTE_DEADLINE_MS + 5);
        const out = await promise;
        expect(out.status).toBe(200);
        expect(out.body.mode).toBe('kb-only (no AI engine responded)');
        expect(out.body.engines).toEqual([]);
        expect(out.body.results.map((r) => [r.type, r.source])).toEqual([['purchase', 'kb'], ['purchase', 'kb']]);
        expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/groq, deepseek/);
    });

    it('Gemini, which reads its own reply inside gemini-client, is bounded the same way', async () => {
        process.env.GROQ_API_KEY = 'g'; process.env.GEMINI_API_KEY = 'k';
        install({
            'api.groq.com': () => chatReply(verdicts('purchase', 'Shopping')),
            'generativelanguage.googleapis.com': (init) => stalledReply(init.signal, false),
        });
        const { promise } = call(AMBIGUOUS);
        await vi.advanceTimersByTimeAsync(VOTE_DEADLINE_MS + 5);
        const out = await promise;
        expect(out.status).toBe(200);
        expect(out.body.engines).toEqual(['groq']);
        expect(out.body.results[0].source).toBe('consensus');
        expect(warn.mock.calls.map((c) => c.join(' ')).join('\n')).toMatch(/no answer from gemini within/);
    });

    it('an engine that FAILS (not stalls) is dropped quietly and fast, as before', async () => {
        process.env.GROQ_API_KEY = 'g'; process.env.DEEPSEEK_API_KEY = 'd';
        install({
            'api.groq.com': () => chatReply(verdicts('purchase', 'Shopping')),
            'api.deepseek.com': () => new Response('rate limited', { status: 429 }),
        });
        const { promise } = call(AMBIGUOUS);
        const out = await promise;            // no timer advance: nothing waits for the deadline
        expect(out.body.engines).toEqual(['groq']);
        expect(warn).not.toHaveBeenCalled();
    });

    it('a request with nothing ambiguous never asks a provider and never starts a deadline timer', async () => {
        process.env.GROQ_API_KEY = 'g';
        const asked = install({});
        const out = await call([CERTAIN, 'DEBIT INTEREST']).promise;
        expect(asked).toEqual([]);
        expect(out.body.mode).toBe('kb-only');
        expect(vi.getTimerCount()).toBe(0);
    });

    it('leaves no timer armed once the vote is over', async () => {
        process.env.GROQ_API_KEY = 'g';
        install({ 'api.groq.com': () => chatReply(verdicts('purchase', 'Shopping')) });
        await call(AMBIGUOUS).promise;
        expect(vi.getTimerCount()).toBe(0);
    });
});

describe('the same pattern is gone from the other multi-provider paths', () => {
    const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

    it('classify-charge no longer carries a fetch helper that clears its timer on headers', () => {
        const src = read('classify-charge.js');
        expect(src).not.toMatch(/function\s+fetchWithTimeout/);
        expect(src).toMatch(/createDeadline\s*\(/);
        // every provider call goes through the shared deadline
        expect(src.match(/(?<![\w.$])fetch\s*\(/g) || []).toHaveLength(0);
    });

    it('vision-scan (a Promise.all over up to a dozen providers) bounds the body read, not just the headers', () => {
        const src = read('api/vision-scan.js');
        expect(src).not.toMatch(/function\s+fetchWithTimeout/);
        expect(src).toMatch(/fetchWithBodyDeadline/);
        expect(src).not.toMatch(/finally\s*\{\s*clearTimeout\(timer\)/);
    });

    it('the advisor web lookup uses the body-covering fetch by default', () => {
        expect(read('advisor-research.mjs')).toMatch(/fetcher = fetchWithBodyDeadline/);
    });

    it('gemini-client and the model-list loader read their bodies under a deadline', () => {
        expect(read('gemini-client.mjs')).not.toMatch(/await response\.(json|text)\(\)/);
        expect(read('ai-models.mjs')).not.toMatch(/await response\.json\(\)/);
    });
});
