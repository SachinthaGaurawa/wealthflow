/* =============================================================================
   WealthFlow Intelligence Settings Panel v1.0
   ---------------------------------------------------------------------------
   Surfaces the v7.11 intelligence layer inside Settings as a proper framed
   card (matching the other settings-sections), so the user can SEE and CONTROL
   what the AI is doing:

     • 🧠 Learned merchants  — how many shop→category mappings the AI remembers
                               (+ a "Forget all" reset)
     • 🛟 Needs-review queue  — count + one-tap "Review now"
     • 🛡 Duplicate scanner   — "Scan now" → shows clusters → one-tap clean
     • 🔒 Encryption status   — confirms AES-256-GCM is active for AI data
     • ⚡ Background engine    — live status; "Process pending now"

   This module is self-contained: it injects its card into the Settings page
   right after the existing AI-Intelligence mount and keeps the numbers live.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_INTEL_PANEL_LOADED) return;
    window.WF_INTEL_PANEL_LOADED = '1.0';

    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }

    const CARD_HTML = `
      <div class="settings-section" id="wfIntelPanel" style="background:linear-gradient(145deg,rgba(16,185,129,0.05),var(--card));border:1px solid var(--border2);">
        <div class="settings-title" style="color:#10b981;">🤖 Autonomous AI Engine</div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">🧠 Learned Merchants</div><div class="setting-desc">Shops &amp; services the AI remembers the category for — it gets faster and smarter every time you confirm one.</div></div>
          <div style="text-align:right;"><div id="wfIntelMemCount" style="font-weight:900;font-size:18px;color:#10b981;">—</div><button class="btn btn-ghost btn-sm" id="wfIntelForget" style="margin-top:4px;">Reset</button></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">🛟 Needs-Review</div><div class="setting-desc">Transactions the AI wasn't sure about and parked for your one-tap decision (remembered across sessions).</div></div>
          <div style="text-align:right;"><div id="wfIntelReviewCount" style="font-weight:900;font-size:18px;color:#f59e0b;">—</div><button class="btn btn-secondary btn-sm" id="wfIntelReview" style="margin-top:4px;">Review</button></div>
        </div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">🛡 Duplicate Scanner</div><div class="setting-desc">Finds the same transaction filed twice (statement + SMS, or a re-paste) using amount + day + merchant + card. Never removes on a weak match.</div></div>
          <button class="btn btn-secondary btn-sm" id="wfIntelDedup">Scan now</button>
        </div>
        <div id="wfIntelDedupResult" style="display:none;margin:4px 0 8px;padding:11px;background:var(--bg2);border:1px solid var(--border);border-radius:10px;font-size:12.5px;"></div>
        <div class="setting-row">
          <div class="setting-info"><div class="setting-label">⚡ Background Processing</div><div class="setting-desc">Hand the AI a paste or screenshot and walk away — it files everything on its own with a live progress bar.</div></div>
          <div style="text-align:right;"><div id="wfIntelQueueState" style="font-weight:800;font-size:13px;color:var(--text2);">Idle</div><button class="btn btn-ghost btn-sm" id="wfIntelQueueRun" style="margin-top:4px;">Run pending</button></div>
        </div>
        <div class="setting-row" style="border-top:1px solid var(--border);margin-top:6px;padding-top:12px;">
          <div class="setting-info"><div class="setting-label">🔒 AI Data Encryption</div><div class="setting-desc">All AI memory, the review queue and the job queue are encrypted at rest (and in cloud sync).</div></div>
          <span id="wfIntelCryptoBadge" class="badge bg-g" style="padding:6px 12px;">AES-256-GCM</span>
        </div>
      </div>`;

    function _inject() {
        if (document.getElementById('wfIntelPanel')) { _refresh(); return true; }
        // Find the AI-Intelligence settings card and insert right after it
        const mount = document.getElementById('wfSmsPasteMount');
        let host = null;
        if (mount) {
            // climb to the enclosing .settings-section, insert the new card after it
            host = mount.closest('.settings-section');
        }
        if (!host) {
            // fallback: any settings-section
            const all = document.querySelectorAll('.settings-section');
            host = all && all.length ? all[0] : null;
        }
        if (!host || !host.parentNode) return false;
        const wrap = document.createElement('div');
        wrap.innerHTML = CARD_HTML.trim();
        const card = wrap.firstChild;
        host.parentNode.insertBefore(card, host.nextSibling);
        _bind();
        _refresh();
        return true;
    }

    function _bind() {
        const on = (id, fn) => { const el = document.getElementById(id); if (el) el.onclick = fn; };
        on('wfIntelForget', () => {
            if (!window.wfMemory) return;
            const doReset = async () => {
                try {
                    const map = await window.wfMemory.export();
                    for (const k of Object.keys(map || {})) { try { await window.wfMemory.forget(map[k].display || k); } catch (_) {} }
                    _notify('AI merchant memory reset.', 'success');
                } catch (_) {}
                _refresh();
            };
            // Prefer the app's styled confirm box; fall back to native confirm.
            if (typeof window.showConfirm === 'function') {
                window.showConfirm('🧠', 'Reset learned merchants?',
                    'Your transactions stay — only the categories the AI has learned are cleared.',
                    'btn-danger', 'Reset', doReset);
            } else {
                if (confirm('Reset everything the AI has learned about your merchants? Your transactions stay; only the learned categories are cleared.')) doReset();
            }
        });
        on('wfIntelReview', () => { if (window.wfReview && window.wfReview.openModal) window.wfReview.openModal(); });
        on('wfIntelQueueRun', () => { if (window.wfQueue && window.wfQueue.start) { window.wfQueue.start(); _notify('Processing any pending items…', 'info'); } });
        on('wfIntelDedup', async () => {
            const btn = document.getElementById('wfIntelDedup');
            const out = document.getElementById('wfIntelDedupResult');
            if (!window.wfDedup) { _notify('Duplicate scanner not loaded.', 'warn'); return; }
            if (btn) { btn.disabled = true; btn.textContent = 'Scanning…'; }
            let clusters = [];
            try { clusters = window.wfDedup.scanExisting() || []; } catch (_) {}
            if (btn) { btn.disabled = false; btn.textContent = 'Scan now'; }
            if (!out) return;
            out.style.display = '';
            if (!clusters.length) {
                out.innerHTML = '<span style="color:#10b981;font-weight:700;">✓ No duplicates found.</span> Your records are clean.';
                return;
            }
            const totalDupes = clusters.reduce((n, c) => n + (c.items.length - 1), 0);
            const certain = clusters.reduce((n, c) => n + c.items.slice(1).filter(i => i.certain).length, 0);
            out.innerHTML =
                '<div style="font-weight:800;margin-bottom:8px;">Found ' + totalDupes + ' likely duplicate' + (totalDupes === 1 ? '' : 's') + ' in ' + clusters.length + ' group' + (clusters.length === 1 ? '' : 's') + '.</div>' +
                clusters.slice(0, 6).map(c => {
                    const head = c.items[0].rec;
                    const desc = head.desc || head.source || head.name || 'Transaction';
                    const amt = (Number(head.amount) || 0).toLocaleString();
                    return '<div style="padding:6px 0;border-top:1px solid var(--border);">' +
                        '<b>' + _esc(desc) + '</b> · LKR ' + amt + ' · ' + c.items.length + ' copies (' + _esc(c.module) + ')' +
                        '</div>';
                }).join('') +
                '<div style="margin-top:10px;display:flex;gap:8px;flex-wrap:wrap;">' +
                    (certain ? '<button class="btn btn-primary btn-sm" id="wfIntelCleanCertain">Remove ' + certain + ' certain duplicate' + (certain === 1 ? '' : 's') + '</button>' : '') +
                    '<span style="font-size:11.5px;color:var(--text3);align-self:center;">Only exact, high-certainty matches are removed. The earliest copy is kept.</span>' +
                '</div>';
            const cbtn = document.getElementById('wfIntelCleanCertain');
            if (cbtn) cbtn.onclick = () => {
                let removed = 0;
                try { removed = window.wfDedup.autoCleanExact(); } catch (_) {}
                _notify(removed ? '✓ Removed ' + removed + ' duplicate' + (removed === 1 ? '' : 's') + '.' : 'Nothing certain enough to remove.', removed ? 'success' : 'info');
                ['renderDash', 'renderExpenses', 'renderIncome', 'renderSubscriptions', 'renderCCOneTime', 'renderCCInstall'].forEach(fn => { try { if (typeof window[fn] === 'function') window[fn](); } catch (_) {} });
                document.getElementById('wfIntelDedup').click();
            };
        });

        // keep queue state live
        if (window.wfQueue && window.wfQueue.on) {
            window.wfQueue.on((s) => {
                const el = document.getElementById('wfIntelQueueState');
                if (!el) return;
                if (s.active || s.pending || s.processing) el.textContent = (s.done) + '/' + s.total + ' • working';
                else if (s.total) el.textContent = '✓ done';
                else el.textContent = 'Idle';
            });
        }
    }

    async function _refresh() {
        try {
            if (window.wfMemory) {
                const st = await window.wfMemory.stats();
                const el = document.getElementById('wfIntelMemCount');
                if (el) el.textContent = (st && st.merchants != null) ? st.merchants : '0';
            }
        } catch (_) {}
        try {
            if (window.wfReview) {
                const n = await window.wfReview.count();
                const el = document.getElementById('wfIntelReviewCount');
                if (el) el.textContent = n;
            }
        } catch (_) {}
        try {
            const badge = document.getElementById('wfIntelCryptoBadge');
            if (badge && window.wfCrypto) {
                const ok = window.wfCrypto.isAvailable ? window.wfCrypto.isAvailable() : true;
                badge.textContent = ok ? 'AES-256-GCM' : 'Plain (no WebCrypto)';
                badge.className = 'badge ' + (ok ? 'bg-g' : 'bg-r');
            }
        } catch (_) {}
    }

    // Inject when the settings page is shown. Try a few times since settings
    // can render lazily.
    function _tryInjectRepeatedly() {
        let tries = 0;
        const t = setInterval(() => { if (_inject() || ++tries > 30) clearInterval(t); }, 600);
    }
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => setTimeout(_tryInjectRepeatedly, 2600));
        window.addEventListener('hashchange', () => setTimeout(_inject, 250));
        // also re-inject when navigating to settings via the app's nav
        document.addEventListener('click', () => setTimeout(() => { if (!document.getElementById('wfIntelPanel')) _inject(); }, 400), true);
    }

    window.wfIntelPanel = { refresh: _refresh, inject: _inject };
    console.log('[wfIntelPanel] ✓ Intelligence settings panel loaded');
})();
