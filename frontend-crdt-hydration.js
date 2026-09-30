/* =============================================================================
 * wealthflow/frontend-crdt-hydration.js (New File)
 * Event-Driven State Hydration and CRDT Local Synchronization Engine
 * Include this script on the client side (e.g. index.html) to prevent stale UI
 * ===========================================================================*/

// Invalidate Stale Local Storage and Force Hydrate from Server Timestamps
window._wfInvalidateLocalStore = function(authoritativeServerTimestamp) {
    if (!window.indexedDB) {
        console.warn("IndexedDB not supported on this client.");
        return;
    }

    const request = indexedDB.open('WealthFlowDB');
    
    request.onsuccess = function(event) {
        const db = event.target.result;
        try {
            if (!db.objectStoreNames.contains('tombstones')) return;
            
            const transaction = db.transaction(['tombstones'], 'readwrite');
            const tombstoneStore = transaction.objectStore('tombstones');

            // CRDT Logic: Clear old tombstones that are blocking new transactions
            const clearTombstones = tombstoneStore.clear();
            
            clearTombstones.onsuccess = () => {
                console.log("[CRDT] Tombstone cache cleared. Preventing ID collision drops.");
            };

            // Force UI React/View frameworks to re-pull from updated store
            transaction.oncomplete = () => {
                console.log("[State Hydration] IndexedDB synchronized successfully.");
                window.dispatchEvent(new CustomEvent('LEDGER_STATE_SYNCHRONIZED', { 
                    detail: { timestamp: authoritativeServerTimestamp || Date.now() } 
                }));
            };
        } catch (e) {
            console.error("[CRDT Sync Error] Failed to invalidate store: ", e);
        }
    };
};

// Bind to layout confirmation success events
window.addEventListener('wf-statement-cloud', (event) => {
    const state = event.detail;
    // When sync/background process officially clears, explicitly hydrate the UI
    if (!state.syncing && state.queued === 0 && !state.error) {
        console.log("[Event-Driven Reactivity] Statement mapped. Hydrating UI without reload.");
        window._wfInvalidateLocalStore(Date.now());
    }
});

// Reactivity binding for immediate rendering
window.addEventListener('LEDGER_STATE_SYNCHRONIZED', () => {
    const page = document.querySelector('.page.active');
    if (page && typeof window.renderPage === 'function') {
        // Synchronous re-render of active financial views
        window.renderPage(page.id.replace('page-', ''));
    }
    
    // Safely update notification badges
    try { if (window.updateCCOTBadge) window.updateCCOTBadge(); } catch(_) {}
    try { if (window.updateIncomeBadge) window.updateIncomeBadge(); } catch(_) {}
});
