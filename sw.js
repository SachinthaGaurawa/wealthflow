// ==================== WealthFlow Infinity Service Worker ====================
// Handles PWA push notifications, offline caching, and background sync

const CACHE_NAME = 'wealthflow-v7.4.0';

// Install event — cache core assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing WealthFlow Service Worker v7.4.0...');
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

// ── Background Sync (one-shot, fires when network is restored) ──────────
// When the app is offline at backup-due time we register tag 'wf-auto-backup'.
// As soon as the device is back online, the browser wakes the SW and fires
// this event. We tell any open client to run the backup. If no client is
// open, we open one — the page-load will trigger _checkAutoBackupDue() via
// the auth-state listener.
self.addEventListener('sync', (event) => {
    if (event.tag === 'wf-auto-backup' || event.tag === 'wealthflow-sync') {
        console.log('[SW] Background Sync fired:', event.tag);
        event.waitUntil(_wfTriggerBackupInClients());
    }
});

// ── Periodic Background Sync (Chromium PWAs only) ───────────────────────
// Fires roughly once per the minInterval the page registered. Used as a
// belt-and-braces wake-up so the app gets a chance to back up even if the
// user never opens the tab.
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'wf-periodic-backup') {
        console.log('[SW] Periodic Background Sync fired:', event.tag);
        event.waitUntil(_wfTriggerBackupInClients());
    }
});

async function _wfTriggerBackupInClients() {
    try {
        const all = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (all && all.length) {
            // Tell every open client to run a backup check now.
            for (const c of all) {
                try { c.postMessage({ type: 'WF_RUN_AUTO_BACKUP' }); } catch (_) {}
            }
            return;
        }
        // No window open — open one in the background. When the page loads
        // and the user is already signed in (Firebase persistence is LOCAL),
        // the in-app scheduler will run _checkAutoBackupDue() automatically.
        try { await clients.openWindow('/?wfAutoBackup=1'); } catch (_) {}
    } catch (e) { console.warn('[SW] _wfTriggerBackupInClients failed:', e && e.message); }
}

// Message handler — allows the app page to trigger notifications via SW
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SHOW_NOTIFICATION') {
        const { title, options } = event.data;
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    }
});
