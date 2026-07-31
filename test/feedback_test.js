// =============================================================================
// WealthFlow Shadow Test Harness — the feedback loop
// =============================================================================
// The user's core request was that feedback must be acted on AND reported back
// as complete. Two things stood in the way, both now fixed and pinned here:
//
//   1. /api/feedback-triage — the only path from feedback to an actionable issue
//      — was never called by any client code.
//   2. The "send system diagnosis" tick attached only the user-agent, screen
//      size and language, while a full crash report sat unused in the app.
//
// These tests cover the pure logic of the return path and the diagnostics
// renderer, so a regression cannot silently reopen the void.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import { parseIssueList, versionFromComments, summarise } from '../feedback-status.js';
import fs from 'node:fs';
import handler, {
    diagnosticsSection, localClassify, fingerprint, LABELS,
    imageSection, IMAGE_MARKER, IMAGE_BUDGET,
} from '../feedback-triage.js';

describe('feedback-status: issue list parsing', () => {
    it('parses a normal comma list', () => {
        expect(parseIssueList('12,15,19')).toEqual([12, 15, 19]);
    });

    it('tolerates spaces and stray separators', () => {
        expect(parseIssueList(' 3 , 4 ,, 5 ')).toEqual([3, 4, 5]);
    });

    it('rejects non-numeric, zero, and negative values', () => {
        expect(parseIssueList('abc,0,-4,7')).toEqual([7]);
    });

    it('caps the list so one request cannot fan out unboundedly', () => {
        const many = Array.from({ length: 200 }, (_, i) => i + 1).join(',');
        expect(parseIssueList(many)).toHaveLength(25);
    });

    it('returns an empty list for empty/garbage input rather than throwing', () => {
        expect(parseIssueList('')).toEqual([]);
        expect(parseIssueList(null)).toEqual([]);
        expect(parseIssueList(undefined)).toEqual([]);
    });

    it('never throws and only ever yields positive integers', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
            for (const n of parseIssueList(s)) {
                expect(Number.isInteger(n)).toBe(true);
                expect(n).toBeGreaterThan(0);
            }
        }), { numRuns: runs(400) });
    });
});

describe('feedback-status: reporting completion', () => {
    it('marks a closed issue as completed', () => {
        const s = summarise({ number: 7, state: 'closed', title: 'x', closed_at: '2026-07-20T00:00:00Z' }, []);
        expect(s.completed).toBe(true);
        expect(s.wontFix).toBe(false);
    });

    it('does NOT claim completion for an issue closed as not planned', () => {
        const s = summarise({ number: 7, state: 'closed', state_reason: 'not_planned', title: 'x' }, []);
        expect(s.completed).toBe(false);
        expect(s.wontFix).toBe(true);
    });

    it('reports an open issue as not complete', () => {
        expect(summarise({ number: 7, state: 'open', title: 'x' }, []).completed).toBe(false);
    });

    it('surfaces in-progress so the app can say "being worked on"', () => {
        const s = summarise({ number: 7, state: 'open', title: 'x', labels: [{ name: 'ai-working' }] }, []);
        expect(s.inProgress).toBe(true);
    });

    it('surfaces needsHuman when the agent stood down', () => {
        const s = summarise({ number: 7, state: 'open', title: 'x', labels: [{ name: 'ai-stuck' }] }, []);
        expect(s.needsHuman).toBe(true);
    });

    it('extracts the version a fix shipped in', () => {
        expect(versionFromComments([
            { body: 'working on it' },
            { body: '### ✅ Shipped\n\nThis fix is live in v7.70.1.' },
        ])).toBe('7.70.1');
    });

    it('ignores a version mentioned without any shipping language', () => {
        expect(versionFromComments([{ body: 'this reproduces on 7.69.12 too' }])).toBeNull();
    });

    it('returns null when there are no comments at all', () => {
        expect(versionFromComments([])).toBeNull();
        expect(versionFromComments(null)).toBeNull();
    });

    it('never throws on a malformed issue payload', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => summarise(x, [])).not.toThrow();
        }), { numRuns: runs(300) });
    });
});

