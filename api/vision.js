/*  vision.js  →  /api/vision
 *  ===========================================================================
 *  High-accuracy OCR endpoint backed by Google Cloud Vision
 *  (vision.googleapis.com). Used across WealthFlow wherever we need the most
 *  accurate text extraction from an image: CRIB reports, bank statements,
 *  expense/CC receipts, and the AI advisor.
 *
 *  v7.56.0 — OCR PHASE 2 (server-side tuning). Dependency-free.
 *    - DOCUMENT_TEXT_DETECTION with textDetectionParams.enableTextDetection-
 *      ConfidenceScore -> per-symbol/word/block confidence, so the pipeline
 *      knows how much to TRUST each read (feeds TensorFlow verification + the
 *      consensus vote).
 *    - BEST-OF MULTI-PASS: DOCUMENT_TEXT_DETECTION first; if that read is weak
 *      (low confidence or too little text) we also run TEXT_DETECTION and keep
 *      whichever pass scored higher (quality = mean-confidence x text-coverage).
 *      Dense/zoomed-out documents win on DOCUMENT; sparse receipts often win on
 *      TEXT -> we no longer lose either case.
 *    - STRUCTURED OUTPUT: { text, blocks[{text,confidence}], confidence,
 *      lowConfidence[], numericTokens[{value,text,confidence}], words, passes }.
 *      numericTokens lets the verifier confirm an extracted amount actually
 *      appears in the image (and how confidently).
 *
 *  Pixel pre-processing (grayscale / contrast / upscale / unsharp) is applied
 *  CLIENT-side (WF_AI_V4 enhanceImageForOCR + the TensorFlow.js path in the app)
 *  before the image reaches here - kept off the server so the backend stays
 *  100% dependency-free (no native image libs, no cold-start / build risk on
 *  the Hobby tier). The confidence this endpoint now returns lets the client
 *  decide when to re-enhance and re-scan a weak image.
 *
 *  ENV: GOOGLE_VISION_API_KEY (or CLOUD_VISION_API_KEY / VISION_API_KEY /
 *       WEALTHFLOW_VISION / WealthFlow_API_Key / GEMINI_API_KEY family).
 *  ===========================================================================*/

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

function pickKey() {
    return process.env.WEALTHFLOW_VISION
        || process.env.GOOGLE_VISION_API_KEY
        || process.env.CLOUD_VISION_API_KEY
        || process.env.VISION_API_KEY
        || process.env.GOOGLE_CLOUD_VISION_API_KEY
        || process.env.GCP_VISION_API_KEY
        || process.env.WealthFlow_API_Key
        || process.env.GEMINI_API_KEY
        || '';
}

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(id); }
}

// Normalise one Vision response into text + blocks + mean confidence + quality.
function parseVision(r0) {
    const text = (r0.fullTextAnnotation && r0.fullTextAnnotation.text)
        || (r0.textAnnotations && r0.textAnnotations[0] && r0.textAnnotations[0].description)
        || '';
    const blocks = [];
    let confSum = 0, confN = 0;
    try {
        const pages = (r0.fullTextAnnotation && r0.fullTextAnnotation.pages) || [];
        pages.forEach(pg => (pg.blocks || []).forEach(bl => {
            let t = '';
            (bl.paragraphs || []).forEach(pa => (pa.words || []).forEach(w => {
                t += (w.symbols || []).map(s => s.text).join('') + ' ';
                if (typeof w.confidence === 'number') { confSum += w.confidence; confN++; }
            }));
            t = t.trim();
            if (t) blocks.push({ text: t, confidence: (typeof bl.confidence === 'number') ? Math.round(bl.confidence * 1000) / 1000 : null });
        }));
    } catch (_) {}
    const meanConfidence = confN ? (confSum / confN) : (text ? 0.72 : 0);
    const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
    const quality = meanConfidence * Math.min(1, words / 8);
    return { text, blocks, meanConfidence, words, quality };
}

