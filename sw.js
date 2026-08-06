// ==================== WealthFlow Infinity Service Worker v7.11.0 ====================
// Handles PWA push notifications, offline caching, and background sync.
//
// v7.11.0 (May 2026): Reverted the v7.9.0 Gmail-sync hooks. The app no longer
// has email-based ingestion. Instead, users paste bank SMSes manually via the
// new in-app modal (wealthflow-sms-paste.js). Service Worker stays simple:
// notifications, caching, and the original auto-backup logic.

const CACHE_NAME = 'wealthflow-v7.69.20';

// ============================================================================
//  WHY THERE IS A fetch HANDLER HERE NOW
//  --------------------------------------------------------------------------
//  For eight consecutive releases the line above was rewritten by the release
//  bot — v7.69.10, .11, .12 … .17 — and it named a cache that NOTHING wrote to
//  and NOTHING read from. There was no fetch handler at all, so the "cache" was
//  an empty room whose nameplate was repainted every night. The owner was told
//  an update had been installed; the only file that had genuinely changed on
//  disk was the name of a container that never held anything.
//
//  That is fixed by making the name true, not by deleting it. Below is a real
//  cache keyed on CACHE_NAME, so a version bump now does exactly what it has
//  always claimed to do: a new version means a new cache, the previous one is
//  deleted on activate, and no byte of the old build can survive the swap.
//
//  STRATEGY: NETWORK-FIRST FOR CODE, CACHE ONLY AS A FALLBACK.
//  This is a financial app. Serving a stale module from cache to save a few
//  hundred milliseconds is how a user ends up looking at last week's arithmetic
//  and believing it is today's. So every request for code goes to the network
//  first and only falls back to the cache when the network genuinely fails —
//  which is what turns this into real offline support rather than a stale-code
//  generator. Cache-first is deliberately NOT used for anything executable.
//
//  NEVER CACHED (correctness beats offline for all of these):
//    · /api/*        — live server calls; a cached reply is a wrong reply
//    · version.json  — the update check itself; caching it freezes the app on
//                      whatever version it first saw, which is the very bug
//    · non-GET       — POSTs are not cacheable and must never be replayed
//    · cross-origin  — Firestore, CDNs, auth; not ours to reason about
// ============================================================================

/** Requests that must always hit the network and are never stored. */
function _isNeverCacheable(request, url) {
    if (request.method !== 'GET') return true;
    if (url.origin !== self.location.origin) return true;
    if (url.pathname.startsWith('/api/')) return true;
    if (url.pathname === '/version.json') return true;
    return false;
}

/** True for the app's own executable/shell assets — the things a version owns. */
function _isAppShell(url) {
    const p = url.pathname;
    return p === '/'
        || p === '/index.html'
        || p === '/manifest.json'
        || /^\/wealthflow-[a-zA-Z0-9-]+\.js$/.test(p)
        || /^\/version\.js$/.test(p);
}

self.addEventListener('fetch', (event) => {
    let url;
    try { url = new URL(event.request.url); } catch (_) { return; }

    // Untouched: let the browser do exactly what it would have done without us.
    if (_isNeverCacheable(event.request, url)) return;
    if (!_isAppShell(url)) return;

    event.respondWith((async () => {
        try {
            // Network first, and deliberately WITHOUT a second argument.
            //
            // The obvious-looking `fetch(event.request, { cache: 'no-store' })`
            // is a trap here: supplying a non-empty init for a request whose mode
            // is 'navigate' re-derives the request and downgrades that mode, which
            // is a spec corner sharp enough to cost a white screen on the app's
            // own entry point. It is also unnecessary — vercel.json already serves
            // '/', '/index.html' and '/wealthflow-*.js' with
            // `Cache-Control: no-cache, must-revalidate`, so the browser
            // revalidates these every time regardless. Freshness is already
            // guaranteed by the header; re-asserting it here would buy nothing and
            // risk the one request that must never fail.
            const fresh = await fetch(event.request);
            if (fresh && fresh.ok) {
                // Store a copy for offline use. Failure to cache must never
                // fail the request — the user gets their page either way.
                try {
                    const copy = fresh.clone();
                    const cache = await caches.open(CACHE_NAME);
                    await cache.put(event.request, copy);
                } catch (_) {}
            }
            return fresh;
        } catch (err) {
            // Genuinely offline. Serve the last good copy of THIS version only:
            // caches.open(CACHE_NAME) cannot reach a previous version's cache,
            // because activate() deleted it.
            const cache = await caches.open(CACHE_NAME);
            const hit = await cache.match(event.request);
            if (hit) return hit;
            // A navigation with nothing cached still deserves the shell rather
            // than a browser error page.
            if (event.request.mode === 'navigate') {
                const shell = await cache.match('/index.html') || await cache.match('/');
                if (shell) return shell;
            }
            // Genuinely offline with nothing stored: surface the real network
            // error rather than inventing a response. A fabricated 200 here would
            // render an empty shell and let the owner believe the app had loaded.
            throw err;
        }
    })());
});

// Install event — cache core assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing WealthFlow Service Worker v7.11.0...');
    self.skipWaiting();
});

// Activate event — clean old caches and take control
self.addEventListener('activate', (event) => {
    console.log('[SW] Service Worker activated (v7.11.0)');
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => clients.claim())
    );
});

