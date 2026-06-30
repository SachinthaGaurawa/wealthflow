/* ============================================================================
 * WealthFlow Elite — Notifications Centre  (v7.38.0)
 * ----------------------------------------------------------------------------
 * Self-wiring topbar notifications bell.
 *   • Aggregates URGENT / WARNING / INFO items from existing data only
 *     (cheques, CC one-time, loans, subscriptions, CC installments).
 *     It NEVER writes financial data — read-only via window.DB.
 *   • Red badge = count of UNSEEN urgent + warning items.
 *   • Grouped, professional panel; most-urgent first, newest within a tier.
 *   • Click → navigate to the relevant page + mark seen. Opening = mark seen.
 *   • Optional DEVICE push notifications (Notifications API + service worker),
 *     opt-in via Settings, deduped so each item alerts at most once.
 *   • Settings → Notifications: master + per-category + push toggles.
 *
 * v7.38.0 fixes/upgrades:
 *   1. SEEN-STATE PERSISTENCE — pruneSeen no longer wipes seen ids during the
 *      boot race (empty list) or for transiently-absent items; it only drops
 *      past-month-stamped ids and hard-caps size. Unseen count now survives
 *      reload / app restart correctly.
 *   2. MOBILE CUTOFF — on small screens the panel is viewport-fixed with side
 *      gutters + safe-area insets, so it can never be clipped by the edge.
 *   3. UI — grouped sections, summary line, due chips, refined styling.
 *   4. DEVICE PUSH — reminders surface in the OS notification centre.
 * ==========================================================================*/
