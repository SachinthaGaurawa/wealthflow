// ==================== WealthFlow Vision Engine v2.0 — Multi-Provider OCR ====================
//
// The most accurate receipt scanner in WealthFlow. Runs MULTIPLE vision/OCR providers in
// parallel and performs consensus voting across the results to maximise extraction
// accuracy. This is the dedicated successor of the old "Deep Scanning Receipt" flow.
//
// =========================================================================================
// REQUEST
// =========================================================================================
//   POST /api/vision-scan
//   Body: {
//      image:   base64 (REQUIRED) — JPEG/PNG image without the data:URI prefix
//      mode:    "quick" | "deep" | "ultra" | "auto"   (default: "deep")
//      hints:   { currency?: "LKR", locale?: "si-LK", today?: "YYYY-MM-DD" }
//   }
//
//   - quick : single engine (fastest provider only) — ~2s
//   - deep  : 3 vision engines in parallel, first high-confidence wins — ~3-5s
//   - ultra : ALL engines + OCR fallback, consensus voting — ~6-10s
//   - auto  : starts quick, escalates to deep if confidence < 0.75
//
// =========================================================================================
// RESPONSE
// =========================================================================================
//   {
//     result: {
//        vendor, amount, date (YYYY-MM-DD), category, items[],
//        currency, tax, payment_method, receipt_number, time,
//        raw_text                              // concatenated OCR text
//     },
//     confidence: {
//        vendor, amount, date, overall          // each 0..1
//     },
//     engines: [
//        { name, success, ms, fields, error? }
//     ],
//     mode: "deep",
//     elapsedMs: 4123
//   }
//
// =========================================================================================
// PROVIDERS (in priority order, all called in parallel for deep/ultra)
// =========================================================================================
//   1. Gemini 2.5 Flash         — best price/perf vision (Google)
//   2. Gemini 1.5 Pro           — slower but most accurate Google vision
//   3. Ollama llama3.2-vision   — Meta open vision (via Ollama Cloud)
//   4. Ollama qwen2.5vl         — alternative vision (consensus tiebreaker)
//   5. OCR.space (Engine 2)     — pure OCR text extraction (no LLM)
//   6. Groq Llava               — fast vision via Groq (if key available)
//
// Required env vars:
//   WealthFlow_API_Key  (Gemini)         REQUIRED for full accuracy
//   OLLAMA_API_KEY      (Ollama Cloud)   has hardcoded fallback for the project
//   GROQ_API_KEY        (Groq Llava)     optional
//   OCR_SPACE_API_KEY   (OCR.space)      optional - uses public "helloworld" key if unset
//
// =========================================================================================

export const config = {
    maxDuration: 60   // long enough for ultra mode with all engines
};

// Cache the embedded Ollama key inside the source — the user provided it as a project key.
// Env var still takes precedence if you want to rotate it without redeploy.
const OLLAMA_FALLBACK_KEY = 'f2e8db440e7e4028a40a0aefbf8dbec5.7efl7SycTPjEwR645yJmxTs1';

// ==================== fetch helpers ====================
async function fetchWithTimeout(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } finally {
        clearTimeout(timer);
    }
}

// ==================== JSON extraction (robust) ====================
// LLMs sometimes wrap JSON in ```json fences, prepend chatter, or output near-valid JSON
// with trailing commas. This is forgiving without being permissive of garbage.
function extractJSON(text) {
    if (!text || typeof text !== 'string') return null;
    let cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
    // Try direct parse first
    try { return JSON.parse(cleaned); } catch (_) { /* fall through */ }
    // Look for the largest {...} block
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    let candidate = m[0]
        .replace(/,\s*([}\]])/g, '$1')           // strip trailing commas
        .replace(/[\u201C\u201D]/g, '"')         // smart quotes → straight
        .replace(/[\u2018\u2019]/g, "'");
    try { return JSON.parse(candidate); } catch (_) { return null; }
}

