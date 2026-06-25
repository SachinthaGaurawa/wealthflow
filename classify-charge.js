// ============================================================================
//  WealthFlow · /api/classify-charge        v7.33.0
// ----------------------------------------------------------------------------
//  WealthFlow's OWN, purpose-built charge-classification engine. Given a list of
//  raw statement descriptions it returns, for EACH one, the credit-card charge
//  TYPE  ∈ { purchase | cash_advance | service_fee | fuel }  and a best-guess
//  expense category — with a confidence score.
//
//  HOW IT REACHES ~100 % USABLE ACCURACY (honest framing):
//    1) A deterministic knowledge base — kept in LOCK-STEP with wealthflow-route.js
//       (v7.30.0 merchant set) — settles the overwhelming majority of real Sri
//       Lankan statement lines INSTANTLY and OFFLINE: fuel forecourts, ATM/cash-
//       advance, the whole tax/levy/interest/fee family, and a wide catalogue of
//       SL merchants (supermarkets, restaurants, ride apps, e-commerce, pharmacies
//       & hospitals, schools & courses, insurers, streaming/SaaS). These come back
//       at confidence >= 0.95 with NO AI call.
//    2) ONLY the genuinely ambiguous remainder (a bare "purchase") is sent to a
//       MULTI-ENGINE AI CONSENSUS where EVERY provider the owner has configured in
//       Vercel votes IN PARALLEL (Promise.allSettled) and the majority verdict
//       wins. More voters -> more robust. Engines with a missing key simply skip.
//    3) The AI may only UPGRADE a generic guess — it can never override a verdict
//       the deterministic KB is already certain about (so fuel/cash-advance/fees
//       stay locked and the classifier only ever improves).
//
//  PARALLELISM: all ~18 engines are dispatched simultaneously; the request is
//  bounded by the router's 60s maxDuration and each engine by an 18s fetch timeout,
//  so one slow provider can never stall the consensus.
//
//  Contract (UNCHANGED — safe for every existing client consumer):
//    POST { descriptions: ["MORAWAKA FUEL STATION", "DEBIT INTEREST", ...] }
//      (also accepts { items:[{description}] } or a single { description })
//    ->  { ok, mode, engines:[...], results:[ { i, description, type, category,
//          confidence, source, engineVotes } ] }
//
//  ALWAYS returns JSON, NEVER throws past the handler.
// ============================================================================

export const config = { maxDuration: 60 }; // Hobby max — covers the full parallel multi-engine vote

const PER_ENGINE_TIMEOUT_MS = 18000; // generous so slow providers still contribute, well under the 60s budget
const MAX_OUTPUT_TOKENS = 4096;      // headroom so a large ambiguous batch (or a reasoning model) is never truncated

async function fetchWithTimeout(url, options, timeoutMs = PER_ENGINE_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try { return await fetch(url, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); }
}

// First defined env var among several likely names (lets the owner name keys freely).
function envAny(...names) { for (const n of names) { const v = process.env[n]; if (v) return v; } return ''; }

/* ---------------------------------------------------------------------------
 *  DETERMINISTIC KNOWLEDGE BASE  (in LOCK-STEP with wealthflow-route.js v7.33.0)
 *  Order matters: a fee/levy/tax/interest WINS over fuel and cash-advance, so
 *  "FUEL SURCHARGE" -> service_fee and "LOCAL CASH ADVANCE FEE" -> service_fee.
 * ------------------------------------------------------------------------- */
