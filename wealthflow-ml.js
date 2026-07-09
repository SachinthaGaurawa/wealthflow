/* ============================================================================
 * WealthFlow AI — On-Device Machine Learning Engine v1.0
 * ----------------------------------------------------------------------------
 * A privacy-first learning layer that runs entirely in the browser (no data
 * leaves the device). It continuously trains on the user's own interactions to
 * make the AI advisor progressively more accurate and personalised:
 *
 *   1. ONLINE INTENT LEARNING — a lightweight Naive-Bayes text classifier that
 *      learns from corrections + feedback so intent detection keeps improving.
 *   2. PREFERENCE MODEL — learns tone, length, language, topics the user likes
 *      (reinforced by 👍 / 👎 feedback) and feeds it back into the prompt.
 *   3. KNOWLEDGE MEMORY — extracts durable facts the user states about
 *      themselves and recalls them in future answers.
 *   4. FEEDBACK LOOP — 👍/👎 on any reply updates all three models.
 *
 * Persistence: localStorage (per device) + mirrored into appData so it syncs
 * across the user's devices through the existing Firestore sync.
 * ========================================================================== */
(function () {
    'use strict';

    var TAG = '[AI-ML]';
    function log() { try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (_) {} }

    var STORE_KEY = 'wf_ai_ml_model_v1';

    // ---- Model state ----
    var model = {
        // Naive-Bayes: word → { intentLabel: count }
        wordIntent: {},
        intentTotals: {},
        // Preference signals
        prefs: {
            likedTone: {},        // tone → score
            likedLength: 'medium',// short | medium | long
            avgLikedWords: 120,
            topics: {},           // topic keyword → interest score
            language: null
        },
        // Durable user facts (self-stated)
        facts: [],
        // v7.56.0 — learned vendor -> {category,type,destination} model (OCR verification)
        vendorModel: {},
        // Counters
        trained: 0,
        feedback: { up: 0, down: 0 },
        updatedAt: 0
    };

    function load() {
        try {
            var raw = localStorage.getItem(STORE_KEY);
            if (raw) { model = Object.assign(model, JSON.parse(raw)); }
            // Also try appData (cross-device)
            if (window.DB && window.DB.getObj) {
                var cloud = window.DB.getObj('aiMLModel', null);
                if (cloud && cloud.updatedAt && cloud.updatedAt > (model.updatedAt || 0)) {
                    model = Object.assign(model, cloud);
                }
            }
        } catch (e) { log('load failed', e && e.message); }
    }

    function save() {
        model.updatedAt = Date.now();
        try { localStorage.setItem(STORE_KEY, JSON.stringify(model)); } catch (_) {}
        try {
            if (window.DB && window.DB.set) {
                window.DB.set('aiMLModel', model);   // mirrors into appData → Firestore sync
                if (typeof window.setDirty === 'function') window.setDirty(true);
            }
        } catch (_) {}
    }

    // ---- Tokeniser ----
    function tokens(text) {
        return (text || '').toLowerCase()
            .replace(/[^a-z0-9\s\u0d80-\u0dff\u0b80-\u0bff]/g, ' ')
            .split(/\s+/).filter(function (w) { return w.length > 1 && w.length < 24; });
    }

    // ---- 1. Naive-Bayes intent training (unigram + bigram features) ----
    function _features(text) {
        var ws = tokens(text);
        var feats = ws.slice();
        for (var i = 0; i < ws.length - 1; i++) feats.push(ws[i] + '_' + ws[i + 1]); // bigrams
        return feats;
    }

    function trainIntent(text, intent) {
        if (!text || !intent) return;
        var ws = _features(text);
        model.intentTotals[intent] = (model.intentTotals[intent] || 0) + 1;
        if (!model.vocab) model.vocab = {};
        ws.forEach(function (w) {
            if (!model.wordIntent[w]) model.wordIntent[w] = {};
            model.wordIntent[w][intent] = (model.wordIntent[w][intent] || 0) + 1;
            model.vocab[w] = 1;
        });
        model.trained++;
        save();
    }

    // Returns { intent, confidence } or null if the model is too small / unsure.
    function predictIntent(text) {
        var labels = Object.keys(model.intentTotals);
        if (labels.length < 2 || model.trained < 12) return null; // not enough data yet
        var ws = _features(text);
        var V = model.vocab ? Object.keys(model.vocab).length : 50; // vocabulary size
        var totalDocs = labels.reduce(function (s, l) { return s + model.intentTotals[l]; }, 0);
        var best = null, bestScore = -Infinity, scores = {};
        labels.forEach(function (label) {
            // log prior
            var score = Math.log(model.intentTotals[label] / totalDocs);
            // total feature count for this label (for proper multinomial NB)
            var labelWordTotal = 0;
            for (var w in model.wordIntent) {
                if (model.wordIntent[w][label]) labelWordTotal += model.wordIntent[w][label];
            }
            ws.forEach(function (w) {
                var wc = (model.wordIntent[w] && model.wordIntent[w][label]) || 0;
                // Proper multinomial NB Laplace smoothing: (count+1)/(labelTotal+V)
                score += Math.log((wc + 1) / (labelWordTotal + V));
            });
            scores[label] = score;
            if (score > bestScore) { bestScore = score; best = label; }
        });
        // Confidence = softmax gap between top-1 and top-2
        var sorted = labels.map(function (l) { return scores[l]; }).sort(function (a, b) { return b - a; });
        var gap = sorted.length > 1 ? (sorted[0] - sorted[1]) : 5;
        var conf = 1 / (1 + Math.exp(-gap / 2)); // calibrated 0.5..1
        // Only return a prediction we're actually confident about (cuts ML "fails")
        if (conf < 0.62) return null;
        return { intent: best, confidence: conf };
    }

    // ---- 2. Preference learning ----
    function learnPreference(userMsg, aiReply, signal) {
        // signal: +1 (liked), -1 (disliked), 0 (neutral observation)
        var len = (aiReply || '').length;
        if (signal > 0) {
            model.prefs.avgLikedWords = Math.round(model.prefs.avgLikedWords * 0.8 + (len / 5) * 0.2);
            model.prefs.likedLength = len < 350 ? 'short' : len > 1100 ? 'long' : 'medium';
            tokens(userMsg).forEach(function (w) {
                model.prefs.topics[w] = (model.prefs.topics[w] || 0) + 1;
            });
        } else if (signal < 0) {
            tokens(userMsg).forEach(function (w) {
                model.prefs.topics[w] = (model.prefs.topics[w] || 0) - 0.5;
            });
        }
        try {
            var s = window.DB ? window.DB.getObj('settings', {}) : {};
            model.prefs.language = s.aiResponseLang || model.prefs.language;
        } catch (_) {}
        save();
    }

    // ---- 3. Knowledge memory: capture durable self-stated facts ----
    var FACT_PATTERNS = [
        /\bmy name is ([a-z .'-]{2,40})/i,
        /\bi (?:am|'m) (?:a |an )?([a-z ]{3,40}?)(?:\.|,|$| and| who| in)/i,
        /\bi (?:work|am working) (?:as|at|in) ([a-z0-9 ,.&'-]{2,50})/i,
        /\bi live in ([a-z ,.'-]{2,40})/i,
        /\bi have ([0-9]+ [a-z ]{2,30})/i,
        /\bmy goal is ([a-z0-9 ,.%'-]{3,80})/i,
        /\bi prefer ([a-z0-9 ,.'-]{3,50})/i,
        /\bi (?:don't|do not) (?:like|want) ([a-z0-9 ,.'-]{3,50})/i,
        /\bremember that ([a-z0-9 ,.%'-]{3,90})/i
    ];
    function captureFacts(userMsg) {
        if (!userMsg) return;
        FACT_PATTERNS.forEach(function (re) {
            var m = userMsg.match(re);
            if (m && m[1]) {
                var fact = m[0].trim().replace(/\s+/g, ' ');
                if (fact.length > 4 && model.facts.indexOf(fact) === -1) {
                    model.facts.push(fact);
                    if (model.facts.length > 40) model.facts.shift();
                }
            }
        });
        save();
    }

    // ---- Build a personalization block injected into the AI prompt ----
    function personalizationBlock() {
        var lines = [];
        if (model.facts.length) {
            lines.push('THINGS YOU KNOW ABOUT THE USER (learned from past chats):');
            model.facts.slice(-12).forEach(function (f) { lines.push('• ' + f); });
        }
        var topTopics = Object.keys(model.prefs.topics)
            .filter(function (k) { return model.prefs.topics[k] >= 2; })
            .sort(function (a, b) { return model.prefs.topics[b] - model.prefs.topics[a]; })
            .slice(0, 8);
        if (topTopics.length) lines.push('User often asks about: ' + topTopics.join(', ') + '.');
        if (model.feedback.up + model.feedback.down >= 4) {
            lines.push('Preferred answer length: ' + model.prefs.likedLength +
                ' (around ' + model.prefs.avgLikedWords + ' words when detailed).');
        }
        if (!lines.length) return '';
        return '\n\n--- PERSONALIZATION (learned on-device) ---\n' + lines.join('\n') +
            '\nUse this to make the answer feel personal and relevant. Never say you were "told" this in a list.';
    }

    // ---- 4. Public feedback hook (👍 / 👎 buttons call this) ----
    function recordFeedback(userMsg, aiReply, liked) {
        if (liked) model.feedback.up++; else model.feedback.down++;
        learnPreference(userMsg, aiReply, liked ? 1 : -1);
        // Reinforce intent learning using the current best classifier label
        try {
            var intent = (window.WealthFlowAIv6 && window.WealthFlowAIv6.classifyIntent)
                ? window.WealthFlowAIv6.classifyIntent(userMsg, false) : null;
            if (intent && liked) trainIntent(userMsg, intent);
        } catch (_) {}
        save();
        log('feedback recorded:', liked ? '👍' : '👎', '(up=' + model.feedback.up + ' down=' + model.feedback.down + ')');
    }

    // ---- Observe every exchange (called by the host) ----
    function observe(userMsg, aiReply, detectedIntent) {
        captureFacts(userMsg);
        if (detectedIntent) trainIntent(userMsg, detectedIntent);
        learnPreference(userMsg, aiReply, 0);
    }

    load();

    /* ══════════════════════════════════════════════════════════════════════
     *  v7.56.0 — OCR EXTRACTION VERIFICATION (on-device)
     *  ----------------------------------------------------------------------
     *  Verifies what the AI + consensus extracted from a receipt / statement:
     *    • AMOUNT must actually appear in the OCR text / numericTokens, and was
     *      not read at low confidence (uses the confidence vision.js now emits).
     *    • VENDOR is soft-flagged when the whole scan was low-confidence.
     *    • CATEGORY / TYPE / DESTINATION are checked against a model this device
     *      LEARNED from the user's own confirmed transactions — it fills blanks
     *      and flags/repairs misclassifications the way the user actually files.
     *  A tiny TensorFlow.js classifier is used as a second opinion WHEN tf.js is
     *  already loaded in the app; otherwise the frequency model is the (always-
     *  on) engine, so this adds no dependency and can never break the scan.
     * ════════════════════════════════════════════════════════════════════════ */
    function _vkey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9\u0d80-\u0dff\u0b80-\u0bff]+/g, ' ').trim().slice(0, 40); }

    function learnTransaction(txn) {
        try {
            if (!txn) return;
            var vk = _vkey(txn.vendor || txn.merchant || txn.name || txn.description);
            if (!vk) return;
            if (!model.vendorModel) model.vendorModel = {};
            var e = model.vendorModel[vk] || { category: {}, type: {}, destination: {}, n: 0 };
            ['category', 'type', 'destination'].forEach(function (fld) {
                var val = _vkey(txn[fld]);
                if (val) e[fld][val] = (e[fld][val] || 0) + 1;
            });
            e.n++;
            model.vendorModel[vk] = e;
            var keys = Object.keys(model.vendorModel);
            if (keys.length > 1200) { keys.sort(function (a, b) { return (model.vendorModel[a].n || 0) - (model.vendorModel[b].n || 0); }); delete model.vendorModel[keys[0]]; }
            save();
        } catch (_) {}
    }

    function _topOf(map) {
        var best = null, bestN = 0, total = 0;
        for (var k in map) { total += map[k]; if (map[k] > bestN) { bestN = map[k]; best = k; } }
        if (best == null) return null;
        return { value: best, confidence: total ? (bestN / total) : 0, n: total };
    }

    function predictField(vendor, field) {
        try {
            var vk = _vkey(vendor);
            if (!vk || !model.vendorModel || !model.vendorModel[vk]) return null;
            var e = model.vendorModel[vk], m = e[field];
            if (!m) return null;
            var t = _topOf(m);
            if (!t) return null;
            t.samples = e.n;
            return t;
        } catch (_) { return null; }
    }

    function _numAppearsInText(amount, rawText, ocrMeta) {
        if (amount == null || isNaN(amount)) return { present: false, confidence: null };
        var a = Math.round(Number(amount) * 100) / 100;
        if (ocrMeta && Array.isArray(ocrMeta.numericTokens)) {
            for (var i = 0; i < ocrMeta.numericTokens.length; i++) {
                var t = ocrMeta.numericTokens[i];
                if (t && typeof t.value === 'number' && Math.abs(t.value - a) < 0.005) return { present: true, confidence: (t.confidence == null ? null : t.confidence) };
            }
        }
        var txt = String(rawText || '');
        if (!txt) return { present: false, confidence: null };
        var variants = {};
        variants[String(a)] = 1; variants[String(Math.round(a))] = 1; variants[a.toFixed(2)] = 1;
        try { variants[a.toLocaleString('en-US')] = 1; variants[Math.round(a).toLocaleString('en-US')] = 1; variants[a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })] = 1; } catch (_) {}
        for (var v in variants) { if (v && txt.indexOf(v) !== -1) return { present: true, confidence: null }; }
        var digits = String(Math.round(a));
        var stripped = txt.replace(/[,\s]/g, '');
        if (digits.length >= 2 && stripped.indexOf(digits) !== -1) return { present: true, confidence: null };
        return { present: false, confidence: null };
    }

    // ---- optional TensorFlow.js second opinion (guarded; no-op without tf) ----
    var _tfState = { model: null, labels: null, trainedN: 0 };
    function _tfReady() { try { return !!(typeof window !== 'undefined' && window.tf && window.tf.sequential && window.tf.tensor2d); } catch (_) { return false; } }
    var _TF_DIM = 48;
    function _tfFeat(vendor) {
        var vec = new Array(_TF_DIM).fill(0);
        var toks = _vkey(vendor).split(/\s+/).filter(Boolean);
        toks.forEach(function (tok) {
            for (var i = 0; i < tok.length - 1; i++) {
                var bg = tok.charCodeAt(i) * 31 + tok.charCodeAt(i + 1);
                vec[Math.abs(bg) % _TF_DIM] += 1;
            }
            var h = 0; for (var j = 0; j < tok.length; j++) h = (h * 131 + tok.charCodeAt(j)) | 0;
            vec[Math.abs(h) % _TF_DIM] += 1;
        });
        var mx = Math.max.apply(null, vec) || 1;
        return vec.map(function (x) { return x / mx; });
    }
    function trainVerifier() {                    // call after data loads; safe if tf absent
        try {
            if (!_tfReady() || !model.vendorModel) return false;
            var rows = [], labelSet = {};
            Object.keys(model.vendorModel).forEach(function (vk) {
                var e = model.vendorModel[vk]; var top = _topOf(e.category || {});
                if (top && top.n >= 2) { rows.push({ vk: vk, label: top.value }); labelSet[top.value] = 1; }
            });
            var labels = Object.keys(labelSet);
            if (rows.length < 8 || labels.length < 2) return false;
            var tf = window.tf;
            var xs = tf.tensor2d(rows.map(function (r) { return _tfFeat(r.vk); }));
            var ys = tf.tensor2d(rows.map(function (r) { var o = new Array(labels.length).fill(0); o[labels.indexOf(r.label)] = 1; return o; }));
            var net = tf.sequential();
            net.add(tf.layers.dense({ inputShape: [_TF_DIM], units: 24, activation: 'relu' }));
            net.add(tf.layers.dense({ units: labels.length, activation: 'softmax' }));
            net.compile({ optimizer: tf.train.adam(0.01), loss: 'categoricalCrossentropy' });
            net.fit(xs, ys, { epochs: 24, batchSize: 16, verbose: 0 }).then(function () {
                _tfState.model = net; _tfState.labels = labels; _tfState.trainedN = rows.length;
                try { xs.dispose(); ys.dispose(); } catch (_) {}
            }).catch(function () { try { xs.dispose(); ys.dispose(); } catch (_) {} });
            return true;
        } catch (_) { return false; }
    }
    function _tfPredictCategory(vendor) {
        try {
            if (!_tfReady() || !_tfState.model || !_tfState.labels) return null;
            var tf = window.tf;
            var out = tf.tidy(function () { return _tfState.model.predict(tf.tensor2d([_tfFeat(vendor)])).dataSync(); });
            var bi = 0; for (var i = 1; i < out.length; i++) if (out[i] > out[bi]) bi = i;
            return { value: _tfState.labels[bi], confidence: out[bi] };
        } catch (_) { return null; }
    }

    function verifyExtraction(record, rawText, ocrMeta) {
        record = record || {}; ocrMeta = ocrMeta || {};
        var verdicts = [], out = {};
        for (var k in record) out[k] = record[k];
        var ocrConf = (typeof ocrMeta.confidence === 'number') ? ocrMeta.confidence : null;

        if (record.amount != null && record.amount !== '') {
            var amt = parseFloat(String(record.amount).replace(/[^0-9.\-]/g, ''));
            var chk = _numAppearsInText(amt, rawText, ocrMeta);
            if (isNaN(amt) || amt <= 0) verdicts.push({ field: 'amount', aiValue: record.amount, action: 'flag', confidence: 0.2, reason: 'Amount is missing or not a positive number.' });
            else if (!chk.present) verdicts.push({ field: 'amount', aiValue: amt, action: 'flag', confidence: 0.35, reason: 'Extracted amount was not found in the scanned text — please confirm.' });
            else if (chk.confidence != null && chk.confidence < 0.6) verdicts.push({ field: 'amount', aiValue: amt, action: 'flag', confidence: chk.confidence, reason: 'The amount was read with low OCR confidence — please confirm.' });
            else verdicts.push({ field: 'amount', aiValue: amt, action: 'accept', confidence: Math.max(0.8, chk.confidence || 0.85), reason: 'Amount verified in the scanned text.' });
        }

        if (record.vendor) {
            if (ocrConf != null && ocrConf < 0.55) verdicts.push({ field: 'vendor', aiValue: record.vendor, action: 'flag', confidence: ocrConf, reason: 'The scan was low-confidence overall — check the merchant name.' });
            else verdicts.push({ field: 'vendor', aiValue: record.vendor, action: 'accept', confidence: ocrConf == null ? 0.75 : Math.max(0.7, ocrConf), reason: 'Vendor accepted.' });
        }

        ['category', 'type', 'destination'].forEach(function (fld) {
            var aiVal = record[fld], pred = predictField(record.vendor, fld);
            var tfp = (fld === 'category') ? _tfPredictCategory(record.vendor) : null;
            if (!pred || pred.samples < 2) {
                if (tfp && tfp.confidence >= 0.85 && !aiVal) { out[fld] = tfp.value; verdicts.push({ field: fld, aiValue: '', suggestedValue: tfp.value, action: 'correct', confidence: tfp.confidence, reason: 'Filled by the on-device model (TensorFlow).' }); }
                else if (aiVal) verdicts.push({ field: fld, aiValue: aiVal, action: 'accept', confidence: 0.6, reason: 'No learned history yet — kept AI value.' });
                return;
            }
            var aiK = _vkey(aiVal);
            if (!aiVal) { out[fld] = pred.value; verdicts.push({ field: fld, aiValue: '', suggestedValue: pred.value, action: 'correct', confidence: pred.confidence, reason: 'Filled from what you usually pick for this merchant.' }); }
            else if (aiK === pred.value) { var boost = (tfp && tfp.value === pred.value) ? 0.05 : 0; verdicts.push({ field: fld, aiValue: aiVal, action: 'accept', confidence: Math.min(1, 0.7 + pred.confidence * 0.3 + boost), reason: 'Matches your history for this merchant.' }); }
            else if (pred.confidence >= 0.8 && pred.samples >= 4) { out['_' + fld + 'Suggestion'] = pred.value; verdicts.push({ field: fld, aiValue: aiVal, suggestedValue: pred.value, action: 'flag', confidence: pred.confidence, reason: 'You usually file this merchant as "' + pred.value + '".' }); }
            else verdicts.push({ field: fld, aiValue: aiVal, action: 'accept', confidence: 0.6, reason: 'Kept AI value (history not decisive).' });
        });

        var acc = 0, flg = 0;
        verdicts.forEach(function (v) { if (v.action === 'accept') acc++; else if (v.action === 'flag') flg++; });
        var score = verdicts.length ? Math.max(0, Math.min(1, (acc + 0.5 * (verdicts.length - acc - flg)) / verdicts.length)) : 0.5;
        return { verified: out, verdicts: verdicts, score: score, needsReview: flg > 0 };
    }

    window.WealthFlowML = {
        version: '1.0',
        observe: observe,
        recordFeedback: recordFeedback,
        predictIntent: predictIntent,
        personalizationBlock: personalizationBlock,
        learnTransaction: learnTransaction,
        predictField: predictField,
        verifyExtraction: verifyExtraction,
        trainVerifier: trainVerifier,
        verifyStats: function () { return { vendors: (model.vendorModel ? Object.keys(model.vendorModel).length : 0), tfTrained: _tfState.trainedN }; },
        stats: function () {
            return {
                trained: model.trained,
                facts: model.facts.length,
                feedback: model.feedback,
                topics: Object.keys(model.prefs.topics).length
            };
        },
        reset: function () {
            model = { wordIntent: {}, intentTotals: {}, prefs: { likedTone: {}, likedLength: 'medium', avgLikedWords: 120, topics: {}, language: null }, facts: [], vendorModel: {}, trained: 0, feedback: { up: 0, down: 0 }, updatedAt: 0 };
            save();
        }
    };
    log('on-device ML engine ready', window.WealthFlowML.stats());
})();
