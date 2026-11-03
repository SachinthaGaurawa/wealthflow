/* =============================================================================
 * test/release_approve_panel_test.js
 * -----------------------------------------------------------------------------
 * The owner asked, directly, for the "Settings → Autonomous Release" panel to
 * be strengthened. Reading it end to end (wealthflow-release-approve.js and
 * its server side, approve-release.js) turned up two real gaps, both of the
 * same shape this repository's own commit history keeps finding: a silent
 * state that reads exactly like a different, more comfortable one.
 *
 *   1. THE BUTTON SAYS "Approve & Deploy" UNCONDITIONALLY. Server-side,
 *      approving only ever WRITES an announcement to system/manifest; the
 *      actual code build fires only if DEPLOY_HOOK_URL happens to be set —
 *      approve-release.js's own comment already says so, but only in the
 *      response the owner sees AFTER tapping. That is the exact "announcement
 *      outrun the deploy" gap PR #196 spent a whole investigation on, except
 *      here it is not a race — it is the button's normal behaviour whenever
 *      the hook is unconfigured, disclosed one tap too late to change the
 *      owner's decision.
 *
 *   2. `_getPending()` COLLAPSED "CONFIRMED EMPTY" AND "COULD NOT CHECK" INTO
 *      THE SAME null. No Firestore handle, a 3.5s timeout, and a thrown
 *      error all returned exactly the value a genuinely-empty queue returns,
 *      so the panel said "No pending release" whether that was true or the
 *      read had simply failed — indistinguishable, and no reason offered to
 *      retry.
 *
 * Both are fixed by making the true state visible BEFORE it matters: a new
 * unauthenticated GET on /api/approve-release reports (only) whether a
 * deploy hook is configured, shown as a banner before the tap; and
 * _getPending() now returns {ok, data, reason} so a failed check renders as
 * "could not check", not as "nothing pending".
 * ===========================================================================*/

/* UPDATE 2026-11-03: the Settings card no longer asks the owner to approve anything. Releases are
 * published by auto-release.yml once the tests pass and the live app is healthy (see AUTONOMY.md
 * section 7), so the card and panel in wealthflow-release-approve.js now show what is live, what
 * that version changed and how a release happens. PART 1 still pins the server route (kept for a
 * manual override); PART 2 pins the new panel. The old pending-proposal/approve/reject panel is gone.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import approveReleaseHandler from '../approve-release.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PANEL_SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-release-approve.js'), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 1 — the server: GET /api/approve-release
 * ═══════════════════════════════════════════════════════════════════════════*/

function fakeRes() {
    const r = { code: 0, body: null };
    r.status = (c) => { r.code = c; return r; };
    r.json = (o) => { r.body = o; return r; };
    return r;
}

