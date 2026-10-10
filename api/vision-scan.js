// ==================== WealthFlow Vision Engine v3.0 — Frontier Multi-Provider ====================
//
// Many AI engines, none of them asked for a model by a name this file remembers:
//   GEMINI:   a fast and a strong reader, each finding its own live model (gemini-client.mjs)
//   OTHERS:   Ollama, Groq, Mistral, Together, NVIDIA, Fireworks, GitHub Models, OpenRouter — one table (ai-provider-call.mjs) that asks a model
//             the provider serves NOW and replaces a retired one from the provider's own list (ai-models.mjs)
//   ANCHOR:   Google Cloud Vision / OCR.space + text-LLM structuring (Cohere, then the same providers as text readers)
//
// MODES: quick | deep | ultra | frontier
//
// ENV (all optional except WealthFlow_API_Key):
//   WealthFlow_API_Key, OLLAMA_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, MISTRAL_API_KEY, COHERE_API_KEY,
//   DEEPSEEK_API_KEY, TOGETHER_API_KEY, NVIDIA_API_KEY, FIREWORKS_API_KEY, GH_PAT (GitHub Models), OCR_SPACE_API_KEY

import { geminiGenerate, mimeOfBase64 } from '../gemini-client.mjs';
import { fetchWithBodyDeadline } from '../fetch-timeout.mjs';
import { askProvider, PROVIDERS } from '../ai-provider-call.mjs';

export const config = {
    maxDuration: 60,
    api: { bodyParser: { sizeLimit: '4mb' } }
};

/* THE KEY THAT USED TO SIT HERE IS GONE, AND IT MUST BE REVOKED.
 *
 * A literal Ollama Cloud key was hardcoded at this line as a "low-trust
 * fallback" so the engine worked without configuration. This repository is
 * PUBLIC. A credential in a public file is a credential everyone has, and no
 * amount of low-trust framing changes that — the owner's standing instruction
 * is that keys are never to be exposed.
 *
 * Removing it from HEAD does not remove it from git history, so the key that
 * was here has to be revoked at the provider. That is the owner's action; this
 * change only stops the file handing it out.
 *
 * The engine now reads OLLAMA_API_KEY from the environment and nothing else.
 * Unset, it is simply not in the fan-out — there are fifteen other engines, and
 * a missing one costs a vote rather than an answer. */

// Each provider call is bounded to its budget from connect THROUGH the body read (fetch-timeout.mjs). The local helper that stood here cleared its
// timer as soon as the headers arrived, so one provider that stalled mid-reply held the whole `Promise.all` vote until the router's 60 s limit.
const fetchWithTimeout = (url, options, timeoutMs = 22000) => fetchWithBodyDeadline(url, options, timeoutMs);

function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    try { return JSON.parse(cleaned); } catch (_) { }
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let candidate = m[0]
        .replace(/,\s*([}\]])/g, '$1')
        .replace(/[\u201C\u201D]/g, '"')
        .replace(/[\u2018\u2019]/g, "'");
    try { return JSON.parse(candidate); } catch (_) { return null; }
}

