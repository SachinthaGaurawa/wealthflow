/* =============================================================================
 * test/resilience_test.js — the two things that were crashing the app, and the
 * tap targets that were too small to hit
 * -----------------------------------------------------------------------------
 * FOUND BY RUNNING THE APP, NOT BY READING IT
 *
 * index.html was loaded in a real browser at 320, 390, 412, 768, 1440 and 2560
 * pixels wide and its request log and layout were read back. Three things came
 * out that no amount of source review had turned up.
 *
 * 1. THE ONLINE PROBE WAS FETCHING A MARKDOWN LINK
 *
 *        await fetch('[https://firestore.googleapis.com](https://firestore.googleapis.com)', …)
 *
 *    That is not a URL. The browser resolved it as a RELATIVE PATH on our own
 *    origin, so probeConnection() never touched the internet — it asked our own
 *    server for a file with brackets in its name, got an answer, and returned
 *    true. Every time. This function is the only thing that decides whether the
 *    app believes it is online, so the offline banner could never appear, the
 *    status pill read Online with no connection at all, and each "reconnect"
 *    fired a sync at a network that was not there.
 *
 * 2. THE ONLY WRITE PATH IN THE APP COULD THROW INTO A CLICK HANDLER
 *
 *    DB.set — every expense, every income row, every setting, every imported
 *    statement — had a bare localStorage.setItem in the middle of it. On iOS
 *    Safari, whose localStorage ceiling is about 5 MB and which evicts under
 *    storage pressure, that throws QuotaExceededError for real. When it did:
 *    appData was already updated so the screen showed the new value; the throw
 *    escaped into the caller so the re-render and the modal close never ran and
 *    the app looked frozen; and setDirty/debouncedSync sit BELOW that line, so
 *    the change never reached Firestore either. A crash with no error message
 *    and silent data loss, which is exactly the shape of "many crashes" that is
 *    impossible to report usefully.
 *
 * 3. TAP TARGETS DOWN TO 15 PX TALL
 *
 *    Measured, not guessed: 92 interactive elements under 36 px on every phone
 *    viewport, including a 28x28 modal close button and 15 px auth links. Apple
 *    asks for 44 pt, Android for 48 dp. In a finance app a miss-tap confirms or
 *    deletes the wrong row. After the fix the same measurement returns 0, and
 *    fine-pointer layouts are untouched.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Source of a top-level block, by brace matching from a literal start marker. */
function blockAt(marker) {
    const start = HTML.indexOf(marker);
    expect(start, `"${marker}" is gone from index.html — retarget this test`).toBeGreaterThan(-1);
    let i = HTML.indexOf('{', start), depth = 0, q = null, j = i;
    for (; j < HTML.length; j++) {
        const c = HTML[j];
        if (q) { if (c === '\\') { j++; continue; } if (c === q) q = null; continue; }
        if (c === '"' || c === "'" || c === '`') { q = c; continue; }
        if (c === '/' && HTML[j + 1] === '/') { j = HTML.indexOf('\n', j); continue; }
        if (c === '/' && HTML[j + 1] === '*') { j = HTML.indexOf('*/', j) + 1; continue; }
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) break; }
    }
    expect(depth, `could not brace-match "${marker}"`).toBe(0);
    return HTML.slice(start, j + 1);
}

/* ── 1. the connectivity probe ───────────────────────────────────────────── */

function loadProbe(fetchImpl) {
    const src = blockAt('async function probeConnection()');
    return new Function('fetch', 'AbortController', 'setTimeout', 'clearTimeout',
        src + '; return probeConnection;')(
        fetchImpl,
        class { constructor() { this.signal = {}; } abort() {} },
        () => 0, () => {},
    );
}

