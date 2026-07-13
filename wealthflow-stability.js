/* =============================================================================
 *  WealthFlow — Stability & Integrity  v1.0   ·   window.WFStability
 *
 *  WHY THIS EXISTS
 *    Your diagnostics said "totalErrors: 0" while you were living through repeated
 *    crashes. Both were true. An iOS renderer crash kills the process — no JS error
 *    handler ever runs, so the app reloads and the crash leaves no trace at all.
 *
 *    1. CRASH DETECTION. We mark a session "alive" and clear it on a clean exit
 *       (pagehide fires on iOS for backgrounding AND closing). If the next boot
 *       still finds that mark, the process died WITHOUT a clean exit — a crash.
 *       We then record exactly what it looked like: page, DOM size, charts alive,
 *       heap, and how long the session survived. Invisible becomes measurable.
 *
 *    2. THE CHART LEAK. Every AI answer containing a chart called `new Chart(...)`
 *       and THREW THE INSTANCE AWAY. Chart.js holds a canvas, a GPU texture and
 *       event listeners. Ask the AI for ten charts and you leak ten of them. On
 *       iOS that is exactly how a renderer dies. Every chart is now tracked and
 *       destroyed before the next render.
 *
 *    3. THE MISSING _ut STAMPS. 40 of your 111 records (all 14 income, all 7
 *       subscriptions, all targets) carry no update stamp, because they predate the
 *       CRDT engine and have no createdAt to fall back on. _utOf() returns 0 for
 *       them — and the merge rule is "a tombstone with deleteTs >= record._ut
 *       removes the record". Every tombstone's deleteTs is > 0. You have 403 of them.
 *       Those records are one id-collision away from silent deletion. We backfill a
 *       DETERMINISTIC stamp (identical on every device, so healing cannot itself
 *       cause a conflict), and prune the tombstone pile.
 * ============================================================================= */
