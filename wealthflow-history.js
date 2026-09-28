/* =============================================================================
   WealthFlow History & Breakdown  v1.0
   ---------------------------------------------------------------------------
   User requirement: when a bank statement is imported, multiple same-month
   payments to the same place (e.g. 5 mobile recharges) must aggregate into that
   category's / place's / month's total; importing more statements accumulates
   onto the existing month total (never double-counting identical rows); and the
   user can open a HISTORY for any month to see every underlying transaction
   (date + amount). Applies to EVERY category/tab, not just mobile.

   Design (mathematically safe):
     • Totals are DERIVED by grouping the individual records, never stored as a
       mutable running total. So same-month rows sum automatically, re-imports
       accumulate (the importer already de-dupes identical rows), and deleting a
       row self-corrects. History = the underlying records.
     • Read-only over the live DB. Zero data migration. Cannot corrupt anything.

   Hierarchy:  Category (tab)  →  Place (payee/number)  →  Month  →  Transactions

   API:  window.WFHistory.open()                  – all money movements
         window.WFHistory.open({ tab:'Expenses' }) – one tab
         window.WFHistory.open({ category:'Telecom' })
         window.WFHistory.close()
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_HISTORY_LOADED) return;
    window.WF_HISTORY_LOADED = '1.0';

    // ── tiny helpers (self-contained; never depend on app internals) ───────────
    function DBget(k) { try { return (window.DB && DB.get(k)) || []; } catch (_) { return []; } }
    function num(v) { if (typeof v === 'number') return isFinite(v) ? v : 0; const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function fmt(n) { try { if (typeof window.fmtS === 'function') return window.fmtS(n); } catch (_) {} const v = Math.round(num(n)); return 'LKR ' + v.toLocaleString('en-US'); }
    function ym(x) { if (!x) return ''; const s = String(x); return /^\d{4}-\d{2}/.test(s) ? s.slice(0, 7) : ''; }
    function isoDay(ts) { try { return new Date(ts).toISOString().slice(0, 10); } catch (_) { return ''; } }
    function monthLabel(m) { try { const a = String(m).split('-'); return new Date(+a[0], (+a[1] || 1) - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' }); } catch (_) { return m; } }
    function dayLabel(d) { if (!d) return '—'; try { const x = new Date(d + (d.length <= 10 ? 'T00:00:00' : '')); if (isNaN(x)) return d; return x.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' }); } catch (_) { return d; } }
    function placeKey(s) { const k = String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); return k || '—'; }
    function titleCase(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }

    // ── collect every dated money movement into ONE uniform shape ──────────────
    // Each adapter is wrapped so a malformed store can never break the view.
    function collect() {
        const out = [];
        const add = (o) => {
            try {
                const month = o.month || ym(o.date); if (!month) return;
                const amount = num(o.amount); if (!amount) return;
                out.push({
                    tab: o.tab || 'Other', category: (o.category && String(o.category).trim()) || 'Other',
                    place: (o.place && String(o.place).trim()) || '—', placeKey: placeKey(o.place),
                    month: month, date: o.date || (month + '-01'), amount: amount,
                    direction: o.direction || 'out', source: o.source || 'manual', id: o.id || ''
                });
            } catch (_) {}
        };
        const safe = (fn) => { try { fn(); } catch (_) {} };

        safe(() => DBget('expenses').forEach(e => add({ tab: 'Expenses', category: e.cat, place: e.desc, month: e.month, date: e.date, amount: e.amount, direction: 'out', source: e.source, id: e.id })));
        safe(() => DBget('incomeRecv').forEach(i => add({ tab: 'Income', category: i.type || 'Income', place: i.name, month: i.month, date: i.date, amount: i.amount, direction: 'in', source: i.source, id: i.id })));
        safe(() => DBget('cconetime').forEach(c => add({ tab: 'Card', category: titleCase(c.type || 'Card'), place: c.desc, date: c.date, amount: (c.combinedTotal != null ? c.combinedTotal : c.amount), direction: 'out', source: c.source, id: c.id })));
        safe(() => DBget('cheques').forEach(c => add({ tab: 'Cheques', category: 'Cheque', place: c.party || c.desc || c.no, date: c.issue || c.date, amount: c.amount, direction: (c.type === 'incoming' || c.dir === 'in') ? 'in' : 'out', source: c.source, id: c.id })));
        safe(() => DBget('loans').forEach(l => (l.payments || []).forEach(p => { if (p && p.paid) add({ tab: 'Loans', category: 'Loan Repayment', place: l.name || l.bank || 'Loan', month: p.month, date: p.paidAt ? isoDay(p.paidAt) : (p.month ? p.month + '-01' : ''), amount: p.amount, direction: 'out', source: p.source || 'manual', id: (l.id || '') + ':' + (p.month || '') }); })));
        safe(() => DBget('ccinstall').forEach(pl => (pl.payments || []).forEach(pay => { if (pay && pay.paid) add({ tab: 'Card', category: 'Installment', place: pl.name || pl.desc || pl.merchant || 'Installment', month: pay.month, date: pay.paidAt ? isoDay(pay.paidAt) : (pay.month ? pay.month + '-01' : ''), amount: pay.amount, direction: 'out', source: 'ccinstall', id: (pl.id || '') + ':' + (pay.month || '') }); })));
        safe(() => DBget('subscriptions').forEach(s => { const mo = s.monthOverrides || {}; Object.keys(mo).forEach(m => { if (typeof mo[m] === 'number') add({ tab: 'Subscriptions', category: s.category || 'Subscription', place: s.name, month: m, date: m + '-01', amount: mo[m], direction: 'out', source: 'subscription', id: (s.id || '') + ':' + m }); }); }));
        return out;
    }

    // ── group into Category → Place → Month → txns (all totals DERIVED) ─────────
    function build(records, opts) {
        opts = opts || {};
        const wantCat = opts.category && opts.category !== 'all' ? opts.category : null;
        const wantTab = opts.tab && opts.tab !== 'all' ? opts.tab : null;
        const q = (opts.query || '').trim().toLowerCase();
        const cats = {};
        let grandTotal = 0, txnCount = 0;
        records.forEach(r => {
            if (wantTab && r.tab !== wantTab) return;
            if (wantCat && r.category !== wantCat) return;
            if (q && String(r.place).toLowerCase().indexOf(q) < 0 && String(r.category).toLowerCase().indexOf(q) < 0) return;
            const c = cats[r.category] || (cats[r.category] = { category: r.category, total: 0, txns: 0, places: {} });
            c.total += r.amount; c.txns++;
            const p = c.places[r.placeKey] || (c.places[r.placeKey] = { place: r.place, placeKey: r.placeKey, tab: r.tab, total: 0, txns: 0, months: {} });
            if (r.place && r.place.length > p.place.length) p.place = r.place;   // keep the fullest label
            p.total += r.amount; p.txns++;
            const m = p.months[r.month] || (p.months[r.month] = { month: r.month, total: 0, txns: [] });
            m.total += r.amount; m.txns.push(r);
            grandTotal += r.amount; txnCount++;
        });
        return { cats, grandTotal, txnCount };
    }

    // ── styles (scoped, injected once) ─────────────────────────────────────────
    function injectCSS() {
        if (document.getElementById('wfh-css')) return;
        const s = document.createElement('style'); s.id = 'wfh-css';
        s.textContent = [
            '.wfh-ov{position:fixed;inset:0;z-index:100000;background:rgba(8,10,20,.62);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);display:flex;align-items:flex-end;justify-content:center;opacity:0;transition:opacity .22s}',
            '.wfh-ov.show{opacity:1}',
            '.wfh-sheet{width:100%;max-width:760px;max-height:92vh;display:flex;flex-direction:column;background:var(--card,#12141f);color:var(--text,#e8eaf2);border:1px solid var(--border2,rgba(255,255,255,.08));border-radius:22px 22px 0 0;box-shadow:0 -20px 60px rgba(0,0,0,.5);transform:translateY(24px);transition:transform .26s cubic-bezier(.22,1,.36,1)}',
            '.wfh-ov.show .wfh-sheet{transform:none}',
            '@media(min-width:820px){.wfh-ov{align-items:center}.wfh-sheet{border-radius:22px;max-height:86vh}}',
            '.wfh-hd{display:flex;align-items:center;gap:12px;padding:16px 18px 12px;border-bottom:1px solid var(--border2,rgba(255,255,255,.07))}',
            '.wfh-hd h3{font-size:17px;font-weight:800;margin:0;flex:1;letter-spacing:.2px}',
            '.wfh-x{border:none;background:var(--bg2,rgba(255,255,255,.06));color:inherit;width:34px;height:34px;border-radius:50%;font-size:18px;cursor:pointer;line-height:1}',
            '.wfh-tools{padding:12px 18px;display:flex;flex-direction:column;gap:10px;border-bottom:1px solid var(--border2,rgba(255,255,255,.07))}',
            '.wfh-search{width:100%;background:var(--bg2,rgba(255,255,255,.05));border:1px solid var(--border2,rgba(255,255,255,.1));color:inherit;border-radius:12px;padding:10px 12px;font-size:14px;outline:none}',
            '.wfh-chips{display:flex;gap:8px;overflow-x:auto;padding-bottom:2px;-webkit-overflow-scrolling:touch}',
            '.wfh-chip{white-space:nowrap;border:1px solid var(--border2,rgba(255,255,255,.12));background:transparent;color:var(--text2,#aab);padding:7px 13px;border-radius:999px;font-size:12.5px;font-weight:700;cursor:pointer;transition:.15s}',
            '.wfh-chip.on{background:var(--accent,#6c8cff);border-color:transparent;color:#fff}',
            '.wfh-sum{display:flex;gap:14px;padding:12px 18px;font-size:12px;color:var(--text3,#8890a6);border-bottom:1px solid var(--border2,rgba(255,255,255,.06))}',
            '.wfh-sum b{display:block;font-size:17px;color:var(--text,#e8eaf2);font-weight:800;margin-top:2px}',
            '.wfh-body{overflow-y:auto;padding:10px 12px 24px;flex:1}',
            '.wfh-place{border:1px solid var(--border2,rgba(255,255,255,.08));border-radius:14px;margin:8px 0;overflow:hidden;background:var(--bg2,rgba(255,255,255,.02))}',
            '.wfh-place>summary,.wfh-month>summary{list-style:none;cursor:pointer;display:flex;align-items:center;gap:10px;padding:13px 14px;user-select:none}',
            '.wfh-place>summary::-webkit-details-marker,.wfh-month>summary::-webkit-details-marker{display:none}',
            '.wfh-nm{flex:1;min-width:0}',
            '.wfh-nm .t{font-weight:750;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.wfh-nm .s{font-size:11px;color:var(--text3,#8890a6);margin-top:2px}',
            '.wfh-amt{font-weight:800;font-size:14px;text-align:right;white-space:nowrap}',
            '.wfh-catbadge{font-size:10px;font-weight:800;padding:3px 8px;border-radius:999px;background:rgba(108,140,255,.16);color:var(--accent,#8ba0ff)}',
            '.wfh-caret{transition:transform .2s;color:var(--text3,#8890a6);font-size:12px}',
            'details[open]>summary .wfh-caret{transform:rotate(90deg)}',
            '.wfh-months{padding:2px 10px 10px}',
            '.wfh-month{border-top:1px dashed var(--border2,rgba(255,255,255,.08))}',
            '.wfh-month>summary{padding:11px 4px}',
            '.wfh-histbtn{font-size:10.5px;font-weight:800;color:var(--accent,#8ba0ff);border:1px solid var(--border2,rgba(255,255,255,.14));border-radius:999px;padding:4px 9px;background:transparent}',
            '.wfh-txns{padding:2px 4px 10px}',
            '.wfh-tx{display:flex;align-items:center;gap:10px;padding:9px 10px;border-radius:10px}',
            '.wfh-tx:nth-child(odd){background:rgba(255,255,255,.025)}',
            '.wfh-tx .d{font-size:12.5px;color:var(--text2,#c3c8d8);min-width:96px}',
            '.wfh-tx .m{flex:1;font-size:11px;color:var(--text3,#8890a6);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
            '.wfh-tx .a{font-weight:750;font-size:13px;white-space:nowrap}',
            '.wfh-src{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:.4px;padding:2px 6px;border-radius:6px;background:rgba(255,255,255,.06);color:var(--text3,#8890a6)}',
            '.wfh-in{color:#22c58b}.wfh-out{color:inherit}',
            '.wfh-empty{text-align:center;color:var(--text3,#8890a6);padding:48px 20px;font-size:14px}'
        ].join('');
        document.head.appendChild(s);
    }

    // ── rendering ──────────────────────────────────────────────────────────────
    let _state = { tab: null, category: 'all', query: '' };

    function bodyHTML() {
        const recs = collect();
        // category chip universe respects the tab scope (if any)
        const scoped = _state.tab ? recs.filter(r => r.tab === _state.tab) : recs;
        const catTotals = {};
        scoped.forEach(r => { catTotals[r.category] = (catTotals[r.category] || 0) + r.amount; });
        const catList = Object.keys(catTotals).sort((a, b) => catTotals[b] - catTotals[a]);
        const chips = ['<button class="wfh-chip ' + (_state.category === 'all' ? 'on' : '') + '" data-cat="all">All</button>']
            .concat(catList.map(c => '<button class="wfh-chip ' + (_state.category === c ? 'on' : '') + '" data-cat="' + esc(c) + '">' + esc(c) + '</button>')).join('');

        const model = build(recs, { tab: _state.tab, category: _state.category, query: _state.query });
        const places = [];
        Object.keys(model.cats).forEach(ck => { const c = model.cats[ck]; Object.keys(c.places).forEach(pk => places.push(Object.assign({ category: c.category }, c.places[pk]))); });
        places.sort((a, b) => b.total - a.total);

        let list;
        if (!places.length) {
            list = '<div class="wfh-empty">No transactions yet for this view.<br>Import a bank statement or add records, and they will appear here grouped by month.</div>';
        } else {
            list = places.map(p => {
                const months = Object.values(p.months).sort((a, b) => b.month.localeCompare(a.month));
                const monthsHTML = months.map(m => {
                    const txns = m.txns.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
                    const rows = txns.map(t => (
                        '<div class="wfh-tx">' +
                        '<span class="d">' + esc(dayLabel(t.date)) + '</span>' +
                        '<span class="m">' + esc(t.place || '') + '</span>' +
                        (t.source && t.source !== 'manual' ? '<span class="wfh-src">' + esc(t.source) + '</span>' : '') +
                        '<span class="a wfh-' + (t.direction === 'in' ? 'in' : 'out') + '">' + (t.direction === 'in' ? '+' : '') + esc(fmt(t.amount)) + '</span>' +
                        '</div>'
                    )).join('');
                    return (
                        '<details class="wfh-month">' +
                        '<summary><span class="wfh-caret">▶</span>' +
                        '<span class="wfh-nm"><div class="t">' + esc(monthLabel(m.month)) + '</div><div class="s">' + m.txns.length + ' transaction' + (m.txns.length > 1 ? 's' : '') + '</div></span>' +
                        '<span class="wfh-histbtn">History</span>' +
                        '<span class="wfh-amt">' + esc(fmt(m.total)) + '</span></summary>' +
                        '<div class="wfh-txns">' + rows + '</div>' +
                        '</details>'
                    );
                }).join('');
                return (
                    '<details class="wfh-place">' +
                    '<summary><span class="wfh-caret">▶</span>' +
                    '<span class="wfh-nm"><div class="t">' + esc(p.place) + '</div><div class="s">' + p.txns + ' payment' + (p.txns > 1 ? 's' : '') + ' · ' + months.length + ' month' + (months.length > 1 ? 's' : '') + '</div></span>' +
                    '<span class="wfh-catbadge">' + esc(p.category) + '</span>' +
                    '<span class="wfh-amt">' + esc(fmt(p.total)) + '</span></summary>' +
                    '<div class="wfh-months">' + monthsHTML + '</div>' +
                    '</details>'
                );
            }).join('');
        }

        return (
            '<div class="wfh-tools">' +
            '<input class="wfh-search" type="search" placeholder="Search a place, number or category…" value="' + esc(_state.query) + '">' +
            '<div class="wfh-chips">' + chips + '</div>' +
            '</div>' +
            '<div class="wfh-sum"><div>Total<b>' + esc(fmt(model.grandTotal)) + '</b></div><div>Places<b>' + places.length + '</b></div><div>Transactions<b>' + model.txnCount + '</b></div></div>' +
            '<div class="wfh-body">' + list + '</div>'
        );
    }

    function repaint() {
        const host = document.getElementById('wfh-content'); if (!host) return;
        // preserve search focus/caret across repaint
        const active = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('wfh-search');
        const caret = active ? document.activeElement.selectionStart : null;
        host.innerHTML = bodyHTML();
        if (active) { const inp = host.querySelector('.wfh-search'); if (inp) { inp.focus(); try { inp.setSelectionRange(caret, caret); } catch (_) {} } }
    }

    function open(opts) {
        injectCSS();
        opts = opts || {};
        _state = { tab: opts.tab || null, category: opts.category || 'all', query: '' };
        close(true);
        const ov = document.createElement('div'); ov.className = 'wfh-ov'; ov.id = 'wfh-ov';
        ov.innerHTML =
            '<div class="wfh-sheet" role="dialog" aria-label="Spending and payment history">' +
            '<div class="wfh-hd"><h3>' + (opts.tab ? esc(opts.tab) + ' — History' : 'Spending & Payment History') + '</h3><button class="wfh-x" id="wfh-x" aria-label="Close">✕</button></div>' +
            '<div id="wfh-content"></div>' +
            '</div>';
        document.body.appendChild(ov);
        const content = ov.querySelector('#wfh-content'); content.innerHTML = bodyHTML();
        requestAnimationFrame(() => ov.classList.add('show'));

        // interactions (delegated)
        ov.addEventListener('click', (e) => {
            if (e.target.id === 'wfh-ov' || e.target.id === 'wfh-x' || e.target.closest('#wfh-x')) { close(); return; }
            const chip = e.target.closest('.wfh-chip');
            if (chip) { _state.category = chip.getAttribute('data-cat'); repaint(); return; }
            const hist = e.target.closest('.wfh-histbtn');
            if (hist) { const d = hist.closest('details.wfh-month'); if (d) { e.preventDefault(); d.open = !d.open; } return; }
        });
        ov.addEventListener('input', (e) => { if (e.target.classList.contains('wfh-search')) { _state.query = e.target.value; repaint(); } });
        document.addEventListener('keydown', _esc, true);
        try { if (window.triggerHaptic) window.triggerHaptic(); } catch (_) {}
    }
    function _esc(e) { if (e.key === 'Escape') close(); }
    function close(silent) {
        document.removeEventListener('keydown', _esc, true);
        const ov = document.getElementById('wfh-ov'); if (!ov) return;
        if (silent) { ov.remove(); return; }
        ov.classList.remove('show'); setTimeout(() => { try { ov.remove(); } catch (_) {} }, 240);
    }

    // ── best-effort launcher buttons in the relevant tab headers ───────────────
    function injectButtons() {
        const map = [
            ['page-expenses', null], ['page-subscriptions', 'Subscriptions'], ['page-incRecv', 'Income'],
            ['page-cconetime', 'Card'], ['page-loans', 'Loans'], ['page-ccinstall', 'Card'], ['page-cheques', 'Cheques']
        ];
        map.forEach(([pid, tab]) => {
            try {
                const page = document.getElementById(pid); if (!page) return;
                const actions = page.querySelector('.sh-actions'); if (!actions || actions.querySelector('.wfh-launch')) return;
                const b = document.createElement('button');
                b.className = 'wfh-launch';
                b.type = 'button';
                b.title = 'Monthly history & breakdown';
                b.style.cssText = 'border:1px solid var(--border2,rgba(255,255,255,.14));background:var(--bg2,rgba(255,255,255,.05));color:var(--text2,#c3c8d8);border-radius:10px;padding:8px 12px;font-size:13px;font-weight:700;cursor:pointer;display:inline-flex;align-items:center;gap:6px';
                b.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"></path><path d="M18 9l-5 5-3-3-4 4"></path></svg> History';
                b.addEventListener('click', () => open(tab ? { tab } : {}));
                actions.insertBefore(b, actions.firstChild);
            } catch (_) {}
        });
    }
    function boot() { try { injectButtons(); } catch (_) {} }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
    // re-inject after tab switches (pages render lazily in some builds)
    try { document.addEventListener('click', () => setTimeout(boot, 60), true); } catch (_) {}

    window.WFHistory = { open, close, collect, build };
})();
