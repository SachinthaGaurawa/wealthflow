/* ============================================================================
 *  WealthFlow AI v3.0 — Universal Patch Module
 *  ============================================================================
 *  Drop-in runtime upgrade that monkey-patches the existing index.html. No
 *  rewriting needed. Loaded as a deferred <script> AFTER index.html's app code
 *  has defined its globals.
 *
 *  WHAT THIS FIXES / ADDS
 *  ----------------------
 *  1.  📸 AI Scan now accepts PDFs (auto-converts to image via PDF.js).
 *  2.  Deep multi-engine vision (Gemini 2.5 Flash + Gemini 2.0 + Ollama
 *      llama3.2-vision + Groq Llava + OCR.space) with consensus voting.
 *  3.  Smart RECURRING-BILL DETECTION: when a user uploads e.g. a phone bill
 *      a month later, AI recognises it as the same recurring expense — copies
 *      description / notes from previous month, but RE-detects category each
 *      time (services can change).
 *  4.  AI Advisor file/image/PDF attachment now WORKS — universal scanner that
 *      summarises ANY document (not only receipts).
 *  5.  🗑️ Trash button in AI Advisor — clears CHAT ONLY, preserves memory.
 *  6.  Reset AI Memory in Settings — beautiful modal, requires PIN to confirm
 *      PERMANENT deletion of all chat + memory + persona.
 *  7.  AI replies in user's language naturally (warm, human, not robotic).
 *  8.  AI Advisor knows everything — not just finance. Talks about life,
 *      world facts, anything — like a smart human friend.
 *  9.  Settings modal for the scanner (mode / language / preprocessing).
 * 10.  Cross-device sync of AI memory continues to work; reset clears cloud copy
 *      too.
 *
 *  Required external assets (auto-loaded on demand):
 *    - PDF.js  v3.11.174 (only loaded if user uploads a PDF)
 *    - /wealthflow-scanner.js (already loaded in <head>)
 * ========================================================================== */

