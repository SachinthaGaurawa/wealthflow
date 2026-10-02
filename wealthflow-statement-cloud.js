let coverage=null,user=null,unsubscribe=null,pending=[],syncPromise=null,overlay=null,authBound=false,authAttempts=0,continuationTimer=null,retrying=[],autoTimer=null,autoRunning=false;
const state={configured:null,saved:false,count:0,savedAt:null,syncing:false,error:'',reviews:0,queued:0,parked:0};

export const getState=()=>({...state});
export const retryAttemptsSummary=()=>retrying.map(r=>({bank:r.bank||'',filename:r.filename||'',retryCount:r.retryCount||0,lastRetryReason:r.lastRetryReason||''}));
export function reviewSummary(){
    const byReason={}; let wholeStatement=0,perRow=0;
    for(const entry of pending){
        const reason=String(entry.reason||'unknown');
        byReason[reason]=(byReason[reason]||0)+1;
        if(entry.index<0||!entry.row)wholeStatement++;else perRow++;
    }
    const wholeStatements=pending.filter(e=>e.index<0||!e.row).slice(0,20).map(e=>({bank:e.bank||'',filename:e.filename||'',reason:e.reason||'',...(Array.isArray(e.embeddedProblems)&&e.embeddedProblems.length?{embedded:e.embeddedProblems.slice(0,12)}:{})}));
    return {total:pending.length,wholeStatement,perRow,byReason,wholeStatements,...(coverage?{coverage:coverageSummary()}:{})};
}
// Which months of which statement the mailbox has not given us, and what the search for them found —
// outcomes only, so the owner can share it without an address or an amount in it.
/** Per sender address: how many distinct emails, and where each is (from the state table). [] until the first sync has reported. */
export function senderFunnel(){return Array.isArray(coverage?.table?.senders)?coverage.table.senders:[]}

export function coverageSummary(){
    if(!coverage)return null;
    const tally=(list,key)=>(list||[]).reduce((o,e)=>{o[e[key]]=(o[e[key]]||0)+1;return o},{});
    return {missing:coverage.missing||0,closedEmpty:(coverage.empties||[]).length,at:coverage.at||0,audit:coverage.audit||null,refused:(coverage.refused||[]).map(r=>r.reason),security:(coverage.security||[]).length,table:coverage.table?{total:coverage.table.total,counts:coverage.table.counts}:null,log:{status:tally(coverage.log,'status'),math:tally(coverage.log,'math')},series:(coverage.series||[]).map(s=>({label:s.label||s.bank||'',first:s.first,last:s.last,missing:s.missing||[],gaps:(s.gaps||[]).map(g=>({month:g.month,outcomes:(g.mail||[]).map(m=>m.outcome)}))}))};
}
const GAP_TEXT={missed:'found in Gmail — being filed now',stored:'already stored','a-new-address-at-a-bank-you-approved':'a new sender address — approve it in Settings → Statement senders','sender-not-on-your-list':'sender not on your list — approve it in Settings → Statement senders','dkim-did-not-pass':'the sender could not be verified','signed-by-a-different-domain':'the sender could not be verified','the-attachment-is-not-a-bank-statement':'the attachment looked like an invoice or receipt','no-pdf-attachment':'no statement attached','attachment-over-the-size-ceiling':'attachment too large'};

const say=(message,type='info')=>{if(window.notify)window.notify(message,type)};
function change(){window.dispatchEvent(new CustomEvent('wf-statement-cloud',{detail:{...state}}))}
function sdkUser(){try{return typeof window.firebase?.auth==='function'?window.firebase.auth().currentUser:null;}catch(_){return null;}}
function currentUser(){return user||sdkUser();}

// Statements are filed by the server, into the same user document the app reads. Pulling that
// document through the app's ONE cloud applier (per-record newest-wins, tombstoned deletes)
// puts the filed rows on screen without a reload; nothing here touches local tombstones, because
// clearing them would bring every record the owner deleted back.
async function refreshFinancialData(){
    const active=currentUser(),db=window.db||window.firebase?.firestore?.();
    if(!active?.uid||!db||typeof window._wfApplyCloudData!=='function')return false;
    const snap=await db.collection('users').doc(active.uid).get({source:'server'});
    if(!snap.exists)return false;
    const applied=window._wfApplyCloudData(snap.data());
    if(applied?.nonSessionChanged){
        const page=document.querySelector('.page.active');
        if(page&&typeof window.renderPage==='function')window.renderPage(page.id.replace('page-',''));
        try{window.updateCCOTBadge?.()}catch(_){}
        try{window.updateChequeBadge?.()}catch(_){}
    }
    return true;
}

