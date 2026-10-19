/* =============================================================================
 * test/settings_sync_revert_test.js — "I switched it off and hours later it was on"
 * -----------------------------------------------------------------------------
 * THE REPORT (owner, three times now): an option turned OFF in Settings comes
 * back by itself a few hours later.
 *
 * THE ROOT CAUSE, reproduced with two real browsers and one shared cloud
 * document (test/e2e/settings-sync.mjs):
 *
 *   phone   turns `notifications` off                    stamp  notifications@100
 *   laptop  (cut off from the cloud, still thinks "on")
 *           turns `compactMode` on                       stamp  compactMode@200
 *           is refreshed by a new deploy                 <- per-field stamps lost
 *           reconnects, merges, pushes
 *   result  `notifications` is ON again — on the laptop, in the cloud, on the phone.
 *
 * The per-field clock (_kuf) that exists to stop exactly this was WRITTEN to
 * disk but never READ BACK: it was not declared in appData, and the boot
 * hydration loop only walks appData's own keys. So the first thing a refreshed
 * device did was forget which fields it had really touched, and the merge fell
 * back to the one stamp for the whole settings object — which is the bug the
 * field clock was written to remove. Deploys refresh the app many times a day,
 * which is why it looked like "a few hours".
 *
 * Three more holes of the same shape are closed with it:
 *   · the stamps were never converged with the cloud's, so a device could not
 *     learn which fields another device had touched;
 *   · a nested object (settings.notif — the notification sub-switches) was ONE
 *     field, so touching one sub-switch claimed all of them;
 *   · "did the cloud change" compared JSON text, so key ORDER alone looked like
 *     a change and every one-minute reconcile pushed an unchanged document.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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
const constAt = (re, what) => {
    const m = HTML.match(re);
    expect(m, `${what} is gone from index.html — retarget this test`).toBeTruthy();
    return m[0];
};

/** One device: its own localStorage and appData, running the SHIPPED merge code. */
function device(initialDisk = {}) {
    const store = new Map(Object.entries(initialDisk));
    const localStorage = {
        getItem: (k) => (store.has(k) ? store.get(k) : null),
        setItem: (k, v) => { store.set(k, String(v)); },
        removeItem: (k) => store.delete(k),
    };
    const appData = { _wipedAck: 0, _kut: {}, _kuf: {}, _tomb: {}, settings: {} };
    const src = [
        constAt(/const _WF_RECORD_KEYS = \[[^\]]*\];/, '_WF_RECORD_KEYS'),
        constAt(/const _WF_TOMB_TTL = [^;]*;/, '_WF_TOMB_TTL'),
        constAt(/const _WF_SYNC_META_KEYS = \{[^}]*\};/, '_WF_SYNC_META_KEYS'),
        constAt(/const _WF_KUT_EXEMPT = \{[^}]*\};/, '_WF_KUT_EXEMPT'),
        constAt(/const _WF_KUT_EXEMPT_FIELDS = \{ auth: \{[^}]*\} \};/, '_WF_KUT_EXEMPT_FIELDS'),
        blockAt('function _utOf(r)'),
        blockAt('function _recSig(r)'),
        blockAt('function _recPreferred(a, b)'),
        blockAt('function _wfMergeRecordArray(localArr, cloudArr, tombMap)'),
        blockAt('function _wfMergeTombMaps(a, b)'),
        'let _wfHlc = 0;',
        'const _WF_DEFAULTS = ' + JSON.stringify({ settings: { backupFreq: 'weekly', theme: 'dark', haptics: true, notifications: true, compactMode: false } }) + ';',
        blockAt('function _wfStampNow()'),
        blockAt('function _wfObserveStamps(cloud)'),
        blockAt('function _persistLocal(key, value, raw)'),
        blockAt('function _persistRaw(key, str)'),
        constAt(/const _WF_KUF_SEP = '[^']*';/, '_WF_KUF_SEP'),
        constAt(/const _WF_KUF_DEPTH = \d+;/, '_WF_KUF_DEPTH'),
        blockAt('function _wfPlainObj(v)'),
        blockAt('function _wfSameValue(a, b)'),
        blockAt('function _wfCanonJson(v)'),
        blockAt('function _wfChangedLeaves(before, after, prefix, out, depth)'),
        blockAt('function _wfKufStampOf(map, leafPath, fallback)'),
        blockAt('function _wfMergeKufMaps(a, b)'),
        blockAt('function _wfStampKey(k)'),
        blockAt('function _wfStampFields(k, nextVal)'),
        blockAt('function _wfMergeKeyed('),
        blockAt('function _wfApplyCloudData(cloudData)'),
    ].join('\n');
    const api = new Function('localStorage', 'appData', 'notify', 'console', 'window',
        src + '; let _wfLocalWriteBlocked = false;'
        + ' return { _wfStampFields, _wfStampKey, _wfStampNow, _wfMergeKeyed, _wfApplyCloudData, _persistRaw };'
    )(localStorage, appData, () => {}, { log() {}, warn() {}, error() {} }, { _isDecoyMode: false });

    /** What DB.set does for a non-record key (fields first, then the key, then disk). */
    const write = (key, value) => {
        api._wfStampFields(key, value);
        api._wfStampKey(key);
        appData[key] = JSON.parse(JSON.stringify(value));
        localStorage.setItem('wf2_' + key, JSON.stringify(value));
    };
    /** The document this device would push: everything in appData. */
    const push = () => JSON.parse(JSON.stringify(appData));
    /**
     * A refresh. The boot hydration reads back every key that appData DECLARES —
     * this copies exactly that list, so a key the source forgets to declare is
     * forgotten here too, as in the browser.
     */
    const declared = declaredKeys();
    const reload = () => {
        const fresh = device(Object.fromEntries(store));
        declared.forEach((k) => {
            const raw = store.get('wf2_' + k);
            if (raw != null) { try { fresh.appData[k] = JSON.parse(raw); } catch { /* keep default */ } }
        });
        return fresh;
    };
    return { api, appData, store, write, push, reload, apply: (cloud) => api._wfApplyCloudData(JSON.parse(JSON.stringify(cloud))) };
}

