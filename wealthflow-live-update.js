/* Deployment discovery must never interrupt the current session. Updates are
 * staged in the background; the explicit Software Update flow owns reloads.
 * Focus, periodic polls and unrelated service-worker activation are read-only
 * with respect to navigation. */
// ── deadline for outbound calls ──────────────────────────────────────────────
// `fetch` has no default timeout: an upstream that accepts the connection and
// then goes quiet never settles, so the caller waits forever and the UI keeps a
// spinner up with no way to recover. Defined as a guarded global so whichever of
// these scripts loads first supplies it and the rest share one implementation —
// no load-order dependency, and no eighth copy to drift.
window._wfFetchT = window._wfFetchT || function (url, init, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 15000);
    var opts = {};
    for (var k in (init || {})) opts[k] = init[k];
    opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(t); });
};

(function () {
    'use strict';
    if (window.wfLiveUpdate) return;
    var POLL_MS = 90000;
    var _bootSha = null;
    var _pendingSha = null;
    var _checking = null;
    var _started = false;

    async function _liveSha() {
        try {
            var r = await window._wfFetchT('/api/version', { cache: 'no-store' });
            if (!r.ok) return null;
            var j = await r.json();
            // The version pill describes the executing build, never a remote build.
            return j && j.sha ? String(j.sha) : null;
        } catch (_) { return null; }
    }

    function _check() {
        if (_checking) return _checking;
        _checking = (async function () {
            var live = await _liveSha();
            if (!live) return;
            if (_bootSha === null) { _bootSha = live; return; }
            if (live === _bootSha || live === _pendingSha) return;
            _pendingSha = live;
            // Registration refresh is safe even if the worker activates: this
            // watcher never listens for controllerchange or reloads the page.
            try {
                if ('serviceWorker' in navigator) {
                    var reg = await navigator.serviceWorker.getRegistration();
                    if (reg) await reg.update();
                }
            } catch (_) {}
            try {
                window.dispatchEvent(new CustomEvent('wf_deployment_available', {
                    detail: { sha: live }
                }));
            } catch (_) {}
        })().finally(function () { _checking = null; });
        return _checking;
    }

    function start() {
        if (_started) return;
        _started = true;
        _check();
        setInterval(_check, POLL_MS);
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') _check();
        });
        window.addEventListener('focus', _check);
    }

    window.wfLiveUpdate = {
        start: start, _check: _check, _liveSha: _liveSha,
        _bootSha: function () { return _bootSha; },
        pendingSha: function () { return _pendingSha; }
    };
    if (document.readyState === 'complete') setTimeout(start, 4000);
    else window.addEventListener('load', function () { setTimeout(start, 4000); }, { once: true });
})();
