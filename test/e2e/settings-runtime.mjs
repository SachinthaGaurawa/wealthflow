/** Real-browser regression for every Settings switch and select. */
import { bootApp } from './harness.mjs';

const app = await bootApp({ repoDir: process.cwd(), headless: true });
const failures = [];

try {
    await app.page.evaluate(() => showPage('settings'));
    await app.page.waitForSelector('#settingsContent .toggle[data-setting]', { state: 'visible' });

    const toggleResults = await app.page.evaluate(async () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 40));
        const keys = [...new Set([...document.querySelectorAll('#settingsContent .toggle[data-setting]')]
            .map((el) => el.dataset.setting))];
        const results = [];
        for (const key of keys) {
            const controls = () => [...document.querySelectorAll(`#settingsContent .toggle[data-setting="${key}"]`)];
            const first = controls()[0];
            const anchor = document.querySelector('#settingsContent .settings-section');
            const before = first.classList.contains('on');
            const beforeWindowY = window.scrollY;
            const main = document.querySelector('.main');
            const beforeMainY = main ? main.scrollTop : 0;
            first.click();
            await pause();
            const after = controls().map((el) => ({ on: el.classList.contains('on'), aria: el.getAttribute('aria-checked') }));
            const stored = DB.getObj('settings', {})[key];
            const changed = key === 'theme' ? stored === (before ? 'light' : 'dark') : stored === !before;
            const synced = after.length > 0 && after.every((x) => x.on === !before && x.aria === String(!before));
            const stable = anchor.isConnected && window.scrollY === beforeWindowY && (!main || main.scrollTop === beforeMainY);
            controls()[0].click();
            await pause();
            const restored = controls().every((el) => el.classList.contains('on') === before);
            results.push({ key, changed, synced, stable, restored, copies: after.length });
        }
        return results;
    });

    for (const row of toggleResults) {
        for (const prop of ['changed', 'synced', 'stable', 'restored']) {
            if (!row[prop]) failures.push(`toggle ${row.key}: ${prop}=false`);
        }
    }

    const selectResults = await app.page.evaluate(async () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 30));
        const selects = [...document.querySelectorAll('#settingsContent select[onchange*="toggleSetting"]')];
        const out = [];
        for (const select of selects) {
            const handler = select.getAttribute('onchange') || '';
            const key = (handler.match(/toggleSetting\('([^']+)'/) || [])[1];
            if (!key || select.options.length < 2) continue;
            const anchor = document.querySelector('#settingsContent .settings-section');
            const oldIndex = select.selectedIndex;
            const nextIndex = oldIndex === select.options.length - 1 ? 0 : oldIndex + 1;
            select.selectedIndex = nextIndex;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await pause();
            const expectedRaw = select.value;
            const expected = /parseInt|parseFloat/.test(handler) ? Number(expectedRaw) : expectedRaw;
            const changed = DB.getObj('settings', {})[key] === expected;
            const stable = anchor.isConnected;
            select.selectedIndex = oldIndex;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            await pause();
            out.push({ key, changed, stable });
        }
        return out;
    });

    for (const row of selectResults) {
        if (!row.changed) failures.push(`select ${row.key}: stored value did not change`);
        if (!row.stable) failures.push(`select ${row.key}: Settings DOM was rebuilt`);
    }

    const accessResults = await app.page.evaluate(async () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
        const anchor = document.querySelector('#settingsContent .settings-section');
        const original = _skipLockEnabled();
        _applySkipLock(!original);
        await pause();
        const button = document.getElementById('skipLockToggle');
        const changed = _skipLockEnabled() === !original;
        const synced = !!button
            && button.textContent.trim() === (!original ? 'ON' : 'OFF')
            && button.getAttribute('aria-pressed') === String(!original);
        const stable = anchor.isConnected;
        _applySkipLock(original);
        await pause();
        const restored = _skipLockEnabled() === original
            && anchor.isConnected
            && document.getElementById('skipLockToggle') === button;
        return { changed, synced, stable, restored };
    });

    for (const prop of ['changed', 'synced', 'stable', 'restored']) {
        if (!accessResults[prop]) failures.push(`passcode-free entry: ${prop}=false`);
    }

    const extendedResults = await app.page.evaluate(async () => {
        const pause = () => new Promise((resolve) => setTimeout(resolve, 60));
        const anchor = document.querySelector('#settingsContent .settings-section');

        const autoLock = document.querySelector('#settingsContent select[onchange*="updateAutoLock"]');
        const oldLockIndex = autoLock.selectedIndex;
        autoLock.selectedIndex = oldLockIndex === autoLock.options.length - 1 ? 0 : oldLockIndex + 1;
        autoLock.dispatchEvent(new Event('change', { bubbles: true }));
        await pause();
        const autoLockChanged = DB.getObj('settings', {}).autoLock === Number(autoLock.value);
        const autoLockStable = anchor.isConnected;
        autoLock.selectedIndex = oldLockIndex;
        autoLock.dispatchEvent(new Event('change', { bubbles: true }));
        await pause();

        const notif = [];
        const notifKeys = ['enabled', 'urgent', 'dueSoon', 'cheques', 'ccOneTime', 'loans', 'subs', 'ccInstall'];
        for (const key of notifKeys) {
            const button = document.getElementById(`wfntfTgl_${key}`);
            const before = button.classList.contains('on');
            button.click();
            await pause();
            const changed = DB.getObj('settings', {}).notif[key] === !before;
            const synced = button.classList.contains('on') === !before
                && button.getAttribute('aria-checked') === String(!before);
            const stable = anchor.isConnected && document.getElementById(`wfntfTgl_${key}`) === button;
            button.click();
            await pause();
            const restored = button.classList.contains('on') === before;
            notif.push({ key, changed, synced, stable, restored });
        }

        const security = document.getElementById('wfAutoSec');
        const securityBefore = security.classList.contains('on');
        security.click();
        await pause();
        const securityChanged = localStorage.getItem('wf_auto_security') === (!securityBefore ? '1' : '0');
        const securitySynced = security.classList.contains('on') === !securityBefore
            && security.getAttribute('aria-checked') === String(!securityBefore);
        const securityStable = anchor.isConnected && document.getElementById('wfAutoSec') === security;
        security.click();
        await pause();
        const securityRestored = security.classList.contains('on') === securityBefore;

        openScannerSettings();
        await pause();
        const scanner = [];
        for (const [id, key] of [
            ['scanTfToggle', 'scanTfEnhance'],
            ['scanAutoEscToggle', 'scanAutoEscalate'],
            ['scanAutoCatToggle', 'scanAutoCategory'],
        ]) {
            const control = document.getElementById(id);
            const before = control.classList.contains('on');
            control.click();
            await pause();
            const changed = DB.getObj('settings', {})[key] === !before;
            const synced = control.classList.contains('on') === !before
                && control.getAttribute('aria-checked') === String(!before);
            const stable = anchor.isConnected && document.getElementById(id) === control;
            control.click();
            await pause();
            scanner.push({ key, changed, synced, stable, restored: control.classList.contains('on') === before });
        }

        const oldMode = DB.getObj('settings', {}).scanMode || 'deep';
        const newMode = oldMode === 'quick' ? 'deep' : 'quick';
        document.querySelector(`.scan-mode-card[data-mode="${newMode}"]`).click();
        await pause();
        const modeChanged = DB.getObj('settings', {}).scanMode === newMode
            && document.querySelector(`.scan-mode-card[data-mode="${newMode}"]`).classList.contains('active');
        document.querySelector(`.scan-mode-card[data-mode="${oldMode}"]`).click();
        await pause();
        const modeRestored = DB.getObj('settings', {}).scanMode === oldMode;

        const currency = document.getElementById('scanCurrencySel');
        const oldCurrency = currency.value;
        currency.selectedIndex = currency.selectedIndex === currency.options.length - 1 ? 0 : currency.selectedIndex + 1;
        currency.dispatchEvent(new Event('change', { bubbles: true }));
        await pause();
        const currencyChanged = DB.getObj('settings', {}).scanCurrency === currency.value;
        currency.value = oldCurrency;
        currency.dispatchEvent(new Event('change', { bubbles: true }));
        await pause();
        const currencyRestored = DB.getObj('settings', {}).scanCurrency === oldCurrency;
        closeModal('mdScannerSettings');

        return {
            autoLock: { changed: autoLockChanged, stable: autoLockStable },
            notif,
            security: { changed: securityChanged, synced: securitySynced, stable: securityStable, restored: securityRestored },
            scanner,
            scanMode: { changed: modeChanged, stable: anchor.isConnected, restored: modeRestored },
            scanCurrency: { changed: currencyChanged, stable: anchor.isConnected, restored: currencyRestored },
        };
    });

    for (const prop of ['changed', 'stable']) {
        if (!extendedResults.autoLock[prop]) failures.push(`auto-lock: ${prop}=false`);
    }
    for (const row of extendedResults.notif) {
        for (const prop of ['changed', 'synced', 'stable', 'restored']) {
            if (!row[prop]) failures.push(`notification ${row.key}: ${prop}=false`);
        }
    }
    for (const prop of ['changed', 'synced', 'stable', 'restored']) {
        if (!extendedResults.security[prop]) failures.push(`auto security: ${prop}=false`);
    }
    for (const row of extendedResults.scanner) {
        for (const prop of ['changed', 'synced', 'stable', 'restored']) {
            if (!row[prop]) failures.push(`scanner ${row.key}: ${prop}=false`);
        }
    }
    for (const [name, result] of [['scan mode', extendedResults.scanMode], ['scan currency', extendedResults.scanCurrency]]) {
        for (const prop of ['changed', 'stable', 'restored']) {
            if (!result[prop]) failures.push(`${name}: ${prop}=false`);
        }
    }

    const keyboard = await app.page.evaluate(async () => {
        const el = document.querySelector('[data-setting="smartExpenseSuggest"]');
        const before = el.classList.contains('on');
        el.focus();
        return { before };
    });
    await app.page.keyboard.press('Space');
    await app.page.waitForTimeout(60);
    const keyboardAfter = await app.page.locator('[data-setting="smartExpenseSuggest"]').first()
        .evaluate((el) => el.classList.contains('on'));
    if (keyboardAfter === keyboard.before) failures.push('keyboard Space did not operate a Settings switch');
    await app.page.keyboard.press('Space');

    if (app.pageErrors.length) failures.push(...app.pageErrors.map((x) => `page error: ${x}`));
    const realConsoleErrors = app.consoleErrors.filter((x) => !/Failed to load resource|ERR_/i.test(x));
    if (realConsoleErrors.length) failures.push(...realConsoleErrors.map((x) => `console error: ${x}`));

    console.log(JSON.stringify({
        toggles: toggleResults,
        selects: selectResults,
        passcodeFree: accessResults,
        extended: extendedResults,
        keyboard: { changed: keyboardAfter !== keyboard.before },
        failures,
    }, null, 2));
    if (failures.length) process.exitCode = 1;
} finally {
    await app.close();
}