const RE_FUEL = /\b(fuel|petrol|diesel|petrol shed|fuel shed|filling station|fuel station|filling|ceypetco|lanka ioc|\bioc\b|sinopec|total energies|gas station|petroleum|dunhinda|rm parks|united petroleum)\b/;
const RE_CASH_ADV = /\b(cash advance|cash adv|cardless cash|\batm\b|cash withdrawal|cash withdraw|withdrawal)\b/;
const RE_CC_FEE = /\b(annual fee|late payment fee|late payment|late fee|finance charge|interest charge|debit interest|credit interest|\binterest\b|service charge|service fee|over ?limit|overlimit|over the limit|joining fee|card fee|card replacement|replacement fee|reissue fee|cash advance fee|local cash advance fee|advance fee|fuel surcharge|surcharge|stamp duty|debit tax|\bvat\b|v\.a\.t|value added tax|\bnbt\b|\bsscl\b|social security|\bcess\b|government levy|govt levy|\blevy\b|commission|commision|processing fee|admin(istration)? fee|handling fee|svc charge|return fee|cheque return|mark[\s-]?up|currency conversion|conversion fee|foreign (currency|transaction) fee|cross[\s-]?border|fx fee|forex fee|pin (re)?issue|e[\s-]?statement fee|statement fee|annual membership|membership fee|membership|late settlement|cash advance interest|over limit fee|cefts? charges?|slips? charges?|bank charges?|maintenance fee|ledger fee|sms (alert|charge)|alert charges?|cheque book (fee|charge)|fallback fee|\bfee\b|\bfees\b|\bcharge\b|\bcharges\b)\b/;

const EXPENSE_CATS = [
    ['Fuel', RE_FUEL],
    ['Groceries', /\b(food city|cargills|keells|arpico|glomark|laughs|supermarket|grocery|spar|sathosa|super ?city|lanka sathosa|sunup|healthy living|jaya super|maharaja super)\b/],
    ['Dining', /\b(restaurant|cafe|coffee|kfc|pizza|mcdonald|burger|hotel|bakery|dominos|barista|java|chai|karak|oishi|kottu|biryani|dinemore|perera and sons|pilawoos|subway|dunkin|sushi|ramen|noodles|hela bojun|chinese dragon|cool spot|sponge|nuga gama|ministry of crab|raja bojun|green cabin|bismillah|chooti|cinnabon|chatime|pizza hut|burger king|food court|fast food|take ?away|fried chicken|rice and curry|tea shop|eatery)\b/],
    ['Transport', /\b(uber|pickme|taxi|bus|train|railway|parking|toll|expressway|interchange|\brda\b|\betc\b|highway|wiper|tyre|tire|vehicle|auto ?parts?|spare ?parts?|service station|garage|leyland|car wash|pick me|kangaroo|three wheel|\bsltb\b|\bctb\b|\byego\b|emission test)\b/],
    ['Utilities', /\b(ceb|ceylon electricity|electricity|leco|water board|nwsdb|dialog|mobitel|slt|hutch|airtel|internet|broadband|recharge|reload|bill payment|gas|litro|laugfs gas|telecom)\b/],
    ['Health', /\b(pharmacy|pharmacies|hospital|hospitals|medical|medicine|medicare|healthcare|health care|health|clinic|channel|channelling|e channel|e channelling|doc990|odoc|lab|laboratory|nawaloka|asiri|hemas|durdans|osu ?sala|healthguard|laksiri|ninewells|lanka hospital|browns hospital|union chemist|state pharmaceutical|dental|dentist|doctor|dispensary|drug store|drugstore|physiotherapy|physio|ayurveda|ayurvedic|surgery|optic|optical|optician|spectacle|eye clinic|eye hospital|x ray|xray|scan centre|scan center)\b/],
    ['Shopping', /\b(odel|nolimit|no limit|fashion|clothing|store|mall|cotton|kapruka|daraz|amazon|aliexpress|koko|mintpay|mint pay|ecom|showroom|singer|abans|softlogic|damro|\bdsi\b|\bbata\b|hameedia|house of fashion|cool planet|takas|wow lk|ikman|clicknshop|uniqlo|shein|\btemu\b|alibaba)\b/],
    ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube|game|scope|pvr|savoy|majestic cine|playstation|\bxbox\b|nintendo|steam games|twitch|disney|hotstar|iflix)\b/],
    ['Education', /\b(school|tuition|university|campus|course|institute|exam|books|royal college|british council|ielts|toefl|coursera|udemy|stafford|\bapiit\b|\bnsbm\b|\bsliit\b|\bcima\b|\bacca\b)\b/],
    ['Insurance', /\b(insurance|aia|ceylinco|allianz|union assurance|sri lanka insurance|janashakthi|hnb assurance|softlogic life|amana takaful|fairfirst|cooplife|arpico insur|premium)\b/]
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
 *  Most providers are OpenAI-compatible (/chat/completions) -> one helper covers
 *  them; xAI (reasoning) needs max_completion_tokens; Gemini and Anthropic have
 *  their own shapes. Every configured engine casts one ballot per description and
 *  the majority TYPE wins.
 * ------------------------------------------------------------------------- */
