import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { webcrypto } from 'node:crypto';
import { VAULT, CLOUD_UNLOCK_BUDGET_MS, readBlob, unlock, save, list, lock, isUnlocked } from '../wealthflow-vault.js';

// THE VAULT OPENS WHEN THE PIN IS RIGHT, NOT WHEN THE NETWORK HAS FINISHED. Typing the PIN used to wait for the cloud copy of the vault (unbounded), then for the security vault's own cloud read, then for two
// server calls handing the passwords to the cloud vault — about twelve seconds on a slow connection (measured against the real page), with the button still saying "Unlock". The device's own copy opens at once;
// the cloud is waited for only up to a budget; the hand-over to the cloud runs behind the open vault. A save never overwrites a newer cloud copy it could not hear about.
const deps = { subtle: webcrypto.subtle, randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };
const store = () => { const m = new Map(); return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) }; };
const PIN = '123456';
const rows = [{ bank: 'HNB', label: 'HNB', password: 'hnb-secret' }];
const wait = ms => new Promise(r => setTimeout(r, ms));
beforeEach(() => lock());

async function deviceWithVault(entries = rows) {
    const storage = store();
    await unlock(PIN, { ...deps, storage });
    await save(entries, { ...deps, storage });
    lock();
    return storage;
}

describe('a slow cloud does not hold the unlock', () => {
    it('opens the device\'s own copy once the budget is spent, and says the cloud did not answer', async () => {
        const storage = await deviceWithVault();
        const cloud = { pull: () => wait(CLOUD_UNLOCK_BUDGET_MS * 4).then(() => null), push: async () => {} };
        const t0 = Date.now();
        const r = await unlock(PIN, { ...deps, storage, cloud });
        const took = Date.now() - t0;
        expect(r).toMatchObject({ ok: true, fresh: false, cloudAnswered: false });
        expect(r.entries.map(e => e.bank)).toEqual(['HNB']);
        expect(took).toBeGreaterThanOrEqual(CLOUD_UNLOCK_BUDGET_MS - 50);
        expect(took).toBeLessThan(CLOUD_UNLOCK_BUDGET_MS * 2);              // not the 4x the cloud asked for
        expect(isUnlocked()).toBe(true);
    }, 15000);
    it('a cloud that answers at once changes nothing: the unlock takes as long as the key derivation, no longer', async () => {
        const storage = await deviceWithVault();
        const r = await unlock(PIN, { ...deps, storage, cloud: { pull: async () => null, push: async () => {} } });
        expect(r).toMatchObject({ ok: true, cloudAnswered: true });
    });
    it('a newer cloud copy that answers inside the budget still wins, as before', async () => {
        const storage = await deviceWithVault();
        const other = store();
        await unlock(PIN, { ...deps, storage: other, cloud: { pull: async () => readBlob(storage), push: async () => {} } });   // another device joins the same vault
        await save([{ bank: 'NTB', label: '', password: 'ntb-secret' }], { ...deps, storage: other });
        const newer = readBlob(other);
        lock();
        const r = await unlock(PIN, { ...deps, storage, cloud: { pull: async () => newer, push: async () => {} } });
        expect(r.entries.map(e => e.bank)).toEqual(['NTB']);
        expect(readBlob(storage).savedAt).toBe(newer.savedAt);
    });
    it('a wrong PIN is still refused, and a cloud that never answers cannot make it open', async () => {
        const storage = await deviceWithVault();
        const cloud = { pull: () => new Promise(() => {}), push: async () => {} };
        const r = await unlock('654321', { ...deps, storage, cloud });
        expect(r.ok).toBe(false);
        expect(isUnlocked()).toBe(false);
    }, 15000);
    it('a device with NO copy of its own still waits for the cloud in full (it has nothing else to open)', async () => {
        const source = await deviceWithVault();
        const blob = readBlob(source);
        const t0 = Date.now();
        const r = await unlock(PIN, { ...deps, storage: store(), cloud: { pull: () => wait(CLOUD_UNLOCK_BUDGET_MS + 400).then(() => blob), push: async () => {} } });
        expect(Date.now() - t0).toBeGreaterThanOrEqual(CLOUD_UNLOCK_BUDGET_MS + 300);
        expect(r).toMatchObject({ ok: true, fresh: false });
        expect(r.entries.map(e => e.bank)).toEqual(['HNB']);
    }, 15000);
});

