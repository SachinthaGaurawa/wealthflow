/* =============================================================================
   WealthFlow · Cards & Accounts  v2.0  —  window.wfOpenCardRegistry
   ---------------------------------------------------------------------------
   A genuine per-card intelligence manager (was a bare last-4 → type mapper).

   For every card/account you register it shows, computed live from your own
   data (cconetime charges + ccPayments), a luxury card tile with:
       • outstanding balance            (unpaid charges on that card)
       • credit-limit utilization bar   (outstanding ÷ limit, colour-graded)
       • available credit               (limit − outstanding)
       • spent this month / paid this month
       • next statement date + next payment-due date (from the days you set)
       • charge count

   AND it still powers the routing brain: WFRoute.accountTypeForLast4() reads
   the `type` we store here, so every statement/SMS charge on a known last-4 is
   filed to the correct tab automatically. Backend is window.wfCardRegistry
   (get/upsert/delete) which merges ANY fields — so the richer profile needs no
   backend change. `type` is preserved as 'credit_card' | 'bank_account' exactly
   as the router requires.

   Self-contained. No emojis (inline SVG only). Idempotent load guard.
   ===========================================================================*/
(function () {
    'use strict';
    // Node-safe global handle: in the browser this IS window (identical behaviour);
    // under Node (unit tests) it falls back to globalThis so the pure intelligence
    // functions below can be imported and tested. Browser-only calls (document,
    // DB, crypto) live inside open()/render() which never run under Node.
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_CARD_REGISTRY_UI === '2.0') return;
    W.WF_CARD_REGISTRY_UI = '2.0';

    /* ---------- helpers ---------- */
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }
    function _reg() { try { return (window.wfCardRegistry && window.wfCardRegistry.get && window.wfCardRegistry.get()) || {}; } catch (_) { return {}; } }
    function _arr(k) { try { return (window.DB && DB.get && DB.get(k)) || []; } catch (_) { return []; } }
    function _num(n) { n = Number(n); return isFinite(n) ? n : 0; }

    // Currency — mirror the app's setting, default LKR. Self-contained so this
    // file never depends on the main script's (non-global) fmt().
    function _cur() { try { const s = (window.DB && DB.getObj) ? (DB.getObj('settings', {}) || {}) : {}; return s.currency || s.primaryCurrency || 'LKR'; } catch (_) { return 'LKR'; } }
    function _fmt(n) { n = _num(n); try { return _cur() + ' ' + n.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 }); } catch (_) { return _cur() + ' ' + n; } }

    const BANKS = ['Commercial Bank', 'HNB', 'Sampath Bank', 'Nations Trust Bank', 'Seylan Bank', 'DFCC Bank', 'NDB Bank', 'Bank of Ceylon', "People's Bank", 'Pan Asia Bank', 'Union Bank', 'Standard Chartered', 'HSBC', 'American Express (AMEX)', 'NSB', 'Cargills Bank', 'Amana Bank', 'Citibank', 'Other'];
    // Router contract: value MUST be 'credit_card' | 'bank_account'.
    const TYPES = [['credit_card', 'Credit Card'], ['bank_account', 'Bank / Debit Account']];
    const NETWORKS = ['', 'Visa', 'Mastercard', 'Amex', 'UnionPay', 'JCB', 'Other'];

    /* ---------- inline SVG (no emojis) ---------- */
    const SVG = {
        card: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
        bank: '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="3" y1="21" x2="21" y2="21"/><line x1="4" y1="10" x2="4" y2="21"/><line x1="20" y1="10" x2="20" y2="21"/><line x1="8" y1="10" x2="8" y2="21"/><line x1="16" y1="10" x2="16" y2="21"/><polygon points="12 2 20 7 4 7 12 2"/></svg>',
        plus: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
        edit: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>',
        trash: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        cal: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>'
    };

    /* ---------- pure intelligence (unit-tested in Node) ---------- */
    // Match a charge/payment row to a card by its last-4.
    // v7.62.0 — LEGACY RESCUE. Every charge imported before this build was written with
    // NO card_last4 (the statement importer simply never set it), so nothing ever matched
    // and every registered card showed "Outstanding 0 / 0% used" — the whole feature looked
    // dead. Those rows are unambiguous when the card is the ONLY one registered for its
    // bank, so we fall back to the bank. With two cards on one bank we stay strict rather
    // than double-count.
    function _matchLast4(row, last4, card, bankIsUnique) {
        const rl = String((row && (row.card_last4 || row.last4)) || '');
        if (rl) return rl === String(last4);
        if (!bankIsUnique || !card || !card.bank) return false;
        const rb = String((row && row.bank) || '').toLowerCase().trim();
        return !!rb && rb === String(card.bank).toLowerCase().trim();
    }

    function cardSummary(last4, charges, payments, card, bankIsUnique) {
        const mine = (charges || []).filter(c => _matchLast4(c, last4, card, bankIsUnique));
        const pays = (payments || []).filter(p => _matchLast4(p, last4, card, bankIsUnique));
        const amt = c => _num(c.combinedTotal != null ? c.combinedTotal : c.amount);
        const ym = new Date().toISOString().slice(0, 7);
        const monthOf = r => String((r && (r.date || r.createdAt)) || '').slice(0, 7);
        const outstanding = mine.filter(c => !c.paid).reduce((s, c) => s + amt(c), 0);
        const spentThisMonth = mine.filter(c => monthOf(c) === ym).reduce((s, c) => s + amt(c), 0);
        const paidThisMonth = pays.filter(p => monthOf(p) === ym).reduce((s, p) => s + _num(p.amount), 0);
        const limit = _num(card && card.creditLimit);
        const isCredit = (card && card.type) === 'credit_card';
        const utilization = (isCredit && limit > 0) ? Math.min(100, Math.round((outstanding / limit) * 100)) : null;
        const available = (isCredit && limit > 0) ? Math.max(0, limit - outstanding) : null;
        return { count: mine.length, unpaidCount: mine.filter(c => !c.paid).length, outstanding, spentThisMonth, paidThisMonth, limit, utilization, available, isCredit };
    }

    // Next calendar occurrence of a given day-of-month (clamped to month length).
    function nextDayOfMonth(day, from) {
        day = Number(day);
        if (!day || day < 1 || day > 31) return null;
        const now = from ? new Date(from) : new Date();
        const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
        const mk = (yy, mm) => { const last = new Date(yy, mm + 1, 0).getDate(); return new Date(yy, mm, Math.min(day, last)); };
        let dt = mk(y, m);
        const todayMid = new Date(y, m, d);
        if (dt < todayMid) { const nm = m + 1; dt = mk(y + Math.floor(nm / 12), nm % 12); }
        return dt;
    }
    function _daysUntil(dt) { if (!dt) return null; return Math.round((dt - new Date(new Date().toISOString().slice(0, 10))) / 86400000); }
    function _fmtDate(dt) { try { return dt.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }); } catch (_) { return ''; } }

    function _utilColor(u) { if (u == null) return '#8b95a8'; if (u < 30) return '#22c55e'; if (u < 70) return '#f59e0b'; return '#ef4444'; }
    function _networkGradient(card) {
        const c = (card && card.color) || '';
        if (c) return 'linear-gradient(135deg,' + c + ',' + c + 'cc)';
        const net = (card && card.network) || '';
        if (net === 'Visa') return 'linear-gradient(135deg,#1a2a6c,#2a4d9c)';
        if (net === 'Mastercard') return 'linear-gradient(135deg,#7a1f1f,#c0392b)';
        if (net === 'Amex') return 'linear-gradient(135deg,#0f5c5c,#1a7f7f)';
        if ((card && card.type) === 'bank_account') return 'linear-gradient(135deg,#1e2a44,#31456e)';
        return 'linear-gradient(135deg,#8a6d1f,#caa233)';           // luxury gold default
    }

    /* ---------- overlay ---------- */
    function open() {
        close();
        const ov = document.createElement('div');
        ov.id = 'wfCardRegOverlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,0.80);backdrop-filter:blur(7px);display:flex;align-items:flex-start;justify-content:center;padding:16px;overflow-y:auto;-webkit-overflow-scrolling:touch;';
        ov.innerHTML =
            '<div style="width:100%;max-width:560px;margin:auto;background:var(--card,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:18px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,0.6);">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top,0px) + 14px));border-bottom:1px solid var(--border,#1f2638);position:sticky;top:0;background:var(--card,#0a0e1a);z-index:2;">' +
                '<div style="display:flex;align-items:center;gap:10px;"><span style="color:#d4af37;">' + SVG.card + '</span><div><div style="font-size:16px;font-weight:800;color:var(--text,#e6e7eb);letter-spacing:.2px;">Cards &amp; Accounts</div><div style="font-size:11px;color:var(--text3,#8b95a8);">Balances, utilization &amp; auto-routing</div></div></div>' +
                '<button id="wfCardRegClose" aria-label="Close" style="background:transparent;border:none;color:#8b95a8;font-size:26px;cursor:pointer;padding:4px 10px;line-height:1;">&times;</button>' +
              '</div>' +
              '<div style="padding:16px 18px 22px;">' +
                '<div id="wfCardRegTotals"></div>' +
                '<div id="wfCardRegList" style="margin-top:14px;"></div>' +
                '<button id="wfCardRegAddBtn" style="width:100%;margin-top:14px;display:flex;align-items:center;justify-content:center;gap:8px;background:transparent;border:1px dashed var(--border2,#2a3450);color:#d4af37;border-radius:12px;padding:13px;font-weight:700;font-size:14px;cursor:pointer;">' + SVG.plus + ' Add a card or account</button>' +
                '<div id="wfCardRegForm" style="display:none;margin-top:14px;"></div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);
        document.getElementById('wfCardRegClose').onclick = close;
        ov.addEventListener('click', e => { if (e.target === ov) close(); });
        document.getElementById('wfCardRegAddBtn').onclick = () => showForm(null);
        render();
    }
    function close() { const ov = document.getElementById('wfCardRegOverlay'); if (ov) ov.remove(); }

    /* ---------- render list + totals ---------- */
    function render() {
        const reg = _reg();
        const keys = Object.keys(reg);
        const charges = _arr('cconetime'), pays = _arr('ccPayments');
        // How many registered cards share each bank? A legacy charge with no last-4 can
        // only be attributed when its bank maps to exactly ONE card.
        const _bankN = {};
        keys.forEach(k => { const b = String((reg[k] && reg[k].bank) || '').toLowerCase().trim(); if (b) _bankN[b] = (_bankN[b] || 0) + 1; });
        const _uniq = k => { const b = String((reg[k] && reg[k].bank) || '').toLowerCase().trim(); return !!b && _bankN[b] === 1; };

        // Portfolio totals across all credit cards.
        let totOut = 0, totLimit = 0, anyCredit = false;
        keys.forEach(k => {
            const s = cardSummary(k, charges, pays, reg[k], _uniq(k));
            if (reg[k].type === 'credit_card') { anyCredit = true; totOut += s.outstanding; totLimit += _num(reg[k].creditLimit); }
        });
        const totalsHost = document.getElementById('wfCardRegTotals');
        if (totalsHost) {
            if (anyCredit && totLimit > 0) {
                const u = Math.min(100, Math.round((totOut / totLimit) * 100));
                totalsHost.innerHTML =
                    '<div style="background:var(--bg2,#060a14);border:1px solid var(--border,#1f2638);border-radius:14px;padding:14px 16px;">' +
                      '<div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px;"><span style="font-size:12px;color:var(--text3,#8b95a8);font-weight:600;">Total card outstanding</span><span style="font-size:16px;font-weight:800;color:var(--text,#e6e7eb);">' + _fmt(totOut) + '</span></div>' +
                      _bar(u) +
                      '<div style="display:flex;justify-content:space-between;margin-top:7px;font-size:11px;color:var(--text3,#8b95a8);"><span>' + u + '% of ' + _fmt(totLimit) + ' limit</span><span>' + _fmt(Math.max(0, totLimit - totOut)) + ' available</span></div>' +
                    '</div>';
            } else { totalsHost.innerHTML = ''; }
        }

        const host = document.getElementById('wfCardRegList');
        if (!host) return;
        if (!keys.length) {
            host.innerHTML =
                '<div style="padding:20px 16px;text-align:center;background:var(--bg2,#060a14);border:1px solid var(--border,#1f2638);border-radius:14px;">' +
                  '<div style="color:var(--text2,#b4bcce);font-size:13px;line-height:1.6;">No cards mapped yet.<br>Add your cards so WealthFlow can <b>auto-file every charge to the right tab</b> and show you <b>live balances, utilization &amp; due dates</b>.</div>' +
                '</div>';
            return;
        }
        // Sort: credit cards first (by highest utilization), then accounts.
        keys.sort((a, b) => {
            const ca = reg[a].type === 'credit_card', cb = reg[b].type === 'credit_card';
            if (ca !== cb) return ca ? -1 : 1;
            const sa = cardSummary(a, charges, pays, reg[a], _uniq(a)), sb = cardSummary(b, charges, pays, reg[b], _uniq(b));
            return (sb.utilization || 0) - (sa.utilization || 0);
        });
        host.innerHTML = keys.map(k => _tile(k, reg[k], cardSummary(k, charges, pays, reg[k], _uniq(k)))).join('');
        // v7.65.0 — the statement day and due day you entered were never read by anything.
        // Now they are: due dates, overdue, utilization and the cost of carrying a balance.
        try {
            if (W.WFInsights) {
                let ins = document.getElementById('wfCardInsights');
                if (!ins) { ins = document.createElement('div'); ins.id = 'wfCardInsights'; ins.style.marginBottom = '14px'; host.parentNode.insertBefore(ins, host); }
                W.WFInsights.renderInto(ins, W.WFInsights.cards(), { title: 'What needs you' });
            }
        } catch (_) {}
        // wire per-tile actions
        keys.forEach(k => {
            const e = document.getElementById('wfCardEdit_' + k); if (e) e.onclick = (ev) => { ev.stopPropagation(); showForm(k); };
            const d = document.getElementById('wfCardDel_' + k); if (d) d.onclick = (ev) => { ev.stopPropagation(); _del(k, reg[k]); };
        });
    }

    function _bar(u) {
        const col = _utilColor(u);
        return '<div style="height:8px;background:rgba(255,255,255,0.06);border-radius:6px;overflow:hidden;"><div style="height:100%;width:' + (u == null ? 0 : u) + '%;background:' + col + ';border-radius:6px;transition:width .4s;"></div></div>';
    }

    function _tile(k, card, s) {
        const bank = _esc(card.bank || 'Card');
        const name = _esc(card.name || '');
        const net = _esc(card.network || '');
        const isCredit = card.type === 'credit_card';
        const grad = _networkGradient(card);
        const dueDt = nextDayOfMonth(card.dueDay), stmtDt = nextDayOfMonth(card.statementDay);
        const dueIn = _daysUntil(dueDt);
        // due urgency colour
        let dueChip = '';
        if (isCredit && dueDt) {
            const col = dueIn <= 3 ? '#ef4444' : dueIn <= 7 ? '#f59e0b' : 'rgba(255,255,255,0.72)';
            dueChip = '<span style="display:inline-flex;align-items:center;gap:4px;color:' + col + ';">' + SVG.cal + ' Due ' + _fmtDate(dueDt) + (dueIn != null && dueIn >= 0 ? ' · ' + dueIn + 'd' : '') + '</span>';
        }
        const stmtChip = (isCredit && stmtDt) ? '<span style="opacity:.75;">Stmt ' + _fmtDate(stmtDt) + '</span>' : '';

        // the luxury card face
        let face =
            '<div style="position:relative;background:' + grad + ';border-radius:14px;padding:15px 16px;color:#fff;overflow:hidden;box-shadow:0 8px 22px rgba(0,0,0,0.35);">' +
              '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
                '<div><div style="font-size:14px;font-weight:800;letter-spacing:.3px;">' + bank + '</div>' + (name ? '<div style="font-size:11px;opacity:.8;margin-top:1px;">' + name + '</div>' : '') + '</div>' +
                '<div style="text-align:right;"><div style="font-size:12px;font-weight:800;letter-spacing:1px;opacity:.95;">' + (net || (isCredit ? 'CARD' : 'ACCOUNT')) + '</div></div>' +
              '</div>' +
              '<div style="font-family:monospace;font-size:16px;letter-spacing:3px;margin:14px 0 10px;opacity:.96;">•••• •••• •••• ' + _esc(k) + '</div>';

        if (isCredit) {
            const u = s.utilization;
            face +=
              '<div style="display:flex;justify-content:space-between;align-items:baseline;">' +
                '<div><div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.5px;">Outstanding</div><div style="font-size:17px;font-weight:800;">' + _fmt(s.outstanding) + '</div></div>' +
                (s.available != null ? '<div style="text-align:right;"><div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.5px;">Available</div><div style="font-size:13px;font-weight:700;">' + _fmt(s.available) + '</div></div>' : '') +
              '</div>';
            if (u != null) {
                face += '<div style="margin-top:9px;"><div style="height:7px;background:rgba(255,255,255,0.22);border-radius:5px;overflow:hidden;"><div style="height:100%;width:' + u + '%;background:' + _utilColor(u) + ';"></div></div>' +
                        '<div style="display:flex;justify-content:space-between;margin-top:5px;font-size:10px;opacity:.85;"><span>' + u + '% used of ' + _fmt(s.limit) + '</span>' + (u >= 70 ? '<span style="font-weight:700;">High</span>' : '') + '</div></div>';
            } else {
                face += '<div style="margin-top:6px;font-size:10.5px;opacity:.7;">Set a credit limit to see utilization</div>';
            }
        } else {
            face +=
              '<div><div style="font-size:10px;opacity:.75;text-transform:uppercase;letter-spacing:.5px;">Debit account</div>' +
              '<div style="font-size:12px;opacity:.9;margin-top:2px;">' + s.count + ' linked transaction' + (s.count === 1 ? '' : 's') + '</div></div>';
        }
        face += '</div>';

        // meta row (spent this month / due / stmt) + actions
        const meta =
            '<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-top:9px;flex-wrap:wrap;">' +
              '<div style="display:flex;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--text3,#8b95a8);align-items:center;">' +
                '<span>Spent this month: <b style="color:var(--text2,#b4bcce);">' + _fmt(s.spentThisMonth) + '</b></span>' + dueChip + stmtChip +
              '</div>' +
              '<div style="display:flex;gap:6px;">' +
                '<button id="wfCardEdit_' + _esc(k) + '" aria-label="Edit" style="display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid var(--border2,#2a3450);color:var(--text2,#b4bcce);border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;">' + SVG.edit + 'Edit</button>' +
                '<button id="wfCardDel_' + _esc(k) + '" aria-label="Delete" style="display:inline-flex;align-items:center;gap:5px;background:transparent;border:1px solid rgba(239,68,68,0.4);color:#ef4444;border-radius:8px;padding:6px 10px;font-size:12px;font-weight:600;cursor:pointer;">' + SVG.trash + '</button>' +
              '</div>' +
            '</div>';

        return '<div style="margin-bottom:14px;">' + face + meta + '</div>';
    }

    /* ---------- add / edit form ---------- */
    function showForm(editKey) {
        const reg = _reg();
        const c = editKey ? (reg[editKey] || {}) : {};
        const inp = (id, ph, val, extra) => '<input id="' + id + '" placeholder="' + _esc(ph) + '" value="' + _esc(val == null ? '' : val) + '" ' + (extra || '') + ' style="width:100%;padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#2a3450);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;box-sizing:border-box;">';
        const sel = (id, opts, val) => '<select id="' + id + '" style="width:100%;padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#2a3450);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;box-sizing:border-box;">' + opts.map(o => { const v = Array.isArray(o) ? o[0] : o, la = Array.isArray(o) ? o[1] : (o || '— select —'); return '<option value="' + _esc(v) + '"' + (String(val || '') === String(v) ? ' selected' : '') + '>' + _esc(la) + '</option>'; }).join('') + '</select>';
        const lbl = t => '<div style="font-size:11px;color:var(--text3,#8b95a8);font-weight:600;margin:0 0 5px 2px;">' + t + '</div>';

        const host = document.getElementById('wfCardRegForm');
        host.style.display = 'block';
        host.innerHTML =
            '<div style="background:var(--bg2,#060a14);border:1px solid var(--border,#1f2638);border-radius:14px;padding:16px;">' +
              '<div style="font-size:14px;font-weight:800;color:var(--text,#e6e7eb);margin-bottom:14px;">' + (editKey ? 'Edit card' : 'New card / account') + '</div>' +
              '<div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;">' +
                '<div>' + lbl('Last 4 digits') + inp('wfCF_last4', '1234', c.last4 || editKey || '', 'inputmode="numeric" maxlength="4"' + (editKey ? ' disabled' : '')) + '</div>' +
                '<div>' + lbl('Nickname') + inp('wfCF_name', 'e.g. Amex Platinum', c.name) + '</div>' +
                '<div>' + lbl('Bank / Issuer') + sel('wfCF_bank', [['', '— Bank —']].concat(BANKS.map(b => [b, b])), c.bank) + '</div>' +
                '<div>' + lbl('Type') + sel('wfCF_type', [['', '— Type —']].concat(TYPES), c.type) + '</div>' +
                '<div id="wfCF_netWrap">' + lbl('Network') + sel('wfCF_net', NETWORKS.map(n => [n, n || '— Network —']), c.network) + '</div>' +
                '<div id="wfCF_limitWrap">' + lbl('Credit limit') + inp('wfCF_limit', 'e.g. 500,000', (c.creditLimit ? Number(c.creditLimit).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ''), 'inputmode="decimal" class="money-input money-cents"') + '</div>' +
                '<div id="wfCF_stmtWrap">' + lbl('Statement day (1-31)') + inp('wfCF_stmt', 'e.g. 25', c.statementDay, 'inputmode="numeric" maxlength="2"') + '</div>' +
                '<div id="wfCF_dueWrap">' + lbl('Payment due day (1-31)') + inp('wfCF_due', 'e.g. 15', c.dueDay, 'inputmode="numeric" maxlength="2"') + '</div>' +
              '</div>' +
              '<div style="display:flex;gap:10px;margin-top:14px;">' +
                '<button id="wfCF_save" style="flex:1;background:linear-gradient(135deg,#d4af37,#caa233);color:#1a1205;border:none;border-radius:9px;padding:12px;font-weight:800;font-size:14px;cursor:pointer;">' + (editKey ? 'Save changes' : 'Save card') + '</button>' +
                '<button id="wfCF_cancel" style="background:transparent;border:1px solid var(--border2,#2a3450);color:#8b95a8;border-radius:9px;padding:12px 18px;font-weight:700;font-size:14px;cursor:pointer;">Cancel</button>' +
              '</div>' +
            '</div>';

        // credit-only fields toggle
        function _syncType() {
            const isCredit = (document.getElementById('wfCF_type').value === 'credit_card');
            ['wfCF_limitWrap', 'wfCF_stmtWrap', 'wfCF_dueWrap'].forEach(id => { const el = document.getElementById(id); if (el) el.style.display = isCredit ? '' : 'none'; });
        }
        document.getElementById('wfCF_type').onchange = _syncType; _syncType();
        document.getElementById('wfCF_cancel').onclick = () => { host.style.display = 'none'; host.innerHTML = ''; };
        document.getElementById('wfCF_save').onclick = () => _save(editKey);
        // v7.47.0 — live "350,000" → "350,000.00" formatting on the credit limit,
        // reusing the app's proven money-input handler.
        try { if (window._attachMoneyHandlers) window._attachMoneyHandlers(document.getElementById('wfCF_limit'), { cents: true }); } catch (_) {}
        try { host.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch (_) {}
    }

    function _clampDay(v) { v = parseInt(String(v || '').replace(/\D/g, ''), 10); if (!v || v < 1) return ''; return Math.min(31, v); }

    function _save(editKey) {
        const last4 = editKey || (document.getElementById('wfCF_last4').value || '').replace(/\D/g, '').slice(0, 4);
        if (!/^\d{4}$/.test(last4)) { _notify('Enter the last 4 digits.', 'warn'); return; }
        const type = document.getElementById('wfCF_type').value;
        if (type !== 'credit_card' && type !== 'bank_account') { _notify('Choose a type so charges route correctly.', 'warn'); return; }
        const fields = {
            bank: document.getElementById('wfCF_bank').value || 'Other',
            name: (document.getElementById('wfCF_name').value || '').trim(),
            type: type,
            network: document.getElementById('wfCF_net').value || ''
        };
        if (type === 'credit_card') {
            fields.creditLimit = _num((document.getElementById('wfCF_limit').value || '').replace(/[^\d.]/g, ''));
            fields.statementDay = _clampDay(document.getElementById('wfCF_stmt').value);
            fields.dueDay = _clampDay(document.getElementById('wfCF_due').value);
        }
        try {
            if (window.wfCardRegistry && window.wfCardRegistry.upsert) window.wfCardRegistry.upsert(last4, fields);
        } catch (e) { _notify('Could not save the card.', 'error'); return; }
        const host = document.getElementById('wfCardRegForm'); if (host) { host.style.display = 'none'; host.innerHTML = ''; }
        render();
        _notify('Saved — WealthFlow will now route •••' + last4 + ' correctly and track its balance.', 'success');
        try { if (window.wfIntelPanel && window.wfIntelPanel.refresh) window.wfIntelPanel.refresh(); } catch (_) {}
    }

    function _del(k, card) {
        const label = (card && (card.name || card.bank)) ? (card.name || card.bank) + ' •••' + k : '•••' + k;
        if (!window.confirm('Remove ' + label + '? Charges already filed stay; only the mapping is removed.')) return;
        try { if (window.wfCardRegistry && window.wfCardRegistry.delete) window.wfCardRegistry.delete(k); } catch (_) {}
        render();
        _notify('Card mapping removed.', 'info');
    }

    /* ---------- exports ---------- */
    W.wfOpenCardRegistry = open;
    // expose pure helpers for tests / other modules
    W.wfCardIntel = { cardSummary: cardSummary, nextDayOfMonth: nextDayOfMonth };
    if (typeof module !== 'undefined' && module.exports) module.exports = { cardSummary: cardSummary, nextDayOfMonth: nextDayOfMonth };
    try { if (W.console) W.console.log('[wfCardRegistry UI] Cards & Accounts v2.0 loaded'); } catch (_) {}
})();
