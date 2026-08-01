/* =============================================================================
 *  WealthFlow — Data Health   ·   window.WFDataHealth
 *  Implements the MEASUREMENT half of issue #53. Read-only, by design.
 * -----------------------------------------------------------------------------
 *  WHY MEASUREMENT ONLY
 *
 *  The diagnostics attached to #46 showed 496 deletion markers against 23 live
 *  records — a ratio of 21:1 — and the app's own detector already had an
 *  opinion about it (index.html):
 *
 *      if (d.tombstones > 300)
 *          add('info', 'data', 'High number of deletion markers (' + n + ').',
 *              'Harmless — they are pruned automatically after 100 days.');
 *
 *  "Harmless" was never measured. It states a mechanism — the 100-day TTL — and
 *  infers a conclusion from it, which is a different thing from knowing what
 *  those markers cost or whether the pruning is running at all.
 *
 *  So this module measures, and nothing else. It has no write path. The
 *  compaction engine proposed alongside it was deliberately NOT built, because
 *  building it first would have meant writing to the storage layer on the
 *  strength of an unverified premise — and if the answer turns out to be four
 *  kilobytes, it should never be built at all.
 *
 *  WHY DELETING TOMBSTONES IS NOT THE OBVIOUS FIX
 *
 *  They are not junk. index.html describes `_tomb` as "per-key deletion
 *  tombstones {key:{id:deleteTs}} for convergent multi-device merge" — they are
 *  what makes a delete on your phone stay deleted after your laptop syncs.
 *  Dropping one resurrects a record you deleted. Nothing here removes any.
 *
 *  WHAT IT LOOKS FOR BEYOND THE HEADLINE COUNT
 *
 *    · expired  — past the TTL and still present, which means the pruner is not
 *                 reaching them. The prune runs ON READ, so a key nothing reads
 *                 is never pruned; 496 markers against a 100-day TTL is either
 *                 heavy delete churn or exactly that, and the two need
 *                 different fixes.
 *    · orphaned — markers filed under a key that is not a record store at all,
 *                 which can never do any useful work.
 * ========================================================================== */
