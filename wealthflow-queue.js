/* =============================================================================
   WealthFlow Queue v1.0 — Autonomous Background Processing Engine
   ---------------------------------------------------------------------------
   User requirement: "the user cannot wait for a statement or SMS paste to be
   uploaded and forwarded to the relevant places. So upload it and then let the
   System AI work on its own. Then the user can do other work in the system or
   close the App/web. Also show the progress bar of its uploading and its
   processing. It should work in real time."

   What this does:
     • You hand it raw items (split SMS messages, or statement line-items). It
       returns immediately. You can navigate away or close the tab.
     • A background loop processes each item through the full AI pipeline:
            brain classify → learned-memory boost → duplicate defence →
            (confident?) auto-file via allocator + teach memory
                          : (unsure?) park in the persistent review queue
     • A live, real-time progress bar shows upload + processing advancing item
       by item, with running tallies (filed / review / duplicate / error).
     • The queue is persisted ENCRYPTED after every state change, so closing
       the tab mid-run loses nothing — on next open it resumes automatically.
     • Network blips are retried with backoff; nothing is dropped.

   Exposes:
     • wfQueue.enqueueSms(text, source)        → split + enqueue, starts engine
     • wfQueue.enqueueStatementLines(lines,src)→ enqueue parsed statement rows
     • wfQueue.enqueue(items)                   → low-level enqueue
     • wfQueue.start() / wfQueue.status()
     • wfQueue.on(cb)                           → subscribe to progress events
     • wfQueue.clearFinished()
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_QUEUE_LOADED) return;
    window.WF_QUEUE_LOADED = '1.0';

    const STORE_KEY = 'job_queue_v1';
    const CONCURRENCY = 4;
    const MAX_ATTEMPTS = 4;
    const CONF_THRESHOLD = 0.95;     // below this → ask the user (review queue)

    let _jobs = null;        // array of job objects
    let _loaded = false;
    let _running = false;
    let _saveTimer = null;
    let _autoHideT = null;   // auto-dismiss timer for the floating progress bar
    const _subs = [];

    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }
    function _uid() { return 'job_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    // ── persistence (encrypted) ─────────────────────────────────────────────---
    async function _load() {
        if (_loaded) return _jobs;
        let data = null;
        if (window.wfCrypto) { try { data = await window.wfCrypto.secureGet(STORE_KEY); } catch (_) {} }
        _jobs = Array.isArray(data) ? data : [];
        // any job left 'processing' from a previous session was interrupted → re-queue
        for (const j of _jobs) if (j.status === 'processing') j.status = 'pending';
        _loaded = true;
        return _jobs;
    }
    function _scheduleSave() { if (_saveTimer) clearTimeout(_saveTimer); _saveTimer = setTimeout(_save, 250); }
    async function _save() {
        if (!_jobs) return;
        if (window.wfCrypto) { try { await window.wfCrypto.secureSet(STORE_KEY, _jobs); return; } catch (_) {} }
        try { localStorage.setItem('wf_' + STORE_KEY, JSON.stringify(_jobs)); } catch (_) {}
    }

    // ── status snapshot + event emit ────────────────────────────────────────---
    function status() {
        const j = _jobs || [];
        const by = (s) => j.filter(x => x.status === s).length;
        const terminal = ['filed', 'review', 'duplicate', 'error', 'unparsed'];
        const done = j.filter(x => terminal.includes(x.status)).length;
        return {
            total: j.length, done,
            pending: by('pending'), processing: by('processing'),
            filed: by('filed'), review: by('review'),
            duplicate: by('duplicate'), error: by('error'), unparsed: by('unparsed'),
            active: _running
        };
    }
    function on(cb) { if (typeof cb === 'function') _subs.push(cb); return () => { const i = _subs.indexOf(cb); if (i >= 0) _subs.splice(i, 1); }; }
    function _emit() { const s = status(); _subs.forEach(cb => { try { cb(s); } catch (_) {} }); _renderBar(s); }

    // ── brain classify (uses sms-paste's fn if present, else direct fetch) ──────
    async function _classify(raw) {
        if (typeof window.wfBrainClassify === 'function') return window.wfBrainClassify(raw);
        // fallback direct call
        const cardRegistry = (window.wfCardRegistry && window.wfCardRegistry.get && window.wfCardRegistry.get()) || {};
        const knownLoans = (window.DB && window.DB.get && window.DB.get('loans')) || [];
        const r = await fetch('/api/autonomous-brain', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sms: raw, received_at_ms: Date.now(), card_registry: cardRegistry, known_loans: knownLoans })
        });
        return r.json();
    }

    // ── the core pipeline for ONE job ───────────────────────────────────────---
    async function _process(job) {
        // 1. brain
        let brain;
        try { brain = await _classify(job.raw); }
        catch (e) {
            job.attempts = (job.attempts || 0) + 1;
            if (job.attempts < MAX_ATTEMPTS) { job.status = 'pending'; job._backoffUntil = Date.now() + 1500 * job.attempts; return; }
            job.status = 'error'; job.result = { reason: 'network: ' + (e && e.message) }; return;
        }
        if (!brain || !brain.ok || !brain.classified) {
            job.status = 'unparsed'; job.result = { reason: (brain && (brain.reason || brain.error)) || 'could not parse' }; return;
        }

        // 2. learned-memory boost / override
        try { if (window.wfMemory) brain = await window.wfMemory.applyToBrain(brain); } catch (_) {}

        // 3. duplicate defence (cross-source)
        try {
            if (window.wfDedup) {
                const dup = window.wfDedup.isDuplicateOfExisting(brain);
                if (dup && (dup.certain || dup.score >= 0.9)) {
                    job.status = 'duplicate';
                    job.result = { reason: dup.why || 'duplicate', matchedId: dup.existing && dup.existing.id };
                    return;
                }
            }
        } catch (_) {}

        // 4. confidence gate
        const m = brain.resolved_merchant || {};
        const r = brain.routed || {};
        let conf = Math.min(r.confidence != null ? r.confidence : 1, m.confidence != null ? m.confidence : 1);

        // 4a. Agentic upgrade — if we're unsure and the category is unknown/Other,
        //     do a real web lookup to identify the merchant before bothering the
        //     user. If it resolves confidently, file it; otherwise fall through
        //     to review. (Privacy: only the merchant name is sent.)
        if (conf < CONF_THRESHOLD && !(brain._memory && brain._memory.userConfirmed) &&
            (!m.category || m.category === 'Other') &&
            window.wfCategoryAI && typeof window.wfCategoryAI.identifyUnknown === 'function') {
            try {
                const rawName = m.name || (brain.parsed && brain.parsed.raw_merchant) || '';
                const found = await window.wfCategoryAI.identifyUnknown(rawName, 'Sri Lanka');
                if (found && found.category && found.category !== 'Other') {
                    brain.resolved_merchant = Object.assign({}, m, {
                        name: found.name || rawName,
                        category: found.category,
                        confidence: Math.max(m.confidence || 0, found.confidence || 0.82),
                        source: found.source
                    });
                    if (brain.routed) brain.routed.confidence = Math.max(brain.routed.confidence || 0, found.confidence || 0.82);
                    conf = Math.min(
                        (brain.routed && brain.routed.confidence != null) ? brain.routed.confidence : 1,
                        brain.resolved_merchant.confidence != null ? brain.resolved_merchant.confidence : 1
                    );
                }
            } catch (_) {}
        }

        if (conf < CONF_THRESHOLD && !(brain._memory && brain._memory.userConfirmed)) {
            // unsure → ask the user later (never guess)
            try { if (window.wfReview) await window.wfReview.add(brain, 'AI ' + Math.round(conf * 100) + '% sure — confirm category'); } catch (_) {}
            job.status = 'review'; job.result = { confidence: conf };
            return;
        }

        // 5. confident → file via allocator (stamps month/year)
        let res;
        try {
            if (typeof window.wfAllocate === 'function') res = await window.wfAllocate(brain);
            else if (typeof window.wfApplyBrainResult === 'function') res = await window.wfApplyBrainResult(brain);
        } catch (e) { res = { ok: false, reason: e && e.message }; }

        if (res && res.reason === 'duplicate') { job.status = 'duplicate'; job.result = res; return; }
        if (res && (res.module === 'quarantine' || res.module === 'review')) {
            try { if (window.wfReview) await window.wfReview.add(brain, 'Flagged for review'); } catch (_) {}
            job.status = 'review'; job.result = res; return;
        }
        if (res && res.ok) {
            // teach memory (non-authoritative observation — strengthens over time)
            try {
                if (window.wfMemory) await window.wfMemory.learn(m.name || (brain.parsed && brain.parsed.raw_merchant), {
                    category: m.category, module: res.module, source: 'auto',
                    cardLast4: (brain.parsed && brain.parsed.card_last4) || null
                });
            } catch (_) {}
            job.status = 'filed'; job.result = { module: res.module, merchant: m.name };
            return;
        }
        // fell through → review rather than lose it
        try { if (window.wfReview) await window.wfReview.add(brain, (res && res.reason) || 'Could not auto-file'); } catch (_) {}
        job.status = 'review'; job.result = res || { reason: 'unknown' };
    }

    // ── the engine loop (bounded concurrency) ────────────────────────────────--
    async function start() {
        await _load();
        if (_running) return;
        _running = true;
        _emit();
        const workers = [];
        for (let i = 0; i < CONCURRENCY; i++) workers.push(_worker());
        await Promise.all(workers);
        _running = false;
        _emit();
        _onDrain();
    }

    function _nextPending() {
        const now = Date.now();
        for (const j of _jobs) {
            if (j.status === 'pending' && (!j._backoffUntil || j._backoffUntil <= now)) return j;
        }
        return null;
    }

    async function _worker() {
        while (true) {
            const job = _nextPending();
            if (!job) {
                // any jobs in backoff still waiting? brief wait, else exit
                const waiting = _jobs.some(j => j.status === 'pending');
                if (!waiting) return;
                await new Promise(r => setTimeout(r, 400));
                continue;
            }
            job.status = 'processing';
            _scheduleSave(); _emit();
            await _process(job);
            _scheduleSave(); _emit();
        }
    }

    function _onDrain() {
        const s = status();
        if (s.total === 0) return;
        // summary toast
        const bits = [];
        if (s.filed) bits.push('✓ ' + s.filed + ' filed');
        if (s.review) bits.push('🛟 ' + s.review + ' to review');
        if (s.duplicate) bits.push('⊘ ' + s.duplicate + ' duplicate' + (s.duplicate === 1 ? '' : 's'));
        if (s.error) bits.push('⚠ ' + s.error + ' error' + (s.error === 1 ? '' : 's'));
        if (s.unparsed) bits.push('? ' + s.unparsed + ' unreadable');
        if (bits.length) _notify('AI finished: ' + bits.join(' · '), s.error ? 'warn' : 'success');
        // if items went to review, surface the banner
        if (s.review && window.wfReview) { try { window.wfReview.promptIfPending(); } catch (_) {} }
        // auto-clear the bar shortly after drain
        setTimeout(() => { if (!status().active && status().pending === 0 && status().processing === 0) _hideBar(); }, 4000);
    }

    // ── enqueue APIs ────────────────────────────────────────────────────────---
    async function enqueue(items) {
        await _load();
        const now = Date.now();
        let added = 0;
        for (const it of (items || [])) {
            const raw = (typeof it === 'string') ? it : it.raw;
            if (!raw || String(raw).trim().length < 5) continue;
            _jobs.push({
                id: _uid(),
                type: (it && it.type) || 'sms',
                source: (it && it.source) || 'paste',
                raw: String(raw).trim(),
                status: 'pending', attempts: 0, enqueuedAt: now, result: null
            });
            added++;
        }
        _scheduleSave();
        _emit();
        if (added) start();      // fire-and-forget; returns immediately
        return added;
    }

    async function enqueueSms(text, source) {
        const parts = (typeof window.wfSplitSmsBatch === 'function')
            ? window.wfSplitSmsBatch(text)
            : [String(text || '')];
        return enqueue(parts.map(p => ({ type: 'sms', raw: p, source: source || 'paste' })));
    }

    async function enqueueStatementLines(lines, source) {
        // lines: array of strings OR {text|raw} objects produced by the scanner
        const items = (lines || []).map(l => ({
            type: 'statement', source: source || 'statement',
            raw: (typeof l === 'string') ? l : (l.text || l.raw || JSON.stringify(l))
        }));
        return enqueue(items);
    }

    // Bridge for the existing statement scanner: it already extracts structured
    // rows {date, description, amount, type}. Convert each into an SMS-like
    // sentence the deterministic brain understands, so statement rows get the
    // exact same merchant-resolution + learned-memory + dedup + auto-file as a
    // pasted SMS — and the user can walk away while it runs.
    async function enqueueStatementRows(rows, opts) {
        opts = opts || {};
        const cur = opts.currency || 'LKR';
        const card = opts.card_last4 ? (' card ' + opts.card_last4) : '';
        const items = (rows || []).filter(r => r && (r.amount || r.description)).map(r => {
            const verb = (r.type === 'credit' || r.type === 'income') ? 'credited with' : 'debited with';
            const date = r.date || new Date().toISOString().slice(0, 10);
            const desc = r.description || r.desc || 'Transaction';
            // synthesise: "A/C 5187 debited with LKR2498.74 on 2026-05-29 ref: <DESC>"
            // (card placed BEFORE ref so the merchant capture stops cleanly at end-of-string)
            const acct = opts.card_last4 ? ('A/C ' + opts.card_last4 + ' is ') : 'A/C is ';
            const raw = acct + verb + ' ' + cur + (Number(r.amount) || 0) + ' on ' + date + ' ref: ' + desc;
            return { type: 'statement', source: opts.source || 'statement', raw };
        });
        return enqueue(items);
    }
    window.wfStatementToQueue = enqueueStatementRows;

    async function clearFinished() {
        await _load();
        const terminal = ['filed', 'duplicate', 'unparsed'];
        _jobs = _jobs.filter(j => !terminal.includes(j.status));
        _scheduleSave(); _emit();
    }

    // ── live progress bar UI ─────────────────────────────────────────────────--
    function _ensureBar() {
        let bar = document.getElementById('wfQueueBar');
        if (bar) return bar;
        const css = document.getElementById('wfqueue-css') || (() => {
            const s = document.createElement('style'); s.id = 'wfqueue-css';
            s.textContent = `
                #wfQueueBar{position:fixed;right:16px;bottom:16px;z-index:99991;width:300px;max-width:calc(100vw - 32px);background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:15px;box-shadow:0 18px 50px rgba(0,0,0,0.5);overflow:hidden;font-family:inherit;transition:transform .25s,opacity .25s;}
                #wfQueueBar.min{width:auto;}
                #wfQueueBar .qb-head{display:flex;align-items:center;gap:9px;padding:13px 15px;cursor:pointer;}
                #wfQueueBar .qb-spin{width:17px;height:17px;border:2.5px solid rgba(255,255,255,0.15);border-top-color:#10b981;border-radius:50%;animation:wfqspin .8s linear infinite;flex-shrink:0;}
                @keyframes wfqspin{to{transform:rotate(360deg)}}
                #wfQueueBar .qb-title{font-weight:800;font-size:13px;color:var(--text,#e6e7eb);flex:1;min-width:0;}
                #wfQueueBar .qb-sub{font-size:11px;color:#8b95a8;margin-top:1px;font-weight:600;}
                #wfQueueBar .qb-pct{font-weight:900;font-size:13px;color:#10b981;}
                #wfQueueBar .qb-track{height:5px;background:var(--bg,#060a14);}
                #wfQueueBar .qb-fill{height:100%;background:linear-gradient(90deg,#10b981,#d4af37);width:0%;transition:width .3s;}
                #wfQueueBar .qb-tallies{display:flex;gap:6px;flex-wrap:wrap;padding:10px 15px 13px;}
                #wfQueueBar .qb-chip{font-size:10.5px;font-weight:800;padding:3px 8px;border-radius:7px;}
                #wfQueueBar.min .qb-track,#wfQueueBar.min .qb-tallies{display:none;}
            `;
            document.head.appendChild(s); return s;
        })();
        bar = document.createElement('div');
        bar.id = 'wfQueueBar';
        bar.innerHTML =
            '<div class="qb-head"><div class="qb-spin" id="wfqSpin"></div>' +
            '<div style="flex:1;min-width:0;"><div class="qb-title" id="wfqTitle">Processing…</div><div class="qb-sub" id="wfqSub"></div></div>' +
            '<div class="qb-pct" id="wfqPct">0%</div></div>' +
            '<div class="qb-track"><div class="qb-fill" id="wfqFill"></div></div>' +
            '<div class="qb-tallies" id="wfqTallies"></div>';
        document.body.appendChild(bar);
        bar.querySelector('.qb-head').addEventListener('click', () => bar.classList.toggle('min'));
        return bar;
    }
    function _hideBar() { const b = document.getElementById('wfQueueBar'); if (b) { b.style.opacity = '0'; b.style.transform = 'translateY(20px)'; setTimeout(() => b.remove(), 280); } }

    function _renderBar(s) {
        if (s.total === 0) return;
        const inFlight = s.pending + s.processing;
        const bar = _ensureBar();
        const pct = s.total ? Math.round(s.done / s.total * 100) : 0;
        const spin = document.getElementById('wfqSpin');
        const title = document.getElementById('wfqTitle');
        const sub = document.getElementById('wfqSub');
        const fill = document.getElementById('wfqFill');
        const pctEl = document.getElementById('wfqPct');
        const tall = document.getElementById('wfqTallies');
        if (fill) fill.style.width = pct + '%';
        if (pctEl) pctEl.textContent = pct + '%';
        if (inFlight > 0) {
            if (title) title.textContent = '🤖 AI is filing your transactions';
            if (sub) sub.textContent = s.done + ' of ' + s.total + ' done · ' + inFlight + ' to go';
            if (spin) spin.style.display = '';
        } else {
            if (title) title.textContent = '✓ All done';
            if (sub) sub.textContent = s.total + ' processed';
            if (spin) spin.style.display = 'none';
            // Auto-hide the floating bar a few seconds after everything is done
            // so it doesn't sit overlapping the settings page / robot button.
            try {
                clearTimeout(_autoHideT);
                _autoHideT = setTimeout(() => {
                    const b = document.getElementById('wfQueueBar');
                    if (!b) return;
                    // only hide if still in the "done" state (nothing new queued)
                    const st = status();
                    if ((st.pending || 0) === 0 && (st.processing || 0) === 0) {
                        b.style.opacity = '0';
                        b.style.transform = 'translateY(20px)';
                        setTimeout(() => { try { b.remove(); } catch (_) {} }, 300);
                    }
                }, 4500);
            } catch (_) {}
        }
        if (tall) {
            const chips = [];
            if (s.filed) chips.push('<span class="qb-chip" style="background:rgba(16,185,129,.15);color:#10b981;">✓ ' + s.filed + ' filed</span>');
            if (s.review) chips.push('<span class="qb-chip" style="background:rgba(245,158,11,.15);color:#f59e0b;">🛟 ' + s.review + ' review</span>');
            if (s.duplicate) chips.push('<span class="qb-chip" style="background:rgba(139,148,168,.15);color:#8b95a8;">⊘ ' + s.duplicate + ' dup</span>');
            if (s.error) chips.push('<span class="qb-chip" style="background:rgba(239,68,68,.15);color:#ef4444;">⚠ ' + s.error + '</span>');
            if (s.unparsed) chips.push('<span class="qb-chip" style="background:rgba(139,148,168,.15);color:#8b95a8;">? ' + s.unparsed + '</span>');
            tall.innerHTML = chips.join('');
        }
    }

    window.wfQueue = { enqueue, enqueueSms, enqueueStatementLines, enqueueStatementRows, start, status, on, clearFinished };

    // Resume any interrupted jobs on load
    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(() => { _load().then(() => { if (status().pending > 0) start(); }); }, 3500);
        });
    }

    console.log('[wfQueue] ✓ Autonomous background processing engine loaded');
})();
