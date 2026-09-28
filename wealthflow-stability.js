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
    var K_CRASH_TOTAL = 'wf_crash_total_count';
    var HEARTBEAT_MS = 5000;             // was 10000 — halves how stale the last-known state can be
    var CRASH_LOG_CAP = 30;              // was a bare 20 baked into slice(-20); named so it reads as a choice
    var CRUMB_CAP = 15;
    var LEGACY_EPOCH = 1600000000000;    // 2020-09-13 — older than any real edit, identical on every device
    var TOMB_CAP = 250;

    function LS() { try { return W.localStorage; } catch (_) { return null; } }
    function rd(k, d) { try { var v = LS() && LS().getItem(k); return v ? JSON.parse(v) : d; } catch (_) { return d; } }
    function wr(k, v) { try { LS() && LS().setItem(k, JSON.stringify(v)); } catch (_) {} }
    function del(k) { try { LS() && LS().removeItem(k); } catch (_) {} }
    function build() { try { return W.WF_APP_VERSION || '?'; } catch (_) { return '?'; } }

    /* ── 1) CRASH DETECTION ──────────────────────────────────────────────────── */
    var _charts = [];

    /* WHAT-WAS-HAPPENING, not just what the DOM/heap looked like. A crash
     * report that says "3242 DOM nodes, 0 charts, survived 72s" leaves the
     * reader (a human, or an AI reading a pasted diagnostic) to re-derive
     * which code path was even running — which is how two real bugs today
     * each took a full source-code investigation to find, when the app
     * itself could have said "mail sync: statement 6/9 — Sampath Bank" and
     * pointed straight at the file. crumb() is deliberately cheap: a capped
     * in-memory ring buffer, persisted on the SAME write beat() already
     * does, so logging one costs nothing beyond calling beat() a bit early
     * — which also means a heavy operation naturally gets MORE frequent,
     * MORE accurate heartbeats exactly when accuracy matters most. */
    var _crumbs = [];
    function crumb(msg) {
        try {
            _crumbs.push({ t: Date.now(), m: String(msg == null ? '' : msg).slice(0, 80) });
            if (_crumbs.length > CRUMB_CAP) _crumbs.shift();
        } catch (_) {}
        try { beat(); } catch (_) {}
    }

    /* WHAT WAS OPEN, not just what leaked. The chart registry below answers
     * "how many charts are alive" for one named kind; two real crashes this
     * session (an un-released PDF-render canvas, a PDF.js document never
     * destroyed) were each invisible to that because neither is a chart.
     * A generic named counter means the NEXT resource that turns out to
     * matter costs one inc()/dec() pair at its two call sites, not a new
     * bespoke tracker. */
    var _resources = Object.create(null);
    // Beats immediately, same reasoning as crumb(): a resource opening or
    // closing is exactly the kind of moment worth an accurate snapshot,
    // and both of today's real crashes were resource-count changes.
    function resourceInc(kind) {
        try { _resources[kind] = (_resources[kind] || 0) + 1; } catch (_) {}
        try { beat(); } catch (_) {}
    }
    function resourceDec(kind) {
        try {
            if (_resources[kind]) _resources[kind] -= 1;
            if (!_resources[kind]) delete _resources[kind];
        } catch (_) {}
        try { beat(); } catch (_) {}
    }
    function resourceCounts() { return Object.assign({}, _resources); }

    function snapshot() {
        var mem = null;
        try { if (performance && performance.memory) mem = Math.round(performance.memory.usedJSHeapSize / 1048576); } catch (_) {}
        return {
            dom: (function () { try { return document.getElementsByTagName('*').length; } catch (_) { return 0; } })(),
            charts: _charts.length,
            res: resourceCounts(),
            heapMB: mem,
            page: (function () { try { return W.currentPage || (document.querySelector('.page.active') || {}).id || '?'; } catch (_) { return '?'; } })()
        };
    }

    function crashes() { var a = rd(K_CRASH, []); return Array.isArray(a) ? a : []; }
    function clearCrashes() { del(K_CRASH); }
    /* The exact lifetime count, independent of the capped detail log below.
     * "20 crash(es)" used to mean "at least 20, we stopped counting there" —
     * silently, because slice(-20) drops the count along with the records.
     * This never resets on clearCrashes(): it is meant to answer "has this
     * device always been this unstable", which clearing the detail log for
     * a fresh read should not erase. */
    function totalCrashCount() { return rd(K_CRASH_TOTAL, 0) || 0; }

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
            res: (alive.res && typeof alive.res === 'object') ? alive.res : {},
            crumbs: Array.isArray(alive.crumbs) ? alive.crumbs : [],
            heapMB: alive.heapMB == null ? null : alive.heapMB,
            aliveSec: Math.max(0, Math.round(((alive.last || alive.start) - alive.start) / 1000))
        };
        var log = crashes();
        log.push(rec);
        wr(K_CRASH, log.slice(-CRASH_LOG_CAP));
        wr(K_CRASH_TOTAL, totalCrashCount() + 1);
        try { console.warn('[WFStability] previous session ended without a clean exit — recorded as a crash', rec); } catch (_) {}
        return rec;
    }

    function beat() {
        var s = snapshot();
        var a = rd(K_ALIVE, null) || { start: Date.now(), build: build() };
        a.last = Date.now(); a.build = build();
        a.page = s.page; a.dom = s.dom; a.charts = s.charts; a.heapMB = s.heapMB;
        a.res = s.res; a.crumbs = _crumbs.slice();
        wr(K_ALIVE, a);
    }

    /* Every crash this has ever recorded reads "? page, 0 DOM nodes, 0 charts
     * alive, survived 0s" — not because those were the real numbers, but
     * because armSession() wrote exactly those placeholders and the FIRST
     * heartbeat, 10 seconds later, never got to overwrite them. A crash
     * inside that first window — which every recorded one has been — is
     * therefore invisible by construction: the one report that would say
     * WHAT was on screen and how big the DOM was when the process died is
     * the one report this always threw away. */
    var FAST_BEAT_MS = 1000;
    var FAST_BEAT_TICKS = 12;   // 12s of dense coverage, then the normal (now 5s) cadence

    function armSession() {
        wr(K_ALIVE, { start: Date.now(), last: Date.now(), build: build(), page: '?', dom: 0, charts: 0, res: {}, crumbs: [], heapMB: null });
        beat();   // real numbers from the first paint, not the boot placeholder
        var ticks = 0;
        var fast = null;
        try {
            fast = setInterval(function () {
                beat();
                ticks++;
                if (ticks >= FAST_BEAT_TICKS) {
                    clearInterval(fast);
                    try { setInterval(beat, HEARTBEAT_MS); } catch (_) {}
                }
            }, FAST_BEAT_MS);
        } catch (_) {}
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

    /* _tomb is NESTED — {collectionKey: {recordId: deleteTs}}, per
     * wealthflow-data-health.js and _wfCollectHealth() in index.html — not
     * a flat {id: ts} map. This function (and integrity() below) read it as
     * flat, so Object.keys(ad._tomb) returned the dozen-or-so COLLECTION
     * KEYS, not the actual tombstone ids. `ids.length <= cap` was therefore
     * always true and pruneTombstones() returned 0 no matter how many
     * tombstones had actually accumulated — confirmed live: a device
     * carrying 508 real tombstones still read "0 pruned" every boot,
     * because the function was comparing 13 against 250, not 508 against
     * it. Nothing here changes what counts as a tombstone; it only counts
     * the ones that actually exist. */
    function _flattenTombstones(tomb) {
        var flat = [];
        var keys = Object.keys(tomb || {});
        for (var k = 0; k < keys.length; k++) {
            var key = keys[k], entry = tomb[key];
            if (!entry || typeof entry !== 'object') continue;
            var ids = Object.keys(entry);
            for (var j = 0; j < ids.length; j++) flat.push({ key: key, id: ids[j], ts: +entry[ids[j]] || 0 });
        }
        return flat;
    }

    function pruneTombstones(cap) {
        try {
            var ad = W.appData;
            if (!ad || !ad._tomb || typeof ad._tomb !== 'object') return 0;
            cap = cap || TOMB_CAP;
            var flat = _flattenTombstones(ad._tomb);
            if (flat.length <= cap) return 0;
            // keep the NEWEST `cap` tombstones — the old ones have long since converged
            flat.sort(function (a, b) { return b.ts - a.ts; });
            var kept = flat.slice(0, cap), dropped = flat.length - kept.length;
            var rebuilt = {};
            for (var i = 0; i < kept.length; i++) {
                var f = kept[i];
                if (!rebuilt[f.key]) rebuilt[f.key] = {};
                rebuilt[f.key][f.id] = f.ts;
            }
            ad._tomb = rebuilt;
            try { W.localStorage.setItem('wf2__tomb', JSON.stringify(rebuilt)); } catch (_) {}
            try { console.warn('[WFStability] pruned ' + dropped + ' stale deletion markers (kept the newest ' + cap + ')'); } catch (_) {}
            return dropped;
        } catch (_) { return 0; }
    }

    /* The markers pruneTombstones() above would never touch even once it
     * worked: entries filed under a key that is not a record store at all
     * (a stale rename, a typo, a removed feature) can never protect a
     * deletion, so — unlike every other tombstone — removing them carries
     * no risk of resurrecting anything a device still believes is deleted.
     * Mirrors the "orphaned" measurement wealthflow-data-health.js already
     * makes; this is the one case that measurement module deliberately
     * left unwritten (it is read-only by design) and that is safe to heal
     * unconditionally rather than merely report. */
    function healOrphanTombstones() {
        try {
            var ad = W.appData;
            if (!ad || !ad._tomb || typeof ad._tomb !== 'object') return 0;
            var keys = Object.keys(ad._tomb);
            var removed = 0, changed = false;
            for (var i = 0; i < keys.length; i++) {
                var key = keys[i];
                if (RECORD_KEYS.indexOf(key) !== -1) continue;
                var entry = ad._tomb[key];
                removed += (entry && typeof entry === 'object') ? Object.keys(entry).length : 0;
                delete ad._tomb[key];
                changed = true;
            }
            if (changed) {
                try { W.localStorage.setItem('wf2__tomb', JSON.stringify(ad._tomb)); } catch (_) {}
                try { console.warn('[WFStability] removed ' + removed + ' orphaned deletion marker(s) filed under a key that holds no records'); } catch (_) {}
            }
            return removed;
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
        try { out.tombstones = _flattenTombstones((W.appData && W.appData._tomb) || {}).length; } catch (_) {}
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
            healOrphanTombstones();
        } catch (_) {}
    }
    try { setTimeout(healSoon, 2500); } catch (_) {}

    W.WFStability = {
        crashes: crashes, clearCrashes: clearCrashes, lastCrash: function () { return lastCrash; },
        totalCrashCount: totalCrashCount, crumb: crumb,
        resourceInc: resourceInc, resourceDec: resourceDec, resourceCounts: resourceCounts,
        track: track, destroyGroup: destroyGroup, destroyAll: destroyAll, chartCount: chartCount,
        healStamps: healStamps, pruneTombstones: pruneTombstones, healOrphanTombstones: healOrphanTombstones,
        integrity: integrity,
        snapshot: snapshot, legacyUt: legacyUt, LEGACY_EPOCH: LEGACY_EPOCH, VERSION: '1.1'
    };
    try { console.log('[WFStability] v1.1 loaded' + (lastCrash ? ' — PREVIOUS SESSION CRASHED (' + lastCrash.page + ', ' + lastCrash.charts + ' charts, ' + lastCrash.dom + ' DOM nodes)' : '')); } catch (_) {}
})();
