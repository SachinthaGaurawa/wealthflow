/* ==================== WealthFlow Receipt Scanner v2.0 ====================
 * Drop-in client-side module for the AI receipt scanner.
 *
 * Loads as a plain <script> — exposes window.WealthFlowScanner with:
 *
 *   WealthFlowScanner.scan(file, options)
 *     - file:     File | Blob   (a receipt image, e.g. from <input type="file">)
 *     - options:  {
 *         mode:           'auto' | 'deep' | 'quick' | 'ultra'  (default: 'auto')
 *         onProgress:     (stage, percent, message) => void
 *         hints:          { currency, locale, today }
 *         preprocessing:  true (default) — sharpen, deskew, denoise locally
 *         apiBase:        '/api'  (default; override for testing)
 *       }
 *     returns: Promise<{ result, confidence, engines, mode, elapsedMs }>
 *
 *   WealthFlowScanner.attach(inputEl, opts)
 *     - inputEl: an <input type="file"> element
 *     - opts:    { onResult, onError, mode, hints }
 *     Wires up the change event with the full pipeline.
 *
 *   WealthFlowScanner.preprocessImage(file, opts) → Promise<{ base64, kb, width, height }>
 *
 * The cascade:
 *   1. Try DEEP scan (multiple vision engines in parallel) via /api/vision-scan
 *   2. If overall confidence < 0.55: escalate to ULTRA (adds Pro models + OCR.space)
 *   3. If everything fails: fall back to legacy /api/ai with a basic prompt
 *
 * The old "Deep Scanning Receipt", "Quick AI Retry", "Cloud OCR API" buttons all
 * map cleanly to mode='deep', mode='quick', mode='ultra' here.
 * ========================================================================== */