// ==================== amount normalisation ====================
// Receipts have wildly inconsistent number formats:
//   "Rs. 1,234.50", "LKR 1.234,50", "1234/=", "1,234/-", "1234.50"
function normaliseAmount(val) {
    if (val === null || val === undefined) return null;
    if (typeof val === 'number') return Number.isFinite(val) ? val : null;
    if (typeof val !== 'string') return null;
    let s = val.trim();
    // Strip currency markers
    s = s.replace(/(?:LKR|USD|EUR|GBP|INR|AUD|CAD|JPY|CNY|SGD|Rs\.?|රු|₹|\$|€|£|¥)/gi, '');
    s = s.replace(/\/=|\/-/g, '');               // SL trailing markers
    s = s.replace(/\s+/g, '').replace(/[^0-9.,\-]/g, '');
    if (!s) return null;
    // Decide which char is the decimal separator: whichever appears LAST is the decimal
    const lastDot = s.lastIndexOf('.');
    const lastCom = s.lastIndexOf(',');
    if (lastDot > -1 && lastCom > -1) {
        if (lastDot > lastCom) {
            s = s.replace(/,/g, '');             // 1,234.50 → 1234.50
        } else {
            s = s.replace(/\./g, '').replace(',', '.');   // 1.234,50 → 1234.50
        }
    } else if (lastCom > -1 && lastDot === -1) {
        // Only commas — could be thousands or decimal. If 1-2 digits after last comma, treat as decimal
        const after = s.length - lastCom - 1;
        if (after === 1 || after === 2) s = s.replace(',', '.');
        else s = s.replace(/,/g, '');
    }
    const n = parseFloat(s);
    return Number.isFinite(n) ? n : null;
}

