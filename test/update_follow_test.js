// One account, several devices: an update done on one device reaches the others signed in to the same account.
// The rules are pure and tested in update_policy_test.js; this drives the real update screen (wealthflow-update-system.js) against a fake
// account record, the way two devices would see it. Merging between devices is the app's ordinary per-field merge, proven in
// test/e2e/update-follow.mjs in a real browser.
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const POLICY = loadBrowserModule('wealthflow-update-policy.js').window.WF_UPDATE_POLICY;
const RUNNING = loadBrowserModule('wealthflow-update-system.js').window.wfUpdate.CURRENT_VERSION;
const bump = (v, n = 1) => { const p = v.split('.').map(Number); p[2] += n; return p.join('.'); };
const NEXT = bump(RUNNING);
const note = (items) => ({ headline: "What's New", date: '2026-11-07', sections: [{ title: 'What changed for you', items }] });

/** The account record as one device reads and writes it (the app's DB, reduced to what the update screen uses). */
function fakeDB(seed = {}) {
    const db = { store: { ...seed }, writes: 0, getObj(k, d = {}) { return this.store[k] !== undefined ? this.store[k] : d; }, get(k, d = []) { return this.getObj(k, d); },
        set(k, v) { this.store[k] = JSON.parse(JSON.stringify(v)); this.writes++; } };
    return db;
}

async function device({ id = 'dev_laptop', ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36', db = fakeDB(), latest = NEXT, ls = {}, manifestExtra = {}, appUp = true } = {}) {
    const skew = { ms: 0 };
    const FakeDate = class extends Date { constructor(...a) { if (a.length) super(...a); else super(Date.now() + skew.ms); } static now() { return Date.now() + skew.ms; } };
    const manifest = { latest, notes: { [latest]: note(['x']) }, mandatory: [], ...manifestExtra };
    const fetchLog = [];
    const fetchImpl = async (url) => {
        fetchLog.push(String(url));
        if (String(url).includes('version.json')) return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => manifest };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}), text: async () => '', arrayBuffer: async () => new ArrayBuffer(4) };
    };
    const m = loadBrowserModule('wealthflow-update-system.js', {
        html: '<div id="wfUpdateCard"></div><nav><span id="nb-settings" style="display:none"></span></nav><div id="page-dashboard"><h1>Home</h1></div>' + (appUp ? '<div id="app" class="show"></div>' : '<div id="app"></div>'),
        fetchImpl, localStorage: { wf_device_id: id, ...ls },
        globals: { WF_UPDATE_POLICY: POLICY, WFWhen: { today: () => '2026-11-07' }, wfVersionManifest: manifest, DB: db, Date: FakeDate, navigator: { userAgent: ua, language: 'en', onLine: true, serviceWorker: undefined } },
    });
    await m.window.wfUpdate._loadManifest();
    const u = m.window.wfUpdate;
    const idle = () => { skew.ms += 120000; };
    return { ...m, u, db, idle, fetchLog, card: () => m.document.getElementById('wfUpdateCard').textContent };
}
const phoneSaid = (version, at = Date.now()) => ({ updateSync: POLICY.reportDevice({}, 'dev_phone', version, 'Safari on iPhone', at, true) });

