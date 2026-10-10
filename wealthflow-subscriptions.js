/*  wealthflow-subscriptions.js — subscription auto-routing engine (window.WFSubs)
 *
 *  When a bank-statement payment is a recurring bill (mobile, ISP, streaming,
 *  utility), it should land in the Subscriptions tab and record that month's
 *  payment. If no matching subscription exists yet, we AUTO-CREATE the best one
 *  (e.g. "Mobile Connection (0771234567)") and REMEMBER the merchant so every
 *  future statement — which won't carry the user's chosen name — routes to the
 *  same subscription. Accuracy first: a stable merchant key + payment de-dupe.
 *
 *  Subscription record shape (matches the app):
 *    { id, name, category, amount, dueDay, cycle:'monthly', anomalyDetect:false,
 *      notes, history:[{month,amount,date,source}], monthOverrides:{'YYYY-MM':amt},
 *      createdAt, autoCreated:true, merchantKeys:[...] }
 *
 *  window.WFSubs = { merchantKey, findExisting, buildSubscription, recordPayment,
 *                    applyToArrays, apply }
 */
(function () {
    'use strict';

    function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
    function _uid() { try { if (typeof window !== 'undefined' && typeof window.uid === 'function') return window.uid(); } catch (_) {} return 'sub_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    // A stable key that identifies the merchant REGARDLESS of the name the user
    // later gives the subscription — so re-imports always map to the same record.
    function merchantKey(txn, routeInfo) {
        routeInfo = routeInfo || {};
        if (routeInfo.subPhone) return 'mobile:' + routeInfo.subPhone;
        var d = norm((txn && txn.description) || '');
        var brand = d.match(/netflix|spotify|youtube|disney|hbo|hulu|prime video|amazon prime|apple music|itunes|icloud|google one|hotstar|dialog|mobitel|hutch|airtel|slt|lanka bell|ceb|leco|nwsdb|aia|ceylinco|allianz/);
        if (brand) return 'brand:' + brand[0].replace(/\s+/g, '');
        var phone = d.match(/(?:\+?94|0)\s?7\d(?:[\s-]?\d){7}/);
        if (phone) return 'mobile:' + phone[0].replace(/[\s-]/g, '');
        // fall back to the first few significant words of the narration
        var words = d.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; }).slice(0, 3);
        return 'desc:' + words.join('-');
    }

    // Find an existing subscription: first by remembered mapping, then by a
    // confident name/phone match (so we don't create duplicates).
    function findExisting(txn, routeInfo, subs, map) {
        var all = subs || []; map = map || {};
        var key = merchantKey(txn, routeInfo);
        // A finished one-time bill is closed: a later charge from the same merchant is a new bill,
        // not a payment on it. Only an exact re-import of a payment it already holds, or a bill the
        // owner reopened, may still match.
        var tDate = (txn && txn.date) || '', tAmt = Math.abs(txn && txn.amount) || 0;
        subs = all.filter(function (s) {
            if (!_oneTime(s && s.cycle) || !(s.paid === true || s.completed === true) || s.reopened === true) return true;
            return (s.history || []).some(function (h) { return h && h.date === tDate && Math.abs((h.amount || 0) - tAmt) < 0.01; });
        });
        if (map[key]) {
            var byMap = subs.filter(function (s) { return s.id === map[key]; })[0];
            if (byMap) return { sub: byMap, key: key, via: 'memory' };
        }
        // a subscription that already lists this key
        var byKey = subs.filter(function (s) { return (s.merchantKeys || []).indexOf(key) >= 0; })[0];
        if (byKey) return { sub: byKey, key: key, via: 'merchantKeys' };
        // confident name / phone match
        var wantName = norm((routeInfo && routeInfo.subName) || (txn && txn.description) || '');
        var phone = routeInfo && routeInfo.subPhone;
        var byName = subs.filter(function (s) {
            if (phone && (s.name || '').replace(/[\s-]/g, '').indexOf(phone) >= 0) return true;
            var n = norm(s.name);
            return n && wantName && (n === wantName || (wantName.length > 4 && (n.indexOf(wantName) >= 0 || wantName.indexOf(n) >= 0)));
        })[0];
        return { sub: byName || null, key: key, via: byName ? 'name' : null };
    }

    function _monthOf(date) { var m = String(date || '').match(/^(\d{4})-(\d{2})/); return m ? (m[1] + '-' + m[2]) : ''; }
    function _dayOf(date) { var m = String(date || '').match(/-(\d{2})$/); return m ? (parseInt(m[1], 10) || 1) : 1; }
    function _p2(n) { return String(n).padStart(2, '0'); }
    function _ymd(y, m, d) {
        var last = new Date(y, m + 1, 0).getDate();
        return y + '-' + _p2(m + 1) + '-' + _p2(Math.min(Math.max(1, Number(d) || 1), last));
    }
    function _date(v) {
        if (!v) return null;
        var d = new Date(String(v).match(/^\d{4}-\d{2}-\d{2}$/) ? String(v) + 'T00:00:00' : v);
        return isNaN(d.getTime()) ? null : d;
    }
    function _oneTime(cycle) { return /^(once|one-time|onetime)$/.test(String(cycle || '').toLowerCase()); }
    function legacyDueDate(sub) {
        sub = sub || {};
        if (/^\d{4}-\d{2}-\d{2}$/.test(String(sub.dueDate || ''))) return String(sub.dueDate);
        var anchor = _date(sub.createdAt);
        return anchor ? _ymd(anchor.getFullYear(), anchor.getMonth(), sub.dueDay) : '';
    }
    function _paidInMonth(sub, ym, oneTime) {
        if (!sub) return false;
        // Reopen is an explicit owner decision. Historical statement evidence
        // remains for audit, but must not immediately close the same bill again.
        // A later statement payment clears this flag in recordPayment().
        if (oneTime && sub.reopened === true) return false;
        if (sub.completed === true || sub.paid === true) return true;
        var history = Array.isArray(sub.history) ? sub.history : [];
        if (history.some(function (h) { return h && (h.month === ym || _monthOf(h.date) === ym) && h.paid !== false; })) return true;
        return !!(sub.monthOverrides && typeof sub.monthOverrides[ym] === 'number');
    }

    /**
     * The one authoritative lifecycle for a bill occurrence.
     *
     * One-time payments keep their exact dueDate and remain actionable after
     * that date until completed; they never roll into a new month. Recurring
     * bills are active only in a real cycle month and stop reminding as soon as
     * that cycle is recorded in history/monthOverrides.
     */
    function occurrence(sub, at) {
        sub = sub || {};
        var now = _date(at) || new Date();
        var cycle = String(sub.cycle || 'monthly').toLowerCase();
        var oneTime = _oneTime(cycle);
        var anchor = _date(sub.createdAt);
        var dueDate = oneTime ? _date(legacyDueDate(sub)) : null;
        var ym;

        if (oneTime) {
            if (!dueDate) return { active: false, paid: false, oneTime: true, date: '', cycle: cycle, reason: 'missing-due-date' };
            var fixed = _ymd(dueDate.getFullYear(), dueDate.getMonth(), dueDate.getDate());
            ym = fixed.slice(0, 7);
            var oncePaid = _paidInMonth(sub, ym, true);
            return { active: !oncePaid, paid: oncePaid, oneTime: true, date: fixed, month: ym, cycle: cycle };
        }

        if (!anchor) {
            // createdAt did not exist on older monthly records. Preserve their
            // established monthly behaviour instead of silently dropping them.
            // Longer cadences need a real anchor; inventing one would create
            // quarterly/yearly charges in arbitrary months.
            if (cycle !== 'monthly') return { active: false, paid: false, oneTime: false, date: '', cycle: cycle, reason: 'missing-anchor' };
            var legacyDate = _ymd(now.getFullYear(), now.getMonth(), sub.dueDay);
            ym = legacyDate.slice(0, 7);
            var legacyPaid = _paidInMonth(sub, ym, false);
            return { active: !legacyPaid, paid: legacyPaid, oneTime: false, date: legacyDate, month: ym, cycle: cycle, legacy: true };
        }
        var elapsed = (now.getFullYear() - anchor.getFullYear()) * 12 + now.getMonth() - anchor.getMonth();
        var step = cycle === 'quarterly' ? 3 : (cycle === 'yearly' || cycle === 'annual' ? 12 : 1);
        if (elapsed < 0 || elapsed % step !== 0) return { active: false, paid: false, oneTime: false, date: '', cycle: cycle, reason: 'off-cycle' };
        var fixedDate = _ymd(now.getFullYear(), now.getMonth(), sub.dueDay);
        ym = fixedDate.slice(0, 7);
        var cyclePaid = _paidInMonth(sub, ym, false);
        return { active: !cyclePaid, paid: cyclePaid, oneTime: false, date: fixedDate, month: ym, cycle: cycle };
    }

    function buildSubscription(routeInfo, txn) {
        routeInfo = routeInfo || {}; txn = txn || {};
        return {
            id: _uid(),
            name: (routeInfo.subName || (txn.description || 'Subscription')).toString().replace(/\s+/g, ' ').trim().slice(0, 40),
            category: routeInfo.category || 'Other',
            amount: Math.abs(txn.amount) || 0,
            dueDay: _dayOf(txn.date),
            cycle: 'monthly',
            anomalyDetect: false,
            notes: 'Auto-created from a bank statement import',
            history: [],
            monthOverrides: {},
            createdAt: new Date().toISOString(),
            autoCreated: true,
            merchantKeys: []
        };
    }

    // Record one statement payment on a subscription (idempotent for re-imports).
    function recordPayment(sub, txn) {
        sub.history = sub.history || []; sub.monthOverrides = sub.monthOverrides || {};
        var date = (txn && txn.date) || ''; var month = _monthOf(date); var amt = Math.abs(txn && txn.amount) || 0;
        var prevAmount = sub.amount;   // headline amount BEFORE this statement changed it (for exact undo)
        var previousLifecycle = { paid: sub.paid, completed: sub.completed, paidAt: sub.paidAt,
            paidSource: sub.paidSource, paidStatementKey: sub.paidStatementKey, reopened: sub.reopened };
        var dup = sub.history.some(function (h) { return h.date === date && Math.abs((h.amount || 0) - amt) < 0.01; });
        if (!dup) {
            sub.history.push({ month: month, amount: amt, date: date, source: 'statement' });
            if (month) sub.monthOverrides[month] = amt; // variable-bill actual for that month
            if (amt) sub.amount = amt;                  // keep the headline amount current
        }
        // an exact re-import of a payment already on the bill is not a new payment: it must not close a bill the owner has since reopened
        if (_oneTime(sub.cycle) && (!dup || !sub.reopened)) {
            var paidNow = new Date();
            sub.paid = true; sub.completed = true; sub.paidAt = date || _ymd(paidNow.getFullYear(), paidNow.getMonth(), paidNow.getDate());
            sub.paidSource = 'statement';
            sub.reopened = false;
        }
        return { added: !dup, month: month, amount: amt, prevAmount: prevAmount, previousLifecycle: previousLifecycle };
    }

    // Pure core (testable): mutate/return the arrays without touching storage.
    function applyToArrays(txn, routeInfo, subs, map) {
        subs = (subs || []).slice(); map = Object.assign({}, map || {});
        var found = findExisting(txn, routeInfo, subs, map);
        var created = false, sub = found.sub;
        if (!sub) { sub = buildSubscription(routeInfo, txn); subs.push(sub); created = true; }
        sub.merchantKeys = sub.merchantKeys || [];
        if (sub.merchantKeys.indexOf(found.key) < 0) sub.merchantKeys.push(found.key);
        var pay = recordPayment(sub, txn);
        map[found.key] = sub.id; // remember for next time
        return { subscriptions: subs, map: map, subId: sub.id, name: sub.name, created: created, paymentAdded: pay.added,
            prevAmount: pay.prevAmount, previousLifecycle: pay.previousLifecycle, via: found.via };
    }

    // Live path: read from DB, apply, write back. Returns a small summary.
    function apply(txn, routeInfo) {
        var DB = (typeof window !== 'undefined' && window.DB) ? window.DB : null;
        var subs = (DB && DB.get ? DB.get('subscriptions') : null) || [];
        var map = (DB && DB.get ? DB.get('subMerchantMap') : null) || {};
        var r = applyToArrays(txn, routeInfo, subs, map);
        if (DB && DB.set) { DB.set('subscriptions', r.subscriptions); DB.set('subMerchantMap', r.map); }
        return { subId: r.subId, name: r.name, created: r.created, paymentAdded: r.paymentAdded, prevAmount: r.prevAmount,
            previousLifecycle: r.previousLifecycle, via: r.via, paymentDate: (txn && txn.date) || '', amount: Math.abs((txn && txn.amount) || 0) };
    }

    window.WFSubs = {
        merchantKey: merchantKey,
        findExisting: findExisting,
        buildSubscription: buildSubscription,
        recordPayment: recordPayment,
        legacyDueDate: legacyDueDate,
        occurrence: occurrence,
        applyToArrays: applyToArrays,
        apply: apply
    };
    try { console.log('[WFSubs] @info@ subscription auto-routing engine ready'); } catch (_) {}
})();
