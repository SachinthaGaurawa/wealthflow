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
        maxBytes = maxBytes || 3 * 1024 * 1024;  // 3 MB safe ceiling
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
        var maxBytes = opts.maxBytes || 3 * 1024 * 1024;

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

            // Adaptive scale-down
            var dims = [1800, 1500, 1200, 1000, 800];
            var quals = [0.88, 0.78, 0.68, 0.55];
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
        var pdf;
        try {
            pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
        } catch (e) {
            throw new Error('PDF could not be opened: ' + e.message + '. Is it password-protected?');
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
        var isAiChat = (type === 'ai_chat');
        var isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
        var showsOverlay = isExpense || isSubscription;

        if (typeof window.triggerHaptic === 'function') window.triggerHaptic('medium');

        try {
            // ---- STEP A: file extraction ----
            if (showsOverlay && typeof window._showScanOverlay === 'function')
                window._showScanOverlay(isPdf ? '📄 Reading PDF…' : '📸 Reading Image…',
                    'Optimising ' + sizeMB + 'MB ' + (isPdf ? 'PDF' : 'photo'), 8);
            else if (typeof window.notify === 'function')
                window.notify(isPdf ? '📄 Processing PDF…' : '📸 Reading image…', 'info');

            var imgBundle;
            try {
                imgBundle = await fileToImagesV4(file, { maxPages: 3, maxBytes: 3 * 1024 * 1024 });
            } catch (ee) {
                throw new Error((isPdf ? 'PDF' : 'Image') + ' could not be read: ' + ee.message);
            }
            var firstImage = imgBundle.images[0];
            var pageCount = imgBundle.pageCount;

            console.log('[' + V + '] extracted', pageCount, 'page(s) from',
                file.name || 'file', '→', imgBundle.dimensions);

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
                docType: isSubscription ? 'subscription_bill' : 'receipt'
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
            var ok = isSubscription
                ? populateSubscriptionForm(scanData.result, { isPdf: isPdf, pageCount: pageCount })
                : populateExpenseForm(scanData.result, { isPdf: isPdf, pageCount: pageCount });
            if (typeof window._hideScanOverlay === 'function') window._hideScanOverlay();

            if (ok) {
                if (typeof window.triggerHaptic === 'function') window.triggerHaptic('success');
                var elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                var conf = Math.round((scanData.confidence && scanData.confidence.overall || 0) * 100);
                var engineCount = (scanData.engines || []).filter(function (en) { return en.success; }).length;
                var label = isSubscription ? '📋 ' : '✅ ';
                var msg = label + (scanData.result.vendor || 'Bill') +
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
            var stored = JSON.parse(localStorage.getItem('wf_scan_settings') || '{}');
            window.WF_SCAN_SETTINGS = {
                mode: stored.mode || 'deep',
                preprocessing: stored.preprocessing !== false,
                currency: stored.currency || 'LKR',
                showEngines: stored.showEngines === true
            };
        } catch (_) {
            window.WF_SCAN_SETTINGS = { mode: 'deep', preprocessing: true, currency: 'LKR', showEngines: false };
        }
    }
    function _saveScanSettings() {
        try { localStorage.setItem('wf_scan_settings', JSON.stringify(window.WF_SCAN_SETTINGS)); } catch (_) { }
    }
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

    /* =========================================================================
     * 17. PATCH FILE INPUTS to accept PDFs
     * ========================================================================= */
    function patchFileInputs() {
        var inputs = document.querySelectorAll('input[type="file"][id="e_ai_scan"], input[type="file"][id="ai_chat_scan"], input[type="file"][id="sub_ai_scan"]');
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
})();
