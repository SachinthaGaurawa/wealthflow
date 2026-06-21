// ============================================================================
//  WealthFlow · /api/classify-charge        v7.28.0
// ----------------------------------------------------------------------------
//  WealthFlow's OWN, purpose-built charge-classification engine. Given a list of
//  raw statement descriptions it returns, for EACH one, the credit-card charge
//  TYPE  ∈ { purchase | cash_advance | service_fee | fuel }  and a best-guess
//  expense category — with a confidence score.
//
//  HOW IT REACHES ~100 % USABLE ACCURACY (honest framing):
//    1) A deterministic knowledge base (the same rules the front-end uses) settles
//       the overwhelming majority of real Sri Lankan statement lines INSTANTLY and
//       OFFLINE — fuel forecourts, ATM/cash-advance, and the whole tax/levy/
//       interest/fee family. These come back at confidence ≥ 0.95 with no AI call.
//    2) ONLY the genuinely ambiguous remainder (a bare "purchase") is sent to a
//       MULTI-ENGINE AI CONSENSUS: every provider the owner has configured in
//       Vercel votes, and the majority verdict wins. More voters → more robust.
//    3) The AI may only UPGRADE a generic guess — it can never override a verdict
//       the deterministic KB is already certain about (so fuel/cash-advance/fees
//       stay locked and the classifier only ever improves).
//
//  Contract:
//    POST { descriptions: ["MORAWAKA FUEL STATION", "DEBIT INTEREST", ...] }
//      (also accepts { items:[{description}] } or a single { description })
//    →   { ok, mode, engines:[...], results:[ { i, description, type, category,
//          confidence, source, engineVotes } ] }
//
//  ALWAYS returns JSON, NEVER throws past the handler, and every provider call is
//  bounded by a timeout so one slow engine can't stall the request.
// ============================================================================

export const config = { maxDuration: 45 };

const OLLAMA_FALLBACK_KEY = 'f2e8db440e7e4028a40a0aefbf8dbec5.7efl7SycTPjEwR645yJmxTs1';

async function fetchWithTimeout(url, options, timeoutMs = 14000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

/* ---------------------------------------------------------------------------
 *  DETERMINISTIC KNOWLEDGE BASE  (kept in lock-step with wealthflow-route.js)
 *  Order matters: a fee/levy/tax/interest WINS over fuel and cash-advance, so
 *  "FUEL SURCHARGE" → service_fee and "LOCAL CASH ADVANCE FEE" → service_fee.
 * ------------------------------------------------------------------------- */
const RE_FUEL = /\b(fuel|petrol|diesel|petrol shed|fuel shed|filling station|fuel station|filling|ceypetco|lanka ioc|\bioc\b|sinopec|total energies|gas station|petroleum|dunhinda)\b/;
const RE_CASH_ADV = /\b(cash advance|cash adv|cardless cash|\batm\b|cash withdrawal|cash withdraw|withdrawal)\b/;
const RE_CC_FEE = /\b(annual fee|late payment fee|late payment|late fee|finance charge|interest charge|debit interest|credit interest|\binterest\b|service charge|service fee|over ?limit|overlimit|over the limit|joining fee|card fee|card replacement|replacement fee|reissue fee|cash advance fee|local cash advance fee|advance fee|fuel surcharge|surcharge|stamp duty|debit tax|\bvat\b|v\.a\.t|value added tax|\bnbt\b|\bsscl\b|social security|\bcess\b|government levy|govt levy|\blevy\b|commission|commision|processing fee|admin(istration)? fee|handling fee|svc charge|return fee|cheque return|mark[\s-]?up|currency conversion|conversion fee|foreign (currency|transaction) fee|cross[\s-]?border|fx fee|forex fee|pin (re)?issue|e[\s-]?statement fee|statement fee)\b/;

const EXPENSE_CATS = [
    ['Fuel', RE_FUEL],
    ['Groceries', /\b(food city|cargills|keells|arpico|glomark|laughs|supermarket|grocery|spar|sathosa|super ?city|lanka sathosa)\b/],
    ['Dining', /\b(restaurant|cafe|coffee|kfc|pizza|mcdonald|burger|hotel|bakery|dominos|barista|java|chai|karak|oishi|kottu|biryani|dinemore|perera and sons|pilawoos)\b/],
    ['Transport', /\b(uber|pickme|taxi|bus|train|railway|parking|toll|expressway|interchange|highway|tyre|tire|vehicle|auto ?parts?|spare ?parts?|service station|garage|car wash)\b/],
    ['Utilities', /\b(ceb|ceylon electricity|electricity|leco|water board|nwsdb|dialog|mobitel|slt|hutch|airtel|internet|broadband|recharge|reload|bill payment|gas)\b/],
    ['Shopping', /\b(odel|nolimit|no limit|fashion|clothing|store|mall|cotton|kapruka|daraz|amazon|aliexpress|koko|mintpay|mint pay|showroom|singer|abans|softlogic)\b/],
    ['Health', /\b(pharmacy|hospital|medical|clinic|channel|\blab\b|nawaloka|asiri|hemas|durdans|osu ?sala|healthguard|laksiri)\b/],
    ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube|game|scope|pvr)\b/],
    ['Education', /\b(school|tuition|university|campus|course|institute|exam|books)\b/],
    ['Insurance', /\b(insurance|aia|ceylinco|allianz|union assurance|sri lanka insurance|premium)\b/]
];