(function () {
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_STABILITY === '1.0') return;
    W.WF_STABILITY = '1.0';

    var K_ALIVE = 'wf_session_alive';
    var K_CRASH = 'wf_crash_log';
    var HEARTBEAT_MS = 10000;
    var LEGACY_EPOCH = 1600000000000;    // 2020-09-13 — older than any real edit, identical on every device
    var TOMB_CAP = 250;

    function LS() { try { return W.localStorage; } catch (_) { return null; } }
    function rd(k, d) { try { var v = LS() && LS().getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
    function wr(k, v) { try { LS() && LS().setItem(k, JSON.stringify(v)); } catch (_) {} }
    function del(k) { try { LS() && LS().removeItem(k); } catch (_) {} }
    function build() { try { return W.WF_APP_VERSION || '?'; } catch (_) { return '?'; } }

    /* ── 1) CRASH DETECTION ──────────────────────────────────────────────────── */
    var _charts = [];

    function snapshot() {
        var mem = null;
        try { if (performance && performance.memory) mem = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
        return {
            dom: (function () { try { return document.getElementsByTagName('*').length; } catch (_) { return 0; } })(),
            charts: _charts.length,
            heapMB: mem,
            page: (function () { try { return W.currentPage || (document.querySelector('.page.active') || {}).id || '?'; } catch (_) { return '?'; } })()
        };
    }

    function crashes() { var a = rd(K_CRASH, []); return Array.isArray(a) ? a : []; }
    function clearCrashes() { del(K_CRASH); }

    function detectPreviousCrash() {
        var alive = rd(K_ALIVE, null);
        if (!alive || typeof alive !== 'object' || !alive.start) return null;
        // The last session never reached pagehide -> the process was killed mid-flight.
        var rec = {
            when: new Date(alive.last || alive.start).toISOString(),
            build: alive.build || '?',
            page: alive.page || '?',
            dom: alive.dom || 0,
            charts: alive.charts || 0,
            heapMB: alive.heapMB == null ? null : alive.heapMB,
            aliveSec: Math.max(0, Math.round(((alive.last || alive.start) - alive.start) / 1000))
        };
        var log = crashes();
        log.push(rec);
        wr(K_CRASH, log.slice(-20));
        try { console.warn('[WFStability] previous session ended without a clean exit — recorded as a crash', rec); } catch (_) {}
        return rec;
    }

    function beat() {
        var s = snapshot();
        var a = rd(K_ALIVE, null) || { start: Date.now(), build: build() };
        a.last = Date.now(); a.build = build();
        a.page = s.page; a.dom = s.dom; a.charts = s.charts; a.heapMB = s.heapMB;
        wr(K_ALIVE, a);
    }

    function armSession() {
        wr(K_ALIVE, { start: Date.now(), last: Date.now(), build: build(), page: '?', dom: 0, charts: 0, heapMB: null });
        try { setInterval(beat, HEARTBEAT_MS); } catch (_) {}
        // pagehide is THE reliable "clean exit" signal on iOS (beforeunload is not).
        var clean = function () { del(K_ALIVE); };
        try { W.addEventListener('pagehide', clean); } catch (_) {}
        try { W.addEventListener('beforeunload', clean); } catch (_) {}
        try {
            document.addEventListener('visibilitychange', function () {
                if (document.visibilityState === 'hidden') clean(); else beat();
            });
        } catch (_) {}
    }

    /* ── 2) THE CHART REGISTRY — nothing leaks again ─────────────────────────── */
    function track(chart, group) {
        if (!chart || typeof chart.destroy !== 'function') return chart;
        _charts.push({ c: chart, g: group || 'default' });
        return chart;
    }
    function destroyGroup(group) {
        var kept = [], n = 0;
        _charts.forEach(function (e) {
            if (group && e.g !== group) { kept.push(e); return; }
            try { e.c.destroy(); n++; } catch (_) {}
        });
        _charts = kept;
        return n;
    }
    function destroyAll() { return destroyGroup(null); }
    function chartCount() { return _charts.length; }

    /* ── 3) DATA INTEGRITY ───────────────────────────────────────────────────── */
    var RECORD_KEYS = ['income', 'incomeRecv', 'loans', 'ccinstall', 'cconetime', 'ccPayments', 'cheques', 'expenses', 'targets', 'subscriptions', 'importBatches', 'cribReports', 'sessions'];

    // Deterministic: every device computes the SAME stamp for the same record, so the
    // heal itself can never create a merge conflict. Real edits (Date.now()) always win.
    function legacyUt(r) {
        var t = Date.parse(r && (r.createdAt || r.date || r.at || r.addedAt) || '');
        if (isFinite(t) && t > 0) return t;
        if (r && typeof r.paidAt === 'number' && r.paidAt > 0) return r.paidAt;
        return LEGACY_EPOCH;
    }

    function healStamps() {
        var DB = W.DB;
        if (!DB || typeof DB.get !== 'function' || typeof DB.set !== 'function') return { healed: 0, keys: [] };
        var healed = 0, touched = [];
        RECORD_KEYS.forEach(function (k) {
            var a;
            try { a = DB.get(k); } catch (_) { return; }
            if (!Array.isArray(a) || !a.length) return;
            var n = 0;
            a.forEach(function (r) {
                if (r && typeof r === 'object' && typeof r._ut !== 'number') { r._ut = legacyUt(r); n++; }
            });
            if (n) {
                healed += n; touched.push(k + ':' + n);
                // _recSig ignores _ut, so the content signature is unchanged: DB.set will
                // preserve our stamp and will NOT tombstone anything.
                try { DB.set(k, a); } catch (_) {}
            }
        });
        if (healed) { try { console.warn('[WFStability] backfilled ' + healed + ' missing update stamps → ' + touched.join(', ')); } catch (_) {} }
        return { healed: healed, keys: touched };
    }

    function pruneTombstones(cap) {
        try {
            var ad = W.appData;
            if (!ad || !ad._tomb || typeof ad._tomb !== 'object') return 0;
            var ids = Object.keys(ad._tomb);
            cap = cap || TOMB_CAP;
            if (ids.length <= cap) return 0;
            // keep the NEWEST `cap` tombstones — the old ones have long since converged
            ids.sort(function (a, b) { return (+ad._tomb[b] || 0) - (+ad._tomb[a] || 0); });
            var drop = ids.slice(cap), t = {};
            ids.slice(0, cap).forEach(function (i) { t[i] = ad._tomb[i]; });
            ad._tomb = t;
            try { W.localStorage.setItem('wf2__tomb', JSON.stringify(t)); } catch (_) {}
            try { console.warn('[WFStability] pruned ' + drop.length + ' stale deletion markers (kept the newest ' + cap + ')'); } catch (_) {}
            return drop.length;
        } catch (_) { return 0; }
    }

    function integrity() {
        var DB = W.DB, out = { records: 0, unstamped: 0, tombstones: 0, byKey: {} };
        if (!DB) return out;
        RECORD_KEYS.forEach(function (k) {
            var a; try { a = DB.get(k); } catch (_) { return; }
            if (!Array.isArray(a)) return;
            var bad = a.filter(function (r) { return r && typeof r._ut !== 'number'; }).length;
            out.records += a.length; out.unstamped += bad;
            if (a.length) out.byKey[k] = { n: a.length, unstamped: bad };
        });
        try { out.tombstones = Object.keys((W.appData && W.appData._tomb) || {}).length; } catch (_) {}
        return out;
    }

    /* ── boot ────────────────────────────────────────────────────────────────── */
    var lastCrash = null;
    try { lastCrash = detectPreviousCrash(); } catch (_) {}
    try { armSession(); } catch (_) {}

    // Heal AFTER the app's own data has loaded (and after any first cloud merge).
    function healSoon() {
        try {
            if (!W.DB) { setTimeout(healSoon, 800); return; }
            healStamps();
            pruneTombstones();
        } catch (_) {}
    }
    try { setTimeout(healSoon, 2500); } catch (_) {}

    W.WFStability = {
        crashes: crashes, clearCrashes: clearCrashes, lastCrash: function () { return lastCrash; },
        track: track, destroyGroup: destroyGroup, destroyAll: destroyAll, chartCount: chartCount,
        healStamps: healStamps, pruneTombstones: pruneTombstones, integrity: integrity,
        snapshot: snapshot, legacyUt: legacyUt, LEGACY_EPOCH: LEGACY_EPOCH, VERSION: '1.0'
    };
    try { console.log('[WFStability] v1.0 loaded' + (lastCrash ? ' — PREVIOUS SESSION CRASHED (' + lastCrash.page + ', ' + lastCrash.charts + ' charts, ' + lastCrash.dom + ' DOM nodes)' : '')); } catch (_) {}
})();
