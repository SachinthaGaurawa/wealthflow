/* ============================================================================
 * WealthFlow Elite — Notifications Centre  (v7.37.0)
 * ----------------------------------------------------------------------------
 * A self-wiring, zero-config topbar notifications bell:
 *   • Aggregates URGENT / WARNING / INFO items from existing data only
 *     (cheques, credit-card one-time charges, loans, subscriptions,
 *      credit-card installments) — it NEVER writes financial data.
 *   • Red badge shows the count of UNSEEN urgent + warning notifications.
 *   • Panel lists items newest-first within each severity tier.
 *   • Clicking a notification navigates straight to the relevant page and
 *     marks it as seen. Opening the panel marks everything shown as seen.
 *   • Settings → Notifications card with master + per-category on/off toggles.
 *
 * Integration is done entirely from here by wrapping a few global functions
 * (DB.set, showPage, updateCCOTBadge, updateChequeBadge, renderSettings) plus
 * a refresh timer / focus / online listener, so the badge stays live in every
 * path — local edits AND incoming cross-device cloud updates. The only markup
 * added to index.html is the bell button, this <script> tag, and the settings
 * card shell. Loaded with `defer`, so all app globals already exist.
 * ==========================================================================*/
(function () {
    'use strict';

    var SEEN_KEY = 'wf2_notif_seen';
    var DEFAULTS = {
        enabled: true,   // master switch
        urgent: true,    // overdue / due-very-soon (counts toward the red badge)
        dueSoon: true,   // upcoming within the warning window (counts toward badge)
        cheques: true,
        ccOneTime: true,
        loans: true,
        ccInstall: true,
        subs: true
    };

    // Inline SVGs keep the panel self-contained and emoji-free regardless of
    // the icon system's dynamic-render timing (the static topbar button still
    // uses data-wfi="bell" to match the rest of the header).
    var SVG = {
        cheque: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h6"/></svg>',
        card: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg>',
        loan: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21h18M5 21V10l7-5 7 5v11M9 21v-6h6v6"/></svg>',
        bill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></svg>',
        ok: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>'
    };

    /* ---------------------------------------------------------------- utils */
    function $(id) { return document.getElementById(id); }
    function p2(n) { return String(n).padStart(2, '0'); }
    function getArr(k) { try { return (window.DB && window.DB.get) ? (window.DB.get(k) || []) : []; } catch (_) { return []; } }
    function todayStr() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
    function curYM() { var d = new Date(); return d.getFullYear() + '-' + p2(d.getMonth() + 1); }
    function dLeft(s) { if (!s) return NaN; var d = new Date(s + 'T00:00:00'), n = new Date(); n.setHours(0, 0, 0, 0); return Math.ceil((d - n) / 86400000); }
    function money(n) { try { return Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 }); } catch (_) { return String(n || 0); } }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

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

    /* --------------------------------------------------------- computation  */
    // Notification shape:
    //   { id, sev:'urgent'|'warning'|'info', cat, icon, title, sub, date, sortTs, page }
    function compute() {
        var st = settings();
        var out = [];
        if (!st.enabled) return out;

        // 1) CHEQUES — pending, release date precise
        if (st.cheques) {
            getArr('cheques').forEach(function (c) {
                if (!c || c.status !== 'pending' || !c.release) return;
                var dl = dLeft(c.release);
                if (isNaN(dl)) return;
                var who = c.party || c.no || 'Cheque';
                var amt = money(c.amount);
                var dir = (c.type === 'issued') ? 'Issued' : 'Received';
                var meta = amt + (c.bank ? ' · ' + esc(c.bank) : '');
                if (dl < 0 && st.urgent) out.push({ id: 'chq:' + c.id, sev: 'urgent', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque overdue — ' + esc(who), sub: Math.abs(dl) + 'd overdue · ' + meta, date: c.release, page: 'cheques' });
                else if (dl === 0 && st.urgent) out.push({ id: 'chq:' + c.id, sev: 'urgent', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque due today — ' + esc(who), sub: 'Release date today · ' + meta, date: c.release, page: 'cheques' });
                else if (dl >= 1 && dl <= 7 && st.dueSoon) out.push({ id: 'chq:' + c.id, sev: 'warning', cat: 'Cheque', icon: 'cheque', title: dir + ' cheque due in ' + dl + 'd — ' + esc(who), sub: 'Releases ' + esc(c.release) + ' · ' + meta, date: c.release, page: 'cheques' });
            });
        }

        // 2) CC ONE-TIME — unpaid, deadline precise
        if (st.ccOneTime) {
            getArr('cconetime').forEach(function (x) {
                if (!x || x.paid || !x.deadline) return;
                var dl = dLeft(x.deadline);
                if (isNaN(dl)) return;
                var label = x.merchant || x.desc || x.name || x.note || x.party || 'Card charge';
                var amt = money(x.combinedTotal != null ? x.combinedTotal : ((x.amount || 0) + (x.serviceFee || 0)));
                var meta = amt + (x.bank ? ' · ' + esc(x.bank) : '');
                if (dl < 0 && st.urgent) out.push({ id: 'ccot:' + x.id, sev: 'urgent', cat: 'Card payment', icon: 'card', title: 'Card payment overdue — ' + esc(label), sub: Math.abs(dl) + 'd overdue · ' + meta, date: x.deadline, page: 'cconetime' });
                else if (dl >= 0 && dl <= 3 && st.urgent) out.push({ id: 'ccot:' + x.id, sev: 'urgent', cat: 'Card payment', icon: 'card', title: 'Card payment due ' + (dl === 0 ? 'today' : 'in ' + dl + 'd') + ' — ' + esc(label), sub: 'Due ' + esc(x.deadline) + ' · ' + meta, date: x.deadline, page: 'cconetime' });
                else if (dl >= 4 && dl <= 10 && st.dueSoon) out.push({ id: 'ccot:' + x.id, sev: 'warning', cat: 'Card payment', icon: 'card', title: 'Card payment due in ' + dl + 'd — ' + esc(label), sub: 'Due ' + esc(x.deadline) + ' · ' + meta, date: x.deadline, page: 'cconetime' });
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
                    out.push({ id: 'loan:' + l.id + ':overdue', sev: 'urgent', cat: 'Loan', icon: 'loan', title: 'Loan instalment overdue — ' + esc(l.name || 'Loan'), sub: overdue.length + ' month' + (overdue.length > 1 ? 's' : '') + ' unpaid (since ' + esc(oldest) + ') · ' + money(l.monthly) + '/mo', date: oldest + '-01', page: 'loans' });
                }
                if (dueNow && st.dueSoon) {
                    out.push({ id: 'loan:' + l.id + ':' + ck, sev: 'warning', cat: 'Loan', icon: 'loan', title: 'Loan instalment due this month — ' + esc(l.name || 'Loan'), sub: money(l.monthly) + (l.bank ? ' · ' + esc(l.bank) : ''), date: ck + '-01', page: 'loans' });
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
                if (until < 0 && st.urgent) out.push({ id: 'sub:' + s.id + ':' + ym, sev: 'urgent', cat: 'Bill', icon: 'bill', title: 'Bill overdue — ' + esc(s.name || 'Subscription'), sub: Math.abs(until) + 'd past day ' + s.dueDay + ' · ' + amt, date: sortDate, page: 'subscriptions' });
                else if (until >= 0 && until <= 7 && st.dueSoon) out.push({ id: 'sub:' + s.id + ':' + ym, sev: 'warning', cat: 'Bill', icon: 'bill', title: 'Bill due ' + (until === 0 ? 'today' : 'in ' + until + 'd') + ' — ' + esc(s.name || 'Subscription'), sub: 'Day ' + s.dueDay + ' · ' + amt, date: sortDate, page: 'subscriptions' });
            });
        }

        // 5) CC INSTALLMENTS — no due-day / no per-month paid flag in the data
        //    model (cciProgress is time-elapsed only). To stay 100% accurate we
        //    surface active plans as INFO only — never a false urgent/overdue.
        if (st.ccInstall) {
            var ymi = curYM();
            getArr('ccinstall').forEach(function (x) {
                if (!x || x.completed) return;
                var active = true;
                try { var end = new Date(x.date + 'T00:00:00'); end.setMonth(end.getMonth() + (x.duration || 0)); active = end > new Date(); } catch (_) { active = true; }
                if (!active) return;
                out.push({ id: 'cci:' + x.id + ':' + ymi, sev: 'info', cat: 'Installment', icon: 'card', title: 'Card instalment active — ' + esc(x.product || 'Installment'), sub: money(x.monthly) + '/mo' + (x.bank ? ' · ' + esc(x.bank) : ''), date: ymi + '-01', page: 'ccinstall' });
            });
        }

        // Order: urgent → warning → info; within a tier, newest date first.
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
        var sn = seen();
        var c = 0;
        for (var i = 0; i < _list.length; i++) {
            var n = _list[i];
            if ((n.sev === 'urgent' || n.sev === 'warning') && !sn[n.id]) c++;
        }
        return c;
    }

    function pruneSeen() {
        try {
            var sn = seen(), active = {}, changed = false;
            _list.forEach(function (n) { active[n.id] = true; });
            Object.keys(sn).forEach(function (id) { if (!active[id]) { delete sn[id]; changed = true; } });
            if (changed) saveSeen(sn);
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
        updateBadge();
        if (_panelOpen) renderPanel();
    }
    function scheduleRefresh() {
        if (_refreshTimer) clearTimeout(_refreshTimer);
        _refreshTimer = setTimeout(refresh, 250);
    }

    /* -------------------------------------------------------------- panel   */
    function renderPanel() {
        var p = $('wfNotifPanel'); if (!p) return;
        var st = settings();
        var head = '<div class="wfntf-head"><span class="wfntf-h-title">Notifications</span>' +
            (_list.length ? '<button type="button" class="wfntf-readall" onclick="WFNotif.markAllRead()">Mark all read</button>' : '') +
            '</div>';

        if (!st.enabled) {
            p.innerHTML = head + '<div class="wfntf-empty"><div class="wfntf-empty-ic">' + SVG.bill + '</div><div>Notifications are turned off.</div><div class="wfntf-empty-sub">Turn them on in Settings → Notifications.</div></div>';
            return;
        }
        if (!_list.length) {
            p.innerHTML = head + '<div class="wfntf-empty"><div class="wfntf-empty-ic ok">' + SVG.ok + '</div><div>You\u2019re all clear.</div><div class="wfntf-empty-sub">No payments or cheques need attention right now.</div></div>';
            return;
        }

        var rows = _list.map(function (n, i) {
            var isNew = (n.sev === 'urgent' || n.sev === 'warning') && !_seenSnapshot[n.id];
            return '<button type="button" class="wfntf-item sev-' + n.sev + (isNew ? ' is-new' : '') + '" onclick="WFNotif._click(' + i + ')">' +
                '<span class="wfntf-ic">' + (SVG[n.icon] || SVG.bill) + '</span>' +
                '<span class="wfntf-body">' +
                '<span class="wfntf-title">' + n.title + '</span>' +
                '<span class="wfntf-sub">' + n.sub + '</span>' +
                '</span>' +
                '<span class="wfntf-meta"><span class="wfntf-chip">' + esc(n.cat) + '</span><span class="wfntf-go">&rsaquo;</span></span>' +
                '</button>';
        }).join('');

        p.innerHTML = head + '<div class="wfntf-list">' + rows + '</div>' +
            '<div class="wfntf-foot"><button type="button" class="wfntf-foot-btn" onclick="WFNotif.openSettings()">Notification settings</button></div>';
    }

    function openPanel() {
        var p = $('wfNotifPanel'); if (!p) return;
        _seenSnapshot = seen();           // capture BEFORE marking, so "new" dots show
        _list = compute();
        _panelOpen = true;
        renderPanel();
        p.classList.add('open');
        var btn = $('wfNotifBtn'); if (btn) btn.classList.add('active');
        // Opening = seen: mark everything currently shown as seen, clear the badge.
        var sn = seen();
        _list.forEach(function (n) { sn[n.id] = true; });
        saveSeen(sn);
        updateBadge();
        setTimeout(function () { document.addEventListener('mousedown', _outside, true); document.addEventListener('keydown', _esc, true); }, 0);
    }
    function closePanel() {
        var p = $('wfNotifPanel'); if (p) p.classList.remove('open');
        var btn = $('wfNotifBtn'); if (btn) btn.classList.remove('active');
        _panelOpen = false;
        document.removeEventListener('mousedown', _outside, true);
        document.removeEventListener('keydown', _esc, true);
    }
    function togglePanel() { _panelOpen ? closePanel() : openPanel(); }
    function _outside(e) { var w = document.querySelector('.wfntf-wrap'); if (w && !w.contains(e.target)) closePanel(); }
    function _esc(e) { if (e.key === 'Escape') closePanel(); }

    function clickRow(i) {
        var n = _list[i]; if (!n) { closePanel(); return; }
        var sn = seen(); sn[n.id] = true; saveSeen(sn);     // navigating = seen
        closePanel();
        try { if (typeof window.showPage === 'function') window.showPage(n.page); } catch (_) { }
        setTimeout(function () { updateBadge(); }, 30);
    }
    function markAllRead() {
        var sn = seen(); _list.forEach(function (n) { sn[n.id] = true; }); saveSeen(sn);
        _seenSnapshot = sn; updateBadge(); renderPanel();
    }

    /* ----------------------------------------------------- settings UI sync */
    function toggleSetting(key, btn) {
        var st = settings();
        if (!(key in st)) return;
        st[key] = !st[key];
        // Turning the master switch on implies the feature is usable; off hides everything.
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
        // When the master switch is off, visually dim the dependent rows.
        var wrap = $('wfntfSettingsBody');
        if (wrap) wrap.classList.toggle('master-off', !st.enabled);
    }
    function openSettings() {
        closePanel();
        try { if (typeof window.showPage === 'function') window.showPage('settings'); } catch (_) { }
        setTimeout(function () {
            try { syncSettingsUI(); var c = $('wfntfSettingsCard'); if (c && c.scrollIntoView) c.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { }
        }, 120);
    }

    /* ------------------------------------------------------------- styles   */
    function injectCSS() {
        if ($('wfntf-css')) return;
        var css = '' +
            '.wfntf-wrap{position:relative;display:inline-flex}' +
            '.wfntf-btn{position:relative}' +
            '.wfntf-btn.has-unseen{color:var(--accent,#d4af37)}' +
            '.wfntf-badge{position:absolute;top:-3px;right:-3px;min-width:17px;height:17px;padding:0 4px;border-radius:9px;background:var(--red,#ef4444);color:#fff;font-size:10px;font-weight:800;line-height:17px;text-align:center;box-shadow:0 0 0 2px var(--card,#16161f);font-family:var(--mono,ui-monospace,monospace)}' +
            '.wfntf-panel{position:absolute;top:calc(100% + 10px);right:0;width:min(380px,calc(100vw - 24px));max-height:min(560px,calc(100vh - 110px));overflow:hidden;display:none;flex-direction:column;background:var(--card,#16161f);border:1px solid var(--border2,#2a2a38);border-radius:16px;box-shadow:0 24px 60px rgba(0,0,0,.55),0 2px 8px rgba(0,0,0,.4);z-index:5000;animation:wfntfIn .16s ease}' +
            '.wfntf-panel.open{display:flex}' +
            '@keyframes wfntfIn{from{opacity:0;transform:translateY(-6px)}to{opacity:1;transform:translateY(0)}}' +
            '.wfntf-head{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid var(--border,#23232f)}' +
            '.wfntf-h-title{font-weight:800;font-size:15px;color:var(--text,#f4f4f6);letter-spacing:.2px}' +
            '.wfntf-readall{background:transparent;border:none;color:var(--accent,#d4af37);font-size:12px;font-weight:700;cursor:pointer;padding:4px 6px;border-radius:8px}' +
            '.wfntf-readall:hover{background:rgba(212,175,55,.12)}' +
            '.wfntf-list{overflow-y:auto;padding:6px;display:flex;flex-direction:column;gap:4px}' +
            '.wfntf-item{display:flex;align-items:flex-start;gap:11px;width:100%;text-align:left;background:var(--bg2,#101018);border:1px solid var(--border,#23232f);border-radius:12px;padding:11px 12px;cursor:pointer;position:relative;transition:transform .08s ease,border-color .12s ease,background .12s ease}' +
            '.wfntf-item:hover{background:var(--card2,#1c1c28);border-color:var(--border2,#2a2a38);transform:translateX(2px)}' +
            '.wfntf-item::before{content:"";position:absolute;left:0;top:10px;bottom:10px;width:3px;border-radius:3px;background:transparent}' +
            '.wfntf-item.sev-urgent::before{background:var(--red,#ef4444)}' +
            '.wfntf-item.sev-warning::before{background:var(--gold,#f5a623)}' +
            '.wfntf-item.sev-info::before{background:var(--blue,#579bfc)}' +
            '.wfntf-ic{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;color:var(--text2,#b8b8c4);background:rgba(255,255,255,.04)}' +
            '.wfntf-ic svg{width:17px;height:17px}' +
            '.wfntf-item.sev-urgent .wfntf-ic{color:var(--red,#ef4444);background:rgba(239,68,68,.12)}' +
            '.wfntf-item.sev-warning .wfntf-ic{color:var(--gold,#f5a623);background:rgba(245,166,35,.12)}' +
            '.wfntf-item.sev-info .wfntf-ic{color:var(--blue,#579bfc);background:rgba(87,155,252,.12)}' +
            '.wfntf-body{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px}' +
            '.wfntf-title{font-size:12.5px;font-weight:700;color:var(--text,#f4f4f6);line-height:1.3;white-space:normal;overflow-wrap:anywhere}' +
            '.wfntf-sub{font-size:11px;color:var(--text3,#8a8a99);line-height:1.3;overflow-wrap:anywhere}' +
            '.wfntf-meta{flex:0 0 auto;display:flex;flex-direction:column;align-items:flex-end;gap:6px}' +
            '.wfntf-chip{font-size:9px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:var(--text3,#8a8a99);background:rgba(255,255,255,.05);padding:2px 6px;border-radius:6px;white-space:nowrap}' +
            '.wfntf-go{font-size:18px;color:var(--text3,#8a8a99);line-height:1}' +
            '.wfntf-item.is-new .wfntf-title::after{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:var(--red,#ef4444);margin-left:7px;vertical-align:middle}' +
            '.wfntf-empty{padding:34px 20px;text-align:center;color:var(--text2,#b8b8c4)}' +
            '.wfntf-empty-ic{width:46px;height:46px;border-radius:50%;margin:0 auto 12px;display:grid;place-items:center;background:rgba(255,255,255,.05);color:var(--text3,#8a8a99)}' +
            '.wfntf-empty-ic.ok{background:rgba(46,204,113,.12);color:var(--green,#2ecc71)}' +
            '.wfntf-empty-ic svg{width:22px;height:22px}' +
            '.wfntf-empty-sub{font-size:11.5px;color:var(--text3,#8a8a99);margin-top:4px}' +
            '.wfntf-foot{border-top:1px solid var(--border,#23232f);padding:8px}' +
            '.wfntf-foot-btn{width:100%;background:transparent;border:none;color:var(--text3,#8a8a99);font-size:11.5px;font-weight:700;cursor:pointer;padding:7px;border-radius:8px}' +
            '.wfntf-foot-btn:hover{background:rgba(255,255,255,.04);color:var(--text,#f4f4f6)}' +
            // ---- settings card toggles ----
            '.wfntf-set-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid var(--border,#23232f)}' +
            '.wfntf-set-row:first-of-type{border-top:none}' +
            '#wfntfSettingsBody.master-off .wfntf-dep{opacity:.45;pointer-events:none}' +
            '.wfntf-switch{flex:0 0 auto;width:44px;height:25px;border-radius:999px;background:var(--border2,#2a2a38);border:1px solid var(--border2,#2a2a38);position:relative;cursor:pointer;transition:background .16s ease;padding:0}' +
            '.wfntf-switch::after{content:"";position:absolute;top:2px;left:2px;width:19px;height:19px;border-radius:50%;background:#fff;transition:transform .16s ease;box-shadow:0 1px 3px rgba(0,0,0,.4)}' +
            '.wfntf-switch.on{background:var(--accent,#d4af37);border-color:var(--accent,#d4af37)}' +
            '.wfntf-switch.on::after{transform:translateX(19px)}' +
            '';
        var st = document.createElement('style');
        st.id = 'wfntf-css';
        st.textContent = css;
        document.head.appendChild(st);
    }

    /* --------------------------------------------------- settings card HTML */
    // Fills the shell (#wfntfSettingsCard) that lives in index.html's settings
    // page. Idempotent — safe to call on every renderSettings.
    function buildSettingsCard() {
        var card = $('wfntfSettingsCard');
        if (!card || card.getAttribute('data-built') === '1') { syncSettingsUI(); return; }
        function row(key, label, desc, dep) {
            return '<div class="wfntf-set-row' + (dep ? ' wfntf-dep' : '') + '">' +
                '<div class="setting-info"><div class="setting-label">' + label + '</div><div class="setting-desc">' + desc + '</div></div>' +
                '<button type="button" id="wfntfTgl_' + key + '" class="wfntf-switch" role="switch" aria-checked="false" onclick="WFNotif.toggleSetting(\'' + key + '\',this)"></button>' +
                '</div>';
        }
        card.innerHTML =
            '<div class="settings-title" style="color:var(--accent,#d4af37);">Notifications</div>' +
            '<div id="wfntfSettingsBody">' +
            row('enabled', 'Enable notifications', 'Master switch for the topbar bell and its red unseen badge.', false) +
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
        var wrapped = function () {
            var r = orig.apply(this, arguments);
            try { after.apply(null, arguments); } catch (_) { }
            return r;
        };
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
        // Wrap render/sync hooks (re-tried until the globals exist).
        wrapDBset();
        wrap('showPage', function () { closePanel(); scheduleRefresh(); });
        wrap('updateCCOTBadge', function () { scheduleRefresh(); });   // also fires after cross-device sync
        wrap('updateChequeBadge', function () { scheduleRefresh(); });
        wrap('renderSettings', function () { setTimeout(buildSettingsCard, 0); });
        // If settings page is already on screen, build the card now.
        buildSettingsCard();
        refresh();
    }

    var _wireTries = 0;
    function bootWire() {
        wireAll();
        // The app's globals (DB.set, showPage, badges, renderSettings) are defined
        // in the inline script; retry a few times in case of load ordering.
        _wireTries++;
        var needRetry = !(window.DB && window.DB.set && window.DB.set.__wfntfWrapped) ||
            typeof window.showPage !== 'function' ||
            !(window.showPage && window.showPage.__wfntfWrapped);
        if (_wireTries < 20 && needRetry) setTimeout(bootWire, 400);
    }

    function start() {
        bootWire();
        // Time-based transitions (a "due in 1d" becomes "due today" at midnight,
        // etc.) + catch cross-device updates that didn't go through a wrapped path.
        setInterval(refresh, 60000);
        document.addEventListener('visibilitychange', function () { if (!document.hidden) refresh(); });
        window.addEventListener('online', refresh);
        window.addEventListener('focus', scheduleRefresh);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();

    /* --------------------------------------------------------------- expose */
    window.WFNotif = {
        togglePanel: togglePanel,
        openPanel: openPanel,
        closePanel: closePanel,
        _click: clickRow,
        markAllRead: markAllRead,
        toggleSetting: toggleSetting,
        syncSettingsUI: syncSettingsUI,
        openSettings: openSettings,
        refresh: refresh,
        compute: compute,
        _count: unseenCount
    };
})();
