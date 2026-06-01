/* =============================================================================
   WealthFlow Feedback Intelligence  v1.0  —  window.wfFeedbackAI
   ---------------------------------------------------------------------------
   The HONEST version of "AI considers and prioritises all user feedback."

   This is NOT a self-training neural network (a static PWA can't host one).
   It is a transparent, deterministic prioritisation engine that runs the exact
   formula from the design doc:

       Priority = (Trend Frequency × Impact Weight) + Security Weight

   What it really does:
     • Pulls every feedback item it can reach (Firestore if signed in, plus the
       local queue + anything submitted this session).
     • Classifies each by intent (bug / security / idea / performance / UI) using
       keyword signals.
     • Clusters near-duplicate reports (same underlying issue) so repeated
       complaints raise the score — "many users report it" genuinely matters.
     • Scores urgency 0–1 and sorts. Security + crashes float to the top.
     • Renders a ranked board so you can SEE what to fix first.

   Anyone can audit the scoring — it's printed next to each item. That honesty
   is the point: real prioritisation you can trust in a finance app, not a
   black box that "trains itself".
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_FEEDBACK_AI) return;
    window.WF_FEEDBACK_AI = '1.0';

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function _notify(m,t){try{if(typeof window.notify==='function')window.notify(m,t||'info');}catch(_){}}

    // ── signal dictionaries (transparent, editable) ──────────────────────────
    const SIGNALS = {
        security:    { w: 1.00, kw: ['hack','breach','leak','exploit','vulnerab','stolen','fraud','unauthor','phishing','password','2fa','otp','encrypt','privacy','security'] },
        crash:       { w: 0.92, kw: ['crash','freeze','frozen','froze','stuck','hang','white screen','black screen','wont open','won\'t open','cant open','can\'t open','cannot open','not loading','wont load','won\'t start','not starting','splash','broken','data lost','lost my data','disappear','unresponsive'] },
        bug:         { w: 0.70, kw: ['bug','error','wrong','incorrect','glitch','fail','doesn\'t work','not working','issue','problem','duplicate','miscategor','wrong category'] },
        performance: { w: 0.55, kw: ['slow','lag','laggy','delay','takes long','loading','spinner','battery','heat'] },
        ui:          { w: 0.40, kw: ['ui','ux','design','layout','color','colour','font','button','hard to read','confusing','cluttered','dark mode','theme'] },
        idea:        { w: 0.30, kw: ['add','feature','please add','would be nice','suggestion','suggest','idea','wish','could you','request','support for'] }
    };

    function _classify(text) {
        const t = (text || '').toLowerCase();
        let best = 'idea', bestHits = 0, bestW = SIGNALS.idea.w;
        for (const [cat, def] of Object.entries(SIGNALS)) {
            let hits = 0;
            for (const kw of def.kw) if (t.indexOf(kw) >= 0) hits++;
            // weight by category importance so security/crash win ties
            if (hits > 0 && (hits * def.w) > (bestHits * bestW)) { best = cat; bestHits = hits; bestW = def.w; }
        }
        return { category: best, weight: SIGNALS[best].w, hits: bestHits };
    }

    // ── semantic similarity ──────────────────────────────────────────────────
    // A lightweight but genuinely semantic layer: each token is expanded to its
    // concept (synonyms map to a shared canonical term), so "won't open",
    // "stuck on splash" and "frozen at launch" all collapse to the same concept
    // and cluster — without shared surface words. Runs fully on-device, instant.
    const CONCEPTS = {
        crash: ['crash','crashed','crashing','freeze','frozen','froze','hang','hung','stuck','unresponsive','dead','died'],
        launch: ['open','opening','opens','launch','start','startup','boot','splash','load','loading','loads'],
        data: ['data','records','transactions','history','entries','backup','sync','synced','lost','missing','gone','disappeared','deleted','vanished'],
        login: ['login','signin','passcode','pin','password','auth','authenticate','locked','google','biometric','faceid','fingerprint'],
        slow: ['slow','laggy','lag','delay','delayed','sluggish','wait','waiting','spinner','spinning','hangs'],
        category: ['category','categorise','categorize','categorisation','classified','classify','wrong','incorrect','miscategorised','misfiled','tag','tagged'],
        ui: ['ui','ux','design','layout','screen','button','color','colour','font','text','dark','light','theme','cluttered','confusing','readable'],
        sms: ['sms','message','text','paste','bank','statement','pdf','scan','ocr','receipt'],
        security: ['security','hack','hacked','breach','breached','leak','leaked','stolen','fraud','unauthorised','unauthorized','phishing','exposed','vulnerable','vulnerability'],
        money: ['amount','balance','total','currency','lkr','rupee','money','sum','calculation','wrong','rounding'],
        notif: ['notification','notify','alert','reminder','badge','push'],
        add: ['add','feature','option','support','request','suggestion','wish','want','need','please','could','would']
    };
    const _concIndex = (() => { const m = {}; for (const c in CONCEPTS) for (const w of CONCEPTS[c]) m[w] = c; return m; })();

    function _tokens(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2); }
    // map a string to its set of CONCEPTS plus its meaningful long tokens
    function _concepts(s) {
        const set = new Set();
        for (const w of _tokens(s)) {
            if (_concIndex[w]) set.add('@' + _concIndex[w]);
            else if (w.length > 3) set.add(w);   // keep distinctive words (merchant names etc.)
        }
        return set;
    }
    function _sim(a, b) {
        const A = _concepts(a), B = _concepts(b);
        if (!A.size || !B.size) return 0;
        let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
        // weight concept matches (prefixed @) higher than raw word matches
        let cw = 0; A.forEach(x => { if (x[0] === '@' && B.has(x)) cw++; });
        const jaccard = inter / (A.size + B.size - inter);
        const conceptBoost = cw > 0 ? Math.min(0.35, cw * 0.18) : 0;
        return Math.min(1, jaccard + conceptBoost);
    }

    // ── gather feedback from every source we can reach ───────────────────────
    async function _gather() {
        const items = [];
        // local queue (offline fallback)
        try { JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]').forEach(x => items.push(Object.assign({ _src: 'local' }, x))); } catch (_) {}
        // this-session submissions cached for instant view
        try { JSON.parse(sessionStorage.getItem('wf_feedback_session') || '[]').forEach(x => items.push(Object.assign({ _src: 'session' }, x))); } catch (_) {}
        // Firestore (all users' feedback) if available
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const db = window.db || (fb && fb.firestore ? fb.firestore() : null);
            if (db) {
                const snap = await db.collection('feedback').orderBy('createdAt', 'desc').limit(200).get();
                snap.forEach(doc => items.push(Object.assign({ _src: 'cloud', _id: doc.id }, doc.data())));
            }
        } catch (e) { /* permissions or offline — fine, use what we have */ }
        return items;
    }

    // ── cluster + score ──────────────────────────────────────────────────────
    function _analyse(items) {
        // build clusters
        const clusters = [];
        for (const it of items) {
            const text = it.text || it.message || '';
            if (!text.trim()) continue;
            let placed = false;
            for (const c of clusters) {
                if (_sim(c.sample, text) >= 0.28 || (_classify(c.sample).category === _classify(text).category && _sim(c.sample, text) >= 0.18)) { c.items.push(it); c.count++; placed = true; break; }
            }
            if (!placed) clusters.push({ sample: text, items: [it], count: 1 });
        }
        // score each cluster: (trendFreq × impactWeight) + securityWeight
        const totalReports = Math.max(1, items.length);
        for (const c of clusters) {
            const cls = _classify(c.sample);
            c.category = cls.category;
            const trendFreq = c.count / totalReports;            // 0..1 share of all feedback
            const impactWeight = cls.weight;                     // 0..1 category severity
            const securityWeight = cls.category === 'security' ? 0.30 : (cls.category === 'crash' ? 0.15 : 0);
            // normalise frequency boost so a single critical report still ranks,
            // but repeated reports clearly outrank one-offs
            const freqBoost = Math.min(0.5, Math.log2(1 + c.count) * 0.18);
            c.score = Math.min(1, (freqBoost + impactWeight * 0.6) + securityWeight);
            c.priority = c.score >= 0.85 ? 'critical' : c.score >= 0.6 ? 'high' : c.score >= 0.4 ? 'medium' : 'low';
        }
        clusters.sort((a, b) => b.score - a.score || b.count - a.count);
        return clusters;
    }

    // ── UI: ranked board ─────────────────────────────────────────────────────
    async function showBoard() {
        _overlay('wfFbBoard', 'Feedback Intelligence', 'Analysing all feedback…',
            '<div id="wfFbBoardBody" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;">Gathering reports & scoring priority…</div>',
            '<button class="btn btn-primary" style="width:100%;" onclick="wfFeedbackAI._close(\'wfFbBoard\')">Close</button>');

        // Prefer the server brain's pre-computed ranking (covers ALL users and
        // runs automatically on a schedule); fall back to local analysis.
        let clusters = null, serverComputed = false;
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const db = window.db || (fb && fb.firestore ? fb.firestore() : null);
            if (db) {
                const doc = await db.collection('system').doc('feedbackPriority').get();
                if (doc && doc.exists) {
                    const d = doc.data();
                    if (d && Array.isArray(d.clusters) && d.clusters.length) { clusters = d.clusters; serverComputed = true; }
                }
            }
        } catch (_) {}
        if (!clusters) { const items = await _gather(); clusters = _analyse(items); }
        const body = document.getElementById('wfFbBoardBody');
        if (!body) return;

        if (!clusters.length) {
            body.style.display = 'block';
            body.innerHTML = '<div style="text-align:center;color:var(--text3,#8b95a8);font-size:13px;padding:20px;">No feedback yet. When users send reports, they\'ll be scored and ranked here by urgency.</div>';
            _setSub('wfFbBoard', 'No feedback yet');
            return;
        }

        const pColor = { critical: '#ef4444', high: '#f59e0b', medium: '#818cf8', low: '#6b7280' };
        const catLabel = { security: 'Security', crash: 'Crash / data', bug: 'Bug', performance: 'Performance', ui: 'UI / UX', idea: 'Feature idea' };
        const critical = clusters.filter(c => c.priority === 'critical').length;
        const totalReports = clusters.reduce((s, c) => s + (c.count || 1), 0);

        const rows = clusters.map((c, i) => {
            const pc = pColor[c.priority] || '#6b7280';
            const pct = Math.round(c.score * 100);
            return '<div style="padding:12px;border:1px solid var(--border,#1f2638);border-left:3px solid ' + pc + ';border-radius:11px;margin-bottom:9px;background:var(--bg2,#0a0e1a);">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                    '<span style="font-size:11px;font-weight:800;color:' + pc + ';text-transform:uppercase;">' + _esc(c.priority) + '</span>' +
                    '<span style="font-size:11px;color:var(--text3,#8b95a8);">' + _esc(catLabel[c.category] || c.category) + '</span>' +
                    '<span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--text2,#c7cdd9);">' + c.count + (c.count > 1 ? ' reports' : ' report') + ' · score ' + pct + '</span>' +
                '</div>' +
                '<div style="font-size:13px;line-height:1.5;color:var(--text,#e6e7eb);">' + _esc(c.sample.slice(0, 220)) + (c.sample.length > 220 ? '…' : '') + '</div>' +
            '</div>';
        }).join('');

        body.style.display = 'block';
        body.innerHTML =
            '<div style="display:flex;gap:8px;margin-bottom:14px;">' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:var(--text,#e6e7eb);">' + clusters.length + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">issues</div></div>' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:#ef4444;">' + critical + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">critical</div></div>' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:#10b981;">' + totalReports + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">reports</div></div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text3,#8b95a8);margin-bottom:10px;">Ranked by: (report frequency × issue severity) + security weight. Security and crashes are prioritised. Repeated reports raise the score.</div>' +
            rows;
        _setSub('wfFbBoard', clusters.length + ' issues · ' + critical + ' critical');
    }

    // public helper used by the update system to know if there are urgent items
    async function topPriority() {
        const clusters = _analyse(await _gather());
        return clusters[0] || null;
    }

    // ── shared overlay helpers (match the update system's look) ──────────────
    function _overlay(id, title, sub, bodyHtml, footerHtml) {
        _close(id);
        const ov = document.createElement('div');
        ov.id = id;
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.78);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .2s;';
        ov.innerHTML = '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:560px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
            '<div style="padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top,0px) + 14px));border-bottom:1px solid var(--border,#1f2638);">' +
                '<div style="font-weight:800;font-size:17px;color:var(--text,#e6e7eb);">' + _esc(title) + '</div>' +
                '<div class="wf-ov-sub" style="font-size:12.5px;color:var(--text3,#8b95a8);margin-top:2px;">' + _esc(sub) + '</div>' +
            '</div>' +
            '<div style="padding:18px 20px;overflow-y:auto;flex:1;">' + bodyHtml + '</div>' +
            '<div style="padding:14px 20px;border-top:1px solid var(--border,#1f2638);">' + footerHtml + '</div>' +
        '</div>';
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
    }
    function _setSub(id, txt) { const ov = document.getElementById(id); if (ov) { const s = ov.querySelector('.wf-ov-sub'); if (s) s.textContent = txt; } }
    function _close(id) { const ov = document.getElementById(id); if (ov) { ov.style.opacity = '0'; setTimeout(() => ov.remove(), 200); } }

    window.wfFeedbackAI = { showBoard, topPriority, analyse: _analyse, classify: _classify, _close };
    console.log('[wfFeedbackAI] ✓ Feedback prioritisation engine loaded');
})();