function buildPrompt(list) {
    return (
        'You are WealthFlow\'s Sri Lankan bank & credit-card statement classifier. Accuracy is critical — these are real money records.\n' +
        'For EACH item return the charge TYPE — one of EXACTLY: purchase, cash_advance, service_fee, fuel. Never invent a value outside this set.\n' +
        'Definitions:\n' +
        '  fuel         = a fuel/petrol/diesel forecourt purchase (Ceypetco, Lanka IOC / IOC, Sinopec, Total Energies, RM Parks, United Petroleum, Dunhinda, any "... FILLING STATION" / "FUEL").\n' +
        '  cash_advance = cash drawn on the card / ATM withdrawal / cardless cash / "CASH ADV".\n' +
        '  service_fee  = ANY bank fee, surcharge, tax, levy, interest, commission, stamp duty, debit tax, annual/late/joining/membership/over-limit/processing/handling fee, card replacement/reissue fee, FX mark-up or currency-conversion/cross-border fee, or government levy (VAT, NBT, SSCL, CESS).\n' +
        '  purchase     = an ordinary goods/services purchase at a merchant (the default when it is clearly a normal spend).\n' +
        'CRITICAL RULE: a FEE always beats fuel/cash_advance — "FUEL SURCHARGE" is service_fee (not fuel); "CASH ADVANCE FEE" / "LOCAL CASH ADVANCE FEE" is service_fee (not cash_advance).\n' +
        'Also give the best-fit category — one of EXACTLY: Fuel, Groceries, Dining, Transport, Utilities, Shopping, Health, Entertainment, Education, Insurance, Fees, Other. Pick the SINGLE most-likely one; use Fees for any service_fee/levy/tax.\n' +
        'Sri Lankan merchant knowledge — apply it actively:\n' +
        '  Groceries: Cargills/Food City, Keells, Arpico, Glomark, Laugfs/LAUGHS, Spar, Sathosa, Lanka Sathosa, Jaya/Maharaja super.\n' +
        '  Dining:    KFC, Pizza Hut, Dominos, McDonald\'s, Burger King, Dinemore, Perera & Sons, Pilawoos, Barista, Java, Cinnabon, Chatime, any restaurant/cafe/bakery/hotel meal/"FAST FOOD"/"FOOD COURT".\n' +
        '  Transport: Uber, PickMe, taxi, three-wheeler, expressway/RDA toll, parking, tyres, spare/auto parts, vehicle service/garage, railway/bus.\n' +
        '  Utilities: Dialog, Mobitel, SLT, Hutch, Airtel (telecom/airtime/reload), CEB, LECO (electricity), NWSDB (water), Litro/Laugfs (gas), broadband/internet bills.\n' +
        '  Shopping:  Daraz, Kapruka, Odel, NoLimit, Singer, Abans, Softlogic, Damro, DSI, Bata, Hameedia, Amazon/AliExpress/Temu/SHEIN, electronics/clothing/footwear/cosmetics.\n' +
        '  Health:    Asiri, Nawaloka, Hemas, Durdans, Ninewells, Lanka Hospitals, Osu Sala, HealthGuard, Union Chemists, any pharmacy/hospital/clinic/medical/medicine/dental/optical/e-Channelling/doc990/"... HEALTH".\n' +
        '  Entertainment: Netflix, Spotify, Disney+, YouTube, Scope/Savoy/Majestic cinemas, PlayStation/Xbox/Steam, tickets/events.\n' +
        '  Education: schools, tuition, university/campus, British Council, IELTS/TOEFL, Coursera/Udemy, books/stationery.\n' +
        '  Insurance: AIA, Ceylinco, Allianz, Union Assurance, SLIC, Janashakthi, HNB Assurance, Softlogic Life, premiums.\n' +
        'OCR NOTE: descriptions may be ABBREVIATED or TRUNCATED (e.g. "AL HEALTH", "...RE GATEWAY", "COMMUN"). Infer the most likely real merchant/category from the visible fragment; do not default everything to purchase/Other when a fragment clearly points to a category.\n' +
        'Respond with ONLY a JSON array — no prose, no markdown, no code fences. Each element exactly: ' +
        '{"i": <index>, "type": "<type>", "category": "<category>"}.\n\n' +
        'ITEMS:\n' + list.map((d, i) => `${i}. ${String(d).slice(0, 160)}`).join('\n')
    );
}

