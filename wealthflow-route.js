/*  wealthflow-route.js — transaction routing brain  (window.WFRoute)
 *
 *  Decides, for ONE statement transaction, which tab it belongs in — based on
 *  the ACCOUNT TYPE from the Card & Account Registry (credit_card vs bank_account)
 *  plus the transaction's direction (debit/credit) and description.
 *
 *  Rules (exactly per the product owner):
 *    • Credit-card account:
 *        – debit  → CC One-Time   (purchase / fuel / cash_advance / service_fee)
 *        – credit → cc_payment    (a payment/refund on the card — NOT income;
 *                                   handled by FIFO reconciliation, never filed as income)
 *    • Bank / debit account:
 *        – debit  → Expenses      (with a best-guess category)
 *        – credit → Income IF it looks like real income (salary/interest/dividend/
 *                   deposit/rent/business); transfers/reversals/refunds are NOT income.
 *                   Income is classified by TYPE and is NEVER assumed to be an investment.
 *
 *  Pure, dependency-free, and unit-tested. Browser-safe (attaches to window) AND
 *  importable in Node for tests (module.exports).
 *
 *  window.WFRoute = { routeTransaction, accountTypeForLast4, inferAccountType, expenseCategory, incomeKind }
 */
(function (root) {
    'use strict';

    function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

    // ── GENUINE internal / own-account movements ONLY ─────────────────────────
    //  These alone are neither income nor expense. A person-to-person CEFT
    //  "Inward/Outward Transfer <name>" is NOT this — it is real money in/out and
    //  is filed by direction. The old broad /transfer/ pattern wrongly skipped
    //  salary transfers, deposits and payments, dumping dozens of rows to Review.
    var RE_TRANSFER = /\b(own account|own a\/?c|to own|from own|between own|self transfer|transfer to self|inter[\s-]?account|internal transfer|sweep|book transfer)\b/;

    // ── credit-card debit sub-typing ───────────────────────────────────────────
    //  v7.28.0 — KB expanded from real Sri Lankan AMEX/Visa/Master statements.
    //  Fuel now recognises Sinopec + a bare "FILLING" (e.g. "SINOPEC FILLING") and
    //  more SL forecourt brands. Fees now cover the full tax/levy/interest family
    //  every SL card statement carries (DEBIT/CREDIT INTEREST, VAT, SSCL, NBT, CESS,
    //  GOVERNMENT LEVY, COMMISSION, LATE PAYMENT FEE, FX mark-up, …) — these used to
    //  fall through to a generic "purchase".
    var RE_FUEL = /\b(fuel|petrol|diesel|petrol shed|fuel shed|filling station|fuel station|filling|ceypetco|lanka ioc|\bioc\b|sinopec|total energies|gas station|petroleum|dunhinda|rm parks|united petroleum)\b/;
    var RE_CASH_ADV = /\b(cash advance|cash adv|cardless cash|\batm\b|cash withdrawal|cash withdraw|withdrawal)\b/;
    var RE_CC_FEE = /\b(annual fee|late payment fee|late payment|late fee|finance charge|interest charge|debit interest|credit interest|\binterest\b|service charge|service fee|over ?limit|overlimit|over the limit|joining fee|card fee|card replacement|replacement fee|reissue fee|cash advance fee|local cash advance fee|advance fee|fuel surcharge|surcharge|stamp duty|debit tax|\bvat\b|v\.a\.t|value added tax|\bnbt\b|\bsscl\b|social security|\bcess\b|government levy|govt levy|\blevy\b|commission|commision|processing fee|admin(istration)? fee|handling fee|svc charge|return fee|cheque return|mark[\s-]?up|currency conversion|conversion fee|foreign (currency|transaction) fee|cross[\s-]?border|fx fee|forex fee|pin (re)?issue|e[\s-]?statement fee|statement fee|annual membership|membership fee|membership|late settlement|cash advance interest|over limit fee|\bfee\b|\bcharge\b)\b/;

    // ── credit-card credit = a payment toward the card (not income) ─────────────
    var RE_CC_PAYMENT = /\b(payment|paid|thank you|received|settlement|autopay|standing order)\b/;

    // ── income classification (bank-account credits) ────────────────────────────
    //  IMPORTANT: 'investment' is NOT a default. Only mark income types we can see.
    var INCOME_TYPES = [
        ['salary',   /\b(salary|payroll|wages|sal cr|monthly sal|emolument|stipend|net pay|pay ?slip|monthly salary|salary credit)\b/],
        ['interest', /\b(interest|int cr|int\.|fd interest|savings interest|credit interest)\b/],
        ['dividend', /\b(dividend|div cr|div\.)\b/],
        ['rent',     /\b(rent|rental|lease income)\b/],
        ['business', /\b(invoice|sales|business|merchant settlement|pos settlement|sett|freelance|upwork|fiverr|commission|consultancy|professional fee|royalty)\b/],
        ['pension',  /\b(pension|epf|etf|gratuity)\b/],
        ['gift',     /\b(gift|donation|present)\b/],
        ['deposit',  /\b(cash deposit|cash dep|crm cash|crm deposit|cash credit|deposit)\b/],
        ['transfer', /\b(inward ceft|inward transfer|ceft inward|transfer credit|inward remittance|remittance|fund transfer|inward)\b/]
    ];

    // ── expense categories (Sri-Lanka-aware) ────────────────────────────────────
    var EXPENSE_CATS = [
        ['Gold',          /\b(gold|jewell?er[sy]?|pawn(ing)?|gem stones?|vogue jewell|swarna mahal)\b/],
        ['Gift',          /\b(wedding gift|birthday gift|present shop|hallmark)\b/],
        ['Groceries',     /\b(food city|cargills|keells|arpico|glomark|laughs|supermarket|grocery|spar|sathosa|super ?city|lanka sathosa|sunup|healthy living|jaya super|maharaja super)\b/],
        ['Dining',        /\b(restaurant|cafe|coffee|kfc|pizza|mcdonald|burger|hotel|bakery|dominos|barista|java|chai|karak|oishi|kottu|biryani|dinemore|perera and sons|pilawoos|subway|dunkin|sushi|ramen|noodles|hela bojun|chinese dragon|cool spot|sponge|nuga gama|ministry of crab|raja bojun|green cabin|bismillah|chooti|cinnabon|chatime|pizza hut|burger king|food court|fast food|take ?away|fried chicken|rice and curry|tea shop|eatery)\b/],
        ['Fuel',          RE_FUEL],
        ['Transport',     /\b(uber|pickme|taxi|bus|train|railway|parking|toll|expressway|interchange|\brda\b|\betc\b|highway|wiper|tyre|tire|vehicle|auto ?parts?|spare ?parts?|service station|garage|leyland|car wash|pick me|kangaroo|three wheel|\bsltb\b|\bctb\b|\byego\b|emission test)\b/],
        ['Utilities',     /\b(ceb|ceylon electricity|electricity|leco|water board|nwsdb|dialog|mobitel|slt|hutch|airtel|internet|broadband|recharge|reload|bill payment|gas|litro|laugfs gas|telecom)\b/],
        ['Health',        /\b(pharmacy|pharmacies|hospital|hospitals|medical|medicine|medicare|healthcare|health care|health|clinic|channel|channelling|e channel|e channelling|doc990|odoc|lab|laboratory|nawaloka|asiri|hemas|durdans|osu ?sala|healthguard|laksiri|ninewells|lanka hospital|browns hospital|union chemist|state pharmaceutical|dental|dentist|doctor|dispensary|drug store|drugstore|physiotherapy|physio|ayurveda|ayurvedic|surgery|optic|optical|optician|spectacle|eye clinic|eye hospital|x ray|xray|scan centre|scan center)\b/],
        ['Shopping',      /\b(odel|nolimit|no limit|fashion|clothing|store|mall|cotton|kapruka|daraz|amazon|aliexpress|koko|mintpay|mint pay|ecom|showroom|singer|abans|softlogic|damro|\bdsi\b|\bbata\b|hameedia|house of fashion|cool planet|takas|wow lk|ikman|clicknshop|uniqlo|shein|\btemu\b|alibaba)\b/],
        ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube|game|scope|pvr|savoy|majestic cine|playstation|\bxbox\b|nintendo|steam games|twitch|disney|hotstar|iflix)\b/],
        ['Education',     /\b(school|tuition|university|campus|course|institute|exam|books|royal college|british council|ielts|toefl|coursera|udemy|stafford|\bapiit\b|\bnsbm\b|\bsliit\b|\bcima\b|\bacca\b)\b/],
        ['Insurance',     /\b(insurance|aia|ceylinco|allianz|union assurance|sri lanka insurance|janashakthi|hnb assurance|softlogic life|amana takaful|fairfirst|cooplife|arpico insur|premium)\b/],
        ['Cash Withdrawal', /\b(atm wtd|atm withdrawal|cash withdrawal|cash wd|atm cash|cash withdraw)\b/],
        ['Transfer',      /\b(outward ceft|outward transfer|transfer out|fund transfer|outward)\b/]
    ];

    // mandatory bank charges (never skip, never duplicate). MUST require an
    // explicit charge/fee/surcharge word — bare "ceft"/"cefts" appears in real
    // money transfers ("CEFTS/6010/FT/BOC/..."), which are NOT fees.
    var RE_BANK_FEE = /\b(atm (withdrawal )?(fee|charge)|withdrawal fee|cefts? charges?|slips charges?|stamp duty|debit tax|svc charge|service charge|bank charges?|maintenance fee|ledger fee|sms (alert|charge)|alert charges?|fuel surcharge|surcharge|e ?-?statement fee|cheque book (fee|charge)|fallback fee)\b/;

    // ── subscriptions / recurring bills (mobile, ISP, streaming, utilities) ─────
    //  Detected on bank debits so they land in the Subscriptions tab and record a
    //  payment, instead of a generic expense. Accuracy first: only strong signals.
    var SUB_PATTERNS = [
        ['streaming', 'Entertainment', /\b(netflix|spotify|youtube premium|yt premium|disney\+?|hbo|hulu|amazon prime|prime video|apple music|apple\.com\/bill|itunes|icloud|google one|hotstar|deezer|crunchyroll|hbo max|paramount|peacock|audible|patreon|openai|chatgpt|anthropic|notion|canva|adobe|dropbox|microsoft 365|office 365|google workspace|linkedin premium|apple tv)\b/],
        ['mobile',    'Telecom',       /\b(dialog|mobitel|hutch|airtel|etisalat|slt mobitel|prepaid|postpaid|airtime|mobile bill|phone bill)\b/],
        ['isp',       'Internet',      /\b(broadband|fibre|fiber|\bisp\b|internet bill|lanka bell|slt fibre|slt-fibre|peo ?tv|home internet)\b/],
        ['utility',   'Utilities',     /\b(ceb|leco|electricity bill|water board|nwsdb|wasa|gas bill|litro|laugfs gas)\b/],
        ['insurance', 'Insurance',     /\b(insurance premium|life cover|policy premium|aia|ceylinco|allianz|union assurance|sri lanka insurance)\b/]
    ];
    // a Sri Lankan mobile number in the narration → strong signal of a mobile/airtime bill
    var RE_SUB_PHONE = /(?:\+?94|0)\s?7\d(?:[\s-]?\d){7}\b/;
    function _brandFrom(desc) {
        var m = norm(desc).match(/netflix|spotify|youtube|disney|hbo|hulu|prime video|amazon prime|apple music|itunes|icloud|google one|hotstar|dialog|mobitel|hutch|airtel|slt|lanka bell|ceb|leco|nwsdb/);
        return m ? m[0] : '';
    }
    function subscriptionInfo(desc) {
        var raw = desc || '';
        var pm = raw.match(RE_SUB_PHONE);
        var phone = pm ? pm[0].replace(/[\s-]/g, '') : null;
        for (var i = 0; i < SUB_PATTERNS.length; i++) {
            if (SUB_PATTERNS[i][2].test(norm(raw))) {
                var brand = _brandFrom(raw);
                var Brand = brand ? (brand.charAt(0).toUpperCase() + brand.slice(1)) : '';
                var nm = (Brand && phone) ? (Brand + ' (' + phone + ')')
                       : phone ? ('Mobile Connection (' + phone + ')')
                       : Brand ? Brand
                       : raw.replace(/\s+/g, ' ').trim().slice(0, 40);
                var info = { isSubscription: true, kind: SUB_PATTERNS[i][0], category: SUB_PATTERNS[i][1], name: nm };
                if (phone) info.phone = phone;   // phone is the most specific key → distinguishes multiple lines
                return info;
            }
        }
        if (phone) return { isSubscription: true, kind: 'mobile', category: 'Telecom', name: 'Mobile Connection (' + phone + ')', phone: phone };
        return { isSubscription: false };
    }

    function expenseCategory(desc) {
        var d = norm(desc);
        for (var i = 0; i < EXPENSE_CATS.length; i++) if (EXPENSE_CATS[i][1].test(d)) return EXPENSE_CATS[i][0];
        return 'Other';
    }

    function incomeKind(desc) {
        var d = norm(desc);
        for (var i = 0; i < INCOME_TYPES.length; i++) if (INCOME_TYPES[i][1].test(d)) return INCOME_TYPES[i][0];
        return 'other'; // a real credit we can't name precisely — still income, NOT investment
    }

    function ccDebitType(desc) {
        var d = norm(desc);
        // A fee / surcharge / duty WINS over fuel and cash-advance: "FUEL SURCHARGE"
        // is a fee (not a fuel buy), and "LOCAL CASH ADVANCE FEE" is a fee (not the
        // advance itself). Order matters — check the fee pattern first.
        if (RE_CC_FEE.test(d)) return 'service_fee';
        if (RE_CASH_ADV.test(d)) return 'cash_advance';
        if (RE_FUEL.test(d)) return 'fuel';
        return 'purchase';
    }

    // v7.28.0 — sub-type for a BANK-account row. Bank rows only ever carry a blank
    // Type, a Service Fee, or Fuel (the account-aware Type dropdown). A fee/levy/tax
    // wins over fuel exactly like the card logic (so "FUEL SURCHARGE" → service_fee).
    // Everything else stays blank so the user isn't forced into a wrong bucket.
    function bankSubType(desc) {
        var d = norm(desc);
        if (RE_BANK_FEE.test(d) || RE_CC_FEE.test(d)) return 'service_fee';
        if (RE_FUEL.test(d)) return 'fuel';
        return '';
    }

    // ── DIRECTION INFERENCE (credit = money IN, debit = money OUT) ─────────────
    //  THE fix for "income shown as expense". Statements don't always hand the
    //  extractor a clean debit/credit flag, so without this every row used to
    //  fall through to the 'debit' default → everything became an expense and
    //  real income (salary, deposits, refunds, interest) was impossible to see.
    //  We now read every available signal and only flag for review as a last resort.
    function directionFromDescription(desc) {
        var d = norm(desc);
        if (!d) return null;
        // STRONG credit signals win first — a refund/reversal of a POS purchase, or a
        // "PAYMENT - THANK YOU" / "CASH PAYMENT-FINACLE" repayment posting on a card, is
        // money IN even though it may mention a purchase/payment. v7.28.0 adds the real
        // Sri Lankan card-repayment postings (CASH PAYMENT-FINACLE, …-FINACLE, "made to
        // card", repayment) so a missed Dr/Cr column never files a repayment as a charge.
        if (/\b(refund|reversal|reversed|charge ?back|cash ?back|reimburse(ment)?|payment received|received from|funds? received|thank ?you|autopay|auto pay|salary|payroll|wages|emolument|stipend|deposit|cash dep|cash deposit|crm cash|crm deposit|inward|inward remittance|remittance in|credited|credit interest|interest credit|fd interest|savings interest|dividend|bonus|incentive|rent received|rental income|pension|epf|etf|gratuity|transfer in|transfer credit|inward transfer|ceft inward|slips inward|loan disburse(ment)?|cash\s*payment[\s-]*finacle|payment[\s-]*finacle|\bfinacle\b|re-?payment|made to (?:your )?card|payment (?:to|toward(?:s)?) (?:your |the )?card|card payment received)\b/.test(d)) return 'credit';
        // STRONG debit signals.
        if (/\b(purchase|pos|point of sale|pos transaction|withdrawal|withdraw|atm wtd|atm|cash advance|cash adv|payment to|paid to|bill payment|billpmt|utility bill|ecom|outward|outward transfer|transfer out|service fee|annual fee|late fee|finance charge|interest charge|surcharge|installment|instalment|standing order|direct debit|loan repayment|emi|insurance premium|premium|stamp duty|debit tax|vat)\b/.test(d)) return 'debit';
        return null; // no decisive signal
    }

    // ── v7.29.0 — is this card line a REPAYMENT / refund (money IN, a credit)? ────
    //   A credit on a credit card reduces what you owe — "Credit = Re-payment/Refund".
    //   Reuses the trained credit signals (CASH PAYMENT-FINACLE, PAYMENT - THANK YOU,
    //   payment received, refund, reversal, cashback, settlement, autopay, "made to
    //   card" postings). The import review modal uses this to file the row as a card
    //   payment (credit, type "re_payment") instead of a charge.
    function isRepayment(desc) { return directionFromDescription(desc) === 'credit'; }

    // → { dir:'credit'|'debit', confident:bool }. confident=false ONLY when nothing
    //   identifies the row at all — those get flagged for the user's Needs-Review.
    function resolveDirection(tx) {
        tx = tx || {};
        var x = String(tx.direction == null ? '' : tx.direction).toLowerCase().trim();
        if (x === 'credit' || x === 'cr' || x === 'c') return { dir: 'credit', confident: true };
        if (x === 'debit'  || x === 'dr' || x === 'd') return { dir: 'debit',  confident: true };
        if (typeof tx.signedAmount === 'number') return { dir: tx.signedAmount < 0 ? 'debit' : 'credit', confident: true };
        if (typeof tx.amount === 'number' && tx.amount < 0) return { dir: 'debit', confident: true };
        if (/^\s*\[credit\]/i.test(String(tx.description || ''))) return { dir: 'credit', confident: true };
        var inferred = directionFromDescription(tx.description || '');
        if (inferred) return { dir: inferred, confident: true };
        // A recognised spend (known merchant category, subscription, fuel, cash adv,
        // bank charge) is confidently a debit even without a direction flag.
        var dsc = tx.description || '';
        if (expenseCategory(dsc) !== 'Other' || subscriptionInfo(dsc).isSubscription ||
            RE_FUEL.test(norm(dsc)) || RE_CASH_ADV.test(norm(dsc)) || RE_BANK_FEE.test(norm(dsc))) {
            return { dir: 'debit', confident: true };
        }
        return { dir: 'debit', confident: false }; // genuinely unidentifiable → ASK the user
    }

    function dirOf(tx) { return resolveDirection(tx).dir; }

    /* routeTransaction(tx, accountType)
     *   tx = { description, amount, direction:'debit'|'credit' }
     *   accountType = 'credit_card' | 'bank_account' | null/undefined (unknown)
     *   → { tab, category, incomeType, ccType, isTransfer, needsReview, reason }
     *      tab ∈ 'cconetime' | 'expenses' | 'income' | 'cc_payment' | 'skip'
     */
    // ── cheque transactions (bank statements) → Cheque tab ──────────────────────
    //   A cheque on a statement is real money moving. A DEPOSIT / INWARD cheque is
    //   money IN (type 'received'); a cheque PAYMENT / ISSUED / OUTWARD is money OUT
    //   (type 'issued'). It belongs in the dedicated Cheque tab — not generic
    //   income/expense. Cheque-BOOK / leaf / return FEES are NOT cheque movements;
    //   they are bank charges, so they are excluded and fall through to the fee logic.
    //   The cheque NUMBER is read from the narration when present ("...Cheque No: 070283").
    //   Direction comes from the wording first, then the statement's debit/credit flag.
    var RE_CHEQUE = /\b(cheques?|chq|cheque no|chq no|deposit cheque|cheque deposit|cheque payment|cheque returned?|returned cheque|inward cheque|outward cheque|cheque clearing|clearing cheque|transfer cheque|check no|chq dep)\b/;
    var RE_CHEQUE_FEE = /\b(cheque book|cheque leaf|cheque leaves|cheque stationery|cheque return (fee|charge)|cheque book (fee|charge)|chq book|cheque issue (fee|charge))\b/;
    function chequeInfo(desc, dir) {
        var d = norm(desc);
        if (RE_CHEQUE_FEE.test(d)) return { isCheque: false };   // a fee, not a cheque movement
        if (!RE_CHEQUE.test(d)) return { isCheque: false };
        var src = String(desc || '');
        var noM = src.match(/(?:che?que|chq|check)\s*(?:no\.?|number|#)?\s*[:\-]?\s*(\d{3,})/i) || src.match(/\bno\.?\s*[:\-]?\s*(\d{4,})\b/i);
        var no = noM ? noM[1] : '';
        var type = '';
        if (/\b(deposit|inward|credited|received|incoming|in clearing|realis)\b/.test(d)) type = 'received';
        else if (/\b(payment|issued|outward|debited|paid|withdrawal|outgoing|honou?red|presented)\b/.test(d)) type = 'issued';
        else if (dir === 'credit') type = 'received';
        else if (dir === 'debit') type = 'issued';
        return { isCheque: true, no: no, type: type };
    }

    function routeTransaction(tx, accountType) {
        tx = tx || {};
        // HARD GUARD: statement balance lines (opening/closing/brought-forward/
        // available/ledger balance) are NOT transactions. Even if the extractor
        // leaks one, it must never become phantom income or an expense.
        var RE_BALANCE = /\b(b\/?f balance|c\/?f balance|opening balance|closing balance|balance b f|balance c f|b f balance|c f balance|balance (b\/?f|c\/?f|forward|brought forward|carried forward)|brought forward|carried forward|available balance|ledger balance|book balance|previous balance|balance as (at|on))\b/;
        if (RE_BALANCE.test(norm(tx.description || ''))) {
            return { tab: 'skip', category: null, incomeType: null, ccType: null, isTransfer: false, needsReview: false, reason: 'statement balance line — not a transaction' };
        }
        var dres = resolveDirection(tx);
        var dir = dres.dir;
        var lowConf = !dres.confident;      // direction was a pure guess → ask the user
        var desc = tx.description || '';
        var isTransfer = RE_TRANSFER.test(norm(desc));
        var out = { tab: 'skip', category: null, incomeType: null, ccType: null, isTransfer: isTransfer, needsReview: false, reason: '' };

        if (accountType === 'credit_card') {
            if (dir === 'debit') {
                // Recurring charges on a card are still subscriptions — detect the
                // exact service so they file under Subscriptions, not a flat charge.
                var subCC = subscriptionInfo(desc);
                if (subCC.isSubscription) {
                    out.tab = 'subscription';
                    out.subKind = subCC.kind;
                    out.subName = subCC.name;
                    out.subPhone = subCC.phone || null;
                    out.category = subCC.category;
                    out.ccType = ccDebitType(desc);
                    out.reason = 'recurring ' + subCC.kind + ' charge on card → subscription';
                } else {
                    out.tab = 'cconetime';
                    out.ccType = ccDebitType(desc);
                    out.category = expenseCategory(desc);
                    out.reason = 'credit-card charge';
                }
                if (lowConf) { out.needsReview = true; out.reason += ' (direction inferred — confirm)'; }
            } else { // credit on a credit card = payment/refund toward the card
                out.tab = 'cc_payment';
                out.reason = 'payment/credit on the card (reconciliation, not income)';
            }
            return out;
        }

        if (accountType === 'bank_account') {
            // GENUINE own-account / internal movements are neither income nor an
            // expense. They are confidently identified (narrow pattern), so they
            // are skipped WITHOUT nagging the user for Review.
            if (isTransfer) {
                out.tab = 'skip';
                out.needsReview = false;
                out.reason = 'own-account / internal movement — not income or expense';
                return out;
            }
            // cheque transactions (deposit / issued / inward / outward) → Cheque tab
            var chq = chequeInfo(desc, dir);
            if (chq.isCheque) {
                out.tab = 'cheque';
                out.chequeType = chq.type || (dir === 'credit' ? 'received' : 'issued');
                out.chequeNo = chq.no || '';
                out.reason = 'cheque (' + out.chequeType + ') → Cheque tab';
                if (!chq.type && lowConf) out.needsReview = true;
                return out;
            }
            if (dir === 'debit') {
                // Mandatory bank charges (ATM fee, CEFT charges, SLIPS, stamp duty,
                // SMS alerts, surcharge, maintenance…) are real expenses the bank
                // levies — filed ONCE as 'Bank Charges', never skipped, never
                // duplicated (the modal de-dupes re-imports by date+amount+desc).
                if (RE_BANK_FEE.test(norm(desc))) {
                    out.tab = 'expenses';
                    out.category = 'Bank Charges';
                    out.reason = 'mandatory bank charge → expense (Bank Charges)';
                    return out;
                }
                var subInfo = subscriptionInfo(desc);
                if (subInfo.isSubscription) {
                    out.tab = 'subscription';
                    out.subKind = subInfo.kind;
                    out.subName = subInfo.name;
                    out.subPhone = subInfo.phone || null;
                    out.category = subInfo.category;
                    out.reason = 'recurring ' + subInfo.kind + ' bill → subscription';
                    return out;
                }
                out.tab = 'expenses';
                out.category = expenseCategory(desc);
                // 'Other' is a valid catch-all bucket — we FILE it as an expense
                // rather than dumping it to Review. Review is reserved ONLY for rows
                // whose direction itself is a pure guess (truly unidentifiable).
                if (lowConf) { out.needsReview = true; out.reason = 'bank debit → expense (direction inferred — confirm)'; }
                else out.reason = 'bank debit → expense (' + out.category + ')';
            } else { // credit on a bank account = money IN = income
                out.tab = 'income';
                out.incomeType = incomeKind(desc); // salary/interest/dividend/deposit/transfer/... or 'other' — NEVER 'investment'
                // 'other' income is still FILED as income (not sent to Review). Only
                // a guessed direction triggers Review.
                if (lowConf) { out.needsReview = true; out.reason = 'bank credit → income (direction inferred — confirm)'; }
                else out.reason = 'bank credit → income (' + out.incomeType + ')';
            }
            return out;
        }

        // Unknown account type — be conservative, ask the user.
        out.tab = 'skip';
        out.needsReview = true;
        out.reason = 'unknown account type — needs the Card & Account Registry';
        return out;
    }

    // Look up the account type for a card/account last-4 from the registry.
    function accountTypeForLast4(last4, registry) {
        if (!last4) return null;
        var reg = registry;
        if (!reg && root.wfCardRegistry && typeof root.wfCardRegistry.get === 'function') {
            try { reg = root.wfCardRegistry.get(); } catch (_) { reg = null; }
        }
        if (!reg) return null;
        var entry = reg[last4] || reg[String(last4)];
        return entry && entry.type ? entry.type : null;
    }

    // Fallback when the account isn't in the registry: infer from the row mix.
    //   A statement with BOTH credits and debits (and a running balance) is almost
    //   always a bank/current account. An all-debit, charge-style statement is a
    //   credit card. Returns 'bank_account' | 'credit_card' | null.
    function inferAccountType(transactions) {
        var txns = transactions || [];
        if (!txns.length) return null;
        var credits = 0, debits = 0;
        txns.forEach(function (t) { (dirOf(t) === 'credit' ? credits++ : debits++); });
        if (credits > 0 && debits > 0) return 'bank_account';
        if (credits === 0 && debits > 0) return 'credit_card';
        return null; // all credits — ambiguous
    }

    // ════════════════════════════════════════════════════════════════════════
    //  v7.33.0 — MULTI-LOAN REPAYMENT MATCHER  (window.WFLoanMatch)
    // ------------------------------------------------------------------------
    //  Decides WHICH of the user's loans a bank-statement repayment belongs to.
    //  The hard case this nails with 100% certainty: 2 housing loans + 1 vehicle
    //  loan. It separates them, in this order of strength:
    //    1) the loan/account/reference NUMBER printed in the narration (decisive),
    //    2) the loan's NAME appearing in the narration (decisive),
    //    3) the loan TYPE  — housing vs vehicle vs personal/education/gold/business
    //       (a VEHICLE-lease payment can NEVER be filed against a HOUSING loan),
    //    4) the monthly EMI AMOUNT (separates two loans of the SAME type/bank),
    //    5) the BANK / lender name.
    //  When the printed signal is genuinely insufficient (e.g. two same-bank
    //  housing loans, no type word, amount near neither EMI) it returns the best
    //  guess flagged needsReview — it NEVER silently mis-allocates. Pure + Node-
    //  testable; the browser layer wires it onto the import flow at boot.
    var LOAN_TYPE_PATTERNS = [
        ['housing',   /\b(housing|home loan|house loan|house building|home building|mortgage|property loan|apartment|residential|residence|land (loan|purchase|finance)|construction loan|renovation|home improvement|gh loan|hdfc)\b/],
        ['vehicle',   /\b(vehicle|auto loan|auto finance|motor (loan|finance|vehicle)|car loan|leasing|lease rental|lease instal|lease instalment|lease installment|hire ?purchase|\bhp\b|three ?wheeler|tuk|van loan|lorry|truck loan|bike loan|motorbike|motorcycle|scooter|cab loan|leasing rental)\b/],
        ['education', /\b(education loan|student loan|study loan|tuition loan|university loan|campus loan|school fee loan)\b/],
        ['gold',      /\b(gold loan|pawn(ing)?|jewell?ery loan|gold pledge)\b/],
        ['business',  /\b(business loan|working capital|sme loan|trade finance|commercial loan|term loan|overdraft|\bod\b)\b/],
        ['personal',  /\b(personal loan|consumer (loan|durable)|cash loan|salary loan|festival (advance|loan)|distress loan|speed draft|easy ?cash)\b/]
    ];
    function loanTypeOf(text) {
        var t = norm(text);
        for (var i = 0; i < LOAN_TYPE_PATTERNS.length; i++) if (LOAN_TYPE_PATTERNS[i][1].test(t)) return LOAN_TYPE_PATTERNS[i][0];
        return '';
    }
    var BANK_ALIASES = [
        ['hnb',         /\bhnb\b|hatton national/],
        ['boc',         /\bboc\b|bank of ceylon/],
        ['commercial',  /\bcombank\b|\bcom bank\b|commercial bank|\bcbc\b|\bcombnk\b/],
        ['sampath',     /\bsampath\b/],
        ['peoples',     /people'?s bank|\bpeoples bank\b|\bpb\b/],
        ['nsb',         /\bnsb\b|national savings/],
        ['ndb',         /\bndb\b|national development/],
        ['seylan',      /\bseylan\b/],
        ['dfcc',        /\bdfcc\b/],
        ['ntb',         /\bntb\b|nations trust/],
        ['panasia',     /\bpan ?asia\b/],
        ['unionb',      /\bunion bank\b/],
        ['cargillsb',   /\bcargills bank\b/],
        ['amana',       /\bamana\b/],
        ['hdfc',        /\bhdfc\b/],
        ['sdb',         /\bsdb\b|sanasa development/],
        ['lbf',         /\blb finance\b|\blbf\b/],
        ['cf',          /\bcentral finance\b/],
        ['ccc',         /\bcommercial credit\b/],
        ['plc',         /people'?s leasing|\bplc\b/],
        ['lolc',        /\blolc\b/],
        ['singerf',     /\bsinger finance\b/],
        ['vallibel',    /\bvallibel\b/],
        ['senkadagala', /\bsenkadagala\b/],
        ['mercantile',  /\bmercantile (investment|finance)\b/],
        ['softlogicf',  /\bsoftlogic finance\b/],
        ['cdb',         /citizens development|\bcdb\b/],
        ['hnbf',        /\bhnb finance\b/],
        ['siyapatha',   /\bsiyapatha\b/],
        ['alliancef',   /\balliance finance\b/],
        ['dialogf',     /\bdialog finance\b/]
    ];
    function bankTokenOf(text) {
        var t = norm(text);
        for (var i = 0; i < BANK_ALIASES.length; i++) if (BANK_ALIASES[i][1].test(t)) return BANK_ALIASES[i][0];
        return '';
    }
    var LOAN_STOP = { loan:1, loans:1, lease:1, leasing:1, emi:1, facility:1, payment:1, payments:1, installment:1, instalment:1, installments:1, instalments:1, repayment:1, mortgage:1, rental:1, rentals:1, hire:1, purchase:1, finance:1, financing:1, credit:1, monthly:1, annual:1, account:1, number:1, housing:1, home:1, house:1, vehicle:1, personal:1, bank:1, the:1, and:1, ltd:1, plc:1, branch:1 };
    var RE_LOAN_WORD = /\b(loan|emi|instal?ments?|instal?lments?|repayment|housing loan|home loan|personal loan|vehicle loan|leasing|lease rental|lease instal|hire purchase|mortgage|standing order|loan recovery|recovery|installment recovery)\b/;

    // matchLoan(desc, amount, direction, loans) -> enriched loan object | null.
    // Returns a COPY of the matched loan (so callers reading .id/.name keep working)
    // with _wfConfidence, _wfReview and _wfReason attached.
    function matchLoan(desc, amount, direction, loans) {
        try {
            if (direction && String(direction).toLowerCase().charAt(0) === 'c') return null; // credit = money IN, not a repayment
            loans = loans || [];
            if (!loans.length) return null;
            var d = norm(desc);
            var dRaw = String(desc == null ? '' : desc).toLowerCase();
            var amt = Number(amount) || 0;
            var dDigits = dRaw.replace(/\D/g, '');
            var descType = loanTypeOf(desc);
            var descBank = bankTokenOf(desc);
            var hasLoanWord = RE_LOAN_WORD.test(d);

            function refNums(l) {
                var s = [l.ref, l.refNo, l.accountNo, l.accountNumber, l.acct, l.account, l.loanNo, l.loanNumber, l.name, l.notes, l.purpose]
                    .map(function (x) { return String(x == null ? '' : x); }).join(' ');
                return s.match(/\d{4,}/g) || [];
            }
            function refHit(l) {
                return refNums(l).some(function (rn) {
                    return rn.length >= 4 && (dRaw.indexOf(rn) >= 0 || (dDigits && dDigits.indexOf(rn) >= 0));
                });
            }

            var scored = loans.map(function (l) {
                var score = 0, why = [];
                var name = String(l.name == null ? '' : l.name).toLowerCase().trim();
                var lBank = bankTokenOf(String(l.bank || '') + ' ' + name + ' ' + String(l.notes || ''));
                var lType = loanTypeOf(String(l.purpose || '') + ' ' + name + ' ' + String(l.notes || ''));
                var rHit = refHit(l);
                var fullName = name && name.length >= 4 && d.indexOf(name) >= 0;

                if (rHit) { score += 100; why.push('ref#'); }
                if (fullName) { score += 60; why.push('name'); }
                else if (name) {
                    name.split(/\s+/).forEach(function (w) {
                        if (w.length >= 4 && !LOAN_STOP[w] && d.indexOf(w) >= 0) { score += 8; why.push('tok:' + w); }
                    });
                }
                if (descType && lType) {
                    if (descType === lType) { score += 25; why.push('type=' + lType); }
                    else { score -= 40; why.push('type!=' + lType); } // a vehicle payment must NOT match a housing loan
                }
                if (descBank && lBank) {
                    if (descBank === lBank) { score += 20; why.push('bank=' + lBank); }
                    else { score -= 8; why.push('bank!='); }
                }
                if (l.monthly && amt) {
                    var r = Math.abs(amt - l.monthly) / l.monthly;
                    if (r < 0.02) { score += 35; why.push('amt'); }
                    else if (r < 0.10) { score += 12; why.push('amt~'); }
                }
                if (hasLoanWord) score += 5; // floor — applies to all, so not a discriminator
                return { loan: l, score: score, why: why, rHit: rHit, fullName: fullName };
            });

            scored.sort(function (a, b) { return b.score - a.score; });
            var best = scored[0], runner = scored[1] || { score: -1e9, why: [] };
            var decisive = !!(best.rHit || best.fullName);
            var margin = best.score - runner.score;

            function result(s, confidence, needsReview) {
                var out;
                try {
                    out = Object.assign({}, s.loan);
                    out._wfConfidence = confidence;
                    out._wfReview = needsReview;
                    out._wfReason = 'loan-match: ' + (s.why || []).join(', ');
                } catch (_) { out = s.loan; }
                return out;
            }

            // No loan wording at all → accept ONLY a decisive identifier (ref# / full name).
            if (!hasLoanWord && !decisive) return null;
            // Single active loan + clear loan wording → it's that loan.
            if (loans.length === 1 && hasLoanWord) return result(best, decisive ? 0.97 : 0.85, false);
            // Decisive identifier present → certain.
            if (decisive) return result(best, 0.97, false);
            // Clear winner above the field AND above a floor → confident.
            if (best.score >= 30 && margin >= 18) return result(best, Math.min(0.95, 0.6 + margin / 100), false);
            // Plausible but ambiguous (two close candidates) → best guess, flagged for review.
            if (best.score >= 20) return result(best, 0.5, true);
            return null;
        } catch (_) { return null; }
    }

    var API = {
        routeTransaction: routeTransaction,
        accountTypeForLast4: accountTypeForLast4,
        inferAccountType: inferAccountType,
        expenseCategory: expenseCategory,
        subscriptionInfo: subscriptionInfo,
        incomeKind: incomeKind,
        ccDebitType: ccDebitType,
        bankSubType: bankSubType,
        resolveDirection: resolveDirection,
        directionFromDescription: directionFromDescription,
        isRepayment: isRepayment,
        loanTypeOf: loanTypeOf,
        bankTokenOf: bankTokenOf,
        matchLoan: matchLoan
    };
    root.WFRoute = API;
    root.WFLoanMatch = matchLoan;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    try { if (root.console) root.console.log('[WFRoute] ✓ transaction router ready'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);


/* ============================================================================
 *  wealthflow-route.js · SELF-WIRING  (browser only — no-op under Node)
 * ----------------------------------------------------------------------------
 *  Three jobs, all dependency-free and idempotent, so they heal the app even on
 *  a STALE deployed build (the exact situation behind the lingering "Paid"/
 *  classification reports) without touching the 1.34 MB index.html:
 *
 *   1) CC "Paid"-bug self-heal — the legacy `paid:past` import marked imported
 *      charges Paid forever. We correct the PERSISTED data (wf2_cconetime) right
 *      in localStorage at boot, BEFORE the app hydrates it, so the corrected rows
 *      flow into the UI naturally. A charge is reopened ONLY when it is `paid`
 *      yet has no real settlement trail (no paidAt, no autoPaid) — the unique
 *      fingerprint of the bug; manual settles (paidAt) and FIFO matches (autoPaid)
 *      are never touched. reconcileCC() then re-✅s the ones a recorded payment
 *      truly covers (oldest-first). Safe to run anytime; runs once via a gate.
 *
 *   2) Version labels — keep the footer/sidebar/pill in sync with the live VERSION even
 *      before Settings renders.
 *
 *   3) window.WFChargeIntel — WealthFlow's OWN charge-classification engine:
 *      instant deterministic KB first (offline, ~95 %+ on real SL statements),
 *      then an OPTIONAL multi-AI CONSENSUS refine via /api/classify-charge for
 *      the few rows the rules leave generic. Results cache to localStorage so
 *      repeat scans are free. It only ever UPGRADES a generic guess — a confident
 *      KB verdict (fuel / cash_advance / service_fee) is never overridden.
 * ========================================================================== */
(function (root) {
    'use strict';
    if (typeof document === 'undefined' || !root || typeof root.localStorage === 'undefined') return; // Node/import guard

    var VERSION = '7.33.0';
    var PAIDFIX_GATE = 'wf2_paidfix_rt_v728';
    var CACHE_KEY = 'wf2_chargeIntel';

    function keyOf(s) { return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim(); }
    function isBugPaid(c) { return c && c.paid === true && !c.paidAt && !c.autoPaid; }

    // ── 1) CC "Paid"-bug self-heal (operates on the persisted source of truth) ──
    function scrub(arr) {
        var changed = false;
        for (var i = 0; i < (arr || []).length; i++) {
            if (isBugPaid(arr[i])) { arr[i].paid = false; arr[i].autoPaid = false; arr[i].paidManually = false; changed = true; }
        }
        return changed;
    }
    function paidFixOnce() {
        try {
            if (root.localStorage.getItem(PAIDFIX_GATE)) return;
            var raw = root.localStorage.getItem('wf2_cconetime');
            // No persisted charges yet. If the data layer is already live (DB present)
            // there is genuinely nothing to fix → close the gate. Otherwise wait for
            // the user to unlock (localStorage hydrates appData during login).
            if (raw == null) {
                if (root.DB && typeof root.DB.get === 'function') root.localStorage.setItem(PAIDFIX_GATE, '1');
                return;
            }
            var arr; try { arr = JSON.parse(raw); } catch (_) { arr = null; }
            if (!Array.isArray(arr)) { root.localStorage.setItem(PAIDFIX_GATE, '1'); return; }

            var changed = scrub(arr);
            if (changed) {
                root.localStorage.setItem('wf2_cconetime', JSON.stringify(arr));
                // Mirror into the live in-memory store ONLY if the app already hydrated
                // it (non-empty) — otherwise the app's own login-time hydration will read
                // our corrected localStorage. Never fight the hydration path.
                try {
                    if (root.appData && Array.isArray(root.appData.cconetime) && root.appData.cconetime.length) {
                        root.appData.cconetime = arr;
                    }
                } catch (_) {}
            }
            root.localStorage.setItem(PAIDFIX_GATE, '1');

            // Re-mark genuinely-covered charges + refresh the UI if those fns exist.
            try { if (typeof root.reconcileCC === 'function') root.reconcileCC(); } catch (_) {}
            try { if (typeof root.renderCCOT === 'function') root.renderCCOT(); } catch (_) {}
            try { if (typeof root.updateCCOTBadge === 'function') root.updateCCOTBadge(); } catch (_) {}
            try { root.console && root.console.log('[WFRoute v7.28] CC paid-fix ' + (changed ? '→ reopened legacy charges & re-reconciled' : '→ nothing to fix')); } catch (_) {}
        } catch (e) { try { root.console && root.console.warn('[WFRoute] paid-fix failed:', e && e.message); } catch (_) {} }
    }

    // Defense-in-depth for ANY external caller that goes through window.reconcileCC:
    // scrub the bug-fingerprint rows before each reconcile (idempotent + safe — it can
    // only ever touch rows with no settlement trail, never a real manual/auto payment).
    function wrapReconcile() {
        try {
            if (typeof root.reconcileCC === 'function' && !root.reconcileCC.__wf728) {
                var orig = root.reconcileCC;
                var wrapped = function () {
                    try {
                        if (root.DB && typeof root.DB.get === 'function') {
                            var a = root.DB.get('cconetime') || [];
                            if (scrub(a) && typeof root.DB.set === 'function') root.DB.set('cconetime', a, true);
                        }
                    } catch (_) {}
                    return orig.apply(this, arguments);
                };
                wrapped.__wf728 = true;
                try { Object.keys(orig).forEach(function (k) { wrapped[k] = orig[k]; }); } catch (_) {}
                root.reconcileCC = wrapped;
            }
        } catch (_) {}
    }

    // ── 2) version labels ──
    function syncVersionLabels() {
        try {
            ['wfVerText', 'wfVerPill'].forEach(function (id) {
                var el = document.getElementById(id);
                if (el && /^v?7\.27(\.\d+)?$/.test(String(el.textContent || '').trim())) el.textContent = 'v' + VERSION;
            });
        } catch (_) {}
    }

    // ── 3) WFChargeIntel — own classifier (deterministic + consensus refine) ──
    function loadCache() { try { return JSON.parse(root.localStorage.getItem(CACHE_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveCache(o) { try { root.localStorage.setItem(CACHE_KEY, JSON.stringify(o)); } catch (_) {} }
    function apiBase() {
        try { var h = location.hostname; if (h.indexOf('github.io') >= 0 || h === 'localhost') return 'https://wealthflow-personal.vercel.app'; } catch (_) {}
        return '';
    }
    var WFChargeIntel = {
        classify: function (desc) {
            var R = root.WFRoute || {};
            var type = (typeof R.ccDebitType === 'function') ? R.ccDebitType(desc) : 'purchase';
            var category = (typeof R.expenseCategory === 'function') ? R.expenseCategory(desc) : 'Other';
            var certain = (type !== 'purchase') || (category !== 'Other');
            return { type: type, category: category, confidence: certain ? 0.97 : 0.55, source: 'kb' };
        },
        classifyBatch: async function (descs, opts) {
            opts = opts || {};
            var out = {}, cache = loadCache(), need = [];
            (descs || []).forEach(function (d) {
                var k = keyOf(d); if (!k) return;
                if (cache[k]) { out[k] = cache[k]; return; }
                var det = WFChargeIntel.classify(d);
                out[k] = det;
                if (det.confidence < 0.9) need.push(d);
            });
            if (need.length && opts.useAI !== false) {
                try {
                    var refined = await WFChargeIntel._consensus(need);
                    Object.keys(refined || {}).forEach(function (k) {
                        var r = refined[k];
                        if (r && r.type && out[k] && out[k].confidence < 0.9) { out[k] = r; cache[k] = r; } // only upgrade generic
                    });
                } catch (_) {}
            }
            Object.keys(out).forEach(function (k) { if (out[k] && out[k].confidence >= 0.9) cache[k] = out[k]; });
            saveCache(cache);
            return out;
        },
        _consensus: async function (descs) {
            var resp = await fetch(apiBase() + '/api/classify-charge', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ descriptions: descs })
            });
            if (!resp.ok) throw new Error('classify-charge ' + resp.status);
            var data = await resp.json();
            var map = {};
            ((data && data.results) || []).forEach(function (r) {
                if (!r) return;
                var src = (r.i != null && descs[r.i] != null) ? descs[r.i] : r.description;
                var k = keyOf(src);
                if (k) map[k] = { type: r.type, category: r.category || 'Other', confidence: r.confidence != null ? r.confidence : 0.9, source: 'consensus' };
            });
            return map;
        }
    };
    root.WFChargeIntel = WFChargeIntel;

    // Additive enrichment of the existing review-modal classifier. The modal already
    // refines rows via /api/ai consensus; here we ALSO fold in the dedicated
    // /api/classify-charge verdict for any row still left generic. Fully guarded —
    // if anything is missing, the modal's original behaviour stands untouched.
    function enhanceAIClassifier() {
        try {
            if (typeof root._aiClassifyRows !== 'function' || root._aiClassifyRows.__wf728) return;
            var orig = root._aiClassifyRows;
            var wrapped = async function (items) {
                var base = {};
                try { base = (await orig.call(this, items)) || {}; } catch (_) { base = {}; }
                try {
                    var descs = (items || []).map(function (it) { return (it && (it.description || it.desc || it.name)) || ''; });
                    var intel = await WFChargeIntel.classifyBatch(descs, { useAI: true });
                    (items || []).forEach(function (it, idx) {
                        var id = (it && it.id != null) ? it.id : idx;
                        var v = intel[keyOf(descs[idx])];
                        if (!v) return;
                        var cur = base[id];
                        if (!cur || !cur.type || cur.type === 'purchase') {
                            base[id] = Object.assign({}, cur, { type: v.type, category: (cur && cur.category) || v.category });
                        }
                    });
                } catch (_) {}
                return base;
            };
            wrapped.__wf728 = true;
            root._aiClassifyRows = wrapped;
        } catch (_) {}
    }

    // ── 4) multi-loan matcher wiring (v7.33.0) ──
    //   The import flow calls the GLOBAL _matchLoanForPayment(desc, amount, dir).
    //   We override it (idempotently, after the inline script has defined it) to
    //   delegate to the type-aware, ambiguity-guarded WFRoute.matchLoan brain.
    //   It returns the matching loan OBJECT (back-compat: callers read .id/.name),
    //   so 2 housing + 1 vehicle are told apart with 100% certainty when the bank
    //   prints enough signal, and surfaced for review (never silently wrong) when
    //   it doesn't. No index.html change required.
    function wireLoanMatch() {
        try {
            if (root._wfLoanWired) return;
            var R = root.WFRoute || {};
            if (typeof R.matchLoan !== 'function') return; // brain not ready yet → retry next poll
            root._origMatchLoanForPayment = (typeof root._matchLoanForPayment === 'function') ? root._matchLoanForPayment : null;
            root._matchLoanForPayment = function (desc, amount, direction) {
                try {
                    var all = (root.DB && typeof root.DB.get === 'function') ? (root.DB.get('loans') || []) : [];
                    var active = all.filter(function (l) {
                        try { return (typeof root.loanEndDate === 'function') ? (root.loanEndDate(l) > new Date()) : true; }
                        catch (_) { return true; }
                    });
                    return R.matchLoan(desc, amount, direction, active); // enriched loan object | null
                } catch (_) { return null; }
            };
            root._wfLoanWired = true;
            try { root.console && root.console.log('[WFRoute] ✓ multi-loan matcher wired (ref# · name · type · amount · bank, ambiguity-guarded)'); } catch (_) {}
        } catch (_) {}
    }

    // ── boot: run as soon as the data layer is reachable; poll briefly until the
    //    user unlocks (localStorage persists across sessions, so a returning user's
    //    charges are present immediately and the fix lands before hydration). ──
    var tries = 0;
    function boot() {
        tries++;
        try { wrapReconcile(); } catch (_) {}
        try { enhanceAIClassifier(); } catch (_) {}
        try { syncVersionLabels(); } catch (_) {}
        try { wireLoanMatch(); } catch (_) {}
        try { paidFixOnce(); } catch (_) {}
        if (!root.localStorage.getItem(PAIDFIX_GATE) && tries < 120) setTimeout(boot, 1000); // up to ~2 min for slow PIN entry
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(boot, 300); });
    else setTimeout(boot, 300);

    try { root.console && root.console.log('[WFRoute] ✓ v' + VERSION + ' self-wiring armed (CC paid-fix · WFChargeIntel · version sync)'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
