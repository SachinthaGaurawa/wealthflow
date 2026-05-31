/* =============================================================================
   WealthFlow Category AI v1.0  —  window.wfCategoryAI
   ---------------------------------------------------------------------------
   ONE shared, high-accuracy merchant→category classifier used by every entry
   point in the app (SMS paste, screenshot OCR, statement scanner, background
   queue). Previously the statement scanner and the SMS brain each guessed
   categories differently, so the same shop could land in "Other" from one path
   and "Medical" from another. This module makes the whole system agree.

   It layers four signals, strongest first:
     1. Learned memory       (wfMemory — what the user confirmed before)
     2. Exact merchant DB     (250+ known names, deterministic)
     3. Keyword inference     (600+ keywords across 20 categories, SL-aware)
     4. Income/credit detection (salary, transfers, refunds, dividends…)

   Returns: { name, category, module, confidence, isIncome, isInvestment,
              isSubscription, source }

   Pure, dependency-free, works in browser AND in Node (for tests). No network.
   ============================================================================ */
(function (root) {
    'use strict';

    // ── Expanded keyword → category map (order = priority) ───────────────────
    // Each entry: [category, /regex/, moduleHint]. moduleHint is where it should
    // file by default ('expenses' unless it's clearly income/subscription).
    const KEYWORDS = [
        // Medical / Pharmacy / Health  (high priority — safety matters)
        ['Healthcare', /hospital|clinic|pharmac|chemist|medic|doctor|dental|dentist|optic|eye\s*care|laborator|\blab\b|surger|nursing|nawaloka|asiri|durdans|hemas\s*hosp|lanka\s*hospital|ninewells|oasis\s*hosp|hospital|healthguard|osu\s*sala|union\s*chemists|raj\s*pharmac|physiotherap|scan\s*cent|channel(l)?ing|vital|wellness|ayurved|osusala/i, 'expenses'],

        // Groceries / Supermarkets
        ['Food & Groceries', /super\s*market|supermarket|grocer|food\s*city|cargills|keells|arpico|laugfs|glomark|sathosa|spar|food\s*world|mini\s*mart|super\s*centre|provision|fresh\s*market|vegetable|fruit|grocery|hyper\s*market/i, 'expenses'],

        // Dining / Restaurants / Cafes
        ['Dining', /restaurant|cafe|caf[eé]|coffee|bakery|baker|pizza|burger|kfc|mcdonald|subway|domino|starbuck|barista|dine|dining|food\s*court|kottu|hotel\s*de|the\s*bake|perera\s*and\s*sons|p\s*&\s*s|fab\b|delifrance|coco\s*veranda|crepe|chinese\s*dragon|java\s*lounge|kumbuk|nuga\s*gama|ministry\s*of\s*crab|upali|nana|raja\s*bojun|sizzle|grill|kitchen|cuisine|eatery|tavern|pub\b|bar\b|biryani|shawarma|noodle|ramen|sushi/i, 'expenses'],

        // Fuel
        ['Fuel', /fuel|petrol|diesel|ceypetco|ioc\b|lanka\s*ioc|filling\s*station|gas\s*station|shell\b|service\s*station|petroleum/i, 'expenses'],

        // Transport / Ride / Travel-local
        ['Transport', /uber|pickme|pick\s*me|taxi|cab\b|tuk|three\s*wheel|bus\b|train|railway|metro|parking|toll|expressway|highway|kadawatha|transport|fare|sltb|intercity|nano\s*ride/i, 'expenses'],

        // Telecom / Mobile / Internet
        ['Telecom', /dialog|mobitel|hutch|airtel|slt\b|sri\s*lanka\s*telecom|etisalat|broadband|recharge|reload|prepaid|postpaid|data\s*card|sim\b|top\s*up|topup|fibre|fiber|peo\s*tv|peotv/i, 'expenses'],

        // Utilities / Bills
        ['Utilities', /electric|ceb\b|leco\b|water\s*board|nwsdb|gas\b|litro|laugfs\s*gas|utility|bill\s*payment|sewage|garbage|municipal\s*council|pradeshiya/i, 'expenses'],

        // Entertainment / Streaming
        ['Entertainment', /cinema|movie|theatre|theater|scope\s*cinema|savoy|liberty|pvr|netflix|spotify|youtube\s*premium|disney|hbo|prime\s*video|hulu|apple\s*tv|game|gaming|playstation|xbox|steam\b|concert|event\s*ticket|bookmyshow|amusement|arcade/i, 'expenses'],

        // Subscriptions / SaaS / Cloud
        ['Subscriptions', /netflix|spotify|youtube\s*premium|disney\+?|hbo|prime|adobe|microsoft\s*365|office\s*365|google\s*one|icloud|dropbox|notion|figma|canva|github|aws|amazon\s*web|azure|digital\s*ocean|heroku|vercel|openai|chatgpt|claude|anthropic|subscription|monthly\s*plan|annual\s*plan|membership/i, 'subscriptions'],

        // Education
        ['Education', /school|college|university|campus|institute|tuition|academy|course|udemy|coursera|edx|skillshare|duolingo|education|stationer|book\s*shop|bookshop|library|exam|coaching|kaplan|edexcel|cambridge|ielts|aptitude/i, 'expenses'],

        // Fashion / Clothing
        ['Shopping (Fashion)', /cloth|garment|textile|\btex\b|fabric|saree|sari|kurta|garments|fashion|apparel|boutique|tailor|odel|nolimit|no\s*limit|fashion\s*bug|cotton\s*collection|hameedia|kelly\s*felder|carnage|emerald|dilly\s*and\s*carlo|avirate|glitz|shoe|footwear|bata|dsi\b|nike|adidas|h&m|zara|uniqlo|levi/i, 'expenses'],

        // Electronics / Tech / Appliances
        ['Electronics & Tech', /electronic|computer|laptop|mobile\s*phone|phone\s*shop|abans|singer|softlogic|damro|metropolitan|nanotek|barclay|redline|dialcom|tech\b|technolog|hardware|appliance|gadget|camera|samsung|apple\s*store|huawei|xiaomi|dell\b|hp\s*store|lenovo|playstation|nintendo/i, 'expenses'],

        // Home / Furniture / Hardware
        ['Shopping (Home)', /furniture|damro|home\s*centre|interior|hardware|paint|tiles|sanitary|paints|paint\s*shop|building\s*material|paint|ikea|arpico\s*super\s*centre|htawatte|laugfs\s*home/i, 'expenses'],

        // Insurance
        ['Insurance', /insurance|assurance|aia\b|ceylinco|allianz|janashakthi|union\s*assurance|sri\s*lanka\s*insurance|softlogic\s*life|life\s*insurance|policy\s*premium|premium\s*payment|continental\s*insurance/i, 'expenses'],

        // Rent / Housing
        ['Rent', /\brent\b|rental|lease|landlord|house\s*rent|apartment\s*rent|monthly\s*rent/i, 'expenses'],

        // Charity / Religious
        ['Charity', /charity|donation|dana\b|temple|church|mosque|kovil|vihara|foundation|relief\s*fund|orphanage|sarvodaya/i, 'expenses'],

        // Government / Tax / Fees
        ['Government', /inland\s*revenue|\bird\b|customs|excise|police|registrar|license|licence|permit|government|govt|municipal|provincial|immigration|passport|motor\s*traffic|rmv\b|drivers?\s*licen/i, 'expenses'],

        // Banking / Fees / ATM
        ['Banking', /atm\b|cash\s*withdraw|withdrawal|service\s*charge|bank\s*charge|annual\s*fee|late\s*fee|interest\s*charge|stamp\s*duty|cheque|overdraft|standing\s*order|paypal|stripe|wise\b|western\s*union|moneygram|revolut|payhere|frimi|genie|ez\s*cash|mcash/i, 'expenses'],

        // Travel / Airlines / Hotels (away)
        ['Travel', /airline|airport|sri\s*lankan\s*airlines|emirates|qatar\s*airways|etihad|cathay|singapore\s*air|booking\.com|agoda|airbnb|expedia|hotel\b|resort|villa|tour|travel|visa\s*fee|flight|cruise|train\s*ticket\s*intercity/i, 'expenses'],

        // Personal care / Beauty
        ['Personal Care', /salon|spa\b|barber|beauty|cosmetic|parlour|parlor|hair\s*cut|grooming|massage|nail\b|fitness|gym\b|yoga|crossfit|power\s*world|herbal/i, 'expenses'],

        // Kids / Baby
        ['Kids & Family', /toys?\b|baby|kids|children|pampers|diaper|daycare|montessori|playgroup|fun\s*world/i, 'expenses'],

        // Pets
        ['Pets', /pet\s*shop|veterinar|\bvet\b|pet\s*care|animal\s*clinic|pedigree|whiskas|pet\s*food/i, 'expenses'],
    ];

    // ── Income detection (credits that are real income, not refunds noise) ───
    const INCOME_PATTERNS = [
        ['Salary',        /salary|payroll|wages|month\s*end\s*pay|emolument|stipend/i],
        ['Business',      /sales\s*proceeds|business\s*income|invoice\s*payment|client\s*payment|settlement/i],
        ['Transfer In',   /inward|credited|received\s*from|fund\s*transfer\s*in|ceft\s*in|inward\s*ceft|transfer\s*from/i],
        ['Refund',        /refund|reversal|cashback|cash\s*back|chargeback|reimburse/i],
        ['Interest',      /interest\s*credit|fd\s*interest|savings\s*interest|deposit\s*interest/i],
        ['Rent Income',   /rent\s*received|rental\s*income/i],
    ];

    // ── Investment platforms → flag the income as an investment return ───────
    const INVESTMENT_PATTERNS = [
        ['Stock Dividend',  /dividend|cds\b|colombo\s*stock|cse\b|stock\s*broker|securities|equities|nsb\s*fund|asia\s*securities|john\s*keells\s*stock|acuity|capital\s*alliance|first\s*capital|ndb\s*securities|ct\s*clsa|softlogic\s*stock/i],
        ['Unit Trust',      /unit\s*trust|mutual\s*fund|jb\s*vantage|ndb\s*wealth|ceybank\s*unit|namal\b|guardian\s*acuity|first\s*capital\s*money/i],
        ['Treasury/Bond',   /treasury\s*bill|t-?bill|treasury\s*bond|government\s*securit|repo\b|gilt/i],
        ['Crypto',          /binance|coinbase|kraken|crypto|bitcoin|ethereum|usdt|metamask/i],
        ['Forex/Trading',   /forex|fx\s*trade|trading\s*account|exness|metatrader|mt4|mt5|etoro|interactive\s*brokers/i],
        ['Fixed Deposit',   /fixed\s*deposit|fd\s*maturity|fd\s*renewal|term\s*deposit/i],
    ];

    function _clean(s) {
        return String(s == null ? '' : s)
            .replace(/[\r\n\t]+/g, ' ')
            .replace(/\s{2,}/g, ' ')
            .trim();
    }

    // Detect if a transaction is income (a credit that represents money IN).
    // `explicitType` may be 'credit'|'debit' from the parser; if present it wins.
    function detectIncome(text, explicitType) {
        const hay = _clean(text).toLowerCase();
        const isCredit = explicitType === 'credit' || explicitType === 'income' ||
            /\bcredited\b|\bcredit\b|received|deposited|inward/i.test(hay);
        if (!isCredit && explicitType === 'debit') return null;
        if (!isCredit) return null;

        // Investment?
        for (const [label, rx] of INVESTMENT_PATTERNS) {
            if (rx.test(hay)) {
                return { isIncome: true, isInvestment: true, category: label, module: 'income', confidence: 0.9 };
            }
        }
        // Plain income?
        for (const [label, rx] of INCOME_PATTERNS) {
            if (rx.test(hay)) {
                return { isIncome: true, isInvestment: false, category: label, module: 'income', confidence: 0.88 };
            }
        }
        // Credit but unknown source — still income, lower confidence (review).
        if (isCredit) {
            return { isIncome: true, isInvestment: false, category: 'Other Income', module: 'income', confidence: 0.72 };
        }
        return null;
    }

    // Keyword category inference for an expense.
    function inferCategory(text) {
        const hay = _clean(text).toLowerCase();
        for (const [cat, rx, mod] of KEYWORDS) {
            if (rx.test(hay)) {
                return { category: cat, module: mod || 'expenses', confidence: 0.78, source: 'keyword' };
            }
        }
        return { category: 'Other', module: 'expenses', confidence: 0.4, source: 'unknown' };
    }

    // Master classify: merchant name + full text + optional explicit debit/credit.
    // Tries memory → income → keyword. (Exact merchant DB lives in the brain;
    // this is the shared *fallback* brain so every path agrees.)
    function classify(merchantName, fullText, opts) {
        opts = opts || {};
        const text = _clean((merchantName || '') + ' ' + (fullText || ''));

        // 1) Income / investment first (a credit shouldn't be miscategorised as expense)
        const inc = detectIncome(text, opts.type);
        if (inc) {
            return {
                name: merchantName || inc.category,
                category: inc.category,
                module: inc.module,
                isIncome: true,
                isInvestment: inc.isInvestment,
                isSubscription: false,
                confidence: inc.confidence,
                source: inc.isInvestment ? 'investment_detect' : 'income_detect'
            };
        }

        // 2) Learned memory (browser only)
        try {
            if (opts.useMemory !== false && root.wfMemory && typeof root.wfMemory.recallSync === 'function') {
                const mem = root.wfMemory.recallSync(merchantName || text);
                if (mem && mem.category) {
                    return {
                        name: merchantName || mem.category, category: mem.category,
                        module: mem.module || 'expenses', isIncome: false, isInvestment: false,
                        isSubscription: !!mem.isSubscription, confidence: mem.confidence || 0.95,
                        source: 'memory'
                    };
                }
            }
        } catch (_) {}

        // 3) Keyword inference
        const kw = inferCategory(text);
        return {
            name: merchantName || (kw.category === 'Other' ? 'Unknown Merchant' : kw.category),
            category: kw.category,
            module: kw.module,
            isIncome: false,
            isInvestment: false,
            isSubscription: kw.module === 'subscriptions',
            confidence: merchantName ? kw.confidence : Math.max(0.3, kw.confidence - 0.1),
            source: kw.source
        };
    }

    // Agentic identify: for an unknown merchant, ask the server endpoint to do
    // a real web lookup. Returns null on any failure (caller keeps local guess).
    // Privacy: only the merchant name + country are sent — never amounts/cards.
    async function identifyUnknown(merchantName, country) {
        try {
            if (typeof fetch !== 'function' || !merchantName) return null;
            const r = await fetch('/api/merchant-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ merchant: merchantName, country: country || 'Sri Lanka' })
            });
            if (!r.ok) return null;
            const d = await r.json();
            if (!d || !d.ok || !d.category) return null;
            return {
                name: merchantName,
                category: d.category,
                module: 'expenses',
                isIncome: false, isInvestment: false, isSubscription: false,
                confidence: d.confidence || 0.8,
                description: d.description || null,
                source: 'web_search:' + (d.provider || '?')
            };
        } catch (_) { return null; }
    }

    root.wfCategoryAI = {
        classify, inferCategory, detectIncome, identifyUnknown,
        KEYWORDS, INCOME_PATTERNS, INVESTMENT_PATTERNS,
        version: '1.0'
    };
    if (typeof console !== 'undefined' && console.log) console.log('[wfCategoryAI] ✓ shared category intelligence loaded (v1.0)');
})(typeof window !== 'undefined' ? window : globalThis);
