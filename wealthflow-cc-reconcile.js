/*  wealthflow-cc-reconcile.js  —  Credit-card auto-@checkCircle@ reconciliation: card payments settle charges OLDEST FIRST, to the cent
 *
 *  The rule (the same one the worker applies — cc-fifo.mjs; test/cc_fifo_test.js keeps the two equal):
 *    • Every payment made to a card goes into ONE pool (the sum of the credits). Charges are walked from the oldest date to the newest
 *      (the smaller amount first within the same date).
 *    • A charge is auto-settled (@checkCircle@) ONLY when the pool can FULLY cover it — never partially — and the pool shrinks by its amount.
 *    • The first charge the pool cannot cover FREEZES the walk: it and every newer charge stay unpaid (Pending / Overdue). What is left in the
 *      pool is CARRIED forward (`carry`), together with how much more the frozen charge needs (`blocked.needs`).
 *    • It is recomputed from the whole timeline on every change, never patched, so the answer never depends on the order things arrived in.
 *    • EXACT ARITHMETIC: amounts become integer cents from their decimal text (never through a binary float) and only integers are added and
 *      compared — no 0.005 tolerance, no drift however many rows pass through the pool.
 *
 *  Worked example (verified in tests):
 *    Debits: Apr20 100k, Apr20 15k, Apr25 20k, May10 50k
 *    +50k credit  → only the 15k is @checkCircle@ (50k can't cover the 100k, which blocks the rest); 35k is carried, the 100k needs 65k more
 *    +100k credit → 100k @checkCircle@, then 20k @checkCircle@ (150k total covers 15k+100k+20k = 135k); 15k carried
 *
 *  Exposes window.WFReconcile = { reconcileCard, parseCardSms, toCents, fromCents, _dateMs }.
 *  Pure + deterministic. Run it whenever a CC credit or debit is added/scanned, then persist the returned settled flags.
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

    // A decimal amount (number or text) as whole cents, half a cent rounded up, read from the decimal text — never through float arithmetic.
    function toCents(value) {
        if (value == null || value === '') return 0;
        var text = typeof value === 'number' ? (isFinite(value) ? String(value) : '') : String(value);
        if (/e/i.test(text)) text = Number(text).toFixed(6);
        text = text.replace(/,/g, '').trim();
        var m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(text);
        if (!m || (m[2] === '' && (m[3] === undefined || m[3] === ''))) return 0;
        var whole = m[2] === '' ? '0' : m[2], frac = (m[3] || '');
        while (frac.length < 3) frac += '0';
        var cents = Number(whole) * 100 + Number(frac.slice(0, 2));
        if (Number(frac.charAt(2)) >= 5) cents += 1;
        return m[1] === '-' ? -cents : cents;
    }
    function fromCents(cents) {
        var n = Math.round(Number(cents) || 0), sign = n < 0 ? '-' : '', abs = Math.abs(n), r = String(abs % 100);
        return sign + Math.floor(abs / 100) + '.' + (r.length < 2 ? '0' + r : r);
    }

    /*  reconcileCard(debits, credits)
     *  debits/credits: [{ id, amount, date|dateMs|timestamp }]
     *  returns { settledIds, unsettledIds, totalCredit, leftover, carry, blocked:{id,amount,needs}|null, detail:[{id,amount,settled,state,coveredBy,needs}] }
     *  (amounts as numbers with two decimals, derived from exact integer cents)
     */
    function reconcileCard(debits, credits) {
        debits = Array.isArray(debits) ? debits : [];
        credits = Array.isArray(credits) ? credits : [];

        var creditCents = credits.reduce(function (s, c) { return s + Math.max(0, toCents(c && c.amount)); }, 0);

        var sorted = debits
            .map(function (d, order) { return { ref: d, order: order, t: _dateMs(d && (d.dateMs != null ? d.dateMs : (d.timestamp != null ? d.timestamp : d.date))), cents: toCents(d && d.amount) }; })
            .filter(function (x) { return x.ref && x.cents > 0; })
            // oldest date first; smaller amount first within the same date; then the order given
            .sort(function (a, b) { return a.t - b.t || a.cents - b.cents || a.order - b.order; });

        var pool = creditCents;
        var blocked = null;
        var detail = [], settledIds = [], unsettledIds = [];

        for (var i = 0; i < sorted.length; i++) {
            var d = sorted[i];
            if (!blocked && pool >= d.cents) {
                pool -= d.cents;
                settledIds.push(d.ref.id);
                detail.push({ id: d.ref.id, amount: d.cents / 100, settled: true, state: 'paid', coveredBy: d.cents / 100, needs: 0 });
            } else {
                // the first charge the pool cannot cover freezes the walk: it and everything newer wait
                if (!blocked) blocked = { id: d.ref.id, cents: d.cents, needsCents: d.cents - pool };
                unsettledIds.push(d.ref.id);
                detail.push({ id: d.ref.id, amount: d.cents / 100, settled: false, state: d.ref.id === blocked.id ? 'blocked' : 'waiting', coveredBy: 0, needs: d.ref.id === blocked.id ? blocked.needsCents / 100 : 0 });
            }
        }
        return {
            settledIds: settledIds,
            unsettledIds: unsettledIds,
            totalCredit: creditCents / 100,
            leftover: pool / 100,
            carry: pool / 100,
            blocked: blocked && { id: blocked.id, amount: blocked.cents / 100, needs: blocked.needsCents / 100 },
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

    window.WFReconcile = { reconcileCard: reconcileCard, parseCardSms: parseCardSms, toCents: toCents, fromCents: fromCents, _dateMs: _dateMs };
    try { console.log('[WFReconcile] @info@ credit-card auto-@checkCircle@ reconciliation ready'); } catch (_) {}
})();
