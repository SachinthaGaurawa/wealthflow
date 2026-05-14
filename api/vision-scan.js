// ==================== WealthFlow Vision Engine v3.0 — Frontier Multi-Provider ====================
//
// 12+ AI engines including 2026's frontier models:
//   FRONTIER: Gemini 3.1 Pro Preview, Gemini 3 Flash Preview
//   STABLE:   Gemini 2.5 Flash/Pro, Gemini 2.0 Flash
//   OPEN:     Ollama llama3.2-vision, qwen2.5vl
//   FAST:     Groq Llava 90B, Cerebras Llama 3.3 70B
//   AGGREGATOR: OpenRouter (Qwen2.5-VL free, DeepSeek free)
//   ANCHOR:   OCR.space + text-LLM structuring
//   FALLBACK: Mistral Pixtral, Cohere Command R+
//
// MODES: quick | deep | ultra | frontier
//
// ENV (all optional except WealthFlow_API_Key):
//   WealthFlow_API_Key, OLLAMA_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY,
//   OPENROUTER_API_KEY, MISTRAL_API_KEY, COHERE_API_KEY, DEEPSEEK_API_KEY,
//   OCR_SPACE_API_KEY

export const config = {
    maxDuration: 60,
    api: { bodyParser: { sizeLimit: '4mb' } }
};

const OLLAMA_FALLBACK_KEY = 'f2e8db440e7e4028a40a0aefbf8dbec5.7efl7SycTPjEwR645yJmxTs1';

async function fetchWithTimeout(url, options, timeoutMs = 22000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

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

function buildReceiptPrompt(hints) {
    const today = (hints && hints.today) || new Date().toISOString().split('T')[0];
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

async function callGemini31Pro(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: {
                temperature: 0.05, maxOutputTokens: 4096,
                responseMimeType: 'application/json',
                thinkingConfig: { thinkingLevel: 'medium' }
            }
        })
    }, 45000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

async function callGemini3Flash(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096, responseMimeType: 'application/json' }
        })
    }, 25000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

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
                { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
                { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
            ]
        })
    }, 20000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    if (data.promptFeedback?.blockReason) throw new Error('blocked');
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

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
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