function adoptUser(next){
    if(!next||user?.uid===next.uid)return user;
    user=next;unsubscribe?.();unsubscribe=null;pending=[];state.reviews=0;
    const db=window.db||window.firebase?.firestore?.();
    if(db)unsubscribe=db.collection('users').doc(user.uid).collection('statementReview').where('status','==','pending').limit(500).onSnapshot(s=>{pending=s.docs.map(d=>({...d.data(),id:d.id}));state.reviews=pending.length;change();if(overlay)drawReview();scheduleAutoRender()},()=>{state.error='statement-review-unavailable';change()});
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
    }catch(error){
        if(error?.name==='AbortError')throw new Error('statement-request-timed-out');
        if(error instanceof TypeError)throw new Error('statement-service-unavailable');
        throw error;
    }
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
    sync().catch(() => {}); return result;
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
        // a 202 ("accepted, still working") carries no counts: the last known ones stand, and the next answer replaces them
        if(!result.partial&&!result.accepted){state.queued=Math.max(0,Number(result.pendingRemaining)||0)+Math.max(0,Number(result.processingRemaining)||0);state.parked=Math.max(0,Number(result.deadLettered)||0);retrying=Array.isArray(result.retrying)?result.retrying:[]}
        if(result.coverage&&typeof result.coverage==='object')coverage=result.coverage;
        if(result.morePending)again(Math.max(750,Math.min(180250,Number(result.retryAfterMs)||750)))
        return result
    }).catch(e=>{state.error=e.message;if(e.message==='statement-request-timed-out')again(3000);throw e})
        .finally(()=>{state.syncing=false;syncPromise=null;change()});
    return syncPromise
}

