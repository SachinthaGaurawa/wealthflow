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
 * PART 2 — the panel: real module, real DOM (linkedom), fake Firestore/fetch
 * ═══════════════════════════════════════════════════════════════════════════*/

function fakeDb({ exists = false, data = null, throwErr = null, hang = false } = {}) {
    return {
        collection: () => ({
            doc: () => ({
                get: () => {
                    if (hang) return new Promise(() => {}); // never settles
                    if (throwErr) return Promise.reject(new Error(throwErr));
                    return Promise.resolve({ exists, data: () => data });
                },
            }),
        }),
    };
}

function loadPanel({ db = null, fetchImpl = null } = {}) {
    const { document } = parseHTML('<!doctype html><html><body></body></html>');
    // `window` must BE the vm context, exactly as in a real browser (window
    // === globalThis there). The module writes `window._wfFetchT = ...` and
    // then calls the BARE identifier `_wfFetchT(...)` elsewhere — that only
    // resolves if writing through `window` and reading the bare name reach
    // the same object, which a separate plain `win` object does not give you.
    const context = {
        document, db, firebase: null, addEventListener() {},
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

describe('_getPending() distinguishes "confirmed empty" from "could not check"', () => {
    it('a genuinely empty queue is ok:true, data:null', async () => {
        const { api } = loadPanel({ db: fakeDb({ exists: false }) });
        const r = await api._getPending();
        expect(r).toEqual({ ok: true, data: null });
    });

    it('a real pending release comes back as ok:true with its data', async () => {
        const payload = { suggestedVersion: '7.70.0', basedOn: '7.69.24' };
        const { api } = loadPanel({ db: fakeDb({ exists: true, data: payload }) });
        const r = await api._getPending();
        expect(r.ok).toBe(true);
        expect(r.data).toEqual(payload);
    });

    it('no Firestore handle at all is ok:false, not a silent empty', async () => {
        const { api } = loadPanel({ db: null });
        const r = await api._getPending();
        expect(r.ok).toBe(false);
        expect(r.data).toBeNull();
        expect(r.reason).toBeTruthy();
    });

    it('a thrown Firestore error is ok:false with the real reason, not swallowed into "nothing pending"', async () => {
        const { api } = loadPanel({ db: fakeDb({ throwErr: 'permission-denied' }) });
        const r = await api._getPending();
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/permission-denied/);
    });

    it('THE BUG THIS PINS: a hung request that never resolves is ok:false after the timeout, never mistaken for empty', async () => {
        vi.useFakeTimers();
        try {
            const { api } = loadPanel({ db: fakeDb({ hang: true }) });
            const pending = api._getPending();
            await vi.advanceTimersByTimeAsync(4000);
            const r = await pending;
            expect(r.ok).toBe(false);
            expect(r.reason).toMatch(/Timed out/);
            expect(r.data).toBeNull();
        } finally { vi.useRealTimers(); }
    });
});

describe('_getDeployStatus() reads the new GET endpoint honestly', () => {
    it('reports configured:true when the server says so', async () => {
        const { api } = loadPanel({ fetchImpl: async () => ({ ok: true, json: async () => ({ deployHookConfigured: true }) }) });
        expect(await api._getDeployStatus()).toEqual({ known: true, configured: true });
    });

    it('reports configured:false when the server says so', async () => {
        const { api } = loadPanel({ fetchImpl: async () => ({ ok: true, json: async () => ({ deployHookConfigured: false }) }) });
        expect(await api._getDeployStatus()).toEqual({ known: true, configured: false });
    });

    it('degrades to known:false on a non-ok response, never guessing', async () => {
        const { api } = loadPanel({ fetchImpl: async () => ({ ok: false }) });
        expect(await api._getDeployStatus()).toEqual({ known: false });
    });

    it('degrades to known:false when the network call throws', async () => {
        const { api } = loadPanel({ fetchImpl: async () => { throw new Error('offline'); } });
        expect(await api._getDeployStatus()).toEqual({ known: false });
    });
});

describe('the panel shows the deploy-hook truth BEFORE the tap, not only after', () => {
    it('a configured hook renders a green "immediate rebuild" banner', async () => {
        const { api, document } = loadPanel({
            db: fakeDb({ exists: true, data: { suggestedVersion: '7.70.0' } }),
            fetchImpl: async () => ({ ok: true, json: async () => ({ deployHookConfigured: true }) }),
        });
        await api.showPanel();
        const html = document.getElementById('wfRaBody').innerHTML;
        expect(html).toMatch(/deploy hook is configured/i);
        expect(html).toMatch(/immediate rebuild/i);
    });

    it('THE CENTRAL FIX: an unconfigured hook renders a warning BEFORE the owner can tap Approve', async () => {
        const { api, document } = loadPanel({
            db: fakeDb({ exists: true, data: { suggestedVersion: '7.70.0' } }),
            fetchImpl: async () => ({ ok: true, json: async () => ({ deployHookConfigured: false }) }),
        });
        await api.showPanel();
        const html = document.getElementById('wfRaBody').innerHTML;
        expect(html).toMatch(/No deploy hook configured/);
        expect(html).toMatch(/only announces this version/);
        // The proposal itself must still render — a warning must not hide the review.
        expect(html).toContain('7.70.0');
    });

    it('an unknown deploy status (the check itself failed) says so plainly rather than picking a side', async () => {
        const { api, document } = loadPanel({
            db: fakeDb({ exists: true, data: { suggestedVersion: '7.70.0' } }),
            fetchImpl: async () => ({ ok: false }),
        });
        await api.showPanel();
        const html = document.getElementById('wfRaBody').innerHTML;
        expect(html).toMatch(/Could not check whether a deploy hook is configured/);
        expect(html).not.toMatch(/immediate rebuild/i);
        expect(html).not.toMatch(/only announces/i);
    });
});

describe('a failed pending-release check offers Retry instead of looking empty', () => {
    it('shows a distinct "could not check" state, not "No pending release"', async () => {
        const { api, document } = loadPanel({ db: fakeDb({ throwErr: 'network-error' }) });
        await api.showPanel();
        const html = document.getElementById('wfRaBody').innerHTML;
        expect(html).toMatch(/Could not check for a pending release/);
        expect(html).not.toMatch(/No pending release\./);
        expect(document.getElementById('wfRaRetry')).toBeTruthy();
    });

    it('tapping Retry re-runs the check and can recover to a real result', async () => {
        let attempt = 0;
        const db = {
            collection: () => ({
                doc: () => ({
                    get: () => {
                        attempt += 1;
                        if (attempt === 1) return Promise.reject(new Error('flaky'));
                        return Promise.resolve({ exists: true, data: () => ({ suggestedVersion: '7.71.0' }) });
                    },
                }),
            }),
        };
        const { api, document } = loadPanel({ db, fetchImpl: async () => ({ ok: false }) });
        await api.showPanel();
        expect(document.getElementById('wfRaBody').innerHTML).toMatch(/Could not check/);
        document.getElementById('wfRaRetry').onclick();
        await vi.waitFor(() => {
            expect(document.getElementById('wfRaBody').innerHTML).toContain('7.71.0');
        });
    });

    it('a genuinely empty queue still reads as "No pending release", not as an error', async () => {
        const { api, document } = loadPanel({ db: fakeDb({ exists: false }) });
        await api.showPanel();
        const html = document.getElementById('wfRaBody').innerHTML;
        expect(html).toMatch(/No pending release\./);
        expect(html).not.toMatch(/Could not check/);
    });
});