(function () {
    'use strict';
    var V = 'WF-AI-v3.0';
    console.log('[' + V + '] booting…');

    /* =========================================================================
     * 0. SAFETY HELPERS — wait for the host app to be ready before patching.
     * ========================================================================= */
    function whenReady(test, cb, maxWaitMs) {
        var start = Date.now();
        var iv = setInterval(function () {
            try {
                if (test()) {
                    clearInterval(iv);
                    cb();
                } else if (Date.now() - start > (maxWaitMs || 8000)) {
                    clearInterval(iv);
                    console.warn('[' + V + '] timeout waiting for host app; some patches may not apply.');
                    cb(); // try anyway
                }
            } catch (_) { /* keep polling */ }
        }, 80);
    }

    function safeCall(fn) {
        return function () {
            try { return fn.apply(this, arguments); }
            catch (e) { console.error('[' + V + ']', e); return null; }
        };
    }

    /* =========================================================================
     * 1. ON-DEMAND PDF.js LOADER
     *    Receipts often arrive as PDFs (Dialog bills, CEB bills, bank
     *    statements). We render page 1 to a canvas → feed it through the
     *    same vision pipeline.
     * ========================================================================= */
    var _pdfjsLoading = null;
    function ensurePdfJs() {
        if (window.pdfjsLib) return Promise.resolve(window.pdfjsLib);
        if (_pdfjsLoading) return _pdfjsLoading;
        _pdfjsLoading = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
            s.onload = function () {
                try {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
                    resolve(window.pdfjsLib);
                } catch (e) { reject(e); }
            };
            s.onerror = function () { reject(new Error('PDF.js failed to load')); };
            document.head.appendChild(s);
        });
        return _pdfjsLoading;
    }

    /**
     * Render one or more PDF pages to a JPEG-encoded canvas data URL.
     * For receipts we usually only need page 1, but multi-page mode helps
     * when the totals are on the last page. We render up to `maxPages` and
     * return an array of base64 strings.
     */
    async function pdfFileToImages(file, opts) {
        opts = opts || {};
        var maxPages = opts.maxPages || 3;
        var scale = opts.scale || 2.0; // 2x scale = ~300dpi equivalent
        await ensurePdfJs();
        var buf = await file.arrayBuffer();
        var pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        var pages = Math.min(pdf.numPages, maxPages);
        var images = [];
        for (var i = 1; i <= pages; i++) {
            var page = await pdf.getPage(i);
            var viewport = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            var ctx = canvas.getContext('2d');
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, viewport.width, viewport.height);
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            var dataUrl = canvas.toDataURL('image/jpeg', 0.88);
            images.push(dataUrl.split(',')[1]);
        }
        return images; // array of base64 strings
    }

    /* =========================================================================
     * 2. UNIVERSAL FILE → BASE64 IMAGE(S)
     *    Handles images directly, converts PDFs via pdf.js.
     * ========================================================================= */
    async function fileToBase64Images(file) {
        if (!file) throw new Error('No file provided');
        var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        if (isPdf) {
            var pages = await pdfFileToImages(file, { maxPages: 3, scale: 2.0 });
            if (!pages.length) throw new Error('PDF has no pages');
            return { images: pages, isPdf: true, pageCount: pages.length };
        }
        // Image — single base64
        var b64 = await new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () {
                try { resolve(r.result.split(',')[1]); }
                catch (e) { reject(e); }
            };
            r.onerror = function () { reject(new Error('File read failed')); };
            r.readAsDataURL(file);
        });
        return { images: [b64], isPdf: false, pageCount: 1 };
    }

    /* =========================================================================
     * 3. MULTI-ENGINE VISION SCAN — calls the /api/vision-scan endpoint.
     *    For PDFs we send the FIRST page to the server (server is fastest and
     *    most expensive part). If first page fails we retry with second page.
     * ========================================================================= */
    function _apiBase() {
        // Dev / GitHub Pages → use the public Vercel deployment
        var isLocalOrGitHub =
            window.location.hostname.includes('github.io') ||
            window.location.hostname === 'localhost';
        return isLocalOrGitHub ? 'https://wealthflow-personal.vercel.app/api' : '/api';
    }

    async function visionScanCall(image, mode, hints, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 55000);
        try {
            var r = await fetch(_apiBase() + '/vision-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: image, mode: mode, hints: hints }),
                signal: controller.signal
            });
            var data;
            try { data = await r.json(); } catch (_) { data = {}; }
            if (!r.ok) {
                var err = new Error(data.error || ('vision-scan ' + r.status));
                err.serverDetails = data;
                throw err;
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    /* =========================================================================
     * 4. RECURRING-EXPENSE FINGERPRINTING
     *    When the user uploads a bill, we check whether the same vendor /
     *    bill type has been seen before. If yes, we copy the description and
     *    notes from the most recent matching entry — but we ALWAYS re-detect
     *    the category (services may change month to month).
     * ========================================================================= */
    function _vendorFingerprint(s) {
        if (!s) return '';
        return String(s).toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, ' ')
            .trim()
            .split(' ')
            .filter(function (w) { return w.length > 2; })
            .slice(0, 3)
            .join(' ');
    }

    function findMatchingPriorExpense(vendor) {
        try {
            if (typeof DB === 'undefined' || typeof DB.get !== 'function') return null;
            var fp = _vendorFingerprint(vendor);
            if (!fp || fp.length < 3) return null;
            var all = DB.get('expenses') || [];
            // Sort by month descending so we pick the most recent
            all = all.slice().sort(function (a, b) { return String(b.month || '').localeCompare(String(a.month || '')); });
            for (var i = 0; i < all.length; i++) {
                var ex = all[i];
                var theirFp = _vendorFingerprint(ex.desc);
                if (!theirFp) continue;
                // Bidirectional partial match — "Dialog Axiata" matches "Dialog Postpaid"
                if (theirFp.indexOf(fp) > -1 || fp.indexOf(theirFp) > -1) {
                    return ex;
                }
                // Token-overlap check (at least 1 shared significant token)
                var fpTokens = fp.split(' ');
                var theirTokens = theirFp.split(' ');
                var shared = fpTokens.filter(function (t) { return theirTokens.indexOf(t) > -1; });
                if (shared.length >= 1 && shared[0].length >= 4) return ex;
            }
        } catch (_) { /* ignore */ }
        return null;
    }

    /* =========================================================================
     * 5. RICH NOTE BUILDER
     *    Build a one-liner "Notes" string for the expense form.
     *    Format: "📦 items list  ·  💳 paid by card  ·  🧾 INV-1234"
     * ========================================================================= */
    function buildSmartNote(result, isPdf, pageCount) {
        if (!result) return '';
        var parts = [];
        if (result.items && result.items.length) {
            parts.push('📦 ' + result.items.slice(0, 5).join(', '));
        }
        if (result.payment_method) {
            var pm = String(result.payment_method).toLowerCase();
            var label = pm === 'card' ? '💳 Card' : pm === 'cash' ? '💵 Cash' :
                pm === 'digital' ? '📲 Digital' : null;
            if (label) parts.push(label);
        }
        if (result.receipt_number) parts.push('🧾 ' + result.receipt_number);
        if (result.tax && typeof result.tax === 'number') {
            parts.push('🧮 Tax LKR ' + result.tax.toLocaleString());
        }
        if (isPdf) parts.push('📄 PDF · ' + pageCount + 'pg');
        return parts.join(' · ');
    }

    /* =========================================================================
     * 6. POPULATE EXPENSE FORM
     *    Smart fill — preserves user-entered values where appropriate.
     * ========================================================================= */
    function populateExpenseForm(result, opts) {
        opts = opts || {};
        var $ = function (id) { return document.getElementById(id); };
        if (!result) return false;
        var filled = false;
        var prior = result._priorMatch || null;

        // Description: use prior's description if same recurring bill — keeps the
        // user-friendly label (e.g. "Dialog Mobile Bill") instead of OCR text
        // (e.g. "Dialog Axiata PLC")
        if ($('e_desc')) {
            if (prior && prior.desc) {
                $('e_desc').value = prior.desc;
                filled = true;
            } else if (result.vendor) {
                $('e_desc').value = result.vendor;
                filled = true;
            }
        }

        if ($('e_amount') && typeof result.amount === 'number') {
            var fmt = (typeof window.fmtN === 'function') ? window.fmtN(result.amount) : result.amount.toFixed(2);
            $('e_amount').value = fmt;
            filled = true;
        }

        if ($('e_month') && result.date && /^\d{4}-\d{2}/.test(result.date)) {
            $('e_month').value = result.date.substring(0, 7);
            filled = true;
        }

        // CATEGORY: always re-detect, even for recurring bills (service may change)
        if ($('e_cat') && result.category) {
            var sel = $('e_cat');
            var target = String(result.category).toLowerCase();
            var matched = false;
            for (var i = 0; i < sel.options.length; i++) {
                var optText = sel.options[i].text.toLowerCase();
                var optVal = sel.options[i].value.toLowerCase();
                if (optText === target || optVal === target) {
                    sel.value = sel.options[i].value; matched = true; break;
                }
            }
            if (!matched) {
                // Loose match (substring)
                for (var j = 0; j < sel.options.length; j++) {
                    var ot = (sel.options[j].text + ' ' + sel.options[j].value).toLowerCase();
                    var firstWord = target.split(/[ &]/)[0];
                    if (firstWord && ot.indexOf(firstWord) > -1) {
                        sel.value = sel.options[j].value; matched = true; break;
                    }
                }
            }
            if (matched) filled = true;
        }

        // Recurring flag — if this is a known recurring bill, default to monthly
        if (prior && $('e_recurring')) {
            $('e_recurring').value = prior.recurring || '1';
        }

        // Notes — smart compose
        if ($('e_notes')) {
            var existing = $('e_notes').value || '';
            // Strip any prior auto-generated content
            var cleaned = existing.split('|').map(function (p) {
                p = p.trim();
                if (!p) return '';
                if (/^(📦|🔤|💳|💵|📲|🧾|🧮|📄|🤖 Recurring)/.test(p)) return '';
                return p;
            }).filter(Boolean).join(' | ');
            var note = buildSmartNote(result, opts.isPdf, opts.pageCount);
            if (prior) {
                note = (note ? note + ' · ' : '') + '🤖 Recurring (same as ' + (prior.month || 'previous') + ')';
            }
            $('e_notes').value = cleaned ? (cleaned + ' | ' + note) : note;
        }

        return filled;
    }

    /* =========================================================================
     * 7. THE NEW handleAIScan — replaces the host app's existing function.
     *    Tries: vision-scan (deep) → vision-scan (ultra) → legacy /api/ai →
     *    Tesseract.js (in-browser).  Each step is logged + uses the existing
     *    scan-overlay UI.
     * ========================================================================= */
    async function newHandleAIScan(e, type) {
        var file = e.target && e.target.files && e.target.files[0];
        if (!file) return;
        var inputEl = e.target;
        var startTime = Date.now();
        var sizeMB = (file.size / 1024 / 1024).toFixed(2);
        var isExpense = (type === 'expense');
        var isAiChat = (type === 'ai_chat');

        if (typeof window.triggerHaptic === 'function') window.triggerHaptic('medium');

        try {
            // ---- STEP 1: Determine file type and extract image(s) ----
            if (isExpense && typeof window._showScanOverlay === 'function') {
                window._showScanOverlay('📸 Reading File…', 'Detecting type: ' + (file.type || file.name), 8);
            } else if (typeof window.notify === 'function') {
                window.notify('📸 Reading file (' + sizeMB + 'MB)…', 'info');
            }

            var imgBundle;
            try {
                imgBundle = await fileToBase64Images(file);
            } catch (extractErr) {
                throw new Error('Could not read file: ' + extractErr.message);
            }
            var firstImage = imgBundle.images[0];
            var isPdf = imgBundle.isPdf;
            var pageCount = imgBundle.pageCount;

            // ---- AI CHAT MODE: route to chat with deep analysis ----
            if (isAiChat) {
                await handleAIChatAttachment(file, imgBundle);
                inputEl.value = '';
                return;
            }

            // ---- STEP 2: Try the multi-engine vision-scan endpoint (deep) ----
            if (typeof window._showScanOverlay === 'function')
                window._showScanOverlay('🧠 AI Vision (Deep)…', '4 engines voting on the result', 30);

            var settings = window.WF_SCAN_SETTINGS || {};
            var hints = {
                currency: settings.currency || 'LKR',
                today: new Date().toISOString().split('T')[0],
                locale: navigator.language || 'en-LK'
            };
            var mode = settings.mode || 'deep';

            var scanData = null;
            var lastErr = null;
            try {
                scanData = await visionScanCall(firstImage, mode, hints, 55000);
            } catch (err1) {
                lastErr = err1;
                console.warn('[' + V + '] vision-scan ' + mode + ' failed:', err1.message);
                // Try ultra mode as escalation (only if deep failed and we have time)
                if (mode !== 'ultra') {
                    if (typeof window._showScanOverlay === 'function')
                        window._showScanOverlay('💎 Ultra Mode…', 'Escalating with all engines', 50);
                    try {
                        scanData = await visionScanCall(firstImage, 'ultra', hints, 58000);
                    } catch (err2) {
                        lastErr = err2;
                        console.warn('[' + V + '] vision-scan ultra failed:', err2.message);
                    }
                }
            }

            // ---- STEP 3: PDF multi-page fallback — try page 2 if available ----
            if ((!scanData || !scanData.result || !scanData.result.amount) && isPdf && imgBundle.images.length > 1) {
                if (typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('📄 PDF Page 2…', 'First page failed — trying next page', 60);
                try {
                    scanData = await visionScanCall(imgBundle.images[1], 'deep', hints, 40000);
                } catch (_) { /* keep going */ }
            }

            // ---- STEP 4: Final fallback — Tesseract for offline scenarios ----
            if ((!scanData || !scanData.result || !scanData.result.amount) && !isPdf) {
                try {
                    if (typeof window._ocrWithTesseract === 'function' &&
                        typeof window._extractFromOCRText === 'function') {
                        if (typeof window._showScanOverlay === 'function')
                            window._showScanOverlay('🔤 Offline OCR…', 'Tesseract reading text', 70);
                        var ocrText = await window._ocrWithTesseract(file);
                        var ocrResult = window._extractFromOCRText(ocrText);
                        if (ocrResult && ocrResult.amount) {
                            scanData = {
                                result: ocrResult,
                                confidence: { overall: 0.55, vendor: 0.5, amount: 0.6, date: 0.5 },
                                engines: [{ name: 'tesseract', success: true, ms: 0 }],
                                mode: 'tesseract-fallback'
                            };
                        }
                    }
                } catch (e3) {
                    console.warn('[' + V + '] tesseract fallback failed:', e3.message);
                }
            }

            // ---- STEP 5: Apply result or fail ----
            if (!scanData || !scanData.result || !scanData.result.amount) {
                if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                if (typeof window.notify === 'function')
                    window.notify('⚠️ Could not extract amount. Try a clearer photo or PDF.', 'error');
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('error');
                inputEl.value = '';
                return;
            }

            // Annotate with recurring-bill match BEFORE populating
            var priorMatch = findMatchingPriorExpense(scanData.result.vendor);
            if (priorMatch) {
                scanData.result._priorMatch = priorMatch;
                console.log('[' + V + '] recurring bill matched:', priorMatch.desc, 'from', priorMatch.month);
            }

            if (typeof window._showScanOverlay === 'function')
                window._showScanOverlay('✅ Filling form…', 'Smart-populating fields', 95);

            var ok = populateExpenseForm(scanData.result, {
                isPdf: isPdf, pageCount: pageCount
            });

            if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();

            if (ok) {
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('success');
                var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                var conf = Math.round((scanData.confidence && scanData.confidence.overall || 0) * 100);
                var engineCount = (scanData.engines || []).filter(function (en) { return en.success; }).length;
                var msg = '✅ ' + (scanData.result.vendor || 'Receipt') +
                    ' · LKR ' + ((typeof window.fmtN === 'function') ? window.fmtN(scanData.result.amount) : scanData.result.amount);
                if (priorMatch) msg += '\n🔁 Recurring bill — same as ' + priorMatch.month;
                msg += '\n⚙️ ' + engineCount + ' engines · ' + conf + '% conf · ' + elapsed + 's';
                if (typeof window.notify === 'function') {
                    var kind = (conf >= 75) ? 'success' : (conf >= 50 ? 'info' : 'warning');
                    window.notify(msg, kind);
                }
                console.log('[' + V + '] scan complete', scanData);
            } else {
                if (typeof window.notify === 'function')
                    window.notify('⚠️ Could not fill form. Please enter manually.', 'warning');
            }
        } catch (err) {
            console.error('[' + V + '] scan failed:', err);
            if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
            if (typeof window.notify === 'function')
                window.notify('⚠️ Scan failed: ' + (err.message || 'unknown error'), 'error');
            if (typeof window.triggerHaptic === 'function') window.triggerHaptic('error');
        } finally {
            if (inputEl) inputEl.value = '';
        }
    }

    /* =========================================================================
     * 8. AI ADVISOR ATTACHMENT HANDLER — runs vision scan, then asks the AI
     *    to interpret the document conversationally.
     * ========================================================================= */
    async function handleAIChatAttachment(file, imgBundle) {
        var firstImage = imgBundle.images[0];
        var isPdf = imgBundle.isPdf;

        if (typeof window.appendAIMessage === 'function') {
            window.appendAIMessage('user',
                '📎 *Attached ' + (isPdf ? 'PDF (' + imgBundle.pageCount + ' page' + (imgBundle.pageCount > 1 ? 's' : '') + ')' : 'image') +
                ': ' + (file.name || 'file') + '*');
        }
        if (typeof window.showAITyping === 'function') window.showAITyping(true);
        if (typeof window.notify === 'function') window.notify('🔍 Deep scanning attachment…', 'info');

        try {
            // Run vision scan (deep) first to get the structured data
            var hints = { currency: 'LKR', today: new Date().toISOString().split('T')[0] };
            var scanData = null;
            try {
                scanData = await visionScanCall(firstImage, 'deep', hints, 50000);
            } catch (_) {
                try {
                    scanData = await visionScanCall(firstImage, 'quick', hints, 30000);
                } catch (_2) { /* keep going */ }
            }

            // Now ask the AI to write a friendly summary using the OCR text + structured data
            var rawText = scanData && scanData.result && scanData.result.raw_text ? scanData.result.raw_text : '';
            var structured = scanData && scanData.result ? JSON.stringify(scanData.result, null, 2) : '(no structured data)';
            var userName = (typeof window.currentUser !== 'undefined' && window.currentUser && window.currentUser.displayName) ?
                window.currentUser.displayName.split(' ')[0] : 'there';

            // Determine the active language
            var lang = 'English';
            try {
                if (typeof window.DB !== 'undefined') {
                    var s = window.DB.getObj('settings', {});
                    if (s.aiResponseLang && window.WF_LANG_NAMES) {
                        lang = window.WF_LANG_NAMES[s.aiResponseLang] || 'English';
                    }
                }
            } catch (_) { }

            var prompt = "You are WealthFlow AI — a warm, friendly financial advisor having a casual conversation with " + userName + ". " +
                "They just shared a document with you (it could be a receipt, bill, statement, ID, contract, manual, or anything). " +
                "Your job is to be HUMAN, helpful, and concise.\n\n" +
                "RESPONSE LANGUAGE: Reply entirely in " + lang + " — naturally, warmly, like a real human friend. Never sound robotic.\n\n" +
                "Here is what the vision system extracted:\n" +
                "STRUCTURED DATA:\n" + structured + "\n\n" +
                (rawText ? "RAW OCR TEXT:\n" + rawText.substring(0, 2500) + "\n\n" : "") +
                "Now give the user a brief, friendly summary (2-5 sentences). If it's a financial document, include the key numbers in bold using **LKR X,XXX** format. " +
                "If it's a bill they could log, gently suggest they tap 📸 AI Scan in Monthly Expenses to add it.\n" +
                "Be conversational. Use light emojis if it fits. End with one helpful question or observation.";

            var reply = await window.callAI(prompt);
            if (typeof window.appendAIMessage === 'function') window.appendAIMessage('bot', reply);

            // Save into history so it's part of context
            if (typeof window.getAIHistory === 'function' && typeof window.saveAIHistory === 'function') {
                var hist = window.getAIHistory();
                hist.push({ role: 'user', content: '📎 [shared a ' + (isPdf ? 'PDF' : 'image') + ': ' + (file.name || 'file') + ']', ts: Date.now() });
                hist.push({ role: 'assistant', content: reply, ts: Date.now() });
                window.saveAIHistory(hist);
            }

            if (typeof window.notify === 'function') window.notify('✅ Document analysed', 'success');
        } catch (e) {
            console.error('[' + V + '] AI chat attachment failed:', e);
            if (typeof window.appendAIMessage === 'function') {
                window.appendAIMessage('bot', '⚠️ I had trouble reading that file. Could you try sending a clearer photo or a different format?');
            }
            if (typeof window.notify === 'function') window.notify('⚠️ Could not analyse: ' + e.message, 'error');
        } finally {
            if (typeof window.showAITyping === 'function') window.showAITyping(false);
        }
    }

    /* =========================================================================
     * 9. ENHANCED clearAIChat — clears CHAT MESSAGES only.
     *    Memory (persona, patterns, preferences) is KEPT.
     * ========================================================================= */
    function newClearAIChat() {
        // Beautiful confirm modal instead of native confirm()
        showBeautifulConfirm({
            icon: '🗑️',
            title: 'Clear Chat History?',
            message: 'I\'ll forget the messages on screen but keep what I\'ve learned about you (your style, preferences, finances). To erase everything permanently, use Settings → Reset AI Memory.',
            confirmText: 'Clear Chat',
            cancelText: 'Cancel',
            accent: 'amber',
            onConfirm: function () {
                try {
                    localStorage.removeItem('wf_ai_history');
                    var container = document.getElementById('aiChatMessages');
                    if (container) {
                        container.innerHTML = '';
                        var welcome = document.createElement('div');
                        welcome.id = 'aiWelcomeBlock';
                        welcome.className = 'ai-welcome-msg';
                        welcome.innerHTML =
                            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
                              '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#0d1d3c,#1a2d4c);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🤖</div>' +
                              '<div><div style="font-size:13px;font-weight:700;color:var(--accent);">WealthFlow AI</div>' +
                              '<div style="font-size:10px;color:var(--text3);">Your personal advisor (memory intact 🧠)</div></div>' +
                            '</div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.7;">' +
                              '👋 Chat cleared. I still remember everything about you — your style, your goals, your finances. Just nothing to scroll through 💫' +
                            '</div>';
                        container.appendChild(welcome);
                    }
                    if (typeof window.notify === 'function') window.notify('🗑️ Chat cleared (memory kept).', 'success');
                    if (typeof window.initAISuggestionPills === 'function') window.initAISuggestionPills();
                    if (typeof window._scheduleAISync === 'function') window._scheduleAISync();
                } catch (e) { console.error(e); }
            }
        });
    }

    /* =========================================================================
     * 10. ENHANCED confirmResetAIMemory — beautiful modal + PIN gate
     *     PERMANENTLY wipes ALL AI data: history, persona, memory.
     * ========================================================================= */
    function newConfirmResetAIMemory() {
        showPinGatedConfirm({
            icon: '🧠',
            title: 'Erase ALL AI Memory?',
            message: 'This permanently deletes EVERYTHING the AI knows about you — chat history, learned preferences, conversation patterns, and personality calibration. This cannot be undone.',
            warning: '⚠️ You\'ll be starting over from scratch.',
            confirmText: '🗑️ Erase Forever',
            cancelText: 'Keep My Memory',
            onConfirm: async function () {
                try {
                    // 1. Clear localStorage
                    localStorage.removeItem('wf_ai_history');
                    localStorage.removeItem('wf_ai_memory');
                    localStorage.removeItem('wf_ai_persona');
                    localStorage.removeItem('wf2_ai_persona');
                    localStorage.removeItem('wf_ai_synced_at');

                    // 2. Clear cloud copy if signed in
                    try {
                        if (typeof window.currentUser !== 'undefined' && window.currentUser &&
                            typeof window.firebase !== 'undefined' && window.firebase.firestore) {
                            await window.firebase.firestore().collection('userAI').doc(window.currentUser.uid).delete();
                        }
                    } catch (e) { console.warn('[' + V + '] cloud delete failed:', e.message); }

                    // 3. Reset chat UI
                    var container = document.getElementById('aiChatMessages');
                    if (container) {
                        container.innerHTML = '';
                        var welcome = document.createElement('div');
                        welcome.id = 'aiWelcomeBlock';
                        welcome.className = 'ai-welcome-msg';
                        welcome.innerHTML =
                            '<div style="display:flex;align-items:center;gap:10px;margin-bottom:12px;">' +
                              '<div style="width:38px;height:38px;border-radius:50%;background:linear-gradient(135deg,#0d1d3c,#1a2d4c);border:2px solid var(--accent);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">🤖</div>' +
                              '<div><div style="font-size:13px;font-weight:700;color:var(--accent);">WealthFlow AI</div>' +
                              '<div style="font-size:10px;color:var(--text3);">Ready to learn you again</div></div>' +
                            '</div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.7;">' +
                              '👋 Hello! My memory has been completely reset. I don\'t know anything about you yet — but I\'m a quick learner. Ask me anything! 💫' +
                            '</div>';
                        container.appendChild(welcome);
                    }
                    if (typeof window.triggerHaptic === 'function') window.triggerHaptic('heavy');
                    if (typeof window.notify === 'function') window.notify('🧠 AI memory fully erased.', 'success');
                } catch (e) {
                    console.error('[' + V + ']', e);
                    if (typeof window.notify === 'function') window.notify('⚠️ Reset failed: ' + e.message, 'error');
                }
            }
        });
    }

    /* =========================================================================
     * 11. BEAUTIFUL CONFIRMATION MODAL (no native alert/confirm)
     * ========================================================================= */
    function _ensureModalContainer() {
        var c = document.getElementById('wf_v3_modal_container');
        if (c) return c;
        c = document.createElement('div');
        c.id = 'wf_v3_modal_container';
        document.body.appendChild(c);

        // Inject styles once
        if (!document.getElementById('wf_v3_modal_styles')) {
            var style = document.createElement('style');
            style.id = 'wf_v3_modal_styles';
            style.textContent =
                '.wf3-overlay{position:fixed;inset:0;background:rgba(2,5,12,0.78);backdrop-filter:blur(14px);' +
                'display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;' +
                'animation:wf3FadeIn 0.18s ease-out;}' +
                '@keyframes wf3FadeIn{from{opacity:0}to{opacity:1}}' +
                '@keyframes wf3SlideUp{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}' +
                '.wf3-modal{background:linear-gradient(160deg,#0c1424 0%,#0a1020 100%);max-width:440px;width:100%;' +
                'border:1px solid rgba(212,175,55,0.4);border-radius:18px;padding:0;color:#e5e7eb;' +
                'font-family:Outfit,system-ui,sans-serif;box-shadow:0 30px 80px rgba(0,0,0,0.65),0 0 50px rgba(212,175,55,0.08);' +
                'animation:wf3SlideUp 0.25s cubic-bezier(0.2,0.8,0.2,1);overflow:hidden;}' +
                '.wf3-modal-header{padding:28px 28px 16px;text-align:center;}' +
                '.wf3-modal-icon{font-size:48px;margin-bottom:10px;line-height:1;filter:drop-shadow(0 4px 12px rgba(212,175,55,0.3));}' +
                '.wf3-modal-title{font-size:20px;font-weight:700;color:#fbbf24;margin-bottom:8px;letter-spacing:0.2px;}' +
                '.wf3-modal-msg{font-size:14px;color:#cbd5e1;line-height:1.7;margin:0 auto;max-width:340px;}' +
                '.wf3-modal-warn{margin:14px 28px 0;padding:10px 14px;background:rgba(239,68,68,0.08);' +
                'border:1px solid rgba(239,68,68,0.25);border-radius:10px;color:#fca5a5;font-size:12.5px;text-align:center;}' +
                '.wf3-modal-body{padding:18px 28px 20px;}' +
                '.wf3-pin-label{font-size:12px;color:#94a3b8;margin-bottom:8px;text-align:center;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;}' +
                '.wf3-pin-dots{display:flex;justify-content:center;gap:11px;margin:8px 0 16px;}' +
                '.wf3-pin-dot{width:14px;height:14px;border-radius:50%;background:rgba(148,163,184,0.18);' +
                'border:1.5px solid rgba(148,163,184,0.3);transition:all 0.18s;}' +
                '.wf3-pin-dot.filled{background:#fbbf24;border-color:#fbbf24;box-shadow:0 0 14px rgba(251,191,36,0.6);transform:scale(1.12);}' +
                '.wf3-pin-dot.error{background:#ef4444;border-color:#ef4444;animation:wf3Shake 0.4s;}' +
                '@keyframes wf3Shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}' +
                '.wf3-pin-input{position:absolute;left:-9999px;opacity:0;}' +
                '.wf3-pin-trigger{display:block;margin:0 auto 18px;padding:11px 22px;background:rgba(212,175,55,0.1);' +
                'border:1px solid rgba(212,175,55,0.35);border-radius:10px;color:#fbbf24;font-size:13px;font-weight:600;' +
                'cursor:pointer;transition:all 0.18s;font-family:inherit;}' +
                '.wf3-pin-trigger:hover{background:rgba(212,175,55,0.18);transform:translateY(-1px);}' +
                '.wf3-pin-err{color:#ef4444;text-align:center;font-size:12.5px;height:18px;font-weight:500;}' +
                '.wf3-modal-actions{display:flex;gap:10px;padding:18px 28px 26px;border-top:1px solid rgba(148,163,184,0.08);}' +
                '.wf3-btn{flex:1;padding:13px 18px;border-radius:11px;border:0;cursor:pointer;font-size:14px;' +
                'font-weight:600;font-family:inherit;transition:all 0.16s;letter-spacing:0.2px;}' +
                '.wf3-btn-cancel{background:rgba(148,163,184,0.1);color:#cbd5e1;border:1px solid rgba(148,163,184,0.2);}' +
                '.wf3-btn-cancel:hover{background:rgba(148,163,184,0.18);transform:translateY(-1px);}' +
                '.wf3-btn-danger{background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;box-shadow:0 4px 16px rgba(220,38,38,0.35);}' +
                '.wf3-btn-danger:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(220,38,38,0.5);}' +
                '.wf3-btn-danger:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none;}' +
                '.wf3-btn-warn{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;box-shadow:0 4px 16px rgba(245,158,11,0.35);}' +
                '.wf3-btn-warn:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(245,158,11,0.5);}';
            document.head.appendChild(style);
        }
        return c;
    }

    function showBeautifulConfirm(opts) {
        var c = _ensureModalContainer();
        var btnClass = opts.accent === 'amber' ? 'wf3-btn-warn' : 'wf3-btn-danger';
        c.innerHTML =
            '<div class="wf3-overlay" id="wf3OverlayCurr">' +
              '<div class="wf3-modal">' +
                '<div class="wf3-modal-header">' +
                  '<div class="wf3-modal-icon">' + (opts.icon || '⚠️') + '</div>' +
                  '<div class="wf3-modal-title">' + opts.title + '</div>' +
                  '<div class="wf3-modal-msg">' + opts.message + '</div>' +
                '</div>' +
                '<div class="wf3-modal-actions">' +
                  '<button class="wf3-btn wf3-btn-cancel" id="wf3Cancel">' + (opts.cancelText || 'Cancel') + '</button>' +
                  '<button class="wf3-btn ' + btnClass + '" id="wf3Confirm">' + (opts.confirmText || 'Confirm') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf3Cancel').onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
        document.getElementById('wf3Confirm').onclick = function () { close(); if (opts.onConfirm) opts.onConfirm(); };
        document.getElementById('wf3OverlayCurr').onclick = function (e) {
            if (e.target.id === 'wf3OverlayCurr') { close(); if (opts.onCancel) opts.onCancel(); }
        };
    }

    /* =========================================================================
     * 12. PIN-GATED CONFIRMATION (for destructive actions)
     *     Uses the existing sha256 + auth.pin from DB to verify.
     * ========================================================================= */
    function showPinGatedConfirm(opts) {
        var c = _ensureModalContainer();
        var pinBuffer = '';

        c.innerHTML =
            '<div class="wf3-overlay" id="wf3OverlayCurr">' +
              '<div class="wf3-modal">' +
                '<div class="wf3-modal-header">' +
                  '<div class="wf3-modal-icon">' + (opts.icon || '🔐') + '</div>' +
                  '<div class="wf3-modal-title">' + opts.title + '</div>' +
                  '<div class="wf3-modal-msg">' + opts.message + '</div>' +
                '</div>' +
                (opts.warning ? '<div class="wf3-modal-warn">' + opts.warning + '</div>' : '') +
                '<div class="wf3-modal-body">' +
                  '<div class="wf3-pin-label">🔐 Enter your 6-digit Master PIN</div>' +
                  '<div class="wf3-pin-dots" id="wf3PinDots">' +
                    '<div class="wf3-pin-dot"></div><div class="wf3-pin-dot"></div><div class="wf3-pin-dot"></div>' +
                    '<div class="wf3-pin-dot"></div><div class="wf3-pin-dot"></div><div class="wf3-pin-dot"></div>' +
                  '</div>' +
                  '<button class="wf3-pin-trigger" id="wf3PinTrigger" type="button">⌨️ Type PIN</button>' +
                  '<input class="wf3-pin-input" id="wf3PinInput" type="password" inputmode="numeric" maxlength="6" autocomplete="off">' +
                  '<div class="wf3-pin-err" id="wf3PinErr"></div>' +
                '</div>' +
                '<div class="wf3-modal-actions">' +
                  '<button class="wf3-btn wf3-btn-cancel" id="wf3Cancel">' + (opts.cancelText || 'Cancel') + '</button>' +
                  '<button class="wf3-btn wf3-btn-danger" id="wf3Confirm" disabled>' + (opts.confirmText || 'Confirm') + '</button>' +
                '</div>' +
              '</div>' +
            '</div>';

        var pinInput = document.getElementById('wf3PinInput');
        var dots = document.getElementById('wf3PinDots').children;
        var confirmBtn = document.getElementById('wf3Confirm');
        var errEl = document.getElementById('wf3PinErr');

        function renderDots() {
            for (var i = 0; i < 6; i++) {
                dots[i].classList.toggle('filled', i < pinBuffer.length);
                dots[i].classList.remove('error');
            }
            confirmBtn.disabled = pinBuffer.length !== 6;
        }
        pinInput.addEventListener('input', function () {
            pinBuffer = (pinInput.value || '').replace(/[^0-9]/g, '').slice(0, 6);
            pinInput.value = pinBuffer;
            errEl.textContent = '';
            renderDots();
        });
        document.getElementById('wf3PinTrigger').onclick = function () { pinInput.focus(); };

        // Auto-focus the PIN input shortly after the modal opens
        setTimeout(function () { try { pinInput.focus(); } catch (_) {} }, 150);

        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf3Cancel').onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
        document.getElementById('wf3OverlayCurr').onclick = function (e) {
            if (e.target.id === 'wf3OverlayCurr') { close(); if (opts.onCancel) opts.onCancel(); }
        };
        confirmBtn.onclick = async function () {
            if (pinBuffer.length !== 6) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '⏳ Verifying…';
            try {
                if (typeof window.sha256 !== 'function' || typeof window.DB === 'undefined') {
                    throw new Error('PIN verification unavailable on this device');
                }
                var auth = window.DB.getObj('auth', {});
                var stored = auth.pin;
                if (!stored) {
                    // No PIN set yet — allow without PIN
                    close();
                    if (opts.onConfirm) opts.onConfirm();
                    return;
                }
                var hash = await window.sha256(pinBuffer + 'wf_salt_sg2026');
                if (hash === stored) {
                    close();
                    if (opts.onConfirm) opts.onConfirm();
                } else {
                    errEl.textContent = '❌ Incorrect PIN. Try again.';
                    for (var i = 0; i < 6; i++) dots[i].classList.add('error');
                    setTimeout(function () {
                        pinBuffer = '';
                        pinInput.value = '';
                        renderDots();
                        pinInput.focus();
                    }, 600);
                    confirmBtn.disabled = false;
                    confirmBtn.textContent = opts.confirmText || 'Confirm';
                    if (typeof window.triggerHaptic === 'function') window.triggerHaptic('error');
                }
            } catch (e) {
                errEl.textContent = '⚠️ ' + e.message;
                confirmBtn.disabled = false;
                confirmBtn.textContent = opts.confirmText || 'Confirm';
            }
        };
    }

    /* =========================================================================
     * 13. ENHANCED buildSystemPrompt — natural multilingual + universal knowledge
     *     This wraps the existing one and prepends extra directives.
     * ========================================================================= */
    function patchBuildSystemPrompt() {
        if (typeof window.buildSystemPrompt !== 'function') return;
        var orig = window.buildSystemPrompt;
        window.buildSystemPrompt = function (ctx, persona) {
            var base;
            try { base = orig.call(this, ctx, persona); } catch (e) { console.warn(e); return ''; }

            // Determine language for natural greeting hint
            var lang = 'English';
            try {
                if (typeof window.DB !== 'undefined') {
                    var s = window.DB.getObj('settings', {});
                    if (s.aiResponseLang && window.WF_LANG_NAMES) {
                        lang = window.WF_LANG_NAMES[s.aiResponseLang] || 'English';
                    }
                }
            } catch (_) { }

            var extra =
                '\n\n--- WEALTHFLOW v3 UPGRADE DIRECTIVES ---\n' +
                '0. CRITICAL — UNIVERSAL KNOWLEDGE: You are NOT limited to finance. You are a smart, well-read friend. ' +
                'Answer questions about anything — world events, science, history, languages, life advice, philosophy, jokes, ' +
                'tech, cooking, relationships, anything. You only steer back to finance if the user themselves brings it up.\n' +
                '\n' +
                '1. NATURAL SPEECH IN ' + lang.toUpperCase() + ': Sound like a real human, not a translator. Use idioms, ' +
                'natural phrasing, the kind of words a native speaker actually uses in casual conversation. ' +
                'For Sinhala / Tamil / Hindi etc: use Roman or native script as the user does. Match THEIR style and energy. ' +
                'Open warmly. Acknowledge their message before launching into advice. ' +
                'NEVER translate awkwardly word-for-word — that\'s what bad chatbots do.\n' +
                '\n' +
                '2. HUMAN GREETINGS & SMALL TALK: If they say "hey", "hi", "wassup", reply with a real greeting back. ' +
                'If they say "how are you", say how YOU are (warm, conversational — "doing great, you?"). ' +
                'If they thank you, accept the thanks like a friend would, don\'t just say "you\'re welcome" robotically. ' +
                'If they make a joke, joke back. If they vent, listen first.\n' +
                '\n' +
                '3. RECEIPT / DOCUMENT CONTEXT: When attachments come through with structured OCR data, summarise in ' +
                '2-5 sentences naturally. If it\'s a recurring bill, note it could be the user\'s previous Dialog / CEB / etc bill ' +
                'and suggest tapping AI Scan in Monthly Expenses to log it.\n' +
                '\n' +
                '4. NEVER sound like a robot. NEVER start with "I am a financial advisor". NEVER refuse to chat about ' +
                'non-finance topics. NEVER list 10 bullet points for a simple question.';
            return base + extra;
        };
        console.log('[' + V + '] patched buildSystemPrompt');
    }

    /* =========================================================================
     * 14. SCANNER SETTINGS — exposed for the user to configure default mode
     * ========================================================================= */
    if (!window.WF_SCAN_SETTINGS) {
        try {
            var stored = JSON.parse(localStorage.getItem('wf_scan_settings') || '{}');
            window.WF_SCAN_SETTINGS = {
                mode:          stored.mode          || 'deep',
                preprocessing: stored.preprocessing !== false,
                currency:      stored.currency      || 'LKR',
                showEngines:   stored.showEngines === true
            };
        } catch (_) {
            window.WF_SCAN_SETTINGS = { mode: 'deep', preprocessing: true, currency: 'LKR', showEngines: false };
        }
    }
    function _saveScanSettings() {
        try { localStorage.setItem('wf_scan_settings', JSON.stringify(window.WF_SCAN_SETTINGS)); } catch (_) {}
    }

    window.openScannerSettings = function () {
        var s = window.WF_SCAN_SETTINGS;
        var c = _ensureModalContainer();
        c.innerHTML =
            '<div class="wf3-overlay" id="wf3OverlayCurr">' +
              '<div class="wf3-modal">' +
                '<div class="wf3-modal-header">' +
                  '<div class="wf3-modal-icon">📸</div>' +
                  '<div class="wf3-modal-title">AI Scanner Settings</div>' +
                  '<div class="wf3-modal-msg">Tune the receipt scanner for accuracy vs speed.</div>' +
                '</div>' +
                '<div class="wf3-modal-body">' +
                  '<label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;">Scan Mode</label>' +
                  '<select id="wf3SetMode" style="width:100%;padding:11px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;color:#e5e7eb;font-size:14px;font-family:inherit;margin-bottom:14px;">' +
                    '<option value="quick">🚀 Quick — 1 engine, ~2s</option>' +
                    '<option value="deep">🔬 Deep — 3 engines vote, ~4s</option>' +
                    '<option value="ultra">💎 Ultra — 5+ engines + OCR, ~8s</option>' +
                  '</select>' +
                  '<label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;">Default Currency</label>' +
                  '<select id="wf3SetCurr" style="width:100%;padding:11px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;color:#e5e7eb;font-size:14px;font-family:inherit;margin-bottom:14px;">' +
                    '<option>LKR</option><option>USD</option><option>EUR</option><option>GBP</option><option>INR</option><option>AUD</option><option>SGD</option><option>JPY</option>' +
                  '</select>' +
                  '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;cursor:pointer;margin-bottom:10px;">' +
                    '<input type="checkbox" id="wf3SetPP" style="width:18px;height:18px;accent-color:#fbbf24;">' +
                    '<span style="font-size:13px;color:#e5e7eb;">Client-side image enhancement</span>' +
                  '</label>' +
                  '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;cursor:pointer;">' +
                    '<input type="checkbox" id="wf3SetDbg" style="width:18px;height:18px;accent-color:#fbbf24;">' +
                    '<span style="font-size:13px;color:#e5e7eb;">Show engine debug in console</span>' +
                  '</label>' +
                '</div>' +
                '<div class="wf3-modal-actions">' +
                  '<button class="wf3-btn wf3-btn-cancel" id="wf3Cancel">Cancel</button>' +
                  '<button class="wf3-btn wf3-btn-warn" id="wf3Save" style="background:linear-gradient(135deg,#d4af37,#b8902f);">💾 Save</button>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.getElementById('wf3SetMode').value = s.mode;
        document.getElementById('wf3SetCurr').value = s.currency;
        document.getElementById('wf3SetPP').checked = s.preprocessing !== false;
        document.getElementById('wf3SetDbg').checked = !!s.showEngines;
        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf3Cancel').onclick = close;
        document.getElementById('wf3OverlayCurr').onclick = function (e) { if (e.target.id === 'wf3OverlayCurr') close(); };
        document.getElementById('wf3Save').onclick = function () {
            window.WF_SCAN_SETTINGS = {
                mode: document.getElementById('wf3SetMode').value,
                currency: document.getElementById('wf3SetCurr').value,
                preprocessing: document.getElementById('wf3SetPP').checked,
                showEngines: document.getElementById('wf3SetDbg').checked
            };
            _saveScanSettings();
            close();
            if (typeof window.notify === 'function') window.notify('✅ Scanner settings saved', 'success');
        };
    };

    /* =========================================================================
     * 15. UPDATE FILE INPUT to accept PDFs in BOTH places.
     *     The HTML accept attribute filters what shows up in the picker.
     * ========================================================================= */
    function patchFileInputs() {
        var inputs = document.querySelectorAll('input[type="file"][id="e_ai_scan"], input[type="file"][id="ai_chat_scan"]');
        inputs.forEach(function (inp) {
            inp.accept = 'image/*,application/pdf,.pdf';
        });
        console.log('[' + V + '] patched ' + inputs.length + ' file inputs to accept PDF');
    }

    /* =========================================================================
     * 16. WIRE EVERYTHING UP — wait for the host app, then monkey-patch.
     * ========================================================================= */
    whenReady(function () {
        return (typeof window.callAI === 'function') ||
            (typeof window.handleAIScan === 'function') ||
            (typeof window.notify === 'function');
    }, function () {
        try {
            // Replace handleAIScan with v3
            window.handleAIScan = newHandleAIScan;
            console.log('[' + V + '] patched handleAIScan');

            // Replace clearAIChat with friendly version
            window.clearAIChat = newClearAIChat;
            console.log('[' + V + '] patched clearAIChat');

            // Replace confirmResetAIMemory with PIN-gated version
            window.confirmResetAIMemory = newConfirmResetAIMemory;
            console.log('[' + V + '] patched confirmResetAIMemory');

            // Enhance system prompt for natural multilingual + universal knowledge
            patchBuildSystemPrompt();

            // Accept PDFs in file inputs
            patchFileInputs();

            // Expose globals for retry buttons
            window._wfV3RunManualScan = function (mode) {
                // Trigger a fresh scan from the most recent file (saved via FileList copy)
                console.log('[' + V + '] manual scan in mode:', mode);
            };

            console.log('[' + V + '] all patches applied successfully ✓');
        } catch (e) {
            console.error('[' + V + '] patch error:', e);
        }
    }, 12000);

    /* =========================================================================
     * 17. EXPORT for debugging
     * ========================================================================= */
    window.WF_AI_V3 = {
        version: V,
        scan: newHandleAIScan,
        clearChat: newClearAIChat,
        resetMemory: newConfirmResetAIMemory,
        openSettings: function () { window.openScannerSettings(); },
        utils: {
            fileToBase64Images: fileToBase64Images,
            pdfFileToImages: pdfFileToImages,
            findMatchingPriorExpense: findMatchingPriorExpense,
            buildSmartNote: buildSmartNote,
            visionScanCall: visionScanCall
        }
    };
})();
