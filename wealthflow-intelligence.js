/* =============================================================================
 * WealthFlow Elite — Intelligence Layer  (v7.7.0)
 * -----------------------------------------------------------------------------
 * Three fully-client-side, zero-external-account power features that complete
 * the autonomous blueprint:
 *
 *   A. SECURITY VAULT       — AES-256-GCM encrypted store of card last-4 / NIC /
 *                             DOB. Used to AUTOMATICALLY unlock password-locked
 *                             bank-statement PDFs (Sri Lankan banks commonly use
 *                             the NIC or DOB as the PDF password). Encrypted at
 *                             rest via the Web Crypto API; never synced to cloud
 *                             in plaintext; device-local.
 *
 *   B. SEMANTIC ALLOCATION  — When an auto-classified transaction's description
 *                             / reference matches a Savings Target or a Loan by
 *                             name, the money is routed straight to that goal's
 *                             contributions or that loan's payments — bypassing
 *                             the generic Expenses tab. (Blueprint §5.)
 *
 *   C. QUARANTINE ZONE      — When the brain's confidence is below 95%, the
 *                             transaction is NOT guessed. It lands in a "Needs
 *                             Review" dashboard widget that asks the user one
 *                             direct question and files it on one tap.
 *                             (Blueprint §6 — Human-in-the-Loop.)
 *
 * No external dependency. No API key. Works offline. Loaded after the main
 * app + wealthflow-autonomous.js so window.DB / window.notify exist.
 * ============================================================================= */
