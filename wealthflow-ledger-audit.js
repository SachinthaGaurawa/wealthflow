/* =============================================================================
 * WealthFlow — Ledger Audit  (Step 2: Ledger Trust)
 * -----------------------------------------------------------------------------
 * READ-ONLY. This module never writes a record. It walks the ledger, asks the
 * merchant table what each row WOULD be classified as today, and reports where
 * that disagrees with what is stored. Applying a change is a separate, explicit,
 * one-at-a-time act by the user through the review flow.
 *
 * WHY IT EXISTS
 *
 * Until #131 the app held several different category vocabularies, and which one
 * a transaction got depended on how it entered: a statement import went through
 * WFMerchants, a photographed receipt used a private list of eight, the nightly
 * merchant sync gated on a list missing Cash Advance, and the routing table
 * emitted names — Gift, Entertainment, Transfer — that existed nowhere else.
 *
 * #131 made those agree. It did NOT retroactively fix rows already filed under
 * the old names, and nobody knows how many there are. That number is the cost of
 * the fragmentation, and this is the instrument that measures it.
 *
 * WHAT IT REPORTS
 *
 *   drifted    stored category is not a category this app has any more
 *   changed    stored is valid, but the classifier now says something else
 *   agreed     stored matches what the classifier says today
 *   unknown    the classifier has no opinion — nothing to compare
 *
 * A "changed" row is NOT automatically wrong. The user may have deliberately
 * overridden the classifier, and that override is the more authoritative of the
 * two. This is why nothing is applied without being confirmed: the audit finds
 * candidates, a person decides.
 *
 * WHY IT IS CHUNKED
 *
 * A full ledger can be thousands of rows and refine() is not free — profiling
 * during the crash sweep found classify() taking a large share of the main
 * thread on a big import. Walking the ledger synchronously would freeze the app
 * exactly like the 301,015-node render did. Work runs in slices with a yield
 * between them, and the walk is abandonable.
 * ===========================================================================*/
