/*  wealthflow-batches.js — statement import batches + UNDO  (window.WFBatch)
 *
 *  Every statement upload (CC One-Time, Settings statement upload, Expenses,
 *  anywhere) is recorded as ONE batch. Undoing a batch removes EVERY payment that
 *  import created, across all tabs — expenses, received income, CC One-Time, and
 *  subscriptions (including the auto-created subscription + the merchant memory if
 *  that subscription has no other history left). We keep the last 6 batches.
 *
 *  Records created by an import carry  _batch: '<batchId>'  so undo is exact.
 *
 *  window.WFBatch = { begin, tag, record, commit, list, undo, _key }
 */
(function () {
    'use strict';
    var KEY = 'importBatches';     // DB key (array, newest last); we keep last 6
    var MAX = 6;

    function _db() { return (typeof window !== 'undefined' && window.DB) ? window.DB : null; }
    function _uid() { try { if (window.uid) return window.uid(); } catch (_) {} return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function list() { var db = _db(); return (db && db.get ? db.get(KEY) : null) || []; }
    function _save(arr) { var db = _db(); if (db && db.set) db.set(KEY, arr.slice(-MAX)); }

    // Start a batch. label = filename / source shown to the user.
    function begin(label, source) {
        return {
            id: _uid(),
            label: label || 'Statement',
            source: source || 'statement',   // e.g. 'cconetime' | 'settings' | 'expenses'
            at: new Date().toISOString(),
            counts: { cconetime: 0, expenses: 0, incomeRecv: 0, subscription: 0 },
            ids: { cconetime: [], expenses: [], incomeRecv: [] },
            subs: []   // [{ subId, paymentDate, amount, createdSub: bool }]
        };
    }
    // Tag a freshly-built record object with the batch id (call before pushing).
    function tag(batch, rec) { if (batch && rec) rec._batch = batch.id; return rec; }
    // Note a created record id under a tab.
    function record(batch, tab, id) {
        if (!batch || !id) return;
        if (batch.ids[tab]) batch.ids[tab].push(id);
        if (batch.counts[tab] != null) batch.counts[tab]++;
    }
    // Note a subscription payment this batch made (for precise undo).
    function recordSub(batch, info) {
        if (!batch || !info) return;
        batch.subs.push(info);              // { subId, paymentDate, amount, createdSub }
        batch.counts.subscription++;
    }
    // Persist the batch (only if it actually did something).
    function commit(batch) {
        if (!batch) return;
        var total = batch.counts.cconetime + batch.counts.expenses + batch.counts.incomeRecv + batch.counts.subscription;
        if (!total) return;
        var arr = list(); arr.push(batch); _save(arr);
        return batch;
    }

    function _undoSubs(batch) {
        var db = _db(); if (!db) return;
        var subs = db.get('subscriptions') || [];
        var map = db.get('subMerchantMap') || {};
        (batch.subs || []).forEach(function (s) {
            var sub = subs.filter(function (x) { return x.id === s.subId; })[0];
            if (!sub) return;
            // remove the payment this batch recorded (match date + amount once)
            if (sub.history && sub.history.length) {
                var idx = sub.history.findIndex(function (h) { return h.date === s.paymentDate && Math.abs((h.amount || 0) - (s.amount || 0)) < 0.01; });
                if (idx > -1) {
                    sub.history.splice(idx, 1);
                    if (s.paymentDate) { var ym = String(s.paymentDate).slice(0, 7); if (sub.monthOverrides) delete sub.monthOverrides[ym]; }
                }
            }
            // if THIS batch created the subscription and nothing else remains, remove it + its memory
            if (s.createdSub && (!sub.history || sub.history.length === 0)) {
                subs = subs.filter(function (x) { return x.id !== s.subId; });
                Object.keys(map).forEach(function (k) { if (map[k] === s.subId) delete map[k]; });
            }
        });
        db.set('subscriptions', subs);
        db.set('subMerchantMap', map);
    }

    // Undo a batch by id. Returns a summary {removed:{...}} or null.
    function undo(batchId) {
        var db = _db(); if (!db) return null;
        var arr = list();
        var batch = arr.filter(function (b) { return b.id === batchId; })[0];
        if (!batch) return null;
        var removed = { cconetime: 0, expenses: 0, incomeRecv: 0, subscription: 0 };

        ['cconetime', 'expenses', 'incomeRecv'].forEach(function (tab) {
            var ids = (batch.ids && batch.ids[tab]) || [];
            if (!ids.length) return;
            var set = {}; ids.forEach(function (i) { set[i] = 1; });
            var cur = db.get(tab) || [];
            var before = cur.length;
            // remove by recorded id OR by the _batch tag (belt and braces)
            var next = cur.filter(function (r) { return !(set[r.id] || r._batch === batch.id); });
            removed[tab] = before - next.length;
            db.set(tab, next);
        });

        _undoSubs(batch);
        removed.subscription = (batch.subs || []).length;

        // drop the batch from the log
        _save(arr.filter(function (b) { return b.id !== batch.id; }));
        return { label: batch.label, removed: removed };
    }

    window.WFBatch = { begin: begin, tag: tag, record: record, recordSub: recordSub, commit: commit, list: list, undo: undo, _key: KEY, MAX: MAX };
    try { console.log('[WFBatch] ✓ statement import-batch + undo ready'); } catch (_) {}
})();