function normaliseAmount(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    if (typeof val !== 'string') return null;
    let s = val.trim()
        .replace(/(?:LKR|USD|EUR|GBP|INR|AUD|CAD|JPY|CNY|SGD|AED|SAR|Rs\.?|රු|₹|\$|€|£|¥)/gi, '')
        .replace(/\/=|\/-/g, '')
        .replace(/\s+/g, '')
        .replace(/[^0-9.,\-]/g, '');
    if (!s) return null;
    const lastDot = s.lastIndexOf('.'), lastCom = s.lastIndexOf(',');
    if (lastDot > -1 && lastCom > -1) {
        if (lastDot > lastCom) s = s.replace(/,/g, '');
        else s = s.replace(/\./g, '').replace(',', '.');
    } else if (lastCom > -1 && lastDot === -1) {
        const after = s.length - lastCom - 1;
        if (after === 1 || after === 2) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

function normaliseDate(val, hintToday) {
    if (!val || typeof val !== 'string') return null;
    const s = val.trim();
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (m) {
        let [, d, mo, y] = m;
        if (y.length === 2) y = '20' + y;
        const dN = parseInt(d, 10), mN = parseInt(mo, 10);
        let day = d, month = mo;
        if (dN > 12 && mN <= 12) { day = d; month = mo; }
        else if (mN > 12 && dN <= 12) { day = mo; month = d; }
        return `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    m = s.match(/(\d{1,2})\s+([a-z]{3,9})\s+(\d{2,4})/i);
    if (m) {
        const [, d, mn, y] = m;
        const mNum = MONTHS[mn.slice(0, 3).toLowerCase()];
        if (mNum) {
            const yy = y.length === 2 ? '20' + y : y;
            return `${yy}-${String(mNum).padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
    }
    m = s.match(/([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})/i);
    if (m) {
        const [, mn, d, y] = m;
        const mNum = MONTHS[mn.slice(0, 3).toLowerCase()];
        if (mNum) {
            const yy = y.length === 2 ? '20' + y : y;
            return `${yy}-${String(mNum).padStart(2, '0')}-${d.padStart(2, '0')}`;
        }
    }
    return hintToday || null;
}

const CATEGORY_RULES = [
    { cat: 'Dining Out',       pat: /\b(restaurant|cafe|coffee|pizza|kfc|mcdonald|burger|domino|hotel.*lunch|dine|food.*delivery|uber.*eats|pickme.*food)\b/i },
    { cat: 'Food & Groceries', pat: /\b(grocery|grocer|supermarket|cargill|keells|arpico|laughs|farmers|sathosa|spar|food.?city|maliban|harischandra|delmege|store|mart|fresh|vegetable|bakery)\b/i },
    { cat: 'Transport',        pat: /\b(uber|pickme|taxi|fuel|petrol|diesel|ipg|ceypetco|laugfs|fleet|gas station|bus|train|sltb|parking)\b/i },
    { cat: 'Utilities',        pat: /\b(ceb|leco|nwsdb|water board|electricity|gas board|litro|dialog|slt|mobitel|hutch|airtel|broadband|internet|telecom)\b/i },
    { cat: 'Medical',          pat: /\b(pharmacy|pharmacist|hospital|clinic|medical|lab|x-?ray|asiri|nawaloka|durdans|hemas|royal hospital|chemist|drug|prescription)\b/i },
    { cat: 'Education',        pat: /\b(school|college|tuition|class|institute|university|kaplan|edx|cima|caa|cgma|book.*shop|stationery|sarasavi|vijitha)\b/i },
    { cat: 'Entertainment',    pat: /\b(cinema|netflix|spotify|youtube|hbo|disney|prime video|liberty plaza|majestic|pvr|theatre|concert|game)\b/i },
    { cat: 'Clothing',         pat: /\b(odel|cool planet|fashion|cotton collection|nolimit|kandyan|saree|garment|footwear|nike|adidas|puma|levi|wear)\b/i },
    { cat: 'Subscriptions',    pat: /\b(subscription|monthly plan|annual plan|recurring|gym membership|netflix|spotify|adobe|cloud|hosting|vps|domain)\b/i },
    { cat: 'Insurance',        pat: /\b(insurance|aia|allianz|union assurance|ceylinco|janashakthi|policy|premium.*payment)\b/i },
    { cat: 'Personal Care',    pat: /\b(salon|barber|spa|beauty|cosmetic|skincare|hair|gym|fitness|massage)\b/i },
    { cat: 'Rent/Housing',     pat: /\b(rent|landlord|maintenance|condominium|service charge|housing)\b/i },
    { cat: 'Shopping',         pat: /\b(daraz|amazon|ebay|flipkart|aliexpress|shein|online.*shop|e.?commerce|crocs|samsung|apple store|gadget|electronics)\b/i }
];
function inferCategory(vendor, rawText) {
    const haystack = `${vendor || ''}  ${(rawText || '').slice(0, 1500)}`;
    for (const r of CATEGORY_RULES) if (r.pat.test(haystack)) return r.cat;
    return null;
}

function inferCurrency(rawText, vendor, hintCurrency) {
    const t = `${vendor || ''} ${rawText || ''}`.toLowerCase();
    if (/\b(lkr|sri lank|රු|rs\.|\/=)/i.test(t)) return 'LKR';
    if (/\b(usd|us\$|dollar)\b/i.test(t)) return 'USD';
    if (/\b(eur|€|euro)\b/i.test(t)) return 'EUR';
    if (/\b(gbp|£|pound sterling)\b/i.test(t)) return 'GBP';
    if (/\b(inr|₹|indian rupee)\b/i.test(t)) return 'INR';
    if (/\b(aud|au\$)\b/i.test(t)) return 'AUD';
    if (/\b(sgd|sg\$)\b/i.test(t)) return 'SGD';
    if (/\b(jpy|¥|yen)\b/i.test(t)) return 'JPY';
    if (/\b(aed|dirham)\b/i.test(t)) return 'AED';
    if (/\b(sar|saudi riyal)\b/i.test(t)) return 'SAR';
    return hintCurrency || 'LKR';
}

/**
 * The day it is where the OWNER is, not where this function runs.
 *
 * THE DEFECT: this file runs on a server whose clock is UTC, and it answered
 * "what is today" with new Date().toISOString().slice(0,10). Colombo is
 * UTC+05:30, so between midnight and half past five in the morning the server's
 * answer is YESTERDAY — and that answer is handed to the vision model as the
 * date to assume for a receipt that does not print one. On the first of a month
 * it puts the transaction in the previous month's tab.
 *
 * The client now sends `today` (its own local date) and `tz` (its IANA zone) on
 * every call, so this normally just uses what it was told. `tz` is the fallback
 * for an older client that sends one but not the other, and UTC is the fallback
 * for a caller that sends neither — which is a caller that has told us nothing,
 * not a caller we can be clever about.
 */
function todayFor(hints) {
    if (hints && typeof hints.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(hints.today)) return hints.today;
    const tz = hints && typeof hints.tz === 'string' ? hints.tz : '';
    if (tz) {
        try {
            // 'en-CA' formats as YYYY-MM-DD, which is the shape every caller wants.
            return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date());
        } catch (_) { /* an unknown zone falls through to UTC */ }
    }
    return new Date().toISOString().split('T')[0];
}

function buildReceiptPrompt(hints) {
    const today = todayFor(hints);
    const currency = (hints && hints.currency) || 'LKR';
    return `You are a world-class receipt OCR system specialised for Sri Lankan and international receipts. Read this image with surgical precision. Return ONLY a single valid JSON object — no markdown, no commentary.

RULES:
- amount = the GRAND TOTAL / NET PAYABLE / AMOUNT DUE at the bottom (the biggest "Total" — NOT a line item, NOT a subtotal). Plain number, no commas/currency.
- date = transaction date in strict YYYY-MM-DD. Sri Lankan receipts use DD/MM/YYYY — convert correctly. If missing, "${today}".
- vendor = merchant name at the TOP.
- category = pick ONE: "Food & Groceries", "Dining Out", "Transport", "Utilities", "Medical", "Education", "Entertainment", "Clothing", "Shopping", "Subscriptions", "Insurance", "Rent/Housing", "Personal Care", "Other".
- currency = 3-letter ISO. Default "${currency}".
- items = up to 10 prominent items as strings.
- tax = tax amount as number (VAT/GST/NBT/SSCL), or null.
- payment_method = "cash"|"card"|"digital"|null
- receipt_number = bill/invoice/receipt number if printed, else null
- time = HH:MM 24-hour, else null
- raw_text = full text you read, lines separated by \\n

{"vendor":"","amount":0,"date":"YYYY-MM-DD","category":"","items":[],"currency":"${currency}","tax":null,"payment_method":null,"receipt_number":null,"time":null,"raw_text":""}`;
}

// ==================== ENGINES ====================

/* Gemini, through the one shared client (gemini-client.mjs). This file used to name five Gemini models by hand — 3.1-pro-preview,
 * 3-flash-preview, 2.5-flash, 2.0-flash, 2.5-pro — and ask them all on every scan: the retired ones answered 404, the Pro ones
 * answered 429 on a key with no Pro quota, and each of those showed up as an API error on the project's Gemini dashboard.
 * Now there are two readers, a fast one and a strong one, each of which finds a live model of its kind by itself, is parked when
 * Google says its quota is spent, and is not asked again until it can answer. */
async function callGeminiVision(image, prompt, geminiKey, { tier = 'fast', isUniversal = false, timeoutMs = 25000 } = {}) {
    if (!geminiKey) throw new Error('no_key');
    const result = await geminiGenerate({
        key: geminiKey, tier,
        parts: [{ text: prompt }, { inline_data: { mime_type: mimeOfBase64(image), data: image } }],
        json: !isUniversal, thinking: isUniversal ? undefined : 'low',
        temperature: isUniversal && tier === 'pro' ? 0.3 : 0.05,
        maxOutputTokens: isUniversal ? 8192 : 4096,
        deadlineMs: timeoutMs, fetcher: fetchWithTimeout
    });
    return result.text;
}






// ── Google Cloud Vision — DOCUMENT_TEXT_DETECTION ──────────────────────────
// Far superior to generic OCR for dense, small or zoomed-out text (bank
// statements, CRIB reports). Returns the full document text. Uses the same
// Google Cloud API key family as Gemini (project: wealthflow-6dffb).
async function callCloudVision(image, visionKey) {
    if (!visionKey) throw new Error('no_key');
    const url = `https://vision.googleapis.com/v1/images:annotate?key=${visionKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            requests: [{
                image: { content: image },
                features: [{ type: 'DOCUMENT_TEXT_DETECTION', maxResults: 1 }],
                imageContext: { languageHints: ['en', 'si', 'ta'] }
            }]
        })
    }, 22000);
    if (!resp.ok) {
        let detail = '';
        try { const j = await resp.json(); detail = j.error && j.error.message ? j.error.message : ''; } catch (_) {}
        throw new Error(`status ${resp.status}${detail ? ' — ' + detail : ''}`);
    }
    const data = await resp.json();
    const r0 = data.responses && data.responses[0];
    if (r0 && r0.error) throw new Error(r0.error.message || 'vision error');
    const text = (r0 && r0.fullTextAnnotation && r0.fullTextAnnotation.text)
        || (r0 && r0.textAnnotations && r0.textAnnotations[0] && r0.textAnnotations[0].description)
        || '';
    if (!text || text.trim().length < 5) throw new Error('empty_text');
    return text;
}

async function callOcrSpace(image, ocrKey) {
    const key = ocrKey || 'helloworld';
    const form = new URLSearchParams();
    form.append('base64Image', `data:image/jpeg;base64,${image}`);
    form.append('language', 'eng');
    form.append('isOverlayRequired', 'false');
    form.append('detectOrientation', 'true');
    form.append('scale', 'true');
    form.append('OCREngine', '2');
    form.append('isTable', 'true');
    const resp = await fetchWithTimeout('https://api.ocr.space/parse/image', {
        method: 'POST',
        headers: { 'apikey': key, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: form.toString()
    }, 22000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.join(' ') || 'OCR error');
    const parsed = data.ParsedResults?.[0]?.ParsedText;
    if (!parsed || parsed.trim().length < 5) throw new Error('empty_text');
    return parsed;
}

/* Who structures OCR text, in order: the ones whose free plan has answered most reliably first. A provider with no key is skipped. */
const STRUCTURE_ORDER = ['Mistral', 'Groq', 'DeepSeek', 'Ollama', 'NVIDIA', 'OpenRouterScan', 'GitHubModels', 'Together', 'Fireworks'];
const STRUCTURE_BUDGET_MS = 24000;

async function structureRawText(rawText, hints, keys) {
    const today = todayFor(hints);
    const currency = hints?.currency || 'LKR';
    const sysPrompt = `Extract the structured data from this OCR'd receipt text. Return ONLY this JSON:
{"vendor":"","amount":0,"date":"YYYY-MM-DD","category":"","items":[],"currency":"${currency}","tax":null,"payment_method":null,"receipt_number":null,"time":null}

Rules:
- amount = grand total as plain number
- date = YYYY-MM-DD; if not found, "${today}"
- category one of: Food & Groceries, Dining Out, Transport, Utilities, Medical, Education, Entertainment, Clothing, Shopping, Subscriptions, Insurance, Rent/Housing, Personal Care, Other

Receipt text:
"""
${rawText.slice(0, 4000)}
"""`;

    if (keys.geminiKey) {
        try {
            const result = await geminiGenerate({ key: keys.geminiKey, parts: [{ text: sysPrompt }], json: true, thinking: 'low', temperature: 0.05, maxOutputTokens: 1024, deadlineMs: 12000, fetcher: fetchWithTimeout });
            if (result.text) return result.text;
        } catch (_) {}
    }
    // Cohere speaks its own shape (v2 chat); everything else goes through the one shared caller, which asks a model the provider still serves.
    if (keys.cohereKey) {
        try {
            const r = await fetchWithTimeout('https://api.cohere.com/v2/chat', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.cohereKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'command-r-plus-08-2024',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024,
                  response_format: { type: 'json_object' } })
            }, 12000);
            if (r.ok) { const d = await r.json(); const t = d.message?.content?.[0]?.text; if (t && extractJSON(t)) return t; }
        } catch (_) {}
    }
    // One at a time, each with its own short deadline and a total budget: a scan has a minute (maxDuration) and the vision engines have already spent some of it.
    const startedAt = Date.now();
    for (const name of STRUCTURE_ORDER) {
        if (Date.now() - startedAt > STRUCTURE_BUDGET_MS) break;
        if (!keys[PROVIDERS[name].key]) continue;
        try {
            const r = await askProvider(name, { keys, prompt: sysPrompt, fetcher: fetchWithTimeout, tokens: 1024, json: true, timeoutMs: 12000, deadlineMs: 15000 });
            if (r.text && extractJSON(r.text)) return r.text;
        } catch (_) {}
    }
    throw new Error('No text LLM available for structuring');
}




// ---- xAI Grok 2 Vision ----
async function callXaiGrokVision(image, prompt, xaiKey) {
    if (!xaiKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.x.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${xaiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'grok-2-vision-1212',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}`, detail: 'high' } }
                ]
            }],
            temperature: 0.05, max_tokens: 2048
        })
    }, 25000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ---- Anthropic Claude (PREMIUM — claude-3-5-sonnet has top-tier vision) ----
