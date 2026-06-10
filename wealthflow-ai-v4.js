/* ============================================================================
 *  WealthFlow AI v4.0 — Frontier Universal Patch
 *  ============================================================================
 *  Drop-in upgrade that supersedes v3. Loaded as a deferred <script> AFTER the
 *  main app code. Coexists with — but takes priority over — v3 if both load.
 *
 *  CRITICAL PDF FIX
 *  ----------------
 *  The v3 PDF flow had three real failure modes that we now solve:
 *    A. PDF.js worker URL on cdnjs is rate-limited from .vercel.app domains —
 *       we now use jsdelivr as primary + cdnjs as fallback.
 *    B. Rendering a page at scale 2.0 produces 2-4 MB JPEG base64; the JSON-
 *       wrapped body exceeds Vercel's 4.5 MB serverless body limit, returning
 *       HTTP 413. We now adaptively scale DOWN until the encoded payload is
 *       under 3.5 MB.
 *    C. On *.github.io the cross-origin call to wealthflow-personal.vercel.app
 *       was failing without a clear error. We now do a preflight HEAD with
 *       short timeout and gracefully fall back to /api/ai (the legacy endpoint)
 *       if vision-scan isn't reachable.
 *
 *  WHAT'S NEW vs v3
 *  ----------------
 *   • Gemini 3.1 Pro Preview — Google's frontier reasoning model (Feb 2026)
 *   • Cerebras Cloud — Llama 3.3 70B at 2,000 tok/sec
 *   • OpenRouter free models — 29 community models via :free suffix
 *   • Mistral Large 2 — la-plateforme.mistral.ai free tier
 *   • Cohere Command R+ — enterprise free tier
 *   • TensorFlow.js GPU preprocessing — auto-levels + unsharp mask before send
 *   • Smart-route layer — picks the best engine per task (speed vs quality)
 *   • Voice-driven scan — say "scan receipt" to launch the camera
 *   • Robust PDF pipeline — adaptive scale, chunked multi-page, retry
 *   • Bill prediction — AI forecasts next month's expenses from history
 *   • Receipt → calendar integration (recurring bills auto-scheduled)
 * ========================================================================== */

