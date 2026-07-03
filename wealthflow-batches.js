/*  wealthflow-batches.js — statement import batches + UNDO  (window.WFBatch)
 *
 *  Every statement upload (CC One-Time, Settings statement upload, Expenses,
 *  anywhere) is recorded as ONE batch. Undoing a batch removes EVERY financial
 *  record that import created, across ALL tabs:
 *     • CC One-Time charges      (cconetime)
 *     • Expenses                 (expenses)
 *     • Received income          (incomeRecv)
 *     • Card payments            (ccPayments)     ← v7.43.0
 *     • Cheques                  (cheques)        ← v7.43.0
 *     • Loan instalments         (loan.payments[])← v7.43.0 (removed/restored)
 *     • Subscriptions            (auto-created sub + merchant memory)
 *  We keep the last 6 batches.
 *
 *  Records created by an import carry  _batch: '<batchId>'  so undo is exact.
 *  Loan instalments live INSIDE each loan's payments[] (not as top-level rows),
 *  so they are recorded as explicit ops { loanId, month, prev } and undo either
 *  removes the added entry or restores the exact one it replaced.
 *
 *  window.WFBatch = { begin, tag, record, recordSub, recordLoan, commit, list, undo, _key }
 */
(function () {
    'use strict';
    var KEY = 'importBatches';     // DB key (array, newest last); we keep last 6
    var MAX = 6;
    // Every top-level array a batch can create rows in. Undo removes by recorded
    // id OR by the _batch tag (belt and braces) from each of these.
    var TABS = ['cconetime', 'expenses', 'incomeRecv', 'ccPayments', 'cheques'];

    function _db() { return (typeof window !== 'undefined' && window.DB) ? window.DB : null; }
    function _uid() { try { if (window.uid) return window.uid(); } catch (_) {} return 'b_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
    function list() { var db = _db(); return (db && db.get ? db.get(KEY) : null) || []; }
    function _save(arr) { var db = _db(); if (db && db.set) db.set(KEY, arr.slice(-MAX)); }

    // Start a batch. label = filename / source shown to the user.
    function begin(label, source) {
        var counts = { subscription: 0 };
        var ids = {};
        TABS.forEach(function (t) { counts[t] = 0; ids[t] = []; });
        return {
            id: _uid(),
            label: label || 'Statement',
            source: source || 'statement',   // e.g. 'cconetime' | 'settings' | 'expenses'
            at: new Date().toISOString(),
            counts: counts,
            ids: ids,
            loans: [],   // [{ loanId, month, prev }]  — loan instalments this batch wrote
            subs: []     // [{ subId, paymentDate, amount, createdSub: bool }]
        };
    }
    // Tag a freshly-built record object with the batch id (call before pushing).
    function tag(batch, rec) { if (batch && rec) rec._batch = batch.id; return rec; }
    // Note a created record id under a tab. Auto-creates the bucket if new so no
    // recorded row is ever silently dropped (the old bug that left cheques /
    // card-payments un-undoable).
    function record(batch, tab, id) {
        if (!batch || !id || !tab) return;
        if (!batch.ids[tab]) batch.ids[tab] = [];
        if (batch.counts[tab] == null) batch.counts[tab] = 0;
        batch.ids[tab].push(id);
        batch.counts[tab]++;
    }
    // Note a loan-instalment op so undo can remove (or restore the replaced) entry.
    function recordLoan(batch, info) {
        if (!batch || !info || !info.loanId || !info.month) return;
        if (!batch.loans) batch.loans = [];
        batch.loans.push({ loanId: info.loanId, month: info.month, prev: info.prev || null });
    }
    // Note a subscription payment this batch made (for precise undo).
    function recordSub(batch, info) {
        if (!batch || !info) return;
        batch.subs.push(info);              // { subId, paymentDate, amount, createdSub }
        batch.counts.subscription++;
    }
    // Total number of things this batch created (drives the commit gate + UI).
    function _total(batch) {
        var t = (batch.counts && batch.counts.subscription) || 0;
        TABS.forEach(function (tab) { t += (batch.counts && batch.counts[tab]) || 0; });
        t += (batch.loans || []).length;
        return t;
    }
    // Persist the batch (only if it actually did something).
    function commit(batch) {
        if (!batch) return;
        if (!_total(batch)) return;
        var arr = list(); arr.push(batch); _save(arr);
        return batch;
    }

    function _undoLoans(batch, removed) {
        var db = _db(); if (!db) return;
        var ops = batch.loans || [];
        if (!ops.length) return;
        var loans = db.get('loans') || [];
        var changed = false;
        ops.forEach(function (op) {
            var ln = loans.filter(function (l) { return l && l.id === op.loanId; })[0];
            if (!ln || !ln.payments) return;
            var pi = ln.payments.findIndex(function (p) { return p && p.month === op.month; });
            if (pi < 0) return;
            // Only touch the instalment if it is the one THIS batch wrote — a later
            // import or a manual edit at that month must not be clobbered.
            if (ln.payments[pi]._batch !== batch.id) return;
            if (op.prev) { ln.payments[pi] = op.prev; }   // restore what we replaced
            else { ln.payments.splice(pi, 1); }           // remove what we added
            removed.loans = (removed.loans || 0) + 1;
            changed = true;
        });
        if (changed) db.set('loans', loans);
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
        var removed = { cconetime: 0, expenses: 0, incomeRecv: 0, ccPayments: 0, cheques: 0, loans: 0, subscription: 0 };

        TABS.forEach(function (tab) {
            var ids = (batch.ids && batch.ids[tab]) || [];
            var cur = db.get(tab) || [];
            if (!cur.length) return;
            var set = {}; ids.forEach(function (i) { set[i] = 1; });
            var before = cur.length;
            // remove by recorded id OR by the _batch tag (belt and braces)
            var next = cur.filter(function (r) { return !(r && (set[r.id] || r._batch === batch.id)); });
            if (next.length !== before) { removed[tab] = before - next.length; db.set(tab, next); }
        });

        _undoLoans(batch, removed);
        _undoSubs(batch);
        removed.subscription = (batch.subs || []).length;

        // Re-settle CC charges against remaining payments after the removal.
        try { if (window.reconcileCC) window.reconcileCC(); } catch (_) {}

        // drop the batch from the log
        _save(arr.filter(function (b) { return b.id !== batch.id; }));
        return { label: batch.label, removed: removed };
    }

    window.WFBatch = { begin: begin, tag: tag, record: record, recordSub: recordSub, recordLoan: recordLoan, commit: commit, list: list, undo: undo, _key: KEY, MAX: MAX };
    try { console.log('[WFBatch] ✓ statement import-batch + full undo ready (v7.43.0)'); } catch (_) {}
})();
