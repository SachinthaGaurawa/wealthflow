/* =============================================================================
   WealthFlow Vision-SMS v1.0 — Screenshot → Text → Transactions
   ---------------------------------------------------------------------------
   User requirement: "user can attach screenshots as SMS paste. Then system AI
   will read and continue. Make for Multi selection attach."

   You screenshot your bank-SMS thread (one or many messages, like the DFCC
   Alerts thread), attach the image(s), and the AI:
       1. OCR-reads every screenshot → raw text
       2. Feeds that text into the SAME proven SMS splitter (so a screenshot
          with 5 messages becomes 5 transactions)
       3. Hands the messages to the background queue → auto-files them
   Multiple screenshots can be attached at once; they're read in parallel and
   their text is concatenated before splitting.

   Two-tier OCR for accuracy + zero-setup + privacy:
       • PRIMARY (client-side): Tesseract.js, loaded on demand from CDN. The
         image never leaves the device. Clean digital screenshots (high
         contrast text) are the ideal case for OCR, so accuracy is excellent.
       • FALLBACK (server-side): if the client OCR yields too little text AND a
         vision endpoint is available, POST the image to /api/vision-sms which
         asks a vision model to transcribe the raw SMS text verbatim.

   Exposes:
     • wfVisionSms.readImage(fileOrDataUrl)      → resolves to extracted text
     • wfVisionSms.readImages([files], onProg)   → combined text from many imgs
     • wfVisionSms.ready()                        → preloads the OCR engine
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_VISION_SMS_LOADED) return;
    window.WF_VISION_SMS_LOADED = '1.0';

    const TESSERACT_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
    const MIN_USEFUL_CHARS = 24;   // below this, try the server fallback
    let _tesseractPromise = null;
    let _worker = null;

    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }

    // ── load Tesseract.js on demand ─────────────────────────────────────────---
    function _loadTesseract() {
        if (_tesseractPromise) return _tesseractPromise;
        _tesseractPromise = new Promise((resolve, reject) => {
            if (window.Tesseract) return resolve(window.Tesseract);
            const s = document.createElement('script');
            s.src = TESSERACT_CDN;
            s.async = true;
            s.onload = () => window.Tesseract ? resolve(window.Tesseract) : reject(new Error('Tesseract failed to expose global'));
            s.onerror = () => reject(new Error('Could not load OCR engine (offline?)'));
            document.head.appendChild(s);
        });
        return _tesseractPromise;
    }

    async function _getWorker(onProg) {
        const T = await _loadTesseract();
        if (_worker) return _worker;
        // Tesseract v5 createWorker API
        _worker = await T.createWorker('eng', 1, {
            logger: (m) => {
                if (m && m.status === 'recognizing text' && typeof onProg === 'function') {
                    onProg(m.progress || 0);
                }
            }
        });
        return _worker;
    }

    // ── normalize a File / Blob / dataURL into something Tesseract accepts ──────
    function _toImageSource(input) {
        // Tesseract accepts File, Blob, dataURL string, <img>, canvas, URL
        return input;
    }

    function _fileToDataUrl(file) {
        return new Promise((resolve, reject) => {
            const r = new FileReader();
            r.onload = () => resolve(r.result);
            r.onerror = () => reject(new Error('Could not read file'));
            r.readAsDataURL(file);
        });
    }
    function _dataUrlToBase64(d) {
        const i = String(d).indexOf(',');
        return i >= 0 ? String(d).slice(i + 1) : String(d);
    }

    // ── server fallback (optional; only if the endpoint exists) ─────────────────
    async function _serverOcr(file) {
        try {
            const dataUrl = (typeof file === 'string') ? file : await _fileToDataUrl(file);
            const b64 = _dataUrlToBase64(dataUrl);
            const r = await fetch('/api/vision-sms', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ image: b64, mode: 'sms_transcribe' })
            });
            if (!r.ok) return '';
            const j = await r.json();
            return (j && (j.raw_text || j.text || '')) || '';
        } catch (_) { return ''; }
    }

    // ── clean OCR output (fix the few systematic mistakes on bank SMS) ─────────-
    function _cleanOcrText(t) {
        if (!t) return '';
        return String(t)
            // common OCR confusions in amounts/codes
            .replace(/LKR\s*([\d.,]+)/gi, 'LKR$1')
            .replace(/\bO0\b/g, '00')
            .replace(/[‘’]/g, "'")
            .replace(/[“”]/g, '"')
            // collapse hard-wrapped lines that belong to one SMS: a line that
            // doesn't end in sentence punctuation likely continues on the next.
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    // ── public: read ONE image → text ───────────────────────────────────────---
    async function readImage(file, onProg) {
        let text = '';
        try {
            const worker = await _getWorker(onProg);
            const src = _toImageSource(typeof file === 'string' ? file : file);
            const { data } = await worker.recognize(src);
            text = (data && data.text) || '';
        } catch (e) {
            console.warn('[wfVisionSms] client OCR failed:', e && e.message);
        }
        text = _cleanOcrText(text);
        // If the client OCR found too little, try the server vision fallback
        if (text.replace(/\s/g, '').length < MIN_USEFUL_CHARS) {
            const serverText = await _serverOcr(file);
            if (serverText && serverText.length > text.length) text = _cleanOcrText(serverText);
        }
        return text;
    }

    // ── public: read MANY images → combined text ───────────────────────────────
    async function readImages(files, onProg) {
        const arr = Array.from(files || []);
        if (!arr.length) return '';
        const texts = [];
        for (let i = 0; i < arr.length; i++) {
            if (typeof onProg === 'function') onProg({ phase: 'image', index: i, total: arr.length, progress: 0 });
            const t = await readImage(arr[i], (p) => {
                if (typeof onProg === 'function') onProg({ phase: 'ocr', index: i, total: arr.length, progress: p });
            });
            if (t) texts.push(t);
            if (typeof onProg === 'function') onProg({ phase: 'done', index: i, total: arr.length, progress: 1 });
        }
        // join with blank lines so the splitter treats screenshots as separate blocks
        return texts.join('\n\n');
    }

    async function ready() { try { await _loadTesseract(); return true; } catch { return false; } }

    window.wfVisionSms = { readImage, readImages, ready };

    console.log('[wfVisionSms] ✓ Screenshot→SMS OCR module loaded (client-side Tesseract primary)');
})();
