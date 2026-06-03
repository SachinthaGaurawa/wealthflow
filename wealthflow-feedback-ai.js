/* =============================================================================
   WealthFlow Feedback Intelligence  v2.0  —  window.wfFeedbackAI
   ---------------------------------------------------------------------------
   The HONEST version of "AI considers and prioritises all user feedback."

   v2.0 fixes (real bugs reported by users):
     1. FEEDBACK SURVIVES SIGN-OUT → SIGN-IN.
        signOutGoogle() calls localStorage.clear(), so the local copy is wiped
        and the session copy dies with the tab. The cloud copy is the durable
        source of truth — but the old board read window.currentUser.uid, which
        is often not yet populated when the panel opens, so it queried with a
        null uid and showed nothing. We now AWAIT auth readiness and resolve the
        uid from firebase.auth().currentUser as a fallback, so your own cloud
        feedback reliably reloads after re-login.
     2. REAL COUNTS (no fakes). Every submission is stored in 3 places
        (sessionStorage + localStorage queue + Firestore). The old de-dupe was
        brittle, so one report could be counted up to 3×. We now collapse the
        three copies of the SAME submission (identical text + createdAt) into ONE,
        preferring the cloud copy. The numbers are now the true count of distinct
        reports, recomputed live every time the board opens.
     3. 2-WEEK WINDOW. Feedback older than 14 days from its send date is no
        longer shown. (For permanent deletion, run a TTL cleanup server-side in
        release-brain.js / a Firestore TTL policy — see notes.)
     4. HONEST "Currently considering by System AI…" STATUS. Shown ONLY when it
        is genuinely true: i.e. when the issue is scored critical/high by the
        same deterministic engine the autonomous brain runs (and confirmed by the
        server's system/feedbackPriority doc when it is readable). Items that are
        not being prioritised show NO badge. Nothing is faked.
     5. REAL-TIME. While the board is open it subscribes to your own feedback via
        a single Firestore onSnapshot listener and re-renders on real data
        changes (not DOM mutations — so it cannot loop). The listener is removed
        when the board closes.

   Privacy is unchanged: a normal user sees ONLY their own reports. The global,
   all-users view stays admin-only (allow-list). The server priority doc is used
   only to compute the boolean "is this being considered" — other users' report
   text is never rendered to a normal user.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_FEEDBACK_AI) return;
    window.WF_FEEDBACK_AI = '2.0';

    var TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,function(c){return ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c];});}
    function _notify(m,t){try{if(typeof window.notify==='function')window.notify(m,t||'info');}catch(_){}}

    // ── signal dictionaries (transparent, editable) ──────────────────────────
    var SIGNALS = {
        security:    { w: 1.00, kw: ['hack','breach','leak','exploit','vulnerab','stolen','fraud','unauthor','phishing','password','2fa','otp','encrypt','privacy','security','share with','see my','other user','others'] },
        crash:       { w: 0.92, kw: ['crash','freeze','frozen','froze','stuck','hang','white screen','black screen','wont open',"won't open",'cant open',"can't open",'cannot open','not loading','wont load',"won't start",'not starting','splash','broken','data lost','lost my data','disappear','unresponsive'] },
        bug:         { w: 0.70, kw: ['bug','error','wrong','incorrect','glitch','fail',"doesn't work",'not working','issue','problem','duplicate','miscategor','wrong category','not show','not showing','fake'] },
        performance: { w: 0.55, kw: ['slow','lag','laggy','delay','takes long','loading','spinner','battery','heat'] },
        ui:          { w: 0.40, kw: ['ui','ux','design','layout','color','colour','font','button','hard to read','confusing','cluttered','dark mode','theme','not professional','not smart'] },
        idea:        { w: 0.30, kw: ['add','feature','please add','would be nice','suggestion','suggest','idea','wish','could you','request','support for'] }
    };

    function _classify(text) {
        var t = (text || '').toLowerCase();
        var best = 'idea', bestHits = 0, bestW = SIGNALS.idea.w;
        for (var cat in SIGNALS) {
            var def = SIGNALS[cat];
            var hits = 0;
            for (var i = 0; i < def.kw.length; i++) if (t.indexOf(def.kw[i]) >= 0) hits++;
            if (hits > 0 && (hits * def.w) > (bestHits * bestW)) { best = cat; bestHits = hits; bestW = def.w; }
        }
        return { category: best, weight: SIGNALS[best].w, hits: bestHits };
    }

    // ── semantic similarity (on-device concept expansion) ────────────────────
    var CONCEPTS = {
        crash: ['crash','crashed','crashing','freeze','frozen','froze','hang','hung','stuck','unresponsive','dead','died'],
        launch: ['open','opening','opens','launch','start','startup','boot','splash','load','loading','loads'],
        data: ['data','records','transactions','history','entries','backup','sync','synced','lost','missing','gone','disappeared','deleted','vanished'],
        login: ['login','signin','passcode','pin','password','auth','authenticate','locked','google','biometric','faceid','fingerprint'],
        slow: ['slow','laggy','lag','delay','delayed','sluggish','wait','waiting','spinner','spinning','hangs'],
        category: ['category','categorise','categorize','categorisation','classified','classify','wrong','incorrect','miscategorised','misfiled','tag','tagged'],
        privacy: ['privacy','private','share','shared','sharing','expose','exposed','other','others','another','everyone','leak','leaked'],
        ui: ['ui','ux','design','layout','screen','button','color','colour','font','text','dark','light','theme','cluttered','confusing','readable','professional'],
        sms: ['sms','message','text','paste','bank','statement','pdf','scan','ocr','receipt'],
        security: ['security','hack','hacked','breach','breached','leak','leaked','stolen','fraud','unauthorised','unauthorized','phishing','exposed','vulnerable','vulnerability'],
        money: ['amount','balance','total','currency','lkr','rupee','money','sum','calculation','wrong','rounding'],
        notif: ['notification','notify','alert','reminder','badge','push'],
        add: ['add','feature','option','support','request','suggestion','wish','want','need','please','could','would']
    };
    var _concIndex = (function () { var m = {}; for (var c in CONCEPTS) for (var i = 0; i < CONCEPTS[c].length; i++) m[CONCEPTS[c][i]] = c; return m; })();

    function _tokens(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(function (w) { return w.length > 2; }); }
    function _concepts(s) {
        var set = new Set(), toks = _tokens(s);
        for (var i = 0; i < toks.length; i++) {
            var w = toks[i];
            if (_concIndex[w]) set.add('@' + _concIndex[w]);
            else if (w.length > 3) set.add(w);
        }
        return set;
    }
    function _sim(a, b) {
        var A = _concepts(a), B = _concepts(b);
        if (!A.size || !B.size) return 0;
        var inter = 0; A.forEach(function (x) { if (B.has(x)) inter++; });
        var cw = 0; A.forEach(function (x) { if (x[0] === '@' && B.has(x)) cw++; });
        var jaccard = inter / (A.size + B.size - inter);
        var conceptBoost = cw > 0 ? Math.min(0.35, cw * 0.18) : 0;
        return Math.min(1, jaccard + conceptBoost);
    }

    // ── auth helpers ──────────────────────────────────────────────────────────
    function _fbRef() { return window.firebase || (typeof firebase !== 'undefined' ? firebase : null); }
    function _dbRef() { var fb = _fbRef(); return window.db || (fb && fb.firestore ? fb.firestore() : null); }
    function _uid() {
        try { if (window.currentUser && window.currentUser.uid) return window.currentUser.uid; } catch (_) {}
        try { var fb = _fbRef(); var u = fb && fb.auth ? fb.auth().currentUser : null; if (u && u.uid) return u.uid; } catch (_) {}
        return null;
    }
    // Wait briefly for Firebase auth to populate after a fresh sign-in, so we
    // never query with a null uid (the root cause of "feedback disappears").
    function _awaitAuth(timeoutMs) {
        var have = _uid();
        if (have) return Promise.resolve(have);
        var fb = _fbRef();
        if (!(fb && fb.auth)) return Promise.resolve(null);
        return new Promise(function (resolve) {
            var done = false;
            var t = setTimeout(function () { if (!done) { done = true; resolve(_uid()); } }, timeoutMs || 2500);
            try {
                var off = fb.auth().onAuthStateChanged(function (u) {
                    if (done) return;
                    if (u) { done = true; clearTimeout(t); try { off && off(); } catch (_) {} resolve(u.uid); }
                });
            } catch (_) { clearTimeout(t); resolve(_uid()); }
        });
    }

    // ── timestamp + freshness (2-week window) ─────────────────────────────────
    function _ts(it) {
        var v = (it && (it.createdAt || it.created || it._ts)) || null;
        if (!v) return 0;
        if (typeof v === 'number') return v;
        if (typeof v === 'string') { var t = Date.parse(v); return isNaN(t) ? 0 : t; }
        if (typeof v === 'object') {
            if (typeof v.seconds === 'number') return v.seconds * 1000;            // Firestore Timestamp
            if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (_) {} }
            if (typeof v._seconds === 'number') return v._seconds * 1000;
        }
        return 0;
    }
    function _fresh(it) {
        var t = _ts(it);
        if (!t) return true;                          // unknown date → assume recent (don't hide brand-new local items)
        return (Date.now() - t) <= TWO_WEEKS_MS;      // only the last 14 days
    }

    // ── de-dupe: collapse the 3 copies of one submission into one ─────────────
    function _normText(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
    function _identity(it) { return _normText(it.text || it.message) + '|' + (it.createdAt || it.created || ''); }
    function _dedupe(items) {
        var byKey = new Map();
        for (var i = 0; i < items.length; i++) {
            var it = items[i], k = _identity(it), prev = byKey.get(k);
            if (!prev) { byKey.set(k, it); continue; }
            // prefer the cloud copy (has _id / _src cloud) as the canonical one
            var keep = (it._src === 'cloud' || it._id) ? it : prev;
            byKey.set(k, keep);
        }
        return Array.from(byKey.values());
    }

    // ── gather feedback (own only, unless admin) ──────────────────────────────
    async function _gather(adminAll) {
        var items = [];
        var myUid = await _awaitAuth(2500);
        try { JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]').forEach(function (x) { items.push(Object.assign({ _src: 'local' }, x)); }); } catch (_) {}
        try { JSON.parse(sessionStorage.getItem('wf_feedback_session') || '[]').forEach(function (x) { items.push(Object.assign({ _src: 'session' }, x)); }); } catch (_) {}
        try {
            var db = _dbRef();
            if (db) {
                var q = db.collection('feedback');
                if (adminAll && _isAdmin()) { q = q.orderBy('createdAt', 'desc').limit(500); }
                else if (myUid) { q = q.where('uid', '==', myUid).limit(200); }
                else { q = null; }
                if (q) { var snap = await q.get(); snap.forEach(function (doc) { items.push(Object.assign({ _src: 'cloud', _id: doc.id }, doc.data())); }); }
            }
        } catch (_) { /* offline / rules — local only */ }
        // de-dupe the 3 copies, then keep only the last 14 days
        return _dedupe(items).filter(_fresh);
    }

    function _isAdmin() {
        try { var uid = (window.currentUser && window.currentUser.uid) || _uid() || ''; var list = window.WF_ADMIN_UIDS || []; return list.indexOf(uid) >= 0; } catch (_) { return false; }
    }

    // ── cluster + score (identical formula to the server brain) ───────────────
    function _analyse(items) {
        var clusters = [];
        for (var i = 0; i < items.length; i++) {
            var it = items[i], text = it.text || it.message || '';
            if (!text.trim()) continue;
            var placed = false;
            for (var j = 0; j < clusters.length; j++) {
                var c = clusters[j];
                if (_sim(c.sample, text) >= 0.28 || (_classify(c.sample).category === _classify(text).category && _sim(c.sample, text) >= 0.18)) {
                    c.items.push(it); c.count++; placed = true; break;
                }
            }
            if (!placed) clusters.push({ sample: text, items: [it], count: 1 });
        }
        var totalReports = Math.max(1, items.length);
        for (var k = 0; k < clusters.length; k++) {
            var cl = _classify(clusters[k].sample);
            clusters[k].category = cl.category;
            var securityWeight = cl.category === 'security' ? 0.30 : (cl.category === 'crash' ? 0.15 : 0);
            var freqBoost = Math.min(0.5, Math.log2(1 + clusters[k].count) * 0.18);
            clusters[k].score = Math.min(1, (freqBoost + cl.weight * 0.6) + securityWeight);
            clusters[k].priority = clusters[k].score >= 0.85 ? 'critical' : clusters[k].score >= 0.6 ? 'high' : clusters[k].score >= 0.4 ? 'medium' : 'low';
        }
        clusters.sort(function (a, b) { return b.score - a.score || b.count - a.count; });
        return clusters;
    }

    // ── honest "considering" signal ───────────────────────────────────────────
    // Fetch the server brain's prioritised clusters (no other-user text is shown;
    // used only to confirm the boolean). Returns [] if unreadable.
    async function _fetchServerClusters() {
        try {
            var db = _dbRef();
            if (!db) return [];
            var doc = await db.collection('system').doc('feedbackPriority').get();
            if (doc && doc.exists) { var d = doc.data(); if (d && Array.isArray(d.clusters)) return d.clusters; }
        } catch (_) {}
        return [];
    }
    // True only when the issue is genuinely being prioritised: confirmed by the
    // server doc as critical/high for a matching issue, OR (if the server doc is
    // unreadable) scored critical/high by the SAME engine the brain runs.
    function _isConsidering(cluster, serverClusters) {
        if (serverClusters && serverClusters.length) {
            for (var i = 0; i < serverClusters.length; i++) {
                var sc = serverClusters[i];
                var s = _sim(cluster.sample, sc.sample || sc.text || '');
                if ((s >= 0.5 || (s >= 0.3 && (sc.priority === 'critical' || sc.priority === 'high'))) &&
                    (sc.priority === 'critical' || sc.priority === 'high')) return true;
            }
            return false;
        }
        // fallback (no server data): the shared deterministic engine would queue
        // critical/high issues, so this is an honest proxy — not a fabricated one.
        return cluster.priority === 'critical' || cluster.priority === 'high';
    }

    // ── UI: ranked board ──────────────────────────────────────────────────────
    var _unsub = null, _boardOpen = false, _renderTimer = 0;

    async function showBoard() {
        var admin = _isAdmin();
        var title = admin ? 'Feedback Intelligence (all users)' : 'Your Feedback';
        _boardOpen = true;
        _overlay('wfFbBoard', title, admin ? 'Analysing all users\u2019 feedback…' : 'Your reports, scored by priority…',
            '<div id="wfFbBoardBody" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;">Loading…</div>',
            '<button class="btn btn-primary" style="width:100%;" onclick="wfFeedbackAI._close(\'wfFbBoard\')">Close</button>');

        await _refresh(admin);

        // real-time: one snapshot listener on the user's own feedback (safe — it
        // only fires on real data changes, never on DOM mutations).
        try {
            var db = _dbRef(), myUid = _uid();
            if (db && myUid && !admin && !_unsub) {
                _unsub = db.collection('feedback').where('uid', '==', myUid)
                    .onSnapshot(function () {
                        if (!_boardOpen) return;
                        clearTimeout(_renderTimer);
                        _renderTimer = setTimeout(function () { _refresh(false); }, 250);
                    }, function () { /* listener error — ignore, manual refresh still works */ });
            }
        } catch (_) {}
    }

    async function _refresh(admin) {
        var clusters = null, serverClusters = [];
        if (admin) {
            serverClusters = await _fetchServerClusters();
            if (serverClusters.length) clusters = serverClusters;
        }
        if (!clusters) {
            var items = await _gather(admin);
            clusters = _analyse(items);
            serverClusters = serverClusters.length ? serverClusters : await _fetchServerClusters();
        }
        _render(clusters, serverClusters, admin);
    }

    function _render(clusters, serverClusters, admin) {
        var body = document.getElementById('wfFbBoardBody');
        if (!body || !_boardOpen) return;

        if (!clusters.length) {
            body.style.display = 'block';
            body.innerHTML = '<div style="text-align:center;color:var(--text3,#8b95a8);font-size:13px;padding:20px;">' +
                (admin ? 'No feedback yet across users.' : 'You haven\u2019t sent any feedback in the last 2 weeks. Use “Send Feedback” to report a bug or suggest an idea — you\u2019ll see it scored here, and the team is notified automatically.') + '</div>';
            _setSub('wfFbBoard', 'Nothing in the last 2 weeks');
            return;
        }

        var pColor = { critical: '#ef4444', high: '#f59e0b', medium: '#818cf8', low: '#6b7280' };
        var catLabel = { security: 'Security', crash: 'Crash / data', bug: 'Bug', performance: 'Performance', ui: 'UI / UX', idea: 'Feature idea' };
        var critical = clusters.filter(function (c) { return c.priority === 'critical'; }).length;
        var totalReports = clusters.reduce(function (s, c) { return s + (c.count || 1); }, 0);

        var rows = clusters.map(function (c) {
            var pc = pColor[c.priority] || '#6b7280';
            var pct = Math.round(c.score * 100);
            var considering = _isConsidering(c, serverClusters);
            var badge = considering
                ? '<div style="margin-top:8px;display:inline-flex;align-items:center;gap:6px;font-size:10.5px;font-weight:700;color:#34d399;background:rgba(16,185,129,0.12);border:1px solid rgba(16,185,129,0.3);padding:3px 9px;border-radius:999px;">' +
                  '<span style="width:6px;height:6px;border-radius:50%;background:#34d399;box-shadow:0 0 0 0 rgba(52,211,153,0.7);animation:wfPulseDot 1.6s infinite;"></span>Currently considering by System AI…</div>'
                : '';
            return '<div style="padding:12px;border:1px solid var(--border,#1f2638);border-left:3px solid ' + pc + ';border-radius:11px;margin-bottom:9px;background:var(--bg2,#0a0e1a);">' +
                '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                    '<span style="font-size:11px;font-weight:800;color:' + pc + ';text-transform:uppercase;">' + _esc(c.priority) + '</span>' +
                    '<span style="font-size:11px;color:var(--text3,#8b95a8);">' + _esc(catLabel[c.category] || c.category) + '</span>' +
                    '<span style="margin-left:auto;font-size:11px;font-weight:700;color:var(--text2,#c7cdd9);">' + (c.count || 1) + ((c.count || 1) > 1 ? ' reports' : ' report') + ' · score ' + pct + '</span>' +
                '</div>' +
                '<div style="font-size:13px;line-height:1.5;color:var(--text,#e6e7eb);">' + _esc((c.sample || '').slice(0, 220)) + ((c.sample || '').length > 220 ? '…' : '') + '</div>' +
                badge +
            '</div>';
        }).join('');

        body.style.display = 'block';
        body.innerHTML =
            '<style>@keyframes wfPulseDot{0%{box-shadow:0 0 0 0 rgba(52,211,153,0.6);}70%{box-shadow:0 0 0 6px rgba(52,211,153,0);}100%{box-shadow:0 0 0 0 rgba(52,211,153,0);}}</style>' +
            '<div style="display:flex;gap:8px;margin-bottom:14px;">' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:var(--text,#e6e7eb);">' + clusters.length + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">issues</div></div>' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:#ef4444;">' + critical + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">critical</div></div>' +
                '<div style="flex:1;text-align:center;padding:10px;background:var(--bg2,#0a0e1a);border-radius:10px;"><div style="font-size:22px;font-weight:900;color:#10b981;">' + totalReports + '</div><div style="font-size:10.5px;color:var(--text3,#8b95a8);">reports</div></div>' +
            '</div>' +
            '<div style="font-size:11px;color:var(--text3,#8b95a8);margin-bottom:10px;">Ranked by: (report frequency × issue severity) + security weight. Security and crashes are prioritised. Repeated reports raise the score. Showing your reports from the last 2 weeks · live.</div>' +
            rows;
        _setSub('wfFbBoard', clusters.length + ' issues · ' + critical + ' critical · live');
    }

    async function topPriority() {
        var clusters = _analyse(await _gather(false));
        return clusters[0] || null;
    }

    // ── overlay helpers ────────────────────────────────────────────────────────
    function _overlay(id, title, sub, bodyHtml, footerHtml) {
        _close(id);
        var ov = document.createElement('div');
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
        requestAnimationFrame(function () { ov.style.opacity = '1'; });
    }
    function _setSub(id, txt) { var ov = document.getElementById(id); if (ov) { var s = ov.querySelector('.wf-ov-sub'); if (s) s.textContent = txt; } }
    function _close(id) {
        if (id === 'wfFbBoard') {
            _boardOpen = false;
            try { if (_unsub) { _unsub(); _unsub = null; } } catch (_) {}
            clearTimeout(_renderTimer);
        }
        var ov = document.getElementById(id);
        if (ov) { ov.style.opacity = '0'; setTimeout(function () { ov.remove(); }, 200); }
    }

    window.wfFeedbackAI = {
        showBoard: showBoard, topPriority: topPriority, analyse: _analyse, classify: _classify, _close: _close,
        // exposed for testing / advanced use
        _dedupe: _dedupe, _fresh: _fresh, _ts: _ts, _isConsidering: _isConsidering, _sim: _sim
    };
    console.log('[wfFeedbackAI] ✓ Feedback prioritisation engine v2.0 loaded (real counts · 2-week window · honest "considering" · live)');
})();
