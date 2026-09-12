/* =============================================================================
 * test/security_vault_sync_test.js
 * -----------------------------------------------------------------------------
 * The owner: passwords saved into the Security Vault (NIC / DOB / card last-4,
 * used to auto-unlock locked bank-statement PDFs) on one device were invisible
 * on every other device signed into the same account — this vault's own
 * encryption key (`_deviceSecret()`) used to be a random value generated
 * per-device and never shared, so even copying the ciphertext by hand would
 * not have helped; a different device had no way to derive the same key.
 *
 * The fix syncs the key AND the ciphertext together, as one pair, through the
 * optional `window._wfVaultCloud` seam (`{pull, push}`, wired to Firestore in
 * index.html). They must always move together — a key from one device paired
 * with another device's ciphertext simply fails to decrypt — so these tests
 * check that a fresh "device" (empty localStorage) sharing only the same fake
 * cloud can read what another device saved, that the newer of two devices'
 * saves always wins, and that the module still works exactly as before when
 * no cloud is wired at all.
 *
 * The whole file is one browser IIFE (wealthflow-intelligence.js), evaluated
 * here via `new Function` against a minimal window/localStorage — the same
 * approach test/pdf_unlock_vault_test.js already uses for its sibling module,
 * so the REAL code runs, not a reimplementation of it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-intelligence.js'), 'utf8');

function fakeStorage() {
    const m = new Map();
    return {
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
}

function fakeCloud() {
    let doc = null;
    return {
        pull: async () => doc,
        push: async (payload) => { doc = payload; },
        _peek: () => doc,
    };
}

/** One fresh "device": its own localStorage, sharing only `cloud` with others. */
function loadDevice(cloud) {
    const storage = fakeStorage();
    const win = {
        DB: { get: () => [], getObj: () => ({}), set() {} },
        notify() {},
        _wfVaultCloud: cloud,
    };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'console', 'localStorage', SRC)(win, {}, console, storage);
    return { wfVault: win.wfVault, storage };
}

describe('the module this file depends on still exports what these tests need', () => {
    it('window.wfVault has save/get/clear/exists/syncFromCloud', () => {
        const { wfVault } = loadDevice(null);
        for (const fn of ['save', 'get', 'exists', 'clear', 'syncFromCloud']) {
            expect(typeof wfVault[fn], fn).toBe('function');
        }
    });
});

describe('with no cloud wired, behaves exactly as it always did (device-local)', () => {
    it('round-trips through this device only', async () => {
        const { wfVault } = loadDevice(null);
        expect(await wfVault.get()).toBe(null);
        await wfVault.save({ nic: '199012345678', dob: '1990-07-07', last4: ['1234'] });
        const v = await wfVault.get();
        expect(v.nic).toBe('199012345678');
        expect(v.dob).toBe('1990-07-07');
        expect(v.last4).toEqual(['1234']);
    });
});