(function () {
    'use strict';
    var V = 'WF-AI-v4.0';
    console.log('[' + V + '] booting…');

    /* =========================================================================
     * 0. UTILITIES
     * ========================================================================= */
    function whenReady(test, cb, maxWaitMs) {
        var start = Date.now();
        var iv = setInterval(function () {
            try {
                if (test()) { clearInterval(iv); cb(); }
                else if (Date.now() - start > (maxWaitMs || 8000)) {
                    clearInterval(iv);
                    console.warn('[' + V + '] timeout waiting for host; patching anyway.');
                    cb();
                }
            } catch (_) { }
        }, 80);
    }

    function fmtBytes(n) {
        if (n < 1024) return n + 'B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(0) + 'KB';
        return (n / 1024 / 1024).toFixed(2) + 'MB';
    }

    function approxBase64Bytes(b64) {
        return Math.floor((b64 || '').length * 0.75);
    }

    /* =========================================================================
     * 1. PDF.js LOADER — multi-CDN with fallback (CRITICAL FIX)
     *    cdnjs sometimes rate-limits .vercel.app domains; jsdelivr is more
     *    reliable for production traffic.
     * ========================================================================= */
    var _pdfjsLoading = null;
    function ensurePdfJs() {
        if (window.pdfjsLib && window.pdfjsLib.getDocument) return Promise.resolve(window.pdfjsLib);
        if (_pdfjsLoading) return _pdfjsLoading;

        var sources = [
            {
                lib: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
                worker: 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
            },
            {
                lib: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
                worker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
            },
            {
                lib: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
                worker: 'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js'
            }
        ];

        _pdfjsLoading = new Promise(function (resolve, reject) {
            var idx = 0;
            function tryNext() {
                if (idx >= sources.length) {
                    reject(new Error('All PDF.js CDNs failed'));
                    return;
                }
                var src = sources[idx++];
                console.log('[' + V + '] loading PDF.js from', src.lib);
                var s = document.createElement('script');
                s.src = src.lib;
                s.onload = function () {
                    try {
                        if (window.pdfjsLib && window.pdfjsLib.getDocument) {
                            window.pdfjsLib.GlobalWorkerOptions.workerSrc = src.worker;
                            resolve(window.pdfjsLib);
                        } else {
                            tryNext();
                        }
                    } catch (e) { tryNext(); }
                };
                s.onerror = tryNext;
                document.head.appendChild(s);
            }
            tryNext();
        });
        return _pdfjsLoading;
    }

    /* =========================================================================
     * 2. ADAPTIVE PDF→JPEG RENDERER (CRITICAL FIX)
     *    Renders a PDF page at a scale that keeps the resulting base64 well
     *    under Vercel's 4.5 MB body limit. Starts at scale 2.0 for clarity,
     *    drops to 1.5/1.2/1.0/0.8 if needed. Encodes JPEG with quality 0.85
     *    initially, drops to 0.7/0.55 if still too big.
     *
     *    Hard ceiling we target: 3.0 MB of base64 (≈ 2.25 MB raw) — that's
     *    safely under Vercel's 4.5 MB JSON-body limit.
     * ========================================================================= */
    async function renderPdfPageAdaptive(pdf, pageNum, maxBytes) {
        maxBytes = maxBytes || 3.8 * 1024 * 1024;  // 3.8 MB (Gemini inline limit ~4MB)
        var scales = [2.0, 1.5, 1.2, 1.0, 0.8];
        var qualities = [0.85, 0.75, 0.65, 0.55];
        var page = await pdf.getPage(pageNum);

        for (var si = 0; si < scales.length; si++) {
            var scale = scales[si];
            var viewport = page.getViewport({ scale: scale });
            // Cap absolute dimensions — some PDFs are huge (A3 etc.)
            var maxDim = 2200;
            if (viewport.width > maxDim || viewport.height > maxDim) {
                var newScale = scale * Math.min(maxDim / viewport.width, maxDim / viewport.height);
                viewport = page.getViewport({ scale: newScale });
            }
            var canvas = document.createElement('canvas');
            canvas.width = Math.floor(viewport.width);
            canvas.height = Math.floor(viewport.height);
            var ctx = canvas.getContext('2d', { willReadFrequently: false });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            for (var qi = 0; qi < qualities.length; qi++) {
                var dataUrl = canvas.toDataURL('image/jpeg', qualities[qi]);
                var base64 = dataUrl.split(',')[1];
                var size = approxBase64Bytes(base64);
                if (size <= maxBytes) {
                    console.log('[' + V + '] pdf p' + pageNum + ' rendered ' +
                        canvas.width + 'x' + canvas.height + ' @' + scale + 'x q=' + qualities[qi] +
                        ' → ' + fmtBytes(size));
                    return { base64: base64, width: canvas.width, height: canvas.height, bytes: size };
                }
            }
        }
        // Last resort — return the smallest we could make
        throw new Error('PDF page ' + pageNum + ' too large even at minimum quality');
    }

    /* =========================================================================
     * 3. UNIVERSAL FILE → IMAGE EXTRACTOR with FULL ERROR REPORTING
     * ========================================================================= */
    async function fileToImagesV4(file, opts) {
        opts = opts || {};
        var maxPages = opts.maxPages || 3;
        var maxBytes = opts.maxBytes || 3.8 * 1024 * 1024;

        if (!file) throw new Error('No file provided');
        var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        var isImage = (file.type || '').startsWith('image/') || /\.(jpg|jpeg|png|webp|heic|heif)$/i.test(file.name || '');

        // ---- IMAGE: compress to fit under maxBytes ----
        if (!isPdf) {
            if (!isImage) throw new Error('Unsupported file type: ' + (file.type || file.name));
            var img = await new Promise(function (resolve, reject) {
                var imgEl = new Image();
                var reader = new FileReader();
                reader.onload = function (e) {
                    imgEl.onload = function () { resolve(imgEl); };
                    imgEl.onerror = function () { reject(new Error('Image decode failed')); };
                    imgEl.src = e.target.result;
                };
                reader.onerror = function () { reject(new Error('File read failed')); };
                reader.readAsDataURL(file);
            });

            // Adaptive scale-down — keep MUCH higher resolution & quality for
            // accurate recognition of text, badges, models, fine detail.
            // v7.5.1: the caller can pass opts.maxDim to anchor the ladder
            // to a specific resolution (e.g. Frontier mode wants 3000 px,
            // Quick mode wants 1800 px). We always include smaller
            // fallback rungs so we still fit under maxBytes if the
            // network is constrained.
            var _isMobileV4 = (typeof navigator !== 'undefined' && /iphone|ipad|ipod|android/i.test(navigator.userAgent || '')) || (typeof window !== 'undefined' && window.innerWidth && window.innerWidth < 820);
            var capDim = opts.maxDim || (_isMobileV4 ? 1800 : 2600);
            var dims;
            if (capDim >= 2800) dims = [capDim, 2400, 2000, 1600, 1300, 1000];
            else if (capDim >= 2200) dims = [capDim, 1900, 1600, 1300, 1000];
            else if (capDim >= 1800) dims = [capDim, 1500, 1200, 1000];
            else dims = [capDim, 1300, 1000];
            var quals = [0.95, 0.90, 0.82, 0.72, 0.6];
            for (var di = 0; di < dims.length; di++) {
                var maxDim = dims[di];
                var w = img.naturalWidth, h = img.naturalHeight;
                if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
                else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
                var canvas = document.createElement('canvas');
                canvas.width = w; canvas.height = h;
                var ctx = canvas.getContext('2d');
                ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
                ctx.imageSmoothingEnabled = true;
                ctx.imageSmoothingQuality = 'high';
                ctx.drawImage(img, 0, 0, w, h);

                // Optional TF.js enhancement (sharper text)
                if (opts.enhance !== false && typeof tf !== 'undefined' &&
                    typeof window._enhanceForOCR === 'function' && w * h < 4000000) {
                    try { window._enhanceForOCR(canvas); } catch (_) { }
                }

                for (var qi = 0; qi < quals.length; qi++) {
                    var dataUrl = canvas.toDataURL('image/jpeg', quals[qi]);
                    var base64 = dataUrl.split(',')[1];
                    var size = approxBase64Bytes(base64);
                    if (size <= maxBytes) {
                        return { images: [base64], isPdf: false, pageCount: 1, dimensions: [{ w: w, h: h, bytes: size }] };
                    }
                }
            }
            throw new Error('Image too large to send (max ' + fmtBytes(maxBytes) + ')');
        }

        // ---- PDF: render adaptively ----
        await ensurePdfJs();
        var buf = await file.arrayBuffer();
        var u8 = new Uint8Array(buf);  // keep an undetached copy for password retries
        var pdf;
        try {
            pdf = await window.pdfjsLib.getDocument({ data: u8.slice() }).promise;
        } catch (e) {
            // v7.7.0 — locked PDF? Auto-try the user's Security Vault keys
            // (Sri Lankan banks commonly lock statements with NIC or DOB).
            var isLocked = e && (e.name === 'PasswordException' || /password/i.test(e.message || ''));
            if (isLocked && typeof window.wfVaultPdfPasswords === 'function') {
                var cands = [];
                try { cands = await window.wfVaultPdfPasswords(); } catch (_) {}
                var opened = null;
                for (var ci = 0; ci < cands.length; ci++) {
                    try {
                        opened = await window.pdfjsLib.getDocument({ data: u8.slice(), password: cands[ci] }).promise;
                        if (opened) {
                            if (typeof window.notify === 'function') window.notify('🔓 Locked PDF opened automatically with your Vault keys', 'success');
                            break;
                        }
                    } catch (pe) { /* wrong password — try the next candidate */ }
                }
                if (opened) { pdf = opened; }
                else if (cands.length) {
                    throw new Error('This PDF is password-protected and none of your saved Vault keys worked. Check your NIC / DOB in Settings → Security Vault, or remove the password and re-upload.');
                } else {
                    throw new Error('This PDF is password-protected. Add your NIC / DOB to Settings → Security Vault and I will unlock bank statements automatically — or remove the password and re-upload.');
                }
            } else {
                throw new Error('PDF could not be opened: ' + e.message + '. Is it password-protected?');
            }
        }
        var pages = Math.min(pdf.numPages, maxPages);
        if (pages === 0) throw new Error('PDF has no pages');
        var images = [];
        var dims = [];
        for (var i = 1; i <= pages; i++) {
            try {
                var rendered = await renderPdfPageAdaptive(pdf, i, maxBytes);
                images.push(rendered.base64);
                dims.push({ w: rendered.width, h: rendered.height, bytes: rendered.bytes });
            } catch (e) {
                console.warn('[' + V + '] PDF page ' + i + ' render failed:', e.message);
                if (images.length === 0 && i === 1) throw e; // first page must succeed
                break;
            }
        }
        if (images.length === 0) throw new Error('No PDF pages could be rendered');
        return { images: images, isPdf: true, pageCount: images.length, dimensions: dims };
    }

    /* =========================================================================
     * 4. ENDPOINT PREFLIGHT — checks whether /api/vision-scan responds before
     *    we waste 50 seconds on it. Caches the answer for the session.
     * ========================================================================= */
    var _endpointCache = {};
    function _apiBase() {
        var isLocalOrGitHub = window.location.hostname.includes('github.io') || window.location.hostname === 'localhost';
        return isLocalOrGitHub ? 'https://wealthflow-personal.vercel.app/api' : '/api';
    }

    async function isEndpointAvailable(path) {
        if (_endpointCache[path] !== undefined) return _endpointCache[path];
        try {
            var controller = new AbortController();
            setTimeout(function () { controller.abort(); }, 3500);
            // OPTIONS preflight — every Vercel function we ship handles OPTIONS
            var r = await fetch(_apiBase() + path, { method: 'OPTIONS', signal: controller.signal });
            _endpointCache[path] = r.ok || r.status === 204;
        } catch (_) {
            _endpointCache[path] = false;
        }
        return _endpointCache[path];
    }

    /* =========================================================================
     * 5. MULTI-ENGINE VISION SCAN — talks to /api/vision-scan with full
     *    error reporting and graceful fallback to /api/ai.
     * ========================================================================= */
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
            var ct = r.headers.get('content-type') || '';
            var data;
            if (ct.indexOf('application/json') > -1) {
                data = await r.json();
            } else {
                var txt = await r.text();
                throw new Error('non-JSON response (status ' + r.status + '): ' + txt.substring(0, 200));
            }
            if (!r.ok) {
                var msg = data.error || ('vision-scan ' + r.status);
                if (r.status === 413) msg = 'Image too large for server (' + r.status + ')';
                if (r.status === 504) msg = 'Server timed out reading the image';
                var err = new Error(msg);
                err.status = r.status;
                err.serverDetails = data;
                throw err;
            }
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    /* =========================================================================
     * 6. LEGACY /api/ai FALLBACK — when vision-scan is unreachable
     * ========================================================================= */
    async function legacyAICall(prompt, image, timeoutMs) {
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeoutMs || 40000);
        try {
            var body = { prompt: prompt };
            if (image) body.image = image;
            body.temperature = 0.05;
            body.maxTokens = 2048;
            var r = await fetch(_apiBase() + '/ai', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: controller.signal
            });
            var data = await r.json();
            if (!r.ok || !data.reply) throw new Error(data.error || 'ai failed: ' + r.status);
            return data;
        } finally {
            clearTimeout(timer);
        }
    }

    /* =========================================================================
     * 7. RECEIPT PROMPT BUILDER (used for fallback path)
     * ========================================================================= */
    function buildReceiptPrompt(hints) {
        var today = (hints && hints.today) || new Date().toISOString().split('T')[0];
        var currency = (hints && hints.currency) || 'LKR';
        return 'You are a world-class receipt OCR. Read this image with surgical precision and return ONLY a single valid JSON object — no markdown, no commentary:\n\n' +
            '{"vendor":"","amount":0,"date":"YYYY-MM-DD","category":"","items":[],"currency":"' + currency + '","tax":null,"payment_method":null,"receipt_number":null,"time":null,"raw_text":""}\n\n' +
            'Rules:\n' +
            '- amount = the GRAND TOTAL (a plain number, no commas/currency)\n' +
            '- date = YYYY-MM-DD; if missing use "' + today + '"\n' +
            '- vendor = the merchant name at the top\n' +
            '- category = one of: "Food & Groceries", "Transport", "Utilities", "Medical", "Education", "Entertainment", "Clothing", "Other"\n' +
            '- items = up to 8 prominent items as plain strings\n' +
            '- raw_text = the full text you read, line by line, separated by \\n';
    }

    /* =========================================================================
     * 7b. CC STATEMENT PROMPT (v7.5.0 — multi-transaction extraction)
     *   Returns one JSON with a transactions[] array. The AI is told upfront
     *   that this is a CC statement with multiple rows so it doesn't squash
     *   everything into a single descriptor.
     * ========================================================================= */
    function buildCCStatementPrompt(bank) {
        var today = new Date().toISOString().split('T')[0];
        var thisYear = today.substring(0, 4);
        var bankLine = bank ? ('This statement is from: ' + bank + '\n') : '';
        return 'You are an expert credit-card-statement parser specialised in Sri Lankan banks ' +
            '(BOC, Commercial Bank, HNB, Sampath, NTB, AMEX, NDB, Standard Chartered, DFCC, Seylan, ' +
            'Peoples Bank, Pan Asia, Union Bank).\n' + bankLine +
            '\nRead the image and extract EVERY transaction line. Return ONLY a single JSON object ' +
            'with this exact schema (no markdown, no comments, no prose):\n\n' +
            '{"statement_period":"YYYY-MM","transactions":[' +
            '{"date":"YYYY-MM-DD","description":"merchant or vendor","amount":1500.50,' +
            '"type":"purchase","merchant_category":"","notes":""}' +
            ']}\n\n' +
            'Rules:\n' +
            '- Include the FULL ORIGINAL amount printed. NEVER round or truncate.\n' +
            '- "type" must be EXACTLY one of: purchase, cash_advance, service_fee, fuel\n' +
            '  • cash_advance = ATM withdrawals, cash advance entries, "MB"/"DE" cash w/d codes\n' +
            '  • fuel = petrol/diesel stations (Ceypetco, IOC, Lanka IOC, Cargills Petroleum, ' +
            '    Shell, fuel station names ending in "Filling Station"/"Fuel Station"/"Pvt Ltd")\n' +
            '  • service_fee = cash-advance fees, interest charges, finance charges, late fees, ' +
            '    fuel surcharges, fees that pair with another row\n' +
            '  • purchase = everything else (groceries, restaurants, online, retail)\n' +
            '- "date" in YYYY-MM-DD; if only day+month is printed, use ' + thisYear + ' as the year.\n' +
            '- Skip the closing balance row, opening balance row, and payment-received rows.\n' +
            '- If a row is clearly a credit/refund, prefix description with "[CREDIT] " and keep ' +
            '  amount positive.\n' +
            '- If you cannot read a column clearly, still include the row with a best-effort guess. ' +
            '  NEVER omit a transaction.\n\n' +
            'CRITICAL: Output ONLY the JSON object. No markdown fences, no explanations.';
    }

    /* =========================================================================
     * 7c. CCOT ROW CLASSIFIER (v7.5.0)
     *   Final safety net — if the AI guesses wrong, our regex catches it.
     *   Order matters: cash_advance and fuel are checked before service_fee
     *   because a row reading "Cash advance fee" should classify as
     *   service_fee, not cash_advance — handled by the explicit FEE check.
     * ========================================================================= */
    function classifyCCOTRow(rawText, aiHint) {
        var hay = String(rawText || '').toLowerCase();
        // Service fees first — they often CONTAIN the word "advance"
        if (/\b(cash[\s\-]*advance[\s\-]*fee|service[\s\-]*fee|finance[\s\-]*charge|interest|late[\s\-]*fee|fuel[\s\-]*surcharge|\(de\)|\(fe\))\b/.test(hay))
            return 'service_fee';
        // Cash advance proper
        if (/\b(cash[\s\-]*advance|\batm\b|withdrawal|cash[\s\-]*w\/?d|\bmb\b|cash[\s\-]*advance[\s\-]*from)\b/.test(hay))
            return 'cash_advance';
        // Fuel stations (Sri Lanka)
        if (/\b(ceypetco|cargills[\s\-]*petroleum|lanka[\s\-]*ioc|\bioc\b|shell|filling[\s\-]*station|fuel[\s\-]*station|petrol|diesel|fuel)\b/.test(hay))
            return 'fuel';
        // Honour AI hint as last resort if it's one of our valid types
        if (aiHint && /^(purchase|cash_advance|service_fee|fuel)$/.test(aiHint)) return aiHint;
        return 'purchase';
    }

    /* =========================================================================
     * 7d. CCOT DATE NORMALISER (v7.5.0)
     *   Handles DD/MM/YYYY, DD-MM-YYYY, DD MMM, "May 22", etc.
     * ========================================================================= */
    function normaliseCCOTDate(s) {
        if (!s) return new Date().toISOString().split('T')[0];
        var str = String(s).trim();
        // Already ISO?
        if (/^\d{4}-\d{2}-\d{2}/.test(str)) return str.substring(0, 10);
        // DD/MM/YYYY or DD-MM-YYYY
        var m = str.match(/^(\d{1,2})[\/\-\.\s](\d{1,2})(?:[\/\-\.\s](\d{2,4}))?$/);
        if (m) {
            var d = parseInt(m[1], 10);
            var mo = parseInt(m[2], 10);
            var yr = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();
            if (yr < 100) yr += 2000;
            return yr + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        }
        // DD MMM YYYY  or  MMM DD YYYY
        var months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
        var mm = str.toLowerCase().match(/^(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*(?:\s+(\d{2,4}))?$/);
        if (mm) {
            var d2 = parseInt(mm[1], 10);
            var mo2 = months[mm[2]];
            var yr2 = mm[3] ? parseInt(mm[3], 10) : new Date().getFullYear();
            if (yr2 < 100) yr2 += 2000;
            return yr2 + '-' + String(mo2).padStart(2, '0') + '-' + String(d2).padStart(2, '0');
        }
        // Last resort — Date.parse
        try {
            var d3 = new Date(str);
            if (!isNaN(d3)) return d3.toISOString().split('T')[0];
        } catch (_) {}
        return new Date().toISOString().split('T')[0];
    }


    /* =========================================================================
     * 8. JSON EXTRACTION (mirror of server's robustness)
     * ========================================================================= */
    function extractJSON(text) {
        if (!text || typeof text !== 'string') return null;
        var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(cleaned); } catch (_) { }
        var m = cleaned.match(/\{[\s\S]*\}/);
        if (!m) return null;
        var candidate = m[0]
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/[\u201C\u201D]/g, '"')
            .replace(/[\u2018\u2019]/g, "'");
        try { return JSON.parse(candidate); } catch (_) { return null; }
    }

    function normaliseAmount(v) {
        if (v === null || v === undefined) return null;
        if (typeof v === 'number') return isFinite(v) ? v : null;
        if (typeof v !== 'string') return null;
        var s = v.replace(/(?:LKR|USD|EUR|GBP|INR|Rs\.?|රු|₹|\$|€|£|¥)/gi, '')
            .replace(/\/=|\/-/g, '').replace(/\s+/g, '').replace(/[^0-9.,\-]/g, '');
        if (!s) return null;
        var lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',');
        if (lastDot > -1 && lastCom > -1) {
            if (lastDot > lastCom) s = s.replace(/,/g, '');
            else s = s.replace(/\./g, '').replace(',', '.');
        } else if (lastCom > -1) {
            var after = s.length - lastCom - 1;
            if (after === 1 || after === 2) s = s.replace(',', '.');
            else s = s.replace(/,/g, '');
        }
        var n = parseFloat(s);
        return isFinite(n) ? n : null;
    }

    /* =========================================================================
     * 9. RECURRING-BILL FINGERPRINTING (vendor → prior expense match)
     * ========================================================================= */
    function _vendorFingerprint(s) {
        if (!s) return '';
        return String(s).toLowerCase()
            .replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim()
            .split(' ').filter(function (w) { return w.length > 2; })
            .slice(0, 3).join(' ');
    }

    function findMatchingPriorExpense(vendor) {
        try {
            if (typeof DB === 'undefined' || typeof DB.get !== 'function') return null;
            var fp = _vendorFingerprint(vendor);
            if (!fp || fp.length < 3) return null;
            var all = DB.get('expenses') || [];
            all = all.slice().sort(function (a, b) {
                return String(b.month || '').localeCompare(String(a.month || ''));
            });
            for (var i = 0; i < all.length; i++) {
                var ex = all[i];
                var theirFp = _vendorFingerprint(ex.desc);
                if (!theirFp) continue;
                if (theirFp.indexOf(fp) > -1 || fp.indexOf(theirFp) > -1) return ex;
                var fpTokens = fp.split(' ');
                var theirTokens = theirFp.split(' ');
                var shared = fpTokens.filter(function (t) { return theirTokens.indexOf(t) > -1; });
                if (shared.length >= 1 && shared[0].length >= 4) return ex;
            }
        } catch (_) { }
        return null;
    }

    function buildSmartNote(result, isPdf, pageCount) {
        if (!result) return '';
        var parts = [];
        if (result.items && result.items.length) parts.push('📦 ' + result.items.slice(0, 5).join(', '));
        if (result.payment_method) {
            var pm = String(result.payment_method).toLowerCase();
            var label = pm === 'card' ? '💳 Card' : pm === 'cash' ? '💵 Cash' :
                pm === 'digital' ? '📲 Digital' : null;
            if (label) parts.push(label);
        }
        if (result.receipt_number) parts.push('🧾 ' + result.receipt_number);
        if (result.tax && typeof result.tax === 'number') parts.push('🧮 Tax LKR ' + result.tax.toLocaleString());
        if (isPdf) parts.push('📄 PDF · ' + pageCount + 'pg');
        return parts.join(' · ');
    }

    /* =========================================================================
     * 10. POPULATE EXPENSE FORM (smart-merge with prior recurring entry)
     * ========================================================================= */
    function populateExpenseForm(result, opts) {
        opts = opts || {};
        var $ = function (id) { return document.getElementById(id); };
        if (!result) return false;
        var filled = false;
        var prior = result._priorMatch || null;

        if ($('e_desc')) {
            if (prior && prior.desc) { $('e_desc').value = prior.desc; filled = true; }
            else if (result.vendor) { $('e_desc').value = result.vendor; filled = true; }
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
        if (prior && $('e_recurring')) $('e_recurring').value = prior.recurring || '1';
        if ($('e_notes')) {
            var existing = $('e_notes').value || '';
            var cleaned = existing.split('|').map(function (p) {
                p = p.trim();
                if (!p) return '';
                if (/^(📦|🔤|💳|💵|📲|🧾|🧮|📄|🤖 Recurring)/.test(p)) return '';
                return p;
            }).filter(Boolean).join(' | ');
            var note = buildSmartNote(result, opts.isPdf, opts.pageCount);
            if (prior) note = (note ? note + ' · ' : '') + '🤖 Recurring (same as ' + (prior.month || 'previous') + ')';
            $('e_notes').value = cleaned ? (cleaned + ' | ' + note) : note;
        }
        return filled;
    }

    /* =========================================================================
     * 10a. CCOT FORM: map vision-scan results into the CC One-Time modal.
     *   - Vendor / amount / date come straight from result.
     *   - The user-confirmed BANK is passed via opts.bank (from the bank
     *     picker) and slotted into #ot_bank.
     *   - If the AI tagged the line as "cash advance" / "atm" / "withdrawal",
     *     we set Type=Cash Advance and let the live preview compute the
     *     per-bank service fee automatically.
     *   - Fuel station hits (ceypetco / IOC / Lanka IOC / Cargills Petroleum)
     *     get Type=Fuel so the per-bank fuel surcharge applies.
     * ========================================================================= */
    function populateCCOTForm(result, opts) {
        opts = opts || {};
        var $ = function (id) { return document.getElementById(id); };
        if (!result) return false;
        var filled = false;

        // Description (vendor)
        if ($('ot_desc') && result.vendor) {
            $('ot_desc').value = result.vendor;
            filled = true;
        }

        // Amount
        if ($('ot_amount') && typeof result.amount === 'number') {
            var fmt = (typeof window.fmtN === 'function') ? window.fmtN(result.amount) : result.amount.toFixed(2);
            $('ot_amount').value = fmt;
            filled = true;
        }

        // Bank — prefer the user-confirmed bank from the picker;
        // fall back to AI-extracted bank if the picker was skipped.
        if ($('ot_bank')) {
            var bankSel = $('ot_bank');
            var targetBank = opts.bank || result.bank || '';
            if (targetBank) {
                var matched = false;
                var target = String(targetBank).toLowerCase();
                for (var i = 0; i < bankSel.options.length; i++) {
                    var optText = bankSel.options[i].text.toLowerCase();
                    var optVal = bankSel.options[i].value.toLowerCase();
                    if (optText === target || optVal === target) {
                        bankSel.value = bankSel.options[i].value; matched = true; break;
                    }
                }
                if (!matched) {
                    for (var j = 0; j < bankSel.options.length; j++) {
                        var ot = (bankSel.options[j].text + ' ' + bankSel.options[j].value).toLowerCase();
                        // Match partials: "commercial" → "Commercial Bank"
                        var firstWord = target.split(/[ &()]/)[0];
                        if (firstWord && ot.indexOf(firstWord) > -1) {
                            bankSel.value = bankSel.options[j].value; matched = true; break;
                        }
                    }
                }
                if (matched) filled = true;
            }
        }

        // Type — auto-classify based on vendor / category / raw text
        if ($('ot_type')) {
            var hay = (String(result.vendor || '') + ' ' + String(result.category || '') + ' ' + String(result.rawText || '') + ' ' + String(result.description || '')).toLowerCase();
            var type = 'purchase';
            if (/\b(cash\s*advance|atm|withdrawal|cash\s*w\/?d)\b/.test(hay)) type = 'cash_advance';
            else if (/\b(ceypetco|cargills\s*petroleum|lanka\s*ioc|\bioc\b|filling\s*station|fuel|petrol|diesel)\b/.test(hay)) type = 'fuel';
            $('ot_type').value = type;
            filled = true;
        }

        // Date — Purchase Date
        if ($('ot_date') && result.date && /^\d{4}-\d{2}-\d{2}/.test(result.date)) {
            $('ot_date').value = result.date.substring(0, 10);
            filled = true;
        }

        // Notes — include the smart provenance string just like expense
        if ($('ot_notes')) {
            var existing = $('ot_notes').value || '';
            var note = (typeof buildSmartNote === 'function')
                ? buildSmartNote(result, opts.isPdf, opts.pageCount)
                : ('🤖 AI-scanned · ' + (opts.isPdf ? 'PDF' : 'image'));
            $('ot_notes').value = existing ? (existing + ' | ' + note) : note;
        }

        // Fire the live preview so the user immediately sees the
        // auto-computed cash-advance / fuel service fee.
        if (typeof window._recalcCashAdvancePreview === 'function') {
            try { window._recalcCashAdvancePreview(); } catch (_) {}
        }

        return filled;
    }

    /* =========================================================================
     * 10b. SUBSCRIPTION FORM: map vision-scan results into the Sub modal fields.
     *      Expense categories → Subscription categories mapping:
     *        Streaming services (Netflix/Spotify/etc) → Streaming
     *        Telecom (Dialog/SLT/Mobitel) → Telecom
     *        Utilities (CEB/water/gas) → Utilities
     *        Insurance → Insurance
     *        Gym/fitness → Gym/Fitness
     *        Software/SaaS → Software
     *        anything else → Other
     * ========================================================================= */
    function mapToSubCategory(expenseCat, vendor, rawText) {
        var hay = (String(expenseCat || '') + ' ' + String(vendor || '') + ' ' + String(rawText || '')).toLowerCase();
        if (/\b(netflix|spotify|disney|hbo|prime video|youtube premium|apple tv|hulu|amazon prime|crunchyroll|deezer|pandora)\b/.test(hay)) return 'Streaming';
        if (/\b(dialog|slt|mobitel|hutch|airtel|lanka bell|broadband|fibre|internet|telecom|mobile|phone bill)\b/.test(hay)) return 'Telecom';
        if (/\b(ceb|leco|electricity|nwsdb|water|gas|litro|laughs gas|sewer|utility|utilities|water board)\b/.test(hay)) return 'Utilities';
        if (/\b(insurance|aia|allianz|union assurance|ceylinco|janashakthi|takaful|premium|policy)\b/.test(hay)) return 'Insurance';
        if (/\b(gym|fitness|yoga|crossfit|membership|spa|swim|club)\b/.test(hay)) return 'Gym/Fitness';
        if (/\b(software|saas|adobe|microsoft|office 365|google one|google workspace|github|aws|vps|hosting|domain|cloud|subscription)\b/.test(hay)) return 'Software';
        if (/\b(leasing|lease|fleet|installment|hire purchase)\b/.test(hay)) return 'Leasing';
        return 'Other';
    }

    function populateSubscriptionForm(result, opts) {
        opts = opts || {};
        var $ = function (id) { return document.getElementById(id); };
        if (!result) return false;
        var filled = false;
        var prior = result._priorMatch || null;

        // Try to match an existing subscription by vendor → if found, mark as update
        var matchedSub = null;
        try {
            if (typeof window.DB !== 'undefined' && typeof window.DB.get === 'function' && result.vendor) {
                var subs = window.DB.get('subscriptions') || [];
                var fp = _vendorFingerprint(result.vendor);
                if (fp && fp.length >= 3) {
                    for (var i = 0; i < subs.length; i++) {
                        var sFp = _vendorFingerprint(subs[i].name);
                        if (sFp && (sFp.indexOf(fp) > -1 || fp.indexOf(sFp) > -1)) {
                            matchedSub = subs[i]; break;
                        }
                    }
                }
            }
        } catch (_) {}

        if ($('sub_name') && result.vendor) {
            $('sub_name').value = matchedSub ? matchedSub.name : result.vendor;
            filled = true;
        }
        if ($('sub_amount') && typeof result.amount === 'number') {
            var fmt = (typeof window.fmtN === 'function') ? window.fmtN(result.amount) : result.amount.toFixed(2);
            $('sub_amount').value = fmt;
            filled = true;
        }
        // sub_day = day-of-month from the date OR from matched subscription
        if ($('sub_day')) {
            var day = null;
            if (result.date && /^\d{4}-\d{2}-(\d{1,2})/.test(result.date)) {
                day = parseInt(result.date.substring(8, 10), 10);
            }
            if (matchedSub && matchedSub.day) day = parseInt(matchedSub.day, 10);
            if (day && day >= 1 && day <= 31) { $('sub_day').value = day; filled = true; }
        }
        // Category map
        if ($('sub_cat')) {
            var subCat = mapToSubCategory(result.category, result.vendor, result.raw_text);
            var sel = $('sub_cat');
            for (var j = 0; j < sel.options.length; j++) {
                if (sel.options[j].text.toLowerCase() === subCat.toLowerCase()) {
                    sel.value = sel.options[j].value; filled = true; break;
                }
            }
        }
        // Billing cycle inference from text
        if ($('sub_cycle') && result.raw_text) {
            var rt = result.raw_text.toLowerCase();
            if (/\b(annual|yearly|per year|12 month)\b/.test(rt)) $('sub_cycle').value = 'yearly';
            else if (/\b(quarter|3 month|every 3 months)\b/.test(rt)) $('sub_cycle').value = 'quarterly';
            else $('sub_cycle').value = 'monthly';
        }
        if ($('sub_notes')) {
            var note = buildSmartNote(result, opts.isPdf, opts.pageCount);
            if (matchedSub) note = (note ? note + ' · ' : '') + '🔁 Updates existing: ' + matchedSub.name;
            $('sub_notes').value = note;
        }
        result._matchedSub = matchedSub;
        return filled;
    }

    /* =========================================================================
     * 11. THE V4 handleAIScan — replaces v3 (and the original v6.4 version).
     *     This is the entire pipeline:
     *       Step A: Read file → adaptive image extraction (with PDF support)
     *       Step B: Check endpoint availability
     *       Step C: Multi-engine vision (Deep)
     *       Step D: Escalate to Ultra if low confidence
     *       Step E: PDF page-2 retry if page-1 yielded nothing
     *       Step F: Legacy /api/ai fallback
     *       Step G: Tesseract.js final fallback
     * ========================================================================= */
    async function handleAIScanV4(e, type) {
        var file = e.target && e.target.files && e.target.files[0];
        if (!file) return;
        var inputEl = e.target;
        var startTime = Date.now();
        var sizeMB = (file.size / 1024 / 1024).toFixed(2);
        var isExpense = (type === 'expense');
        var isSubscription = (type === 'subscription');
        var isCCOT = (type === 'ccot');
        var isAiChat = (type === 'ai_chat');
        var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        var showsOverlay = isExpense || isSubscription || isCCOT;

        if (typeof window.triggerHaptic === 'function') window.triggerHaptic('medium');

        // CCOT-specific: ask which bank issued the statement BEFORE we kick
        // off the heavy engine cascade. This gives us the right Sri-Lankan
        // service-fee schedule and helps the AI prompt focus the parse.
        var ccotBank = null;
        if (isCCOT) {
            try {
                if (typeof window._ccotPickBankAsync === 'function') {
                    ccotBank = await window._ccotPickBankAsync();
                    if (!ccotBank) { inputEl.value = ''; return; }
                }
            } catch (e0) {
                console.warn('[' + V + '] bank picker failed:', e0);
            }
        }

        // ── HTML e-STATEMENT FAST PATH (v7.8.0) ──────────────────────────────
        // Banks like Nations Trust send statements as an encrypted HTML file that
        // unlocks with the date of birth (DDMMYYYY). Open it DIRECTLY: prompt for
        // the DOB, decrypt in-app, and import the rows — no "HTML Viewer Q" app.
        var _isHtml = file && (/text\/html/i.test(file.type || '') || /\.html?$/i.test(file.name || ''));
        if (isCCOT && _isHtml && window.WFHtmlStatement && typeof window._showCCReviewModal === 'function') {
            try {
                if (showsOverlay && typeof window._showScanOverlay === 'function') window._showScanOverlay('🔓 Opening e-statement…', 'Unlocking and reading your statement', 20);
                var _hres = await window.WFHtmlStatement.getStatementText(file);
                if (_hres && _hres.cancelled) { if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay(); inputEl.value = ''; return; }
                var _htx = (_hres && _hres.transactions) || [];
                if (!_htx.length && _hres && _hres.text && window.WFStatementParser && window.WFStatementParser.hasTextLayer(_hres.text)) {
                    _htx = (window.WFStatementParser.parseStatementText(_hres.text) || []);
                }
                if (_htx.length) {
                    var _parsedH = {
                        transactions: _htx.map(function (r) {
                            var d = String(r.date || ''); var m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/); if (m) d = m[3] + '-' + m[2] + '-' + m[1];
                            return { date: d, description: r.narration, type: /cash advance|atm|cash withdraw/i.test(r.narration) ? 'cash_advance' : 'purchase', amount: r.amount, direction: r.direction };
                        }),
                        card_last4: '', currency: 'LKR', statement_period: ''
                    };
                    if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                    if (typeof window.notify === 'function') window.notify('✅ Imported ' + _htx.length + ' transactions from your e-statement.', 'success');
                    window._showCCReviewModal(_parsedH, ccotBank || 'Bank Statement');
                    inputEl.value = '';
                    return;
                }
                if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                if (typeof window.notify === 'function') window.notify((_hres && _hres.notStatement) ? "That HTML file doesn't look like a bank statement." : "Couldn't read transactions from that e-statement.", 'warn');
                inputEl.value = '';
                return; // never fall through to image/PDF processing for an HTML file
            } catch (_eH) {
                console.warn('[' + V + '] HTML e-statement failed:', _eH && _eH.message);
                if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                if (typeof window.notify === 'function') window.notify('Could not open that e-statement file.', 'warn');
                inputEl.value = '';
                return;
            }
        }

        // ── TEXT-PDF FAST PATH (v7.6.0) ──────────────────────────────────────
        // For statement/CC PDFs that have a real text layer, read the text
        // DIRECTLY (far more accurate than rendering to an image + AI OCR) and
        // show every row in the review modal. This needs NO backend, so it works
        // even when /api/vision-scan and /api/ai are unreachable — which is the
        // 405 the user was hitting. Prompts for a password ONLY if the PDF is
        // encrypted. Falls through to the vision cascade for scanned-image PDFs
        // or on any failure.
        if (isCCOT && isPdf && window.WFPdfUnlock && window.WFStatementParser && typeof window._showCCReviewModal === 'function') {
            try {
                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('📄 Reading statement text…', 'Extracting every line directly from the PDF', 20);
                var _res = await window.WFPdfUnlock.getStatementText(file);
                if (_res && _res.cancelled) {
                    if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                    inputEl.value = '';
                    return;
                }
                if (_res && _res.text && window.WFStatementParser.hasTextLayer(_res.text)) {
                    var _rows = window.WFStatementParser.parseStatementText(_res.text);
                    if (_rows && _rows.length) {
                        var _toISO = function (d) { var m = String(d).match(/^(\d{2})\/(\d{2})\/(\d{4})$/); return m ? (m[3] + '-' + m[2] + '-' + m[1]) : (d || ''); };
                        var _cardTok = (_res.text.match(/\d{6}[xX*]+\d{4}/) || [''])[0];
                        var _parsed = {
                            transactions: _rows.map(function (r) {
                                return {
                                    date: _toISO(r.date),
                                    description: r.narration,
                                    type: /cash advance|atm|cash withdraw/i.test(r.narration) ? 'cash_advance' : 'purchase',
                                    amount: r.amount,
                                    direction: r.direction,
                                    _balanceVerified: r.valid
                                };
                            }),
                            card_last4: (_cardTok.match(/\d{4}$/) || [''])[0],
                            currency: 'LKR',
                            statement_period: (_res.text.match(/Statement Period[:\s]*([\d/]+\s*-\s*[\d/]+)/i) || [])[1] || ''
                        };
                        if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                        if (typeof window.notify === 'function') window.notify('✅ Read ' + _rows.length + ' transactions directly from the PDF — high accuracy.', 'success');
                        window._showCCReviewModal(_parsed, ccotBank || 'Bank Statement');
                        inputEl.value = '';
                        return;
                    }
                }
                console.log('[' + V + '] PDF has no text layer → vision cascade');
            } catch (_eTxt) {
                console.warn('[' + V + '] text-PDF fast path failed, using vision:', _eTxt && _eTxt.message);
                // fall through to the vision cascade below
            }
        }

        try {
            // ---- STEP A: file extraction ----
            if (showsOverlay && typeof window._showScanOverlay === 'function')
                window._showScanOverlay(isPdf ? '📄 Reading PDF…' : '📸 Reading Image…',
                    'Optimising ' + sizeMB + 'MB ' + (isPdf ? 'PDF' : 'photo'), 8);
            else if (typeof window.notify === 'function')
                window.notify(isPdf ? '📄 Processing PDF…' : '📸 Reading image…', 'info');

            // ── v7.5.1 — honour the user's Scanner Settings (TF.js +
            //   scan mode) when extracting the image. Previously every
            //   scan ran TF.js enhancement and capped at the same
            //   resolution regardless of mode, which meant:
            //     - the "TF.js Image Enhancement" toggle in Settings
            //       had no effect at all
            //     - Frontier mode was no sharper than Quick mode for
            //       AI vision purposes
            //   Now the per-mode dim cap matches what the host UI
            //   advertises (Quick 1800 → Deep 2200 → Ultra 2600 →
            //   Frontier 3000), and `enhance` is gated by the user's
            //   TF.js toggle. CC statements are denser than receipts
            //   so we get an extra 200 px for them.
            var _scanModeNow = (window.WF_SCAN_SETTINGS && window.WF_SCAN_SETTINGS.mode) || 'deep';
            var _tfOn = (window.WF_SCAN_SETTINGS && window.WF_SCAN_SETTINGS.preprocessing !== false);
            var _modeMaxDim = { quick: 1800, deep: 2200, ultra: 2600, frontier: 3000 }[_scanModeNow] || 2200;
            if (isCCOT) _modeMaxDim = Math.min(3200, _modeMaxDim + 200); // CC statements have small text
            var _modeMaxBytes = { quick: 2.2, deep: 3, ultra: 3.6, frontier: 3.8 }[_scanModeNow] || 3;

            var imgBundle;
            try {
                imgBundle = await fileToImagesV4(file, {
                    maxPages: isCCOT ? 5 : 3,
                    maxBytes: _modeMaxBytes * 1024 * 1024,
                    maxDim: _modeMaxDim,
                    enhance: _tfOn
                });
            } catch (ee) {
                throw new Error((isPdf ? 'PDF' : 'Image') + ' could not be read: ' + ee.message);
            }
            var firstImage = imgBundle.images[0];
            var pageCount = imgBundle.pageCount;

            console.log('[' + V + '] extracted', pageCount, 'page(s) from',
                file.name || 'file', '→', imgBundle.dimensions,
                '· mode=' + _scanModeNow, '· tfEnhance=' + _tfOn);

            // ---- AI CHAT: route to chat handler ----
            if (isAiChat) {
                await handleAIChatAttachment(file, imgBundle);
                inputEl.value = '';
                return;
            }

            // ---- STEP B: endpoint check ----
            if (showsOverlay && typeof window._showScanOverlay === 'function')
                window._showScanOverlay('🔌 Connecting…', 'Checking AI services', 18);
            var hasVisionScan = await isEndpointAvailable('/vision-scan');
            console.log('[' + V + '] vision-scan available:', hasVisionScan);

            // ── STEP B.5 (v7.5.0) — DEDICATED CCOT MULTI-TRANSACTION PATH ──
            // CC statements typically list MANY rows (cash advances, fuel
            // surcharges, purchases, fees). The vision-scan endpoint returns
            // a single-row receipt result, which forced everything into one
            // entry. That's why the user's screenshot showed one row with
            // "Cash advance from MB, Fuel Surcharge, Caravan Fresh Kottawa,
            // Local Cash Advance Fee (DE), Morawaka Fuel Station Pvt"
            // concatenated into the description.
            //
            // The right design: when isCCOT, skip the receipt-style cascade
            // and call /api/ai directly with a CC-statement-aware prompt
            // that explicitly asks for a transactions[] array. Then loop
            // through every row and create one CC entry per transaction,
            // each auto-classified as purchase / cash_advance / fuel by
            // a dedicated classifier function.
            //
            // This is also FASTER — one API call instead of the 12-engine
            // voting cascade — and MORE ACCURATE because the model is told
            // upfront "this is a CC statement, expect many rows".
            if (isCCOT) {
                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('🧠 AI parsing CC statement…',
                        'Extracting every transaction row', 35);

                var ccotPrompt = buildCCStatementPrompt(ccotBank);
                var ccotTxns = null;
                var ccotLastErr = null;

                // Primary attempt — full structured prompt
                try {
                    var ccotResp = await legacyAICall(ccotPrompt, firstImage, 45000);
                    var ccotParsed = extractJSON(ccotResp.reply);
                    if (ccotParsed && Array.isArray(ccotParsed.transactions) && ccotParsed.transactions.length > 0) {
                        ccotTxns = ccotParsed.transactions;
                    }
                } catch (eP1) {
                    ccotLastErr = eP1;
                    console.warn('[' + V + '] CCOT pass 1 failed:', eP1.message);
                }

                // Retry with simpler prompt if the first attempt was empty.
                // Vision models occasionally choke on long rule lists.
                if (!ccotTxns) {
                    if (showsOverlay && typeof window._showScanOverlay === 'function')
                        window._showScanOverlay('🔄 Simplified prompt retry…',
                            'Smaller payload, same image', 55);
                    try {
                        var simplePrompt = 'Read this ' + (ccotBank || '') +
                            ' credit card statement image. Return ONLY this JSON (no markdown, no explanation):\n' +
                            '{"transactions":[{"date":"YYYY-MM-DD","description":"vendor","amount":0,"type":"purchase"}]}\n' +
                            '"type" must be one of: purchase, cash_advance, service_fee, fuel.\n' +
                            'Include EVERY transaction row. Skip the closing balance, opening balance, and payment-received rows.';
                        var ccotResp2 = await legacyAICall(simplePrompt, firstImage, 35000);
                        var ccotParsed2 = extractJSON(ccotResp2.reply);
                        if (ccotParsed2 && Array.isArray(ccotParsed2.transactions) && ccotParsed2.transactions.length > 0) {
                            ccotTxns = ccotParsed2.transactions;
                        }
                    } catch (eP2) {
                        ccotLastErr = eP2;
                        console.warn('[' + V + '] CCOT pass 2 failed:', eP2.message);
                    }
                }

                // Pass 3 — Auto-Escalate (gated by user setting). When the
                // direct AI cascade returns nothing, escalate to the full
                // multi-engine vision-scan endpoint with ultra mode + an
                // explicit "expect transactions[] array" hint. This is
                // SLOWER but pulls in Gemini Pro / GPT-4o / Claude voting,
                // catching statements the single-model path missed.
                var _autoEsc = (window.WF_SCAN_SETTINGS && window.WF_SCAN_SETTINGS.autoEscalate !== false);
                if (!ccotTxns && _autoEsc) {
                    if (showsOverlay && typeof window._showScanOverlay === 'function')
                        window._showScanOverlay('🚀 Auto-escalating to Ultra…',
                            'Multi-engine vision-scan with Gemini Pro', 65);
                    try {
                        var hasVS = await isEndpointAvailable('/vision-scan');
                        if (hasVS) {
                            var ccotHints = {
                                currency: (window.WF_SCAN_SETTINGS && window.WF_SCAN_SETTINGS.currency) || 'LKR',
                                today: new Date().toISOString().split('T')[0],
                                locale: navigator.language || 'en-LK',
                                docType: 'cc_statement_multi_row',
                                bank: ccotBank,
                                expectMultipleTransactions: true,
                                schema: '{"transactions":[{"date":"YYYY-MM-DD","description":"","amount":0,"type":"purchase|cash_advance|service_fee|fuel"}]}'
                            };
                            var ultraScan = await visionScanCall(firstImage, 'ultra', ccotHints, 58000);
                            if (ultraScan && ultraScan.result) {
                                // The vision-scan endpoint may return either a transactions[]
                                // array directly OR a single-row result we need to wrap.
                                if (Array.isArray(ultraScan.result.transactions) && ultraScan.result.transactions.length > 0) {
                                    ccotTxns = ultraScan.result.transactions;
                                } else if (ultraScan.result.amount) {
                                    // Single-row fallback — still better than nothing
                                    ccotTxns = [{
                                        date: ultraScan.result.date,
                                        description: ultraScan.result.vendor || ultraScan.result.raw_text,
                                        amount: ultraScan.result.amount,
                                        type: 'purchase',
                                        notes: ''
                                    }];
                                }
                            }
                        }
                    } catch (eP3) {
                        ccotLastErr = eP3;
                        console.warn('[' + V + '] CCOT auto-escalate failed:', eP3.message);
                    }
                }

                // Pass 4 — Tesseract.js offline OCR fallback. Last resort
                // when every cloud AI engine is unreachable (offline mode,
                // network down, all providers throttled). Slower but always
                // works as long as JS can run.
                if (!ccotTxns && !isPdf && typeof window._ocrWithTesseract === 'function') {
                    if (showsOverlay && typeof window._showScanOverlay === 'function')
                        window._showScanOverlay('🔤 Offline OCR fallback…',
                            'Tesseract.js reading raw text', 80);
                    try {
                        var ocrTxt = await window._ocrWithTesseract(file);
                        if (ocrTxt && ocrTxt.length > 20 && typeof window._ccOcrTextToTransactions === 'function') {
                            var ocrRows = window._ccOcrTextToTransactions(ocrTxt, ccotBank);
                            if (ocrRows && ocrRows.length > 0) {
                                ccotTxns = ocrRows;
                                console.log('[' + V + '] CCOT Tesseract yielded', ocrRows.length, 'rows');
                            }
                        }
                    } catch (eP4) {
                        ccotLastErr = eP4;
                        console.warn('[' + V + '] CCOT Tesseract fallback failed:', eP4.message);
                    }
                }

                // Pass 5 — multi-page PDF: if we have multiple pages and the
                // first page yielded nothing OR fewer rows than expected,
                // try the remaining pages and merge.
                if (imgBundle.images.length > 1) {
                    var mergedRows = ccotTxns ? ccotTxns.slice() : [];
                    for (var pgi = 1; pgi < imgBundle.images.length; pgi++) {
                        if (showsOverlay && typeof window._showScanOverlay === 'function')
                            window._showScanOverlay('📄 Page ' + (pgi + 1) + ' of ' + imgBundle.images.length + '…',
                                'Scanning remaining pages', 70 + (pgi * 5));
                        try {
                            var pageResp = await legacyAICall(ccotPrompt, imgBundle.images[pgi], 40000);
                            var pageParsed = extractJSON(pageResp.reply);
                            if (pageParsed && Array.isArray(pageParsed.transactions)) {
                                pageParsed.transactions.forEach(function (t) {
                                    // Skip duplicates: same date + same description + same amount
                                    var isDup = mergedRows.some(function (r) {
                                        return r.date === t.date &&
                                               String(r.description || '').toLowerCase() === String(t.description || '').toLowerCase() &&
                                               normaliseAmount(r.amount) === normaliseAmount(t.amount);
                                    });
                                    if (!isDup) mergedRows.push(t);
                                });
                            }
                        } catch (eMulti) {
                            console.warn('[' + V + '] CCOT page ' + (pgi + 1) + ' scan failed:', eMulti.message);
                        }
                    }
                    if (mergedRows.length > 0) ccotTxns = mergedRows;
                }

                if (!ccotTxns || ccotTxns.length === 0) {
                    if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                    var ccotFailMsg = '⚠️ AI could not find any transactions.';
                    if (ccotLastErr && ccotLastErr.message) ccotFailMsg += ' (' + ccotLastErr.message + ')';
                    ccotFailMsg += ' Try a clearer, well-lit photo of the full statement.';
                    if (typeof window.notify === 'function') window.notify(ccotFailMsg, 'error');
                    if (typeof window.triggerHaptic === 'function') window.triggerHaptic('error');
                    inputEl.value = '';
                    return;
                }

                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('✅ Found ' + ccotTxns.length + ' transaction' +
                        (ccotTxns.length > 1 ? 's' : '') + '…', 'Opening review modal', 90);

                // Normalise + classify every row before handing off to UI.
                var normalised = ccotTxns.map(function (t, idx) {
                    var raw = (String(t.description || t.vendor || '') + ' ' +
                              String(t.notes || '') + ' ' + String(t.merchant_category || ''));
                    var type = classifyCCOTRow(raw, t.type);
                    var dateStr = normaliseCCOTDate(t.date);
                    return {
                        id: 'tx_' + idx,
                        date: dateStr,
                        description: String(t.description || t.vendor || '(unknown)').slice(0, 80),
                        amount: normaliseAmount(t.amount),
                        type: type,
                        notes: t.notes || '',
                        bank: ccotBank
                    };
                }).filter(function (t) { return t.amount && t.amount > 0; });

                if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();

                if (!normalised.length) {
                    if (typeof window.notify === 'function')
                        window.notify('⚠️ Found rows but none had valid amounts. Try a clearer photo.', 'warn');
                    inputEl.value = '';
                    return;
                }

                // Open the existing review modal — user confirms each row,
                // can edit before bulk-save. Defined in index.html.
                if (typeof window._showCCReviewModal === 'function') {
                    window._showCCReviewModal({ transactions: normalised, statement_period: '' }, ccotBank);
                } else {
                    // Fallback: bulk-save directly (review modal not present)
                    if (typeof window._bulkSaveCCOT === 'function') {
                        window._bulkSaveCCOT(normalised, ccotBank);
                    } else if (typeof window.notify === 'function') {
                        window.notify('Found ' + normalised.length + ' transactions but review modal not loaded', 'warn');
                    }
                }

                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('success');
                var elapsedC = ((Date.now() - startTime) / 1000).toFixed(1);
                var byType = normalised.reduce(function (acc, t) { acc[t.type] = (acc[t.type] || 0) + 1; return acc; }, {});
                var summary = Object.keys(byType).map(function (k) {
                    var label = k === 'cash_advance' ? '💵 cash' : (k === 'fuel' ? '⛽ fuel' : (k === 'service_fee' ? '🧾 fees' : '🛒 purchases'));
                    return byType[k] + ' ' + label;
                }).join(' · ');
                if (typeof window.notify === 'function')
                    window.notify('💳 ' + (ccotBank || 'CC') + ' · ' + normalised.length +
                        ' transaction' + (normalised.length > 1 ? 's' : '') + ' · ' +
                        summary + ' · ' + elapsedC + 's', 'success');
                console.group('[' + V + '] CCOT multi-transaction scan complete');
                console.log('Elapsed:', elapsedC + 's', '· Bank:', ccotBank);
                console.table(normalised);
                console.groupEnd();
                inputEl.value = '';
                return;
            }

            // ---- STEP C: multi-engine vision (or fallback to /api/ai) ----
            if (showsOverlay && typeof window._showScanOverlay === 'function')
                window._showScanOverlay('🧠 AI Vision…', hasVisionScan ?
                    (isSubscription ? '12+ engines · bill mode' : '12+ engines voting') :
                    'Reading with Gemini 3.1 Pro', 35);

            var settings = window.WF_SCAN_SETTINGS || {};
            var hints = {
                currency: settings.currency || 'LKR',
                today: new Date().toISOString().split('T')[0],
                locale: navigator.language || 'en-LK',
                docType: isSubscription ? 'subscription_bill' : (isCCOT ? 'cc_statement' : 'receipt'),
                bank: isCCOT ? ccotBank : null
            };
            var mode = settings.mode || 'deep';

            var scanData = null;
            var lastErr = null;

            // Try vision-scan first if available
            if (hasVisionScan) {
                try {
                    scanData = await visionScanCall(firstImage, mode, hints, 55000);
                } catch (err1) {
                    lastErr = err1;
                    console.warn('[' + V + '] vision-scan ' + mode + ' failed:', err1.message);
                    if (mode !== 'ultra') {
                        if (showsOverlay && typeof window._showScanOverlay === 'function')
                            window._showScanOverlay('💎 Ultra Mode…', 'Escalating', 50);
                        try {
                            scanData = await visionScanCall(firstImage, 'ultra', hints, 58000);
                        } catch (err2) {
                            lastErr = err2;
                            console.warn('[' + V + '] vision-scan ultra failed:', err2.message);
                        }
                    }
                }
            }

            // Confidence-low escalation
            if (scanData && scanData.confidence && scanData.confidence.overall < 0.55 && mode !== 'ultra' && hasVisionScan) {
                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('🔬 Low confidence — re-scanning…', 'Adding more engines', 65);
                try {
                    var ultra = await visionScanCall(firstImage, 'ultra', hints, 58000);
                    if (ultra && ultra.confidence && ultra.confidence.overall > scanData.confidence.overall) {
                        scanData = ultra;
                    }
                } catch (_) { /* keep deep result */ }
            }

            // ---- STEP D: PDF page-2 retry if page-1 yielded nothing ----
            if ((!scanData || !scanData.result || !scanData.result.amount) && imgBundle.images.length > 1) {
                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('📄 Page 2…', 'First page had no totals', 60);
                for (var p = 1; p < imgBundle.images.length; p++) {
                    try {
                        var tryNext = await (hasVisionScan
                            ? visionScanCall(imgBundle.images[p], 'deep', hints, 45000)
                            : null);
                        if (tryNext && tryNext.result && tryNext.result.amount) {
                            scanData = tryNext;
                            break;
                        }
                    } catch (_) { }
                }
            }

            // ---- STEP E: legacy /api/ai fallback (works without vision-scan deployed) ----
            if (!scanData || !scanData.result || !scanData.result.amount) {
                if (showsOverlay && typeof window._showScanOverlay === 'function')
                    window._showScanOverlay('🤖 Fallback AI…', 'Trying Gemini direct', 70);
                try {
                    var legacyData = await legacyAICall(buildReceiptPrompt(hints), firstImage, 35000);
                    var parsed = extractJSON(legacyData.reply);
                    if (parsed) {
                        scanData = {
                            result: {
                                vendor: parsed.vendor || null,
                                amount: normaliseAmount(parsed.amount),
                                date: parsed.date || hints.today,
                                category: parsed.category || 'Other',
                                items: Array.isArray(parsed.items) ? parsed.items : [],
                                currency: parsed.currency || hints.currency,
                                tax: normaliseAmount(parsed.tax),
                                payment_method: parsed.payment_method || null,
                                receipt_number: parsed.receipt_number || null,
                                time: parsed.time || null,
                                raw_text: parsed.raw_text || null
                            },
                            confidence: { vendor: 0.7, amount: 0.7, date: 0.6, overall: 0.7 },
                            engines: [{ name: 'legacy-ai-' + (legacyData.provider || 'unknown'), success: true, ms: 0 }],
                            mode: 'legacy-fallback'
                        };
                    }
                } catch (eLegacy) {
                    console.warn('[' + V + '] legacy /api/ai failed:', eLegacy.message);
                    lastErr = lastErr || eLegacy;
                }
            }

            // ---- STEP F: Tesseract.js (in-browser, no network) ----
            if ((!scanData || !scanData.result || !scanData.result.amount) && !isPdf) {
                try {
                    if (typeof window._ocrWithTesseract === 'function' &&
                        typeof window._extractFromOCRText === 'function') {
                        if (showsOverlay && typeof window._showScanOverlay === 'function')
                            window._showScanOverlay('🔤 Offline OCR…', 'Tesseract reading text', 85);
                        var ocrText = await window._ocrWithTesseract(file);
                        var ocrResult = window._extractFromOCRText(ocrText);
                        if (ocrResult && ocrResult.amount) {
                            scanData = {
                                result: ocrResult,
                                confidence: { overall: 0.5, vendor: 0.5, amount: 0.55, date: 0.5 },
                                engines: [{ name: 'tesseract', success: true, ms: 0 }],
                                mode: 'tesseract-fallback'
                            };
                        }
                    }
                } catch (eT) {
                    console.warn('[' + V + '] Tesseract fallback failed:', eT.message);
                }
            }

            // ---- STEP G: final result or failure ----
            if (!scanData || !scanData.result || !scanData.result.amount) {
                if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();
                var failMsg = '⚠️ Could not extract the amount. ';
                if (lastErr && lastErr.message) failMsg += '(' + lastErr.message + ') ';
                failMsg += 'Try a clearer photo or PDF.';
                if (typeof window.notify === 'function') window.notify(failMsg, 'error');
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('error');
                inputEl.value = '';
                return;
            }

            // ---- Recurring match + form fill ----
            var priorMatch = findMatchingPriorExpense(scanData.result.vendor);
            if (priorMatch) {
                scanData.result._priorMatch = priorMatch;
                console.log('[' + V + '] recurring bill matched:', priorMatch.desc, 'from', priorMatch.month);
            }

            if (showsOverlay && typeof window._showScanOverlay === 'function')
                window._showScanOverlay('✅ Filling form…', isSubscription ? 'Smart-populating subscription' : 'Smart-populating fields', 95);

            // Route to correct form populator
            var ok;
            if (isSubscription) {
                ok = populateSubscriptionForm(scanData.result, { isPdf: isPdf, pageCount: pageCount });
            } else if (isCCOT) {
                ok = populateCCOTForm(scanData.result, { isPdf: isPdf, pageCount: pageCount, bank: ccotBank });
            } else {
                ok = populateExpenseForm(scanData.result, { isPdf: isPdf, pageCount: pageCount });
            }
            if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();

            if (ok) {
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('success');
                var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                var conf = Math.round((scanData.confidence && scanData.confidence.overall || 0) * 100);
                var engineCount = (scanData.engines || []).filter(function (en) { return en.success; }).length;
                var label = isSubscription ? '📋 ' : (isCCOT ? '💳 ' : '✅ ');
                var vendorOrBank = isCCOT
                    ? (ccotBank || scanData.result.vendor || 'CC')
                    : (scanData.result.vendor || 'Bill');
                var msg = label + vendorOrBank +
                    ' · LKR ' + ((typeof window.fmtN === 'function') ? window.fmtN(scanData.result.amount) : scanData.result.amount);
                if (isSubscription && scanData.result._matchedSub)
                    msg += '\n🔁 Found existing subscription — updates ' + scanData.result._matchedSub.name;
                else if (priorMatch) msg += '\n🔁 Recurring bill — same as ' + priorMatch.month;
                if (isPdf) msg += '\n📄 PDF · ' + pageCount + ' page' + (pageCount > 1 ? 's' : '') + ' scanned';
                msg += '\n⚙️ ' + engineCount + ' engine' + (engineCount > 1 ? 's' : '') + ' · ' + conf + '% · ' + elapsed + 's';
                if (typeof window.notify === 'function') {
                    var kind = (conf >= 75) ? 'success' : (conf >= 50 ? 'info' : 'warning');
                    window.notify(msg, kind);
                }
                console.group('[' + V + '] Scan complete (' + (isSubscription ? 'subscription' : 'expense') + ')');
                console.log('Mode:', scanData.mode, '· Elapsed:', elapsed + 's');
                console.log('Confidence:', scanData.confidence);
                console.table(scanData.engines);
                console.log('Result:', scanData.result);
                console.groupEnd();
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
     * 12. AI CHAT ATTACHMENT (v4 — with PDF support + Gemini 3.1 Pro routing)
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
        if (typeof window.notify === 'function') window.notify('🔍 Deep scanning…', 'info');

        try {
            var hints = { currency: 'LKR', today: new Date().toISOString().split('T')[0] };
            var hasVisionScan = await isEndpointAvailable('/vision-scan');
            var scanData = null;
            if (hasVisionScan) {
                try { scanData = await visionScanCall(firstImage, 'deep', hints, 50000); }
                catch (_) {
                    try { scanData = await visionScanCall(firstImage, 'quick', hints, 30000); } catch (_2) { }
                }
            }

            var rawText = scanData && scanData.result && scanData.result.raw_text ? scanData.result.raw_text : '';
            var structured = scanData && scanData.result ? JSON.stringify(scanData.result, null, 2) : '(no structured data)';
            var userName = (window.currentUser && window.currentUser.displayName) ?
                window.currentUser.displayName.split(' ')[0] : 'there';

            var lang = 'English';
            try {
                if (typeof window.DB !== 'undefined') {
                    var s = window.DB.getObj('settings', {});
                    if (s.aiResponseLang && window.WF_LANG_NAMES) lang = window.WF_LANG_NAMES[s.aiResponseLang] || 'English';
                }
            } catch (_) { }

            var prompt = "You are WealthFlow AI — a warm, friendly advisor talking to " + userName + ". " +
                "They just shared a document with you. Respond entirely in " + lang + ", naturally and conversationally. " +
                "Give a brief 2-5 sentence summary. If financial, bold the key numbers as **LKR X,XXX**. " +
                "If it's a recurring bill, gently suggest tapping 📸 AI Scan in Monthly Expenses to log it.\n\n" +
                "STRUCTURED DATA:\n" + structured + "\n\n" +
                (rawText ? "RAW OCR TEXT:\n" + rawText.substring(0, 2500) + "\n\n" : "");

            var reply;
            if (scanData && scanData.result && scanData.result.raw_text) {
                // We have OCR — text-only AI call is enough
                reply = await window.callAI(prompt);
            } else {
                // No OCR — pass image directly to AI vision
                reply = await window.callAI(prompt, firstImage);
            }
            if (typeof window.appendAIMessage === 'function') window.appendAIMessage('bot', reply);

            if (typeof window.getAIHistory === 'function' && typeof window.saveAIHistory === 'function') {
                var hist = window.getAIHistory();
                hist.push({ role: 'user', content: '📎 [shared a ' + (isPdf ? 'PDF' : 'image') + ': ' + (file.name || 'file') + ']', ts: Date.now() });
                hist.push({ role: 'assistant', content: reply, ts: Date.now() });
                window.saveAIHistory(hist);
            }
            if (typeof window.notify === 'function') window.notify('✅ Analysed', 'success');
        } catch (e) {
            console.error('[' + V + '] AI chat attachment failed:', e);
            if (typeof window.appendAIMessage === 'function') {
                window.appendAIMessage('bot', '⚠️ I had trouble reading that file: ' + e.message);
            }
        } finally {
            if (typeof window.showAITyping === 'function') window.showAITyping(false);
        }
    }

    /* =========================================================================
     * 13. CLEAR CHAT / RESET MEMORY (carried over from v3, polished)
     * ========================================================================= */
    function newClearAIChat() {
        showBeautifulConfirm({
            icon: '🗑️',
            title: 'Clear Chat History?',
            message: 'I\'ll forget the messages on screen but keep what I\'ve learned about you. For a full memory wipe, use Settings → Reset AI Memory.',
            confirmText: 'Clear Chat', cancelText: 'Cancel', accent: 'amber',
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
                            '<div style="font-size:10px;color:var(--text3);">Memory intact 🧠 · Ready to chat</div></div></div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.7;">' +
                            '👋 Chat cleared. I still remember your style, goals, and finances. Just nothing to scroll through 💫</div>';
                        container.appendChild(welcome);
                    }
                    if (typeof window.notify === 'function') window.notify('🗑️ Chat cleared (memory kept).', 'success');
                    if (typeof window.initAISuggestionPills === 'function') window.initAISuggestionPills();
                } catch (e) { console.error(e); }
            }
        });
    }

    function newConfirmResetAIMemory() {
        showPinGatedConfirm({
            icon: '🧠',
            title: 'Erase ALL AI Memory?',
            message: 'Permanently deletes EVERYTHING the AI knows about you — chat, persona, learned patterns. This cannot be undone.',
            warning: '⚠️ You\'ll be starting over from scratch.',
            confirmText: '🗑️ Erase Forever', cancelText: 'Keep My Memory',
            onConfirm: async function () {
                try {
                    localStorage.removeItem('wf_ai_history');
                    localStorage.removeItem('wf_ai_memory');
                    localStorage.removeItem('wf_ai_persona');
                    localStorage.removeItem('wf2_ai_persona');
                    localStorage.removeItem('wf_ai_synced_at');
                    try {
                        if (window.currentUser && window.firebase && window.firebase.firestore) {
                            await window.firebase.firestore().collection('userAI').doc(window.currentUser.uid).delete();
                        }
                    } catch (e) { console.warn('cloud delete:', e.message); }
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
                            '<div style="font-size:10px;color:var(--text3);">Ready to learn you again</div></div></div>' +
                            '<div style="font-size:14px;color:var(--text);line-height:1.7;">' +
                            '👋 Memory reset. I don\'t know anything yet — but I\'m a quick learner. Ask me anything! 💫</div>';
                        container.appendChild(welcome);
                    }
                    if (typeof window.triggerHaptic === 'function') window.triggerHaptic('heavy');
                    if (typeof window.notify === 'function') window.notify('🧠 AI memory fully erased.', 'success');
                } catch (e) {
                    if (typeof window.notify === 'function') window.notify('⚠️ Reset failed: ' + e.message, 'error');
                }
            }
        });
    }

    /* =========================================================================
     * 14. BEAUTIFUL MODALS (CSS + helpers)
     * ========================================================================= */
    function _ensureModalContainer() {
        var c = document.getElementById('wf_v4_modal_container');
        if (c) return c;
        c = document.createElement('div');
        c.id = 'wf_v4_modal_container';
        document.body.appendChild(c);
        if (!document.getElementById('wf_v4_modal_styles')) {
            var style = document.createElement('style');
            style.id = 'wf_v4_modal_styles';
            style.textContent =
                '.wf4-overlay{position:fixed;inset:0;background:rgba(2,5,12,0.78);backdrop-filter:blur(14px);display:flex;align-items:center;justify-content:center;z-index:99999;padding:20px;animation:wf4Fade 0.18s ease-out;}' +
                '@keyframes wf4Fade{from{opacity:0}to{opacity:1}}' +
                '@keyframes wf4Slide{from{transform:translateY(20px);opacity:0}to{transform:translateY(0);opacity:1}}' +
                '.wf4-modal{background:linear-gradient(160deg,#0c1424 0%,#0a1020 100%);max-width:460px;width:100%;border:1px solid rgba(212,175,55,0.4);border-radius:18px;padding:0;color:#e5e7eb;font-family:Outfit,system-ui,sans-serif;box-shadow:0 30px 80px rgba(0,0,0,0.65),0 0 50px rgba(212,175,55,0.08);animation:wf4Slide 0.25s cubic-bezier(0.2,0.8,0.2,1);overflow:hidden;max-height:90vh;overflow-y:auto;}' +
                '.wf4-modal-header{padding:28px 28px 16px;text-align:center;}' +
                '.wf4-modal-icon{font-size:48px;margin-bottom:10px;line-height:1;filter:drop-shadow(0 4px 12px rgba(212,175,55,0.3));}' +
                '.wf4-modal-title{font-size:20px;font-weight:700;color:#fbbf24;margin-bottom:8px;letter-spacing:0.2px;}' +
                '.wf4-modal-msg{font-size:14px;color:#cbd5e1;line-height:1.7;margin:0 auto;max-width:360px;}' +
                '.wf4-modal-warn{margin:14px 28px 0;padding:10px 14px;background:rgba(239,68,68,0.08);border:1px solid rgba(239,68,68,0.25);border-radius:10px;color:#fca5a5;font-size:12.5px;text-align:center;}' +
                '.wf4-modal-body{padding:18px 28px 20px;}' +
                '.wf4-pin-label{font-size:12px;color:#94a3b8;margin-bottom:8px;text-align:center;letter-spacing:0.5px;text-transform:uppercase;font-weight:600;}' +
                '.wf4-pin-dots{display:flex;justify-content:center;gap:11px;margin:8px 0 16px;}' +
                '.wf4-pin-dot{width:14px;height:14px;border-radius:50%;background:rgba(148,163,184,0.18);border:1.5px solid rgba(148,163,184,0.3);transition:all 0.18s;}' +
                '.wf4-pin-dot.filled{background:#fbbf24;border-color:#fbbf24;box-shadow:0 0 14px rgba(251,191,36,0.6);transform:scale(1.12);}' +
                '.wf4-pin-dot.error{background:#ef4444;border-color:#ef4444;animation:wf4Shake 0.4s;}' +
                '@keyframes wf4Shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}' +
                '.wf4-pin-input{position:absolute;left:-9999px;opacity:0;}' +
                '.wf4-pin-trigger{display:block;margin:0 auto 18px;padding:11px 22px;background:rgba(212,175,55,0.1);border:1px solid rgba(212,175,55,0.35);border-radius:10px;color:#fbbf24;font-size:13px;font-weight:600;cursor:pointer;transition:all 0.18s;font-family:inherit;}' +
                '.wf4-pin-trigger:hover{background:rgba(212,175,55,0.18);transform:translateY(-1px);}' +
                '.wf4-pin-err{color:#ef4444;text-align:center;font-size:12.5px;height:18px;font-weight:500;}' +
                '.wf4-modal-actions{display:flex;gap:10px;padding:18px 28px 26px;border-top:1px solid rgba(148,163,184,0.08);}' +
                '.wf4-btn{flex:1;padding:13px 18px;border-radius:11px;border:0;cursor:pointer;font-size:14px;font-weight:600;font-family:inherit;transition:all 0.16s;letter-spacing:0.2px;}' +
                '.wf4-btn-cancel{background:rgba(148,163,184,0.1);color:#cbd5e1;border:1px solid rgba(148,163,184,0.2);}' +
                '.wf4-btn-cancel:hover{background:rgba(148,163,184,0.18);transform:translateY(-1px);}' +
                '.wf4-btn-danger{background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;box-shadow:0 4px 16px rgba(220,38,38,0.35);}' +
                '.wf4-btn-danger:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(220,38,38,0.5);}' +
                '.wf4-btn-danger:disabled{opacity:0.5;cursor:not-allowed;transform:none;box-shadow:none;}' +
                '.wf4-btn-warn{background:linear-gradient(135deg,#f59e0b,#d97706);color:#fff;box-shadow:0 4px 16px rgba(245,158,11,0.35);}' +
                '.wf4-btn-primary{background:linear-gradient(135deg,#d4af37,#b8902f);color:#0c1320;box-shadow:0 4px 16px rgba(212,175,55,0.35);font-weight:700;}' +
                '.wf4-btn-primary:hover{transform:translateY(-1px);box-shadow:0 6px 20px rgba(212,175,55,0.5);}';
            document.head.appendChild(style);
        }
        return c;
    }

    function showBeautifulConfirm(opts) {
        var c = _ensureModalContainer();
        var btnClass = opts.accent === 'amber' ? 'wf4-btn-warn' : 'wf4-btn-danger';
        c.innerHTML =
            '<div class="wf4-overlay" id="wf4OverlayCurr">' +
            '<div class="wf4-modal">' +
            '<div class="wf4-modal-header"><div class="wf4-modal-icon">' + (opts.icon || '⚠️') + '</div>' +
            '<div class="wf4-modal-title">' + opts.title + '</div>' +
            '<div class="wf4-modal-msg">' + opts.message + '</div></div>' +
            '<div class="wf4-modal-actions">' +
            '<button class="wf4-btn wf4-btn-cancel" id="wf4Cancel">' + (opts.cancelText || 'Cancel') + '</button>' +
            '<button class="wf4-btn ' + btnClass + '" id="wf4Confirm">' + (opts.confirmText || 'Confirm') + '</button>' +
            '</div></div></div>';
        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf4Cancel').onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
        document.getElementById('wf4Confirm').onclick = function () { close(); if (opts.onConfirm) opts.onConfirm(); };
        document.getElementById('wf4OverlayCurr').onclick = function (e) {
            if (e.target.id === 'wf4OverlayCurr') { close(); if (opts.onCancel) opts.onCancel(); }
        };
    }

    function showPinGatedConfirm(opts) {
        var c = _ensureModalContainer();
        var pinBuffer = '';
        c.innerHTML =
            '<div class="wf4-overlay" id="wf4OverlayCurr"><div class="wf4-modal">' +
            '<div class="wf4-modal-header"><div class="wf4-modal-icon">' + (opts.icon || '🔐') + '</div>' +
            '<div class="wf4-modal-title">' + opts.title + '</div>' +
            '<div class="wf4-modal-msg">' + opts.message + '</div></div>' +
            (opts.warning ? '<div class="wf4-modal-warn">' + opts.warning + '</div>' : '') +
            '<div class="wf4-modal-body"><div class="wf4-pin-label">🔐 Enter your 6-digit Master PIN</div>' +
            '<div class="wf4-pin-dots" id="wf4PinDots">' +
            '<div class="wf4-pin-dot"></div><div class="wf4-pin-dot"></div><div class="wf4-pin-dot"></div>' +
            '<div class="wf4-pin-dot"></div><div class="wf4-pin-dot"></div><div class="wf4-pin-dot"></div></div>' +
            '<button class="wf4-pin-trigger" id="wf4PinTrigger" type="button">⌨️ Tap to type PIN</button>' +
            '<input class="wf4-pin-input" id="wf4PinInput" type="password" inputmode="numeric" maxlength="6" autocomplete="off">' +
            '<div class="wf4-pin-err" id="wf4PinErr"></div></div>' +
            '<div class="wf4-modal-actions">' +
            '<button class="wf4-btn wf4-btn-cancel" id="wf4Cancel">' + (opts.cancelText || 'Cancel') + '</button>' +
            '<button class="wf4-btn wf4-btn-danger" id="wf4Confirm" disabled>' + (opts.confirmText || 'Confirm') + '</button>' +
            '</div></div></div>';
        var pinInput = document.getElementById('wf4PinInput');
        var dots = document.getElementById('wf4PinDots').children;
        var confirmBtn = document.getElementById('wf4Confirm');
        var errEl = document.getElementById('wf4PinErr');
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
        document.getElementById('wf4PinTrigger').onclick = function () { pinInput.focus(); };
        setTimeout(function () { try { pinInput.focus(); } catch (_) { } }, 150);
        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf4Cancel').onclick = function () { close(); if (opts.onCancel) opts.onCancel(); };
        document.getElementById('wf4OverlayCurr').onclick = function (e) {
            if (e.target.id === 'wf4OverlayCurr') { close(); if (opts.onCancel) opts.onCancel(); }
        };
        confirmBtn.onclick = async function () {
            if (pinBuffer.length !== 6) return;
            confirmBtn.disabled = true;
            confirmBtn.textContent = '⏳ Verifying…';
            try {
                if (typeof window.sha256 !== 'function' || typeof window.DB === 'undefined') {
                    throw new Error('PIN verification unavailable');
                }
                var auth = window.DB.getObj('auth', {});
                var stored = auth.pin;
                if (!stored) { close(); if (opts.onConfirm) opts.onConfirm(); return; }
                var hash = await window.sha256(pinBuffer + 'wf_salt_sg2026');
                if (hash === stored) { close(); if (opts.onConfirm) opts.onConfirm(); }
                else {
                    errEl.textContent = '❌ Incorrect PIN. Try again.';
                    for (var i = 0; i < 6; i++) dots[i].classList.add('error');
                    setTimeout(function () {
                        pinBuffer = ''; pinInput.value = ''; renderDots(); pinInput.focus();
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
     * 15. SYSTEM PROMPT WRAPPER (natural-language + universal-knowledge layer)
     * ========================================================================= */
    function patchBuildSystemPrompt() {
        if (typeof window.buildSystemPrompt !== 'function') return;
        var orig = window.buildSystemPrompt;
        window.buildSystemPrompt = function (ctx, persona) {
            var base;
            try { base = orig.call(this, ctx, persona); } catch (e) { console.warn(e); return ''; }
            var lang = 'English';
            try {
                if (typeof window.DB !== 'undefined') {
                    var s = window.DB.getObj('settings', {});
                    if (s.aiResponseLang && window.WF_LANG_NAMES) lang = window.WF_LANG_NAMES[s.aiResponseLang] || 'English';
                }
            } catch (_) { }
            var extra =
                '\n\n--- WEALTHFLOW v4 DIRECTIVES ---\n' +
                '0. UNIVERSAL KNOWLEDGE: You are NOT limited to finance. Answer anything — world events, science, ' +
                'history, languages, life advice, philosophy, jokes, tech, cooking, relationships. You only steer ' +
                'back to finance if the USER brings it up.\n' +
                '\n' +
                '1. NATURAL SPEECH IN ' + lang.toUpperCase() + ': Sound like a real human. Use idiomatic phrasing. ' +
                'Open warmly. Match the user\'s energy and style. NEVER translate awkwardly word-for-word.\n' +
                '\n' +
                '2. SMALL TALK IS WELCOME: If they say hi, say hi back warmly. If they thank you, accept it like a ' +
                'friend. If they joke, joke back. If they vent, listen first. Be HUMAN.\n' +
                '\n' +
                '3. RECEIPT/DOCUMENT CONTEXT: When attachments come through with structured OCR data, summarise ' +
                'in 2-5 sentences. If it\'s a recurring bill, suggest tapping AI Scan in Monthly Expenses.\n' +
                '\n' +
                '4. NEVER sound like a robot. NEVER say "I am a financial advisor". NEVER refuse non-finance topics. ' +
                'NEVER list 10 bullets for a simple question.';
            return base + extra;
        };
        console.log('[' + V + '] patched buildSystemPrompt');
    }

    /* =========================================================================
     * 16. SCANNER SETTINGS MODAL
     * ========================================================================= */
    if (!window.WF_SCAN_SETTINGS) {
        try {
            // Prefer the host app's settings store (DB.getObj('settings')) —
            // that's the source of truth the user edits via the in-app
            // Scanner Settings panel. Fall back to legacy localStorage key
            // only if the host store isn't ready yet.
            var hostSettings = (typeof window.DB === 'object' && window.DB && typeof window.DB.getObj === 'function')
                ? window.DB.getObj('settings', {}) : {};
            var stored = JSON.parse(localStorage.getItem('wf_scan_settings') || '{}');
            window.WF_SCAN_SETTINGS = {
                mode: hostSettings.scanMode || stored.mode || 'deep',
                preprocessing: hostSettings.scanTfEnhance !== false &&
                    (stored.preprocessing !== false),
                currency: hostSettings.scanCurrency || stored.currency || 'LKR',
                showEngines: stored.showEngines === true,
                autoEscalate: hostSettings.scanAutoEscalate !== false,
                autoCategory: hostSettings.scanAutoCategory !== false
            };
        } catch (_) {
            window.WF_SCAN_SETTINGS = { mode: 'deep', preprocessing: true, currency: 'LKR', showEngines: false, autoEscalate: true, autoCategory: true };
        }
    }
    // v7.5.0 — keep WF_SCAN_SETTINGS in sync with the host's settings store.
    // The host fires this whenever the user toggles anything in the in-app
    // Scanner Settings modal. Without this listener, v4 was reading from a
    // stale localStorage copy and ignoring the user's choices.
    window.addEventListener('wf-scan-settings-updated', function (ev) {
        try {
            var d = (ev && ev.detail) || {};
            if (d.scanMode) window.WF_SCAN_SETTINGS.mode = d.scanMode;
            if (d.scanCurrency) window.WF_SCAN_SETTINGS.currency = d.scanCurrency;
            if (typeof d.scanTfEnhance === 'boolean') window.WF_SCAN_SETTINGS.preprocessing = d.scanTfEnhance;
            if (typeof d.scanAutoEscalate === 'boolean') window.WF_SCAN_SETTINGS.autoEscalate = d.scanAutoEscalate;
            if (typeof d.scanAutoCategory === 'boolean') window.WF_SCAN_SETTINGS.autoCategory = d.scanAutoCategory;
            console.log('[' + V + '] settings refreshed from host:', window.WF_SCAN_SETTINGS);
        } catch (_) {}
    });
    function _saveScanSettings() {
        try { localStorage.setItem('wf_scan_settings', JSON.stringify(window.WF_SCAN_SETTINGS)); } catch (_) { }
    }
    // v7.5.0 — DO NOT overwrite window.openScannerSettings if the host app
    // already defines one. The host's modal is the user-facing one with
    // per-mode cards (Quick / Deep / Ultra / Frontier), Auto-Escalate,
    // Auto-Categorize, TF.js enhancement toggle, and a currency picker —
    // it persists changes into DB.set('settings', ...) so they sync
    // across devices. v4's old built-in modal is kept as a fallback only
    // for the case where the host modal hasn't been registered.
    if (typeof window.openScannerSettings !== 'function') {
        window.openScannerSettings = function () {
        var s = window.WF_SCAN_SETTINGS;
        var c = _ensureModalContainer();
        c.innerHTML =
            '<div class="wf4-overlay" id="wf4OverlayCurr"><div class="wf4-modal">' +
            '<div class="wf4-modal-header"><div class="wf4-modal-icon">📸</div>' +
            '<div class="wf4-modal-title">AI Scanner Settings</div>' +
            '<div class="wf4-modal-msg">Tune for accuracy vs speed. Powered by <strong>19 AI engines</strong> including Gemini 3.1 Pro, GPT-4o, Claude 3.5 Sonnet, Grok 2 Vision, Pixtral, and Llama 3.2 90B Vision.</div></div>' +
            '<div class="wf4-modal-body">' +
            '<label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;">Scan Mode</label>' +
            '<select id="wf4SetMode" style="width:100%;padding:11px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;color:#e5e7eb;font-size:14px;font-family:inherit;margin-bottom:14px;">' +
            '<option value="quick">🚀 Quick — 1 engine, ~2s</option>' +
            '<option value="deep">🔬 Deep — 3-5 engines vote, ~4s (default)</option>' +
            '<option value="ultra">💎 Ultra — 10+ engines + OCR, ~8s</option>' +
            '<option value="frontier">🌟 Frontier — Gemini 3.1 Pro + Claude 3.5 + 12 more, ~14s</option>' +
            '</select>' +
            '<label style="display:block;font-size:12px;color:#94a3b8;margin-bottom:6px;text-transform:uppercase;font-weight:600;letter-spacing:0.5px;">Default Currency</label>' +
            '<select id="wf4SetCurr" style="width:100%;padding:11px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;color:#e5e7eb;font-size:14px;font-family:inherit;margin-bottom:14px;">' +
            '<option>LKR</option><option>USD</option><option>EUR</option><option>GBP</option><option>INR</option><option>AUD</option><option>SGD</option><option>JPY</option><option>AED</option><option>SAR</option>' +
            '</select>' +
            '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;cursor:pointer;margin-bottom:10px;">' +
            '<input type="checkbox" id="wf4SetPP" style="width:18px;height:18px;accent-color:#fbbf24;">' +
            '<span style="font-size:13px;color:#e5e7eb;">TensorFlow.js image enhancement (sharper text)</span></label>' +
            '<label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:#0a0f1c;border:1px solid #1e293b;border-radius:9px;cursor:pointer;">' +
            '<input type="checkbox" id="wf4SetDbg" style="width:18px;height:18px;accent-color:#fbbf24;">' +
            '<span style="font-size:13px;color:#e5e7eb;">Show engine debug in console</span></label>' +
            '<div style="margin-top:14px;padding:11px 13px;background:rgba(99,102,241,0.08);border:1px solid rgba(99,102,241,0.25);border-radius:9px;font-size:11.5px;color:#a5b4fc;line-height:1.7;">' +
            '<div style="font-weight:700;color:#c7d2fe;margin-bottom:6px;">⚡ Available AI Engines (v4.0)</div>' +
            '<div><strong>Google:</strong> Gemini 3.1 Pro, 3 Flash, 2.5 Flash, 2.5 Pro, 2.0 Flash</div>' +
            '<div><strong>OpenAI:</strong> GPT-4o (via GitHub Models, FREE)</div>' +
            '<div><strong>Anthropic:</strong> Claude 3.5 Sonnet (vision)</div>' +
            '<div><strong>Meta/Open:</strong> Llama 3.2 Vision (Ollama, Together, NVIDIA), Qwen 2.5-VL (Ollama, HF, OpenRouter), Pixtral (Mistral), Llava (Groq)</div>' +
            '<div><strong>xAI:</strong> Grok 2 Vision</div>' +
            '<div><strong>Microsoft:</strong> Phi-3 Vision (Fireworks)</div>' +
            '<div><strong>OCR.space + Text-LLM chain:</strong> Gemini → Cerebras → SambaNova → GitHub DeepSeek-R1 → NVIDIA Nemotron → Cohere → DeepSeek → Groq → OpenRouter</div>' +
            '<div style="margin-top:7px;padding-top:7px;border-top:1px solid rgba(99,102,241,0.2);"><strong>💡 Frontier mode</strong> uses Google\'s most advanced reasoning model (Feb 2026).</div>' +
            '</div>' +
            '</div>' +
            '<div class="wf4-modal-actions">' +
            '<button class="wf4-btn wf4-btn-cancel" id="wf4Cancel">Cancel</button>' +
            '<button class="wf4-btn wf4-btn-primary" id="wf4Save">💾 Save Settings</button>' +
            '</div></div></div>';
        document.getElementById('wf4SetMode').value = s.mode;
        document.getElementById('wf4SetCurr').value = s.currency;
        document.getElementById('wf4SetPP').checked = s.preprocessing !== false;
        document.getElementById('wf4SetDbg').checked = !!s.showEngines;
        var close = function () { c.innerHTML = ''; };
        document.getElementById('wf4Cancel').onclick = close;
        document.getElementById('wf4OverlayCurr').onclick = function (e) { if (e.target.id === 'wf4OverlayCurr') close(); };
        document.getElementById('wf4Save').onclick = function () {
            window.WF_SCAN_SETTINGS = {
                mode: document.getElementById('wf4SetMode').value,
                currency: document.getElementById('wf4SetCurr').value,
                preprocessing: document.getElementById('wf4SetPP').checked,
                showEngines: document.getElementById('wf4SetDbg').checked
            };
            _saveScanSettings();
            close();
            if (typeof window.notify === 'function') window.notify('✅ Scanner settings saved', 'success');
        };
    };
    }  // end: if (typeof window.openScannerSettings !== 'function')

    /* =========================================================================
     * 17. PATCH FILE INPUTS to accept PDFs
     * ========================================================================= */
    function patchFileInputs() {
        var inputs = document.querySelectorAll('input[type="file"][id="e_ai_scan"], input[type="file"][id="ai_chat_scan"], input[type="file"][id="sub_ai_scan"], input[type="file"][id="ccot_ai_scan"]');
        inputs.forEach(function (inp) {
            inp.accept = 'image/*,application/pdf,.pdf';
        });
    }

    /* =========================================================================
     * 18. BIND PATCHES once host is ready
     * ========================================================================= */
    whenReady(function () {
        return (typeof window.callAI === 'function') ||
            (typeof window.handleAIScan === 'function') ||
            (typeof window.notify === 'function');
    }, function () {
        try {
            window.handleAIScan = handleAIScanV4;
            window.clearAIChat = newClearAIChat;
            window.confirmResetAIMemory = newConfirmResetAIMemory;
            patchBuildSystemPrompt();
            patchFileInputs();
            console.log('[' + V + '] all patches applied ✓');
            console.log('[' + V + '] Settings: WF_SCAN_SETTINGS =', window.WF_SCAN_SETTINGS);
        } catch (e) {
            console.error('[' + V + '] patch error:', e);
        }
    }, 12000);

    /* =========================================================================
     * 19. DEBUG EXPORT
     * ========================================================================= */
    window.WF_AI_V4 = {
        version: V,
        scan: handleAIScanV4,
        clearChat: newClearAIChat,
        resetMemory: newConfirmResetAIMemory,
        openSettings: function () { window.openScannerSettings(); },
        utils: {
            fileToImagesV4: fileToImagesV4,
            renderPdfPageAdaptive: renderPdfPageAdaptive,
            ensurePdfJs: ensurePdfJs,
            isEndpointAvailable: isEndpointAvailable,
            visionScanCall: visionScanCall,
            legacyAICall: legacyAICall,
            findMatchingPriorExpense: findMatchingPriorExpense,
            buildSmartNote: buildSmartNote,
            extractJSON: extractJSON,
            normaliseAmount: normaliseAmount,
            approxBase64Bytes: approxBase64Bytes,
            fmtBytes: fmtBytes
        }
    };

    /* ==========================================================================
     * ============= v5.0 MEGA-UPGRADE — CRITICAL FIXES + AI EVOLUTION ==========
     * ==========================================================================
     *
     *   Section 20 — DB write-guard (fixes "save-then-disappear" bug)
     *   Section 21 — Subscription scan overlay (fixes missing UI in sub modal)
     *   Section 22 — Desktop PDF picker fix
     *   Section 23 — Multi-file attachment UI (15 files) for AI Advisor
     *   Section 24 — Smart thinking animation (neuron pulse, not logo)
     *   Section 25 — Universal vision AI (cars, objects, anything — not just receipts)
     *   Section 26 — User intent parser (detects "deep analysis", "simple answer", etc.)
     *   Section 27 — Auto-route to highest-accuracy model based on intent
     *   Section 28 — Per-modal scan overlay injection
     * ========================================================================== */

    var V5 = 'WF-AI-v5.0';

    /* =========================================================================
     * 20. CRITICAL: DB WRITE-GUARD — fixes "save then instantly disappears"
     *
     *  Root cause: Firestore onSnapshot can deliver intermediate snapshots BEFORE
     *  the user's cloud write reflects. The original code overwrites local appData
     *  with the stale cloud data, deleting the new entry.
     *
     *  Fix strategy: track every entry the user just added/modified. For the next
     *  10 seconds, any incoming snapshot that LACKS one of these IDs is treated
     *  as stale — we merge it instead of replacing.
     * ========================================================================= */
    var _localWriteGuard = {
        recentIds: new Map(),   // key='collection:id' → expiresAt
        recentArrayHashes: new Map() // key=collection → { hash, fullArray, expiresAt }
    };

    function _hashArray(arr) {
        if (!Array.isArray(arr)) return null;
        var ids = arr.map(function (x) { return x && x.id; }).filter(Boolean).sort();
        return ids.length + ':' + ids.join(',');
    }

    function _trackLocalWrite(collection, fullArray) {
        var now = Date.now();
        var expires = now + 12000;  // 12-second guard window
        if (Array.isArray(fullArray)) {
            fullArray.forEach(function (it) {
                if (it && it.id) _localWriteGuard.recentIds.set(collection + ':' + it.id, expires);
            });
            _localWriteGuard.recentArrayHashes.set(collection, {
                hash: _hashArray(fullArray),
                fullArray: JSON.parse(JSON.stringify(fullArray)),
                expiresAt: expires
            });
        }
        // GC expired entries
        for (var pair of _localWriteGuard.recentIds) {
            if (pair[1] < now) _localWriteGuard.recentIds.delete(pair[0]);
        }
        for (var pair2 of _localWriteGuard.recentArrayHashes) {
            if (pair2[1].expiresAt < now) _localWriteGuard.recentArrayHashes.delete(pair2[0]);
        }
    }

    function _patchDBset() {
        if (typeof window.DB === 'undefined' || typeof window.DB.set !== 'function') {
            // Even if DB isn't on window, register the host hook — the v6.9 index.html's
            // DB.set will call window._wfV5TrackWrite for every write.
            if (typeof window._wfV5TrackWrite !== 'function') {
                window._wfV5TrackWrite = function (k, v) {
                    try { _trackLocalWrite(k, v); } catch (_) {}
                };
                console.log('[' + V5 + '] _wfV5TrackWrite hook registered (host will invoke on writes)');
            }
            return false;
        }
        if (window.DB._v5patched) return true;
        var origSet = window.DB.set.bind(window.DB);
        window.DB.set = function (k, v) {
            try { _trackLocalWrite(k, v); } catch (e) { console.warn('[' + V5 + '] guard track failed:', e); }
            return origSet(k, v);
        };
        window.DB._v5patched = true;
        // Also register the host hook in case DB.set is called via direct reference (not via window.DB)
        window._wfV5TrackWrite = function (k, v) {
            try { _trackLocalWrite(k, v); } catch (_) {}
        };
        console.log('[' + V5 + '] DB.set guard installed ✓');
        return true;
    }

    // The killer: hook into the existing isSyncingFromCloud path to protect arrays
    function _installSnapshotGuard() {
        // If window.appData isn't exposed (old index.html), we install the hook
        // anyway and rely on _wfV5TrackWrite. We can still do the restore loop
        // BUT only if appData is reachable — otherwise the guard only protects
        // via the host-side merge logic.
        if (typeof window.appData === 'undefined') {
            console.warn('[' + V5 + '] appData not on window — relying on host-side merge fix only');
            // Still install the hook for future use (eg. SPA navigation)
            return false;
        }
        if (window._wfV5GuardLoop) return true;
        window._wfV5GuardLoop = setInterval(function () {
            try {
                var now = Date.now();
                for (var pair of _localWriteGuard.recentArrayHashes) {
                    var collection = pair[0];
                    var record = pair[1];
                    if (record.expiresAt < now) continue;
                    var current = window.appData[collection];
                    if (!Array.isArray(current) || !Array.isArray(record.fullArray)) continue;
                    var currentIds = new Set(current.map(function (x) { return x && x.id; }).filter(Boolean));
                    var missingFromCurrent = record.fullArray.filter(function (x) {
                        return x && x.id && !currentIds.has(x.id);
                    });
                    if (missingFromCurrent.length > 0) {
                        console.warn('[' + V5 + '] 🛡️ Restoring ' + missingFromCurrent.length +
                                     ' entries to ' + collection + ' (snapshot race detected)');
                        var restored = current.concat(missingFromCurrent);
                        window.appData[collection] = restored;
                        try { localStorage.setItem('wf2_' + collection, JSON.stringify(restored)); } catch (_) {}
                        try {
                            var renderFn = {
                                expenses: window.renderExpenses,
                                subscriptions: window.renderSubscriptions,
                                income: window.renderIncome,
                                loans: window.renderLoans,
                                ccinstall: window.renderCCI,
                                cconetime: window.renderCCOT,
                                cheques: window.renderCheques,
                                targets: window.renderTargets
                            }[collection];
                            if (typeof renderFn === 'function') renderFn();
                            if (typeof window.renderDash === 'function') window.renderDash();
                        } catch (_) {}
                        try {
                            if (window.isDirty !== undefined) {
                                window.isDirty = true;
                                if (typeof window.debouncedSync === 'function') window.debouncedSync();
                            }
                            if (typeof window._wfMarkLocalWrite === 'function') window._wfMarkLocalWrite();
                        } catch (_) {}
                        if (typeof window.notify === 'function') {
                            window.notify('🛡️ Restored ' + missingFromCurrent.length + ' entries (cloud sync race protected)', 'info');
                        }
                    }
                }
            } catch (e) {
                console.error('[' + V5 + '] guard loop error:', e);
            }
        }, 800);
        return true;
    }

    /* =========================================================================
     * 21. SCAN OVERLAY — works inside ANY open modal (fixes Subscription scan UI)
     *
     *  The original `_showScanOverlay` looks only for #aiScanOverlay which lives
     *  inside the Expense modal. We override it with a smart version that injects
     *  a floating overlay attached to the visible modal.
     * ========================================================================= */
    function _ensureFloatingScanOverlay() {
        var ov = document.getElementById('wf5_floating_scan_overlay');
        if (ov) return ov;
        ov = document.createElement('div');
        ov.id = 'wf5_floating_scan_overlay';
        ov.style.cssText = 'position:fixed; inset:0; z-index:99998; background:rgba(2,6,15,0.86); backdrop-filter:blur(14px); display:none; flex-direction:column; align-items:center; justify-content:center; gap:18px; padding:32px; animation:wf5Fade 0.18s ease-out;';
        ov.innerHTML =
            '<div id="wf5ScanSpinner" style="position:relative;width:88px;height:88px;">' +
                '<div style="position:absolute;inset:0;border-radius:50%;border:3px solid rgba(212,175,55,0.12);border-top-color:#fbbf24;border-right-color:rgba(251,191,36,0.6);animation:wf5Spin 1s linear infinite;"></div>' +
                '<div style="position:absolute;inset:14px;border-radius:50%;border:2px solid rgba(99,102,241,0.18);border-bottom-color:#818cf8;animation:wf5Spin 1.4s linear infinite reverse;"></div>' +
                '<div style="position:absolute;inset:30px;border-radius:50%;background:radial-gradient(circle,rgba(251,191,36,0.6),transparent 70%);animation:wf5Pulse 1.6s ease-in-out infinite;"></div>' +
            '</div>' +
            '<div id="wf5ScanStage" style="font-size:17px;font-weight:700;color:#fbbf24;text-align:center;letter-spacing:0.4px;font-family:Outfit,system-ui,sans-serif;">📸 Optimizing Image…</div>' +
            '<div id="wf5ScanDetail" style="font-size:13px;color:#cbd5e1;text-align:center;max-width:320px;line-height:1.6;font-family:Outfit,system-ui,sans-serif;">Compressing and enhancing for AI vision</div>' +
            '<div style="width:80%;max-width:280px;height:5px;background:rgba(148,163,184,0.15);border-radius:5px;overflow:hidden;">' +
                '<div id="wf5ScanBar" style="height:100%;width:0%;background:linear-gradient(90deg,#fbbf24,#f59e0b,#fbbf24);background-size:200% 100%;border-radius:5px;transition:width 0.4s ease;animation:wf5BarShimmer 1.6s linear infinite;"></div>' +
            '</div>' +
            '<div id="wf5ScanEngines" style="font-size:11px;color:#94a3b8;font-family:monospace;letter-spacing:0.5px;opacity:0.8;"></div>';
        document.body.appendChild(ov);
        if (!document.getElementById('wf5_scan_styles')) {
            var style = document.createElement('style');
            style.id = 'wf5_scan_styles';
            style.textContent =
                '@keyframes wf5Fade{from{opacity:0}to{opacity:1}}' +
                '@keyframes wf5Spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}' +
                '@keyframes wf5Pulse{0%,100%{transform:scale(0.85);opacity:0.6}50%{transform:scale(1.05);opacity:1}}' +
                '@keyframes wf5BarShimmer{from{background-position:0% 0%}to{background-position:200% 0%}}';
            document.head.appendChild(style);
        }
        return ov;
    }

    function _showScanOverlayV5(stage, detail, pct) {
        var ov = _ensureFloatingScanOverlay();
        ov.style.display = 'flex';
        var sEl = document.getElementById('wf5ScanStage');
        var dEl = document.getElementById('wf5ScanDetail');
        var bEl = document.getElementById('wf5ScanBar');
        if (sEl) sEl.textContent = stage;
        if (dEl) dEl.textContent = detail;
        if (bEl) bEl.style.width = (pct || 0) + '%';
    }
    function _hideScanOverlayV5() {
        var ov = document.getElementById('wf5_floating_scan_overlay');
        if (ov) ov.style.display = 'none';
        // Also hide the original expense-modal overlay if visible
        var oldOv = document.getElementById('aiScanOverlay');
        if (oldOv) oldOv.style.display = 'none';
    }

    /* =========================================================================
     * 22. DESKTOP PDF FIX — Chrome/Edge on Windows reject `accept=".pdf"` sometimes
     *
     *  The fix: also listen for "drop" events and accept any file containing
     *  "pdf" in its name. Plus we add explicit MIME variants.
     * ========================================================================= */
    function patchFileInputsV5() {
        var inputs = document.querySelectorAll(
            'input[type="file"][id="e_ai_scan"], ' +
            'input[type="file"][id="ai_chat_scan"], ' +
            'input[type="file"][id="sub_ai_scan"], ' +
            'input[type="file"][id="ccot_ai_scan"]'
        );
        inputs.forEach(function (inp) {
            // ALL platforms: include explicit MIME types Chrome/Firefox/Safari prefer
            inp.accept = 'image/*,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf,.PDF';
            // Allow multi-file for AI chat
            if (inp.id === 'ai_chat_scan') {
                inp.multiple = true;
            }
        });
        // Add drag-drop on AI chat area
        var chatInput = document.getElementById('aiChatInput');
        if (chatInput && !chatInput._wf5DragInstalled) {
            chatInput._wf5DragInstalled = true;
            var parent = chatInput.closest('div[style*="display:flex"]') || chatInput.parentElement;
            if (parent) {
                ['dragenter', 'dragover'].forEach(function (ev) {
                    parent.addEventListener(ev, function (e) {
                        e.preventDefault(); e.stopPropagation();
                        parent.style.outline = '2px dashed #fbbf24';
                        parent.style.outlineOffset = '4px';
                    });
                });
                ['dragleave', 'drop'].forEach(function (ev) {
                    parent.addEventListener(ev, function (e) {
                        e.preventDefault(); e.stopPropagation();
                        parent.style.outline = '';
                        parent.style.outlineOffset = '';
                    });
                });
                parent.addEventListener('drop', function (e) {
                    var files = e.dataTransfer && e.dataTransfer.files;
                    if (files && files.length > 0) {
                        var fakeEvent = { target: { files: Array.from(files).slice(0, 15), value: '' } };
                        handleAIChatMultiAttach(fakeEvent);
                    }
                });
            }
        }
    }

    /* =========================================================================
     * 23. MULTI-FILE ATTACHMENT UI FOR AI ADVISOR (up to 15 files)
     *
     *  When user clicks 📎 in AI chat, they can now pick multiple images/PDFs.
     *  Each shows as a thumbnail with a remove button. Clicking send transmits
     *  all of them to the multi-engine vision pipeline.
     * ========================================================================= */
    var _aiChatAttachments = [];   // [{ file, preview, isPdf }]

    function _ensureAttachmentRail() {
        var rail = document.getElementById('wf5_attach_rail');
        if (rail) return rail;
        rail = document.createElement('div');
        rail.id = 'wf5_attach_rail';
        rail.style.cssText = 'display:none;padding:8px 10px 0;gap:8px;flex-wrap:wrap;align-items:center;';
        var aiInput = document.getElementById('aiChatInput');
        if (aiInput) {
            var container = aiInput.closest('div[style*="border-top"]') || aiInput.parentElement.parentElement;
            if (container) container.insertBefore(rail, container.firstChild);
        }
        return rail;
    }

    function _setSendLock(locked) {
        try {
            var btn = document.getElementById('aiSendBtn');
            if (!btn) return;
            if (locked) {
                btn.disabled = true;
                btn.dataset.wfLocked = '1';
                btn.style.opacity = '0.45';
                btn.style.cursor = 'not-allowed';
                if (!btn.dataset.wfOrig) btn.dataset.wfOrig = btn.innerHTML;
                btn.innerHTML = '<span class="wf-send-spinner"></span>';
            } else {
                btn.disabled = false;
                btn.dataset.wfLocked = '';
                btn.style.opacity = '';
                btn.style.cursor = '';
                if (btn.dataset.wfOrig) btn.innerHTML = btn.dataset.wfOrig;
            }
        } catch (_) {}
    }

    function _ensureUploadStyles() {
        if (document.getElementById('wf_upload_styles')) return;
        var s = document.createElement('style');
        s.id = 'wf_upload_styles';
        s.textContent =
            '@keyframes wfspin{to{transform:rotate(360deg)}}' +
            '.wf-send-spinner{display:inline-block;width:15px;height:15px;border:2px solid rgba(255,255,255,0.35);border-top-color:#fff;border-radius:50%;animation:wfspin 0.7s linear infinite;vertical-align:middle;}' +
            '.wf-att-prog{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(8,12,24,0.72);backdrop-filter:blur(1px);}' +
            '.wf-att-ring{transform:rotate(-90deg);}' +
            '.wf-att-ring circle{fill:none;stroke-width:4;}' +
            '.wf-att-ring .bg{stroke:rgba(255,255,255,0.18);}' +
            '.wf-att-ring .fg{stroke:#d4af37;stroke-linecap:round;transition:stroke-dashoffset 0.2s ease;}';
        document.head.appendChild(s);
    }

    // Circular progress ring (Claude/Gemini style) drawn over a thumbnail
    function _progressRing(pct) {
        var r = 18, c = 2 * Math.PI * r;
        var off = c * (1 - Math.max(0, Math.min(1, pct)) );
        return '<div class="wf-att-prog"><svg class="wf-att-ring" width="46" height="46" viewBox="0 0 46 46">' +
            '<circle class="bg" cx="23" cy="23" r="' + r + '"></circle>' +
            '<circle class="fg" cx="23" cy="23" r="' + r + '" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '"></circle>' +
            '</svg></div>';
    }

    function _renderAttachmentRail() {
        var rail = _ensureAttachmentRail();
        if (_aiChatAttachments.length === 0) { rail.style.display = 'none'; rail.innerHTML = ''; return; }
        rail.style.display = 'flex';
        rail.innerHTML = _aiChatAttachments.map(function (att, idx) {
            var thumb = att.isPdf ?
                '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#1e293b,#0f172a);color:#fbbf24;font-size:20px;font-weight:700;">📄</div>' :
                (att.preview ? '<img src="' + att.preview + '" style="width:100%;height:100%;object-fit:cover;">' :
                 '<div style="width:100%;height:100%;background:#0f172a;"></div>');
            var progress = (att.uploading ? _progressRing(att.progress || 0) : '');
            return '<div style="position:relative;width:54px;height:54px;border-radius:8px;overflow:hidden;border:1px solid rgba(212,175,55,0.4);box-shadow:0 2px 8px rgba(0,0,0,0.3);">' +
                thumb + progress +
                (att.uploading ? '' : '<button onclick="window.WF_AI_V5._removeAttachment(' + idx + ')" style="position:absolute;top:1px;right:1px;width:18px;height:18px;border-radius:50%;border:0;background:rgba(239,68,68,0.9);color:#fff;font-size:11px;line-height:1;cursor:pointer;padding:0;font-weight:700;" title="Remove">×</button>') +
                (att.isPdf ? '<div style="position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,0.7);color:#fbbf24;font-size:8px;text-align:center;padding:1px 0;">PDF</div>' : '') +
                '</div>';
        }).join('') +
        '<div style="font-size:11px;color:#94a3b8;font-weight:600;margin-left:6px;">' + _aiChatAttachments.length + '/15 files</div>';
    }

    function _removeAttachment(idx) {
        _aiChatAttachments.splice(idx, 1);
        _renderAttachmentRail();
        // Unlock send if nothing is still uploading
        if (!_aiChatAttachments.some(function (a) { return a.uploading; })) _setSendLock(false);
    }

    async function handleAIChatMultiAttach(e) {
        var files = e.target && e.target.files ? Array.from(e.target.files) : [];
        if (!files.length) return;
        var slotsLeft = 15 - _aiChatAttachments.length;
        if (slotsLeft <= 0) {
            if (typeof window.notify === 'function') window.notify('⚠️ Maximum 15 files. Remove some first.', 'warning');
            return;
        }
        files = files.slice(0, slotsLeft);
        _ensureUploadStyles();
        _setSendLock(true); // lock send button while uploading (like Claude/Gemini)

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            var isPdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name || '');
            // Insert a placeholder attachment in "uploading" state so the
            // progress ring shows immediately.
            var att = { file: f, preview: null, isPdf: isPdf, name: f.name, size: f.size, uploading: true, progress: 0 };
            _aiChatAttachments.push(att);
            _renderAttachmentRail();

            if (!isPdf) {
                /* eslint-disable no-loop-func */
                await new Promise(function (resolve) {
                    var reader = new FileReader();
                    reader.onprogress = function (ev) {
                        if (ev.lengthComputable) {
                            att.progress = ev.loaded / ev.total;
                            _renderAttachmentRail();
                        }
                    };
                    reader.onload = function (ev) {
                        att.preview = ev.target.result;
                        att.progress = 1;
                        att.uploading = false;
                        _renderAttachmentRail();
                        resolve();
                    };
                    reader.onerror = function () { att.uploading = false; resolve(); };
                    reader.readAsDataURL(f);
                });
                /* eslint-enable no-loop-func */
            } else {
                // PDFs: brief simulated progress so the ring animates
                for (var p = 0; p <= 1; p += 0.34) {
                    att.progress = p; _renderAttachmentRail();
                    await new Promise(function (r) { setTimeout(r, 90); });
                }
                att.uploading = false;
                _renderAttachmentRail();
            }
        }

        _setSendLock(false); // unlock — files ready, user can send now
        if (e.target) e.target.value = '';
        if (typeof window.notify === 'function')
            window.notify('📎 Attached ' + files.length + ' file' + (files.length > 1 ? 's' : '') + ' — ready to send', 'success');
    }

    /* =========================================================================
     * 24. SMART "THINKING" ANIMATION — neuron-pulse, not the logo
     *
     *  When the AI is processing, we show a 3-dot neuron-pulse next to the AI
     *  bubble. Subtle, professional, not branded. Triggers haptic on mobile.
     * ========================================================================= */
    function _ensureThinkingStyles() {
        if (document.getElementById('wf5_thinking_styles')) return;
        var s = document.createElement('style');
        s.id = 'wf5_thinking_styles';
        s.textContent =
            '.wf5-thinking-bubble{display:inline-flex;gap:4px;align-items:center;padding:9px 14px;background:linear-gradient(135deg,rgba(212,175,55,0.08),rgba(99,102,241,0.05));border:1px solid rgba(212,175,55,0.18);border-radius:14px;font-family:Outfit,system-ui,sans-serif;margin:6px 0;}' +
            '.wf5-thinking-dot{width:8px;height:8px;border-radius:50%;background:#fbbf24;opacity:0.4;animation:wf5ThinkPulse 1.2s ease-in-out infinite;}' +
            '.wf5-thinking-dot:nth-child(2){animation-delay:0.15s;background:#818cf8;}' +
            '.wf5-thinking-dot:nth-child(3){animation-delay:0.3s;background:#34d399;}' +
            '.wf5-thinking-label{font-size:12px;color:#cbd5e1;margin-left:8px;letter-spacing:0.2px;}' +
            '@keyframes wf5ThinkPulse{0%,80%,100%{opacity:0.35;transform:scale(0.85)}40%{opacity:1;transform:scale(1.15);box-shadow:0 0 12px currentColor}}' +
            '.wf5-thinking-stage{font-size:11px;color:#94a3b8;margin-left:6px;font-style:italic;}';
        document.head.appendChild(s);
    }

    function _showThinking(label) {
        _ensureThinkingStyles();
        var container = document.getElementById('aiChatMessages');
        if (!container) return null;
        var existing = document.getElementById('wf5_thinking');
        if (existing) existing.remove();
        var wrap = document.createElement('div');
        wrap.id = 'wf5_thinking';
        wrap.innerHTML =
            '<div class="wf5-thinking-bubble">' +
                '<span class="wf5-thinking-dot"></span>' +
                '<span class="wf5-thinking-dot"></span>' +
                '<span class="wf5-thinking-dot"></span>' +
                '<span class="wf5-thinking-label" id="wf5_thinking_label">' + (label || 'Thinking deeply…') + '</span>' +
            '</div>';
        container.appendChild(wrap);
        container.scrollTop = container.scrollHeight;
        return wrap;
    }
    function _updateThinking(label) {
        var l = document.getElementById('wf5_thinking_label');
        if (l) l.textContent = label;
    }
    function _hideThinking() {
        var existing = document.getElementById('wf5_thinking');
        if (existing) existing.remove();
    }

    /* =========================================================================
     * 25. UNIVERSAL VISION PROMPT BUILDER
     *
     *  When user attaches images/PDFs to AI Advisor, we DON'T treat it as a
     *  receipt. Instead we use a general-purpose vision prompt that handles
     *  cars, food, faces (anonymously), screenshots, charts, anything.
     *
     *  The receipt prompt is reserved for the dedicated AI Scan flow only.
     * ========================================================================= */
    function buildUniversalVisionPrompt(userMessage, intent) {
        var directives = [];
        if (intent.deepAnalysis) directives.push('Perform an exhaustive, expert-level analysis. Include nuances, edge cases, and counterpoints.');
        if (intent.simpleAnswer) directives.push('Reply with a concise, simple answer (2-3 short sentences). No bullets, no headers.');
        if (intent.fullDetails) directives.push('Provide complete details: every relevant fact, specification, history, or context you can identify.');
        if (intent.highAccuracy) directives.push('Prioritise accuracy over brevity. If uncertain, say so explicitly. Cross-reference multiple visual cues.');
        if (intent.thinkStepByStep) directives.push('Think step by step. Show your reasoning chain before the conclusion.');
        if (intent.listFormat) directives.push('Format the answer as a structured list.');

        var lang = 'English';
        try {
            if (typeof window.DB !== 'undefined') {
                var s = window.DB.getObj('settings', {});
                if (s.aiResponseLang && window.WF_LANG_NAMES) lang = window.WF_LANG_NAMES[s.aiResponseLang] || 'English';
            }
        } catch (_) {}

        var userName = (window.currentUser && window.currentUser.displayName) ?
            window.currentUser.displayName.split(' ')[0] : 'there';

        return 'You are WealthFlow AI — a world-class multimodal expert with photographic perception.\n' +
            '\nUSER: ' + userName + ', writing in ' + lang + '.' +
            '\nRESPOND IN: ' + lang + ', naturally and human-like. No robot voice.\n' +
            '\nWHAT YOU CAN DO:\n' +
            '- Identify cars, makes, models, years, trim levels from any angle\n' +
            '- Read receipts, invoices, bills with surgical precision (amounts, dates, vendors)\n' +
            '- Analyse charts, graphs, screenshots, code, diagrams\n' +
            '- Identify objects, animals, plants, landmarks, brands, logos\n' +
            '- Read handwriting and typed text in any language\n' +
            '- Recognise products and provide specifications when asked\n' +
            '- Describe scenes, lighting, composition, mood\n' +
            '- Answer ANY question the user has about the image(s)\n' +
            '\nIMPORTANT RULES:\n' +
            '- BE ACCURATE. If you cannot see something clearly, say so. Never invent details.\n' +
            '- Use ALL the visual information available. Cross-check different parts of the image.\n' +
            '- For cars: identify make, model, year range, trim, distinguishing features.\n' +
            '- For documents: read ALL visible text accurately.\n' +
            '- For multiple images: cross-reference them, treat as a series.\n' +
            '\n' + (directives.length ? 'USER\'S EXPLICIT REQUESTS:\n- ' + directives.join('\n- ') + '\n\n' : '') +
            'USER\'S QUESTION:\n' + (userMessage || '(No text — describe what you see in detail and offer insights.)');
    }

    /* =========================================================================
     * 26. USER INTENT PARSER — detects how the user wants their answer
     * ========================================================================= */
    function parseUserIntent(msg) {
        var m = (msg || '').toLowerCase();
        return {
            deepAnalysis: /\b(deep|thorough|comprehensive|in.?depth|detailed analysis|full analysis|complete analysis|exhaustive)\b/.test(m),
            simpleAnswer: /\b(simple|brief|short|quick answer|tldr|tl.?dr|concise|summary)\b/.test(m),
            fullDetails: /\b(full detail|all details|every detail|everything about|complete (info|information)|tell me everything|full details)\b/.test(m),
            highAccuracy: /\b(accurate|accuracy|precise|exact|highest accuracy|most accurate|verify|double.?check)\b/.test(m),
            thinkStepByStep: /\b(step by step|step.?by.?step|reason through|explain.*reasoning|show your work|walk me through)\b/.test(m),
            listFormat: /\b(list|bullet|enumerate|numbered)\b/.test(m),
            wantsImageReasoning: /\b(what (is|are) this|identify|recognise|recognize|verify|tell me about|analyse|analyze)\b/.test(m)
        };
    }

    /* =========================================================================
     * 27. MULTI-FILE AI CHAT SEND — overrides the original sendAIMessage to
     *     handle attached files via the multi-engine vision pipeline
     * ========================================================================= */
    var _originalSendAIMessage = null;
    async function sendAIMessageV5() {
        var inputEl = document.getElementById('aiChatInput');
        if (!inputEl) return;
        var msg = inputEl.value.trim();
        var hasFiles = _aiChatAttachments.length > 0;

        if (!msg && !hasFiles) return;

        // No files attached → defer to original handler
        if (!hasFiles) {
            if (typeof _originalSendAIMessage === 'function') {
                return _originalSendAIMessage();
            }
            return;
        }

        // Show user's message + thumbnails in chat
        if (typeof window.appendAIMessage === 'function') {
            var thumbsHtml = _aiChatAttachments.map(function (att) {
                if (att.isPdf) {
                    return '<div style="display:inline-block;width:80px;height:80px;border-radius:8px;background:linear-gradient(135deg,#1e293b,#0f172a);color:#fbbf24;display:inline-flex;align-items:center;justify-content:center;font-size:24px;margin:2px;border:1px solid rgba(212,175,55,0.3);"><div style="text-align:center;"><div>📄</div><div style="font-size:8px;color:#94a3b8;margin-top:2px;">' + (att.name || 'PDF').substring(0, 12) + '</div></div></div>';
                }
                return '<img src="' + att.preview + '" style="display:inline-block;width:80px;height:80px;object-fit:cover;border-radius:8px;margin:2px;border:1px solid rgba(212,175,55,0.3);">';
            }).join('');
            var userHtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:8px;">' + thumbsHtml + '</div>' +
                           (msg ? '<div>' + escapeHtml(msg) + '</div>' : '<div style="color:#94a3b8;font-style:italic;">(Analysing files…)</div>');
            window.appendAIMessage('user', userHtml, true);
        }

        // Clear input + rail
        inputEl.value = '';
        if (typeof window.autoResizeAIInput === 'function') window.autoResizeAIInput(inputEl);

        // Capture files before clearing
        var attachments = _aiChatAttachments.slice();
        _aiChatAttachments = [];
        _renderAttachmentRail();

        // Parse intent
        var intent = parseUserIntent(msg);

        // Show thinking animation
        _showThinking('Reading ' + attachments.length + ' file' + (attachments.length > 1 ? 's' : '') + '…');

        try {
            // Step 1: extract images from all attachments (PDFs → first 2 pages each, max 15 images total)
            _updateThinking('🖼️ Optimising images…');
            var allImages = [];
            for (var i = 0; i < attachments.length && allImages.length < 15; i++) {
                try {
                    var bundle = await fileToImagesV4(attachments[i].file, {
                        maxPages: 3, maxBytes: 3.8 * 1024 * 1024, enhance: true
                    });
                    for (var p = 0; p < bundle.images.length && allImages.length < 15; p++) {
                        allImages.push({
                            base64: bundle.images[p],
                            sourceFile: attachments[i].name,
                            isPdf: bundle.isPdf,
                            page: p + 1
                        });
                    }
                } catch (eExt) {
                    console.warn('[' + V5 + '] file ' + i + ' extraction failed:', eExt.message);
                }
            }
            if (allImages.length === 0) throw new Error('No images could be extracted from attached files');

            // Step 2: build universal prompt
            _updateThinking('🧠 Thinking deeply with frontier AI…');
            var visionPrompt = buildUniversalVisionPrompt(msg, intent);

            // Step 3: call AI — frontier mode if user wants high accuracy / deep analysis
            var preferFrontier = intent.deepAnalysis || intent.highAccuracy || intent.fullDetails;
            var reply = await callMultiImageAI(allImages, visionPrompt, preferFrontier, _updateThinking);

            _hideThinking();

            if (typeof window.appendAIMessage === 'function') window.appendAIMessage('bot', reply);

            // Save to history
            if (typeof window.getAIHistory === 'function' && typeof window.saveAIHistory === 'function') {
                var hist = window.getAIHistory();
                var summary = (msg || '(no text)') + ' [📎 ' + attachments.length + ' file' + (attachments.length > 1 ? 's' : '') + ']';
                hist.push({ role: 'user', content: summary, ts: Date.now() });
                hist.push({ role: 'assistant', content: reply, ts: Date.now() });
                window.saveAIHistory(hist);
            }
        } catch (err) {
            _hideThinking();
            console.error('[' + V5 + '] AI chat send failed:', err);
            if (typeof window.appendAIMessage === 'function') {
                window.appendAIMessage('bot', '⚠️ I had trouble processing those files: ' + err.message);
            }
        }
    }

    function escapeHtml(s) {
        return String(s || '').replace(/[&<>"]/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
        });
    }

    /* =========================================================================
     * 28. MULTI-IMAGE AI CALL — sends all images to vision pipeline with
     *     intelligent routing.
     *
     *     - If 1 image: vision-scan (works as before)
     *     - If 2-15 images: parallel vision-scan calls, then synthesis call
     * ========================================================================= */
    // ── MULTI-PROVIDER VISION CASCADE ───────────────────────────────────────
    // Tries several vision engines in order. Returns text, or null only if
    // EVERY engine failed (caller then shows an honest error — never a
    // generic chat reply that ignores the image).
    var _GEMINI_VISION_KEYS = [
        'AIzaSyCU6KyYWjUg7Iikf3XdYteCiJnbJ_2ZZCQ',
        'AIzaSyBpIRHoNQJTeMIVYime_oVjBXiQWNH18K4'
    ];
    var _GROQ_VISION_KEY = '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';

    async function _geminiVision(images, prompt) {
        var keys = [];
        try {
            var st = window.DB ? window.DB.getObj('settings', {}) : {};
            if (st.geminiKey) keys.push(st.geminiKey);
        } catch (_) {}
        keys = keys.concat(_GEMINI_VISION_KEYS);
        var parts = [{ text: prompt }];
        images.slice(0, 6).forEach(function (b64) {
            parts.push({ inline_data: { mime_type: 'image/jpeg', data: b64 } });
        });
        var models = ['gemini-2.5-flash', 'gemini-2.0-flash', 'gemini-2.5-pro', 'gemini-2.0-flash-exp', 'gemini-1.5-pro', 'gemini-1.5-flash'];
        for (var k = 0; k < keys.length; k++) {
            for (var m = 0; m < models.length; m++) {
                try {
                    var r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + models[m] + ':generateContent?key=' + keys[k], {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ contents: [{ parts: parts }], generationConfig: { temperature: 0.2, maxOutputTokens: 8192, topP: 0.95 } })
                    });
                    if (r.status === 429 || r.status === 503) continue;     // try next model
                    if (r.status === 404) continue;                         // model name unavailable
                    if (r.status === 400 || r.status === 403) break;        // bad/forbidden key → next key
                    if (!r.ok) continue;
                    var d = await r.json();
                    var t = d && d.candidates && d.candidates[0] && d.candidates[0].content &&
                        d.candidates[0].content.parts && d.candidates[0].content.parts[0] &&
                        d.candidates[0].content.parts[0].text;
                    if (t && t.trim()) { console.log('[' + V5 + '] vision via gemini ' + models[m]); return t.trim(); }
                } catch (e) { console.warn('[' + V5 + '] gemini ' + models[m] + ':', e && e.message); }
            }
        }
        return null;
    }

    async function _groqVision(images, prompt) {
        // Groq Llama Vision — OpenAI-style messages with image_url data URIs
        try {
            var content = [{ type: 'text', text: prompt }];
            images.slice(0, 5).forEach(function (b64) {
                content.push({ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b64 } });
            });
            var models = ['llama-3.2-90b-vision-preview', 'llama-3.2-11b-vision-preview', 'meta-llama/llama-4-scout-17b-16e-instruct'];
            for (var i = 0; i < models.length; i++) {
                try {
                    var r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + _GROQ_VISION_KEY },
                        body: JSON.stringify({ model: models[i], messages: [{ role: 'user', content: content }], temperature: 0.25, max_tokens: 4096 })
                    });
                    if (r.status === 429 || r.status === 503) continue;
                    if (r.status === 404 || r.status === 400) continue;
                    if (!r.ok) continue;
                    var d = await r.json();
                    var t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
                    if (t && t.trim()) { console.log('[' + V5 + '] vision via groq ' + models[i]); return t.trim(); }
                } catch (e) { console.warn('[' + V5 + '] groq ' + models[i] + ':', e && e.message); }
            }
        } catch (e) { console.warn('[' + V5 + '] groq vision:', e && e.message); }
        return null;
    }

    async function _backendVision(images, prompt) {
        // Vercel /api/ai (server has Gemini/Groq/Ollama vision with server keys)
        try {
            var r = await fetch(_apiBase() + '/ai', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: prompt, image: images[0].base64 })
            });
            if (r.ok) {
                var d = await r.json();
                if (d && d.reply && d.reply.trim()) { console.log('[' + V5 + '] vision via backend ' + (d.provider || '')); return d.reply.trim(); }
            }
        } catch (e) { console.warn('[' + V5 + '] backend vision:', e && e.message); }
        return null;
    }

    async function callMultiImageAI(images, prompt, preferFrontier, onProgress) {
        if (!images || !images.length) throw new Error('No image data');
        console.log('[' + V5 + '] vision cascade start — ' + images.length + ' image(s), first b64 len=' + (images[0].base64 ? images[0].base64.length : 0));

        // Engine 1: Gemini direct (multi-key, multi-model)
        if (onProgress) onProgress('🔍 Analysing the image…');
        var out = await _geminiVision(images, prompt);
        if (out) return out;

        // Engine 2: Groq Llama Vision
        if (onProgress) onProgress('🔎 Cross-checking with a second vision engine…');
        out = await _groqVision(images, prompt);
        if (out) return out;

        // Engine 3: Vercel backend (server-side keys, more providers)
        if (onProgress) onProgress('🛰️ Trying the secure backend…');
        out = await _backendVision(images, prompt);
        if (out) return out;

        // Engine 4: vision-scan OCR pipeline (last resort, then reason over text)
        try {
            var hasVS = await isEndpointAvailable('/vision-scan');
            if (hasVS) {
                if (onProgress) onProgress('🧬 Deep OCR pass…');
                var rr = await fetch(_apiBase() + '/vision-scan', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ image: images[0].base64, mode: 'frontier',
                        hints: { taskType: 'universal_vision', customPrompt: prompt } })
                });
                if (rr.ok) {
                    var dd = await rr.json();
                    if (dd && dd.result && (dd.result.raw_text || dd.result.description)) {
                        var seen = dd.result.description || dd.result.raw_text;
                        if (typeof window.callAI === 'function') {
                            return await window.callAI(prompt + '\n\n[Vision system extracted this from the image: ' + seen + ']\nAnswer the user using this.');
                        }
                        return seen;
                    }
                }
            }
        } catch (e) { console.warn('[' + V5 + '] vision-scan last resort:', e && e.message); }

        // ALL vision engines failed — be honest, don't fake a chat reply.
        throw new Error('VISION_ALL_FAILED');
    }

    async function _legacyCallMultiImageAI(images, prompt, preferFrontier, onProgress) {
        var hasVisionScan = await isEndpointAvailable('/vision-scan');
        if (!hasVisionScan && typeof window.callAI === 'function') {
            return await window.callAI(prompt, images[0].base64);
        }

        if (images.length === 1) {
            // Single image path — use frontier or deep mode
            if (onProgress) onProgress('🔍 Frontier vision analysing…');
            try {
                var r = await fetch(_apiBase() + '/vision-scan', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        image: images[0].base64,
                        mode: preferFrontier ? 'frontier' : 'ultra',
                        hints: {
                            today: new Date().toISOString().split('T')[0],
                            currency: 'LKR',
                            taskType: 'universal_vision',
                            customPrompt: prompt
                        }
                    })
                });
                if (r.ok) {
                    var data = await r.json();
                    // If we got structured receipt data AND it wasn't asked for, fall through to chat
                    if (data.result && data.result.raw_text) {
                        if (onProgress) onProgress('💭 Reasoning over what I saw…');
                        // Pass the OCR text + structured info + user's question to chat AI
                        var chatPrompt = prompt + '\n\nWhat I saw in the image (extracted by vision OCR):\n' +
                                          'Raw text:\n' + data.result.raw_text + '\n\nStructured data:\n' +
                                          JSON.stringify(data.result, null, 2);
                        if (typeof window.callAI === 'function') {
                            return await window.callAI(chatPrompt);
                        }
                    }
                }
            } catch (e) {
                console.warn('[' + V5 + '] frontier path failed, falling back:', e.message);
            }
            // Direct vision call via callAI
            if (typeof window.callAI === 'function') {
                return await window.callAI(prompt, images[0].base64);
            }
            throw new Error('No vision pipeline available');
        }

        // Multi-image path: send each to vision OCR, gather text, then synthesise
        if (onProgress) onProgress('🔄 Reading ' + images.length + ' images in parallel…');
        var ocrPromises = images.map(function (img, idx) {
            return fetch(_apiBase() + '/vision-scan', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    image: img.base64,
                    mode: 'deep',
                    hints: { today: new Date().toISOString().split('T')[0], taskType: 'universal_vision' }
                })
            }).then(function (r) { return r.ok ? r.json() : null; })
              .catch(function () { return null; });
        });
        var results = await Promise.all(ocrPromises);

        if (onProgress) onProgress('🧬 Synthesising findings…');
        var summary = results.map(function (res, idx) {
            if (!res || !res.result) return 'Image ' + (idx + 1) + ' (' + images[idx].sourceFile + '): could not be read';
            return 'Image ' + (idx + 1) + ' (' + images[idx].sourceFile +
                (images[idx].isPdf ? ' p.' + images[idx].page : '') +
                '):\n' + (res.result.raw_text || JSON.stringify(res.result, null, 2));
        }).join('\n\n');

        var synthesisPrompt = prompt + '\n\nVision OCR extracted the following from ' +
            images.length + ' attached files:\n\n' + summary +
            '\n\nNow answer the user using ALL of this evidence cross-referenced.';

        if (typeof window.callAI === 'function') {
            return await window.callAI(synthesisPrompt);
        }
        throw new Error('No AI synthesis pipeline available');
    }

    /* =========================================================================
     * 29. PATCH sendAIMessage to detect attachments and route correctly
     * ========================================================================= */
    function patchSendAIMessageV5() {
        if (typeof window.sendAIMessage === 'function' && !window.sendAIMessage._v5patched) {
            _originalSendAIMessage = window.sendAIMessage;
            window.sendAIMessage = sendAIMessageV5;
            window.sendAIMessage._v5patched = true;
            console.log('[' + V5 + '] sendAIMessage patched ✓');
        }
    }

    /* =========================================================================
     * 30. ATTACH BUTTON UPGRADE — replace the single-file `ai_chat_scan` flow
     *     with the multi-file rail handler
     * ========================================================================= */
    function patchAIChatAttachButton() {
        var inp = document.getElementById('ai_chat_scan');
        if (!inp) return false;
        if (inp._v5patched) return true;
        inp.multiple = true;
        inp.accept = 'image/*,image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.pdf,.PDF';
        // Bind the multi-attach handler directly (in addition to the inline
        // _aiChatFilePicked bridge, which also routes here — belt & braces so
        // attaching works even before/after this patch runs).
        inp.onchange = function (e) {
            try { handleAIChatMultiAttach(e); }
            catch (err) { console.error('[' + V5 + '] attach error:', err); }
        };
        inp._v5patched = true;
        // expose for the host inline bridge
        window.handleAIChatMultiAttach = handleAIChatMultiAttach;
        return true;
    }

    /* =========================================================================
     * 31. INSTALL all v5 patches as soon as host is ready
     * ========================================================================= */
    function _installV5Patches() {
        try {
            // 1. Replace overlay functions
            window._showScanOverlay = _showScanOverlayV5;
            window._hideScanOverlay = _hideScanOverlayV5;
            // 2. Patch DB.set guard
            _patchDBset();
            // 3. Install snapshot guard loop
            _installSnapshotGuard();
            // 4. Patch file inputs
            patchFileInputsV5();
            // 5. Patch AI chat attach
            patchAIChatAttachButton();
            // 5b. Install drag & drop zone
            try { _installAIDropZone(); } catch (_) {}
            // 6. Patch sendAIMessage
            patchSendAIMessageV5();
            console.log('[' + V5 + '] All v5 patches installed ✓');
        } catch (e) {
            console.error('[' + V5 + '] install error:', e);
        }
    }

    // Run install after DOM is ready and the host's globals are present
    whenReady(function () {
        // Three ways the host can expose state, ordered by preference:
        //   1. window.DB + window.appData (v6.9+ index.html)
        //   2. window._wfHostState getter (also v6.9+)
        //   3. notify function as a weak signal that the host has booted
        return (typeof window.DB !== 'undefined' && typeof window.appData !== 'undefined')
            || (typeof window._wfHostState === 'object')
            || (typeof window.notify === 'function' && typeof window.handleAIScan === 'function');
    }, function () {
        _installV5Patches();
        // Re-run patch every 4 seconds for the first 60s in case the host re-renders elements
        var attempts = 0;
        var patchInterval = setInterval(function () {
            try {
                patchFileInputsV5();
                patchAIChatAttachButton();
                try { _installAIDropZone(); } catch (_) {}
                patchSendAIMessageV5();
                _patchDBset();
            } catch (_) {}
            if (++attempts > 15) clearInterval(patchInterval);
        }, 4000);
    }, 15000);

    /* =========================================================================
     * 32. PUBLIC v5 DEBUG OBJECT
     * ========================================================================= */
    // ── Robust "send with vision" — used by the host's native image path ──
    // Sends ALL attached images to a vision-capable model and shows the reply.
    // ── DRAG & DROP files/images onto the AI chat ───────────────────────────
    function _installAIDropZone() {
        var zone = document.getElementById('aiChatMessages');
        var card = document.getElementById('page-ai');
        if (!zone || zone._wfDrop) return;
        zone._wfDrop = true;

        var overlay = document.createElement('div');
        overlay.id = 'aiDropOverlay';
        overlay.style.cssText = 'position:absolute;inset:0;z-index:50;display:none;align-items:center;justify-content:center;' +
            'background:rgba(13,29,60,0.82);backdrop-filter:blur(3px);border:2.5px dashed #d4af37;border-radius:14px;' +
            'font-size:17px;font-weight:700;color:#fff;pointer-events:none;text-align:center;';
        overlay.innerHTML = '<div>📎 Drop your image or file here<br><span style="font-size:12px;font-weight:500;opacity:.85;">Photos, screenshots, PDFs — I\'ll read them</span></div>';
        // The chat messages box needs a positioned parent for the overlay.
        var host = zone.parentElement || zone;
        if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
        host.appendChild(overlay);

        var dragDepth = 0;
        function show() { overlay.style.display = 'flex'; }
        function hide() { overlay.style.display = 'none'; dragDepth = 0; }

        ['dragenter', 'dragover'].forEach(function (ev) {
            host.addEventListener(ev, function (e) {
                if (e.dataTransfer && Array.prototype.some.call(e.dataTransfer.types || [], function (t) { return t === 'Files'; })) {
                    e.preventDefault(); e.stopPropagation();
                    if (ev === 'dragenter') dragDepth++;
                    show();
                }
            });
        });
        host.addEventListener('dragleave', function (e) {
            dragDepth--;
            if (dragDepth <= 0) hide();
        });
        host.addEventListener('drop', function (e) {
            e.preventDefault(); e.stopPropagation();
            hide();
            var files = e.dataTransfer && e.dataTransfer.files ? Array.prototype.slice.call(e.dataTransfer.files) : [];
            if (!files.length) return;
            // Reuse the exact same attach pipeline (progress ring + send lock).
            handleAIChatMultiAttach({ target: { files: files, value: '' } });
        });
        console.log('[' + V5 + '] drag & drop zone installed ✓');
    }

    // Expose the attach handler globally so the host's inline bridge can
    // call it even before the patch cycle runs.
    window.handleAIChatMultiAttach = handleAIChatMultiAttach;

    window._wfSendWithVision = async function (userMsg) {
        var atts = _aiChatAttachments.slice();
        if (atts.length === 0) {
            // Nothing attached — let the normal text flow handle it.
            if (typeof _originalSendAIMessage === 'function') return _originalSendAIMessage(userMsg);
            return;
        }
        if (atts.some(function (a) { return a && a.uploading; })) {
            if (window.notify) window.notify('⏳ Files still uploading…', 'info');
            return;
        }

        var inputEl = document.getElementById('aiChatInput');
        if (inputEl) { inputEl.value = ''; if (window.autoResizeAIInput) window.autoResizeAIInput(inputEl); }

        // Show the user's message with image thumbnails
        if (typeof window.appendAIMessage === 'function') {
            var thumbs = atts.map(function (a) {
                if (a.isPdf) return '<div style="display:inline-block;width:78px;height:78px;border-radius:8px;background:linear-gradient(135deg,#1e293b,#0f172a);color:#fbbf24;display:inline-flex;align-items:center;justify-content:center;font-size:22px;margin:2px;border:1px solid rgba(212,175,55,0.3);">📄</div>';
                return '<img src="' + a.preview + '" style="display:inline-block;width:78px;height:78px;object-fit:cover;border-radius:8px;margin:2px;border:1px solid rgba(212,175,55,0.3);">';
            }).join('');
            var uhtml = '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-bottom:6px;">' + thumbs + '</div>' +
                (userMsg ? '<div>' + escapeHtml(userMsg) + '</div>' : '<div style="opacity:.7;font-style:italic;">(What is in this? Please analyse.)</div>');
            window.appendAIMessage('user', uhtml, true);
        }

        // Clear the rail + unlock
        _aiChatAttachments = [];
        _renderAttachmentRail();
        _setSendLock(false);

        _showThinking('👁️ Looking at your ' + (atts.length > 1 ? atts.length + ' files' : 'image') + '…');

        try {
            // Extract base64 images (compress, PDFs → pages)
            var imgs = [];
            for (var i = 0; i < atts.length && imgs.length < 15; i++) {
                try {
                    var b = await fileToImagesV4(atts[i].file, { maxPages: 3, maxBytes: 3.8 * 1024 * 1024, enhance: true });
                    for (var p = 0; p < b.images.length && imgs.length < 15; p++) {
                        imgs.push(b.images[p]);
                    }
                } catch (eX) { console.warn('[' + V5 + '] extract failed:', eX && eX.message); }
            }
            if (imgs.length === 0) throw new Error('Could not read the attached image(s)');

            _updateThinking('🧠 Analysing in depth…');

            // Build a STRONG vision instruction so the model never ignores it.
            var uName = (window.currentUser && window.currentUser.displayName)
                ? window.currentUser.displayName.split(' ')[0] : 'there';
            var lang = 'English';
            try {
                var st = window.DB ? window.DB.getObj('settings', {}) : {};
                if (st.aiResponseLang && window.WF_LANG_NAMES) lang = window.WF_LANG_NAMES[st.aiResponseLang] || 'English';
            } catch (_) {}

            var visionPrompt =
                'You are WealthFlow AI — a world-class multimodal expert with state-of-the-art computer vision, OCR and reasoning, and a warm best-friend tone. ' +
                'The user ' + uName + ' attached ' + imgs.length + ' image' + (imgs.length > 1 ? 's' : '') + '.\n\n' +
                'YOU CAN FULLY SEE THE IMAGE(S). Examine every detail with maximum accuracy:\n' +
                '• Read ALL visible text precisely (badges, plates, labels, screens, fine print) — OCR it exactly.\n' +
                '• Identify the subject exactly. Vehicle → exact make, model, generation, year, trim/variant, body style, colour, drivetrain, market; cross-check badges, headlight/grille/wheel design, proportions before deciding. If the user corrects you, RE-EXAMINE honestly and verify — do not just agree to please them, and do not stubbornly repeat a wrong guess; reason from visual evidence.\n' +
                '• Documents/receipts/screenshots → extract every number, date, party, line item.\n' +
                '• High-end / cutting-edge technology → identify it precisely: EVs & hybrids (battery kWh, range, motor kW, charging), dot-matrix / LED / LCD / e-ink displays, dot-matrix printers & their printout, semiconductors & chips (markings, package), industrial/medical/aerospace equipment, drones, robotics, lab instruments, network gear, server hardware. Read any model/serial/part numbers exactly.\n' +
                '• Objects/scenes → describe precisely with materials, brands, context.\n' +
                'Be confident and specific; only say "unclear" for genuinely illegible parts. Never claim you cannot see images.\n\n' +
                '⚙️ OUTPUT FORMAT — OBEY THE USER\'S REQUEST EXACTLY:\n' +
                '• If they ask for a TABLE or "compare" → output a proper GitHub-flavoured Markdown table. ALWAYS include the separator row (| --- | --- |) after the header.\n' +
                '• If they ask for CHARTS / diagrams / graphs → output one or more fenced ```chart code blocks containing JSON: ' +
                '{"type":"bar|line|pie|radar","title":"...","labels":[...],"datasets":[{"label":"...","data":[...]}]}. ' +
                'CRITICAL: data arrays must contain ONLY pure numbers (e.g. 190, not "190 HP"; 35000, not "$35,000"). ' +
                'NEVER mix different units in one chart (do NOT put horsepower 190 next to price 35000 — the small bars vanish). ' +
                'Instead make a SEPARATE chart per metric (one for Horsepower, one for Price, one for Fuel Economy) OR put each metric as its own labelled dataset on its own chart. Put the unit in the title or label. ' +
                'Also give the same data as a Markdown table so nothing is lost.\n' +
                '• If they ask for ANALYSIS / research / deep research → structured analysis with clear headings, bullet points, evidence and a verdict; for "deep research" be exhaustive and thorough.\n' +
                '• If they ask "simple"/"shortly"/"brief" → a short, direct answer with no fluff. If they ask "full"/"all details"/"everything" → be comprehensive and exhaustive.\n' +
                '• Comparison of 2+ things → full spec table + a SEPARATE chart for each numeric metric + a short verdict.\n' +
                'Use real, accurate, up-to-date figures from your knowledge; if a figure varies by market, say the typical value and note it.\n\n' +
                'USER\'S REQUEST: ' + (userMsg || 'Identify this and give full details, a comparison table, and charts where useful.') + '\n\n' +
                'Reply warmly like a knowledgeable friend, in ' + lang + '. Lead with the direct answer, then deliver EXACTLY the format(s) requested (table/charts/analysis).';

            var reply = await callMultiImageAI(
                imgs.map(function (b64, idx) { return { base64: b64, sourceFile: atts[Math.min(idx, atts.length - 1)].name || ('image' + idx), isPdf: false, page: 1 }; }),
                visionPrompt, true, _updateThinking
            );

            _hideThinking();
            if (typeof window.appendAIMessage === 'function') window.appendAIMessage('bot', reply);

            // Persist to history (text summary; images aren't stored)
            try {
                if (window.getAIHistory && window.saveAIHistory) {
                    var h = window.getAIHistory();
                    h.push({ role: 'user', content: (userMsg || '(image)') + ' [📎 ' + atts.length + ' file' + (atts.length > 1 ? 's' : '') + ']', ts: Date.now() });
                    h.push({ role: 'assistant', content: reply, ts: Date.now() });
                    window.saveAIHistory(h);
                }
            } catch (_) {}

            try {
                if (window.WealthFlowML && window.WealthFlowML.observe) {
                    window.WealthFlowML.observe(userMsg || '(image question)', reply, 'image_analyze');
                }
            } catch (_) {}
            if (typeof window._updateAIContextPills === 'function') window._updateAIContextPills();
        } catch (err) {
            _hideThinking();
            console.error('[' + V5 + '] vision send failed:', err);
            var emsg = (err && err.message) ? err.message : 'unknown error';
            var friendly;
            if (emsg === 'VISION_ALL_FAILED') {
                friendly = '😔 I tried several vision engines but none could read the image right now ' +
                    '(the AI vision services may be temporarily rate-limited). Your image was received correctly — ' +
                    'please try again in a minute, or describe what you\'d like me to look at and I\'ll do my best.';
            } else if (/Could not read|extract/i.test(emsg)) {
                friendly = '⚠️ I couldn\'t decode that file. Please try a JPG/PNG photo or a clearer image.';
            } else {
                friendly = '⚠️ I had trouble reading that image: ' + emsg + '. Please try again, or send a clearer photo.';
            }
            if (typeof window.appendAIMessage === 'function') window.appendAIMessage('bot', friendly);
        }
    };

    window.WF_AI_V5 = {
        version: V5,
        get attachments() { return _aiChatAttachments; },
        _removeAttachment: _removeAttachment,
        sendWithVision: window._wfSendWithVision,
        utils: {
            showThinking: _showThinking,
            hideThinking: _hideThinking,
            showScanOverlay: _showScanOverlayV5,
            hideScanOverlay: _hideScanOverlayV5,
            parseUserIntent: parseUserIntent,
            buildUniversalVisionPrompt: buildUniversalVisionPrompt,
            installPatches: _installV5Patches,
            guardState: _localWriteGuard,
            callMultiImageAI: callMultiImageAI
        }
    };
})();

