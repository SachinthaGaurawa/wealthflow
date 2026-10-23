// =============================================================================
// An upload that fails must be SEEN (wealthflow-sync-health.js + the page's wiring).
// -----------------------------------------------------------------------------
// Reported 2026-10-23: "Settle in full" and "Confirm" on the phone sent no text, the same two taps on the laptop did. A text goes out only after the
// change is uploaded, and a failed upload was silent: the error sat in a variable nobody read, the badge went back to "Online", and the retries hung off
// an edit, a reconnect or a successful read. These tests pin the pieces that make it audible: the notice, the retry that needs nothing else to keep going,
// the connection check that names the first failing step, and the page wiring that uses them.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import H, { SYNC, codeOf, explainPushError, retryDelayMs, bannerView, createTracker, createRetryLoop, inspectPayload, runChecks, verdict, reportText } from '../wealthflow-sync-health.js';

const T0 = 1_700_000_000_000;

describe('what a failed upload means, in words', () => {
    it('reads the code with or without the firestore/ prefix', () => {
        expect(codeOf({ code: 'firestore/unavailable' })).toBe('unavailable');
        expect(codeOf({ code: 'permission-denied' })).toBe('permission-denied');
        expect(codeOf(null)).toBe('');
        expect(codeOf('aborted')).toBe('aborted');
    });

    it('a sign-in the account no longer accepts is named as one', () => {
        for (const code of ['permission-denied', 'unauthenticated']) {
            const e = explainPushError({ code, message: 'Missing or insufficient permissions.' });
            expect(e.kind).toBe('signin');
            expect(e.text).toMatch(/sign out and sign in again/i);
        }
    });

    it('a network that cannot reach the cloud keeps being retried and the words say so', () => {
        for (const code of ['unavailable', 'deadline-exceeded', 'cancelled']) {
            const e = explainPushError({ code });
            expect(e.kind).toBe('network');
            expect(e.retry).toBe(true);
            expect(e.text).toMatch(/keeps trying/);
        }
        expect(explainPushError({ message: 'Failed to fetch' }).kind).toBe('network');
    });

    it('data the cloud cannot store is the one case where trying the same thing again cannot help', () => {
        const nested = explainPushError({ code: 'invalid-argument', message: 'Nested arrays are not supported' });
        expect(nested.kind).toBe('data');
        expect(nested.retry).toBe(false);
        expect(explainPushError({ message: 'Document exceeds the maximum size' }).kind).toBe('data');
        expect(nested.text).toMatch(/Check Connection/);
    });

    it('contention, a usage limit and anything else each have their own plain sentence', () => {
        expect(explainPushError({ code: 'aborted', message: 'Transaction failed all retries.' }).kind).toBe('busy');
        expect(explainPushError({ code: 'resource-exhausted' }).kind).toBe('quota');
        const other = explainPushError({ code: 'something-new' });
        expect(other.kind).toBe('other');
        expect(other.text).not.toMatch(/unknown/i);
    });

    it('the pause grows with each failure and stops growing at the last step', () => {
        expect(retryDelayMs(1)).toBe(5000);
        expect(retryDelayMs(2)).toBe(15000);
        expect(retryDelayMs(3)).toBe(45000);
        expect(retryDelayMs(4)).toBe(120000);
        expect(retryDelayMs(40)).toBe(120000);
        expect(retryDelayMs(0)).toBe(5000);
    });
});