function parseJsonArray(text) {
    if (!text) return null;
    let t = String(text).trim().replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    const a = t.indexOf('['), b = t.lastIndexOf(']');
    if (a < 0 || b < 0 || b < a) return null;
    try { const arr = JSON.parse(t.slice(a, b + 1)); return Array.isArray(arr) ? arr : null; } catch (_) { return null; }
}

// One OpenAI-compatible chat call -> array of {i,type,category} (or null on failure).
// opts.tokenParam lets reasoning models (xAI) use max_completion_tokens instead of max_tokens.
function makeOAI(name, url, key, model, opts) {
    opts = opts || {};
    const tokenParam = opts.tokenParam || 'max_tokens';
    const extraHeaders = opts.extraHeaders || null;
    return async function (list) {
        if (!key) return null;
        const headers = Object.assign({ 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key }, extraHeaders || {});
        const payload = {
            model,
            temperature: 0,
            messages: [
                { role: 'system', content: 'You are a precise financial transaction classifier. Output only JSON.' },
                { role: 'user', content: buildPrompt(list) }
            ]
        };
        payload[tokenParam] = MAX_OUTPUT_TOKENS;
        const resp = await fetchWithTimeout(url, { method: 'POST', headers, body: JSON.stringify(payload) });
        if (!resp.ok) throw new Error(name + ' ' + resp.status);
        const data = await resp.json();
        const txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        return parseJsonArray(txt);
    };
}

