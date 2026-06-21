/*  wealthflow-pdf-unlock.js  —  password-protected PDF support for all uploads
 *
 *  When a user uploads a PDF (Upload Statement, CC One-Time, any upload), this:
 *    1. Tries to open it normally.
 *    2. If — and ONLY if — the PDF is encrypted, shows a password prompt.
 *    3. Unlocks it with the user's password (re-prompts on a wrong password).
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
    async function openPdf(arrayBuffer, askPassword) {
        var lib = await ensurePdfJs();
        var password;            // undefined on first try (unencrypted opens straight away)
        var wasEncrypted = false;
        for (var attempt = 0; attempt < 8; attempt++) {
            try {
                var pdf = await lib.getDocument({ data: _copy(arrayBuffer), password: password }).promise;
                pdf.__wasEncrypted = wasEncrypted;
                return pdf;
            } catch (e) {
                // ONLY a password error triggers the prompt; anything else is a real error
                if (e && (e.name === 'PasswordException' || /password/i.test(e.message || ''))) {
                    wasEncrypted = true;
                    var incorrect = (e.code === 2) || /incorrect/i.test(e.message || '');
                    password = await (askPassword || promptPassword)(incorrect);
                    if (password === null || password === undefined) return null;  // cancelled
                    continue;
                }
                throw e;
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

    async function getStatementText(file, askPassword) {
        var buf = await file.arrayBuffer();
        var pdf = await openPdf(buf, askPassword);
        if (!pdf) return { cancelled: true, text: '', encrypted: true };
        var text = await extractText(pdf);
        return { cancelled: false, text: text, encrypted: !!pdf.__wasEncrypted };
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

    window.WFPdfUnlock = { getStatementText: getStatementText, openPdf: openPdf, extractText: extractText, promptPassword: promptPassword, _itemsToLines: _itemsToLines };
    try { console.log('[WFPdfUnlock] ✓ encrypted-PDF unlock ready'); } catch (_) {}
})();