describe('the notice', () => {
    const ctx = { online: true, signedIn: true, holding: false, decoy: false };

    it('shows nothing while the account has everything', () => {
        const tr = createTracker(() => T0);
        expect(tr.view(ctx, T0 + 600000).show).toBe(false);
        tr.noteDirty(T0); tr.noteClean(T0 + 1000);
        expect(tr.view(ctx, T0 + 600000).show).toBe(false);
    });

    it('stays quiet while a normal upload is still on its way, then speaks when a change has waited too long', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0);
        expect(tr.view(ctx, T0 + 5000).show).toBe(false);
        const v = tr.view(ctx, T0 + SYNC.SHOW_AFTER_MS);
        expect(v.show).toBe(true);
        expect(v.title).toBe('Not saved to your account yet');
        expect(v.reason).toMatch(/longer than usual/);
    });

    it('a failed upload is shown soon after, with the reason and the code', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0);
        tr.noteFailure({ code: 'firestore/unavailable', message: 'The service is currently unavailable.' }, T0 + 2000);
        expect(tr.view(ctx, T0 + 4000).show).toBe(false);          // one retry gets its chance first
        const v = tr.view(ctx, T0 + SYNC.SHOW_AFTER_FAIL_MS);
        expect(v.show).toBe(true);
        expect(v.kind).toBe('network');
        expect(v.code).toBe('unavailable');
        expect(v.reason).toMatch(/could not reach your cloud account/);
        expect(v.note).toMatch(/text messages to your debtors and tenants/);
    });

    it('offline reads as waiting, not as a fault, and signed out says so', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0);
        const off = tr.view({ ...ctx, online: false }, T0 + 30000);
        expect(off.tone).toBe('wait');
        expect(off.title).toBe('Waiting to save to your account');
        expect(off.reason).toMatch(/no internet/);
        expect(tr.view({ ...ctx, signedIn: false }, T0 + 30000).reason).toMatch(/signed out/);
    });

    it('is never shown in the duress (decoy) mode or while a restore holds the sync', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0); tr.noteFailure({ code: 'unavailable' }, T0);
        expect(tr.view({ ...ctx, decoy: true }, T0 + 60000).show).toBe(false);
        expect(tr.view({ ...ctx, holding: true }, T0 + 60000).show).toBe(false);
    });

    it('a successful upload clears the failures and the notice with them', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0); tr.noteFailure({ code: 'unavailable' }, T0 + 1000);
        expect(tr.state.failures).toBe(1);
        tr.noteClean(T0 + 9000);
        expect(tr.state).toMatchObject({ dirtySince: 0, failures: 0, code: '' });
        expect(tr.view(ctx, T0 + 60000).show).toBe(false);
    });

    it('the wait is counted from the FIRST unsaved change, not from the latest edit', () => {
        const tr = createTracker(() => T0);
        tr.noteDirty(T0); tr.noteDirty(T0 + 15000); tr.noteDirty(T0 + 19000);
        expect(tr.view(ctx, T0 + 20000).show).toBe(true);
    });
});

describe('the retry that needs nothing else to keep going', () => {
    function rig({ results, pendingFlags }) {
        const timers = []; const calls = [];
        let i = 0;
        const loop = createRetryLoop({
            attempt: async () => { calls.push('attempt'); const r = results[Math.min(i, results.length - 1)]; i += 1; if (r instanceof Error) throw r; return r; },
            pending: () => (typeof pendingFlags === 'function' ? pendingFlags() : true),
            setTimer: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return t; },
            clearTimer: (t) => { t.live = false; },
        });
        const fire = async () => { const t = timers.filter((x) => x.live).pop(); if (!t) return false; t.live = false; t.fn(); await Promise.resolve(); await Promise.resolve(); await new Promise((r) => setImmediate(r)); return true; };
        return { loop, timers, calls, fire };
    }

    it('after a failure it schedules the next try by itself, with a growing pause', async () => {
        const r = rig({ results: [false, false, false, false, true] });
        await r.loop.run();
        expect(r.timers.map((t) => t.ms)).toEqual([5000]);
        await r.fire();
        expect(r.timers.map((t) => t.ms)).toEqual([5000, 15000]);
        await r.fire();
        await r.fire();
        expect(r.timers.map((t) => t.ms)).toEqual([5000, 15000, 45000, 120000]);
        await r.fire();                                   // the fifth attempt succeeds
        expect(r.calls.length).toBe(5);
        expect(r.loop.failures).toBe(0);
        expect(r.loop.scheduled).toBe(false);
    });

    it('a rejected attempt counts as a failure instead of ending the loop', async () => {
        const r = rig({ results: [new Error('boom'), true] });
        await r.loop.run();
        expect(r.loop.scheduled).toBe(true);
        await r.fire();
        expect(r.loop.scheduled).toBe(false);
    });

    it('stops when nothing is waiting any more', async () => {
        let waiting = true;
        const r = rig({ results: [false], pendingFlags: () => waiting });
        await r.loop.run();
        expect(r.loop.scheduled).toBe(true);
        waiting = false;                                  // saved by some other path in the meantime
        await r.fire();
        expect(r.calls.length).toBe(1);
        expect(r.loop.scheduled).toBe(false);
    });

    it('runs one attempt at a time', async () => {
        let release; const gate = new Promise((res) => { release = res; });
        let n = 0;
        const loop = createRetryLoop({ attempt: () => { n += 1; return gate; }, pending: () => true, setTimer: () => 1, clearTimer: () => {} });
        const first = loop.run();
        const second = await loop.run();
        expect(second).toBe(false);
        release(true);
        await first;
        expect(n).toBe(1);
    });

    it('a sooner request replaces a pause that is still waiting, a later one does not', () => {
        const r = rig({ results: [true] });
        r.loop.schedule(60000);
        r.loop.schedule();
        expect(r.timers.length).toBe(1);
        r.loop.schedule(0);
        expect(r.timers.length).toBe(2);
        expect(r.timers[0].live).toBe(false);
        expect(r.timers[1].ms).toBe(0);
    });
});

