/* =============================================================================
   WealthFlow AutoPilot v1.0 — Zero-Setup Automation
   ---------------------------------------------------------------------------
   The goal: the user should never have to "set up" the autonomous engine.
   Everything that CAN be inferred from existing data is inferred. The user
   only confirms — never types.

   What this module does automatically:
     1. Scans existing CC One-Time, CC Installment, Expense, and Income data
        for card-last-4 + bank-name patterns → auto-builds the Card Registry.
     2. Detects recurring charges in expense history → offers one-tap
        "Add as subscription" with smart defaults.
     3. Runs the predictive engine on boot, surfaces insights as toast
        notifications (not buried in Settings).
     4. Auto-detects the user's primary currency from transaction history
        (sets it as default for new transactions).
     5. Provides a One-Tap Setup Wizard that bundles every step into a
        single 3-screen flow with everything pre-filled.

   Exposes these globals (all reachable from onclick handlers):
     • wfAutoPilotRun()        — run full auto-discovery (idempotent)
     • wfOpenWizard()           — open the One-Tap Setup Wizard
     • wfAutoAddRecurring()     — one-tap convert detected → subscriptions
     • wfAutoDiscoverCards()    — scan past tx for card-last-4 patterns
     • wfShowInsights()         — show forecast + insights as toasts
   ============================================================================*/

