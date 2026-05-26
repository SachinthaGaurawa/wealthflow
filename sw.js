// ==================== WealthFlow Infinity Service Worker ====================
// Handles PWA push notifications, offline caching, and background sync

const CACHE_NAME = 'wealthflow-v7.4.9';

// Install event — cache core assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing WealthFlow Service Worker v7.4.9...');
    self.skipWaiting();
});

// Activate event — clean old caches and take control
self.addEventListener('activate', (event) => {
    console.log('[SW] Service Worker activated');
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
        vibrate: [5, 40, 5, 40, 12, 60, 20], // Luxury rising pattern
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
            // If app is already open, focus it and forward the action
            for (const client of clientList) {
                if (client.url.includes(self.location.origin)) {
                    if (action && data.actionableId) {
                        // Forward the action click to the page
                        client.postMessage({
                            type: 'WF_NOTIFICATION_ACTION',
                            action,
                            actionableId: data.actionableId
                        });
                    }
                    if ('focus' in client) return client.focus();
                }
            }
            // Otherwise open a new window
            return clients.openWindow(urlToOpen).then((newClient) => {
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

// Notification close handler
self.addEventListener('notificationclose', (event) => {
    console.log('[SW] Notification dismissed');
});

// Background Sync — handles wf-auto-backup AND legacy wealthflow-sync.
self.addEventListener('sync', (event) => {
    if (event.tag === 'wf-auto-backup') {
        console.log('[SW] wf-auto-backup sync triggered');
        event.waitUntil(_runAutoBackupFromSW('background-sync'));
    } else if (event.tag === 'wealthflow-sync') {
        console.log('[SW] Background sync triggered (legacy tag)');
    }
});

// ── Periodic Background Sync — fires ~once a day in installed PWAs ─
// Same handler shape: wake an open client OR do a SW-side push to
// Firestore using the snapshot the page left for us.
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'wf-periodic-backup') {
        console.log('[SW] wf-periodic-backup periodicsync triggered');
        event.waitUntil(_runAutoBackupFromSW('periodic-sync'));
    }
});

async function _runAutoBackupFromSW(triggerKind) {
    try {
        // 1. If a WealthFlow tab is open, just ask it to run a backup.
        //    The page has full access to Drive tokens + Firestore creds
        //    so it does a much higher-fidelity backup than the SW can.
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (allClients && allClients.length) {
            for (const c of allClients) c.postMessage({ type: 'WF_RUN_AUTO_BACKUP', triggerKind });
            console.log('[SW] asked', allClients.length, 'client(s) to run a backup');
            return;
        }

        // 2. No client is open. Try the SW-side fallback: read the
        //    "pending snapshot" left by the page on its last visit and
        //    post it to Firestore directly. The page writes this snapshot
        //    every time it saves, so the SW always has a recent one.
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

        // 3. POST to Firestore REST (no auth tokens needed for project's
        //    public-write rules — same path the page uses). Drive uploads
        //    require an OAuth token only the page can refresh, so we skip
        //    those here and rely on Layer 1/2/3 for verified Drive backups.
        const r = await fetch(payload.firestoreUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload.body)
        });
        if (r.ok) {
            console.log('[SW] cloud-only backup succeeded (' + triggerKind + ')');
            // Show a notification so the user knows it happened.
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

// (Background Sync handler defined above)

// Message handler — allows the app page to trigger notifications via SW
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = event.data;
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});