describe('feedback-triage: the diagnostics the tick actually sends', () => {
    const rich = {
        ua: 'Mozilla/5.0 (iPhone)', screen: '390x844', viewport: '390x700',
        lang: 'en-GB', online: true, standalone: true, activePage: 'reports', domNodes: 4211,
        errorSummary: { total: 3, fromThisBuild: 2, uniqueMessages: ["Cannot read properties of null (reading 'map')"] },
        errors: [{ msg: "Cannot read properties of null", stack: 'at renderReports (index.html:123)', page: 'reports', ver: '7.69.12' }],
        detectedIssues: [{ severity: 'error', message: '2 error(s) recorded on the current build.' }],
        health: { storage: { approxKB: 2100 } },
    };

    it('renders the error messages and stack traces the agent needs', () => {
        const md = diagnosticsSection(rich);
        expect(md).toMatch(/System diagnosis/);
        expect(md).toMatch(/Cannot read properties of null/);
        expect(md).toMatch(/renderReports/);
    });

    it('renders the app\'s own self-detected problems', () => {
        expect(diagnosticsSection(rich)).toMatch(/2 error\(s\) recorded on the current build/);
    });

    it('includes the device facts the old version sent, so nothing regressed', () => {
        const md = diagnosticsSection(rich);
        expect(md).toMatch(/iPhone/);
        expect(md).toMatch(/390x844/);
    });

    it('returns empty string when the user did NOT tick the box', () => {
        expect(diagnosticsSection(null)).toBe('');
        expect(diagnosticsSection(undefined)).toBe('');
    });

    it('stays well inside GitHub\'s 65,536-character issue-body limit', () => {
        const huge = {
            ua: 'x'.repeat(5000),
            errors: Array.from({ length: 50 }, () => ({ msg: 'm'.repeat(2000), stack: 's'.repeat(5000), page: 'p', ver: 'v' })),
            errorSummary: { total: 999, fromThisBuild: 999, uniqueMessages: Array.from({ length: 50 }, () => 'u'.repeat(1000)) },
            detectedIssues: Array.from({ length: 50 }, () => ({ severity: 'error', message: 'd'.repeat(1000) })),
            health: { blob: 'h'.repeat(100000) },
        };
        expect(diagnosticsSection(huge).length).toBeLessThan(60000);
    });

    it('never throws on arbitrary diagnostics shapes', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => diagnosticsSection(x)).not.toThrow();
            expect(typeof diagnosticsSection(x)).toBe('string');
        }), { numRuns: runs(400) });
    });
});

describe('feedback-triage: classification', () => {
    it('treats a possible data leak as critical security', () => {
        expect(localClassify('I can see another user\'s balance')).toEqual({ type: 'security', severity: 'critical' });
    });

    it('treats a white screen as a critical crash', () => {
        expect(localClassify('white screen when I open reports').type).toBe('crash');
    });

    it('treats readability complaints as UI', () => {
        expect(localClassify('the font is too hard to read').type).toBe('ui');
    });

    it('maps every classification to a real label', () => {
        for (const t of ['bug', 'crash', 'ui', 'feature', 'security', 'other']) {
            expect(LABELS[t], t).toBeTruthy();
        }
    });

    it('produces a stable fingerprint for de-duplication', () => {
        expect(fingerprint('the reports page is blank')).toBe(fingerprint('The Reports page is blank!'));
    });

    it('distinguishes genuinely different reports', () => {
        expect(fingerprint('reports page blank')).not.toBe(fingerprint('budget total wrong'));
    });

    it('never throws on arbitrary feedback text', () => {
        fc.assert(fc.property(fc.string({ maxLength: 500 }), (s) => {
            expect(() => localClassify(s)).not.toThrow();
            expect(() => fingerprint(s)).not.toThrow();
        }), { numRuns: runs(400) });
    });
});


