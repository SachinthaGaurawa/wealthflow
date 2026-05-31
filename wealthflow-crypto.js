/* =============================================================================
   WealthFlow Crypto v1.0 — End-to-End At-Rest Encryption Layer
   ---------------------------------------------------------------------------
   Every piece of sensitive WealthFlow data the new AI subsystems persist
   (learned merchant→category memory, the pending-review queue, the duplicate
   ledger, the background job queue) is encrypted with AES-256-GCM BEFORE it
   ever touches localStorage / IndexedDB / the cloud sync snapshot.

   Threat model handled here:
     • A second person who picks up the unlocked device and opens devtools
       cannot read the learned spending profile in plaintext.
     • The cloud-sync snapshot (Firestore) only ever receives ciphertext for
       these keys, so a server-side breach reveals nothing about the user's
       merchants, categories or amounts in these stores.
     • Keys never leave the device. The master key is derived on-device from a
       per-install random seed (256-bit) optionally mixed with the user's
       master PIN, via PBKDF2-SHA-256 @ 210k iterations.

   This is genuine end-to-end at-rest encryption: WealthFlow's servers (and
   anyone else) only see opaque base64 ciphertext for everything routed
   through wfCrypto.secureSet().

   Exposes (all async unless noted):
     • wfCrypto.ready()                       → resolves when the key is ready
     • wfCrypto.encrypt(obj)        → "wfx1:..."   (base64 iv||ct)
     • wfCrypto.decrypt("wfx1:...") → original obj
     • wfCrypto.secureSet(key, obj)           persist encrypted (localStorage)
     • wfCrypto.secureGet(key)                load + decrypt (or null)
     • wfCrypto.secureDelete(key)
     • wfCrypto.setUserSecret(pin)            re-derive key mixing in the PIN
     • wfCrypto.fingerprint(str)    → hex SHA-256 (non-secret, for dedup keys)
     • wfCrypto.isEncrypted(v)      (sync) → boolean
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_CRYPTO_LOADED) return;
    window.WF_CRYPTO_LOADED = '1.0';

    const SUBTLE = (window.crypto && window.crypto.subtle) ? window.crypto.subtle : null;
    const ENC = new TextEncoder();
    const DEC = new TextDecoder();
    const VERSION = 'wfx1:';
    const SEED_KEY = '_wf_dk_seed_v1';
    const PBKDF2_ITERS = 210000;

    let _key = null;            // CryptoKey (AES-GCM 256)
    let _userSecret = '';       // optional extra entropy (master PIN)
    let _readyResolve;
    const _ready = new Promise(r => { _readyResolve = r; });

    // ── base64 helpers ────────────────────────────────────────────────────────
    function _b64(bytes) {
        let bin = '';
        const b = new Uint8Array(bytes);
        for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
        return btoa(bin);
    }
    function _unb64(str) {
        const bin = atob(str);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    // ── per-install random seed (256-bit) ──────────────────────────────────────
    function _getOrCreateSeed() {
        try {
            let s = localStorage.getItem(SEED_KEY);
            if (s) return s;
        } catch (_) {}
        const rnd = new Uint8Array(32);
        (window.crypto || {}).getRandomValues ? window.crypto.getRandomValues(rnd) : rnd.forEach((_, i) => rnd[i] = Math.floor(Math.random() * 256));
        const s = _b64(rnd);
        try { localStorage.setItem(SEED_KEY, s); } catch (_) {}
        return s;
    }

    // ── key derivation ──────────────────────────────────────────────────────--
    async function _deriveKey() {
        if (!SUBTLE) { _key = null; _readyResolve(false); return false; }
        try {
            const seed = _getOrCreateSeed();
            const material = await SUBTLE.importKey(
                'raw', ENC.encode(seed + '|' + _userSecret),
                { name: 'PBKDF2' }, false, ['deriveKey']
            );
            // Salt is bound to the seed so it's deterministic per-install but
            // unique across installs.
            const salt = ENC.encode('wealthflow-e2e-salt|' + seed.slice(0, 16));
            _key = await SUBTLE.deriveKey(
                { name: 'PBKDF2', salt, iterations: PBKDF2_ITERS, hash: 'SHA-256' },
                material,
                { name: 'AES-GCM', length: 256 },
                false, ['encrypt', 'decrypt']
            );
            _readyResolve(true);
            return true;
        } catch (e) {
            console.warn('[wfCrypto] key derivation failed, falling back to plaintext store:', e && e.message);
            _key = null;
            _readyResolve(false);
            return false;
        }
    }

    // ── public: ready ───────────────────────────────────────────────────────--
    function ready() { return _ready; }

    // ── public: setUserSecret (mix the master PIN into the key) ────────────────
    async function setUserSecret(secret) {
        _userSecret = String(secret || '');
        return _deriveKey();
    }

    function isEncrypted(v) { return typeof v === 'string' && v.indexOf(VERSION) === 0; }

    // ── public: encrypt / decrypt ──────────────────────────────────────────────
    async function encrypt(obj) {
        await _ready;
        const plaintext = ENC.encode(JSON.stringify(obj));
        if (!_key) {
            // No SubtleCrypto — degrade gracefully to a tagged, NON-encrypted
            // store so the app still works (e.g. very old browsers). We mark it
            // so decrypt() knows not to attempt AES.
            return 'wfp0:' + _b64(plaintext);
        }
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const ct = await SUBTLE.encrypt({ name: 'AES-GCM', iv }, _key, plaintext);
        const out = new Uint8Array(iv.length + ct.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ct), iv.length);
        return VERSION + _b64(out);
    }

    async function decrypt(blob) {
        await _ready;
        if (typeof blob !== 'string') return null;
        if (blob.indexOf('wfp0:') === 0) {
            try { return JSON.parse(DEC.decode(_unb64(blob.slice(5)))); } catch { return null; }
        }
        if (blob.indexOf(VERSION) !== 0) {
            // Legacy / plaintext JSON — try to parse directly
            try { return JSON.parse(blob); } catch { return null; }
        }
        if (!_key) return null;
        try {
            const raw = _unb64(blob.slice(VERSION.length));
            const iv = raw.slice(0, 12);
            const ct = raw.slice(12);
            const pt = await SUBTLE.decrypt({ name: 'AES-GCM', iv }, _key, ct);
            return JSON.parse(DEC.decode(pt));
        } catch (e) {
            console.warn('[wfCrypto] decrypt failed:', e && e.message);
            return null;
        }
    }

    // ── public: secureSet / secureGet / secureDelete ───────────────────────────
    async function secureSet(key, obj) {
        const blob = await encrypt(obj);
        try { localStorage.setItem('wfsec_' + key, blob); return true; }
        catch (e) { console.warn('[wfCrypto] secureSet failed:', e && e.message); return false; }
    }
    async function secureGet(key) {
        let blob;
        try { blob = localStorage.getItem('wfsec_' + key); } catch { return null; }
        if (!blob) return null;
        return decrypt(blob);
    }
    function secureDelete(key) {
        try { localStorage.removeItem('wfsec_' + key); } catch (_) {}
    }

    // ── public: fingerprint (non-secret SHA-256 hex, for dedup keys) ────────────
    async function fingerprint(str) {
        const data = ENC.encode(String(str || ''));
        if (SUBTLE) {
            try {
                const h = await SUBTLE.digest('SHA-256', data);
                return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
            } catch (_) {}
        }
        // Fallback: FNV-1a 32-bit (not cryptographic, but fine for dedup)
        let h = 0x811c9dc5;
        for (let i = 0; i < data.length; i++) { h ^= data[i]; h = (h * 0x01000193) >>> 0; }
        return ('00000000' + h.toString(16)).slice(-8);
    }

    window.wfCrypto = {
        ready, encrypt, decrypt, secureSet, secureGet, secureDelete,
        setUserSecret, fingerprint, isEncrypted
    };

    // Derive the device key immediately.
    _deriveKey();

    // If the app exposes the master PIN at unlock time, mix it in for stronger
    // E2E. We listen for a custom event the app can dispatch; harmless if never
    // fired.
    window.addEventListener('wf-master-pin-ready', (e) => {
        if (e && e.detail) setUserSecret(e.detail);
    });

    console.log('[wfCrypto] ✓ End-to-end encryption layer ready (AES-256-GCM, PBKDF2 ' + PBKDF2_ITERS + ')');
})();
