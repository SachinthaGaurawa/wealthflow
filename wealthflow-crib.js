/*  wealthflow-crib.js — CRIB credit-report intelligence  (v7.22 — full rebuild)
 *  ===========================================================================
 *  Sri Lanka's Credit Information Bureau (CRIB) issues a credit report with a
 *  CRIB score (250–900), a risk category and the full list of a person's
 *  credit facilities, defaults/arrears and inquiries. This module lets the
 *  user attach a CRIB report (PDF or image), runs DEEP AI analysis IN THE
 *  USER'S SELECTED AI-RESPONSE LANGUAGE, tracks every report (de-duplicated by
 *  TWO independent fingerprints), compares the newest against ALL past reports
 *  with charts + a delta table + an AI comparison narrative, gives a separate
 *  actionable advice paragraph + a score-improvement plan, keeps every past
 *  analysis viewable, syncs everything to the AI advisor, and feeds a CRIB
 *  factor into the WealthFlow score.
 *
 *  ROOT CAUSES FIXED IN THIS REBUILD:
 *   1. AI never produced analysis/advice → the host callAI() is a CHAT engine
 *      that rewrites text-only prompts and discards structured instructions.
 *      We now call window.callAIInLanguage / callAIRaw (structured, language-
 *      enforced, NOT rewritten). Falls back gracefully on older builds.
 *   2. Duplicates were accepted + no comparison → field extraction was being
 *      corrupted, so fingerprints were unstable. Fixed by (1) + a SECOND
 *      content-hash fingerprint over the OCR text. A re-upload of the same
 *      report is reliably detected and NOT saved twice → history grows only
 *      with genuinely different reports → comparison works.
 *   3. Language → resolved via window.WF_LANG_NAMES (now exposed by the host);
 *      every AI reply is natural, human, in the user's chosen language.
 *
 *  Public API (window.WFCrib):
 *    open() · render(id) · handleUpload(file) · list() · get(id) ·
 *    getAnalysis(id) · deleteReport(id) · compare() · scoreFactor() ·
 *    contextForAdvisor() · reanalyse(id)
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFCrib && window.WFCrib.__v && window.WFCrib.__v >= 722) return;

    var DB = window.DB;
    function _db() { return window.DB || DB; }

    /* ── self-hydration (our keys may not be in the host seed) ───────────────── */
    (function _hydrate() {
        try {
            var d = _db(); if (!d) return;
            ['cribReports', 'cribAnalyses'].forEach(function (k) {
                try {
                    var cur = (k === 'cribReports') ? d.get(k, null) : d.getObj(k, null);
                    var has = (k === 'cribReports') ? (Array.isArray(cur) && cur.length) : (cur && Object.keys(cur).length);
                    if (!has) {
                        var raw = localStorage.getItem('wf2_' + k);
                        if (raw) {
                            var val = JSON.parse(raw);
                            if (window.appData) window.appData[k] = val;
                            else d.set(k, val, true);
                        }
                    }
                } catch (_) {}
            });
        } catch (_) {}
    })();

    /* ── small utils ─────────────────────────────────────────────────────────── */
    function _uid() { return 'crib_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8); }
    function _now() { return Date.now(); }
    function fmtNum(n) { try { return (Number(n) || 0).toLocaleString(); } catch (_) { return String(n); } }
    function _esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    function _notify(msg, type) { try { if (typeof window.notify === 'function') return window.notify(msg, type || 'info'); } catch (_) {} }
    function _haptic(k) { try { if (typeof window.triggerHaptic === 'function') window.triggerHaptic(k || 'light'); } catch (_) {} }

    function _settings() { try { return (_db().getObj('settings', {})) || {}; } catch (_) { return {}; } }
    function _langName() {
        var s = _settings();
        var names = window.WF_LANG_NAMES || {};
        var code = s.aiResponseLang || 'en';
        if (code === 'auto' || !code) return 'English';
        var n = names[code] || 'English';
        return String(n).replace(/\s*\(.*\)\s*$/, '').replace(/^🌐\s*/, '').trim() || 'English';
    }

    /* ── dual fingerprints (bullet-proof de-duplication) ─────────────────────── */
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
        } catch (_) { return _hash((rawText || '') + Math.random()); }
    }
    function textFingerprint(rawText) {
        var t = String(rawText || '').toLowerCase();
        // Collapse digit grouping so "1,250,000" / "1 250 000" / "1250000" all match
        // (Cloud Vision / OCR can format the same amount differently across reads).
        t = t.replace(/(\d)[\s,]+(?=\d)/g, '$1');
        t = t.replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (t.length < 24) return '';
        return _hash(t.slice(0, 6000));
    }
    function _hash(str) {
        var h = 5381;
        for (var i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
        var h2 = 52711;
        for (var j = str.length - 1; j >= 0; j--) h2 = ((h2 << 5) + h2 + str.charCodeAt(j)) >>> 0;
        return ('00000000' + h.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
    }

    /* ── persistence ─────────────────────────────────────────────────────────── */
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
        m[id] = Object.assign({}, m[id] || {}, payload);
        _db().set('cribAnalyses', m);
    }
    function deleteReport(id) {
        var arr = [];
        try { arr = (_db().get('cribReports') || []).filter(function (r) { return r.id !== id; }); } catch (_) {}
        _db().set('cribReports', arr);
        var m = {};
        try { m = Object.assign({}, _db().getObj('cribAnalyses', {})); } catch (_) {}
        if (m[id]) { delete m[id]; _db().set('cribAnalyses', m); }
        try { if (window.WealthFlowAIMemory && window.WealthFlowAIMemory.refreshContext) window.WealthFlowAIMemory.refreshContext(); } catch (_) {}
        try { if (typeof window._wfSyncAdvisorContext === 'function') window._wfSyncAdvisorContext(); } catch (_) {}
        try { if (typeof window.recomputeWFScore === 'function') window.recomputeWFScore(); else if (typeof window.renderWFScore === 'function') window.renderWFScore(); } catch (_) {}
        return true;
    }

    /* ── OCR (Cloud Vision via /api/vision, with graceful fallbacks) ──────────── */
    function _apiBase() {
        try { if (typeof window._apiBase === 'function') return window._apiBase(); } catch (_) {}
        return '/api';
    }
    function _fileToImages(file) {
        try {
            if (window.WF_AI_V4 && window.WF_AI_V4.utils && typeof window.WF_AI_V4.utils.fileToImagesV4 === 'function') {
                return window.WF_AI_V4.utils.fileToImagesV4(file, { maxPages: 6, maxBytes: 3.4 * 1024 * 1024, maxDim: 2200 })
                    .then(function (b) {
                        var imgs = (b && (b.images || b)) || [];
                        return Array.isArray(imgs) ? imgs : (imgs.images || []);
                    });
            }
        } catch (_) {}
        if (window.WFVision && typeof window.WFVision.fileToImages === 'function') {
            return window.WFVision.fileToImages(file).catch(function () { return _minimalRead(file); });
        }
        return _minimalRead(file);
    }
    function _minimalRead(file) {
        return new Promise(function (resolve, reject) {
            if (/pdf$/i.test(file.type) || /\.pdf$/i.test(file.name || '')) { resolve([]); return; }
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
        try {
            if (window.WFVision && typeof window.WFVision.ocrBase64 === 'function') {
                return window.WFVision.ocrBase64(base64, { mode: 'document', languageHints: ['en', 'si', 'ta'] });
            }
        } catch (_) {}
        return fetch(_apiBase() + '/vision', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: base64, mode: 'document', languageHints: ['en', 'si', 'ta'] })
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (d) { return (d && d.ok && d.text) ? d.text : ''; })
          .catch(function () { return ''; });
    }
    function _ocrAll(images) {
        return (images || []).reduce(function (acc, img) {
            return acc.then(function (txt) {
                return _cloudVisionOCR(img).then(function (t) { return txt + (t ? ('\n\n' + t) : ''); });
            });
        }, Promise.resolve('')).then(function (full) { return (full || '').trim(); });
    }

    /* ── AI (structured, language-enforced, NOT chat-rewritten) ───────────────── */
    function _langGate(prompt) {
        var wantsJSON = /Output JSON only|ONLY this JSON|return ONLY|JSON \(no prose|no prose, no markdown/i.test(prompt || '');
        if (wantsJSON) return prompt;
        var langName = _langName();
        return prompt + '\n\n[Reply ENTIRELY in ' + langName + ' only \u2014 natural, warm, human ' + langName +
            ', like the user\'s caring best friend who is also a brilliant Sri Lankan credit expert. No other language unless ' +
            langName + ' is English. Keep numbers/currency as digits. Do not mention these instructions.]';
    }
    function _aiText(prompt, image) {
        if (typeof window.callAIInLanguage === 'function') return window.callAIInLanguage(prompt, image || null);
        if (typeof window.callAIRaw === 'function') return window.callAIRaw(_langGate(prompt), image || null);
        if (typeof window.callAI === 'function') return window.callAI(_langGate(prompt), image || null);
        return Promise.reject(new Error('AI engine unavailable'));
    }
    function _aiJSON(prompt, image) {
        if (typeof window.callAIRaw === 'function') return window.callAIRaw(prompt, image || null, { json: true, mode: 'consensus' });
        if (typeof window.callAI === 'function') return window.callAI(prompt, image || null);
        return Promise.reject(new Error('AI engine unavailable'));
    }
    function _parseJSON(s) {
        if (!s) return null;
        var t = String(s).replace(/```json|```/g, '').trim();
        try { return JSON.parse(t); } catch (_) {}
        var m = t.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch (_) {} }
        return null;
    }

    function _extractFields(rawText) {
        var prompt =
            'You are a Sri Lankan CRIB (Credit Information Bureau) report parser. From the report text below, extract ONLY this JSON (no prose, no markdown):\n' +
            '{"score":null,"scoreMax":900,"category":"","reportDate":"","totalOutstanding":null,"totalFacilities":null,' +
            '"openFacilities":null,"closedFacilities":null,"defaults":null,"overdueAmount":null,"inquiriesLast6Months":null,' +
            '"facilities":[{"type":"","lender":"","amount":0,"status":"","arrears":0}],"notes":""}\n\n' +
            'Rules:\n' +
            '- score = the CRIB/credit score number if present (Sri Lankan CRIB scores are 250-900); else null.\n' +
            '- category = the worded risk grade if present (e.g. "AA","A","B","Low risk"); else "".\n' +
            '- reportDate = the report/issue date as YYYY-MM-DD if findable; else "".\n' +
            '- amounts = plain numbers (no commas/currency).\n' +
            '- facilities = each credit facility/loan/card line (cap at 40).\n' +
            '- Use null when truly unknown. Output JSON ONLY.\n\n' +
            'CRIB REPORT TEXT:\n"""\n' + String(rawText).slice(0, 12000) + '\n"""';
        return _aiJSON(prompt).then(function (out) {
            var fields = _parseJSON(out);
            if (!fields || typeof fields !== 'object') fields = {};
            ['score', 'totalOutstanding', 'overdueAmount'].forEach(function (k) {
                if (fields[k] != null) { var v = parseFloat(String(fields[k]).replace(/[^0-9.\-]/g, '')); fields[k] = isNaN(v) ? null : v; }
            });
            if (!Array.isArray(fields.facilities)) fields.facilities = [];
            return fields;
        });
    }
    function _extractFieldsFromImage(base64) {
        var prompt =
            'Look at this Sri Lankan CRIB credit report image and extract ONLY this JSON (no prose): ' +
            '{"score":null,"scoreMax":900,"category":"","reportDate":"","totalOutstanding":null,"totalFacilities":null,' +
            '"openFacilities":null,"closedFacilities":null,"defaults":null,"overdueAmount":null,"inquiriesLast6Months":null,' +
            '"facilities":[{"type":"","lender":"","amount":0,"status":"","arrears":0}],"notes":""}. ' +
            'Amounts as plain numbers. Use null when unknown. Output JSON only.';
        return _aiJSON(prompt, base64).then(function (out) {
            var f = _parseJSON(out) || {};
            if (!Array.isArray(f.facilities)) f.facilities = [];
            return f;
        });
    }

    function _financialCtxLine() {
        try {
            if (typeof window.buildFinancialContext === 'function') {
                var c = window.buildFinancialContext();
                return '\n\nThe person\'s WealthFlow money snapshot (connect CRIB to their real situation): ' +
                    JSON.stringify({
                        monthlyIncome: c.totalMonthlyIncome, monthlyExpenses: c.thisMonthExpenses,
                        monthlyLoanPayments: c.monthlyLoanPayments, netCashFlow: c.netMonthlyCashFlow,
                        balance: c.balanceOnHand, activeLoans: c.activeLoans
                    });
            }
        } catch (_) {}
        return '';
    }

    function _analyse(fields, rawText) {
        var langName = _langName();
        var prompt =
            'You are WealthFlow AI \u2014 the user\'s warm, brilliant best friend who is also a top Sri Lankan credit expert. ' +
            'Talk like a real person texting a friend: natural, caring, encouraging, never robotic, never corporate. ' +
            'You are reviewing their CRIB credit report.\n\n' +
            'Extracted data (JSON):\n' + JSON.stringify(fields) + _financialCtxLine() + '\n\n' +
            'Write TWO clearly separated sections, and nothing else:\n\n' +
            '[ANALYSIS]\n' +
            'A warm, deep, easy-to-understand read of their CRIB report \u2014 what their score and category really mean, what their facilities/defaults/inquiries say, and how it connects to their real money situation. Be specific and honest but kind. 2-4 short paragraphs.\n\n' +
            '[ADVICE]\n' +
            'A separate, practical action plan to IMPROVE their CRIB score, advance their risk category and strengthen their personal CRIB account. Concrete prioritised steps (settle X, keep utilisation under Y%, avoid hard inquiries, fix arrears first, keep facilities active and clean, etc.), each with a one-line "why". Make it feel achievable and encourage them.\n\n' +
            'Write the ENTIRE response in ' + langName + ' only, in natural human ' + langName + '. Use the exact tags [ANALYSIS] and [ADVICE] (in English) to separate the two sections.';
        return _aiText(prompt).then(function (out) { return _splitSections(out); });
    }
    function _splitSections(out) {
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
    }
    function _compareNarrative(reports) {
        if (!reports || reports.length < 2) return Promise.resolve('');
        var langName = _langName();
        var slim = reports.slice(0, 6).map(function (r) {
            return {
                date: r.dateLabel, score: r.score, category: r.category,
                outstanding: r.fields && r.fields.totalOutstanding, defaults: r.fields && r.fields.defaults,
                overdue: r.fields && r.fields.overdueAmount, inquiries: r.fields && r.fields.inquiriesLast6Months
            };
        });
        var prompt =
            'You are WealthFlow AI \u2014 the user\'s caring best friend and a Sri Lankan credit expert. ' +
            'Here are their CRIB reports over time (newest first):\n' + JSON.stringify(slim) + '\n\n' +
            'In 1 short, warm paragraph (no tags, no lists), tell them how their credit is TRENDING \u2014 what improved, what slipped, and what it means \u2014 comparing the newest report to the previous one and to the overall trend. Be specific with the numbers. End on an encouraging, human note. Write ENTIRELY in ' + langName + ' only.';
        return _aiText(prompt).then(function (t) { return String(t || '').trim(); }).catch(function () { return ''; });
    }

    /* ── score factor + bands ─────────────────────────────────────────────────── */
    function scoreFactor() {
        var reps = list();
        if (!reps.length) return null;
        var latest = reps[0];
        var s = latest.score, max = latest.scoreMax || 900;
        if (s != null && !isNaN(s)) {
            var lo = 250, hi = max || 900;
            return Math.max(0, Math.min(1, (s - lo) / (hi - lo)));
        }
        var cat = String(latest.category || '').toUpperCase();
        var catMap = { 'AA': 1, 'A': 0.85, 'B': 0.65, 'C': 0.45, 'D': 0.3, 'HH': 0.15 };
        if (catMap[cat] != null) return catMap[cat];
        if (/low/.test(cat)) return 0.85; if (/medium|moderate/.test(cat)) return 0.55; if (/high/.test(cat)) return 0.25;
        return 0.5;
    }
    function _band(score) {
        if (score == null) return { label: 'Unknown', color: 'var(--text2,#aeb9cc)' };
        if (score >= 800) return { label: 'Excellent', color: 'var(--green,#10b981)' };
        if (score >= 720) return { label: 'Very Good', color: '#22c55e' };
        if (score >= 640) return { label: 'Good', color: 'var(--accent,#f5a623)' };
        if (score >= 520) return { label: 'Fair', color: '#e0a82e' };
        return { label: 'Needs Work', color: 'var(--red,#ef4444)' };
    }

    /* ── comparison data ──────────────────────────────────────────────────────── */
    function compare() {
        var reps = list().slice().reverse();
        var labels = reps.map(function (r) { return r.dateLabel || new Date(r.ts).toISOString().slice(0, 10); });
        var scores = reps.map(function (r) { return (r.score != null ? r.score : null); });
        var outstanding = reps.map(function (r) { return (r.fields && r.fields.totalOutstanding != null) ? r.fields.totalOutstanding : null; });
        var defaults = reps.map(function (r) { return (r.fields && r.fields.defaults != null) ? r.fields.defaults : null; });
        var overdue = reps.map(function (r) { return (r.fields && r.fields.overdueAmount != null) ? r.fields.overdueAmount : null; });
        var deltas = null;
        if (reps.length >= 2) {
            var a = reps[reps.length - 2], b = reps[reps.length - 1];
            var d = function (x, y) { return (x != null && y != null) ? (y - x) : null; };
            deltas = {
                score: d(a.score, b.score),
                outstanding: d(a.fields && a.fields.totalOutstanding, b.fields && b.fields.totalOutstanding),
                defaults: d(a.fields && a.fields.defaults, b.fields && b.fields.defaults),
                overdue: d(a.fields && a.fields.overdueAmount, b.fields && b.fields.overdueAmount),
                inquiries: d(a.fields && a.fields.inquiriesLast6Months, b.fields && b.fields.inquiriesLast6Months),
                facilities: d(a.fields && a.fields.totalFacilities, b.fields && b.fields.totalFacilities)
            };
        }
        return { labels: labels, scores: scores, outstanding: outstanding, defaults: defaults, overdue: overdue, deltas: deltas, count: reps.length };
    }

    /* ── advisor context ──────────────────────────────────────────────────────── */
    function contextForAdvisor() {
        var reps = list();
        if (!reps.length) return '';
        var latest = reps[0];
        var lines = ['CRIB credit report (latest of ' + reps.length + ' tracked):'];
        if (latest.score != null) lines.push('  • Score: ' + latest.score + '/' + (latest.scoreMax || 900) + ' (' + _band(latest.score).label + ')');
        if (latest.category) lines.push('  • Category: ' + latest.category);
        if (latest.fields) {
            if (latest.fields.totalOutstanding != null) lines.push('  • Total outstanding: LKR ' + fmtNum(latest.fields.totalOutstanding));
            if (latest.fields.totalFacilities != null) lines.push('  • Facilities: ' + latest.fields.totalFacilities);
            if (latest.fields.defaults != null) lines.push('  • Defaults: ' + latest.fields.defaults);
            if (latest.fields.overdueAmount != null) lines.push('  • Overdue: LKR ' + fmtNum(latest.fields.overdueAmount));
            if (latest.fields.inquiriesLast6Months != null) lines.push('  • Inquiries (6mo): ' + latest.fields.inquiriesLast6Months);
        }
        var c = compare();
        if (c.deltas && c.deltas.score != null) lines.push('  • Score change vs previous report: ' + (c.deltas.score >= 0 ? '+' : '') + c.deltas.score);
        var an = getAnalysis(latest.id);
        if (an && an.advice) lines.push('  • A saved AI advice plan exists for this report.');
        return lines.join('\n');
    }

    /* ── upload pipeline ──────────────────────────────────────────────────────── */
    function handleUpload(file) {
        return _fileToImages(file).then(function (images) {
            return _ocrAll(images).then(function (rawText) {
                if (!rawText || rawText.length < 20) {
                    if (images && images.length) {
                        return _extractFieldsFromImage(images[0]).then(function (fields) { return { rawText: '', fields: fields }; });
                    }
                    throw new Error('Could not read that file. Try a clearer photo or a PDF.');
                }
                return _extractFields(rawText).then(function (fields) { return { rawText: rawText, fields: fields }; });
            });
        }).then(function (res) {
            var fields = res.fields || {};
            var fp = fingerprint(fields, res.rawText);
            var tfp = textFingerprint(res.rawText);
            var existing = list().filter(function (r) {
                return r.fingerprint === fp || (tfp && r.textFp && r.textFp === tfp);
            })[0];

            if (existing) {
                var an = getAnalysis(existing.id);
                if (an && an.analysis) return { duplicate: true, report: existing, analysis: an };
                return _analyse(existing.fields || fields, res.rawText).then(function (a) {
                    _saveAnalysis(existing.id, { analysis: a.analysis, advice: a.advice, ts: _now(), lang: _langName() });
                    return _compareNarrative(list()).then(function (cmpTxt) {
                        if (cmpTxt) _saveAnalysis(existing.id, { compare: cmpTxt });
                        return { duplicate: true, report: existing, analysis: getAnalysis(existing.id) };
                    });
                });
            }

            return _analyse(fields, res.rawText).then(function (a) {
                var rep = {
                    id: _uid(), ts: _now(),
                    dateLabel: fields.reportDate || new Date().toISOString().slice(0, 10),
                    fingerprint: fp, textFp: tfp,
                    score: (fields.score != null ? fields.score : null),
                    scoreMax: fields.scoreMax || 900,
                    category: fields.category || '',
                    fields: fields,
                    fileName: file.name || 'CRIB report',
                    rawTextSample: String(res.rawText || '').slice(0, 600)
                };
                _saveReport(rep);
                _saveAnalysis(rep.id, { analysis: a.analysis, advice: a.advice, ts: _now(), lang: _langName() });
                return _compareNarrative(list()).then(function (cmpTxt) {
                    if (cmpTxt) _saveAnalysis(rep.id, { compare: cmpTxt });
                    try { if (typeof window.recomputeWFScore === 'function') window.recomputeWFScore(); else if (typeof window.renderWFScore === 'function') window.renderWFScore(); } catch (_) {}
                    try { if (typeof window._wfSyncAdvisorContext === 'function') window._wfSyncAdvisorContext(); } catch (_) {}
                    try { if (window.WealthFlowAIMemory && window.WealthFlowAIMemory.refreshContext) window.WealthFlowAIMemory.refreshContext(); } catch (_) {}
                    return { duplicate: false, report: rep, analysis: getAnalysis(rep.id) };
                });
            });
        });
    }

    function reanalyse(id) {
        var rep = get(id); if (!rep) return Promise.reject(new Error('Report not found'));
        return _analyse(rep.fields || {}, rep.rawTextSample || '').then(function (a) {
            _saveAnalysis(rep.id, { analysis: a.analysis, advice: a.advice, ts: _now(), lang: _langName() });
            return _compareNarrative(list()).then(function (cmpTxt) {
                if (cmpTxt) _saveAnalysis(rep.id, { compare: cmpTxt });
                try { if (typeof window._wfSyncAdvisorContext === 'function') window._wfSyncAdvisorContext(); } catch (_) {}
                return getAnalysis(rep.id);
            });
        });
    }

    /* ═══════════════════════════════════════════════════════════════════════════
     *  UI
     * ═══════════════════════════════════════════════════════════════════════════ */
    var _charts = {};
    function _destroyCharts() {
        try { Object.keys(_charts).forEach(function (k) { try { _charts[k].destroy(); } catch (_) {} delete _charts[k]; }); } catch (_) {}
    }

    function _ensureNavAndPage() {
        if (!document.getElementById('wfCribNavItem')) {
            try {
                var navItems = document.querySelectorAll('.nav-item');
                var anchor = null;
                navItems.forEach(function (n) { if (/score/i.test(n.getAttribute('onclick') || '')) anchor = n; });
                var item = document.createElement('div');
                item.className = 'nav-item'; item.id = 'wfCribNavItem';
                item.setAttribute('onclick', "WFCrib.open()");
                item.innerHTML = '<span class="nav-icon">\uD83D\uDCD1</span> CRIB Credit Report';
                if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(item, anchor.nextSibling);
                else { var nav = document.querySelector('.nav-items, .sidebar-nav, nav'); if (nav) nav.appendChild(item); }
            } catch (_) {}
        }
        if (!document.getElementById('page-crib') && !document.getElementById('cribContent')) {
            try {
                var ref = document.getElementById('page-score') || document.querySelector('.page');
                if (ref && ref.parentNode) {
                    var pg = document.createElement('div');
                    pg.className = 'page'; pg.id = 'page-crib';
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
        try { if (typeof window.showPage === 'function') { window.showPage('crib'); _renderCribUI(); return; } } catch (_) {}
        try {
            document.querySelectorAll('.page').forEach(function (p) { p.classList.remove('active'); });
            var pg = document.getElementById('page-crib'); if (pg) pg.classList.add('active');
        } catch (_) {}
        _renderCribUI();
    }
    function _upload() { _ensureNavAndPage(); var el = document.getElementById('crib_upload'); if (el) el.click(); }
    function _onUpload(e) {
        var file = e.target && e.target.files && e.target.files[0];
        if (e.target) e.target.value = '';
        if (!file) return;
        var host = document.getElementById('cribContent');
        if (host) host.insertAdjacentHTML('afterbegin', '<div id="cribBusy" style="background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:14px;padding:18px;margin-bottom:14px;display:flex;align-items:center;gap:12px;"><div style="width:10px;height:10px;border-radius:50%;background:var(--accent,#f5a623);animation:luxuryBlink 1.4s infinite;"></div><span style="font-weight:600;">Reading your CRIB report with Cloud Vision + AI\u2026 analysing in your language.</span></div>');
        _haptic('medium');
        handleUpload(file).then(function (res) {
            if (res && res.duplicate) _notify('\uD83D\uDCD1 You already uploaded this CRIB report \u2014 it was not saved again. Showing your saved analysis & comparison.', 'info');
            else if (res && res.report) _notify('\u2705 CRIB report analysed, tracked and added to your score.', 'success');
            _renderCribUI(res && res.report ? res.report.id : null);
        }).catch(function (err) {
            var b = document.getElementById('cribBusy'); if (b) b.remove();
            _notify('Could not analyse that CRIB report: ' + ((err && err.message) || 'unknown error'), 'error');
        });
    }

    function _facilityGroups(fields) {
        var out = {};
        try {
            (fields.facilities || []).forEach(function (f) {
                var key = (f.lender || f.type || 'Other').toString().trim() || 'Other';
                out[key] = (out[key] || 0) + (Math.abs(parseFloat(f.amount) || 0));
            });
        } catch (_) {}
        return out;
    }

    function _renderCribUI(focusId) {
        window._wfCribUsingModuleUI = true;
        _ensureNavAndPage();
        _destroyCharts();
        var host = document.getElementById('cribContent');
        if (!host) return;
        var reports = list();
        if (!reports.length) {
            host.innerHTML =
                '<div style="text-align:center;padding:48px 18px;color:var(--text3,#8a97ad);">' +
                '<div style="font-size:44px;margin-bottom:12px;">\uD83D\uDCD1</div>' +
                '<div style="font-size:17px;font-weight:700;color:var(--text2,#aeb9cc);margin-bottom:6px;">No CRIB report yet</div>' +
                '<div style="font-size:13px;margin-bottom:18px;line-height:1.6;">Attach your CRIB credit report (PDF or photo). WealthFlow reads it with Cloud Vision, analyses it in your language, tracks it over time, compares it to your past reports, and factors it into your score.</div>' +
                '<button class="btn btn-primary" onclick="WFCrib._upload()">\uD83D\uDCCE Attach CRIB Report</button></div>';
            return;
        }
        var latest = reports[0];
        var focus = focusId ? (get(focusId) || latest) : latest;
        var an = getAnalysis(focus.id);
        var cmp = compare();
        var band = _band(focus.score);
        var card = 'background:var(--card,#0f1626);border:1px solid var(--border2,#243049);border-radius:16px;padding:18px;margin-bottom:16px;';
        var html = '';

        /* Hero — score ring + delta */
        var pct = (focus.score != null) ? Math.max(0, Math.min(100, ((focus.score - 250) / ((focus.scoreMax || 900) - 250)) * 100)) : 0;
        var circ = (Math.PI * 2 * 52);
        html += '<div style="background:linear-gradient(145deg,rgba(245,166,35,0.07),var(--card,#0f1626));border:1px solid var(--border2,#243049);border-radius:16px;padding:20px;margin-bottom:16px;">';
        html += '<div style="display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap;">';
        html += '<div style="flex:1;min-width:150px;"><div style="font-size:12px;color:var(--text3,#8a97ad);text-transform:uppercase;letter-spacing:.5px;">Latest CRIB Score</div>';
        html += '<div style="font-size:44px;font-weight:800;color:' + band.color + ';line-height:1.05;">' + (focus.score != null ? focus.score : '\u2014') + '<span style="font-size:16px;color:var(--text3,#8a97ad);font-weight:600;"> / ' + (focus.scoreMax || 900) + '</span></div>';
        html += '<div style="margin-top:4px;font-size:13px;color:' + band.color + ';font-weight:700;">' + band.label + (focus.category ? (' <span style="color:var(--text2,#aeb9cc);font-weight:600;">\u00B7 ' + _esc(focus.category) + '</span>') : '') + '</div>';
        html += '<div style="font-size:12px;color:var(--text3,#8a97ad);margin-top:2px;">Report date: ' + _esc(focus.dateLabel || '\u2014') + '</div></div>';
        html += '<div style="position:relative;width:108px;height:108px;flex-shrink:0;">' +
            '<svg width="108" height="108" viewBox="0 0 120 120" style="transform:rotate(-90deg);">' +
            '<circle cx="60" cy="60" r="52" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="12"></circle>' +
            '<circle cx="60" cy="60" r="52" fill="none" stroke="' + band.color + '" stroke-width="12" stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + (circ * (1 - pct / 100)).toFixed(1) + '"></circle></svg>' +
            '<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;"><div style="font-size:20px;font-weight:800;color:' + band.color + ';">' + Math.round(pct) + '%</div><div style="font-size:9px;color:var(--text3,#8a97ad);">of range</div></div></div>';
        if (cmp.deltas && cmp.deltas.score != null) {
            var up = cmp.deltas.score >= 0;
            html += '<div style="text-align:right;min-width:88px;"><div style="font-size:12px;color:var(--text3,#8a97ad);">vs previous</div><div style="font-size:24px;font-weight:800;color:' + (up ? 'var(--green,#10b981)' : 'var(--red,#ef4444)') + ';">' + (up ? '\u25B2 +' : '\u25BC ') + cmp.deltas.score + '</div></div>';
        }
        html += '</div></div>';

        /* AI trend narrative */
        if (an && an.compare) {
            html += '<div style="background:linear-gradient(145deg,rgba(99,102,241,0.07),var(--card,#0f1626));border:1px solid #6366f1;border-radius:16px;padding:16px;margin-bottom:16px;"><div style="font-weight:700;margin-bottom:6px;color:#a5b4fc;">\uD83D\uDCC8 Trend</div><div style="font-size:14px;line-height:1.7;color:var(--text,#e8edf5);white-space:pre-wrap;">' + _esc(an.compare) + '</div></div>';
        }

        /* Score history chart */
        if (cmp.count >= 2) {
            html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:10px;">\uD83D\uDCC9 Score history</div><div style="height:220px;"><canvas id="cribScoreChart"></canvas></div></div>';
            html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:10px;">\uD83D\uDCB0 Outstanding & overdue over time</div><div style="height:200px;"><canvas id="cribDebtChart"></canvas></div></div>';
            /* Delta table */
            var dl = cmp.deltas || {};
            var rowsT = [
                ['Score', dl.score, false], ['Outstanding (LKR)', dl.outstanding, true],
                ['Defaults', dl.defaults, true], ['Overdue (LKR)', dl.overdue, true],
                ['Inquiries (6mo)', dl.inquiries, true], ['Facilities', dl.facilities, true]
            ];
            html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:10px;">\uD83D\uDD0E Latest vs previous report</div><div style="display:flex;flex-direction:column;gap:8px;">';
            rowsT.forEach(function (r) {
                if (r[1] == null) return;
                var lowerBetter = r[2];
                var good = lowerBetter ? (r[1] <= 0) : (r[1] >= 0);
                var col = good ? 'var(--green,#10b981)' : 'var(--red,#ef4444)';
                var arrow = (r[1] === 0) ? '\u25CF' : (r[1] > 0 ? '\u25B2 +' : '\u25BC ');
                html += '<div style="display:flex;justify-content:space-between;align-items:center;font-size:13px;border-bottom:1px solid var(--border,#1b2436);padding-bottom:6px;"><span style="color:var(--text2,#aeb9cc);">' + r[0] + '</span><span style="font-weight:800;color:' + col + ';">' + arrow + fmtNum(Math.abs(r[1])) + '</span></div>';
            });
            html += '</div></div>';
        }

        /* Facilities breakdown */
        var fg = _facilityGroups(focus.fields || {});
        var fgKeys = Object.keys(fg);
        if (fgKeys.length >= 2) {
            html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:10px;">\uD83C\uDFE6 Credit facilities breakdown</div><div style="height:220px;"><canvas id="cribFacChart"></canvas></div></div>';
        } else if (fgKeys.length === 1) {
            html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:6px;">\uD83C\uDFE6 Credit facilities</div><div style="font-size:13px;color:var(--text2,#aeb9cc);">' + _esc(fgKeys[0]) + ': LKR ' + fmtNum(fg[fgKeys[0]]) + '</div></div>';
        }

        /* Analysis + advice */
        if (an) {
            if (an.analysis) html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:8px;">\uD83E\uDDE0 Analysis</div><div style="font-size:14px;line-height:1.7;color:var(--text,#e8edf5);white-space:pre-wrap;">' + _esc(an.analysis) + '</div></div>';
            if (an.advice) html += '<div style="background:linear-gradient(145deg,rgba(16,185,129,0.07),var(--card,#0f1626));border:1px solid var(--green,#10b981);border-radius:16px;padding:18px;margin-bottom:16px;"><div style="font-weight:700;margin-bottom:8px;color:var(--green,#10b981);">\uD83D\uDCA1 How to improve your CRIB (your plan)</div><div style="font-size:14px;line-height:1.7;color:var(--text,#e8edf5);white-space:pre-wrap;">' + _esc(an.advice) + '</div></div>';
            if (an.lang) html += '<div style="font-size:11px;color:var(--text3,#8a97ad);margin:-8px 2px 14px;">Analysed in ' + _esc(an.lang) + '. <a href="javascript:void(0)" onclick="WFCrib._reanalyse(\'' + focus.id + '\')" style="color:var(--accent,#f5a623);font-weight:600;text-decoration:none;">Re-analyse in current language</a></div>';
        } else {
            html += '<div style="' + card + 'text-align:center;"><div style="font-size:13px;color:var(--text2,#aeb9cc);margin-bottom:10px;">Analysis is still generating or unavailable.</div><button class="btn btn-primary btn-sm" onclick="WFCrib._reanalyse(\'' + focus.id + '\')">\uD83E\uDDE0 Analyse now</button></div>';
        }

        /* All reports list */
        html += '<div style="' + card + '"><div style="font-weight:700;margin-bottom:12px;">\uD83D\uDDC2\uFE0F All CRIB reports (' + reports.length + ')</div>';
        reports.forEach(function (r) {
            var isF = r.id === focus.id;
            var rb = _band(r.score);
            html += '<div style="display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-bottom:1px solid var(--border,#1b2436);">';
            html += '<div style="cursor:pointer;flex:1;" onclick="WFCrib.render(\'' + r.id + '\')"><div style="font-weight:' + (isF ? '800' : '600') + ';color:' + (isF ? 'var(--accent,#f5a623)' : 'var(--text,#e8edf5)') + ';">' + (r.score != null ? (r.score + '/' + (r.scoreMax || 900)) : 'Report') + ' <span style="font-size:11px;font-weight:700;color:' + rb.color + ';">' + rb.label + '</span>' + (r.category ? (' <span style="font-size:11px;color:var(--text3,#8a97ad);">\u00B7 ' + _esc(r.category) + '</span>') : '') + '</div>';
            html += '<div style="font-size:12px;color:var(--text3,#8a97ad);">' + _esc(r.dateLabel || new Date(r.ts).toISOString().slice(0, 10)) + ' \u00B7 ' + _esc(r.fileName || '') + '</div></div>';
            html += '<button title="Delete" style="background:none;border:none;cursor:pointer;font-size:16px;color:var(--red,#ef4444);" onclick="WFCrib._del(\'' + r.id + '\')">\uD83D\uDDD1\uFE0F</button></div>';
        });
        html += '<div style="margin-top:12px;display:flex;gap:8px;flex-wrap:wrap;"><button class="btn btn-primary btn-sm" onclick="WFCrib._upload()">\uD83D\uDCCE Attach another report</button>';
        html += '<button class="btn btn-sm" style="background:var(--bg2,#0b1220);border:1px solid var(--border2,#243049);color:var(--text2,#aeb9cc);" onclick="WFCrib._export(\'' + focus.id + '\')">\u2B07\uFE0F Export this analysis</button></div>';
        html += '</div>';

        host.innerHTML = html;

        /* Charts (Chart.js) */
        if (typeof window.Chart !== 'undefined') {
            var gridC = 'rgba(255,255,255,0.05)', tickC = '#64748b', legC = '#e6e7eb';
            if (cmp.count >= 2) {
                var sc = document.getElementById('cribScoreChart');
                if (sc) try {
                    _charts.score = new window.Chart(sc.getContext('2d'), {
                        type: 'line',
                        data: { labels: cmp.labels, datasets: [{ label: 'CRIB Score', data: cmp.scores, borderColor: '#f5a623', backgroundColor: 'rgba(245,166,35,0.12)', fill: true, tension: 0.3, pointRadius: 4, pointBackgroundColor: '#f5a623', spanGaps: true }] },
                        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: legC } } }, scales: { x: { grid: { color: gridC }, ticks: { color: tickC } }, y: { grid: { color: gridC }, ticks: { color: tickC }, suggestedMin: 250, suggestedMax: 900 } } }
                    });
                } catch (_) {}
                var dc = document.getElementById('cribDebtChart');
                if (dc) try {
                    _charts.debt = new window.Chart(dc.getContext('2d'), {
                        type: 'line',
                        data: {
                            labels: cmp.labels,
                            datasets: [
                                { label: 'Outstanding', data: cmp.outstanding, borderColor: '#ef4444', backgroundColor: 'rgba(239,68,68,0.10)', fill: true, tension: 0.3, pointRadius: 3, spanGaps: true },
                                { label: 'Overdue', data: cmp.overdue, borderColor: '#e0a82e', backgroundColor: 'rgba(224,168,46,0.10)', fill: true, tension: 0.3, pointRadius: 3, spanGaps: true }
                            ]
                        },
                        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: legC } } }, scales: { x: { grid: { color: gridC }, ticks: { color: tickC } }, y: { grid: { color: gridC }, ticks: { color: tickC } } } }
                    });
                } catch (_) {}
            }
            if (fgKeys.length >= 2) {
                var fc = document.getElementById('cribFacChart');
                if (fc) try {
                    var palette = ['#f5a623', '#10b981', '#6366f1', '#ef4444', '#22c55e', '#e0a82e', '#3b82f6', '#a855f7', '#ec4899', '#14b8a6'];
                    _charts.fac = new window.Chart(fc.getContext('2d'), {
                        type: 'doughnut',
                        data: { labels: fgKeys, datasets: [{ data: fgKeys.map(function (k) { return fg[k]; }), backgroundColor: fgKeys.map(function (_, i) { return palette[i % palette.length]; }), borderWidth: 0 }] },
                        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'right', labels: { color: legC, font: { size: 11 } } } } }
                    });
                } catch (_) {}
            }
        }
    }

    function _del(id) {
        var doDelete = function () {
            deleteReport(id);
            _notify('CRIB report deleted everywhere and removed from your score & AI advisor.', 'success');
            _renderCribUI();
        };
        try {
            if (typeof window.showConfirm === 'function') {
                window.showConfirm('\uD83D\uDDD1\uFE0F', 'Delete this CRIB report?', 'This removes the report and its analysis from WealthFlow everywhere, updates your score, and tells your AI advisor to forget it. This cannot be undone.', 'btn-danger', 'Delete', doDelete);
                return;
            }
        } catch (_) {}
        if (window.confirm('Delete this CRIB report? This cannot be undone.')) doDelete();
    }

    function _reanalyse(id) {
        var host = document.getElementById('cribContent');
        _notify('\uD83E\uDDE0 Re-analysing in ' + _langName() + '\u2026', 'info');
        reanalyse(id).then(function () { _renderCribUI(id); }).catch(function (e) { _notify('Re-analyse failed: ' + ((e && e.message) || 'error'), 'error'); });
    }

    function _export(id) {
        var r = get(id); if (!r) return;
        var an = getAnalysis(id) || {};
        var lines = [];
        lines.push('WealthFlow — CRIB Credit Report Analysis');
        lines.push('Report date: ' + (r.dateLabel || '') + '   File: ' + (r.fileName || ''));
        lines.push('Score: ' + (r.score != null ? (r.score + '/' + (r.scoreMax || 900)) : 'N/A') + '   Category: ' + (r.category || 'N/A'));
        if (r.fields) {
            if (r.fields.totalOutstanding != null) lines.push('Total outstanding: LKR ' + fmtNum(r.fields.totalOutstanding));
            if (r.fields.defaults != null) lines.push('Defaults: ' + r.fields.defaults);
            if (r.fields.overdueAmount != null) lines.push('Overdue: LKR ' + fmtNum(r.fields.overdueAmount));
        }
        lines.push('');
        if (an.compare) { lines.push('TREND:'); lines.push(an.compare); lines.push(''); }
        if (an.analysis) { lines.push('ANALYSIS:'); lines.push(an.analysis); lines.push(''); }
        if (an.advice) { lines.push('ADVICE — HOW TO IMPROVE:'); lines.push(an.advice); }
        var text = lines.join('\n');
        try {
            var blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = 'CRIB-analysis-' + (r.dateLabel || 'report') + '.txt';
            document.body.appendChild(a); a.click();
            setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
            _notify('Analysis exported.', 'success');
        } catch (_) {
            try { if (navigator.share) navigator.share({ title: 'CRIB analysis', text: text }); } catch (__) {}
        }
    }

    /* ── public API ───────────────────────────────────────────────────────────── */
    window.WFCrib = {
        __v: 722,
        open: function () { _openCrib(); },
        render: _renderCribUI,
        handleUpload: handleUpload,
        list: list, get: get, getAnalysis: getAnalysis,
        deleteReport: deleteReport,
        compare: compare, scoreFactor: scoreFactor,
        contextForAdvisor: contextForAdvisor,
        reanalyse: reanalyse,
        fingerprint: fingerprint, textFingerprint: textFingerprint,
        _extractFields: _extractFields, _analyse: _analyse,
        _upload: _upload, _del: _del, _open: _openCrib,
        _onUploadEvt: _onUpload, _reanalyse: _reanalyse, _export: _export
    };

    /* ── boot: ensure nav + page after late renders ───────────────────────────── */
    function _boot() { try { _ensureNavAndPage(); } catch (_) {} }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(_boot, 1500); });
    else setTimeout(_boot, 800);
    setTimeout(_boot, 4000);

    /* ── score integration (blend CRIB into the WealthFlow score) ─────────────── */
    function _patchScore() {
        try {
            if (typeof window.calculateWFScore !== 'function') return false;
            if (window.calculateWFScore.__wfCribWrapped) return true;
            var orig = window.calculateWFScore;
            var wrapped = function () {
                var sc = orig.apply(this, arguments);
                try {
                    if (sc && typeof sc === 'object' && !sc.crib) {
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
    if (!_patchScore()) {
        var _tries = 0;
        var _iv = setInterval(function () { if (_patchScore() || ++_tries > 40) clearInterval(_iv); }, 400);
    }

    try { console.log('[WFCrib] \u2713 CRIB credit-report intelligence v7.22 ready'); } catch (_) {}
})();
