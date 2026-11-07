// What the person sees and can do about an update: later, skip, install when idle, staged rollout, required updates,
// one catch-up list across skipped releases, the agreement once per minor line, and patch-style downloads.
import { describe, it, expect, vi } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const POLICY = loadBrowserModule('wealthflow-update-policy.js').window.WF_UPDATE_POLICY;
const note = (items, extra = {}) => ({ headline: "What's New", date: '2026-11-07', sections: [{ title: 'What changed for you', items }], ...extra });

async function boot({ manifest, ls = {}, extra = {}, html = '', fetchLog = null } = {}) {
    const fetchImpl = async (url, init) => {
        if (fetchLog) fetchLog.push({ url: String(url), cache: init && init.cache });
        if (String(url).includes('version.json')) {
            return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ latest: manifest.latest, notes: manifest.notes || {}, mandatory: manifest.mandatory || [] }) };
        }
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) };
    };
    const m = loadBrowserModule('wealthflow-update-system.js', {
        html: '<div id="wfUpdateCard"></div><nav><span id="nb-settings" style="display:none"></span></nav><div id="page-dashboard"><h1>Home</h1></div>' + html,
        fetchImpl, localStorage: ls,
        globals: { WF_UPDATE_POLICY: POLICY, WFWhen: { today: () => '2026-11-07' }, wfVersionManifest: manifest, ...extra },
    });
    await m.window.wfUpdate._loadManifest();
    m.window.wfUpdate.refresh();
    const card = () => m.document.getElementById('wfUpdateCard').textContent;
    const pill = () => !!m.document.getElementById('wfUpdatePill');
    return { ...m, card, pill, u: m.window.wfUpdate };
}

describe('an update the person may take or leave', () => {
    const manifest = { latest: '99.0.0', notes: { '99.0.0': note(['New thing']) } };

    it('offers update now, later, install when idle and skip', async () => {
        const t = await boot({ manifest });
        expect(t.card()).toContain('Update now');
        expect(t.card()).toContain('Remind me tomorrow');
        expect(t.card()).toContain('Install when idle');
        expect(t.card()).toContain('Skip this version');
        expect(t.pill()).toBe(true);
    });

    it('later hides the pill but never the card, and the choice is written in the history', async () => {
        const t = await boot({ manifest });
        t.u.later(1);
        expect(t.pill()).toBe(false);
        expect(t.card()).toContain('Update now');
        expect(t.card()).toContain('Reminders are paused until');
        expect(t.u._history().pop()).toMatchObject({ kind: 'later', version: '99.0.0' });
        t.u.undoChoice();
        expect(t.pill()).toBe(true);
    });

    it('skip applies to that version only: the next one is offered again', async () => {
        const t = await boot({ manifest });
        t.u.skip();
        expect(t.pill()).toBe(false);
        expect(t.card()).toContain('You skipped v99.0.0');
        const next = await boot({ manifest: { latest: '99.0.1' }, ls: Object.fromEntries(t.localStorage.store) });
        expect(next.pill()).toBe(true);
    });

    it('a required update cannot be skipped, can be postponed one day, and says it does not lock the app', async () => {
        const t = await boot({ manifest: { ...manifest, mandatory: ['99.0.0'] } });
        expect(t.card()).toContain('Install required update');
        expect(t.card()).toContain('You can keep using WealthFlow');
        expect(t.card()).not.toContain('Skip this version');
        expect(t.card()).not.toContain('In a week');
        t.u.skip();
        expect(t.pill()).toBe(true);
        t.u.later(7);
        expect(JSON.parse(t.localStorage.getItem('wf_update_choice')).days).toBe(1);
    });

    it('a halted version is offered to nobody', async () => {
        const t = await boot({ manifest: { ...manifest, halted: ['99.0.0'] } });
        expect(t.pill()).toBe(false);
        expect(t.card()).toContain('up to date');
    });

    it('while a staged rollout has not reached this device the pill stays quiet, the card explains, and install now anyway works', async () => {
        const t = await boot({ manifest: { ...manifest, rollout: { '99.0.0': 0 } } });
        expect(t.pill()).toBe(false);
        expect(t.card()).toContain('released in stages');
        expect(t.card()).toContain('Install now anyway');
        t.u.setEarly(true);       // early access does not override a rollout of 0, like a Play rollout at 0 percent
        expect(t.pill()).toBe(false);
    });

    it('early access puts the device first in a partial rollout', async () => {
        const t = await boot({ manifest: { ...manifest, rollout: { '99.0.0': 1 } }, ls: { wf_device_bucket: '50' } });
        expect(t.pill()).toBe(false);
        t.u.setEarly(true);
        expect(t.pill()).toBe(true);
    });

    it('a low-priority update stays in Settings and does not badge the app', async () => {
        const t = await boot({ manifest: { ...manifest, priority: { '99.0.0': 1 } } });
        expect(t.pill()).toBe(false);
        expect(t.card()).toContain('Update now');
    });
});