// ==================== date normalisation ====================
// Accept formats: YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY (US), DD-Mon-YYYY, etc.
function normaliseDate(val, hintToday) {
    if (!val || typeof val !== 'string') return null;
    const s = val.trim();
    // ISO already
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) {
        const [, y, mo, d] = m;
        return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
    // DD/MM/YYYY or DD-MM-YYYY (most of the world, including Sri Lanka)
    m = s.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})/);
    if (m) {
        let [, d, mo, y] = m;
        if (y.length === 2) y = '20' + y;
        // Heuristic: if first number > 12, it's day. If second > 12, first is month (US).
        const dN = parseInt(d, 10), mN = parseInt(mo, 10);
        let day = d, month = mo;
        if (dN > 12 && mN <= 12)      { day = d;  month = mo; }      // clearly DD/MM
        else if (mN > 12 && dN <= 12) { day = mo; month = d;  }      // clearly MM/DD (US)
        // ambiguous → assume DD/MM (default for Sri Lanka and most of world)
        return `${y}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
    }
    // Month-name forms: 12 Mar 2025  /  Mar 12, 2025
    const MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
    m = s.match(/(\d{1,2})\s+([a-z]{3,9})\s+(\d{2,4})/i);
    if (m) {
        const [, d, mn, y] = m;
        const mNum = MONTHS[mn.slice(0,3).toLowerCase()];
        if (mNum) {
            const yy = y.length === 2 ? '20' + y : y;
            return `${yy}-${String(mNum).padStart(2,'0')}-${d.padStart(2,'0')}`;
        }
    }
    m = s.match(/([a-z]{3,9})\s+(\d{1,2}),?\s+(\d{2,4})/i);
    if (m) {
        const [, mn, d, y] = m;
        const mNum = MONTHS[mn.slice(0,3).toLowerCase()];
        if (mNum) {
            const yy = y.length === 2 ? '20' + y : y;
            return `${yy}-${String(mNum).padStart(2,'0')}-${d.padStart(2,'0')}`;
        }
    }
    return hintToday || null;
}

// ==================== category inference ====================
// Cheap on-device classifier as a backstop in case the LLM doesn't pick a category.
// Order matters — earlier patterns win, so put the more specific ones first.
const CATEGORY_RULES = [
    { cat: 'Dining Out',          pat: /\b(restaurant|cafe|coffee|pizza|kfc|mcdonald|burger|domino|hotel.*lunch|dine|food.*delivery|uber.*eats|pickme.*food)\b/i },
    { cat: 'Food & Groceries',    pat: /\b(grocery|grocer|supermarket|cargill|keells|arpico|laughs|farmers|sathosa|spar|food.?city|maliban|harischandra|delmege|store|mart|fresh|vegetable|bakery)\b/i },
    { cat: 'Transport',           pat: /\b(uber|pickme|taxi|fuel|petrol|diesel|ipg|ceypetco|laugfs|fleet|gas station|bus|train|sltb|parking)\b/i },
    { cat: 'Utilities',           pat: /\b(ceb|leco|nwsdb|water board|electricity|gas board|litro|dialog|slt|mobitel|hutch|airtel|broadband|internet|telecom)\b/i },
    { cat: 'Medical',             pat: /\b(pharmacy|pharmacist|hospital|clinic|medical|lab|x-?ray|asiri|nawaloka|durdans|hemas|royal hospital|chemist|drug|prescription)\b/i },
    { cat: 'Education',           pat: /\b(school|college|tuition|class|institute|university|kaplan|edx|cima|caa|cgma|book.*shop|stationery|sarasavi|vijitha)\b/i },
    { cat: 'Entertainment',       pat: /\b(cinema|netflix|spotify|youtube|hbo|disney|prime video|liberty plaza|majestic|pvr|theatre|concert|game)\b/i },
    { cat: 'Clothing',            pat: /\b(odel|cool planet|fashion|cotton collection|nolimit|kandyan|saree|garment|footwear|nike|adidas|puma|levi|wear)\b/i },
    { cat: 'Subscriptions',       pat: /\b(subscription|monthly plan|annual plan|recurring|gym membership|netflix|spotify|adobe|cloud|hosting|vps|domain)\b/i },
    { cat: 'Insurance',           pat: /\b(insurance|aia|allianz|union assurance|ceylinco|janashakthi|policy|premium.*payment)\b/i },
    { cat: 'Personal Care',       pat: /\b(salon|barber|spa|beauty|cosmetic|skincare|hair|gym|fitness|massage)\b/i },
    { cat: 'Rent/Housing',        pat: /\b(rent|landlord|maintenance|condominium|service charge|housing)\b/i },
    { cat: 'Shopping',            pat: /\b(daraz|amazon|ebay|flipkart|aliexpress|shein|online.*shop|e.?commerce|crocs|samsung|apple store|gadget|electronics)\b/i },
];
function inferCategory(vendor, rawText) {
    const haystack = `${vendor || ''}  ${(rawText || '').slice(0, 1500)}`;
    for (const r of CATEGORY_RULES) {
        if (r.pat.test(haystack)) return r.cat;
    }
    return null;
}

// ==================== currency detection ====================
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
    return hintCurrency || 'LKR';
}

// ==================== prompt builder ====================
function buildReceiptPrompt(hints) {
    const today = (hints && hints.today) || new Date().toISOString().split('T')[0];
    const currency = (hints && hints.currency) || 'LKR';
    return `You are a world-class receipt OCR system specialised for Sri Lankan and international receipts. Read this image with surgical precision and extract every field. Return ONLY a single valid JSON object — no markdown, no commentary, no \`\`\` fences.

CRITICAL RULES:
- amount = the GRAND TOTAL / NET PAYABLE / AMOUNT DUE at the bottom of the receipt (the biggest "Total" — NOT a line item, NOT a subtotal). Return as a plain number with no commas, no currency symbols.
- date = the transaction date in strict YYYY-MM-DD format. Receipts often use DD/MM/YYYY in Sri Lanka — convert correctly. If no date is visible, use "${today}".
- vendor = the merchant/business name shown at the TOP of the receipt (not the parent company name printed in fine print).
- category = pick exactly ONE from: "Food & Groceries", "Dining Out", "Transport", "Utilities", "Medical", "Education", "Entertainment", "Clothing", "Shopping", "Subscriptions", "Insurance", "Rent/Housing", "Personal Care", "Other".
- currency = 3-letter ISO code. Default "${currency}" for Sri Lankan receipts.
- items = up to 10 most prominent items as plain strings. Skip totals / tax lines.
- tax = the tax amount as a number (VAT/GST/NBT/SSCL line), or null if not shown separately.
- payment_method = "cash" | "card" | "digital" | null
- receipt_number = the bill / invoice / receipt number if printed, else null
- time = HH:MM 24-hour clock, else null
- raw_text = the full text you read from the receipt, line by line, separated by \\n

OUTPUT FORMAT (single line, valid JSON, every field present):
{"vendor":"","amount":0,"date":"YYYY-MM-DD","category":"","items":[],"currency":"${currency}","tax":null,"payment_method":null,"receipt_number":null,"time":null,"raw_text":""}`;
}