// ── attached screenshots (the silently discarded payload) ────────────────────
// The client has always captured a screenshot, downscaled it to 900px and sent
// it as `image`. feedback-triage.js never read the field, so every screenshot a
// user attached was transmitted and thrown away on arrival — the AI never saw a
// single one. These tests pin the field being read AND the safety limits, since
// an oversized body is rejected by GitHub outright and would lose the whole
// report, not merely the picture.
describe('feedback: an attached screenshot reaches the agent', () => {
    const b64 = (n) => 'A'.repeat(n);
    const png = (n = 400) => 'data:image/png;base64,' + b64(n);

    it('embeds a valid inline image, with a marker the agent can find', () => {
        const out = imageSection(png());
        expect(out).toContain(IMAGE_MARKER);
        expect(out).toContain('data:image/png;base64,');
        expect(out).toMatch(/### Screenshot/);
    });

    it('accepts png, jpeg and webp', () => {
        for (const t of ['png', 'jpeg', 'jpg', 'webp']) {
            expect(imageSection('data:image/' + t + ';base64,' + b64(200)), t).toContain(IMAGE_MARKER);
        }
    });

    it('emits nothing at all when no image was attached', () => {
        expect(imageSection('')).toBe('');
        expect(imageSection(null)).toBe('');
        expect(imageSection(undefined)).toBe('');
    });

    it('REFUSES a remote URL or an SVG rather than pasting it into the issue', () => {
        // An autonomous agent later reads this body. A remote URL is an
        // exfiltration vector and an SVG can carry script, so neither is
        // embedded just because it arrived in an image field.
        for (const bad of [
            'https://evil.example.com/x.png',
            'data:image/svg+xml;base64,' + b64(50),
            'data:text/html;base64,' + b64(50),
            'javascript:alert(1)',
            'data:image/png;base64,not*valid*base64!',
        ]) {
            const out = imageSection(bad);
            expect(out, bad).not.toContain(IMAGE_MARKER);
            expect(out, bad).not.toContain(bad);
        }
    });

    it('REFUSES an oversized image instead of truncating it', () => {
        // Half a base64 string is not an image. Truncating would spend a vision
        // call to discover that, and an over-length body loses the whole report.
        const out = imageSection(png(IMAGE_BUDGET + 5000));
        expect(out).not.toContain(IMAGE_MARKER);
        expect(out).toMatch(/exceeds/i);
        expect(out).toMatch(/Firestore/);          // says where the full copy is
    });

    it('keeps the budget well inside GitHub\'s 65,536-character body limit', () => {
        expect(IMAGE_BUDGET).toBeLessThan(65536 - 15000);
    });

    it('never throws on adversarial input', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => imageSection(x)).not.toThrow();
        }), { numRuns: runs(300) });
    });

    it('is actually wired into the handler, not merely exported', () => {
        // The original bug was a function that existed conceptually and was
        // never called. Asserting the export alone would not have caught it.
        const src = fs.readFileSync('feedback-triage.js', 'utf8');
        expect(src).toMatch(/body\.image/);                 // the field is read

        // Assert the CALL SITE, not just the name. The first version of this
        // test matched /imageSection\(image\)/ — which also matches the
        // `export function imageSection(image) {` DEFINITION, so deleting the
        // call left the test passing. A test that cannot fail is worse than no
        // test, because it reports safety that is not there.
        expect(src, 'imageSection is defined but never called from the issue body')
            .toMatch(/^\s*imageSection\(image\),\s*$/m);

        // And it must sit inside the issue-body array, next to the section it
        // belongs beside — not merely somewhere in the file.
        const body = src.slice(src.indexOf('const issueBody'), src.indexOf('.filter(Boolean)'));
        expect(body).toMatch(/diagnosticsSection\(diagnostics\)/);
        expect(body).toMatch(/imageSection\(image\)/);
    });
});

// ── browser password prompts (claim: "randomly asks for a new password") ─────
describe('app: no markup that invites a browser password prompt', () => {
    const html = fs.readFileSync('index.html', 'utf8');

    it('has no account-password flow at all', () => {
        // The app authenticates with Google plus a local 6-digit PIN. There is no
        // password to set, so any prompt for one comes from the browser.
        for (const api of ['sendPasswordResetEmail', 'updatePassword', 'createUserWithEmailAndPassword']) {
            expect(html, api).not.toContain(api);
        }
    });

    it('marks every masked PIN input autocomplete="off"', () => {
        // WHY THE PROMPT APPEARED: five inputs used type="password" with no
        // autocomplete attribute. Browsers treat a bare password field — and
        // especially an adjacent new/confirm pair like cp_new/cp_confirm — as a
        // credential form, and offer "Save password?" or the strong-password
        // generator. Nothing in this repo ever contained the words "new
        // password"; the text came from Chrome, triggered by our own markup.
        const inputs = html.match(/<input[^>]*type="password"[^>]*>/gs) || [];
        expect(inputs.length).toBeGreaterThan(0);
        for (const tag of inputs) {
            expect(tag, `missing autocomplete: ${tag.slice(0, 140)}`).toMatch(/autocomplete="off"/);
        }
    });

    it('never uses autocomplete="new-password", which INVITES the generator', () => {
        // The intuitive "fix" is the exact opposite of one: new-password is the
        // value that asks Chrome to offer a generated password.
        expect(html).not.toMatch(/autocomplete="new-password"/);
    });
});

