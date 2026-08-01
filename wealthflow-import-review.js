/* =============================================================================
 *  WealthFlow — Import Review Queue   ·   window.WFImportReview
 *  Implements the accepted proposal in issue #48.
 * -----------------------------------------------------------------------------
 *  WHAT THIS IS FOR
 *
 *  wealthflow-statement-parser.js already decides, per row, how far it should be
 *  trusted, and says so: `valid`, `balanceVerified` (did the bank's own running
 *  balance confirm this amount), `directionSource` (balance · marker · column ·
 *  sign · keyword · assumed) and `needsReview`. wealthflow-statement-router.js
 *  adds `confidence` and deliberately propagates upstream doubt rather than
 *  letting a confident category paper over an unverified amount.
 *
 *  None of it ever reached a screen. Every imported row arrived looking equally
 *  certain — a row whose direction was openly ASSUMED presented exactly like one
 *  the bank's arithmetic confirmed to the cent. The accuracy work was real and
 *  invisible, so a user could only trust everything or check everything.
 *
 *  That is this repository's signature failure, found for the fifth time:
 *  machinery present, signal absent. imageSection() rendered screenshots nobody
 *  sent it; /api/feedback-triage classified reports it then dropped; the tile()
 *  renderer styled buttons that were not buttons. Same shape every time — the
 *  work was done and the output discarded.
 *
 *  WHAT IT DOES NOT DO
 *
 *  It does not re-parse, re-classify, or second-guess anything. Every field it
 *  reads already exists and is already under test. It sorts rows by the evidence
 *  they arrived with, states each doubt in words a person can act on, and groups
 *  identical doubts so a statement with forty assumed rows is one decision
 *  rather than forty.
 *
 *  It also never silently drops a row: `accept.length + review.length` always
 *  equals the number of rows it was given. A queue that loses a transaction on
 *  the way to being reviewed would be worse than no queue at all.
 * ========================================================================== */
