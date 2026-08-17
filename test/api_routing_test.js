// =============================================================================
// WealthFlow Shadow Test Harness — /api routing
// =============================================================================
// THE BUG THIS FILE EXISTS TO STOP.
//
// A user submitted feedback and the app said:
//
//     "Saved, but it could not be filed as a work item yet: the server answered
//      HTTP 405 without saying why."
//
// Nothing in this repo returns 405. The router answers 404 for an unknown
// endpoint, 500 for a crash, 204 for OPTIONS — never 405. That status came from
// Vercel: a POST to a STATIC FILE is answered "405 Method Not Allowed", and
// /api/feedback-triage was resolving to index.html.
//
// The evidence, gathered before changing anything:
//   • GET /api/health returned 1,574,601 characters — the index.html monolith,
//     not JSON.
//   • Six hours of production runtime logs contained exactly one request path,
//     /api/ai, which is served by its own real file at api/ai.js. The catch-all
//     had not been invoked once.
//
// So every endpoint whose handler lives at the repo root — feedback-triage,
// feedback, health, feedback-status, version, market-data, and twenty-odd more
// — had been dead since the router was written. The router file's own header
// described this exact 405 as the bug it FIXED. It never did: the file that
// claimed the fix was itself unreachable, because api/[...path].js relied on a
// bracketed catch-all filename being interpreted as a route, and it was not.
//
// That is this project's signature failure once more, and the reason it went
// unnoticed for so long is precise: nothing anywhere asserted that a request to
// /api/<something> reaches code. The unit tests imported the handlers directly
// and passed, because importing a module never asks whether it is routable.
//
// These tests ask. They are static — they cannot prove Vercel's behaviour, and
// they do not pretend to — but they hold the two properties whose absence let a
// self-referential rewrite and a dead filename sit in production: the rewrite
// must send /api/* at a file that EXISTS, and every handler the router claims
// to dispatch must be a file that EXISTS.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8'));
const routerSrc = fs.readFileSync('api/router.js', 'utf8');

/** The rewrite that is supposed to carry every /api request. */
const apiRewrite = (vercel.rewrites || []).find((r) => String(r.source || '').startsWith('/api'));

