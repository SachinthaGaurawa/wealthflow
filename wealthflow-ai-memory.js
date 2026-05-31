/* =============================================================================
   WealthFlow AI Memory v1.0 — Self-Learning Merchant Intelligence
   ---------------------------------------------------------------------------
   User requirement: "if the user pastes a transaction today and pastes a
   transaction tomorrow for the same shop/restaurant, the AI should remember
   which category it belongs to. Then it's very efficient and fast."

   What this does:
     • Every time a transaction is confidently filed (or the user manually
       confirms / corrects one), we LEARN the mapping:
            normalized merchant  →  { category, module, cardLast4, count, ... }
     • Next time that merchant appears — even spelled slightly differently, or
       with a different branch suffix ("CARGILLS FOOD CITY-KULIYA KULIYAPIT"
       vs "CARGILLS FOOD CITY - NUGEGODA") — we instantly recall the learned
       category/module and BOOST confidence to near-certainty.
     • User corrections carry the most weight: if the AI guessed "Shopping" but
       the user moved it to "Food & Groceries", that correction is remembered
       and overrides the built-in DB next time.
     • The learned profile is encrypted at rest via wfCrypto (E2E).

   This is what makes the system get smarter and faster the more you use it.

   Exposes (async):
     • wfMemory.ready()
     • wfMemory.learn(merchant, {category, module, cardLast4, source, weight})
     • wfMemory.recall(merchant)        → {category, module, confidence, ...}|null
     • wfMemory.applyToBrain(brain)     → mutates+returns brain with learned boost
     • wfMemory.forget(merchant)
     • wfMemory.export()                → full learned map (for debugging/UI)
     • wfMemory.stats()                 → {merchants, totalObservations}
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_MEMORY_LOADED) return;
    window.WF_MEMORY_LOADED = '1.0';

    const STORE_KEY = 'ai_memory_v1';
    let _map = null;            // { normKey: entry }
    let _loaded = false;
    let _saveTimer = null;
    let _readyResolve;
    const _ready = new Promise(r => { _readyResolve = r; });

    // ── merchant-name normalization ─────────────────────────────────────────---
    // Strips branch/location suffixes, card masks, punctuation, so all branches
    // of the same merchant collapse to one learning key.
    function normalize(name) {
        let s = String(name || '').toLowerCase();
        // strip everything after a dash/at/comma that usually denotes a branch
        s = s.split(/[-–—@,/|]/)[0];
        // remove common bank-noise tokens
        s = s.replace(/\b(pvt|ltd|plc|inc|llc|co|pte|the|store|supermarket|super|outlet|branch|colombo|col\d?|kandy|galle|sri lanka|lk)\b/g, ' ');
        // remove non-alphanumerics
        s = s.replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
        return s;
    }
    function keyOf(name) {
        const n = normalize(name);
        return n.replace(/\s/g, '');
    }

    // ── persistence (encrypted) ─────────────────────────────────────────────---
    async function _load() {
        if (_loaded) return _map;
        let data = null;
        if (window.wfCrypto) {
            try { data = await window.wfCrypto.secureGet(STORE_KEY); } catch (_) {}
        }
        if (!data) {
            // migrate any legacy plaintext store
            try {
                const legacy = localStorage.getItem('wf_' + STORE_KEY);
                if (legacy) data = JSON.parse(legacy);
            } catch (_) {}
        }
        _map = (data && typeof data === 'object') ? data : {};
        _loaded = true;
        _readyResolve(true);
        return _map;
    }
    function _scheduleSave() {
        if (_saveTimer) clearTimeout(_saveTimer);
        _saveTimer = setTimeout(_save, 600);
    }
    async function _save() {
        if (!_map) return;
        if (window.wfCrypto) {
            try { await window.wfCrypto.secureSet(STORE_KEY, _map); return; } catch (_) {}
        }
        try { localStorage.setItem('wf_' + STORE_KEY, JSON.stringify(_map)); } catch (_) {}
    }

    function ready() { return _ready.then(() => true); }

    // ── learn ───────────────────────────────────────────────────────────────---
    async function learn(merchant, info) {
        await _load();
        const k = keyOf(merchant);
        if (!k || k.length < 2) return null;
        info = info || {};
        const now = Date.now();
        const weight = Number(info.weight) || (info.source === 'user' ? 5 : info.source === 'confirm' ? 3 : 1);

        let e = _map[k];
        if (!e) {
            e = {
                display: String(merchant || '').trim().slice(0, 60),
                category: info.category || 'Other',
                module: info.module || 'expenses',
                cardLast4: info.cardLast4 || null,
                count: 0,
                userConfirmed: false,
                firstSeen: now,
                lastSeen: now,
                // tallies let competing categories vote
                catVotes: {},
                modVotes: {}
            };
        }
        // vote tallies
        if (info.category) e.catVotes[info.category] = (e.catVotes[info.category] || 0) + weight;
        if (info.module) e.modVotes[info.module] = (e.modVotes[info.module] || 0) + weight;
        // user corrections are authoritative
        if (info.source === 'user') {
            e.userConfirmed = true;
            if (info.category) e.category = info.category;
            if (info.module) e.module = info.module;
        } else {
            // pick the current winner from votes (unless user already locked it)
            if (!e.userConfirmed) {
                e.category = _argmax(e.catVotes) || e.category;
                e.module = _argmax(e.modVotes) || e.module;
            }
        }
        if (info.cardLast4) e.cardLast4 = info.cardLast4;
        e.count += weight;
        e.lastSeen = now;
        if (merchant && (!e.display || e.display.length < 3)) e.display = String(merchant).trim().slice(0, 60);

        _map[k] = e;
        _scheduleSave();
        return e;
    }

    function _argmax(votes) {
        let best = null, bestN = -1;
        for (const k in votes) if (votes[k] > bestN) { bestN = votes[k]; best = k; }
        return best;
    }

    // ── recall ──────────────────────────────────────────────────────────────---
    async function recall(merchant) {
        await _load();
        const k = keyOf(merchant);
        if (!k) return null;
        let e = _map[k];
        // try a fuzzy prefix match if exact key misses (handles typos / extra tokens)
        if (!e) {
            const norm = normalize(merchant);
            for (const mk in _map) {
                const cand = _map[mk];
                const cn = normalize(cand.display);
                if (!cn) continue;
                if (norm.indexOf(cn) === 0 || cn.indexOf(norm) === 0) {
                    if (Math.abs(cn.length - norm.length) <= 4) { e = cand; break; }
                }
            }
        }
        if (!e) return null;
        // Confidence scales with observation count + user confirmation.
        let confidence = e.userConfirmed ? 0.99 : Math.min(0.98, 0.80 + 0.03 * Math.min(e.count, 6));
        return {
            category: e.category,
            module: e.module,
            cardLast4: e.cardLast4,
            confidence,
            count: e.count,
            userConfirmed: e.userConfirmed,
            display: e.display
        };
    }

    // ── applyToBrain ──────────────────────────────────────────────────────────
    // Boost or override the brain's classification using learned memory.
    async function applyToBrain(brain) {
        try {
            if (!brain || !brain.ok) return brain;
            const m = brain.resolved_merchant || {};
            const name = m.name || (brain.parsed && brain.parsed.raw_merchant) || '';
            if (!name) return brain;
            const r = await recall(name);
            if (!r) return brain;

            // Only override category/module when memory is at least as confident
            // as the brain's own resolution (or the user explicitly confirmed it).
            const brainConf = (m.confidence != null ? m.confidence : 1);
            if (r.userConfirmed || r.confidence >= brainConf) {
                if (brain.resolved_merchant) {
                    brain.resolved_merchant.category = r.category;
                    brain.resolved_merchant.confidence = Math.max(brainConf, r.confidence);
                    brain.resolved_merchant.learned = true;
                }
                if (brain.routed) {
                    // keep income/cc routing from the parser if it's structural,
                    // but apply learned module when the learned one is user-set.
                    if (r.userConfirmed && r.module) brain.routed.module = r.module;
                    const f = brain.routed.suggested_fields || (brain.routed.suggested_fields = {});
                    if ('cat' in f || true) f.cat = r.category;
                    if ('category' in f || true) f.category = r.category;
                    brain.routed.confidence = Math.max(brain.routed.confidence || 0, r.confidence);
                    brain.routed.learned = true;
                }
                brain._memory = { matched: true, confidence: r.confidence, userConfirmed: r.userConfirmed, count: r.count };
            }
        } catch (e) {
            console.warn('[wfMemory] applyToBrain error:', e && e.message);
        }
        return brain;
    }

    async function forget(merchant) {
        await _load();
        const k = keyOf(merchant);
        if (_map[k]) { delete _map[k]; _scheduleSave(); return true; }
        return false;
    }

    async function exportMap() { await _load(); return JSON.parse(JSON.stringify(_map)); }
    async function stats() {
        await _load();
        let obs = 0; const keys = Object.keys(_map);
        for (const k of keys) obs += _map[k].count || 0;
        return { merchants: keys.length, totalObservations: obs };
    }

    window.wfMemory = { ready, learn, recall, applyToBrain, forget, export: exportMap, stats, normalize, keyOf };

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => { setTimeout(_load, 300); });
    } else { _load(); }

    console.log('[wfMemory] ✓ Self-learning merchant intelligence ready');
})();