describe('everything since the version this device had', () => {
    it('what\'s new joins the notes of the releases in between instead of showing only the last', async () => {
        const manifest = { latest: '7.69.70', notes: { '7.69.67': note(['First fix']), '7.69.68': note(['Second fix']), '7.69.70': note(['Third fix']) } };
        const t = await boot({ manifest });
        t.u.whatsNew('7.69.70');
        const text = t.document.getElementById('wfWhatsNew').textContent;
        expect(text).toContain('Everything new since v7.69.66');
        expect(text).toContain('First fix');
        expect(text).toContain('Second fix');
        expect(text).toContain('Third fix');
        expect(text).toContain('3 updates');
    });
});

describe('the agreement and the download', () => {
    const manifest = { latest: '99.0.0', notes: { '99.0.0': note(['x']) } };
    it('the agreement is shown to a device that never accepted, and not again for the same minor line', async () => {
        const first = await boot({ manifest: { latest: '7.69.80' } });
        first.u.start();
        await vi.waitFor(() => expect(first.document.getElementById('wfEula')).toBeTruthy());
        const again = await boot({ manifest: { latest: '7.69.81' }, ls: { wf_update_eula_ok: '7.69' }, extra: { _verifyPinPrompt: async () => false } });
        await again.u.start();
        expect(again.document.getElementById('wfEula')).toBeFalsy();
        const newLine = await boot({ manifest: { latest: '7.70.0' }, ls: { wf_update_eula_ok: '7.69' } });
        newLine.u.start();
        await vi.waitFor(() => expect(newLine.document.getElementById('wfEula')).toBeTruthy());
    });

    it('scripts are downloaded with their validators so unchanged files cost a 304, the page document is reloaded', async () => {
        const log = [];
        const t = await boot({ manifest, ls: { wf_update_eula_ok: '99.0' }, fetchLog: log, html: '<script src="a.js"></script><script src="b.mjs"></script>', extra: { _verifyPinPrompt: async () => true } });
        t.u.start();
        await vi.waitFor(() => expect(log.some((c) => c.url === '/app')).toBe(true), { timeout: 4000 });
        expect(log.find((c) => c.url === 'a.js').cache).toBe('no-cache');
        expect(log.find((c) => c.url === 'b.mjs').cache).toBe('no-cache');
        expect(log.find((c) => c.url === '/app').cache).toBe('reload');
    });
});

describe('wifi only and install when idle', () => {
    it('install when idle does nothing while the person is busy, and waits on a metered connection when Wi-Fi only is on', async () => {
        const manifest = { latest: '99.0.0', notes: { '99.0.0': note(['x']) } };
        const t = await boot({ manifest });
        t.u.whenIdle();
        expect(await t.u._autoApplyIfChosen()).toBe(false);          // the person touched the app a moment ago
        t.u.setWifiOnly(true);
        expect(t.localStorage.getItem('wf_update_wifi_only')).toBe('1');
    });
});

describe('features that differ per device', () => {
    it('unknown features are on; a declared one follows version, channel, share and the person\'s switch', async () => {
        const manifest = { latest: '7.69.66', features: { beta_ai: { label: 'Beta AI', channel: 'early' }, new_chart: { label: 'Chart', default: false } } };
        const t = await boot({ manifest });
        expect(t.u.featureOn('never_declared')).toBe(true);
        expect(t.u.featureOn('beta_ai')).toBe(false);
        expect(t.u.featureOn('new_chart')).toBe(false);
        t.u.setEarly(true);
        expect(t.u.featureOn('beta_ai')).toBe(true);
        t.u.setFeature('new_chart', true);
        expect(t.u.featureOn('new_chart')).toBe(true);
        expect(t.card()).toContain('Features on this device');
    });
});