describe('cross-device sync via window._wfVaultCloud', () => {
    it('a second device, with empty local storage, reads what the first device saved', async () => {
        const cloud = fakeCloud();
        const deviceA = loadDevice(cloud);
        await deviceA.wfVault.save({ nic: '199012345678', dob: '1990-07-07', last4: [] });

        const deviceB = loadDevice(cloud); // fresh localStorage, same cloud
        expect(deviceB.wfVault.exists(), 'device B has not synced yet').toBe(false);
        const v = await deviceB.wfVault.get(); // get() syncs first, then reads
        expect(v, "device B could not read device A's vault").not.toBe(null);
        expect(v.nic).toBe('199012345678');
        expect(deviceB.wfVault.exists(), 'device B did not cache the synced copy locally').toBe(true);
    });

    it('pushes the key and the ciphertext together, never one without the other', async () => {
        const cloud = fakeCloud();
        const { wfVault } = loadDevice(cloud);
        await wfVault.save({ nic: '199012345678', dob: '', last4: [] });
        const pushed = cloud._peek();
        expect(pushed.dk, 'the device key was not pushed').toBeTruthy();
        expect(pushed.enc, 'the ciphertext was not pushed').toBeTruthy();
        expect(pushed.enc.ct).toBeTruthy();
        // Nothing readable in what crosses the wire.
        expect(JSON.stringify(pushed)).not.toContain('199012345678');
    });

    it('whichever device saved LAST wins, not whichever device asks first', async () => {
        const cloud = fakeCloud();
        const deviceA = loadDevice(cloud);
        await deviceA.wfVault.save({ nic: '111111111111', dob: '', last4: [] });

        await new Promise((r) => setTimeout(r, 2)); // distinct updatedAt
        const deviceB = loadDevice(cloud);
        await deviceB.wfVault.save({ nic: '222222222222', dob: '', last4: [] });

        // Device A asks again — its own local copy is now the stale one.
        const v = await deviceA.wfVault.get();
        expect(v.nic, "device A's stale local copy was not replaced by the newer cloud one").toBe('222222222222');
    });

    it('a fresh device seeds the cloud from an EXISTING local vault (pre-sync upgrade path)', async () => {
        // Simulates the owner's actual situation: a vault saved on the phone
        // before this sync feature existed, cloud has nothing yet.
        const cloud = fakeCloud();
        const phone = loadDevice(null); // saved with no cloud wired at all
        await phone.wfVault.save({ nic: '333333333333', dob: '', last4: [] });

        // Now the app is updated: the SAME device's next read/write sees the
        // cloud seam for the first time and should seed it.
        const phoneAfterUpdate = { wfVault: null };
        const win2 = { DB: { get: () => [], getObj: () => ({}), set() {} }, notify() {}, _wfVaultCloud: cloud };
        // eslint-disable-next-line no-new-func
        new Function('window', 'document', 'console', 'localStorage', SRC)(win2, {}, console, phone.storage);
        phoneAfterUpdate.wfVault = win2.wfVault;

        await phoneAfterUpdate.wfVault.get(); // triggers the one-time seed
        expect(cloud._peek(), 'the existing local vault was never seeded to the cloud').toBeTruthy();

        const laptop = loadDevice(cloud);
        const v = await laptop.wfVault.get();
        expect(v.nic, 'a second device could not read the seeded vault').toBe('333333333333');
    });

    it('a pull failure (offline) still reads whatever is on this device', async () => {
        const flakyCloud = { pull: async () => { throw new Error('offline'); }, push: async () => {} };
        const { wfVault } = loadDevice(flakyCloud);
        await wfVault.save({ nic: '444444444444', dob: '', last4: [] });
        const v = await wfVault.get();
        expect(v.nic).toBe('444444444444');
    });

    it('a push failure (offline) does not fail the local save', async () => {
        const flakyCloud = { pull: async () => null, push: async () => { throw new Error('offline'); } };
        const { wfVault } = loadDevice(flakyCloud);
        await expect(wfVault.save({ nic: '555555555555', dob: '', last4: [] })).resolves.toBe(true);
        expect(wfVault.exists()).toBe(true);
    });

    it('clear() propagates to another device syncing afterward', async () => {
        const cloud = fakeCloud();
        const deviceA = loadDevice(cloud);
        await deviceA.wfVault.save({ nic: '666666666666', dob: '', last4: [] });

        const deviceB = loadDevice(cloud);
        expect((await deviceB.wfVault.get()).nic).toBe('666666666666');

        await new Promise((r) => setTimeout(r, 2));
        deviceA.wfVault.clear();
        await new Promise((r) => setTimeout(r, 0)); // let the fire-and-forget push land

        const deviceC = loadDevice(cloud);
        const v = await deviceC.wfVault.get();
        expect(v, 'a device syncing after clear() still saw the deleted vault').toBe(null);
    });
});
