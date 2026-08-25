/* =============================================================================
 * test/update_ui_truth_test.js
 * -----------------------------------------------------------------------------
 * WHAT THE OWNER SAW
 *
 * A device executing v7.69.18 displayed a sheet headed "Welcome to v7.69.15",
 * describing press-and-hold undo of an investment month and a Drive connection
 * that stays on. Neither part was true, and the two parts were not even about
 * the same release:
 *
 *   · the version came from localStorage['wf_installed_version'], which only
 *     ever advanced when the user completed the in-app update flow — so a hard
 *     refresh, which is how new code actually arrives, left it frozen;
 *   · the text came from BUILTIN_NOTES['7.40.0'], dated 2026-07-01, reached
 *     through a fallback whose comment read "never show an empty What's New".
 *
 * That fallback is the defect in one line: the UI would rather fabricate than
 * admit it does not know. An empty sheet is a missing note. A filled one is a
 * false claim about what the owner is running.
 *
 * These tests execute the real module against a stubbed DOM/localStorage rather
 * than reading it as text, because "the source no longer contains BUILTIN_NOTES"
 * and "the sheet can no longer show another release's notes" are different
 * claims and only the second is what the owner experiences.
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

/**
 * Load the module into a fresh fake window.
 *
 * Evaluated per-test with `new Function` rather than imported: an ESM import is
 * cached, so the IIFE would run once and every later test would assert against
 * the first test's localStorage. That exact mistake cost a full debugging cycle
 * earlier in this project.
 */
function loadModule({ stored = null, manifest = null } = {}) {
    const store = new Map();
    if (stored !== null) store.set('wf_installed_version', stored);

    const el = () => ({
        style: {}, classList: { add() {}, remove() {}, toggle() {} },
        setAttribute() {}, removeAttribute() {}, appendChild() {}, remove() {},
        addEventListener() {}, querySelector: () => null, querySelectorAll: () => [],
        innerHTML: '', textContent: '', value: '', checked: false, dataset: {},
    });
    const win = {
        localStorage: {
            getItem: (k) => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: (k) => store.delete(k),
            key: (i) => Array.from(store.keys())[i] ?? null,
            get length() { return store.size; },
        },
        sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
        addEventListener() {}, removeEventListener() {},
        location: { origin: 'https://wf.app', reload() {} },
        navigator: { userAgent: 'test', language: 'en', onLine: true },
        screen: { width: 390, height: 844 },
        matchMedia: () => ({ matches: false, addEventListener() {} }),
        fetch: async () => { throw new Error('offline in test'); },
        console, setTimeout, clearTimeout, setInterval, clearInterval,
        requestAnimationFrame: (f) => f(),
    };
    win.window = win;
    const doc = {
        readyState: 'complete', body: el(), documentElement: el(),
        getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
        createElement: () => el(), addEventListener() {}, head: el(),
    };

    new Function('window', 'document', 'localStorage', 'sessionStorage',
        'navigator', 'screen', 'location', 'fetch', 'requestAnimationFrame',
        SRC)(
        win, doc, win.localStorage, win.sessionStorage,
        win.navigator, win.screen, win.location, win.fetch, win.requestAnimationFrame,
    );

    const api = win.wfUpdate;
    return { api, win, store };
}