describe('GET /api/approve-release reports deploy-hook presence, nothing else', () => {
    const prevHook = process.env.DEPLOY_HOOK_URL;
    const prevSA = process.env.FIREBASE_SERVICE_ACCOUNT;
    afterEach(() => {
        if (prevHook === undefined) delete process.env.DEPLOY_HOOK_URL; else process.env.DEPLOY_HOOK_URL = prevHook;
        if (prevSA === undefined) delete process.env.FIREBASE_SERVICE_ACCOUNT; else process.env.FIREBASE_SERVICE_ACCOUNT = prevSA;
    });

    it('reports true when a deploy hook is configured', async () => {
        process.env.DEPLOY_HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/hook123';
        const res = fakeRes();
        await approveReleaseHandler({ method: 'GET' }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ ok: true, deployHookConfigured: true });
    });

    it('reports false when it is unset', async () => {
        delete process.env.DEPLOY_HOOK_URL;
        const res = fakeRes();
        await approveReleaseHandler({ method: 'GET' }, res);
        expect(res.body).toEqual({ ok: true, deployHookConfigured: false });
    });

    it('reports false for a blank/whitespace-only value, not a truthy string bug', async () => {
        process.env.DEPLOY_HOOK_URL = '   ';
        const res = fakeRes();
        await approveReleaseHandler({ method: 'GET' }, res);
        expect(res.body.deployHookConfigured).toBe(false);
    });

    it('never touches Firestore or firebase-admin — the check is unauthenticated and side-effect-free', async () => {
        // Deliberately break FIREBASE_SERVICE_ACCOUNT so any admin-SDK code path
        // would fail loudly; the GET path must never reach it at all.
        process.env.FIREBASE_SERVICE_ACCOUNT = '{ not json';
        process.env.DEPLOY_HOOK_URL = 'https://example.com/hook';
        const res = fakeRes();
        await approveReleaseHandler({ method: 'GET' }, res);
        expect(res.code).toBe(200);
        expect(res.body).toEqual({ ok: true, deployHookConfigured: true });
    });

    it('never leaks the hook URL itself, only whether it exists', async () => {
        process.env.DEPLOY_HOOK_URL = 'https://api.vercel.com/v1/integrations/deploy/SECRET_PATH_HERE';
        const res = fakeRes();
        await approveReleaseHandler({ method: 'GET' }, res);
        expect(JSON.stringify(res.body)).not.toContain('SECRET_PATH_HERE');
    });

    it('a POST (the real approve/reject action) is completely unaffected', () => {
        expect(fs.readFileSync(path.join(ROOT, 'approve-release.js'), 'utf8'))
            .toMatch(/if \(\(req && req\.method\) === 'GET'\) \{/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * PART 2 — the panel: real module, real DOM (linkedom), fake fetch
 * ═══════════════════════════════════════════════════════════════════════════*/

function loadPanel({ fetchImpl = null } = {}) {
    const { document } = parseHTML('<!doctype html><html><head></head><body></body></html>');
    // `window` must BE the vm context, exactly as in a real browser (window === globalThis there):
    // the module writes `window._wfFetchT = ...` and then calls the bare `_wfFetchT(...)`.
    const context = {
        document, firebase: null, addEventListener() {},
        fetch: fetchImpl || (async () => ({ ok: false })),
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (fn) => fn(),
        AbortController,
        Promise,
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(PANEL_SRC, context);
    return { api: context.wfReleaseApprove, document, window: context };
}

const jsonRes = (body) => ({ ok: true, status: 200, json: async () => body });
function site({ version = '7.69.36', sha = '4c6f0e97c5b5', notes = undefined, api = null, manifest = null } = {}) {
    return async (url) => {
        if (String(url).startsWith('/api/version')) return api || jsonRes({ sha, version, env: 'production' });
        if (String(url).startsWith('/version.json')) return manifest || jsonRes({ latest: version, notes: notes === undefined ? { [version]: { headline: "What's New", sections: [{ title: 'What changed for you', items: ['Cheque numbers show on every row (#458)', 'Card instalments get one tab per card (#489)'] }] } } : notes });
        return { ok: false, status: 404, json: async () => ({}) };
    };
}
const bodyOf = (document) => document.getElementById('wfRaBody').innerHTML;

describe('the panel shows what is live and what it changed', () => {
    it('reads version and build from /api/version and the notes of THAT version from /version.json', async () => {
        const { api, document } = loadPanel({ fetchImpl: site() });
        await api.showPanel();
        const html = bodyOf(document);
        expect(html).toContain('7.69.36');
        expect(html).toContain('4c6f0e9');                       // build = first 7 of the sha
        expect(html).toContain('Cheque numbers show on every row (#458)');
        expect(html).toContain('Card instalments get one tab per card (#489)');
        expect(html).toMatch(/How a release happens/);
    });

    it('accepts notes that are a plain string, and flattens every section', async () => {
        const one = loadPanel({ fetchImpl: site({ notes: { '7.69.36': 'One line of notes.' } }) });
        await one.api.showPanel();
        expect(bodyOf(one.document)).toContain('One line of notes.');
        const two = loadPanel({ fetchImpl: site({ notes: { '7.69.36': { sections: [{ title: 'A', items: ['first'] }, { title: 'B', items: ['second'] }] } } }) });
        await two.api.showPanel();
        expect(bodyOf(two.document)).toMatch(/first[\s\S]*second/);
    });

    it('shows at most 6 notes and says how many more there are', async () => {
        const items = Array.from({ length: 77 }, (_, i) => `Change number ${i + 1}`);
        const { api, document } = loadPanel({ fetchImpl: site({ notes: { '7.69.36': { sections: [{ title: 'x', items }] } } }) });
        await api.showPanel();
        const html = bodyOf(document);
        expect(html).toContain('Change number 6');
        expect(html).not.toContain('Change number 7<');
        expect(html).toMatch(/and 71 more, listed in the changelog/);
    });

    it('escapes anything it renders (notes are text, never markup)', async () => {
        const { api, document } = loadPanel({ fetchImpl: site({ notes: { '7.69.36': 'Fixed <img src=x onerror=alert(1)> & more' } }) });
        await api.showPanel();
        const html = bodyOf(document);
        expect(html).not.toContain('<img');
        expect(html).toContain('&lt;img');
        expect(html).toContain('&amp; more');
    });

    it('says plainly when a version has no notes, instead of showing another version\'s', async () => {
        const { api, document } = loadPanel({ fetchImpl: site({ notes: { '7.69.35': 'Old release.' } }) });
        await api.showPanel();
        const html = bodyOf(document);
        expect(html).toMatch(/No notes were published for this version/);
        expect(html).not.toContain('Old release.');
    });

    it('a notes failure does not hide the live version', async () => {
        const base = site();
        const { api, document } = loadPanel({ fetchImpl: async (u) => (String(u).startsWith('/version.json') ? { ok: false, status: 500 } : base(u)) });
        await api.showPanel();
        const html = bodyOf(document);
        expect(html).toContain('7.69.36');
        expect(html).toMatch(/notes for this version could not be loaded/);
    });
});

describe('a failed read is shown as "could not read", with a way to retry', () => {
    it('an error answer or a network failure is never rendered as a healthy or empty state', async () => {
        for (const impl of [async () => ({ ok: false, status: 503 }), async () => { throw new Error('offline'); }]) {
            const { api, document } = loadPanel({ fetchImpl: impl });
            await api.showPanel();
            const html = bodyOf(document);
            expect(html).toMatch(/Could not read the live version/);
            expect(html).toMatch(/does not mean a release failed/);
            expect(html).not.toMatch(/Live now/);
            expect(document.getElementById('wfRaRetry')).toBeTruthy();
        }
    });

    it('an answer with no version is a failure, not "version undefined"', async () => {
        const { api, document } = loadPanel({ fetchImpl: site({ api: jsonRes({ sha: 'abc' }) }) });
        await api.showPanel();
        expect(bodyOf(document)).toMatch(/Could not read the live version/);
        expect(bodyOf(document)).not.toMatch(/undefined/);
    });

    it('Try Again re-runs the read and recovers', async () => {
        let n = 0;
        const ok = site();
        const { api, document } = loadPanel({ fetchImpl: async (u) => { if (String(u).startsWith('/api/version') && ++n === 1) throw new Error('flaky'); return ok(u); } });
        await api.showPanel();
        expect(bodyOf(document)).toMatch(/Could not read/);
        document.getElementById('wfRaRetry').onclick();
        await vi.waitFor(() => { expect(bodyOf(document)).toContain('7.69.36'); });
    });

    it('a request that never answers ends as a failure after the deadline', async () => {
        vi.useFakeTimers();
        try {
            const { api, document } = loadPanel({ fetchImpl: (u, init) => new Promise((_, rej) => { init.signal.addEventListener('abort', () => rej(new Error('aborted'))); }) });
            const p = api.showPanel();
            await vi.advanceTimersByTimeAsync(7000);
            await p;
            expect(bodyOf(document)).toMatch(/Could not read the live version/);
        } finally { vi.useRealTimers(); }
    });
});

describe('the panel no longer asks for an approval that decides nothing', () => {
    it('has no Approve or Reject control, no note box, and no call to the approval route', async () => {
        const calls = [];
        const base = site();
        const { api, document } = loadPanel({ fetchImpl: async (u, i) => { calls.push(String(u)); return base(u, i); } });
        await api.showPanel();
        for (const id of ['wfRaApprove', 'wfRaReject', 'wfRaNote']) expect(document.getElementById(id)).toBeNull();
        expect(PANEL_SRC).not.toMatch(/approve-release|idToken|Approve and publish|pendingRelease/);
        expect(calls.every((u) => u.startsWith('/api/version') || u.startsWith('/version.json'))).toBe(true);
    });

    it('says the opposite of the old card: automatic, nothing waits for the owner', async () => {
        const { api, document } = loadPanel({ fetchImpl: site() });
        await api.showPanel();
        const all = document.body.innerHTML;
        expect(all).toMatch(/Published automatically/);
        expect(all).toMatch(/No approval from you is needed/);
        expect(all).not.toMatch(/only when you approve|Only the owner can approve/i);
    });
});

describe('opening, closing, and being a good dialog', () => {
    it('opens once, has dialog semantics, closes with its button, and can be reopened', async () => {
        const { api, document } = loadPanel({ fetchImpl: site() });
        await api.showPanel(); await api.showPanel();
        expect(document.querySelectorAll('#wfRaOverlay').length).toBe(1);
        const ov = document.getElementById('wfRaOverlay');
        expect(ov.getAttribute('role')).toBe('dialog');
        expect(ov.getAttribute('aria-modal')).toBe('true');
        expect(document.getElementById('wfRaTitle').textContent).toBe('Software release');
        document.getElementById('wfRaClose').onclick();
        await new Promise((r) => setTimeout(r, 260));
        expect(document.getElementById('wfRaOverlay')).toBeNull();
        await api.showPanel();
        expect(document.getElementById('wfRaOverlay')).toBeTruthy();
    });

    it('shows a loading skeleton while it reads, not a blank sheet', async () => {
        let release;
        const gate = new Promise((r) => { release = r; });
        const base = site();
        const { api, document } = loadPanel({ fetchImpl: async (u, i) => { await gate; return base(u, i); } });
        const p = api.showPanel();
        await Promise.resolve();
        expect(bodyOf(document)).toMatch(/wfrl-skel/);
        release(); await p;
        expect(bodyOf(document)).not.toMatch(/wfrl-skel/);
    });
});

describe('the Settings card', () => {
    function settings({ active = true, withIntel = true } = {}) {
        const loaded = loadPanel({ fetchImpl: site() });
        const { document } = loaded;
        document.body.innerHTML = `<div id="page-settings" class="${active ? 'active' : ''}"><div class="settings-section" id="s1">${withIntel ? '<div id="wfIntelPanel"></div>' : ''}</div><div class="settings-section" id="s2"></div></div>`;
        return loaded;
    }

    it('reads "Releases publish automatically" with a Details button, and not the old approval wording', () => {
        const { api, document } = settings();
        expect(api._inject()).toBe(true);
        const card = document.getElementById('wfReleasePanel');
        expect(card.textContent).toMatch(/Software release/);
        expect(card.textContent).toMatch(/Releases publish automatically/);
        expect(card.textContent).toMatch(/No approval from you is needed/);
        expect(card.textContent).not.toMatch(/Review and approve|Only the owner can approve|approve it to publish/i);
        expect(document.getElementById('wfReleaseOpenBtn').textContent).toBe('Details');
    });

    it('sits right after the AI card, once, and only while Settings is the active page', () => {
        const off = settings({ active: false });
        expect(off.api._inject()).toBe(false);
        expect(off.document.getElementById('wfReleasePanel')).toBeNull();
        const { api, document } = settings();
        api._inject(); api._inject();
        expect(document.querySelectorAll('#wfReleasePanel').length).toBe(1);
        expect(document.getElementById('s1').nextElementSibling.id).toBe('wfReleasePanel');
    });

    it('the Details button opens the panel', async () => {
        const { api, document } = settings();
        api._inject();
        document.getElementById('wfReleaseOpenBtn').onclick();
        await vi.waitFor(() => { expect(document.getElementById('wfRaBody').innerHTML).toContain('7.69.36'); });
    });
});