async function callGemini25Pro(image, prompt, geminiKey) {
    if (!geminiKey) throw new Error('no_key');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=${geminiKey}`;
    const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: 'image/jpeg', data: image } }] }],
            generationConfig: { temperature: 0.05, maxOutputTokens: 4096 }
        })
    }, 32000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) throw new Error('empty');
    return text;
}

async function callOllamaVision(image, prompt, ollamaKey) {
    if (!ollamaKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'llama3.2-vision',
            messages: [{ role: 'user', content: prompt, images: [image] }],
            stream: false, format: 'json',
            options: { temperature: 0.05, num_predict: 2048 }
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = data.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

async function callOllamaQwen(image, prompt, ollamaKey) {
    if (!ollamaKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://ollama.com/api/chat', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${ollamaKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'qwen2.5vl',
            messages: [{ role: 'user', content: prompt, images: [image] }],
            stream: false, format: 'json',
            options: { temperature: 0.05, num_predict: 2048 }
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

async function callGroqLlava(image, prompt, groqKey) {
    if (!groqKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'llama-3.2-90b-vision-preview',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
            }],
            temperature: 0.05, max_tokens: 2048
        })
    }, 18000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

async function callMistralPixtral(image, prompt, mistralKey) {
    if (!mistralKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${mistralKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'pixtral-large-latest',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: `data:image/jpeg;base64,${image}` }
                ]
            }],
            temperature: 0.05, max_tokens: 2048,
            response_format: { type: 'json_object' }
        })
    }, 25000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

async function callOpenRouterVision(image, prompt, openrouterKey) {
    if (!openrouterKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${openrouterKey}`, 'Content-Type': 'application/json',
            'HTTP-Referer': 'https://wealthflow-personal.vercel.app', 'X-Title': 'WealthFlow'
        },
        body: JSON.stringify({
            model: 'qwen/qwen-2.5-vl-72b-instruct:free',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
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

async function structureRawText(rawText, hints, keys) {
    const today = hints?.today || new Date().toISOString().split('T')[0];
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
            const r = await fetchWithTimeout(
                `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${keys.geminiKey}`,
                { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ contents: [{ parts: [{ text: sysPrompt }] }],
                    generationConfig: { temperature: 0.05, maxOutputTokens: 1024, responseMimeType: 'application/json' } })
                }, 12000);
            if (r.ok) {
                const d = await r.json();
                const t = d.candidates?.[0]?.content?.parts?.[0]?.text;
                if (t) return t;
            }
        } catch (_) {}
    }
    if (keys.cerebrasKey) {
        try {
            const r = await fetchWithTimeout('https://api.cerebras.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.cerebrasKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'llama-3.3-70b',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024 })
            }, 8000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
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
            if (r.ok) { const d = await r.json(); const t = d.message?.content?.[0]?.text; if (t) return t; }
        } catch (_) {}
    }
    if (keys.deepseekKey) {
        try {
            const r = await fetchWithTimeout('https://api.deepseek.com/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.deepseekKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'deepseek-chat',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024,
                  response_format: { type: 'json_object' } })
            }, 15000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    if (keys.groqKey) {
        try {
            const r = await fetchWithTimeout('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.groqKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'llama-3.3-70b-versatile',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024,
                  response_format: { type: 'json_object' } })
            }, 12000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    if (keys.openrouterKey) {
        try {
            const r = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.openrouterKey}`, 'Content-Type': 'application/json',
                           'HTTP-Referer': 'https://wealthflow-personal.vercel.app', 'X-Title': 'WealthFlow' },
                body: JSON.stringify({ model: 'deepseek/deepseek-chat:free',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024,
                  response_format: { type: 'json_object' } })
            }, 15000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    // SambaNova — ultra-fast Llama 3.3 70B (FREE tier)
    if (keys.sambanovaKey) {
        try {
            const r = await fetchWithTimeout('https://api.sambanova.ai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.sambanovaKey}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'Meta-Llama-3.3-70B-Instruct',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024 })
            }, 8000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    // GitHub Models — DeepSeek-R1 FREE (requires GitHub PAT)
    if (keys.githubToken) {
        try {
            const r = await fetchWithTimeout('https://models.github.ai/inference/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.githubToken}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: 'DeepSeek-R1',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024 })
            }, 18000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    // NVIDIA NIM — Mistral Nemotron 70B (FREE tier)
    if (keys.nvidiaKey) {
        try {
            const r = await fetchWithTimeout('https://integrate.api.nvidia.com/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${keys.nvidiaKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
                body: JSON.stringify({ model: 'nvidia/llama-3.1-nemotron-70b-instruct',
                  messages: [{ role: 'user', content: sysPrompt }],
                  temperature: 0.05, max_tokens: 1024 })
            }, 18000);
            if (r.ok) { const d = await r.json(); const t = d.choices?.[0]?.message?.content; if (t) return t; }
        } catch (_) {}
    }
    throw new Error('No text LLM available for structuring');
}

// ---- GitHub Models (FREE — OpenAI-compatible, GPT-4o vision, requires GitHub PAT) ----
async function callGitHubModelsGPT4o(image, prompt, githubToken) {
    if (!githubToken) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://models.github.ai/inference/chat/completions', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            model: 'gpt-4o',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
            }],
            temperature: 0.05, max_tokens: 2048,
            response_format: { type: 'json_object' }
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ---- Together AI (FREE tier — Llama 3.2 90B Vision Instruct) ----
async function callTogetherVision(image, prompt, togetherKey) {
    if (!togetherKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.together.xyz/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${togetherKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'meta-llama/Llama-3.2-90B-Vision-Instruct-Turbo',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
                ]
            }],
            temperature: 0.05, max_tokens: 2048
        })
    }, 28000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
}

// ---- NVIDIA NIM (FREE tier — Llama 3.2 90B Vision Instruct) ----
async function callNvidiaVision(image, prompt, nvidiaKey) {
    if (!nvidiaKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${nvidiaKey}`, 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({
            model: 'meta/llama-3.2-90b-vision-instruct',
            messages: [{
                role: 'user',
                content: `${prompt}\n<img src="data:image/jpeg;base64,${image}" />`
            }],
            temperature: 0.05, max_tokens: 2048, top_p: 1, stream: false
        })
    }, 30000);
    if (!resp.ok) throw new Error(`status ${resp.status}`);
    const data = await resp.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('empty');
    return text;
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

