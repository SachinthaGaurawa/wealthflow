/* =============================================================================
 * wealthflow-shell.js — the frame around every screen
 * -----------------------------------------------------------------------------
 * WHAT THIS IS. The visual design lives in wf-tokens.css and wf-ui.css. This file
 * adds the three pieces of the frame that CSS cannot make, without touching what
 * any screen does:
 *
 *   1. A TAB BAR on phones and tablets (≤ 900 px): Home · Income · Spending ·
 *      Loans · More. The hamburger-and-drawer it replaces hid 22 screens behind
 *      one tap and a scroll; the four screens people use daily are now one tap,
 *      and "More" opens a sheet holding the rest, grouped as the sidebar groups
 *      them.
 *   2. A COMMAND PALETTE (Ctrl or Cmd + K, "/", or the search button): type "loan",
 *      "cheque", "add expense", or the name of a lender, and go straight there.
 *      It also finds the user's own records by name.
 *   3. SMALL SHELL DETAILS: the brand mark in the phone header, the sign-in
 *      brand panel on desktop, the browser theme-colour following Dark/Light.
 *
 * THE SIDEBAR REMAINS THE SINGLE SOURCE OF TRUTH FOR "WHAT SCREENS EXIST". The
 * sheet, the palette and the tab bar are all BUILT FROM the sidebar's nav items
 * (their showPage('x') handler, label, icon and group), so a screen added to the
 * sidebar tomorrow appears in all three with no second list to forget. Nothing
 * here calls into a screen's internals: navigation is the app's own showPage(),
 * so the biometric gate on sensitive pages still applies.
 *
 * Presentation only: no data is read except record NAMES for search, and
 * nothing is written (the one write is the last-used list, kept in this
 * browser's localStorage, which is optional and wrapped in try/catch).
 * ===========================================================================*/
