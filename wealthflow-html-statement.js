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
        // Day + month-NAME + optional year, separated by space, hyphen or slash.
        // Covers "05 May 2026", "02-Aug-2026" (the format on NTB / AmEx Smart
        // Statements) and "02/Aug/2026". The hyphenated form was previously
        // unmatched, so every row on those statements parsed to no date and was
        // dropped — the statement decrypted but showed zero transactions.
        m = d.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,})\.?[\s\-\/]*(\d{4})?$/);
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

    // A cell that is ONLY money: optional currency code, sign, parens, Dr/Cr.
    var _MONEY_ONLY = /^\(?\s*(?:[A-Z]{3}\s*)?[-+]?[\d,]+(?:\.\d{1,2})?\s*\)?\s*(?:[A-Z]{3}\s*)?(?:DR|CR)?\.?$/i;
    function _isMoney(s) { s = String(s || '').trim(); return !!s && _MONEY_ONLY.test(s); }
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
        if (/^\s*-/.test(t.trim())) return 'credit';
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

                var row = (date && amtRaw != null) ? _mkRow(date, narr, amtRaw, '') : null;
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

    /** Every balanced [...] span inside a <script>, parsed as data if it can be. */
    function _fromScripts(html) {
        var out = [];
        var blocks = String(html).match(/<script[^>]*>[\s\S]*?<\/script>/gi) || [];
        blocks.forEach(function (block) {
            var body = block.replace(/^<script[^>]*>/i, '').replace(/<\/script>\s*$/i, '');
            for (var i = 0; i < body.length; i++) {
                if (body[i] !== '[') continue;
                var depth = 0, inStr = false, q = '', j = i;
                for (; j < body.length; j++) {
                    var ch = body[j];
                    if (inStr) { if (ch === '\\') { j++; continue; } if (ch === q) inStr = false; continue; }
                    if (ch === '"' || ch === "'") { inStr = true; q = ch; continue; }
                    if (ch === '[') depth++;
                    else if (ch === ']') { depth--; if (depth === 0) break; }
                }
                if (depth !== 0) break;                      // unbalanced — give up on this block
                var span = body.slice(i, j + 1);
                i = j;
                if (span.length < 20 || span.indexOf('{') < 0) continue;
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
                arr.forEach(function (o) { var r = _fromObject(o); if (r) out.push(r); });
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

    /* The layers individually: asserting only on htmlToTransactions cannot tell
     * WHICH one answered, so a broken table layer hid behind the text scan. */
    function _layerTables(html) {
        try { return _dedupe(_fromTables(new DOMParser().parseFromString(html, 'text/html'))); }
        catch (_) { return []; }
    }

    window.WFHtmlStatement = {
        _layerTables: _layerTables,
        _layerScripts: function (h) { try { return _dedupe(_fromScripts(h)); } catch (_) { return []; } },
        _layerText: function (h) { try { return _dedupe(_fromTextLines(h)); } catch (_) { return []; } },
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
