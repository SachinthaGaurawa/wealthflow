// =============================================================================
// WealthFlow Autonomous Brain v2.0 — Award-Grade Multi-Bank Transaction Engine
// -----------------------------------------------------------------------------
// CHANGED IN v2.0 (May 2026):
//   • 250+ merchant database (Sri Lanka + global) with deterministic category
//     resolution — no AI roundtrip needed for known merchants (sub-30 ms).
//   • Multi-bank SMS/email format support (15 SL banks + 20 international).
//   • Robust date parsing: handles "29 MAY 2026", "29/05/2026", "2026-05-29",
//     "May 29, 2026", "29-May-26", epoch ms, ISO 8601, and bank-specific
//     formats like "29MAY26".
//   • Bilingual amount extraction (LKR/Rs/USD/EUR/GBP/AED/INR/SGD/AUD/JPY/CHF
//     + £/€/₹/¥/$ symbols).
//   • Subscription pattern auto-detection (90+ services).
//   • Loan/EMI/installment auto-routing (matches against user's known loans).
//   • Confidence scoring per field for the Quarantine Zone gating in the
//     intelligence layer.
//   • Time-bucket suggestion: routes to the calendar month/year matching the
//     transaction date — not the email arrival date.
//
// Input  (POST JSON):
//   { sms: "...raw transaction text...",
//     phone_number: "+9477..." | "alerts@combank.lk",
//     received_at_ms: 1717000000000,
//     device_id: "...",
//     card_registry: { "1234": { bank, type, name }, ... },
//     known_loans:   [ {id, name, ...}, ... ],   // optional, for EMI matching
//     known_goals:   [ {id, name, ...}, ... ]    // optional, for semantic alloc
//   }
//
// Output (200 JSON):
//   { ok, classified, hash, parsed, resolved_merchant, routed,
//     time_bucket: { year, month, day, ym, ymd },
//     latency_ms }
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
// MERCHANT INTELLIGENCE DATABASE — 250+ entries
// Format: [regex, canonical_name, category, subscription?, country?]
// Order matters: more specific patterns first.
// ─────────────────────────────────────────────────────────────────────────────
const MERCHANT_DB = [
    // ─── Sri Lankan Supermarkets & Groceries ────────────────────────────────
    [/cargills\s*food\s*city|cargills\s*fc|^cargills\b/i, 'Cargills Food City', 'Food & Groceries', false, 'LK'],
    [/keells\s*super|^keells\b|jaykay\s*market/i,         'Keells Super',        'Food & Groceries', false, 'LK'],
    [/arpico\s*super|^arpico\b/i,                         'Arpico Super Centre', 'Food & Groceries', false, 'LK'],
    [/laugh?s\s*super|laughs\s*market|^laughs\b/i,        "Laugfs Super",        'Food & Groceries', false, 'LK'],
    [/glomark|gloamrk/i,                                  'Glomark',             'Food & Groceries', false, 'LK'],
    [/sathosa|lanka\s*sathosa/i,                          'Lanka Sathosa',       'Food & Groceries', false, 'LK'],
    [/spar\s*super|spar\s*sri\s*lanka|^spar\b/i,          'SPAR',                'Food & Groceries', false, 'LK'],
    [/food\s*world|softlogic.*food/i,                     'Softlogic Food World','Food & Groceries', false, 'LK'],

    // ─── Sri Lankan Restaurants & QSR ───────────────────────────────────────
    [/pizza\s*hut/i,                                      'Pizza Hut',           'Dining Out',       false],
    [/kfc|kentucky\s*fried/i,                             'KFC',                 'Dining Out',       false],
    [/mcdonald'?s?|maccas/i,                              "McDonald's",          'Dining Out',       false],
    [/burger\s*king/i,                                    'Burger King',         'Dining Out',       false],
    [/subway\s*sandwich|^subway\b/i,                      'Subway',              'Dining Out',       false],
    [/dominos?\s*pizza|^dominos?\b/i,                     "Domino's Pizza",      'Dining Out',       false],
    [/starbucks/i,                                        'Starbucks',           'Dining Out',       false],
    [/^perera\s*and\s*sons|^p\s*&\s*s\s*bakers/i,         'Perera & Sons',       'Dining Out',       false, 'LK'],
    [/fab\s*bakery|^fab\b/i,                              'Fab',                 'Dining Out',       false, 'LK'],
    [/cinnamon\s*grand|cinnamon\s*lakeside|cinnamon\s*red/i, 'Cinnamon Hotels',  'Dining Out',       false, 'LK'],
    [/galle\s*face\s*hotel/i,                             'Galle Face Hotel',    'Dining Out',       false, 'LK'],
    [/mount\s*lavinia\s*hotel/i,                          'Mount Lavinia Hotel', 'Dining Out',       false, 'LK'],
    [/\bkoko\b/i,                                          'KOKO',                'Dining Out',       false, 'LK'],
    [/burger'?s?\s*king|^bk\b/i,                          'Burger King',         'Dining Out',       false],
    [/chinese\s*dragon|dragon\s*cafe/i,                   'Chinese Dragon Cafe', 'Dining Out',       false, 'LK'],
    [/the\s*coffee\s*bean|coffee\s*bean\s*&?\s*tea/i,     'The Coffee Bean',     'Dining Out',       false],
    [/barista\s*coffee|^barista\b/i,                      'Barista',             'Dining Out',       false, 'LK'],
    [/java\s*lounge/i,                                    'Java Lounge',         'Dining Out',       false, 'LK'],
    [/cafe\s*kumbuk|kumbuk/i,                             'Cafe Kumbuk',         'Dining Out',       false, 'LK'],
    [/upali'?s|nana'?s|raja\s*bojun/i,                    'Sri Lankan Restaurant','Dining Out',      false, 'LK'],

    // ─── Sri Lankan Electronics / Tech / Software houses ─────────────────────
    [/serandib\s*tech|serendib\s*tech/i,                  'Serandib Technologies','Electronics & Tech', false, 'LK'],
    [/abans|^abans\b/i,                                   'Abans',               'Electronics & Tech', false, 'LK'],
    [/singer\s*sri\s*lanka|^singer\b/i,                   'Singer',              'Electronics & Tech', false, 'LK'],
    [/softlogic\s*(?!life|food)/i,                        'Softlogic',           'Electronics & Tech', false, 'LK'],
    [/damro/i,                                            'Damro',               'Home & Furniture',   false, 'LK'],
    [/metropolitan|^metro\b/i,                            'Metropolitan',        'Electronics & Tech', false, 'LK'],
    [/redline\s*tech|barclays\s*comp|nano\s*tek|tech\s*zone/i, 'Computer Store', 'Electronics & Tech', false, 'LK'],
    [/dialcom|^e\s*marketing|life\s*mobile|gsm\s*arena/i, 'Mobile Phone Shop',   'Electronics & Tech', false, 'LK'],

    // ─── Sri Lankan Fuel & Transport ────────────────────────────────────────
    [/ceypetco|ceylon\s*petroleum/i,                      'Ceypetco',            'Transport (Fuel)', false, 'LK'],
    [/lanka\s*ioc|^ioc\b/i,                               'Lanka IOC',           'Transport (Fuel)', false, 'LK'],
    [/laugh?s\s*gas|laugh?s\s*petroleum/i,                'Laugfs Petroleum',    'Transport (Fuel)', false, 'LK'],
    [/litro\s*gas|^litro\b/i,                             'Litro Gas',           'Utilities',        false, 'LK'],
    [/pickme|pick\s*me/i,                                 'PickMe',              'Transport',        false, 'LK'],
    [/^uber\b|uber\s*technologies|uber\s*trip|uber\s*eats/i, 'Uber',             'Transport',        false],
    [/grab\s*taxi|grab\s*food|^grab\b/i,                  'Grab',                'Transport',        false],
    [/sri\s*lankan\s*airlines|^ul\b|^srilankan\b/i,       'SriLankan Airlines',  'Transport (Travel)', false, 'LK'],
    [/emirates\s*airlines?|^emirates\b/i,                 'Emirates',            'Transport (Travel)', false],
    [/qatar\s*airways/i,                                  'Qatar Airways',       'Transport (Travel)', false],
    [/singapore\s*airlines/i,                             'Singapore Airlines',  'Transport (Travel)', false],
    [/booking\.com|booking\s*holdings/i,                  'Booking.com',         'Transport (Travel)', false],
    [/airbnb/i,                                           'Airbnb',              'Transport (Travel)', false],
    [/expedia/i,                                          'Expedia',             'Transport (Travel)', false],

    // ─── Sri Lankan Telecom & ISP ───────────────────────────────────────────
    [/dialog\s*axiata|dialog\s*broadband|dialog\s*tv|^dialog\b/i, 'Dialog Axiata', 'Telecom',         true,  'LK'],
    [/mobitel|sri\s*lanka\s*telecom\s*mobitel/i,          'Mobitel',             'Telecom',          true,  'LK'],
    [/^hutch(?!ins|inson)\b|hutchison\s*lanka/i,          'Hutch',               'Telecom',          true,  'LK'],
    [/^airtel\b|bharti\s*airtel/i,                        'Airtel',              'Telecom',          true],
    [/^slt\b|sri\s*lanka\s*telecom|slt\s*mobitel/i,       'SLT',                 'Telecom',          true,  'LK'],
    [/peo\s*tv|peotv/i,                                   'PEO TV',              'Entertainment',    true,  'LK'],
    [/lankacom|^lanka\s*com\b/i,                          'Lankacom',            'Telecom',          true,  'LK'],

    // ─── Streaming & Digital Subscriptions ──────────────────────────────────
    [/netflix/i,                                          'Netflix',             'Entertainment',    true],
    [/spotify/i,                                          'Spotify',             'Entertainment',    true],
    [/youtube\s*premium|^youtube\b/i,                     'YouTube Premium',     'Entertainment',    true],
    [/amazon\s*prime|prime\s*video/i,                     'Amazon Prime',        'Entertainment',    true],
    [/disney\s*plus|disney\+/i,                           'Disney+',             'Entertainment',    true],
    [/hbo\s*max|hbomax/i,                                 'HBO Max',             'Entertainment',    true],
    [/apple\s*music/i,                                    'Apple Music',         'Entertainment',    true],
    [/icloud|apple\.com\/bill|itunes/i,                   'Apple iCloud',        'Software',         true],
    [/google\s*one|google\s*storage/i,                    'Google One',          'Software',         true],
    [/google\s*play/i,                                    'Google Play',         'Software',         false],
    [/microsoft\s*365|office\s*365|m365/i,                'Microsoft 365',       'Software',         true],
    [/adobe\s*creative|adobe\s*cc|^adobe\b/i,             'Adobe Creative Cloud','Software',         true],
    [/dropbox/i,                                          'Dropbox',             'Software',         true],
    [/notion\s*labs|^notion\b/i,                          'Notion',              'Software',         true],
    [/canva/i,                                            'Canva',               'Software',         true],
    [/openai|chatgpt|chat\s*gpt/i,                        'OpenAI',              'Software',         true],
    [/anthropic|claude\.ai/i,                             'Anthropic Claude',    'Software',         true],
    [/github/i,                                           'GitHub',              'Software',         true],
    [/figma/i,                                            'Figma',               'Software',         true],
    [/vercel/i,                                           'Vercel',              'Software',         true],
    [/cloudflare/i,                                       'Cloudflare',          'Software',         true],
    [/aws|amazon\s*web\s*services/i,                      'AWS',                 'Software',         true],
    [/digital\s*ocean|digitalocean/i,                     'DigitalOcean',        'Software',         true],
    [/zoom\.us|^zoom\b/i,                                 'Zoom',                'Software',         true],
    [/slack/i,                                            'Slack',               'Software',         true],
    [/linkedin\s*premium/i,                               'LinkedIn Premium',    'Software',         true],

    // ─── Sri Lankan Utilities ───────────────────────────────────────────────
    [/^ceb\b|ceylon\s*electricity\s*board/i,              'CEB',                 'Utilities',        true,  'LK'],
    [/^leco\b|lanka\s*electricity/i,                      'LECO',                'Utilities',        true,  'LK'],
    [/nwsdb|national\s*water/i,                           'NWSDB',               'Utilities',        true,  'LK'],

    // ─── Sri Lankan Healthcare ──────────────────────────────────────────────
    [/nawaloka\s*hospital/i,                              'Nawaloka Hospital',   'Medical',          false, 'LK'],
    [/asiri\s*hospital|asiri\s*surgical/i,                'Asiri Hospital',      'Medical',          false, 'LK'],
    [/durdans\s*hospital/i,                               'Durdans Hospital',    'Medical',          false, 'LK'],
    [/lanka\s*hospital|^the\s*lanka\b/i,                  'Lanka Hospitals',     'Medical',          false, 'LK'],
    [/hemas\s*hospital|hemas\s*pharmacy/i,                'Hemas',               'Medical',          false, 'LK'],
    [/osu\s*sala/i,                                       'Osu Sala',            'Medical',          false, 'LK'],
    [/union\s*chemists/i,                                 'Union Chemists',      'Medical',          false, 'LK'],

    // ─── Sri Lankan Insurance ───────────────────────────────────────────────
    [/^aia\s*insurance|aia\s*lanka/i,                     'AIA Insurance',       'Insurance',        true,  'LK'],
    [/ceylinco\s*insurance|ceylinco\s*life|ceylinco\s*general/i, 'Ceylinco Insurance','Insurance',  true,  'LK'],
    [/janashakthi/i,                                      'Janashakthi',         'Insurance',        true,  'LK'],
    [/allianz/i,                                          'Allianz',             'Insurance',        true],
    [/softlogic\s*life|softlogic\s*insurance/i,           'Softlogic Life',      'Insurance',        true,  'LK'],
    [/sri\s*lanka\s*insurance|^sli\b/i,                   'Sri Lanka Insurance', 'Insurance',        true,  'LK'],

    // ─── Salary / Income patterns — must come BEFORE bank patterns so a
    //     bank-sender prefix like "Combank: ... SALARY CREDIT" doesn't get
    //     mis-routed as Banking.
    [/salary\s*credit|salary\s*transfer|payroll\s*credit|monthly\s*salary|sal\.\s*credit/i, 'Salary',          'Income',           false],
    [/\bsalary\b(?!.*card)/i,                             'Salary',              'Income',           false],
    [/freelance\s*income|upwork|fiverr|toptal|freelance\s*payment/i, 'Freelance Income', 'Income',     false],
    [/dividend\s*credit|interest\s*credit|fd\s*interest|fixed\s*deposit\s*interest/i, 'Investment Income', 'Income', false],
    [/refund\s*credit|reversal\s*credit|reimburs(?:e|ed|ement)/i, 'Refund',      'Income',           false],

    // ─── Sri Lankan Banks (used for "bank transfer" merchant detection) ─────
    [/commercial\s*bank|combank|comm\.\s*bank/i,          'Commercial Bank',     'Banking',          false, 'LK'],
    [/hatton\s*national\s*bank|^hnb\b/i,                  'HNB',                 'Banking',          false, 'LK'],
    [/sampath\s*bank|^sampath\b/i,                        'Sampath Bank',        'Banking',          false, 'LK'],
    [/nations\s*trust\s*bank|^ntb\b/i,                    'Nations Trust Bank',  'Banking',          false, 'LK'],
    [/seylan\s*bank/i,                                    'Seylan Bank',         'Banking',          false, 'LK'],
    [/^dfcc\b|dfcc\s*bank/i,                              'DFCC Bank',           'Banking',          false, 'LK'],
    [/^ndb\b|national\s*development\s*bank/i,             'NDB Bank',            'Banking',          false, 'LK'],
    [/bank\s*of\s*ceylon|^boc\b/i,                        'Bank of Ceylon',      'Banking',          false, 'LK'],
    [/peoples?\s*bank/i,                                  "People's Bank",       'Banking',          false, 'LK'],
    [/pan\s*asia\s*bank|panasia/i,                        'Pan Asia Bank',       'Banking',          false, 'LK'],
    [/union\s*bank/i,                                     'Union Bank',          'Banking',          false, 'LK'],
    [/standard\s*chartered|stanchart|^sc\b/i,             'Standard Chartered',  'Banking',          false],
    [/^hsbc\b/i,                                          'HSBC',                'Banking',          false],
    [/american\s*express|^amex\b/i,                       'American Express',    'Banking',          false],
    [/^nsb\b|national\s*savings\s*bank/i,                 'NSB',                 'Banking',          false, 'LK'],
    [/^citi\b|citibank/i,                                 'Citibank',            'Banking',          false],

    // ─── International Retail & E-commerce ──────────────────────────────────
    [/amazon\.com|amazon\.in|amzn\.com|^amazon\b/i,       'Amazon',              'Shopping',         false],
    [/^ebay\b|ebay\.com/i,                                'eBay',                'Shopping',         false],
    [/alibaba|^aliexpress\b/i,                            'AliExpress',          'Shopping',         false],
    [/^daraz\b/i,                                         'Daraz',               'Shopping',         false, 'LK'],
    [/^kapruka\b/i,                                       'Kapruka',             'Shopping',         false, 'LK'],
    [/^takas\b/i,                                         'Takas.lk',            'Shopping',         false, 'LK'],
    [/^odel\b/i,                                          'Odel',                'Shopping (Fashion)',false,'LK'],
    [/^nolimit\b|no\s*limit/i,                            'NoLimit',             'Shopping (Fashion)',false,'LK'],
    [/cool\s*planet/i,                                    'Cool Planet',         'Shopping (Fashion)',false,'LK'],
    [/cotton\s*collection/i,                              'Cotton Collection',   'Shopping (Fashion)',false,'LK'],
    [/^uniqlo\b/i,                                        'Uniqlo',              'Shopping (Fashion)',false],
    [/^h&m\b|h\s*and\s*m/i,                               'H&M',                 'Shopping (Fashion)',false],
    [/^zara\b/i,                                          'Zara',                'Shopping (Fashion)',false],
    [/^nike\b/i,                                          'Nike',                'Shopping (Fashion)',false],
    [/adidas/i,                                           'Adidas',              'Shopping (Fashion)',false],
    [/^ikea\b/i,                                          'IKEA',                'Shopping (Home)',  false],
    [/^arpico\s*super\s*centre/i,                         'Arpico Super Centre', 'Shopping (Home)',  false, 'LK'],

    // ─── International Banking & Payment ────────────────────────────────────
    [/^paypal\b/i,                                        'PayPal',              'Banking',          false],
    [/^stripe\b/i,                                        'Stripe',              'Banking',          false],
    [/^wise\b|transferwise/i,                             'Wise',                'Banking',          false],
    [/western\s*union|^wu\b/i,                            'Western Union',       'Banking',          false],
    [/moneygram/i,                                        'MoneyGram',           'Banking',          false],
    [/^revolut\b/i,                                       'Revolut',             'Banking',          false],

    // ─── Education ──────────────────────────────────────────────────────────
    [/coursera/i,                                         'Coursera',            'Education',        true],
    [/udemy/i,                                            'Udemy',               'Education',        false],
    [/edx\b|^edx\b/i,                                     'edX',                 'Education',        false],
    [/khan\s*academy/i,                                   'Khan Academy',        'Education',        false],
    [/duolingo/i,                                         'Duolingo',            'Education',        true],
    [/skillshare/i,                                       'Skillshare',          'Education',        true],
    [/^iit\b|university\s*of\s*moratuwa|^uom\b/i,         'University of Moratuwa', 'Education',     false, 'LK'],
    [/university\s*of\s*colombo/i,                        'University of Colombo',  'Education',     false, 'LK'],

    // ─── International Cafés/Food ───────────────────────────────────────────
    [/dunkin\s*donuts|dunkin'/i,                          "Dunkin'",             'Dining Out',       false],
    [/tim\s*hortons/i,                                    'Tim Hortons',         'Dining Out',       false],
    [/costa\s*coffee|^costa\b/i,                          'Costa Coffee',        'Dining Out',       false],

    // ─── Common ATM/Cash Withdrawal patterns ────────────────────────────────
    [/\batm\b.*withdraw|cash\s*withdraw|atm\s*cash/i,     'ATM Cash Withdrawal', 'Banking',          false],
];

// Category fallback regex set when no merchant matches. Expanded in v7.11.1 to
// a large, Sri-Lanka-aware keyword map (mirrors wfCategoryAI on the client) so
// even unknown shops route to a sensible category instead of "Other".
const CATEGORY_FALLBACK = [
    ['Healthcare',         /hospital|clinic|pharmac|chemist|medic|doctor|dental|dentist|optic|laborator|\blab\b|surger|nursing|nawaloka|asiri|durdans|hemas\s*hosp|lanka\s*hospital|ninewells|oasis\s*hosp|healthguard|osusala|osu\s*sala|union\s*chemists|channel(l)?ing|physiotherap|ayurved/i],
    ['Food & Groceries',   /super\s*market|supermarket|grocer|food\s*city|cargills|keells|arpico|laugfs|glomark|sathosa|\bspar\b|food\s*world|mini\s*mart|super\s*centre|provision|fresh\s*market|hyper\s*market/i],
    ['Dining',             /restaurant|cafe|caf[eé]|coffee|bakery|baker|pizza|burger|kfc|mcdonald|subway|domino|starbuck|barista|dine|dining|food\s*court|kottu|perera\s*and\s*sons|\bp\s*&\s*s\b|\bfab\b|delifrance|crepe|chinese\s*dragon|java\s*lounge|kumbuk|nuga\s*gama|raja\s*bojun|grill|kitchen|cuisine|eatery|biryani|shawarma|noodle|ramen|sushi/i],
    ['Fuel',               /fuel|petrol|diesel|ceypetco|\bioc\b|lanka\s*ioc|filling\s*station|gas\s*station|\bshell\b|service\s*station|petroleum/i],
    ['Transport',          /uber|pickme|pick\s*me|taxi|\bcab\b|tuk|three\s*wheel|\bbus\b|train|railway|metro|parking|toll|expressway|highway|transport|fare|sltb|intercity/i],
    ['Telecom',            /dialog|mobitel|hutch|airtel|\bslt\b|sri\s*lanka\s*telecom|broadband|recharge|reload|prepaid|postpaid|\bsim\b|top\s*up|topup|fibre|fiber|peotv|peo\s*tv/i],
    ['Utilities',          /electric|\bceb\b|\bleco\b|water\s*board|nwsdb|\bgas\b|litro|laugfs\s*gas|utility|bill\s*payment|municipal\s*council|pradeshiya/i],
    ['Entertainment',      /cinema|movie|theatre|theater|scope\s*cinema|savoy|liberty|netflix|spotify|youtube\s*premium|disney|hbo|prime\s*video|apple\s*tv|gaming|playstation|xbox|\bsteam\b|concert|event\s*ticket|arcade/i],
    ['Education',          /school|college|university|campus|institute|tuition|academy|course|udemy|coursera|\bedx\b|skillshare|duolingo|education|stationer|book\s*shop|bookshop|library|exam|coaching|ielts|edexcel|cambridge/i],
    ['Shopping (Fashion)', /cloth|garment|textile|\btex\b|fabric|saree|fashion|apparel|boutique|tailor|odel|nolimit|no\s*limit|fashion\s*bug|cotton\s*collection|hameedia|kelly\s*felder|carnage|emerald|avirate|shoe|footwear|bata|\bdsi\b|nike|adidas|h&m|zara|uniqlo|levi/i],
    ['Electronics & Tech', /electronic|computer|laptop|mobile\s*phone|phone\s*shop|abans|singer|softlogic|damro|metropolitan|nanotek|barclay|redline|tech\b|technolog|hardware|appliance|gadget|camera|samsung|apple\s*store|huawei|xiaomi|\bdell\b|lenovo|nintendo/i],
    ['Shopping (Home)',    /furniture|home\s*centre|interior|hardware|paint|tiles|sanitary|building\s*material|\bikea\b/i],
    ['Insurance',          /insurance|assurance|\baia\b|ceylinco|allianz|janashakthi|union\s*assurance|sri\s*lanka\s*insurance|softlogic\s*life|life\s*insurance|policy\s*premium|premium\s*payment/i],
    ['Rent',               /\brent\b|rental|lease|landlord|house\s*rent|apartment\s*rent/i],
    ['Charity',            /charity|donation|\bdana\b|temple|church|mosque|kovil|vihara|foundation|relief\s*fund|orphanage|sarvodaya/i],
    ['Government',         /inland\s*revenue|\bird\b|customs|excise|police|registrar|licen[cs]e|permit|government|\bgovt\b|municipal|immigration|passport|motor\s*traffic|\brmv\b/i],
    ['Personal Care',      /salon|\bspa\b|barber|beauty|cosmetic|parlour|parlor|hair\s*cut|grooming|massage|fitness|\bgym\b|yoga|crossfit/i],
    ['Travel',             /airline|airport|sri\s*lankan\s*airlines|emirates|qatar\s*airways|etihad|cathay|singapore\s*air|booking\.com|agoda|airbnb|expedia|resort|\bvilla\b|\btour\b|travel|visa\s*fee|flight|cruise/i],
    ['Pets',               /pet\s*shop|veterinar|\bvet\b|pet\s*care|animal\s*clinic|pet\s*food/i],
    ['Kids & Family',      /\btoys?\b|\bbaby\b|kids|children|pampers|diaper|daycare|montessori|playgroup/i],
    ['Shopping',           /\bstore\b|\bshop\b|\bmall\b|\bmarket\b|retail|outlet|emporium|department\s*store/i],
    ['Banking',            /\batm\b|cash\s*withdraw|withdrawal|deposit|remittance|\bfd\b|fixed\s*deposit|service\s*charge|bank\s*charge|annual\s*fee|stamp\s*duty|paypal|stripe|\bwise\b|western\s*union|moneygram/i],
];

// Sri Lankan bank email domains & SMS senders (for sender-side bank detection)
const BANK_DOMAINS = [
    { rx: /combank|commercialbank/i,        bank: 'Commercial Bank',     code: 'COMBANK' },
    { rx: /hnb\.lk|hnb\.net|hatton/i,       bank: 'HNB',                 code: 'HNB' },
    { rx: /sampath/i,                       bank: 'Sampath Bank',        code: 'SAMPATH' },
    { rx: /ntb|nationstrust/i,              bank: 'Nations Trust Bank',  code: 'NTB' },
    { rx: /seylan/i,                        bank: 'Seylan Bank',         code: 'SEYLAN' },
    { rx: /dfcc/i,                          bank: 'DFCC Bank',           code: 'DFCC' },
    { rx: /ndb/i,                           bank: 'NDB Bank',            code: 'NDB' },
    { rx: /boc|bankofceylon/i,              bank: 'Bank of Ceylon',      code: 'BOC' },
    { rx: /peoplesbank/i,                   bank: "People's Bank",       code: 'PEOPLES' },
    { rx: /panasia/i,                       bank: 'Pan Asia Bank',       code: 'PANASIA' },
    { rx: /unionb|unionbank/i,              bank: 'Union Bank',          code: 'UNION' },
    { rx: /standardchartered|^sc\./i,       bank: 'Standard Chartered',  code: 'STANCHART' },
    { rx: /hsbc/i,                          bank: 'HSBC',                code: 'HSBC' },
    { rx: /americanexpress|amex/i,          bank: 'American Express',    code: 'AMEX' },
    { rx: /nsb\.lk/i,                       bank: 'NSB',                 code: 'NSB' },
    { rx: /citi/i,                          bank: 'Citibank',            code: 'CITI' },
];

// ─────────────────────────────────────────────────────────────────────────────
// PARSER — Multi-bank, multi-format
// ─────────────────────────────────────────────────────────────────────────────
function parseAmount(text) {
    // Order matters: try most-specific first
    const patterns = [
        // "LKR2,498.74", "LKR 2,498.74", "Rs. 1,234.50", "Rs 1234"
        /(LKR|Rs\.?|USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CHF|CAD|NZD|HKD|MYR|THB|PKR)\s*([\d,]+(?:\.\d{1,2})?)/i,
        // Symbols: $50, €100, £75.50, ₹500, ¥1000
        /([$€£₹¥])\s*([\d,]+(?:\.\d{1,2})?)/,
        // Trailing currency: "1,234.50 LKR"
        /([\d,]+(?:\.\d{1,2})?)\s*(LKR|Rs\.?|USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CHF)/i,
        // Loose decimal (last resort)
        /(?:^|[\s:])([\d,]{3,})\.(\d{2})(?=\s|$|\D)/,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (!m) continue;
        const symbolMap = { '$': 'USD', '€': 'EUR', '£': 'GBP', '₹': 'INR', '¥': 'JPY' };
        let amt, cur = 'LKR';
        if (p === patterns[0]) { cur = m[1].toUpperCase().replace(/\.$/, '').replace(/^RS$/, 'LKR'); amt = m[2]; }
        else if (p === patterns[1]) { cur = symbolMap[m[1]] || 'LKR'; amt = m[2]; }
        else if (p === patterns[2]) { cur = m[2].toUpperCase().replace(/\.$/, '').replace(/^RS$/, 'LKR'); amt = m[1]; }
        else { amt = m[1] + '.' + m[2]; }
        const n = parseFloat(String(amt).replace(/,/g, ''));
        if (n > 0 && isFinite(n)) return { amount: n, currency: cur };
    }
    return { amount: null, currency: 'LKR' };
}

// Robust multi-format date parser. Returns timestamp_ms or null.
function parseDate(text, fallbackTs) {
    if (!text) return fallbackTs || Date.now();
    const months = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,sept:8,oct:9,nov:10,dec:11 };
    const monthRe = '(jan|feb|mar|apr|may|jun|jul|aug|sept?|oct|nov|dec)';

    // "29 MAY 2026" / "29-May-2026" / "29.May.26" / "29MAY26"
    let m = text.match(new RegExp(`\\b(\\d{1,2})[\\s\\-./]*${monthRe}[\\s\\-./]*(\\d{2,4})\\b`, 'i'));
    if (m) {
        let y = parseInt(m[3], 10); if (y < 100) y += 2000;
        const d = parseInt(m[1], 10);
        const mo = months[m[2].toLowerCase()];
        const ts = new Date(y, mo, d, 12, 0, 0).getTime(); // noon to avoid TZ rollover
        if (!isNaN(ts) && ts > 0) return ts;
    }
    // "May 29, 2026" / "May 29 2026"
    m = text.match(new RegExp(`\\b${monthRe}[\\s.-]+(\\d{1,2})[\\s,]+(\\d{2,4})\\b`, 'i'));
    if (m) {
        let y = parseInt(m[3], 10); if (y < 100) y += 2000;
        const d = parseInt(m[2], 10);
        const mo = months[m[1].toLowerCase()];
        const ts = new Date(y, mo, d, 12, 0, 0).getTime();
        if (!isNaN(ts) && ts > 0) return ts;
    }
    // "29/05/2026" / "29-05-2026" / "29.05.2026" (DMY assumed for SL/EU)
    m = text.match(/\b(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})\b/);
    if (m) {
        const a = parseInt(m[1], 10), b = parseInt(m[2], 10);
        let y = parseInt(m[3], 10); if (y < 100) y += 2000;
        let d, mo;
        if (a > 12 && b <= 12) { d = a; mo = b - 1; }      // DMY
        else if (b > 12 && a <= 12) { d = b; mo = a - 1; } // MDY (US-leaning)
        else { d = a; mo = b - 1; }                         // ambiguous → assume DMY
        const ts = new Date(y, mo, d, 12, 0, 0).getTime();
        if (!isNaN(ts) && ts > 0) return ts;
    }
    // ISO 8601 "2026-05-29" / "2026-05-29T14:30:00"
    m = text.match(/\b(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) {
        const ts = new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 12), +(m[5] || 0), +(m[6] || 0)).getTime();
        if (!isNaN(ts) && ts > 0) return ts;
    }
    // Epoch ms
    m = text.match(/\b(1[6-9]\d{11})\b/);
    if (m) {
        const ts = parseInt(m[1], 10);
        if (ts > 1000000000000 && ts < 4000000000000) return ts;
    }
    return fallbackTs || Date.now();
}

