/**/
let user=null,unsubscribe=null,pending=[],syncPromise=null,overlay=null,authBound=false,authAttempts=0,continuationTimer=null;
const state={configured:null,saved:false,count:0,savedAt:null,syncing:false,error:'',reviews:0,queued:0};
export const getState=()=>({...state});
// For the Diagnostics "Copy diagnostics" button: why statements are actually
// stuck, in aggregate, with no date/amount/narration/description ever
// included — only the reason code and bank name, the same two fields the
// review list already shows the owner on screen. This is what turns "nothing
// is being added" into an actionable report without asking for statement
// content.
export function reviewSummary(){
    const byReason={};
    let wholeStatement=0,perRow=0;
    for(const entry of pending){
        const reason=String(entry.reason||'unknown');
        byReason[reason]=(byReason[reason]||0)+1;
        if(entry.index<0||!entry.row)wholeStatement++;else perRow++;
    }
    const wholeStatements=pending.filter(e=>e.index<0||!e.row).slice(0,20)
        .map(e=>({bank:e.bank||'',filename:e.filename||'',reason:e.reason||''}));
    return {total:pending.length,wholeStatement,perRow,byReason,wholeStatements};
}
const say=(message,type='info')=>{if(window.notify)window.notify(message,type)};
function change(){window.dispatchEvent(new CustomEvent('wf-statement-cloud',{detail:{...state}}))}
function sdkUser(){try{return typeof window.firebase?.auth==='function'?window.firebase.auth().currentUser:null;}catch(_){return null;}}
function currentUser(){return user||sdkUser();}
function adoptUser(next){
 if(!next||user?.uid===next.uid)return user;
 user=next;unsubscribe?.();unsubscribe=null;pending=[];state.reviews=0;
 const db=window.db||window.firebase?.firestore?.();
 if(db)unsubscribe=db.collection('users').doc(user.uid).collection('statementReview').where('status','==','pending').limit(500).onSnapshot(s=>{pending=s.docs.map(d=>({...d.data(),id:d.id}));state.reviews=pending.length;change();if(overlay)drawReview()},()=>{state.error='statement-review-unavailable';change()});
 return next
}
async function reconcileLogin(){for(let n=0;n<20;n++){if(window._wfRecentSweep){await window._wfRecentSweep(false);return}await new Promise(r=>setTimeout(r,100))}}
export async function request(path,method='GET',body){
    const active=currentUser();
    if(!active||typeof active.getIdToken!=='function')throw new Error('sign-in-required');
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),55000);
    try{
        const token=await active.getIdToken();
        const response = await fetch(path, { method, cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            headers: { Authorization: 'Bearer ' + token, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
            ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
        const result=await response.json().catch(()=>null);
        const sdk=sdkUser();
        if ((typeof window.firebase?.auth === 'function' && sdk?.uid !== active.uid) || (!sdk && user?.uid !== active.uid)) throw new Error('sign-in-changed');
        if (!response.ok || !result?.ok) throw new Error(result?.reason || 'statement-service-unavailable');
        return result;
    }catch(error){if(error?.name==='AbortError')throw new Error('statement-request-timed-out');throw error}
    finally{clearTimeout(timer)}
}
export async function status(){
    const requestUid=currentUser()?.uid;
    try {
        const result = await request('/api/statement-vault');
        Object.assign(state, { configured: true, saved: result.saved === true, count: result.count || 0, savedAt: result.savedAt || null, error: '' });
    } catch (error) {
        if(currentUser()?.uid!==requestUid)throw error;
        if (error.message === 'statement-cloud-not-configured') Object.assign(state, { configured: false, saved: false, count: 0, error: '' });
        else { state.error = error.message; change(); throw error; }
    }
    change();return {...state};
}
export async function save(entries){
    await status();
    if(!state.configured)return {ok:true,localOnly:true};
    const result=await request('/api/statement-vault','PUT',{entries});
    Object.assign(state, { saved: result.saved === true, count: result.count || 0, savedAt: result.savedAt || null, error: '' }); change();
    sync().catch(() => {});
    return result;
}
export async function remove(){
    await status();
    if(!state.configured)return {ok:true,localOnly:true};
    const result=await request('/api/statement-vault','DELETE');
    Object.assign(state, { saved: false, count: 0, savedAt: null }); change(); return result;
}
export async function sync(){
    if(syncPromise)return syncPromise;
    adoptUser(currentUser());
    if(!state.configured||!state.saved||!currentUser())return {ok:false,reason:'cloud-vault-required'};
    state.syncing=true;state.error='';change();
    const again=delay=>{if(!continuationTimer)continuationTimer=setTimeout(()=>{continuationTimer=null;sync().catch(()=>{})},delay)};
    syncPromise=request('/api/statement-sync','POST',{action:'sync'}).then(result=>{
        state.queued=Math.max(0,Number(result.pendingRemaining)||0)+Math.max(0,Number(result.processingRemaining)||0);
        if(result.morePending)again(Math.max(750,Math.min(180250,Number(result.retryAfterMs)||750)))
        return result
    }).catch(e=>{state.error=e.message;if(e.message==='statement-request-timed-out')again(3000);throw e})
        .finally(()=>{state.syncing=false;syncPromise=null;change()});
    return syncPromise
}
export async function authChanged(next){
 if(user?.uid===next?.uid&&next)return;
 unsubscribe?.();unsubscribe=user=null;pending=[];state.reviews=0;
 Object.assign(state,{configured:null,saved:false,count:0,savedAt:null,error:'',queued:0});change();
 if(!next){clearTimeout(continuationTimer);continuationTimer=null;overlay?.remove();overlay=null;return}
 adoptUser(next);try{await status();await reconcileLogin();await sync()}catch(_){}
}
export function friendly(reason) {
    return ({ 'sign-in-required': 'Sign in to use the statement vault.', 'statement-cloud-not-configured': 'Cloud processing is not configured; device processing is available.',
        'statement-request-timed-out': 'Request timed out; the queue will check again.',
        'statement-service-unavailable': 'Service unavailable; statements remain pending.',
        'statement-sync-unavailable': 'Processing is unavailable; the safe queue will retry.',
        'statement-worker-retry-required': 'A statement needs retry; it will not block the others.',
        'autonomous-mailbox-not-enabled': 'Reconnect Gmail to resume background processing.',
        'gmail-profile-unavailable': 'Gmail is unavailable; automatic retry is queued.',
        'gmail-profile-owner-mismatch': 'Connected Gmail does not match this WealthFlow owner.',
        'gmail-intake-unavailable': 'Gmail collection paused safely and will retry.',
        'verified-owner-required': 'Verify the owner email before running autonomous statement processing.',
        'cloud-vault-required': 'Save passwords to the private cloud vault first.',
        'sign-in-changed': 'The account changed during the request; retry after loading.' })[reason] || 'Processing stopped safely; nothing was filed and the queue will retry.';
}
export const migrateUnlockedVault=entries=>Array.isArray(entries) && entries.length ? save(entries) : false;
async function download(entry) {
    try {
        const sourceId = String(entry.sourcePath || '').split('/').pop();
        const result = await request('/api/gmail-link?items=1&source=' + encodeURIComponent(sourceId));
        const item = result.items?.find(i => i.id === sourceId);
        if (!item) throw new Error('source-not-available');
        const encoded = item.manifest?.d || (item.parts || []).sort((a, b) => a.i - b.i).map(p => p.d).join('');
        if (!encoded || encoded.length > 24 * 1024 * 1024) throw new Error('source-not-available');
        const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
        const link = document.createElement('a'); link.href = url; link.rel = 'noopener'; link.download = item.manifest?.filename || 'statement.pdf'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { say('The original statement is unavailable for download. The review remains pending.', 'error'); }
}
// Every reason mapReviewLayout()/inspectReviewSource() can explicitly return
// for action:'layout' names a real, permanent fact about the statement or
// its evidence — retrying changes nothing. Anything else reaching here can
// only be a raw network failure, a timeout, or a generic 5xx (request()'s
// own fallback 'statement-service-unavailable'): exactly the kind of blip a
// mobile connection causes and a few seconds later recovers from. Forcing
// the owner back through the whole teach modal (re-fetch the source,
// re-propose a reading, re-tap through every date) just to retry the one
// POST that actually confirms it is real friction for a failure that costs
// nothing to retry automatically instead.
const LAYOUT_CONFIRM_PERMANENT_REASONS = new Set([
    'PASSWORD_FAILED', 'NO_VAULT_KEYS', 'statement-message-missing', 'statement-message-deleted',
    'statement-sender-no-longer-approved', 'statement-attachment-identity-mismatch',
    'statement-attachment-content-mismatch', 'statement-attachment-invalid', 'statement-attachment-size',
    'gmail-fetch-unavailable', 'review-source-text-unavailable', 'review-source-is-not-statement',
    'review-source-owner-mismatch', 'whole-statement-review-required',
    'layout-confirmation-does-not-reproduce-statement', 'layout-not-mapped',
]);
const LAYOUT_CONFIRM_RETRIES = 2;
async function confirmLayout(entry, rows) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const result = await request('/api/statement-sync', 'POST', { action: 'layout', id: entry.id, rows });
            if (result.mapped !== true) throw new Error('layout-not-mapped');
            return result;
        } catch (error) {
            // A previous attempt — this call's own earlier try, or an even
            // earlier session — may already have gone through: mapReviewLayout's
            // replay guard is what reports that, and it is a result to surface
            // accurately, never a fresh failure to retry into (retrying it again
            // would just repeat the exact same, correct rejection forever).
            if (error?.message === 'layout-replay-would-overlap-settled-data') { error.mightAlreadyBeMapped = true; throw error; }
            if (attempt >= LAYOUT_CONFIRM_RETRIES || LAYOUT_CONFIRM_PERMANENT_REASONS.has(error?.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
    }
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
                const result = await confirmLayout(entry, learned[0].rows);
                say(result.queued === true ? 'Statement layout verified, saved and queued for background processing.' : 'Statement layout is saved. Scheduling is still pending; background catch-up will retry.', result.queued === true ? 'success' : 'warn');
                await sync().catch(() => say('The layout is saved, but the immediate processing request failed. Its queued statement remains pending for retry.', 'warn'));
            } catch (error) {
                say(error?.mightAlreadyBeMapped
                    ? 'This may already be confirmed from an earlier attempt — check Open reviews for its current status before mapping it again.'
                    : 'Cloud layout saving was not completed. The original statement remains pending.', error?.mightAlreadyBeMapped ? 'warn' : 'error');
            }
            openReview();
        });
    } catch (error) {
        const messages = {
            PASSWORD_FAILED: 'Saved passwords did not unlock this statement. Add the exact PDF password.',
            NO_VAULT_KEYS: 'Save the PDF password before mapping this statement.',
            'statement-message-missing': 'Original Gmail reference is missing; upload again or dismiss.',
            'statement-message-deleted': 'Original Gmail message was deleted; upload again or dismiss.',
            'statement-attachment-identity-mismatch': 'The recorded attachment is missing; upload it again or dismiss.',
            'statement-attachment-content-mismatch': 'Attachment content changed and was not opened; upload the intended file.',
            'review-source-is-not-statement': 'The document lacks enough bank-statement evidence.',
            'review-source-text-unavailable': 'No usable statement text was recovered; check its PDF password.',
        };
        say(messages[error?.message] || 'The original statement could not be reopened. Nothing was filed; upload the intended statement again or dismiss this stale review.', 'error');
    }
}
// Plain-language text for the codes validateSettlementRow() (statement-ledger.mjs)
// and classifySlice() (statement-sync.js) return as a review's `reason`. Shown
// directly to the owner in the review list and inside the single-row modal, so
// a raw code like 'invalid-transaction' — which says nothing about what to
// fix — must never reach that screen unexplained.
function reviewReasonText(reason) {
    return ({
        'invalid-transaction': 'The amount, date or description could not be read correctly. Check this row against your statement and correct it.',
        'unproven-direction': "Whether this was money in or money out could not be confirmed from the statement. Check it against the statement and set it below.",
        'ai-consensus-unavailable': 'The independent AI review could not reach agreement on this transaction. Check it against the statement and confirm it yourself.',
        'unanimous-decision-required': 'The independent AI review could not reach agreement on this transaction. Check it against the statement and confirm it yourself.',
        'transfer-route-conflict': 'This looks like a transfer between your own accounts but was routed as spending or income. Confirm where it should go.',
        'skip-requires-transfer-evidence': "This was marked as a transfer between your own accounts, but the statement doesn't clearly show that. Confirm where it should go.",
        'income-direction-conflict': 'This was routed as income, but the statement direction does not support that. Confirm where it should go.',
        'card-payment-context-required': 'This was routed as a card payment, but the statement does not support that. Confirm where it should go.',
        'expense-direction-conflict': 'This was routed as spending, but the statement direction does not support that. Confirm where it should go.',
        'card-charge-context-required': 'This was routed as a card charge, but the statement does not support that. Confirm where it should go.',
    })[reason] || 'This transaction needs your confirmation. Check it against the statement before saving.';
}
export function review(entry) {
    if (typeof window._showCCReviewModal !== 'function') return say('Statement review is not loaded yet.', 'warn');
    const row = entry.row;
    // A missing/invalid date or amount on an already-indexed row (e.g. reason
    // 'invalid-transaction') is a defect in ONE transaction, not proof the
    // statement's layout is unread — mapLayout() re-teaches the whole layout,
    // and once any sibling row from the same source has already filed,
    // mapReviewLayout's replay guard rejects that unconditionally, leaving the
    // entry permanently stuck with no explanation. The single-row modal below
    // already renders editable date/amount inputs, so the fix is to let the
    // owner correct or dismiss THIS row here, the same as any other review.
    if (!row || entry.index < 0) return mapLayout(entry);
    overlay?.remove(); overlay = null;
    // review() used to hand off to the global modal with no guard: a throw
    // there (malformed row data, the modal builder itself) unwound through the
    // caller's bare `await review(entry)` as an unhandled rejection — nothing
    // shown, the button just re-enabled, which looks exactly like "I clicked
    // it and nothing happened." mapLayout() above already fails this safely;
    // this brings review() to the same standard.
    try {
        window._showCCReviewModal({ transactions: [{ ...row, description: row.description || row.narration, _needsReview: true, _reviewWhy: reviewReasonText(entry.reason) }],
            fileName: 'Cloud statement review', card_last4: row.card_last4 || '',
            cloudReview: async decisions => {
                if (decisions.length !== 1) throw new Error('review-selection-required');
                const choice = decisions[0];
                const result = await request('/api/statement-sync', 'POST', { action: 'review', id: entry.id, row: choice.row, decision: choice.decision });
                if (result.resolved !== true) throw new Error('review-not-resolved');
                say('Statement review saved securely.', 'success'); return result;
            } }, row.bank || 'Bank', null);
    } catch {
        say('This review could not be opened. It remains pending; try again or download the original statement.', 'error');
        openReview();
    }
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
    const summary = document.createElement('p');
    summary.textContent = `${pending.length} review item${pending.length === 1 ? '' : 's'} shown${state.queued ? ` · ${state.queued} statement${state.queued === 1 ? '' : 's'} still processing automatically` : ' · processing queue is clear'}.`;
    summary.style.cssText = 'margin:12px 0;color:var(--text2);'; box.appendChild(summary);
    if (!pending.length) { const p = document.createElement('p'); p.textContent = 'No transactions are awaiting review.'; box.appendChild(p); }
    for (const entry of pending) {
        const item = document.createElement('div'); item.style.cssText = 'padding:14px 0;border-bottom:1px solid var(--border);';
        const identity = [entry.bank, entry.filename].filter(Boolean).join(' · ');
        const description = entry.row?.description || entry.row?.narration || '';
        const text = document.createElement('p');
        text.textContent = [entry.row?.date || (entry.receivedMs && new Date(entry.receivedMs).toLocaleDateString()) || 'Date ?', identity || 'Statement', description].filter(Boolean).join(' · ');
        item.appendChild(text);
        // Row-level reasons (validateSettlementRow/classifySlice) get the plain-
        // language text; whole-statement reasons keep their existing display —
        // reviewReasonText()'s vocabulary is scoped to the former only, and a
        // generic "this transaction needs confirmation" fallback would misdescribe
        // an unmapped layout, which is not about any one transaction at all.
        const rowLevel = Boolean(entry.row) && entry.index >= 0;
        const why = document.createElement('p'); why.textContent = rowLevel ? reviewReasonText(entry.reason) : String(entry.reason || 'Verification required'); item.appendChild(why);
        // Mirrors review()'s own routing decision exactly, so the label never
        // promises an action (re-teaching a whole layout) that a per-row defect
        // like an invalid amount cannot actually complete.
        const button = document.createElement('button'); button.className = 'btn btn-primary btn-sm'; button.textContent = !entry.row || entry.index < 0 ? 'Map statement layout' : 'Review'; button.onclick = async () => { button.disabled = true; try { await review(entry); } catch { say('This review could not be opened. It remains pending.', 'error'); } finally { button.disabled = false; } }; item.appendChild(button);
        const raw = document.createElement('button'); raw.className = 'btn btn-secondary btn-sm'; raw.textContent = 'Download original'; raw.style.marginLeft = '8px'; raw.onclick = () => download(entry); item.appendChild(raw); box.appendChild(item);
        if (entry.index < 0 || !entry.row?.amount) { const dismiss = document.createElement('button'); dismiss.className = 'btn btn-ghost btn-sm'; dismiss.textContent = 'Dismiss statement'; dismiss.style.marginLeft = '8px'; dismiss.onclick = () => dismissReview(entry); item.appendChild(dismiss); }
    }
    if (pending.length === 500) { const p = document.createElement('p'); p.textContent = 'Showing the first 500 pending reviews. Resolve items to reveal any older remainder.'; box.appendChild(p); }
    overlay.appendChild(box);
}
export function openReview() {
    adoptUser(currentUser());
    if (!currentUser()) return say('Sign in to review cloud statements.', 'warn');
    overlay?.remove(); overlay = document.createElement('div'); overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:99990;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;';
    document.body.appendChild(overlay); drawReview();
}
if (typeof window !== 'undefined') {
    window.addEventListener('wf-statement-cloud', () => {
        const text = document.getElementById('_statement_cloud_status');
        if (text) text.textContent = state.error ? 'Background statement sync needs attention. Retry saving or syncing.' : state.syncing ? 'Processing statements in the background…' : state.saved ? `Private cloud vault saved · ${state.reviews} transactions need review.` : state.configured === false ? 'Cloud processing is not configured. Device processing is available.' : 'Save your statement passwords to enable background decryption.';
    });
    window.WFStatementCloud = { authChanged, save, remove, sync, status, openReview, friendly, migrateUnlockedVault, getState, reviewSummary };
    const start=()=>{
        if (authBound) return;
        if (window.firebase?.apps?.length && typeof window.firebase.auth === 'function') {
            authBound=true;
            window.firebase.auth().onAuthStateChanged(next => authChanged(next));
            return;
        }
        if(++authAttempts<300)setTimeout(start,100);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true }); else start();
}