// =============================================================================
// The endpoint must never report success for work it did not do
// =============================================================================
// A real bug report — "Add your income button please fix that. Urgently fix that
// issue." — was submitted, classified, and dropped. Every signal said it worked:
// the server returned HTTP 200 with ok:true and a `note` nobody read, and the
// client checked only for an issue number and ignored everything else. Both ends
// conspired to look successful.
//
// That is this project's signature failure, now found for the fourth time: a test
// job that ran no tests and exited 0; an auto-merge gate keyed to a label nothing
// applied; a schedule six times over its allowance; and now a feedback endpoint
// that accepts a report and files nothing. Machinery present, signal absent,
// everything green.
// =============================================================================
describe('feedback-triage: no false confirmations', () => {
    const KEYS = ['GITHUB_REPO', 'GITHUB_REPOSITORY', 'GH_PAT', 'GITHUB_TOKEN', 'GITHUB_MODELS_TOKEN', 'EDENAI_API_KEY',
        // resolveRepo() now also falls back to these, so a machine that happens to
        // have them set (any Vercel context) must not make "not configured" tests
        // find a repo. Cleared here to keep the config-gap assertions hermetic.
        'VERCEL_GIT_REPO_OWNER', 'VERCEL_GIT_REPO_SLUG'];
    const call = async (env) => {
        // Save and restore KEY BY KEY. Assigning `process.env = {...}` replaces
        // Node's special env object with a plain one, which breaks things far away
        // from here — the first version of this helper did that and made an
        // unrelated test read an empty file.
        const saved = {};
        for (const k of KEYS) saved[k] = process.env[k];
        for (const k of KEYS) { if (k in env) process.env[k] = env[k]; else delete process.env[k]; }
        let status = 0; let body = null;
        const res = {
            setHeader() {},
            status(c) { status = c; return this; },
            json(o) { body = o; return this; },
        };
        await handler({ body: { text: 'the Add your income button is broken' } }, res);
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
        return { status, body };
    };

    it('refuses to claim success when it has no repo or token', async () => {
        const { status, body } = await call({});
        expect(status).toBe(503);
        expect(body.ok).toBe(false);
        expect(body.error).toBe('not_configured');
        expect(body.reason).toMatch(/GITHUB_REPO/);
        expect(body.reason).toMatch(/saved locally/i);
    });

    it('names which half is missing, so the fix is obvious', async () => {
        const onlyRepo = await call({ GITHUB_REPO: 'o/r' });
        expect(onlyRepo.body.reason).toMatch(/GitHub token/i);
        expect(onlyRepo.body.reason).not.toMatch(/GITHUB_REPO/);
    });

    it('reports what is configured WITHOUT exposing any value', async () => {
        const { body } = await call({ GITHUB_REPO: 'o/r', GH_PAT: 'ghp_supersecretvalue' });
        expect(body.configured).toEqual({ repo: true, token: true });
        // The diagnostic must never become the leak. No value, no prefix, no length.
        const json = JSON.stringify(body);
        expect(json).not.toContain('ghp_supersecretvalue');
        expect(json).not.toContain('supersecret');
        expect(json).not.toContain('o/r'.repeat(1) + '"'); // repo name only where it belongs
    });

    it('still classifies the feedback even when it cannot file it', async () => {
        // The classification is useful on the retry, so a config gap must not
        // discard the work already done.
        const { body } = await call({});
        expect(body.classification).toBeTruthy();
        expect(['bug', 'crash', 'ui', 'feature', 'security', 'other']).toContain(body.classification.type);
    });

    it('rejects an empty report with 400, not a silent 200', async () => {
        let status = 0; let body = null;
        const res = { setHeader() {}, status(c) { status = c; return this; }, json(o) { body = o; return this; } };
        await handler({ body: { text: '   ' } }, res);
        expect(status).toBe(400);
        expect(body.ok).toBe(false);
    });

    it('gives every non-2xx a `reason` the app can show verbatim', async () => {
        // The client displays `reason` and nothing else. A failure shape without
        // one is a failure the user cannot be told about.
        let status = 0; let body = null;
        const res = { setHeader() {}, status(c) { status = c; return this; }, json(o) { body = o; return this; } };
        await handler({ body: { text: '   ' } }, res);
        expect(status).not.toBe(200);
        expect(typeof body.reason).toBe('string');
        expect(body.reason.length).toBeGreaterThan(0);
    });

    it('answers "can this deployment file at all?" without filing anything', async () => {
        // An empty POST is a zero-side-effect health check: no issue is created,
        // no GitHub call is made, and the answer comes back anyway. Without this,
        // the only way to find out whether the environment is configured was to
        // submit a real bug report and watch it vanish.
        let status = 0; let body = null;
        const res = { setHeader() {}, status(c) { status = c; return this; }, json(o) { body = o; return this; } };
        const saved = {};
        for (const k of KEYS) saved[k] = process.env[k];
        for (const k of KEYS) delete process.env[k];
        await handler({ body: {} }, res);
        for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }

        expect(status).toBe(400);
        expect(body.configured).toEqual({ repo: false, token: false });
    });
});