describe('the app can tell whether it is actually online', () => {
    it('asks a real absolute URL, not a relative path', async () => {
        let asked = '';
        const probe = loadProbe((u) => { asked = String(u); return Promise.resolve({}); });
        await probe();
        expect(asked, 'the probe URL is not absolute — it resolves against our own '
            + 'origin and answers "online" without ever leaving the device')
            .toMatch(/^https:\/\//);
        expect(asked, 'a Markdown link is back in the URL').not.toMatch(/[[\]()]/);
    });

    it('reports offline when the request fails', async () => {
        const probe = loadProbe(() => Promise.reject(new Error('net::ERR_INTERNET_DISCONNECTED')));
        expect(await probe(), 'the offline banner can never appear if this is true')
            .toBe(false);
    });

    it('reports online when the request succeeds', async () => {
        const probe = loadProbe(() => Promise.resolve({}));
        expect(await probe()).toBe(true);
    });
});

/* ── 2. the write path ───────────────────────────────────────────────────── */

/** _persistLocal + DB, in one scope, driven by a storage that can be made full. */
function loadDB({ full = false, freeable = true } = {}) {
    const store = new Map();
    const notes = [];
    let dirty = 0, synced = 0;
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => {
            // Full unless the re-derivable caches have been cleared.
            const stillCached = ['wf_merchants_remote_v1', 'wf_error_log', 'wf_crash_log']
                .some((c) => store.has(c));
            if (full && (stillCached || !freeable)) {
                const e = new Error('QuotaExceededError'); e.name = 'QuotaExceededError'; throw e;
            }
            store.set(k, String(v));
        },
        removeItem: (k) => store.delete(k),
    };
    // The caches that are allowed to be sacrificed, plus data that must not be.
    store.set('wf_merchants_remote_v1', '[]');
    store.set('wf_error_log', '[]');
    store.set('wf_crash_log', '[]');
    store.set('wf2_expenses', '[{"id":1}]');
    store.set('wf_drive_token', 'precious');

    const env = {
        window: {},
        appData: {},
        isSyncingFromCloud: false,
        _WF_RECORD_KEYS: ['expenses', 'income'],
        _wfStampAndTomb: (k, v) => v,
        localStorage,
        _lastLocalWriteTs: 0,
        setDirty: () => { dirty++; },
        debouncedSync: () => { synced++; },
        console: { log() {}, warn() {}, error() {} },
        notify: (m) => notes.push(String(m)),
        _queueCloudDelete: () => {},
        _flushCloudDeletes: () => {},
    };
    const names = Object.keys(env);
    const src = blockAt('let _wfLocalWriteBlocked = false;\n        function _persistLocal')
        + '\n' + blockAt('const DB = {') + ';'
        + '\nreturn { DB: DB, _persistLocal: _persistLocal, blocked: () => _wfLocalWriteBlocked };';
    // The `let _wfLocalWriteBlocked` declaration is part of the extracted block,
    // so the two functions share the real binding rather than a copy.
    const api = new Function(...names, src)(...names.map((n) => env[n]));
    return { ...api, store, notes, counts: () => ({ dirty, synced }), env };
}

