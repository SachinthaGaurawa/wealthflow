/*  wealthflow-pdf-unlock.js  —  password-protected PDF support for all uploads
 *
 *  When a user uploads a PDF (Upload Statement, CC One-Time, any upload), this:
 *    1. Tries to open it normally.
 *    2. If — and ONLY if — the PDF is encrypted, tries every password the owner
 *       has already saved in the vault (and the NIC/DOB-derived guesses),
 *       most-likely-first, without asking them anything.
 *    3. Only if all of those fail, shows a password prompt.
 *    4. Extracts the text layer as clean, line-structured text and hands it to
 *       WFStatementParser for high-accuracy, balance-verified parsing.
 *
 *  Reuses the app's PDF.js v3.11.174 (window.pdfjsLib). No prompt is ever shown for
 *  a normal, unencrypted PDF.
 *
 *  window.WFPdfUnlock = { getStatementText, openPdf, extractText, promptPassword }
 *  Usage in an upload handler:
 *      const res = await WFPdfUnlock.getStatementText(file);
 *      if (res.cancelled) return;               // user dismissed the password box
 *      const txns = WFStatementParser.parseStatementText(res.text);
 */
(function () {
    'use strict';

    var _loading = null;
    function ensurePdfJs() {
        if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
        if (_loading) return _loading;
        var sources = [
            { lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js', worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js' },
            { lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js' },
            { lib: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js', worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js' }
        ];
        _loading = new Promise(function (resolve, reject) {
            var i = 0;
            (function next() {
                if (i >= sources.length) return reject(new Error('PDF.js failed to load'));
                var src = sources[i++];
                var s = document.createElement('script');
                s.src = src.lib;
                s.onload = function () {
                    try {
                        if (window.pdfjsLib && window.pdfjsLib.getDocument) {
                            window.pdfjsLib.GlobalWorkerOptions.workerSrc = src.worker;
                            resolve(window.pdfjsLib);
                        } else next();
                    } catch (e) { next(); }
                };
                s.onerror = next;
                document.head.appendChild(s);
            })();
        });
        return _loading;
    }

    // PDF.js can detach the ArrayBuffer it's given, so pass a fresh copy each attempt
    function _copy(buf) { return new Uint8Array(buf).slice(); }

    /*  openPdf(arrayBuffer, askPassword)
     *  askPassword(isRetry) → Promise<string|null>  (null = user cancelled)
     *  Resolves the pdf document, or null if the user cancelled the password box.
     */
    /*  Is this pdf.js error "the password is wrong / missing"?
     *  Anything else is a real error and must not be answered with a password.
     */
    function _isPasswordError(e) {
        return !!(e && (e.name === 'PasswordException' || /password/i.test(e.message || '')));
    }

    /*  THE PASSWORDS THE OWNER ALREADY SAVED, TRIED BEFORE ANYONE IS ASKED.
     *
     *  ── THE DEFECT THIS CLOSES ──────────────────────────────────────────
     *
     *  The vault, the derived NIC/DOB guesses, and `candidatesFor()` — which
     *  orders every saved password most-likely-first — have all existed for a
     *  while. Two callers used them: the mail-statement path in index.html and
     *  the loader in wealthflow-ai-v4.js.
     *
     *  THIS module did not, and this module is the one whose own header says it
     *  handles "Upload Statement, CC One-Time, any upload". So a locked PDF
     *  arriving through getStatementText() went straight to a password box and
     *  asked the owner to type a password they had already saved — while a
     *  locked PDF arriving through a different door opened itself.
     *
     *  A facility built and wired to some of its callers is this repository's
     *  most repeated defect. It is fixed here rather than at the two call sites
     *  because one place is the only arrangement that cannot drift.
     *
     *  ── WHAT IT DOES NOT DO ─────────────────────────────────────────────
     *
     *  Nothing leaves the device. The vault is decrypted in memory under a key
     *  derived from the master PIN, pdf.js decrypts a local file, and no
     *  password is logged, reported, or attached to the result — only WHICH
     *  SOURCE opened it, so the interface can say "opened with a saved
     *  password" without saying which.
     */
    async function _vaultCandidates(bank, getCandidates) {
        var fn = getCandidates
            || (typeof window !== 'undefined' && window.wfVaultPdfPasswords);
        if (typeof fn !== 'function') return [];
        try {
            var list = await fn(bank || '');
            if (!Array.isArray(list)) return [];
            var out = [];
            for (var i = 0; i < list.length; i++) {
                var v = list[i] == null ? '' : String(list[i]);
                if (v && out.indexOf(v) === -1) out.push(v);
            }
            return out;
        } catch (_) {
            /* A vault that will not open is not a reason to fail the upload —
             * the password box below is still a real answer. */
            return [];
        }
    }

    /*  Try each candidate in turn. Returns the opened document, or null.
     *  `open` is injected so this can be tested without pdf.js or a browser.
     */
    async function tryCandidates(open, bytes, candidates) {
        for (var i = 0; i < candidates.length; i++) {
            try {
                var doc = await open(candidates[i]);
                if (doc) return { doc: doc, index: i };
            } catch (e) {
                /* A WRONG PASSWORD IS NOT A FAILURE — it is the next attempt.
                 * Any other error is, and stops the loop: retrying a corrupt
                 * file against forty passwords is forty ways to say the same
                 * thing slowly. */
                if (!_isPasswordError(e)) throw e;
            }
        }
        return null;
    }

    /*  openPdf(arrayBuffer, askPassword, opts)
     *  askPassword(isRetry) → Promise<string|null>  (null = user cancelled)
     *  opts.bank            → orders the saved passwords, when the bank is known
     *  opts.getCandidates   → injected for tests; defaults to the vault
     *  Resolves the pdf document, or null if the user cancelled the password box.
     */
    async function openPdf(arrayBuffer, askPassword, opts) {
        opts = opts || {};
        var lib = await ensurePdfJs();
        var open = function (pw) {
            return lib.getDocument({ data: _copy(arrayBuffer), password: pw }).promise;
        };

        /* Unencrypted opens straight away and no vault is consulted: a normal
         * PDF must never cause a password to be read out of storage. */
        try {
            var plain = await open(undefined);
            plain.__wasEncrypted = false;
            plain.__unlockedBy = null;
            return plain;
        } catch (e0) {
            if (!_isPasswordError(e0)) throw e0;
        }

        var saved = await _vaultCandidates(opts.bank, opts.getCandidates);
        var hit = await tryCandidates(open, arrayBuffer, saved);
        if (hit) {
            hit.doc.__wasEncrypted = true;
            /* The SOURCE, never the password. */
            hit.doc.__unlockedBy = 'vault';
            hit.doc.__triedSaved = saved.length;
            return hit.doc;
        }

        /* Only now is the owner asked, and only for what the vault did not
         * already know. */
        var password;
        for (var attempt = 0; attempt < 8; attempt++) {
            var incorrect = attempt > 0 || saved.length > 0;
            password = await (askPassword || promptPassword)(incorrect);
            if (password === null || password === undefined) return null;  // cancelled
            try {
                var pdf = await open(password);
                pdf.__wasEncrypted = true;
                pdf.__unlockedBy = 'typed';
                pdf.__triedSaved = saved.length;
                return pdf;
            } catch (e) {
                if (!_isPasswordError(e)) throw e;
            }
        }
        return null;
    }

    // Reconstruct line-structured text from PDF.js text items (group by y, order by x)
    function _itemsToLines(items) {
        var rows = [];
        for (var k = 0; k < items.length; k++) {
            var it = items[k];
            if (!it || !it.str) continue;
            var y = Math.round((it.transform && it.transform[5]) || 0);
            var row = null;
            for (var r = 0; r < rows.length; r++) { if (Math.abs(rows[r].y - y) <= 2) { row = rows[r]; break; } }
            if (!row) { row = { y: y, items: [] }; rows.push(row); }
            row.items.push(it);
        }
        rows.sort(function (a, b) { return b.y - a.y; });   // top of page first
        return rows.map(function (r) {
            return r.items.sort(function (a, b) { return (a.transform[4] || 0) - (b.transform[4] || 0); })
                .map(function (i) { return i.str; }).join(' ').replace(/\s+/g, ' ').trim();
        }).filter(Boolean).join('\n');
    }

    async function extractText(pdf) {
        var out = [];
        for (var p = 1; p <= pdf.numPages; p++) {
            var page = await pdf.getPage(p);
            var tc = await page.getTextContent();
            out.push(_itemsToLines(tc.items));
        }
        return out.join('\n');
    }

    async function getStatementText(file, askPassword, opts) {
        var buf = await file.arrayBuffer();
        var pdf = await openPdf(buf, askPassword, opts);
        if (!pdf) return { cancelled: true, text: '', encrypted: true };
        var text = await extractText(pdf);
        return {
            cancelled: false, text: text, encrypted: !!pdf.__wasEncrypted,
            /* 'vault' | 'typed' | null. The SOURCE, never the password — so a
             * screen can say "opened with a saved password" without saying
             * which one, and so a caller can tell whether the owner was made to
             * do work the vault could have done. */
            unlockedBy: pdf.__unlockedBy || null,
            triedSaved: pdf.__triedSaved || 0,
        };
    }

    // ── password prompt UI (dark-theme, matches the app) ─────────────────────────
    function promptPassword(isRetry) {
        return new Promise(function (resolve) {
            var ov = document.createElement('div');
            ov.style.cssText = 'position:fixed;inset:0;z-index:99999;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,0.6);backdrop-filter:blur(4px);';
            ov.innerHTML =
                '<div style="background:var(--card,#11182a);border:1px solid var(--border2,#243049);border-radius:16px;padding:22px;max-width:340px;width:88%;box-shadow:0 20px 60px rgba(0,0,0,0.5);">' +
                    '<div style="font-size:16px;font-weight:800;color:var(--text,#e2e8f0);display:flex;align-items:center;gap:8px;">🔒 Protected PDF</div>' +
                    '<div style="font-size:13px;color:var(--text2,#94a3b8);margin:8px 0 14px;">This statement is password-protected. Enter its password to unlock and read it.</div>' +
                    (isRetry ? '<div id="wfPwErr" style="font-size:12px;color:#ef4444;margin-bottom:8px;">Incorrect password — please try again.</div>' : '') +
                    '<input id="wfPwInput" type="password" autocomplete="off" placeholder="PDF password" style="width:100%;box-sizing:border-box;padding:11px 12px;border-radius:10px;border:1px solid var(--border2,#243049);background:var(--bg,#0b0f1a);color:var(--text,#e2e8f0);font-size:14px;outline:none;" />' +
                    '<div style="display:flex;gap:8px;margin-top:14px;">' +
                        '<button id="wfPwCancel" style="flex:1;padding:10px;border-radius:10px;border:1px solid var(--border2,#243049);background:transparent;color:var(--text2,#94a3b8);font-weight:700;cursor:pointer;">Cancel</button>' +
                        '<button id="wfPwOk" style="flex:1;padding:10px;border-radius:10px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;">Unlock</button>' +
                    '</div>' +
                '</div>';
            document.body.appendChild(ov);
            var input = ov.querySelector('#wfPwInput');
            if (input) setTimeout(function () { input.focus(); }, 50);
            function done(val) { try { ov.remove(); } catch (_) {} resolve(val); }
            ov.querySelector('#wfPwCancel').onclick = function () { done(null); };
            ov.querySelector('#wfPwOk').onclick = function () { done(input ? input.value : ''); };
            if (input) input.addEventListener('keydown', function (e) { if (e.key === 'Enter') done(input.value); if (e.key === 'Escape') done(null); });
        });
    }

    window.WFPdfUnlock = { getStatementText: getStatementText, openPdf: openPdf, extractText: extractText, promptPassword: promptPassword, _itemsToLines: _itemsToLines, tryCandidates: tryCandidates, _isPasswordError: _isPasswordError };
    try { console.log('[WFPdfUnlock] ✓ encrypted-PDF unlock ready'); } catch (_) {}
})();