async function callAnthropicClaude(image, prompt, anthropicKey) {
    if (!anthropicKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'x-api-key': anthropicKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 2048,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: image } },
                    { type: 'text', text: prompt }
                ]
            }]
        })
    }, 35000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = data.content?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}


// ---- HuggingFace Inference (Qwen2-VL-7B free serverless) ----
async function callHuggingFaceVision(image, prompt, hfKey) {
    if (!hfKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api-inference.huggingface.co/models/Qwen/Qwen2-VL-7B-Instruct/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${hfKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'Qwen/Qwen2-VL-7B-Instruct',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
            }],
            temperature: 0.05, max_tokens: 2048
        })
    }, 35000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

function normaliseEngineOutput(parsed, hints) {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
        vendor: (typeof parsed.vendor === 'string' && parsed.vendor.trim()) ? parsed.vendor.trim() : null,
        amount: normaliseAmount(parsed.amount ?? parsed.total ?? parsed.grand_total),
        date: normaliseDate(parsed.date ?? parsed.transaction_date, hints?.today),
        category: (typeof parsed.category === 'string' && parsed.category.trim()) ? parsed.category.trim() : null,
        items: Array.isArray(parsed.items) ? parsed.items.slice(0, 10).map(String) : [],
        currency: (typeof parsed.currency === 'string' && parsed.currency.length === 3) ? parsed.currency.toUpperCase() : null,
        tax: normaliseAmount(parsed.tax),
        payment_method: typeof parsed.payment_method === 'string' ? parsed.payment_method.toLowerCase() : null,
        receipt_number: typeof parsed.receipt_number === 'string' ? parsed.receipt_number : null,
        time: typeof parsed.time === 'string' ? parsed.time : null,
        raw_text: typeof parsed.raw_text === 'string' ? parsed.raw_text : null
    };
}

