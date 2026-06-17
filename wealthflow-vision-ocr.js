/*  wealthflow-vision-ocr.js — Google Cloud Vision OCR, everywhere  (v7.22)
 *  ===========================================================================
 *  The user asked for Cloud Vision OCR across the WHOLE app — expenses, one-time
 *  CC, bank statements, the CRIB system and the AI advisor — because Cloud Vision
 *  reads dense / small / zoomed-out text far better than generic vision models.
 *
 *  This module:
 *    1. Exposes ONE shared primitive   window.WFVision   used by every consumer:
 *         ocrBase64(b64, opts)  → Promise<string>   (single image)
 *         ocrImages(imgs, opts) → Promise<string>   (multi-page concat)
 *         ocrFile(file, opts)   → Promise<string>   (file → images → OCR)
 *         fileToImages(file)    → Promise<string[]> (memory-safe, iOS-safe)
 *         enrichPrompt(p, img)  → Promise<string>   (prompt + OCR ground-truth)
 *         available()           → boolean
 *
 *    2. Transparently WRAPS window.callAI so that EVERY image-based AI call in
 *       the app first runs a Cloud Vision OCR pass and injects the recognised
 *       text into the prompt as ground truth. This upgrades receipt scans,
 *       CC/expense photos, bank-statement images, AI-advisor attachments and the
 *       CRIB image path — all at once — with zero changes to their call sites.
 *
 *  Fully defensive: any failure (no key, offline, timeout, tiny result) falls
 *  back to the original behaviour. Idempotent: a prompt is never OCR-enriched
 *  twice (guarded by a marker), and callAI is wrapped only once.
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFVision && window.WFVision.__v && window.WFVision.__v >= 722) return;

    var MARKER = '\u3010OCR-GROUND-TRUTH\u3011'; // 【OCR-GROUND-TRUTH】 — unmissable, idempotency guard
    var _ocrCache = {};   // short-lived cache keyed by a cheap hash of the image
    var _available = null;

    function _apiBase() {
        try { if (typeof window._apiBase === 'function') return window._apiBase(); } catch (_) {}
        try {
            var h = window.location.hostname || '';
            if (h.indexOf('github.io') >= 0 || h === 'localhost') return 'https://wealthflow-personal.vercel.app/api';
        } catch (_) {}
        return '/api';
    }
    function _stripPrefix(b64) {
        if (!b64) return '';
        var s = String(b64);
        if (s.slice(0, 5) === 'data:') { var c = s.indexOf(','); if (c > 0) return s.slice(c + 1); }
        return s;
    }
    function _cheapHash(str) {
        var h = 5381, n = Math.min(str.length, 4000);
        for (var i = 0; i < n; i += 7) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        return (str.length + ':' + h.toString(36));
    }
    function _withTimeout(promise, ms, fallback) {
        return new Promise(function (resolve) {
            var done = false;
            var t = setTimeout(function () { if (!done) { done = true; resolve(fallback); } }, ms);
            promise.then(function (v) { if (!done) { done = true; clearTimeout(t); resolve(v); } },
                         function () { if (!done) { done = true; clearTimeout(t); resolve(fallback); } });
        });
    }

    /* ── core Cloud Vision call ──────────────────────────────────────────────── */
    function ocrBase64(base64, opts) {
        opts = opts || {};
        var img = _stripPrefix(base64);
        if (!img || img.length < 64) return Promise.resolve('');
        var key = _cheapHash(img);
        if (_ocrCache[key] != null) return Promise.resolve(_ocrCache[key]);
        var body = {
            image: img,
            mode: opts.mode || 'document',
            languageHints: opts.languageHints || ['en', 'si', 'ta']
        };
        var p = fetch(_apiBase() + '/vision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        }).then(function (r) {
            if (!r.ok) { if (r.status === 503) _available = false; return null; }
            return r.json();
        }).then(function (d) {
            if (d && d.ok) { _available = true; var t = d.text || ''; _ocrCache[key] = t; return t; }
            return '';
        }).catch(function () { return ''; });
        return _withTimeout(p, opts.timeout || 18000, '');
    }

    function ocrImages(images, opts) {
        images = images || [];
        if (!images.length) return Promise.resolve('');
        // Cap pages we OCR to keep it fast; the first pages carry the key data.
        var max = (opts && opts.maxPages) || 6;
        var slice = images.slice(0, max);
        return slice.reduce(function (acc, im) {
            return acc.then(function (txt) {
                return ocrBase64(im, opts).then(function (t) { return txt + (t ? ((txt ? '\n\n' : '') + t) : ''); });
            });
        }, Promise.resolve('')).then(function (full) { return (full || '').trim(); });
    }

    /* ── file → images (prefers the host's memory/iOS-safe extractor) ─────────── */
    function fileToImages(file) {
        try {
            if (window.WF_AI_V4 && window.WF_AI_V4.utils && typeof window.WF_AI_V4.utils.fileToImagesV4 === 'function') {
                return window.WF_AI_V4.utils.fileToImagesV4(file, { maxPages: 6, maxBytes: 3.4 * 1024 * 1024, maxDim: 2200 })
                    .then(function (b) {
                        var imgs = (b && (b.images || b)) || [];
                        return Array.isArray(imgs) ? imgs : (imgs.images || []);
                    });
            }
        } catch (_) {}
        // minimal single-image fallback (no PDF support here)
        return new Promise(function (resolve) {
            try {
                if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || '')) { resolve([]); return; }
                var r = new FileReader();
                r.onload = function () {
                    var image = new Image();
                    image.onload = function () {
                        var maxDim = 2000, w = image.naturalWidth, h = image.naturalHeight;
                        if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
                        else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
                        var c = document.createElement('canvas'); c.width = w; c.height = h;
                        var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(image, 0, 0, w, h);
                        var b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
                        c.width = c.height = 0; image.src = '';
                        resolve([b64]);
                    };
                    image.onerror = function () { resolve([]); };
                    image.src = r.result;
                };
                r.onerror = function () { resolve([]); };
                r.readAsDataURL(file);
            } catch (_) { resolve([]); }
        });
    }

    function ocrFile(file, opts) {
        return fileToImages(file).then(function (imgs) { return ocrImages(imgs, opts); });
    }

    /* ── prompt enrichment (idempotent) ──────────────────────────────────────── */
    function enrichPrompt(prompt, image) {
        prompt = prompt || '';
        try {
            if (!image) return Promise.resolve(prompt);
            if (prompt.indexOf(MARKER) >= 0) return Promise.resolve(prompt); // already enriched
            return ocrBase64(image, { mode: 'document' }).then(function (text) {
                text = (text || '').trim();
                if (text.length < 16) return prompt; // nothing useful → leave untouched
                if (text.length > 11000) text = text.slice(0, 11000);
                return prompt +
                    '\n\n' + MARKER + '\n' +
                    'High-accuracy OCR text extracted from the attached image by Google Cloud Vision. ' +
                    'Treat this as the GROUND TRUTH for any text, numbers, names, dates and amounts (it is more reliable than reading the pixels). ' +
                    'Still use the image for layout/visual context.\n"""\n' + text + '\n"""';
            }).catch(function () { return prompt; });
        } catch (_) { return Promise.resolve(prompt); }
    }

    function available() { return _available !== false; }

    window.WFVision = {
        __v: 722,
        ocrBase64: ocrBase64,
        ocrImages: ocrImages,
        ocrFile: ocrFile,
        fileToImages: fileToImages,
        enrichPrompt: enrichPrompt,
        available: available
    };

    /* ── wrap window.callAI so EVERY image AI call gets the OCR pre-pass ──────── */
    function _wrapCallAI() {
        try {
            var orig = window.callAI;
            if (typeof orig !== 'function') return false;
            if (orig.__wfVisionWrapped) return true;
            var wrapped = function (prompt, image) {
                if (!image) return orig.call(this, prompt, image);
                var self = this;
                return enrichPrompt(prompt, image)
                    .then(function (p) { return orig.call(self, p, image); })
                    .catch(function () { return orig.call(self, prompt, image); });
            };
            wrapped.__wfVisionWrapped = true;
            // Preserve any properties the host attached to callAI.
            try { Object.keys(orig).forEach(function (k) { try { wrapped[k] = orig[k]; } catch (_) {} }); } catch (_) {}
            window.callAI = wrapped;
            return true;
        } catch (_) { return false; }
    }
    if (!_wrapCallAI()) {
        var _tries = 0;
        var _iv = setInterval(function () { if (_wrapCallAI() || ++_tries > 50) clearInterval(_iv); }, 300);
    }

    try { console.log('[WFVision] \u2713 Cloud Vision OCR ready — wired into all image AI calls'); } catch (_) {}
})();
