/* =============================================================================
 * test/vault_test.js
 * -----------------------------------------------------------------------------
 * This vault holds bank passwords, so the tests are mostly about the ways a
 * password store fails QUIETLY — the failures that leave a working-looking app
 * with the secret exposed, rather than an error anybody would notice.
 *
 * Four of them matter more than the rest:
 *
 *   1. The key must come from the PIN, not from anything on disk. The vault this
 *      one sits beside derives its key from a random value kept in localStorage
 *      right next to the ciphertext, so anything that can read storage has both
 *      halves. That is a defensible trade for a NIC; it is not one for a bank
 *      password. There is a test that the ciphertext cannot be opened without
 *      the PIN, and one that the salt alone does not open it.
 *
 *   2. The IV must never repeat under one key. AES-GCM does not forgive it: two
 *      messages under the same key and IV leak the XOR of their plaintexts and
 *      the authentication breaks outright. Since the salt is deliberately reused
 *      across saves so the key can stay cached, the IV is the only thing keeping
 *      successive saves apart — so it is checked directly.
 *
 *   3. Nothing may reach appData. Every record there goes through DB.set, which
 *      writes localStorage AND pushes to Firestore. One DB.set in this module
 *      would upload every password in it. Asserted against the file's own text.
 *
 *   4. A wrong PIN must be a reason, not an exception, and must look exactly
 *      like a corrupted blob. Distinguishing them tells an attacker which
 *      guesses were structurally valid.
 *
 * WHAT THESE TESTS DO NOT COVER
 *
 * The strength of PBKDF2 at 310,000 rounds, which is a property of the algorithm
 * and the platform rather than of this file. What is checked is that the
 * iteration count is actually passed through and not quietly lowered — the
 * common way a KDF ends up weak.
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import { webcrypto } from 'node:crypto';
import V, {
    STORE_KEY, KDF, VAULT, MIN_PIN,
    normaliseEntry, normaliseAll, deriveKey, seal, openSealed, candidatesFor,
    isSet, readBlob, writeBlob, destroy, newSalt,
    unlock, lock, isUnlocked, list, save, _resetSession,
} from '../wealthflow-vault.js';

const deps = { subtle: webcrypto.subtle, randomBytes: (n) => webcrypto.getRandomValues(new Uint8Array(n)) };

/* A localStorage that is just a Map, so nothing here can touch a real one. */
function fakeStore() {
    const m = new Map();
    return {
        _m: m,
        getItem: (k) => (m.has(k) ? m.get(k) : null),
        setItem: (k, v) => m.set(k, String(v)),
        removeItem: (k) => m.delete(k),
    };
}

const PIN = '123456';
const entries = [
    { bank: 'HNB', label: 'Statement PDF', password: 'hnb-Secret#2026' },
    { bank: 'DFCC', label: '', password: 'dfcc pass with spaces ' },
];

beforeEach(() => _resetSession());

