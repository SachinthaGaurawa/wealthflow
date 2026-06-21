/*  wealthflow-html-statement.js — encrypted HTML e-statement support
 *  ===========================================================================
 *  Nations Trust Bank (AMEX / Magnet) and similar banks email a "Smart
 *  Statement" as a single self-contained .html file. The transaction data is
 *  AES-encrypted inside the file and unlocked in-page with the cardholder's
 *  Date of Birth (DDMMYYYY). WealthFlow opens these directly — no need to view
 *  the file in a browser first.
 *
 *  Exact scheme discovered in the real file:
 *     var embedded = "<base64 ciphertext>";
 *     salt  = "<32 hex chars>";   iv = "<32 hex chars>";
 *     key   = CryptoJS.PBKDF2(password, Hex.parse(salt), {keySize:4, iterations:15000});
 *     plain = CryptoJS.AES.decrypt({ciphertext:Base64.parse(embedded)}, key, {iv:Hex.parse(iv)})
 *                       .toString(CryptoJS.enc.Utf8);
 *     document.write(atob(encodeUnicode(plain)));   // UTF-8 round-trip → inner HTML
 *  A WRONG password throws "Malformed UTF-8 data".
 *
 *  This module is memory-careful: the embedded ciphertext can be ~4 MB, so on
 *  mobile we avoid copying it more than necessary and release references.
 *
 *  Public API (window.WFHtmlStatement):
 *    isEncryptedHtmlStatement(text)        → bool
 *    looksLikeStatement(htmlOrText)        → bool
 *    ensureCryptoJS()                      → Promise (loads CDN CryptoJS if absent)
 *    decrypt(fileText, password)           → Promise<string htmlOrEmpty>
 *    htmlToText(html)                      → string
 *    htmlToTransactions(html)              → [{date,narration,amount,direction}]
 *    promptPassword()                      → Promise<string|null>  (DDMMYYYY UI)
 *    getStatementText(file)                → Promise<{ok,html,text,transactions,meta}>
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFHtmlStatement) return;

    var CRYPTOJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js';

    // ── detection ────────────────────────────────────────────────────────────
    function isEncryptedHtmlStatement(text) {
        if (!text || typeof text !== 'string') return false;
        // Strong signals from the real NTB file.
        var hasEmbedded = /var\s+embedded\s*=\s*["']/.test(text);
        var hasDecryptFn = /function\s+decryptDocument\s*\(/.test(text) || /CryptoJS\.AES\.decrypt/.test(text);
        var hasPbkdf2 = /CryptoJS\.PBKDF2/.test(text);
        return hasEmbedded && (hasDecryptFn || hasPbkdf2);
    }

    function looksLikeStatement(html) {
        if (!html) return false;
        var t = String(html).toLowerCase();
        var hits = 0;
        ['transaction', 'statement', 'closing balance', 'opening balance', 'payment due',
         'credit limit', 'post date', 'amount', 'card no', 'account no'].forEach(function (k) {
            if (t.indexOf(k) >= 0) hits++;
        });
        return hits >= 3;
    }

    // ── CryptoJS loader (CDN, cached) ──────────────────────────────────────────
    var _cryptoPromise = null;
    function ensureCryptoJS() {
        if (window.CryptoJS && window.CryptoJS.AES) return Promise.resolve(window.CryptoJS);
        if (_cryptoPromise) return _cryptoPromise;
        _cryptoPromise = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = CRYPTOJS_CDN;
            s.async = true;
            s.onload = function () { window.CryptoJS ? resolve(window.CryptoJS) : reject(new Error('CryptoJS missing after load')); };
            s.onerror = function () { reject(new Error('Could not load decryption library (offline?)')); };
            (document.head || document.documentElement).appendChild(s);
        });
        return _cryptoPromise;
    }

    // ── extract the embedded params from the file text ─────────────────────────
    function _params(text) {
        var out = { embedded: '', salt: '', iv: '', iterations: 15000, keySize: 4 };
        var m;
        m = text.match(/var\s+embedded\s*=\s*["']([\s\S]*?)["']\s*;/);
        if (m) out.embedded = m[1];
        // salt / iv are 32-hex-char strings assigned to vars named salt / iv
        m = text.match(/\bsalt\s*=\s*["']([0-9a-fA-F]{16,})["']/);
        if (m) out.salt = m[1];
        m = text.match(/\biv\s*=\s*["']([0-9a-fA-F]{16,})["']/);
        if (m) out.iv = m[1];
        m = text.match(/iterations\s*:\s*(\d+)/);
        if (m) out.iterations = parseInt(m[1], 10) || 15000;
        m = text.match(/keySize\s*:\s*(\d+)/);
        if (m) out.keySize = parseInt(m[1], 10) || 4;
        return out;
    }

    // UTF-8 safe decode mirroring the file's atob(encodeUnicode(x)). In practice
    // the decrypted UTF-8 string already IS the inner HTML; this is a guard that
    // also handles statements whose inner payload is base64-wrapped.
    function _maybeUnwrap(plain) {
        if (!plain) return plain;
        var head = plain.slice(0, 200).replace(/^\s+/, '');
        // Already HTML → use as-is.
        if (/^<!doctype/i.test(head) || /^<html/i.test(head) || /<table/i.test(plain.slice(0, 4000))) return plain;
        // Looks like pure base64 → try one decode (covers banks that double-wrap).
        if (/^[A-Za-z0-9+/=\s]+$/.test(head) && plain.length > 100) {
            try {
                var bin = atob(plain.replace(/\s+/g, ''));
                // decode as UTF-8
                var bytes = new Uint8Array(bin.length);
                for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                var dec = new TextDecoder('utf-8').decode(bytes);
                if (/<html|<table|<!doctype/i.test(dec.slice(0, 4000))) return dec;
            } catch (_) {}
        }
        return plain;
    }

    // ── decrypt (returns inner HTML, or '' on wrong password) ───────────────────
    function decrypt(fileText, password) {
        return ensureCryptoJS().then(function (CryptoJS) {
            var p = _params(fileText);
            if (!p.embedded || !p.salt || !p.iv) throw new Error('This file is not a recognised encrypted statement.');
            var key = CryptoJS.PBKDF2(password, CryptoJS.enc.Hex.parse(p.salt), { keySize: p.keySize, iterations: p.iterations });
            var cipherParams = CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(p.embedded) });
            var decrypted = CryptoJS.AES.decrypt(cipherParams, key, { iv: CryptoJS.enc.Hex.parse(p.iv) });
            var plain = '';
            try {
                plain = decrypted.toString(CryptoJS.enc.Utf8);  // throws "Malformed UTF-8" on wrong pw
            } catch (e) {
                return '';   // wrong password
            }
            // free big refs
            cipherParams = null; decrypted = null; key = null;
            if (!plain) return '';
            return _maybeUnwrap(plain);
        });
    }

    // ── HTML → text / transactions ──────────────────────────────────────────────
    function htmlToText(html) {
        try {
            var doc = new DOMParser().parseFromString(html, 'text/html');
            // remove scripts/styles
            doc.querySelectorAll('script,style,noscript').forEach(function (n) { n.remove(); });
            return (doc.body ? doc.body.innerText || doc.body.textContent : '') || '';
        } catch (_) {
            return String(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
    }

    // money: first standalone money-looking number in a string (NOT a balance col)
    function _num(s) {
        if (s == null) return null;
        var m = String(s).replace(/[, ]/g, function (c) { return c === ',' ? '' : ' '; })
            .match(/-?\d+(?:\.\d{1,2})?/);
        if (!m) return null;
        var v = parseFloat(m[0]);
        return isNaN(v) ? null : v;
    }

    function _toISO(d) {
        if (!d) return '';
        d = String(d).trim();
        var m;
        // DD/MM/YYYY or DD-MM-YYYY
        m = d.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/);
        if (m) { var y = m[3].length === 2 ? '20' + m[3] : m[3]; return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); }
        // "05 May 2026" / "05 MAY 2026" / "05 May"
        var MON = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
        m = d.match(/^(\d{1,2})\s+([A-Za-z]{3,})\.?\s*(\d{4})?$/);
        if (m) {
            var mm = MON[m[2].slice(0, 3).toLowerCase()];
            if (mm) {
                var yr = m[3] || String(new Date().getFullYear());
                return yr + '-' + mm + '-' + String(m[1]).padStart(2, '0');
            }
        }
        // already ISO
        m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) return d;
        return '';
    }

    // Parse the transaction table(s). NTB rows look like:
    //   Post Date | Transaction Date | Description | Currency | Amount | Amount(LKR) Dr/Cr
    function htmlToTransactions(html) {
        var out = [];
        var doc;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); }
        catch (_) { return out; }

        var tables = Array.prototype.slice.call(doc.querySelectorAll('table'));
        tables.forEach(function (table) {
            var rows = Array.prototype.slice.call(table.querySelectorAll('tr'));
            rows.forEach(function (tr) {
                var cells = Array.prototype.slice.call(tr.querySelectorAll('td')).map(function (td) {
                    return (td.innerText || td.textContent || '').replace(/\u00a0/g, ' ').trim();
                });
                if (cells.length < 3) return;

                // Find a date cell + a description cell + an amount cell.
                var dateISO = '';
                for (var i = 0; i < cells.length && !dateISO; i++) dateISO = _toISO(cells[i]);
                if (!dateISO) return;

                // direction: a trailing "Dr"/"Cr" on the row, or a credit/debit word
                var rowText = cells.join(' ');
                var dir = /\bCr\b/i.test(cells[cells.length - 1]) || /\bcredit\b/i.test(rowText) ? 'credit' : 'debit';
                if (/\bDr\b/i.test(cells[cells.length - 1])) dir = 'debit';

                // amount: prefer a cell that has Dr/Cr, else the first money cell
                // that ISN'T the date and ISN'T a pure currency code.
                var amount = null;
                for (var j = cells.length - 1; j >= 0; j--) {
                    if (/\b(Dr|Cr)\b/i.test(cells[j])) { amount = _num(cells[j]); if (amount != null) break; }
                }
                if (amount == null) {
                    for (var k = 0; k < cells.length; k++) {
                        if (_toISO(cells[k])) continue;            // skip date cells
                        if (/^[A-Z]{3}$/.test(cells[k])) continue; // skip "LKR"/"USD"
                        var v = _num(cells[k]);
                        if (v != null && Math.abs(v) >= 1) { amount = v; break; }
                    }
                }
                if (amount == null || Math.abs(amount) < 0.01) return;

                // narration: the longest non-numeric, non-date, non-currency cell
                var narration = '';
                cells.forEach(function (c) {
                    if (_toISO(c)) return;
                    if (/^[A-Z]{3}$/.test(c)) return;
                    if (/^-?[\d,]+(?:\.\d{1,2})?\s*(Dr|Cr)?$/i.test(c)) return;
                    if (c.length > narration.length) narration = c;
                });
                if (!narration) return;

                out.push({ date: dateISO, narration: narration, amount: Math.abs(amount), direction: dir });
            });
        });

        // De-dupe identical rows that appear in both summary + detail tables.
        var seen = {}, dedup = [];
        out.forEach(function (t) {
            var key = t.date + '|' + t.narration.toLowerCase() + '|' + t.amount + '|' + t.direction;
            if (seen[key]) return;
            seen[key] = 1; dedup.push(t);
        });
        return dedup;
    }

    // pull a few header fields for display / dedup
    function _meta(html) {
        var meta = { card_last4: '', period: '', holder: '' };
        var text = htmlToText(html);
        var m;
        m = text.match(/Card\s*No\.?\s*[:#]?\s*([0-9X*]{8,})/i);
        if (m) { var d = m[1].replace(/[^0-9]/g, ''); meta.card_last4 = d.slice(-4); }
        m = text.match(/Statement\s*Period\s*[:]?\s*([0-9A-Za-z\- ]+to[0-9A-Za-z\- ]+)/i);
        if (m) meta.period = m[1].trim();
        return meta;
    }

    // ── password UI (DDMMYYYY) ──────────────────────────────────────────────────
    function promptPassword() {
        return new Promise(function (resolve) {
            var ov = document.createElement('div');
            ov.className = 'mo';
            ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,6,14,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .2s;';
            ov.innerHTML =
                '<div style="width:100%;max-width:380px;background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:18px;padding:22px;">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
                (window.WFIcon ? WFIcon.svg('lock', ' width="22" height="22" style="color:var(--accent,#f5a623)"') : '') +
                '<div style="font-size:17px;font-weight:800;color:var(--text,#e8edf5);">Unlock e-statement</div></div>' +
                '<div style="font-size:12.5px;color:var(--text3,#8a97ad);line-height:1.55;margin-bottom:14px;">This bank statement is password-protected. Enter the cardholder\u2019s <b>Date of Birth</b> in <b>DDMMYYYY</b> format (e.g. 05071990).</div>' +
                '<input id="_wfhsPw" type="tel" inputmode="numeric" maxlength="8" placeholder="DDMMYYYY" autofocus ' +
                'style="width:100%;box-sizing:border-box;font-family:var(--mono,monospace);font-size:20px;letter-spacing:6px;text-align:center;padding:12px;border-radius:12px;border:1px solid var(--border2,#243049);background:var(--bg2,#0a0f1a);color:var(--text,#e8edf5);">' +
                '<div id="_wfhsErr" style="color:#ef4444;font-size:12px;text-align:center;min-height:18px;margin-top:8px;"></div>' +
                '<div style="display:flex;gap:10px;margin-top:8px;">' +
                '<button id="_wfhsCancel" style="flex:1;padding:12px;border-radius:12px;border:1px solid var(--border2,#243049);background:transparent;color:var(--text2,#aeb9cc);font-weight:700;cursor:pointer;">Cancel</button>' +
                '<button id="_wfhsOk" style="flex:2;padding:12px;border-radius:12px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;">Unlock</button>' +
                '</div></div>';
            document.body.appendChild(ov);
            requestAnimationFrame(function () { ov.style.opacity = '1'; });
            var inp = ov.querySelector('#_wfhsPw');
            var err = ov.querySelector('#_wfhsErr');
            function close(val) { ov.style.opacity = '0'; setTimeout(function () { ov.remove(); }, 200); resolve(val); }
            ov.querySelector('#_wfhsCancel').onclick = function () { close(null); };
            ov.querySelector('#_wfhsOk').onclick = function () {
                var v = (inp.value || '').replace(/\D/g, '');
                if (v.length !== 8) { err.textContent = 'Enter all 8 digits (DDMMYYYY).'; return; }
                close(v);
            };
            inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') ov.querySelector('#_wfhsOk').click(); });
            ov.addEventListener('click', function (e) { if (e.target === ov) close(null); });
            // expose a way to show an inline error and re-prompt without rebuilding
            ov._setError = function (msg) { err.textContent = msg; inp.value = ''; inp.focus(); };
            ov._inp = inp;
            window.__wfhsActiveOverlay = ov;
            setTimeout(function () { try { inp.focus(); } catch (_) {} }, 250);
        });
    }

    // ── top-level: read a File, detect, decrypt (retrying password), parse ──────
    function _readFileText(file) {
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () { resolve(String(r.result || '')); };
            r.onerror = function () { reject(new Error('Could not read the file.')); };
            r.readAsText(file);
        });
    }

    function getStatementText(file) {
        return _readFileText(file).then(function (text) {
            // Plain (already-decrypted) statement HTML?
            if (!isEncryptedHtmlStatement(text)) {
                if (looksLikeStatement(text)) {
                    return { ok: true, encrypted: false, html: text, text: htmlToText(text), transactions: htmlToTransactions(text), meta: _meta(text) };
                }
                return { ok: false, notStatement: true, reason: 'Not a bank statement HTML file.' };
            }
            // Encrypted → prompt for DOB, retry up to 3 times.
            var attempts = 0;
            function tryOnce() {
                return promptPassword().then(function (pw) {
                    if (pw == null) return { ok: false, cancelled: true };
                    return decrypt(text, pw).then(function (html) {
                        if (html && (looksLikeStatement(html) || /<table/i.test(html))) {
                            // success — close the active overlay if still open
                            try { if (window.__wfhsActiveOverlay) { window.__wfhsActiveOverlay.style.opacity = '0'; setTimeout(function () { window.__wfhsActiveOverlay && window.__wfhsActiveOverlay.remove(); window.__wfhsActiveOverlay = null; }, 150); } } catch (_) {}
                            return { ok: true, encrypted: true, html: html, text: htmlToText(html), transactions: htmlToTransactions(html), meta: _meta(html) };
                        }
                        attempts++;
                        if (attempts >= 3) {
                            try { if (window.__wfhsActiveOverlay) { window.__wfhsActiveOverlay.remove(); window.__wfhsActiveOverlay = null; } } catch (_) {}
                            return { ok: false, wrongPassword: true, reason: 'Incorrect Date of Birth (3 attempts).' };
                        }
                        // wrong password → show error in the SAME overlay and re-prompt
                        return new Promise(function (res) {
                            try {
                                var ov = window.__wfhsActiveOverlay;
                                if (ov && ov._setError) { ov._setError('Incorrect Date of Birth. Try again (' + (3 - attempts) + ' left).'); ov._inp.onkeydown = null; }
                            } catch (_) {}
                            // reuse overlay: wait for the user to submit again
                            var ov2 = window.__wfhsActiveOverlay;
                            if (ov2) {
                                ov2.querySelector('#_wfhsOk').onclick = function () {
                                    var v = (ov2._inp.value || '').replace(/\D/g, '');
                                    if (v.length !== 8) { ov2._setError('Enter all 8 digits (DDMMYYYY).'); return; }
                                    decrypt(text, v).then(function (h2) {
                                        if (h2 && (looksLikeStatement(h2) || /<table/i.test(h2))) {
                                            ov2.style.opacity = '0'; setTimeout(function () { ov2.remove(); window.__wfhsActiveOverlay = null; }, 150);
                                            res({ ok: true, encrypted: true, html: h2, text: htmlToText(h2), transactions: htmlToTransactions(h2), meta: _meta(h2) });
                                        } else {
                                            attempts++;
                                            if (attempts >= 3) { ov2.remove(); window.__wfhsActiveOverlay = null; res({ ok: false, wrongPassword: true, reason: 'Incorrect Date of Birth (3 attempts).' }); }
                                            else ov2._setError('Incorrect Date of Birth. Try again (' + (3 - attempts) + ' left).');
                                        }
                                    });
                                };
                                ov2._inp.onkeydown = function (e) { if (e.key === 'Enter') ov2.querySelector('#_wfhsOk').click(); };
                            } else {
                                res({ ok: false, wrongPassword: true });
                            }
                        });
                    });
                });
            }
            return tryOnce();
        });
    }

    window.WFHtmlStatement = {
        isEncryptedHtmlStatement: isEncryptedHtmlStatement,
        looksLikeStatement: looksLikeStatement,
        ensureCryptoJS: ensureCryptoJS,
        decrypt: decrypt,
        htmlToText: htmlToText,
        htmlToTransactions: htmlToTransactions,
        promptPassword: promptPassword,
        getStatementText: getStatementText,
        _params: _params
    };
    try { console.log('[WFHtmlStatement] \u2713 encrypted e-statement support ready'); } catch (_) {}
})();
