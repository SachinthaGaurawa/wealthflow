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

import { geminiGenerate, geminiKeyOf, mimeOfBase64 } from './gemini-client.mjs';

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

async function transcribeWithGemini(imageB64, key, tier) {
    try {
        // the shared client finds a live model of this kind, honours a quota answer, and is never asked for a retired name
        const result = await geminiGenerate({
            key, tier, parts: [{ text: TRANSCRIBE_PROMPT }, { inline_data: { mime_type: mimeOfBase64(imageB64), data: imageB64 } }],
            temperature: 0, maxOutputTokens: 2048, deadlineMs: 28000
        });
        return result.text.trim();
    } catch (_) {
        return '';
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

    const key = (typeof process !== 'undefined' && process.env) ? geminiKeyOf(process.env) : null;

    if (!key) {
        // No server vision available — tell the client to keep its OCR result.
        return new Response(JSON.stringify({ ok: false, error: 'no_vision_key', raw_text: '' }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }

    // The fast reader first (it finds its own live model); the strong one only if that returned next to nothing.
    let text = await transcribeWithGemini(image, key, 'fast');
    if (!text || text.length < 12) {
        text = await transcribeWithGemini(image, key, 'pro');
    }

    return new Response(JSON.stringify({ ok: !!text, raw_text: text || '' }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
    });
}
