// ==================== WealthFlow Infinity Service Worker v7.11.0 ====================
// Handles PWA push notifications, offline caching, and background sync.
//
// v7.11.0 (May 2026): Reverted the v7.9.0 Gmail-sync hooks. The app no longer
// has email-based ingestion. Instead, users paste bank SMSes manually via the
// new in-app modal (wealthflow-sms-paste.js). Service Worker stays simple:
// notifications, caching, and the original auto-backup logic.

const CACHE_NAME = 'wealthflow-v7.69.10';

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