(function () {
    'use strict';

    var SEEN_KEY = 'wf2_notif_seen';
    var PUSH_KEY = 'wf2_notif_pushed';
    var ICON = 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1778426077/WealthFlow_Logo_extc7w.png';
    var DEFAULTS = {
        enabled: true,   // master switch
        push: false,     // device push (opt-in; needs OS permission)
        urgent: true,    // overdue / due-very-soon  (counts toward badge)
        dueSoon: true,   // upcoming within warning window (counts toward badge)
        cheques: true,
        ccOneTime: true,
        loans: true,
        ccInstall: true,
        subs: true
    };

    var SVG = {
        cheque: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h6"/></svg>',
        card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
        loan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/></svg>',
        bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
        ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>',
        bellsm: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>'
    };

    /* ---------------------------------------------------------------- utils */
    function $(id) { return document.getElementById(id); }
    function p2(n) { return String(n).padStart(2, '0'); }
    function getArr(k) { try { return (window.DB && window.DB.get) ? (window.DB.get(k) || []) : []; } catch (_) { return []; } }
    function curYM() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
    function dLeft(s) { if (!s) return NaN; var d = new Date(s + 'T00:00:00'), n = new Date(); n.setHours(0, 0, 0, 0); return Math.ceil((d - n) / 86400000); }
    function money(n) { try { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); } catch (_) { return String(n || 0); } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function toast(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) { } }

    /* ------------------------------------------------------------- settings */
    function settings() {
        var s = {};
        try { s = (window.DB && window.DB.getObj) ? (window.DB.getObj('settings', {}) || {}) : {}; } catch (_) { s = {}; }
        var n = (s && s.notif) || {};
        var out = {};
        Object.keys(DEFAULTS).forEach(function (k) { out[k] = (typeof n[k] === 'boolean') ? n[k] : DEFAULTS[k]; });
        return out;
    }
    function saveSettings(n) {
        try {
            var s = (window.DB && window.DB.getObj) ? (window.DB.getObj('settings', {}) || {}) : {};
            s.notif = n;
            if (window.DB && window.DB.set) window.DB.set('settings', s);
        } catch (_) { }
    }

    /* ----------------------------------------------------------- seen-state */
    function seen() { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function saveSeen(o) { try { localStorage.setItem(SEEN_KEY, JSON.stringify(o || {})); } catch (_) { } }
    function pushedMap() { try { return JSON.parse(localStorage.getItem(PUSH_KEY) || '{}') || {}; } catch (_) { return {}; } }
    function savePushed(o) { try { localStorage.setItem(PUSH_KEY, JSON.stringify(o || {})); } catch (_) { } }

    /* --------------------------------------------------------- computation  */
    // { id, sev, cat, icon, title, sub, when, date, sortTs, page }
    function compute() {
        var st = settings();
        var out = [];
        if (!st.enabled) return out;

        // 1) CHEQUES — pending, release date precise
        if (st.cheques) {
            getArr('cheques').forEach(function (c) {
                if (!c || c.status !== 'pending' || !c.release) return;
                var dl = dLeft(c.release); if (isNaN(dl)) return;
                var who = c.party || c.no || 'Cheque', amt = money(c.amount);
                var dir = (c.type === 'issued') ? 'Issued' : 'Received';
                var meta = amt + (c.bank ? ' \u00b7 ' + esc(c.bank) : '');
                if (dl < 0 && st.urgent) out.push({ id: 'chq:' + c.id, sev: 'urgent', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque overdue \u2014 ' + esc(who), sub: meta, when: Math.abs(dl) + 'd over', date: c.release, page: 'cheques' });
                else if (dl === 0 && st.urgent) out.push({ id: 'chq:' + c.id, sev: 'urgent', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque due today \u2014 ' + esc(who), sub: meta, when: 'Today', date: c.release, page: 'cheques' });
                else if (dl >= 1 && dl <= 7 && st.dueSoon) out.push({ id: 'chq:' + c.id, sev: 'warning', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque \u2014 ' + esc(who), sub: 'Releases ' + esc(c.release) + ' \u00b7 ' + meta, when: 'in ' + dl + 'd', date: c.release, page: 'cheques' });
            });
        }

        // 2) CC ONE-TIME — unpaid, deadline precise
        if (st.ccOneTime) {
            getArr('cconetime').forEach(function (x) {
                if (!x || x.paid || !x.deadline) return;
                var dl = dLeft(x.deadline); if (isNaN(dl)) return;
                var label = x.merchant || x.desc || x.name || x.note || x.party || 'Card charge';
                var amt = money(x.combinedTotal != null ? x.combinedTotal : ((x.amount || 0) + (x.serviceFee || 0)));
                var meta = amt + (x.bank ? ' \u00b7 ' + esc(x.bank) : '');
                if (dl < 0 && st.urgent) out.push({ id: 'ccot:' + x.id, sev: 'urgent', cat: 'Card payment', icon: 'card', title: 'Card payment overdue \u2014 ' + esc(label), sub: meta, when: Math.abs(dl) + 'd over', date: x.deadline, page: 'cconetime' });
                else if (dl >= 0 && dl <= 3 && st.urgent) out.push({ id: 'ccot:' + x.id, sev: 'urgent', cat: 'Card payment', icon: 'card', title: 'Card payment due ' + (dl === 0 ? 'today' : 'in ' + dl + 'd') + ' \u2014 ' + esc(label), sub: 'Due ' + esc(x.deadline) + ' \u00b7 ' + meta, when: dl === 0 ? 'Today' : 'in ' + dl + 'd', date: x.deadline, page: 'cconetime' });
                else if (dl >= 4 && dl <= 10 && st.dueSoon) out.push({ id: 'ccot:' + x.id, sev: 'warning', cat: 'Card payment', icon: 'card', title: 'Card payment \u2014 ' + esc(label), sub: 'Due ' + esc(x.deadline) + ' \u00b7 ' + meta, when: 'in ' + dl + 'd', date: x.deadline, page: 'cconetime' });
            });
        }

        // 3) LOANS — per-month paid flags (month precise)
        if (st.loans) {
            var ck = curYM();
            getArr('loans').forEach(function (l) {
                if (!l) return;
                var active = true;
                try { active = (typeof window.loanEndDate === 'function') ? (window.loanEndDate(l) > new Date()) : true; } catch (_) { active = true; }
                if (!active) return;
                var months = [];
                try { months = (typeof window._loanInstallmentMonths === 'function') ? (window._loanInstallmentMonths(l) || []) : []; } catch (_) { months = []; }
                var pays = l.payments || [];
                var paid = function (key) { return pays.some(function (p) { return p && p.month === key && p.paid; }); };
                var overdue = months.filter(function (m) { return m && m.key && m.key < ck && !paid(m.key); });
                var dueNow = months.some(function (m) { return m && m.key === ck; }) && !paid(ck);
                if (overdue.length && st.urgent) {
                    var oldest = overdue[0].key;
                    out.push({ id: 'loan:' + l.id + ':overdue', sev: 'urgent', cat: 'Loan', icon: 'loan', title: 'Loan instalment overdue \u2014 ' + esc(l.name || 'Loan'), sub: overdue.length + ' month' + (overdue.length > 1 ? 's' : '') + ' unpaid (since ' + esc(oldest) + ') \u00b7 ' + money(l.monthly) + '/mo', when: 'Overdue', date: oldest + '-01', page: 'loans' });
                }
                if (dueNow && st.dueSoon) {
                    out.push({ id: 'loan:' + l.id + ':' + ck, sev: 'warning', cat: 'Loan', icon: 'loan', title: 'Loan instalment due this month \u2014 ' + esc(l.name || 'Loan'), sub: money(l.monthly) + (l.bank ? ' \u00b7 ' + esc(l.bank) : ''), when: 'This mo', date: ck + '-01', page: 'loans' });
                }
            });
        }

        // 4) SUBSCRIPTIONS — day-of-month precise (mirrors renderSubscriptions)
        if (st.subs) {
            var d = new Date(), day = d.getDate(), ym = curYM();
            getArr('subscriptions').forEach(function (s) {
                if (!s || !s.dueDay) return;
                var until = s.dueDay - day;
                var amt = money((s.monthOverrides && typeof s.monthOverrides[ym] === 'number') ? s.monthOverrides[ym] : s.amount);
                var sortDate = ym + '-' + p2(Math.min(28, Math.max(1, s.dueDay)));
                if (until < 0 && st.urgent) out.push({ id: 'sub:' + s.id + ':' + ym, sev: 'urgent', cat: 'Bill', icon: 'bill', title: 'Bill overdue \u2014 ' + esc(s.name || 'Subscription'), sub: 'Was due day ' + s.dueDay + ' \u00b7 ' + amt, when: Math.abs(until) + 'd over', date: sortDate, page: 'subscriptions' });
                else if (until >= 0 && until <= 7 && st.dueSoon) out.push({ id: 'sub:' + s.id + ':' + ym, sev: 'warning', cat: 'Bill', icon: 'bill', title: 'Bill \u2014 ' + esc(s.name || 'Subscription'), sub: 'Day ' + s.dueDay + ' \u00b7 ' + amt, when: until === 0 ? 'Today' : 'in ' + until + 'd', date: sortDate, page: 'subscriptions' });
            });
        }

        // 5) CC INSTALLMENTS — no due-day / no paid flag → INFO only (never false urgent)
        if (st.ccInstall) {
            var ymi = curYM();
            getArr('ccinstall').forEach(function (x) {
                if (!x || x.completed) return;
                var active = true;
                try { var end = new Date(x.date + 'T00:00:00'); end.setMonth(end.getMonth() + (x.duration || 0)); active = end > new Date(); } catch (_) { active = true; }
                if (!active) return;
                out.push({ id: 'cci:' + x.id + ':' + ymi, sev: 'info', cat: 'Installment', icon: 'card', title: 'Card instalment active \u2014 ' + esc(x.product || 'Installment'), sub: money(x.monthly) + '/mo' + (x.bank ? ' \u00b7 ' + esc(x.bank) : ''), when: 'Active', date: ymi + '-01', page: 'ccinstall' });
            });
        }

        var rank = { urgent: 0, warning: 1, info: 2 };
        out.forEach(function (n) { n.sortTs = n.date ? new Date(n.date + 'T00:00:00').getTime() : 0; });
        out.sort(function (a, b) {
            if (rank[a.sev] !== rank[b.sev]) return rank[a.sev] - rank[b.sev];
            if (b.sortTs !== a.sortTs) return b.sortTs - a.sortTs;
            return String(a.id).localeCompare(String(b.id));
        });
        return out;
    }

    /* ------------------------------------------------------------- state    */
    var _list = [];
    var _panelOpen = false;
    var _seenSnapshot = {};
    var _refreshTimer = null;

    function unseenCount() {
        var sn = seen(), c = 0;
        for (var i = 0; i < _list.length; i++) {
            var n = _list[i];
            if ((n.sev === 'urgent' || n.sev === 'warning') && !sn[n.id]) c++;
        }
        return c;
    }

    // SAFE prune: never wipe on empty list / boot race; only drop ids stamped
    // with a PAST month (safe to forget), keep everything else, hard-cap size.
    function pruneSeen() {
        try {
            if (!_list.length) return;
            var sn = seen(), curM = curYM(), changed = false, active = {};
            _list.forEach(function (n) { active[n.id] = true; });
            Object.keys(sn).forEach(function (id) {
                if (active[id]) return;
                var m = id.match(/:(\d{4}-\d{2})$/);
                if (m && m[1] < curM) { delete sn[id]; changed = true; }
            });
            var keys = Object.keys(sn);
            if (keys.length > 800) { keys.slice(0, keys.length - 800).forEach(function (k) { delete sn[k]; }); changed = true; }
            if (changed) saveSeen(sn);
        } catch (_) { }
    }
    function prunePushed() {
        try {
            if (!_list.length) return;
            var pm = pushedMap(), curM = curYM(), changed = false, active = {};
            _list.forEach(function (n) { active[n.id] = true; });
            Object.keys(pm).forEach(function (id) {
                if (active[id]) return;
                var m = id.match(/:(\d{4}-\d{2})$/);
                if (m && m[1] < curM) { delete pm[id]; changed = true; }
            });
            var keys = Object.keys(pm);
            if (keys.length > 800) { keys.slice(0, keys.length - 800).forEach(function (k) { delete pm[k]; }); changed = true; }
            if (changed) savePushed(pm);
        } catch (_) { }
    }

    function updateBadge() {
        var b = $('wfNotifBadge'); if (!b) return;
        var n = unseenCount();
        if (n > 0) { b.style.display = ''; b.textContent = n > 99 ? '99+' : String(n); }
        else { b.style.display = 'none'; b.textContent = '0'; }
        var btn = $('wfNotifBtn'); if (btn) btn.classList.toggle('has-unseen', n > 0);
    }

    function refresh() {
        _list = compute();
        pruneSeen();
        prunePushed();
        updateBadge();
        if (_panelOpen) renderPanel();
        maybePush();
    }
    function scheduleRefresh() {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(refresh, 250);
    }

    /* ----------------------------------------------------------- device push */
    function canPush() {
        var st = settings();
        return !!st.enabled && !!st.push && ('Notification' in window) && (window.Notification.permission === 'granted');
    }
    function showDeviceNotification(title, body, page, count, tag) {
        try {
            var opts = { body: body || '', tag: tag || 'wf-payment', renotify: true, icon: ICON, badge: ICON, data: { page: page || '' } };
            if (navigator.serviceWorker && navigator.serviceWorker.ready && navigator.serviceWorker.ready.then) {
                navigator.serviceWorker.ready.then(function (reg) {
                    try { reg.showNotification(title, opts); }
                    catch (_) { try { fallbackNotify(title, opts, page); } catch (__) { } }
                }).catch(function () { try { fallbackNotify(title, opts, page); } catch (_) { } });
            } else { fallbackNotify(title, opts, page); }
        } catch (_) { }
    }
    function fallbackNotify(title, opts, page) {
        if (!('Notification' in window)) return;
        var n = new window.Notification(title, opts);
        n.onclick = function () { try { window.focus(); if (page && typeof window.showPage === 'function') window.showPage(page); } catch (_) { } n.close(); };
    }
    // Push each pushable (urgent/warning) item at most once; batch when several.
    function maybePush() {
        if (!canPush()) return;
        var pm = pushedMap();
        var fresh = _list.filter(function (n) { return (n.sev === 'urgent' || n.sev === 'warning') && !pm[n.id]; });
        if (!fresh.length) return;
        fresh.forEach(function (n) { pm[n.id] = Date.now(); });
        savePushed(pm);
        if (fresh.length === 1) {
            showDeviceNotification('WealthFlow', fresh[0].title + (fresh[0].sub ? ' \u2014 ' + fresh[0].sub : ''), fresh[0].page, 1, 'wf-payment');
        } else {
            var body = fresh.slice(0, 4).map(function (n) { return '\u2022 ' + n.title; }).join('\n');
            if (fresh.length > 4) body += '\n\u2026and ' + (fresh.length - 4) + ' more';
            showDeviceNotification('WealthFlow \u2014 ' + fresh.length + ' need attention', body, '', fresh.length, 'wf-payment');
        }
    }
    function requestPush() {
        if (!('Notification' in window)) { toast('Notifications aren\u2019t supported on this device or browser.', 'warn'); return; }
        if (window.Notification.permission === 'denied') { toast('Notifications are blocked for this site. Enable them in your browser settings, then try again.', 'warn'); return; }
        try {
            var p = window.Notification.requestPermission(function (perm) { _afterPerm(perm); });
            if (p && p.then) p.then(_afterPerm).catch(function () { });
        } catch (_) { }
    }
    function _afterPerm(perm) {
        var st = settings();
        st.push = (perm === 'granted');
        saveSettings(st);
        syncSettingsUI();
        if (perm === 'granted') {
            var pm = pushedMap();
            var fresh = _list.filter(function (n) { return (n.sev === 'urgent' || n.sev === 'warning') && !pm[n.id]; });
            if (fresh.length) maybePush();
            else showDeviceNotification('WealthFlow notifications are on', 'You\u2019ll be reminded here when a payment or cheque needs attention.', '', 1, 'wf-info');
            toast('Device notifications enabled.', 'success');
        } else {
            toast('Permission not granted \u2014 device push stays off.', 'warn');
        }
    }

    /* -------------------------------------------------------------- panel   */
    function rowHtml(n) {
        return '<button type="button" class="wfntf-item sev-' + n.sev + (((n.sev === 'urgent' || n.sev === 'warning') && !_seenSnapshot[n.id]) ? ' is-new' : '') + '" onclick="WFNotif._click(' + n._i + ')">' +
            '<span class="wfntf-ic">' + (SVG[n.icon] || SVG.bill) + '</span>' +
            '<span class="wfntf-body">' +
            '<span class="wfntf-title">' + n.title + '</span>' +
            '<span class="wfntf-sub">' + n.sub + '</span>' +
            '</span>' +
            '<span class="wfntf-meta">' + (n.when ? '<span class="wfntf-when">' + esc(n.when) + '</span>' : '') + '<span class="wfntf-go">&rsaquo;</span></span>' +
            '</button>';
    }
    function renderPanel() {
        var p = $('wfNotifPanel'); if (!p) return;
        var st = settings();
        _list.forEach(function (n, i) { n._i = i; });

        var urgent = _list.filter(function (n) { return n.sev === 'urgent'; });
        var warning = _list.filter(function (n) { return n.sev === 'warning'; });
        var info = _list.filter(function (n) { return n.sev === 'info'; });
        var attn = urgent.length + warning.length;

        var head = '<div class="wfntf-head">' +
            '<div class="wfntf-h-l"><span class="wfntf-h-ic">' + SVG.bellsm + '</span><span class="wfntf-h-title">Notifications</span></div>' +
            (_list.length ? '<button type="button" class="wfntf-readall" onclick="WFNotif.markAllRead()">Mark all read</button>' : '') +
            '</div>';

        if (!st.enabled) {
            p.innerHTML = head + '<div class="wfntf-empty"><div class="wfntf-empty-ic">' + SVG.bellsm + '</div><div class="wfntf-empty-t">Notifications are off</div><div class="wfntf-empty-sub">Turn them on in Settings \u2192 Notifications.</div></div>' + footHtml();
            return;
        }
        if (!_list.length) {
            p.innerHTML = head + '<div class="wfntf-empty"><div class="wfntf-empty-ic ok">' + SVG.ok + '</div><div class="wfntf-empty-t">You\u2019re all clear</div><div class="wfntf-empty-sub">No payments or cheques need attention right now.</div></div>' + footHtml();
            return;
        }

        var summary = '<div class="wfntf-summary">' +
            (attn > 0
                ? '<span class="wfntf-sum-strong">' + attn + '</span> ' + (attn === 1 ? 'item needs' : 'items need') + ' attention'
                : 'Nothing urgent \u2014 just a heads-up') +
            '</div>';

        function group(label, key, items) {
            if (!items.length) return '';
            return '<div class="wfntf-group">' +
                '<div class="wfntf-group-h"><span class="wfntf-gdot ' + key + '"></span>' + label + '<span class="wfntf-gn">' + items.length + '</span></div>' +
                items.map(rowHtml).join('') +
                '</div>';
        }

        p.innerHTML = head + summary +
            '<div class="wfntf-scroll">' +
            group('Needs attention', 'urgent', urgent) +
            group('Coming up', 'warning', warning) +
            group('Good to know', 'info', info) +
            '</div>' +
            footHtml();
    }
    function footHtml() {
        return '<div class="wfntf-foot"><button type="button" class="wfntf-foot-btn" onclick="WFNotif.openSettings()">' + SVG.bellsm + ' Notification settings</button></div>';
    }

    function openPanel() {
        var p = $('wfNotifPanel'); if (!p) return;
        _seenSnapshot = seen();
        _list = compute();
        _panelOpen = true;
        renderPanel();
        p.classList.add('open');
        var btn = $('wfNotifBtn'); if (btn) btn.classList.add('active');
        var sn = seen();
        _list.forEach(function (n) { sn[n.id] = true; });
        saveSeen(sn);
        updateBadge();
        setTimeout(function () { document.addEventListener('mousedown', _outside, true); document.addEventListener('keydown', _escKey, true); }, 0);
    }
    function closePanel() {
        var p = $('wfNotifPanel'); if (p) p.classList.remove('open');
        var btn = $('wfNotifBtn'); if (btn) btn.classList.remove('active');
        _panelOpen = false;
        document.removeEventListener('mousedown', _outside, true);
        document.removeEventListener('keydown', _escKey, true);
    }
    function togglePanel() { _panelOpen ? closePanel() : openPanel(); }
    function _outside(e) { var w = document.querySelector('.wfntf-wrap'); if (w && !w.contains(e.target)) closePanel(); }
    function _escKey(e) { if (e.key === 'Escape') closePanel(); }

    function clickRow(i) {
        var n = _list[i]; if (!n) { closePanel(); return; }
        var sn = seen(); sn[n.id] = true; saveSeen(sn);
        closePanel();
        try { if (typeof window.showPage === 'function') window.showPage(n.page); } catch (_) { }
        setTimeout(updateBadge, 30);
    }
    function markAllRead() {
        var sn = seen(); _list.forEach(function (n) { sn[n.id] = true; }); saveSeen(sn);
        _seenSnapshot = sn; updateBadge(); renderPanel();
    }

    /* ----------------------------------------------------- settings UI sync */
    function toggleSetting(key, btn) {
        var st = settings();
        if (!(key in st)) return;
        if (key === 'push') {
            if (!st.push) { requestPush(); }            // turning on → ask OS permission
            else { st.push = false; saveSettings(st); syncSettingsUI(); }
            return;
        }
        st[key] = !st[key];
        saveSettings(st);
        syncSettingsUI();
        refresh();
    }
    function syncSettingsUI() {
        var st = settings();
        Object.keys(DEFAULTS).forEach(function (k) {
            var el = $('wfntfTgl_' + k);
            if (!el) return;
            var on = !!st[k];
            el.classList.toggle('on', on);
            el.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        var body = $('wfntfSettingsBody');
        if (body) body.classList.toggle('master-off', !st.enabled);
        var ps = $('wfntfPushState');
        if (ps) {
            var supported = ('Notification' in window);
            var perm = supported ? window.Notification.permission : 'unsupported';
            ps.textContent = !supported ? 'Not supported on this device'
                : perm === 'denied' ? 'Blocked in browser settings'
                    : (st.push && perm === 'granted') ? 'On for this device' : 'Off';
        }
    }
    function openSettings() {
        closePanel();
        try { if (typeof window.showPage === 'function') window.showPage('settings'); } catch (_) { }
        setTimeout(function () { try { syncSettingsUI(); var c = $('wfntfSettingsCard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { } }, 120);
    }

    /* ------------------------------------------------------------- styles   */
    function injectCSS() {
        if ($('wfntf-css')) return;
        var css = '' +
            '.wfntf-wrap{position:relative;display:inline-flex}' +
            '.wfntf-btn{position:relative}' +
            '.wfntf-btn.has-unseen{color:var(--accent,#d4af37)}' +
            '.wfntf-badge{position:absolute;top:-3px;right:-3px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--red,#ef4444);color:#fff;font-size:10px;font-weight:800;line-height:17px;text-align:center;box-shadow:0 0 0 2px var(--card,#16161f);font-family:var(--mono,ui-monospace,monospace)}' +
            '.wfntf-btn.has-unseen .wfntf-badge{animation:wfntfPulse 2s ease-in-out infinite}' +
            '@keyframes wfntfPulse{0%,100%{box-shadow:0 0 0 2px var(--card,#16161f),0 0 0 0 rgba(239,68,68,.5)}50%{box-shadow:0 0 0 2px var(--card,#16161f),0 0 0 5px rgba(239,68,68,0)}}' +
            '.wfntf-panel{position:absolute;top:calc(100% + 10px);right:0;width:min(384px,calc(100vw - 24px));max-height:min(580px,calc(100vh - 110px));overflow:hidden;display:none;flex-direction:column;background:var(--card,#16161f);border:1px solid var(--border2,#2a2a38);border-radius:18px;box-shadow:0 28px 70px rgba(0,0,0,.6),0 2px 10px rgba(0,0,0,.45);z-index:5000;animation:wfntfIn .17s cubic-bezier(.2,.8,.2,1)}' +
            '.wfntf-panel.open{display:flex}' +
            '@keyframes wfntfIn{from{opacity:0;transform:translateY(-8px) scale(.98)}to{opacity:1;transform:translateY(0) scale(1)}}' +
            '.wfntf-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px 12px;border-bottom:1px solid var(--border,#23232f);background:linear-gradient(180deg,rgba(212,175,55,.06),transparent)}' +
            '.wfntf-h-l{display:flex;align-items:center;gap:9px}' +
            '.wfntf-h-ic{width:26px;height:26px;border-radius:8px;display:grid;place-items:center;color:var(--accent,#d4af37);background:rgba(212,175,55,.12)}' +
            '.wfntf-h-ic svg{width:15px;height:15px}' +
            '.wfntf-h-title{font-weight:800;font-size:15px;color:var(--text,#f4f4f6);letter-spacing:.2px}' +
            '.wfntf-readall{background:transparent;border:none;color:var(--accent,#d4af37);font-size:11.5px;font-weight:700;cursor:pointer;padding:5px 8px;border-radius:8px}' +
            '.wfntf-readall:hover{background:rgba(212,175,55,.12)}' +
            '.wfntf-summary{padding:9px 16px;font-size:12px;color:var(--text3,#8a8a99);border-bottom:1px solid var(--border,#23232f)}' +
            '.wfntf-sum-strong{color:var(--text,#f4f4f6);font-weight:800}' +
            '.wfntf-scroll{overflow-y:auto;padding:8px;display:flex;flex-direction:column;gap:10px}' +
            '.wfntf-group{display:flex;flex-direction:column;gap:5px}' +
            '.wfntf-group-h{display:flex;align-items:center;gap:7px;padding:2px 6px;font-size:10px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:var(--text3,#8a8a99)}' +
            '.wfntf-gdot{width:7px;height:7px;border-radius:50%}' +
            '.wfntf-gdot.urgent{background:var(--red,#ef4444)}.wfntf-gdot.warning{background:var(--gold,#f5a623)}.wfntf-gdot.info{background:var(--blue,#579bfc)}' +
            '.wfntf-gn{margin-left:auto;background:rgba(255,255,255,.06);color:var(--text2,#b8b8c4);font-size:10px;font-weight:800;padding:1px 7px;border-radius:8px;letter-spacing:0}' +
            '.wfntf-item{display:flex;align-items:flex-start;gap:11px;width:100%;text-align:left;background:var(--bg2,#101018);border:1px solid var(--border,#23232f);border-radius:13px;padding:11px 12px;cursor:pointer;position:relative;overflow:hidden;transition:transform .08s ease,border-color .12s ease,background .12s ease}' +
            '.wfntf-item:hover{background:var(--card2,#1c1c28);border-color:var(--border2,#2a2a38);transform:translateX(2px)}' +
            '.wfntf-item:active{transform:scale(.99)}' +
            '.wfntf-item::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:transparent}' +
            '.wfntf-item.sev-urgent::before{background:var(--red,#ef4444)}' +
            '.wfntf-item.sev-warning::before{background:var(--gold,#f5a623)}' +
            '.wfntf-item.sev-info::before{background:var(--blue,#579bfc)}' +
            '.wfntf-ic{flex:0 0 auto;width:32px;height:32px;border-radius:10px;display:grid;place-items:center;color:var(--text2,#b8b8c4);background:rgba(255,255,255,.04)}' +
            '.wfntf-ic svg{width:17px;height:17px}' +
            '.wfntf-item.sev-urgent .wfntf-ic{color:var(--red,#ef4444);background:rgba(239,68,68,.12)}' +
            '.wfntf-item.sev-warning .wfntf-ic{color:var(--gold,#f5a623);background:rgba(245,166,35,.12)}' +
            '.wfntf-item.sev-info .wfntf-ic{color:var(--blue,#579bfc);background:rgba(87,155,252,.12)}' +
            '.wfntf-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}' +
            '.wfntf-title{font-size:12.5px;font-weight:700;color:var(--text,#f4f4f6);line-height:1.32;overflow-wrap:anywhere}' +
            '.wfntf-sub{font-size:11px;color:var(--text3,#8a8a99);line-height:1.3;overflow-wrap:anywhere}' +
            '.wfntf-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px;padding-left:2px}' +
            '.wfntf-when{font-size:9.5px;font-weight:800;letter-spacing:.2px;white-space:nowrap;padding:2px 7px;border-radius:7px;color:var(--text2,#b8b8c4);background:rgba(255,255,255,.06)}' +
            '.wfntf-item.sev-urgent .wfntf-when{color:#fff;background:var(--red,#ef4444)}' +
            '.wfntf-item.sev-warning .wfntf-when{color:#1a1205;background:var(--gold,#f5a623)}' +
            '.wfntf-go{font-size:18px;color:var(--text3,#8a8a99);line-height:1}' +
            '.wfntf-item.is-new::after{content:"";position:absolute;top:10px;right:10px;width:7px;height:7px;border-radius:50%;background:var(--red,#ef4444);box-shadow:0 0 0 3px var(--bg2,#101018)}' +
            '.wfntf-empty{padding:40px 22px;text-align:center;color:var(--text2,#b8b8c4)}' +
            '.wfntf-empty-ic{width:52px;height:52px;border-radius:50%;margin:0 auto 14px;display:grid;place-items:center;background:rgba(255,255,255,.05);color:var(--text3,#8a8a99)}' +
            '.wfntf-empty-ic.ok{background:rgba(46,204,113,.12);color:var(--green,#2ecc71)}' +
            '.wfntf-empty-ic svg{width:24px;height:24px}' +
            '.wfntf-empty-t{font-size:14px;font-weight:800;color:var(--text,#f4f4f6)}' +
            '.wfntf-empty-sub{font-size:11.5px;color:var(--text3,#8a8a99);margin-top:5px}' +
            '.wfntf-foot{border-top:1px solid var(--border,#23232f);padding:8px}' +
            '.wfntf-foot-btn{width:100%;display:flex;align-items:center;justify-content:center;gap:7px;background:transparent;border:none;color:var(--text3,#8a8a99);font-size:11.5px;font-weight:700;cursor:pointer;padding:8px;border-radius:9px}' +
            '.wfntf-foot-btn svg{width:14px;height:14px}' +
            '.wfntf-foot-btn:hover{background:rgba(255,255,255,.04);color:var(--text,#f4f4f6)}' +
            // mobile: viewport-fixed so the panel can NEVER be clipped by the edge
            '@media (max-width:560px){.wfntf-wrap{position:static}.wfntf-panel{position:fixed;top:calc(env(safe-area-inset-top,0px) + 58px);left:calc(env(safe-area-inset-left,0px) + 10px);right:calc(env(safe-area-inset-right,0px) + 10px);width:auto;max-width:none;max-height:calc(100vh - env(safe-area-inset-top,0px) - 78px)}}' +
            // settings card toggles
            '.wfntf-set-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-top:1px solid var(--border,#23232f)}' +
            '.wfntf-set-row:first-of-type{border-top:none}' +
            '#wfntfSettingsBody.master-off .wfntf-dep{opacity:.45;pointer-events:none}' +
            '.wfntf-pushstate{font-size:10.5px;font-weight:700;color:var(--text3,#8a8a99);margin-top:3px}' +
            '.wfntf-switch{flex:0 0 auto;width:46px;height:26px;border-radius:999px;background:var(--border2,#2a2a38);border:1px solid var(--border2,#2a2a38);position:relative;cursor:pointer;transition:background .16s ease;padding:0}' +
            '.wfntf-switch::after{content:"";position:absolute;top:2px;left:2px;width:20px;height:20px;border-radius:50%;background:#fff;transition:transform .17s cubic-bezier(.2,.8,.2,1);box-shadow:0 1px 3px rgba(0,0,0,.4)}' +
            '.wfntf-switch.on{background:var(--accent,#d4af37);border-color:var(--accent,#d4af37)}' +
            '.wfntf-switch.on::after{transform:translateX(20px)}' +
            '';
        var st = document.createElement('style');
        st.id = 'wfntf-css';
        st.textContent = css;
        document.head.appendChild(st);
    }

    /* --------------------------------------------------- settings card HTML */
    function buildSettingsCard() {
        var card = $('wfntfSettingsCard');
        if (!card) return;
        if (card.getAttribute('data-built') === '1') { syncSettingsUI(); return; }
        function row(key, label, desc, dep, extra) {
            return '<div class="wfntf-set-row' + (dep ? ' wfntf-dep' : '') + '">' +
                '<div class="setting-info"><div class="setting-label">' + label + '</div><div class="setting-desc">' + desc + '</div>' + (extra || '') + '</div>' +
                '<button type="button" id="wfntfTgl_' + key + '" class="wfntf-switch" role="switch" aria-checked="false" onclick="WFNotif.toggleSetting(\'' + key + '\',this)"></button>' +
                '</div>';
        }
        card.innerHTML =
            '<div class="settings-title" style="color:var(--accent,#d4af37);">Notifications</div>' +
            '<div id="wfntfSettingsBody">' +
            row('enabled', 'Enable notifications', 'Master switch for the topbar bell and its red unseen badge.', false) +
            row('push', 'Device push notifications', 'Also remind you in your phone/computer notification centre when something needs attention.', true, '<div class="wfntf-pushstate" id="wfntfPushState">Off</div>') +
            row('urgent', 'Urgent alerts', 'Overdue items and payments due very soon. These count toward the red badge.', true) +
            row('dueSoon', 'Due-soon warnings', 'Upcoming payments and cheques approaching their date.', true) +
            row('cheques', 'Cheques', 'Pending cheques nearing or past their release date.', true) +
            row('ccOneTime', 'Card payments', 'Unpaid one-time credit-card charges nearing or past their deadline.', true) +
            row('loans', 'Loan instalments', 'Loan EMIs due this month or overdue.', true) +
            row('subs', 'Bills & subscriptions', 'Recurring bills due soon or overdue.', true) +
            row('ccInstall', 'Card instalments', 'Active credit-card instalment plans (informational).', true) +
            '</div>';
        card.setAttribute('data-built', '1');
        syncSettingsUI();
    }

    /* ----------------------------------------------------------- self-wire  */
    function wrap(name, after) {
        var orig = window[name];
        if (typeof orig !== 'function' || orig.__wfntfWrapped) return;
        var wrapped = function () { var r = orig.apply(this, arguments); try { after.apply(null, arguments); } catch (_) { } return r; };
        wrapped.__wfntfWrapped = true;
        try { window[name] = wrapped; } catch (_) { }
    }
    function wrapDBset() {
        try {
            if (!window.DB || typeof window.DB.set !== 'function' || window.DB.set.__wfntfWrapped) return;
            var orig = window.DB.set;
            var w = function () { var r = orig.apply(this, arguments); scheduleRefresh(); return r; };
            w.__wfntfWrapped = true;
            window.DB.set = w;
        } catch (_) { }
    }
    function wireAll() {
        injectCSS();
        wrapDBset();
        wrap('showPage', function () { closePanel(); scheduleRefresh(); });
        wrap('updateCCOTBadge', function () { scheduleRefresh(); });
        wrap('updateChequeBadge', function () { scheduleRefresh(); });
        wrap('renderSettings', function () { setTimeout(buildSettingsCard, 0); });
        buildSettingsCard();
        refresh();
    }
    var _wireTries = 0;
    function bootWire() {
        wireAll();
        _wireTries++;
        var needRetry = !(window.DB && window.DB.set && window.DB.set.__wfntfWrapped) ||
            typeof window.showPage !== 'function' ||
            !(window.showPage && window.showPage.__wfntfWrapped);
        if (_wireTries < 25 && needRetry) setTimeout(bootWire, 400);
    }
    function start() {
        bootWire();
        setInterval(refresh, 60000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
        window.addEventListener('online', refresh);
        window.addEventListener('focus', scheduleRefresh);
        // Tapping a device notification → focus app + navigate (SW relays the page).
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.addEventListener) {
                navigator.serviceWorker.addEventListener('message', function (e) {
                    if (e && e.data && e.data.type === 'wf-notif-open') {
                        try { if (e.data.page && typeof window.showPage === 'function') window.showPage(e.data.page); } catch (_) { }
                    }
                });
            }
        } catch (_) { }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    /* --------------------------------------------------------------- expose */
    window.WFNotif = {
        togglePanel: togglePanel, openPanel: openPanel, closePanel: closePanel,
        _click: clickRow, markAllRead: markAllRead,
        toggleSetting: toggleSetting, syncSettingsUI: syncSettingsUI, openSettings: openSettings,
        refresh: refresh, compute: compute, _count: unseenCount
    };
})();
