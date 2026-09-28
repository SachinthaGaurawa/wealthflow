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
 *    htmlToTransactionsAsync(html)         → Promise<{transactions,rendered,renderedHtml}>
 *    renderInSandbox(html)                 → Promise<string>  (runs it, see below)
 *    promptPassword()                      → Promise<string|null>  (DDMMYYYY UI)
 *    getStatementText(file)                → Promise<{ok,html,text,transactions,meta}>
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFHtmlStatement) return;

    // ── detection ────────────────────────────────────────────────────────────
    function isEncryptedHtmlStatement(text) {
        if (!text || typeof text !== 'string') return false;
        // Strong signals from the real NTB file.
        // var/let/const, and the payload is not always called `embedded`.
        var hasEmbedded = /\b(?:var|let|const)\s+(?:embedded|payload|cipher(?:text)?|encrypted|data)\s*=\s*["']/i.test(text);
        var hasDecryptFn = /function\s+decrypt\w*\s*\(/.test(text) || /CryptoJS\.AES\.decrypt/.test(text)
            || /subtle\.decrypt/.test(text);
        var hasPbkdf2 = /CryptoJS\.PBKDF2/.test(text) || /PBKDF2/.test(text);
        return hasEmbedded && (hasDecryptFn || hasPbkdf2);
    }

    /* Requiring THREE keyword hits rejected a perfectly real but sparse statement —
     * a heading, a table and nothing else scores one. That matters twice over,
     * because this same function decides whether a decryption SUCCEEDED: a correct
     * Date of Birth on such a file was reported as "Incorrect Date of Birth".
     *
     * Two hits now, over a wider vocabulary, OR the structural signal that settles
     * it outright — a row carrying both a date and an amount. Wrong-password
     * detection is unaffected: a bad key fails PKCS7 unpadding and yields an empty
     * string long before this is consulted. */
    function looksLikeStatement(html) {
        if (!html) return false;
        var t = String(html).toLowerCase();
        var hits = 0;
        ['transaction', 'statement', 'closing balance', 'opening balance', 'payment due',
         'credit limit', 'post date', 'amount', 'card no', 'account no', 'balance',
         'e-statement', 'cardholder', 'due date', 'minimum payment', 'available credit',
         'account summary', 'value date', 'description', 'particulars', 'narration'].forEach(function (k) {
            if (t.indexOf(k) >= 0) hits++;
        });
        if (hits >= 2) return true;
        // A line with a date AND a money amount is a transaction, whatever it is called.
        return /\d{1,4}[\/\-. ][A-Za-z0-9]{2,9}[\/\-. ]\d{2,4}[\s\S]{0,120}?\d[.,]\d{2}\b/.test(t);
    }

    /* Did the decryption succeed? A WRONG key fails PKCS7 unpadding and produces an
     * empty string, so anything structured here came from the right one. Requiring
     * a <table> as well meant a div-built statement made a correct Date of Birth
     * report as incorrect, three times, and then give up. */
    function _decryptedOk(html) {
        if (!html) return false;
        if (looksLikeStatement(html)) return true;
        return /<(?:table|html|body|div|section|tbody|tr|p)\b/i.test(html);
    }

    // ── ensureCryptoJS (retained stub) ────────────────────────────────────────
    // Decryption is native WebCrypto now — no library is fetched. The name is
    // kept because older code referenced WFHtmlStatement.ensureCryptoJS.
    function ensureCryptoJS() {
        return (window.CryptoJS && window.CryptoJS.AES)
            ? Promise.resolve(window.CryptoJS)
            : Promise.reject(new Error('CryptoJS not loaded (WebCrypto is used instead).'));
    }

    // ── extract the embedded params from the file text ─────────────────────────
    function _params(text) {
        var out = { embedded: '', salt: '', iv: '', iterations: 15000, keySize: 4 };
        var m;
        m = text.match(/\b(?:var|let|const)\s+(?:embedded|payload|cipher(?:text)?|encrypted|data)\s*=\s*["']([\s\S]*?)["']\s*;/i);
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

    // ── byte helpers (browser + Node) ──────────────────────────────────────────
    function _hexBytes(h) {
        h = String(h).replace(/[^0-9a-fA-F]/g, '');
        var a = new Uint8Array(h.length >> 1);
        for (var i = 0; i < a.length; i++) a[i] = parseInt(h.substr(i * 2, 2), 16);
        return a;
    }
    function _b64Bytes(b) {
        var s = atob(String(b).replace(/\s+/g, ''));
        var a = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
        return a;
    }

    // ── native WebCrypto decrypt — NO dependency, offline- and CSP-safe ─────────
    // Proven byte-identical to the bank's own bundled CryptoJS, using that very
    // library as the oracle (see test/estatement_decrypt_test.js): PBKDF2-SHA1,
    // keySize 4 words = 128-bit key, 15000 iterations, AES-CBC, PKCS7. This is the
    // primary path now because the previous code could only decrypt after fetching
    // CryptoJS from a CDN at click time — a single point of failure that a strict
    // CSP, an offline phone, or a slow network turned into "wrong Date of Birth" on
    // a correct DOB. WebCrypto is native to every secure-context browser and to
    // Node, so the statement opens with nothing to download.
    //
    // Returns: inner text on success; '' on a genuinely wrong password (the AES
    // unpad throws, or the ~1/256 valid-padding garbage is rejected upstream by
    // looksLikeStatement); null when WebCrypto itself is unavailable, which is the
    // signal to fall back to the CryptoJS path below.
    function _webcryptoDecrypt(p, password) {
        var subtle = (typeof globalThis !== 'undefined' && globalThis.crypto && globalThis.crypto.subtle) || null;
        if (!subtle) return Promise.resolve(null);
        var saltB, ivB, ctB;
        try { saltB = _hexBytes(p.salt); ivB = _hexBytes(p.iv); ctB = _b64Bytes(p.embedded); }
        catch (e) { return Promise.resolve(null); }
        var bits = (p.keySize || 4) * 32;
        var pw = new TextEncoder().encode(String(password));
        return subtle.importKey('raw', pw, { name: 'PBKDF2' }, false, ['deriveBits'])
            .then(function (base) {
                return subtle.deriveBits({ name: 'PBKDF2', salt: saltB, iterations: p.iterations || 15000, hash: 'SHA-1' }, base, bits);
            })
            .then(function (kb) {
                return subtle.importKey('raw', kb, { name: 'AES-CBC' }, false, ['decrypt']);
            })
            .then(function (key) {
                // ONLY the final decrypt failure means "wrong password" → ''. A
                // failure before this point is a setup problem (an engine without
                // PBKDF2-SHA1 or AES-CBC) and must fall back, not masquerade as a
                // wrong DOB — otherwise every password would look wrong.
                return subtle.decrypt({ name: 'AES-CBC', iv: ivB }, key, ctB)
                    .then(function (buf) { return new TextDecoder('utf-8').decode(new Uint8Array(buf)); })
                    .catch(function () { return ''; });
            })
            .catch(function () { return null; });
    }

    // ── decrypt (returns inner HTML, or '' on a wrong password) ─────────────────
    function decrypt(fileText, password) {
        var p = _params(fileText);
        if (!p.embedded || !p.salt || !p.iv) return Promise.reject(new Error('This file is not a recognised encrypted statement.'));
        return _webcryptoDecrypt(p, password).then(function (plain) {
            // null = WebCrypto unavailable (insecure context). This app is served
            // over https, so it is effectively unreachable; surface it honestly.
            if (plain === null) return Promise.reject(new Error('This browser cannot decrypt here — open WealthFlow over https.'));
            return plain ? _maybeUnwrap(plain) : '';   // '' = wrong password
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
    /* Money, across grouping conventions. "1.234,56" and "1 234,56" were dropped
     * entirely: the old reader stripped commas and spaces and then matched the
     * first \d+(\.\d{1,2})? it found, which on "5.000,00" is "5.000" — five, not
     * five thousand. The separator that appears LAST is the decimal one; if only
     * one kind appears it is a decimal point only when exactly two digits follow.
     * A TRAILING minus ("5,000.00-") is a credit, the accounting convention. */
    function _num(s) {
        if (s == null) return null;
        var t = String(s).replace(/ /g, ' ').trim();
        var neg = /^\(.*\)$/.test(t) || /^[-−]/.test(t) || /[-−]$/.test(t);
        var m = t.replace(/[()]/g, ' ').match(/[\d.,\s ]*\d/);
        if (!m) return null;
        var raw = m[0].replace(/[\s ]/g, '');
        var lastDot = raw.lastIndexOf('.'), lastCom = raw.lastIndexOf(',');
        var dec = lastDot > lastCom ? '.' : (lastCom > lastDot ? ',' : '');
        if (dec) {
            var tail = raw.length - raw.lastIndexOf(dec) - 1;
            // A lone separator with three trailing digits is grouping, not a decimal.
            if (tail === 3 && raw.indexOf(dec) === raw.lastIndexOf(dec)) dec = '';
        }
        var norm = dec
            ? raw.slice(0, raw.lastIndexOf(dec)).replace(/[.,]/g, '') + '.' + raw.slice(raw.lastIndexOf(dec) + 1)
            : raw.replace(/[.,]/g, '');
        var v = parseFloat(norm);
        if (isNaN(v)) return null;
        return neg ? -Math.abs(v) : v;
    }

    var _MON = { jan:'01',feb:'02',mar:'03',apr:'04',may:'05',jun:'06',
                 jul:'07',aug:'08',sep:'09',oct:'10',nov:'11',dec:'12' };
    function _pad(n) { return String(n).padStart(2, '0'); }
    function _yr(y) {
        y = String(y);
        if (y.length === 4) return y;
        var n = parseInt(y, 10);
        return String(n > 70 ? 1900 + n : 2000 + n);   // 2-digit year window
    }
    function _ok(y, m, d) {
        y = parseInt(y, 10); m = parseInt(m, 10); d = parseInt(d, 10);
        return m >= 1 && m <= 12 && d >= 1 && d <= 31 && y >= 1900 && y <= 2999;
    }

    /* Dates, across the separators and orders a statement actually uses.
     * '.' was missing entirely, so 02.08.2026 dropped every row; and a 4-digit
     * first group fell through to the day-first branch, turning 2026/08/02 into
     * 2002-08-26 — a WRONG date imported silently, which is worse than none. */
    function _toISO(d) {
        if (!d) return '';
        d = String(d).replace(/ /g, ' ').trim().replace(/,/g, ' ').replace(/\s+/g, ' ');
        var m;

        // ISO first: YYYY-MM-DD / YYYY/MM/DD / YYYY.MM.DD
        m = d.match(/^(\d{4})[\/\-. ](\d{1,2})[\/\-. ](\d{1,2})$/);
        if (m && _ok(m[1], m[2], m[3])) return m[1] + '-' + _pad(m[2]) + '-' + _pad(m[3]);

        // D?M?Y with any separator. Day-first (the local convention) unless the
        // numbers can only be month-first.
        m = d.match(/^(\d{1,2})[\/\-. ](\d{1,2})[\/\-. ](\d{2,4})$/);
        if (m) {
            var a = parseInt(m[1], 10), b = parseInt(m[2], 10), y = _yr(m[3]);
            if (a > 12 && b <= 12 && _ok(y, b, a)) return y + '-' + _pad(b) + '-' + _pad(a);
            if (b > 12 && a <= 12 && _ok(y, a, b)) return y + '-' + _pad(a) + '-' + _pad(b);
            if (_ok(y, b, a)) return y + '-' + _pad(b) + '-' + _pad(a);   // day-first default
        }

        // D MMM YYYY — space, hyphen, slash or dot ("02-Aug-2026", "02.Aug.2026")
        m = d.match(/^(\d{1,2})[\s\-\/.]+([A-Za-z]{3,})\.?[\s\-\/.]*(\d{2,4})?$/);
        if (m) {
            var mm = _MON[m[2].slice(0, 3).toLowerCase()];
            if (mm) return (m[3] ? _yr(m[3]) : String(new Date().getFullYear())) + '-' + mm + '-' + _pad(m[1]);
        }

        // MMM D YYYY — "Aug 02 2026" (the comma was stripped above)
        m = d.match(/^([A-Za-z]{3,})\.?[\s\-\/.]+(\d{1,2})[\s\-\/.]+(\d{2,4})$/);
        if (m) {
            var mm2 = _MON[m[1].slice(0, 3).toLowerCase()];
            if (mm2) return _yr(m[3]) + '-' + mm2 + '-' + _pad(m[2]);
        }

        // DDMMYYYY / YYYYMMDD, unseparated
        m = d.match(/^(\d{8})$/);
        if (m) {
            var t = m[1];
            if (_ok(t.slice(4), t.slice(2, 4), t.slice(0, 2))) return t.slice(4) + '-' + t.slice(2, 4) + '-' + t.slice(0, 2);
            if (_ok(t.slice(0, 4), t.slice(4, 6), t.slice(6))) return t.slice(0, 4) + '-' + t.slice(4, 6) + '-' + t.slice(6);
        }
        return '';
    }

    /* Transaction extraction, THREE LAYERS in order: (1) static <table>;
     * (2) rows held as data in <script> and drawn by JS — DOMParser never runs
     * scripts, so layer 1 sees an empty shell there; (3) one transaction per text
     * line, for merged cells and <div> grids. All feed one row builder.
     * Full account + a fixture per layer: test/estatement_parse_shapes_test.js */

    function _slice(x) { return Array.prototype.slice.call(x || []); }
    function _txt(el) { return String((el && (el.innerText || el.textContent)) || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim(); }

    /* td+th: a date in a <th> is still a transaction. Fallbacks keep simpler DOM
     * implementations working. */
    function _cellsOf(tr) {
        var c = _slice(tr.querySelectorAll('td,th'));
        if (!c.length) c = _slice(tr.querySelectorAll('td'));
        if (!c.length) c = _slice(tr.querySelectorAll('th'));
        return c.map(_txt);
    }

    /* A cell that is ONLY money. Decorations are stripped and whatever remains
     * must be digits and separators — a single regex could not express "1.234,56"
     * and "1,234.56" and "1 234,56" at once without matching prose too. */
    function _isMoney(s) {
        var t = String(s || '').replace(/ /g, ' ').trim();
        if (!t) return false;
        var core = t
            .replace(/^[\s(]+|[\s)]+$/g, '')
            .replace(/^(?:[A-Z]{3}|Rs)\.?\s*/i, '')     // leading LKR / Rs.
            .replace(/\s*(?:[A-Z]{3}|Rs)\.?$/i, '')     // trailing LKR
            .replace(/\s*(?:DR|CR)\.?$/i, '')           // Dr / Cr marker
            .replace(/^[-\u2212+]|[-\u2212+]$/g, '')    // sign at either end
            .trim();
        return /^\d$|^\d[\d.,\s\u00a0]*\d$/.test(core);
    }
    /* A KNOWN currency code, never "any three capitals". Matching [A-Z]{3} ate the
     * last word of "PAYMENT - THANK YOU", and would equally eat LTD, PLC, KFC. */
    var _CUR = /^(?:LKR|USD|EUR|GBP|INR|AUD|CAD|SGD|JPY|CHF|AED|SAR|MYR|THB|CNY|NZD|HKD|QAR|KWD|BHD|OMR|PKR|BDT|NPR|MVR|ZAR|SEK|NOK|DKK)$/i;
    function _isCur(s) { return _CUR.test(String(s || '').trim()); }

    /* Unmarked defaults to debit: the majority on a card statement, and a wrong
     * credit silently subtracts from what is owed. */
    function _dirOf(s) {
        var t = String(s || '');
        if (/\bCR\b/i.test(t)) return 'credit';
        if (/\bDR\b/i.test(t)) return 'debit';
        if (/^\s*\(.*\)\s*$/.test(t.trim())) return 'credit';   // (1,234.00) = credit
        if (/^\s*[-\u2212]/.test(t.trim())) return 'credit';
        if (/[-\u2212]\s*$/.test(t.trim())) return 'credit';     // "5,000.00-" = credit
        return '';
    }

    /* A Dr/Cr marker standing alone in its OWN cell or field. _dirOf only ever
     * looked INSIDE the amount ("15,000.00 Cr"), so the six-column layout that
     * puts the marker in a column of its own read every payment as a charge —
     * which silently inflates what the card appears to owe, and looks like
     * nothing is wrong. Found by rendering a real statement in a real browser;
     * every fixture until then happened to merge the marker into the amount. */
    function _markerDir(s) {
        var t = String(s || '').trim().replace(/\.$/, '');
        if (/^(?:CR|CREDIT)$/i.test(t)) return 'credit';
        if (/^(?:DR|DEBIT)$/i.test(t)) return 'debit';
        return '';
    }

    var _DATE_TOKEN = '(?:\\d{1,2}[\\/\\-\\s](?:\\d{1,2}|[A-Za-z]{3,9})[\\/\\-\\s]\\d{2,4}|\\d{4}-\\d{2}-\\d{2})';

    function _cleanNarr(s) {
        return String(s || '')
            .replace(new RegExp('^\\s*' + _DATE_TOKEN + '\\s+'), '')   // a second date column
            .replace(/\s+[A-Za-z]{3}\s*$/, function (m) { return _isCur(m.trim()) ? '' : m; })
            .replace(/[\s.\-|:]+$/, '')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /** The one row definition: null unless date, amount AND description are all
     *  found — a partial row is not a row. */
    function _mkRow(dateRaw, narrRaw, amtRaw, dirHint) {
        var date = _toISO(dateRaw);
        if (!date) return null;
        var amount = _num(amtRaw);
        if (amount == null || Math.abs(amount) < 0.01) return null;
        var narration = _cleanNarr(narrRaw);
        if (!narration || _isMoney(narration) || _isCur(narration)) return null;
        return {
            date: date,
            narration: narration,
            amount: Math.abs(amount),
            direction: dirHint || _dirOf(amtRaw) || 'debit'
        };
    }

    /* date … description … amount [Dr|Cr]. Decimals required, so a reference or
     * card number is never read as money. */
    var _LINE_RE = new RegExp(
        '^\\s*(' + _DATE_TOKEN + ')\\s+(.+?)\\s+([-+(]?\\s*[\\d,]+\\.\\d{2}\\s*\\)?)\\s*(DR|CR)?\\.?\\s*$', 'i');

    function _fromLine(line) {
        var m = String(line || '').match(_LINE_RE);
        if (!m) return null;
        var marker = m[4] || '';
        return _mkRow(m[1], m[2], m[3], _dirOf(marker) || _dirOf(m[3]) || '');
    }

    // ── layer 1: tables ───────────────────────────────────────────────────────
    function _fromTables(doc) {
        var out = [];
        _slice(doc.querySelectorAll('table')).forEach(function (table) {
            _slice(table.querySelectorAll('tr')).forEach(function (tr) {
                var cells = _cellsOf(tr);
                if (cells.length < 2) return;

                var date = '', di = -1;
                for (var i = 0; i < cells.length && !date; i++) { var d = _toISO(cells[i]); if (d) { date = d; di = i; } }

                /* RIGHT TO LEFT, money-only cells first. Left-to-right took the
                 * first number on the row, so "FUEL 20.00 LTR" became a 20.00
                 * charge. Money columns sit right and hold only money. */
                var amtRaw = null;
                for (var j = cells.length - 1; j >= 0; j--) {
                    if (j === di || _isCur(cells[j])) continue;
                    if (_isMoney(cells[j]) && _num(cells[j]) != null) { amtRaw = cells[j]; break; }
                }
                if (amtRaw == null) {
                    for (var k = cells.length - 1; k >= 0; k--) {
                        if (k === di || _isCur(cells[k])) continue;
                        if (/\b(DR|CR)\b/i.test(cells[k]) && _num(cells[k]) != null) { amtRaw = cells[k]; break; }
                    }
                }

                // narration: the longest cell that is not the date, a currency code
                // or money.
                var narr = '';
                cells.forEach(function (c, idx) {
                    if (idx === di || _isCur(c) || _isMoney(c)) return;
                    if (_toISO(c)) return;
                    if (c.length > narr.length) narr = c;
                });

                var dirHint = _dirOf(amtRaw);
                if (!dirHint) {
                    for (var m = cells.length - 1; m >= 0; m--) {
                        if (m === di) continue;
                        dirHint = _markerDir(cells[m]);
                        if (dirHint) break;
                    }
                }

                var row = (date && amtRaw != null) ? _mkRow(date, narr, amtRaw, dirHint) : null;
                // Merged cells ("02-Aug-2026 ODEL COLOMBO" | "5,000.00 Dr") do not
                // decompose by column; the line parser handles them.
                if (!row) row = _fromLine(cells.join(' '));
                if (row) out.push(row);
            });
        });
        return out;
    }

    // ── layer 2: rows rendered from data inside <script> ──────────────────────
    var _K_DESC = /desc|narrat|detail|merchant|particular|remark|title|name/i;
    var _K_AMT = /amount|amt|value|total|lkr|debit|credit/i;
    var _K_DIR = /dr.?cr|indicator|sign|type|kind/i;

    /** One object → a row, without knowing the bank's field names. */
    function _fromObject(o) {
        if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
        var keys = Object.keys(o).filter(function (k) {
            var v = o[k];
            return v == null || typeof v === 'string' || typeof v === 'number';
        });
        if (!keys.length) return null;
        var val = function (k) { return o[k] == null ? '' : String(o[k]); };

        var dk = '';
        keys.forEach(function (k) { if (!dk && /date|^dt$/i.test(k) && _toISO(val(k))) dk = k; });
        keys.forEach(function (k) { if (!dk && _toISO(val(k))) dk = k; });
        if (!dk) return null;

        var ak = '';
        keys.forEach(function (k) { if (!ak && k !== dk && _K_AMT.test(k) && _num(val(k)) != null && _isMoney(val(k))) ak = k; });
        keys.forEach(function (k) { if (!ak && k !== dk && _isMoney(val(k)) && _num(val(k)) != null) ak = k; });
        if (!ak) return null;

        var nk = '';
        keys.forEach(function (k) { if (!nk && k !== dk && k !== ak && _K_DESC.test(k) && val(k).trim()) nk = k; });
        keys.forEach(function (k) {
            if (nk || k === dk || k === ak) return;
            var v = val(k).trim();
            if (!v || _isMoney(v) || _isCur(v) || _toISO(v)) return;
            if (v.length > val(nk || k).length || !nk) nk = k;
        });
        if (!nk) return null;

        var dir = '';
        keys.forEach(function (k) { if (!dir && _K_DIR.test(k)) dir = _dirOf(val(k)); });
        return _mkRow(val(dk), val(nk), val(ak), dir);
    }

    /** One POSITIONAL row — ["03-Aug-2026","KEELLS","4,250.00","Dr"] — which is
     *  every bit as common as an array of objects and was rejected outright,
     *  because the span scan required a '{' before it would even try to parse. */
    function _fromArrayRow(a) {
        if (!Array.isArray(a) || a.length < 2) return null;
        var v = a.map(function (x) {
            return (x == null || typeof x === 'object') ? '' : String(x);
        });
        var di = -1, ai = -1, ni = -1, i;
        for (i = 0; i < v.length; i++) { if (_toISO(v[i])) { di = i; break; } }
        if (di < 0) return null;
        // Right to left: the rightmost money column is the amount, not a quantity
        // embedded in the description — the same rule the table layer uses.
        for (i = v.length - 1; i >= 0; i--) {
            if (i !== di && _isMoney(v[i]) && _num(v[i]) != null) { ai = i; break; }
        }
        if (ai < 0) return null;
        for (i = 0; i < v.length; i++) {
            var t = v[i].trim();
            if (i === di || i === ai || !t) continue;
            if (_isMoney(t) || _isCur(t) || _toISO(t)) continue;
            if (ni < 0 || t.length > v[ni].trim().length) ni = i;
        }
        if (ni < 0) return null;
        var dir = _dirOf(v[ai]);
        for (i = 0; i < v.length && !dir; i++) {
            if (i !== ni) dir = _dirOf(v[i]) || _markerDir(v[i]);
        }
        return _mkRow(v[di], v[ni], v[ai], dir);
    }

    /* A minified bundle is millions of characters of '[' that never balance in a
     * scan this naive, so the work done per block is capped. Without a cap this
     * is quadratic and would hang the phone on a 3 MB statement. */
    var _SCAN_BUDGET = 2000000;

    /** Every balanced [...] span inside a <script>, parsed as data if it can be. */
    function _fromScripts(html) {
        var out = [];
        var blocks = String(html).match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
        blocks.forEach(function (block) {
            var body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
            var work = 0;
            for (var i = 0; i < body.length; i++) {
                if (body[i] !== '[') continue;
                var depth = 0, inStr = false, q = '', j = i;
                for (; j < body.length; j++) {
                    /* Bounded, not unbounded: see _SCAN_BUDGET. */
                    if (++work > _SCAN_BUDGET) return;
                    var ch = body[j];
                    if (inStr) { if (ch === '\\') { j++; continue; } if (ch === q) inStr = false; continue; }
                    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
                    if (ch === '[') depth++;
                    else if (ch === ']') { depth--; if (depth === 0) break; }
                }
                /* This '[' never closed — a regex literal or a template string
                 * desynced the scan. Abandoning the whole BLOCK here meant one
                 * such '[' anywhere above the data hid every array below it, and
                 * in minified code there is always one. Move on to the next '['
                 * instead; _SCAN_BUDGET is what keeps that affordable. */
                if (depth !== 0) continue;
                var span = body.slice(i, j + 1);
                i = j;
                if (span.length < 20) continue;
                // Objects OR positional rows. Requiring '{' dropped [[...],[...]].
                if (span.indexOf('{') < 0 && !/\[\s*["'\-\d]/.test(span)) continue;
                var arr = null;
                try { arr = JSON.parse(span); } catch (_) {
                    // Tolerate JS object literals; anything else is skipped.
                    try {
                        arr = JSON.parse(span
                            .replace(/'/g, '"')
                            .replace(/,(\s*[}\]])/g, '$1')
                            .replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":'));
                    } catch (__) { arr = null; }
                }
                if (!Array.isArray(arr)) continue;
                arr.forEach(function (o) {
                    var r = Array.isArray(o) ? _fromArrayRow(o) : _fromObject(o);
                    if (r) out.push(r);
                });
            }
        });
        return out;
    }

    // ── layer 3: one transaction per text line ────────────────────────────────
    function _fromTextLines(html) {
        var out = [];
        var text = String(html)
            .replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<\/(tr|div|p|li|h[1-6]|table)>/gi, '\n')
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<[^>]+>/g, ' ')
            .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&')
            .replace(/[ \t ]+/g, ' ');
        text.split(/\r?\n/).forEach(function (line) {
            var r = _fromLine(line);
            if (r) out.push(r);
        });
        if (out.length) return out;

        /* A <div> grid splits each field into its own element, so no single line
         * holds a whole transaction. Flatten and scan for triples. Deliberately
         * last: the loosest reading, used only when everything else found none. */
        var flat = text.replace(/\s+/g, ' ');
        var scan = new RegExp('(' + _DATE_TOKEN + ')\\s+(.{2,80}?)\\s+([-+(]?[\\d,]+\\.\\d{2}\\)?)\\s*(DR|CR)?\\b', 'gi');
        var m;
        while ((m = scan.exec(flat)) !== null) {
            var r2 = _mkRow(m[1], m[2], m[3], _dirOf(m[4] || '') || _dirOf(m[3]) || '');
            if (r2) out.push(r2);
        }
        return out;
    }

    function _dedupe(rows) {
        var seen = {}, out = [];
        rows.forEach(function (t) {
            var key = t.date + '|' + t.narration.toLowerCase() + '|' + t.amount + '|' + t.direction;
            if (seen[key]) return;
            seen[key] = 1; out.push(t);
        });
        return out;
    }

    /* ── run the statement, do not merely read it ─────────────────────────────
     *
     * A Smart Statement is an APPLICATION. Its transactions live in JavaScript
     * and are drawn into the page on load. DOMParser does not execute scripts,
     * so every static layer above has been reading an empty shell. That is not a
     * theory — it is what the field diagnostic reported on the real file:
     *
     *     tables 2 / rows 3 / cells 17 / date-cells 0 / money-cells 0 /
     *     scripts 14 / script-rows 0 / chars 3104263
     *
     * Three million characters, fourteen scripts, and three table rows between
     * them, not one of which holds a date or an amount. No amount of extra
     * layout guessing reaches data that has not been rendered yet.
     *
     * So render it, the way a viewer app does — but held far more tightly, because
     * this is executable code that arrived as an email attachment:
     *
     *   • sandbox="allow-scripts" and NOTHING else. WITHOUT allow-same-origin the
     *     frame gets an opaque origin: it cannot read this page's DOM, its
     *     localStorage, its IndexedDB or the signed-in session, and it cannot call
     *     anything here. Adding allow-same-origin would hand a stranger's script
     *     the user's entire account, so the tests assert that it is absent.
     *   • An injected CSP of default-src 'none', ahead of any of the statement's
     *     own markup: no fetch, no XHR, no WebSocket, no beacon, no remote image,
     *     no remote script. A statement has no reason to touch the network, and
     *     the user's financial data must not leave the device.
     *   • No allow-forms, allow-popups, allow-modals or allow-top-navigation: it
     *     cannot submit, open, block or navigate.
     *   • The frame is off-screen, and removed the moment it answers or the
     *     deadline passes.
     *
     * It reports back by postMessage carrying a per-run nonce. The parent never
     * reaches into the frame; it only reads the string the frame chose to send.
     * ------------------------------------------------------------------------ */
    var _SANDBOX_CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; "
        + "style-src 'unsafe-inline'; img-src data:; font-src data:; media-src data:; "
        + "form-action 'none'; base-uri 'none'; frame-src 'none'; child-src 'none'";

    /* Runs INSIDE the frame. It has to survive the statement calling
     * document.write() after load — which implies document.open() and wipes every
     * node and every document listener — so no state is kept in the DOM and the
     * loop is driven by setTimeout, which document.open() does not touch.
     *
     * Script bodies are stripped from the snapshot before it is sent: after the
     * page has run, the rows are in the DOM, and posting three megabytes of
     * library source back across the boundary is pure cost. */
    function _bootstrapSrc(nonce, budgetMs) {
        return '(function(){'
            + 'var N=' + JSON.stringify(String(nonce)) + ',D=' + Number(budgetMs) + ';'
            + 'var T=Date.now(),last=-1,still=0,sent=0,BL=[],ER=0,E1="";'
            /* The likeliest way this fix fails is the CSP refusing something the
             * statement needed — and a silent refusal would put us straight back
             * to guessing. Report the DIRECTIVE and the blocked origin, never the
             * path or query, which is where data would be. */
            + 'function onv(e){try{var d=e.violatedDirective||e.effectiveDirective||"?";'
            + 'var u=String(e.blockedURI||"").split("/").slice(0,3).join("/");'
            + 'var k=d+(u?" "+u:"");if(BL.length<6&&BL.indexOf(k)<0)BL.push(k);}catch(x){}}'
            + 'try{window.addEventListener("securitypolicyviolation",onv,true);}catch(e){}'
            + 'try{document.addEventListener("securitypolicyviolation",onv,true);}catch(e){}'
            + 'var SC=new RegExp("<scr"+"ipt[\\\\s\\\\S]*?</scr"+"ipt>","gi");'
            + 'function post(o){try{o.__wfhs=N;parent.postMessage(o,"*");}catch(e){}}'
            + 'function snap(){if(sent)return;sent=1;var h="";'
            + 'try{h=document.documentElement?document.documentElement.outerHTML:"";}catch(e){}'
            + 'try{h=h.replace(SC,"");}catch(e){}'
            + 'post({html:h,ms:Date.now()-T,blocked:BL,errs:ER,err1:E1});}'
            + 'function tick(){var n=0;'
            + 'try{n=(document.body&&document.body.innerHTML.length)||0;}catch(e){}'
            + 'if(n===last){still++;}else{still=0;last=n;}'
            + 'if((still>=2&&n>0)||Date.now()-T>=D){snap();return;}'
            + 'setTimeout(tick,160);}'
            /* Swallow the statement's own errors — one throw must not stop the
             * snapshot — but COUNT them, and keep the first message with every
             * digit masked, because "it rendered nothing" and "it threw on line
             * one" need different fixes. */
            + 'try{window.onerror=function(m){ER++;if(!E1)E1=String(m).replace(/[0-9]/g,"#").slice(0,90);return true;};}catch(e){}'
            + 'setTimeout(tick,100);'
            + '})();';
    }

    /* The statement goes in the BODY of a document we control, so the CSP and the
     * bootstrap are guaranteed to come first. Its own <html>/<head>/<body> tags are
     * dropped by the parser while their contents stay inline, and its scripts still
     * run — which is the whole point. */
    function _buildSandboxDoc(inner, nonce, budgetMs) {
        return '<!doctype html><html><head><meta charset="utf-8">'
            + '<meta http-equiv="Content-Security-Policy" content="' + _SANDBOX_CSP + '">'
            + '<script>' + _bootstrapSrc(nonce, budgetMs) + '<\/script>'
            + '</head><body>' + String(inner == null ? '' : inner) + '</body></html>';
    }

    var _RENDER_MS = 9000;

    /** Resolves with the rendered HTML, or '' if it could not be rendered.
     *  Never rejects: rendering is an enhancement, and the static layers stand. */
    function renderInSandbox(html, opts) {
        opts = opts || {};
        var doc = opts.document || (typeof document !== 'undefined' ? document : null);
        var win = opts.window || (typeof window !== 'undefined' ? window : null);
        var budget = opts.timeoutMs || _RENDER_MS;
        if (!html || !doc || !win || typeof doc.createElement !== 'function'
            || typeof win.addEventListener !== 'function') return Promise.resolve('');
        return new Promise(function (resolve) {
            var nonce = 'wfhs' + Math.random().toString(36).slice(2) + Date.now().toString(36);
            var frame, timer = null, done = false;

            function finish(out) {
                if (done) return;
                done = true;
                try { win.removeEventListener('message', onMsg); } catch (_) {}
                if (timer) { try { clearTimeout(timer); } catch (_) {} }
                try { if (frame && frame.parentNode) frame.parentNode.removeChild(frame); } catch (_) {}
                resolve(typeof out === 'string' ? out : '');
            }

            function onMsg(e) {
                var d = e && e.data;
                if (!d || typeof d !== 'object' || d.__wfhs !== nonce) return;
                /* The nonce is unguessable, but if a source is available it must be
                 * our own frame — a message is only ever trusted for one reason. */
                if (e.source && frame && frame.contentWindow && e.source !== frame.contentWindow) return;
                if (typeof opts.onReport === 'function') {
                    try {
                        opts.onReport({
                            blocked: Array.isArray(d.blocked) ? d.blocked.slice(0, 6).map(String) : [],
                            errs: Number(d.errs) || 0,
                            /* Masked in the frame already; masked again here, because
                             * a value that must never carry digits is not something
                             * to take on trust from the document being examined. */
                            err1: String(d.err1 || '').replace(/[0-9]/g, '#').slice(0, 90),
                            ms: Number(d.ms) || 0
                        });
                    } catch (_) {}
                }
                finish(typeof d.html === 'string' ? d.html : '');
            }

            try {
                frame = doc.createElement('iframe');
                win.addEventListener('message', onMsg);
                timer = setTimeout(function () { finish(''); }, budget + 1500);
                // allow-scripts ALONE. See the block comment above: adding
                // allow-same-origin would give the statement this page's origin.
                frame.setAttribute('sandbox', 'allow-scripts');
                frame.setAttribute('referrerpolicy', 'no-referrer');
                frame.setAttribute('aria-hidden', 'true');
                frame.setAttribute('tabindex', '-1');
                frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:1024px;'
                    + 'height:900px;opacity:0;pointer-events:none;border:0;';
                frame.srcdoc = _buildSandboxDoc(html, nonce, budget);
                (doc.body || doc.documentElement).appendChild(frame);
            } catch (_) { finish(''); }
        });
    }

    function htmlToTransactions(html) {
        if (!html) return [];
        var doc = null;
        try { doc = new DOMParser().parseFromString(html, 'text/html'); } catch (_) { doc = null; }

        var rows = [];
        if (doc) { try { rows = _fromTables(doc); } catch (_) { rows = []; } }
        if (!rows.length) { try { rows = _fromScripts(html); } catch (_) { rows = []; } }
        if (!rows.length) { try { rows = _fromTextLines(html); } catch (_) { rows = []; } }
        return _dedupe(rows);
    }

    /* The static read first — it is instant, and a statement that really is a
     * table needs no frame at all. Only when it yields NOTHING and the document
     * carries scripts is it worth paying for a render. */
    function htmlToTransactionsAsync(html, opts) {
        var empty = { transactions: [], rendered: false, renderedHtml: '' };
        if (!html) return Promise.resolve(empty);
        var rows = [];
        try { rows = htmlToTransactions(html); } catch (_) { rows = []; }
        if (rows.length) return Promise.resolve({ transactions: rows, rendered: false, renderedHtml: '' });
        if (!/<script[\s>]/i.test(String(html))) return Promise.resolve(empty);
        var report = null, o = {}, k;
        for (k in (opts || {})) { if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k]; }
        o.onReport = function (x) { report = x; };
        return renderInSandbox(html, o).then(function (out) {
            if (!out) return { transactions: [], rendered: false, renderedHtml: '', report: report };
            var r2 = [];
            try { r2 = htmlToTransactions(out); } catch (_) { r2 = []; }
            return { transactions: r2, rendered: true, renderedHtml: out, report: report };
        })['catch'](function () { return empty; });
    }

    /* WHAT THE DOCUMENT ACTUALLY LOOKED LIKE.
     *
     * "Couldn't read transactions" is a dead end: it names no cause, so the only
     * way forward was to guess at layouts and ship another build. This reports the
     * structure the parser saw, which turns one screenshot into a precise fix.
     *
     * It is deliberately SHAPE ONLY — counts, and lines with every digit masked —
     * so a diagnostic can be shared without exposing an amount, a card number or a
     * merchant the owner banks with. */
    /* What KIND of thing is in a <script>. On the real file this is the question
     * that matters: fourteen scripts and three table rows means the rows are built
     * at runtime — and if one of those scripts is a megabyte of base64 rather than
     * code, there is a second-stage payload behind it. Sizes and kinds only; no
     * content is ever reported. */
    function _scriptKind(body) {
        var t = String(body || '').replace(/^[\s;]+/, '');
        if (!t) return 'empty';
        if (/^[[{]/.test(t) && /["']\s*:/.test(t.slice(0, 4000))) return 'json';
        var b = t.match(/[A-Za-z0-9+/=]{512,}/);
        if (b) return 'b64-' + b[0].length;
        if (/\bdocument\.write\s*\(/.test(t)) return 'doc-write';
        if (/\batob\s*\(/.test(t)) return 'atob';
        if (/\bfunction\b|=>|\bvar\b|\blet\b|\bconst\b/.test(t)) return 'js';
        return 'other';
    }

    function diagnose(html, extra) {
        var d = { tables: 0, rows: 0, cells: 0, scripts: 0, arrays: 0, chars: 0, dateCells: 0,
                  moneyCells: 0, bodyChars: 0, topScripts: [], rendered: false,
                  renderedChars: 0, renderedRows: 0, blocked: [], errs: 0, err1: '',
                  samples: [] };
        var src = String(html || '');
        d.chars = src.length;
        d.scripts = (src.match(/<script[^>]*>/gi) || []).length;
        d.topScripts = (src.match(/<script[^>]*>[\s\S]*?<\/script>/gi) || []).map(function (b) {
            var body = b.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
            return { n: body.length, k: _scriptKind(body) };
        }).sort(function (a, b2) { return b2.n - a.n; }).slice(0, 5);
        try {
            var doc = new DOMParser().parseFromString(src, 'text/html');
            var tables = _slice(doc.querySelectorAll('table'));
            d.tables = tables.length;
            tables.forEach(function (t) {
                _slice(t.querySelectorAll('tr')).forEach(function (tr) {
                    d.rows++;
                    var cells = _cellsOf(tr);
                    d.cells += cells.length;
                    cells.forEach(function (c) {
                        if (_toISO(c)) d.dateCells++;
                        else if (_isMoney(c)) d.moneyCells++;
                    });
                });
            });
        } catch (_) {}
        try { d.arrays = _fromScripts(src).length; } catch (_) {}

        /* A few lines that carry BOTH something date-shaped and something
         * money-shaped — the lines a transaction would be on. Digits masked. */
        var text = src.replace(/<script[\s\S]*?<\/script>/gi, ' ')
            .replace(/<style[\s\S]*?<\/style>/gi, ' ')
            .replace(/<\/(tr|div|p|li|td|th)>/gi, '\n')
            .replace(/<[^>]+>/g, ' ').replace(/&nbsp;/gi, ' ')
            .replace(/[ \t ]+/g, ' ');
        var lines = text.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        for (var i = 0; i < lines.length && d.samples.length < 6; i++) {
            var L = lines[i];
            if (L.length < 8 || L.length > 160) continue;
            if (!/\d/.test(L)) continue;
            if (!/\d[.,]\d{2}\b/.test(L) && !/[A-Za-z]{3}/.test(L)) continue;
            d.samples.push(L.replace(/\d/g, '#').slice(0, 120));
        }
        d.bodyChars = text.replace(/\s+/g, ' ').trim().length;
        if (extra) {
            d.rendered = !!extra.rendered;
            d.renderedChars = Number(extra.renderedChars) || 0;
            d.renderedRows = Number(extra.renderedRows) || 0;
            var rp = extra.report;
            if (rp) {
                d.blocked = Array.isArray(rp.blocked) ? rp.blocked.slice(0, 6).map(String) : [];
                d.errs = Number(rp.errs) || 0;
                d.err1 = String(rp.err1 || '').replace(/[0-9]/g, '#').slice(0, 90);
            }
        }
        return d;
    }

    /** One line a person can screenshot. */
    function diagLine(d) {
        if (!d) return '';
        var top = (d.topScripts || []).map(function (x) { return x.n + ':' + x.k; }).join('  ');
        return 'tables ' + d.tables + ' / rows ' + d.rows + ' / cells ' + d.cells
            + ' / date-cells ' + d.dateCells + ' / money-cells ' + d.moneyCells
            + ' / scripts ' + d.scripts + ' / script-rows ' + d.arrays
            + ' / chars ' + d.chars + ' / body ' + d.bodyChars
            + '\nrendered ' + (d.rendered ? 'yes' : 'no')
            + ' / rendered-chars ' + d.renderedChars
            + ' / rendered-rows ' + d.renderedRows
            + ((d.blocked && d.blocked.length) ? '\nblocked ' + d.blocked.join(' | ') : '')
            + (d.errs ? '\nerrors ' + d.errs + (d.err1 ? ' — ' + d.err1 : '') : '')
            + (top ? '\nscripts ' + top : '');
    }

    /* Shown when the statement opened but yielded nothing. The shape line and the
     * masked samples are what identify the layout, and a Copy button beats asking
     * someone to retype them off a phone screen. */
    function showDiagnostic(d) {
        try {
            var body = diagLine(d) + '\n\n' + (d.samples.length ? d.samples.join('\n') : '(no line carried both a date and an amount)');
            var ov = document.createElement('div');
            ov.setAttribute('data-wfhs-modal', '1');
            ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,6,14,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;pointer-events:auto;';
            ov.innerHTML =
                '<div style="width:100%;max-width:420px;background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:18px;padding:20px;">'
                + '<div style="font-size:16px;font-weight:800;color:var(--text,#e8edf5);margin-bottom:6px;">Statement opened, but no transactions found</div>'
                + '<div style="font-size:12.5px;color:var(--text3,#8a97ad);line-height:1.5;margin-bottom:12px;">It unlocked correctly, and it was also opened and run in a sealed offline frame — this is a layout the reader does not recognise yet. Send this to support and it can be added. All digits are masked.</div>'
                + '<textarea readonly id="_wfhsDiag" style="width:100%;box-sizing:border-box;height:176px;font-family:var(--mono,monospace);font-size:11.5px;padding:10px;border-radius:10px;border:1px solid var(--border2,#243049);background:var(--bg2,#0a0f1a);color:var(--text2,#aeb9cc);pointer-events:auto;-webkit-user-select:text;user-select:text;"></textarea>'
                + '<div style="display:flex;gap:10px;margin-top:12px;">'
                + '<button id="_wfhsDClose" style="flex:1;padding:11px;border-radius:11px;border:1px solid var(--border2,#243049);background:transparent;color:var(--text2,#aeb9cc);font-weight:700;">Close</button>'
                + '<button id="_wfhsDCopy" style="flex:1;padding:11px;border-radius:11px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;">Copy</button>'
                + '</div></div>';
            document.body.appendChild(ov);
            ov.querySelector('#_wfhsDiag').value = body;
            ov.querySelector('#_wfhsDClose').onclick = function () { ov.remove(); };
            ov.querySelector('#_wfhsDCopy').onclick = function () {
                var ta = ov.querySelector('#_wfhsDiag');
                try {
                    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(body);
                    else { ta.select(); document.execCommand('copy'); }
                    ov.querySelector('#_wfhsDCopy').textContent = 'Copied';
                } catch (_) { ta.select(); }
            };
            ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
        } catch (_) {}
    }

    /* Split from _meta so the caller can pass the RENDERED text: after a render
     * the header fields exist, and re-parsing three megabytes to find them again
     * is a cost with nothing to show for it. */
    // pull a few header fields for display / dedup
    function _metaFromText(text) {
        var meta = { card_last4: '', period: '', holder: '' };
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
            /* NO `mo` class: pointer-events:none unless `.mo.open`, never added
             * here — it rendered but was inert. See the matching test. */
            ov.setAttribute('data-wfhs-modal', '1');
            ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,6,14,.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:18px;opacity:0;transition:opacity .2s;pointer-events:auto;';
            ov.innerHTML =
                '<div style="width:100%;max-width:380px;background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:18px;padding:22px;">' +
                '<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px;">' +
                (window.WFIcon ? WFIcon.svg('lock', ' width="22" height="22" style="color:var(--accent,#f5a623)"') : '') +
                '<div style="font-size:17px;font-weight:800;color:var(--text,#e8edf5);">Unlock e-statement</div></div>' +
                '<div style="font-size:12.5px;color:var(--text3,#8a97ad);line-height:1.55;margin-bottom:14px;">This bank statement is password-protected. Enter the cardholder\u2019s <b>Date of Birth</b> in <b>DDMMYYYY</b> format (e.g. 05071990).</div>' +
                '<input id="_wfhsPw" type="tel" inputmode="numeric" maxlength="8" placeholder="DDMMYYYY" autofocus ' +
                /* >=16px or iOS zooms; select/pointer-events vs inherited none. */
                'style="width:100%;box-sizing:border-box;font-family:var(--mono,monospace);font-size:20px;letter-spacing:6px;text-align:center;padding:12px;border-radius:12px;border:1px solid var(--border2,#243049);background:var(--bg2,#0a0f1a);color:var(--text,#e8edf5);pointer-events:auto;-webkit-user-select:text;user-select:text;touch-action:manipulation;">' +
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

    /* ONE place that turns a document into a result, so the render, the text
     * fallback and the diagnostic can never end up describing different documents
     * — which is how a confident report about work that never happened starts. */
    function _finish(html, encrypted, opts) {
        return htmlToTransactionsAsync(html, opts).then(function (r) {
            var t0 = '', t1 = '';
            try { t0 = htmlToText(html); } catch (_) {}
            if (r.renderedHtml) { try { t1 = htmlToText(r.renderedHtml); } catch (_) {} }
            /* Whichever document actually has words in it. Even when row extraction
             * still finds nothing, a RENDERED page gives the text fallback in
             * wealthflow-ai-v4.js something real to read; before this it was handed
             * the empty shell and never had a chance either. */
            var text = t1.length > t0.length ? t1 : t0;
            return {
                ok: true,
                encrypted: !!encrypted,
                html: html,
                text: text,
                transactions: r.transactions,
                meta: _metaFromText(text),
                diag: diagnose(html, {
                    rendered: r.rendered,
                    renderedChars: (r.renderedHtml || '').length,
                    renderedRows: r.rendered ? r.transactions.length : 0,
                    report: r.report
                })
            };
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
                if (looksLikeStatement(text)) return _finish(text, false);
                return { ok: false, notStatement: true, reason: 'Not a bank statement HTML file.' };
            }
            // Encrypted → prompt for DOB, retry up to 3 times.
            var attempts = 0;
            function tryOnce() {
                return promptPassword().then(function (pw) {
                    if (pw == null) return { ok: false, cancelled: true };
                    return decrypt(text, pw).then(function (html) {
                        if (html && _decryptedOk(html)) {
                            // success — close the active overlay if still open
                            try { if (window.__wfhsActiveOverlay) { window.__wfhsActiveOverlay.style.opacity = '0'; setTimeout(function () { window.__wfhsActiveOverlay && window.__wfhsActiveOverlay.remove(); window.__wfhsActiveOverlay = null; }, 150); } } catch (_) {}
                            return _finish(html, true);
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
                                        if (h2 && _decryptedOk(h2)) {
                                            ov2.style.opacity = '0'; setTimeout(function () { ov2.remove(); window.__wfhsActiveOverlay = null; }, 150);
                                            _finish(h2, true).then(res);
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

    /* The layers individually: asserting only on htmlToTransactions cannot tell
     * WHICH one answered, so a broken table layer hid behind the text scan. */
    function _layerTables(html) {
        try { return _dedupe(_fromTables(new DOMParser().parseFromString(html, 'text/html'))); }
        catch (_) { return []; }
    }

    window.WFHtmlStatement = {
        diagnose: diagnose,
        diagLine: diagLine,
        showDiagnostic: showDiagnostic,
        _layerTables: _layerTables,
        _layerScripts: function (h) { try { return _dedupe(_fromScripts(h)); } catch (_) { return []; } },
        _layerText: function (h) { try { return _dedupe(_fromTextLines(h)); } catch (_) { return []; } },
        isEncryptedHtmlStatement: isEncryptedHtmlStatement,
        looksLikeStatement: looksLikeStatement,
        ensureCryptoJS: ensureCryptoJS,
        decrypt: decrypt,
        htmlToText: htmlToText,
        htmlToTransactions: htmlToTransactions,
        htmlToTransactionsAsync: htmlToTransactionsAsync,
        renderInSandbox: renderInSandbox,
        _buildSandboxDoc: _buildSandboxDoc,
        promptPassword: promptPassword,
        getStatementText: getStatementText,
        _params: _params
    };
    try { console.log('[WFHtmlStatement] \u2713 encrypted e-statement support ready'); } catch (_) {}
})();
