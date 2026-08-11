/* =============================================================================
 * test/api_contract_test.js — the client and the server must agree
 * -----------------------------------------------------------------------------
 * THE FAILURE FAMILY THIS EXISTS TO END
 *
 * Twice now this repository has shipped an endpoint where every individual
 * piece was correct and the JOIN between them was not:
 *
 *   1. The 405. A POST to /api/feedback-triage resolved to index.html because
 *      the router was not being invoked at all. Handler fine, client fine, route
 *      dead. See test/api_routing_test.js.
 *
 *   2. Google Drive. drive-auth.js and drive-config.js were written on 26 July,
 *      complete and correct, and neither was ever added to the ROUTES table in
 *      api/router.js. The app called them on every attempt to connect Drive and
 *      got the not-found path every time. The owner's own health snapshot
 *      recorded the result for weeks:
 *          "drive": { "connected": false, "everGranted": true }
 *      — consent granted in the browser, server-side exchange impossible.
 *      Drive backup had never worked once, and nothing anywhere said so.
 *
 * Both are integration-boundary defects: each side passes its own tests, and the
 * contract between them is asserted by nobody. Unit tests cannot see this. Only
 * comparing the two sides can.
 *
 * WHAT THIS ASSERTS
 *   · every /api/… the client calls has a handler that can serve it
 *   · every ROUTES entry points at a file that actually exists
 *   · every root-level serverless handler is reachable through the router
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/** `name -> relative import path`, parsed from the router's ROUTES table. */
function routesTable() {
    const src = read('api/router.js');
    const out = {};
    for (const m of src.matchAll(/['"]([a-zA-Z0-9_-]+)['"]:\s*\(\)\s*=>\s*import\(['"]([^'"]+)['"]\)/g)) {
        out[m[1]] = m[2];
    }
    return out;
}

/** Endpoints served natively by a file in api/ (Vercel resolves these directly). */
const nativeRoutes = () => fs.readdirSync(path.join(ROOT, 'api'))
    .filter((f) => f.endsWith('.js')).map((f) => f.replace(/\.js$/, ''));

/** Every /api/… string the shipped client actually calls. */
function calledEndpoints() {
    const files = fs.readdirSync(ROOT).filter((f) => /\.(js|html)$/.test(f));
    const found = new Set();
    for (const f of files) {
        for (const m of read(f).matchAll(/['"`]\/api\/([a-zA-Z0-9_-]+)/g)) found.add(m[1]);
    }
    return [...found].sort();
}

/** Root-level files that export a serverless handler. */
function rootHandlers() {
    return fs.readdirSync(ROOT)
        .filter((f) => f.endsWith('.js'))
        .filter((f) => /export\s+default\s+(async\s+)?function\s+handler/.test(read(f)))
        .map((f) => f.replace(/\.js$/, ''))
        .sort();
}

describe('the parsers actually see the system (guards a vacuous pass)', () => {
    it('finds a substantial routes table, client calls and handlers', () => {
        // Every assertion below passes trivially against empty sets, which is
        // precisely how a contract check ends up guarding nothing.
        expect(Object.keys(routesTable()).length).toBeGreaterThan(25);
        expect(calledEndpoints().length).toBeGreaterThan(15);
        expect(rootHandlers().length).toBeGreaterThan(25);
        expect(nativeRoutes()).toContain('router');
    });
});

describe('every endpoint the client calls can actually be served', () => {
    it('has a handler for all of them', () => {
        const routes = routesTable();
        const native = nativeRoutes();
        const dead = calledEndpoints().filter((e) => !routes[e] && !native.includes(e));
        expect(dead, `the app calls these and NOTHING serves them:\n  /api/${dead.join('\n  /api/')}`).toEqual([]);
    });

    it('specifically serves the two Drive endpoints', () => {
        // Named explicitly because these were dead for weeks while the app kept
        // calling them, and the only symptom was a false field in a diagnostic
        // blob nobody was reading.
        const routes = routesTable();
        expect(routes['drive-auth'], '/api/drive-auth has no route').toBeTruthy();
        expect(routes['drive-config'], '/api/drive-config has no route').toBeTruthy();
    });
});

describe('every route points at something real', () => {
    it('resolves each ROUTES target to a file on disk', () => {
        const missing = [];
        for (const [name, rel] of Object.entries(routesTable())) {
            const p = rel.startsWith('./') ? path.join('api', rel.slice(2)) : rel.replace(/^\.\.\//, '');
            if (!fs.existsSync(path.join(ROOT, p))) missing.push(`${name} -> ${rel}`);
        }
        // A missing target is invisible until a request arrives, then throws
        // inside the dynamic import and surfaces as a 500 with no explanation.
        expect(missing, `ROUTES entries whose file does not exist:\n  ${missing.join('\n  ')}`).toEqual([]);
    });
});

describe('no handler is stranded', () => {
    it('makes every root-level handler reachable through the router', () => {
        const routes = routesTable();
        const native = nativeRoutes();
        const stranded = rootHandlers().filter((h) => !routes[h] && !native.includes(h));
        expect(
            stranded,
            'these files export a handler that nothing can reach — either route them or delete them:\n  ' + stranded.join('\n  '),
        ).toEqual([]);
    });
});

describe('the check can actually fail', () => {
    // A contract check that has never rejected anything is indistinguishable
    // from no contract check, so the comparison is exercised against inputs
    // that must be refused.
    const dead = (called, routes, native) => called.filter((e) => !routes[e] && !native.includes(e));

    it('flags a client call with no handler', () => {
        expect(dead(['drive-auth', 'ai'], { ai: './ai.js' }, [])).toEqual(['drive-auth']);
    });

    it('accepts an endpoint served natively from api/', () => {
        expect(dead(['ai'], {}, ['ai'])).toEqual([]);
    });

    it('flags a stranded handler', () => {
        const stranded = ['drive-auth', 'feedback'].filter((h) => !({ feedback: '../feedback.js' })[h]);
        expect(stranded).toEqual(['drive-auth']);
    });
});

describe('Firestore state intake — read, and honestly not worked', () => {
    // The audit's third finding. work-queue.mjs connects to Firestore, reads
    // system/pendingRelease and maps proposedChanges into fully-formed work
    // items; `queue.proposals` was then referenced in exactly ONE place, a log
    // line printing its length. The agent iterated queue.issues alone. The
    // module docstring says the proposals are "folded in" — they were counted.
    //
    // They also cannot just be folded in: every proposal carries number: null,
    // and the agent loop uses that number for the attempt-state file, the issue
    // comments, the labels and the `Closes #N` link. Merging them as-is breaks
    // all four, which is why the honest fix is to SAY they are ignored until
    // someone converts them into real issues.
    const agent = read('autonomous-fix-agent.js');
    const wq = read('autonomy/work-queue.mjs');

    it('still maps proposals with no issue number — the reason they cannot be worked', () => {
        const fn = wq.slice(wq.indexOf('export async function firestoreProposals'));
        expect(fn).toMatch(/number: null/);
    });

    it('tells the operator they were ignored, instead of printing a bare count', () => {
        expect(agent).toMatch(/were read but NOT worked/);
        expect(agent).toMatch(/File it as a GitHub issue to have it actioned/);
    });

    it('says so in the job summary too, not only the log', () => {
        expect(agent).toMatch(/Firestore proposal\(s\) ignored/);
    });

    it('does not pretend to queue them', () => {
        // The old line read "N workable issue(s); M Firestore proposal(s)",
        // which alongside the workable count implied M were queued.
        const bad = /log\(`\$\{candidates\.length\} workable issue\(s\); \$\{queue\.proposals\.length\} Firestore proposal\(s\)`\)/;
        expect(agent).not.toMatch(bad);
    });
});
