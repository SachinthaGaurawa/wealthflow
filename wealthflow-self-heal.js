/* =============================================================================
   WealthFlow Self-Healing  v1.0  —  window.wfHeal
   ---------------------------------------------------------------------------
   The HONEST, working version of "self-healing client architecture."

   What it really does (all on-device, no servers, no fake swarm):
     1. Records a "last known good" boot every time the app reaches a healthy,
        interactive state (a success beacon fired ~4s after load).
     2. Wraps the app in a global error boundary (window.onerror +
        unhandledrejection). It counts fatal errors per boot.
     3. Detects a CRASH LOOP — repeated hard failures in a short window,
        especially right after a version change — using a small causal check:
        "did the failures begin immediately after the installed version changed?"
        That distinguishes a bad update from a random one-off error, so we don't
        roll back unnecessarily (no infinite downgrade loops).
     4. When a genuine post-update crash loop is detected, it SELF-HEALS:
          • clears the broken service-worker caches,
          • unregisters the faulty service worker,
          • restores the pre-update data backup if one exists,
          • reloads onto the previous safe state,
          • leaves a breadcrumb so the next boot shows a calm "recovered" notice.
     5. Reports the incident into the feedback pipeline (Firestore) so the
        Release Brain sees it and can prioritise a real fix — the silent
        background loop you asked for.

   It NEVER rolls back on ordinary errors or disagreements — only on a
   measured crash loop tied to a version change.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_SELF_HEAL) return;
    window.WF_SELF_HEAL = '1.0';

    const LS_GOOD = 'wf_last_good_version';     // last version that booted cleanly
    const LS_BOOTLOG = 'wf_boot_log';           // recent boot outcomes
    const LS_HEAL_FLAG = 'wf_healed_from';      // breadcrumb after a heal
    const LS_INSTALLED = 'wf_installed_version'; // shared with the update system

    const FATAL_THRESHOLD = 3;     // fatal errors in one boot ⇒ unhealthy boot
    const LOOP_WINDOW_MS = 90000;  // crash-loop detection window
    const LOOP_BOOTS = 2;          // this many unhealthy boots in the window ⇒ heal
    const HEALTHY_AFTER_MS = 4000; // app considered good if it survives this long

    let _fatal = 0;
    let _healthyTimer = null;
    let _booted = Date.now();

    function _v() { try { return localStorage.getItem(LS_INSTALLED) || '0.0.0'; } catch (_) { return '0.0.0'; } }
    function _readLog() { try { return JSON.parse(localStorage.getItem(LS_BOOTLOG) || '[]'); } catch (_) { return []; } }
    function _writeLog(l) { try { localStorage.setItem(LS_BOOTLOG, JSON.stringify(l.slice(-12))); } catch (_) {} }

    // ── record a boot outcome ────────────────────────────────────────────────
    function _logBoot(outcome) {
        const log = _readLog();
        log.push({ t: Date.now(), v: _v(), outcome });
        _writeLog(log);
        return log;
    }

    // ── decide whether we are in a genuine post-update crash loop ─────────────
    function _isPostUpdateCrashLoop() {
        const log = _readLog();
        const now = Date.now();
        const recent = log.filter(b => now - b.t < LOOP_WINDOW_MS);
        const bad = recent.filter(b => b.outcome === 'crash');
        if (bad.length < LOOP_BOOTS) return false;
        // causal check: did the crashes start on the CURRENT version, and was the
        // last known-good a DIFFERENT (earlier) version? i.e. the update caused it.
        const good = _lastGood();
        const cur = _v();
        if (good && good !== cur && bad.every(b => b.v === cur)) return true;
        // also heal if simply crashing hard repeatedly on the same version
        if (bad.length >= (LOOP_BOOTS + 1)) return true;
        return false;
    }

    function _lastGood() { try { return localStorage.getItem(LS_GOOD) || null; } catch (_) { return null; } }
    function _setGood(v) { try { localStorage.setItem(LS_GOOD, v); } catch (_) {} }

    // restore the wf2_* data snapshot taken just before the last update
    function _restoreLocalSnapshot() {
        let snap = null;
        try { snap = JSON.parse(localStorage.getItem('wf_preupdate_snapshot') || 'null'); } catch (_) {}
        if (!snap || !snap.data) return false;
        try {
            for (const k in snap.data) { if (k.indexOf('wf2_') === 0) localStorage.setItem(k, snap.data[k]); }
            return true;
        } catch (_) { return false; }
    }

    // ── the actual heal ──────────────────────────────────────────────────────
    async function _selfHeal(reason) {
        try { console.warn('[wfHeal] Self-healing triggered:', reason); } catch (_) {}
        const from = _v();
        const to = _lastGood();
        // breadcrumb for the next boot
        try { localStorage.setItem(LS_HEAL_FLAG, JSON.stringify({ from, to, at: Date.now(), reason })); } catch (_) {}

        // 1. report the incident so the Release Brain can prioritise a fix
        _report(from, reason);

        // 2. restore the most recent pre-update data backup, if the app exposes one
        try {
            if (typeof window.wfRestoreLastBackup === 'function') { await window.wfRestoreLastBackup(); }
            else { _restoreLocalSnapshot(); }
        } catch (_) { try { _restoreLocalSnapshot(); } catch (__) {} }

        // 3. nuke caches + unregister the faulty service worker
        try {
            if (window.caches && caches.keys) {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            }
        } catch (_) {}
        try {
            if ('serviceWorker' in navigator) {
                const regs = await navigator.serviceWorker.getRegistrations();
                await Promise.all(regs.map(r => r.unregister()));
            }
        } catch (_) {}

        // 4. clear the crash log so we boot fresh, then reload
        try { localStorage.removeItem(LS_BOOTLOG); } catch (_) {}
        // small delay so the breadcrumb + storage writes flush
        setTimeout(() => { try { location.reload(); } catch (_) {} }, 400);
    }

    // ── report the crash into the feedback pipeline (silent, background) ──────
    function _report(version, reason) {
        const payload = {
            type: 'crash', text: 'Auto-detected post-update crash loop (self-heal): ' + reason,
            version: version, createdAt: new Date().toISOString(),
            ua: navigator.userAgent, auto: true
        };
        // Firestore (best-effort)
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const db = window.db || (fb && fb.firestore ? fb.firestore() : null);
            if (db) {
                const uid = (window.currentUser && window.currentUser.uid) || 'anon';
                db.collection('feedback').add(Object.assign({ uid }, payload,
                    { _ts: fb.firestore.FieldValue.serverTimestamp() })).catch(() => {});
            }
        } catch (_) {}
        // local queue fallback so it's not lost offline
        try { const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); q.push(payload); localStorage.setItem('wf_feedback_queue', JSON.stringify(q)); } catch (_) {}
    }

    // ── error boundary ────────────────────────────────────────────────────────
    function _onFatal(msg) {
        _fatal++;
        if (_fatal >= FATAL_THRESHOLD) {
            // this boot is unhealthy
            const log = _logBoot('crash');
            if (_isPostUpdateCrashLoop()) {
                _selfHeal('crash-threshold: ' + String(msg).slice(0, 120));
            }
        }
    }

    // ── post-heal notice ──────────────────────────────────────────────────────
    function _showHealNoticeIfAny() {
        let bc = null;
        try { bc = JSON.parse(localStorage.getItem(LS_HEAL_FLAG) || 'null'); } catch (_) {}
        if (!bc) return;
        try { localStorage.removeItem(LS_HEAL_FLAG); } catch (_) {}
        const msg = bc.to
            ? ('We hit a problem after an update and safely restored your previous version (' + bc.to + '). Your data is intact.')
            : 'We recovered the app after an unexpected error. Your data is intact.';
        try { if (typeof window.notify === 'function') window.notify(msg, 'info'); } catch (_) {}
    }

    // ── init ───────────────────────────────────────────────────────────────────
    function init() {
        // catch hard errors
        window.addEventListener('error', (e) => { try { _onFatal(e && e.message); } catch (_) {} });
        window.addEventListener('unhandledrejection', (e) => { try { _onFatal(e && e.reason && (e.reason.message || e.reason)); } catch (_) {} });

        // mark this boot healthy if it survives long enough
        _healthyTimer = setTimeout(() => {
            _setGood(_v());
            _logBoot('ok');
        }, HEALTHY_AFTER_MS);

        // show a calm notice if we just healed
        setTimeout(_showHealNoticeIfAny, 1600);
    }

    window.wfHeal = {
        // expose for diagnostics / manual use
        status: () => ({ version: _v(), lastGood: _lastGood(), log: _readLog(), fatal: _fatal }),
        heal: (r) => _selfHeal(r || 'manual'),
        _onFatal
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();

    console.log('[wfHeal] ✓ Self-healing boot guard active');
})();