// Low-confidence words + numeric-token confidence, from the raw pages.
function extractSignals(r0) {
    const low = [], numeric = [];
    try {
        const pages = (r0.fullTextAnnotation && r0.fullTextAnnotation.pages) || [];
        pages.forEach(pg => (pg.blocks || []).forEach(bl => (bl.paragraphs || []).forEach(pa => (pa.words || []).forEach(w => {
            const wt = (w.symbols || []).map(s => s.text).join('');
            const c = (typeof w.confidence === 'number') ? w.confidence : null;
            if (!wt) return;
            if (c !== null && c < 0.70 && low.length < 60) low.push({ text: wt, confidence: Math.round(c * 1000) / 1000 });
            const bare = wt.replace(/^(rs\.?|lkr|usd|\$|€|£)/i, '');
            if (/[0-9]/.test(wt) && /^[0-9.,]+$/.test(bare)) {
                const num = parseFloat(bare.replace(/,/g, ''));
                if (!isNaN(num) && numeric.length < 80) numeric.push({ value: num, text: wt, confidence: c === null ? null : Math.round(c * 1000) / 1000 });
            }
        }))));
    } catch (_) {}
    return { low, numeric };
}

async function runVision(url, image, feature, languageHints) {
    const r = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [{
                image: { content: image },
                features: [{ type: feature, maxResults: 1 }],
                imageContext: {
                    languageHints,
                    textDetectionParams: { enableTextDetectionConfidenceScore: true }
                }
            }]
        })
    }, 25000);
    if (!r.ok) {
        let detail = '';
        try { const j = await r.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (_) {}
        return { httpError: `Cloud Vision ${r.status}${detail ? ' — ' + detail : ''}` };
    }
    const data = await r.json();
    const r0 = (data.responses && data.responses[0]) || {};
    if (r0.error) return { visionError: r0.error.message || 'Cloud Vision error' };
    return { r0 };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'POST only' });

    const key = pickKey();
    if (!key) return res.status(503).json({ ok: false, error: 'Cloud Vision key not configured (set GOOGLE_VISION_API_KEY in Vercel).' });

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    let image = (body && body.image) || '';
    if (!image) return res.status(400).json({ ok: false, error: 'Missing image (base64).' });
    const comma = image.indexOf(',');
    if (image.slice(0, 5) === 'data:' && comma > 0) image = image.slice(comma + 1);

    const mode = (body && body.mode) || 'auto';                 // document | text | auto
    const bestOf = (body && body.bestOf !== false);             // default ON
    const languageHints = (body && Array.isArray(body.languageHints) && body.languageHints.length)
        ? body.languageHints : ['en', 'si', 'ta'];

    const url = `https://vision.googleapis.com/v1/images:annotate?key=${key}`;
    const primaryFeature = (mode === 'text') ? 'TEXT_DETECTION' : 'DOCUMENT_TEXT_DETECTION';

    try {
        const p1 = await runVision(url, image, primaryFeature, languageHints);
        if (p1.httpError) return res.status(502).json({ ok: false, error: p1.httpError });
        if (p1.visionError) return res.status(502).json({ ok: false, error: p1.visionError });
        let chosen = parseVision(p1.r0), chosenR0 = p1.r0, chosenFeature = primaryFeature, passes = 1;

        const weak = chosen.quality < 0.60 || chosen.words < 5;
        if (bestOf && mode === 'auto' && weak) {
            const altFeature = (primaryFeature === 'DOCUMENT_TEXT_DETECTION') ? 'TEXT_DETECTION' : 'DOCUMENT_TEXT_DETECTION';
            const p2 = await runVision(url, image, altFeature, languageHints);
            if (p2.r0) {
                passes = 2;
                const alt = parseVision(p2.r0);
                if (alt.quality > chosen.quality) { chosen = alt; chosenR0 = p2.r0; chosenFeature = altFeature; }
            }
        }

        const sig = extractSignals(chosenR0);
        let blocks = chosen.blocks;
        if (blocks.length > 400) blocks = blocks.slice(0, 400);

        return res.status(200).json({
            ok: true,
            text: chosen.text,
            blocks,
            confidence: Math.round(chosen.meanConfidence * 1000) / 1000,
            lowConfidence: sig.low,
            numericTokens: sig.numeric,
            words: chosen.words,
            engine: 'cloud-vision',
            feature: chosenFeature,
            passes
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: (e && e.message) || 'vision failed' });
    }
}