// ---- Fireworks AI (Phi-3 Vision) ----
async function callFireworksVision(image, prompt, fireworksKey) {
    if (!fireworksKey) throw new Error('no_key');
    const resp = await fetchWithTimeout('https://api.fireworks.ai/inference/v1/chat/completions', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${fireworksKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
            model: 'accounts/fireworks/models/phi-3-vision-128k-instruct',
            messages: [{
                role: 'user',
                content: [
                    { type: 'text', text: prompt },
                    { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${image}` } }
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
        date: date.value || hints?.today || new Date().toISOString().split('T')[0],
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
        ollamaKey: process.env.OLLAMA_API_KEY || OLLAMA_FALLBACK_KEY,
        groqKey: process.env.GROQ_API_KEY,
        deepseekKey: process.env.DEEPSEEK_API_KEY,
        cerebrasKey: process.env.CEREBRAS_API_KEY,
        openrouterKey: process.env.OPENROUTER_API_KEY,
        mistralKey: process.env.MISTRAL_API_KEY,
        cohereKey: process.env.COHERE_API_KEY,
        ocrSpaceKey: process.env.OCR_SPACE_API_KEY,
        // ---- new in v3.5 ----
        githubToken: process.env.GITHUB_MODELS_TOKEN || process.env.GITHUB_TOKEN,
        togetherKey: process.env.TOGETHER_API_KEY,
        nvidiaKey: process.env.NVIDIA_API_KEY || process.env.NIM_API_KEY,
        xaiKey: process.env.XAI_API_KEY,
        anthropicKey: process.env.ANTHROPIC_API_KEY,
        fireworksKey: process.env.FIREWORKS_API_KEY,
        hfKey: process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN,
        sambanovaKey: process.env.SAMBANOVA_API_KEY
    };
    const prompt = buildReceiptPrompt(hints);

    // ---------- QUICK ----------
    if (mode === 'quick') {
        const engines = [];
        if (keys.geminiKey)  engines.push({ name: 'gemini-2.0-flash', fn: () => callGemini20Flash(image, prompt, keys.geminiKey) });
        if (keys.ollamaKey)  engines.push({ name: 'ollama-llama3.2-vision', fn: () => callOllamaVision(image, prompt, keys.ollamaKey) });
        if (keys.groqKey)    engines.push({ name: 'groq-llava', fn: () => callGroqLlava(image, prompt, keys.groqKey) });
        if (keys.mistralKey) engines.push({ name: 'mistral-pixtral', fn: () => callMistralPixtral(image, prompt, keys.mistralKey) });
        if (keys.togetherKey) engines.push({ name: 'together-llama-3.2-vision', fn: () => callTogetherVision(image, prompt, keys.togetherKey) });
        if (keys.githubToken) engines.push({ name: 'github-models-gpt4o', fn: () => callGitHubModelsGPT4o(image, prompt, keys.githubToken) });
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
        engines.push({ name: 'gemini-3.1-pro-preview', fn: () => callGemini31Pro(image, prompt, keys.geminiKey) });
        engines.push({ name: 'gemini-3-flash-preview', fn: () => callGemini3Flash(image, prompt, keys.geminiKey) });
    }
    // Anthropic Claude — premium quality, only in frontier mode
    if (mode === 'frontier' && keys.anthropicKey) {
        engines.push({ name: 'anthropic-claude-3.5-sonnet', fn: () => callAnthropicClaude(image, prompt, keys.anthropicKey) });
    }
    if (keys.geminiKey) {
        engines.push({ name: 'gemini-2.5-flash', fn: () => callGemini25Flash(image, prompt, keys.geminiKey) });
        engines.push({ name: 'gemini-2.0-flash', fn: () => callGemini20Flash(image, prompt, keys.geminiKey) });
    }
    if (keys.ollamaKey) {
        engines.push({ name: 'ollama-llama3.2-vision', fn: () => callOllamaVision(image, prompt, keys.ollamaKey) });
    }
    if (mode === 'ultra' || mode === 'frontier') {
        if (keys.geminiKey)   engines.push({ name: 'gemini-2.5-pro', fn: () => callGemini25Pro(image, prompt, keys.geminiKey) });
        if (keys.ollamaKey)   engines.push({ name: 'ollama-qwen2.5vl', fn: () => callOllamaQwen(image, prompt, keys.ollamaKey) });
        if (keys.togetherKey) engines.push({ name: 'together-llama-3.2-vision', fn: () => callTogetherVision(image, prompt, keys.togetherKey) });
        if (keys.nvidiaKey)   engines.push({ name: 'nvidia-llama-3.2-vision', fn: () => callNvidiaVision(image, prompt, keys.nvidiaKey) });
        if (keys.githubToken) engines.push({ name: 'github-models-gpt4o', fn: () => callGitHubModelsGPT4o(image, prompt, keys.githubToken) });
        if (keys.xaiKey)      engines.push({ name: 'xai-grok-2-vision', fn: () => callXaiGrokVision(image, prompt, keys.xaiKey) });
        if (keys.fireworksKey) engines.push({ name: 'fireworks-phi-3-vision', fn: () => callFireworksVision(image, prompt, keys.fireworksKey) });
        if (keys.hfKey)       engines.push({ name: 'huggingface-qwen2-vl', fn: () => callHuggingFaceVision(image, prompt, keys.hfKey) });
    }
    if (keys.groqKey)    engines.push({ name: 'groq-llava', fn: () => callGroqLlava(image, prompt, keys.groqKey) });
    if (keys.mistralKey) engines.push({ name: 'mistral-pixtral', fn: () => callMistralPixtral(image, prompt, keys.mistralKey) });
    if (keys.openrouterKey && (mode === 'ultra' || mode === 'frontier'))
        engines.push({ name: 'openrouter-qwen2.5vl-free', fn: () => callOpenRouterVision(image, prompt, keys.openrouterKey) });

    if (engines.length === 0) {
        return res.status(503).json({
            error: 'No vision engines configured',
            details: 'Set WealthFlow_API_Key (Gemini) and/or OLLAMA_API_KEY in Vercel'
        });
    }

    const results = await Promise.all(engines.map(e => runEngine(e.name, e.fn, hints)));

    if (mode === 'ultra' || mode === 'frontier') {
        try {
            const rawText = await callOcrSpace(image, keys.ocrSpaceKey);
            try {
                const structuredText = await structureRawText(rawText, hints, keys);
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
        if (mode !== 'ultra' && mode !== 'frontier') {
            try {
                const rawText = await callOcrSpace(image, keys.ocrSpaceKey);
                const structuredText = await structureRawText(rawText, hints, keys);
                const parsed = extractJSON(structuredText);
                if (parsed) {
                    const fields = normaliseEngineOutput(parsed, hints);
                    if (fields) {
                        fields.raw_text = rawText;
                        results.push({ name: 'ocr.space+text-llm (fallback)', success: true, ms: 0, fields });
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