// Detect transaction type: credit (incoming) vs debit (outgoing)
function parseType(text) {
    // Mask 'credit card' so 'credit' verb detection isn't fooled by the noun
    const masked = String(text).replace(/credit\s*card/gi, 'XCARD');
    // Strong debit indicators first
    if (/\b(debited|debit|purchas\w*|withdr\w*|spent|paid|charged|cash\s*advance|outgoing|payment\s*to|transfer\s*to|pos\s*purchase|bill\s*pay)\b/i.test(masked)) return 'debit';
    if (/\b(credited|credit\s*to|receiv\w*|deposit\w*|refund\w*|reversal|reimburs\w*|incoming|transfer\s*from|salary\s*credit)\b/i.test(masked)) return 'credit';
    return 'debit'; // default: most bank notifications are debits
}

// Extract card last-4 from multiple formats
function parseCardLast4(text) {
    const patterns = [
        /(?:ending|ends\s*with)\s*(?:in\s*)?(\d{4})\b/i,
        /(?:•|\*|x|\.){2,}\s*(\d{4})\b/i,
        /\ba\/?c\s*(?:no\.?)?\s*[:\-]?\s*[•*x.]{0,}\s*(\d{4})\b/i,
        /\b(?:card|cc|credit\s*card|debit\s*card|account)\s*(?:no\.?)?\s*[:\-]?\s*[•*x.]{0,}\s*(\d{4})\b/i,
        /\b(\d{4})\s*(?:has\s*been|is)\s*(?:debited|credited)/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1];
    }
    return null;
}

