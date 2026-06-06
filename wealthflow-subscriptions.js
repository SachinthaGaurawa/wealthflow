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
        subs = subs || []; map = map || {};
        var key = merchantKey(txn, routeInfo);
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
        var dup = sub.history.some(function (h) { return h.date === date && Math.abs((h.amount || 0) - amt) < 0.01; });
        if (!dup) {
            sub.history.push({ month: month, amount: amt, date: date, source: 'statement' });
            if (month) sub.monthOverrides[month] = amt; // variable-bill actual for that month
            if (amt) sub.amount = amt;                  // keep the headline amount current
        }
        return { added: !dup, month: month, amount: amt };
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
        return { subscriptions: subs, map: map, subId: sub.id, name: sub.name, created: created, paymentAdded: pay.added, via: found.via };
    }

    // Live path: read from DB, apply, write back. Returns a small summary.
    function apply(txn, routeInfo) {
        var DB = (typeof window !== 'undefined' && window.DB) ? window.DB : null;
        var subs = (DB && DB.get ? DB.get('subscriptions') : null) || [];
        var map = (DB && DB.get ? DB.get('subMerchantMap') : null) || {};
        var r = applyToArrays(txn, routeInfo, subs, map);
        if (DB && DB.set) { DB.set('subscriptions', r.subscriptions); DB.set('subMerchantMap', r.map); }
        return { subId: r.subId, name: r.name, created: r.created, paymentAdded: r.paymentAdded, via: r.via };
    }

    window.WFSubs = {
        merchantKey: merchantKey,
        findExisting: findExisting,
        buildSubscription: buildSubscription,
        recordPayment: recordPayment,
        applyToArrays: applyToArrays,
        apply: apply
    };
    try { console.log('[WFSubs] ✓ subscription auto-routing engine ready'); } catch (_) {}
})();
