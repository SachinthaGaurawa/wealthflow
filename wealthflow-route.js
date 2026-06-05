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

    // ── transfers / reversals / refunds — never income, never an expense ───────
    var RE_TRANSFER = /\b(transfer|fund transfer|own account|reversal|reversed|refund|chargeback|charge back|returned|cancellation|void)\b/;

    // ── credit-card debit sub-typing ───────────────────────────────────────────
    var RE_FUEL = /\b(fuel|petrol|diesel|filling station|fuel station|ceypetco|lanka ioc|ioc|gas station|petroleum)\b/;
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
        ['pension',  /\b(pension|epf|etf|gratuity)\b/]
    ];

    // ── expense categories (Sri-Lanka-aware) ────────────────────────────────────
    var EXPENSE_CATS = [
        ['Groceries',     /\b(food city|cargills|keells|arpico|glomark|laughs|supermarket|grocery|spar|sathosa)\b/],
        ['Dining',        /\b(restaurant|cafe|coffee|kfc|pizza|mcdonald|burger|hotel|bakery|dominos|barista|java)\b/],
        ['Fuel',          RE_FUEL],
        ['Transport',     /\b(uber|pickme|taxi|bus|train|railway|parking|toll|expressway)\b/],
        ['Utilities',     /\b(ceb|electricity|lecо|water board|nwsdb|dialog|mobitel|slt|hutch|airtel|internet|broadband|recharge|reload|bill payment)\b/],
        ['Shopping',      /\b(odel|nolimit|fashion|clothing|store|mall|cotton|kapruka|daraz|amazon|aliexpress)\b/],
        ['Health',        /\b(pharmacy|hospital|medical|clinic|channel|lab|nawaloka|asiri|hemas|durdans)\b/],
        ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube|game|scope|pvr)\b/],
        ['Education',     /\b(school|tuition|university|campus|course|institute|exam|books)\b/],
        ['Insurance',    /\b(insurance|aia|ceylinco|allianz|union assurance|sri lanka insurance|premium)\b/]
    ];

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

    function dirOf(tx) {
        var x = (tx && tx.direction) || '';
        if (x === 'credit' || x === 'debit') return x;
        // fall back to a numeric/sign hint if present
        if (tx && typeof tx.signedAmount === 'number') return tx.signedAmount < 0 ? 'debit' : 'credit';
        return 'debit';
    }

    /* routeTransaction(tx, accountType)
     *   tx = { description, amount, direction:'debit'|'credit' }
     *   accountType = 'credit_card' | 'bank_account' | null/undefined (unknown)
     *   → { tab, category, incomeType, ccType, isTransfer, needsReview, reason }
     *      tab ∈ 'cconetime' | 'expenses' | 'income' | 'cc_payment' | 'skip'
     */
    function routeTransaction(tx, accountType) {
        tx = tx || {};
        var dir = dirOf(tx);
        var desc = tx.description || '';
        var isTransfer = RE_TRANSFER.test(norm(desc));
        var out = { tab: 'skip', category: null, incomeType: null, ccType: null, isTransfer: isTransfer, needsReview: false, reason: '' };

        if (accountType === 'credit_card') {
            if (dir === 'debit') {
                out.tab = 'cconetime';
                out.ccType = ccDebitType(desc);
                out.reason = 'credit-card charge';
            } else { // credit on a credit card = payment/refund toward the card
                out.tab = 'cc_payment';
                out.reason = 'payment/credit on the card (reconciliation, not income)';
            }
            return out;
        }

        if (accountType === 'bank_account') {
            if (dir === 'debit') {
                out.tab = 'expenses';
                out.category = expenseCategory(desc);
                if (out.category === 'Other') out.needsReview = true;
                out.reason = 'bank debit → expense';
            } else { // credit on a bank account
                if (isTransfer) {
                    out.tab = 'skip';
                    out.needsReview = true;
                    out.reason = 'transfer/reversal/refund — not income';
                } else {
                    out.tab = 'income';
                    out.incomeType = incomeKind(desc); // salary/interest/dividend/... or 'other' — NEVER 'investment'
                    if (out.incomeType === 'other') out.needsReview = true;
                    out.reason = 'bank credit → income (' + out.incomeType + ')';
                }
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
        incomeKind: incomeKind,
        ccDebitType: ccDebitType
    };
    root.WFRoute = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    try { if (root.console) root.console.log('[WFRoute] ✓ transaction router ready'); } catch (_) {}
})(typeof window !== 'undefined' ? window : globalThis);
