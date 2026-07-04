/* =============================================================================
   WealthFlow Autonomous Module v1.0
   ---------------------------------------------------------------------------
   Client-side conductor for the robotic financial OS:

     • Card Registry (card_last4 → bank + type + name) stored in DB.settings
     • Pending-queue (IndexedDB) for offline self-healing
     • Manual + auto Predictive Wealth refresh
     • Apply-routed-transaction helper used by SMS ingestion + manual paste
     • FIFO reconciler dispatcher for "credit to CC" events
     • OCR receipt → SMS-match auto-linker

   All functions are attached to window so onclick handlers can reach them.
   ===========================================================================*/

(function () {
    'use strict';

    if (window.WF_AUTONOMOUS_LOADED) return;
    window.WF_AUTONOMOUS_LOADED = '1.0';

    // ────────────────────────────────────────────────────────────────────────
    // 1. Card Registry
    // ────────────────────────────────────────────────────────────────────────
    function getCardRegistry() {
        try {
            const s = (window.DB && DB.getObj && DB.getObj('settings')) || {};
            return s.cardRegistry || {};
        } catch (_) { return {}; }
    }
    function setCardRegistry(reg) {
        const s = (window.DB && DB.getObj && DB.getObj('settings')) || {};
        s.cardRegistry = reg;
        DB.set('settings', s);
        if (typeof window.syncToCloud === 'function') {
            try { syncToCloud(); } catch (_) {}
        }
        return reg;
    }
    function upsertCard(last4, fields) {
        last4 = String(last4 || '').trim();
        if (!/^\d{4}$/.test(last4)) {
            if (typeof window.notify === 'function') notify('Card last-4 must be exactly 4 digits', 'error');
            return null;
        }
        const reg = getCardRegistry();
        reg[last4] = Object.assign({}, reg[last4] || {}, fields, {
            last4, updated_at: Date.now()
        });
        setCardRegistry(reg);
        if (typeof window.notify === 'function') notify(`✓ Card •••${last4} saved`, 'success');
        return reg[last4];
    }
    function deleteCard(last4) {
        const reg = getCardRegistry();
        if (reg[last4]) { delete reg[last4]; setCardRegistry(reg); }
        return reg;
    }
    window.wfCardRegistry = { get: getCardRegistry, set: setCardRegistry, upsert: upsertCard, delete: deleteCard };

    // ────────────────────────────────────────────────────────────────────────
    // 2. Device Token — used by SMS forwarder to authenticate
    // ────────────────────────────────────────────────────────────────────────
    function getDeviceToken() {
        try {
            let tok = localStorage.getItem('wf_device_token');
            if (!tok) {
                const arr = new Uint8Array(24);
                crypto.getRandomValues(arr);
                tok = Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
                localStorage.setItem('wf_device_token', tok);
            }
            return tok;
        } catch (_) { return null; }
    }
    function rotateDeviceToken() {
        try { localStorage.removeItem('wf_device_token'); } catch (_) {}
        return getDeviceToken();
    }
    window.wfDeviceToken = { get: getDeviceToken, rotate: rotateDeviceToken };

    // ────────────────────────────────────────────────────────────────────────
    // 3. Offline queue using IndexedDB
    //    Stores pending SMS-ingest payloads while offline; replays on
    //    "online" + every 60s.
    // ────────────────────────────────────────────────────────────────────────
    const IDB_NAME = 'wfAutonomous';
    const IDB_VER = 1;
    function openIDB() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(IDB_NAME, IDB_VER);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('queue')) {
                    db.createObjectStore('queue', { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains('processed_hashes')) {
                    db.createObjectStore('processed_hashes', { keyPath: 'hash' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }
    async function enqueue(payload) {
        try {
            const db = await openIDB();
            return new Promise(res => {
                const tx = db.transaction('queue', 'readwrite');
                tx.objectStore('queue').add({ payload, queued_at: Date.now() });
                tx.oncomplete = () => res(true);
                tx.onerror = () => res(false);
            });
        } catch (_) { return false; }
    }
    async function drainQueue() {
        if (!navigator.onLine) return { drained: 0, remaining: -1 };
        let drained = 0;
        try {
            const db = await openIDB();
            const items = await new Promise(res => {
                const tx = db.transaction('queue', 'readonly');
                const out = [];
                tx.objectStore('queue').openCursor().onsuccess = (ev) => {
                    const c = ev.target.result;
                    if (c) { out.push({ key: c.key, value: c.value }); c.continue(); }
                    else res(out);
                };
            });
            for (const it of items) {
                try {
                    const r = await fetch('/api/sms-ingest', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json',
                                   'x-wf-device-token': getDeviceToken() },
                        body: JSON.stringify(it.value.payload)
                    });
                    if (r.ok) {
                        const data = await r.json();
                        if (data.ok && data.classified) {
                            await applyBrainResult(data);
                        }
                        // Remove from queue regardless of classification (we tried)
                        await new Promise(res => {
                            const tx = db.transaction('queue', 'readwrite');
                            tx.objectStore('queue').delete(it.key);
                            tx.oncomplete = res;
                        });
                        drained++;
                    }
                } catch (e) { /* leave in queue, try later */ }
            }
        } catch (e) { /* idb failed */ }
        return { drained };
    }
    async function alreadyProcessed(hash) {
        try {
            const db = await openIDB();
            return new Promise(res => {
                const tx = db.transaction('processed_hashes', 'readonly');
                tx.objectStore('processed_hashes').get(hash).onsuccess = (ev) => {
                    res(!!ev.target.result);
                };
            });
        } catch (_) { return false; }
    }
    async function markProcessed(hash) {
        try {
            const db = await openIDB();
            await new Promise(res => {
                const tx = db.transaction('processed_hashes', 'readwrite');
                tx.objectStore('processed_hashes').put({ hash, ts: Date.now() });
                tx.oncomplete = res;
            });
        } catch (_) {}
    }
    window.wfQueue = { enqueue, drain: drainQueue };

    // ────────────────────────────────────────────────────────────────────────
    // 4. Apply Brain Result — writes the classified transaction to the
    //    correct WealthFlow module via DB.set.
    // ────────────────────────────────────────────────────────────────────────
    async function applyBrainResult(brain, opts) {
        opts = opts || {};
        if (!brain || !brain.ok || !brain.classified) return { ok: false, reason: 'not classified' };
        if (!opts.skipDedup && await alreadyProcessed(brain.hash)) {
            return { ok: false, reason: 'duplicate (already applied)' };
        }
        const routed = brain.routed || {};
        const fields = routed.suggested_fields || {};
        let module = opts.forceModule || routed.module;

        // ── v7.7.0 Intelligence layer ──────────────────────────────────────
        // Runs BEFORE generic routing, but is skipped when re-applying from the
        // Quarantine Zone (the user has already made the decision there).
        if (!opts.skipIntel) {
            // (B) Semantic Goal / Loan allocation — highest priority. If the
            //     transaction description matches a savings goal or a loan by
            //     name, route the money straight there and stop.
            if (typeof window.wfTrySemanticAllocate === 'function') {
                try {
                    const alloc = await window.wfTrySemanticAllocate(brain);
                    if (alloc && alloc.ok) {
                        await markProcessed(brain.hash);
                        if (typeof window.syncToCloud === 'function') { try { syncToCloud(); } catch (_) {} }
                        return alloc;
                    }
                } catch (e) { console.warn('[Autonomous] semantic hook error:', e && e.message); }
            }

            // (C) Confidence gate → Needs-Review. If the brain isn't at least
            //     95% sure, DO NOT guess — park it in the persistent review
            //     queue (wfReview) so the user decides later. Never auto-file
            //     a low-confidence guess.
            const rConf = (routed.confidence != null) ? routed.confidence : 1;
            const mConf = (brain.resolved_merchant && brain.resolved_merchant.confidence != null)
                ? brain.resolved_merchant.confidence : 1;
            const conf = Math.min(rConf, mConf);
            if (conf < 0.95) {
                let parked = false;
                if (window.wfReview && typeof window.wfReview.add === 'function') {
                    try { window.wfReview.add(brain, 'AI only ' + Math.round(conf * 100) + '% sure'); parked = true; } catch (_) {}
                }
                if (parked) {
                    await markProcessed(brain.hash); // the review entry owns it now
                    if (typeof window.notify === 'function') {
                        notify('🛟 1 transaction needs your review (low confidence)', 'info');
                    }
                    return { ok: true, module: 'review' };
                }
                // If the review system isn't available, fall through and file it
                // normally rather than silently dropping the transaction.
            }
        }

        try {
            if (module === 'goal') {
                // forced from Quarantine "Goal" chip — needs a target id in fields
                const arr = (DB.get('targets') || []);
                const gi = arr.findIndex(x => x.id === fields.goalId);
                if (gi < 0) return { ok: false, reason: 'goal not found' };
                if (!Array.isArray(arr[gi].savings)) arr[gi].savings = [];
                arr[gi].savings.push({ id: 'auto_' + Date.now().toString(36), amount: fields.amount, date: new Date(fields.date || Date.now()).toISOString().slice(0,10), note: 'Filed from review', auto: true });
                DB.set('targets', arr);
            } else if (module === 'loan') {
                const arr = (DB.get('loans') || []);
                const li = arr.findIndex(x => x.id === fields.loanId);
                if (li < 0) return { ok: false, reason: 'loan not found' };
                if (!Array.isArray(arr[li].payments)) arr[li].payments = [];
                arr[li].payments.push({ id: 'auto_' + Date.now().toString(36), amount: fields.amount, date: new Date(fields.date || Date.now()).toISOString().slice(0,10), paid: true, note: 'Filed from review', auto: true });
                DB.set('loans', arr);
            } else if (module === 'income') {
                const _txTs = fields.date_ms || fields.date || Date.now();
                const _d = new Date(_txTs);
                const _ym = fields.month || (_d.getFullYear() + '-' + String(_d.getMonth()+1).padStart(2,'0'));
                const _yr = fields.year || _d.getFullYear();
                const arr = (DB.get('income') || []);
                const _isInv = !!(fields.is_investment || (fields.cat === 'Investment'));
                arr.push({
                    id: 'auto_' + Date.now().toString(36),
                    // income-tab schema compatibility: it reads name/company/amount
                    name: fields.source || (_isInv ? 'Investment Return' : 'Income'),
                    company: fields.source || '',
                    source: fields.source || 'Auto',
                    amount: fields.amount, date: _d.toISOString().slice(0,10),
                    date_ms: _d.getTime(),
                    month: _ym, year: _yr,
                    cat: fields.cat || (_isInv ? 'Investment' : 'Income'),
                    type: _isInv ? 'investment' : 'income',
                    is_investment: _isInv,
                    freq: 'once', monthly: 0, rate: 0,
                    notes: fields.notes || '', auto: true,
                    hash: brain.hash, createdAt: new Date().toISOString()
                });
                DB.set('income', arr);
            } else if (module === 'expenses') {
                // v7.9.0 — time-bucket stamping. The allocator may have pre-
                // stamped fields.month/year; honour them if present, else derive.
                const _txTs = fields.date_ms || fields.date || Date.now();
                const _d = new Date(_txTs); const _ymd = _d.toISOString().slice(0,10);
                const _ym = fields.month || (_d.getFullYear() + '-' + String(_d.getMonth()+1).padStart(2,'0'));
                const _yr = fields.year || _d.getFullYear();
                const arr = (DB.get('expenses') || []);
                arr.push({
                    id: 'auto_' + Date.now().toString(36),
                    desc: fields.desc, amount: fields.amount,
                    cat: fields.cat || 'Other',
                    date: _ymd,
                    date_ms: _d.getTime(),
                    month: _ym, year: _yr,
                    completed: true,   // imported from SMS/statement = already paid
                    paid: true,
                    notes: fields.notes || '', auto: true,
                    hash: brain.hash, createdAt: new Date().toISOString()
                });
                DB.set('expenses', arr);
            } else if (module === 'cconetime') {
                const _txTs = fields.date_ms || fields.date || Date.now();
                const _d = new Date(_txTs); const _ymd = _d.toISOString().slice(0,10);
                const _ym = fields.month || (_d.getFullYear() + '-' + String(_d.getMonth()+1).padStart(2,'0'));
                const _yr = fields.year || _d.getFullYear();
                const arr = (DB.get('cconetime') || []);
                arr.push({
                    id: 'auto_' + Date.now().toString(36),
                    desc: fields.desc, amount: fields.amount,
                    date: _ymd,
                    date_ms: _d.getTime(),
                    month: _ym, year: _yr,
                    bank: fields.bank || '', card_last4: fields.card_last4,
                    type: fields.type || 'purchase',
                    notes: fields.notes || '', completed: true, paid: true, auto: true,
                    hash: brain.hash, createdAt: new Date().toISOString()
                });
                DB.set('cconetime', arr);
            } else if (module === 'subscriptions') {
                const arr = (DB.get('subscriptions') || []);
                // Skip if a sub with same name already exists
                if (!arr.some(s => (s.name||'').toLowerCase() === (fields.name||'').toLowerCase())) {
                    const _txTs = fields.date_ms || fields.date || Date.now();
                    const _d = new Date(_txTs);
                    arr.push({
                        id: 'auto_' + Date.now().toString(36),
                        name: fields.name, category: fields.category,
                        amount: fields.amount, dueDay: fields.due_day,
                        cycle: fields.cycle || 'monthly', auto: true,
                        firstSeen_ms: _d.getTime(),
                        month: fields.month || (_d.getFullYear() + '-' + String(_d.getMonth()+1).padStart(2,'0')),
                        year:  fields.year  || _d.getFullYear(),
                        hash: brain.hash, createdAt: new Date().toISOString()
                    });
                    DB.set('subscriptions', arr);
                }
            } else if (module === 'cc_payment') {
                // Trigger FIFO reconciliation
                return await runFifoReconcile(fields);
            } else {
                return { ok: false, reason: 'Unknown module: ' + module };
            }

            await markProcessed(brain.hash);
            if (typeof window.syncToCloud === 'function') {
                try { syncToCloud(); } catch (_) {}
            }
            if (typeof window.notify === 'function') {
                notify(`🤖 Auto-logged: ${brain.resolved_merchant && brain.resolved_merchant.name} • LKR ${(fields.amount||0).toLocaleString()}`, 'success');
            }
            return { ok: true, module };
        } catch (e) {
            console.error('[Autonomous] applyBrainResult error:', e);
            return { ok: false, reason: e.message };
        }
    }
    window.wfApplyBrainResult = applyBrainResult;

    // ────────────────────────────────────────────────────────────────────────
    // 5. FIFO Reconciler — picks up "credit to CC" payment events
    // ────────────────────────────────────────────────────────────────────────
    async function runFifoReconcile({ amount, card_last4, timestamp }) {
        // Gather all unsettled debits for this card
        const ccot = (DB.get('cconetime') || [])
            .filter(x => x && x.card_last4 === card_last4 && !x.completed)
            .map(x => ({
                id: x.id, module: 'cconetime',
                card_last4: x.card_last4, amount: x.amount,
                timestamp: x.date_ms || new Date(x.date).getTime()
            }));
        const cci = (DB.get('ccinstall') || [])
            .filter(x => x && x.card_last4 === card_last4 && !x.completed)
            .map(x => ({
                id: x.id, module: 'ccinstall',
                card_last4: x.card_last4, amount: x.amount,
                timestamp: x.date_ms || new Date(x.date).getTime()
            }));
        const debits = ccot.concat(cci);

        if (!debits.length) {
            if (typeof window.notify === 'function') notify(`💳 CC payment received (•••${card_last4}) — no outstanding charges to clear.`, 'info');
            return { ok: true, settled: 0 };
        }

        try {
            const r = await fetch('/api/fifo-reconcile', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    card_last4, payment_amount: amount, payment_ts: timestamp, debits
                })
            });
            const plan = await r.json();
            if (!plan.ok) throw new Error(plan.error || 'reconcile failed');

            // Apply settled flags
            const settledIds = new Set((plan.settled || []).map(s => s.id));
            ['cconetime', 'ccinstall'].forEach(mod => {
                const arr = DB.get(mod) || [];
                let mutated = false;
                for (const item of arr) {
                    if (settledIds.has(item.id)) {
                        item.completed = true;
                        item.settled_at = plan.payment_ts;
                        item.settled_by_payment = true;
                        mutated = true;
                    }
                    if (plan.partial && plan.partial.id === item.id) {
                        item.amount = plan.partial.remaining;
                        item.partial_paid = (item.partial_paid || 0) + plan.partial.paid_portion;
                        mutated = true;
                    }
                }
                if (mutated) DB.set(mod, arr);
            });

            if (typeof window.syncToCloud === 'function') {
                try { syncToCloud(); } catch (_) {}
            }
            if (typeof window.notify === 'function') {
                const n = plan.settled.length;
                notify(`💳 FIFO reconciled: ${n} CC charge${n!==1?'s':''} cleared by your payment.`, 'success');
            }
            return { ok: true, settled: plan.settled.length, partial: plan.partial };
        } catch (e) {
            console.error('[FIFO] error:', e);
            if (typeof window.notify === 'function') notify('FIFO reconcile failed: ' + e.message, 'error');
            return { ok: false, error: e.message };
        }
    }
    window.wfFifoReconcile = runFifoReconcile;

    // ────────────────────────────────────────────────────────────────────────
    // 6. Manual SMS classify (user pastes an SMS into a textarea)
    // ────────────────────────────────────────────────────────────────────────
    async function classifyAndApplySms(smsBody, opts) {
        opts = opts || {};
        const payload = {
            sms: smsBody,
            sender: opts.sender || 'manual',
            received_at_ms: opts.received_at_ms || Date.now(),
            device_id: getDeviceToken().slice(0, 8),
            device_token: getDeviceToken(),
            card_registry: getCardRegistry(),
            location: null
        };
        try {
            const r = await fetch('/api/sms-ingest', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json',
                           'x-wf-device-token': getDeviceToken() },
                body: JSON.stringify(payload)
            });
            const data = await r.json();
            if (data.ok && data.classified) {
                return await applyBrainResult(data);
            }
            if (typeof window.notify === 'function') {
                notify(data.reason || data.error || 'Could not classify SMS', 'warn');
            }
            return data;
        } catch (e) {
            // Offline → enqueue for later
            await enqueue(payload);
            if (typeof window.notify === 'function') {
                notify('Offline — queued for sync when network returns.', 'warn');
            }
            return { ok: false, queued: true };
        }
    }
    window.wfClassifySms = classifyAndApplySms;

    // ────────────────────────────────────────────────────────────────────────
    // 7. Predictive Wealth refresh
    // ────────────────────────────────────────────────────────────────────────
    async function refreshPredictions(horizon) {
        try {
            const r = await fetch('/api/predict-wealth', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    expenses: DB.get('expenses') || [],
                    income: DB.get('income') || [],
                    subscriptions: DB.get('subscriptions') || [],
                    horizon_months: horizon || 12
                })
            });
            const data = await r.json();
            if (data.ok) {
                const s = DB.getObj('settings') || {};
                s.lastPredictions = { ...data, refreshed_at: Date.now() };
                DB.set('settings', s);
            }
            return data;
        } catch (e) { return { ok: false, error: e.message }; }
    }
    window.wfRefreshPredictions = refreshPredictions;

    // ────────────────────────────────────────────────────────────────────────
    // 8. FX helper
    // ────────────────────────────────────────────────────────────────────────
    async function fxConvert(amount, from, to) {
        try {
            const r = await fetch('/api/fx-rate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ amount, from, to })
            });
            return await r.json();
        } catch (e) { return { ok: false, error: e.message }; }
    }
    window.wfFxConvert = fxConvert;

    // ────────────────────────────────────────────────────────────────────────
    // 9. Self-healing tick
    // ────────────────────────────────────────────────────────────────────────
    function startSelfHealing() {
        if (window._wfHealingTicker) return;
        window._wfHealingTicker = setInterval(() => {
            if (navigator.onLine) drainQueue();
        }, 60000);
        window.addEventListener('online', () => { drainQueue(); });
    }

    // ────────────────────────────────────────────────────────────────────────
    // 10. v7.6.3 — Share-target inbox poller
    // The share-target.html page (which iOS Share Sheet / Android Share Sheet
    // posts to) writes classified-but-not-yet-applied results to
    // localStorage.wf_share_inbox. This poller picks them up, applies them
    // to the user's modules via applyBrainResult, and clears the inbox.
    // ────────────────────────────────────────────────────────────────────────
    async function drainShareInbox() {
        try {
            const raw = localStorage.getItem('wf_share_inbox');
            if (!raw) return { drained: 0 };
            const inbox = JSON.parse(raw);
            if (!Array.isArray(inbox) || !inbox.length) return { drained: 0 };
            let drained = 0;
            const keep = [];
            for (const item of inbox) {
                if (!item || !item.brain) { continue; }
                try {
                    const r = await applyBrainResult(item.brain);
                    if (r && r.ok) drained++;
                    else if (r && r.reason && r.reason.includes('duplicate')) drained++;
                    else keep.push(item);
                } catch (_) { keep.push(item); }
            }
            localStorage.setItem('wf_share_inbox', JSON.stringify(keep));
            if (drained > 0) {
                try {
                    if (typeof renderSubscriptions === 'function') renderSubscriptions();
                    if (typeof renderExpenses === 'function') renderExpenses();
                    if (typeof renderDash === 'function') renderDash();
                } catch (_) {}
                if (typeof window.notify === 'function') {
                    notify(`📤 Applied ${drained} transaction${drained > 1 ? 's' : ''} from Share Sheet`, 'success');
                }
            }
            return { drained };
        } catch (_) { return { drained: 0 }; }
    }
    window.wfDrainShareInbox = drainShareInbox;

    // ────────────────────────────────────────────────────────────────────────
    // 11. v7.6.6 — SERVER INBOX POLLER (CRITICAL)
    // This is what makes iOS Shortcut auto-forwarding actually WORK end-to-end.
    //
    // The iOS Shortcut POSTs to /api/sms-ingest → backend classifies →
    // backend writes the result to a per-device server-side inbox (Vercel KV).
    //
    // This poller, running in the main app on the user's phone, fetches
    // those inbox entries and applies them via applyBrainResult, exactly
    // the same code path as the Paste-SMS tester. Without this, classified
    // transactions from the Shortcut would be silently lost.
    //
    // Runs on:
    //   - 4s after page load
    //   - Every 30s while app is open
    //   - Immediately when tab becomes visible (user opens app)
    // ────────────────────────────────────────────────────────────────────────
    async function drainServerInbox() {
        try {
            const tok = getDeviceToken();
            if (!tok) return { drained: 0 };
            const r = await fetch('/api/inbox-pull', {
                method: 'GET',
                headers: { 'x-wf-device-token': tok }
            });
            if (!r.ok) return { drained: 0, error: 'pull failed: ' + r.status };
            const data = await r.json();
            if (!data.ok || !Array.isArray(data.items) || !data.items.length) {
                return { drained: 0 };
            }
            let drained = 0;
            const successfulKeys = [];
            for (const it of data.items) {
                if (!it || !it.brain_result) continue;
                try {
                    const apply = await applyBrainResult(it.brain_result);
                    if (apply && (apply.ok || (apply.reason && apply.reason.includes('duplicate')))) {
                        successfulKeys.push(it.key);
                        drained++;
                    }
                } catch (_) { /* leave on server for next attempt */ }
            }
            // ACK: tell server to delete the items we successfully applied
            if (successfulKeys.length) {
                try {
                    await fetch('/api/inbox-ack', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json', 'x-wf-device-token': tok },
                        body: JSON.stringify({ keys: successfulKeys })
                    });
                } catch (_) {}
            }
            if (drained > 0) {
                try {
                    if (typeof renderSubscriptions === 'function') renderSubscriptions();
                    if (typeof renderExpenses === 'function') renderExpenses();
                    if (typeof renderDash === 'function') renderDash();
                    if (typeof renderAutoPilotTile === 'function') renderAutoPilotTile();
                } catch (_) {}
                if (typeof window.notify === 'function') {
                    notify(`🤖 Auto-logged ${drained} transaction${drained > 1 ? 's' : ''} from your phone`, 'success');
                }
            }
            return { drained };
        } catch (e) {
            return { drained: 0, error: e.message };
        }
    }
    window.wfDrainServerInbox = drainServerInbox;

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(startSelfHealing, 3000);
            // Auto-refresh predictions once on boot (silent)
            setTimeout(() => { refreshPredictions(12).catch(()=>{}); }, 8000);
            // v7.6.3 — share-target poller: 15s, plus on visibilitychange
            setTimeout(() => {
                drainShareInbox();
                setInterval(drainShareInbox, 15000);
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden) drainShareInbox();
                });
            }, 5000);
            // v7.6.6 — SERVER INBOX POLLER: this is what makes iOS Shortcut
            // auto-forwarding end-to-end work. Runs 4s after load, every 30s,
            // and immediately on tab-visible.
            setTimeout(() => {
                drainServerInbox();
                setInterval(() => {
                    if (navigator.onLine && !document.hidden) drainServerInbox();
                }, 30000);
                document.addEventListener('visibilitychange', () => {
                    if (!document.hidden && navigator.onLine) drainServerInbox();
                });
            }, 4000);
        });
    }

    console.log('[Autonomous] ✅ WealthFlow Autonomous Module v1.1 (v7.9.0 time-bucket stamping) loaded');
})();