// ==================== Provider 1: Gemini 2.5 Flash (primary) ====================
async function callGemini25Flash(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096, responseMimeType: 'application/json' },
            safetySettings: [
                { category: 'HARM_CATEGORY_HARASSMENT',        threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH',       threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
        })
    }, 20000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked_by_safety');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 2: Gemini 2.0 Flash (fast fallback) ====================
async function callGemini20Flash(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        })
    }, 18000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked_by_safety');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 3: Gemini 1.5 Pro (highest accuracy) ====================
async function callGemini15Pro(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096 }
        })
    }, 28000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked_by_safety');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 4: Ollama Cloud — llama3.2-vision ====================
async function callOllamaVision(image, prompt, ollamaKey) {
    if (!ollamaKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ollamaKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama3.2-vision',
            messages: [{ role: 'user', content: prompt, images: [image] }],
            stream: false,
            format: 'json',
            options: { temperature: 0.05, num_predict: 2048 }
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = data.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 5: Ollama Cloud — qwen2.5vl (tiebreaker) ====================
async function callOllamaQwen(image, prompt, ollamaKey) {
    if (!ollamaKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://ollama.com/api/chat', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${ollamaKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'qwen2.5vl',
            messages: [{ role: 'user', content: prompt, images: [image] }],
            stream: false,
            format: 'json',
            options: { temperature: 0.05, num_predict: 2048 }
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 6: Groq Llava (fast vision fallback) ====================
async function callGroqLlava(image, prompt, groqKey) {
    if (!groqKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${groqKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'llama-3.2-90b-vision-preview',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
            }],
            temperature: 0.05,
            max_tokens: 2048
        })
    }, 18000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ==================== Provider 7: OCR.space — pure text extraction ====================
// Used as a "raw text" anchor — we then feed the text into a text LLM for structured extraction
// when the vision models all disagree or fail. The "helloworld" key is rate-limited but works
// for low-volume usage; set OCR_SPACE_API_KEY for a personal key.
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
        headers: {
            'apikey': key,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: form.toString()
    }, 22000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.IsErroredOnProcessing) throw new Error(data.ErrorMessage?.join(' ') || 'OCR error');
    const parsed = data.ParsedResults?.[0]?.ParsedText;
    if (!parsed || parsed.trim().length < 5) throw new Error('empty_text');
    return parsed;
}

// ==================== Provider 7b: Structure OCR text via text LLM ====================
// Once OCR.space gives us raw text, we ask Gemini (or whichever text engine is available)
// to structure it. Cheap and very accurate when the receipt text was readable.
async function structureRawText(rawText, hints, geminiKey, groqKey, deepseekKey) {
    const today = hints?.today || new Date().toISOString().split('T')[0];
    const currency = hints?.currency || 'LKR';
    const sysPrompt = `You will receive the raw OCR text of a receipt. Extract the structured data and return ONLY this JSON, nothing else:
{"vendor":"","amount":0,"date":"YYYY-MM-DD","category":"","items":[],"currency":"${currency}","tax":null,"payment_method":null,"receipt_number":null,"time":null}

Rules:
- amount = the grand total as a plain number, no commas, no currency
- date = YYYY-MM-DD; if not found, "${today}"
- category one of: Food & Groceries, Dining Out, Transport, Utilities, Medical, Education, Entertainment, Clothing, Shopping, Subscriptions, Insurance, Rent/Housing, Personal Care, Other
- items: up to 10 prominent items as plain strings

Receipt text:
"""
${rawText.slice(0, 4000)}
"""`;

    // Try Gemini text → DeepSeek → Groq
    if (geminiKey) {
        try {
            const r = await fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${geminiKey}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        contents: [{ parts: [{ text: sysPrompt }] }],
                        generationConfig: { temperature: 0.05, maxOutputTokens: 1024, responseMimeType: 'application/json' }
                    })
                }, 15000);
            if (r.ok) {
                const d = await r.json();
                const t = d.candidates?.[0]?.content?.parts?.[0]?.text;
                if (t) return t;
            }
        } catch (_) {}
    }
    if (deepseekKey) {
        try {
            const r = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${deepseekKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'deepseek-chat',
                    messages: [{ role: 'user', content: sysPrompt }],
                    temperature: 0.05,
                    max_tokens: 1024,
                    response_format: { type: 'json_object' }
                })
            }, 15000);
            if (r.ok) {
                const d = await r.json();
                const t = d.choices?.[0]?.message?.content;
                if (t) return t;
            }
        } catch (_) {}
    }
    if (groqKey) {
        try {
            const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'llama-3.3-70b-versatile',
                    messages: [{ role: 'user', content: sysPrompt }],
                    temperature: 0.05,
                    max_tokens: 1024,
                    response_format: { type: 'json_object' }
                })
            }, 15000);
            if (r.ok) {
                const d = await r.json();
                const t = d.choices?.[0]?.message?.content;
                if (t) return t;
            }
        } catch (_) {}
    }
    throw new Error('No text LLM available for OCR structuring');
}