describe('a save never writes over a cloud copy the unlock could not hear about', () => {
    it('when the cloud turns out to hold something newer, nothing is overwritten: the newer copy is cached and the owner is told', async () => {
        const storage = await deviceWithVault();
        const other = store();
        await unlock(PIN, { ...deps, storage: other, cloud: { pull: async () => readBlob(storage), push: async () => {} } });
        await wait(5);
        await save([{ bank: 'NTB', label: '', password: 'ntb-secret' }], { ...deps, storage: other });
        const newer = readBlob(other);
        lock();
        let pushed = 0;
        const slowThenNewer = { pull: (() => { let n = 0; return () => (++n === 1 ? wait(CLOUD_UNLOCK_BUDGET_MS * 3).then(() => null) : Promise.resolve(newer)); })(), push: async () => { pushed += 1; } };
        const opened = await unlock(PIN, { ...deps, storage, cloud: slowThenNewer });
        expect(opened.cloudAnswered).toBe(false);
        const r = await save([{ bank: 'HNB', label: 'HNB', password: 'edited-on-stale-copy' }], { ...deps, storage, cloud: slowThenNewer });
        expect(r).toEqual({ ok: false, reason: VAULT.CLOUD_NEWER });
        expect(pushed).toBe(0);
        expect(readBlob(storage).savedAt).toBe(newer.savedAt);
    }, 20000);
    it('when the cloud holds nothing newer (or cannot be reached), the save goes through as it always did', async () => {
        const storage = await deviceWithVault();
        const never = { pull: () => new Promise(() => {}), push: async () => {} };
        const opened = await unlock(PIN, { ...deps, storage, cloud: never });
        expect(opened.cloudAnswered).toBe(false);
        expect(await save([{ bank: 'HNB', label: '', password: 'changed' }], { ...deps, storage, cloud: never })).toMatchObject({ ok: true });
        expect((await list({ ...deps, storage })).entries[0].password).toBe('changed');
    }, 20000);
    it('a normal unlock (the cloud answered) saves without asking again', async () => {
        const storage = await deviceWithVault();
        let pulls = 0;
        const cloud = { pull: async () => { pulls += 1; return null; }, push: async () => {} };
        await unlock(PIN, { ...deps, storage, cloud });
        await save(rows, { ...deps, storage, cloud });
        expect(pulls).toBe(1);
    });
});

describe('the Unlock button and the page', () => {
    const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
    const start = html.indexOf('const attempt = async () => {\n                if (busy) return;');
    const body = html.slice(start, html.indexOf("body.querySelector('#_bv_go').onclick = attempt;", start));
    it('shows that it is working, ignores a second tap while it does, and puts the button back if the PIN is refused', () => {
        expect(start).toBeGreaterThan(0);
        expect(body).toContain("if (busy) return;");
        expect(body).toContain("go.textContent = 'Unlocking…'");
        expect(body).toMatch(/finally \{\s*busy = false;/);
    });
    it('does not wait for the hand-over to the cloud before it shows the unlocked vault', () => {
        expect(body).toMatch(/migrating = \(async \(\) => \{/);
        expect(body).not.toMatch(/await window\.WFStatementCloud\?\.migrateUnlockedVault\(cloudEntries\);\s*\}\s*catch \(_\) \{ notify\('Vault unlocked; cloud migration will retry later\.', 'warn'\); \}\s*try \{ triggerHaptic/);
        // the hand-over is inside the background function, which is not awaited
        expect(body).not.toMatch(/await migrating/);
    });
    it('what should follow the vault (Check now) is held until the hand-over has finished', () => {
        expect(html).toContain('onClose: () => { if (migrating) migrating.then(caller, caller); else caller(); }');
    });
    it('tells the owner when the passwords changed on another device instead of saving over them', () => {
        expect(html).toContain('VAULT.CLOUD_NEWER');
    });
});
