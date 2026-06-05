/*  wealthflow-html-statement.js — encrypted HTML e-statement support
 *
 *  Banks like Nations Trust Bank send "Smart Statements" as an HTML file whose
 *  content is AES-encrypted and unlocked with the customer's date of birth
 *  (DDMMYYYY). The HTML normally tells you to open it in the "HTML Viewer Q" app.
 *  This module lets WealthFlow open it DIRECTLY: the user enters the DDMMYYYY
 *  password, we decrypt it in-app (exact replica of the bank's CryptoJS scheme),
 *  pull out the transactions, and hand them to the parser + router — no external
 *  app, no manual copying.
 *
 *  window.WFHtmlStatement = { isEncryptedHtmlStatement, looksLikeStatementFile,
 *                             getStatementText, decrypt, htmlToText, promptPassword }
 *
 *  Usage (upload handler):
 *     const r = await WFHtmlStatement.getStatementText(file);   // prompts for DOB
 *     if (r.cancelled) return;
 *     const txns = WFStatementParser.parseStatementText(r.text);
 */
(function () {
    'use strict';

    // ── load CryptoJS on demand (only when an encrypted HTML statement opens) ───
    var _cjs = null;
    function ensureCryptoJS() {
        if (window.CryptoJS && window.CryptoJS.PBKDF2) return Promise.resolve(window.CryptoJS);
        if (_cjs) return _cjs;
        var urls = [
            'https://cdnjs.cloudflare.com/ajax/libs/crypto-js/4.2.0/crypto-js.min.js',
            'https://cdn.jsdelivr.net/npm/crypto-js@4.2.0/crypto-js.min.js'
        ];
        _cjs = new Promise(function (resolve, reject) {
            var i = 0;
            (function next() {
                if (i >= urls.length) return reject(new Error('CryptoJS failed to load'));
                var s = document.createElement('script');
                s.src = urls[i++];
                s.onload = function () { (window.CryptoJS && window.CryptoJS.PBKDF2) ? resolve(window.CryptoJS) : next(); };
                s.onerror = next;
                document.head.appendChild(s);
            })();
        });
        return _cjs;
    }

    // Is this an encrypted HTML statement we know how to open? (NTB-style)
    function isEncryptedHtmlStatement(htmlText) {
        if (!htmlText) return false;
        var t = String(htmlText);
        var hasEmbedded = /var\s+embedded\s*=\s*["']/.test(t);
        var hasCrypto = /CryptoJS|PBKDF2|decryptDocument/.test(t);
        var hasGate = /password protected|Date of Birth|DDMMYYYY|Smart Statement/i.test(t);
        return hasEmbedded && hasCrypto && (hasGate || /CipherParams/.test(t));
    }

    // A statement file at all? (encrypted or a plain HTML statement)
    function looksLikeStatementFile(htmlText) {
        if (isEncryptedHtmlStatement(htmlText)) return true;
        return /statement|transaction|opening balance|closing balance|account (no|number)|card (no|number)/i.test(String(htmlText || ''));
    }

    function _params(htmlText) {
        var t = String(htmlText);
        return {
            embedded: (t.match(/var\s+embedded\s*=\s*"([^"]+)"/) || [])[1] || '',
            salt: (t.match(/var\s+salt\s*=\s*"([0-9a-fA-F]+)"/) || [])[1] || '',
            iv: (t.match(/var\s+iv\s*=\s*"([0-9a-fA-F]+)"/) || [])[1] || '',
            iterations: parseInt((t.match(/iterations:\s*(\d+)/) || [])[1], 10) || 15000,
            keySize: parseInt((t.match(/keySize:\s*(\d+)/) || [])[1], 10) || 4
        };
    }

    // EXACT replica of the bank's decryptDocument(): PBKDF2 → AES-decrypt.
    // Returns the decrypted statement HTML, or '' on a wrong password.
    async function decrypt(htmlText, password) {
        var C = await ensureCryptoJS();
        var p = _params(htmlText);
        if (!p.embedded || !p.salt || !p.iv) throw new Error('not a recognised encrypted statement');
        try {
            var key = C.PBKDF2(password, C.enc.Hex.parse(p.salt), { keySize: p.keySize, iterations: p.iterations });
            var cipherParams = C.lib.CipherParams.create({ ciphertext: C.enc.Base64.parse(p.embedded) });
            var dec = C.AES.decrypt(cipherParams, key, { iv: C.enc.Hex.parse(p.iv) });
            return dec.toString(C.enc.Utf8); // throws "Malformed UTF-8" on a wrong password
        } catch (e) {
            return ''; // wrong password — caller re-prompts
        }
    }

    // Pull transaction-bearing text out of the decrypted statement HTML.
    // Prefers table rows (one transaction per line); falls back to stripped text.
    function htmlToText(html) {
        if (!html) return '';
        var lines = [];
        // Browser: use a real parser when available
        try {
            if (typeof DOMParser !== 'undefined') {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                var trs = doc.querySelectorAll('tr');
                if (trs && trs.length) {
                    trs.forEach(function (tr) {
                        var cells = tr.querySelectorAll('td,th');
                        var parts = [];
                        cells.forEach(function (c) { var v = (c.textContent || '').replace(/\s+/g, ' ').trim(); if (v) parts.push(v); });
                        if (parts.length) lines.push(parts.join('  '));
                    });
                }
                if (lines.length < 3) {
                    var body = (doc.body && doc.body.textContent) || '';
                    body.split(/\n+/).forEach(function (l) { l = l.replace(/\s+/g, ' ').trim(); if (l) lines.push(l); });
                }
                return lines.join('\n');
            }
        } catch (_) { /* fall through to regex */ }
        // Non-DOM fallback (also used in tests): extract <tr> rows, then strip tags
        var rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;
        while ((m = rowRe.exec(html))) {
            var cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, cm, parts2 = [];
            while ((cm = cellRe.exec(m[1]))) {
                var v2 = cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
                if (v2) parts2.push(v2);
            }
            if (parts2.length) lines.push(parts2.join('  '));
        }
        if (lines.length < 3) {
            var stripped = html.replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
            stripped.split(/\n+/).forEach(function (l) { l = l.replace(/\s+/g, ' ').trim(); if (l) lines.push(l); });
        }
        return lines.join('\n');
    }

    // ── direct table → transactions (best-effort; the review modal lets the user fix) ─
    var _MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    function _pad(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    function _toISO(s) {
        s = String(s || '').trim();
        var m = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
        if (m) { var y = m[3].length === 2 ? ('20' + m[3]) : m[3]; return y + '-' + _pad(m[2]) + '-' + _pad(m[1]); }
        var mn = s.match(/^(\d{1,2})[\s\-]+([A-Za-z]{3,})[\s\-]+(\d{4})$/);
        if (mn) { var mo = _MONTHS[mn[2].slice(0, 3).toLowerCase()]; if (mo) return mn[3] + '-' + mo + '-' + _pad(mn[1]); }
        return '';
    }
    function _num(s) {
        var t = String(s || '').trim();
        var body = t.replace(/^(lkr|rs|usd|\$|€|£)\.?\s*/i, '');     // drop a leading currency code/symbol
        // Whole cell must be a money token: comma-grouped and/or decimal, optional ()/sign/Cr/Dr.
        var mm = body.match(/^\(?\s*(-?)\s*((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)\s*\)?\s*(cr|dr)?\.?$/i);
        if (!mm) return null;
        if (!/[.,]/.test(mm[2])) return null;                        // excludes bare ints like "03" / "100"
        var v = parseFloat(mm[2].replace(/,/g, ''));
        if (isNaN(v)) return null;
        var neg = mm[1] === '-' || /^\(/.test(body) || /dr/i.test(mm[3] || '');
        return neg ? -v : v;
    }
    function _tableRows(html) {
        var rows = [];
        try {
            if (typeof DOMParser !== 'undefined') {
                var doc = new DOMParser().parseFromString(html, 'text/html');
                doc.querySelectorAll('tr').forEach(function (tr) {
                    var cells = [];
                    tr.querySelectorAll('td,th').forEach(function (c) { cells.push((c.textContent || '').replace(/\s+/g, ' ').trim()); });
                    if (cells.length) rows.push(cells);
                });
                return rows;
            }
        } catch (_) {}
        var rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi, m;
        while ((m = rowRe.exec(html))) {
            var cellRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi, cm, cells2 = [];
            while ((cm = cellRe.exec(m[1]))) cells2.push(cm[1].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim());
            if (cells2.length) rows.push(cells2);
        }
        return rows;
    }
    var _RE_CR = /\b(cr|credit|deposit|salary|interest|dividend|refund|reversal|inward|received)\b/i;
    function htmlToTransactions(html) {
        var txns = [];
        _tableRows(html).forEach(function (cells) {
            var date = '', desc = [], amts = [];
            cells.forEach(function (c) {
                var iso = _toISO(c);
                if (iso && !date) { date = iso; return; }
                var n = _num(c);
                if (n != null && Math.abs(n) >= 1) { amts.push(n); return; }
                if (c) desc.push(c);
            });
            if (!date || !amts.length) return;                 // not a transaction row
            var amount = Math.abs(amts[0]);                    // first money figure (balance, if any, comes later)
            var rowText = cells.join(' ');
            var direction = (_RE_CR.test(rowText) || amts[0] < 0) ? 'credit' : 'debit';
            txns.push({ date: date, narration: desc.join(' ').trim() || 'Transaction', amount: amount, direction: direction, valid: true, _source: 'html' });
        });
        return txns;
    }

    // ── DDMMYYYY password prompt (with the bank's date-of-birth hint) ────────────
    function promptPassword(isRetry) {
        return new Promise(function (resolve) {
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
            ov.innerHTML =
                '<div style="background:var(--card,#11182a);border:1px solid var(--border2,#243049);border-radius:16px;padding:22px;max-width:360px;width:90%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
                    '<div style="font-size:16px;font-weight:800;color:var(--text,#e2e8f0);display:flex;align-items:center;gap:8px;">🔒 Protected e-Statement</div>' +
                    '<div style="font-size:13px;color:var(--text2,#94a3b8);margin:8px 0 4px;">This bank statement is locked. Enter your <b>date of birth</b> as the password.</div>' +
                    '<div style="font-size:12px;color:var(--text3,#64748b);margin-bottom:12px;">Format: <b>DDMMYYYY</b> — e.g. 23 October 1984 → <b>23101984</b></div>' +
                    (isRetry ? '<div style="font-size:12px;color:#ef4444;margin-bottom:8px;">Incorrect password — please try again.</div>' : '') +
                    '<input id="wfHtmlPw" type="password" inputmode="numeric" autocomplete="off" placeholder="DDMMYYYY" maxlength="8" style="width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border2,#243049);background:var(--bg,#0b0f1a);color:var(--text,#e2e8f0);font-size:15px;letter-spacing:2px;outline:none;text-align:center;" />' +
                    '<div style="display:flex;gap:8px;margin-top:14px;">' +
                        '<button id="wfHtmlCancel" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2,#243049);background:transparent;color:var(--text2,#94a3b8);font-weight:700;cursor:pointer;">Cancel</button>' +
                        '<button id="wfHtmlOk" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;">Unlock &amp; import</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(ov);
            var input = ov.querySelector('#wfHtmlPw');
            if (input) setTimeout(function () { input.focus(); }, 50);
            function done(v) { try { ov.remove(); } catch (_) {} resolve(v); }
            ov.querySelector('#wfHtmlCancel').onclick = function () { done(null); };
            ov.querySelector('#wfHtmlOk').onclick = function () { done(input ? input.value.trim() : ''); };
            if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(input.value.trim()); if (e.key === 'Escape') done(null); });
        });
    }

    // Orchestrate: read file → detect → prompt DOB → decrypt (re-prompt on wrong) → text
    async function getStatementText(file, askPassword) {
        var raw = await file.text();
        // Plain (unencrypted) HTML statement → extract its text + rows directly
        if (!isEncryptedHtmlStatement(raw)) {
            if (looksLikeStatementFile(raw)) return { cancelled: false, encrypted: false, text: htmlToText(raw), transactions: htmlToTransactions(raw) };
            return { cancelled: false, encrypted: false, text: '', transactions: [], notStatement: true };
        }
        var ask = askPassword || promptPassword;
        for (var attempt = 0; attempt < 6; attempt++) {
            var pw = await ask(attempt > 0);
            if (pw === null || pw === undefined) return { cancelled: true, encrypted: true, text: '', transactions: [] };
            var html = await decrypt(raw, pw);
            if (html && html.length > 20) return { cancelled: false, encrypted: true, text: htmlToText(html), transactions: htmlToTransactions(html), decryptedHtml: html };
            // else wrong password → loop and re-prompt
        }
        return { cancelled: true, encrypted: true, text: '', transactions: [] };
    }

    window.WFHtmlStatement = {
        isEncryptedHtmlStatement: isEncryptedHtmlStatement,
        looksLikeStatementFile: looksLikeStatementFile,
        getStatementText: getStatementText,
        decrypt: decrypt,
        htmlToText: htmlToText,
        htmlToTransactions: htmlToTransactions,
        promptPassword: promptPassword,
        _params: _params
    };
    try { console.log('[WFHtmlStatement] ✓ encrypted HTML e-statement support ready'); } catch (_) {}
})();