(function () {
    var W = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_DATA_HEALTH === '1.0') return;
    W.WF_DATA_HEALTH = '1.0';

    /** Mirrors _WF_TOMB_TTL in index.html — 100 days. */
    var TOMB_TTL_MS = 100 * 24 * 3600 * 1000;

    /**
     * The stores that hold real records. Mirrors _WF_RECORD_KEYS in index.html;
     * a marker filed under anything else cannot be protecting a delete.
     */
    var RECORD_KEYS = ['income', 'incomeRecv', 'loans', 'ccinstall', 'cconetime', 'ccPayments',
        'cheques', 'expenses', 'targets', 'subscriptions', 'importBatches', 'cribReports', 'sessions'];

    /** Below this, the markers are not worth a compaction engine. */
    var NEGLIGIBLE_BYTES = 20 * 1024;

    function sizeOf(v) {
        try { return JSON.stringify(v == null ? null : v).length; } catch (_) { return 0; }
    }

    /**
     * Measure. Never writes, never prunes, never returns a recommendation it did
     * not compute from the data in front of it.
     *
     * @param {object} [appData]  defaults to window.appData
     * @param {{now?:number, recordKeys?:string[]}} [opts]
     */
    function measure(appData, opts) {
        var o = opts || {};
        var data = appData || W.appData || {};
        var now = typeof o.now === 'number' ? o.now : Date.now();
        var keys = Array.isArray(o.recordKeys) ? o.recordKeys : RECORD_KEYS;

        var tomb = (data && typeof data._tomb === 'object' && data._tomb) ? data._tomb : {};
        var out = {
            tombstones: { count: 0, bytes: sizeOf(tomb), expired: 0, orphaned: 0, byKey: {} },
            records: { count: 0, bytes: 0 },
            totalBytes: 0, sharePct: 0, ratio: null,
        };

        var tk = Object.keys(tomb);
        for (var i = 0; i < tk.length; i++) {
            var key = tk[i];
            var entry = tomb[key];
            if (!entry || typeof entry !== 'object') continue;
            var ids = Object.keys(entry);
            var isOrphan = keys.indexOf(key) === -1;
            var expiredHere = 0;
            for (var j = 0; j < ids.length; j++) {
                var ts = entry[ids[j]];
                if (typeof ts === 'number' && (now - ts) > TOMB_TTL_MS) expiredHere += 1;
            }
            out.tombstones.count += ids.length;
            out.tombstones.expired += expiredHere;
            if (isOrphan) out.tombstones.orphaned += ids.length;
            out.tombstones.byKey[key] = { n: ids.length, expired: expiredHere, orphaned: isOrphan };
        }

        for (var k = 0; k < keys.length; k++) {
            var arr = data[keys[k]];
            if (Array.isArray(arr)) {
                out.records.count += arr.length;
                out.records.bytes += sizeOf(arr);
            }
        }

        out.totalBytes = out.records.bytes + out.tombstones.bytes;

        // Share OF THE RECORDS AND THEIR MARKERS — not of everything stored.
        //
        // The first version reported this as "% of your stored data", and on a
        // real device it read 70.4% while the markers were 15.2 KB against
        // 2,574 KB of actual storage: 0.6%. Overstated by roughly 100x, on a
        // diagnostic whose entire purpose is replacing an unverified claim with
        // a measured one. A number that sounds authoritative and measures
        // something other than what it says is the same defect as "Harmless",
        // wearing a percentage.
        out.sharePct = out.totalBytes > 0
            ? Math.round((out.tombstones.bytes / out.totalBytes) * 1000) / 10 : 0;

        // The honest headline figure, when the caller knows what the device
        // actually holds. Null rather than a guess when it does not.
        var total = typeof (o.totalStorageBytes) === 'number' && o.totalStorageBytes > 0 ? o.totalStorageBytes : null;
        out.totalStorageBytes = total;
        out.sharePctOfStorage = total
            ? Math.round((out.tombstones.bytes / total) * 1000) / 10 : null;
        out.ratio = out.records.count > 0
            ? Math.round((out.tombstones.count / out.records.count) * 10) / 10 : null;
        return out;
    }

    /**
     * The measured replacement for the "Harmless" assertion.
     *
     * Every branch quotes the number it was derived from. The point of #53 is
     * that a verdict which cannot show its arithmetic is indistinguishable from
     * a guess — which is precisely what it replaces.
     */
    function verdict(m) {
        if (!m || !m.tombstones) return { level: 'unknown', text: 'Deletion markers could not be measured.' };
        var t = m.tombstones;
        var kb = Math.round(t.bytes / 1024 * 10) / 10;
        var head = t.count + ' deletion marker' + (t.count === 1 ? '' : 's') + ', ' + kb + ' KB';
        // Say precisely what the percentage is OF. See measure() for why.
        var share = m.sharePctOfStorage != null
            ? ' (' + m.sharePctOfStorage + '% of everything this device stores)'
            : (m.sharePct ? ' (' + m.sharePct + '% of your records and their markers)' : '');

        if (t.count === 0) return { level: 'ok', text: 'No deletion markers.' };

        // The pruner runs on read, so a key nothing reads is never pruned. If
        // expired markers are still here, that is the fault — not the count.
        if (t.expired > 0) {
            return { level: 'warn', measured: true,
                text: head + share + '. ' + t.expired + ' of them are past the 100-day expiry and still present, '
                    + 'so they are not being pruned — the prune only runs when a key is read.' };
        }
        if (t.orphaned > 0) {
            return { level: 'warn', measured: true,
                text: head + share + '. ' + t.orphaned + ' are filed under a key that holds no records, '
                    + 'so they can never protect a deletion.' };
        }
        if (t.bytes < NEGLIGIBLE_BYTES) {
            return { level: 'ok', measured: true,
                text: head + share + ' — negligible, and every one is still within its 100-day life. No action needed.' };
        }
        return { level: 'info', measured: true,
            text: head + share + '. All are still within their 100-day life, so they are doing their job, '
                + 'but the volume is worth watching.' };
    }

    W.WFDataHealth = {
        TOMB_TTL_MS: TOMB_TTL_MS, RECORD_KEYS: RECORD_KEYS, NEGLIGIBLE_BYTES: NEGLIGIBLE_BYTES,
        measure: measure, verdict: verdict, VERSION: '1.0',
    };
    try { console.log('[WFDataHealth] v1.0 loaded (read-only)'); } catch (_) {}
})();