describe('the hardcoded release history is gone', () => {
    it('BUILTIN_NOTES is no longer a live binding', () => {
        // Comments may still mention it — that documentation is why it left.
        const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(code).not.toMatch(/const BUILTIN_NOTES/);
        expect(code).not.toMatch(/BUILTIN_NOTES\[/);
    });

    it('took ~21 KB of duplicated history out of the bundle', () => {
        // Raised from 105_000 when the update flow stopped asserting an
        // installation it had not verified: the claim/settle pair, the download
        // tally, and the comments recording what the old behaviour cost. The
        // duplicated release history this ceiling was created to keep out has not
        // come back — that is asserted separately, above and below.
        const bytes = fs.statSync(path.join(ROOT, 'wealthflow-update-system.js')).size;
        expect(bytes).toBeLessThan(115_000);
    });
});

describe('the notes fallback that fabricated history is gone', () => {
    it('no longer reaches for "the newest notes we have"', () => {
        const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        // The exact shape of the old fallback: build a merged map, sort keys
        // descending, return the newest regardless of which version was asked for.
        expect(code).not.toMatch(/Object\.assign\(\{\}, BUILTIN_NOTES/);
        expect(code).not.toMatch(/return keys\.length \? all\[keys\[0\]\] : null/);
    });

    it('_rawNotesFor returns notes for the asked-for version, or null', () => {
        const i = SRC.indexOf('function _rawNotesFor');
        expect(i, '_rawNotesFor anchor not found — retarget this test').toBeGreaterThan(-1);
        const fn = SRC.slice(i, SRC.indexOf('\n    }', i));
        expect(fn).toMatch(/_manifest\.notes\[v\]/);
        expect(fn).toMatch(/return null;/);
        // Must not consult any other version.
        expect(fn).not.toMatch(/keys\[0\]/);
    });
});

describe('the installed version reports the code that is running', () => {
    it('reconciles a stale localStorage forward to CURRENT_VERSION', () => {
        // The owner's exact situation: device remembered 7.69.15, ran 7.69.18.
        const { api } = loadModule({ stored: '7.69.15' });
        expect(api, 'wfUpdate did not initialise').toBeTruthy();
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(api._installedVersion()).toBe(shipped);
    });

    it('writes the reconciled value back, so it stops drifting', () => {
        const { api, store } = loadModule({ stored: '7.69.15' });
        api._installedVersion();
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(store.get('wf_installed_version')).toBe(shipped);
    });

    it('reports CURRENT_VERSION on a device that has never stored one', () => {
        const { api } = loadModule({ stored: null });
        const shipped = /const CURRENT_VERSION\s*=\s*'([\d.]+)'/.exec(SRC)[1];
        expect(api._installedVersion()).toBe(shipped);
    });

    it('keeps the evidence when stored is ahead — WITHOUT suppressing updates', () => {
        // The original rule here was "never lower the record": a device served
        // older code than it once ran is a rollback or a stale cache, and erasing
        // that would lose the only evidence. The intent was right; the mechanism
        // had a consequence nobody had traced.
        //
        // _updateAvailable() compares the latest version against THIS value. So a
        // device that recorded 7.70.0 while still executing 7.69.24 — which the
        // update flow caused directly, by writing the target version whether or
        // not a single file had downloaded — was told it was current and stopped
        // being offered updates. Permanently. That is the self-sealing half of
        // "when a new update is released, app versions not yet updated".
        //
        // So the evidence is kept, in a key that cannot suppress anything, and the
        // answer to "what is installed" becomes the one fact that is verifiable:
        // the version of the code executing right now.
        const { api, store } = loadModule({ stored: '9.9.9' });
        expect(api._installedVersion(), 'a version ahead of the running code is still reported as '
            + 'installed, so update checks compare against it and never fire again')
            .toBe(api.CURRENT_VERSION || '7.69.24');
        const anomaly = store.get('wf_version_anomaly');
        expect(anomaly, 'the evidence of the mismatch was erased rather than moved').toBeTruthy();
        expect(JSON.parse(anomaly).stored, 'the anomaly record does not name what was stored')
            .toBe('9.9.9');
        // The stored value itself must be corrected, not just reported around.
        // Returning the right answer while leaving 9.9.9 on disk means every
        // direct reader of wf_installed_version is still wrong, and the heal has
        // to run again on every single call.
        expect(store.get('wf_installed_version'), 'the poisoned value was left on disk — anything '
            + 'reading it directly still sees a version ahead of the running code')
            .toBe(api.CURRENT_VERSION || '7.69.24');
    });
});

describe('version.json now carries real notes for v7.69.18', () => {
    const vj = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8'));
    const n = vj.notes['7.69.18'];

    it('is the structured shape, not the old boilerplate string', () => {
        expect(typeof n).toBe('object');
        expect(JSON.stringify(n)).not.toMatch(/Improvements and fixes in this release/);
    });

    it('names the change the owner would actually notice', () => {
        const user = n.sections.find((s) => /what changed for you/i.test(s.title));
        expect(user).toBeTruthy();
        expect(user.items.join(' ')).toMatch(/update system tell the truth/i);
    });

    it('separates the four pipeline PRs from it', () => {
        const hood = n.sections.find((s) => /under the hood/i.test(s.title));
        expect(hood.items).toHaveLength(4);
    });

    it('carries no markdown — the renderer escapes its input', () => {
        expect(JSON.stringify(n)).not.toMatch(/\*\*/);
    });
});

/* ── the update that claimed an installation it never had ────────────────────
 *
 * The flow ended with _markInstalled(target) — unconditionally. Every fetch
 * failure in the download step was swallowed with "still counts as attempted",
 * the service-worker swap was best-effort, and then the target version was
 * written to localStorage whether or not a single byte had arrived.
 *
 * So the app could report "Update complete — now on 7.70.0" while running
 * byte-identical code. And because _installedVersion() returned that stored
 * value, _updateAvailable() then compared the latest release against it, found
 * them equal, and never offered an update again. One failed tap and the device
 * was stuck on old code believing it was current — which is what "the update
 * system is a fake placebo" and "when a new update is released, app versions not
 * yet updated" both describe.
 * ---------------------------------------------------------------------------*/
describe('an update is claimed, then settled against the code that loaded', () => {
    it('a claim that came true is settled as installed', () => {
        const { api, store } = loadModule({ stored: null });
        const running = api.CURRENT_VERSION;
        // claim an update to the version we are in fact running
        api._claimUpdate(running, { fetched: 40, total: 40 });
        const out = api._settleClaim();
        expect(out.ok, 'an update that did land was not settled as installed').toBe(true);
        expect(store.get('wf_installed_version')).toBe(running);
        expect(store.get('wf_update_claimed'), 'the claim was left behind to be settled twice')
            .toBeUndefined();
    });

    it('a claim that did NOT come true never becomes an installed version', () => {
        const { api, store } = loadModule({ stored: null });
        api._claimUpdate('99.0.0', { fetched: 0, total: 40 });
        const out = api._settleClaim();
        expect(out.ok, 'an update that did not land was settled as a success').toBe(false);
        expect(out.running).toBe(api.CURRENT_VERSION);
        expect(store.get('wf_installed_version'), 'the target version was written even though the '
            + 'code never changed — this is exactly what stops the device updating again')
            .not.toBe('99.0.0');
        expect(store.get('wf_update_claimed'), 'the failed claim persists and will be re-settled')
            .toBeUndefined();
    });

    it('settling is idempotent — a second boot has nothing left to settle', () => {
        const { api } = loadModule({ stored: null });
        api._claimUpdate('99.0.0', { fetched: 0, total: 40 });
        expect(api._settleClaim().ok).toBe(false);
        expect(api._settleClaim(), 'a settled claim was settled again').toBe(null);
    });

    it('carries the download evidence into the failure, so the reason is knowable', () => {
        const { api } = loadModule({ stored: null });
        api._claimUpdate('99.0.0', { fetched: 3, total: 41 });
        const out = api._settleClaim();
        expect(out.fetched).toBe(3);
        expect(out.total).toBe(41);
    });

    it('the flow refuses to claim when nothing downloaded', () => {
        // Source-level, because driving the whole update flow needs a live SW and
        // a real network. The branch has to exist and it has to return before the
        // claim: a claim written after a zero-byte download is the original bug.
        const claimAt = SRC.indexOf('_claimUpdate(version, _dl)');
        const refuseAt = SRC.indexOf("reason: 'no-files-downloaded'");
        expect(refuseAt, 'the flow no longer refuses an update that downloaded nothing')
            .toBeGreaterThan(-1);
        expect(refuseAt, 'the refusal comes after the claim, so the claim is written anyway')
            .toBeLessThan(claimAt);
        // The branch must still be REACHABLE. Asserting only that the block exists
        // let a mutation to `if (false)` through: the text stayed exactly where it
        // was and the position check passed while the refusal was dead code.
        expect(SRC, 'the zero-download refusal is present but can never run')
            .toMatch(/if \(_dl\.total > 0 && _dl\.fetched === 0\) \{/);
        // Comment-stripped: the fix's own comment quotes the old phrase to record
        // what it replaced, and matching against the prose flagged that as the bug
        // returning. What must not come back is the CODE — a bare fetch in a
        // try/catch whose catch does nothing with the failure.
        const code = SRC.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
        expect(code, 'a fetch failure is swallowed again in the download step, which is how the '
            + 'flow reported success on zero downloads')
            .not.toMatch(/await fetch\(src, \{ cache: 'reload' \}\); \} catch \(_\) \{ \}/);
        expect(SRC, 'the download step no longer counts which fetches actually succeeded')
            .toMatch(/if \(r && r\.ok\) _dl\.fetched \+= 1/);
    });

    it('init settles the claim before anything reads the installed version', () => {
        const settle = SRC.indexOf('_settleClaim()');
        const initAt = SRC.indexOf('async function init()');
        const readAt = SRC.indexOf('const installed = _installedVersion();', initAt);
        const settleInInit = SRC.indexOf('_settleClaim()', initAt);
        expect(settle, '_settleClaim is never called').toBeGreaterThan(-1);
        expect(settleInInit, 'init does not settle the claim, so a promise from the previous '
            + 'session is read as fact by the settings card and the update check')
            .toBeGreaterThan(-1);
        expect(settleInInit, 'the claim is settled after the installed version is read')
            .toBeLessThan(readAt);
    });
});