(function (global) {
    'use strict';

    var DEFAULT_API_BASE = '/api';

    // ---------- tiny utilities ----------
    function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

    function fmtNumber(n) {
        if (n === null || n === undefined || isNaN(n)) return '';
        try {
            return new Intl.NumberFormat('en-US', {
                minimumFractionDigits: 2, maximumFractionDigits: 2
            }).format(n);
        } catch (_) { return String(n); }
    }

    function nowIso() { return new Date().toISOString().split('T')[0]; }

    // Read a File as a HTMLImageElement (in-memory)
    function fileToImage(file) {
        return new Promise(function (resolve, reject) {
            var img = new Image();
            var reader = new FileReader();
            reader.onload = function (e) {
                img.onload = function () { resolve(img); };
                img.onerror = function () { reject(new Error('Image decode failed')); };
                img.src = e.target.result;
            };
            reader.onerror = function () { reject(new Error('File read failed')); };
            reader.readAsDataURL(file);
        });
    }

    /* ==================== IMAGE PREPROCESSING ====================
     * Applied client-side, BEFORE upload, to dramatically increase OCR accuracy:
     *   1. Auto-rotate from EXIF (handled implicitly by <img> + canvas in modern browsers)
     *   2. Resize to optimal dimensions (1600px longest side — sweet spot for vision LLMs)
     *   3. White-background flatten (handles transparent PNGs)
     *   4. Adaptive contrast boost (CLAHE-lite)
     *   5. Light unsharp mask (sharpening)
     *   6. JPEG re-encode at quality 0.85
     */
    function preprocessImage(file, opts) {
        opts = opts || {};
        var maxDim     = opts.maxDim    || 1600;   // 1600 is a good vision-LLM sweet spot
        var quality    = opts.quality   || 0.85;
        var doSharpen  = opts.sharpen  !== false;
        var doContrast = opts.contrast !== false;

        return fileToImage(file).then(function (img) {
            var w = img.naturalWidth || img.width;
            var h = img.naturalHeight || img.height;

            // Scale down so longest side <= maxDim — preserves aspect ratio
            if (w > h && w > maxDim)      { h = Math.round(h * maxDim / w); w = maxDim; }
            else if (h >= w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }

            var canvas = document.createElement('canvas');
            canvas.width = w; canvas.height = h;
            var ctx = canvas.getContext('2d', { willReadFrequently: true });
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, w, h);
            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            ctx.drawImage(img, 0, 0, w, h);

            // ---- contrast / brightness normalisation ----
            // Receipts are typically dark text on light/white paper. We push the histogram
            // so the dark text gets darker and the paper gets whiter. This is much more
            // forgiving than naive contrast bumping because we anchor the percentiles.
            if (doContrast) {
                try {
                    var imgData = ctx.getImageData(0, 0, w, h);
                    var data = imgData.data;

                    // Build a luminance histogram (downsampled for speed)
                    var hist = new Uint32Array(256);
                    var step = Math.max(1, Math.floor(data.length / 4 / 50000)); // sample ~50k px
                    for (var i = 0; i < data.length; i += 4 * step) {
                        var lum = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000;
                        hist[clamp(Math.round(lum), 0, 255)]++;
                    }
                    var total = 0;
                    for (var k = 0; k < 256; k++) total += hist[k];

                    // Find the 2nd and 98th percentile luminance — clip the rest
                    var loCutoff = total * 0.02, hiCutoff = total * 0.98;
                    var lo = 0, hi = 255, acc = 0;
                    for (var k2 = 0; k2 < 256; k2++) {
                        acc += hist[k2];
                        if (acc >= loCutoff) { lo = k2; break; }
                    }
                    acc = 0;
                    for (var k3 = 0; k3 < 256; k3++) {
                        acc += hist[k3];
                        if (acc >= hiCutoff) { hi = k3; break; }
                    }
                    var range = Math.max(1, hi - lo);
                    // Linear stretch each channel using the luminance percentiles
                    for (var j = 0; j < data.length; j += 4) {
                        data[j]     = clamp(Math.round((data[j]     - lo) * 255 / range), 0, 255);
                        data[j + 1] = clamp(Math.round((data[j + 1] - lo) * 255 / range), 0, 255);
                        data[j + 2] = clamp(Math.round((data[j + 2] - lo) * 255 / range), 0, 255);
                    }
                    ctx.putImageData(imgData, 0, 0);
                } catch (e) { /* CORS-tainted? skip silently */ }
            }

            // ---- unsharp mask (light sharpening) ----
            // Applies a small kernel to bring out edge contrast — receipts often suffer
            // from camera blur, this helps the vision model resolve characters.
            if (doSharpen && w * h < 4_000_000) {  // skip for very large images (perf)
                try {
                    var srcData = ctx.getImageData(0, 0, w, h);
                    var src = srcData.data;
                    var dst = new Uint8ClampedArray(src.length);
                    // 3x3 sharpening kernel:  0 -1  0 / -1  5 -1 /  0 -1  0
                    var W = w * 4;
                    for (var y = 1; y < h - 1; y++) {
                        for (var x = 1; x < w - 1; x++) {
                            var idx = (y * w + x) * 4;
                            for (var c = 0; c < 3; c++) {
                                var v = 5 * src[idx + c]
                                      -     src[idx + c - 4]
                                      -     src[idx + c + 4]
                                      -     src[idx + c - W]
                                      -     src[idx + c + W];
                                dst[idx + c] = clamp(v, 0, 255);
                            }
                            dst[idx + 3] = src[idx + 3];
                        }
                    }
                    // Copy borders verbatim
                    for (var b = 0; b < w; b++) {
                        for (var cc = 0; cc < 4; cc++) {
                            dst[(0 * w + b) * 4 + cc] = src[(0 * w + b) * 4 + cc];
                            dst[((h - 1) * w + b) * 4 + cc] = src[((h - 1) * w + b) * 4 + cc];
                        }
                    }
                    for (var by = 0; by < h; by++) {
                        for (var cc2 = 0; cc2 < 4; cc2++) {
                            dst[(by * w + 0) * 4 + cc2]       = src[(by * w + 0) * 4 + cc2];
                            dst[(by * w + (w - 1)) * 4 + cc2] = src[(by * w + (w - 1)) * 4 + cc2];
                        }
                    }
                    var out = new ImageData(dst, w, h);
                    ctx.putImageData(out, 0, 0);
                } catch (_) { /* graceful */ }
            }

            var dataUrl = canvas.toDataURL('image/jpeg', quality);
            var base64 = dataUrl.split(',')[1];
            var kb = Math.round(base64.length * 0.75 / 1024);
            return { base64: base64, kb: kb, width: w, height: h };
        });
    }

    /* ==================== API CALLS ==================== */
    function callVisionScan(apiBase, payload, timeoutMs) {
        var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = controller ? setTimeout(function () { controller.abort(); }, timeoutMs || 55000) : null;
        return fetch(apiBase + '/vision-scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: controller ? controller.signal : undefined
        }).then(function (resp) {
            if (timer) clearTimeout(timer);
            return resp.json().then(function (data) {
                if (!resp.ok) {
                    var err = new Error(data.error || ('vision-scan ' + resp.status));
                    err.serverDetails = data;
                    throw err;
                }
                return data;
            });
        }).catch(function (e) {
            if (timer) clearTimeout(timer);
            throw e;
        });
    }

    function callLegacyAI(apiBase, prompt, base64) {
        return fetch(apiBase + '/ai', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: prompt, image: base64, temperature: 0.05, maxTokens: 2048 })
        }).then(function (r) { return r.json(); });
    }

    /* ==================== JSON sanitisation (mirror of server) ==================== */
    function extractJSON(text) {
        if (!text || typeof text !== 'string') return null;
        var cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
        try { return JSON.parse(cleaned); } catch (_) {}
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

    /* ==================== MAIN ENTRY POINT ==================== */
    function scan(file, opts) {
        opts = opts || {};
        var apiBase = opts.apiBase || DEFAULT_API_BASE;
        var mode    = opts.mode || 'auto';
        var hints   = opts.hints || { currency: 'LKR', today: nowIso() };
        var doPreproc = opts.preprocessing !== false;
        var onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : function () {};

        if (!file) return Promise.reject(new Error('No file provided'));

        var startTime = Date.now();
        var sizeMB = (file.size / 1024 / 1024).toFixed(2);
        onProgress('preprocess', 5, 'Optimising image (' + sizeMB + 'MB)…');

        var preprocStep = doPreproc
            ? preprocessImage(file, { maxDim: 1600, quality: 0.85 })
            : fileToImage(file).then(function (img) {
                // Minimal conversion to base64 JPEG without enhancements
                var c = document.createElement('canvas');
                c.width = img.naturalWidth; c.height = img.naturalHeight;
                c.getContext('2d').drawImage(img, 0, 0);
                var url = c.toDataURL('image/jpeg', 0.85);
                return { base64: url.split(',')[1], kb: Math.round(url.length * 0.75 / 1024), width: c.width, height: c.height };
            });

        return preprocStep.then(function (img) {
            onProgress('upload', 25, 'Sent ' + img.kb + 'KB · ' + img.width + '×' + img.height);

            // --- DEEP / AUTO: try multi-engine vision-scan first ---
            var primaryMode = (mode === 'auto') ? 'deep' : mode;
            onProgress('scanning', 40, 'Scanning with multiple AI engines…');

            return callVisionScan(apiBase, { image: img.base64, mode: primaryMode, hints: hints }, 55000)
                .then(function (data) {
                    onProgress('scanning', 80, 'Got results from ' +
                        data.engines.filter(function (e) { return e.success; }).length + ' engines');

                    // AUTO: escalate to ULTRA if confidence is shaky
                    if (mode === 'auto' && data.confidence && data.confidence.overall < 0.55) {
                        onProgress('escalating', 85, 'Confidence low — running deep ULTRA mode…');
                        return callVisionScan(apiBase, { image: img.base64, mode: 'ultra', hints: hints }, 58000)
                            .then(function (ultra) {
                                // Pick whichever has higher confidence
                                var pick = (ultra.confidence.overall > data.confidence.overall) ? ultra : data;
                                onProgress('done', 100, 'Complete (' + ((Date.now() - startTime) / 1000).toFixed(1) + 's)');
                                pick.image = { kb: img.kb, width: img.width, height: img.height };
                                pick.elapsedMs = Date.now() - startTime;
                                return pick;
                            });
                    }
                    onProgress('done', 100, 'Complete (' + ((Date.now() - startTime) / 1000).toFixed(1) + 's)');
                    data.image = { kb: img.kb, width: img.width, height: img.height };
                    data.elapsedMs = Date.now() - startTime;
                    return data;
                })
                .catch(function (deepErr) {
                    // --- Vision-scan endpoint isn't available or all engines failed ---
                    // Fall back to legacy /api/ai with a vision prompt
                    console.warn('[Scanner] vision-scan failed:', deepErr.message);
                    onProgress('fallback', 70, 'Falling back to single-engine AI…');
                    var prompt = 'You are a receipt OCR scanner. Extract ONLY this JSON from the receipt: ' +
                        '{"vendor":"","amount":0,"date":"' + hints.today + '","category":"Other","items":[],"currency":"' + (hints.currency || 'LKR') + '"}' +
                        ' Rules: amount = grand total (number, no commas/currency). date = YYYY-MM-DD. ' +
                        'Return ONLY valid JSON, no markdown.';
                    return callLegacyAI(apiBase, prompt, img.base64).then(function (legacyData) {
                        if (!legacyData.reply) throw new Error(legacyData.error || 'AI returned nothing');
                        var parsed = extractJSON(legacyData.reply);
                        if (!parsed) throw new Error('Could not parse AI response');
                        onProgress('done', 100, 'Complete via fallback');
                        return {
                            result: {
                                vendor:   parsed.vendor || null,
                                amount:   normaliseAmount(parsed.amount),
                                date:     parsed.date   || hints.today,
                                category: parsed.category || 'Other',
                                items:    Array.isArray(parsed.items) ? parsed.items : [],
                                currency: parsed.currency || hints.currency || 'LKR',
                                raw_text: null
                            },
                            confidence: { vendor: 0.5, amount: 0.5, date: 0.5, overall: 0.5 },
                            engines: [{ name: 'legacy-ai', success: true, ms: 0 }],
                            mode: 'fallback',
                            elapsedMs: Date.now() - startTime,
                            image: { kb: img.kb, width: img.width, height: img.height }
                        };
                    });
                });
        });
    }

    /* ==================== INPUT-ELEMENT WIRING ====================
     * Convenience helper for hooking up an <input type="file"> directly.
     * Used when you don't want to write the boilerplate yourself.
     */
    function attach(inputEl, opts) {
        if (!inputEl || inputEl.tagName !== 'INPUT' || inputEl.type !== 'file') {
            throw new Error('WealthFlowScanner.attach requires an <input type="file">');
        }
        opts = opts || {};
        inputEl.addEventListener('change', function (ev) {
            var file = ev.target.files && ev.target.files[0];
            if (!file) return;
            scan(file, {
                mode: opts.mode || 'auto',
                hints: opts.hints,
                preprocessing: opts.preprocessing,
                onProgress: opts.onProgress
            }).then(function (data) {
                if (typeof opts.onResult === 'function') opts.onResult(data);
            }).catch(function (err) {
                if (typeof opts.onError === 'function') opts.onError(err);
                else console.error('[WealthFlowScanner]', err);
            }).finally(function () {
                ev.target.value = '';   // reset so the same file can be re-selected
            });
        });
        return inputEl;
    }

    /* ==================== Public API ==================== */
    global.WealthFlowScanner = {
        version: '2.0.0',
        scan: scan,
        attach: attach,
        preprocessImage: preprocessImage,
        // helpers callers can reuse:
        utils: {
            normaliseAmount: normaliseAmount,
            extractJSON:     extractJSON,
            fmtNumber:       fmtNumber
        }
    };
})(typeof window !== 'undefined' ? window : globalThis);