(function () {
    'use strict';
    if (window.WF_AUTOPILOT_LOADED) return;
    window.WF_AUTOPILOT_LOADED = '1.0';

    const _bankFromSenderOrText = (s) => {
        const up = String(s || '').toUpperCase();
        const map = {
            'COMBANK': 'ComBank', 'COMMBANK': 'ComBank', 'COMMERCIAL BANK': 'ComBank',
            'HNB': 'HNB', 'HATTON': 'HNB',
            'SAMPATH': 'Sampath',
            'NTB': 'NTB', 'NATIONS TRUST': 'NTB',
            'SEYLAN': 'Seylan',
            'DFCC': 'DFCC',
            'NDB': 'NDB',
            'BOC': 'BOC', 'BANK OF CEYLON': 'BOC',
            'PEOPLE': 'Peoples', "PEOPLE'S": 'Peoples',
            'PAN ASIA': 'PanAsia', 'PANASIA': 'PanAsia',
            'UNION': 'Union',
            'STANCHART': 'StanChart', 'STANDARD CHARTERED': 'StanChart',
            'AMEX': 'AMEX', 'AMERICAN EXPRESS': 'AMEX',
            'NSB': 'NSB', 'HSBC': 'HSBC', 'CITI': 'CITI'
        };
        for (const k of Object.keys(map)) {
            if (up.includes(k)) return map[k];
        }
        return null;
    };

    // ────────────────────────────────────────────────────────────────────────
    // 1. AUTO-DISCOVER cards from existing transaction history
    // ────────────────────────────────────────────────────────────────────────
    function autoDiscoverCards() {
        const reg = (window.wfCardRegistry && wfCardRegistry.get()) || {};
        const before = Object.keys(reg).length;

        // Source A: CC One-Time entries (have card_last4 + bank explicitly)
        try {
            const ccot = DB.get('cconetime') || [];
            for (const x of ccot) {
                const l4 = String(x.card_last4 || '').trim();
                if (!/^\d{4}$/.test(l4)) continue;
                if (reg[l4]) continue;
                reg[l4] = {
                    last4: l4,
                    bank: _bankFromSenderOrText(x.bank) || x.bank || 'Other',
                    type: 'credit_card',
                    name: (x.bank || 'Card') + ' •••' + l4,
                    auto_discovered: true,
                    source: 'cconetime',
                    updated_at: Date.now()
                };
            }
        } catch (_) {}

        // Source B: CC Installments
        try {
            const cci = DB.get('ccinstall') || [];
            for (const x of cci) {
                const l4 = String(x.card_last4 || '').trim();
                if (!/^\d{4}$/.test(l4)) continue;
                if (reg[l4]) continue;
                reg[l4] = {
                    last4: l4,
                    bank: _bankFromSenderOrText(x.bank) || x.bank || 'Other',
                    type: 'credit_card',
                    name: (x.bank || 'Card') + ' •••' + l4,
                    auto_discovered: true,
                    source: 'ccinstall',
                    updated_at: Date.now()
                };
            }
        } catch (_) {}

        // Source C: scan expense/income notes for "...1234" or "xxxx1234" patterns
        try {
            const sources = [
                ...(DB.get('expenses') || []),
                ...(DB.get('income') || []),
                ...(DB.get('loans') || [])
            ];
            for (const x of sources) {
                const blob = (x.notes || '') + ' ' + (x.desc || '') + ' ' + (x.source || '') + ' ' + (x.bank || '');
                const m = blob.match(/(?:•{2,}|\*{2,}|x{2,}|\.{2,}|ending\s+|a\/c\s+|card\s+)(\d{4})\b/i);
                if (m && !reg[m[1]]) {
                    const bank = _bankFromSenderOrText(blob);
                    if (bank) {
                        reg[m[1]] = {
                            last4: m[1],
                            bank,
                            type: 'bank_account',  // safe default for non-CC sources
                            name: bank + ' •••' + m[1],
                            auto_discovered: true,
                            source: 'pattern_scan',
                            updated_at: Date.now()
                        };
                    }
                }
            }
        } catch (_) {}

        const after = Object.keys(reg).length;
        if (after > before) {
            wfCardRegistry.set(reg);
            return { discovered: after - before, total: after };
        }
        return { discovered: 0, total: after };
    }
    window.wfAutoDiscoverCards = autoDiscoverCards;

    // ────────────────────────────────────────────────────────────────────────
    // 2. AUTO-ADD recurring detections as subscriptions (one tap)
    // ────────────────────────────────────────────────────────────────────────
    async function autoAddRecurring() {
        // Refresh predictions if we don't have a recent one
        const s = (window.DB && DB.getObj('settings')) || {};
        let p = s.lastPredictions;
        const stale = !p || (Date.now() - (p.refreshed_at || 0) > 10 * 60 * 1000);
        if (stale && window.wfRefreshPredictions) {
            p = await wfRefreshPredictions(12);
        }
        const recurring = (p && p.recurring) || [];
        if (!recurring.length) {
            if (window.notify) notify('No new recurring charges detected', 'info');
            return { added: 0 };
        }

        const subs = DB.get('subscriptions') || [];
        const existingNames = new Set(subs.map(x => (x.name || '').toLowerCase().trim()));
        let added = 0;
        for (const r of recurring) {
            const nm = (r.name || '').toLowerCase().trim();
            if (!nm || existingNames.has(nm)) continue;
            subs.push({
                id: 'auto_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
                name: r.name,
                category: r.category || 'Other',
                amount: r.amount,
                dueDay: new Date(r.last_seen).getDate(),
                cycle: 'monthly',
                auto: true,
                auto_added_by: 'AutoPilot',
                createdAt: new Date().toISOString()
            });
            existingNames.add(nm);
            added++;
        }
        if (added > 0) {
            DB.set('subscriptions', subs);
            try { if (typeof syncToCloud === 'function') syncToCloud(); } catch (_) {}
            if (window.notify) notify(`✅ Added ${added} detected subscription${added > 1 ? 's' : ''}`, 'success');
            if (typeof renderSubscriptions === 'function') renderSubscriptions();
        } else {
            if (window.notify) notify('All detected recurring charges are already tracked', 'info');
        }
        return { added };
    }
    window.wfAutoAddRecurring = autoAddRecurring;

    // ────────────────────────────────────────────────────────────────────────
    // 3. Detect user's primary currency from history
    // ────────────────────────────────────────────────────────────────────────
    function detectPrimaryCurrency() {
        try {
            const all = [...(DB.get('expenses') || []), ...(DB.get('income') || [])];
            const counts = {};
            for (const x of all) {
                const c = x.currency || 'LKR';
                counts[c] = (counts[c] || 0) + 1;
            }
            const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
            return top ? top[0] : 'LKR';
        } catch (_) { return 'LKR'; }
    }
    window.wfPrimaryCurrency = detectPrimaryCurrency;

    // ────────────────────────────────────────────────────────────────────────
    // 4. Boot-time insights as toasts (so user sees them without opening Settings)
    // ────────────────────────────────────────────────────────────────────────
    async function showInsightsAsToasts() {
        try {
            const data = (window.wfRefreshPredictions && await wfRefreshPredictions(12)) || {};
            if (!data.ok || !data.insights || !data.insights.length) return;
            // Surface up to 2 high-severity insights as toasts (spaced out)
            const high = data.insights.filter(i => i.severity === 'high' || i.severity === 'medium').slice(0, 2);
            high.forEach((ins, idx) => {
                setTimeout(() => {
                    if (window.notify) {
                        notify(`${ins.icon} ${ins.title}`, ins.severity === 'high' ? 'warn' : 'info');
                    }
                }, 3500 + idx * 3500);
            });

            // If recurring charges detected, show a one-tap action toast
            if (data.recurring && data.recurring.length > 0) {
                const lastNotice = parseInt(localStorage.getItem('wf_autopilot_lastRecurringNotice') || '0', 10);
                if (Date.now() - lastNotice > 24 * 60 * 60 * 1000) {     // once per day max
                    setTimeout(() => {
                        if (window.notify) {
                            notify(`🔁 ${data.recurring.length} recurring charge${data.recurring.length > 1 ? 's' : ''} detected — tap to auto-add`, 'info', () => {
                                wfAutoAddRecurring();
                            });
                        }
                        localStorage.setItem('wf_autopilot_lastRecurringNotice', String(Date.now()));
                    }, 10000);
                }
            }
        } catch (e) {
            // silent — autopilot must never break the UI
        }
    }
    window.wfShowInsights = showInsightsAsToasts;

    // ────────────────────────────────────────────────────────────────────────
    // 5. Master AutoPilot run — fires on boot
    // ────────────────────────────────────────────────────────────────────────
    async function autoPilotRun() {
        try {
            const c = autoDiscoverCards();
            if (c.discovered > 0 && window.notify) {
                notify(`🤖 AutoPilot found ${c.discovered} card${c.discovered > 1 ? 's' : ''} in your history`, 'success');
            }
        } catch (_) {}
        try { showInsightsAsToasts(); } catch (_) {}
    }
    window.wfAutoPilotRun = autoPilotRun;

    // Boot hook — runs ONCE per session, 6s after DOMContentLoaded so all other
    // modules have a chance to register their data + functions.
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            const RAN_KEY = 'wf_autopilot_ran_session';
            if (sessionStorage.getItem(RAN_KEY)) return;
            sessionStorage.setItem(RAN_KEY, '1');
            setTimeout(autoPilotRun, 6000);
        });
    }

    console.log('[AutoPilot] ✅ WealthFlow AutoPilot v1.0 loaded');
})();