// =============================================================================
// The client cannot fall through to a success message. Ever.
// =============================================================================
// The fix above made the SERVER honest, and the app was still showing "Thank you
// — your feedback was saved and prioritised." for a report that was filed
// nowhere. The server was not the one lying any more; the client was.
//
// The check it used was `else if (j && j.reason)`, which trusts the endpoint to
// name its own failure. The endpoint does — but it is not the only thing that
// answers that URL. api/router.js returns `{ error: 'Unknown endpoint' }` and
// `{ error: 'Endpoint runtime crash' }` with no `reason` at all, and a
// platform-level failure returns an HTML page, so `r.json()` rejects and there is
// no body to read. Each of those matched neither branch, left `triageError` null,
// and dropped straight through to the success string.
//
// Same defect, one layer up from where it was fixed. So the rule is now inverted
// — success must be PROVEN — and these tests enumerate the failure shapes rather
// than trusting the next one to look like the last.
// =============================================================================
describe('feedback client: success is proven, never assumed', () => {
    // Load the real browser IIFE with a stub global bag: the two functions under
    // test are pure, but they live in a file that expects a DOM, so evaluating
    // the shipped source is the only way to test what actually runs.
    const wf = (() => {
        const noop = () => {};
        const win = {};
        const el = () => ({ style: {}, classList: { add: noop, remove: noop }, appendChild: noop, setAttribute: noop });
        const doc = {
            readyState: 'complete', addEventListener: noop, getElementById: () => null,
            querySelector: () => null, querySelectorAll: () => [], createElement: el,
            body: { appendChild: noop }, head: { appendChild: noop },
        };
        const store = { getItem: () => null, setItem: noop, removeItem: noop };
        new Function(
            'window', 'document', 'console', 'localStorage', 'sessionStorage', 'navigator',
            'setTimeout', 'setInterval', 'fetch', 'screen', 'location',
            fs.readFileSync('wealthflow-update-system.js', 'utf8'),
        )(win, doc, { log: noop, warn: noop, error: noop }, store, store,
            { onLine: true, userAgent: 'test' }, noop, noop, noop, { width: 1, height: 1 },
            { href: 'http://localhost/', reload: noop });
        return win.wfUpdate;
    })();

    const read = (status, body, err) => wf._readTriageResponse(status, body, err);
    const said = (status, body) => wf._feedbackMessage({
        issue: read(status, body).issue, reason: read(status, body).reason, stored: true,
    });

    it('loaded the shipped module (guards against a vacuous pass)', () => {
        expect(typeof wf._readTriageResponse).toBe('function');
        expect(typeof wf._feedbackMessage).toBe('function');
    });

    it('reports a filed issue as a work item', () => {
        expect(read(200, { ok: true, issue: 42 }).issue).toBe(42);
        expect(said(200, { ok: true, issue: 42 }).msg).toMatch(/work item #42/);
    });

    it('treats an already-tracked duplicate as filed, not as a failure', () => {
        expect(read(200, { ok: true, deduped: 7 }).issue).toBe(7);
    });

    it('shows the endpoint\'s own reason when it gives one', () => {
        const m = said(503, { ok: false, error: 'not_configured', reason: 'GITHUB_REPO is missing.' });
        expect(m.msg).toMatch(/GITHUB_REPO is missing/);
        expect(m.tone).toBe('warn');
    });

    // ── the shapes that used to slip through ────────────────────────────────
    const silent = [
        ['router 404, no reason field', 404, { error: 'Unknown endpoint', endpoint: 'feedback-triage' }],
        ['router 500, no reason field', 500, { error: 'Endpoint runtime crash', endpoint: 'feedback-triage' }],
        ['not-bundled 500, no reason field', 500, { error: 'Endpoint file not bundled by Vercel' }],
        ['an HTML error page (body unparseable)', 500, null],
        ['a gateway timeout with no body', 504, null],
        ['a payload rejected as too large', 413, null],
        ['200 with an empty body', 200, {}],
        ['200 that says ok but filed nothing', 200, { ok: true }],
    ];

    it.each(silent)('never claims success for %s', (_name, status, body) => {
        const v = read(status, body);
        expect(v.issue).toBeFalsy();
        expect(typeof v.reason).toBe('string');
        expect(v.reason.length).toBeGreaterThan(0);

        const m = said(status, body);
        expect(m.tone).toBe('warn');
        expect(m.msg).toMatch(/could not be filed as a work item/);
    });

    it('names the status code, so an unexplained failure is still diagnosable', () => {
        expect(read(502, null).reason).toMatch(/502/);
        expect(read(404, null).reason).toMatch(/404/);
    });

    it('a request that never completed is a failure, not a silence', () => {
        // This is the case `catch (_) {}` used to swallow entirely. With Firestore
        // already succeeding, the swallow is what produced the success toast.
        const v = read(0, null, new Error('Failed to fetch'));
        expect(v.issue).toBeFalsy();
        expect(v.reason).toMatch(/could not be reached/);
    });

    it('cannot produce "saved and prioritised" for ANY state', () => {
        // The exact string the user reported seeing. Nothing in this app can know
        // a report was prioritised unless it became a work item, so no combination
        // of inputs may produce it — and if it ever appears on screen again, that
        // can only be stale cached JS, which is itself the diagnosis.
        fc.assert(fc.property(
            fc.option(fc.integer({ min: 1, max: 9999 }), { nil: null }),
            fc.option(fc.string({ maxLength: 80 }), { nil: null }),
            fc.boolean(),
            (issue, reason, stored) => {
                expect(wf._feedbackMessage({ issue, reason, stored }).msg)
                    .not.toMatch(/prioriti[sz]ed/i);
            },
        ), { numRuns: runs(300) });
    });

    it('only ever calls something a success when an issue number backs it', () => {
        fc.assert(fc.property(
            fc.option(fc.integer({ min: 1, max: 9999 }), { nil: null }),
            fc.option(fc.string({ maxLength: 80 }), { nil: null }),
            fc.boolean(),
            (issue, reason, stored) => {
                const m = wf._feedbackMessage({ issue, reason, stored });
                if (m.tone === 'success') expect(issue).toBeTruthy();
            },
        ), { numRuns: runs(300) });
    });

    it('never throws, whatever the server returns', () => {
        fc.assert(fc.property(fc.integer({ min: 0, max: 599 }), fc.anything(), (status, body) => {
            expect(() => read(status, body)).not.toThrow();
            const v = read(status, body);
            // The invariant, stated once: an outcome is either a filed issue or a
            // stated reason. There is no third state, and no silence.
            expect(Boolean(v.issue) !== Boolean(v.reason)).toBe(true);
        }), { numRuns: runs(400) });
    });
});

// ── the screenshot has to travel WITH the report ─────────────────────────────
describe('feedback client: the attached screenshot reaches triage', () => {
    const src = fs.readFileSync('wealthflow-update-system.js', 'utf8');
    const call = src.slice(src.indexOf("fetch('/api/feedback-triage'"), src.indexOf("if (issueNumber) { payload.issue"));

    it('sends `image` in the triage POST body', () => {
        // feedback-triage.js renders body.image into the issue so the fix agent can
        // see it. That renderer, its size budget and its data-URL validation were
        // all built and tested — and the call site never sent the field, so it
        // received '' on every real submission. The tests above proved the
        // renderer worked; none of them proved anything ever reached it.
        expect(call).toMatch(/image:\s*payload\.image/);
    });

    it('still sends the text, type and diagnostics alongside it', () => {
        expect(call).toMatch(/\btype\b/);
        expect(call).toMatch(/\btext\b/);
        expect(call).toMatch(/diagnostics:\s*diagnostics/);
    });
});
