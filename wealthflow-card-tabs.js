/* =============================================================================
 * wealthflow-card-tabs.js — one tab per credit card, when the owner holds more than one   (window.WFCardTabs)
 * -----------------------------------------------------------------------------
 * CC One-Time and CC Instalments list every card's money together. With a second card, "what do I owe on THIS card" is a filter the owner has to build by eye. This module turns the records
 * into a row of tabs, one per card — the bank's name, the card's last four digits, how many rows, what is due — plus an "All cards" tab, and the screen shows the one the owner picks. Shown only
 * when there is more than one card; with a single card the screen is as it always was.
 *
 * WHAT A CARD IS. The same key the card walk settles by (index.html `_ccKey`): the bank, folded to its one canonical name, and the card's last four digits. Two cards of one bank are two tabs.
 * A row that carries no last four (an older one, a plan typed by hand) joins the bank's only numbered card when there is exactly one, in Settings > Cards and accounts or among the rows; when the
 * bank has none or several, it stays under the bank alone — never guessed onto a card.
 *
 * Pure but for `render` (a string) and `wire` (one delegated listener). No storage, no network, no clock. The page passes in what only it knows: the canonical bank name, the bank's printed name,
 * and which rows are still owed. Loaded as a classic script; also a CommonJS module for the tests.
 * ===========================================================================*/