(function () {
    'use strict';

    var VERSION = '1.0.0';
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});

    /* Record arrays that carry a user-visible category, and the field it lives
     * in. Kept explicit rather than derived from _WF_RECORD_KEYS: most record
     * types have no category at all, and auditing them would produce noise that
     * looks like findings. */
    var AUDITED = [
        { key: 'expenses',      field: 'cat',      label: 'Expenses' },
        { key: 'subscriptions', field: 'category', label: 'Subscriptions' },
        { key: 'cconetime',     field: 'cat',      label: 'Card one-time charges' }
    ];

    var SLICE = 120;          // rows per slice — small enough to stay off the frame budget
    var HARD_CAP = 20000;     // refuse to walk a ledger larger than this in one pass

    function M() { try { return W.WFMerchants; } catch (_) { return null; } }
    function DB() { try { return W.DB; } catch (_) { return null; } }

    function canonical() {
        var m = M();
        var c = m && m.CATEGORIES;
        return (Array.isArray(c) && c.length) ? c : null;
    }

    function rows(key) {
        try {
            var a = DB() && DB().get(key, []);
            return Array.isArray(a) ? a : [];
        } catch (_) { return []; }
    }

    function descOf(r) {
        if (!r || typeof r !== 'object') return '';
        return String(r.desc || r.description || r.name || r.merchant || r.vendor || '');
    }

    /* What the classifier says about this row TODAY. Returns null when it has no
     * opinion, which is different from "it says Other" — the first is silence,
     * the second is an answer, and conflating them would manufacture findings. */
    function computed(r) {
        var m = M();
        if (!m || typeof m.refine !== 'function') return null;
        var d = descOf(r);
        if (!d || d.length < 2) return null;
        try {
            var out = m.refine(d, 'debit', { tab: 'expenses' });
            var c = out && (out.category || (out.fields && out.fields.cat));
            return c || null;
        } catch (_) { return null; }
    }

    function yieldSlice() {
        return new Promise(function (resolve) {
            if (typeof W.requestIdleCallback === 'function') W.requestIdleCallback(function () { resolve(); }, { timeout: 60 });
            else setTimeout(resolve, 0);
        });
    }

    var _running = false;
    var _abort = false;

    /**
     * Walk the ledger. Resolves with a report; writes nothing.
     * onProgress({done, total}) is called between slices.
     */
    async function run(opts) {
        opts = opts || {};
        if (_running) return { ok: false, reason: 'an audit is already running' };
        var CANON = canonical();
        if (!CANON) return { ok: false, reason: 'WFMerchants is not loaded — nothing to compare against' };

        _running = true; _abort = false;
        var report = {
            version: VERSION,
            at: new Date().toISOString(),
            canonicalCount: CANON.length,
            totals: { scanned: 0, agreed: 0, changed: 0, drifted: 0, unknown: 0 },
            byKey: {},
            drifted: [],          // stored under a name the app no longer has
            changed: [],          // stored is valid, classifier now disagrees
            vocabulary: {}        // every stored category seen -> count
        };

        try {
            var total = 0;
            AUDITED.forEach(function (spec) { total += rows(spec.key).length; });
            if (total > HARD_CAP) {
                return { ok: false, reason: 'ledger has ' + total + ' rows, above the ' + HARD_CAP + ' single-pass cap' };
            }

            var done = 0;
            for (var a = 0; a < AUDITED.length; a++) {
                var spec = AUDITED[a];
                var list = rows(spec.key);
                report.byKey[spec.key] = { scanned: 0, agreed: 0, changed: 0, drifted: 0, unknown: 0 };
                for (var i = 0; i < list.length; i++) {
                    if (_abort) { _running = false; return { ok: false, reason: 'aborted', partial: report }; }
                    var r = list[i];
                    var stored = r && r[spec.field];
                    var k = report.byKey[spec.key];
                    report.totals.scanned++; k.scanned++;

                    if (stored) report.vocabulary[stored] = (report.vocabulary[stored] || 0) + 1;

                    if (stored && CANON.indexOf(stored) === -1) {
                        report.totals.drifted++; k.drifted++;
                        report.drifted.push({ key: spec.key, label: spec.label, id: r.id,
                            desc: descOf(r), stored: stored, computed: computed(r) });
                    } else {
                        var now = computed(r);
                        if (!now) { report.totals.unknown++; k.unknown++; }
                        else if (!stored || now === stored) { report.totals.agreed++; k.agreed++; }
                        else {
                            report.totals.changed++; k.changed++;
                            report.changed.push({ key: spec.key, label: spec.label, id: r.id,
                                desc: descOf(r), stored: stored, computed: now });
                        }
                    }

                    done++;
                    if (done % SLICE === 0) {
                        if (typeof opts.onProgress === 'function') { try { opts.onProgress({ done: done, total: total }); } catch (_) {} }
                        await yieldSlice();
                    }
                }
            }
            if (typeof opts.onProgress === 'function') { try { opts.onProgress({ done: done, total: total }); } catch (_) {} }
            report.ok = true;
            return report;
        } finally {
            _running = false;
        }
    }

    function abort() { _abort = true; }
    function running() { return _running; }

    /* The dropdown the user picks from by hand is its own list, and it is NOT the
     * canonical one. Reporting the difference is part of the audit rather than
     * something to quietly normalise: several of its names — Rent, Travel, Pets,
     * Charity, Personal Care, Kids & Family — are distinctions a person may want
     * and the canonical list does not carry. Collapsing them would lose
     * information the user chose. What to do about it is a product decision; this
     * only measures it. */
    function inputVocabulary(selectId) {
        var out = { id: selectId || 'e_cat', options: [], missingFromCanonical: [], canonicalNotOffered: [] };
        try {
            var el = W.document && W.document.getElementById(out.id);
            if (!el || !el.options) return out;
            for (var i = 0; i < el.options.length; i++) {
                var v = String(el.options[i].value || '').trim();
                if (v) out.options.push(v);
            }
            var CANON = canonical() || [];
            out.missingFromCanonical = out.options.filter(function (o) { return CANON.indexOf(o) === -1; });
            out.canonicalNotOffered = CANON.filter(function (c) { return out.options.indexOf(c) === -1; });
        } catch (_) {}
        return out;
    }

    /**
     * Apply ONE audited change, by id, after the user has confirmed it.
     * Deliberately singular: there is no applyAll, because a bulk rewrite of a
     * user's categories is exactly the silent mass edit this whole module exists
     * to avoid. Returns true only if a row actually changed.
     */
    function applyOne(key, id, category) {
        var spec = null;
        for (var i = 0; i < AUDITED.length; i++) if (AUDITED[i].key === key) spec = AUDITED[i];
        if (!spec) return false;
        var CANON = canonical();
        if (!CANON || CANON.indexOf(category) === -1) return false;   // never write a name the app lacks
        var db = DB();
        if (!db) return false;
        var list = rows(key).slice();
        var hit = false;
        for (var j = 0; j < list.length; j++) {
            if (list[j] && list[j].id === id) {
                if (list[j][spec.field] === category) return false;
                list[j] = Object.assign({}, list[j]);
                list[j][spec.field] = category;
                hit = true;
                break;
            }
        }
        if (!hit) return false;
        db.set(key, list);
        return true;
    }

    W.WFLedgerAudit = {
        VERSION: VERSION,
        run: run,
        abort: abort,
        running: running,
        applyOne: applyOne,
        inputVocabulary: inputVocabulary,
        AUDITED: AUDITED
    };
    try { W.console && W.console.log('[WFLedgerAudit] ✓ v' + VERSION + ' — read-only ledger audit ready'); } catch (_) {}
})();
