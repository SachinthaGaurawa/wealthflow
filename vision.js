/*  vision.js  →  /api/vision
 *  ===========================================================================
 *  Pure high-accuracy OCR endpoint backed by Google Cloud Vision
 *  (vision.googleapis.com, DOCUMENT_TEXT_DETECTION). Used across WealthFlow
 *  wherever we need the most accurate text extraction from an image:
 *  CRIB reports, bank statements, expense/CC receipts, and the AI advisor.
 *
 *  Cloud Vision reads dense, small and zoomed-out text far better than generic
 *  OCR, which fixes the "only zoomed-in / high-quality images work" problem.
 *
 *  Request  (POST JSON):
 *    { image: "<base64 (no data: prefix)>", mode?: "document"|"text",
 *      languageHints?: ["en","si","ta"] }
 *  Response (200):
 *    { ok:true, text:"<full text>", blocks:[...], words:<n>, engine:"cloud-vision" }
 *
 *  ENV: GOOGLE_VISION_API_KEY (or CLOUD_VISION_API_KEY / VISION_API_KEY /
 *       WealthFlow_API_Key / GEMINI_API_KEY — same Google Cloud key family).
 *  ===========================================================================*/

export const config = { api: { bodyParser: { sizeLimit: '8mb' } } };

function pickKey() {
    // The dedicated Cloud Vision key the owner configured in Vercel MUST come first.
    // A Gemini AI-Studio key (WealthFlow_API_Key) does NOT work against
    // vision.googleapis.com, so falling through to it silently broke OCR accuracy.
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

export default async function handler(req, res) {
    // CORS (same-origin in prod, permissive for safety)
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
    // strip any data: prefix
    const comma = image.indexOf(',');
    if (image.slice(0, 5) === 'data:' && comma > 0) image = image.slice(comma + 1);

    const featureType = (body && body.mode === 'text') ? 'TEXT_DETECTION' : 'DOCUMENT_TEXT_DETECTION';
    const languageHints = (body && Array.isArray(body.languageHints) && body.languageHints.length)
        ? body.languageHints : ['en', 'si', 'ta'];

    try {
        const url = `https://vision.googleapis.com/v1/images:annotate?key=${key}`;
        const r = await fetchWithTimeout(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                requests: [{
                    image: { content: image },
                    features: [{ type: featureType, maxResults: 1 }],
                    imageContext: { languageHints }
                }]
            })
        }, 25000);

        if (!r.ok) {
            let detail = '';
            try { const j = await r.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (_) {}
            return res.status(502).json({ ok: false, error: `Cloud Vision ${r.status}${detail ? ' — ' + detail : ''}` });
        }
        const data = await r.json();
        const r0 = (data.responses && data.responses[0]) || {};
        if (r0.error) return res.status(502).json({ ok: false, error: r0.error.message || 'Cloud Vision error' });

        const text = (r0.fullTextAnnotation && r0.fullTextAnnotation.text)
            || (r0.textAnnotations && r0.textAnnotations[0] && r0.textAnnotations[0].description)
            || '';
        // light block list (page→block bounding text), capped for payload size
        let blocks = [];
        try {
            const pages = (r0.fullTextAnnotation && r0.fullTextAnnotation.pages) || [];
            pages.forEach(pg => (pg.blocks || []).forEach(bl => {
                let t = '';
                (bl.paragraphs || []).forEach(pa => (pa.words || []).forEach(w => {
                    t += (w.symbols || []).map(s => s.text).join('') + ' ';
                }));
                t = t.trim();
                if (t) blocks.push(t);
            }));
        } catch (_) {}
        if (blocks.length > 400) blocks = blocks.slice(0, 400);

        const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
        return res.status(200).json({ ok: true, text, blocks, words, engine: 'cloud-vision', feature: featureType });
    } catch (e) {
        return res.status(500).json({ ok: false, error: (e && e.message) || 'vision failed' });
    }
}