(function (root) {
    'use strict';

    var last4Of = function (r) { return String((r && (r.card_last4 || r.last4)) || '').trim(); };
    var esc = function (v) { return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
    var cents = function (v) { var n = Number(v); return isFinite(n) ? Math.round(n * 100) : 0; };

    /**
     * @param {Array<object>} records the rows the screen lists (charges, or instalment plans)
     * @param {{canonBank?:function(string):string, shown?:function(string):string, registry?:object,
     *          open?:function(object):boolean, value?:function(object):number, late?:function(object):boolean}} ctx
     *   canonBank: the bank's one canonical name; shown: the name the owner reads; registry: settings.cardRegistry (credit cards only name a card's number);
     *   open: the row is still owed; value: what it asks (whole amount); late: it is past due
     * @returns {{keyOf:function(object):string, tabs:Array<{key:string,bank:string,bankKey:string,last4:string,label:string,count:number,open:number,due:number,late:number}>}}
     */
    function build(records, ctx) {
        ctx = ctx || {};
        var canon = typeof ctx.canonBank === 'function' ? ctx.canonBank : function (b) { return String(b || '').trim(); };
        var shown = typeof ctx.shown === 'function' ? ctx.shown : function (b) { return String(b || ''); };
        var open = typeof ctx.open === 'function' ? ctx.open : function () { return true; };
        var value = typeof ctx.value === 'function' ? ctx.value : function (r) { return Number(r && r.amount) || 0; };
        var late = typeof ctx.late === 'function' ? ctx.late : function () { return false; };
        var bankKey = function (r) { return String(canon(r && r.bank) || '').toLowerCase().trim(); };
        var list = Array.isArray(records) ? records.filter(function (r) { return r && typeof r === 'object'; }) : [];

        // the numbered cards of each bank: the numbers on the rows, and the credit cards of Settings > Cards and accounts (an entry that says bank account is not a card)
        var numbered = {};
        var note = function (bk, n) { if (!bk || !n) return; (numbered[bk] = numbered[bk] || {})[n] = true; };
        list.forEach(function (r) { note(bankKey(r), last4Of(r)); });
        var registry = ctx.registry && typeof ctx.registry === 'object' ? ctx.registry : {};
        Object.keys(registry).forEach(function (k) {
            var e = registry[k];
            if (e && e.type === 'credit_card') note(String(canon(e.bank) || '').toLowerCase().trim(), String(e.last4 || k).trim());
        });

        var keyOf = function (r) {
            var bk = bankKey(r), n = last4Of(r);
            if (!bk && !n) return '';
            if (n) return bk + '|' + n;
            var only = Object.keys(numbered[bk] || {});
            return bk + '|' + (only.length === 1 ? only[0] : '');
        };

        var byKey = {}, order = [];
        list.forEach(function (r) {
            var k = keyOf(r);
            if (!k) return;
            var t = byKey[k];
            if (!t) {
                var bank = canon(r.bank) || '';
                var n = k.slice(k.indexOf('|') + 1);
                t = byKey[k] = { key: k, bank: bank, bankKey: k.slice(0, k.indexOf('|')), last4: n, label: shown(bank) || bank || 'Card', count: 0, open: 0, dueCents: 0, late: 0 };
                order.push(k);
            }
            t.count += 1;
            if (open(r)) { t.open += 1; t.dueCents += cents(value(r)); if (late(r)) t.late += 1; }
        });
        var tabs = order.map(function (k) { var t = byKey[k]; t.due = t.dueCents / 100; delete t.dueCents; return t; });
        // what is owed first, then the card with the most rows, then the name: the card that needs the owner comes first
        tabs.sort(function (a, b) { return (b.due - a.due) || (b.count - a.count) || a.label.localeCompare(b.label); });
        return { keyOf: keyOf, tabs: tabs };
    }

    var initials = function (label) {
        var words = String(label || '').replace(/\([^)]*\)/g, ' ').split(/[^A-Za-z0-9]+/).filter(function (w) { return w && !/^(bank|ltd|plc|pvt|the|of|and|limited|finance)$/i.test(w); });
        if (!words.length) return '?';
        return (words.length === 1 ? words[0].slice(0, 2) : words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
    };

    /**
     * The tab row as HTML. `active` is a tab's key or 'all'.
     * @param {{tabs:Array}} model what `build` returned
     * @param {string} active
     * @param {{fmt?:function(number):string, noun?:string, dueLabel?:string, allLabel?:string, name?:string}} opts
     *   noun: what a row is called ("charge", "plan"); dueLabel: "Due" for charges, "Monthly" for plans; name: the tablist's accessible name
     */
    function render(model, active, opts) {
        opts = opts || {};
        var fmt = typeof opts.fmt === 'function' ? opts.fmt : function (n) { return Number(n).toFixed(2); };
        var noun = opts.noun || 'row', dueLabel = opts.dueLabel || 'Due';
        var tabs = (model && model.tabs) || [];
        var plural = function (n) { return n + ' ' + noun + (n === 1 ? '' : 's'); };
        var tab = function (key, mark, label, meta, due, late, on) {
            var shownDue = due > 0 ? fmt(due) : 'Nothing due';
            return '<button type="button" role="tab" class="wf-ctab' + (on ? ' is-on' : '') + (late ? ' is-late' : '') + '" data-card-tab="' + esc(key) + '" aria-selected="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '">'
                + '<span class="wf-ctab-mark" aria-hidden="true">' + esc(mark) + '</span>'
                + '<span class="wf-ctab-name" title="' + esc(label) + '">' + esc(label) + '</span>'
                + '<span class="wf-ctab-meta">' + esc(meta) + '</span>'
                + '<span class="wf-ctab-due' + (due > 0 ? '' : ' is-none') + '"><span class="wf-ctab-duelbl">' + esc(dueLabel) + '</span> <span class="wf-ctab-amt">' + esc(shownDue) + '</span>'
                + (late ? ' <span class="wf-ctab-late">' + esc(late + ' overdue') + '</span>' : '') + '</span>'
                + '</button>';
        };
        var totalCount = 0, totalDue = 0, totalLate = 0;
        tabs.forEach(function (t) { totalCount += t.count; totalDue += Math.round(t.due * 100); totalLate += t.late; });
        var html = tab('all', 'All', opts.allLabel || 'All cards', tabs.length + ' cards · ' + plural(totalCount), totalDue / 100, totalLate, active === 'all' || !tabs.some(function (t) { return t.key === active; }));
        tabs.forEach(function (t) {
            html += tab(t.key, initials(t.label), t.label, (t.last4 ? '••' + t.last4 + ' · ' : '') + plural(t.count), t.due, t.late, t.key === active);
        });
        return '<div class="wf-ctabs" role="tablist" aria-label="' + esc(opts.name || 'Credit cards') + '">' + html + '</div>';
    }

    /**
     * One delegated listener on the host, added once: a click picks a tab; the arrow keys, Home and End move between tabs (the tabs are one stop in the tab order).
     * @param {Element} host
     * @param {function(string):void} pick called with the tab's key ('all' or a card key)
     */
    function wire(host, pick) {
        if (!host || host.__wfCardTabs) { if (host) host.__wfCardTabsPick = pick; return; }
        host.__wfCardTabs = true; host.__wfCardTabsPick = pick;
        var choose = function (el) { if (el && typeof host.__wfCardTabsPick === 'function') host.__wfCardTabsPick(el.getAttribute('data-card-tab') || 'all'); };
        host.addEventListener('click', function (ev) {
            var el = ev.target && ev.target.closest ? ev.target.closest('[data-card-tab]') : null;
            if (el && host.contains(el)) choose(el);
        });
        host.addEventListener('keydown', function (ev) {
            var el = ev.target && ev.target.closest ? ev.target.closest('[data-card-tab]') : null;
            if (!el || !host.contains(el)) return;
            var all = Array.prototype.slice.call(host.querySelectorAll('[data-card-tab]')), at = all.indexOf(el), next = -1;
            if (ev.key === 'ArrowRight' || ev.key === 'ArrowDown') next = (at + 1) % all.length;
            else if (ev.key === 'ArrowLeft' || ev.key === 'ArrowUp') next = (at - 1 + all.length) % all.length;
            else if (ev.key === 'Home') next = 0;
            else if (ev.key === 'End') next = all.length - 1;
            if (next < 0) return;
            ev.preventDefault();
            choose(all[next]);
            // the screen repaints the row on a pick; focus follows the chosen tab afterwards
            var want = all[next].getAttribute('data-card-tab');
            var focus = function () { var again = host.querySelector('[data-card-tab="' + String(want).replace(/"/g, '\\"') + '"]'); if (again && again.focus) again.focus(); };
            if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(focus); else focus();
        });
    }

    /**
     * On a phone the row scrolls sideways; a repaint starts it at the left again, so a card chosen further along would vanish from view. Brings the chosen tab back into view, only inside the
     * row (the page itself never moves). Call once the host is shown.
     * @param {Element} host the element the row was rendered into
     */
    function reveal(host) {
        var row = host && host.querySelector ? host.querySelector('.wf-ctabs') : null;
        var on = row ? row.querySelector('.wf-ctab.is-on') : null;
        if (!row || !on || !row.getBoundingClientRect) return;
        var r = row.getBoundingClientRect(), t = on.getBoundingClientRect();
        if (!r.width) return;
        // line the tab's left edge up with the row's: that is the tab's own snap point (scroll-snap-align: start), so the browser keeps it there instead of snapping back to the first tab
        if (t.left < r.left - 1 || t.right > r.right + 1) row.scrollLeft += (t.left - r.left);
    }

    /* ── THE MINIMUM PAYMENT EACH CARD ASKS FOR ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
     * A card statement's foot prints the least the bank must receive and the day it must receive it by. The worker keeps that as one `cardDues` record per statement (statement-due.mjs). This is the model
     * and the markup of the section the CC One-Time page shows above the charges: the latest ask of each card, how many days are left, and whether the payments made since the statement already cover it.
     * Days are counted on the calendar (UTC day numbers of the printed dates), money in whole cents. */
    var dayNum = function (iso) { var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '')); return m ? Math.round(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000) : NaN; };
    var RANK = { late: 0, soon: 1, open: 2, covered: 3, paid: 4 };
    /**
     * @param {Array<object>} records the owner's `cardDues` ({id, bank, card_last4, minimum, dueDate, closing?, statementEnd?, paidManually?})
     * @param {Array<object>} payments the owner's `ccPayments` (money paid TO a card: {date, amount, card_last4?, bank?})
     * @param {{today:string, canonBank?:function(string):string, shown?:function(string):string}} ctx today as 'YYYY-MM-DD'
     * @returns {Array<{id,key,bank,last4,label,minimum,closing,dueDate,statementEnd,daysLeft,paid,short,state}>} state: late (past the date, minimum not covered) | soon (5 days or fewer) | open | covered | paid (the owner said so)
     */
    function dues(records, payments, ctx) {
        ctx = ctx || {};
        var today = dayNum(ctx.today);
        if (isNaN(today)) return [];
        var canon = typeof ctx.canonBank === 'function' ? ctx.canonBank : function (b) { return String(b || '').trim(); };
        var shown = typeof ctx.shown === 'function' ? ctx.shown : function (b) { return String(b || ''); };
        var bankOf = function (r) { return String(canon(r && r.bank) || '').toLowerCase().trim(); };
        var latest = {};
        (Array.isArray(records) ? records : []).forEach(function (r) {
            if (!r || !(Number(r.minimum) > 0)) return;
            var due = dayNum(r.dueDate);
            if (isNaN(due)) return;
            var l4 = last4Of(r), key = bankOf(r) + '|' + l4;
            if (!latest[key] || latest[key].due < due) latest[key] = { r: r, due: due, key: key, l4: l4, bank: bankOf(r) };
        });
        var out = [];
        Object.keys(latest).forEach(function (k) {
            var x = latest[k], r = x.r, min = cents(r.minimum);
            // what the card received after the statement's last day counts toward it; a statement that does not say its last day is taken to close 25 days before its due date
            var from = !isNaN(dayNum(r.statementEnd)) ? dayNum(r.statementEnd) : x.due - 25, paid = 0;
            (Array.isArray(payments) ? payments : []).forEach(function (p) {
                var d = p ? dayNum(p.date) : NaN;
                if (isNaN(d) || d <= from || d > today) return;
                var pl = last4Of(p), same = x.l4 && pl ? pl === x.l4 : !!x.bank && bankOf(p) === x.bank;
                if (same) paid += cents(p.amount);
            });
            var daysLeft = x.due - today;
            var state = r.paidManually ? 'paid' : paid >= min ? 'covered' : daysLeft < 0 ? 'late' : daysLeft <= 5 ? 'soon' : 'open';
            if (daysLeft < -45 || ((state === 'paid' || state === 'covered') && daysLeft < -7)) return;        // an old ask that was met is not news
            var bankName = shown(r.bank) || r.bank || 'Card';
            out.push({ id: r.id, key: k, bank: bankName, last4: x.l4, label: bankName + (x.l4 ? ' ••••' + x.l4 : ''), minimum: min / 100, closing: r.closing == null ? null : Number(r.closing), dueDate: r.dueDate, statementEnd: r.statementEnd || '', daysLeft: daysLeft, paid: paid / 100, short: Math.max(0, min - paid) / 100, state: state });
        });
        out.sort(function (a, b) { return (RANK[a.state] - RANK[b.state]) || (a.daysLeft - b.daysLeft) || a.label.localeCompare(b.label); });
        return out;
    }
    var when = function (n) { return n < 0 ? Math.abs(n) + ' day' + (Math.abs(n) === 1 ? '' : 's') + ' overdue' : n === 0 ? 'due today' : n === 1 ? 'due tomorrow' : 'in ' + n + ' days'; };
    var longDate = function (iso) { var d = new Date(dayNum(iso) * 86400000); try { return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }); } catch (_) { return iso; } };
    /** The section as HTML (empty string when no card has an ask). `opts.fmt` turns a number into the money text the page uses. */
    function renderDues(list, opts) {
        opts = opts || {};
        var fmt = typeof opts.fmt === 'function' ? opts.fmt : function (n) { return Number(n).toFixed(2); };
        if (!Array.isArray(list) || !list.length) return '';
        var cards = list.map(function (d) {
            var done = d.state === 'covered' || d.state === 'paid';
            var chip = d.state === 'paid' ? 'Marked as paid' : d.state === 'covered' ? 'Covered' : when(d.daysLeft);
            var note = [];
            if (d.state === 'covered') note.push(fmt(d.paid) + ' has reached this card since the statement, which covers the minimum.');
            else {
                if (d.paid > 0) note.push(fmt(d.paid) + ' paid since the statement; ' + fmt(d.short) + ' still to go.');
                if (d.closing != null && d.closing > 0) note.push('Statement balance ' + fmt(d.closing) + '. Paying only the minimum leaves the rest to carry interest.');
            }
            return '<article class="wf-due-card is-' + esc(d.state) + '" data-due-id="' + esc(d.id) + '">'
                + '<div class="wf-due-top"><span class="wf-due-who">' + esc(d.label) + '</span><span class="wf-due-chip">' + esc(chip) + '</span></div>'
                + '<div class="wf-due-main"><span class="wf-due-lbl">' + (done ? 'Minimum payment' : 'Pay at least') + '</span> <span class="wf-due-amt">' + esc(fmt(d.minimum)) + '</span></div>'
                + '<div class="wf-due-when">' + (done ? 'was due ' : 'before ') + esc(longDate(d.dueDate)) + '</div>'
                + (note.length ? '<div class="wf-due-note">' + esc(note.join(' ')) + '</div>' : '')
                + (done ? '' : '<div class="wf-due-act"><button type="button" class="btn btn-sm" data-due-paid="' + esc(d.id) + '">I have paid this</button></div>')
                + '</article>';
        }).join('');
        return '<section class="wf-due" aria-label="Minimum payment due"><div class="wf-due-h"><span class="wf-due-title">Minimum payment due</span><span class="wf-due-sub">The least each card statement asks for, and the date the bank must have it by. These are not charges.</span></div><div class="wf-due-list">' + cards + '</div></section>';
    }

    var API = { build: build, render: render, wire: wire, reveal: reveal, dues: dues, renderDues: renderDues, initials: initials, keyParts: function (key) { var i = String(key).indexOf('|'); return i < 0 ? { bankKey: String(key), last4: '' } : { bankKey: key.slice(0, i), last4: key.slice(i + 1) }; } };
    root.WFCardTabs = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
