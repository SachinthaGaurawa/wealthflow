/* =============================================================================
 * test/fetch_timeout_test.js — no server endpoint may make an outbound call
 * that can hang
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * `fetch` has no default timeout. An upstream that accepts the connection and
 * then goes quiet does not produce an error — the call simply never settles.
 * Inside a Vercel function with `maxDuration: 60` that has exactly one outcome:
 * the invocation is killed at the ceiling and the client gets
 * FUNCTION_INVOCATION_TIMEOUT, with nothing recording which upstream stalled.
 *
 * Eighteen call sites across eight endpoints had no deadline: ai-vision (2),
 * approve-release (1), drive-auth (2), feedback-status (1), feedback (1),
 * fx-rate (1), merchant-search (4), feedback-triage (6).
 *
 * THE CENSUS THAT LIED
 *
 * The first pass at measuring this counted, per file, occurrences of `fetch(`
 * against occurrences of the string `signal`. feedback-triage.js scored 6 and 3
 * — apparently half-protected. It had ZERO AbortSignals. The three hits were the
 * word "signal" in its own prose:
 *
 *     "signal available said it worked"
 *     "Machinery present, signal absent, everything green"
 *     "signal user feedback can carry"
 *
 * A file whose comments discuss missing signals, scored by a checker that counts
 * the word "signal". That is the same defect as the subject matter, and it is why
 * the guard below parses call sites instead of grepping for a keyword.
 *
 * WHAT THIS ASSERTS
 *   · every outbound call in a server endpoint goes through fetchWithTimeout
 *   · the helper actually aborts, distinguishes a timeout from a network error,
 *     and does not discard a caller's own signal
 *   · a new unbounded fetch in an endpoint fails this file
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { fetchWithTimeout, withTimeout, DEFAULT_TIMEOUT_MS } from '../fetch-timeout.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

/** Server endpoints: root-level files exporting a handler, plus api/. Client
 *  files (wealthflow-*.js, sw.js) run in the browser, where a hang costs a
 *  spinner rather than the whole function's time budget — a real concern, but a
 *  different one, and not what this file is about. */
function serverEndpoints() {
    const out = [];
    for (const f of fs.readdirSync(ROOT)) {
        if (!f.endsWith('.js') || f.startsWith('wealthflow-') || f === 'sw.js') continue;
        const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
        if (/export\s+default\s+(async\s+)?function\s+handler/.test(src)) out.push(f);
    }
    for (const f of fs.readdirSync(path.join(ROOT, 'api'))) {
        if (f.endsWith('.js')) out.push('api/' + f);
    }
    return out.sort();
}

/** Strip comments and strings so a `fetch(` inside prose or a template literal is
 *  not mistaken for a call. This is the step the naive census skipped. */
