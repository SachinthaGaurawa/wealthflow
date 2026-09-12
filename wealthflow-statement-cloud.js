/* Authenticated cloud vault and autonomous statement review. No secrets enter appData. */
let user = null, unsubscribe = null, pending = [], syncPromise = null, overlay = null;
const state = { configured: null, saved: false, count: 0, savedAt: null, syncing: false, error: '', reviews: 0 };
const say = (message, type = 'info') => { if (typeof window.notify === 'function') window.notify(message, type); };
function change() { window.dispatchEvent(new CustomEvent('wf-statement-cloud', { detail: { ...state } })); }
export async function request(path, method = 'GET', body) {
    const active = user || window.firebase?.auth?.().currentUser;
    if (!active || typeof active.getIdToken !== 'function') throw new Error('sign-in-required');
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 55000);
    try {
        const token = await active.getIdToken();
        const response = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const result = await response.json().catch(() => null);
        if ((user || window.firebase?.auth?.().currentUser)?.uid !== active.uid) throw new Error('sign-in-changed');
        if (!response.ok || !result?.ok) throw new Error(result?.reason || 'statement-service-unavailable');
        return result;
    } catch (error) { if (error?.name === 'AbortError') throw new Error('statement-request-timed-out'); throw error; }
    finally { clearTimeout(timer); }
}
export async function status() {
    const requestUid = (user || window.firebase?.auth?.().currentUser)?.uid;
    try {
        const result = await request('/api/statement-vault');
        Object.assign(state, { configured: true, saved: result.saved === true, count: result.count || 0, savedAt: result.savedAt || null, error: '' });
    } catch (error) {
        if ((user || window.firebase?.auth?.().currentUser)?.uid !== requestUid) throw error;
        if (error.message === 'statement-cloud-not-configured') Object.assign(state, { configured: false, saved: false, count: 0, error: '' });
        else { state.error = error.message; change(); throw error; }
    }
    change(); return { ...state };
}
export async function save(entries) {
    await status();
    if (!state.configured) return { ok: true, localOnly: true };
    const result = await request('/api/statement-vault', 'PUT', { entries });
    Object.assign(state, { saved: result.saved === true, count: result.count || 0, savedAt: result.savedAt || null, error: '' }); change();
    sync().catch(() => {});
    return result;
}
export async function remove() {
    await status();
    if (!state.configured) return { ok: true, localOnly: true };
    const result = await request('/api/statement-vault', 'DELETE');
    Object.assign(state, { saved: false, count: 0, savedAt: null }); change(); return result;
}
export async function sync() {
    if (syncPromise) return syncPromise;
    if (!state.configured || !state.saved || !user) return { ok: false, reason: 'cloud-vault-required' };
    state.syncing = true; state.error = ''; change();
    syncPromise = request('/api/statement-sync', 'POST', { action: 'sync' }).catch(error => { state.error = error.message; throw error; })
        .finally(() => { state.syncing = false; syncPromise = null; change(); });
    return syncPromise;
}
export async function authChanged(next) {
    if (user?.uid === next?.uid && next) return;
    user = next; unsubscribe?.(); unsubscribe = null; pending = []; state.reviews = 0;
    state.configured = null; state.saved = false; state.count = 0; state.error = ''; change();
    if (!user) { overlay?.remove(); overlay = null; return; }
    const db = window.db || window.firebase?.firestore?.();
    if (db) unsubscribe = db.collection('users').doc(user.uid).collection('statementReview').where('status', '==', 'pending').limit(100)
        .onSnapshot(snapshot => { pending = snapshot.docs.map(d => ({ ...d.data(), id: d.id })); state.reviews = pending.length; change(); if (overlay) drawReview(); },
            () => { state.error = 'statement-review-unavailable'; change(); });
    try { await status(); await sync(); } catch (error) { if (user?.uid === next.uid) say('Background statement sync could not start: ' + friendly(error.message), 'warn'); }
}
export function friendly(reason) {
    return ({ 'sign-in-required': 'Sign in to access your cloud statement vault.', 'statement-cloud-not-configured': 'Cloud statement processing is not configured; device processing remains available.',
        'statement-request-timed-out': 'The request timed out; its final server state will be checked again.',
        'statement-service-unavailable': 'The service is unavailable. Your statements remain pending.' })[reason] || 'The cloud operation failed. Please retry; no successful completion was recorded.';
}
async function download(entry) {
    try {
        const sourceId = String(entry.sourcePath || '').split('/').pop();
        const result = await request('/api/gmail-link?items=1');
        const item = result.items?.find(i => i.id === sourceId);
        if (!item) throw new Error('source-not-available');
        const encoded = item.manifest?.d || (item.parts || []).sort((a, b) => a.i - b.i).map(p => p.d).join('');
        if (!encoded || encoded.length > 24 * 1024 * 1024) throw new Error('source-not-available');
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.rel = 'noopener'; link.download = item.manifest?.filename || 'statement.pdf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { say('The original statement is unavailable for download. The review remains pending.', 'error'); }
}
async function mapLayout(entry) {
    if (typeof window._teachStatementLayout !== 'function') return say('The statement layout mapper is not loaded yet.', 'warn');
    try {
        const source = await request('/api/statement-sync', 'POST', { action: 'review-source', id: entry.id });
        if (!source.text || typeof source.text !== 'string') throw new Error('statement-text-unavailable');
        overlay?.remove(); overlay = null;
        window._teachStatementLayout([{ key: entry.id, text: source.text, bank: source.bank || 'Bank', fileName: source.filename || 'Statement', index: 0, last4: source.last4 || '' }], async learned => {
            if (!learned?.[0]?.rows?.length) { say('No complete layout was confirmed. The statement remains in Needs Review.', 'warn'); openReview(); return; }
            try {
                const result = await request('/api/statement-sync', 'POST', { action: 'layout', id: entry.id, rows: learned[0].rows });
                if (result.mapped !== true) throw new Error('layout-not-mapped');
                say(result.queued === true ? 'Statement layout verified, saved and queued for background processing.' : 'Statement layout is saved. Scheduling is still pending; background catch-up will retry.', result.queued === true ? 'success' : 'warn');
                await sync().catch(() => say('The layout is saved, but the immediate processing request failed. Its queued statement remains pending for retry.', 'warn'));
            } catch { say('Cloud layout saving was not completed. The original statement remains pending.', 'error'); }
            openReview();
        });
    } catch { say('The original statement could not be opened for mapping. Its source remains securely pending; check your saved cloud passwords.', 'error'); }
}
function review(entry) {
    if (typeof window._showCCReviewModal !== 'function') return say('Statement review is not loaded yet.', 'warn');
    const row = entry.row;
    if (!row || !row.date || !row.amount || entry.index < 0) return mapLayout(entry);
    overlay?.remove(); overlay = null;
    window._showCCReviewModal({ transactions: [{ ...row, description: row.description || row.narration, _needsReview: true, _reviewWhy: entry.reason }],
        fileName: 'Cloud statement review', card_last4: row.card_last4 || '',
        cloudReview: async decisions => {
            if (decisions.length !== 1) throw new Error('review-selection-required');
            const choice = decisions[0];
            const result = await request('/api/statement-sync', 'POST', { action: 'review', id: entry.id, row: choice.row, decision: choice.decision });
            if (result.resolved !== true) throw new Error('review-not-resolved');
            say('Statement review saved securely.', 'success'); return result;
        } }, row.bank || 'Bank', null);
}
export function dismissReview(entry) {
    const commit = async () => {
        try {
            const result = await request('/api/statement-sync', 'POST', { action: 'review', id: entry.id, decision: { module: 'skip' } });
            if (result.resolved !== true) throw new Error('review-not-resolved');
            say('Statement review dismissed securely.', 'info');
        } catch { say('Dismissal was not completed. The statement remains pending.', 'error'); }
    };
    if (typeof window.showConfirm === 'function') return window.showConfirm('trash', 'Dismiss this statement?',
        'This statement will be ignored and no financial transactions will be created from it. Dismiss only if it is not a statement you want to import.', 'btn-danger', 'Dismiss statement', commit);
    if (typeof window.confirm === 'function' && window.confirm('Ignore this statement without importing its transactions?')) return commit();
}
function drawReview() {
    if (!overlay) return;
    overlay.replaceChildren();
    const box = document.createElement('section'); box.className = 'md'; box.style.cssText = 'max-width:720px;width:94%;max-height:85vh;overflow:auto;padding:20px;background:var(--card);border-radius:16px;';
    const title = document.createElement('h3'); title.textContent = 'Statements needing review'; box.appendChild(title);
    const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Close'; close.onclick = () => { overlay.remove(); overlay = null; }; box.appendChild(close);
    if (!pending.length) { const p = document.createElement('p'); p.textContent = 'No transactions are awaiting review.'; box.appendChild(p); }
    for (const entry of pending) {
        const item = document.createElement('div'); item.style.cssText = 'padding:14px 0;border-bottom:1px solid var(--border);';
        const text = document.createElement('p'); text.textContent = `${entry.row?.date || 'Unknown date'} · ${entry.row?.description || entry.row?.narration || 'Statement layout'} · ${entry.row?.amount || ''}`; item.appendChild(text);
        const why = document.createElement('p'); why.textContent = String(entry.reason || 'Verification required'); item.appendChild(why);
        const button = document.createElement('button'); button.className = 'btn btn-primary btn-sm'; button.textContent = entry.index < 0 || !entry.row?.amount ? 'Map statement layout' : 'Review'; button.onclick = async () => { button.disabled = true; try { await review(entry); } finally { button.disabled = false; } }; item.appendChild(button);
        const raw = document.createElement('button'); raw.className = 'btn btn-secondary btn-sm'; raw.textContent = 'Download original'; raw.style.marginLeft = '8px'; raw.onclick = () => download(entry); item.appendChild(raw); box.appendChild(item);
        if (entry.index < 0 || !entry.row?.amount) { const dismiss = document.createElement('button'); dismiss.className = 'btn btn-ghost btn-sm'; dismiss.textContent = 'Dismiss statement'; dismiss.style.marginLeft = '8px'; dismiss.onclick = () => dismissReview(entry); item.appendChild(dismiss); }
    }
    if (pending.length === 100) { const p = document.createElement('p'); p.textContent = 'Showing the first 100 pending reviews. More will appear as these are resolved.'; box.appendChild(p); }
    overlay.appendChild(box);
}
export function openReview() {
    if (!user) return say('Sign in to review cloud statements.', 'warn');
    overlay?.remove(); overlay = document.createElement('div'); overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(overlay); drawReview();
}
if (typeof window !== 'undefined') {
    window.addEventListener('wf-statement-cloud', () => {
        const text = document.getElementById('_statement_cloud_status');
        if (text) text.textContent = state.error ? 'Background statement sync needs attention. Retry saving or syncing.' : state.syncing ? 'Processing statements in the background…' : state.saved ? `Private cloud vault saved · ${state.reviews} transactions need review.` : state.configured === false ? 'Cloud processing is not configured. Device processing is available.' : 'Save your statement passwords to enable background decryption.';
    });
    window.WFStatementCloud = { authChanged, save, remove, sync, status, openReview, friendly, getState: () => ({ ...state }) };
    const start = () => { if (window.firebase?.apps?.length) window.firebase.auth().onAuthStateChanged(next => authChanged(next)); };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}