/* ═══════════════════════════════════════════════════════════════════════════
 * THE KEY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the key comes from the PIN and from nothing on disk', () => {
    it('cannot open the ciphertext without the PIN', async () => {
        /* THE POINT OF THIS FILE. The stored blob carries the salt, the IV and
         * the ciphertext — everything except the one thing that matters. */
        const salt = newSalt(deps);
        const key = await deriveKey(PIN, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), deps);
        const blob = await seal(key, entries, salt, deps);

        const wrong = await deriveKey('999999', Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), deps);
        const out = await openSealed(wrong, blob, deps);
        expect(out.ok).toBe(false);
        expect(out.reason).toBe(VAULT.WRONG_PIN);
        expect(out.entries).toEqual([]);
    });

    it('does not put the password, or anything readable, in the stored blob', async () => {
        const salt = newSalt(deps);
        const key = await deriveKey(PIN, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), deps);
        const blob = await seal(key, entries, salt, deps);
        const text = JSON.stringify(blob);
        for (const secret of ['hnb-Secret#2026', 'dfcc pass with spaces', 'HNB', 'DFCC']) {
            expect(text, `"${secret}" is readable in the stored blob`).not.toContain(secret);
        }
    });

    it('refuses a PIN shorter than the app itself accepts', async () => {
        expect(MIN_PIN).toBe(6);
        expect(await deriveKey('12345', new Uint8Array(16), deps)).toBe(null);
        expect(await deriveKey('', new Uint8Array(16), deps)).toBe(null);
        expect(await deriveKey(null, new Uint8Array(16), deps)).toBe(null);
    });

    it('gives different vaults different keys for the same PIN', async () => {
        /* Two installs with the same PIN must not produce the same key, or one
         * cracked device would open the other. That is what the salt is for. */
        const a = newSalt(deps);
        const b = newSalt(deps);
        expect(a).not.toBe(b);
        const ka = await deriveKey(PIN, Uint8Array.from(atob(a), (c) => c.charCodeAt(0)), deps);
        const blobA = await seal(ka, entries, a, deps);
        const kb = await deriveKey(PIN, Uint8Array.from(atob(b), (c) => c.charCodeAt(0)), deps);
        // Same PIN, other salt: must not open A's ciphertext.
        expect((await openSealed(kb, blobA, deps)).ok).toBe(false);
    });

    it('actually passes the iteration count through', async () => {
        // A KDF quietly dropped to a low count still "works", which is why the
        // number is asserted rather than assumed.
        expect(KDF.ITERATIONS).toBeGreaterThanOrEqual(310000);
        expect(KDF.HASH).toBe('SHA-256');
        let seenIterations = null;
        const spy = {
            subtle: {
                importKey: (...a) => webcrypto.subtle.importKey(...a),
                deriveKey: (algo, ...rest) => { seenIterations = algo.iterations; return webcrypto.subtle.deriveKey(algo, ...rest); },
            },
        };
        await deriveKey(PIN, new Uint8Array(16), spy);
        expect(seenIterations).toBe(KDF.ITERATIONS);
    });

    it('derives a key that cannot be read back out of the page', async () => {
        // Non-extractable: even code running here cannot export it.
        const key = await deriveKey(PIN, new Uint8Array(16), deps);
        expect(key.extractable).toBe(false);
        await expect(webcrypto.subtle.exportKey('raw', key)).rejects.toBeTruthy();
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE IV
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('every save gets its own IV', () => {
    it('never repeats an IV across saves under one key', async () => {
        /* THE ONE AES-GCM DOES NOT FORGIVE. The salt is reused on purpose so the
         * key can stay cached; that makes the IV the only thing separating two
         * saves, and a fixed IV would leak the XOR of the two plaintexts. */
        const salt = newSalt(deps);
        const key = await deriveKey(PIN, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), deps);
        const ivs = new Set();
        for (let i = 0; i < 40; i += 1) {
            const b = await seal(key, entries, salt, deps);
            ivs.add(b.iv);
        }
        expect(ivs.size, 'an IV was reused under the same key').toBe(40);
    });

    it('uses a 96-bit IV, the size AES-GCM is specified for', async () => {
        expect(KDF.IV_BYTES).toBe(12);
        const salt = newSalt(deps);
        const key = await deriveKey(PIN, Uint8Array.from(atob(salt), (c) => c.charCodeAt(0)), deps);
        const b = await seal(key, entries, salt, deps);
        expect(atob(b.iv).length).toBe(12);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NOTHING REACHES THE CLOUD
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a password can never take the synced path', () => {
    it('never calls DB.set, which would upload it', async () => {
        /* Every record in appData is written by DB.set, which persists locally
         * AND pushes to Firestore. One of those in this module would put every
         * bank password in the sync document. */
        const fs = await import('node:fs');
        const path = await import('node:path');
        const raw = fs.readFileSync(path.resolve(import.meta.dirname, '../wealthflow-vault.js'), 'utf8');
        /* CODE ONLY. The first version of this check matched the module's own
         * header, which explains at length why DB.set must never appear here —
         * so the test failed on the prose arguing for the thing it was
         * enforcing. Comments are stripped before the check for that reason. */
        const code = raw
            .replace(/\/\*[\s\S]*?\*\//g, ' ')
            .replace(/(^|[^:])\/\/.*$/gm, '$1');
        expect(code, 'this module writes through the synced store').not.toContain('DB.set');
        expect(code, 'this module reaches the synced object').not.toContain('appData');
        expect(code, 'a password could reach the console').not.toMatch(/console\.(log|warn|error)/);
        // and the stripper must not have eaten everything
        expect(code).toContain('export async function unlock');
    });

    it('owns exactly one storage key', async () => {
        const st = fakeStore();
        await unlock(PIN, { ...deps, storage: st });
        await save(entries, { ...deps, storage: st });
        expect([...st._m.keys()]).toEqual([STORE_KEY]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ENTRIES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what counts as an entry', () => {
    it('keeps the password byte-for-byte', () => {
        /* A password is whatever the bank chose. Trimming or case-folding it is
         * how a correct password stops working, with no clue why. */
        const e = normaliseEntry({ bank: 'HNB', password: '  Pa ss\tword  ' });
        expect(e.password).toBe('  Pa ss\tword  ');
    });

    it('tidies everything that is not the password', () => {
        const e = normaliseEntry({ bank: '  HNB  ', label: '  PDF ', password: 'x' });
        expect(e.bank).toBe('HNB');
        expect(e.label).toBe('PDF');
    });

    it('refuses an entry with no password or no bank', () => {
        expect(normaliseEntry({ bank: 'HNB', password: '' })).toBe(null);
        expect(normaliseEntry({ bank: '', password: 'x' })).toBe(null);
        expect(normaliseEntry(null)).toBe(null);
    });

    it('replaces rather than duplicates the same bank and label', () => {
        const out = normaliseAll([
            { bank: 'HNB', label: 'PDF', password: 'old' },
            { bank: 'hnb', label: 'pdf', password: 'new' },
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].password).toBe('new');
    });

    it('keeps two different labels for one bank', () => {
        const out = normaliseAll([
            { bank: 'HNB', label: 'Savings', password: 'a' },
            { bank: 'HNB', label: 'Card', password: 'b' },
        ]);
        expect(out).toHaveLength(2);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CANDIDATES
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('which passwords get tried on a locked PDF', () => {
    const list2 = normaliseAll([
        { bank: 'HNB', password: 'hnb-pw' },
        { bank: 'DFCC', password: 'dfcc-pw' },
    ]);

    it('puts the typed password for that bank first, ahead of the guesses', () => {
        const out = candidatesFor('HNB', list2, ['199012345V', '01011990']);
        expect(out[0]).toBe('hnb-pw');
        expect(out).toContain('199012345V');
    });

    it('still offers the other saved passwords, after the matching one', () => {
        /* This assertion is the REVERSE of the one first written here, and the
         * reversal is the point. The original refused any non-matching bank,
         * reasoning about retry limits — but a locked PDF's bank is unknown
         * until it opens, so `bank` is usually empty at the only moment this is
         * called, and the strict rule returned nothing but guesses. Every
         * password the owner typed went unused in the exact case they saved it
         * for. There is no lockout either: this is pdf.js on a local file. */
        const out = candidatesFor('HNB', list2, []);
        expect(out[0]).toBe('hnb-pw');
        expect(out).toContain('dfcc-pw');
        expect(out.indexOf('hnb-pw')).toBeLessThan(out.indexOf('dfcc-pw'));
    });

    it('offers everything saved when the bank is not known yet', () => {
        // The common case: the file is locked, so nothing has been read from it.
        const out = candidatesFor('', list2, ['nic-guess']);
        expect(out).toEqual(['hnb-pw', 'dfcc-pw', 'nic-guess']);
    });

    it('matches a short name against a long one, both directions', () => {
        // The registry may say "HNB" where the statement says the full name.
        const l = normaliseAll([{ bank: 'Hatton National Bank', password: 'p' }]);
        expect(candidatesFor('hnb', normaliseAll([{ bank: 'HNB', password: 'p' }]))).toEqual(['p']);
        expect(candidatesFor('Hatton National Bank', l)).toEqual(['p']);
    });

    it('always puts the owner typed passwords ahead of the guesses', () => {
        const out = candidatesFor(null, list2, ['guess']);
        expect(out[out.length - 1]).toBe('guess');
        expect(out).toContain('hnb-pw');
    });

    it('de-duplicates without reordering', () => {
        const l = normaliseAll([{ bank: 'HNB', label: 'a', password: 'same' }, { bank: 'HNB', label: 'b', password: 'same' }]);
        expect(candidatesFor('HNB', l, ['same', 'other'])).toEqual(['same', 'other']);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SESSION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('unlocking, saving and locking', () => {
    it('round-trips through storage', async () => {
        const st = fakeStore();
        const d = { ...deps, storage: st };
        const first = await unlock(PIN, d);
        expect(first).toMatchObject({ ok: true, fresh: true });
        expect(await save(entries, d)).toMatchObject({ ok: true });

        _resetSession();
        const again = await unlock(PIN, d);
        expect(again.ok).toBe(true);
        expect(again.fresh).toBe(false);
        expect(again.entries.map((e) => e.bank).sort()).toEqual(['DFCC', 'HNB']);
        expect(again.entries.find((e) => e.bank === 'HNB').password).toBe('hnb-Secret#2026');
    });

    it('refuses the wrong PIN and does not cache a key', async () => {
        const st = fakeStore();
        const d = { ...deps, storage: st };
        await unlock(PIN, d);
        await save(entries, d);
        _resetSession();

        const bad = await unlock('654321', d);
        expect(bad.ok).toBe(false);
        expect(bad.reason).toBe(VAULT.WRONG_PIN);
        expect(isUnlocked(), 'a rejected PIN still unlocked the session').toBe(false);
        expect((await list(d)).entries).toEqual([]);
    });

    it('reports a short PIN separately from a wrong one', async () => {
        // Different because one is a typo the UI can explain and the other is a
        // failed guess; neither reveals anything about the stored data.
        const d = { ...deps, storage: fakeStore() };
        expect((await unlock('12', d)).reason).toBe(VAULT.BAD_PIN);
    });

    it('cannot read or write while locked', async () => {
        const st = fakeStore();
        const d = { ...deps, storage: st };
        await unlock(PIN, d);
        await save(entries, d);
        lock();
        expect(isUnlocked()).toBe(false);
        expect((await list(d)).ok).toBe(false);
        /* The REASON, not just the failure. A mutation that deleted the locked
         * guard still failed the write — seal() refuses a null key — but
         * reported 'no-web-crypto', and the UI must tell those apart: one asks
         * for the PIN again, the other says this browser cannot do it at all.
         * Asserting only `ok === false` let that mutant live. */
        const refused = await save([{ bank: 'X', password: 'y' }], d);
        expect(refused.ok).toBe(false);
        expect(refused.reason, 'a locked vault must ask for the PIN, not claim the browser is broken')
            .toBe(VAULT.EMPTY);
        // and the stored blob was not touched by the refused write
        expect(readBlob(st).ct).toBeTruthy();
    });

    it('treats a corrupted blob exactly like a wrong PIN', async () => {
        /* Distinguishing them would tell an attacker which guesses produced a
         * structurally valid decrypt. */
        const st = fakeStore();
        const d = { ...deps, storage: st };
        await unlock(PIN, d);
        await save(entries, d);
        const blob = readBlob(st);
        writeBlob({ ...blob, ct: blob.ct.slice(0, -4) + 'AAAA' }, st);
        _resetSession();
        expect((await unlock(PIN, d)).reason).toBe(VAULT.WRONG_PIN);
    });

    it('survives storage that refuses to write', async () => {
        const st = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => {} };
        const d = { ...deps, storage: st };
        await unlock(PIN, d);
        expect((await save(entries, d)).ok).toBe(false);   // reported, not thrown
    });

    it('reports rather than throws with no Web Crypto at all', async () => {
        const d = { subtle: null, storage: fakeStore() };
        expect((await unlock(PIN, d)).reason).toBe(VAULT.NO_CRYPTO);
    });

    it('knows whether a vault exists, and forgets it on destroy', async () => {
        const st = fakeStore();
        const d = { ...deps, storage: st };
        expect(isSet(st)).toBe(false);
        await unlock(PIN, d);
        await save(entries, d);
        expect(isSet(st)).toBe(true);
        destroy(st);
        expect(isSet(st)).toBe(false);
        expect(readBlob(st)).toBe(null);
    });

    it('exports what the page needs', () => {
        for (const fn of ['unlock', 'lock', 'list', 'save', 'candidatesFor', 'isSet', 'destroy']) {
            expect(typeof V[fn], fn).toBe('function');
        }
    });
});
