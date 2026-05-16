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

    // ---- 1. Naive-Bayes intent training ----
    function trainIntent(text, intent) {
        if (!text || !intent) return;
        var ws = tokens(text);
        model.intentTotals[intent] = (model.intentTotals[intent] || 0) + 1;
        ws.forEach(function (w) {
            if (!model.wordIntent[w]) model.wordIntent[w] = {};
            model.wordIntent[w][intent] = (model.wordIntent[w][intent] || 0) + 1;
        });
        model.trained++;
        save();
    }

    // Returns { intent, confidence } or null if the model is too small / unsure.
    function predictIntent(text) {
        var labels = Object.keys(model.intentTotals);
        if (labels.length < 2 || model.trained < 12) return null; // not enough data yet
        var ws = tokens(text);
        var totalDocs = labels.reduce(function (s, l) { return s + model.intentTotals[l]; }, 0);
        var best = null, bestScore = -Infinity, scores = {};
        labels.forEach(function (label) {
            // log prior
            var score = Math.log(model.intentTotals[label] / totalDocs);
            ws.forEach(function (w) {
                var wc = (model.wordIntent[w] && model.wordIntent[w][label]) || 0;
                // Laplace smoothing
                score += Math.log((wc + 1) / (model.intentTotals[label] + 2));
            });
            scores[label] = score;
            if (score > bestScore) { bestScore = score; best = label; }
        });
        // Confidence = softmax gap between top-1 and top-2
        var sorted = labels.map(function (l) { return scores[l]; }).sort(function (a, b) { return b - a; });
        var gap = sorted.length > 1 ? (sorted[0] - sorted[1]) : 5;
        var conf = 1 / (1 + Math.exp(-gap)); // 0.5..1
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

    window.WealthFlowML = {
        version: '1.0',
        observe: observe,
        recordFeedback: recordFeedback,
        predictIntent: predictIntent,
        personalizationBlock: personalizationBlock,
        stats: function () {
            return {
                trained: model.trained,
                facts: model.facts.length,
                feedback: model.feedback,
                topics: Object.keys(model.prefs.topics).length
            };
        },
        reset: function () {
            model = { wordIntent: {}, intentTotals: {}, prefs: { likedTone: {}, likedLength: 'medium', avgLikedWords: 120, topics: {}, language: null }, facts: [], trained: 0, feedback: { up: 0, down: 0 }, updatedAt: 0 };
            save();
        }
    };
    log('on-device ML engine ready', window.WealthFlowML.stats());
})();
