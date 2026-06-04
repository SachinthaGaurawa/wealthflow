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

    /*  parseCardSms(text) → { type:'debit'|'credit', amount, cardLast4, date|null, merchant|null, availableBalance|null } | null
     *  Handles the two real Sri Lankan card SMS formats supplied:
     *    debit : "Transaction Approved on your Card 376657*****0276 for LKR 24000.00 at Cash advance from MB Available Bal LKR 131561.38"
     *    credit: "Thank you for your payment of LKR 20,000.00 made to Card # 376657*****0276 on 03-06-2026."
     */
    function parseCardSms(text) {
        if (!text) return null;
        var s = String(text);
        var cardM = s.match(/Card\s*#?\s*(\d{4,6}\*+\d{4})/i);
        var cardLast4 = cardM ? cardM[1].slice(-4) : null;

        // CREDIT — a payment made TO the card
        var payM = s.match(/payment of\s*(?:LKR|Rs\.?|USD|\$)?\s*([\d,]+\.?\d*)/i);
        if (payM) {
            var dM = s.match(/on\s+(\d{1,2}[-/]\d{1,2}[-/]\d{4})/i);
            return {
                type: 'credit',
                amount: _amt(payM[1]),
                cardLast4: cardLast4,
                date: dM ? dM[1] : null,
                merchant: null,
                availableBalance: null
            };
        }

        // DEBIT — a charge / cash advance FROM the card
        var debM = s.match(/(?:for|of)\s*(?:LKR|Rs\.?|USD|\$)?\s*([\d,]+\.?\d*)\s*at\s+(.+?)(?:\s+Available\s+Bal|\.|$)/i);
        if (/Transaction Approved/i.test(s) || debM) {
            var amtM = debM ? debM[1] : (s.match(/(?:for|of)\s*(?:LKR|Rs\.?|USD|\$)?\s*([\d,]+\.?\d*)/i) || [])[1];
            var availM = s.match(/Available\s+Bal(?:ance)?\s*(?:LKR|Rs\.?)?\s*([\d,]+\.?\d*)/i);
            return {
                type: 'debit',
                amount: _amt(amtM),
                cardLast4: cardLast4,
                date: null,                                  // debit SMS carries no txn date → caller uses receipt time
                merchant: debM ? debM[2].trim() : null,
                isCashAdvance: /cash advance/i.test(s),
                availableBalance: availM ? _amt(availM[1]) : null
            };
        }
        return null;
    }

    window.WFReconcile = { reconcileCard: reconcileCard, parseCardSms: parseCardSms, _dateMs: _dateMs };
    try { console.log('[WFReconcile] ✓ credit-card auto-✅ reconciliation ready'); } catch (_) {}
})();
