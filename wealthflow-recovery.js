/*  wealthflow-recovery.js  —  Phase 0 self-heal (client side)
 *
 *  Guarantees the app can always recover from a broken state without the user
 *  having to clear data manually. Two parts:
 *
 *  1) ALWAYS-ON escape hatch:  wfRecovery.hardReset()  — purges all caches, tells
 *     the service worker to unregister (WF_HARD_RESET), and reloads from network.
 *     Safe to call anytime (manual support action, or a future monitor).
 *
 *  2) OPT-IN auto-heal (off unless the app calls wfRecovery.bootStarted()):
 *     - Call wfRecovery.bootStarted() very early in index.html boot.
 *     - Call wfRecovery.bootOk() once the app is interactive/healthy.
 *     If a boot starts but never reaches bootOk() (i.e. it crashed), that counts as
 *     a failed boot. After 3 consecutive failed boots it auto-runs hardReset() ONCE,
 *     guarded by a 60s cooldown and a hard cap of 2 auto-resets so it can NEVER loop.
 *     If the app never calls bootStarted(), auto-heal stays dormant (no false resets).
 */
(function () {
    'use strict';
    if (window.wfRecovery) return;

    var FAIL_THRESHOLD = 3, COOLDOWN_MS = 60000, MAX_AUTO_RESETS = 2;
    var _resetting = false;

    function _get(k, d) { try { var v = localStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
    function _set(k, v) { try { localStorage.setItem(k, String(v)); } catch (_) {} }
    function _num(k) { return parseInt(_get(k, '0'), 10) || 0; }

    async function hardReset(reason) {
        if (_resetting) return; _resetting = true;
        _set('wf_last_reset', Date.now());
        _set('wf_reset_count', _num('wf_reset_count') + 1);
        try { console.warn('[wfRecovery] hard reset:', reason || 'manual'); } catch (_) {}
        // 1. ask the service worker to purge caches + unregister
        try {
            if (navigator.serviceWorker && navigator.serviceWorker.controller) {
                navigator.serviceWorker.controller.postMessage({ type: 'WF_HARD_RESET' });
            }
        } catch (_) {}
        // 2. clear caches directly too (belt and suspenders)
        try { if (window.caches) { var ks = await caches.keys(); await Promise.all(ks.map(function (k) { return caches.delete(k); })); } } catch (_) {}
        // 3. reload from the network
        setTimeout(function () { try { location.reload(); } catch (_) {} }, 600);
    }

    // the app opted into auto-heal by calling this early in boot
    function bootStarted() {
        _set('wf_autoheal', '1');
        // if the previous boot started but never confirmed OK, it failed
        if (_get('wf_boot_pending', '0') === '1') {
            _set('wf_boot_fails', _num('wf_boot_fails') + 1);
        }
        _set('wf_boot_pending', '1');
        _maybeAutoReset();
    }

    function bootOk() {
        _set('wf_boot_pending', '0');
        _set('wf_boot_fails', 0);
        _set('wf_reset_count', 0); // healthy again → allow future auto-heal
    }

    function _maybeAutoReset() {
        if (_get('wf_autoheal', '0') !== '1') return;            // dormant unless opted in
        if (_num('wf_boot_fails') < FAIL_THRESHOLD) return;       // not enough failures
        if (_num('wf_reset_count') >= MAX_AUTO_RESETS) return;    // cap → never loop
        if (Date.now() - _num('wf_last_reset') < COOLDOWN_MS) return; // cooldown
        hardReset('repeated boot failures (' + _num('wf_boot_fails') + ')');
    }

    // when the SW finishes the purge, reload onto fresh code
    try {
        if (navigator.serviceWorker) {
            navigator.serviceWorker.addEventListener('message', function (e) {
                if (e && e.data && e.data.type === 'WF_RESET_DONE') { try { location.reload(); } catch (_) {} }
            });
        }
    } catch (_) {}

    window.wfRecovery = {
        hardReset: hardReset,
        bootStarted: bootStarted,
        bootOk: bootOk,
        // exposed for tests/inspection
        _state: function () { return { fails: _num('wf_boot_fails'), pending: _get('wf_boot_pending', '0'), resets: _num('wf_reset_count'), autoheal: _get('wf_autoheal', '0') }; }
    };
    try { console.log('[wfRecovery] ✓ self-heal ready (escape hatch + opt-in auto-heal)'); } catch (_) {}
})();
