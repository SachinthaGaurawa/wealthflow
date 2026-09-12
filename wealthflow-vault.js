/* =============================================================================
 * wealthflow-vault.js — the bank-password vault
 * -----------------------------------------------------------------------------
 * A place to keep the passwords the banks put on their statement PDFs, so a
 * locked statement opens without being asked every time.
 *
 * ── WHY THIS IS NOT THE VAULT THAT ALREADY EXISTS ───────────────────────────
 *
 * wealthflow-intelligence.js already has a "Security Vault". It holds NIC, date
 * of birth and card last-4, and DERIVES candidate passwords from them, because
 * Sri Lankan banks commonly lock a statement with one of those. That vault is
 * real, it works, and this file does not replace it.
 *
 * What it cannot hold is a password the bank simply chose — and it should not
 * be made to, because of how it is encrypted. Its key comes from
 * `_deviceSecret()`, a random value kept in localStorage under `wf_vault_dk`,
 * sitting directly beside the ciphertext in `wf_vault_enc`. Anything that can
 * read localStorage has BOTH halves. Its own header says so, honestly, and for
 * a NIC that is a defensible trade: a NIC is semi-public, and the device lock
 * is the real perimeter.
 *
 * A bank password is not a NIC. It is frequently reused, it opens something
 * that holds money, and the cost of it leaking is not "someone learns my date
 * of birth". So this vault derives its key from the MASTER PIN — typed, never
 * stored anywhere in any form this file can reach — with a random salt and
 * 310,000 PBKDF2 rounds. The ciphertext on disk is worthless without something
 * that exists only in the owner's head.
 *
 * That is the whole reason for a second file rather than three more fields on
 * the first one. Two different secrets deserving two different keys is not
 * duplication; encrypting a bank password with a key stored next to it would be.
 *
 * ── THE COST, STATED PLAINLY ────────────────────────────────────────────────
 *
 * A PIN-derived key cannot be recovered. Forget the PIN and the passwords are
 * gone — there is no reset, because a reset is by definition a way in without
 * the secret, and any such door is the door an attacker uses. The UI says this
 * before the first password is saved.
 *
 * It also means biometric unlock is not enough to open THIS vault: a fingerprint
 * produces no PIN to derive from. So the PIN is asked for once per session and
 * the derived key — not the PIN — is held in memory until the app locks.
 *
 * ── AND WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────
 *
 * Touch appData. Every record in appData is written by DB.set, which persists to
 * localStorage AND pushes to Firestore. A bank password must never take that
 * path, so nothing here goes near it: this module owns one localStorage key and
 * has no other storage of any kind. There is a test asserting the string
 * 'DB.set' does not appear in this file, because that is the mistake that would
 * quietly upload every password in it.
 *
 * ── CROSS-DEVICE SYNC (v7.71.0) ─────────────────────────────────────────────
 *
 * The owner asked for this vault to stop being pinned to the device it was
 * saved on: a password added on the phone must be usable from a laptop, and
 * vice versa, on the same account. That does NOT mean the security model
 * above changes — it means the same ciphertext this file already writes to
 * ONE localStorage key is now also written to ONE private Firestore document
 * the owner alone can read (`users/{uid}/vault/bankpw`, covered by the
 * existing owner-only rule for `users/{uid}/**` — no rules change needed).
 *
 * What travels is EXACTLY what already sits on disk: `{v, kdf, salt, iv, ct,
 * savedAt}`. The PIN never travels. The derived key never travels — it is
 * non-extractable and this file could not export it if it wanted to. A device
 * that has never seen this vault before still needs the correct PIN to read
 * a single entry out of the blob it downloads; an attacker with full read
 * access to the owner's Firestore document is in exactly the position this
 * file already defends against for someone with full read access to
 * localStorage, because it is the same ciphertext either way.
 *
 * `savedAt` is the one new field, and it is deliberately OUTSIDE the
 * ciphertext: recency has to be comparable ACROSS DEVICES before either side
 * knows the PIN, or two devices editing offline would have no way to decide
 * whose copy is newer without asking for the PIN just to find out. A save
 * timestamp is not a secret.
 *
 * The sync itself is injected as `deps.cloud = { pull, push }`, exactly like
 * `deps.subtle` and `deps.storage` above — this file still does not import
 * Firestore, know a project id, or hold a `db` handle. The real
 * implementation is wired in index.html, next to every other Firestore call
 * in the app; this file only ever sees two functions it can await, and both
 * are optional (no `deps.cloud` — nothing changes, the vault behaves exactly
 * as it always did, e.g. under test or before login).
 * ===========================================================================*/

