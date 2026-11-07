/* The browser canary: a release that is served but does not boot is caught, and each way of not booting is named.
 *
 * The pure verdict (judgeCanary / isOwnError) is tested on its own. The browser half runs a REAL Chromium against a small local
 * site that is healthy, or broken in exactly one way, and checks that the canary names that way. If no Chromium can be started
 * here the browser tests are skipped (and say so); the verdict tests always run.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { judgeCanary, isOwnError, observe, runCanary, CHECK_IDS } from '../autonomy/canary.mjs';

const GOOD = { status: 200, bodyTextLength: 900, version: '7.70.0', failedAssets: [], pageErrors: [], hasUpdateModule: true, serviceWorker: true };

describe('judgeCanary', () => {
    it('passes when every check passes, and lists them all in order', () => {
        const v = judgeCanary(GOOD, { expect: '7.70.0' });
        expect(v.ok).toBe(true);
        expect(v.checks.map((c) => c.id)).toEqual(CHECK_IDS);
        expect(v.failing).toEqual([]);
    });
    const broken = [
        ['loads', { status: 502 }, /HTTP 502/],
        ['loads', { bodyTextLength: 12 }, /12 characters|answered|on screen/],
        ['version', { version: '7.69.9' }, /runs 7\.69\.9, the release is 7\.70\.0/],
        ['version', { version: null }, /did not say/],
        ['assets', { failedAssets: [{ url: '/wealthflow-x.js', status: 404 }] }, /\/wealthflow-x\.js → 404/],
        ['errors', { pageErrors: ['x is not defined'] }, /x is not defined/],
        ['update-module', { hasUpdateModule: false }, /could not be updated again/],
        ['service-worker', { serviceWorker: false }, /no service worker/],
    ];
    for (const [id, patch, detail] of broken) {
        it(`names "${id}" when ${JSON.stringify(patch).slice(0, 50)}`, () => {
            const v = judgeCanary({ ...GOOD, ...patch }, { expect: '7.70.0' });
            expect(v.ok).toBe(false);
            expect(v.failing).toContain(id);
            expect(v.checks.find((c) => c.id === id).detail).toMatch(detail);
        });
    }
    it('an empty observation is a failure on every check that needs evidence, never a pass', () => {
        for (const o of [undefined, null, {}]) {
            const v = judgeCanary(o, { expect: '7.70.0' });
            expect(v.ok).toBe(false);
            expect(v.failing.length).toBe(CHECK_IDS.length);
        }
    });
    it('without an expected version it still insists the page says one', () => {
        expect(judgeCanary(GOOD).ok).toBe(true);
        expect(judgeCanary({ ...GOOD, version: null }).failing).toEqual(['version']);
    });
});

describe('isOwnError', () => {
    const origin = 'https://www.wealthflow.lk';
    it('an error from the release\'s own code counts', () => expect(isOwnError({ stack: `ReferenceError: a\n at f (${origin}/wealthflow-x.js:10:5)` }, origin)).toBe(true));
    it('an error from a third-party script does not', () => expect(isOwnError({ stack: 'Error: b\n at https://www.gstatic.com/firebasejs/x.js:1:1' }, origin)).toBe(false));
    it('an error with no location at all is treated as ours', () => expect(isOwnError(new Error('plain'), origin) || isOwnError({ message: 'plain' }, origin)).toBe(true));
    it('one own frame among foreign ones is enough', () => expect(isOwnError({ stack: `E\n at https://cdn.x/a.js:1:1\n at ${origin}/app:5:5` }, origin)).toBe(true));
});

/* ------------------------------------------------------------------ a real browser */
const PAGE = (extra = '', version = '7.70.0') => `<!doctype html><html><head><meta charset="utf-8"><title>WF</title>
<script>window.WF_APP_VERSION='${version}';</script></head><body>
<p>${'WealthFlow canary fixture page. '.repeat(8)}</p>
<script src="/ok.js"></script>${extra}
<script>try{navigator.serviceWorker.register('/sw.js').catch(function(){})}catch(e){}</script></body></html>`;

function site(variant) {
    return http.createServer((req, res) => {
        const p = req.url.split('?')[0];
        const send = (type, body, code = 200) => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
        if (p === '/app') {
            if (variant === 'down') return send('text/plain', 'bad gateway', 502);
            if (variant === 'old') return send('text/html', PAGE('', '7.69.1'));
            if (variant === 'missing-script') return send('text/html', PAGE('<script src="/gone.js"></script>'));
            if (variant === 'throws') return send('text/html', PAGE('<script src="/throws.js"></script>'));
            if (variant === 'no-updater') return send('text/html', PAGE('<script>window.wfUpdate = undefined;</script>').replace('<script src="/ok.js"></script>', '<script src="/ok-noupdate.js"></script>'));
            return send('text/html', PAGE());
        }
        if (p === '/ok.js') return send('text/javascript', 'window.wfUpdate = { start: function () {} };');
        if (p === '/ok-noupdate.js') return send('text/javascript', 'window.somethingElse = 1;');
        if (p === '/throws.js') return send('text/javascript', 'window.wfUpdate = { start: function () {} }; setTimeout(function () { notDefinedAnywhere.boot(); }, 100);');
        if (p === '/sw.js') return send('text/javascript', variant === 'no-sw' ? 'throw new Error("sw broken")' : 'self.addEventListener("fetch", function () {});');
        return send('text/plain', 'not found', 404);
    });
}

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
let browserOk = false;
beforeAll(async () => {
    const srv = site('good');
    const base = await listen(srv);
    try { const o = await observe({ base, timeoutMs: 20000, settleMs: 300 }); browserOk = o.status === 200; } catch (_) { browserOk = false; }
    await new Promise((r) => srv.close(r));
}, 60000);

