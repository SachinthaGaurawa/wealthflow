// =================== Eden AI proxy v1.0 — Multi-feature aggregator ===================
//
// Modes:
//   financial_parser  — extract structured data from receipts/invoices using
//                       Mindee/Amazon/Google providers via Eden AI
//   sentiment         — classify text sentiment (financial notes, etc.)
//   chat              — fallback chat (Eden AI's smart routing)
//   ocr               — pure OCR text extraction
//
// Env vars:
//   EDENAI_API_KEY (required; embedded fallback for development convenience)
//
// SECURITY: the embedded fallback below is a known-exposed key. ROTATE in Eden AI
// dashboard and set EDENAI_API_KEY env var to override.
// =====================================================================================

export const config = {
    maxDuration: 30,
    api: { bodyParser: { sizeLimit: '4mb' } }
};

// SECURITY: This was provided in chat history → assume compromised. Use env var to override.
const EMBEDDED_KEY_FALLBACK = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyX2lkIjoiNWQxZDFlYjctODJmOS00OGZiLTkzMDUtYzIyMjc0MzllODA5IiwidHlwZSI6ImFwaV90b2tlbiIsIm5hbWUiOiJFREVOQUlfQVBJX0tFWSIsImlzX2N1c3RvbSI6dHJ1ZX0.R426tOr_IhAFb1OOyEoAPul1lXNK5LT3lZY4GVceR44';

async function fetchWithTimeout(url, options, timeoutMs = 25000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

// ---- Financial Parser: receipts + invoices ----
async function callFinancialParser(image, key, providers = 'mindee,amazon,google') {
    // Eden AI accepts file_base64 in the JSON body
    const resp = await fetchWithTimeout('https://api.edenai.run/v2/ocr/financial_parser', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            providers: providers,
            file_base64: image,
            file_type: 'image/jpeg',
            document_type: 'receipt',
            language: 'en'
        })
    }, 28000);
    const text = await resp.text();
    if (!resp.ok) throw new Error(`financial_parser ${resp.status}: ${text.slice(0, 250)}`);
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('invalid JSON: ' + text.slice(0, 200)); }
    return data;
}

// ---- Sentiment analysis ----
async function callSentiment(text, key, providers = 'amazon,google,microsoft') {
    const resp = await fetchWithTimeout('https://api.edenai.run/v2/text/sentiment_analysis', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ providers, text, language: 'en' })
    }, 15000);
    if (!resp.ok) throw new Error(`sentiment ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return await resp.json();
}

// ---- Keyword extraction (useful for tagging expenses) ----
async function callKeywords(text, key) {
    const resp = await fetchWithTimeout('https://api.edenai.run/v2/text/keyword_extraction', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ providers: 'amazon,microsoft', text, language: 'en' })
    }, 15000);
    if (!resp.ok) throw new Error(`keywords ${resp.status}`);
    return await resp.json();
}

// ---- Chat (Eden AI smart-router) ----
async function callEdenChat(prompt, key, model = 'openai/gpt-4o-mini') {
    const resp = await fetchWithTimeout('https://api.edenai.run/v2/text/chat', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            providers: model,
            text: prompt,
            temperature: 0.2,
            max_tokens: 1024
        })
    }, 25000);
    if (!resp.ok) throw new Error(`chat ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    return await resp.json();
}

// ---- OCR (pure text extraction) ----
async function callOcr(image, key, providers = 'google,amazon,microsoft') {
    const resp = await fetchWithTimeout('https://api.edenai.run/v2/ocr/ocr', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            providers,
            file_base64: image,
            file_type: 'image/jpeg',
            language: 'en'
        })
    }, 20000);
    if (!resp.ok) throw new Error(`ocr ${resp.status}`);
    return await resp.json();
}

// ---- Normalise Eden AI financial parser output to our standard schema ----
function normaliseEdenFinancial(edenData) {
    // Pick the first successful provider response
    const result = {};
    for (const provName of Object.keys(edenData || {})) {
        const p = edenData[provName];
        if (!p || p.status !== 'success' || !p.extracted_data || !p.extracted_data.length) continue;
        const doc = p.extracted_data[0];
        const merchant = doc.merchant_information || {};
        const payment = doc.payment_information || {};
        const dates = doc.local || {};
        const lineItems = doc.item_lines || [];
        result.vendor = merchant.merchant_name || merchant.merchant_legal_name || null;
        result.amount = (typeof payment.amount_due === 'number') ? payment.amount_due :
                       (typeof payment.total === 'number') ? payment.total :
                       (typeof payment.amount === 'number') ? payment.amount : null;
        result.tax = (typeof payment.amount_tax === 'number') ? payment.amount_tax :
                    (typeof payment.tax === 'number') ? payment.tax : null;
        result.date = doc.date || dates.date || null;
        result.time = doc.time || null;
        result.currency = payment.amount_currency || dates.currency || 'LKR';
        result.receipt_number = doc.invoice_number || doc.reference || null;
        result.payment_method = (payment.payment_method ? String(payment.payment_method).toLowerCase() : null);
        result.items = lineItems.slice(0, 10).map(it =>
            typeof it === 'string' ? it : (it.description || it.product_code || JSON.stringify(it).slice(0, 60))
        );
        result.raw_text = doc.raw_text || null;
        result.provider_used = provName;
        return result;
    }
    return null;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const key = process.env.EDENAI_API_KEY || EMBEDDED_KEY_FALLBACK;
    if (!key) return res.status(503).json({ error: 'EDENAI_API_KEY not configured' });

    const { feature, image, text, providers } = req.body || {};
    if (!feature) return res.status(400).json({ error: 'Missing "feature" (financial_parser|sentiment|chat|ocr|keywords)' });

    const startedAt = Date.now();
    try {
        let raw;
        switch (feature) {
            case 'financial_parser':
                if (!image) return res.status(400).json({ error: 'Missing "image" (base64)' });
                raw = await callFinancialParser(image, key, providers);
                return res.status(200).json({
                    feature, result: normaliseEdenFinancial(raw), raw, elapsedMs: Date.now() - startedAt
                });
            case 'ocr':
                if (!image) return res.status(400).json({ error: 'Missing "image" (base64)' });
                raw = await callOcr(image, key, providers);
                return res.status(200).json({ feature, raw, elapsedMs: Date.now() - startedAt });
            case 'sentiment':
                if (!text) return res.status(400).json({ error: 'Missing "text"' });
                raw = await callSentiment(text, key, providers);
                return res.status(200).json({ feature, raw, elapsedMs: Date.now() - startedAt });
            case 'keywords':
                if (!text) return res.status(400).json({ error: 'Missing "text"' });
                raw = await callKeywords(text, key);
                return res.status(200).json({ feature, raw, elapsedMs: Date.now() - startedAt });
            case 'chat':
                if (!text) return res.status(400).json({ error: 'Missing "text"' });
                raw = await callEdenChat(text, key, providers || 'openai/gpt-4o-mini');
                return res.status(200).json({ feature, raw, elapsedMs: Date.now() - startedAt });
            default:
                return res.status(400).json({ error: 'Unknown feature: ' + feature });
        }
    } catch (e) {
        return res.status(502).json({ error: String(e.message || e), feature, elapsedMs: Date.now() - startedAt });
    }
}