/* What a password is MADE OF, which the vault now records alongside it. A
 * birthday typed as 07/07/1993 is the same secret as 07071993 and 1993-07-07,
 * and until this module existed only the exact string typed was ever tried —
 * the owner's complaint, in one sentence. */
import { expand as expandShape } from './wealthflow-password-shapes.js';

/* The store. Separate key from `wf_vault_enc` on purpose — different secret,
 * different key derivation, different lifetime. */
export const STORE_KEY = 'wf_vault_pw_v1';

export const KDF = {
    ITERATIONS: 310000,     // OWASP's PBKDF2-SHA256 floor; ~0.3s on a mid phone
    HASH: 'SHA-256',
    SALT_BYTES: 16,
    IV_BYTES: 12,           // 96 bits, the size AES-GCM is specified for
};

export const VAULT = {
    OK: 'ok',
    WRONG_PIN: 'wrong-pin',
    EMPTY: 'no-vault',
    NO_CRYPTO: 'no-web-crypto',
    BAD_PIN: 'pin-too-short',
};

/** The shortest PIN the app itself accepts. Below this, refuse to derive. */
export const MIN_PIN = 6;

const s = (v) => (v == null ? '' : String(v)).trim();

/* ── entries ──────────────────────────────────────────────────────────────── */

/**
 * One stored password.
 *
 * `password` is NOT trimmed and NOT case-folded: a password is a byte sequence
 * the bank chose, and "helpfully" normalising it is how a correct password stops
 * working. Everything else is tidied.
 */
