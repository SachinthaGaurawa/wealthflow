/* =============================================================================
   /api/merchant-search.js  —  Agentic merchant identifier (Vercel Edge)
   ---------------------------------------------------------------------------
   When the on-device classifier can't confidently name an unknown merchant,
   the client calls this endpoint with the raw merchant string. It performs a
   real web lookup to identify what the business is and returns a best-guess
   category + a short human description so the dashboard can show a 1-click
   "Confirm" card.

   Providers (first available key wins; all optional — never crashes):
     • Tavily          (TAVILY_API_KEY)        — agentic web search
     • Brave Search    (BRAVE_API_KEY)         — web search
     • Serper.dev      (SERPER_API_KEY)        — google search proxy
     • Gemini grounding (WealthFlow_API_Key / GEMINI_API_KEY) — LLM w/ knowledge

   If NO key is configured it returns ok:false (the client keeps its local
   keyword guess and simply flags the item for review — nothing breaks).

   Privacy: only the merchant name + country hint is sent out, never amounts,
   balances, card numbers or any personal data.
   ============================================================================ */

export const config = { runtime: 'edge' };

const CATEGORIES = [
    'Food & Groceries', 'Dining', 'Transport', 'Fuel', 'Utilities', 'Telecom',
    'Healthcare', 'Education', 'Entertainment', 'Subscriptions', 'Shopping',
    'Shopping (Fashion)', 'Electronics & Tech', 'Shopping (Home)', 'Insurance',
    'Rent', 'Personal Care', 'Kids & Family', 'Pets', 'Travel', 'Charity',
    'Government', 'Banking', 'Other'
];

function json(body, status) {
    return new Response(JSON.stringify(body), {
        status: status || 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type',
            'Cache-Control': 'no-store'
        }
    });
}

// Map a free-text description to one of our categories with a keyword pass.
function categorise(text) {
    const t = (text || '').toLowerCase();
    const M = [
        ['Healthcare', /hospital|clinic|pharmac|chemist|medical|doctor|dental|health|laborator/],
        ['Food & Groceries', /supermarket|grocer|food city|hypermarket|provision|mini ?mart/],
        ['Dining', /restaurant|cafe|coffee|bakery|fast food|eatery|dining|food court|pizza|burger/],
        ['Fuel', /fuel|petrol|filling station|petroleum|gas station/],
        ['Transport', /taxi|ride hailing|ride-hailing|transport|bus|railway|cab|logistics/],
        ['Telecom', /telecom|mobile network|internet service|broadband|sim|isp/],
        ['Utilities', /electric|water board|utility|power company|gas utility/],
        ['Entertainment', /cinema|movie|streaming|gaming|entertainment|theatre/],
        ['Education', /school|college|university|institute|education|tuition|academy|bookshop/],
        ['Shopping (Fashion)', /clothing|fashion|apparel|garment|textile|footwear|shoe/],
        ['Electronics & Tech', /electronics|computer|technology|gadget|appliance|software company|mobile phone/],
        ['Shopping (Home)', /furniture|home ?centre|hardware|interior|building material/],
        ['Insurance', /insurance|assurance|life cover/],
        ['Personal Care', /salon|spa|beauty|cosmetic|barber|gym|fitness/],
        ['Pets', /pet|veterinar|animal/],
        ['Travel', /airline|airport|hotel|resort|travel agency|tour|booking/],
        ['Government', /government|ministry|municipal|revenue|customs|authority/],
        ['Banking', /\bbank\b|finance company|payment|remittance|microfinance/],
        ['Shopping', /retail|store|shop|mall|department store|marketplace/],
    ];
    for (const [cat, rx] of M) if (rx.test(t)) return cat;
    return 'Other';
}

async function viaTavily(merchant, country, key) {
    const r = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            api_key: key,
            query: 'What kind of business is "' + merchant + '"' + (country ? ' in ' + country : '') + '? What category of merchant?',
            search_depth: 'basic',
            include_answer: true,
            max_results: 4
        })
    });
    if (!r.ok) throw new Error('tavily ' + r.status);
    const d = await r.json();
    const answer = d.answer || (d.results || []).map(x => x.title + ' ' + (x.content || '')).join(' ');
    return answer;
}

