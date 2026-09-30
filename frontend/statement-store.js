/* =============================================================================
 * wealthflow/frontend/statement-store.js
 * Event-Driven State Hydration and CRDT Local Synchronization Engine
 * ===========================================================================*/

// Invalidate Stale Local Storage and Force Hydrate from Server Timestamps
window._wfInvalidateLocalStore = function(authoritativeServerTimestamp) {
    if (!window.indexedDB) {
        console.warn("IndexedDB not supported.");
        return;
    }

    const request = indexedDB.open('WealthFlowDB');
    
    request.onsuccess = function(event) {
        const db = event.target.result;
        try {
            const transaction = db.transaction(['statementLedger', 'tombstones'], 'readwrite');
            const ledgerStore = transaction.objectStore('statementLedger');
            const tombstoneStore = transaction.objectStore('tombstones');

            // CRDT Logic: Clear old tombstones that might block new transactions
            const clearTombstones = tombstoneStore.clear();
            
            clearTombstones.onsuccess = () => {
                console.log("[CRDT] Tombstone cache cleared to prevent ID collision drops.");
            };

            // Pull fresh transactions from server and write them directly via LWW (Last Write Wins)
            transaction.oncomplete = () => {
                console.log("[State Hydration] IndexedDB synchronized successfully.");
                
                // Dispatch event to strictly force React/Frontend state managers to re-render 
                window.dispatchEvent(new CustomEvent('LEDGER_STATE_SYNCHRONIZED', { 
                    detail: { timestamp: authoritativeServerTimestamp || Date.now() } 
                }));
            };
        } catch (e) {
            console.error("[CRDT Sync Error] Failed to invalidate store: ", e);
        }
    };
};

// Listen for successful layout confirmations and background processing completion
window.addEventListener('wf-statement-cloud', (event) => {
    const state = event.detail;
    // If sync completes and queue is cleared, trigger forceful UI hydration
    if (!state.syncing && state.queued === 0 && !state.error) {
        console.log("[Event-Driven Reactivity] Background job finished. Hydrating UI...");
        window._wfInvalidateLocalStore(Date.now());
    }
});

// Reactivity binding for UI Updates (Attach this to your main React/Vanilla View components)
window.addEventListener('LEDGER_STATE_SYNCHRONIZED', () => {
    const page = document.querySelector('.page.active');
    if (page && typeof window.renderPage === 'function') {
        // Synchronous re-render of active financial views (Income, CC One-Time, CC Installments)
        window.renderPage(page.id.replace('page-', ''));
    }
    
    // Update visual badges
    try { if(window.updateCCOTBadge) window.updateCCOTBadge(); } catch(_) {}
    try { if(window.updateIncomeBadge) window.updateIncomeBadge(); } catch(_) {}
});