describe('what would be uploaded, looked at as the cloud will look at it', () => {
    it('a clean document passes and reports its size', () => {
        const r = inspectPayload({ expenses: [{ id: 'a', amount: 5 }], settings: { theme: 'dark' } });
        expect(r.problems).toEqual([]);
        expect(r.bytes).toBeGreaterThan(20);
        expect(r.biggest[0].key).toBe('expenses');
    });

    it('a list inside a list is named by its path', () => {
        const r = inspectPayload({ debtors: [{ id: 'd', events: [[1, 2]] }] });
        expect(r.problems).toEqual([{ path: 'debtors[0].events[0]', why: 'a list inside a list' }]);
    });

    it('reserved and empty field names are named', () => {
        const r = inspectPayload({ a: { '__x__': 1, '': 2 } });
        expect(r.problems.map((p) => p.why).sort()).toEqual(['a reserved field name', 'an empty field name']);
    });

    it('more than one document can hold is the first thing said, and near the limit is flagged without being a problem', () => {
        const big = inspectPayload({ blob: 'x'.repeat(SYNC.DOC_LIMIT_BYTES + 10) });
        expect(big.problems[0].why).toMatch(/more than one account document can hold/);
        const near = inspectPayload({ blob: 'x'.repeat(SYNC.DOC_WARN_BYTES + 10) });
        expect(near.nearLimit).toBe(true);
        expect(near.problems).toEqual([]);
    });

    it('the three largest fields are reported, largest first', () => {
        const r = inspectPayload({ a: 'x'.repeat(10), b: 'x'.repeat(1000), c: 'x'.repeat(100), d: 'x'.repeat(500) });
        expect(r.biggest.map((b) => b.key)).toEqual(['b', 'd', 'c']);
    });
});