/** The keys index.html declares in its default appData — what the boot hydration walks. */
function declaredKeys() {
    const at = HTML.indexOf('let appData = {');
    expect(at, 'the default appData is gone — retarget this test').toBeGreaterThan(-1);
    const body = blockAt('let appData = {').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    return [...body.matchAll(/(?:^|[,{\s])([A-Za-z_][A-Za-z0-9_]*)\s*:/g)].map((m) => m[1])
        .filter((k) => !['total', 'flows', 'backupFreq', 'lastBackup', 'theme', 'autoLock', 'haptics', 'currency', 'notifications', 'compactMode'].includes(k));
}

const tick = (n = 5) => { const end = Date.now() + n; while (Date.now() < end) { /* spin so stamps differ */ } };

describe('the per-field clock survives a refresh', () => {
    it('is declared in the default appData, so the boot hydration reads it back', () => {
        expect(declaredKeys()).toContain('_kuf');
    });

    it('a refreshed device still holds the stamps it earned before the refresh', () => {
        const laptop = device();
        laptop.write('settings', { theme: 'dark', notifications: true });
        tick();
        laptop.write('settings', { theme: 'dark', notifications: true, compactMode: true });
        const before = JSON.parse(JSON.stringify(laptop.appData._kuf));
        expect(before.settings.compactMode).toBeGreaterThan(0);
        const again = laptop.reload();
        expect(again.appData._kuf, 'the stamps were written to disk and not read back').toEqual(before);
    });
});

describe('THE OWNER’S BUG, end to end across a refresh', () => {
    /** phone: notifications off.  laptop: stale, touches compactMode, refreshes, reconnects. */
    function scenario({ refresh }) {
        const phone = device();
        const laptop = device();
        // both start from the same synced state
        const start = { theme: 'dark', notifications: true, compactMode: false };
        phone.write('settings', start); tick();
        laptop.appData.settings = { ...start };
        laptop.store.set('wf2_settings', JSON.stringify(start));
        laptop.apply(phone.push());

        // the laptop goes dark; the phone turns notifications off
        tick();
        phone.write('settings', { ...phone.appData.settings, notifications: false });
        tick(10);
        let cloud = phone.push();

        // the laptop, unaware, turns compact mode on
        laptop.write('settings', { ...laptop.appData.settings, compactMode: true });
        let lap = refresh ? laptop.reload() : laptop;

        // it reconnects: merge the cloud in, then push what it holds
        lap.apply(cloud);
        cloud = (() => { const m = lap.push(); return m; })();
        phone.apply(cloud);
        return { phone, lap, cloud };
    }

    it('without a refresh the setting stays off (the case the old fix covered)', () => {
        const { phone, lap } = scenario({ refresh: false });
        expect(lap.appData.settings.notifications).toBe(false);
        expect(phone.appData.settings.notifications).toBe(false);
        expect(lap.appData.settings.compactMode).toBe(true);
    });

    it('and it still stays off when the laptop was refreshed in between', () => {
        const { phone, lap, cloud } = scenario({ refresh: true });
        expect(lap.appData.settings.notifications,
            'a refreshed, stale device reverted a setting it never touched').toBe(false);
        expect(cloud.settings.notifications).toBe(false);
        expect(phone.appData.settings.notifications).toBe(false);
        expect(lap.appData.settings.compactMode, 'the laptop’s own change was lost').toBe(true);
        expect(phone.appData.settings.compactMode).toBe(true);
    });
});

describe('a device that never saved its settings', () => {
    it('keeps the defaults it was born with out of its claim when it first changes ONE thing', () => {
        /* Reproduced in two browsers: a laptop with nothing on disk for `settings`
         * toggled compact mode. The key counted as "a first write", so every field
         * was stamped now — including `notifications`, still at its default of on.
         * The phone had switched it off a minute earlier; the laptop's stamp was
         * newer, and the phone's choice was overwritten. */
        const laptop = device();
        laptop.write('settings', { backupFreq: 'weekly', theme: 'dark', haptics: true, notifications: true, compactMode: true });
        expect(Object.keys(laptop.appData._kuf.settings)).toEqual(['compactMode']);
    });

    it('is read from the defaults captured BEFORE disk and cloud are read', () => {
        const decl = HTML.indexOf('const _WF_DEFAULTS = JSON.parse(JSON.stringify(appData));');
        expect(decl, 'the defaults snapshot is gone').toBeGreaterThan(-1);
        expect(decl).toBeLessThan(HTML.indexOf("Object.keys(appData).forEach(k => {"));
    });

    it('a key with no default at all is a genuine first write and is stamped whole', () => {
        const d = device();
        d.write('brandNew', { a: 1, b: { c: 2 } });
        expect(Object.keys(d.appData._kuf.brandNew).sort()).toEqual(['a', 'b']);
    });
});

describe('the clock travels with the value', () => {
    it('a device that adopts the cloud’s value also adopts the cloud’s stamp for it', () => {
        const laptop = device();
        laptop.write('settings', { notifications: true });   // older, its own stamp
        tick();
        const phone = device();
        phone.write('settings', { notifications: false });    // newer
        laptop.apply(phone.push());
        expect(laptop.appData.settings.notifications).toBe(false);
        expect(laptop.appData._kuf.settings.notifications,
            'adopted a value without the claim that won it — the next merge would re-argue it')
            .toBe(phone.appData._kuf.settings.notifications);
    });

    it('asks to be pushed when the cloud is missing a stamp this device holds', () => {
        const phone = device();
        phone.write('settings', { notifications: false });
        const cloud = phone.push();
        delete cloud._kuf;
        const res = phone.apply(cloud);
        expect(res.needPush).toBe(true);
    });

    it('settles: applying the same document twice asks for nothing the second time', () => {
        const phone = device();
        phone.write('settings', { notifications: false, theme: 'light', notif: { sms: false } });
        const laptop = device();
        laptop.apply(phone.push());
        const echo = laptop.push();
        const second = phone.apply(echo);
        expect(second.needPush, 'two devices holding the same truth keep pushing it at each other').toBe(false);
        const third = laptop.apply(phone.push());
        expect(third.needPush).toBe(false);
    });

    it('key ORDER alone is not a change (Firestore returns map keys sorted)', () => {
        const phone = device();
        phone.write('settings', { zeta: 1, alpha: 2, mid: { z: 1, a: 2 } });
        const cloud = phone.push();
        const sorted = JSON.parse(JSON.stringify(cloud, (k, v) => (v && typeof v === 'object' && !Array.isArray(v)
            ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v)));
        const res = phone.apply(sorted);
        expect(res.needPush, 'a re-ordered but identical document triggers a push every minute').toBe(false);
    });
});

describe('a nested switch is its own field', () => {
    it('touching one notification sub-switch does not claim the others', () => {
        const phone = device();
        const laptop = device();
        const both = { notif: { sms: true, email: true, push: true } };
        phone.write('settings', both); tick();
        laptop.write('settings', both);
        laptop.apply(phone.push()); tick();

        phone.write('settings', { notif: { sms: false, email: true, push: true } });   // phone: sms off
        tick(10);
        laptop.write('settings', { notif: { sms: true, email: false, push: true } });   // stale laptop: email off, sms untouched

        const merged = laptop.apply(phone.push());
        void merged;
        expect(laptop.appData.settings.notif.sms, 'sms was switched off on the phone').toBe(false);
        expect(laptop.appData.settings.notif.email, 'email was switched off on the laptop').toBe(false);
        expect(laptop.appData.settings.notif.push).toBe(true);
    });

    it('a stamp on the whole object (an older build) still covers every sub-switch', () => {
        const { api } = device();
        const out = api._wfMergeKeyed({ notif: { a: 1, b: 1 } }, { notif: { a: 2, b: 2 } }, 5, 5,
            { notif: 900 }, { notif: 100 });
        expect(out.notif).toEqual({ a: 1, b: 1 });
    });
});

describe('what stays as it was', () => {
    it('a field removed by the caller keeps its old stamp', () => {
        const d = device();
        d.write('settings', { a: 1, b: 2 });
        const stampB = d.appData._kuf.settings.b;
        tick();
        d.write('settings', { a: 5 });
        expect(d.appData._kuf.settings.b).toBe(stampB);
    });

    it('legacy documents with no stamps anywhere keep the local copy', () => {
        const { api } = device();
        const out = api._wfMergeKeyed({ t: 'dark' }, { t: 'light' }, 0, 0);
        expect(out.t).toBe('dark');
    });
});


describe('auth: credentials never merge, but a lost PIN is never adopted and skipLock keeps its clock', () => {
    const PIN = '0667d7722e83d08ebe5934a31235809a49d010a30ece5a97cf9c3fed44001c47';

    it('a cloud copy WITHOUT a PIN never replaces a local one that has it (new-account sign-up)', () => {
        const d = device();
        d.write('auth', { pin: PIN });
        const res = d.apply({ auth: {}, _kut: {}, _kuf: {} });
        expect(d.appData.auth.pin, 'the PIN just created was erased by the empty profile written before it').toBe(PIN);
        expect(res.needPush, 'the cloud must be told, or it keeps having no PIN').toBe(true);
        expect(JSON.parse(d.store.get('wf2_auth')).pin).toBe(PIN);
    });

    it('a cloud copy WITH a PIN still wins (a PIN changed on another device)', () => {
        const d = device();
        d.write('auth', { pin: PIN });
        d.apply({ auth: { pin: 'other', _pinChangedAt: 5 } });
        expect(d.appData.auth.pin).toBe('other');
    });

    it('the first skipLock toggle stamps skipLock only, never the credentials around it', () => {
        const d = device();
        d.write('auth', { pin: PIN });
        d.write('auth', { pin: PIN, skipLock: true });
        expect(Object.keys(d.appData._kuf.auth || {})).toEqual(['skipLock']);
    });

    it('skipLock switched on here AFTER the cloud copy was written is not put back by the next cloud read', () => {
        const phone = device();
        const laptop = device();
        laptop.write('auth', { pin: PIN, skipLock: false });
        phone.write('auth', { pin: PIN, skipLock: false });
        phone.apply(laptop.push());
        tick();
        // phone turns "Passcode-free entry" on while offline — it has not pushed yet
        phone.write('auth', { pin: PIN, skipLock: true });
        const res = phone.apply(laptop.push());          // the one-minute reconcile reads the stale cloud copy
        expect(phone.appData.auth.skipLock, 'the switch turned itself back off').toBe(true);
        expect(res.needPush).toBe(true);
        // once pushed, the laptop takes the newer choice
        laptop.apply(phone.push());
        expect(laptop.appData.auth.skipLock).toBe(true);
    });

    it('skipLock changed on the OTHER device later wins here', () => {
        const phone = device();
        const laptop = device();
        phone.write('auth', { pin: PIN, skipLock: true });
        laptop.apply(phone.push());
        tick();
        laptop.write('auth', { pin: PIN, skipLock: false });
        phone.apply(laptop.push());
        expect(phone.appData.auth.skipLock).toBe(false);
    });

    it('a device with no skipLock stamp (an older build) leaves the cloud value alone', () => {
        const d = device();
        d.write('auth', { pin: PIN });
        d.appData.auth.skipLock = true;                       // set by an older build: no stamp anywhere
        d.apply({ auth: { pin: PIN, skipLock: false }, _kuf: {}, _kut: {} });
        expect(d.appData.auth.skipLock).toBe(false);
    });
});