export async function authChanged(next){
    if(user?.uid===next?.uid&&next)return;
    unsubscribe?.();unsubscribe=user=null;pending=[];coverage=null;state.reviews=0;
    Object.assign(state,{configured:null,saved:false,count:0,savedAt:null,error:'',queued:0});change();
    if(!next){clearTimeout(continuationTimer);continuationTimer=null;clearTimeout(autoTimer);autoTimer=null;overlay?.remove();overlay=null;return}
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

const LAYOUT_CONFIRM_RETRYABLE_REASONS = new Set(['statement-request-timed-out', 'statement-service-unavailable']);
const LAYOUT_CONFIRM_RETRIES = 2;
const confirmLayout = (entry, rows) => confirmWithRetry({ action: 'layout', id: entry.id, rows });
async function confirmWithRetry(body) {
    for (let attempt = 0; ; attempt += 1) {
        try {
            const result = await request('/api/statement-sync', 'POST', body);
            if (result.mapped !== true) throw new Error('layout-not-mapped');
            let filed=Math.max(0,Number(result.filed)||0),review=Math.max(0,Number(result.review)||0),current=result;
            
            // A long statement is filed in batches. A batch that filed nothing
            // and raised nothing (the statement is waiting out a retry, or
            // another worker holds it) is not progress: after three in a row
            // stop asking — the background queue carries on — instead of
            // sending a hundred requests at a source that cannot move.
            let idle=0;
            for(let batch=0;current.replayStatus==='pending'&&idle<3&&batch<100;batch+=1){
                current=await request('/api/statement-sync','POST',{action:'layout-continue',id:body.id});
                const moved=Math.max(0,Number(current.filed)||0)+Math.max(0,Number(current.review)||0);
                filed+=Math.max(0,Number(current.filed)||0);review+=Math.max(0,Number(current.review)||0);
                idle=moved?0:idle+1;
            }
            if(current.replayStatus==='pending'&&idle<3)throw new Error('statement-continuation-limit');
            result.filed=filed;result.review=review;result.queued=current.queued===true;result.replayStatus=current.replayStatus;
            return result;
        } catch (error) {
            if (error?.message === 'layout-replay-would-overlap-settled-data' || error?.message === 'whole-statement-review-required') {
                error.mightAlreadyBeMapped = true; throw error;
            }
            if (attempt >= LAYOUT_CONFIRM_RETRIES || !LAYOUT_CONFIRM_RETRYABLE_REASONS.has(error?.message)) throw error;
            await new Promise(resolve => setTimeout(resolve, 1500 * (attempt + 1)));
        }
    }
}
async function gzipToB64(text) {
    const packed = new Uint8Array(await new Response(new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    let binary = '';
    for (let i = 0; i < packed.length; i += 0x8000) binary += String.fromCharCode.apply(null, packed.subarray(i, i + 0x8000));
    return btoa(binary);
}
async function gunzipFromB64(encoded) {
    const packed = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    return new Response(new Blob([packed]).stream().pipeThrough(new DecompressionStream('gzip'))).text();
}
// Reasons that mean "this route cannot read that statement", so the ordinary
// text-based layout teacher gets its turn instead of a dead end.
const RENDER_FALLBACK_REASONS = new Set(['rendered-source-not-html', 'rendered-source-too-large', 'rendered-statement-invalid', 'rendered-statement-has-no-rows']);
const RENDER_TRANSIENT_REASONS = new Set(['statement-request-timed-out', 'statement-service-unavailable']);
// Mirrors RENDERED_VERSION in statement-sync.js: a review marked by an OLDER
// reader (renderedRead: true, i.e. 1) carries text that reader got wrong.
const RENDERED_VERSION = 3;
const canRender = entry => !(Number(entry.renderedRead) >= RENDERED_VERSION) && /\.html?$/i.test(entry.filename || '')
    && typeof window.WFHtmlStatement?.htmlToTransactionsAsync === 'function'
    && typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
// A Smart Statement (NTB / American Express e-statements) draws its rows with
// its own JavaScript, which the server has no browser to run. The device does
// exactly that for a file uploaded by hand (wealthflow-html-statement.js's
// sandboxed renderer) — this gives an emailed statement the same reading: the
// server decrypts it, this device renders it, and the rendered document goes
// back to be read and validated like any other statement. Never throws.
// status: unavailable | fallback (this route cannot read it) | transient |
//         submitted | needs-layout | failed
async function renderAndSubmit(entry) {
    // renderedRead: this statement was already read on this route and only
    // needs the owner to confirm its rows — the layout teacher, which now
    // receives the rendered rows. Rendering it again would loop forever.
    if (!canRender(entry)) return { status: 'unavailable' };
    const reader = window.WFHtmlStatement;
    let read;
    try {
        const source = await request('/api/statement-sync', 'POST', { action: 'render-source', id: entry.id });
        if (typeof source.htmlGz !== 'string' || !source.htmlGz) return { status: 'fallback' };
        read = await reader.htmlToTransactionsAsync(await gunzipFromB64(source.htmlGz));
    } catch (error) { return { status: RENDER_TRANSIENT_REASONS.has(error?.message) ? 'transient' : 'fallback' }; }
    // Shape only (counts, digits masked) — what "Copy diagnostics" needs when a
    // statement still cannot be read, never an amount or a merchant.
    try {
        (window._wfLayoutAttempts = window._wfLayoutAttempts || []).unshift({ bank: String(entry.bank || ''), at: Date.now(), outcome: read?.rendered ? 'rendered-on-device' : 'render-produced-nothing',
            diag: read?.rendered && typeof reader.diagnose === 'function' ? reader.diagnose(read.renderedHtml, { rendered: true, renderedRows: read.transactions?.length || 0, report: read.report }) : null });
        window._wfLayoutAttempts.length = Math.min(window._wfLayoutAttempts.length, 15);
    } catch (_) {}
    // No transactions read is still worth sending: a month with none is a real
    // statement, and only the server can tell that from a page that failed to
    // draw (it does, from the statement's own balances).
    if (!read?.rendered || !read.renderedHtml) return { status: 'fallback' };
    try {
        const result = await confirmWithRetry({ action: 'rendered', id: entry.id, htmlGz: await gzipToB64(read.renderedHtml) });
        try { if (result.why && window._wfLayoutAttempts?.[0]) window._wfLayoutAttempts[0].server = result.why; } catch (_) {}
        return { status: result.needsLayout === true ? 'needs-layout' : 'submitted', result };
    } catch (error) {
        if (RENDER_FALLBACK_REASONS.has(error?.message)) return { status: 'fallback' };
        return { status: RENDER_TRANSIENT_REASONS.has(error?.message) ? 'transient' : 'failed', error };
    }
}
// A statement that is already part-filed, or whose review is stale, cannot have a layout mapped over it without risking a second filing of its
// rows (the server refuses, and this used to end in "may already be read"). It is resumed instead, from its first row: every row already filed
// is checked, never filed twice. True when the server dealt with it (said, unless quiet).
const RESUME_FIRST = new Set(['statement-cursor-or-content-changed', 'statement-retries-exhausted']);
async function resumeStatement(entry, { quiet = false } = {}) {
    try {
        // `auto`: the app's silent attempt (once per replay version, server side); the owner's tap always goes.
        const r = await request('/api/statement-sync', 'POST', { action: 'resume-review', id: entry.id, ...(quiet ? { auto: true } : {}) });
        if (!quiet) {
            // a replay that stopped again is not "being finished"
            const stopped = r.resumed && (r.replayStatus === 'needs_review' || r.replayStatus === 'dead_letter');
            if (stopped) say(`${r.filed > 0 ? `${r.filed} more transaction${r.filed === 1 ? '' : 's'} filed, but the statement` : 'The statement'} stopped again. ${WHOLE_TEXT[r.replayReason] || 'It still needs a look.'} Nothing was lost and nothing is filed twice.`, 'warn');
            else if (r.resumed) say(r.filed > 0 ? `${r.filed} more transaction${r.filed === 1 ? '' : 's'} filed. The rest of this statement is being finished from where it stopped; nothing is filed twice.` : 'This statement is being finished from where it stopped; nothing is filed twice.', 'success');
            else say(r.state === 'filed' ? 'This statement is already filed, so its review is closed.' : r.state === 'busy' ? 'WealthFlow is working on this statement right now.' : 'This review was already handled.', 'info');
            overlay?.remove(); overlay = null;
        }
        if (r.resumed || r.state === 'filed') { await refreshFinancialData().catch(() => {}); if (!quiet) await sync().catch(() => {}); }
        return true;
    } catch (_) { return false; }
}
// Resolves true only when it took the statement all the way to the server.
async function mapRenderedStatement(entry) {
    if (!canRender(entry)) return false;
    say('Reading this statement on your device…', 'info');
    const { status, result, error } = await renderAndSubmit(entry);
    // needs-layout: read fine, but the statement-wide total does not reconcile.
    // Show the owner the rows it found and let them confirm the reading — the
    // same review an uploaded statement gets — instead of a dead-end message.
    if (status === 'fallback' || status === 'needs-layout' || status === 'unavailable') return false;
    if (status === 'submitted') {
        if (result.filed > 0 && result.review === 0) say(`${result.filed} statement transaction${result.filed === 1 ? '' : 's'} read on your device and filed.`, 'success');
        else if (result.filed > 0) say(`${result.filed} transaction${result.filed === 1 ? '' : 's'} filed; ${result.review} still need${result.review === 1 ? 's' : ''} review.`, 'warn');
        else if (result.replayStatus === 'filed') say('This statement has no transactions — its balances did not change — so there was nothing to file.', 'info');
        else if (result.replayStatus === 'needs_review') say('The statement was read on your device, but its transactions need your confirmation. Open the review and map its layout.', 'warn');
        else say('Statement read on your device. The remaining rows are continuing in the background.', 'info');
        overlay?.remove(); overlay = null;
        await refreshFinancialData().catch(() => {});
        await sync().catch(() => say('The statement was read, but the immediate processing request failed. It remains queued for retry.', 'warn'));
    } else if (!(error?.mightAlreadyBeMapped && await resumeStatement(entry))) {
        say(error?.mightAlreadyBeMapped
            ? 'This may already be read from an earlier attempt — check Open reviews for its current status before mapping it again.'
            : 'Reading this statement on your device was not completed. The original statement remains pending.', error?.mightAlreadyBeMapped ? 'warn' : 'error');
    }
    openReview();
    return true;
}
// AUTONOMOUS: nobody should have to tap "Map statement layout" once per emailed
// Smart Statement. Whenever this device holds pending HTML statements, it reads
// them itself, one at a time — the server already has the passwords, this
// device has the browser. A statement this route cannot read is not retried for
// a day; one that only failed on the network is retried on the next snapshot.
const AUTO_TRIED_KEY = 'wf_render_tried_v3', AUTO_RETRY_MS = 86400000, AUTO_FAILED_RETRY_MS = 600000, AUTO_BATCH = 25;
const triedMap = () => { try { return JSON.parse(window.localStorage?.getItem?.(AUTO_TRIED_KEY) || '{}') || {}; } catch (_) { return {}; } };
// A page the device could not draw is retried tomorrow; a rendering the SERVER refused, in ten minutes (a fix must not wait a day). Stored shifted.
function markTried(id, retryMs = AUTO_RETRY_MS) {
    try {
        const tried = { ...triedMap(), [id]: Date.now() - (AUTO_RETRY_MS - retryMs) }, ids = Object.keys(tried);
        if (ids.length > 200) ids.sort((a, b) => tried[a] - tried[b]).slice(0, ids.length - 200).forEach(key => delete tried[key]);
        window.localStorage?.setItem?.(AUTO_TRIED_KEY, JSON.stringify(tried));
    } catch (_) {}
}
const autoCandidates = () => { const tried = triedMap(), now = Date.now(); return pending.filter(entry => entry.index < 0 && canRender(entry) && !(tried[entry.id] && now - tried[entry.id] < AUTO_RETRY_MS)); };
function scheduleAutoRender() {
    if (autoTimer || autoRunning || !currentUser() || !autoCandidates().length) return;
    autoTimer = setTimeout(() => { autoTimer = null; autoRenderPending().catch(() => {}); }, 4000);
}
export async function autoRenderPending() {
    if (autoRunning) return { statements: 0, filed: 0, needLayout: 0, empty: 0 };
    autoRunning = true;
    const done = { statements: 0, filed: 0, needLayout: 0, empty: 0 };
    try {
        for (const entry of autoCandidates().slice(0, AUTO_BATCH)) {
            if (!currentUser() || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) break;
            const { status, result, error } = await renderAndSubmit(entry);
            if (status === 'failed' && error?.mightAlreadyBeMapped) await resumeStatement(entry, { quiet: true });
            if (status === 'fallback') markTried(entry.id); else if (status === 'failed') markTried(entry.id, AUTO_FAILED_RETRY_MS);
            if (status === 'transient' || status === 'unavailable') break;
            if (status === 'submitted') { done.statements += 1; done.filed += Math.max(0, Number(result.filed) || 0); if (result.replayStatus === 'filed' && !result.filed) done.empty += 1; }
            if (status === 'needs-layout') done.needLayout += 1;
        }
        if (done.filed > 0) say(`${done.filed} statement transaction${done.filed === 1 ? '' : 's'} read on your device and filed automatically.`, 'success');
        if (done.empty > 0) say(`${done.empty} statement${done.empty === 1 ? ' had' : 's had'} no transactions and ${done.empty === 1 ? 'was' : 'were'} closed.`, 'info');
        if (done.needLayout > 0) say(`${done.needLayout} statement${done.needLayout === 1 ? ' was' : 's were'} read on your device but need${done.needLayout === 1 ? 's' : ''} your confirmation. Open the review to confirm.`, 'warn');
        if (done.statements + done.needLayout > 0) await refreshFinancialData().catch(() => {});
    } finally { autoRunning = false; }
    return done;
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleAutoRender(); });
async function mapLayout(entry) {
    if (RESUME_FIRST.has(entry.reason) && await resumeStatement(entry)) { openReview(); return; }
    if (await mapRenderedStatement(entry)) return;
    if (typeof window._teachStatementLayout !== 'function') return say('The statement layout mapper is not loaded yet.', 'warn');
    try {
        const source = await request('/api/statement-sync', 'POST', { action: 'review-source', id: entry.id });
        if (!source.text || typeof source.text !== 'string') throw new Error('statement-text-unavailable');
        overlay?.remove(); overlay = null;
        window._teachStatementLayout([{ key: entry.id, text: source.text, bank: source.bank || 'Bank', fileName: source.filename || 'Statement', index: 0, last4: source.last4 || '' }], async learned => {
            if (!learned?.[0]?.rows?.length) { say('No complete layout was confirmed. The statement remains in Needs Review.', 'warn'); openReview(); return; }
            try {
                const result = await confirmLayout(entry, learned[0].rows);
                if (result.filed > 0 && result.review === 0) say(`${result.filed} statement transaction${result.filed === 1 ? '' : 's'} verified and filed.`, 'success');
                else if (result.review > 0) say(`The layout was saved, but ${result.review} transaction${result.review === 1 ? '' : 's'} still need${result.review === 1 ? 's' : ''} review before filing.`, 'warn');
                else if (result.queued === true) say('Statement layout verified. Remaining rows are continuing in the background.', 'info');
                else say('The layout was saved, but no transaction was filed. Check the review queue for the blocking evidence.', 'warn');
                
                await refreshFinancialData().catch(() => {});
                await sync().catch(() => say('The layout is saved, but the immediate processing request failed. Its queued statement remains pending for retry.', 'warn'));
            } catch (error) {
                if (!(error?.mightAlreadyBeMapped && await resumeStatement(entry))) say(error?.mightAlreadyBeMapped
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

// Why a WHOLE statement is waiting, in words (the row-level reasons are below).
const WHOLE_TEXT = {
    'statement-empty-needs-confirmation': 'This month looks like it had no transactions, but the statement does not say so clearly. Check the original and confirm.',
    'statement-layout-or-reconciliation-needs-review': "The rows could not be proven to add up to this statement's balances, so nothing was filed from it.",
    'statement-layout-identity-needs-review': 'WealthFlow could not confirm this document is a bank statement.',
    'statement-retries-exhausted': 'This statement could not be processed after many automatic tries over a day and a half (the reason is on record). It is still here, from where it stopped — open it to read it yourself.',
    'statement-currency-differs': 'This statement is in a different currency from your account, so none of it was filed (its figures would have been counted as your own currency). Check the original.',
    'statement-cursor-or-content-changed': 'This statement read differently the second time, so it was stopped part-way. Rows already filed are kept and checked; open it to finish it from where it stopped.',
};
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
    if (!row || entry.index < 0) return mapLayout(entry);
    overlay?.remove(); overlay = null;
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
    const title = document.createElement('h3'); title.textContent = pending.length ? 'Statements needing review' : 'Your email bank statements'; box.appendChild(title);
    const close = document.createElement('button'); close.className = 'btn btn-secondary'; close.textContent = 'Close'; close.onclick = () => { overlay.remove(); overlay = null; }; box.appendChild(close);
    const summary = document.createElement('p');
    summary.textContent = `${pending.length} review item${pending.length === 1 ? '' : 's'} shown${state.queued ? ` · ${state.queued} statement${state.queued === 1 ? '' : 's'} still processing automatically` : ' · processing queue is clear'}.`;
    summary.style.cssText = 'margin:12px 0;color:var(--text2);'; box.appendChild(summary);
    const panel = head => { const d = document.createElement('div'); d.style.cssText = 'margin:0 0 12px;padding:12px;border:1px solid var(--border);border-radius:12px;'; const h = document.createElement('strong'); h.textContent = head; d.appendChild(h); box.appendChild(d); return d; };
    const note = (parent, text) => { const p = document.createElement('p'); p.style.cssText = 'margin:6px 0 0;font-size:13px;'; p.textContent = text; parent.appendChild(p); return p; };
    if (coverage?.grid?.length) { const held = panel('Statements in your books'); for (const line of coverage.grid) note(held, line); }
    const a = coverage?.audit;
    if (a?.at) note(panel('Mailbox history check'), `${new Date(a.at).toLocaleString()} · ${a.listed} bank email${a.listed === 1 ? '' : 's'} with attachments found · ${a.accounted} already accounted for · ${a.taken} added now · ${a.refused} refused · ${a.held} waiting on a sender decision${a.complete ? '' : ' · still checking'}`);
    const table = coverage?.table;
    if (table?.total) {
        const C = table.counts || {};
        const box = panel(`Every email from your banks · ${table.total}`);
        note(box, `${C.INGESTED || 0} in your ledger · ${C.PROCESSED || 0} stored, being read · ${C.REVIEW || 0} in review · ${C.PENDING || 0} just found · ${C.HELD || 0} waiting on a sender decision · ${C.REFUSED || 0} not statements · ${C.FAILED_VERIFICATION || 0} forged`);
        for (const r of table.senders || []) note(box, `${r.address}: ${r.total} email${r.total === 1 ? '' : 's'} — ${r.INGESTED} ingested${r.PROCESSED ? `, ${r.PROCESSED} being read` : ''}${r.REVIEW ? `, ${r.REVIEW} in review` : ''}${r.HELD ? `, ${r.HELD} held` : ''}${r.REFUSED ? `, ${r.REFUSED} not statements` : ''}${r.FAILED_VERIFICATION ? `, ${r.FAILED_VERIFICATION} forged` : ''}`);
        if (table.stuckCount) note(box, `${table.stuckCount} not finished yet — each is retried automatically.`);
        if (state.parked) note(box, `${state.parked} statement${state.parked === 1 ? ' is' : 's are'} paused after repeated failures and put back automatically (after 15 minutes, then 1, 6 and 24 hours), from where ${state.parked === 1 ? 'it' : 'they'} stopped. None is dropped.`);
    }
    if (coverage?.refused?.length) {
        const refusedBox = panel(`${coverage.refused.length} email${coverage.refused.length === 1 ? '' : 's'} from your banks that were not taken`);
        for (const r of coverage.refused) {
            const line = note(refusedBox, `${r.receivedMs ? new Date(r.receivedMs).toLocaleDateString() : ''} · ${r.from} · ${r.filename || r.subject}: ${r.text} `);
            if (r.takeable === false) continue;
            const take = document.createElement('button'); take.className = 'btn btn-ghost btn-sm'; take.textContent = r.asked ? 'Queued' : 'Take it'; take.disabled = !!r.asked;
            take.onclick = async () => { take.disabled = true; try { await request('/api/statement-sync', 'POST', { action: 'take-refused', messageId: r.messageId }); r.asked = true; say('Queued — it will be read and must reconcile before it is filed.', 'info'); drawReview(); await sync(); } catch { take.disabled = false; say('That email could not be queued.', 'error'); } };
            line.appendChild(take);
        }
    }
    if (coverage?.security?.length) {
        const box = panel(`${coverage.securityCount || coverage.security.length} email${(coverage.securityCount || coverage.security.length) === 1 ? '' : 's'} blocked as forged or unauthenticated`);
        note(box, 'These claimed to come from your bank but failed the sender checks. They were dropped and nothing in them was read. They cannot be taken.');
        for (const r of coverage.security) note(box, `${r.receivedMs ? new Date(r.receivedMs).toLocaleDateString() : ''} · ${r.from} · ${r.subject}: ${r.text}${r.checks?.why ? ' (' + r.checks.why + ')' : ''}`);
    }
    const holes = (coverage?.series || []).filter(s => s.missing?.length);
    if (holes.length) {
        const gap = panel(`${coverage.missing} statement month${coverage.missing === 1 ? '' : 's'} not in your mailbox yet`);
        note(gap, 'If the bank never sent it, download that month from the bank and import it by hand.');
        for (const s of holes) for (const m of s.missing) {
            const line = document.createElement('p'); line.style.cssText = 'margin:6px 0 0;font-size:13px;';
            const mail = (s.gaps || []).find(g => g.month === m)?.mail;
            line.textContent = `${s.label || s.bank} · ${m}: ` + (!mail ? 'searching…' : mail.length ? mail.map(x => GAP_TEXT[x.outcome] || x.outcome).join('; ') : 'no email from this bank arrived that month');
            gap.appendChild(line);
        }
    }
    if (coverage?.empties?.length) {
        const closed = panel('Closed automatically — the bank\'s own figures show nothing moved');
        for (const e of coverage.empties) {
            const line = note(closed, `${e.month || ''} · ${e.label}${e.how ? ' — ' + e.how : ''} `);
            const reopen = document.createElement('button'); reopen.className = 'btn btn-ghost btn-sm'; reopen.textContent = 'Reopen';
            reopen.onclick = async () => { reopen.disabled = true; try { await request('/api/statement-sync', 'POST', { action: 'reopen-empty', id: e.id }); coverage.empties = coverage.empties.filter(x => x.id !== e.id); say('Reopened — it will be read again and sent to review.', 'info'); drawReview(); await sync(); } catch { reopen.disabled = false; say('That statement could not be reopened.', 'error'); } };
            line.appendChild(reopen);
        }
    }
    if (coverage?.log?.length) {
        const d = document.createElement('details'); d.style.cssText = 'margin:0 0 12px;'; const sm = document.createElement('summary'); sm.textContent = `Statement audit log (${coverage.log.length})`; d.appendChild(sm);
        for (const e of coverage.log) note(d, `${e.month || '?'} · ${e.bank} · ${e.file} · ${e.status} · maths ${e.math}${e.last4 ? ' · …' + e.last4 : ''}${e.sha ? ' · ' + e.sha : ''}`);
        box.appendChild(d);
    }
    if (!pending.length) { const p = document.createElement('p'); p.textContent = 'No transactions are awaiting review.'; box.appendChild(p); }
    for (const entry of pending) {
        const item = document.createElement('div'); item.style.cssText = 'padding:14px 0;border-bottom:1px solid var(--border);';
        const identity = [entry.bank, entry.filename].filter(Boolean).join(' · ');
        const description = entry.row?.description || entry.row?.narration || '';
        const text = document.createElement('p');
        text.textContent = [entry.row?.date || (entry.receivedMs && new Date(entry.receivedMs).toLocaleDateString()) || 'Date ?', identity || 'Statement', description].filter(Boolean).join(' · ');
        item.appendChild(text);
        const rowLevel = Boolean(entry.row) && entry.index >= 0;
        const why = document.createElement('p'); why.textContent = rowLevel ? reviewReasonText(entry.reason) : (WHOLE_TEXT[entry.reason] || String(entry.reason || 'Verification required')); item.appendChild(why);
        const button = document.createElement('button'); button.className = entry.reason === 'statement-empty-needs-confirmation' ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'; button.textContent = !entry.row || entry.index < 0 ? 'Map statement layout' : 'Review'; button.onclick = async () => { button.disabled = true; try { await review(entry); } catch { say('This review could not be opened. It remains pending.', 'error'); } finally { button.disabled = false; } }; item.appendChild(button);
        const raw = document.createElement('button'); raw.className = 'btn btn-secondary btn-sm'; raw.textContent = 'Download original'; raw.style.marginLeft = '8px'; raw.onclick = () => download(entry); item.appendChild(raw); box.appendChild(item);
        if (entry.index === -1 && entry.reason === 'statement-empty-needs-confirmation') {
            const empty = document.createElement('button'); empty.className = 'btn btn-primary btn-sm'; empty.textContent = 'Yes, nothing happened that month'; empty.style.marginLeft = '8px';
            empty.onclick = async () => { empty.disabled = true; try { await request('/api/statement-sync', 'POST', { action: 'close-empty', id: entry.id }); say('Closed as an empty month. You can reopen it from the list of closed months.', 'info'); await sync(); } catch { empty.disabled = false; say('That month could not be closed.', 'error'); } };
            item.appendChild(empty);
        }
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


/* ── ONE STATEMENT, ADDED ONCE: the manual-upload door of the statement registry (statement-registry.mjs, /api/statement-guard) ──
 * The server holds the lock and tells which door got there first; this only asks. A server that cannot be reached never stops the owner
 * from adding their own statement — the transaction-level matcher is still behind it — so every call here fails OPEN and says nothing. */
const hex=buf=>[...new Uint8Array(buf)].map(b=>b.toString(16).padStart(2,'0')).join('');
async function guardCall(body){
    try{const r=await request('/api/statement-guard','POST',body);return r}
    catch(error){try{console.warn('[statement-guard] not checked:',error&&error.message)}catch(_){}return null}
}
/** SHA-256 of the file's bytes — the same hash the email sync records for the same file. '' when it cannot be made. */
export async function fileSha256(file){
    try{return hex(await crypto.subtle.digest('SHA-256',await file.arrayBuffer()))}catch(_){return ''}
}
/** The last four digits of the account a statement's text names ("Account No: 001-234-5678", "Card 4111 11XX XXXX 1234"); '' when it names none. */
export function accountTailOf(text){
    const t=String(text||'').slice(0,6000);
    const m=/(?:a\/c|acct|account|card)\s*(?:no|number|num|#)?\.?\s*[:.\-]?\s*([\dxX*•\- ]{6,40}\d{4})(?!\d)/i.exec(t)||/\d{6}[xX*•]+(\d{4})(?!\d)/.exec(t);
    return m?String(m[m.length-1]).replace(/\D+/g,'').slice(-4):'';
}
const noticeOf=r=>r&&r.duplicate===true?{duplicate:true,via:r.via||'',notice:r.notice||'Already Added'}:null;
/** Before anything is read: is this exact file already in the books? -> {duplicate, via, notice, sha} or {sha}. */
export async function guardFile(file){
    const sha=await fileSha256(file);
    if(!sha)return {sha:''};
    const r=noticeOf(await guardCall({action:'check',sha256:sha}));
    return r?{...r,sha}:{sha};
}
/** After the statement is read: is this bank + account + month already in the books? Returns {duplicate,...,info} or {info}; `info` goes to guardClaim at save. */
export async function guardParsed({sha='',bank='',last4='',periodText='',dates=[],filename='',size=0,rows=0}){
    const info={sha,bank:String(bank||''),last4:String(last4||''),periodText:String(periodText||''),dates:(dates||[]).slice(0,2000),filename:String(filename||'').slice(0,200),size:Number(size)||0,rows:Number(rows)||0,token:(crypto.randomUUID?crypto.randomUUID():String(Date.now())+Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9_-]/g,'').slice(0,64).padEnd(8,'0')};
    const r=noticeOf(await guardCall({action:'check',sha256:sha||undefined,bank:info.bank,last4:info.last4,periodText:info.periodText,dates:info.dates}));
    return r?{...r,info}:{info};
}
/** At save: take the statement. -> {duplicate, via, notice} when another door got there first, else null (go ahead). */
export async function guardClaim(info){
    if(!info)return null;
    return noticeOf(await guardCall({action:'claim',sha256:info.sha||undefined,bank:info.bank,last4:info.last4,periodText:info.periodText,dates:info.dates,filename:info.filename,size:info.size,rows:info.rows,token:info.token}));
}
/** Give a statement back (e.g. its records were deleted) so the same file or month can be added again. */
export async function guardRelease(id){const r=await guardCall({action:'release',id});return r?r.released||0:0}

if (typeof window !== 'undefined') {
    window.addEventListener('wf-statement-cloud', () => {
        const text = document.getElementById('_statement_cloud_status');
        if (text) text.textContent = state.error ? 'Background statement sync needs attention. Retry saving or syncing.' : state.syncing ? 'Processing statements in the background…' : state.saved ? `Private cloud vault saved · ${state.reviews} transactions need review.` : state.configured === false ? 'Cloud processing is not configured. Device processing is available.' : 'Save your statement passwords to enable background decryption.';
    });
    window.WFStatementCloud = { authChanged, save, remove, sync, status, openReview, friendly, migrateUnlockedVault, getState, reviewSummary, coverageSummary, retryAttemptsSummary, senderFunnel, guard: { file: guardFile, parsed: guardParsed, claim: guardClaim, release: guardRelease, accountTailOf } };
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