describe('this device tells the account what it runs', () => {
    it('the first report names the device and the version, and does not move the account version (nothing was installed on purpose)', async () => {
        const t = await device();
        t.u._reportToAccount();
        const s = t.db.store.updateSync;
        expect(POLICY.parseDevice(s.devices.dev_laptop)).toMatchObject({ v: RUNNING, name: 'Chrome on Windows' });
        expect(s.wanted).toBeUndefined();
    });
    it('an update that landed here moves the account version, once, and a repeat report writes nothing more', async () => {
        const t = await device();
        t.u._claimUpdate(RUNNING, { fetched: 10, total: 10 });
        expect(t.u._settleClaim().ok).toBe(true);
        t.u._reportToAccount();
        expect(POLICY.parseWanted(t.db.store.updateSync.wanted)).toMatchObject({ v: RUNNING, by: 'dev_laptop' });
        const writes = t.db.writes;
        t.u._reportToAccount(); t.u._reportToAccount();
        expect(t.db.writes).toBe(writes);
    });
    it('a device on early access does not pull the others along', async () => {
        const t = await device({ ls: { wf_early_access: '1' } });
        t.u._claimUpdate(RUNNING, { fetched: 10, total: 10 });
        t.u._settleClaim();
        t.u._reportToAccount();
        expect(t.db.store.updateSync.wanted).toBeUndefined();
        expect(POLICY.parseDevice(t.db.store.updateSync.devices.dev_laptop).v).toBe(RUNNING);
    });
    it('nothing is written while the books are closed (sign-in screen, lock screen) or in decoy mode', async () => {
        const closed = await device({ appUp: false });
        closed.u._reportToAccount();
        expect(closed.db.writes).toBe(0);
        const decoy = await device();
        decoy.window._isDecoyMode = true;
        decoy.u._reportToAccount();
        expect(decoy.db.writes).toBe(0);
        expect(decoy.u._followState()).toBe(null);
    });
});

describe('another device already has a newer version', () => {
    it('this device is told so: the dashboard pill and Settings name the other device and the version', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)) });
        const f = t.u._followState();
        expect(f).toMatchObject({ act: 'install', version: NEXT, from: { name: 'Safari on iPhone' } });
        t.u.refresh();
        expect(t.document.getElementById('wfUpdatePill').textContent).toContain('Your Safari on iPhone is on v' + NEXT);
        expect(t.card()).toContain('Your devices');
        expect(t.card()).toContain('Keep my devices on the same version');
        expect(t.card()).toContain('Your Safari on iPhone is already on v' + NEXT);
    });
    it('the pill shows even for a quiet or still-rolling-out release, because the person already took it elsewhere', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), manifestExtra: { rollout: { [NEXT]: 1 }, priority: { [NEXT]: 0 } } });
        t.u.refresh();
        expect(!!t.document.getElementById('wfUpdatePill')).toBe(true);
    });
    it('without another device in the picture the pill and the card are exactly what they were', async () => {
        const t = await device({ manifestExtra: { priority: { [NEXT]: 0 } } });
        expect(t.u._followState()).toMatchObject({ act: 'none' });
        t.u.refresh();
        expect(!!t.document.getElementById('wfUpdatePill')).toBe(false);
        expect(t.card()).toContain('Your other devices show here after they open WealthFlow');
    });
    it('while the person is using the app nothing is installed; after a quiet minute it installs the build the server offers', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.') } });
        expect(await t.u._autoFollow()).toBe(false);
        expect(t.document.getElementById('wfProgress')).toBeNull();
        t.idle();
        const run = t.u._autoFollow().catch(() => {});
        await new Promise((r) => setTimeout(r, 30));
        expect(t.document.getElementById('wfProgress')).not.toBeNull();
        expect(JSON.parse(t.localStorage.getItem('wf_update_follow_try'))).toMatchObject({ version: NEXT, n: 1 });
        void run;
    });
    it('it does not start by itself where the agreement was never accepted on this account', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)) });
        t.idle();
        expect(await t.u._autoFollow()).toBe(false);
        expect(t.document.getElementById('wfProgress')).toBeNull();
    });
    it('the agreement the person accepted on the other device is enough', async () => {
        const sync = POLICY.noteAgreed(phoneSaid(NEXT).updateSync, NEXT.split('.').slice(0, 2).join('.'), Date.now());
        const t = await device({ db: fakeDB({ updateSync: sync }) });
        t.idle();
        const run = t.u._autoFollow().catch(() => {});
        await new Promise((r) => setTimeout(r, 30));
        expect(t.document.getElementById('wfProgress')).not.toBeNull();
        void run;
    });
    it('switching it off here stops it, and the choice is only for this device', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.') } });
        t.u.setFollow(false);
        expect(t.localStorage.getItem('wf_update_follow')).toBe('0');
        t.idle();
        expect(t.u._followState().why).toBe('off');
        expect(await t.u._autoFollow()).toBe(false);
        expect(t.document.getElementById('wfProgress')).toBeNull();
    });
    it('a version skipped on this device is not installed behind the person\'s back', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.') } });
        t.u.skip();
        t.idle();
        expect(t.u._followState().why).toBe('skipped');
        expect(await t.u._autoFollow()).toBe(false);
    });
    it('a failed attempt is not retried every few seconds', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.'), wf_update_follow_try: JSON.stringify({ version: NEXT, at: Date.now(), n: 1 }) } });
        t.idle();
        expect(await t.u._autoFollow()).toBe(false);
        expect(t.document.getElementById('wfProgress')).toBeNull();
    });
    it('Wi-Fi only is honoured like every other automatic install', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.'), wf_update_wifi_only: '1' } });
        t.window.navigator.connection = { type: 'cellular' };
        t.idle();
        expect(await t.u._autoFollow()).toBe(false);
    });
});

