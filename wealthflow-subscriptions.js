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

    // The identity rule is ONE file the email worker reads too (wealthflow-sub-identity.js, window.WFSubIdentity): a number, a bill reference or a brand is what a payment is
    // for, so a row is not one entry by upload and another by email. It loads as a deferred module; until it is there (or if it cannot load) the older reading below is used.
    function _identity() { try { return (typeof window !== 'undefined' && window.WFSubIdentity) || null; } catch (_) { return null; } }
    function _evidence(txn, routeInfo) {
        var I = _identity(); if (!I) return null;
        var ev = I.evidenceOf(txn || {});
        // the router may have read the number the row prints in another spelling: it is still that number
        if (!ev.phones.length && routeInfo && routeInfo.subPhone) ev.phones = I.phoneKeys(String(routeInfo.subPhone));
        return ev;
    }

    // A stable key that identifies the merchant REGARDLESS of the name the user
    // later gives the subscription — so re-imports always map to the same record.
    function merchantKey(txn, routeInfo) {
        routeInfo = routeInfo || {};
        var I = _identity(), ev = _evidence(txn, routeInfo);
        if (I && ev) {
            if (ev.phones.length === 1) return I.manualPhoneKey(ev.phones[0]);          // "mobile:0771234567": one number, one entry
            if (!ev.phones.length && ev.refs.length === 1) return I.refKey(ev.refs[0]);  // "ref:asp931097": one bill reference, one entry
            if (!ev.phones.length && ev.brands.length === 1) return 'brand:' + ev.brands[0].key;
        }
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

    // The key an earlier version stored for a row with no number or brand it knew (the first words of the narration). An entry that lists it was made from rows like this one.
    function legacyKey(txn) {
        var d = norm((txn && txn.description) || '');
        var words = d.replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; }).slice(0, 3);
        return 'desc:' + words.join('-');
    }

    // Find an existing subscription: first by remembered mapping, then by a
    // confident name / phone match (so we don't create duplicates).
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
        var I = _identity(), ev = _evidence(txn, routeInfo);
        if (I && ev && (ev.phones.length || ev.refs.length)) {
            /* A NUMBER OR A BILL REFERENCE IS THE IDENTITY. The entry that carries it is the entry, for any amount; an entry that carries a different one is never it, whatever its name says; and a
             * number nobody tracks yet is a new entry — never "the nearest name". */
            var want = ev.phones.length ? ev.phones : ev.refs, field = ev.phones.length ? 'phones' : 'refs';
            var owners = subs.filter(function (s) { var id = I.identityOf(s)[field]; return want.some(function (n) { return id.indexOf(n) >= 0; }); });
            if (owners.length === 1) return { sub: owners[0], key: key, via: field === 'phones' ? 'number' : 'reference' };
            if (owners.length > 1) {   // two entries carry it: the remembered one, else the first (never a guess across different numbers)
                var mapped = map[key] ? owners.filter(function (s) { return s.id === map[key]; })[0] : null;
                return { sub: mapped || owners[0], key: key, via: 'number' };
            }
            return { sub: null, key: key, via: null };
        }
        if (map[key]) {
            var byMap = subs.filter(function (s) { return s.id === map[key]; })[0];
            if (byMap) return { sub: byMap, key: key, via: 'memory' };
        }
        // a subscription that already lists this key
        var byKey = subs.filter(function (s) { return (s.merchantKeys || []).indexOf(key) >= 0; })[0];
        if (byKey) return { sub: byKey, key: key, via: 'merchantKeys' };
        // an entry that names the same business in other words (Claude / Anthropic, ChatGPT / OpenAI) — never one that carries a number or a reference of its own
        if (I && ev && ev.brands.length === 1) {
            var byBrand = subs.filter(function (s) { var id = I.identityOf(s); return !id.phones.length && !id.refs.length && id.brands.indexOf(ev.brands[0].key) >= 0; })[0];
            if (byBrand) return { sub: byBrand, key: key, via: 'brand' };
        }
        // confident name match
        var wantName = norm((routeInfo && routeInfo.subName) || (txn && txn.description) || '');
        var byName = subs.filter(function (s) {
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
        var name = (routeInfo.subName || (txn.description || 'Subscription')).toString().replace(/\s+/g, ' ').trim().slice(0, 40), keys = [];
        // a number or a bill reference names its entry ("Mobile 076 576 4382", "Bill payment ASP931097"), so two of them are two entries a reader can tell apart
        var I = _identity();
        if (I) {
            var spec = I.subscriptionToCreate({ direction: 'debit', description: (txn.description || '') });
            var ev = _evidence(txn, routeInfo);
            if (spec && ev && (ev.phones.length === 1 || ev.refs.length === 1)) {
                var digits = String(name).replace(/\D/g, '');
                if (ev.refs.length === 1 || !ev.phones.length || digits.indexOf(ev.phones[0]) < 0) name = spec.name;
                keys = spec.merchantKeys.slice();
            } else if (ev && ev.refs.length === 1 && !ev.phones.length) { name = 'Bill payment ' + ev.refs[0]; keys = [I.refKey(ev.refs[0])]; }
            else if (ev && ev.phones.length === 1) keys = [I.manualPhoneKey(ev.phones[0])];
        }
        return {
            id: _uid(),
            name: name,
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
            merchantKeys: keys
        };
    }

    // The cents a month holds: every statement payment recorded in it, added as whole cents.
    function _cents(n) { return Math.round((Number(n) || 0) * 100); }
    function monthTotal(sub, month) {
        var cents = (sub.history || []).reduce(function (t, h) { return t + ((h && h.source === 'statement' && (h.month === month || _monthOf(h.date) === month)) ? _cents(h.amount) : 0); }, 0);
        return cents / 100;
    }
    function latestStatementMonth(sub) {
        return (sub.history || []).reduce(function (m, h) { var hm = h && h.source === 'statement' ? (h.month || _monthOf(h.date)) : ''; return hm && hm > m ? hm : m; }, '');
    }
    /* A month that holds several statement payments but shows only ONE of them (an earlier version kept the last payment of the month) is corrected to their total. A figure the owner typed
     * is left alone: it is only touched when it is exactly one of the payments. Returns the months it changed. */
    function healMonths(sub) {
        var changed = [];
        if (!sub || !Array.isArray(sub.history) || !sub.monthOverrides) return changed;
        var months = {};
        sub.history.forEach(function (h) { if (h && h.source === 'statement') { var m = h.month || _monthOf(h.date); if (m) (months[m] = months[m] || []).push(_cents(h.amount)); } });
        Object.keys(months).forEach(function (m) {
            var list = months[m]; if (list.length < 2 || typeof sub.monthOverrides[m] !== 'number') return;
            var shown = _cents(sub.monthOverrides[m]), total = list.reduce(function (a, b) { return a + b; }, 0);
            if (shown !== total && list.indexOf(shown) >= 0) { sub.monthOverrides[m] = total / 100; sub._ut = Date.now(); changed.push(m); }
        });
        if (changed.length) { var latest = latestStatementMonth(sub); if (latest && changed.indexOf(latest) >= 0) sub.amount = monthTotal(sub, latest); }
        return changed;
    }
    /** Heal every entry in the list; true when any month changed (the caller saves). */
    function healAll(subs) { var any = false; (subs || []).forEach(function (s) { if (healMonths(s).length) any = true; }); return any; }

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
            /* A MONTH HOLDS WHAT WAS PAID IN IT, IN TOTAL. A phone reloaded on the 1st, the 10th and the 25th is three payments and one month: the month shows the three added together (in cents,
             * so the total is exact), and each payment stays in the list beside it. It used to keep only the last one. */
            if (month) { sub.monthOverrides[month] = monthTotal(sub, month); }
            if (amt) {                                  // keep the headline amount current: the latest month's total
                var latest = latestStatementMonth(sub);
                if (!latest || month >= latest) sub.amount = month ? monthTotal(sub, month) : amt;
            }
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
        var moved = pay.added && !/^desc:/.test(found.key) ? moveFromLumped(txn, sub, subs, map, found.key) : [];
        return { subscriptions: subs, map: map, subId: sub.id, name: sub.name, created: created, paymentAdded: pay.added,
            prevAmount: pay.prevAmount, previousLifecycle: pay.previousLifecycle, via: found.via, moved: moved };
    }

    /* A PAYMENT FILED BEFORE THE ENTRY KNEW ITS NUMBER. An earlier version put every "IB BILL PAYMENT <number>" on one entry called "Ib Bill Payment" (it matched the name and ignored the
     * number). When the same row is read again and now has its own entry, the copy on that mixed entry is taken off it (and the mixed entry's month is added up again), so the payment is
     * counted once, on the right entry. Only an entry that lists this row's own old key is touched, and only the payment with the same date and amount. Every change is returned so the
     * upload's Undo can put it back exactly. */
    function moveFromLumped(txn, sub, subs, map, key) {
        var lk = legacyKey(txn), date = (txn && txn.date) || '', amt = Math.abs(txn && txn.amount) || 0, out = [];
        if (!lk || lk === key || lk === 'desc:' || !date) return out;
        subs.slice().forEach(function (L) {
            if (!L || L === sub || (L.merchantKeys || []).indexOf(lk) < 0 || !Array.isArray(L.history)) return;
            var idx = L.history.findIndex(function (h) { return h && h.source === 'statement' && h.date === date && Math.abs((h.amount || 0) - amt) < 0.01; });
            if (idx < 0) return;
            var month = L.history[idx].month || _monthOf(date), before = { amount: L.amount, override: L.monthOverrides ? L.monthOverrides[month] : undefined };
            var payment = L.history.splice(idx, 1)[0];
            L.monthOverrides = L.monthOverrides || {};
            var total = monthTotal(L, month);
            if (total > 0) L.monthOverrides[month] = total; else delete L.monthOverrides[month];
            var latest = latestStatementMonth(L);
            if (latest) L.amount = monthTotal(L, latest);
            var entry = { fromSubId: L.id, payment: payment, month: month, prevAmount: before.amount, prevOverride: before.override };
            if (!L.history.length && L.autoCreated === true) {
                var at = subs.indexOf(L); if (at > -1) subs.splice(at, 1);
                Object.keys(map).forEach(function (k) { if (map[k] === L.id) delete map[k]; });
                entry.removedSub = L;
            }
            out.push(entry);
        });
        return out;
    }

    // Live path: read from DB, apply, write back. Returns a small summary.
    function apply(txn, routeInfo) {
        var DB = (typeof window !== 'undefined' && window.DB) ? window.DB : null;
        var subs = (DB && DB.get ? DB.get('subscriptions') : null) || [];
        var map = (DB && DB.get ? DB.get('subMerchantMap') : null) || {};
        var r = applyToArrays(txn, routeInfo, subs, map);
        if (DB && DB.set) { DB.set('subscriptions', r.subscriptions); DB.set('subMerchantMap', r.map); }
        return { subId: r.subId, name: r.name, created: r.created, paymentAdded: r.paymentAdded, prevAmount: r.prevAmount,
            previousLifecycle: r.previousLifecycle, via: r.via, moved: r.moved, paymentDate: (txn && txn.date) || '', amount: Math.abs((txn && txn.amount) || 0) };
    }

    // Was this entry started by a statement payment (and not typed in by the owner)? The card says so, and offers Rename / Remove.
    function startedFromStatement(sub) { return !!sub && sub.autoCreated === true && sub.source !== 'manual'; }

    // Take an entry away: the entry goes, and so does every remembered merchant that pointed at it, so the next statement payment is not matched to a ghost.
    function removeEntry(subs, map, id) {
        var gone = (subs || []).filter(function (s) { return s && s.id === id; })[0] || null;
        var keys = Object.keys(map || {}).filter(function (k) { return map[k] === id; });
        keys.forEach(function (k) { delete map[k]; });
        return { subscriptions: (subs || []).filter(function (s) { return !s || s.id !== id; }), map: map || {}, removed: gone, forgot: keys.length };
    }

    window.WFSubs = {
        startedFromStatement: startedFromStatement,
        removeEntry: removeEntry,
        merchantKey: merchantKey,
        findExisting: findExisting,
        buildSubscription: buildSubscription,
        recordPayment: recordPayment,
        monthTotal: monthTotal,
        healMonths: healMonths,
        healAll: healAll,
        legacyDueDate: legacyDueDate,
        occurrence: occurrence,
        moveFromLumped: moveFromLumped,
        applyToArrays: applyToArrays,
        apply: apply
    };
    try { console.log('[WFSubs] @info@ subscription auto-routing engine ready'); } catch (_) {}
})();
