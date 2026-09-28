/* =============================================================================
   WealthFlow Merchant Intelligence  v1.0   →  window.WFMerchants
   ---------------------------------------------------------------------------
   The deterministic Sri-Lanka-aware classifier that decides, for every bank /
   card transaction, its  GOES-TO (tab)  and  TYPE (category)  with high
   accuracy and ZERO latency — so a mobile-bill lands in Telecom (Subscriptions),
   an insurer lands in Insurance (Subscriptions), and a supermarket lands in
   Groceries (Expenses), every time.

   Why a dedicated engine:
     • The bank prints noisy narrations ("Pos Transaction Softlogic Life
       Insurance Colombo 03", "Ib Bill Payment 0775050020", "Pos Transaction Fee
       Ac-Lkr…"). This engine strips the bank prefix, detects mobile numbers and
       fees, and matches a large curated SL merchant registry by MEANING.
     • Deterministic + offline ⇒ instant and reproducible for known merchants;
       the multi-model AI consensus is reserved only for the genuine unknowns.
     • Self-learning: every classification the user confirms is remembered, so
       the registry grows automatically and unknowns shrink over time.
     • Self-verifying: the learned store is validated for conflicts on every load.

   API
     WFMerchants.classify(desc, direction)  → {goesTo, category, type, subName,
                                               subPhone, confidence, matched, reason}
     WFMerchants.refine(desc, direction, routed) → improved routing | null
     WFMerchants.learn(desc, tab, category)  → remember a confirmed mapping
     WFMerchants.verify()                    → {ok, conflicts[]}
     WFMerchants.stats()  ·  export()  ·  merge(list)
   ============================================================================ */
