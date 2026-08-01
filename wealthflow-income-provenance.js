/* =============================================================================
 *  WealthFlow — Income Provenance   ·   window.WFIncomeProvenance
 *  Implements the accepted proposal in issue #47.
 * -----------------------------------------------------------------------------
 *  WHAT PROBLEM THIS SOLVES
 *
 *  Issue #46 was filed because the dashboard showed LKR 0.00 of income beside
 *  LKR 3,464,337 of spending. The number was HONEST — Year Income reads
 *  `incomeRecv` (money actually received) and the Investments store is excluded
 *  on purpose so the same money is not counted twice — but a figure you cannot
 *  interrogate is indistinguishable from a broken one.
 *
 *  Worse, the two ways money becomes income disagreed with each other:
 *
 *    · by hand — `incomeRecv` is a store somebody has to remember to fill, so
 *      it sits empty and income reads zero;
 *    · by import — every credit was filed as income (fixed in #49), so the
 *      moment a statement was imported the figure would read too HIGH, because
 *      refunds and transfers between your own accounts counted as earnings.
 *
 *  Zero, then over-counted. The truth was never on either side of that.
 *
 *  THE APPROACH: POLICY, SEPARATE FROM DETECTION
 *
 *  wealthflow-merchants.js answers "what KIND of credit is this?" — salary,
 *  refund, internal transfer, loan drawdown, investment return, unknown. That is
 *  detection, and it already exists and is tested.
 *
 *  This module answers a different question: "given that kind, does it COUNT as
 *  income, and can you show me the arithmetic?" That is policy, and keeping it
 *  here means the two never drift: there is exactly one place that decides what
 *  income means, and it can be read in one screenful.
 *
 *  Every figure it produces carries its own derivation. Nothing is asserted
 *  without a stated reason, because "trust me" is what the old number did.
 *
 *  DEGRADES HONESTLY
 *  If wealthflow-merchants.js has not loaded, detection is unavailable and every
 *  imported row resolves to `unknown` — which does NOT count, and says so. It
 *  never guesses in order to produce a bigger number.
 * ========================================================================== */