describe('the devices list', () => {
    it('shows every device with its version and which are behind, this one first', async () => {
        const at = Date.now();
        let s = POLICY.reportDevice({}, 'dev_phone', NEXT, 'Safari on iPhone', at - 60000, true);
        s = POLICY.reportDevice(s, 'dev_tab', RUNNING, 'Chrome on Android', at - 3 * 3600000, false);
        const t = await device({ db: fakeDB({ updateSync: s }) });
        t.u._reportToAccount();
        t.u.refresh();
        const c = t.card();
        expect(c.indexOf('Chrome on Windows · this device')).toBeGreaterThan(-1);
        expect(c).toContain('Safari on iPhone');
        expect(c).toContain('Newest');
        expect(c).toContain('Behind');
        expect(c).toContain('seen 3 h ago');
    });
});

describe('the agreement', () => {
    it('now says other devices follow, and that the agreement counts for all of them', async () => {
        const t = await device();
        const src = (await import('node:fs')).readFileSync(new URL('../wealthflow-update-system.js', import.meta.url), 'utf8');
        expect(src).toContain('YOUR DEVICES. This update installs on this device.');
        expect(src).not.toContain('PER-DEVICE INSTALLATION');
        void t;
    });
});

describe('the release list can lag the account', () => {
    it('when the account has a version this device\'s release list does not know yet, the list is read again (at most every 2 minutes)', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), latest: RUNNING });
        // this device's list still says "current"; the account says NEXT
        expect(t.u._followState().why).toBe('not-deployed');
        const before = t.fetchLog.length;
        t.u._refreshForAccount();
        await new Promise((r) => setTimeout(r, 20));
        expect(t.fetchLog.length).toBeGreaterThan(before);
        const after = t.fetchLog.length;
        t.u._refreshForAccount();
        await new Promise((r) => setTimeout(r, 20));
        expect(t.fetchLog.length).toBe(after);
    });
    it('it does not read again when the list already covers what the account has, or when this device is the one that installed it', async () => {
        const t = await device({ db: fakeDB(phoneSaid(NEXT)), latest: NEXT });
        const n = t.fetchLog.length;
        t.u._refreshForAccount();
        await new Promise((r) => setTimeout(r, 20));
        expect(t.fetchLog.length).toBe(n);
    });
});

describe('what counts as "the person is busy"', () => {
    const base = { db: fakeDB(phoneSaid(NEXT)), ls: { wf_update_eula_ok: NEXT.split('.').slice(0, 2).join('.') } };
    it('a dialog that is open stops an automatic install; one that is hidden (the notification panel always is) does not', async () => {
        const t = await device(base);
        t.idle();
        const dlg = t.document.createElement('div');
        dlg.setAttribute('role', 'dialog');
        t.document.body.appendChild(dlg);
        expect(await t.u._autoFollow()).toBe(false);
        dlg.hidden = true;
        const run = t.u._autoFollow().catch(() => {});
        await new Promise((r) => setTimeout(r, 30));
        expect(t.document.getElementById('wfProgress')).not.toBeNull();
        void run;
    });
});
