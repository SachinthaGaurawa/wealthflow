/*  wealthflow-cc-reconcile.js  —  Credit-card auto-✅ reconciliation (IMG_8884)
 *
 *  Implements EXACTLY the behaviour described in the worked example:
 *    • Both debits (cash advances / charges) AND credits (payments) are tracked.
 *    • Credits accumulate. A debit is auto-settled (✅) ONLY when the running credit
 *      pool can FULLY cover it — never partially.
 *    • Order: oldest date first; within the SAME date, the smaller amount first.
 *    • An older debit that can't be covered BLOCKS newer ones (you can't clear a
 *      newer charge while an older one is still outstanding).
 *
 *  Worked example (verified in tests):
 *    Debits: Apr20 100k, Apr20 15k, Apr25 20k, May10 50k
 *    +50k credit  → only the 15k is ✅ (50k can't cover the 100k, which blocks the rest)
 *    +100k credit → 100k ✅, then 20k ✅ (150k total covers 15k+100k+20k = 135k)
 *
 *  Exposes window.WFReconcile = { reconcileCard, parseCardSms, _dateMs }.
 *  Pure + deterministic. Run it whenever a CC credit or debit is added/scanned,
 *  then persist the returned settled flags.
 */
(function () {
    'use strict';

    // flexible date → ms (accepts ms number, ISO, "DD-MM-YYYY", "10 May 2026", Date)
    function _dateMs(v) {
        if (v == null) return 0;
        if (typeof v === 'number') return v;
        if (v instanceof Date) return v.getTime();
        var s = String(v).trim();
        // DD-MM-YYYY or DD/MM/YYYY
        var m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
        if (m) return new Date(+m[3], +m[2] - 1, +m[1]).getTime();
        var t = Date.parse(s);
        return isNaN(t) ? 0 : t;
    }

    function _amt(v) {
        var n = parseFloat(String(v == null ? 0 : v).replace(/,/g, ''));
        return isNaN(n) ? 0 : n;
    }

    /*  reconcileCard(debits, credits)
     *  debits/credits: [{ id, amount, date|dateMs|timestamp }]
     *  returns { settledIds, unsettledIds, totalCredit, leftover, detail:[{id,amount,settled,coveredBy}] }
     */
    function reconcileCard(debits, credits) {
        debits = Array.isArray(debits) ? debits : [];
        credits = Array.isArray(credits) ? credits : [];

        var totalCredit = credits.reduce(function (s, c) { return s + Math.max(0, _amt(c.amount)); }, 0);

        var sorted = debits
            .filter(function (d) { return d && _amt(d.amount) > 0; })
            .map(function (d) { return { ref: d, t: _dateMs(d.dateMs != null ? d.dateMs : (d.timestamp != null ? d.timestamp : d.date)), amt: _amt(d.amount) }; })
            // oldest date first; smaller amount first within the same date
            .sort(function (a, b) { return a.t - b.t || a.amt - b.amt; });

        var pool = totalCredit;
        var blocked = false;
        var detail = [], settledIds = [], unsettledIds = [];

        for (var i = 0; i < sorted.length; i++) {
            var d = sorted[i];
            if (!blocked && pool >= d.amt - 0.005) {
                pool -= d.amt;
                settledIds.push(d.ref.id);
                detail.push({ id: d.ref.id, amount: d.amt, settled: true, coveredBy: d.amt });
            } else {
                // first uncoverable debit blocks everything newer than it
                blocked = true;
                unsettledIds.push(d.ref.id);
                detail.push({ id: d.ref.id, amount: d.amt, settled: false, coveredBy: 0 });
            }
        }
        return {
            settledIds: settledIds,
            unsettledIds: unsettledIds,
            totalCredit: Number(totalCredit.toFixed(2)),
            leftover: Number(Math.max(0, pool).toFixed(2)),
            detail: detail
        };
    }

    /*  parseCardSms(text) → { type:'debit'|'credit', amount, cardLast4, date|null, merchant|null, isCashAdvance, availableBalance|null } | null
     *
     *  Format-AGNOSTIC: the two Sri Lankan examples below are only samples. This
     *  recognises a wide range of bank card SMS — many debit/credit verbs, card-mask
     *  styles (376657*****0276 · ****0276 · ending 0276 · Card No xxxx0276), currencies
     *  (LKR/Rs/USD/$), and date styles (03-06-2026 · 2026-06-03 · 03/06/26 · 03 Jun 2026 · 03-Jun-2026).
     *    debit : "Transaction Approved on your Card 376657*****0276 for LKR 24000.00 at Cash advance from MB Available Bal LKR 131561.38"
     *    credit: "Thank you for your payment of LKR 20,000.00 made to Card # 376657*****0276 on 03-06-2026."
     */
    function parseCardSms(text) {
        if (!text) return null;
        var s = String(text).replace(/\s+/g, ' ').trim();
        if (!/card|credit|debit|payment|transaction|spent|withdraw|cash advance|pos\b/i.test(s)) return null;

        // ---- card last 4 (many mask styles) ----
        var cardLast4 = null;
        var cm = s.match(/\b\d{4,6}[*xX•·]{2,}\s*(\d{4})\b/)                       // 376657*****0276
            || s.match(/(?:ending|ends|end)\s*(?:in|with)?\s*[:#]?\s*(\d{4})\b/i)  // ending in 0276
            || s.match(/card\s*(?:no\.?|number|#|:)?\s*[xX*•·\d\s-]*?(\d{4})\b/i)  // Card No xxxx0276 / Card # ...0276
            || s.match(/[xX*•·]{2,}\s*(\d{4})\b/);                                 // ****0276
        if (cm) cardLast4 = cm[1];

        // ---- available balance (optional) ----
        var availM = s.match(/Av(?:ailable|l)\.?\s*Bal(?:ance)?\.?\s*(?:is)?\s*[:.]?\s*(?:LKR|Rs\.?|USD|\$)?\s*([\d,]+\.?\d*)/i);
        var availableBalance = availM ? _amt(availM[1]) : null;

        // ---- date (keep raw; the caller normalises) ----
        var dateRaw = null;
        var dm = s.match(/\b(?:on|dated|date)\s*[:]?\s*(\d{1,2}[-/]\d{1,2}[-/]\d{2,4})\b/i)      // on 03-06-2026 / 03/06/26
            || s.match(/\b(?:on|dated|date)\s*[:]?\s*(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b/i)          // on 2026-06-03
            || s.match(/\b(?:on|dated|date)\s*[:]?\s*(\d{1,2}[-\s][A-Za-z]{3,9}[-\s]\d{2,4})\b/i)// 03 Jun 2026 / 03-Jun-2026
            || s.match(/\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b/);
        if (dm) dateRaw = dm[1];

        function amtNear(re) { var m = s.match(re); return m ? _amt(m[1]) : null; }
        var anyAmt = /(?:LKR|Rs\.?|USD|INR|\$)\s*([\d,]+\.?\d*)/i;

        // ---- direction detection ----
        var creditRe = /(thank you for your payment|payment\s+of|payment\s+received|received\s+with\s+thanks|amount\s+credited|has\s+been\s+credited|credited\s+(?:to|with)|\bcredited\b|re-?payment|reversal|refund(?:ed)?|cash\s*payment\s*finacle)/i;
        var debitRe = /(transaction\s+approved|approved\s+on\s+your\s+card|debited|debit\s+of|\bspent\b|\bcharged\b|withdraw(?:n|al)?|cash\s+advance|cash\s+adv|\bpurchase\b|\bpos\b|txn\s+of|spent\s+at|paid\s+at|used\s+(?:at|for))/i;
        var isCredit = creditRe.test(s);
        var isDebit = debitRe.test(s);
        // "payment ... made TO (your) card" → credit even though it says "payment"
        if (/payment[^.]*\b(?:made\s+)?to\s+(?:your\s+)?card/i.test(s)) { isCredit = true; isDebit = false; }
        // a "payment ... at <merchant>" is a purchase (debit)
        if (/payment\s+(?:of\s+[\d.,]+\s+)?at\s+/i.test(s)) { isDebit = true; isCredit = false; }

        // ---- CREDIT (money INTO the card) ----
        if (isCredit && !isDebit) {
            var camt = amtNear(/(?:payment\s+of|credited\s*(?:with|by)?|received|refund(?:ed)?\s*(?:of)?|reversal\s*(?:of)?|amount)\s*(?:LKR|Rs\.?|USD|INR|\$)?\s*([\d,]+\.?\d*)/i) || amtNear(anyAmt);
            return { type: 'credit', amount: camt, cardLast4: cardLast4, date: dateRaw, merchant: null, isCashAdvance: false, availableBalance: availableBalance };
        }

        // ---- DEBIT (money OUT of the card) — capture amount + merchant ----
        var debM = s.match(/(?:for|of)\s*(?:LKR|Rs\.?|USD|INR|\$)?\s*([\d,]+\.?\d*)\s*(?:at|to|in|towards)\s+(.+?)(?:\s+Av(?:ailable|l)\.?\s*Bal|\.\s|\.$|\s+Call\b|$)/i);
        var damt = debM ? _amt(debM[1]) : amtNear(/(?:spent|debited|charged|withdrawn|purchase\s+of|txn\s+of|for|of)\s*(?:LKR|Rs\.?|USD|INR|\$)?\s*([\d,]+\.?\d*)/i);
        if (damt == null) damt = amtNear(anyAmt);
        if (damt == null) return null;
        return {
            type: 'debit', amount: damt, cardLast4: cardLast4, date: dateRaw,
            merchant: debM ? debM[2].trim() : null,
            isCashAdvance: /cash\s+advance|cash\s+adv|\batm\b/i.test(s),
            availableBalance: availableBalance
        };
    }

    window.WFReconcile = { reconcileCard: reconcileCard, parseCardSms: parseCardSms, _dateMs: _dateMs };
    try { console.log('[WFReconcile] ✓ credit-card auto-✅ reconciliation ready'); } catch (_) {}
})();