// Push notification handler
self.addEventListener('push', (event) => {
    console.log('[SW] Push notification received');

    let data = {
        title: 'WealthFlow Infinity',
        body: 'You have a new financial update.',
        icon: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
        badge: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
        tag: 'wealthflow-notification',
        data: { url: '/' }
    };

    if (event.data) {
        try {
            const payload = event.data.json();
            data = { ...data, ...payload };
        } catch (e) {
            data.body = event.data.text();
        }
    }

    const options = {
        body: data.body,
        icon: data.icon,
        badge: data.badge,
        tag: data.tag,
        vibrate: [5, 40, 5, 40, 12, 60, 20],
        data: data.data || { url: '/' },
        actions: data.actions || [],
        requireInteraction: false,
        renotify: true,
        silent: false
    };

    event.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// Notification click handler — open the app and forward action to page
self.addEventListener('notificationclick', (event) => {
    console.log('[SW] Notification clicked', event.action);
    event.notification.close();

    const action = event.action || '';
    const data = event.notification.data || {};
    const urlToOpen = data.url || '/';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if (client.url.includes(self.location.origin)) {
                    if (data.page) {
                        client.postMessage({ type: 'wf-notif-open', page: data.page });
                    }
                    if (action && data.actionableId) {
                        client.postMessage({
                            type: 'WF_NOTIFICATION_ACTION',
                            action,
                            actionableId: data.actionableId
                        });
                    }
                    if ('focus' in client) return client.focus();
                }
            }
            return clients.openWindow(urlToOpen).then((newClient) => {
                if (newClient && data.page) {
                    setTimeout(() => {
                        newClient.postMessage({ type: 'wf-notif-open', page: data.page });
                    }, 1500);
                }
                if (newClient && action && data.actionableId) {
                    setTimeout(() => {
                        newClient.postMessage({
                            type: 'WF_NOTIFICATION_ACTION',
                            action,
                            actionableId: data.actionableId
                        });
                    }, 1500);
                }
            });
        })
    );
});

self.addEventListener('notificationclose', (event) => {
    console.log('[SW] Notification dismissed');
});

// Background Sync — auto-backup only (Gmail sync removed in v7.11.0)
self.addEventListener('sync', (event) => {
    if (event.tag === 'wf-auto-backup') {
        console.log('[SW] wf-auto-backup sync triggered');
        event.waitUntil(_runAutoBackupFromSW('background-sync'));
    } else if (event.tag === 'wealthflow-sync') {
        console.log('[SW] Background sync triggered (legacy tag)');
    }
});

// Periodic Background Sync — daily auto-backup (Gmail sync removed in v7.11.0)
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'wf-periodic-backup') {
        console.log('[SW] wf-periodic-backup periodicsync triggered');
        event.waitUntil(_runAutoBackupFromSW('periodic-sync'));
    }
});

async function _runAutoBackupFromSW(triggerKind) {
    try {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (allClients && allClients.length) {
            for (const c of allClients) c.postMessage({ type: 'WF_RUN_AUTO_BACKUP', triggerKind });
            console.log('[SW] asked', allClients.length, 'client(s) to run a backup');
            return;
        }

        const cache = await caches.open('wf-backup-cache');
        const stored = await cache.match('/wf-pending-backup');
        if (!stored) {
            console.log('[SW] no pending backup snapshot found — nothing to do');
            return;
        }
        const payload = await stored.json();
        if (!payload || !payload.uid || !payload.snapshot || !payload.firestoreUrl) {
            console.log('[SW] pending snapshot incomplete — skipping');
            return;
        }

        const r = await fetch(payload.firestoreUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload.body)
        });
        if (r.ok) {
            console.log('[SW] cloud-only backup succeeded (' + triggerKind + ')');
            try {
                await self.registration.showNotification('☁️ Auto-Backup Complete', {
                    body: 'Your WealthFlow data was backed up automatically while the app was closed.',
                    icon: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
                    badge: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
                    tag: 'wf-auto-backup',
                    silent: false,
                    data: { url: '/?source=auto-backup' }
                });
            } catch (_) {}
        } else {
            console.warn('[SW] Firestore push failed', r.status);
        }
    } catch (e) {
        console.warn('[SW] _runAutoBackupFromSW error:', e && e.message);
    }
}

// Message handler — allows the app page to trigger notifications via SW
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = event.data;
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
    // In-app update flow: the page asks the freshly-installed (waiting) worker
    // to activate immediately. controllerchange on the page then reloads onto
    // the new files. This is the real, atomic "swap core files" step.
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
    // ESCAPE HATCH (Phase 0 self-heal): if the app ever detects it is broken/stuck,
    // it posts { type: 'WF_HARD_RESET' }. We purge ALL caches and unregister this
    // worker, then tell every open tab to reload from the network — guaranteeing a
    // clean recovery to the latest deployed code. This is the safety net that makes
    // auto-deploy recoverable; it never serves stale content.
    if (event.data && event.data.type === 'WF_HARD_RESET') {
        event.waitUntil((async () => {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            } catch (_) {}
            try {
                const cs = await self.clients.matchAll({ includeUncontrolled: true });
                cs.forEach(c => { try { c.postMessage({ type: 'WF_RESET_DONE' }); } catch (_) {} });
            } catch (_) {}
            try { await self.registration.unregister(); } catch (_) {}
        })());
    }
});
