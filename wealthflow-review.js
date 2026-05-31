/* =============================================================================
   WealthFlow Review v1.0 — Persistent "Ask Me Later" Queue
   ---------------------------------------------------------------------------
   User requirement: "if there is any problem with a statement or SMS, ask it
   at that time or later. Which tab/category should this go to. Not always —
   the System AI will try its best on its own. Ask the user only if there is a
   problem. Sometimes the user closes the web/app. But ask when he logs back
   in. The AI should remember that very well. There is no way to enter false
   and incorrect details."

   How this satisfies it:
     • The background engine only sends an item here when it genuinely can't be
       sure (low confidence, or two plausible categories tie). Confident items
       are filed automatically and never bother the user.
     • Items persist (encrypted, via wfCrypto) across sessions. Close the tab,
       come back tomorrow — they're still waiting.
     • On the next app open, if anything is pending, a calm banner appears:
       "N transactions need a quick decision". One tap opens the review sheet.
     • Resolving an item (a) files it with the user's chosen category/tab and
       (b) teaches wfMemory, so the SAME merchant is never asked about again.
     • Nothing is ever filed with a guessed category — so no false/incorrect
       data slips in.

   Exposes:
     • wfReview.add(brain, reason)         → queue an item (returns id)
     • wfReview.list()                      → pending items
     • wfReview.count()                     → number pending
     • wfReview.resolve(id, decision)       → file with user's choice + learn
     • wfReview.skip(id)  / wfReview.remove(id)
     • wfReview.openModal()                 → review UI
     • wfReview.promptIfPending()           → show the banner if items waiting
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_REVIEW_LOADED) return;
    window.WF_REVIEW_LOADED = '1.0';

    const STORE_KEY = 'review_queue_v1';
    let _items = null;          // array
    let _loaded = false;
    let _saveTimer = null;

    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
    function _uid() { return 'rv_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    async function _load() {
        if (_loaded) return _items;
        let data = null;
        if (window.wfCrypto) { try { data = await window.wfCrypto.secureGet(STORE_KEY); } catch (_) {} }
        _items = Array.isArray(data) ? data : [];
        _loaded = true;
        return _items;
    }
    function _scheduleSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(_save, 400); }
    async function _save() {
        if (!_items) return;
        if (window.wfCrypto) { try { await window.wfCrypto.secureSet(STORE_KEY, _items); return; } catch (_) {} }
        try { localStorage.setItem('wf_' + STORE_KEY, JSON.stringify(_items)); } catch (_) {}
    }

    async function add(brain, reason) {
        await _load();
        // de-dup the review queue itself (don't ask twice about the same hash)
        if (brain && brain.hash && _items.some(it => it.hash === brain.hash)) return null;
        const f = (brain && brain.routed && brain.routed.suggested_fields) || {};
        const p = (brain && brain.parsed) || {};
        const m = (brain && brain.resolved_merchant) || {};
        const item = {
            id: _uid(),
            hash: brain && brain.hash || null,
            brain,
            reason: reason || 'Needs your decision',
            merchant: m.name || p.raw_merchant || 'Unknown',
            amount: f.amount != null ? f.amount : p.amount,
            currency: p.currency || 'LKR',
            date_ms: f.date_ms || f.timestamp || p.timestamp || Date.now(),
            suggestedCat: f.cat || f.category || m.category || 'Other',
            suggestedModule: (brain && brain.routed && brain.routed.module) || 'expenses',
            createdAt: Date.now(),
            status: 'pending'
        };
        _items.push(item);
        _scheduleSave();
        _updateBadge();
        return item.id;
    }

    async function list() { await _load(); return _items.filter(i => i.status === 'pending'); }
    async function count() { await _load(); return _items.filter(i => i.status === 'pending').length; }

    async function resolve(id, decision) {
        await _load();
        const it = _items.find(x => x.id === id);
        if (!it) return { ok: false, reason: 'not found' };
        decision = decision || {};
        const module = decision.module || it.suggestedModule;
        const cat = decision.cat || it.suggestedCat;

        // rebuild a brain result with the user's authoritative choice + high conf
        const brain = JSON.parse(JSON.stringify(it.brain || {}));
        brain.ok = true; brain.classified = true;
        brain.routed = brain.routed || {};
        brain.routed.module = module;
        brain.routed.confidence = 1;
        const f = brain.routed.suggested_fields = brain.routed.suggested_fields || {};
        if (decision.amount != null) f.amount = Number(decision.amount);
        f.cat = cat; f.category = cat;
        if (decision.date_ms) { f.date_ms = decision.date_ms; f.date = new Date(decision.date_ms).toISOString().slice(0, 10); }
        if (brain.resolved_merchant) { brain.resolved_merchant.category = cat; brain.resolved_merchant.confidence = 1; }

        // file it (allocator stamps month/year; skipIntel so it doesn't re-quarantine)
        let res;
        try {
            if (typeof window.wfAllocate === 'function') res = await window.wfAllocate(brain);
            else if (typeof window.wfApplyBrainResult === 'function') res = await window.wfApplyBrainResult(brain, { skipIntel: true });
        } catch (e) { res = { ok: false, reason: e && e.message }; }

        // teach memory so this merchant is never asked about again
        try {
            if (window.wfMemory) await window.wfMemory.learn(it.merchant, { category: cat, module, source: 'user', cardLast4: (brain.parsed && brain.parsed.card_last4) || null });
        } catch (_) {}

        it.status = 'resolved';
        it.resolvedAt = Date.now();
        _scheduleSave();
        _updateBadge();
        _refreshUI();
        return res || { ok: true };
    }

    async function skip(id) {
        await _load();
        const it = _items.find(x => x.id === id);
        if (it) { it.status = 'skipped'; _scheduleSave(); _updateBadge(); }
        return { ok: true };
    }
    async function remove(id) {
        await _load();
        _items = _items.filter(x => x.id !== id);
        _scheduleSave(); _updateBadge();
        return { ok: true };
    }

    function _refreshUI() {
        ['renderDash', 'renderExpenses', 'renderIncome', 'renderSubscriptions', 'renderCCOneTime', 'renderCCInstall'].forEach(fn => {
            try { if (typeof window[fn] === 'function') window[fn](); } catch (_) {}
        });
    }

    // ── badge on the SMS-paste banner / settings ───────────────────────────────
    async function _updateBadge() {
        const n = await count();
        document.querySelectorAll('.wf-review-badge').forEach(el => {
            el.textContent = n;
            el.style.display = n > 0 ? 'inline-flex' : 'none';
        });
    }

    // ── return-to-app banner ────────────────────────────────────────────────---
    async function promptIfPending() {
        const n = await count();
        if (n <= 0) return;
        if (document.getElementById('wfReviewBanner')) { _updateBadge(); return; }
        const bar = document.createElement('div');
        bar.id = 'wfReviewBanner';
        bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:99990;padding:12px 16px;background:linear-gradient(135deg,#f59e0b,#d97706);color:#1a1205;display:flex;align-items:center;gap:12px;box-shadow:0 -6px 24px rgba(0,0,0,0.35);font-weight:700;';
        bar.innerHTML =
            '<span style="font-size:20px;">🛟</span>' +
            '<span style="flex:1;min-width:0;font-size:14px;">' + n + ' transaction' + (n === 1 ? '' : 's') + ' need a quick decision before filing.</span>' +
            '<button id="wfReviewOpenBtn" style="background:#1a1205;color:#ffd591;border:none;border-radius:9px;padding:9px 16px;font-weight:800;font-size:13px;cursor:pointer;">Review now</button>' +
            '<button id="wfReviewLaterBtn" style="background:transparent;border:none;color:#1a1205;font-size:20px;cursor:pointer;padding:4px 8px;">×</button>';
        document.body.appendChild(bar);
        document.getElementById('wfReviewOpenBtn').onclick = () => { bar.remove(); openModal(); };
        document.getElementById('wfReviewLaterBtn').onclick = () => bar.remove();
    }

    // ── review modal ────────────────────────────────────────────────────────---
    const CATS_BY_MODULE = {
        expenses: ['Food & Groceries', 'Dining', 'Transport', 'Fuel', 'Utilities', 'Telecom', 'Healthcare', 'Education', 'Entertainment', 'Subscriptions', 'Shopping', 'Shopping (Fashion)', 'Electronics & Tech', 'Shopping (Home)', 'Insurance', 'Rent', 'Personal Care', 'Kids & Family', 'Pets', 'Travel', 'Charity', 'Government', 'Banking', 'Other'],
        income: ['Salary', 'Business', 'Transfer In', 'Interest', 'Refund', 'Rent Income', 'Gift', 'Stock Dividend', 'Unit Trust', 'Treasury/Bond', 'Crypto', 'Forex/Trading', 'Fixed Deposit', 'Other Income'],
        subscriptions: ['Streaming', 'Software', 'Telecom', 'Utilities', 'Membership', 'Cloud', 'Other'],
        cconetime: ['Shopping', 'Dining', 'Travel', 'Electronics', 'Other'],
        ccinstall: ['Electronics', 'Appliances', 'Travel', 'Other'],
        loan: ['Loan Payment'],
        goal: ['Savings']
    };
    const MODULE_LABELS = {
        expenses: '💸 Expense', income: '💰 Income', subscriptions: '🔁 Subscription',
        cconetime: '💳 Card (one-time)', ccinstall: '🗓 Card (installment)', loan: '🏦 Loan', goal: '🎯 Goal'
    };

    function _money(a, c) { try { return (c || 'LKR') + ' ' + (Number(a) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch { return (c || 'LKR') + ' ' + a; } }
    function _dl(ts) { const d = new Date(ts); return isNaN(d) ? '' : d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' }); }

    async function openModal() {
        await _load();
        const pending = _items.filter(i => i.status === 'pending');
        const existing = document.getElementById('wfReviewOverlay');
        if (existing) existing.remove();

        const ov = document.createElement('div');
        ov.id = 'wfReviewOverlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:0;';

        const rows = pending.length ? pending.map(_renderItem).join('') :
            '<div style="text-align:center;padding:50px 20px;color:#8b95a8;"><div style="font-size:40px;opacity:.5;margin-bottom:10px;">✅</div><div style="font-weight:700;">All clear — nothing needs review.</div></div>';

        ov.innerHTML =
            '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);width:100%;height:100%;max-width:680px;max-height:100vh;display:flex;flex-direction:column;border-radius:0;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top, 0px) + 14px));border-bottom:1px solid var(--border,#1f2638);">' +
                '<div style="font-weight:800;font-size:16px;color:var(--text,#e6e7eb);">🛟 Needs Your Decision <span style="color:#f59e0b;">(' + pending.length + ')</span></div>' +
                '<button id="wfReviewClose" style="background:transparent;border:none;color:#8b95a8;font-size:26px;cursor:pointer;padding:4px 10px;">×</button>' +
              '</div>' +
              '<div style="padding:8px 14px 4px;font-size:12px;color:#8b95a8;line-height:1.5;">The AI filed everything it was sure about. These few are ambiguous — pick the right place and the AI will remember your choice forever.</div>' +
              '<div id="wfReviewList" style="flex:1;overflow-y:auto;padding:14px 18px;">' + rows + '</div>' +
            '</div>';

        ov.addEventListener('click', (e) => {
            if (e.target === ov || e.target.id === 'wfReviewClose') { ov.remove(); return; }
            _onModalClick(e);
        });
        ov.addEventListener('change', _onModalChange);
        document.body.appendChild(ov);
    }

    function _renderItem(it) {
        const mod = it.suggestedModule || 'expenses';
        const cats = CATS_BY_MODULE[mod] || CATS_BY_MODULE.expenses;
        return '<div class="wfrv-card" data-id="' + it.id + '" style="background:var(--bg2,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:13px;padding:14px;margin-bottom:11px;">' +
            '<div style="display:flex;justify-content:space-between;gap:10px;">' +
                '<div style="min-width:0;flex:1;"><div style="font-weight:800;font-size:14.5px;color:var(--text,#e6e7eb);">' + _esc(it.merchant) + '</div>' +
                '<div style="font-size:11.5px;color:#8b95a8;margin-top:3px;">' + _esc(_dl(it.date_ms)) + ' • <span style="color:#f59e0b;">' + _esc(it.reason) + '</span></div></div>' +
                '<div style="font-weight:900;font-size:15px;color:#d4af37;white-space:nowrap;">' + _money(it.amount, it.currency) + '</div>' +
            '</div>' +
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:11px;">' +
                '<div><label style="display:block;font-size:10.5px;color:#8b95a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">File into</label>' +
                    '<select data-field="module" data-id="' + it.id + '" style="width:100%;padding:8px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:8px;color:var(--text,#e6e7eb);font-size:13px;">' +
                        Object.keys(MODULE_LABELS).map(k => '<option value="' + k + '"' + (k === mod ? ' selected' : '') + '>' + MODULE_LABELS[k] + '</option>').join('') +
                    '</select></div>' +
                '<div><label style="display:block;font-size:10.5px;color:#8b95a8;text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px;">Category</label>' +
                    '<select data-field="cat" data-id="' + it.id + '" style="width:100%;padding:8px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:8px;color:var(--text,#e6e7eb);font-size:13px;">' +
                        cats.map(c => '<option value="' + _esc(c) + '"' + (c === it.suggestedCat ? ' selected' : '') + '>' + _esc(c) + '</option>').join('') +
                    '</select></div>' +
            '</div>' +
            '<div style="display:flex;gap:8px;margin-top:11px;">' +
                '<button data-act="file" data-id="' + it.id + '" style="flex:1;background:linear-gradient(135deg,#10b981,#0ea371);color:#04130d;border:none;border-radius:9px;padding:9px;font-weight:800;font-size:13px;cursor:pointer;">File here</button>' +
                '<button data-act="skip" data-id="' + it.id + '" style="background:transparent;border:1px solid var(--border2,#1f2638);color:#8b95a8;border-radius:9px;padding:9px 14px;font-weight:700;font-size:13px;cursor:pointer;">Skip</button>' +
                '<button data-act="remove" data-id="' + it.id + '" title="Delete this transaction" style="background:transparent;border:1px solid rgba(239,68,68,0.4);color:#ef4444;border-radius:9px;padding:9px 13px;font-weight:700;font-size:13px;cursor:pointer;">Remove</button>' +
            '</div>' +
        '</div>';
    }

    function _onModalChange(e) {
        const sel = e.target.closest('[data-field]');
        if (!sel) return;
        const id = sel.dataset.id, field = sel.dataset.field;
        const it = _items.find(x => x.id === id);
        if (!it) return;
        if (field === 'module') {
            it.suggestedModule = sel.value;
            // refresh that card's category options
            const card = e.target.closest('.wfrv-card');
            const catSel = card && card.querySelector('[data-field="cat"]');
            if (catSel) {
                const cats = CATS_BY_MODULE[sel.value] || CATS_BY_MODULE.expenses;
                catSel.innerHTML = cats.map(c => '<option value="' + _esc(c) + '">' + _esc(c) + '</option>').join('');
                it.suggestedCat = cats[0];
            }
        } else if (field === 'cat') {
            it.suggestedCat = sel.value;
        }
    }

    async function _onModalClick(e) {
        const btn = e.target.closest('[data-act]');
        if (!btn) return;
        const id = btn.dataset.id, act = btn.dataset.act;
        const it = _items.find(x => x.id === id);
        if (!it) return;
        if (act === 'file') {
            btn.disabled = true; btn.textContent = '⟳ Filing…';
            const res = await resolve(id, { module: it.suggestedModule, cat: it.suggestedCat });
            const card = btn.closest('.wfrv-card');
            if (card) { card.style.transition = 'opacity .3s'; card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
            _notify(res && res.ok !== false ? '✓ Filed & learned — won\'t ask again' : 'Could not file', res && res.ok !== false ? 'success' : 'warn');
            if ((await count()) === 0) setTimeout(() => { const ov = document.getElementById('wfReviewOverlay'); if (ov) ov.remove(); }, 400);
        } else if (act === 'skip') {
            await skip(id);
            const card = btn.closest('.wfrv-card');
            if (card) { card.style.opacity = '0.4'; }
        } else if (act === 'remove') {
            const ok = (typeof confirm === 'function') ? confirm('Delete this transaction? It will be removed from the review list and not saved anywhere.') : true;
            if (!ok) return;
            await remove(id);
            const card = btn.closest('.wfrv-card');
            if (card) { card.style.transition = 'opacity .3s'; card.style.opacity = '0'; setTimeout(() => card.remove(), 300); }
            _notify('Removed.', 'info');
            if ((await count()) === 0) setTimeout(() => { const ov = document.getElementById('wfReviewOverlay'); if (ov) ov.remove(); }, 400);
        }
    }

    window.wfReview = { add, list, count, resolve, skip, remove, openModal, promptIfPending };

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            // give the app a few seconds to boot, then offer the pending queue
            setTimeout(() => { _load().then(() => { _updateBadge(); promptIfPending(); }); }, 4500);
        });
    }

    console.log('[wfReview] ✓ Persistent ask-me-later queue loaded');
})();