// Google Gemini (generateContent shape).
function makeGemini(key) {
    return async function (list) {
        if (!key) return null;
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`;
        const resp = await fetchWithTimeout(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: buildPrompt(list) }] }],
                generationConfig: { temperature: 0, maxOutputTokens: MAX_OUTPUT_TOKENS }
            })
        });
        if (!resp.ok) throw new Error('gemini ' + resp.status);
        const data = await resp.json();
        const txt = data && data.candidates && data.candidates[0] && data.candidates[0].content &&
            data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
        return parseJsonArray(txt);
    };
}

// Anthropic Claude (Messages API shape — different from OpenAI).
function makeAnthropic(key, model) {
    return async function (list) {
        if (!key) return null;
        const resp = await fetchWithTimeout('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({
                model,
                max_tokens: MAX_OUTPUT_TOKENS,
                temperature: 0,
                system: 'You are a precise financial transaction classifier. Output only JSON.',
                messages: [{ role: 'user', content: buildPrompt(list) }]
            })
        });
        if (!resp.ok) throw new Error('anthropic ' + resp.status);
        const data = await resp.json();
        const txt = data && data.content && data.content[0] && data.content[0].text;
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

        // ── Every engine the owner has configured (missing key -> skipped). All fire IN PARALLEL. ──
        const engines = [
            ['groq',       makeOAI('groq',       'https://api.groq.com/openai/v1/chat/completions',          envAny('GROQ_API_KEY'),                       'llama-3.3-70b-versatile')],
            ['deepseek',   makeOAI('deepseek',   'https://api.deepseek.com/chat/completions',                envAny('DEEPSEEK_API_KEY'),                   'deepseek-chat')],
            ['mistral',    makeOAI('mistral',    'https://api.mistral.ai/v1/chat/completions',               envAny('MISTRAL_API_KEY'),                    'mistral-small-latest')],
            ['together',   makeOAI('together',   'https://api.together.xyz/v1/chat/completions',             envAny('TOGETHER_API_KEY','TOGETHERAI_API_KEY'), 'meta-llama/Llama-3.3-70B-Instruct-Turbo')],
            ['fireworks',  makeOAI('fireworks',  'https://api.fireworks.ai/inference/v1/chat/completions',   envAny('FIREWORKS_API_KEY'),                  'accounts/fireworks/models/llama-v3p3-70b-instruct')],
            ['openrouter', makeOAI('openrouter', 'https://openrouter.ai/api/v1/chat/completions',            envAny('OPENROUTER_API_KEY','OPEN_ROUTER_API_KEY'), 'meta-llama/llama-3.3-70b-instruct')],
            ['cerebras',   makeOAI('cerebras',   'https://api.cerebras.ai/v1/chat/completions',              envAny('CEREBRAS_API_KEY'),                   'llama-3.3-70b')],
            ['sambanova',  makeOAI('sambanova',  'https://api.sambanova.ai/v1/chat/completions',             envAny('SAMBANOVA_API_KEY'),                  'Meta-Llama-3.3-70B-Instruct')],
            ['nvidia',     makeOAI('nvidia',     'https://integrate.api.nvidia.com/v1/chat/completions',     envAny('NVIDIA_API_KEY'),                     'meta/llama-3.3-70b-instruct')],
            ['github',     makeOAI('github',     'https://models.inference.ai.azure.com/chat/completions',   envAny('GITHUB_MODELS_TOKEN','GITHUB_TOKEN'), 'gpt-4o-mini')],
            ['deepinfra',  makeOAI('deepinfra',  'https://api.deepinfra.com/v1/openai/chat/completions',     envAny('DEEPINFRA_API_KEY','DEEPINFRA_TOKEN'),'meta-llama/Llama-3.3-70B-Instruct')],
            ['hyperbolic', makeOAI('hyperbolic', 'https://api.hyperbolic.xyz/v1/chat/completions',           envAny('HYPERBOLIC_API_KEY'),                 'meta-llama/Llama-3.3-70B-Instruct')],
            ['novita',     makeOAI('novita',     'https://api.novita.ai/v3/openai/chat/completions',         envAny('NOVITA_API_KEY'),                     'meta-llama/llama-3.3-70b-instruct')],
            ['openai',     makeOAI('openai',     'https://api.openai.com/v1/chat/completions',               envAny('OPENAI_API_KEY','OPENAI_KEY'),        'gpt-4o-mini')],
            ['cohere',     makeOAI('cohere',     'https://api.cohere.ai/compatibility/v1/chat/completions',  envAny('COHERE_API_KEY'),                     'command-r-08-2024')],
            // xAI Grok is a reasoning model -> it uses max_completion_tokens, NOT max_tokens.
            ['xai',        makeOAI('xai',        'https://api.x.ai/v1/chat/completions',                     envAny('XAI_API_KEY','GROK_API_KEY'),         'grok-4.3', { tokenParam: 'max_completion_tokens' })],
            // Gemini & Anthropic use their own request/response shapes.
            ['gemini',     makeGemini(envAny('WealthFlow_API_Key','GEMINI_API_KEY','GOOGLE_API_KEY'))],
            ['anthropic',  makeAnthropic(envAny('ANTHROPIC_API_KEY','CLAUDE_API_KEY'), 'claude-3-5-haiku-latest')]
        ];

        // Fire every configured engine in parallel; ignore the ones that fail/time out/lack a key.
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
            if (!total) return; // no engine voted -> keep deterministic
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