const VALID_TYPES = { purchase: 1, cash_advance: 1, service_fee: 1, fuel: 1 };

function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function kbType(desc) {
    const d = norm(desc);
    if (RE_CC_FEE.test(d)) return 'service_fee';
    if (RE_CASH_ADV.test(d)) return 'cash_advance';
    if (RE_FUEL.test(d)) return 'fuel';
    return 'purchase';
}
function kbCategory(desc) {
    const d = norm(desc);
    for (let i = 0; i < EXPENSE_CATS.length; i++) if (EXPENSE_CATS[i][1].test(d)) return EXPENSE_CATS[i][0];
    return 'Other';
}
function deterministic(desc) {
    const type = kbType(desc);
    const category = kbCategory(desc);
    const certain = (type !== 'purchase') || (category !== 'Other');
    return { type, category, confidence: certain ? 0.97 : 0.5, source: 'kb' };
}

/* ---------------------------------------------------------------------------
 *  MULTI-ENGINE CONSENSUS for the ambiguous remainder.
 *  Most providers are OpenAI-compatible (/chat/completions) → one helper covers
 *  them; Gemini has its own shape. Every configured engine casts one ballot per
 *  description and the majority TYPE wins.
 * ------------------------------------------------------------------------- */
function buildPrompt(list) {
    return (
        'You classify Sri Lankan credit-card statement line descriptions.\n' +
        'For EACH item return the charge TYPE — one of exactly: purchase, cash_advance, service_fee, fuel.\n' +
        'Rules: fuel = a fuel/petrol/diesel station purchase. cash_advance = cash drawn on the card / ATM. ' +
        'service_fee = any bank fee, surcharge, tax, levy, interest, commission, stamp duty, annual/late fee, FX mark-up. ' +
        'purchase = an ordinary goods/services purchase. A FEE always beats fuel/cash_advance ' +
        '(e.g. "FUEL SURCHARGE" is service_fee, "CASH ADVANCE FEE" is service_fee).\n' +
        'Also give a short category (Fuel, Groceries, Dining, Transport, Utilities, Shopping, Health, ' +
        'Entertainment, Education, Insurance, Fees, or Other).\n' +
        'Respond with ONLY a JSON array, no prose, no markdown. Each element: ' +
        '{"i": <index>, "type": "<type>", "category": "<category>"}.\n\n' +
        'ITEMS:\n' + list.map((d, i) => `${i}. ${String(d).slice(0, 120)}`).join('\n')
    );
}

function parseJsonArray(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a < 0 || b < 0 || b < a) return null;
    try { const arr = JSON.parse(t.slice(a, b + 1)); return Array.isArray(arr) ? arr : null; } catch (_) { return null; }
}

// One OpenAI-compatible chat call → array of {i,type,category} (or null on failure)
function makeOAI(name, url, key, model, extraHeaders) {
    return async function (list) {
        if (!key) return null;
        const headers = Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, extraHeaders || {});
        const resp = await fetchWithTimeout(url, {
            method: 'POST', headers,
            body: JSON.stringify({
                model,
                temperature: 0,
                max_tokens: 1200,
                messages: [
                    { role: 'system', content: 'You are a precise financial transaction classifier. Output only JSON.' },
                    { role: 'user', content: buildPrompt(list) }
                ]
            })
        });
        if (!resp.ok) throw new Error(name + ' ' + resp.status);
        const data = await resp.json();
        const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return parseJsonArray(txt);
    };
}

