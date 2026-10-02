import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

// "Passcode-free entry" used to apply only to the installed app and never in a browser tab, and the choice lived on one device. The owner's
// rule: signed in with Google, on ANY device, no passcode — an ON/OFF option that follows the account, off by default. These tests run the
// real functions out of index.html.
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    return html.slice(start, html.indexOf('\n        }', start) + 10);
}
function page({ auth = {}, local = {}, standalone = false } = {}) {
    const store = { ...local };
    const appData = { auth: { ...auth } };
    const context = vm.createContext({
        appData, notify: vi.fn(), launchApp: vi.fn(), resetAutoLockTimer: vi.fn(), showAuthView: vi.fn(), renderSettings: vi.fn(), pinMode: '',
        localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } },
        window: { navigator: { standalone }, matchMedia: () => ({ matches: standalone }) }, navigator: { standalone }, document: { referrer: '' },
        DB: { getObj: key => appData[key] || {}, set: vi.fn((key, value) => { appData[key] = value; }) },
    });
    for (const name of ['_isStandaloneApp', '_skipLockEnabled', '_canSkipEntryLock', '_bootEnterWithPin', 'toggleSkipLock']) vm.runInContext(source(name), context);
    return { context, store, appData };
}

describe('passcode-free entry', () => {
    it('is off by default: the passcode screen is shown, in a browser and in the installed app alike', () => {
        for (const standalone of [false, true]) {
            const { context } = page({ auth: { pin: 'hash' }, standalone });
            expect(context._canSkipEntryLock()).toBe(false);
            expect(context._bootEnterWithPin()).toBe(false);
            expect(context.launchApp).not.toHaveBeenCalled();
            expect(context.showAuthView).toHaveBeenCalledWith('authLogin');
        }
    });
    it('on, it opens straight to the dashboard on ANY device — a plain browser tab included', () => {
        for (const standalone of [false, true]) {
            const { context } = page({ auth: { pin: 'hash', skipLock: true }, standalone });
            expect(context._canSkipEntryLock()).toBe(true);
            expect(context._bootEnterWithPin()).toBe(true);
            expect(context.launchApp).toHaveBeenCalledTimes(1);
            expect(context.showAuthView).not.toHaveBeenCalled();
        }
    });
    it('follows the account: a device with no flag of its own enters because the account says so', () => {
        const { context, store } = page({ auth: { pin: 'hash', skipLock: true } });
        expect(store.wf2_skip_lock).toBeUndefined();
        expect(context._skipLockEnabled()).toBe(true);
    });
    it('the account decides when it has said something: an explicit OFF beats a stale local ON, an explicit ON beats a missing local flag', () => {
        expect(page({ auth: { pin: 'hash', skipLock: false }, local: { wf2_skip_lock: '1' } }).context._skipLockEnabled()).toBe(false);
        expect(page({ auth: { pin: 'hash', skipLock: true }, local: {} }).context._skipLockEnabled()).toBe(true);
    });
    it('a device that predates the account setting keeps the flag it already had', () => {
        expect(page({ auth: { pin: 'hash' }, local: { wf2_skip_lock: '1' } }).context._skipLockEnabled()).toBe(true);
    });
    it('turning it ON writes it to the account and the device, and leaves the PIN exactly as it was', () => {
        const { context, store, appData } = page({ auth: { pin: 'hash', secQ: 'q' } });
        context.toggleSkipLock(true);
        expect(appData.auth).toEqual({ pin: 'hash', secQ: 'q', skipLock: true });
        expect(store.wf2_skip_lock).toBe('1');
        expect(context.DB.set).toHaveBeenCalledWith('auth', expect.objectContaining({ pin: 'hash', skipLock: true }));
        expect(context.notify.mock.calls[0][0]).toMatch(/every device/);
    });
    it('turning it OFF is an explicit false (a stale true on another device must lose), the device flag goes, the PIN stays', () => {
        const { context, store, appData } = page({ auth: { pin: 'hash', skipLock: true }, local: { wf2_skip_lock: '1' } });
        context.toggleSkipLock(false);
        expect(appData.auth).toEqual({ pin: 'hash', skipLock: false });
        expect(store.wf2_skip_lock).toBeUndefined();
        expect(context._canSkipEntryLock()).toBe(false);
        expect(context._bootEnterWithPin()).toBe(false);
    });
});

describe('the settings row and the boot paths', () => {
    it('says what the option does on any device, how to turn it off, and what stays protected — and no longer says "installed app only"', () => {
        expect(html).not.toContain('Passcode-free entry (installed app only)');
        expect(html).not.toContain("it takes effect once you open the installed app");
        expect(html).toMatch(/Passcode-free entry<\/div>\s*<div class="setting-desc">Signed in with Google\? Open straight to your dashboard on <b>any device<\/b>/);
        expect(html).toMatch(/Anyone who can open WealthFlow on a device that is signed in to your Google account will see your data/);
        expect(html).toMatch(/passcode still protects the vault and Change PIN/);
    });
    it('every route that would show the passcode screen to a signed-in user goes through the one chokepoint', () => {
        const route = source('_wfRouteToPinScreen');
        expect(route).toMatch(/r === 'found'\) \{ _wfPinRouting = false; _bootEnterWithPin\(\); return; \}/);
        expect(route).not.toMatch(/r === 'found'\) \{[^}]*showAuthView\('authLogin'\)/);
    });
});
