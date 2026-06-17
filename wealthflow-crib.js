/*  wealthflow-crib.js — CRIB credit-report intelligence
 *  ===========================================================================
 *  Sri Lanka's Credit Information Bureau (CRIB) issues a credit report with a
 *  CRIB score (250–900), a risk category, and the full list of a person's
 *  credit facilities, defaults/arrears and inquiries. This module lets the
 *  user attach a CRIB report (PDF or image), runs deep AI analysis IN THE
 *  USER'S SELECTED LANGUAGE, tracks every report (de-duplicated), compares the
 *  newest against all past reports with charts, gives an actionable advice
 *  paragraph, and feeds a CRIB factor into the WealthFlow score.
 *
 *  Storage (per-user, synced):
 *    DB.get('cribReports')   → [ {id, ts, dateLabel, fingerprint, score,
 *                                 category, summary, fields, fileName} ]
 *    DB.getObj('cribAnalyses', {}) → { [reportId]: {analysis, advice, charts, ts, lang} }
 *
 *  Public API (window.WFCrib):
 *    open()                         open the CRIB screen
 *    handleUpload(file)             OCR → extract → dedup → analyse → save
 *    list()                         sorted reports (newest first)
 *    get(id) / getAnalysis(id)
 *    deleteReport(id)               removes report + analysis + syncs advisor
 *    compare()                      {labels, scores, categories, deltas}
 *    scoreFactor()                  0..1 contribution to the WealthFlow score
 *    contextForAdvisor()            compact text the AI advisor can read
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFCrib) return;

    var DB = window.DB;
    function _db() { return window.DB || DB; }

    // ── self-hydration ─────────────────────────────────────────────────────────
    // The host's boot loader only re-loads appData keys it already knows about.
    // Since we don't edit index.html, our keys may not be in that seed — so we
    // hydrate cribReports/cribAnalyses from localStorage ourselves on load, and
    // ensure DB.set persists them (DB.set already writes wf2_<key> + cloud sync).
    (function _hydrate() {
        try {
            var d = _db(); if (!d) return;
            ['cribReports', 'cribAnalyses'].forEach(function (k) {
                try {
                    var cur = (k === 'cribReports') ? d.get(k, null) : d.getObj(k, null);
                    var has = (k === 'cribReports') ? Array.isArray(cur) && cur.length : (cur && Object.keys(cur).length);
                    if (!has) {
                        var raw = localStorage.getItem('wf2_' + k);
                        if (raw) {
                            var val = JSON.parse(raw);
                            // seed into appData WITHOUT triggering a cloud write
                            if (window.appData) window.appData[k] = val;
                            else d.set(k, val, true);
                        }
                    }
                } catch (_) {}
            });
        } catch (_) {}
    })();

    // ── small utils ────────────────────────────────────────────────────────────
    function _uid() { return 'crib_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
    function _now() { return Date.now(); }
    function fmtNum(n) { try { return (Number(n) || 0).toLocaleString(); } catch (_) { return String(n); } }

    function _settings() { try { return (_db().getObj('settings', {})) || {}; } catch (_) { return {}; } }
    function _langName() {
        var s = _settings();
        var names = window.WF_LANG_NAMES || {};
        var code = s.aiResponseLang || 'en';
        if (code === 'auto' || !code) return 'English';
        var n = names[code] || 'English';
        // strip the native-script suffix in parens for the model instruction
        return String(n).replace(/\s*\(.*\)\s*$/, '').replace(/^🌐\s*/, '') || 'English';
    }

    // Stable fingerprint of a report so re-uploading the SAME report is detected.
    // Built from the strongest invariants (score + report date + sorted facility
    // signatures + total outstanding). Falls back to a hash of the raw text.
    function fingerprint(fields, rawText) {
        try {
            var parts = [];
            if (fields) {
                if (fields.score != null) parts.push('s' + fields.score);
                if (fields.reportDate) parts.push('d' + String(fields.reportDate).replace(/[^0-9]/g, ''));
                if (fields.category) parts.push('c' + String(fields.category).toLowerCase().replace(/\s+/g, ''));
                if (fields.totalOutstanding != null) parts.push('o' + Math.round(fields.totalOutstanding));
                if (Array.isArray(fields.facilities)) {
                    var sig = fields.facilities.map(function (f) {
                        return (String(f.type || '') + '|' + String(f.lender || '') + '|' + Math.round(f.amount || 0)).toLowerCase();
                    }).sort().join(';');
                    parts.push('f' + sig);
                }
            }
            var basis = parts.join('~');
            if (basis.length < 8 && rawText) basis = rawText.replace(/\s+/g, ' ').trim().slice(0, 2000);
            return _hash(basis);
        } catch (_) {
            return _hash((rawText || '') + Math.random());
        }
    }
    function _hash(str) {
        // djb2 → hex (sync, dependency-free; good enough for dedup keys)
        var h = 5381;
        for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        // mix a second pass for fewer collisions
        var h2 = 52711;
        for (var j = str.length - 1; j >= 0; j--) h2 = ((h2 << 5) + h2 + str.charCodeAt(j)) >>> 0;
        return ('00000000' + h.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
    }

    // ── persistence ──────────────────────────────────────────────────────────
    function list() {
        var arr = [];
        try { arr = (_db().get('cribReports') || []).slice(); } catch (_) {}
        arr.sort(function (a, b) { return (b.ts || 0) - (a.ts || 0); });
        return arr;
    }
    function get(id) { return list().filter(function (r) { return r.id === id; })[0] || null; }
    function getAnalysis(id) {
        try { return (_db().getObj('cribAnalyses', {}) || {})[id] || null; } catch (_) { return null; }
    }
    function _saveReport(rep) {
        var arr = [];
        try { arr = (_db().get('cribReports') || []).slice(); } catch (_) {}
        arr.push(rep);
        _db().set('cribReports', arr);
    }
    function _saveAnalysis(id, payload) {
        var m = {};
        try { m = Object.assign({}, _db().getObj('cribAnalyses', {})); } catch (_) {}
        m[id] = payload;
        _db().set('cribAnalyses', m);
    }
    function deleteReport(id) {
        var arr = [];
        try { arr = (_db().get('cribReports') || []).filter(function (r) { return r.id !== id; }); } catch (_) {}
        _db().set('cribReports', arr);
        var m = {};
        try { m = Object.assign({}, _db().getObj('cribAnalyses', {})); } catch (_) {}
        if (m[id]) { delete m[id]; _db().set('cribAnalyses', m); }
        // Sync the deletion to the AI advisor's knowledge so it forgets this report.
        try { if (window.WealthFlowAIMemory && window.WealthFlowAIMemory.refreshContext) window.WealthFlowAIMemory.refreshContext(); } catch (_) {}
        try { if (typeof window._wfSyncAdvisorContext === 'function') window._wfSyncAdvisorContext(); } catch (_) {}
        try { if (typeof window.recomputeWFScore === 'function') window.recomputeWFScore(); else if (typeof window.renderWFScore === 'function') window.renderWFScore(); } catch (_) {}
        return true;
    }

    // ── OCR (Cloud Vision via /api/vision, with graceful fallbacks) ─────────────
    function _apiBase() {
        try { if (typeof window._apiBase === 'function') return window._apiBase(); } catch (_) {}
        return '/api';
    }
    function _fileToBase64Capped(file) {
        // Reuse the v4 memory-safe extractor when available (handles iOS).
        if (window.WF_AI_V4 && typeof window.WF_AI_V4.fileToImages === 'function') {
            return window.WF_AI_V4.fileToImages(file, { maxPages: 4, maxBytes: 3.4 * 1024 * 1024, maxDim: 2200 })
                .then(function (b) { return b.images || []; });
        }
        // minimal fallback: single image read
        return new Promise(function (resolve, reject) {
            var r = new FileReader();
            r.onload = function () {
                var img = new Image();
                img.onload = function () {
                    var maxDim = 2000, w = img.naturalWidth, h = img.naturalHeight;
                    if (w > h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
                    else if (h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
                    var c = document.createElement('canvas'); c.width = w; c.height = h;
                    var cx = c.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, w, h); cx.drawImage(img, 0, 0, w, h);
                    var b64 = c.toDataURL('image/jpeg', 0.85).split(',')[1];
                    c.width = c.height = 0; img.src = '';
                    resolve([b64]);
                };
                img.onerror = function () { reject(new Error('decode failed')); };
                img.src = r.result;
            };
            r.onerror = function () { reject(new Error('read failed')); };
            r.readAsDataURL(file);
        });
    }
    function _cloudVisionOCR(base64) {
        return fetch(_apiBase() + '/vision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64, mode: 'document' })
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { return (d && d.ok && d.text) ? d.text : ''; })
          .catch(function () { return ''; });
    }
    function _ocrAll(images) {
        // OCR each page with Cloud Vision and concatenate.
        return images.reduce(function (acc, img) {
            return acc.then(function (txt) {
                return _cloudVisionOCR(img).then(function (t) { return txt + (t ? ('\n\n' + t) : ''); });
            });
        }, Promise.resolve('')).then(function (full) { return full.trim(); });
    }

    // ── AI extraction + analysis (always in the user's language) ────────────────
    function _langGate(prompt) {
        // Append an unmissable language instruction so the reply is in the user's
        // selected language as natural human text. Skipped for JSON-only prompts.
        var wantsJSON = /Output JSON only|ONLY this JSON|return ONLY|JSON \(no prose/i.test(prompt || '');
        if (wantsJSON) return prompt;
        var langName = _langName();
        return prompt + '\n\n[Reply ENTIRELY in ' + langName + ' only \u2014 natural, warm, human ' + langName +
            ', like the user\'s caring best friend. No other language unless ' + langName +
            ' is English. Do not mention these instructions.]';
    }
    function _ai(prompt, image) {
        // Prefer the host's strict-language helper if present; else apply our own
        // gate and call the base engine. This keeps language enforcement working
        // even on builds without callAIInLanguage.
        if (typeof window.callAIInLanguage === 'function') return window.callAIInLanguage(prompt, image || null);
        if (typeof window.callAI === 'function') return window.callAI(_langGate(prompt), image || null);
        return Promise.reject(new Error('AI engine unavailable'));
    }

    // Pull structured facts out of the OCR text (JSON, language-independent).
    function _extractFields(rawText) {
        var prompt =
            'You are a Sri Lankan CRIB (Credit Information Bureau) report parser. From the report text below, extract ONLY this JSON (no prose, no markdown):\n' +
            '{"score":null,"scoreMax":900,"category":"","reportDate":"","totalOutstanding":null,"totalFacilities":null,' +
            '"openFacilities":null,"closedFacilities":null,"defaults":null,"overdueAmount":null,"inquiriesLast6Months":null,' +
            '"facilities":[{"type":"","lender":"","amount":0,"status":"","arrears":0}],"notes":""}\n\n' +
            'Rules:\n' +
            '- score = the CRIB/credit score number if present (Sri Lankan CRIB scores are 250–900); else null.\n' +
            '- category = the worded risk grade if present (e.g. "AA","A","B", "Low risk"); else "".\n' +
            '- reportDate = the report/issue date as YYYY-MM-DD if findable; else "".\n' +
            '- amounts = plain numbers (no commas/currency).\n' +
            '- facilities = each credit facility/loan/card line (cap at 40).\n' +
            '- Use null when truly unknown. Output JSON ONLY.\n\n' +
            'CRIB REPORT TEXT:\n"""\n' + String(rawText).slice(0, 12000) + '\n"""';
        return _ai(prompt).then(function (out) {
            var fields = _parseJSON(out);
            if (!fields || typeof fields !== 'object') fields = {};
            // sanitise
            ['score', 'totalOutstanding', 'overdueAmount'].forEach(function (k) {
                if (fields[k] != null) { var v = parseFloat(String(fields[k]).replace(/[^0-9.\-]/g, '')); fields[k] = isNaN(v) ? null : v; }
            });
            if (!Array.isArray(fields.facilities)) fields.facilities = [];
            return fields;
        });
    }
    function _parseJSON(s) {
        if (!s) return null;
        var t = String(s).replace(/```json|```/g, '').trim();
        try { return JSON.parse(t); } catch (_) {}
        var m = t.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
        return null;
    }

    // Deep, human, best-friend analysis + a SEPARATE advice paragraph — in the
    // user's language. Returns { analysis, advice }.
    function _analyse(fields, rawText, financialCtx) {
        var langName = _langName();
        var ctxLine = '';
        try {
            if (financialCtx) {
                ctxLine = '\n\nThe person\'s WealthFlow money snapshot (use it to connect CRIB to their real situation): ' +
                    JSON.stringify({
                        monthlyIncome: financialCtx.totalMonthlyIncome,
                        monthlyExpenses: financialCtx.thisMonthExpenses,
                        monthlyLoanPayments: financialCtx.monthlyLoanPayments,
                        netCashFlow: financialCtx.netMonthlyCashFlow,
                        balance: financialCtx.balanceOnHand,
                        activeLoans: financialCtx.activeLoans
                    });
            }
        } catch (_) {}

        var prompt =
            'You are WealthFlow AI — the user\'s warm, brilliant best friend who also happens to be a top Sri Lankan credit expert. ' +
            'Talk like a real person texting a friend: natural, caring, encouraging, never robotic, never corporate. ' +
            'You are reviewing their CRIB credit report.\n\n' +
            'Here is the extracted data (JSON):\n' + JSON.stringify(fields) + ctxLine + '\n\n' +
            'Write TWO clearly separated sections, and nothing else:\n\n' +
            '[ANALYSIS]\n' +
            'A warm, deep, easy-to-understand read of their CRIB report — what their score and category really mean, what their facilities/defaults/inquiries say about them, and how it connects to their real money situation. Be specific and honest but kind. 2–4 short paragraphs.\n\n' +
            '[ADVICE]\n' +
            'A separate, practical action plan to IMPROVE their CRIB score, advance their risk category, and strengthen their personal CRIB account. Give concrete, prioritised steps (settle X, keep utilisation under Y%, avoid hard inquiries, fix arrears first, etc.), each with a one-line "why". Encourage them — make them feel it is achievable.\n\n' +
            'Write the ENTIRE response in ' + langName + ' only, in natural human ' + langName + '. Use the exact tags [ANALYSIS] and [ADVICE] (in English) to separate the two sections.';

        return _ai(prompt).then(function (out) {
            var text = String(out || '');
            var aIdx = text.indexOf('[ANALYSIS]');
            var dIdx = text.indexOf('[ADVICE]');
            var analysis = text, advice = '';
            if (aIdx !== -1 && dIdx !== -1 && dIdx > aIdx) {
                analysis = text.slice(aIdx + 10, dIdx).trim();
                advice = text.slice(dIdx + 8).trim();
            } else if (dIdx !== -1) {
                analysis = text.slice(0, dIdx).replace('[ANALYSIS]', '').trim();
                advice = text.slice(dIdx + 8).trim();
            } else {
                analysis = text.replace('[ANALYSIS]', '').trim();
            }
            return { analysis: analysis, advice: advice };
        });
    }

    // ── score factor (0..1) for the WealthFlow score ────────────────────────────
    // Maps the latest CRIB score (or category) to 0..1. Encourages improvement.
    function scoreFactor() {
        var reps = list();
        if (!reps.length) return null;            // null = no CRIB data → score unaffected
        var latest = reps[0];
        var s = latest.score, max = latest.scoreMax || 900;
        if (s != null && !isNaN(s)) {
            // CRIB SL band ~250..900 → normalise; clamp 0..1
            var lo = 250, hi = max || 900;
            var f = (s - lo) / (hi - lo);
            return Math.max(0, Math.min(1, f));
        }
        // category fallback
        var cat = String(latest.category || '').toUpperCase();
        var catMap = { 'AA': 1, 'A': 0.85, 'B': 0.65, 'C': 0.45, 'D': 0.3, 'HH': 0.15 };
        if (catMap[cat] != null) return catMap[cat];
        if (/low/.test(cat)) return 0.85; if (/medium|moderate/.test(cat)) return 0.55; if (/high/.test(cat)) return 0.25;
        return 0.5;
    }

    // ── comparison (charts data) ────────────────────────────────────────────────
    function compare() {
        var reps = list().slice().reverse(); // oldest → newest for a timeline
        var labels = reps.map(function (r) { return r.dateLabel || new Date(r.ts).toISOString().slice(0, 10); });
        var scores = reps.map(function (r) { return (r.score != null ? r.score : null); });
        var outstanding = reps.map(function (r) { return (r.fields && r.fields.totalOutstanding != null) ? r.fields.totalOutstanding : null; });
        var defaults = reps.map(function (r) { return (r.fields && r.fields.defaults != null) ? r.fields.defaults : null; });
        var deltas = null;
        if (reps.length >= 2) {
            var a = reps[reps.length - 2], b = reps[reps.length - 1];
            deltas = {
                score: (b.score != null && a.score != null) ? (b.score - a.score) : null,
                outstanding: (b.fields && a.fields && b.fields.totalOutstanding != null && a.fields.totalOutstanding != null) ? (b.fields.totalOutstanding - a.fields.totalOutstanding) : null,
                defaults: (b.fields && a.fields && b.fields.defaults != null && a.fields.defaults != null) ? (b.fields.defaults - a.fields.defaults) : null
            };
        }
        return { labels: labels, scores: scores, outstanding: outstanding, defaults: defaults, deltas: deltas, count: reps.length };
    }

    // ── advisor context (compact, for the AI advisor full-sync) ─────────────────
    function contextForAdvisor() {
        var reps = list();
        if (!reps.length) return '';
        var latest = reps[0];
        var lines = ['CRIB credit report (latest of ' + reps.length + '):'];
        if (latest.score != null) lines.push('  • Score: ' + latest.score + '/' + (latest.scoreMax || 900));
        if (latest.category) lines.push('  • Category: ' + latest.category);
        if (latest.fields) {
            if (latest.fields.totalOutstanding != null) lines.push('  • Total outstanding: LKR ' + fmtNum(latest.fields.totalOutstanding));
            if (latest.fields.defaults != null) lines.push('  • Defaults: ' + latest.fields.defaults);
            if (latest.fields.overdueAmount != null) lines.push('  • Overdue: LKR ' + fmtNum(latest.fields.overdueAmount));
            if (latest.fields.inquiriesLast6Months != null) lines.push('  • Inquiries (6mo): ' + latest.fields.inquiriesLast6Months);
        }
        var c = compare();
        if (c.deltas && c.deltas.score != null) lines.push('  • Score change vs previous report: ' + (c.deltas.score >= 0 ? '+' : '') + c.deltas.score);
        return lines.join('\n');
    }

    // ── upload pipeline ─────────────────────────────────────────────────────────
    // OCR → extract → dedup → analyse → save. Resolves with
    // { duplicate:bool, report, analysis }.
    function handleUpload(file) {
        var financialCtx = null;
        try { if (typeof window.buildFinancialContext === 'function') financialCtx = window.buildFinancialContext(); } catch (_) {}

        return _fileToBase64Capped(file).then(function (images) {
            if (!images || !images.length) throw new Error('Could not read that file.');
            return _ocrAll(images).then(function (rawText) {
                if (!rawText || rawText.length < 20) {
                    // Vision unavailable → let the AI read the first image directly.
                    return _extractFieldsFromImage(images[0]).then(function (fields) {
                        return { rawText: '', fields: fields };
                    });
                }
                return _extractFields(rawText).then(function (fields) { return { rawText: rawText, fields: fields }; });
            });
        }).then(function (res) {
            var fields = res.fields || {};
            var fp = fingerprint(fields, res.rawText);
            var existing = list().filter(function (r) { return r.fingerprint === fp; })[0];
            if (existing) {
                // Already uploaded — DO NOT save again, but still surface the analysis.
                var an = getAnalysis(existing.id);
                if (an) return { duplicate: true, report: existing, analysis: an };
                // analysis missing for some reason → regenerate without saving a new report
                return _analyse(existing.fields || fields, res.rawText, financialCtx).then(function (a) {
                    _saveAnalysis(existing.id, { analysis: a.analysis, advice: a.advice, ts: _now(), lang: _langName() });
                    return { duplicate: true, report: existing, analysis: getAnalysis(existing.id) };
                });
            }
            // New report → analyse + save.
            return _analyse(fields, res.rawText, financialCtx).then(function (a) {
                var rep = {
                    id: _uid(), ts: _now(),
                    dateLabel: fields.reportDate || new Date().toISOString().slice(0, 10),
                    fingerprint: fp,
                    score: (fields.score != null ? fields.score : null),
                    scoreMax: fields.scoreMax || 900,
                    category: fields.category || '',
                    fields: fields,
                    fileName: file.name || 'CRIB report'
                };
                _saveReport(rep);
                _saveAnalysis(rep.id, { analysis: a.analysis, advice: a.advice, ts: _now(), lang: _langName() });
                // refresh score + advisor knowledge
                try { if (typeof window.recomputeWFScore === 'function') window.recomputeWFScore(); else if (typeof window.renderWFScore === 'function') window.renderWFScore(); } catch (_) {}
                try { if (typeof window._wfSyncAdvisorContext === 'function') window._wfSyncAdvisorContext(); } catch (_) {}
                return { duplicate: false, report: rep, analysis: getAnalysis(rep.id) };
            });
        });
    }

    function _extractFieldsFromImage(base64) {
        var prompt =
            'Look at this Sri Lankan CRIB credit report image and extract ONLY this JSON (no prose): ' +
            '{"score":null,"scoreMax":900,"category":"","reportDate":"","totalOutstanding":null,"totalFacilities":null,' +
            '"openFacilities":null,"closedFacilities":null,"defaults":null,"overdueAmount":null,"inquiriesLast6Months":null,' +
            '"facilities":[{"type":"","lender":"","amount":0,"status":"","arrears":0}],"notes":""}. ' +
            'Amounts as plain numbers. Use null when unknown. Output JSON only.';
        return _ai(prompt, base64).then(function (out) {
            var f = _parseJSON(out) || {};
            if (!Array.isArray(f.facilities)) f.facilities = [];
            return f;
        });
    }

    window.WFCrib = {
        open: function () { _openCrib(); },
        handleUpload: handleUpload,
        list: list, get: get, getAnalysis: getAnalysis,
        deleteReport: deleteReport,
        compare: compare, scoreFactor: scoreFactor,
        contextForAdvisor: contextForAdvisor,
        fingerprint: fingerprint, _extractFields: _extractFields, _analyse: _analyse,
        render: _renderCribUI
    };

    // ═══════════════════════════════════════════════════════════════════════════
    //  SELF-BOOTSTRAPPING UI — works as a pure drop-in on ANY WealthFlow build.
    //  If index.html already defines a CRIB page/render (newer builds), we use it;
    //  otherwise this injects its own nav item, page container and renders here.
    //  This guarantees CRIB works without editing index.html.
    // ═══════════════════════════════════════════════════════════════════════════
    function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function _notify(msg, type) { try { if (typeof window.notify === 'function') return window.notify(msg, type || 'info'); } catch (_) {} }
    function _haptic(k) { try { if (typeof window.triggerHaptic === 'function') window.triggerHaptic(k || 'light'); } catch (_) {} }

    function _ensureNavAndPage() {
        // Nav item — add next to the WealthFlow Score item if we can find it.
        if (!document.getElementById('wfCribNavItem')) {
            try {
                var navItems = document.querySelectorAll('.nav-item');
                var anchor = null;
                navItems.forEach(function (n) { if (/score/i.test(n.getAttribute('onclick') || '')) anchor = n; });
                var item = document.createElement('div');
                item.className = 'nav-item';
                item.id = 'wfCribNavItem';
                item.setAttribute('onclick', "WFCrib.open()");
                item.innerHTML = '<span class="nav-icon">\uD83D\uDCD1</span> CRIB Credit Report';
                if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(item, anchor.nextSibling);
                else {
                    var nav = document.querySelector('.nav-items, .sidebar-nav, nav');
                    if (nav) nav.appendChild(item);
                }
            } catch (_) {}
        }
        // Page container — only inject our own if the host build doesn't already have one.
        if (!document.getElementById('page-crib') && !document.getElementById('cribContent')) {
            try {
                var ref = document.getElementById('page-score') || document.querySelector('.page');
                if (ref && ref.parentNode) {
                    var pg = document.createElement('div');
                    pg.className = 'page';
                    pg.id = 'page-crib';
                    pg.innerHTML =
                        '<div class="sh"><div class="sh-title">\uD83D\uDCD1 CRIB Credit Report</div>' +
                        '<div class="sh-actions"><button class="btn btn-primary btn-sm" onclick="WFCrib._upload()">\uD83D\uDCCE Attach CRIB Report</button></div></div>' +
                        '<input type="file" id="crib_upload" accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf,.PDF,image/*" style="display:none;">' +
                        '<div id="cribContent"></div>';
                    ref.parentNode.insertBefore(pg, ref.nextSibling);
                    var inp = pg.querySelector('#crib_upload');
                    if (inp) inp.addEventListener('change', function (e) { _onUpload(e); });
                }
            } catch (_) {}
        }
    }

    function _openCrib() {
        _ensureNavAndPage();
        // Prefer the host's router if present.
        try {
            if (typeof window.showPage === 'function') { window.showPage('crib'); _renderCribUI(); return; }
        } catch (_) {}
        // Fallback: manual page switch.
        try {
            document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
            var pg = document.getElementById('page-crib');
            if (pg) pg.classList.add('active');
        } catch (_) {}
        _renderCribUI();
    }

    function _upload() {
        _ensureNavAndPage();
        var el = document.getElementById('crib_upload');
        if (el) el.click();
    }
    function _onUpload(e) {
        var file = e.target && e.target.files && e.target.files[0];
        if (e.target) e.target.value = '';
        if (!file) return;
        var host = document.getElementById('cribContent');
        if (host) host.insertAdjacentHTML('afterbegin', '<div id="cribBusy" style="background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:14px;padding:18px;margin-bottom:14px;display:flex;align-items:center;gap:12px;"><div style="width:10px;height:10px;border-radius:50%;background:var(--accent,#f5a623);animation:luxuryBlink 1.4s infinite;"></div><span style="font-weight:600;">Reading your CRIB report with Cloud Vision + AI\u2026</span></div>');
        _haptic('medium');
        handleUpload(file).then(function (res) {
            if (res && res.duplicate) _notify('\uD83D\uDCD1 You already uploaded this CRIB report \u2014 showing your saved analysis.', 'info');
            else if (res && res.report) _notify('\u2705 CRIB report analysed and saved.', 'success');
            _renderCribUI(res && res.report ? res.report.id : null);
        }).catch(function (err) {
            var b = document.getElementById('cribBusy'); if (b) b.remove();
            _notify('Could not analyse that CRIB report: ' + ((err && err.message) || 'unknown error'), 'error');
        });
    }

    function _renderCribUI(focusId) {
        // If the host build has its own renderCrib, defer to it (avoid double UI).
        if (typeof window.renderCrib === 'function' && window.renderCrib !== _renderCribUI && !window._wfCribUsingModuleUI) {
            try { return window.renderCrib(focusId); } catch (_) {}
        }
        window._wfCribUsingModuleUI = true;
        _ensureNavAndPage();
        var host = document.getElementById('cribContent');
        if (!host) return;
        var reports = list();
        if (!reports.length) {
            host.innerHTML =
                '<div style="text-align:center;padding:48px 18px;color:var(--text3,#8a97ad);">' +
                '<div style="font-size:44px;margin-bottom:12px;">\uD83D\uDCD1</div>' +
                '<div style="font-size:17px;font-weight:700;color:var(--text2,#aeb9cc);margin-bottom:6px;">No CRIB report yet</div>' +
                '<div style="font-size:13px;margin-bottom:18px;">Attach your CRIB credit report (PDF or photo). WealthFlow reads it with Cloud Vision, analyses it in your language, tracks it over time, and factors it into your score.</div>' +
                '<button class="btn btn-primary" onclick="WFCrib._upload()">\uD83D\uDCCE Attach CRIB Report</button></div>';
            return;
        }
        var latest = reports[0];
        var focus = focusId ? (get(focusId) || latest) : latest;
        var an = getAnalysis(focus.id);
        var cmp = compare();
        var sColor = (focus.score == null) ? 'var(--text2,#aeb9cc)' : (focus.score >= 750 ? 'var(--green,#10b981)' : focus.score >= 600 ? 'var(--accent,#f5a623)' : focus.score >= 450 ? 'var(--accent2,#e0a82e)' : 'var(--red,#ef4444)');
        var html = '';
        html += '<div style="background:linear-gradient(145deg,rgba(245,166,35,0.06),var(--card,#0f1626));border:1px solid var(--border2,#243049);border-radius:16px;padding:20px;margin-bottom:16px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap;">';
        html += '<div><div style="font-size:12px;color:var(--text3,#8a97ad);text-transform:uppercase;letter-spacing:.5px;">Latest CRIB Score</div>';
        html += '<div style="font-size:40px;font-weight:800;color:' + sColor + ';line-height:1.1;">' + (focus.score != null ? focus.score : '\u2014') + '<span style="font-size:16px;color:var(--text3,#8a97ad);font-weight:600;"> / ' + (focus.scoreMax || 900) + '</span></div>';
        if (focus.category) html += '<div style="margin-top:4px;font-size:13px;color:var(--text2,#aeb9cc);">Category: <b>' + _esc(focus.category) + '</b></div>';
        html += '<div style="font-size:12px;color:var(--text3,#8a97ad);margin-top:2px;">Report date: ' + _esc(focus.dateLabel || '\u2014') + '</div></div>';
        if (cmp.deltas && cmp.deltas.score != null) {
            var up = cmp.deltas.score >= 0;
            html += '<div style="text-align:right;"><div style="font-size:12px;color:var(--text3,#8a97ad);">vs previous</div><div style="font-size:22px;font-weight:800;color:' + (up ? 'var(--green,#10b981)' : 'var(--red,#ef4444)') + ';">' + (up ? '\u25B2 +' : '\u25BC ') + cmp.deltas.score + '</div></div>';
        }
        html += '</div></div>';
        if (cmp.count >= 2) {
            html += '<div style="background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:16px;padding:18px;margin-bottom:16px;">';
            html += '<div style="font-weight:700;margin-bottom:10px;">\uD83D\uDCC8 Score history</div><div style="height:220px;"><canvas id="cribChart"></canvas></div></div>';
        }
        if (an) {
            if (an.analysis) html += '<div style="background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:16px;padding:18px;margin-bottom:16px;"><div style="font-weight:700;margin-bottom:8px;">\uD83E\uDDE0 Analysis</div><div style="font-size:14px;line-height:1.7;color:var(--text,#e8edf5);white-space:pre-wrap;">' + _esc(an.analysis) + '</div></div>';
            if (an.advice) html += '<div style="background:linear-gradient(145deg,rgba(16,185,129,0.06),var(--card,#0f1626));border:1px solid var(--green,#10b981);border-radius:16px;padding:18px;margin-bottom:16px;"><div style="font-weight:700;margin-bottom:8px;color:var(--green,#10b981);">\uD83D\uDCA1 How to improve your CRIB</div><div style="font-size:14px;line-height:1.7;color:var(--text,#e8edf5);white-space:pre-wrap;">' + _esc(an.advice) + '</div></div>';
        }
        html += '<div style="background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:16px;padding:18px;"><div style="font-weight:700;margin-bottom:12px;">\uD83D\uDDC2\uFE0F All CRIB reports (' + reports.length + ')</div>';
        reports.forEach(function (r) {
            var isF = r.id === focus.id;
            html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#1b2436);">';
            html += '<div style="cursor:pointer;flex:1;" onclick="WFCrib.render(\'' + r.id + '\')"><div style="font-weight:' + (isF ? '800' : '600') + ';color:' + (isF ? 'var(--accent,#f5a623)' : 'var(--text,#e8edf5)') + ';">' + (r.score != null ? (r.score + '/' + (r.scoreMax || 900)) : 'Report') + (r.category ? (' \u00B7 ' + _esc(r.category)) : '') + '</div>';
            html += '<div style="font-size:12px;color:var(--text3,#8a97ad);">' + _esc(r.dateLabel || new Date(r.ts).toISOString().slice(0, 10)) + ' \u00B7 ' + _esc(r.fileName || '') + '</div></div>';
            html += '<button class="ib d" title="Delete" style="background:none;border:none;cursor:pointer;font-size:16px;" onclick="WFCrib._del(\'' + r.id + '\')">\uD83D\uDDD1\uFE0F</button></div>';
        });
        html += '</div>';
        host.innerHTML = html;
        if (cmp.count >= 2 && typeof window.Chart !== 'undefined') {
            var cv = document.getElementById('cribChart');
            if (cv) {
                try {
                    new window.Chart(cv.getContext('2d'), {
                        type: 'line',
                        data: { labels: cmp.labels, datasets: [{ label: 'CRIB Score', data: cmp.scores, borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.12)', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: '#f5a623' }] },
                        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#e6e7eb' } } }, scales: { x: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' } }, y: { grid: { color: 'rgba(255,255,255,0.05)' }, ticks: { color: '#64748b' }, suggestedMin: 250, suggestedMax: 900 } } }
                    });
                } catch (_) {}
            }
        }
    }
    function _del(id) {
        var doDelete = function () {
            deleteReport(id);
            _notify('CRIB report deleted.', 'success');
            try { if (typeof window.renderWFScore === 'function') window.renderWFScore(); } catch (_) {}
            _renderCribUI();
        };
        try {
            if (typeof window.showConfirm === 'function') {
                window.showConfirm('\uD83D\uDDD1\uFE0F', 'Delete this CRIB report?', 'This removes the report and its analysis from WealthFlow everywhere, and updates your score. This cannot be undone.', 'btn-danger', 'Delete', doDelete);
                return;
            }
        } catch (_) {}
        if (window.confirm('Delete this CRIB report? This cannot be undone.')) doDelete();
    }

    // expose helpers used by injected markup
    window.WFCrib._upload = _upload;
    window.WFCrib._del = _del;
    window.WFCrib._open = _openCrib;
    window.WFCrib._onUploadEvt = _onUpload;

    // Inject nav + page once the DOM is ready (covers both old and new builds).
    function _boot() { try { _ensureNavAndPage(); } catch (_) {} }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1500); });
    else setTimeout(_boot, 800);
    // re-ensure after late renders (e.g. settings/nav rebuilt)
    setTimeout(_boot, 4000);

    // ── Runtime score integration (drop-in, no index.html edit needed) ─────────
    // Wrap calculateWFScore so a real CRIB report blends into the score at 15%.
    // Idempotent + safe: if the host already blends CRIB (newer builds expose
    // sc.crib), we DON'T double-apply.
    function _patchScore() {
        try {
            if (typeof window.calculateWFScore !== 'function') return false;
            if (window.calculateWFScore.__wfCribWrapped) return true;
            var orig = window.calculateWFScore;
            var wrapped = function () {
                var sc = orig.apply(this, arguments);
                try {
                    if (sc && typeof sc === 'object' && !sc.crib) {   // host hasn't blended CRIB
                        var f = scoreFactor();
                        if (f != null && typeof sc.total === 'number') {
                            var W = 0.15;
                            sc.baseTotal = sc.total;
                            sc.total = Math.min(1000, Math.round(sc.total * (1 - W) + (f * 1000) * W));
                            sc.crib = { score: Math.round(f * 150), max: 150, value: f, label: 'CRIB Credit Health', present: true };
                        }
                    }
                } catch (_) {}
                return sc;
            };
            wrapped.__wfCribWrapped = true;
            window.calculateWFScore = wrapped;
            return true;
        } catch (_) { return false; }
    }
    // Try now + after load (calculateWFScore may be defined later).
    if (!_patchScore()) {
        var _tries = 0;
        var _iv = setInterval(function () { if (_patchScore() || ++_tries > 40) clearInterval(_iv); }, 400);
    }

    try { console.log('[WFCrib] \u2713 CRIB credit-report intelligence ready (self-bootstrapping)'); } catch (_) {}
})();