/** Turn a rewrite destination into the file Vercel would have to serve. */
function destinationFile(dest) {
    const p = String(dest || '').split('?')[0].replace(/^\//, '');
    for (const ext of ['.js', '.mjs', '.ts', '']) {
        if (ext && fs.existsSync(p + ext)) return p + ext;
    }
    return fs.existsSync(p) ? p : null;
}

describe('api routing: the /api rewrite points at a file that exists', () => {
    it('has a rewrite covering /api/*', () => {
        expect(apiRewrite, 'no rewrite in vercel.json matches /api').toBeTruthy();
    });

    it('is NOT the self-referential no-op that shipped', () => {
        // `{ source: '/api/(.*)', destination: '/api/$1' }` rewrites a path to
        // itself. It reads like configuration and does nothing: when no function
        // matches, the request falls onward to the SPA catch-all and lands on
        // index.html — which is what answered POSTs with 405 for months.
        expect(apiRewrite.destination).not.toBe('/api/$1');
        expect(apiRewrite.destination).not.toBe('/api/:path*');
    });

    it('resolves to a real file in the repository', () => {
        // The assertion that would have failed on the day the bug shipped. A
        // destination naming a file that is not there cannot route, and nothing
        // else in the build says so.
        const file = destinationFile(apiRewrite.destination);
        expect(file, `rewrite destination "${apiRewrite.destination}" resolves to no file`).toBeTruthy();
        expect(fs.existsSync(file)).toBe(true);
    });

    it('resolves to a file inside api/, where Vercel builds functions', () => {
        // Vercel's zero-config only turns files INSIDE /api into Serverless
        // Functions. A destination pointing anywhere else is a static asset, and
        // a POST to a static asset is exactly the 405 the user saw.
        expect(destinationFile(apiRewrite.destination).startsWith('api/')).toBe(true);
    });

    it('does not depend on a bracketed catch-all filename being routable', () => {
        // The previous router was api/[...path].js and was never invoked once in
        // production. Whatever the reason, the routing must not rest on how that
        // name is interpreted — an explicit rewrite to an ordinary filename
        // cannot be misread.
        const file = destinationFile(apiRewrite.destination);
        expect(file).not.toMatch(/[[\]]/);
        expect(fs.readdirSync('api').filter((f) => f.includes('['))).toEqual([]);
    });

    it('passes the requested endpoint through in a form the router reads', () => {
        // The destination carries ?path=$1, and resolveName() reads that key
        // first. If the rewrite dropped the capture, every request would arrive
        // named "router" and be answered "unknown endpoint" with total confidence.
        //
        // The key is now a named constant, because clientUrl() has to strip
        // exactly this key back out when it rebuilds the URL a Web-style handler
        // sees — leaving it in would hand the handler a phantom ?path= the client
        // never sent. So both halves are pinned: that the constant IS the key the
        // rewrite sends, and that resolveName reads the query through it. That is
        // a stronger claim than the single literal this line used to match, not a
        // relaxation of it.
        const key = (routerSrc.match(/const SELF_QUERY_KEY = '([^']+)'/) || [])[1];
        expect(key, 'the router no longer names the rewrite query key').toBeTruthy();
        expect(apiRewrite.destination).toMatch(new RegExp('[?&]' + key + '=\\$1\\b'));
        expect(routerSrc).toMatch(/req\.query\[SELF_QUERY_KEY\]/);
    });
});

describe('api routing: every endpoint the router claims to serve is importable', () => {
    // The HANDLERS map is a promise: "POST here and this module runs". Two of its
    // entries pointed at ../ai.js and ../vision-scan.js, which do not exist — the
    // files are in api/, not at the root. Nothing caught it because those two
    // paths are served by their own real files before a request could reach the
    // router, so the broken import was unreachable code inside an unreachable
    // file. It would have surfaced the moment the router started working.
    const entries = [...routerSrc.matchAll(/'([\w-]+)':\s*\(\)\s*=>\s*import\('([^']+)'\)/g)]
        .map(([, name, spec]) => ({ name, spec }));

    it('found the handler map (guards against a vacuous pass)', () => {
        // If the regex stopped matching, every it.each below would silently
        // vanish and this file would report green having checked nothing.
        expect(entries.length).toBeGreaterThanOrEqual(30);
    });

    it.each(entries)('$name → $spec exists', ({ spec }) => {
        expect(fs.existsSync(path.join('api', spec))).toBe(true);
    });

    it('exports a default handler for Vercel to call', () => {
        expect(routerSrc).toMatch(/export default async function handler/);
    });
});

describe('api routing: the router answers, and never with a bare 405', () => {
    // Behavioural, not textual: the module is loaded and called.
    const load = async () => (await import('../api/router.js')).default;

    const call = async (req) => {
        let status = 0; let body = null; let ended = false;
        const res = {
            setHeader() {}, headersSent: false,
            status(c) { status = c; return this; },
            json(o) { body = o; return this; },
            end() { ended = true; return this; },
        };
        await (await load())(req, res);
        return { status, body, ended };
    };

    it('answers OPTIONS pre-flight with 204, not an error', () => {
        return call({ method: 'OPTIONS', url: '/api/router?path=feedback-triage', query: { path: 'feedback-triage' } })
            .then(({ status, ended }) => {
                expect(status).toBe(204);
                expect(ended).toBe(true);
            });
    });

    it('answers an unknown endpoint with JSON 404 carrying a reason', async () => {
        // Not 405, and not HTML. The client shows `reason` verbatim, so a failure
        // without one is a failure the user cannot be told about.
        const { status, body } = await call({ method: 'POST', url: '/api/router?path=nope', query: { path: 'nope' } });
        expect(status).toBe(404);
        expect(body.endpoint).toBe('nope');
        expect(typeof body.reason).toBe('string');
        expect(body.reason.length).toBeGreaterThan(0);
    });

    it('does not mistake its own filename for the requested endpoint', async () => {
        // Every rewritten request has "router" in its URL path. If the URL
        // fallback ever won over ?path=, the router would answer every single
        // request with "this deployment has no /api/router endpoint".
        const { status, body } = await call({ method: 'POST', url: '/api/router', query: {} });
        expect(status).toBe(200);
        expect(body.service).toBe('wealthflow-api');
    });

    it('reports the endpoint count from the map itself, not a hardcoded number', async () => {
        const { body } = await call({ method: 'GET', url: '/api/router', query: {} });
        expect(body.endpoints).toBeGreaterThanOrEqual(30);
    });
});
