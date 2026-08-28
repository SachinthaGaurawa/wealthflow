/* =============================================================================
 * pwa-updater.js — WealthFlow PWA Version Polling & Instant Invalidation Manager
 * -----------------------------------------------------------------------------
 * Ensures that when a new build is deployed to Vercel, active client sessions
 * automatically detect the new SHA, trigger Service Worker update & cache
 * invalidation via self.skipWaiting(), and seamlessly reload onto fresh code
 * without ever bricking or looping.
 * ===========================================================================*/

(function () {
    'use strict';

    if (typeof window === 'undefined') return;
    if (window.wfPwaUpdater) return;

    var POLL_INTERVAL_MS = 60000;       // Poll every 60 seconds
    var MIN_RELOAD_GAP_MS = 20000;      // Anti-loop protection: 20s min between reloads
    var _isUpdating = false;
    var _timer = null;

    function _ssGet(key, def) {
        try {
            var v = sessionStorage.getItem(key);
            return v === null ? def : v;
        } catch (_) {
            return def;
        }
    }

    function _ssSet(key, val) {
        try {
            sessionStorage.setItem(key, String(val));
        } catch (_) {}
    }

    async function _fetchVersion() {
        try {
            var url = '/api/version?_t=' + Date.now();
            var r = await fetch(url, { cache: 'no-store' });
            if (!r.ok) {
                // Fallback to /version.json
                var r2 = await fetch('/version.json?_t=' + Date.now(), { cache: 'no-store' });
                if (!r2.ok) return null;
                return await r2.json();
            }
            return await r.json();
        } catch (_) {
            return null;
        }
    }

    function _safeReload(reason) {
        var last = parseInt(_ssGet('wf_pwa_last_reload', '0'), 10) || 0;
        if (Date.now() - last < MIN_RELOAD_GAP_MS) return;
        _ssSet('wf_pwa_last_reload', Date.now());
        try {
            console.log('[PWA-Updater] Reloading onto updated build:', reason);
        } catch (_) {}
        try {
            window.location.reload();
        } catch (_) {}
    }

    function _activateWorker(reg) {
        try {
            var w = reg && (reg.waiting || reg.installing);
            if (w) {
                try {
                    w.postMessage({ type: 'SKIP_WAITING' });
                } catch (_) {}
            }
        } catch (_) {}
    }

    async function checkForUpdate() {
        if (_isUpdating) return false;
        if (document.visibilityState === 'hidden') return false; // Do not reload behind user's back

        try {
            var data = await _fetchVersion();
            if (!data) return false;

            var newSha = data.sha ? String(data.sha).trim() : null;
            var newVer = data.version ? String(data.version).trim() : null;

            // Sync visible version labels in DOM if present
            try {
                if (newVer) {
                    var t = document.getElementById('wfVerText');
                    if (t) t.textContent = 'v' + newVer;
                    var p = document.getElementById('wfVerPill');
                    if (p) p.textContent = 'v' + newVer + ' ✓';
                }
            } catch (_) {}

            var currentSha = _ssGet('wf_pwa_active_sha', '');
            if (!currentSha && newSha) {
                // First boot in this session
                _ssSet('wf_pwa_active_sha', newSha);
                return false;
            }

            if (newSha && currentSha && newSha !== currentSha) {
                console.log('[PWA-Updater] New version detected:', currentSha, '->', newSha);
                return await applyUpdate(newSha);
            }
        } catch (e) {
            console.warn('[PWA-Updater] Error checking update:', e);
        }
        return false;
    }

    async function applyUpdate(targetSha) {
        if (_isUpdating) return false;
        _isUpdating = true;

        if (targetSha) {
            _ssSet('wf_pwa_active_sha', targetSha);
        }

        try {
            if ('serviceWorker' in navigator) {
                var reg = await navigator.serviceWorker.getRegistration();
                if (reg) {
                    try {
                        await reg.update();
                    } catch (_) {}

                    _activateWorker(reg);

                    if (reg.addEventListener) {
                        reg.addEventListener('updatefound', function () {
                            var nw = reg.installing;
                            if (nw) {
                                nw.addEventListener('statechange', function () {
                                    if (nw.state === 'installed') {
                                        _activateWorker(reg);
                                    }
                                });
                            }
                        });
                    }
                }
            }
        } catch (_) {}

        // Small delay to allow the new service worker to claim clients and purge old cache
        setTimeout(function () {
            _safeReload('new-sha-' + (targetSha || 'latest'));
        }, 300);

        return true;
    }

    function init() {
        // Listen for controller changes to ensure smooth takeover
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.addEventListener('controllerchange', function () {
                console.log('[PWA-Updater] Service Worker controller changed');
            });
        }

        // Start background polling
        if (_timer) clearInterval(_timer);
        _timer = setInterval(function () {
            checkForUpdate();
        }, POLL_INTERVAL_MS);

        // Also check on tab focus/visibilitychange
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                checkForUpdate();
            }
        });
    }

    // Public API
    window.wfPwaUpdater = {
        checkNow: checkForUpdate,
        applyUpdate: applyUpdate,
        getBuildInfo: _fetchVersion,
        init: init
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