(function (root) {
    'use strict';
    if (root.WF_MERCHANTS_LOADED) return;
    root.WF_MERCHANTS_LOADED = '1.0';
    var VERSION = '1.0';
    var LS_LEARN = 'wf_merchant_learned';
    var LS_UNKNOWN = 'wf_merchant_unknown';   // merchants seen in YOUR statements that nothing could identify
    var LS_PENDING = 'wf_merchant_pending';   // AI answers that did NOT clear the 0.95 gate — never written, shown for confirmation
    var AI_URL = '/api/ai';                   // your OWN endpoint — it already holds every AI key in Vercel
    var VERIFY_URL = '/api/verify';           // SEARCH-FIRST verification (Serper -> one fast LLM, cite-or-abstain)
    // TWO gates, deliberately different.
    //   LOCAL  0.95 — learned on THIS device only. Lower, so the app actually learns
    //                 your habits instead of freezing.
    //   GLOBAL 0.99 — required before a merchant may enter merchants.json, which every
    //                 device on earth then trusts. A wrong entry there is contagious.
    var WRITE_GATE = 0.95;                    // local device gate
    var GLOBAL_GATE = 0.99;                   // global registry gate (enforced in the Action too)
    var LS_REMOTE = 'wf_merchants_remote_v1';        // verified copy of the fetched list
    var LS_REMOTE_TS = 'wf_merchants_remote_ts';      // last sync time (throttle)
    var REMOTE_URL = '/merchants.json';               // same-origin, served static by Vercel
    var REMOTE_TTL = 6 * 3600 * 1000;                 // re-sync at most every 6h
    var _remote = [];                                 // [{key,category,goesTo}] sorted by key length desc

    function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }
    // a compact form that KEEPS letters+digits glued (so "apple.com/bill" → "applecombill",
    // "echannelling" stays, "0775050020" stays) — lets us catch merchants the noisy
    // narration mashes together and that the space-normaliser would break.
    function glue(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ''); }

    // ── which categories are RECURRING → they belong in the Subscriptions tab ──
    var SUB_CATS = { Telecom: 1, Insurance: 1, Streaming: 1, Internet: 1, Utilities: 1, Software: 1, 'Gym/Fitness': 1, Leasing: 1 };

    // ── Sri Lanka mobile number → strongest telecom signal ─────────────────────
    var RE_PHONE = /(?:\+?94|0)7\d(?:[\s-]?\d){7}/;
    function phoneOf(desc) { var m = String(desc || '').match(RE_PHONE); return m ? m[0].replace(/[\s-]/g, '').replace(/^94/, '0') : null; }

    // ── bank-narration prefixes to strip so we match on the real merchant ──────
    var PREFIXES = [
        /^ib\s+bill\s+payment\s+/i, /^bill\s+payment\s+/i, /^pos\s+transaction\s+/i, /^pos\s+/i,
        /^inward\s+ceft\s+transfer\s+/i, /^outward\s+ceft\s+transfer\s+/i, /^ceft\s+(charges?|transfer)\s+/i,
        /^transfer\s+(debit|credit)[- ]*(mobilebanking)?\s*/i, /^atm\s+withdrawal\s+(fee\s+)?/i,
        /^crm\s+cash\s+deposit\s+/i, /^lanka\s+qr[\s-]+payment\s+(debit|credit)\s*/i, /^charge\s*-\s*(capitalise\s+)?/i,
        /^standing\s+order\s+/i, /^direct\s+debit\s+/i, /^online\s+(purchase|payment)\s+/i
    ];
    function stripPrefix(desc) { var s = String(desc || '').trim(); for (var i = 0; i < PREFIXES.length; i++) s = s.replace(PREFIXES[i], ''); return s.trim(); }

    // ── FEE detector (must win before merchant matching) ───────────────────────
    var FEE_KWS = ['pos transaction fee', 'transaction fee', 'atm withdrawal fee', 'withdrawal fee', 'ceft charge', 'cefts charge', 'ceft charges', 'slips charge', 'slip charge', 'stamp duty', 'debit tax', 'service charge', 'maintenance fee', 'ledger fee', 'sms active fee', 'sms alert', 'sms charge', 'alert charge', 'active fee', 'fuel surcharge', 'card annual', 'annual fee', 'annual or maintenance', 'card fee', 'card replacement', 'over limit', 'overlimit', 'late fee', 'late payment', 'finance charge', 'interest charge', 'commission', 'processing fee', 'handling fee', 'e statement fee', 'estatement fee', 'statement fee', 'capitalise', 'capitalize', 'fallback fee', 'markup', 'mark up', 'conversion fee', 'cross border', 'reissue', 'pin reissue', 'joining fee', 'membership fee', 'cheque return', 'return fee', 'ledger', 'vat', 'nbt', 'sscl', 'cess', 'government levy', 'govt levy', 'levy', 'debit interest', 'credit interest',
        /* A cash-advance fee is the one fee this list did not know, so
         * "LOCAL CASH ADVANCE FEE (DB)" matched nothing at all and was sent to
         * the manual review queue — where the picker had no category for it
         * either. wealthflow-route.js has recognised these since it was written;
         * only this module had not. */
        'cash advance fee', 'local cash advance fee', 'overseas cash advance fee',
        'cash adv fee', 'advance fee', 'cash advance interest'];
    // words that make a "fee-looking" line actually a normal payment (avoid false fees)
    // A fee keyword must never match INSIDE another word. 'vat' hides in
    // "priVATe" / "cultiVATion"; 'cess' hides in "proCESSing" / "prinCESS".
    // Multi-word phrases are safe to substring-match (spaced AND glued, because
    // banks glue: "ceft charges" -> "ceftcharges"); single words demand a
    // word boundary.
    var FEE_PHRASES = [], FEE_WORDS = [];
    (function () { for (var i = 0; i < FEE_KWS.length; i++) { (FEE_KWS[i].indexOf(' ') >= 0 ? FEE_PHRASES : FEE_WORDS).push(FEE_KWS[i]); } })();
    var RE_FEE_WORD = new RegExp('\\b(' + FEE_WORDS.join('|') + ')\\b');
    function isFee(nd, gd) {
        for (var i = 0; i < FEE_PHRASES.length; i++) { var k = FEE_PHRASES[i]; if (nd.indexOf(k) >= 0 || gd.indexOf(k.replace(/ /g, '')) >= 0) return true; }
        return RE_FEE_WORD.test(nd);
    }

    /* Cash ADVANCE (borrowed against a card) is not cash WITHDRAWAL (your own
     * money out of an ATM). They carry different fees and different meaning, so
     * they stay two categories rather than one comfortable blur. */
    var RE_CASH_ADVANCE = /\b(cash advance|cash adv|advance from (?:mb|cc|card))\b/;

    // ── truncation-tolerant key match ────────────────────────────────────────
    // Banks CUT merchant names to fit a fixed field: "Aliexpress"->"Aliexpres",
    // "Vital Essence (Pvt) Ltd"->"Vital Essence (Pvt) Lt". Allow up to 2 missing
    // trailing characters, but only on long distinctive keys (never short ones).
    var _reCache = {};
    function _wordRe(k) { return _reCache[k] || (_reCache[k] = new RegExp('\\b' + k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b')); }
    /* glue() runs a regex over its argument. hasKey() called it on the KEY, and
     * _matchRegistry walks 538 fixed keys for every record classified, so the same
     * 538 strings were re-glued on every single call. A CPU profile of the app
     * rendering 2,000 records put 23-30% of the whole main thread in glue() alone,
     * and another 34-38% in hasKey() around it — those two were the app's largest
     * single cost. The key set never changes, so it is computed once. */
    /* EVERYTHING hasKey() derives from a key is a property of the key, and the key
     * set is fixed: 538 of them, walked for every record classified. The old body
     * re-did all of it on every call — String(key).trim() allocated, glue() ran a
     * regex, and the two truncation prefixes were sliced fresh. Computed once per
     * key instead. Behaviour is unchanged, deliberately and exactly:
     *   short  = the length<=6 single-word rule, which must stay off the glued path
     *   gOk    = the "never glue-match a short key" floor at 6
     *   g1/g2  = the 1- and 2-character truncation prefixes, present only at the
     *            lengths that were allowed to use them (8 and 10) */
    var _keyInfo = {};
    function _info(key) {
        var v = _keyInfo[key];
        if (v) return v;
        var k = String(key).trim();
        var g = glue(k);
        v = {
            k: k,
            short: (k.length <= 6 && k.indexOf(' ') < 0),
            gOk: g.length >= 6,
            g: g,
            g1: g.length >= 8 ? g.slice(0, g.length - 1) : null,
            g2: g.length >= 10 ? g.slice(0, g.length - 2) : null
        };
        return (_keyInfo[key] = v);
    }
    function hasKey(nd, gd, key) {
        if (!key) return false;
        var i = _info(key);
        if (!i.k) return false;
        // A SHORT single word may ONLY match on a word boundary in the normalised text.
        // It must NEVER take the glued path: glue() deletes every space, so "spar" would
        // match inside "SPARe part", "gold" inside "GOLDen Key Hospital" and "mart"
        // inside "walMART" — silently mis-filing real merchants.
        if (i.short) return _wordRe(i.k).test(nd);
        if (nd.indexOf(i.k) >= 0) return true;
        if (!i.gOk) return false;                              // never glue-match a short key
        if (gd.indexOf(i.g) >= 0) return true;
        // Banks TRUNCATE merchant names to fit a fixed field ("Aliexpress"->"Aliexpres",
        // "Vital Essence (Pvt) Ltd"->"Vital Essence (Pvt) Lt"). Allow up to 2 missing
        // trailing characters, but only on long distinctive keys.
        if (i.g1 && gd.indexOf(i.g1) >= 0) return true;
        if (i.g2 && gd.indexOf(i.g2) >= 0) return true;
        return false;
    }

    // ── masked credit-card number  ("376657Xxxxx0276" = an AMEX bill payment) ──
    // Paying your CARD from your BANK is NOT an expense — the card's purchases are
    // already expenses. Filing the payment as one counts the same money TWICE.
    var RE_CARD_MASK = /(\d{4,6})[x*\s]{3,}(\d{4})(?!\d)/;
    function cardOf(nd) {
        var m = String(nd || '').match(RE_CARD_MASK);
        if (!m) return null;
        var bin = m[1], last4 = m[2];
        var brand = /^3[47]/.test(bin) ? 'AMEX' : bin.charAt(0) === '4' ? 'Visa' : bin.charAt(0) === '5' ? 'Mastercard' : bin.charAt(0) === '6' ? 'Discover' : 'Card';
        return { bin: bin, last4: last4, brand: brand };
    }

    // ── generic industry tokens ──────────────────────────────────────────────
    // These GENERALISE to merchants nobody has ever listed: any "... Pharmacy",
    // any "... Restaurant", any "... Interchange RDA". This is what lifts coverage
    // far beyond a finite brand list. Brands still win (checked earlier).
    var INDUSTRY = [
        ['Health', ['pharmacy', 'pharmacies', 'medstore', 'med store', 'drug store', 'hospital', 'nursing home', 'medical cent', 'medicare', 'clinic', 'dental', 'laborator', 'diagnostic', 'channell', 'osusala', 'osu sala', 'ayurved', 'optic', 'surgical']],
        ['Dining', ['restaurant', 'restaurent', 'cafe', 'caffe', 'coffee', 'bakery', 'bakers', 'pizza', 'burger', 'kottu', 'hotel ', 'food court', 'foodcourt', 'fast food', 'ice cream', 'creamery', 'crepe', 'wine ', 'liquor', 'beer', 'pub ', 'lounge', 'kitchen', 'grill', 'bbq', 'juice bar', 'tea shop', 'sweet house', 'confection']],
        ['Groceries', ['supermarket', 'super market', 'food city', 'grocer', 'mini mart', 'minimart', 'mart ', ' mart', 'super cent', 'supercent', 'mpcs', 'co op city', 'coop city', 'co-op', 'sathosa', 'provision', 'general store', 'daily needs']],
        ['Transport', ['interchange', 'expressway', 'express way', ' rda', 'rda ', 'toll', 'taxi', 'cab service', 'rent a car', 'car rent', 'vehicle rent', 'bus depot', 'railway', 'parking', 'transport']],
        ['Fuel', ['filling station', 'fuel station', 'petrol shed', 'petroleum', 'service station']],
        ['Gold', ['jewellers', 'jewellery', 'jewelers', 'goldsmith', 'gold shop']],
        ['Shopping', ['apparel', 'garment', 'textile', ' tex', 'dress point', 'dress shop', 'fashion', 'boutique', 'footwear', 'shoe ', 'furniture', 'hardware', 'electronic', 'computer', 'communication', 'cellular', 'mobile shop', 'phone shop', 'technolog', 'distribut', 'traders', 'enterprises', 'stores', 'book shop', 'bookshop', 'stationery', 'toy ', 'gift ']],
        ['Education', ['institute', 'campus', 'college', 'academy', 'university', 'tuition', 'school ']],
        ['Utilities', ['water board', 'electricity', 'gas company']],
        ['Gym/Fitness', ['gym', 'fitness', 'health club', 'yoga']]
    ];
    function industryOf(nd, gd) {
        for (var i = 0; i < INDUSTRY.length; i++) {
            var cat = INDUSTRY[i][0], toks = INDUSTRY[i][1];
            for (var j = 0; j < toks.length; j++) { if (nd.indexOf(toks[j]) >= 0) return { category: cat, token: toks[j].trim() }; }
        }
        return null;
    }

    // ── the Sri Lanka merchant / category registry ─────────────────────────────
    // Each entry: [category, [keywords…]]. Order = precedence (earlier wins).
    // Keywords are matched as substrings on BOTH the space-normalised text and the
    // glued text, so noisy/merged narrations still resolve.
    var REGISTRY = [
        // — Insurance (recurring) — insurers first so "Softlogic Life" never falls to Shopping
        ['Insurance', ['insurance', 'insuarance', 'insurence', 'assurance', 'takaful', 'life cover', 'endowment', 'policy premium', 'softlogic life', 'aia insurance', 'aia ', 'ceylinco', 'allianz', 'union assurance', 'sri lanka insurance', 'srilanka insurance', 'janashakthi', 'hnb assurance', 'amana takaful', 'fairfirst', 'cooplife', 'coop life', 'arpico insurance', 'continental insurance', 'orient insurance', 'lolc life', 'lolc general', 'lolc insurance', 'sanasa insurance', 'sanasa life', 'peoples insurance', 'mbsl insurance', 'life insurance', 'general insurance', 'motor insurance', 'vehicle insurance', 'health insurance', 'medical insurance', 'critical illness', 'softlogic finance life']],
        // — Telecom (recurring) —
        ['Telecom', ['dialog axiata', 'dialog broadband', 'dialog tv', 'dialog ', 'mobitel', 'slt mobitel', 'sri lanka telecom', 'sltmobitel', 'slt ', 'hutchison', 'hutch', 'airtel', 'etisalat', 'lanka bell', 'lankabell', 'peotv', 'peo tv', 'airtime', 'prepaid reload', 'reload', 'recharge', 'ez cash', 'ezcash', 'mcash', 'genie', 'kaspa', 'starpoints', 'lucky communication', 'lanka communication']],
        // — Streaming (recurring) —
        ['Streaming', ['netflix', 'spotify', 'youtube premium', 'yt premium', 'youtubepremium', 'youtube', 'disney', 'hbo', 'hulu', 'amazon prime', 'prime video', 'primevideo', 'apple music', 'applemusic', 'apple tv', 'appletv', 'hotstar', 'deezer', 'crunchyroll', 'audible', 'patreon', 'twitch', 'iflix', 'shahid', 'wwe network']],
        // — Software / cloud (recurring) —
        ['Software', ['github', 'apple.com/bill', 'applecombill', 'apple com bill', 'apple.com', 'icloud', 'google one', 'googleone', 'google storage', 'google gsuite', 'google workspace', 'microsoft', 'office 365', 'office365', 'microsoft 365', 'ms365', 'adobe', 'dropbox', 'notion', 'canva', 'openai', 'chatgpt', 'anthropic', 'claude.ai', 'figma', 'jetbrains', 'godaddy', 'namecheap', 'digitalocean', 'linode', 'heroku', 'vercel', 'netlify', 'cloudflare', 'zoom.us', 'zoom video', 'slack', 'atlassian', 'jira', 'grammarly', '1password', 'nordvpn', 'expressvpn', 'surfshark', 'lastpass', 'evernote', 'wordpress', 'wix.com', 'squarespace', 'aws', 'amazon web', 'azure', 'play google', 'google play', 'steam games', 'playstation network', 'psn ', 'xbox', 'nintendo']],
        // — Internet / broadband (recurring) —
        ['Internet', ['broadband', 'fibre', 'fiber', 'home internet', 'wifi', 'wi fi', 'internet bill', 'adsl', '4g router', 'home broadband']],
        // — Utilities (recurring) —
        ['Utilities', ['ceb ', 'ceylon electricity', 'electricity', 'leco', 'water board', 'nwsdb', 'wasa ', 'sewerage', 'litro', 'litro gas', 'laugfs gas', 'gas bill', 'electricity bill', 'water bill', 'prepaid meter', 'meter reading', 'gas refill', 'gas cylinder']],
        // — Groceries / supermarkets —
        ['Groceries', ['cargills', 'food city', 'foodcity', 'keells', 'keels', 'arpico daily', 'arpico super', 'arpico supercentre', 'glomark', 'laugfs super', 'sathosa', 'lanka sathosa', 'spar ', 'sunup', 'healthy living', 'maharaja super', 'su711', 'maliban super', 'fresh mart', 'mac mart', 'macmart', 'foodstar', 'mpcs', 'co op city', 'coop city', 'cooperative', 'super market', 'supermarket', 'provision', 'grocery', 'nihal stores', 'jaya super', 'vishwa super', 'delight holdings', 'dunhinda brothers', 'daily super', 'mini mart', 'minimart']],
        // — Dining / food & beverage —
        ['Dining', ['restaurant', 'cafe', 'coffee', 'kfc', 'pizza hut', 'pizzahut', 'pizza', 'dominos', 'mcdonald', 'burger king', 'burgerking', 'burger', 'subway', 'dinemore', 'perera and sons', 'pereraandsons', 'pilawoos', 'barista', 'java lounge', 'dunkin', 'crepe runner', 'creperunner', 'crepe', 'simply strawberries', 'strawberries', 'mandiya', 'spicy food', 'sponge', 'shanmugas', 'elephant house', 'cool spot', 'chinese dragon', 'nuga gama', 'kottu', 'rice and curry', 'bistro', 'eatery', 'bakery', 'bake house', 'bakehouse', 'hela bojun', 'raja bojun', 'green cabin', 'chatime', 'cinnabon', 'chooti', 'the commons', 'coffee bean', 'cafe kumbuk', 'food court', 'foodcourt', 'fast food', 'fried chicken', 'tea shop', 'juice bar', 'ice cream', 'dessert', 'waffle', 'donut', 'shawarma', 'hoppers', 'lamprais', 'noodles', 'ramen', 'sushi', 'grill', 'barbeque', 'buffet', 'canteen', 'cafeteria']],
        // — Health / medical —
        ['Health', ['pharmacy', 'pharma', 'hospital', 'medical', 'medicine', 'medicare', 'clinic', 'channelling', 'echannelling', 'e channelling', 'echannel', 'doc990', 'odoc', 'nawaloka', 'asiri', 'hemas hospital', 'durdans', 'lanka hospital', 'ninewells', 'healthguard', 'osu sala', 'osusala', 'laksiri', 'union chemist', 'medstore', 'med store', 'vital essence', 'raj pharmacy', 'isuru pharmacy', 'sunrise pharmacy', 'no 1 pharmacy', 'dental', 'dentist', 'optical', 'optician', 'spectacle', 'laboratory', 'medi lab', 'scan centre', 'scan center', 'x ray', 'xray', 'diagnostic', 'radiology', 'ayurveda', 'ayurvedic', 'glaxo', 'supplements', 'vitamins', 'nursing home', 'physiotherapy', 'surgery', 'eye hospital', 'central hospital', 'golden key hospital', 'navinna']],
        // — Transport (incl. RDA expressway tolls, ride-hailing, vehicle service) —
        ['Transport', ['uber', 'pickme', 'pick me', 'taxi', 'railway', 'parking', 'toll', 'expressway', 'interchange', ' rda', 'rda ', 'highway', 'tyre', 'tire', 'auto part', 'spare part', 'garage', 'car wash', 'carwash', 'rent a car', 'car rental', 'self drive', 'revenue license', 'emission test', 'three wheeler', 'tuk tuk', 'yego', 'kangaroo cab', 'sltb', 'ctb', 'vehicle service', 'lubricant', 'battery', 'wheel alignment', 'puncture', 'car park', 'season ticket', 'car rent', 'rent car', 'vehicle rent']],
        // — Fuel —
        ['Fuel', ['fuel', 'petrol', 'diesel', 'filling station', 'fuel shed', 'ceypetco', 'lanka ioc', 'lioc', ' ioc', 'sinopec', 'total energies', 'petroleum', 'cpc filling', 'associated motorways', 'rm parks', 'united petroleum', 'laugfs petroleum', 'gas station', 'petrol shed']],
        // — Education —
        ['Education', ['tuition', 'university', 'campus', 'institute', 'coursera', 'udemy', 'british council', 'ielts', 'toefl', 'vijitha yapa', 'sarasavi', 'makeen', 'stafford', 'apiit', 'nsbm', 'sliit', 'kdu', 'ousl', 'academy', 'college', 'montessori', 'pre school', 'preschool', 'day care', 'international school', 'diploma', 'edexcel', 'cambridge', 'pearson', 'kaplan', 'book shop', 'bookshop', 'book store', 'bookstore', 'school ']],
        // — Government / statutory services —
        ['Government', ['crib', 'credit information', 'inland revenue', 'ird ', 'motor traffic', 'rmv ', 'immigration', 'passport', 'land registry', 'title documents', 'company registration', 'registrar', 'pradeshiya sabha', 'municipal council', 'urban council', 'grama niladhari', 'divisional secretariat', 'court fees', 'license fee', 'government', 'e revenue', 'erl ']],
        // — Shopping / retail / e-commerce —
        ['Shopping', ['odel', 'nolimit', 'no limit', 'house of fashion', 'houseoffashion', 'cotton collection', 'fashion bug', 'fashionbug', 'hameedia', 'kapruka', 'daraz', 'amazon', 'aliexpress', 'alibaba', 'shein', 'temu', 'ebay', 'wish.com', 'koko', 'mintpay', 'mint pay', 'singer', 'abans', 'damro', 'softlogic', ' dsi', 'dsi ', 'bata', 'nike', 'adidas', 'showroom', 'xiaomi', 'redmi', 'samsung', 'huawei', 'oppo', 'realme', 'apple store', 'laptop', 'smartphone', 'electronics', 'furniture', 'homelux', 'home centre', 'department store', 'boutique', 'apparel', 'garment', 'textile', ' tex', 'tex ', 'dress point', 'dresspoint', 'saree', 'fabric', 'clothing', 'footwear', 'handbag', 'jewell', 'toys', 'gift shop', 'new kandy tex', 'sriyani dress', 'serandib technologies', 'sense micro', 'wine world', 'wine store', 'liquor', 'foodstar marketing', 'mac mart kandy']],
        // — Gold / jewellery —
        ['Gold', ['gold', 'jewell', 'pawning', 'pawn ', 'gem stone', 'swarna mahal', 'vogue jewell']]
    ];

    // learned overrides (user-confirmed) take precedence over the seed registry
    /* classify() consults the learned map, so this used to read localStorage and
     * JSON.parse it once per record. It is cached and dropped whenever anything
     * writes it, which is the only way it can change from under us — a stale
     * learned map would file a merchant into the category the user had just
     * corrected, so the invalidation matters more than the speed does. */
    var _learnedCache = null;
    function _loadLearned() {
        if (_learnedCache) return _learnedCache;
        try { _learnedCache = JSON.parse(root.localStorage.getItem(LS_LEARN) || '{}') || {}; }
        catch (_) { _learnedCache = {}; }
        return _learnedCache;
    }
    function _saveLearned(o) {
        _learnedCache = o || {};
        _clsForget();          // the learned map is an input to every classification
        try { root.localStorage.setItem(LS_LEARN, JSON.stringify(o)); } catch (_) {}
    }
    /* Anything that changes the map outside _saveLearned — another tab, a cloud
     * sync, a manual edit — must be able to drop the cache. */
    function _forgetLearned() { _learnedCache = null; _clsForget(); }
    // a stable merchant key from a noisy narration: strip prefix, drop trailing city/refs,
    // keep the first strong tokens.
    function merchantKey(desc) {
        var s = norm(stripPrefix(desc)).replace(/\b(colombo|kandy|kurunegala|kuliyapitiya|negombo|galle|matara|jaffna|gampaha|kaluthara|kalutara|dambulla|homagama|nugegoda|wellampitiya|ibbagamuwa|meerigama|mirigama|maharagama|moratuwa|panadura|ja ela|jaela|wattala|dehiwala|ratmalana|pvt|ltd|plc|private|limited|the|and)\b/g, ' ').replace(/\d{4,}/g, ' ').replace(/\s+/g, ' ').trim();
        return s.split(' ').slice(0, 4).join(' ').trim();
    }

    function _matchRegistry(nd, gd) {
        for (var i = 0; i < REGISTRY.length; i++) {
            var cat = REGISTRY[i][0], kws = REGISTRY[i][1];
            for (var j = 0; j < kws.length; j++) {
                // hasKey applies the SAME rules everywhere: a short single word needs a
                // word boundary (so "spar" can't fire inside "SPARe part" and "jewell"
                // can't fire inside "JEWELLers"), long keys tolerate bank truncation.
                if (hasKey(nd, gd, kws[j])) return { category: cat, keyword: kws[j] };
            }
        }
        return null;
    }

    // ── the classifier ─────────────────────────────────────────────────────────
    // ── what KIND of money-in is this? ───────────────────────────────────────
    // Matched against both forms: `nd` keeps single spaces ("cash back"), `gd`
    // glues everything ("cashback"), and bank narrations use either.
    var CREDIT_RE = {
        refund: [/\b(refunds?|refunded|reversals?|reversed|charge ?backs?|cash ?backs?|rebates?|reimburse(?:d|ment)?s?)\b/,
            /(refund|reversal|chargeback|cashback|rebate|reimbursement)/],
        transfer: [/\b(own account|self transfer|internal transfer|inter account|transfer from (?:my|own)|acct transfer)\b/,
            /(ownaccount|selftransfer|internaltransfer|interaccount)/],
        loan_in: [/\b(loan (?:disburse\w*|drawdown|proceeds)|disbursements?|od drawdown)\b/,
            /(loandisburse|loandrawdown|disbursement)/],
        /* Drawing cash against a credit card lands in the bank account as a
         * CREDIT. It is borrowing at the highest rate the card charges — filing
         * it as income would overstate earnings and understate what is owed, in
         * the same movement. It is a loan drawdown wearing a different name. */
        cash_advance: [/\b(cash advance|cash adv|advance from (?:mb|cc|card))\b/,
            /(cashadvance|cashadv)/],
        salary: [/\b(salary|salaries|payroll|wages|stipend|pension|gratuity|bonus)\b/,
            /(salary|payroll)/],
        ret: [/\b(dividends?|interest credit|coupon|maturity|redemption|profit credit)\b/,
            /(dividend|interestcredit|maturity|redemption)/],
    };

    function _hit(kind, nd, gd) {
        var p = CREDIT_RE[kind];
        return p[0].test(nd) || p[1].test(gd);
    }

    /**
     * Resolve a credit. Returns the same shape as classify().
     *
     * `creditKind` is added for callers that want the distinction (the Income
     * Provenance proposal builds directly on it). `goesTo` stays inside the set
     * the rest of the app already understands — null means "I decline", which
     * refine() already treats as "keep WFRoute's answer".
     */
    function creditKind(nd, gd, out) {
        // Money coming BACK, in any of its shapes. Checked before earnings so a
        // line like "SALARY OVERPAYMENT REVERSAL" reads as the reversal it is.
        if (_hit('cash_advance', nd, gd)) {
            out.creditKind = 'cash_advance'; out.confidence = 0.9; out.matched = 'credit:cash_advance';
            out.reason = 'credit-card cash advance — borrowed against your card at card rates, not income';
            return out;
        }
        if (_hit('refund', nd, gd)) {
            out.creditKind = 'refund'; out.confidence = 0.9; out.matched = 'credit:refund';
            out.reason = 'money returned (refund/reversal/cashback) — it reduces the original expense, it is not income';
            return out;
        }
        if (_hit('transfer', nd, gd)) {
            out.creditKind = 'internal_transfer'; out.confidence = 0.9; out.matched = 'credit:transfer';
            out.reason = 'transfer between your own accounts — the same money, not new money';
            return out;
        }
        if (_hit('loan_in', nd, gd)) {
            out.creditKind = 'loan_drawdown'; out.confidence = 0.85; out.matched = 'credit:loan';
            out.reason = 'loan drawdown — borrowed, not earned';
            return out;
        }
        if (_hit('salary', nd, gd)) {
            out.creditKind = 'salary'; out.goesTo = 'income'; out.category = 'Salary';
            out.type = 'earning'; out.confidence = 0.92; out.matched = 'credit:salary';
            out.reason = 'salary/payroll credit → Income';
            return out;
        }
        if (_hit('ret', nd, gd)) {
            out.creditKind = 'investment_return'; out.goesTo = 'income'; out.category = 'Investment Return';
            out.type = 'earning'; out.confidence = 0.88; out.matched = 'credit:return';
            out.reason = 'investment return (dividend/interest/maturity) → Income';
            return out;
        }
        // Nothing identified it. Refusing to guess is the point: asserting
        // "income" here is what made every refund look like earnings.
        out.creditKind = 'unknown'; out.confidence = 0;
        out.reason = 'money in, but nothing in the text says what kind — not assumed to be income';
        return out;
    }

    /* ── the answer for one narration does not change between renders ─────────
     * A CPU profile of the app rendering 2,000 records put over half the main
     * thread inside classify(): the insight strips classify every record, on every
     * render, and _matchRegistry walks 538 keywords for each one. The same
     * narration produces the same answer, and a re-render re-asks the identical
     * questions, so the answers are kept.
     *
     * WHAT THE CACHE DEPENDS ON, AND WHERE EACH IS DROPPED
     *   the learned map  → _saveLearned() and _forgetLearned()
     *   the remote list  → _setRemote()
     * Those are the only two inputs besides the narration and the direction. A
     * stale entry would be worse than a slow one: it would re-file a merchant into
     * the category the user had just corrected, which is precisely the complaint
     * that made the learned map exist. The invalidation is the point; the speed is
     * the side effect.
     *
     * Bounded, because a long import is thousands of distinct narrations and this
     * must not become a memory leak on a phone.
     *
     * TWO GENERATIONS, NOT ONE, and that was measured rather than reasoned. The
     * first version emptied the cache on reaching its ceiling, which on a store
     * holding more distinct narrations than the ceiling made it fill, clear and
     * refill: the dashboard timed 826 ms, then 53 ms, then 302 ms. Retiring the
     * older half instead of dropping everything removes the cliff — a key that is
     * still being asked for is promoted back into the live generation on its next
     * hit, and one that is not simply ages out. */
    var CLS_CACHE_MAX = 3000;
    var _clsCache = Object.create(null), _clsOld = Object.create(null), _clsCount = 0;
    /* Anything downstream that caches something DERIVED from a classification has
     * the same staleness problem and no way to know about it. wealthflow-insights
     * keeps a merchant-key cache of exactly that kind, and it was never cleared —
     * so after the user corrected a merchant, the analytics kept grouping it under
     * the brand the classifier had guessed before the correction. A counter is
     * enough: a reader stores the epoch alongside its cache and drops it when the
     * number moves. No registration, no coupling beyond an integer. */
    var _clsEpoch = 1;
    function epoch() { return _clsEpoch; }
    function _clsForget() {
        _clsCache = Object.create(null); _clsOld = Object.create(null); _clsCount = 0;
        _clsHits = 0; _clsMisses = 0;
        _clsEpoch++;
    }
    /* Counted, so the two-generation behaviour can be asserted rather than
     * described. Without this the difference between retiring the older half and
     * dropping everything is invisible from outside — both answer correctly, one
     * just recomputes far more — and a guard that cannot see the difference is not
     * guarding it. */
    var _clsHits = 0, _clsMisses = 0;
    function _clsStats() {
        return { hits: _clsHits, misses: _clsMisses, live: _clsCount,
                 retired: Object.keys(_clsOld).length, max: CLS_CACHE_MAX };
    }
    function _clsGet(k) {
        var v = _clsCache[k];
        if (v) { _clsHits++; return v; }
        v = _clsOld[k];
        if (v) { _clsCache[k] = v; _clsCount++; _clsHits++; return v; }   // still wanted — promote it
        _clsMisses++;
        return v;
    }
    function _clsPut(k, v) {
        if (_clsCount >= CLS_CACHE_MAX) { _clsOld = _clsCache; _clsCache = Object.create(null); _clsCount = 0; }
        _clsCache[k] = v; _clsCount++;
    }

    function classify(desc, direction) {
        var _ck = String(direction || '') + '\u0000' + String(desc || '');
        var _hit = _clsGet(_ck);
        // A shallow copy: callers mutate what they are handed (refine() does), and a
        // cached object handed out twice would be edited by the first caller and
        // read back wrong by the second.
        if (_hit) {
            var _c = {};
            for (var _k in _hit) { if (Object.prototype.hasOwnProperty.call(_hit, _k)) _c[_k] = _hit[_k]; }
            return _c;
        }
        var _res = _classifyUncached(desc, direction);
        _clsPut(_ck, _res);
        var _o = {};
        for (var _k2 in _res) { if (Object.prototype.hasOwnProperty.call(_res, _k2)) _o[_k2] = _res[_k2]; }
        return _o;
    }

    function _classifyUncached(desc, direction) {
        var raw = String(desc || '');
        var nd = norm(raw), gd = glue(raw);
        var dir = String(direction || '').toLowerCase();
        var out = { goesTo: null, category: null, type: 'purchase', subName: '', subPhone: '', confidence: 0, matched: '', reason: '' };
        if (!nd) return out;

        // 1) money IN — but WHICH money in?
        //
        // This rule used to be `credit → income, confidence 0.6, return`, ahead of
        // every other check. Money arriving is not the same as money earned:
        //
        //   · a refund returns money already recorded as an expense;
        //   · a reversal cancels a charge that is also in the data;
        //   · a transfer between your own accounts is the same money, twice;
        //   · a loan drawdown is borrowed, not earned.
        //
        // Counting any of those as income overstates it. The blanket rule did not
        // corrupt imports today — refine() discards anything under 0.85 confidence
        // and this scored 0.6 — but it IS the answer analyze() shows the user, and
        // it is this module's documented public contract, so it was wrong in the
        // open and one gate-change away from being wrong in the data.
        //
        // Now: say income when something actually says income, decline otherwise.
        // Declining is already the safe contract — a null goesTo makes refine()
        // defer to WFRoute/AI, which is exactly where an unidentified credit
        // belongs. The scores are deliberate: salary clears the 0.85 gate so a
        // real salary is finally ROUTED, where the old blanket 0.6 was both too
        // eager to claim income and too weak to ever be used.
        if (dir === 'credit') return creditKind(nd, gd, out);

        // 2) bank fee / levy → Expenses · Bank Charges (wins over merchant words)
        if (isFee(nd, gd) && !/dialog|mobitel|insurance|netflix|spotify/.test(nd)) {
            out.goesTo = 'expenses'; out.category = 'Bank Charges'; out.type = 'service_fee'; out.confidence = 0.95; out.matched = 'fee'; out.reason = 'bank charge/levy → Bank Charges'; return out;
        }

        // 2b) paying a CREDIT CARD from this bank account → the Card Payments tab.
        //     "Outward Ceft Transfer 376657Xxxxx0276" is an AMEX bill payment, NOT an
        //     expense: the card's purchases are already expenses, so filing the payment
        //     as one counts the same money TWICE. Deterministic → confidence 1.00.
        var _card = cardOf(nd);
        if (_card && dir !== 'credit') {
            out.goesTo = 'cc_payment'; out.category = 'Card Payment'; out.type = 're_payment';
            out.ccLast4 = _card.last4; out.ccBrand = _card.brand;
            out.confidence = 1; out.matched = 'card:' + _card.brand + '****' + _card.last4;
            out.reason = 'masked card number → ' + _card.brand + ' bill payment (Card Payments, not an expense)';
            return out;
        }

        /* 2c) CASH ADVANCE drawn against the card. Deliberately AFTER the fee
         *     rule, so "LOCAL CASH ADVANCE FEE" is read as the fee it is rather
         *     than as the advance itself — the two are separate lines on the
         *     statement and separate money.
         *
         *     Not a purchase. index.html already models cash_advance as its own
         *     type and computes the bank's fee for it (see the service-fee block
         *     there); this module simply never told it so, which is why both the
         *     advance and its fee ended up in the manual review queue. */
        if (RE_CASH_ADVANCE.test(nd) || /cashadvance|cashadv/.test(gd)) {
            out.goesTo = 'expenses'; out.category = 'Cash Advance'; out.type = 'cash_advance';
            out.confidence = 0.95; out.matched = 'cash advance';
            out.reason = 'cash advance against the card → Cash Advance (borrowed, and it carries a fee)';
            return out;
        }

        // 3) learned override (user-confirmed memory)
        var learned = _loadLearned(); var mk = merchantKey(raw);
        if (mk && learned[mk] && learned[mk].category) {
            var lc = learned[mk].category;
            out.category = lc; out.matched = 'learned:' + mk; out.confidence = 0.97;
            out.goesTo = SUB_CATS[lc] ? 'subscription' : (learned[mk].tab || 'expenses');
            if (SUB_CATS[lc]) { out.subName = _subName(raw, lc); out.subPhone = phoneOf(raw) || ''; }
            out.type = out.category === 'Fuel' ? 'fuel' : (out.category === 'Bank Charges' ? 'service_fee' : 'purchase');
            out.reason = 'learned from your confirmed imports'; return out;
        }

        // 4) mobile number → Telecom (Subscriptions) — strong, specific
        var ph = phoneOf(raw);
        var reg = _matchRegistry(nd, gd);
        if (ph && (!reg || reg.category === 'Telecom')) {
            out.goesTo = 'subscription'; out.category = 'Telecom'; out.subPhone = ph;
            out.subName = 'Mobile Connection (' + ph + ')'; out.confidence = 0.95; out.matched = 'mobile:' + ph;
            out.reason = 'mobile number → Telecom (Subscriptions)'; return out;
        }

        // 5) curated merchant registry
        if (reg) {
            out.category = reg.category; out.matched = reg.keyword; out.confidence = 0.9;
            if (SUB_CATS[reg.category]) {
                out.goesTo = 'subscription'; out.subName = _subName(raw, reg.category, reg.keyword); out.subPhone = ph || '';
                out.reason = reg.category + ' → Subscriptions (recurring)';
            } else {
                out.goesTo = 'expenses';
                out.type = reg.category === 'Fuel' ? 'fuel' : 'purchase';
                out.reason = reg.category + ' → Expenses';
            }
            return out;
        }

        // 5b) auto-updated remote merchant list (verified) — fills gaps the seed lacks
        var rem = _matchFlat(nd, gd);
        if (rem) {
            out.category = rem.category; out.matched = 'remote:' + rem.key; out.confidence = 0.88;
            if (SUB_CATS[rem.category] || rem.goesTo === 'subscription') { out.goesTo = 'subscription'; out.subName = _subName(raw, rem.category, rem.key); out.subPhone = ph || ''; out.reason = rem.category + ' \u2192 Subscriptions (auto-updated list)'; }
            else { out.goesTo = 'expenses'; out.type = rem.category === 'Fuel' ? 'fuel' : 'purchase'; out.reason = rem.category + ' \u2192 Expenses (auto-updated list)'; }
            return out;
        }
        // 5c) generic industry tokens — "<anything> Pharmacy" → Health, "<anything>
        //     Restaurant" → Dining, "<anything> Interchange RDA" → Transport. This is
        //     what covers merchants that are on NO list anywhere.
        var ind = industryOf(nd, gd);
        if (ind) {
            out.category = ind.category; out.matched = 'industry:' + ind.token; out.confidence = 0.95;
            if (SUB_CATS[ind.category]) { out.goesTo = 'subscription'; out.subName = _subName(raw, ind.category, null); out.subPhone = ph || ''; out.reason = ind.category + ' → Subscriptions (industry: ' + ind.token + ')'; }
            else { out.goesTo = 'expenses'; out.type = ind.category === 'Fuel' ? 'fuel' : 'purchase'; out.reason = ind.category + ' → Expenses (industry: ' + ind.token + ')'; }
            return out;
        }

        // 6) cash withdrawal (not a fee) → Expenses · Cash Withdrawal
        if (/\b(atm withdrawal|cash withdrawal|cardless cash|crm withdrawal)\b/.test(nd)) {
            out.goesTo = 'expenses'; out.category = 'Cash Withdrawal'; out.confidence = 0.8; out.matched = 'cash'; out.reason = 'cash withdrawal → Expenses'; return out;
        }
        // unknown → let WFRoute / AI consensus decide
        return out;
    }
    /* THE taxonomy — one list, in the order the picker shows it.
     *
     * There were four of these: this one, the picker in wealthflow-verify-panel.js,
     * the server list in api/verify.js and the sentence in the AI prompt below.
     * They had drifted apart, and the drift had a cost the user paid: a cash
     * advance and its own fee were classified into categories this module accepts
     * but the picker could not offer, so the only two lines the system asked a
     * human about were the two it gave the human no way to answer.
     *
     * VALID_CATS and the prompt are now DERIVED from this array, and
     * test/merchant_taxonomy_test.js pins the other two files to it. */
    var CATEGORIES = [
        'Telecom', 'Insurance', 'Streaming', 'Software', 'Internet', 'Utilities',
        'Groceries', 'Dining', 'Health', 'Transport', 'Fuel', 'Education',
        'Government', 'Shopping', 'Gold', 'Gym/Fitness', 'Leasing',
        'Cash Advance', 'Cash Withdrawal', 'Bank Charges', 'Other'
    ];
    // valid taxonomy — the ONLY categories a remote/AI entry may claim (self-verification)
    var VALID_CATS = {};
    for (var _ci = 0; _ci < CATEGORIES.length; _ci++) VALID_CATS[CATEGORIES[_ci]] = 1;
    function _validEntry(e) { return !!(e && typeof e.key === 'string' && e.key.length >= 2 && e.category && VALID_CATS[e.category]); }
    function _matchFlat(nd, gd) { for (var i = 0; i < _remote.length; i++) { var e = _remote[i]; if (hasKey(nd, gd, e.key)) return e; } return null; }
    function _loadRemoteCache() { try { var a = JSON.parse(root.localStorage.getItem(LS_REMOTE) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
    function _saveRemoteCache(a) { try { root.localStorage.setItem(LS_REMOTE, JSON.stringify(a)); } catch (_) {} }
    function _setRemote(a) {
        _remote = (a || []).slice().sort(function (x, y) { return String(y.key).length - String(x.key).length; });  // longer/more-specific keys win
        _clsForget();          // the remote list is the other input to a classification
    }
    // fetch the auto-updated merchant list, VERIFY every entry against the taxonomy, then merge.
    function syncRemote(url, force) {
        try {
            if (typeof fetch !== 'function') return Promise.resolve(0);
            var now = Date.now();
            if (!force) { var last = +(root.localStorage.getItem(LS_REMOTE_TS) || 0); if (now - last < REMOTE_TTL) return Promise.resolve(-1); }
            try { root.localStorage.setItem(LS_REMOTE_TS, String(now)); } catch (_) {}
            return fetch((url || REMOTE_URL) + '?_=' + now, { cache: 'no-store' }).then(function (r) { return r && r.ok ? r.json() : null; }).then(function (j) {
                if (!j || !Array.isArray(j.merchants)) return 0;
                var clean = [], seen = {};
                j.merchants.forEach(function (e) { if (!_validEntry(e)) return; var k = norm(e.key); if (!k || seen[k]) return; seen[k] = 1; clean.push({ key: k, category: e.category, goesTo: (e.goesTo === 'subscription' || e.goesTo === 'expenses' || e.goesTo === 'income') ? e.goesTo : (SUB_CATS[e.category] ? 'subscription' : 'expenses') }); });
                _saveRemoteCache(clean); _setRemote(clean);
                try { root.console && root.console.log('[WFMerchants] \u2713 synced ' + clean.length + ' verified merchants (list v' + (j.version || '?') + ')'); } catch (_) {}
                return clean.length;
            }).catch(function () { return 0; });
        } catch (_) { return Promise.resolve(0); }
    }
    function verifyRemote() { var bad = 0; _remote.forEach(function (e) { if (!_validEntry(e)) bad++; }); return { ok: bad === 0, count: _remote.length, invalid: bad }; }

    function _title(x) { return String(x || '').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }).trim(); }

    // The DISPLAY name of a subscription. This used to be merchantKey(raw), which left
    // the bank's debris behind ("Allianz Life Insurancela 03") and — far worse — the
    // import then fell back to the RAW NARRATION, so a subscription was literally called
    // "Pos Transaction Allianz Life Insurancela". Two statements that spell the same
    // merchant slightly differently then produced TWO subscriptions, which is where your
    // duplicate "Dialog" and the auto-numbered "Kaushi's Insuarance - 1" came from.
    //
    // We now prefer the BRAND WE ACTUALLY MATCHED — it is clean by construction.
    function _subName(raw, cat, matched) {
        // The ISOLATED entity is the merchant's real name with the bank's debris removed —
        // "Pos Transaction Allianz Life Insurance Colombo 03" -> "Allianz Life Insurance".
        // Prefer it over the matched keyword, which is often a generic industry token
        // ("insurance") rather than the brand.
        var iso = isolate(raw);
        if (iso && iso.length >= 3) return _title(iso);
        if (matched) {
            var k = String(matched).replace(/^[a-z]+:/, '').trim();
            if (k && k.length >= 3 && !/^\d+$/.test(k)) return _title(k);
        }
        var mk = merchantKey(raw);
        if (mk && mk.length >= 3 && !/^\d+$/.test(mk)) return _title(mk);
        return cat || 'Subscription';
    }

    // A clean, stable display name for ANY merchant — used by the import so a subscription
    // can never again be named after the raw bank line.
    function cleanName(raw) {
        var c = classify(raw, 'debit');
        return _subName(raw, c.category, c.matched);
    }

    // ── refine(): plug into the import — improve WFRoute's routing when we're sure
    function refine(desc, direction, routed) {
        var c = classify(desc, direction);
        if (!c.goesTo || c.confidence < 0.85) return null;      // not sure enough → keep WFRoute/AI
        routed = routed || {};
        // never fight a confident CHEQUE or own-account SKIP that WFRoute structurally found,
        // unless we matched a real recurring merchant (sub) — those must be rescued from "skip".
        if ((routed.tab === 'cheque') && c.goesTo !== 'subscription') return null;
        if (routed.tab === 'skip' && c.goesTo !== 'subscription' && c.goesTo !== 'cc_payment' && c.category !== 'Bank Charges') return null;
        if (routed.tab === c.goesTo && (routed.category || '') === (c.category || '') ) return null; // already correct
        return {
            tab: c.goesTo, category: c.category || routed.category || 'Other',
            subName: c.subName || routed.subName || '', subPhone: c.subPhone || routed.subPhone || '',
            ccLast4: c.ccLast4 || '', ccBrand: c.ccBrand || '',
            type: c.type, confidence: c.confidence, reason: 'WFMerchants: ' + c.reason
        };
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  AUTONOMOUS MERCHANT VERIFICATION ENGINE
    //  Stage 1 Isolation · Stage 2 Pattern · Stage 3 Cross-reference · Stage 4 Audit
    //  Nothing below the 0.95 gate is EVER written to the registry.
    // ═══════════════════════════════════════════════════════════════════════════
    var ACTION = { MATCHED: 'MATCHED_AND_VERIFIED', NEW: 'NEW_MERCHANT_DISCOVERED', SEARCH: 'AMBIGUOUS_REQUIRES_SEARCH' };
    var GOES_LABEL = { subscription: 'Subscription', expenses: 'Expenses', income: 'Income', cc_payment: 'Card Payment' };

    // Stage 1 — ISOLATION PASS: strip transaction noise, POS/terminal codes, city
    // suffixes, customer ids and trailing reference numbers → the core entity only.
    var CITIES = /\b(colombo|kandy|kurunegala|kuliyapitiya|kuliyapit|negombo|galle|matara|jaffna|gampaha|nugegoda|dehiwala|moratuwa|maharagama|kalutara|kaluthara|panadura|ratnapura|badulla|anuradhapura|dambulla|homagama|meerigama|mattegoda|wellampitiya|ibbagamuwa|kadawatha|malabe|piliyandala|singapore|london)\b/g;
    function isolate(raw) {
        var t = norm(raw);
        t = stripPrefix(t);
        t = t.replace(/\b(pos|ib|ceft|slips|crm|atm|dcc)\b/g, ' ');
        t = t.replace(/\b\d{4,}\b/g, ' ');            // terminal / customer / reference numbers
        t = t.replace(/\b\d{1,2}\b/g, ' ');           // "colombo 03"
        t = t.replace(CITIES, ' ');
        t = t.replace(/\b(pvt|pv|ltd|lt|plc|limited|private|company|co)\b/g, ' ');
        // the bank's own verbs are not part of anyone's name
        t = t.replace(/\b(charges?|payment|payments|transfer|bill|withdrawal|deposit|debit|credit|outward|inward|transaction|purchase|fee|fees)\b/g, ' ');
        return t.replace(/\s+/g, ' ').trim();
    }

    // Stage 4 — SELF-CORRECTION AUDIT: could this string honestly belong to more than
    // one category? If yes we REFUSE to be confident and demand external verification.
    function ambiguity(nd, gd) {
        var hits = {}, n = 0;
        for (var i = 0; i < REGISTRY.length; i++) {
            var cat = REGISTRY[i][0], kws = REGISTRY[i][1];
            for (var j = 0; j < kws.length; j++) { if (hasKey(nd, gd, kws[j])) { if (!hits[cat]) { hits[cat] = 1; n++; } break; } }
        }
        return n > 1 ? Object.keys(hits) : null;
    }

    // The full four-stage analysis, in the exact contract the system spec defines.
    function analyze(desc, direction) {
        var raw = String(desc || '');
        var nd = norm(raw), gd = glue(raw);
        var name = isolate(raw);
        var c = classify(raw, direction);
        var amb = ambiguity(nd, gd);
        var conf = c.confidence || 0;
        var action;
        if (amb && conf < 1) { conf = Math.min(conf, 0.6); action = ACTION.SEARCH; }
        else if (!c.category) { conf = 0; action = ACTION.SEARCH; }
        else if (/^(learned|remote):/.test(c.matched || '')) action = ACTION.MATCHED;
        else if (conf >= WRITE_GATE) action = ACTION.NEW;
        else action = ACTION.SEARCH;
        return {
            raw_transaction_string: raw,
            isolated_merchant_name: name || '(unresolved)',
            confidence_score: +conf.toFixed(2),
            system_action: action,
            routing: { goes_to: GOES_LABEL[c.goesTo] || null, type: c.category || null },
            logical_justification: amb ? ('Ambiguous — the text also matches ' + amb.join(' / ') + '. Refusing to guess; queued for verification.')
                                       : (c.reason || 'No signal in the text could identify this entity.'),
            _internal: c
        };
    }

    // ── discovery queue: every merchant YOUR statements contain that nothing knows ──
    function _loadQ(k) { try { var a = JSON.parse(root.localStorage.getItem(k) || '[]'); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
    function _saveQ(k, a) { try { root.localStorage.setItem(k, JSON.stringify(a.slice(-300))); } catch (_) {} }
    function discover(desc, direction) {
        try {
            var a = analyze(desc, direction);
            if (a.system_action !== ACTION.SEARCH) return null;
            var key = merchantKey(desc);
            if (!key || key.length < 3 || /^\d+$/.test(key.replace(/\s/g, ''))) return null;
            var q = _loadQ(LS_UNKNOWN);
            if (q.some(function (x) { return x.key === key; })) return null;
            q.push({ key: key, raw: String(desc || '').slice(0, 120), name: a.isolated_merchant_name, at: Date.now() });
            _saveQ(LS_UNKNOWN, q);
            return key;
        } catch (_) { return null; }
    }
    function unknowns() { return _loadQ(LS_UNKNOWN); }
    function pending() { return _loadQ(LS_PENDING); }

    // The prompt MUST contain "Return only JSON" and a {"vendor":...} example: that is
    // exactly what ai.js's wantsJSON regex looks for, and it is what switches the backend
    // from mode=fastest (ONE engine) to mode=consensus (ALL 16 engines, then a field-wise
    // MAJORITY VOTE on vendor/category/destination). Without it we were trusting a single
    // model's guess and calling it consensus.
    var SYS = [
        'You are the WealthFlow Autonomous Merchant Verification Engine for Sri Lanka.',
        'Identify the merchant in a raw bank narration: discard POS/terminal codes, city names and reference numbers.',
        'Deduce the industry from the text. A 10-digit number starting 077/071/070/078/076/075/074/072 is a Sri Lankan mobile -> Telecom.',
        '"Life"/"Insurance"/"Assurance" -> Insurance. CEB/LECO/Water Board -> Utilities. Supermarkets -> Groceries.',
        'If the entity could honestly belong to more than one category, LOWER the confidence. Never invent a merchant.',
        'category must be exactly one of: ' + CATEGORIES.join(', ') + '.',
        'A bank\'s own charge is Bank Charges. Cash drawn against a card is Cash Advance; '
            + 'cash taken from an ATM with your own money is Cash Withdrawal. '
            + 'If none of them honestly fits, answer Other with a LOW confidence rather than '
            + 'forcing the nearest merchant category.',
        'destination must be exactly "subscription" or "expenses".',
        'confidence is 0.00-1.00. Use >= 0.95 ONLY when the merchant is unmistakable. A low score is CORRECT and safe; a confident wrong answer is a system failure.',
        'Return only JSON, no prose and no markdown fences, in exactly this shape:',
        '{"vendor":"...","category":"...","destination":"subscription|expenses","confidence":0.00,"why":"..."}'
    ].join('\n');

    // ── SEARCH-FIRST verification (the primary path) ─────────────────────────
    // Ask /api/verify: it Googles the merchant with a Sri Lanka geo-bias, hands ONLY
    // those results to one fast model, and refuses to answer unless it can cite a URL
    // that really appeared in them. Evidence beats recall — a model cannot invent a
    // shop that does not exist.
    function _verify(item) {
        return fetch(VERIFY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ merchant: item.raw }) })
            .then(function (r) { return r && r.ok ? r.json() : null; })
            .then(function (v) { return { v: v, item: item }; })
            .catch(function () { return { v: null, item: item }; });
    }

    // ── 16-engine consensus (the fallback, when search finds nothing) ────────
    function _askOne(item) {
        var body = { prompt: SYS + '\n\nNarration: "' + String(item.raw).replace(/"/g, "'") + '"', mode: 'consensus', temperature: 0, maxTokens: 400 };
        return fetch(AI_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
            .then(function (r) { return r && r.ok ? r.json() : null; })
            .then(function (j) {
                if (!j) return { entry: null, engines: 0, item: item };
                var m = String(j.reply || '').match(/\{[\s\S]*\}/);
                if (!m) return { entry: null, engines: 0, item: item };
                var e = null; try { e = JSON.parse(m[0]); } catch (_) { return { entry: null, engines: 0, item: item }; }
                return { entry: e, engines: +(j.consensusOf || 1), item: item };
            })
            .catch(function () { return { entry: null, engines: 0, item: item }; });
    }

    // Resolve every merchant YOUR statements contain that nothing could identify.
    //   1. SEARCH-FIRST  — /api/verify must find the business AND cite a real URL.
    //   2. FALLBACK      — if search finds nothing, fall back to the 16-engine consensus.
    //   3. HOLD          — if neither clears 0.95, nothing is written. It waits for you,
    //                      with the reason and the evidence links attached.
    function resolveUnknowns(limit) {
        try {
            if (typeof fetch !== 'function') return Promise.resolve({ resolved: 0, held: 0, note: 'no fetch' });
            var q = _loadQ(LS_UNKNOWN);
            if (!q.length) return Promise.resolve({ resolved: 0, held: 0, note: 'nothing unknown' });
            var batch = q.slice(0, Math.max(1, Math.min(12, limit || 8)));

            return Promise.all(batch.map(_verify)).then(function (vres) {
                var verified = 0, needFallback = [], holdList = _loadQ(LS_PENDING);

                vres.forEach(function (r) {
                    var v = r.v, src = r.item;
                    var cited = v && Array.isArray(v.evidence_urls) && v.evidence_urls.length > 0;
                    if (v && v.exists === true && v.category && VALID_CATS[v.category] && cited && (+v.confidence || 0) >= WRITE_GATE) {
                        learn(src.raw, (v.destination === 'subscription' || SUB_CATS[v.category]) ? 'subscription' : 'expenses', v.category, +v.confidence);
                        verified++;
                        return;
                    }
                    needFallback.push({ item: src, v: v });
                });

                if (!needFallback.length) return { verified: verified, fb: [], holdList: holdList };
                return Promise.all(needFallback.map(function (x) { return _askOne(x.item); })).then(function (fb) {
                    return { verified: verified, fb: fb, holdList: holdList, vmap: needFallback };
                });
            }).then(function (stage) {
                var resolved = stage.verified, held = 0, holdList = stage.holdList;
                (stage.fb || []).forEach(function (r, i) {
                    var src = r.item, e = r.entry;
                    var vprev = (stage.vmap && stage.vmap[i] && stage.vmap[i].v) || null;
                    var cat = e && e.category, conf = e ? (+e.confidence || 0) : 0;
                    var agreed = r.engines >= 2;
                    if (e && cat && VALID_CATS[cat] && agreed && conf >= WRITE_GATE) {
                        learn(src.raw, (e.destination === 'subscription' || SUB_CATS[cat]) ? 'subscription' : 'expenses', cat, conf);
                        resolved++;
                        return;
                    }
                    held++;
                    if (!holdList.some(function (h) { return h.key === src.key; })) {
                        holdList.push({
                            key: src.key, raw: src.raw,
                            merchant: (vprev && vprev.vendor) || (e && e.vendor) || src.name,
                            type: (cat && VALID_CATS[cat]) ? cat : ((vprev && vprev.category) || ''),
                            goesTo: (cat && SUB_CATS[cat]) ? 'subscription' : 'expenses',
                            confidence: +Math.max(conf, (vprev && +vprev.confidence) || 0).toFixed(2),
                            evidence: (vprev && vprev.evidence_urls) || [],
                            industry: (vprev && vprev.industry) || '',
                            why: (e && e.why) || (vprev && vprev.abstain_reason) || '',
                            reason: (vprev && vprev.abstain_reason === 'search_not_configured') ? 'web search is not configured — add SERPER_API_KEY in Vercel'
                                  : (vprev && vprev.abstain_reason === 'no_search_results') ? 'the web has no record of this merchant'
                                  : (vprev && vprev.abstain_reason === 'no_valid_citation') ? 'the AI could not cite a real source — refused'
                                  : !e ? 'the AI could not read this merchant'
                                  : !agreed ? 'only one engine answered — not a consensus'
                                  : !VALID_CATS[cat] ? 'the category was outside the taxonomy'
                                  : 'below the ' + WRITE_GATE + ' confidence gate',
                            at: Date.now()
                        });
                    }
                });
                _saveQ(LS_PENDING, holdList);
                var keys = {}; batch.forEach(function (x) { keys[x.key] = 1; });
                _saveQ(LS_UNKNOWN, q.filter(function (x) { return !keys[x.key]; }));
                try { root.console && root.console.log('[WFMerchants] verified ' + stage.verified + ' by web search, ' + (resolved - stage.verified) + ' by consensus, ' + held + ' held'); } catch (_) {}
                return { resolved: resolved, verified: stage.verified, held: held, note: 'search-first, gate ' + WRITE_GATE };
            }).catch(function () { return { resolved: 0, held: 0, note: 'verification unreachable' }; });
        } catch (_) { return Promise.resolve({ resolved: 0, held: 0, note: 'error' }); }
    }

    // Accept a held merchant the user confirmed (their word beats any model).
    function confirm(key, category) {
        var hold = _loadQ(LS_PENDING), hit = null;
        hold = hold.filter(function (h) { if (h.key === key) { hit = h; return false; } return true; });
        if (!hit) return false;
        var cat = category || hit.type;
        if (!VALID_CATS[cat]) return false;
        learn(hit.raw, SUB_CATS[cat] ? 'subscription' : 'expenses', cat, 1);
        _saveQ(LS_PENDING, hold);
        return true;
    }

    // ── learning: remember a confirmed mapping so it's instant next time ────────
    //     GATED: nothing below 0.95 is ever written to the registry.
    function learn(desc, tab, category, confidence) {
        try {
            if (!desc || !category) return;
            if (!VALID_CATS[category]) return;                       // never store a category outside the taxonomy
            if (confidence != null && +confidence < WRITE_GATE) return;   // the spec's hard write gate
            var mk = merchantKey(desc); if (!mk || mk.length < 2) return;
            // don't learn pure person-transfers or numeric-only keys
            if (/^\d+$/.test(mk.replace(/\s/g, ''))) return;
            var o = _loadLearned();
            o[mk] = { category: category, tab: tab || (SUB_CATS[category] ? 'subscription' : 'expenses'), n: (o[mk] && o[mk].n || 0) + 1, conf: confidence == null ? 1 : +confidence, ts: Date.now() };
            _saveLearned(o);
        } catch (_) {}
    }

    // ── self-verification: flag a merchant learned into conflicting categories ──
    function verify() {
        var o = _loadLearned(), conflicts = [], seen = {};
        Object.keys(o).forEach(function (k) {
            var cat = o[k] && o[k].category; if (!cat) return;
            // a learned key whose own words strongly match a DIFFERENT seed category
            var reg = _matchRegistry(norm(k), glue(k));
            if (reg && reg.category !== cat && (o[k].n || 0) < 2) { conflicts.push({ key: k, learned: cat, registry: reg.category }); }
            seen[k] = cat;
        });
        // auto-heal: drop low-confidence conflicts so a one-off mistap can't poison future imports
        if (conflicts.length) { conflicts.forEach(function (c) { if ((o[c.key].n || 0) < 2) delete o[c.key]; }); _saveLearned(o); }
        return { ok: conflicts.length === 0, conflicts: conflicts, learnedCount: Object.keys(o).length };
    }

    function stats() { var o = _loadLearned(); var seed = 0; REGISTRY.forEach(function (r) { seed += r[1].length; }); return { version: VERSION, seedKeywords: seed, categories: REGISTRY.length, learned: Object.keys(o).length }; }
    function exportLearned() { return _loadLearned(); }
    // merge an external merchant list  [{key, category, tab}]  (auto-update hook)
    function merge(list) {
        if (!Array.isArray(list)) return 0; var o = _loadLearned(), n = 0;
        list.forEach(function (e) { if (e && e.key && e.category) { var k = norm(e.key); if (!o[k]) { o[k] = { category: e.category, tab: e.tab || (SUB_CATS[e.category] ? 'subscription' : 'expenses'), n: 0, ts: Date.now(), src: 'merge' }; n++; } } });
        _saveLearned(o); return n;
    }

    try { _setRemote(_loadRemoteCache()); } catch (_) {}   // hydrate last verified list immediately
    try { verify(); } catch (_) {}                          // heal any learned conflicts on load
    try { if (typeof fetch === 'function') syncRemote(); } catch (_) {}   // refresh in the background (throttled)
    root.WFMerchants = { classify: classify, refine: refine, analyze: analyze, learn: learn, cleanName: cleanName, GLOBAL_GATE: GLOBAL_GATE, verify: verify, verifyRemote: verifyRemote, syncRemote: syncRemote, discover: discover, resolveUnknowns: resolveUnknowns, unknowns: unknowns, pending: pending, confirm: confirm, isolate: isolate, stats: stats, export: exportLearned, merge: merge, merchantKey: merchantKey, WRITE_GATE: WRITE_GATE, CATEGORIES: CATEGORIES, forgetLearned: _forgetLearned, _clsForget: _clsForget, _clsStats: _clsStats, epoch: epoch, VERSION: VERSION };
    try { root.console && root.console.log('[WFMerchants] ✓ v' + VERSION + ' — ' + stats().seedKeywords + ' merchant signals across ' + REGISTRY.length + ' categories'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