// ==================== Normalise & validate one engine's parsed output ====================
function normaliseEngineOutput(parsed, hints) {
    if (!parsed || typeof parsed !== 'object') return null;
    return {
        vendor:         (typeof parsed.vendor === 'string' && parsed.vendor.trim()) ? parsed.vendor.trim() : null,
        amount:         normaliseAmount(parsed.amount ?? parsed.total ?? parsed.grand_total),
        date:           normaliseDate(parsed.date ?? parsed.transaction_date, hints?.today),
        category:       (typeof parsed.category === 'string' && parsed.category.trim()) ? parsed.category.trim() : null,
        items:          Array.isArray(parsed.items) ? parsed.items.slice(0, 10).map(String) : [],
        currency:       (typeof parsed.currency === 'string' && parsed.currency.length === 3) ? parsed.currency.toUpperCase() : null,
        tax:            normaliseAmount(parsed.tax),
        payment_method: typeof parsed.payment_method === 'string' ? parsed.payment_method.toLowerCase() : null,
        receipt_number: typeof parsed.receipt_number === 'string' ? parsed.receipt_number : null,
        time:           typeof parsed.time === 'string' ? parsed.time : null,
        raw_text:       typeof parsed.raw_text === 'string' ? parsed.raw_text : null
    };
}

// ==================== Consensus voting across engines ====================
// For each field we take the most common value. Ties broken by engine priority order.
// We also compute a 0-1 confidence per field based on agreement.
function consensus(engineResults, hints) {
    const successful = engineResults.filter(r => r.fields);
    if (successful.length === 0) return null;
    if (successful.length === 1) {
        const f = successful[0].fields;
        return {
            result: f,
            confidence: {
                vendor:  f.vendor ? 0.70 : 0,
                amount:  (f.amount !== null && f.amount !== undefined) ? 0.70 : 0,
                date:    f.date ? 0.70 : 0,
                overall: 0.70
            }
        };
    }

    // Vote per field. For amounts, accept values within 1% of each other as agreeing.
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
                        counts.set(k, counts.get(k) + 1);
                        matched = true; break;
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
        // String/array voting
        const counts = new Map();
        for (const v of values) {
            const k = Array.isArray(v) ? JSON.stringify(v) : String(v).toLowerCase().trim();
            counts.set(k, (counts.get(k) || 0) + 1);
        }
        let bestKey = null, bestN = 0;
        for (const [k, n] of counts.entries()) {
            if (n > bestN) { bestKey = k; bestN = n; }
        }
        // Return original-cased value
        let bestVal = null;
        for (const v of values) {
            const k = Array.isArray(v) ? JSON.stringify(v) : String(v).toLowerCase().trim();
            if (k === bestKey) { bestVal = v; break; }
        }
        return { value: bestVal, conf: bestN / successful.length };
    }

    const vendor   = vote('vendor');
    const amount   = vote('amount', true);
    const date     = vote('date');
    const category = vote('category');
    const items    = vote('items');
    const currency = vote('currency');
    const tax      = vote('tax', true);
    const payment  = vote('payment_method');
    const receipt  = vote('receipt_number');
    const time     = vote('time');

    // Pick the longest raw_text we got (best OCR coverage usually wins)
    let rawText = null;
    for (const r of successful) {
        const t = r.fields.raw_text;
        if (t && (!rawText || t.length > rawText.length)) rawText = t;
    }

    // Category backstop — if no engine picked one, infer from text
    const finalCategory = category.value || inferCategory(vendor.value, rawText);

    const result = {
        vendor:         vendor.value,
        amount:         amount.value,
        date:           date.value || hints?.today || new Date().toISOString().split('T')[0],
        category:       finalCategory || 'Other',
        items:          items.value || [],
        currency:       currency.value || inferCurrency(rawText, vendor.value, hints?.currency),
        tax:            tax.value,
        payment_method: payment.value,
        receipt_number: receipt.value,
        time:           time.value,
        raw_text:       rawText
    };

    // Confidence weights — vendor/amount/date matter most.
    const overall = (
        (vendor.conf   * 0.30) +
        (amount.conf   * 0.40) +
        (date.conf     * 0.20) +
        (category.conf * 0.10)
    );

    return {
        result,
        confidence: {
            vendor:  vendor.conf,
            amount:  amount.conf,
            date:    date.conf,
            category: category.conf,
            overall: Math.min(1, overall + (successful.length >= 3 ? 0.05 : 0))   // 3-engine consensus bonus
        }
    };
}

