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
    var RE_FUEL = /\b(fuel|petrol|diesel|filling station|fuel station|ceypetco|lanka ioc|ioc|gas station|petroleum|dunhinda)\b/;
    var RE_CASH_ADV = /\b(cash advance|cash adv|atm|cash withdrawal|cash withdraw|withdrawal)\b/;
    var RE_CC_FEE = /\b(annual fee|late fee|finance charge|interest charge|service charge|over limit|overlimit|joining fee|card fee)\b/;

    // ── credit-card credit = a payment toward the card (not income) ─────────────
    var RE_CC_PAYMENT = /\b(payment|paid|thank you|received|settlement|autopay|standing order)\b/;

    // ── income classification (bank-account credits) ────────────────────────────
    //  IMPORTANT: 'investment' is NOT a default. Only mark income types we can see.
    var INCOME_TYPES = [
        ['salary',   /\b(salary|payroll|wages|sal cr|monthly sal|emolument|stipend)\b/],
        ['interest', /\b(interest|int cr|int\.|fd interest|savings interest|credit interest)\b/],
        ['dividend', /\b(dividend|div cr|div\.)\b/],
        ['rent',     /\b(rent|rental|lease income)\b/],
        ['business', /\b(invoice|sales|business|merchant settlement|pos settlement|sett)\b/],
        ['pension',  /\b(pension|epf|etf|gratuity)\b/],
        ['gift',     /\b(gift|donation|present)\b/],
        ['deposit',  /\b(cash deposit|cash dep|crm cash|crm deposit|cash credit|deposit)\b/],
        ['transfer', /\b(inward ceft|inward transfer|ceft inward|transfer credit|inward remittance|remittance|fund transfer|inward)\b/]
    ];

    // ── expense categories (Sri-Lanka-aware) ────────────────────────────────────
    var EXPENSE_CATS = [
        ['Gold',          /\b(gold|jewell?er[sy]?|pawn(ing)?|gem stones?|vogue jewell|swarna mahal)\b/],
        ['Gift',          /\b(wedding gift|birthday gift|present shop|hallmark)\b/],
        ['Groceries',     /\b(food city|cargills|keells|arpico|glomark|laughs|supermarket|grocery|spar|sathosa|super ?city|lanka sathosa)\b/],
        ['Dining',        /\b(restaurant|cafe|coffee|kfc|pizza|mcdonald|burger|hotel|bakery|dominos|barista|java|chai|karak|oishi|kottu|biryani|dinemore|perera and sons|pilawoos)\b/],
        ['Fuel',          RE_FUEL],
        ['Transport',     /\b(uber|pickme|taxi|bus|train|railway|parking|toll|expressway|interchange|\brda\b|\betc\b|highway|wiper|tyre|tire|vehicle|auto ?parts?|spare ?parts?|service station|garage|leyland|car wash)\b/],
        ['Utilities',     /\b(ceb|ceylon electricity|electricity|leco|water board|nwsdb|dialog|mobitel|slt|hutch|airtel|internet|broadband|recharge|reload|bill payment|gas)\b/],
        ['Shopping',      /\b(odel|nolimit|no limit|fashion|clothing|store|mall|cotton|kapruka|daraz|amazon|aliexpress|koko|mintpay|mint pay|ecom|showroom|singer|abans|softlogic)\b/],
        ['Health',        /\b(pharmacy|hospital|medical|clinic|channel|lab|nawaloka|asiri|hemas|durdans|osu ?sala|healthguard|laksiri)\b/],
        ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube|game|scope|pvr)\b/],
        ['Education',     /\b(school|tuition|university|campus|course|institute|exam|books)\b/],
        ['Insurance',     /\b(insurance|aia|ceylinco|allianz|union assurance|sri lanka insurance|premium)\b/],
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
        ['streaming', 'Entertainment', /\b(netflix|spotify|youtube premium|yt premium|disney\+?|hbo|hulu|amazon prime|prime video|apple music|apple\.com\/bill|itunes|icloud|google one|hotstar|deezer|crunchyroll)\b/],
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
        if (RE_FUEL.test(d)) return 'fuel';
        if (RE_CASH_ADV.test(d)) return 'cash_advance';
        if (RE_CC_FEE.test(d)) return 'service_fee';
        return 'purchase';
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
        // "PAYMENT - THANK YOU" on a card, is money IN even though it mentions a purchase/payment.
        if (/\b(refund|reversal|reversed|charge ?back|cash ?back|reimburse(ment)?|payment received|received from|funds? received|thank ?you|autopay|auto pay|salary|payroll|wages|emolument|stipend|deposit|cash dep|cash deposit|crm cash|crm deposit|inward|inward remittance|remittance in|credited|credit interest|interest credit|fd interest|savings interest|dividend|bonus|incentive|rent received|rental income|pension|epf|etf|gratuity|transfer in|transfer credit|inward transfer|ceft inward|slips inward|loan disburse(ment)?)\b/.test(d)) return 'credit';
        // STRONG debit signals.
        if (/\b(purchase|pos|point of sale|pos transaction|withdrawal|withdraw|atm wtd|atm|cash advance|cash adv|payment to|paid to|bill payment|billpmt|utility bill|ecom|outward|outward transfer|transfer out|service fee|annual fee|late fee|finance charge|interest charge|surcharge|installment|instalment|standing order|direct debit|loan repayment|emi|insurance premium|premium|stamp duty|debit tax|vat)\b/.test(d)) return 'debit';
        return null; // no decisive signal
    }

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
    function routeTransaction(tx, accountType) {
        tx = tx || {};
        // HARD GUARD: statement balance lines (opening/closing/brought-forward/
        // available/ledger balance) are NOT transactions. Even if the extractor
        // leaks one, it must never become phantom income or an expense.
        var RE_BALANCE = /\b(b\/?f balance|c\/?f balance|opening balance|closing balance|balance (b\/?f|c\/?f|forward|brought forward|carried forward)|brought forward|carried forward|available balance|ledger balance|book balance|previous balance|balance as (at|on))\b/;
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

    var API = {
        routeTransaction: routeTransaction,
        accountTypeForLast4: accountTypeForLast4,
        inferAccountType: inferAccountType,
        expenseCategory: expenseCategory,
        subscriptionInfo: subscriptionInfo,
        incomeKind: incomeKind,
        ccDebitType: ccDebitType,
        resolveDirection: resolveDirection,
        directionFromDescription: directionFromDescription
    };
    root.WFRoute = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    try { if (root.console) root.console.log('[WFRoute] ✓ transaction router ready'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