describe('the connection check names the first step that fails', () => {
    const ok = (id, detail = 'fine') => ({ id, label: id.toUpperCase(), run: async () => detail });
    const bad = (id, err) => ({ id, label: id.toUpperCase(), run: async () => { throw err; } });

    it('runs every step in order, even after one fails, and times each on its own', async () => {
        const seen = [];
        const rows = await runChecks([ok('server'), bad('google', Object.assign(new Error('blocked'), { code: 'unavailable' })), ok('signin')], { onStep: (r) => seen.push(r.id) });
        expect(rows.map((r) => [r.id, r.ok])).toEqual([['server', true], ['google', false], ['signin', true]]);
        expect(seen).toEqual(['server', 'google', 'signin']);
        expect(rows[1].detail).toBe('unavailable: blocked');
    });

    it('a step that never answers fails with a plain reason instead of hanging the check', async () => {
        const rows = await runChecks([{ id: 'read', label: 'Reading your account', run: () => new Promise(() => {}) }], { timeoutMs: 20 });
        expect(rows[0].ok).toBe(false);
        expect(rows[0].detail).toMatch(/did not answer/);
    });

    it('a step can fail without throwing', async () => {
        const rows = await runChecks([{ id: 'data', label: 'Data', run: async () => ({ ok: false, detail: 'a list inside a list' }) }]);
        expect(rows[0]).toMatchObject({ ok: false, detail: 'a list inside a list' });
    });

    it('the verdict is the first failing step in plain words, or the all-clear', () => {
        const all = verdict([{ id: 'server', label: 'S', ok: true, detail: 'x' }]);
        expect(all.ok).toBe(true);
        const v = verdict([{ id: 'server', label: 'S', ok: true, detail: 'x' }, { id: 'google', label: 'Google cloud database', ok: false, detail: 'unavailable: blocked' }, { id: 'write', label: 'W', ok: false, detail: 'y' }]);
        expect(v.ok).toBe(false);
        expect(v.failed).toBe('google');
        expect(v.text).toMatch(/cannot reach Google's cloud database/);
        expect(v.text).toMatch(/Google cloud database: unavailable: blocked/);
    });

    it('the copied report carries the steps and the size, and nothing that names the account', () => {
        const rows = [{ id: 'server', label: 'WealthFlow server', ok: true, detail: 'reachable', ms: 40 }, { id: 'write', label: 'Saving to your account', ok: false, detail: 'permission-denied: Missing or insufficient permissions.', ms: 120 }];
        const text = reportText(rows, { build: '7.69.35', online: true, when: new Date('2026-10-23T10:00:00Z'), payload: inspectPayload({ expenses: [{ id: 'a' }] }) });
        expect(text).toContain('Build: 7.69.35');
        expect(text).toContain('OK     WealthFlow server (40 ms) - reachable');
        expect(text).toContain('FAILED Saving to your account (120 ms)');
        expect(text).toContain('Data size:');
        expect(text).not.toMatch(/uid|token|@/i);
    });
});

describe('the module registers itself for the page', () => {
    it('the default export is the same object the page reads from window.WFSyncHealth', () => {
        expect(typeof H.createTracker).toBe('function');
        expect(H.SYNC).toBe(SYNC);
    });
});

/* ── the page's wiring ───────────────────────────────────────────────────── */
const ROOT = path.resolve(__dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const fnBody = (name) => {
    const a = HTML.search(new RegExp(`(?:async )?function ${name}\\(`));
    expect(a, `${name} is gone from index.html`).toBeGreaterThan(-1);
    const next = HTML.slice(a + 10).search(/\n {8}(?:async )?function |\n {8}\/\* [A-Z]/);
    return HTML.slice(a, next < 0 ? a + 6000 : a + 10 + next);
};

describe('the page: a failed upload is counted, explained and retried', () => {
    const sync = fnBody('syncToCloud');

    it('loads the module', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-sync-health.js"></script>');
    });

    it('syncToCloud reports success and failure through window hooks and stays self-contained', () => {
        expect(sync).toMatch(/window\._wfSyncOk/);
        expect(sync).toMatch(/window\._wfSyncFailed\(err\)/);
        expect(sync).not.toMatch(/_wfTracker|_wfSyncRetry|WFSyncHealth/);
    });

    it('a failure feeds the tracker and schedules the retry loop unless the data itself is the problem', () => {
        const hook = HTML.slice(HTML.indexOf('window._wfSyncFailed = function'), HTML.indexOf('window._wfSyncOk = function'));
        expect(hook).toMatch(/tr\.noteFailure\(err\)/);
        expect(hook).toMatch(/explainPushError\(err\)\.retry/);
        expect(hook).toMatch(/loop\.schedule\(H\.retryDelayMs\(tr\.state\.failures\)\)/);
    });

    it('a retry after a rejected sign-in renews the token first', () => {
        expect(HTML).toMatch(/unauthenticated\|permission-denied[\s\S]{0,200}getIdToken\(true\)/);
    });

    it('a watchdog starts a retry when a change has waited without any upload running', () => {
        const tick = fnBody('_wfSyncTick');
        expect(tick).toMatch(/isDirty && loop && !window\._wfSyncRun && !loop\.scheduled && Date\.now\(\) - tr\.state\.dirtySince >= 15000/);
        expect(HTML).toMatch(/setInterval\(_wfSyncTick, 4000\)/);
    });

    it('leaving the page flushes the change instead of waiting out the debounce, and coming back retries at once', () => {
        expect(HTML).toMatch(/window\.addEventListener\('pagehide', leave\)/);
        expect(HTML).toMatch(/visibilityState === 'hidden'\) leave\(\)/);
    });

    it('the notice has Try Again and Check Connection, and says texts follow the save', () => {
        const draw = fnBody('_wfRenderSyncBanner');
        expect(draw).toContain('_wfSyncTryAgain(this)');
        expect(draw).toContain('_wfOpenSyncCheck()');
        expect(HTML).toMatch(/#syncBanner\.show \{ display: block; \}/);
    });

    it('the connection check tests the server, Google, the sign-in, a read, a write and the data, and the write goes to a path the rules already allow', () => {
        const checks = fnBody('_wfSyncChecks');
        for (const id of ['server', 'google', 'signin', 'read', 'write', 'data']) expect(checks).toContain(`id: '${id}'`);
        expect(checks).toContain("collection('syncProbe').doc('ping')");
        const rules = fs.readFileSync(path.join(ROOT, 'firestore.rules'), 'utf8');
        expect(rules).toMatch(/match \/users\/\{uid\}\/\{collection\}\/\{document=\*\*\}/);
        expect(rules).not.toMatch(/'syncProbe'/);                       // not in the server-owned list, so the owner may write it
    });

    it('Refresh and Sync now say when the account does NOT have the changes', () => {
        const pull = fnBody('forceSyncFromCloud');
        expect(pull).toMatch(/_saved = await _wfUploadNow\(\)/);
        expect(pull).toMatch(/not saved to your account yet/);
        expect(HTML).toMatch(/Sync now<\/div>[\s\S]{0,200}onclick="refreshApp\(this\)"/);
        expect(HTML).toMatch(/onclick="_wfOpenSyncCheck\(\)">Check Connection<\/button>/);
    });

    it('the debtor actions that send a text wait for the upload and say which happened', () => {
        const act = fnBody('_debtorAction');
        expect(act).toMatch(/_wfUploadNow\(\)\.then\(\(ok\) => notify\(upload\(ok\)/);
        expect(act).toMatch(/not saved to your account yet\. The text goes out once it is saved/);
        const settle = fnBody('_settleDebtor');
        expect(settle).toMatch(/countedNow && smsOn[\s\S]{0,120}_wfUploadNow\(\)/);
    });

    it('_wfUploadNow cancels the debounce, waits for a push in flight and reports whether the account has everything', () => {
        const up = fnBody('_wfUploadNow');
        expect(up).toMatch(/clearTimeout\(syncDebounceTimer\)/);
        expect(up).toMatch(/await window\._wfSyncRun/);
        expect(up).toMatch(/return !isDirty/);
    });
    it('the live listener has an error callback that starts it again, and is wired through _wfListen', () => {
        const listen = fnBody('_wfListen');
        expect(listen).toMatch(/userDocRef\.onSnapshot\(\(snap\) => \{[\s\S]*\}, \(err\) => \{/);
        expect(listen).toMatch(/_wfLive\.timer = setTimeout\(_wfListen, pause\)/);
        expect(listen).toMatch(/\[2000, 5000, 15000, 60000\]/);
        expect(HTML).toMatch(/window\._wfSnapHandler = \(snap\) => \{/);
        expect(HTML).not.toMatch(/userDocRef\.onSnapshot\(\(snap\) => \{\s*\n\s*if \(!isInitialised\)/);
        expect(HTML).toMatch(/\n\s*_wfListen\(\);\s*\n\s*\} catch \(listenerErr\)/);
    });

    it('a read that finds what the listener never delivered starts the listener again', () => {
        const rec = fnBody('_wfReconcileWithCloud');
        expect(rec).toMatch(/_wfLastReconcile\.changed && why !== 'start'[\s\S]{0,120}_wfLive\.missed\+\+; _wfListen\(\)/);
    });

    it('every device reads the account every 20 seconds while visible, and again on focus, resume and reconnect', () => {
        const loop = fnBody('_wfStartReconcileLoop');
        expect(loop).toMatch(/_wfReconcileWithCloud\('interval'\); \}, 20000\)/);
        expect(loop).toMatch(/addEventListener\('focus'/);
        expect(loop).toMatch(/addEventListener\('visibilitychange'/);
        expect(loop).toMatch(/addEventListener\('online'/);
    });

    it('Check Connection includes the live listener step', () => {
        expect(fnBody('_wfSyncChecks')).toContain("id: 'live'");
    });

    it('a revoked-session listener that ends is started again', () => {
        const w = fnBody('_startSessionRevokeWatcher');
        expect(w).toMatch(/_sessionRevokeUnsub = null;\s*\n\s*setTimeout\(\(\) => \{ try \{ _startSessionRevokeWatcher\(\)/);
    });
});

// =============================================================================
// The connection mode. Reported 2026-10-23: with iCloud Private Relay on, "Reading your account did not answer in 12 seconds" and uploads failed with
// deadline-exceeded while sign-in and the WealthFlow server answered. Firestore's default stream is what such networks hold up; the steady mode (long polling)
// is plain request-and-answer. The rule lives twice (the page needs it before the module has loaded); these tests pin the two to agree.
// =============================================================================
describe('the connection mode', () => {
    const SAFARI_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
    const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/126.0.0.0 Mobile/15E148 Safari/604.1';
    const IPAD_DESKTOP_SITE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15';
    const CHROME_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
    const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';
    const FIREFOX = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0';
    const EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0';

    it('Safari and every iPhone / iPad browser are steady; the others are fast', () => {
        for (const ua of [SAFARI_MAC, IPHONE_SAFARI, IPHONE_CHROME]) expect(H.chooseTransport({ ua })).toEqual({ steady: true, why: 'safari' });
        expect(H.chooseTransport({ ua: IPAD_DESKTOP_SITE, maxTouchPoints: 5 })).toEqual({ steady: true, why: 'safari' });
        for (const ua of [CHROME_MAC, CHROME_ANDROID, FIREFOX, EDGE, '']) expect(H.chooseTransport({ ua })).toEqual({ steady: false, why: 'default' });
    });
    it('a saved choice beats the browser, both ways, and nonsense is ignored', () => {
        expect(H.chooseTransport({ ua: CHROME_MAC, stored: 'steady' })).toEqual({ steady: true, why: 'chosen' });
        expect(H.chooseTransport({ ua: SAFARI_MAC, stored: 'fast' })).toEqual({ steady: false, why: 'chosen' });
        expect(H.chooseTransport({ ua: SAFARI_MAC, stored: 'banana' })).toEqual({ steady: true, why: 'safari' });
    });
    it('the settings given to Firestore switch long polling on and auto-detect off (the SDK refuses both together)', () => {
        expect(H.STEADY_SETTINGS).toEqual({ experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false, merge: true });
        expect(Object.isFrozen(H.STEADY_SETTINGS)).toBe(true);
    });
    it('the page decides the same way as the module, from the same inputs, and gives Firestore exactly those settings before it is first used', () => {
        const html = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
        const src = html.slice(html.indexOf('function _wfChooseTransport('));
        const fn = new Function('return ' + src.slice(0, src.indexOf('\n        }\n') + 10).replace(/^function _wfChooseTransport/, 'function'))();
        const key = /const _WF_FS_KEY = '([^']+)'/.exec(html)[1];
        expect(key).toBe(H.TRANSPORT_KEY);
        for (const ua of [SAFARI_MAC, IPHONE_SAFARI, IPHONE_CHROME, IPAD_DESKTOP_SITE, CHROME_MAC, CHROME_ANDROID, FIREFOX, EDGE, ''])
            for (const mtp of [0, 5]) for (const stored of ['', 'steady', 'fast', 'x'])
                expect(fn(ua, mtp, stored), `${ua} ${mtp} ${stored}`).toEqual(H.chooseTransport({ ua, maxTouchPoints: mtp, stored }));
        const init = html.slice(html.indexOf('db = firebase.firestore();'), html.indexOf('db.enablePersistence('));
        expect(init).toContain('db.settings({ experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false, merge: true })');
        expect(init.indexOf('db.settings(')).toBeGreaterThan(-1);   // inside the slice that ends at enablePersistence, the first use
    });
    it('says which mode in words, for Check Connection and the copied report', () => {
        expect(H.transportText({ steady: true, why: 'safari' })).toMatch(/^steady .*Safari/);
        expect(H.transportText({ steady: true, why: 'chosen' })).toBe('steady (chosen on this device)');
        expect(H.transportText({ steady: false, why: 'default' })).toBe('fast');
        const text = reportText([{ id: 'server', label: 'WealthFlow server', ok: true, ms: 5, detail: 'reachable' }], { transport: { steady: true, why: 'safari' }, when: new Date('2026-10-23T10:00:00Z') });
        expect(text).toMatch(/Connection mode: steady/);
    });
    it('no longer tells the person to switch their private relay off: the app works with it', () => {
        const all = [explainPushError({ code: 'deadline-exceeded' }).text, verdict([{ id: 'server', label: 'x', ok: false, detail: '' }]).text, verdict([{ id: 'google', label: 'x', ok: false, detail: '' }]).text, verdict([{ id: 'read', label: 'x', ok: false, detail: '' }]).text].join('\n');
        expect(all).not.toMatch(/switch off|private relay|VPN/i);
        expect(explainPushError({ code: 'deadline-exceeded' }).text).toMatch(/Check Connection finds which step is stuck and can repair it/);
    });
});

describe('a save that never answers: the verdict names the stuck part, and repair is offered only when it can help', () => {
    const ok = (id) => ({ id, label: id, ok: true, ms: 5, detail: 'fine' });
    const bad = (id, detail = 'did not answer in 12 seconds') => ({ id, label: id, ok: false, ms: 12000, detail });
    const front = [ok('server'), ok('google'), ok('signin'), ok('read')];

    it('a save the account refused still says to sign in again, and offers no repair', () => {
        const v = verdict([...front, bad('write', 'permission-denied')]);
        expect(v.text).toMatch(/refused the save/);
        expect(v.repair).toBeFalsy();
    });
    it('a save that only times out is NOT called a refusal (the old text told people to sign out for a stuck queue)', () => {
        const v = verdict([...front, bad('write')]);
        expect(v.text).not.toMatch(/sign out and sign in|not allowed/i);
        expect(v.repair).toBe(true);
    });
    it('a direct save that works while the SDK save does not points at the browser\'s own queue', () => {
        const v = verdict([...front, bad('write'), ok('direct')]);
        expect(v.text).toMatch(/saving queue inside this browser/);
        expect(v.repair).toBe(true);
    });
    it('a direct save that fails too points at the network and offers no repair', () => {
        const v = verdict([...front, bad('write'), bad('direct')]);
        expect(v.text).toMatch(/Something on the network/);
        expect(v.repair).toBeFalsy();
    });
    it('browser storage that does not answer is the first thing named, and repair is offered', () => {
        const v = verdict([...front, bad('write'), ok('direct'), bad('storage')]);
        expect(v.text).toMatch(/browser's own storage/);
        expect(v.repair).toBe(true);
        expect(verdict([...front, ok('write'), bad('storage')]).repair).toBe(true);
    });
    it('a stuck queue seen alone also offers repair', () => {
        const v = verdict([...front, ok('write'), bad('queue')]);
        expect(v.failed).toBe('queue');
        expect(v.repair).toBe(true);
    });
    it('the banner offers repair only after repeated network failures', () => {
        const st = (failures) => ({ dirtySince: T0, failures, code: 'deadline-exceeded', message: '' });
        const v2 = bannerView(st(2), { online: true, signedIn: true }, T0 + 120_000);
        const v4 = bannerView(st(4), { online: true, signedIn: true }, T0 + 120_000);
        expect(!!v2.repairable).toBe(false);
        expect(!!v4.repairable).toBe(true);
    });
});

describe('the offline cache choice and the automatic repair', () => {
    it('only an explicit "off" turns the cache off', () => {
        expect(H.choosePersistence('off')).toBe('off');
        for (const s of ['', 'on', null, undefined, 'x']) expect(H.choosePersistence(s)).toBe('on');
    });
    it('says what each state means without alarming anyone', () => {
        expect(H.persistText('on')).toBe('on');
        expect(H.persistText('off')).toMatch(/nothing is lost/);
        expect(H.persistText('failed')).toMatch(/saving still works/);
    });
    it('repairs on its own after six failures in a row of the unreachable kind, once per 12 hours, never when already off', () => {
        const base = { failures: SYNC.AUTO_REPAIR_AFTER, kind: 'network', lastRepairAt: 0, now: T0, persist: 'on' };
        expect(H.shouldAutoRepair(base)).toBe(true);
        expect(H.shouldAutoRepair({ ...base, failures: SYNC.AUTO_REPAIR_AFTER - 1 })).toBe(false);
        expect(H.shouldAutoRepair({ ...base, kind: 'permission' })).toBe(false);
        expect(H.shouldAutoRepair({ ...base, persist: 'off' })).toBe(false);
        expect(H.shouldAutoRepair({ ...base, lastRepairAt: T0 - 3600_000 })).toBe(false);
        expect(H.shouldAutoRepair({ ...base, lastRepairAt: T0 - SYNC.AUTO_REPAIR_GAP_MS })).toBe(true);
    });
    it('the copied report says whether the offline cache is on', () => {
        const text = reportText([ok0()], { persist: 'off', when: new Date('2026-10-23T10:00:00Z') });
        expect(text).toMatch(/Offline cache: off on this device/);
    });
    function ok0() { return { id: 'server', label: 'WealthFlow server', ok: true, ms: 5, detail: 'reachable' }; }
});