function consensus(engineResults, hints) {
    const successful = engineResults.filter(r => r.fields);
    if (successful.length === 0) return null;

    // UNIVERSAL VISION: pick the most-detailed response, attach all alternatives
    const isUniversal = hints && (hints.taskType === 'universal_vision' || hints.customPrompt);
    if (isUniversal) {
        // Score each by length + structure depth; the longest most-substantive response wins
        const ranked = successful.map(r => ({
            engine: r.name,
            text: (r.fields.raw_text || '').trim(),
            length: (r.fields.raw_text || '').length
        })).sort((a, b) => b.length - a.length);
        const primary = ranked[0];
        return {
            result: {
                vendor: null, amount: null, date: null, category: null,
                items: [], currency: null, tax: null,
                payment_method: null, receipt_number: null, time: null,
                raw_text: primary.text,
                primary_engine: primary.engine,
                alternative_responses: ranked.slice(1, 4).map(r => ({ engine: r.engine, length: r.length }))
            },
            confidence: {
                overall: Math.min(0.95, 0.5 + 0.1 * successful.length),
                engines_agreed: successful.length
            }
        };
    }

    if (successful.length === 1) {
        const f = successful[0].fields;
        return { result: f, confidence: {
            vendor: f.vendor ? 0.70 : 0,
            amount: (f.amount !== null && f.amount !== undefined) ? 0.70 : 0,
            date: f.date ? 0.70 : 0, overall: 0.70
        }};
    }
    function vote(field, isNumeric = false) {
        const values = successful.map(r => r.fields[field]).filter(v => v !== null && v !== undefined && v !== '');
        if (values.length === 0) return { value: null, conf: 0 };
        if (isNumeric) {
            const counts = new Map();
            for (let i = 0; i < values.length; i++) {
                let matched = false;
                for (const k of counts.keys()) {
                    const ref = parseFloat(k);
                    if (Math.abs(values[i] - ref) / Math.max(Math.abs(ref), 1) < 0.01) {
                        counts.set(k, counts.get(k) + 1); matched = true; break;
                    }
                }
                if (!matched) counts.set(String(values[i]), 1);
            }
            let best = null, bestN = 0;
            for (const [k, n] of counts.entries()) {
                if (n > bestN) { best = parseFloat(k); bestN = n; }
            }
            return { value: best, conf: bestN / successful.length };
        }
        const counts = new Map();
        for (const v of values) {
            const k = Array.isArray(v) ? JSON.stringify(v) : String(v).toLowerCase().trim();
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        let bestKey = null, bestN = 0;
        for (const [k, n] of counts.entries()) {
            if (n > bestN) { bestKey = k; bestN = n; }
        }
        let bestVal = null;
        for (const v of values) {
            const k = Array.isArray(v) ? JSON.stringify(v) : String(v).toLowerCase().trim();
            if (k === bestKey) { bestVal = v; break; }
        }
        return { value: bestVal, conf: bestN / successful.length };
    }
    const vendor = vote('vendor'), amount = vote('amount', true), date = vote('date'),
          category = vote('category'), items = vote('items'), currency = vote('currency'),
          tax = vote('tax', true), payment = vote('payment_method'),
          receipt = vote('receipt_number'), time = vote('time');
    let rawText = null;
    for (const r of successful) {
        const t = r.fields.raw_text;
        if (t && (!rawText || t.length > rawText.length)) rawText = t;
    }
    const finalCategory = category.value || inferCategory(vendor.value, rawText);
    const result = {
        vendor: vendor.value, amount: amount.value,
        date: date.value || todayFor(hints),
        category: finalCategory || 'Other',
        items: items.value || [],
        currency: currency.value || inferCurrency(rawText, vendor.value, hints?.currency),
        tax: tax.value, payment_method: payment.value,
        receipt_number: receipt.value, time: time.value, raw_text: rawText
    };
    const overall = (vendor.conf * 0.30) + (amount.conf * 0.40) + (date.conf * 0.20) + (category.conf * 0.10);
    return {
        result,
        confidence: {
            vendor: vendor.conf, amount: amount.conf, date: date.conf,
            category: category.conf,
            overall: Math.min(1, overall + (successful.length >= 3 ? 0.05 : 0))
        }
    };
}

async function runEngine(name, fn, hints) {
    const start = Date.now();
    const isUniversal = hints && (hints.taskType === 'universal_vision' || hints.customPrompt);
    try {
        const raw = await fn();
        const model = fn.model ? { model: String(fn.model).slice(0, 80) } : {};
        if (isUniversal) {
            // Universal-vision mode: return raw text — do NOT force receipt JSON
            return {
                name, success: true, ms: Date.now() - start, ...model,
                fields: {
                    raw_text: typeof raw === 'string' ? raw : JSON.stringify(raw),
                    vendor: null, amount: null, date: null, category: null,
                    items: [], currency: null, tax: null,
                    payment_method: null, receipt_number: null, time: null
                }
            };
        }
        const parsed = extractJSON(raw);
        if (!parsed) throw new Error('invalid_json');
        const fields = normaliseEngineOutput(parsed, hints);
        if (!fields || (fields.amount === null && !fields.vendor)) {
            throw new Error('no_useful_fields');
        }
        return { name, success: true, ms: Date.now() - start, ...model, fields };
    } catch (e) {
        return { name, success: false, ms: Date.now() - start, error: String(e.message || e).slice(0, 360) };
    }
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const startedAt = Date.now();
    const body = req.body || {};
    const { image, hints } = body;
    let mode = (body.mode || 'deep').toLowerCase();
    if (!['quick', 'deep', 'ultra', 'frontier', 'auto'].includes(mode)) mode = 'deep';

    if (!image) return res.status(400).json({ error: 'Missing image (base64)' });
    if (typeof image !== 'string' || image.length < 100) {
        return res.status(400).json({ error: 'Invalid image data' });
    }
    if (image.length > 8_000_000) {
        return res.status(413).json({ error: 'Image too large (>6MB raw). Reduce client-side.' });
    }

    const keys = {
        geminiKey: process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY,
        ollamaKey: process.env.OLLAMA_API_KEY,
        groqKey: process.env.GROQ_API_KEY,
        deepseekKey: process.env.DEEPSEEK_API_KEY,
        openrouterKey: process.env.OPENROUTER_API_KEY,
        mistralKey: process.env.MISTRAL_API_KEY,
        cohereKey: process.env.COHERE_API_KEY,
        ocrSpaceKey: process.env.OCR_SPACE_API_KEY,
        // Google Cloud Vision (same project key family as Gemini). High-accuracy
        // OCR anchor for dense/small/zoomed-out text.
        visionKey: process.env.GOOGLE_VISION_API_KEY || process.env.CLOUD_VISION_API_KEY || process.env.VISION_API_KEY || process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY,
        // ---- new in v3.5 ----
        // GH_PAT first, as api/ai.js reads it: the token carrying the "Models: read" permission is that one (GITHUB_MODELS_TOKEN answered 200 "OK" to every call)
        githubToken: process.env.GH_PAT || process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN,
        togetherKey: process.env.TOGETHER_API_KEY,
        nvidiaKey: process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY,
        xaiKey: process.env.XAI_API_KEY,
        anthropicKey: process.env.ANTHROPIC_API_KEY,
        fireworksKey: process.env.FIREWORKS_API_KEY,
        hfKey: process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN
    };
    /* One reader per provider, asked with a model the provider still serves (ai-provider-call.mjs): the nine hand-named models that stood here
     * were all retired, and every scan fell through to OCR alone. The engine reports which model answered. */
    const reader = (provider, extra = {}) => {
        const fn = async () => {
            const out = await askProvider(provider, { keys, image, prompt, fetcher: fetchWithTimeout, tokens: 2048, ...extra });
            fn.model = out.model;
            return out.text;
        };
        return fn;
    };
    // If the client provides a customPrompt (e.g. for universal vision tasks like
    // identifying a car), use that instead of the receipt-specific prompt.
    const prompt = (hints && hints.customPrompt) ? hints.customPrompt : buildReceiptPrompt(hints);
    const isUniversal = hints && (hints.taskType === 'universal_vision' || hints.customPrompt);

    // ---------- QUICK ----------
    if (mode === 'quick') {
        const engines = [];
        if (keys.geminiKey)  engines.push({ name: 'gemini-flash', fn: () => callGeminiVision(image, prompt, keys.geminiKey, { tier: 'fast', timeoutMs: 18000 }) });
        // one after another, so each gets a short deadline of its own: the first reader that answers ends the scan
        const quick = { deadlineMs: 16000, timeoutMs: 14000 };
        if (keys.ollamaKey)  engines.push({ name: 'ollama', fn: reader('Ollama', { ...quick, json: !isUniversal }) });
        if (keys.groqKey)    engines.push({ name: 'groq', fn: reader('Groq', quick) });
        if (keys.mistralKey) engines.push({ name: 'mistral', fn: reader('Mistral', quick) });
        if (keys.togetherKey) engines.push({ name: 'together', fn: reader('Together', quick) });
        if (keys.githubToken) engines.push({ name: 'github-models', fn: reader('GitHubModels', quick) });
        for (const e of engines) {
            const r = await runEngine(e.name, e.fn, hints);
            if (r.success) {
                const c = consensus([r], hints);
                return res.status(200).json({
                    result: c.result, confidence: c.confidence, engines: [r],
                    mode: 'quick', elapsedMs: Date.now() - startedAt
                });
            }
        }
        return res.status(502).json({ error: 'No engines succeeded', engines, mode: 'quick' });
    }

    // ---------- DEEP / ULTRA / FRONTIER ----------
    const engines = [];

    if (mode === 'frontier' && keys.geminiKey) {
        engines.push({ name: 'gemini-pro', fn: () => callGeminiVision(image, prompt, keys.geminiKey, { tier: 'pro', isUniversal, timeoutMs: isUniversal ? 60000 : 45000 }) });
    }
    // Anthropic Claude — premium quality, only in frontier mode
    if (mode === 'frontier' && keys.anthropicKey) {
        engines.push({ name: 'anthropic-claude-3.5-sonnet', fn: () => callAnthropicClaude(image, prompt, keys.anthropicKey) });
    }
    if (keys.geminiKey) {
        engines.push({ name: 'gemini-flash', fn: () => callGeminiVision(image, prompt, keys.geminiKey, { tier: 'fast', isUniversal, timeoutMs: 25000 }) });
    }
    if (keys.ollamaKey) {
        engines.push({ name: 'ollama', fn: reader('Ollama', { timeoutMs: 30000, json: !isUniversal }) });
    }
    if (mode === 'ultra' || mode === 'frontier') {
        if (keys.togetherKey) engines.push({ name: 'together', fn: reader('Together', { timeoutMs: 28000 }) });
        if (keys.nvidiaKey)   engines.push({ name: 'nvidia', fn: reader('NVIDIA', { timeoutMs: 30000 }) });
        if (keys.githubToken) engines.push({ name: 'github-models', fn: reader('GitHubModels', { timeoutMs: 30000 }) });
        if (keys.xaiKey)      engines.push({ name: 'xai-grok-2-vision', fn: () => callXaiGrokVision(image, prompt, keys.xaiKey) });
        if (keys.fireworksKey) engines.push({ name: 'fireworks', fn: reader('Fireworks') });
        if (keys.hfKey)       engines.push({ name: 'huggingface-qwen2-vl', fn: () => callHuggingFaceVision(image, prompt, keys.hfKey) });
    }
    if (keys.groqKey)    engines.push({ name: 'groq', fn: reader('Groq', { timeoutMs: 18000 }) });
    if (keys.mistralKey) engines.push({ name: 'mistral', fn: reader('Mistral') });
    if (keys.openrouterKey && (mode === 'ultra' || mode === 'frontier'))
        engines.push({ name: 'openrouter', fn: reader('OpenRouterScan') });

    if (engines.length === 0) {
        return res.status(503).json({
            error: 'No vision engines configured',
            details: 'Set WealthFlow_API_Key (Gemini) and/or OLLAMA_API_KEY in Vercel'
        });
    }

    const results = await Promise.all(engines.map(e => runEngine(e.name, e.fn, hints)));

    if (mode === 'ultra' || mode === 'frontier') {
        // Primary OCR anchor: Google Cloud Vision (best for dense/small text),
        // fall back to OCR.space only if Vision is unavailable/fails.
        let rawText = null, ocrEngineName = 'cloud-vision+text-llm';
        try {
            rawText = await callCloudVision(image, keys.visionKey);
        } catch (eV) {
            try { rawText = await callOcrSpace(image, keys.ocrSpaceKey); ocrEngineName = 'ocr.space+text-llm'; }
            catch (eO) { results.push({ name: 'ocr-anchor', success: false, ms: 0, error: 'vision:' + eV.message + ' | ocrspace:' + eO.message }); }
        }
        if (rawText) {
            try {
                const structuredText = await structureRawText(rawText, hints, keys);
                const parsed = extractJSON(structuredText);
                if (parsed) {
                    const fields = normaliseEngineOutput(parsed, hints);
                    if (fields) {
                        fields.raw_text = rawText;
                        results.push({ name: ocrEngineName, success: true, ms: 0, fields });
                    }
                }
            } catch (e) {
                results.push({ name: ocrEngineName, success: false, ms: 0, error: e.message });
            }
        }
    }

    const cons = consensus(results, hints);
    if (!cons) {
        if (mode !== 'ultra' && mode !== 'frontier') {
            try {
                let rawText = null;
                try { rawText = await callCloudVision(image, keys.visionKey); }
                catch (_) { rawText = await callOcrSpace(image, keys.ocrSpaceKey); }
                const structuredText = await structureRawText(rawText, hints, keys);
                const parsed = extractJSON(structuredText);
                if (parsed) {
                    const fields = normaliseEngineOutput(parsed, hints);
                    if (fields) {
                        fields.raw_text = rawText;
                        results.push({ name: 'ocr-anchor+text-llm (fallback)', success: true, ms: 0, fields });
                        const cons2 = consensus(results, hints);
                        if (cons2) {
                            return res.status(200).json({
                                result: cons2.result, confidence: cons2.confidence,
                                engines: results, mode: mode + '+ocr-fallback', elapsedMs: Date.now() - startedAt
                            });
                        }
                    }
                }
            } catch (_) {}
        }
        return res.status(502).json({
            error: 'All providers failed',
            engines: results, mode, elapsedMs: Date.now() - startedAt
        });
    }

    return res.status(200).json({
        result: cons.result, confidence: cons.confidence,
        engines: results, mode, elapsedMs: Date.now() - startedAt
    });
}
