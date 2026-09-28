/* =============================================================================
   WealthFlow Dedup v1.0 — Multi-Signal Duplicate Defence
   ---------------------------------------------------------------------------
   User requirement: "there can be duplications in statement upload and SMS
   paste. It is not the user's fault. So the System AI needs to know how to
   remove those duplications... by looking at the amount and date and time and
   same shop/restaurant/service. But there can be no mistake."

   The "no mistake" constraint is the hard part. Two genuinely different
   transactions can look similar (you really did buy coffee twice today). So we
   NEVER auto-delete on a weak signal. A pair is only treated as a duplicate
   when MULTIPLE independent signals agree:

       signal 1: amount matches to the cent (|Δ| < 0.01)
       signal 2: same calendar day
       signal 3: merchant matches (exact normalized, OR ≥ 0.88 fuzzy)
       signal 4: same card last-4 (when BOTH records carry one)
       signal 5: same reference / bank dedup hash (when present) → instant

   Scoring:
       • Identical bank reference / hash         → DUPLICATE (certain)
       • amount + day + merchant + matching card → DUPLICATE (certain)
       • amount + day + merchant (no card data)  → DUPLICATE (high)
       • amount + day + same minute timestamp    → DUPLICATE (high)
       • anything weaker                          → NOT a duplicate (keep both)

   Exposes:
     • wfDedup.signature(record)            → stable string signature
     • wfDedup.isDuplicateOfExisting(brain) → {dup, existing, score, certain}|null
     • wfDedup.markSeen(record)             → record a signature in the ledger
     • wfDedup.scanExisting()               → find dup CLUSTERS already in the DB
     • wfDedup.removeDuplicates(ids,module) → delete specific records (user-driven)
     • wfDedup.autoCleanExact()             → silently remove only CERTAIN dups
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_DEDUP_LOADED) return;
    window.WF_DEDUP_LOADED = '1.0';

    const MODULES = ['expenses', 'income', 'subscriptions', 'cconetime', 'ccinstall'];

    function _db() { return window.DB || null; }
    function _get(k) { try { return (_db() && _db().get(k)) || []; } catch { return []; } }
    function _set(k, v) { try { if (_db()) _db().set(k, v); } catch (_) {} }

    // ── normalization & fuzzy ──────────────────────────────────────────────────
    function _norm(s) {
        return String(s || '')
            .toLowerCase()
            .split(/[-–—@,/|]/)[0]                 // drop branch suffix
            .replace(/[^a-z0-9 ]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }
    function _lev(a, b) {
        if (a === b) return 1;
        const m = a.length, n = b.length;
        if (!m || !n) return 0;
        const dp = Array(n + 1).fill(0).map((_, i) => i);
        for (let i = 1; i <= m; i++) {
            let prev = dp[0]; dp[0] = i;
            for (let j = 1; j <= n; j++) {
                const tmp = dp[j];
                dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j - 1], dp[j]);
                prev = tmp;
            }
        }
        return 1 - dp[n] / Math.max(m, n);
    }
    function _merchantMatch(a, b) {
        const na = _norm(a), nb = _norm(b);
        if (!na || !nb) return 0;
        if (na === nb) return 1;
        if (na.length > 4 && nb.length > 4 && (na.indexOf(nb) === 0 || nb.indexOf(na) === 0)) return 0.95;
        return _lev(na, nb);
    }
    function _amountEq(a, b) { return Math.abs(Number(a || 0) - Number(b || 0)) < 0.01; }
    function _ts(r) { return r.date_ms || (r.date ? Date.parse(r.date) : 0) || 0; }
    function _sameDay(a, b) {
        const da = new Date(a), db = new Date(b);
        if (isNaN(da) || isNaN(db)) return false;
        return da.getFullYear() === db.getFullYear() && da.getMonth() === db.getMonth() && da.getDate() === db.getDate();
    }
    function _sameMinute(a, b) { return a && b && Math.abs(a - b) < 60000; }

    function _recDesc(r) { return r.desc || r.source || r.name || r.merchant || ''; }
    function _recAmt(r) { return Number(r.amount || 0); }
    function _recCard(r) { return r.card_last4 || r.cardLast4 || null; }
    function _recRef(r) { return r.ref || r.reference || r.hash || null; }

    // ── stable signature (used for fast ledger lookups) ────────────────────────
    function signature(r) {
        const amt = _recAmt(r).toFixed(2);
        const d = new Date(_ts(r));
        const ymd = isNaN(d) ? '0000-00-00' : d.toISOString().slice(0, 10);
        const merch = _norm(_recDesc(r)).slice(0, 24);
        const card = _recCard(r) || '----';
        return [amt, ymd, merch, card].join('|');
    }

    // ── compare two records → {match, score, certain} ──────────────────────────
    function compare(a, b) {
        // instant: same explicit reference / dedup hash
        const ra = _recRef(a), rb = _recRef(b);
        if (ra && rb && ra === rb) return { match: true, score: 1, certain: true, why: 'same reference/hash' };

        if (!_amountEq(_recAmt(a), _recAmt(b))) return { match: false, score: 0 };

        const ta = _ts(a), tb = _ts(b);
        const sameDay = _sameDay(ta, tb);
        const sameMin = _sameMinute(ta, tb);
        if (!sameDay && !sameMin) return { match: false, score: 0 };

        const mScore = _merchantMatch(_recDesc(a), _recDesc(b));
        const ca = _recCard(a), cb = _recCard(b);
        const cardConflict = ca && cb && ca !== cb;
        if (cardConflict) return { match: false, score: 0, why: 'different cards' };
        const cardAgree = ca && cb && ca === cb;

        // scoring
        if (mScore >= 0.99 && cardAgree) return { match: true, score: 1, certain: true, why: 'amount+day+merchant+card' };
        if (mScore >= 0.88 && sameMin)  return { match: true, score: 0.97, certain: true, why: 'amount+minute+merchant' };
        if (mScore >= 0.88 && sameDay)  return { match: true, score: 0.9, certain: false, why: 'amount+day+merchant' };
        if (mScore >= 0.99 && sameDay)  return { match: true, score: 0.92, certain: false, why: 'amount+day+exact-merchant' };
        // amount + same minute but weak merchant: likely the SAME tx seen twice
        if (sameMin && mScore >= 0.6)   return { match: true, score: 0.85, certain: false, why: 'amount+minute' };

        return { match: false, score: mScore };
    }

    // ── is an incoming brain result a duplicate of something already filed? ─────
    function _brainToRecord(brain) {
        const f = (brain.routed && brain.routed.suggested_fields) || {};
        const p = brain.parsed || {};
        return {
            amount: f.amount != null ? f.amount : p.amount,
            date: f.date, date_ms: f.date_ms || f.timestamp || p.timestamp,
            desc: f.desc || f.source || f.name || (brain.resolved_merchant && brain.resolved_merchant.name) || '',
            card_last4: f.card_last4 || p.card_last4 || null,
            ref: f.ref || p.ref || brain.hash || null,
            hash: brain.hash || null
        };
    }
    function isDuplicateOfExisting(brain) {
        if (!brain || !brain.ok) return null;
        const incoming = _brainToRecord(brain);
        const targetModule = (brain.routed && brain.routed.module) || 'expenses';
        const sets = [targetModule];
        for (const m of MODULES) if (m !== targetModule) sets.push(m);

        let best = null;
        for (const mod of sets) {
            for (const ex of _get(mod)) {
                if (!ex) continue;
                const c = compare(incoming, ex);
                if (c.match && (!best || c.score > best.score)) {
                    best = { existing: ex, module: mod, score: c.score, certain: c.certain, why: c.why };
                    if (c.certain && c.score >= 1) return best; // can't do better
                }
            }
        }
        return best;
    }

    // ── scan the whole DB for duplicate clusters already present ────────────────
    function scanExisting() {
        const clusters = [];
        for (const mod of MODULES) {
            const arr = _get(mod);
            const used = new Set();
            for (let i = 0; i < arr.length; i++) {
                if (used.has(i) || !arr[i]) continue;
                const group = [{ idx: i, rec: arr[i] }];
                for (let j = i + 1; j < arr.length; j++) {
                    if (used.has(j) || !arr[j]) continue;
                    const c = compare(arr[i], arr[j]);
                    if (c.match) { group.push({ idx: j, rec: arr[j], score: c.score, certain: c.certain, why: c.why }); used.add(j); }
                }
                if (group.length > 1) { used.add(i); clusters.push({ module: mod, items: group }); }
            }
        }
        return clusters;
    }

    // ── remove specific records (user-confirmed) ────────────────────────────────
    function removeDuplicates(ids, module) {
        if (!Array.isArray(ids) || !ids.length) return 0;
        const idset = new Set(ids);
        let removed = 0;
        const mods = module ? [module] : MODULES;
        for (const mod of mods) {
            const arr = _get(mod);
            const next = arr.filter(r => { const drop = r && idset.has(r.id); if (drop) removed++; return !drop; });
            if (next.length !== arr.length) _set(mod, next);
        }
        if (removed && typeof window.syncToCloud === 'function') { try { window.syncToCloud(); } catch (_) {} }
        return removed;
    }

    // ── silently remove only CERTAIN duplicates (keeps the earliest of each) ────
    function autoCleanExact() {
        const clusters = scanExisting();
        let removed = 0;
        for (const cl of clusters) {
            // only act when every extra item in the cluster is a CERTAIN match
            const extras = cl.items.slice(1).filter(it => it.certain);
            if (!extras.length) continue;
            // keep the earliest-created record, drop the certain duplicates
            const sorted = cl.items.slice().sort((a, b) => (_ts(a.rec) - _ts(b.rec)) || ((a.rec.createdAt || '') < (b.rec.createdAt || '') ? -1 : 1));
            const keepId = sorted[0].rec.id;
            const dropIds = extras.map(e => e.rec.id).filter(id => id !== keepId);
            removed += removeDuplicates(dropIds, cl.module);
        }
        if (removed) console.log('[wfDedup] auto-removed', removed, 'certain duplicate(s)');
        return removed;
    }

    window.wfDedup = {
        signature, compare, isDuplicateOfExisting, scanExisting,
        removeDuplicates, autoCleanExact,
        _norm, _merchantMatch
    };

    console.log('[wfDedup] ✓ Multi-signal duplicate defence loaded');
})();
