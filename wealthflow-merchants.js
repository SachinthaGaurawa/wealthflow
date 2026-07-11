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
    var FEE_KWS = ['pos transaction fee', 'transaction fee', 'atm withdrawal fee', 'withdrawal fee', 'ceft charge', 'cefts charge', 'ceft charges', 'slips charge', 'slip charge', 'stamp duty', 'debit tax', 'service charge', 'maintenance fee', 'ledger fee', 'sms active fee', 'sms alert', 'sms charge', 'alert charge', 'active fee', 'fuel surcharge', 'card annual', 'annual fee', 'annual or maintenance', 'card fee', 'card replacement', 'over limit', 'overlimit', 'late fee', 'late payment', 'finance charge', 'interest charge', 'commission', 'processing fee', 'handling fee', 'e statement fee', 'estatement fee', 'statement fee', 'capitalise', 'capitalize', 'fallback fee', 'markup', 'mark up', 'conversion fee', 'cross border', 'reissue', 'pin reissue', 'joining fee', 'membership fee', 'cheque return', 'return fee', 'ledger', 'vat', 'nbt', 'sscl', 'cess', 'government levy', 'govt levy', 'levy', 'debit interest', 'credit interest'];
    // words that make a "fee-looking" line actually a normal payment (avoid false fees)
    function isFee(nd, gd) {
        for (var i = 0; i < FEE_KWS.length; i++) { var k = FEE_KWS[i]; if (nd.indexOf(k) >= 0 || gd.indexOf(k.replace(/ /g, '')) >= 0) return true; }
        return false;
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
    function _loadLearned() { try { return JSON.parse(root.localStorage.getItem(LS_LEARN) || '{}') || {}; } catch (_) { return {}; } }
    function _saveLearned(o) { try { root.localStorage.setItem(LS_LEARN, JSON.stringify(o)); } catch (_) {} }
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
                var k = kws[j]; var kg = glue(k);
                if ((k.indexOf(' ') >= 0 || k.charAt(0) === ' ' || k.charAt(k.length - 1) === ' ') ? (nd.indexOf(k.trim()) >= 0) : (nd.indexOf(k) >= 0 || (kg.length >= 4 && gd.indexOf(kg) >= 0))) {
                    return { category: cat, keyword: k.trim() };
                }
            }
        }
        return null;
    }

    // ── the classifier ─────────────────────────────────────────────────────────
    function classify(desc, direction) {
        var raw = String(desc || '');
        var nd = norm(raw), gd = glue(raw);
        var dir = String(direction || '').toLowerCase();
        var out = { goesTo: null, category: null, type: 'purchase', subName: '', subPhone: '', confidence: 0, matched: '', reason: '' };
        if (!nd) return out;

        // 1) money IN → income (the tab decides; category left to income logic)
        if (dir === 'credit') { out.goesTo = 'income'; out.confidence = 0.6; out.reason = 'credit → income'; return out; }

        // 2) bank fee / levy → Expenses · Bank Charges (wins over merchant words)
        if (isFee(nd, gd) && !/dialog|mobitel|insurance|netflix|spotify/.test(nd)) {
            out.goesTo = 'expenses'; out.category = 'Bank Charges'; out.type = 'service_fee'; out.confidence = 0.95; out.matched = 'fee'; out.reason = 'bank charge/levy → Bank Charges'; return out;
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
                out.goesTo = 'subscription'; out.subName = _subName(raw, reg.category); out.subPhone = ph || '';
                out.reason = reg.category + ' → Subscriptions (recurring)';
            } else {
                out.goesTo = 'expenses';
                out.type = reg.category === 'Fuel' ? 'fuel' : 'purchase';
                out.reason = reg.category + ' → Expenses';
            }
            return out;
        }

        // 6) cash withdrawal (not a fee) → Expenses · Cash Withdrawal
        if (/\b(atm withdrawal|cash withdrawal|cardless cash|crm withdrawal)\b/.test(nd)) {
            out.goesTo = 'expenses'; out.category = 'Cash Withdrawal'; out.confidence = 0.8; out.matched = 'cash'; out.reason = 'cash withdrawal → Expenses'; return out;
        }
        // unknown → let WFRoute / AI consensus decide
        return out;
    }
    function _subName(raw, cat) {
        var brand = merchantKey(raw);
        brand = brand ? brand.replace(/\b\w/g, function (c) { return c.toUpperCase(); }) : '';
        return brand || cat;
    }

    // ── refine(): plug into the import — improve WFRoute's routing when we're sure
    function refine(desc, direction, routed) {
        var c = classify(desc, direction);
        if (!c.goesTo || c.confidence < 0.85) return null;      // not sure enough → keep WFRoute/AI
        routed = routed || {};
        // never fight a confident CHEQUE or own-account SKIP that WFRoute structurally found,
        // unless we matched a real recurring merchant (sub) — those must be rescued from "skip".
        if ((routed.tab === 'cheque') && c.goesTo !== 'subscription') return null;
        if (routed.tab === 'skip' && c.goesTo !== 'subscription' && c.category !== 'Bank Charges') return null;
        if (routed.tab === c.goesTo && (routed.category || '') === (c.category || '') ) return null; // already correct
        return {
            tab: c.goesTo, category: c.category || routed.category || 'Other',
            subName: c.subName || routed.subName || '', subPhone: c.subPhone || routed.subPhone || '',
            type: c.type, confidence: c.confidence, reason: 'WFMerchants: ' + c.reason
        };
    }

    // ── learning: remember a user-confirmed mapping so it's instant next time ───
    function learn(desc, tab, category) {
        try {
            if (!desc || !category) return;
            var mk = merchantKey(desc); if (!mk || mk.length < 2) return;
            // don't learn pure person-transfers or numeric-only keys
            if (/^\d+$/.test(mk.replace(/\s/g, ''))) return;
            var o = _loadLearned();
            o[mk] = { category: category, tab: tab || (SUB_CATS[category] ? 'subscription' : 'expenses'), n: (o[mk] && o[mk].n || 0) + 1, ts: Date.now() };
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

    try { verify(); } catch (_) {}   // heal any conflicts on load
    root.WFMerchants = { classify: classify, refine: refine, learn: learn, verify: verify, stats: stats, export: exportLearned, merge: merge, merchantKey: merchantKey, VERSION: VERSION };
    try { root.console && root.console.log('[WFMerchants] ✓ v' + VERSION + ' — ' + stats().seedKeywords + ' merchant signals across ' + REGISTRY.length + ' categories'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