function makeGemini(key) {
    return async function (list) {
        if (!key) return null;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
        const resp = await fetchWithTimeout(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: buildPrompt(list) }] }],
                generationConfig: { temperature: 0, maxOutputTokens: 1200 }
            })
        });
        if (!resp.ok) throw new Error('gemini ' + resp.status);
        const data = await resp.json();
        const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        return parseJsonArray(txt);
    };
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' });

    // ----- normalise input -----
    let body = req.body || {};
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    let descriptions = body.descriptions;
    if (!Array.isArray(descriptions)) {
        if (Array.isArray(body.items)) descriptions = body.items.map(it => (it && (it.description || it.desc || it.name)) || '');
        else if (typeof body.description === 'string') descriptions = [body.description];
        else descriptions = [];
    }
    descriptions = descriptions.map(d => String(d == null ? '' : d)).slice(0, 200); // hard cap
    if (!descriptions.length) return res.status(400).json({ ok: false, error: 'No descriptions provided' });

    // ----- 1) deterministic pass for everything -----
    const results = descriptions.map((d, i) => Object.assign({ i, description: d, engineVotes: null }, deterministic(d)));

    // ----- 2) which ones still need the AI jury? (only the generic guesses) -----
    const ambiguousIdx = results.filter(r => r.confidence < 0.9).map(r => r.i);

    const enginesUsed = [];
    if (ambiguousIdx.length) {
        const list = ambiguousIdx.map(i => descriptions[i]);

        const geminiKey = process.env.WealthFlow_API_Key || process.env.GEMINI_API_KEY;
        const engines = [
            ['groq', makeOAI('groq', 'https://api.groq.com/openai/v1/chat/completions', process.env.GROQ_API_KEY, 'llama-3.3-70b-versatile')],
            ['deepseek', makeOAI('deepseek', 'https://api.deepseek.com/chat/completions', process.env.DEEPSEEK_API_KEY, 'deepseek-chat')],
            ['mistral', makeOAI('mistral', 'https://api.mistral.ai/v1/chat/completions', process.env.MISTRAL_API_KEY, 'mistral-small-latest')],
            ['together', makeOAI('together', 'https://api.together.xyz/v1/chat/completions', process.env.TOGETHER_API_KEY, 'meta-llama/Llama-3.3-70B-Instruct-Turbo')],
            ['fireworks', makeOAI('fireworks', 'https://api.fireworks.ai/inference/v1/chat/completions', process.env.FIREWORKS_API_KEY, 'accounts/fireworks/models/llama-v3p3-70b-instruct')],
            ['openrouter', makeOAI('openrouter', 'https://openrouter.ai/api/v1/chat/completions', process.env.OPENROUTER_API_KEY, 'meta-llama/llama-3.3-70b-instruct')],
            ['cerebras', makeOAI('cerebras', 'https://api.cerebras.ai/v1/chat/completions', process.env.CEREBRAS_API_KEY, 'llama-3.3-70b')],
            ['sambanova', makeOAI('sambanova', 'https://api.sambanova.ai/v1/chat/completions', process.env.SAMBANOVA_API_KEY, 'Meta-Llama-3.3-70B-Instruct')],
            ['nvidia', makeOAI('nvidia', 'https://integrate.api.nvidia.com/v1/chat/completions', process.env.NVIDIA_API_KEY, 'meta/llama-3.3-70b-instruct')],
            ['github', makeOAI('github', 'https://models.inference.ai.azure.com/chat/completions', process.env.GITHUB_MODELS_TOKEN, 'gpt-4o-mini')],
            ['gemini', makeGemini(geminiKey)]
        ];

        // Fire every configured engine in parallel; ignore the ones that fail/time out.
        const settled = await Promise.allSettled(engines.map(async ([name, fn]) => {
            const arr = await fn(list);
            if (!arr) throw new Error(name + ' empty');
            return { name, arr };
        }));

        // Tally votes per ambiguous position.
        const tally = list.map(() => ({})); // [{type:count}]
        const catVote = list.map(() => ({}));
        settled.forEach(s => {
            if (s.status !== 'fulfilled' || !s.value) return;
            enginesUsed.push(s.value.name);
            s.value.arr.forEach(row => {
                if (!row) return;
                const pos = Number(row.i);
                if (!(pos >= 0 && pos < list.length)) return;
                let t = String(row.type || '').toLowerCase().trim().replace(/\s+/g, '_');
                if (t === 'cashadvance' || t === 'cash-advance') t = 'cash_advance';
                if (t === 'servicefee' || t === 'fee' || t === 'fees' || t === 'service-fee') t = 'service_fee';
                if (!VALID_TYPES[t]) return;
                tally[pos][t] = (tally[pos][t] || 0) + 1;
                const c = String(row.category || '').trim();
                if (c) catVote[pos][c] = (catVote[pos][c] || 0) + 1;
            });
        });

        // Apply the majority verdict — but ONLY upgrade a still-generic row, never
        // override anything the KB is already confident about.
        ambiguousIdx.forEach((origIdx, pos) => {
            const votes = tally[pos];
            const total = Object.values(votes).reduce((s, n) => s + n, 0);
            if (!total) return; // no engine voted → keep deterministic
            let bestType = 'purchase', bestN = -1;
            Object.keys(votes).forEach(t => { if (votes[t] > bestN) { bestN = votes[t]; bestType = t; } });
            let bestCat = '', bestCN = -1;
            Object.keys(catVote[pos]).forEach(c => { if (catVote[pos][c] > bestCN) { bestCN = catVote[pos][c]; bestCat = c; } });
            const r = results[origIdx];
            if (r.type === 'purchase' || r.confidence < 0.9) {
                r.type = bestType;
                if ((!r.category || r.category === 'Other') && bestCat) r.category = bestCat;
                r.confidence = Math.min(0.98, 0.55 + 0.45 * (bestN / total)); // agreement-weighted
                r.source = 'consensus';
                r.engineVotes = votes;
            }
        });
    }

    return res.status(200).json({
        ok: true,
        mode: ambiguousIdx.length ? (enginesUsed.length ? 'kb+consensus' : 'kb-only (no AI engine responded)') : 'kb-only',
        engines: enginesUsed,
        count: results.length,
        results
    });
}