// ==================== Run a single engine, return a uniform record ====================
async function runEngine(name, fn, hints) {
    const start = Date.now();
    try {
        const raw = await fn();
        const parsed = extractJSON(raw);
        if (!parsed) throw new Error('invalid_json');
        const fields = normaliseEngineOutput(parsed, hints);
        if (!fields || (fields.amount === null && !fields.vendor)) {
            throw new Error('no_useful_fields');
        }
        return { name, success: true, ms: Date.now() - start, fields };
    } catch (e) {
        return { name, success: false, ms: Date.now() - start, error: String(e.message || e).slice(0, 200) };
    }
}

// ==================== HANDLER ====================
export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

    const startedAt = Date.now();
    const body = req.body || {};
    const { image, hints } = body;
    let mode = (body.mode || 'deep').toLowerCase();
    if (!['quick', 'deep', 'ultra', 'auto'].includes(mode)) mode = 'deep';

    if (!image) return res.status(400).json({ error: 'Missing image (base64)' });
    if (typeof image !== 'string' || image.length < 100) {
        return res.status(400).json({ error: 'Invalid image data' });
    }

    const geminiKey   = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
    const ollamaKey   = process.env.OLLAMA_API_KEY || OLLAMA_FALLBACK_KEY;
    const groqKey     = process.env.GROQ_API_KEY;
    const deepseekKey = process.env.DEEPSEEK_API_KEY;
    const ocrSpaceKey = process.env.OCR_SPACE_API_KEY;

    const prompt = buildReceiptPrompt(hints);

    // ---------- QUICK ----------
    if (mode === 'quick') {
        const engines = [];
        if (geminiKey) engines.push({ name: 'gemini-2.0-flash', fn: () => callGemini20Flash(image, prompt, geminiKey) });
        if (ollamaKey) engines.push({ name: 'ollama-llama3.2-vision', fn: () => callOllamaVision(image, prompt, ollamaKey) });
        if (groqKey)   engines.push({ name: 'groq-llava', fn: () => callGroqLlava(image, prompt, groqKey) });

        for (const e of engines) {
            const r = await runEngine(e.name, e.fn, hints);
            if (r.success) {
                const c = consensus([r], hints);
                return res.status(200).json({
                    result: c.result,
                    confidence: c.confidence,
                    engines: [r],
                    mode: 'quick',
                    elapsedMs: Date.now() - startedAt
                });
            }
        }
        return res.status(502).json({ error: 'No engines succeeded', engines, mode: 'quick' });
    }

    // ---------- DEEP & ULTRA: parallel vision engines ----------
    const engines = [];
    if (geminiKey) engines.push({ name: 'gemini-2.5-flash',         fn: () => callGemini25Flash(image, prompt, geminiKey) });
    if (geminiKey) engines.push({ name: 'gemini-2.0-flash',         fn: () => callGemini20Flash(image, prompt, geminiKey) });
    if (ollamaKey) engines.push({ name: 'ollama-llama3.2-vision',   fn: () => callOllamaVision(image, prompt, ollamaKey) });
    if (mode === 'ultra' && geminiKey) engines.push({ name: 'gemini-1.5-pro', fn: () => callGemini15Pro(image, prompt, geminiKey) });
    if (mode === 'ultra' && ollamaKey) engines.push({ name: 'ollama-qwen2.5vl', fn: () => callOllamaQwen(image, prompt, ollamaKey) });
    if (groqKey) engines.push({ name: 'groq-llava', fn: () => callGroqLlava(image, prompt, groqKey) });

    if (engines.length === 0) {
        return res.status(503).json({
            error: 'No vision engines configured',
            details: 'Set WealthFlow_API_Key (Gemini) and/or OLLAMA_API_KEY in Vercel'
        });
    }

    // Run ALL in parallel — total wall time = slowest engine in this batch
    const results = await Promise.all(engines.map(e => runEngine(e.name, e.fn, hints)));

    // ULTRA mode also runs OCR.space + structures it, adding to the consensus pool
    if (mode === 'ultra') {
        try {
            const rawText = await callOcrSpace(image, ocrSpaceKey);
            try {
                const structuredText = await structureRawText(rawText, hints, geminiKey, groqKey, deepseekKey);
                const parsed = extractJSON(structuredText);
                if (parsed) {
                    const fields = normaliseEngineOutput(parsed, hints);
                    if (fields) {
                        fields.raw_text = rawText;
                        results.push({ name: 'ocr.space+text-llm', success: true, ms: 0, fields });
                    }
                }
            } catch (e) {
                results.push({ name: 'ocr.space+text-llm', success: false, ms: 0, error: e.message });
            }
        } catch (e) {
            results.push({ name: 'ocr.space', success: false, ms: 0, error: e.message });
        }
    }

    const cons = consensus(results, hints);
    if (!cons) {
        // Last-ditch: try OCR.space + structure if we haven't already
        if (mode !== 'ultra') {
            try {
                const rawText = await callOcrSpace(image, ocrSpaceKey);
                const structuredText = await structureRawText(rawText, hints, geminiKey, groqKey, deepseekKey);
                const parsed = extractJSON(structuredText);
                if (parsed) {
                    const fields = normaliseEngineOutput(parsed, hints);
                    if (fields) {
                        fields.raw_text = rawText;
                        results.push({ name: 'ocr.space+text-llm (fallback)', success: true, ms: 0, fields });
                        const cons2 = consensus(results, hints);
                        if (cons2) {
                            return res.status(200).json({
                                result: cons2.result,
                                confidence: cons2.confidence,
                                engines: results,
                                mode: mode + '+ocr-fallback',
                                elapsedMs: Date.now() - startedAt
                            });
                        }
                    }
                }
            } catch (_) {}
        }
        return res.status(502).json({
            error: 'All providers failed',
            engines: results,
            mode,
            elapsedMs: Date.now() - startedAt
        });
    }

    // ---------- AUTO escalation ----------
    if (mode === 'auto' && cons.confidence.overall < 0.75) {
        // We already ran 2-3 engines. Add the heavy ones and re-vote.
        const escalation = [];
        if (geminiKey && !results.find(r => r.name === 'gemini-1.5-pro')) {
            escalation.push({ name: 'gemini-1.5-pro', fn: () => callGemini15Pro(image, prompt, geminiKey) });
        }
        if (ollamaKey && !results.find(r => r.name === 'ollama-qwen2.5vl')) {
            escalation.push({ name: 'ollama-qwen2.5vl', fn: () => callOllamaQwen(image, prompt, ollamaKey) });
        }
        const extra = await Promise.all(escalation.map(e => runEngine(e.name, e.fn, hints)));
        results.push(...extra);
        const cons3 = consensus(results, hints);
        return res.status(200).json({
            result: cons3.result,
            confidence: cons3.confidence,
            engines: results,
            mode: 'auto+escalated',
            elapsedMs: Date.now() - startedAt
        });
    }

    return res.status(200).json({
        result: cons.result,
        confidence: cons.confidence,
        engines: results,
        mode,
        elapsedMs: Date.now() - startedAt
    });
}