describe('a full disk does not take the app down with it', () => {
    it('the extraction found the real DB (guards a vacuous suite)', () => {
        const { DB, _persistLocal } = loadDB();
        expect(typeof DB.set).toBe('function');
        expect(typeof DB.delKey).toBe('function');
        expect(typeof _persistLocal).toBe('function');
    });

    it('writes normally when there is room', () => {
        const { DB, store } = loadDB();
        DB.set('income', [{ id: 7 }]);
        expect(JSON.parse(store.get('wf2_income'))).toEqual([{ id: 7 }]);
    });

    it('DB.set does not throw when storage is full', () => {
        const { DB } = loadDB({ full: true, freeable: false });
        expect(() => DB.set('expenses', [{ id: 1 }]),
            'the throw escapes into whatever click handler called it, and the rest '
            + 'of that handler never runs — a crash with no error message')
            .not.toThrow();
    });

    it('still marks the change for the cloud when the local write failed', () => {
        // The cloud has no 5 MB ceiling. Losing the local copy is survivable;
        // never pushing it is the actual data loss.
        const { DB, counts } = loadDB({ full: true, freeable: false });
        DB.set('expenses', [{ id: 1 }]);
        const c = counts();
        expect(c.dirty, 'a failed local write also skipped the cloud push').toBeGreaterThan(0);
        expect(c.synced).toBeGreaterThan(0);
    });

    it('keeps the value in memory so the screen and the data agree', () => {
        const { DB, env } = loadDB({ full: true, freeable: false });
        DB.set('expenses', [{ id: 42 }]);
        expect(env.appData.expenses).toEqual([{ id: 42 }]);
    });

    it('frees only re-derivable caches and retries once', () => {
        const { DB, store } = loadDB({ full: true, freeable: true });
        DB.set('expenses', [{ id: 5 }]);
        expect(JSON.parse(store.get('wf2_expenses')), 'the retry after freeing space did not happen')
            .toEqual([{ id: 5 }]);
        expect(store.has('wf_merchants_remote_v1'), 'the merchant cache should have been freed').toBe(false);
    });

    it('never sacrifices anything belonging to the user to make room', () => {
        const { DB, store } = loadDB({ full: true, freeable: true });
        DB.set('expenses', [{ id: 5 }]);
        expect(store.get('wf_drive_token'), 'a non-cache key was deleted to free space')
            .toBe('precious');
    });

    it('tells the user once, not on every keystroke', () => {
        const { DB, notes } = loadDB({ full: true, freeable: false });
        DB.set('expenses', [{ id: 1 }]);
        DB.set('expenses', [{ id: 2 }]);
        DB.set('income', [{ id: 3 }]);
        expect(notes.length, 'a storage-full notice on every write is its own outage')
            .toBe(1);
        expect(notes[0], 'the message does not say that the account copy is still safe')
            .toMatch(/syncing to your account/i);
    });

    it('DB.delKey survives a full disk too', () => {
        const { DB } = loadDB({ full: true, freeable: false });
        expect(() => DB.delKey('expenses', 'someId')).not.toThrow();
    });

    it('a value that cannot be serialised is reported, not thrown', () => {
        const { _persistLocal } = loadDB();
        const circular = {}; circular.self = circular;
        expect(() => _persistLocal('wf2_x', circular)).not.toThrow();
        expect(_persistLocal('wf2_x', circular)).toBe(false);
    });
});

/* ── 3. tap targets ──────────────────────────────────────────────────────── */

describe('the app is usable on a phone, whatever the OS', () => {
    const block = (() => {
        const i = HTML.indexOf('@media (pointer: coarse)');
        expect(i, 'the touch-target rules are gone — measured, 92 elements were '
            + 'under 36 px before they existed').toBeGreaterThan(-1);
        return HTML.slice(i, HTML.indexOf('\n        }', i) + 10);
    })();

    it('raises the minimum height of buttons', () => {
        expect(block).toMatch(/\.btn\s*\{[^}]*min-height:\s*(4[0-9]|[5-9][0-9])px/);
    });

    it('raises the small buttons and the install tabs, which measured 24 px', () => {
        expect(block).toMatch(/\.btn-sm[^{]*\{[^}]*min-height:\s*(4[0-9]|[5-9][0-9])px/);
    });

    it('raises the modal close button, which measured 28x28', () => {
        expect(block).toMatch(/\.md-x\s*\{[^}]*width:\s*4\dpx[^}]*height:\s*4\dpx/);
    });

    it('raises fields, where a miss-tap means a mistyped amount', () => {
        expect(block).toMatch(/\.fi,\s*\.fs\s*\{[^}]*min-height:\s*(4[0-9]|[5-9][0-9])px/);
    });

    it('applies to touch only, so mouse layouts are not changed', () => {
        expect(block.indexOf('@media (pointer: coarse)'),
            'the rules escaped the coarse-pointer query and now resize desktop too')
            .toBe(0);
    });

    it('the page still declares a responsive viewport', () => {
        expect(HTML).toMatch(/<meta[^>]+name="viewport"[^>]+width=device-width/i);
    });
});

/* ── 4. one bad record must not blank a page ─────────────────────────────── */

