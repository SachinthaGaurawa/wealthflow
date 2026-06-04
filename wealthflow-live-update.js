/*  wealthflow-live-update.js  —  PWA instant-update delivery (PDF Phase 5)
 *
 *  THE FIX for "users never receive updates". It watches the live deployment SHA
 *  (/api/version) and, the moment a new Vercel deployment goes live, seamlessly
 *  pulls it onto the user's device:
 *      detect new SHA → registration.update() → tell the waiting SW to
 *      self.skipWaiting() → reload once onto the fresh assets.
 *
 *  Designed to COEXIST with wealthflow-update-system.js (the rich What's-New flow):
 *  this module only handles the frictionless auto-delivery of new deploys and uses
 *  its own one-shot reload guard so it can never double-reload or loop.
 *
 *  Safety: reloads at most once per detected SHA (sessionStorage), 20s minimum
 *  between reloads, and is a no-op if the page is hidden (won't reload under you).
 */
(function () {
    'use strict';
    if (window.wfLiveUpdate) return;

    var POLL_MS = 90000;              // poll /api/version every 90s
    var MIN_RELOAD_GAP_MS = 20000;    // never reload more than once per 20s
    var _bootSha = null;
    var _applying = false;

    function _ss(k, d) { try { var v = sessionStorage.getItem(k); return v === null ? d : v; } catch (_) { return d; } }
    function _ssSet(k, v) { try { sessionStorage.setItem(k, String(v)); } catch (_) {} }

    async function _liveSha() {
        try {
            var r = await fetch('/api/version', { cache: 'no-store' });
            if (!r.ok) return null;
            var j = await r.json();
            return j && j.sha ? String(j.sha) : null;
        } catch (_) { return null; }
    }

    function _reloadOnce(reason) {
        var last = parseInt(_ss('wf_live_last_reload', '0'), 10) || 0;
        if (Date.now() - last < MIN_RELOAD_GAP_MS) return;     // anti-loop gap
        _ssSet('wf_live_last_reload', Date.now());
        try { console.log('[wfLiveUpdate] applying update →', reason); } catch (_) {}
        try { location.reload(); } catch (_) {}
    }

    // ask the waiting worker to take over; reload when it does
    function _activateWaiting(reg) {
        try {
            var w = reg && (reg.waiting || (reg.installing));
            if (w) { try { w.postMessage({ type: 'SKIP_WAITING' }); } catch (_) {} }
        } catch (_) {}
    }

    async function _applyUpdate(newSha) {
        if (_applying) return; _applying = true;
        // only apply when the tab is visible, so we never reload work out from under the user
        if (document.visibilityState === 'hidden') { _applying = false; return; }
        // remember which SHA we're updating to, so we reload once for it
        if (_ss('wf_live_applied_sha', '') === newSha) { _applying = false; return; }
        _ssSet('wf_live_applied_sha', newSha);

        try {
            if ('serviceWorker' in navigator) {
                var reg = await navigator.serviceWorker.getRegistration();
                if (reg) {
                    try { await reg.update(); } catch (_) {}      // fetch the new sw.js
                    _activateWaiting(reg);
                    // if/when a new worker is waiting, activate it
                    reg.addEventListener && reg.addEventListener('updatefound', function () {
                        var nw = reg.installing;
                        if (nw) nw.addEventListener('statechange', function () {
                            if (nw.state === 'installed') _activateWaiting(reg);
                        });
                    });
                }
            }
        } catch (_) {}

        // reload onto fresh assets (index.html is no-cache; modules revalidate)
        _reloadOnce('new deploy ' + newSha);
        _applying = false;
    }

    // when the new SW takes control, reload once
    try {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('controllerchange', function () {
                if (_ss('wf_live_applied_sha', '')) _reloadOnce('controllerchange');
            });
        }
    } catch (_) {}

    async function _check() {
        var live = await _liveSha();
        if (!live) return;
        if (_bootSha === null) { _bootSha = live; return; }   // first successful read = baseline
        if (live !== _bootSha) _applyUpdate(live);
    }

    function start() {
        _check();
        setInterval(_check, POLL_MS);
        // also check when the user returns to the tab / regains focus
        document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') _check(); });
        window.addEventListener('focus', _check);
    }

    window.wfLiveUpdate = { start: start, _check: _check, _liveSha: _liveSha, _bootSha: function () { return _bootSha; } };

    if (document.readyState === 'complete') setTimeout(start, 4000);
    else window.addEventListener('load', function () { setTimeout(start, 4000); });

    try { console.log('[wfLiveUpdate] ✓ live deploy watcher armed (polls /api/version)'); } catch (_) {}
})();