describe('observe + runCanary in a real browser', () => {
    const run = async (variant, expectVersion = '7.70.0') => {
        const srv = site(variant); const base = await listen(srv);
        try { return await runCanary({ base, expect: expectVersion, timeoutMs: 20000, settleMs: 600, swWaitMs: 2000 }); } finally { await new Promise((r) => srv.close(r)); }
    };
    const cases = [
        ['good', true, []],
        ['down', false, ['loads']],
        ['old', false, ['version']],
        ['missing-script', false, ['assets']],
        ['throws', false, ['errors']],
        ['no-updater', false, ['update-module']],
        ['no-sw', false, ['service-worker']],
    ];
    for (const [variant, ok, failing] of cases) {
        it(`${variant}: ${ok ? 'passes' : 'fails on ' + failing.join(', ')}`, async (ctx) => {
            if (!browserOk) return ctx.skip();
            const r = await run(variant);
            // a page that does not answer cannot show its version or its worker either; what matters is that the FIRST failure is the cause
            const got = variant === 'down' ? r.verdict.failing.slice(0, 1) : r.verdict.failing;
            expect(got, JSON.stringify(r.verdict.checks.filter((c) => !c.ok))).toEqual(failing);
            expect(r.verdict.ok).toBe(ok);
        }, 90000);
    }
});

describe('the release workflow runs the canary, and cannot swallow its verdict', () => {
    const wf = fs.readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'auto-release.yml'), 'utf8');
    const step = wf.slice(wf.indexOf('- name: Canary - open the live release in a real browser'), wf.indexOf('- name: Fail loudly if the gates approved'));
    it('the step exists, after the live check and before the closing "fail loudly" steps', () => {
        expect(step.length).toBeGreaterThan(500);
        expect(wf.indexOf('Confirm the new version is LIVE')).toBeLessThan(wf.indexOf('Canary - open the live release'));
    });
    it('only runs for a release that really shipped (same conditions as the live check)', () => {
        expect(step).toMatch(/steps\.due\.outputs\.due == 'yes' && steps\.gates\.outputs\.ok == 'yes' && steps\.release\.outputs\.declined != 'yes' && steps\.release\.outputs\.moved != 'yes'/);
    });
    it('a confirmed failure turns the run red and files an issue; it does not use continue-on-error', () => {
        expect(step).not.toMatch(/continue-on-error/);
        expect(step).toMatch(/gh issue create[\s\S]*canary-failed/);
        expect(step).toMatch(/exit 1\s*$/);
    });
    it('looks twice before calling a failure a verdict, and treats "no browser" as a warning, not a pass', () => {
        expect(step).toMatch(/sleep 30/);
        expect(step).toMatch(/RC" -eq 2/);
        expect(step).toMatch(/NOT browser-checked/);
    });
    it('rolls back only when both the repository variable and the token are set', () => {
        expect(step).toMatch(/\[ "\$CANARY_ROLLBACK" = "true" \] && \[ -n "\$VERCEL_TOKEN" \]/);
    });
});

describe('the release signs what shipped, after the live check and the canary, and says what that proves', () => {
    const wf = fs.readFileSync(path.join(import.meta.dirname, '..', '.github', 'workflows', 'auto-release.yml'), 'utf8');
    it('has the two permissions signing needs, and signs after the canary', () => {
        expect(wf).toMatch(/permissions:[\s\S]{0,200}id-token: write[\s\S]{0,200}attestations: write/);
        expect(wf.indexOf('Canary - open the live release')).toBeLessThan(wf.indexOf('Sign the build provenance'));
        expect(wf).toMatch(/uses: actions\/attest-build-provenance@v2/);
    });
    it('packs a reproducible tree (git archive | gzip -n) and prints the command anyone can verify it with', () => {
        expect(wf).toMatch(/git archive --format=tar --prefix=wealthflow\/ "v\$V" \| gzip -n/);
        expect(wf).toMatch(/gh attestation verify wealthflow-v\$V\.tar\.gz --repo/);
    });
    it('never swallows a signing failure and does not claim to be a zero-knowledge proof', () => {
        const at = wf.indexOf('- name: Sign the build provenance');
        expect(wf.slice(at, at + 400)).not.toMatch(/continue-on-error/);
        expect(wf).toMatch(/not a zero-knowledge proof/);
    });
});