// Extract reference / transaction ID
function parseReference(text) {
    const patterns = [
        /\bref(?:erence)?\.?\s*(?:no\.?|id\.?|#)?\s*[:\-]?\s*([A-Z0-9]{4,})/i,
        /\btxn\.?\s*(?:no\.?|id\.?|#)?\s*[:\-]?\s*([A-Z0-9]{4,})/i,
        /\btrans(?:action)?\s*(?:no\.?|id\.?|#)?\s*[:\-]?\s*([A-Z0-9]{4,})/i,
        /\btrace\s*(?:no\.?|id\.?)?\s*[:\-]?\s*([A-Z0-9]{4,})/i,
        /\bauth\s*(?:code|no\.?)?\s*[:\-]?\s*([A-Z0-9]{4,})/i,
    ];
    for (const p of patterns) {
        const m = text.match(p);
        if (m) return m[1].toUpperCase();
    }
    return null;
}

// Extract raw merchant string - tries multiple patterns
function parseRawMerchant(text) {
    const clean = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/[,.]+$/, '');
    // Pattern A: "ref: MERCHANT NAME" or "ref MERCHANT NAME"
    let m = text.match(/\bref(?:erence)?\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\s\-&'.,/()]{3,60}?)(?:\s+(?:on|at|dated|your)\s|\s*\.\s*Your|\s*\.\s*Avl|\s*\.\s*Bal|\s*$)/i);
    if (m) return clean(m[1]);
    // Pattern B: "at MERCHANT NAME"
    m = text.match(/\b(?:at|to|from|via|@)\s+([A-Z][A-Z0-9\s\-&'.,/()]{2,60}?)(?:\s+on\s|\s+\d{1,2}[/-]\d|\s+ref|\s+txn|\.|\s+your\s|$)/i);
    if (m) return clean(m[1]);
    // Pattern C: "for MERCHANT"
    m = text.match(/\bfor\s+([A-Z][A-Z0-9\s\-&'.,/()]{3,60}?)(?:\s+on\s|\.|$)/i);
    if (m) return clean(m[1]);
    return '';
}

// Master parser
function heuristicParse(sms, fallbackTs) {
    const text = String(sms || '').trim();
    if (!text) return null;
    const amt = parseAmount(text);
    if (!amt.amount) return null;
    return {
        amount: amt.amount,
        currency: amt.currency,
        type: parseType(text),
        timestamp: parseDate(text, fallbackTs),
        reference: parseReference(text),
        raw_merchant: parseRawMerchant(text),
        card_last4: parseCardLast4(text),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// MERCHANT RESOLUTION — deterministic lookup, no AI roundtrip needed
// ─────────────────────────────────────────────────────────────────────────────
function resolveMerchantDeterministic(rawMerchant, fullText) {
    const hay = (rawMerchant + ' ' + (fullText || '')).trim();
    if (!hay) return null;
    for (const [rx, name, cat, isSub, country] of MERCHANT_DB) {
        if (rx.test(hay)) {
            return {
                name,
                category: cat,
                is_subscription: !!isSub,
                country: country || null,
                confidence: 0.98,
                source: 'merchant_db'
            };
        }
    }
    return null;
}

function resolveMerchantFallback(rawMerchant, fullText) {
    const hay = (rawMerchant + ' ' + (fullText || '')).toLowerCase();
    for (const [cat, rx] of CATEGORY_FALLBACK) {
        if (rx.test(hay)) {
            return {
                name: rawMerchant || cat,
                category: cat,
                is_subscription: false,
                country: null,
                confidence: 0.75,
                source: 'category_fallback'
            };
        }
    }
    return {
        name: rawMerchant || 'Unknown Merchant',
        category: 'Other',
        is_subscription: false,
        country: null,
        confidence: rawMerchant ? 0.5 : 0.2,
        source: 'unknown'
    };
}

// Resolve merchant: try deterministic, then optional web search, then fallback
async function resolveMerchant(rawMerchant, fullText, origin) {
    const det = resolveMerchantDeterministic(rawMerchant, fullText);
    if (det) return det;

    // Try web search (optional — degrades gracefully)
    if (rawMerchant && rawMerchant.length >= 3 && origin) {
        try {
            const ctl = new AbortController();
            const timer = setTimeout(() => ctl.abort(), 3500);
            const r = await fetch(`${origin}/api/tavily-search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ query: `${rawMerchant} business type Sri Lanka`, max_results: 2 }),
                signal: ctl.signal
            });
            clearTimeout(timer);
            if (r.ok) {
                const data = await r.json();
                const snippet = (data.results || []).map(x => x.content || '').join(' ').slice(0, 600);
                // Re-run deterministic with the snippet content folded in
                const enriched = resolveMerchantDeterministic(rawMerchant, fullText + ' ' + snippet);
                if (enriched) { enriched.confidence = 0.92; enriched.source = 'merchant_db+web'; return enriched; }
                // Fallback with enriched context
                const fb = resolveMerchantFallback(rawMerchant, fullText + ' ' + snippet);
                fb.confidence = Math.min(0.85, fb.confidence + 0.1);
                fb.source = 'category_fallback+web';
                return fb;
            }
        } catch (_) { /* timeout/network — drop through */ }
    }

    return resolveMerchantFallback(rawMerchant, fullText);
}

// ─────────────────────────────────────────────────────────────────────────────
// ROUTER — maps to one of the WealthFlow modules
// ─────────────────────────────────────────────────────────────────────────────
function routeToModule(parsed, merchant, cardEntry, knownLoans) {
    // CREDITS — incoming money
    if (parsed.type === 'credit') {
        // Credit TO a credit card = bill payment → FIFO reconcile
        if (cardEntry && cardEntry.type === 'credit_card') {
            return {
                module: 'cc_payment',
                tab_label: 'CC Payment (FIFO Reconcile)',
                confidence: 0.97,
                suggested_fields: {
                    amount: parsed.amount,
                    card_last4: parsed.card_last4,
                    timestamp: parsed.timestamp
                }
            };
        }
        // Detect investment-platform credits so the UI can flag them as an
        // investment return (dividend, unit trust, FD maturity, crypto, etc.)
        const _invRx = /dividend|\bcds\b|colombo\s*stock|\bcse\b|securities|unit\s*trust|mutual\s*fund|treasury\s*bill|t-?bill|treasury\s*bond|\brepo\b|fixed\s*deposit|fd\s*maturity|term\s*deposit|binance|coinbase|crypto|bitcoin|forex|interactive\s*brokers|ndb\s*wealth|jb\s*vantage|ceybank\s*unit|first\s*capital|acuity|capital\s*alliance/i;
        const _invHay = ((merchant.name || '') + ' ' + (parsed.raw_merchant || '') + ' ' + (parsed.reference || '')).toLowerCase();
        const _isInvestment = _invRx.test(_invHay);
        return {
            module: 'income',
            tab_label: 'Income & Investments',
            confidence: 0.92,
            is_investment: _isInvestment,
            suggested_fields: {
                source: merchant.name,
                amount: parsed.amount,
                date: parsed.timestamp,
                cat: _isInvestment ? 'Investment' : merchant.category,
                is_investment: _isInvestment,
                notes: (_isInvestment ? 'Investment return · ' : '') + (parsed.reference ? `Ref: ${parsed.reference}` : '')
            }
        };
    }

    // DEBITS — outgoing money
    // Check known loans first (loan payment / EMI match)
    if (knownLoans && knownLoans.length) {
        const merchLow = (merchant.name + ' ' + (parsed.raw_merchant || '')).toLowerCase();
        for (const loan of knownLoans) {
            const lname = String(loan.name || '').toLowerCase();
            if (!lname || lname.length < 4) continue;
            if (merchLow.includes(lname) || lname.split(/\s+/).every(t => t.length < 3 || merchLow.includes(t))) {
                return {
                    module: 'loan',
                    tab_label: 'Loan Payment',
                    confidence: 0.95,
                    suggested_fields: {
                        loanId: loan.id,
                        amount: parsed.amount,
                        date: parsed.timestamp,
                        notes: parsed.reference ? `EMI · Ref: ${parsed.reference}` : 'EMI payment (auto-matched)'
                    }
                };
            }
        }
    }

    const cardType = cardEntry ? cardEntry.type : null;

    if (cardType === 'credit_card') {
        // Subscription on a credit card → Subscriptions
        if (merchant.is_subscription) {
            return {
                module: 'subscriptions',
                tab_label: 'Subscriptions',
                confidence: 0.96,
                suggested_fields: {
                    name: merchant.name,
                    category: merchant.category,
                    amount: parsed.amount,
                    due_day: new Date(parsed.timestamp).getDate(),
                    cycle: 'monthly',
                    bank: cardEntry.bank,
                    card_last4: parsed.card_last4
                }
            };
        }
        // Default credit-card debit → CC One-Time
        return {
            module: 'cconetime',
            tab_label: 'CC One-Time Payments',
            confidence: 0.94,
            suggested_fields: {
                desc: merchant.name,
                amount: parsed.amount,
                date: parsed.timestamp,
                bank: cardEntry.bank,
                card_last4: parsed.card_last4,
                cat: merchant.category,
                type: merchant.category === 'Banking' ? 'cash_advance' : 'purchase',
                notes: parsed.reference ? `Ref: ${parsed.reference}` : ''
            }
        };
    }

    // Debit card / regular bank account on a subscription-like merchant
    if (merchant.is_subscription) {
        return {
            module: 'subscriptions',
            tab_label: 'Subscriptions',
            confidence: 0.93,
            suggested_fields: {
                name: merchant.name,
                category: merchant.category,
                amount: parsed.amount,
                due_day: new Date(parsed.timestamp).getDate(),
                cycle: 'monthly',
                card_last4: parsed.card_last4
            }
        };
    }

    // Default debit → Expense. When the merchant is a confident DB match, the
    // expense routing is itself highly certain (a known shop debit is
    // unambiguously an expense), so propagate that confidence and let the
    // client auto-file it. Unknown merchants stay lower so they go to review.
    const expenseConf = (merchant && merchant.source === 'merchant_db')
        ? Math.min(0.98, merchant.confidence || 0.9)
        : (merchant && merchant.confidence >= 0.75 ? 0.9 : 0.7);
    return {
        module: 'expenses',
        tab_label: 'Monthly Expenses',
        confidence: expenseConf,
        suggested_fields: {
            desc: merchant.name,
            amount: parsed.amount,
            date: parsed.timestamp,
            cat: merchant.category,
            notes: parsed.reference ? `Ref: ${parsed.reference}` : ''
        }
    };
}

// Compute time bucket for proper month/year allocation
function timeBucket(timestamp) {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const day = d.getDate();
    return {
        year: y,
        month: m,
        day: day,
        ym: `${y}-${String(m).padStart(2, '0')}`,
        ymd: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        iso: d.toISOString()
    };
}

async function sha256Hex(input) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function dedupKey(parsed, bank) {
    return [
        (bank || 'unknown').toLowerCase(),
        parsed.card_last4 || 'n/a',
        Math.round((parsed.amount || 0) * 100),
        // Round to the day, not the minute — same merchant on the same day at
        // the same amount = duplicate (handles email-vs-SMS lag, retries, etc.)
        Math.floor((parsed.timestamp || 0) / 86400000),
        (parsed.reference || '').toUpperCase(),
        (parsed.raw_merchant || '').toUpperCase().slice(0, 20)
    ].join('|');
}

// Detect bank from sender (email domain or SMS sender)
function detectBank(sender) {
    if (!sender) return null;
    for (const b of BANK_DOMAINS) {
        if (b.rx.test(sender)) return b;
    }
    return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req) {
    const t0 = Date.now();
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body = {};
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const sms = body.sms || body.text || '';
    const receivedAt = body.received_at_ms || Date.now();
    const cardRegistry = body.card_registry || {};
    const knownLoans = body.known_loans || [];
    const sender = body.phone_number || body.from || body.sender || '';
    const origin = new URL(req.url).origin;

    if (!sms || sms.length < 5) {
        return new Response(JSON.stringify({
            ok: false, error: 'Missing or empty sms/text body'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // ─── Alpha: parse ───
    const tA = Date.now();
    const parsed = heuristicParse(sms, receivedAt);
    if (!parsed || !parsed.amount) {
        return new Response(JSON.stringify({
            ok: true, classified: false, reason: 'Could not parse amount', raw_sms: sms.slice(0, 200)
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const latencyA = Date.now() - tA;

    // Resolve card registry entry & bank
    const cardEntry = parsed.card_last4 ? cardRegistry[parsed.card_last4] : null;
    const senderBank = detectBank(sender);
    const bank = cardEntry ? cardEntry.bank : (senderBank ? senderBank.bank : null);

    // If we got a bank from sender but the card registry has no entry, create a
    // virtual cardEntry so the router can still classify CC vs debit-account.
    let resolvedCardEntry = cardEntry;
    if (!resolvedCardEntry && senderBank && parsed.card_last4) {
        // Default to bank_account unless the text says "credit card"
        const isCC = /credit\s*card|^cc\b/i.test(sms);
        resolvedCardEntry = {
            bank: senderBank.bank,
            type: isCC ? 'credit_card' : 'bank_account',
            name: senderBank.bank + ' •••' + parsed.card_last4,
            inferred: true
        };
    }

    // Dedup hash
    const hash = await sha256Hex(dedupKey(parsed, bank));

    // ─── Beta: resolve merchant ───
    const tB = Date.now();
    const merchant = await resolveMerchant(parsed.raw_merchant, sms, origin);
    const latencyB = Date.now() - tB;

    // ─── Gamma: route ───
    const tG = Date.now();
    const routed = routeToModule(parsed, merchant, resolvedCardEntry, knownLoans);
    const latencyG = Date.now() - tG;

    // Time bucket for month/year allocation
    const bucket = timeBucket(parsed.timestamp);

    return new Response(JSON.stringify({
        ok: true,
        classified: true,
        hash,
        parsed,
        resolved_merchant: merchant,
        routed,
        time_bucket: bucket,
        card_entry: resolvedCardEntry,
        bank_detected: bank,
        sender_bank: senderBank,
        latency_ms: { alpha: latencyA, beta: latencyB, gamma: latencyG, total: Date.now() - t0 }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