(function () {
    var W = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_INCOME_PROV === '1.0') return;
    W.WF_INCOME_PROV = '1.0';

    /**
     * The taxonomy. `counts` is the policy decision, and it is deliberately
     * conservative: a kind counts only when something positively identified it
     * as earnings. Everything else is excluded WITH A REASON rather than
     * silently folded into a total.
     */
    var KINDS = {
        salary:            { counts: true,  label: 'Salary / payroll' },
        investment_return: { counts: true,  label: 'Investment return' },
        gift:              { counts: true,  label: 'Gift received' },
        refund:            { counts: false, label: 'Refund / reversal',
            why: 'money coming back reduces the expense it came from — counting it again would show the same money twice' },
        internal_transfer: { counts: false, label: 'Transfer between your own accounts',
            why: 'the same money moving, not new money' },
        loan_drawdown:     { counts: false, label: 'Loan drawdown',
            why: 'borrowed, not earned — it is a liability, and the repayments are already tracked' },
        unknown:           { counts: false, label: 'Unidentified credit',
            why: 'nothing in the text says what kind of money this is' },
    };

    /** Kinds that can never count, however the row was created. */
    var NEVER = { refund: 1, internal_transfer: 1, loan_drawdown: 1 };

    function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    function str(v) { return String(v == null ? '' : v); }

    /** Everything a row might call its description. */
    function textOf(row) {
        if (!row) return '';
        return str(row.name || row.description || row.narration || row.desc || row.notes || '');
    }

    /** What the user typed in the Income page's Type field, normalised. */
    function declaredKind(row) {
        var t = str(row && row.type).toLowerCase().trim();
        if (!t) return '';
        if (/salary|payroll|wage/.test(t)) return 'salary';
        if (/dividend|interest|invest|return|maturity/.test(t)) return 'investment_return';
        if (/gift|donation/.test(t)) return 'gift';
        if (/refund|reversal|cash ?back/.test(t)) return 'refund';
        if (/transfer/.test(t)) return 'internal_transfer';
        if (/loan/.test(t)) return 'loan_drawdown';
        return '';
    }

    /**
     * Ask wealthflow-merchants.js what kind of credit this text is.
     * Returns '' when the detector is unavailable — never a guess.
     */
    function detectKind(text) {
        try {
            if (W.WFMerchants && typeof W.WFMerchants.classify === 'function') {
                var c = W.WFMerchants.classify(text, 'credit');
                if (c && c.creditKind) return c.creditKind;
            }
        } catch (_) { /* detector unavailable → unknown, not a guess */ }
        return '';
    }

    /**
     * Resolve one row to a provenance decision.
     *
     * Precedence, strongest evidence first:
     *   1. a kind that can NEVER be income wins outright, however it was found —
     *      a refund typed in by hand is still a refund;
     *   2. what the user explicitly declared on the Income page;
     *   3. what the detector reads from the text;
     *   4. otherwise unknown, which does not count.
     *
     * @returns {{kind:string,counts:boolean,amount:number,reason:string,source:string}}
     */
    function classifyRow(row) {
        var r = row || {};
        var amount = Math.abs(num(r.amount != null ? r.amount : r.combinedTotal));
        var declared = declaredKind(r);
        var detected = detectKind(textOf(r));
        var manual = str(r.source).toLowerCase() === 'manual';

        var kind = 'unknown', source = 'none';
        if (declared && NEVER[declared]) { kind = declared; source = 'declared'; }
        else if (detected && NEVER[detected]) { kind = detected; source = 'detected'; }
        else if (declared) { kind = declared; source = 'declared'; }
        else if (detected) { kind = detected; source = 'detected'; }

        var meta = KINDS[kind] || KINDS.unknown;
        var counts = !!meta.counts;
        var reason;

        if (NEVER[kind]) {
            counts = false;
            reason = meta.label + ' — ' + meta.why;
        } else if (r.received === false) {
            // The store is called "Received income" and each row carries a
            // received flag that nothing ever read. A figure that answers "how
            // much have I actually been paid" must not include money that has
            // not arrived. Only an explicit false excludes — legacy rows with
            // the flag missing are untouched.
            counts = false;
            reason = 'not marked received yet';
        } else if (counts) {
            reason = meta.label + (source === 'declared' ? ' — you entered this on the Income page' : ' — identified from the description');
        } else if (manual) {
            // Entered by hand on the Income page and not excluded above: the
            // user asserting it outranks the detector failing to recognise it.
            counts = true;
            kind = kind === 'unknown' ? 'declared_income' : kind;
            reason = 'you entered this on the Income page';
        } else {
            reason = meta.label + ' — ' + (meta.why || 'not counted');
        }

        return { kind: kind, counts: counts, amount: amount, reason: reason, source: source };
    }

    /** Four-digit year of whichever date field the row carries. */
    function yearOf(row) {
        return str(row && (row.date || row.month || row.createdAt)).slice(0, 4);
    }

    /**
     * Derive received income from a set of rows, with the arithmetic attached.
     *
     * @param {Array} rows
     * @param {{year?:string|number}} [opts]  restrict to a calendar year
     * @returns {{total:number,counted:Array,excluded:Array,byKind:Object,
     *            excludedTotal:number,needsReview:number,year:(string|null)}}
     */
    function derive(rows, opts) {
        var o = opts || {};
        var year = o.year != null ? String(o.year) : null;
        var list = Array.isArray(rows) ? rows : [];
        var out = { total: 0, counted: [], excluded: [], byKind: {}, excludedTotal: 0, needsReview: 0, year: year };

        for (var i = 0; i < list.length; i++) {
            var row = list[i];
            if (year && yearOf(row) !== year) continue;
            var d = classifyRow(row);
            var slot = out.byKind[d.kind] || (out.byKind[d.kind] = { n: 0, total: 0, counts: d.counts });
            slot.n += 1; slot.total += d.amount;

            var entry = { row: row, kind: d.kind, amount: d.amount, reason: d.reason };
            if (d.counts) { out.total += d.amount; out.counted.push(entry); }
            else {
                out.excluded.push(entry);
                out.excludedTotal += d.amount;
                if (d.kind === 'unknown') out.needsReview += 1;
            }
        }
        return out;
    }

    /**
     * The derivation as lines a human can read. This is the whole point: the
     * previous income figure could not be interrogated, so a user could not tell
     * "correct and surprising" from "broken".
     */
    function explain(d) {
        if (!d) return [];
        var lines = [];
        lines.push(d.counted.length
            ? ('Counted ' + d.counted.length + ' credit' + (d.counted.length === 1 ? '' : 's') + ' as income.')
            : 'Nothing counted as income.');
        var kinds = Object.keys(d.byKind);
        for (var i = 0; i < kinds.length; i++) {
            var k = kinds[i], s = d.byKind[k];
            var meta = KINDS[k] || { label: k };
            lines.push((s.counts ? '✓ ' : '✕ ') + (meta.label || k) + ': ' + s.n + ' · ' + Math.round(s.total)
                + (s.counts ? '' : (meta.why ? ' — ' + meta.why : '')));
        }
        if (d.needsReview) {
            lines.push(d.needsReview + ' credit' + (d.needsReview === 1 ? '' : 's')
                + ' could not be identified and were left out rather than guessed at.');
        }
        return lines;
    }

    W.WFIncomeProvenance = {
        KINDS: KINDS, classifyRow: classifyRow, derive: derive, explain: explain,
        textOf: textOf, declaredKind: declaredKind, yearOf: yearOf, VERSION: '1.0',
    };
    try { console.log('[WFIncomeProvenance] v1.0 loaded'); } catch (_) {}
})();