async function viaBrave(merchant, country, key) {
    const q = encodeURIComponent(merchant + (country ? ' ' + country : '') + ' business type');
    const r = await fetch('https://api.search.brave.com/res/v1/web/search?q=' + q, {
        headers: { 'X-Subscription-Token': key, 'Accept': 'application/json' }
    });
    if (!r.ok) throw new Error('brave ' + r.status);
    const d = await r.json();
    const items = (d.web && d.web.results) || [];
    return items.slice(0, 4).map(x => (x.title || '') + ' ' + (x.description || '')).join(' ');
}

async function viaSerper(merchant, country, key) {
    const r = await fetch('https://google.serper.dev/search', {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: merchant + (country ? ' ' + country : '') + ' business type' })
    });
    if (!r.ok) throw new Error('serper ' + r.status);
    const d = await r.json();
    const kg = d.knowledgeGraph ? (d.knowledgeGraph.title + ' ' + (d.knowledgeGraph.type || '') + ' ' + (d.knowledgeGraph.description || '')) : '';
    const org = (d.organic || []).slice(0, 4).map(x => (x.title || '') + ' ' + (x.snippet || '')).join(' ');
    return kg + ' ' + org;
}

async function viaGemini(merchant, country, key) {
    const model = 'gemini-2.0-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
    const prompt = 'A bank statement shows a merchant called "' + merchant + '"' + (country ? ' (likely in ' + country + ')' : '') +
        '. In ONE short sentence say what kind of business this is, then on a new line output exactly: CATEGORY: <one of ' +
        CATEGORIES.join(', ') + '>. If you are unsure, use CATEGORY: Other.';
    const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 120 } })
    });
    if (!r.ok) throw new Error('gemini ' + r.status);
    const d = await r.json();
    const txt = (((d.candidates || [])[0] || {}).content || {}).parts || [];
    return txt.map(p => p.text || '').join(' ');
}

export default async function handler(req) {
    if (req.method === 'OPTIONS') return json({ ok: true });
    if (req.method !== 'POST') return json({ ok: false, error: 'POST only' }, 405);

    let body = {};
    try { body = await req.json(); } catch (_) {}
    const merchant = (body.merchant || body.raw || '').toString().slice(0, 80).trim();
    const country = (body.country || 'Sri Lanka').toString().slice(0, 40);
    if (!merchant) return json({ ok: false, error: 'no merchant' }, 400);

    const env = (typeof process !== 'undefined' && process.env) ? process.env : {};
    const providers = [];
    if (env.TAVILY_API_KEY) providers.push(['tavily', () => viaTavily(merchant, country, env.TAVILY_API_KEY)]);
    if (env.BRAVE_API_KEY) providers.push(['brave', () => viaBrave(merchant, country, env.BRAVE_API_KEY)]);
    if (env.SERPER_API_KEY) providers.push(['serper', () => viaSerper(merchant, country, env.SERPER_API_KEY)]);
    const gkey = env.WealthFlow_API_Key || env.GEMINI_API_KEY;
    if (gkey) providers.push(['gemini', () => viaGemini(merchant, country, gkey)]);

    if (!providers.length) {
        // No keys configured — client keeps its local guess + flags for review.
        return json({ ok: false, reason: 'no_search_provider', merchant });
    }

    for (const [name, fn] of providers) {
        try {
            const text = await fn();
            if (!text || !text.trim()) continue;
            // explicit "CATEGORY: X" wins (gemini); else keyword-map the prose
            let category = 'Other';
            const m = /CATEGORY:\s*([A-Za-z()&\s]+)/i.exec(text);
            if (m && CATEGORIES.includes(m[1].trim())) category = m[1].trim();
            else category = categorise(text);
            const description = text.replace(/CATEGORY:.*/i, '').replace(/\s+/g, ' ').trim().slice(0, 180);
            return json({
                ok: true, provider: name, merchant, category,
                description: description || null,
                confidence: category === 'Other' ? 0.5 : 0.82
            });
        } catch (e) {
            // try next provider
        }
    }
    return json({ ok: false, reason: 'all_providers_failed', merchant });
}
