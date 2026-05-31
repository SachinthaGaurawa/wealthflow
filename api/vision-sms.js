// =============================================================================
//  /api/vision-sms  —  Screenshot → raw bank-SMS text transcription
//  ---------------------------------------------------------------------------
//  This is the OPTIONAL server-side fallback used by wealthflow-vision-sms.js
//  when the on-device OCR (Tesseract.js) returns too little text. It asks a
//  vision model to transcribe the bank-SMS text VERBATIM (not to interpret or
//  summarise it) so the client's proven SMS splitter + brain can do the
//  classification exactly as they do for pasted text.
//
//  Accuracy-first design: we ask only for faithful transcription, preserving
//  amounts, dates, reference lines and account masks exactly. We do NOT ask the
//  model to classify — classification stays in the deterministic brain so the
//  behaviour is identical whether text was pasted or OCR'd.
//
//  Reuses the app's existing Gemini key:
//      WealthFlow_API_Key  (or GEMINI_API_KEY)
//  If no key is set, returns ok:false so the client keeps the client-side OCR
//  result instead. Never throws to the client.
// =============================================================================

export const config = {
    runtime: 'edge'
};

const TRANSCRIBE_PROMPT =
    "You are a precise OCR transcriber for bank SMS screenshots. " +
    "Transcribe EVERY bank/transaction SMS visible in this image, VERBATIM, exactly as written. " +
    "Preserve amounts (e.g. LKR2,498.74), dates (e.g. 29 MAY 2026), account masks (e.g. ********5187), " +
    "reference text (e.g. ref: CARGILLS FOOD CITY-KULIYA KULIYAPIT) and balances exactly. " +
    "Put a BLANK LINE between separate messages. Do NOT summarise, classify, translate, or add commentary. " +
    "Ignore UI chrome like the contact name, timestamps headers (Friday 11:39), status bar, and phone-number links. " +
    "Output ONLY the transcribed message text.";

async function transcribeWithGemini(imageB64, key, model) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 28000);
    try {
        const resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: controller.signal,
            body: JSON.stringify({
                contents: [{
                    parts: [
                        { text: TRANSCRIBE_PROMPT },
                        { inline_data: { mime_type: 'image/jpeg', data: imageB64 } }
                    ]
                }],
                generationConfig: { temperature: 0, maxOutputTokens: 2048 }
            })
        });
        if (!resp.ok) return '';
        const j = await resp.json();
        const parts = j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts;
        if (!parts) return '';
        return parts.map(p => p.text || '').join('').trim();
    } catch (_) {
        return '';
    } finally {
        clearTimeout(timer);
    }
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }

    let body = {};
    try { body = await req.json(); } catch (_) {
        return new Response(JSON.stringify({ ok: false, error: 'invalid json' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const image = body.image || body.image_base64 || '';
    if (!image || image.length < 100) {
        return new Response(JSON.stringify({ ok: false, error: 'no image' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const key = (typeof process !== 'undefined' && process.env)
        ? (process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY)
        : null;

    if (!key) {
        // No server vision available — tell the client to keep its OCR result.
        return new Response(JSON.stringify({ ok: false, error: 'no_vision_key', raw_text: '' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }

    // Try the frontier model first, then fall back to a faster one.
    let text = await transcribeWithGemini(image, key, 'gemini-2.5-flash');
    if (!text || text.length < 12) {
        text = await transcribeWithGemini(image, key, 'gemini-2.0-flash');
    }

    return new Response(JSON.stringify({ ok: !!text, raw_text: text || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