export function normaliseEntry(raw, now = Date.now()) {
    const r = raw || {};
    const password = r.password == null ? '' : String(r.password);
    const bank = s(r.bank);
    if (!password) return null;
    return {
        id: s(r.id) || `pw_${now.toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
        bank,
        label: s(r.label),
        password,
        /* WHAT THE PASSWORD IS, not just what it says. An entry saved before
         * these fields existed has neither, and wealthflow-password-shapes.js
         * reads an absent kind as OTHER — so every password already in a
         * vault keeps behaving exactly as it did. */
        kind: s(r.kind),
        format: s(r.format),
        updatedAt: Number(r.updatedAt) || now,
    };
}

/** Preserve independent credentials; an explicit entry id identifies an edit. */
export function normaliseAll(list, now = Date.now()) {
    const out = [];
    const seen = new Map();
    for (const raw of Array.isArray(list) ? list : []) {
        const e = normaliseEntry(raw, now);
        if (!e) continue;
        const k = s(raw && raw.id) ? `id:${e.id}` : `legacy:${JSON.stringify([
            e.bank.toLowerCase(), e.label.toLowerCase(), e.password, e.kind, e.format,
        ])}`;
        if (seen.has(k)) {
            out[seen.get(k)] = e;
            continue;
        }
        seen.set(k, out.length);
        out.push(e);
    }
    return out;
}

/* ── the key ──────────────────────────────────────────────────────────────── */

const enc = new TextEncoder();

function bytesToB64(bytes) {
    let out = '';
    for (let i = 0; i < bytes.length; i += 1) out += String.fromCharCode(bytes[i]);
    return btoa(out);
}

function b64ToBytes(b64) {
    const bin = atob(b64);
    const u = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) u[i] = bin.charCodeAt(i);
    return u;
}

function subtleOf(deps) {
    /* An explicitly passed `subtle: null` means "there is none" and must NOT
     * fall through to the global. Without the `in` check, a caller trying to
     * exercise the no-crypto path silently gets the real implementation — the
     * seam looks injected and is not, which is worse than having no seam. */
    if (deps && 'subtle' in deps) return deps.subtle || null;
    return (typeof crypto !== 'undefined' && crypto.subtle) ? crypto.subtle : null;
}

function randomOf(deps, n) {
    if (deps && typeof deps.randomBytes === 'function') return deps.randomBytes(n);
    const u = new Uint8Array(n);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(u);
    else throw new Error('no secure randomness available');
    return u;
}

/**
 * Derive the vault key from the typed PIN.
 *
 * NOT the auth hash. index.html verifies the PIN as
 * `sha256(pin + 'wf_salt_sg2026')` and keeps that digest in appData — which is
 * synced. Deriving the encryption key the same way would make the stored,
 * uploaded digest equal to the key, and the vault would be readable by anyone
 * holding the sync document. Different salt, different algorithm, many more
 * rounds: the two values are unrelated and neither reveals the other.
 *
 * The key is non-extractable, so even code running on the page cannot read it
 * back out once derived.
 */
export async function deriveKey(pin, salt, deps = {}) {
    const subtle = subtleOf(deps);
    if (!subtle) return null;
    const p = pin == null ? '' : String(pin);
    if (p.length < MIN_PIN) return null;
    const material = await subtle.importKey('raw', enc.encode(p), { name: 'PBKDF2' }, false, ['deriveKey']);
    return subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: KDF.ITERATIONS, hash: KDF.HASH },
        material,
        { name: 'AES-GCM', length: 256 },
        false,                       // non-extractable
        ['encrypt', 'decrypt'],
    );
}

/* ── sealing and opening ──────────────────────────────────────────────────── */

/**
 * Encrypt the entries under `key`.
 *
 * A FRESH IV every time, which is the one rule AES-GCM does not forgive:
 * encrypting twice with the same key and IV leaks the XOR of the plaintexts and
 * breaks the authentication outright. The salt may be reused across saves — it
 * exists to make the key unique per vault, not per message — so the key can stay
 * cached while every write still gets its own IV.
 */
export async function seal(key, entries, saltB64, deps = {}) {
    const subtle = subtleOf(deps);
    if (!subtle || !key) return null;
    const iv = randomOf(deps, KDF.IV_BYTES);
    const savedAt = Date.now();
    const body = enc.encode(JSON.stringify({ entries: normaliseAll(entries), savedAt }));
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, key, body);
    return {
        v: 1,
        kdf: { it: KDF.ITERATIONS, hash: KDF.HASH },
        salt: saltB64,
        iv: bytesToB64(iv),
        ct: bytesToB64(new Uint8Array(ct)),
        // Deliberately OUTSIDE the ciphertext (see the cross-device sync note
        // atop this file): two devices need to agree on whose copy is newer
        // BEFORE either one knows the PIN, and a save timestamp is not a
        // secret. Duplicated from the encrypted `savedAt` above only for that
        // reason — the encrypted one remains the source of truth once opened.
        savedAt,
    };
}

/**
 * Decrypt a sealed blob.
 *
 * A wrong PIN is reported as a REASON, never thrown. AES-GCM fails the
 * authentication tag on a wrong key, which is what makes "wrong PIN" detectable
 * at all without storing a separate verifier — and storing one would be an extra
 * thing an attacker could test guesses against offline.
 */
export async function openSealed(key, blob, deps = {}) {
    const subtle = subtleOf(deps);
    if (!subtle) return { ok: false, reason: VAULT.NO_CRYPTO, entries: [] };
    if (!blob || !blob.ct) return { ok: false, reason: VAULT.EMPTY, entries: [] };
    if (!key) return { ok: false, reason: VAULT.WRONG_PIN, entries: [] };
    try {
        const pt = await subtle.decrypt(
            { name: 'AES-GCM', iv: b64ToBytes(blob.iv) },
            key,
            b64ToBytes(blob.ct),
        );
        const parsed = JSON.parse(new TextDecoder().decode(pt));
        return { ok: true, reason: VAULT.OK, entries: normaliseAll(parsed && parsed.entries) };
    } catch (_) {
        /* Deliberately indistinguishable: a wrong PIN and a corrupted blob both
         * report the same thing, and neither logs the ciphertext or the PIN. */
        return { ok: false, reason: VAULT.WRONG_PIN, entries: [] };
    }
}

/* ── the candidate list ───────────────────────────────────────────────────── */

/**
 * The passwords to try for a locked PDF, most likely first.
 *
 * ORDER, NOT EXCLUSION — and the first version of this function got that wrong.
 *
 * It returned ONLY the passwords whose bank matched, reasoning that trying
 * another bank's password is a wasted attempt that could count toward a lockout.
 * That reasoning does not survive contact with the actual caller. A locked PDF's
 * bank is not known until the PDF OPENS — that is the whole problem — so `bank`
 * is usually empty at the moment the candidates are needed, and the strict
 * version therefore returned nothing but guesses. Every password the owner had
 * carefully typed in went unused in exactly the case they saved it for.
 *
 * There is also no lockout to protect against: this is pdf.js decrypting a local
 * file. A wrong password costs one key derivation and nothing else. Nothing
 * leaves the device, and no server is told anything.
 *
 * So every password the owner saved is offered, ordered:
 *   1. entries whose bank matches the one named (when one is)
 *   2. the owner's other saved passwords
 *   3. guesses derived from NIC / date of birth / card last-4
 *
 * Ordering still matters — it decides which is tried first, and so which one the
 * app reports having opened the file with.
 */
export function candidatesFor(bank, entries, derived = []) {
    const want = s(bank).toLowerCase();
    const matched = [];
    const others = [];
    const out = [];
    const push = (into, x) => {
        const v = x == null ? '' : String(x);
        if (v && !into.includes(v)) into.push(v);
    };
    for (const e of Array.isArray(entries) ? entries : []) {
        if (!e || !e.password) continue;
        const b = s(e.bank).toLowerCase();
        // Substring either way: the registry may say "HNB" where the statement
        // says "Hatton National Bank", and the owner may have typed either.
        const hit = want && b && (b === want || b.includes(want) || want.includes(b));
        /* EVERY SPELLING OF IT, not just the one that was typed. The owner
         * asked why a date of birth with slashes was never tried; the answer
         * was that a password could only ever be an opaque string here, so
         * 07/07/1993 and 07071993 were two different secrets as far as this
         * function could tell. An entry declaring itself a birthday now
         * contributes both, and the declared form is still first. */
        for (const v of expandShape(e)) push(hit ? matched : others, v);
    }
    for (const x of matched) push(out, x);
    for (const x of others) push(out, x);
    for (const d of Array.isArray(derived) ? derived : []) push(out, d);
    return out;
}

/* ── the stored blob ──────────────────────────────────────────────────────── */

/** Is there a vault on this device at all? */
export function isSet(storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return false;
    try { return !!st.getItem(STORE_KEY); } catch (_) { return false; }
}

export function readBlob(storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return null;
    try {
        const raw = st.getItem(STORE_KEY);
        if (!raw) return null;
        const p = JSON.parse(raw);
        return (p && p.ct && p.salt && p.iv) ? p : null;
    } catch (_) { return null; }
}

export function writeBlob(blob, storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st || !blob) return false;
    try { st.setItem(STORE_KEY, JSON.stringify(blob)); return true; } catch (_) { return false; }
}

/** Remove the vault. The salt goes with it — a new vault gets a new one. */
export function destroy(storage) {
    const st = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!st) return false;
    try { st.removeItem(STORE_KEY); return true; } catch (_) { return false; }
}

/** A fresh salt, base64. New vaults only; an existing vault keeps its own. */
export function newSalt(deps = {}) {
    return bytesToB64(randomOf(deps, KDF.SALT_BYTES));
}

/* ── the session ──────────────────────────────────────────────────────────── */

/*
 * The derived key is cached for the life of the unlocked session so the owner is
 * asked for the PIN once, not once per statement. The KEY is cached, never the
 * PIN: it is non-extractable, so nothing on the page can read it back out, and
 * it cannot be used to re-derive anything else or to attack the auth hash.
 */
let _sessionKey = null;
let _sessionSalt = null;

/**
 * The newer of a local and a cloud copy, by the plaintext `savedAt` each
 * carries — never by trusting whichever one happened to answer first. A
 * missing blob loses to a present one; a missing `savedAt` (a blob saved
 * before this field existed) counts as the oldest possible time rather than
 * throwing, so an old local vault does not out-rank a real cloud copy just
 * because `undefined > n` is always false anyway — being explicit here means
 * that stays true on purpose, not by accident of JS comparison rules.
 */
function _newer(a, b) {
    if (!a) return b || null;
    if (!b) return a;
    return (Number(b.savedAt) || 0) > (Number(a.savedAt) || 0) ? b : a;
}

/**
 * Best-effort pull from the cloud. Never throws, never blocks unlocking with
 * whatever is already on this device — a device with no network, or a
 * signed-out session, must keep working exactly as it did before sync
 * existed.
 */
async function _cloudPull(deps) {
    try {
        if (deps && deps.cloud && typeof deps.cloud.pull === 'function') return (await deps.cloud.pull()) || null;
    } catch (_) {}
    return null;
}

/** Best-effort push. A failed push never fails the (already-completed) local save. */
async function _cloudPush(blob, deps) {
    try {
        if (deps && deps.cloud && typeof deps.cloud.push === 'function') await deps.cloud.push(blob);
    } catch (_) {}
}

/**
 * Pull the cloud copy (when `deps.cloud` is wired) and cache it locally when
 * it is newer than whatever is already on this device — with NO PIN and NO
 * key derivation, so it is safe to call at boot, before the owner has typed
 * anything, purely to make `isSet()` tell the truth on a device that has
 * never been unlocked here yet. `unlock()` below does the same reconciliation
 * itself (a stale cache between boot and the next unlock would otherwise
 * still open with a stale blob), so calling `hydrate()` first is an
 * optimisation for the UI, never a requirement for correctness.
 *
 * Returns the blob that ended up on disk (local or the newly-cached remote),
 * or null when neither device nor cloud has ever saved one.
 */
export async function hydrate(deps = {}) {
    const st = deps.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const local = readBlob(st);
    const remote = await _cloudPull(deps);
    const blob = _newer(local, remote);
    if (blob && blob === remote) writeBlob(blob, st); // cache the winning cloud copy for offline use
    return blob;
}

/**
 * Derive and cache the key for this session, verifying it against the stored
 * blob when one exists so a wrong PIN is refused up front rather than silently
 * caching a key that decrypts nothing.
 *
 * Cross-device: pulls the cloud copy (if `deps.cloud` is wired) and unlocks
 * with whichever of {local, cloud} carries the later `savedAt`, caching the
 * winner locally so the device stays usable offline afterwards. A device
 * opening this vault for the very first time therefore does not need a local
 * blob at all — only the same PIN used to create it elsewhere.
 */
export async function unlock(pin, deps = {}) {
    const p = pin == null ? '' : String(pin);
    if (p.length < MIN_PIN) return { ok: false, reason: VAULT.BAD_PIN, entries: [] };
    if (!subtleOf(deps)) return { ok: false, reason: VAULT.NO_CRYPTO, entries: [] };

    const blob = await hydrate(deps);

    const saltB64 = blob ? blob.salt : newSalt(deps);
    const key = await deriveKey(p, b64ToBytes(saltB64), deps);
    if (!key) return { ok: false, reason: VAULT.NO_CRYPTO, entries: [] };

    if (!blob) {
        // First use anywhere on this account: nothing to verify against, so
        // this PIN defines the vault.
        _sessionKey = key; _sessionSalt = saltB64;
        return { ok: true, reason: VAULT.OK, entries: [], fresh: true };
    }
    const opened = await openSealed(key, blob, deps);
    if (!opened.ok) return opened;
    _sessionKey = key; _sessionSalt = saltB64;
    return { ok: true, reason: VAULT.OK, entries: opened.entries, fresh: false };
}

/** Forget the key. Called when the app locks. */
export function lock() { _sessionKey = null; _sessionSalt = null; }

export function isUnlocked() { return !!_sessionKey; }

/** Read the vault using the cached key. Null when locked — never a prompt. */
export async function list(deps = {}) {
    if (!_sessionKey) return { ok: false, reason: VAULT.EMPTY, entries: [] };
    const blob = readBlob(deps.storage);
    if (!blob) return { ok: true, reason: VAULT.OK, entries: [] };
    return openSealed(_sessionKey, blob, deps);
}

/**
 * Replace the whole entry list, re-sealed under the cached key.
 *
 * The local write is what this function's result reports — that succeeding
 * or failing has never depended on the network, and still does not. The
 * cloud push (when `deps.cloud` is wired) happens after, best-effort: a
 * phone with no signal still saves the vault it can use right now, and syncs
 * the next time `save()` or `unlock()` succeeds with a connection.
 */
export async function save(entries, deps = {}) {
    if (!_sessionKey || !_sessionSalt) return { ok: false, reason: VAULT.EMPTY };
    const blob = await seal(_sessionKey, entries, _sessionSalt, deps);
    if (!blob) return { ok: false, reason: VAULT.NO_CRYPTO };
    const wrote = writeBlob(blob, deps.storage);
    if (!wrote) return { ok: false, reason: VAULT.NO_CRYPTO };
    await _cloudPush(blob, deps);
    return { ok: true, reason: VAULT.OK };
}

/** Test seam: drop the cached key without touching storage. */
export function _resetSession() { lock(); }

const API = {
    STORE_KEY, KDF, VAULT, MIN_PIN,
    normaliseEntry, normaliseAll, deriveKey, seal, openSealed, candidatesFor,
    isSet, readBlob, writeBlob, destroy, newSalt,
    unlock, lock, isUnlocked, list, save, hydrate,
};

if (typeof window !== 'undefined') window.WFVault = API;

export default API;