/* FOUND BY DRIVING THE APP, NOT BY READING IT
 *
 * The app was booted in a real browser with a stubbed backend, every one of its
 * 21 pages was rendered, and then a single expense record missing a field was
 * put into the store. renderDash() threw:
 *
 *     TypeError: Cannot read properties of undefined (reading 'startsWith')
 *       at renderDash  →  DB.get('expenses').filter(e => e.month.startsWith(year))
 *
 * The repair for exactly this already existed. It was written as an IIFE INSIDE
 * renderExpenses(), under a comment promising "the Expenses tab can NEVER crash
 * on bad data again" — a promise it kept, for one tab. renderDash reads the same
 * array raw, and the dashboard is the page the app opens on, so one old import
 * or one partial cloud merge left the app looking dead from the first screen
 * with no error anywhere a user could see it.
 *
 * The repair is now a shared function that every reader calls. */

function loadNormaliser() {
    const src = blockAt('function _wfNormaliseExpenseArray(arr)');
    return new Function('uid', 'window', src + '; return _wfNormaliseExpenseArray;')(
        () => 'generated-id', {});
}

describe('a malformed expense cannot blank a page', () => {
    const N = loadNormaliser();

    it('the extraction found the real function (guards a vacuous suite)', () => {
        expect(typeof N).toBe('function');
    });

    it('fills in a missing month from the date', () => {
        // A date in a DIFFERENT month from today on purpose: with today's month
        // the fixture cannot tell "read the date" from "give up and use now",
        // and a mutation replacing one with the other passed unnoticed.
        const a = [{ id: 1, amount: 100, date: '2024-03-15' }];
        N(a);
        expect(a[0].month, 'the month is not being read off the date — an old import '
            + 'silently moves to the current month, which moves the money with it')
            .toBe('2024-03');
    });

    it('falls back to the current month when there is no date either', () => {
        const a = [{ id: 1, amount: 100 }];
        N(a);
        expect(a[0].month).toMatch(/^\d{4}-\d{2}$/);
    });

    it('coerces an amount saved as a string, which is what an import produces', () => {
        const a = [{ id: 1, amount: '1,500.50', date: '2026-08-24' }];
        N(a);
        expect(a[0].amount).toBe(1500.5);
    });

    it('gives an amount that cannot be read at all a number, not NaN', () => {
        const a = [{ id: 1, amount: 'not money', date: '2026-08-24' }];
        N(a);
        expect(a[0].amount).toBe(0);
        expect(Number.isFinite(a[0].amount)).toBe(true);
    });

    it('drops null slots rather than letting them through', () => {
        const a = [null, { id: 1, amount: 5, date: '2026-08-24' }, undefined];
        N(a);
        expect(a).toHaveLength(1);
    });

    it('supplies a category and a description', () => {
        const a = [{ id: 1, amount: 5, date: '2026-08-24' }];
        N(a);
        expect(a[0].cat).toBe('Other');
        expect(typeof a[0].desc).toBe('string');
    });

    it('repairs IN PLACE so the fix persists on the next write', () => {
        const row = { id: 1, amount: 5, date: '2024-03-15' };
        const a = [row];
        N(a);
        expect(row.month, 'a copy was repaired and the stored record was left broken')
            .toBe('2024-03');
    });

    it('survives being handed something that is not an array', () => {
        expect(() => N(null)).not.toThrow();
        expect(() => N(undefined)).not.toThrow();
        expect(N('nonsense')).toEqual([]);
    });

    it('the dashboard repairs before it reads', () => {
        const dash = blockAt('function renderDash()');
        expect(dash, 'renderDash reads the raw array again — one bad record blanks '
            + 'the page the app opens on').toMatch(/_wfNormaliseExpenseArray\(DB\.get\('expenses'\)/);
    });

    it('the category chart no longer reads the raw store', () => {
        const dash = blockAt('function renderDash()');
        expect(dash, "the pie chart is back on DB.get('expenses') — the exact line that threw")
            .not.toMatch(/DB\.get\('expenses'\)\.filter\(e => e\.month\.startsWith/);
    });

    it('the repair is shared, not sealed inside one tab again', () => {
        expect(HTML, 'the normaliser went back to being an IIFE inside renderExpenses, '
            + 'where it protects that tab and nothing else')
            .not.toMatch(/\(function _wfNormaliseExpenses\(\)/);
    });
});