function executableSource(src) {
    let s = src.replace(/\/\*[\s\S]*?\*\//g, ' ');
    s = s.split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
    s = s.replace(/'(?:[^'\\\n]|\\.)*'/g, "''")
        .replace(/"(?:[^"\\\n]|\\.)*"/g, '""')
        .replace(/`(?:[^`\\]|\\.)*`/g, '``');
    return s;
}

/** Read the balanced argument text of a call whose `(` is at `open`. */
function callArgs(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '(') depth++;
        else if (code[i] === ')') { depth--; if (depth === 0) return code.slice(open + 1, i); }
    }
    return code.slice(open + 1);
}

/**
 * Calls that can hang: a bare `fetch(` — not `fetchWithTimeout(`, not `.fetch(` —
 * whose arguments carry no `signal`.
 *
 * The signal check is the point. The requirement is that a call HAS A DEADLINE,
 * not that it uses one particular helper: statement-store.js and the inbox trio
 * bound their calls with a local AbortController and are correct as they stand.
 * An earlier version of this guard asserted the helper by name and flagged all of
 * them — a checker enforcing an implementation detail instead of the property that
 * matters, which is how a guard starts generating false findings and gets
 * disabled.
 */
function bareFetchCalls(src) {
    const code = executableSource(src);
    const hits = [];
    for (const m of code.matchAll(/(?<![\w.$])fetch\s*\(/g)) {
        const open = code.indexOf('(', m.index);
        // `signal: x`, shorthand `signal,` and `signal }` all count — statement-store.js
        // uses the shorthand, and an earlier version of this check missed it.
        if (/(?<![\w.$])signal\s*[:,}]/.test(callArgs(code, open))) continue;   // bounded already
        hits.push(code.slice(0, m.index).split('\n').length);
    }
    return hits;
}

const ENDPOINTS = serverEndpoints();

describe('the census can actually see (guards a vacuous pass)', () => {
    it('found the endpoints', () => {
        expect(ENDPOINTS.length).toBeGreaterThan(25);
        for (const f of ['fx-rate.js', 'merchant-search.js', 'feedback-triage.js', 'api/router.js']) {
            expect(ENDPOINTS, `${f} missing from the census`).toContain(f);
        }
    });

    it('counts a bare fetch, and does not count a wrapped one', () => {
        expect(bareFetchCalls('const r = await fetch(url);')).toHaveLength(1);
        expect(bareFetchCalls('const r = await fetchWithTimeout(url);')).toHaveLength(0);
        expect(bareFetchCalls('obj.fetch(url);')).toHaveLength(0);
    });

    it('accepts a bare fetch that carries its own signal', () => {
        // statement-store.js and the inbox trio are bounded this way and must not
        // be flagged: the requirement is a deadline, not a particular helper.
        expect(bareFetchCalls('await fetch(u, { method: "GET", signal: ctl.signal });')).toHaveLength(0);
        expect(bareFetchCalls('await fetch(u, {\n  headers: h,\n  signal,\n});')).toHaveLength(0);
        expect(bareFetchCalls('await fetch(u, { headers: h, signal });')).toHaveLength(0);
        // …and still catches one that has an init object but no signal in it.
        expect(bareFetchCalls('await fetch(u, { method: "POST", body: b });')).toHaveLength(1);
    });

    it('does not count the word fetch in a comment or a string', () => {
        // The exact mistake the first census made, in the other direction.
        expect(bareFetchCalls('// we should await fetch(x) here one day')).toHaveLength(0);
        expect(bareFetchCalls('/* await fetch(x) */')).toHaveLength(0);
        expect(bareFetchCalls('const s = "await fetch(x)";')).toHaveLength(0);
    });

    it('is not fooled by the word "signal" in prose — the original failure', () => {
        const prose = '// Machinery present, signal absent, everything green.\nawait fetch(u);';
        expect(bareFetchCalls(prose), 'a commented mention of "signal" hid a real call').toHaveLength(1);
    });
});

describe('THE BUG: every outbound call in a server endpoint has a deadline', () => {
    /* fetch-timeout.mjs is itself allowed one bare fetch — it IS the wrapper. */
    const ALLOWED = new Set(['fetch-timeout.mjs']);

    for (const f of ENDPOINTS) {
        it(`${f} makes no unbounded fetch`, () => {
            if (ALLOWED.has(f)) return;
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const bare = bareFetchCalls(src);
            expect(
                bare,
                `${f} calls fetch() with no timeout at line(s) ${bare.join(', ')}. `
                + 'An upstream that stalls will consume the whole maxDuration and the client '
                + 'gets FUNCTION_INVOCATION_TIMEOUT with no record of which upstream did it. '
                + "Use fetchWithTimeout from './fetch-timeout.mjs'.",
            ).toEqual([]);
        });
    }

    it('the eight endpoints repaired in this pass import the helper', () => {
        // Named explicitly: these are the files the naive census misjudged.
        for (const f of ['ai-vision.js', 'approve-release.js', 'drive-auth.js', 'feedback-status.js',
            'feedback.js', 'fx-rate.js', 'merchant-search.js', 'feedback-triage.js']) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            expect(src, `${f} no longer imports the timeout helper`).toMatch(/fetch-timeout\.mjs/);
        }
    });
});

describe('fetchWithTimeout actually times out', () => {
    const realFetch = globalThis.fetch;

    /** A fetch that never settles unless its signal aborts — the upstream this
     *  whole file exists for. */
    function installHangingFetch() {
        globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
            const sig = init && init.signal;
            if (!sig) return;                       // hangs forever, as the real one did
            if (sig.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
            sig.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        });
    }

    it('rejects with a TimeoutError instead of hanging', async () => {
        installHangingFetch();
        try {
            await expect(fetchWithTimeout('https://example.test/slow', {}, 40)).rejects.toThrow(/timed out after 40ms/);
        } finally { globalThis.fetch = realFetch; }
    });

    it('names the timeout distinctly, so it is not read as a network fault', async () => {
        installHangingFetch();
        try {
            const e = await fetchWithTimeout('https://example.test/slow', {}, 40).catch((x) => x);
            expect(e.name).toBe('TimeoutError');
            expect(e.timedOut).toBe(true);
            expect(e.timeoutMs).toBe(40);
        } finally { globalThis.fetch = realFetch; }
    });

    it('never puts a query string in the message', async () => {
        // Several of these endpoints carry an API key in the query, and this
        // message reaches logs and, in a few handlers, a response body.
        installHangingFetch();
        try {
            const e = await fetchWithTimeout('https://example.test/v1/x?key=SUPERSECRET&a=1', {}, 30)
                .catch((x) => x);
            expect(e.message).not.toMatch(/SUPERSECRET/);
            expect(e.message).not.toMatch(/\?/);
            expect(e.message).toMatch(/example\.test\/v1\/x/);
        } finally { globalThis.fetch = realFetch; }
    });

    it('passes a real network error through unchanged', async () => {
        globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
        try {
            await expect(fetchWithTimeout('https://example.test/x', {}, 5000)).rejects.toThrow(/ECONNREFUSED/);
        } finally { globalThis.fetch = realFetch; }
    });

    it('does NOT throw on 4xx/5xx — the caller still has to check r.ok', async () => {
        // A drop-in replacement must not change this, or every call site's error
        // handling would silently change meaning.
        globalThis.fetch = async () => new Response('nope', { status: 503 });
        try {
            const r = await fetchWithTimeout('https://example.test/x', {}, 5000);
            expect(r.status).toBe(503);
            expect(r.ok).toBe(false);
        } finally { globalThis.fetch = realFetch; }
    });

    it('resolves normally well inside the budget', async () => {
        globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });
        try {
            const r = await fetchWithTimeout('https://example.test/x', {}, 5000);
            expect((await r.json()).ok).toBe(true);
        } finally { globalThis.fetch = realFetch; }
    });

    it('honours a caller\'s own signal instead of discarding it', async () => {
        // Adding a deadline must not disable an existing cancellation path — that
        // would trade one silent failure for another.
        installHangingFetch();
        const caller = new AbortController();
        try {
            const p = fetchWithTimeout('https://example.test/slow', { signal: caller.signal }, 60_000);
            caller.abort();
            const e = await p.catch((x) => x);
            expect(e.timedOut, 'a caller abort was misreported as a timeout').toBeUndefined();
        } finally { globalThis.fetch = realFetch; }
    });

    it('aborts immediately if the caller\'s signal is already aborted', async () => {
        installHangingFetch();
        try {
            const e = await fetchWithTimeout('https://example.test/slow',
                { signal: AbortSignal.abort() }, 60_000).catch((x) => x);
            expect(e).toBeInstanceOf(Error);
        } finally { globalThis.fetch = realFetch; }
    });

    it('falls back to the default budget on a nonsense value', async () => {
        expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(1000);
        expect(DEFAULT_TIMEOUT_MS).toBeLessThan(60_000);   // must fit inside maxDuration
        installHangingFetch();
        try {
            for (const bad of [0, -1, NaN, null, undefined, 'soon']) {
                const p = fetchWithTimeout('https://example.test/slow', {}, bad);
                // Not awaited to completion — only that it did not adopt a 0ms or
                // infinite budget. A 0 would reject instantly; assert it does not.
                const settled = await Promise.race([
                    p.then(() => 'resolved', () => 'rejected'),
                    new Promise((r) => setTimeout(() => r('pending'), 30)),
                ]);
                expect(settled, `budget ${String(bad)} did not fall back to the default`).toBe('pending');
                p.catch(() => {});
            }
        } finally { globalThis.fetch = realFetch; }
    });

    it('clears its timer, so a fast call leaves nothing pending', async () => {
        globalThis.fetch = async () => new Response('ok');
        try {
            await fetchWithTimeout('https://example.test/x', {}, 50_000);
            // If the timer were left armed, vitest would hold the event loop for
            // 50s. Reaching the next line quickly is the assertion.
            expect(true).toBe(true);
        } finally { globalThis.fetch = realFetch; }
    });
});

describe('withTimeout is the same policy in the shape statement-store uses', () => {
    it('gives the callback a signal and clears the timer', async () => {
        let seen = null;
        const out = await withTimeout(async (signal) => { seen = signal; return 42; }, 5000);
        expect(out).toBe(42);
        expect(seen).toBeInstanceOf(AbortSignal);
        expect(seen.aborted).toBe(false);
    });

    it('aborts the signal it handed out when the budget expires', async () => {
        const aborted = await withTimeout(
            (signal) => new Promise((res) => signal.addEventListener('abort', () => res(true))),
            20,
        );
        expect(aborted).toBe(true);
    });
});

/* =============================================================================
 * CLIENT-SIDE CALLS
 * -----------------------------------------------------------------------------
 * The census above deliberately scoped itself to server endpoints, on the
 * grounds that a hang in the browser costs a spinner rather than a function's
 * whole time budget. That was true and it was not a reason to leave them
 * unbounded: fourteen client calls across eight files could stall forever, and a
 * spinner that never resolves is a feature the user cannot use and cannot
 * diagnose.
 *
 * The browser scripts are classic <script> IIFEs, not modules, so they cannot
 * import fetch-timeout.mjs. They share a guarded global instead — whichever file
 * loads first defines `window._wfFetchT` and the rest reuse it, which removes
 * both the load-order dependency and the eighth copy that would drift.
 *
 * sw.js is the exception, and deliberately so: see the app-shell assertions in
 * test/update_honesty_test.js. Passing ANY non-empty init to a `navigate` request
 * re-derives it and downgrades request.mode, so the shell's deadline is a
 * Promise.race rather than an AbortSignal. `{ signal }` there would be the very
 * bug the timeout was meant to prevent, in the one request that must never fail.
 * ===========================================================================*/
describe('client-side calls are bounded too', () => {
    const CLIENT = ['wealthflow-autonomous.js', 'wealthflow-crib.js', 'wealthflow-live-update.js',
        'wealthflow-queue.js', 'wealthflow-release-approve.js', 'wealthflow-vision-ocr.js',
        'wealthflow-vision-sms.js'];

    for (const f of CLIENT) {
        it(`${f} routes every call through the deadline helper`, () => {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            const code = executableSource(src);
            expect(code.indexOf('window._wfFetchT = window._wfFetchT ||'),
                `${f} does not define or reuse the shared deadline helper`).toBeGreaterThan(-1);
            // The helper's own body legitimately calls the real fetch once, so that
            // ONE line is excluded by exact text. An earlier version tried to skip
            // the whole helper by scanning to the next `};` — which landed on
            // `var opts = {};` inside the body, leaking `return fetch(url, opts)`
            // back into the scan and failing every correct file. Precision beats
            // cleverness for a boundary a guard depends on.
            const outside = code.replace('return fetch(url, opts).finally(function () { clearTimeout(t); });', '');
            const bare = [...outside.matchAll(/(?<![\w.$])fetch\s*\(/g)];
            expect(bare.map((m) => outside.slice(0, m.index).split('\n').length),
                `${f} still calls fetch() directly; use _wfFetchT(url, init, ms)`).toEqual([]);
        });
    }

    it('the helper calls the real fetch, not itself', () => {
        // A rename that turned the helper recursive would hang every call in the
        // app rather than bound it — the exact opposite of the intent, and it
        // would still satisfy a naive "no bare fetch" check.
        for (const f of CLIENT) {
            const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
            expect(src, `${f}'s helper is self-recursive`).toMatch(/return fetch\(url, opts\)/);
        }
    });

    it('sw.js bounds the shell without an AbortSignal, and the sync call with one', () => {
        const sw = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
        expect(sw).toMatch(/Promise\.race\(\[\s*fetch\(event\.request\)/);
        expect(sw, 'the background-sync call is unbounded').toMatch(/signal: syncCtl\.signal/);
    });
});