(function () {
    'use strict';
    if (window.WFShell) return;

    var doc = document;
    var root = doc.documentElement;
    var PHONE = window.matchMedia ? window.matchMedia('(max-width: 900px)') : { matches: false, addEventListener: function () {} };
    var MAIN_TABS = [
        { id: 'dashboard', label: 'Home', icon: 'dashboard' },
        { id: 'incRecv', label: 'Income', icon: 'wallet' },
        { id: 'expenses', label: 'Spending', icon: 'receipt' },
        { id: 'loans', label: 'Loans', icon: 'bank' }
    ];
    /* Words people type that the screen's label does not contain. */
    var KEYWORDS = {
        dashboard: 'home overview summary', monthly: 'plan budget calendar', incRecv: 'salary income payouts received money in',
        income: 'investments lending fixed deposit debtors', loans: 'loan debt emi bank repayment', ccinstall: 'credit card installment easy payment plan',
        cconetime: 'credit card one time purchase', cheques: 'cheque check pdc post dated', liquidity: 'liquidity credit limit cash',
        expenses: 'spending expense budget transactions statement', targets: 'goals savings target', dscr: 'ratio debt service eligibility',
        score: 'health score rating', crib: 'credit report crib bureau', subscriptions: 'recurring bills netflix', debtdemo: 'debt payoff snowball avalanche',
        montecarlo: 'simulator forecast projection future', cashflow3d: 'cash flow chart visual', sessions: 'devices security logins',
        ai: 'advisor assistant chat gemini ask', settings: 'preferences backup export pin theme account'
    };
    /* Records worth finding by name: [data key, screen, fields that name a record]. */
    var RECORDS = [
        ['loans', 'loans', ['name', 'bank']], ['income', 'income', ['name', 'company']], ['debtors', 'income', ['name']],
        ['ccinstall', 'ccinstall', ['product', 'bank']], ['cconetime', 'cconetime', ['desc', 'bank']], ['cheques', 'cheques', ['party', 'no']],
        ['targets', 'targets', ['name']], ['subscriptions', 'subscriptions', ['name']], ['expenses', 'expenses', ['desc']]
    ];
    var ADD_ACTIONS = [
        { id: 'add-expense', label: 'Add expense', icon: 'receipt', clear: 'clearExpenseForm', modal: 'mdExpense', words: 'new log spend' },
        { id: 'add-investment', label: 'Add investment', icon: 'chartLine', clear: 'clearIncomeForm', modal: 'mdIncome', words: 'new lend deposit' },
        { id: 'add-loan', label: 'Add loan', icon: 'bank', clear: 'clearLoanForm', modal: 'mdLoan', words: 'new borrow' },
        { id: 'add-cheque', label: 'Add cheque', icon: 'cheque', clear: 'clearChequeForm', modal: 'mdCheque', words: 'new check' },
        { id: 'add-subscription', label: 'Add subscription', icon: 'bell', clear: 'clearSubForm', modal: 'mdSubscription', words: 'new recurring bill' },
        { id: 'add-target', label: 'Add savings target', icon: 'target', clear: 'clearTargetForm', modal: 'mdTarget', words: 'new goal' }
    ];

    var LS_KEY = 'wf_shell_recent';
    var tabbar = null;
    var sheetOv = null;
    var palOv = null;
    var lastFocus = null;
    var palState = { items: [], sel: 0, query: '' };

    /* ───────── helpers ───────── */
    function $(id) { return doc.getElementById(id); }
    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function icon(name) {
        try { if (window.WFIcon && window.WFIcon.has(name)) return window.WFIcon(name); } catch (_) { /* fall through */ }
        var path = {
            more: '<circle cx="5" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="19" cy="12" r="1.7"/>',
            enter: '<polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>',
            arrowUp: '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
            arrowDown: '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>'
        }[name];
        return path ? '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + path + '</svg>' : '';
    }
    function isMac() { return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || ''); }
    function lsGet() { try { return JSON.parse(localStorage.getItem(LS_KEY) || '[]') || []; } catch (_) { return []; } }
    function lsPush(id) {
        try {
            var cur = lsGet().filter(function (x) { return x !== id; });
            cur.unshift(id);
            localStorage.setItem(LS_KEY, JSON.stringify(cur.slice(0, 5)));
        } catch (_) { /* optional convenience */ }
    }
    function signedIn() { var a = $('app'); return !!(a && a.classList.contains('show')); }
    function dataGet(key) {
        try {
            var db = (typeof DB !== 'undefined') ? DB : window.DB;
            var v = db && db.get ? db.get(key, []) : [];
            return Array.isArray(v) ? v : [];
        } catch (_) { return []; }
    }

    /* ───────── the sidebar is the screen index ───────── */
    function readPages() {
        var out = [];
        var signOut = null;
        var nav = doc.querySelector('.sb-nav');
        if (!nav) return { pages: out, signOut: null };
        var group = '';
        Array.prototype.forEach.call(nav.children, function (el) {
            if (el.classList.contains('sb-group')) { group = el.textContent.replace(/\s+/g, ' ').trim(); return; }
            if (!el.classList.contains('nav-item')) return;
            var on = el.getAttribute('onclick') || '';
            var m = /showPage\('([^']+)'/.exec(on);
            if (!m) { if (/signOutGoogle/.test(on)) signOut = el; return; }
            try { if (window.getComputedStyle(el).display === 'none') return; } catch (_) { /* keep it */ }
            var clone = el.cloneNode(true);
            Array.prototype.forEach.call(clone.querySelectorAll('.nav-icon, .nb'), function (n) { n.remove(); });
            var ic = el.querySelector('.nav-icon');
            var nb = el.querySelector('.nb');
            var badge = '';
            try { if (nb && window.getComputedStyle(nb).display !== 'none') badge = nb.textContent.replace(/\s+/g, ' ').trim(); } catch (_) { /* no badge */ }
            out.push({
                id: m[1], group: group, el: el, badge: badge,
                label: clone.textContent.replace(/\s+/g, ' ').trim(),
                icon: ic ? ic.innerHTML : ''
            });
        });
        return { pages: out, signOut: signOut };
    }
    function currentPage() {
        var a = doc.querySelector('.page.active');
        return a && a.id ? a.id.replace(/^page-/, '') : 'dashboard';
    }
    function go(id) {
        var idx = readPages();
        var hit = null;
        for (var i = 0; i < idx.pages.length; i++) if (idx.pages[i].id === id) { hit = idx.pages[i]; break; }
        if (currentPage() === id) {
            try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (_) { window.scrollTo(0, 0); }
            return;
        }
        if (typeof window.showPage === 'function') window.showPage(id, hit ? hit.el : undefined);
    }

    /* ───────── brand + header pieces ───────── */
    var MARK = '<svg class="wf-mark" role="img" aria-label="WealthFlow"><use href="#wf-mark"/></svg>';

    function installHeader() {
        var left = doc.querySelector('.topbar .tb-left');
        if (left && !left.querySelector('.wf-topmark')) {
            var m = doc.createElement('span');
            m.className = 'wf-topmark wf-tile';
            m.innerHTML = MARK;
            left.insertBefore(m, left.firstChild);
        }
        var right = doc.querySelector('.topbar .tb-right');
        if (right && !right.querySelector('.wf-search')) {
            var s = doc.createElement('button');
            s.type = 'button';
            s.className = 'wf-search';
            s.setAttribute('aria-label', 'Search or jump to a screen');
            s.setAttribute('aria-keyshortcuts', 'Control+K Meta+K');
            s.innerHTML = icon('search') + '<span>Search or jump to…</span><kbd class="wf-kbd">' + (isMac() ? String.fromCharCode(0x2318) + ' K' : 'Ctrl K') + '</kbd>';
            s.addEventListener('click', function () { openPalette(); });
            right.insertBefore(s, right.firstChild);
            var b = doc.createElement('button');
            b.type = 'button';
            b.className = 'tb-action-icon wf-search-btn';
            b.setAttribute('aria-label', 'Search');
            b.innerHTML = icon('search');
            b.addEventListener('click', function () { openPalette(); });
            right.insertBefore(b, right.querySelector('.network-wrap') || right.children[1] || null);
        }
    }

    /* The sign-in screen on a wide display: a brand panel beside the form. Markup is
       built here rather than shipped in index.html so the page stays inside its size
       budget; the panel is hidden below 981 px by CSS and is not needed to sign in. */
    function installBrandPanel() {
        var auth = $('authScreen');
        if (!auth || auth.querySelector('.auth-brand')) return;
        var p = doc.createElement('aside');
        p.className = 'auth-brand';
        p.innerHTML =
            '<div class="ab-lockup"><span class="wf-tile">' + MARK + '</span><span class="wf-wordmark">WealthFlow</span></div>' +
            '<div class="ab-head"><h2>Every rupee, <em>accounted&nbsp;for.</em></h2>' +
            '<p>Income, loans, cards, cheques and spending in one calm place, with an advisor that reads your real numbers.</p>' +
            '<ul class="ab-points">' +
            '<li><span class="ab-ic">' + icon('scan') + '</span><div><b>Statements read themselves</b><span>Upload a bank or card statement and every line is sorted for you.</span></div></li>' +
            '<li><span class="ab-ic">' + icon('bell') + '</span><div><b>Nothing due slips past</b><span>Instalments, cheques and subscriptions, with a reminder before the date.</span></div></li>' +
            '<li><span class="ab-ic">' + icon('bot') + '</span><div><b>An advisor that has seen your books</b><span>Ask about a loan, a purchase or a plan and get an answer grounded in your own figures.</span></div></li>' +
            '</ul></div>' +
            '<div class="ab-foot"><span>' + icon('lock') + 'PIN-locked on every device</span><span>' + icon('user') + 'Sign in with Google</span></div>';
        auth.insertBefore(p, auth.firstChild);
    }

    /* The browser chrome (Android address bar, iOS PWA status area) follows the theme. */
    function syncThemeColor() {
        try {
            var meta = doc.querySelector('meta[name="theme-color"]');
            if (!meta) return;
            var bg = window.getComputedStyle(root).getPropertyValue('--wf-bg').trim();
            if (bg) meta.setAttribute('content', bg);
        } catch (_) { /* cosmetic */ }
    }

    /* ───────── tab bar ───────── */
    function installTabbar() {
        var app = $('app');
        if (!app || tabbar) return;
        tabbar = doc.createElement('nav');
        tabbar.className = 'wf-tabbar';
        tabbar.id = 'wfTabbar';
        tabbar.setAttribute('aria-label', 'Main');
        tabbar.innerHTML = MAIN_TABS.map(function (t) {
            return '<button type="button" class="wf-tab" data-page="' + t.id + '">' + icon(t.icon) + '<span>' + esc(t.label) + '</span></button>';
        }).join('') + '<button type="button" class="wf-tab" data-more="1" aria-haspopup="dialog">' + icon('more') + '<span>More</span></button>';
        tabbar.addEventListener('click', function (e) {
            var b = e.target.closest ? e.target.closest('.wf-tab') : null;
            if (!b) return;
            if (b.getAttribute('data-more')) { openMore(); return; }
            go(b.getAttribute('data-page'));
        });
        app.appendChild(tabbar);
        syncTabbar();
    }
    function syncTabbar() {
        if (!tabbar) return;
        var cur = currentPage();
        var inMain = MAIN_TABS.some(function (t) { return t.id === cur; });
        Array.prototype.forEach.call(tabbar.querySelectorAll('.wf-tab'), function (b) {
            var on = b.getAttribute('data-more') ? !inMain : b.getAttribute('data-page') === cur;
            if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
        });
        /* A red dot on More when something there needs attention (the sidebar badges). */
        var more = tabbar.querySelector('[data-more]');
        var needs = readPages().pages.some(function (p) {
            return p.badge && !MAIN_TABS.some(function (t) { return t.id === p.id; });
        });
        var dot = more.querySelector('.wf-dot');
        if (needs && !dot) { dot = doc.createElement('i'); dot.className = 'wf-dot'; more.appendChild(dot); }
        if (!needs && dot) dot.remove();
    }
    function watchPages() {
        if (!window.MutationObserver) return;
        var mo = new MutationObserver(syncTabbar);
        Array.prototype.forEach.call(doc.querySelectorAll('.page'), function (p) {
            mo.observe(p, { attributes: true, attributeFilter: ['class'] });
        });
    }

    /* The tab bar steps aside while a field is being typed in, so it is never
       pushed up over the keyboard, and returns when the field is left. */
    function watchTyping() {
        function isField(el) {
            if (!el || !el.tagName) return false;
            var t = el.tagName;
            if (t === 'TEXTAREA' || t === 'SELECT') return true;
            if (t !== 'INPUT') return false;
            return !/^(checkbox|radio|button|submit|range|file|color)$/i.test(el.type || '');
        }
        doc.addEventListener('focusin', function (e) {
            if (PHONE.matches && isField(e.target) && !e.target.closest('.wf-pal')) doc.body.classList.add('wf-typing');
        });
        doc.addEventListener('focusout', function () {
            setTimeout(function () { if (!isField(doc.activeElement)) doc.body.classList.remove('wf-typing'); }, 60);
        });
    }

    /* ───────── overlay plumbing (sheet + palette share it) ───────── */
    function makeOverlay(id, inner, label) {
        var ov = doc.createElement('div');
        ov.className = 'wf-ov';
        ov.id = id;
        ov.innerHTML = inner;
        ov.addEventListener('click', function (e) { if (e.target === ov) closeAll(); });
        var panel = ov.firstElementChild;
        panel.setAttribute('role', 'dialog');
        panel.setAttribute('aria-modal', 'true');
        panel.setAttribute('aria-label', label);
        panel.setAttribute('tabindex', '-1');
        doc.body.appendChild(ov);
        return ov;
    }
    function showOverlay(ov, focusEl) {
        lastFocus = doc.activeElement;
        ov.classList.add('open');
        root.classList.add('wf-sheet-open');
        /* Now (so typing straight after Ctrl+K is not lost) and once more after the first frame (iOS). */
        var focus = function () { try { (focusEl || ov.firstElementChild).focus({ preventScroll: true }); } catch (_) { /* ignore */ } };
        focus();
        setTimeout(focus, 60);
    }
    function closeAll() {
        var was = false;
        [sheetOv, palOv].forEach(function (ov) { if (ov && ov.classList.contains('open')) { ov.classList.remove('open'); was = true; } });
        root.classList.remove('wf-sheet-open');
        if (was && lastFocus && lastFocus.focus) { try { lastFocus.focus({ preventScroll: true }); } catch (_) { /* ignore */ } }
        lastFocus = null;
    }
    function trapTab(e, panel) {
        if (e.key !== 'Tab') return;
        var f = panel.querySelectorAll('button:not([disabled]), input, [tabindex="0"]');
        if (!f.length) { e.preventDefault(); return; }
        var first = f[0];
        var last = f[f.length - 1];
        if (e.shiftKey && (doc.activeElement === first || doc.activeElement === panel)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && doc.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    /* ───────── "More" sheet ───────── */
    function profileHtml() {
        var photo = doc.querySelector('#sbUser .sb-user-photo');
        var initial = doc.querySelector('#sbUser .sb-user-initial');
        var name = doc.querySelector('#sbUser .sb-user-name');
        var av = photo && photo.getAttribute('src')
            ? '<img src="' + esc(photo.getAttribute('src')) + '" alt="" referrerpolicy="no-referrer">'
            : esc(initial ? initial.textContent.replace(/\s+/g, '').slice(0, 2) : 'W');
        var ver = $('wfSbVer');
        return '<div class="wf-me"><span class="wf-me-av">' + av + '</span><div><div class="wf-me-name">' +
            esc(name ? name.textContent.trim() : 'WealthFlow') + '</div><div class="wf-me-sub">' +
            esc(ver ? ver.textContent.trim() : 'WealthFlow') + '</div></div></div>';
    }
    function openMore() {
        var idx = readPages();
        var cur = currentPage();
        var skip = {};
        MAIN_TABS.forEach(function (t) { skip[t.id] = 1; });
        var groups = [];
        var byName = {};
        idx.pages.forEach(function (p) {
            if (skip[p.id]) return;
            var g = byName[p.group];
            if (!g) { g = byName[p.group] = { name: p.group, items: [] }; groups.push(g); }
            g.items.push(p);
        });
        var themeNow = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        var body =
            '<div class="wf-grab" id="wfGrab"></div>' +
            '<div class="wf-sheet-body">' + profileHtml() +
            '<div class="wf-quick">' +
            '<button type="button" data-q="search">' + icon('search') + 'Search</button>' +
            '<button type="button" data-q="sync">' + icon('refresh') + 'Sync now</button>' +
            '<button type="button" data-q="theme">' + icon(themeNow === 'dark' ? 'sun' : 'moon') + (themeNow === 'dark' ? 'Light mode' : 'Dark mode') + '</button>' +
            '</div>' +
            groups.map(function (g) {
                return '<div class="wf-grp">' + esc(g.name) + '</div><div class="wf-grid">' + g.items.map(function (p) {
                    return '<button type="button" class="wf-item" data-page="' + esc(p.id) + '"' + (p.id === cur ? ' aria-current="page"' : '') + '>' +
                        '<span class="wf-ic">' + p.icon + '</span>' + esc(p.label) + (p.badge ? '<i class="wf-badge">' + esc(p.badge) + '</i>' : '') + '</button>';
                }).join('') + '</div>';
            }).join('') +
            (idx.signOut ? '<button type="button" class="wf-signout" data-q="signout">' + icon('logOut') + 'Sign out</button>' : '') +
            '</div>';
        if (!sheetOv) {
            sheetOv = makeOverlay('wfSheetOv', '<div class="wf-sheet"></div>', 'More');
            sheetOv.addEventListener('click', function (e) {
                var q = e.target.closest ? e.target.closest('[data-q]') : null;
                var it = e.target.closest ? e.target.closest('.wf-item') : null;
                if (it) { var id = it.getAttribute('data-page'); closeAll(); go(id); return; }
                if (!q) return;
                var k = q.getAttribute('data-q');
                closeAll();
                if (k === 'search') setTimeout(function () { openPalette(); }, 120);
                else if (k === 'sync') { try { window.refreshApp && window.refreshApp($('topRefreshBtn')); } catch (_) { /* ignore */ } }
                else if (k === 'theme') { try { window.toggleTheme && window.toggleTheme(); } catch (_) { /* ignore */ } }
                else if (k === 'signout') { try { window.signOutGoogle && window.signOutGoogle(); } catch (_) { /* ignore */ } }
            });
            sheetOv.addEventListener('keydown', function (e) {
                if (e.key === 'Escape') { e.stopPropagation(); closeAll(); }
                else trapTab(e, sheetOv.firstElementChild);
            });
        }
        var sheet = sheetOv.firstElementChild;
        sheet.innerHTML = body;
        bindDrag(sheet);
        showOverlay(sheetOv, sheet);
    }
    /* Pull the sheet down by its handle to dismiss it, like every native sheet. */
    function bindDrag(sheet) {
        var grab = sheet.querySelector('#wfGrab');
        if (!grab) return;
        var y0 = 0;
        var dy = 0;
        var on = false;
        grab.style.cssText = 'padding:14px 0 10px;margin:0 auto;background-clip:content-box;height:4px;box-sizing:content-box;touch-action:none;width:40px;';
        grab.addEventListener('touchstart', function (e) { on = true; y0 = e.touches[0].clientY; dy = 0; sheet.style.transition = 'none'; }, { passive: true });
        grab.addEventListener('touchmove', function (e) {
            if (!on) return;
            dy = Math.max(0, e.touches[0].clientY - y0);
            sheet.style.transform = 'translateY(' + dy + 'px)';
        }, { passive: true });
        function end() {
            if (!on) return;
            on = false;
            sheet.style.transition = '';
            sheet.style.transform = '';
            if (dy > 90) closeAll();
        }
        grab.addEventListener('touchend', end);
        grab.addEventListener('touchcancel', end);
    }

    /* ───────── command palette ───────── */
    function buildCatalog() {
        var idx = readPages();
        var items = [];
        idx.pages.forEach(function (p) {
            items.push({ id: 'page:' + p.id, kind: 'Go to', label: p.label, hint: p.group, icon: p.icon, words: (KEYWORDS[p.id] || '') + ' ' + p.group,
                run: function () { go(p.id); } });
        });
        ADD_ACTIONS.forEach(function (a) {
            items.push({ id: 'act:' + a.id, kind: 'Actions', label: a.label, hint: '', icon: icon(a.icon), words: a.words,
                run: function () {
                    try { if (typeof window[a.clear] === 'function') window[a.clear](); if (typeof window.openModal === 'function') window.openModal(a.modal); } catch (_) { /* ignore */ }
                } });
        });
        var themeNow = root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
        items.push({ id: 'act:theme', kind: 'Actions', label: themeNow === 'dark' ? 'Switch to light mode' : 'Switch to dark mode', hint: '', icon: icon(themeNow === 'dark' ? 'sun' : 'moon'),
            words: 'theme appearance dark light', run: function () { try { window.toggleTheme && window.toggleTheme(); } catch (_) { /* ignore */ } } });
        items.push({ id: 'act:sync', kind: 'Actions', label: 'Sync now', hint: '', icon: icon('refresh'), words: 'refresh update cloud',
            run: function () { try { window.refreshApp && window.refreshApp($('topRefreshBtn')); } catch (_) { /* ignore */ } } });
        return items;
    }
    function searchRecords(q) {
        var out = [];
        if (q.length < 2) return out;
        var pageLabel = {};
        readPages().pages.forEach(function (p) { pageLabel[p.id] = p.label; });
        for (var r = 0; r < RECORDS.length && out.length < 8; r++) {
            var rows = dataGet(RECORDS[r][0]);
            for (var i = 0; i < rows.length && out.length < 8; i++) {
                var row = rows[i];
                if (!row || typeof row !== 'object') continue;
                var title = '';
                var hay = '';
                for (var f = 0; f < RECORDS[r][2].length; f++) {
                    var v = row[RECORDS[r][2][f]];
                    if (v == null || v === '') continue;
                    if (!title) title = String(v);
                    hay += ' ' + String(v).toLowerCase();
                }
                if (title && hay.indexOf(q) !== -1) {
                    (function (screen, t) {
                        out.push({ id: 'rec:' + RECORDS[r][0] + ':' + (row.id || i), kind: 'In your records', label: t, hint: pageLabel[screen] || '', icon: icon('search'), words: '',
                            run: function () { go(screen); } });
                    })(RECORDS[r][1], title);
                }
            }
        }
        return out;
    }
    function score(item, q) {
        var l = item.label.toLowerCase();
        if (l === q) return 100;
        if (l.indexOf(q) === 0) return 90;
        var parts = l.split(/[\s—-]+/);
        for (var i = 0; i < parts.length; i++) if (parts[i].indexOf(q) === 0) return 80;
        if (l.indexOf(q) !== -1) return 60;
        var w = (item.words || '').toLowerCase();
        var tokens = q.split(/\s+/);
        var all = tokens.every(function (t) { return l.indexOf(t) !== -1 || w.indexOf(t) !== -1; });
        return all ? 40 : 0;
    }
    function computeResults(raw) {
        var q = raw.trim().toLowerCase();
        var cat = buildCatalog();
        if (!q) {
            var rec = lsGet();
            var recent = rec.map(function (id) { return cat.filter(function (c) { return c.id === id; })[0]; }).filter(Boolean).map(function (c) {
                return { id: c.id, kind: 'Recent', label: c.label, hint: c.hint, icon: c.icon, words: '', run: c.run };
            });
            var rest = cat.filter(function (c) { return c.kind === 'Go to'; });
            return recent.concat(rest.map(function (c) { return { id: c.id, kind: 'Go to', label: c.label, hint: c.hint, icon: c.icon, words: '', run: c.run }; }));
        }
        var scored = cat.map(function (c) { return { c: c, s: score(c, q) }; }).filter(function (x) { return x.s > 0; });
        scored.sort(function (a, b) { return b.s - a.s; });
        return scored.map(function (x) { return x.c; }).concat(searchRecords(q));
    }
    function renderPalette() {
        var list = $('wfPalList');
        if (!list) return;
        var items = palState.items;
        if (!items.length) {
            list.innerHTML = '<div class="wf-pal-empty">Nothing matches “' + esc(palState.query) + '”. Try “loan”, “cheque” or “add expense”.</div>';
            return;
        }
        var html = '';
        var kind = '';
        items.forEach(function (it, i) {
            if (it.kind !== kind) { kind = it.kind; html += '<div class="wf-pal-h">' + esc(kind) + '</div>'; }
            html += '<button type="button" class="wf-pal-it" role="option" id="wfPalIt' + i + '" data-i="' + i + '" aria-selected="' + (i === palState.sel) + '">' +
                it.icon + '<span>' + esc(it.label) + '</span>' + (it.hint ? '<small>' + esc(it.hint) + '</small>' : '') + '</button>';
        });
        list.innerHTML = html;
        var input = $('wfPalIn');
        if (input) input.setAttribute('aria-activedescendant', 'wfPalIt' + palState.sel);
        var sel = $('wfPalIt' + palState.sel);
        if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });
    }
    function choose(i) {
        var it = palState.items[i];
        if (!it) return;
        if (it.id.indexOf('rec:') !== 0) lsPush(it.id);
        closeAll();
        setTimeout(function () { try { it.run(); } catch (_) { /* a screen's own error handling takes over */ } }, 60);
    }
    function openPalette(prefill) {
        if (!signedIn()) return;
        if (!palOv) {
            palOv = makeOverlay('wfPalOv',
                '<div class="wf-pal"><div class="wf-pal-in">' + icon('search') +
                '<input id="wfPalIn" type="text" role="combobox" aria-expanded="true" aria-controls="wfPalList" aria-autocomplete="list" ' +
                'placeholder="Search screens, records, or type “add expense”" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go"></div>' +
                '<div class="wf-pal-list" id="wfPalList" role="listbox" aria-label="Results"></div>' +
                '<div class="wf-pal-foot"><span>' + icon('arrowUp') + icon('arrowDown') + 'Move</span><span>' + icon('enter') + 'Open</span><span>Esc to close</span></div></div>',
                'Search');
            var input = palOv.querySelector('#wfPalIn');
            input.addEventListener('input', function () {
                palState.query = input.value;
                palState.items = computeResults(input.value);
                palState.sel = 0;
                renderPalette();
            });
            palOv.addEventListener('mousemove', function (e) {
                var b = e.target.closest ? e.target.closest('.wf-pal-it') : null;
                if (b) {
                    var i = +b.getAttribute('data-i');
                    if (i !== palState.sel) {
                        var prev = $('wfPalIt' + palState.sel);
                        if (prev) prev.setAttribute('aria-selected', 'false');
                        palState.sel = i;
                        b.setAttribute('aria-selected', 'true');
                    }
                }
            });
            palOv.addEventListener('click', function (e) {
                var b = e.target.closest ? e.target.closest('.wf-pal-it') : null;
                if (b) choose(+b.getAttribute('data-i'));
            });
            palOv.addEventListener('keydown', function (e) {
                var n = palState.items.length;
                if (e.key === 'Escape') { e.stopPropagation(); closeAll(); }
                else if (e.key === 'ArrowDown') { e.preventDefault(); if (n) { palState.sel = (palState.sel + 1) % n; renderPalette(); } }
                else if (e.key === 'ArrowUp') { e.preventDefault(); if (n) { palState.sel = (palState.sel - 1 + n) % n; renderPalette(); } }
                else if (e.key === 'Home' && n) { e.preventDefault(); palState.sel = 0; renderPalette(); }
                else if (e.key === 'End' && n) { e.preventDefault(); palState.sel = n - 1; renderPalette(); }
                else if (e.key === 'Enter') { e.preventDefault(); choose(palState.sel); }
                else trapTab(e, palOv.firstElementChild);
            });
        }
        var inp = palOv.querySelector('#wfPalIn');
        inp.value = typeof prefill === 'string' ? prefill : '';
        palState.query = inp.value;
        palState.items = computeResults(inp.value);
        palState.sel = 0;
        renderPalette();
        showOverlay(palOv, inp);
    }

    /* ───────── global keys ───────── */
    function onKey(e) {
        var k = (e.key || '').toLowerCase();
        /* Escape closes whatever is open even if focus has not landed inside it yet. */
        if (k === 'escape' && root.classList.contains('wf-sheet-open')) { closeAll(); return; }
        if ((e.ctrlKey || e.metaKey) && k === 'k') {
            if (!signedIn()) return;
            e.preventDefault();
            if (palOv && palOv.classList.contains('open')) closeAll(); else openPalette();
            return;
        }
        if (k === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && signedIn()) {
            var t = e.target;
            var typing = t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName || ''));
            if (!typing) { e.preventDefault(); openPalette(); }
        }
    }

    /* ───────── dashboard greeting ─────────
       The first line of the dashboard: whom it is for, and today's date. Built from the sidebar's
       name and the clock only; nothing is read from the books. */
    function greetText() {
        var h = new Date().getHours();
        var part = h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
        var n = doc.querySelector('.sb-user-name');
        var first = n ? String(n.textContent || '').trim().split(/\s+/)[0] : '';
        if (/^(wealthflow|user)$/i.test(first)) first = '';
        return part + (first ? ', ' + first : '');
    }
    function installGreeting() {
        var pg = doc.getElementById('page-dashboard');
        if (!pg || doc.getElementById('wfGreet')) return;
        var g = doc.createElement('div');
        g.id = 'wfGreet';
        g.className = 'wf-greet';
        pg.insertBefore(g, pg.firstChild);
        function paint() {
            var ds = '';
            try { ds = new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }); } catch (_) {}
            g.innerHTML = '<h2 class="wf-greet-h">' + esc(greetText()) + '</h2><p class="wf-greet-p">' + esc(ds) + '</p>';
        }
        paint();
        /* The name arrives after sign-in, and the part of the day moves on. */
        var nm = doc.querySelector('.sb-user-name');
        if (nm && window.MutationObserver) new MutationObserver(paint).observe(nm, { childList: true, characterData: true, subtree: true });
        setInterval(paint, 300000);
    }

    /* ───────── boot ───────── */
    function init() {
        installHeader();
        installGreeting();
        installBrandPanel();
        installTabbar();
        watchPages();
        watchTyping();
        syncThemeColor();
        if (window.MutationObserver) {
            new MutationObserver(syncThemeColor).observe(root, { attributes: true, attributeFilter: ['data-theme'] });
            /* Badges on the sidebar change as data loads; keep the More dot honest. */
            var nav = doc.querySelector('.sb-nav');
            if (nav) new MutationObserver(function () { syncTabbar(); }).observe(nav, { attributes: true, subtree: true, attributeFilter: ['style'] });
        }
        doc.addEventListener('keydown', onKey);
        /* A tab bar must not outlive a rotation to a wide layout with a sheet still open. */
        var onChange = function () { if (!PHONE.matches) closeAll(); };
        if (PHONE.addEventListener) PHONE.addEventListener('change', onChange);
    }
    if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', init); else init();

    window.WFShell = { openPalette: openPalette, openMore: openMore, close: closeAll, go: go };
})();