(function () {
    var W = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_IMPORT_REVIEW === '1.0') return;
    W.WF_IMPORT_REVIEW = '1.0';

    /**
     * The router's own review threshold, not a new invention. 0.75 is the value
     * wealthflow-statement-router.js already uses and the fixtures already
     * exercise, so the queue starts out agreeing with the routing it inherits.
     */
    var THRESHOLD = 0.75;

    /** Stable ids so the UI can group, count and bulk-resolve by cause. */
    var DOUBT = {
        unreadable:   'unreadable',
        no_amount:    'no_amount',
        no_direction: 'no_direction',
        assumed:      'assumed_direction',
        flagged:      'flagged_upstream',
        low_category: 'low_confidence_category',
    };

    function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    function pct(c) { return Math.round(num(c) * 100); }

    /**
     * Why this row cannot be committed unseen — in words the user can act on.
     * Returns null when the evidence is good enough to accept.
     *
     * Ordered by severity: an unreadable line is a worse problem than a
     * confidently-parsed amount with an uncertain CATEGORY, and reporting the
     * lesser one first would bury the real fault.
     */
    function doubtOf(row, opts) {
        var r = row || {};
        var threshold = (opts && typeof opts.threshold === 'number') ? opts.threshold : THRESHOLD;

        if (num(r.amount) === 0) {
            return { id: DOUBT.no_amount, text: 'no amount could be read from this line' };
        }
        if (r.direction !== undefined && !r.direction) {
            // The parser refuses to guess when a statement gives it nothing to
            // go on — one amount column, no previous balance, no CR/DR marker.
            // Fixture E asserts exactly this rather than guessing "debit" and
            // being right 80% of the time. The queue is where that honesty pays.
            return { id: DOUBT.no_direction, text: 'the statement does not say whether this was money in or out' };
        }
        // The generic catch-all sits AFTER the specific causes on purpose. The
        // parser marks a row invalid when it could not settle the direction, so
        // testing `valid` first reported "this line could not be read" for
        // fixture E's first row — whose date, narration and amount were all read
        // perfectly. Burying the actionable reason under a vague one is how a
        // review queue becomes something people stop reading.
        if (r.valid === false) {
            return { id: DOUBT.unreadable, text: 'this line could not be read as a transaction' };
        }
        if (r.directionSource === 'assumed') {
            return { id: DOUBT.assumed, text: 'no running balance and no CR/DR marker, so money in vs money out was assumed' };
        }
        if (r.needsReview === true) {
            return { id: DOUBT.flagged, text: 'the parser flagged this row as needing a look' };
        }
        if (typeof r.confidence === 'number' && r.confidence < threshold) {
            return { id: DOUBT.low_category, text: 'the category is a guess (' + pct(r.confidence) + '% confident)' };
        }
        return null;
    }

    /** A one-line statement of why a row IS trustworthy, for the accepted list. */
    function evidenceOf(row) {
        var r = row || {};
        if (r.balanceVerified === true) return 'the running balance confirms this amount';
        if (r.directionSource === 'marker') return 'the statement prints a CR/DR marker';
        if (r.directionSource === 'column') return 'the amount sits in the debit or credit column';
        if (r.directionSource === 'balance') return 'derived from the running balance';
        if (r.directionSource === 'sign') return 'the amount carries its own sign';
        return 'no doubt was raised';
    }

    /**
     * Split rows into what can be committed and what a person should see.
     *
     * @param {Array} rows   parser rows, optionally merged with router output
     * @param {{threshold?:number}} [opts]
     * @returns {{accept:Array,review:Array,summary:Object}}
     */
    function triage(rows, opts) {
        var list = Array.isArray(rows) ? rows : [];
        var out = {
            accept: [], review: [],
            summary: { total: list.length, accepted: 0, needsReview: 0, byReason: {}, verified: 0 },
        };

        for (var i = 0; i < list.length; i++) {
            var row = list[i];
            var d = doubtOf(row, opts);
            if (d) {
                out.review.push({ row: row, index: i, doubt: d.text, reason: d.id, amount: Math.abs(num(row && row.amount)) });
                out.summary.needsReview += 1;
                var slot = out.summary.byReason[d.id] || (out.summary.byReason[d.id] = { n: 0, text: d.text });
                slot.n += 1;
            } else {
                out.accept.push({ row: row, index: i, evidence: evidenceOf(row), amount: Math.abs(num(row && row.amount)) });
                out.summary.accepted += 1;
                if (row && row.balanceVerified === true) out.summary.verified += 1;
            }
        }
        return out;
    }

    /**
     * What the whole-statement arithmetic says, which no per-row check can know.
     *
     * A per-row check compares a row against its neighbours, so it cannot notice
     * a row that was never parsed AT ALL. The identity opening + credits −
     * debits = closing can: if a transaction is missing, the totals stop adding
     * up. Surfacing it before commit is the only chance to catch that.
     */
    function reconciliationNote(parsed) {
        var rc = parsed && parsed.reconciliation;
        if (!rc) return null;
        if (rc.ok === true) {
            return { level: 'ok', text: 'The rows add up: opening + credits − debits matches the closing balance.' };
        }
        if (rc.ok === false) {
            return { level: 'warn', text: 'These rows do not explain the closing balance — off by '
                + Math.abs(Math.round(num(rc.difference))) + '. A transaction may be missing or misread.' };
        }
        // ok === null. Saying "unknown" is the honest answer; claiming a pass
        // here would be a check that always passes, which is worse than none.
        return { level: 'unknown', text: 'No opening balance was printed, so the totals cannot be cross-checked.' };
    }

    /**
     * Record a human's decision, and teach the classifier from it.
     *
     * Point 4 of the proposal, and the reason the queue makes accuracy compound
     * instead of staying flat: WFMerchants already keeps a learned store keyed
     * by merchant, consulted at classify() step 3 with confidence 0.97. A
     * correction made here writes to it, so the same statement layout is right
     * next month without being asked again.
     *
     * `learn()` is called with no confidence argument on purpose — its write
     * gate lets a null through as certain, which is the correct reading of a
     * human confirming something by hand.
     *
     * THE RETURN VALUE IS VERIFIED, NOT ASSUMED. learn() declines silently when
     * the category is outside its taxonomy, so "I called learn(), therefore it
     * worked" would report success for work that did not happen — the precise
     * failure this repository keeps digging out of itself. The learned store is
     * read back through WFMerchants.export() and the key must actually be there.
     *
     * @returns {boolean} whether the correction was actually stored. False is a
     *   real answer (classifier absent, or category outside its taxonomy) and
     *   the caller must not report success for it.
     */
    function teach(desc, tab, category) {
        try {
            if (!desc || !category) return false;
            var M = W.WFMerchants;
            if (!M || typeof M.learn !== 'function') return false;
            M.learn(String(desc), tab || '', String(category));

            if (typeof M.export !== 'function' || typeof M.merchantKey !== 'function') return false;
            var key = M.merchantKey(String(desc));
            var store = M.export() || {};
            var got = key && store[key];
            return !!(got && got.category === String(category));
        } catch (_) { return false; }
    }

    W.WFImportReview = {
        THRESHOLD: THRESHOLD, DOUBT: DOUBT,
        doubtOf: doubtOf, evidenceOf: evidenceOf, triage: triage,
        reconciliationNote: reconciliationNote, teach: teach,
        VERSION: '1.0',
    };
    try { console.log('[WFImportReview] v1.0 loaded'); } catch (_) {}
})();