(function () {
    'use strict';
    var V = 'v7.7.0-intel';

    /* ---- safe accessors (degrade gracefully if main app not ready) ---- */
    function _db() { return window.DB || null; }
    function _get(k) { try { return (_db() && _db().get(k)) || []; } catch (_) { return []; } }
    function _set(k, v) { try { if (_db()) _db().set(k, v); } catch (_) {} }
    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t); } catch (_) {} }
    function _uid() { return 'intel_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function _money(n) { try { return 'LKR ' + (Number(n) || 0).toLocaleString(); } catch (_) { return 'LKR ' + n; } }

    /* =========================================================================
     * A. SECURITY VAULT  (AES-256-GCM, device-local, encrypted at rest)
     * =========================================================================
     * Threat model (honest):
     *   ✔ Protects against the vault contents being readable in plaintext by
     *     casual inspection, in cloud backups, or by other scripts that don't
     *     hold the device key.
     *   ✔ Keeps NIC / DOB OUT of the cloud document entirely.
     *   ✘ Does NOT defend against an attacker with full read access to this
     *     device's localStorage AND the ability to run code (they'd have both
     *     key + ciphertext) — but at that point the device PIN/biometric lock
     *     is the real perimeter. This is the correct, standard tradeoff for a
     *     personal-finance PWA that must also work under biometric unlock
     *     (where no typed PIN is available to derive a key from).
     */
    function _b64(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
    function _ub64(b64) { var bin = atob(b64); var u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

    function _deviceSecret() {
        var s = localStorage.getItem('wf_vault_dk');
        if (!s) {
            var b = crypto.getRandomValues(new Uint8Array(32));
            s = _b64(b);
            localStorage.setItem('wf_vault_dk', s);
        }
        return s;
    }

    async function _vaultKey() {
        var base = await crypto.subtle.importKey('raw', _ub64(_deviceSecret()), 'PBKDF2', false, ['deriveKey']);
        var salt = new TextEncoder().encode('wf_vault_salt_v1');
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt: salt, iterations: 100000, hash: 'SHA-256' },
            base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
        );
    }

    function vaultExists() { return !!localStorage.getItem('wf_vault_enc'); }

    async function vaultSave(obj) {
        if (!crypto || !crypto.subtle) throw new Error('Secure storage not available in this browser');
        // sanitise
        var clean = {
            last4: Array.isArray(obj.last4) ? obj.last4.map(function (x) { return String(x).replace(/\D/g, '').slice(-4); }).filter(Boolean) : [],
            nic: obj.nic ? String(obj.nic).trim().toUpperCase().replace(/\s+/g, '') : '',
            dob: obj.dob ? String(obj.dob).trim() : '',
            updatedAt: new Date().toISOString()
        };
        var key = await _vaultKey();
        var iv = crypto.getRandomValues(new Uint8Array(12));
        var data = new TextEncoder().encode(JSON.stringify(clean));
        var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, data);
        localStorage.setItem('wf_vault_enc', JSON.stringify({ v: 1, iv: _b64(iv), ct: _b64(new Uint8Array(ct)) }));
        return true;
    }

    async function vaultGet() {
        var raw = localStorage.getItem('wf_vault_enc');
        if (!raw) return null;
        try {
            var p = JSON.parse(raw);
            var key = await _vaultKey();
            var pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: _ub64(p.iv) }, key, _ub64(p.ct));
            return JSON.parse(new TextDecoder().decode(pt));
        } catch (e) {
            console.warn('[' + V + '] vault decrypt failed:', e && e.message);
            return null;
        }
    }

    function vaultClear() {
        localStorage.removeItem('wf_vault_enc');
        // keep the device key so a future vault re-uses it; remove only data
        return true;
    }

    /* Candidate passwords for locked bank PDFs, derived from vault contents.
     * Sri Lankan banks variously use the NIC, the DOB in several formats, or
     * the last 4 of the card as the statement password. We generate every
     * sensible candidate, de-duplicated and ordered most-likely-first. */
    function _pdfCandidatesFrom(v) {
        if (!v) return [];
        var out = [];
        function push(x) { if (x && out.indexOf(x) === -1) out.push(x); }

        if (v.nic) {
            var nic = String(v.nic).trim().toUpperCase();
            push(nic);
            push(nic.toLowerCase());
            push(nic.replace(/[VX]$/i, ''));   // old NIC without trailing V/X
            push(nic.slice(-4));               // last 4 of NIC
            push(nic.slice(0, 6));             // birth-encoded prefix of old NIC
        }
        if (v.dob) {
            var m = String(v.dob).match(/(\d{4})\D?(\d{2})\D?(\d{2})/);
            if (m) {
                var Y = m[1], M = m[2], D = m[3], yy = Y.slice(2);
                push(D + M + Y);     // DDMMYYYY
                push(Y + M + D);     // YYYYMMDD
                push(D + M + yy);    // DDMMYY
                push(yy + M + D);    // YYMMDD
                push(M + D + Y);     // MMDDYYYY
                push(D + M);         // DDMM
                push(Y + D + M);     // YYYYDDMM
            }
        }
        (v.last4 || []).forEach(function (c) { push(String(c).trim()); });
        return out;
    }

    /* Public: the passwords to try on a locked statement PDF.
     *
     * Two sources, and they are deliberately different things:
     *   - the BANK PASSWORD VAULT (wealthflow-vault.js): passwords the owner
     *     actually typed, encrypted under a key derived from the master PIN.
     *     Only available when that vault has been unlocked this session, since
     *     its key exists only in memory and only after the PIN is entered.
     *   - THIS vault: NIC / date of birth / card last-4, from which likely
     *     passwords are derived. Guesses, and ordered last accordingly.
     *
     * When the password vault is locked — or was never set up — this degrades
     * to exactly the behaviour it had before: derived guesses only.
     */
    async function vaultPdfPasswords(bank) {
        var v = await vaultGet();
        var derived = _pdfCandidatesFrom(v);
        try {
            if (window.WFVault && window.WFVault.isUnlocked()) {
                var r = await window.WFVault.list();
                if (r && r.ok) return window.WFVault.candidatesFor(bank, r.entries, derived);
            }
        } catch (_) { /* the derived list below is still a real answer */ }
        return derived;
    }

    /* =========================================================================
     * B. SEMANTIC GOAL / LOAN ALLOCATION
     * ========================================================================= */
    function _norm(s) {
        return String(s == null ? '' : s).toLowerCase()
            .replace(/[^a-z0-9\u0D80-\u0DFF\s]/g, ' ')   // keep Sinhala block + alnum
            .replace(/\s+/g, ' ').trim();
    }

    // similarity of `name` against free-text `text`: 1.0 if the whole name
    // appears as a word/phrase; otherwise fraction of the name's tokens present.
    function _sim(text, name) {
        if (!name) return 0;
        var esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        var re = new RegExp('(^|\\s)' + esc + '(\\s|$)');
        if (re.test(text)) return 1;
        var have = {};
        text.split(/\s+/).forEach(function (t) { if (t) have[t] = 1; });
        var toks = name.split(/\s+/).filter(Boolean);
        if (!toks.length) return 0;
        var hit = 0;
        toks.forEach(function (t) { if (t.length >= 3 && have[t]) hit++; });
        return hit / toks.length;
    }

    function matchGoalOrLoan(text) {
        var t = _norm(text);
        if (!t) return null;
        var cands = [];
        _get('targets').forEach(function (g) {
            if (g && g.name) cands.push({ type: 'goal', id: g.id, name: g.name, score: _sim(t, _norm(g.name)) });
        });
        _get('loans').forEach(function (l) {
            if (l && l.name) cands.push({ type: 'loan', id: l.id, name: l.name, score: _sim(t, _norm(l.name)) });
        });
        cands.sort(function (a, b) { return b.score - a.score; });
        var best = cands[0];
        return (best && best.score >= 0.6) ? best : null;
    }

    function allocateToGoal(goalId, amount, date, note) {
        var arr = _get('targets');
        var i = arr.findIndex(function (x) { return x.id === goalId; });
        if (i < 0) return false;
        if (!Array.isArray(arr[i].savings)) arr[i].savings = [];
        arr[i].savings.push({ id: _uid(), amount: Number(amount) || 0, date: date, note: note || 'Auto-allocated', auto: true });
        _set('targets', arr);
        try { if (typeof window.renderTargets === 'function') window.renderTargets(); } catch (_) {}
        return true;
    }

    function allocateToLoan(loanId, amount, date, note) {
        var arr = _get('loans');
        var i = arr.findIndex(function (x) { return x.id === loanId; });
        if (i < 0) return false;
        if (!Array.isArray(arr[i].payments)) arr[i].payments = [];
        arr[i].payments.push({ id: _uid(), amount: Number(amount) || 0, date: date, paid: true, note: note || 'Auto-detected payment', auto: true });
        _set('loans', arr);
        try { if (typeof window.renderLoans === 'function') window.renderLoans(); } catch (_) {}
        return true;
    }

    // Called from applyBrainResult BEFORE generic module routing.
    // Returns {ok, module, label} if it allocated, else null.
    async function trySemanticAllocate(brain) {
        try {
            var routed = brain.routed || {};
            var f = routed.suggested_fields || {};
            var m = brain.resolved_merchant || {};
            var hay = [f.desc, f.notes, f.source, f.name, f.reference, f.ref, f.memo, m.name]
                .filter(Boolean).join(' ');
            var match = matchGoalOrLoan(hay);
            if (!match) return null;
            var amount = Number(f.amount) || 0;
            if (!amount) return null;   // no amount → let normal path handle it
            var date = f.date ? new Date(f.date).toISOString().slice(0, 10) : window.WFWhen.today();

            if (match.type === 'goal') {
                if (!allocateToGoal(match.id, amount, date, 'Auto-allocated · matched "' + match.name + '"')) return null;
                _notify('Auto-funded goal "' + match.name + '" with ' + _money(amount), 'success');
                return { ok: true, module: 'goal', label: match.name };
            }
            if (!allocateToLoan(match.id, amount, date, 'Auto-detected loan payment · "' + match.name + '"')) return null;
            _notify('Auto-recorded loan payment for "' + match.name + '" · ' + _money(amount), 'success');
            return { ok: true, module: 'loan', label: match.name };
        } catch (e) {
            console.warn('[' + V + '] semantic allocate error:', e && e.message);
            return null;
        }
    }

    /* =========================================================================
     * C. THE SECOND "NEEDS REVIEW" QUEUE — DELETED, NOT MOVED
     * =========================================================================
     *
     * There was a whole quarantine zone here: a localStorage store
     * (`wf_quarantine`), an adder exported as window.wfQuarantineAdd, a tile
     * renderer, and six chips to file a held transaction to expenses, income,
     * subscriptions, a card, a goal or a loan.
     *
     * NONE OF IT HAD EVER RUN.
     *
     *   - `qAdd` had NO CALLER anywhere in the app. The comment beside its
     *     export said "consumed by wealthflow-autonomous.js"; that file does
     *     not mention it. So the store was always empty.
     *   - `renderQuarantineTile()` looked up `#quarantineTile`, and no HTML in
     *     this repository contains that id. It returned on its first line,
     *     every time, silently.
     *
     * So the owner's "Interactive Quarantine Zone" existed twice: here, dead,
     * and in wealthflow-review.js — which is wired, visible, persisted
     * encrypted, raises its own banner, and is fed by the queue, the SMS paste
     * and the statement flows. The mail pipeline sends its held rows to the
     * statement review screen for the same reason: that one writes an undoable
     * batch and de-duplicates against the ledger.
     *
     * Wiring this one up would have made a THIRD path that writes financial
     * records, with its own store and its own idea of what a filed row is.
     * That is how two shapes of "expense" end up in one array. It is deleted
     * rather than repaired; wealthflow-review.js is the one that answers the
     * requirement, and test/mail_filing_test.js pins that the mail path reaches
     * the review screen rather than inventing a second writer.
     * ========================================================================= */

    /* The icon system's lock, or nothing. NEVER an emoji: a system-font glyph
     * is a fixed colour that cannot follow the theme, and this app's rule is
     * inline SVG that inherits currentColor. Falls back to empty rather than to
     * a character, because a missing icon is invisible and a stray glyph is
     * the thing being removed. */
    function _lockIcon() {
        try { return (window.WFIcon && window.WFIcon.has && window.WFIcon.has('lock')) ? window.WFIcon('lock') : ''; }
        catch (_) { return ''; }
    }

    /* tiny modal overlay helper (self-contained; does not depend on app modals) */
    function _overlay(title, bodyHtml) {
        var o = document.createElement('div');
        o.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
        o.innerHTML = '<div style="background:var(--card,#1a1f2e);border:1px solid var(--border2,#2a3142);border-radius:16px;max-width:420px;width:100%;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
            '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
            '<div style="font-weight:800;font-size:16px;">' + title + '</div>' +
            '<button class="_ovX" style="background:transparent;border:none;color:var(--text3,#8b95a8);font-size:22px;cursor:pointer;line-height:1;">×</button>' +
            '</div>' + bodyHtml + '</div>';
        o.addEventListener('click', function (e) { if (e.target === o) o.remove(); });
        o.querySelector('._ovX').onclick = function () { o.remove(); };
        document.body.appendChild(o);
        return o;
    }

    /* =========================================================================
     * SETTINGS — Vault management modal
     * ========================================================================= */
    async function openVaultModal() {
        var v = await vaultGet();
        var last4 = (v && v.last4 || []).join(', ');
        var html = '' +
            '<div style="font-size:12.5px;color:var(--text2);line-height:1.6;margin-bottom:14px;">' +
              'Stored <b>encrypted on this device only</b> (AES-256). Never uploaded in plaintext. ' +
              'Used to automatically unlock password-protected bank-statement PDFs.' +
            '</div>' +
            '<label style="font-size:12px;color:var(--text3);">Card last-4 digits (comma separated)</label>' +
            '<input id="_vLast4" class="fi" style="width:100%;margin:4px 0 12px;" inputmode="numeric" placeholder="1234, 5678" value="' + _esc(last4) + '">' +
            '<label style="font-size:12px;color:var(--text3);">NIC number</label>' +
            '<input id="_vNic" class="fi" style="width:100%;margin:4px 0 12px;" placeholder="200012345678 or 921234567V" value="' + _esc(v && v.nic || '') + '">' +
            '<label style="font-size:12px;color:var(--text3);">Date of birth</label>' +
            '<input id="_vDob" type="date" class="fi" style="width:100%;margin:4px 0 16px;" value="' + _esc(v && v.dob || '') + '">' +
            '<button class="btn btn-primary" id="_vSave" style="width:100%;margin-bottom:8px;">' + _lockIcon() + ' Save securely</button>' +
            (vaultExists() ? '<button class="btn btn-secondary" id="_vClear" style="width:100%;background:transparent;border:1px solid var(--border);color:var(--text3);">Clear vault</button>' : '');
        var o = _overlay(_lockIcon() + ' Security Vault', html);
        o.querySelector('#_vSave').onclick = async function () {
            try {
                await vaultSave({
                    last4: (o.querySelector('#_vLast4').value || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean),
                    nic: o.querySelector('#_vNic').value,
                    dob: o.querySelector('#_vDob').value
                });
                _notify('Vault saved and encrypted on this device', 'success');
                o.remove();
            } catch (e) { _notify('Save failed: ' + (e && e.message), 'error'); }
        };
        if (o.querySelector('#_vClear')) o.querySelector('#_vClear').onclick = function () {
            vaultClear(); _notify('Vault cleared', 'info'); o.remove();
        };
    }

    /* =========================================================================
     * EXPOSE
     * ========================================================================= */
    window.wfVault = { save: vaultSave, get: vaultGet, exists: vaultExists, clear: vaultClear, openModal: openVaultModal };
    window.wfVaultPdfPasswords = vaultPdfPasswords;     // consumed by wealthflow-ai-v4.js PDF loader
    window.wfTrySemanticAllocate = trySemanticAllocate;  // consumed by wealthflow-autonomous.js
    window.wfMatchGoalOrLoan = matchGoalOrLoan;
    /* window.wfQuarantineAdd, window.wfQ and window.renderQuarantineTile are
     * gone with the code above, along with the timer that rendered a tile into
     * an element no page has. Nothing called any of them: the only reference in
     * the repository was index.html's own call to renderQuarantineTile(), which
     * has already been removed. window.wfReview is the review queue. */

    console.log('[' + V + '] Intelligence layer ready — Vault · Semantic Allocation');
})();
