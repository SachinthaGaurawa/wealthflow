// ==================== WealthFlow Infinity Service Worker v7.9.0 ====================
// Handles PWA push notifications, offline caching, background sync, and the
// new Gmail-sync periodic background poll (v7.9.0).

const CACHE_NAME = 'wealthflow-v7.9.0';

// Install event — cache core assets
self.addEventListener('install', (event) => {
    console.log('[SW] Installing WealthFlow Service Worker v7.9.0...');
    self.skipWaiting();
});

// Activate event — clean old caches and take control
self.addEventListener('activate', (event) => {
    console.log('[SW] Service Worker activated (v7.9.0)');
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

// Background Sync — handles wf-auto-backup AND wf-gmail-sync (v7.9.0).
self.addEventListener('sync', (event) => {
    if (event.tag === 'wf-auto-backup') {
        console.log('[SW] wf-auto-backup sync triggered');
        event.waitUntil(_runAutoBackupFromSW('background-sync'));
    } else if (event.tag === 'wf-gmail-sync') {
        console.log('[SW] wf-gmail-sync triggered');
        event.waitUntil(_wakeClientsForGmailSync('background-sync'));
    } else if (event.tag === 'wealthflow-sync') {
        console.log('[SW] Background sync triggered (legacy tag)');
    }
});

// Periodic Background Sync — fires ~once a day in installed PWAs.
// v7.9.0: now also asks the page to do a Gmail sync once per day in the
// background, even if the user hasn't opened the app.
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'wf-periodic-backup') {
        console.log('[SW] wf-periodic-backup periodicsync triggered');
        event.waitUntil(_runAutoBackupFromSW('periodic-sync'));
    } else if (event.tag === 'wf-periodic-gmail-sync') {
        console.log('[SW] wf-periodic-gmail-sync triggered');
        event.waitUntil(_wakeClientsForGmailSync('periodic-sync'));
    }
});

// v7.9.0 — wake any open client and ask it to run a Gmail sync.
// The page does the actual sync (it holds the encrypted refresh-token);
// the SW just nudges. If no client is open, we surface a notification
// inviting the user to open the app — Gmail tokens can't be used from
// inside the SW without exposing them in plaintext, which we won't do.
async function _wakeClientsForGmailSync(triggerKind) {
    try {
        const allClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (allClients && allClients.length) {
            for (const c of allClients) {
                c.postMessage({ type: 'WF_RUN_GMAIL_SYNC', triggerKind });
            }
            console.log('[SW] asked', allClients.length, 'client(s) to run Gmail sync');
            return;
        }
        // No clients open — notify the user (only once per 12 hours)
        const lastNotify = await _readSwState('wf_gmail_last_notify');
        if (lastNotify && (Date.now() - lastNotify) < 12 * 3600 * 1000) return;
        await _writeSwState('wf_gmail_last_notify', Date.now());
        try {
            await self.registration.showNotification('📧 Bank emails waiting', {
                body: 'Open WealthFlow to auto-file new transactions from your Gmail.',
                icon: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
                badge: 'https://res.cloudinary.com/dzrfpc9be/image/upload/v1777660556/WealthFlow_Logo_tytp9p.png',
                tag: 'wf-gmail-sync-needed',
                silent: false,
                data: { url: '/?source=gmail-sync-notify' }
            });
        } catch (_) {}
    } catch (e) {
        console.warn('[SW] _wakeClientsForGmailSync error:', e && e.message);
    }
}

async function _readSwState(key) {
    try {
        const cache = await caches.open('wf-sw-state');
        const r = await cache.match('/state/' + key);
        if (!r) return null;
        return Number(await r.text());
    } catch { return null; }
}

async function _writeSwState(key, value) {
    try {
        const cache = await caches.open('wf-sw-state');
        await cache.put('/state/' + key, new Response(String(value)));
    } catch (_) {}
}

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
});
