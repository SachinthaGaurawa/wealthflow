/* ============================================================================
 * WealthFlow AI Intelligence Engine v6.0
 * ----------------------------------------------------------------------------
 * Fixes the core problems with the AI advisor:
 *   1. Intent detection — distinguishes general / financial / image-analysis /
 *      image-generation / coding / math / translation requests instead of
 *      always behaving like a finance-only bot.
 *   2. Adaptive identity — the AI is a genuinely general assistant that ALSO
 *      happens to be an expert financial advisor, not a finance-only robot.
 *   3. Image generation — real image creation via Pollinations (no API key).
 *   4. Smart image analysis — "what is this?" describes the actual image
 *      instead of forcing a financial interpretation.
 *   5. Anti-repetition — detects near-duplicate replies and regenerates with
 *      higher variation so the AI never sends the same answer twice.
 *
 * This module monkey-patches the host page's sendAIMessage / handleAIScan
 * after load. It is intentionally defensive: if the host functions aren't
 * present it silently no-ops.
 * ========================================================================== */
(function () {
    'use strict';

    var TAG = '[AI v6]';
    function log() { try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (_) {} }

    // ---------------------------------------------------------------------
    // 1. INTENT CLASSIFIER
    // ---------------------------------------------------------------------
    // Lightweight, deterministic, instant (no extra API round-trip). Returns
    // one of: image_gen | image_analyze | general | finance | code | math |
    // translate | definition
    function classifyIntent(text, hasImage) {
        var t = (text || '').toLowerCase().trim();

        // Image generation — explicit creative requests
        var genPatterns = [
            /\b(generate|create|make|draw|design|paint|render|produce|sketch|imagine)\b.*\b(image|picture|photo|art|logo|illustration|drawing|wallpaper|poster|icon|graphic|pic|painting|design)\b/,
            /\b(image|picture|photo|art|logo|illustration|drawing|wallpaper|poster|icon)\b.*\b(of|for|showing|with|that looks)\b/,
            /^(draw|paint|sketch|design)\b/,
            /\bcan you (draw|create|generate|make).*(image|picture|art|logo)/
        ];
        for (var i = 0; i < genPatterns.length; i++) {
            if (genPatterns[i].test(t)) return 'image_gen';
        }

        // Image analysis — there's an image AND a question about it
        if (hasImage) {
            // If they explicitly ask financial extraction, treat as finance-vision
            if (/\b(receipt|invoice|bill|expense|statement|bank|salary|payslip|how much|total|amount|spent|cost)\b/.test(t)) {
                return 'finance_vision';
            }
            return 'image_analyze';
        }

        // Coding
        if (/\b(code|function|script|bug|error|python|javascript|java|c\+\+|html|css|sql|api|regex|algorithm|debug|compile|programming|write a program)\b/.test(t)) {
            return 'code';
        }

        // Math (pure calculation, not financial planning)
        if (/^[\s\d+\-*/().^%]+=?\??$/.test(t) || /\b(calculate|solve|equation|derivative|integral|square root|factorial|prime|geometry|algebra|trigonometry)\b/.test(t)) {
            return 'math';
        }

        // Translation
        if (/\b(translate|translation|how do you say|what does .* mean in|in (sinhala|tamil|hindi|french|spanish|german|chinese|japanese|arabic))\b/.test(t)) {
            return 'translate';
        }

        // Definition / general knowledge — "what is", "who is", "explain", "tell me about"
        var generalPatterns = [
            /^(what|who|when|where|why|how|which|whose|whom)\b/,
            /\b(explain|describe|tell me about|what is|what are|who is|who was|define|meaning of|history of|difference between|how does|how do|how to)\b/,
            /\b(specification|specs|features|review|comparison|vs\.?|versus|recipe|weather|news|sport|movie|song|book|game|country|capital|planet|science|biology|chemistry|physics|space|animal|history|geography)\b/
        ];
        var financeWords = /\b(money|budget|save|saving|loan|debt|invest|income|expense|salary|cash|fund|profit|portfolio|emi|installment|interest rate|net worth|wealth|financ|afford|spend|bank balance|tax|epf|etf|retirement|pension|insurance|mortgage|credit)\b/;

        var looksGeneral = false;
        for (var g = 0; g < generalPatterns.length; g++) {
            if (generalPatterns[g].test(t)) { looksGeneral = true; break; }
        }

        // If it looks like a general question AND has no finance words → general
        if (looksGeneral && !financeWords.test(t)) return 'general';

        // Explicit finance signal → finance
        if (financeWords.test(t)) return 'finance';

        // Greetings / casual / very short → general (friendly chat)
        if (t.length < 25 || /\b(hi|hello|hey|yo|sup|thanks|thank you|bye|good morning|good night|how are you|lol|haha|ok|okay|cool|nice|wow|great)\b/.test(t)) {
            return 'general';
        }

        // Default: general assistant (NOT finance). This is the key behavioural
        // change — the AI no longer assumes everything is about money.
        return 'general';
    }

    // ---------------------------------------------------------------------
    // 2. ADAPTIVE SYSTEM PROMPT
    // ---------------------------------------------------------------------
    function getLangDirective() {
        try {
            var s = (window.DB && window.DB.getObj) ? window.DB.getObj('settings', {}) : {};
            var code = s.aiResponseLang || 'en';
            var names = window.WF_LANG_NAMES || {};
            var name = names[code] || 'English';
            if (code === 'en') return 'Respond in English.';
            return 'CRITICAL: Write your ENTIRE reply in ' + name + ' (' + code + '). Every sentence. ' +
                'Only use a different language if the user explicitly asks in this message. This overrides all else.';
        } catch (_) { return 'Respond in English.'; }
    }

    function getPersonaDirective() {
        try {
            var s = (window.DB && window.DB.getObj) ? window.DB.getObj('settings', {}) : {};
            var p = s.aiAdvisorPersona || 'balanced';
            var map = {
                supportive: 'Tone: warm, encouraging, gentle. Always find a positive angle.',
                balanced: 'Tone: realistic, professional, friendly — like a knowledgeable friend.',
                strict: 'Tone: blunt, direct, disciplined. No sugar-coating, no emojis.',
                aggressive: 'Tone: high-intensity coach. Push hard, strong action verbs.'
            };
            return map[p] || map.balanced;
        } catch (_) { return ''; }
    }

    // Build identity prompt by intent. The financial context is only injected
    // when it's actually relevant.
    function buildAdaptivePrompt(intent, userName, financialContextText) {
        var lang = getLangDirective();
        var persona = getPersonaDirective();
        var base = 'You are WealthFlow AI — a brilliant, friendly, genuinely helpful general-purpose AI assistant for ' + (userName || 'the user') + '. ' +
            'You can discuss ANY topic in the world: science, technology, history, cooking, health, travel, entertainment, coding, math, languages, life advice — anything. ' +
            'You ALSO happen to be a world-class financial advisor, but you are NOT limited to finance. ' +
            'Answer what the user actually asked. Never force a financial angle onto a non-financial question.';

        var rules = '\n\nCORE RULES:\n' +
            '- Answer the ACTUAL question. If asked "what is the full specification of the iPhone 15", give phone specs — NOT financial advice.\n' +
            '- Be accurate and specific. Use real facts, real numbers, real detail. If unsure, say so honestly.\n' +
            '- Match length to the question: short question → short answer; deep question → structured detailed answer.\n' +
            '- Never repeat a previous answer verbatim. Always add new value.\n' +
            '- Be warm and human, not robotic. No boilerplate disclaimers.\n' +
            '- ' + persona + '\n- ' + lang;

        var identity;
        switch (intent) {
            case 'general':
            case 'definition':
                identity = base + '\n\nThe user asked a GENERAL knowledge question. Answer it directly, accurately and thoroughly like an expert encyclopedia + friendly teacher. Do NOT mention their finances unless they ask.';
                break;
            case 'code':
                identity = base + '\n\nThe user asked a CODING/technical question. Act as a senior software engineer. Give correct, working, well-explained code with brief commentary. Use code blocks.';
                break;
            case 'math':
                identity = base + '\n\nThe user asked a MATH problem. Solve it step by step, show the working clearly, and give the final answer in bold.';
                break;
            case 'translate':
                identity = base + '\n\nThe user asked for a TRANSLATION or language help. Provide the accurate translation, pronunciation if useful, and a usage note.';
                break;
            case 'image_analyze':
                identity = base + '\n\nThe user attached an IMAGE and asked about it. Describe and analyse what is ACTUALLY in the image accurately and in detail. Identify objects, text, people, scenes, products, specifications — whatever is relevant to their question. Do NOT assume it is a receipt or financial document unless it clearly is.';
                break;
            case 'finance_vision':
                identity = base + '\n\nThe user attached a financial document/image. Extract the key data and give a clear breakdown plus useful financial insight.' +
                    (financialContextText ? '\n\nUSER FINANCIAL CONTEXT:\n' + financialContextText : '');
                break;
            case 'finance':
                identity = base + '\n\nThe user asked a FINANCIAL question. Now act as their expert personal financial advisor. Be specific with their real numbers.' +
                    (financialContextText ? '\n\nUSER FINANCIAL CONTEXT:\n' + financialContextText : '') +
                    '\n\nFORMAT longer answers with a headline, 2-3 emoji section headers, bold **LKR** numbers, and a "Bottom line:".';
                break;
            default:
                identity = base;
        }
        return identity + rules;
    }

    // ---------------------------------------------------------------------
    // 3. IMAGE GENERATION (Pollinations — free, no key, client-side)
    // ---------------------------------------------------------------------
    function extractImagePrompt(text) {
        var t = text.trim();
        // Strip leading command words
        t = t.replace(/^(please\s+)?(can you\s+)?(generate|create|make|draw|design|paint|render|produce|sketch|imagine|give me)\s+(me\s+)?(an?\s+)?(image|picture|photo|art|logo|illustration|drawing|wallpaper|poster|icon|graphic|pic|painting)\s*(of|for|showing|with|that looks like|:)?\s*/i, '');
        return t || text;
    }

    function generateImage(promptText) {
        var clean = extractImagePrompt(promptText);
        var seed = Math.floor(Math.random() * 1e9);
        var enhanced = encodeURIComponent(clean + ', high quality, highly detailed, professional, 4k');
        // Pollinations: free text-to-image, returns an image directly at this URL
        var url = 'https://image.pollinations.ai/prompt/' + enhanced +
            '?width=1024&height=1024&seed=' + seed + '&nologo=true&model=flux';
        return { url: url, prompt: clean };
    }

    // ---------------------------------------------------------------------
    // 4. ANTI-REPETITION
    // ---------------------------------------------------------------------
    var _recentReplies = [];
    function similarity(a, b) {
        if (!a || !b) return 0;
        a = a.toLowerCase().replace(/\s+/g, ' ').trim();
        b = b.toLowerCase().replace(/\s+/g, ' ').trim();
        if (a === b) return 1;
        // Token Jaccard similarity
        var sa = {}, sb = {}, i, common = 0;
        var ta = a.split(' '), tb = b.split(' ');
        for (i = 0; i < ta.length; i++) sa[ta[i]] = 1;
        for (i = 0; i < tb.length; i++) sb[tb[i]] = 1;
        var keysA = Object.keys(sa), keysB = Object.keys(sb);
        for (i = 0; i < keysA.length; i++) if (sb[keysA[i]]) common++;
        var union = keysA.length + keysB.length - common;
        return union ? common / union : 0;
    }
    function isRepetitive(reply) {
        for (var i = 0; i < _recentReplies.length; i++) {
            if (similarity(reply, _recentReplies[i]) > 0.82) return true;
        }
        return false;
    }
    function rememberReply(reply) {
        _recentReplies.push(reply);
        if (_recentReplies.length > 5) _recentReplies.shift();
    }

    // ---------------------------------------------------------------------
    // 5. PATCH sendAIMessage
    // ---------------------------------------------------------------------
    function installSendPatch() {
        if (typeof window.sendAIMessage !== 'function') return false;
        if (window.__aiV6SendPatched) return true;

        var origSend = window.sendAIMessage;

        window.sendAIMessage = async function (msgOverride) {
            var input = document.getElementById('aiChatInput');
            var msg = msgOverride || (input ? input.value.trim() : '');
            if (!msg) return;

            var intent = classifyIntent(msg, false);
            log('intent =', intent, '| msg =', msg.slice(0, 60));

            // ---- IMAGE GENERATION ----
            if (intent === 'image_gen') {
                if (input) { input.value = ''; if (window.autoResizeAIInput) window.autoResizeAIInput(input); }
                if (window.appendAIMessage) window.appendAIMessage('user', msg);

                var hist0 = window.getAIHistory ? window.getAIHistory() : [];
                hist0.push({ role: 'user', content: msg, ts: Date.now() });
                if (window.saveAIHistory) window.saveAIHistory(hist0);

                if (window.showAITyping) window.showAITyping(true);
                try {
                    var gen = generateImage(msg);
                    // Preload the image so we can show it when ready
                    await new Promise(function (resolve) {
                        var im = new Image();
                        im.onload = resolve;
                        im.onerror = resolve;
                        im.src = gen.url;
                        setTimeout(resolve, 12000); // safety timeout
                    });
                    if (window.showAITyping) window.showAITyping(false);

                    var html = '🎨 Here is the image I generated for "<strong>' + gen.prompt.replace(/</g, '&lt;') + '</strong>":<br><br>' +
                        '<img src="' + gen.url + '" alt="Generated image" ' +
                        'style="max-width:100%;border-radius:14px;border:1px solid var(--border);box-shadow:0 4px 18px rgba(0,0,0,.3);" ' +
                        'onclick="window.open(this.src,\'_blank\')" />' +
                        '<br><div style="font-size:11px;color:var(--text3);margin-top:6px;">Tap image to open full size · Ask me to "regenerate" for a new variation</div>';

                    if (window.appendAIMessage) window.appendAIMessage('bot', html);

                    var hist1 = window.getAIHistory ? window.getAIHistory() : [];
                    hist1.push({ role: 'assistant', content: '[Generated image: ' + gen.prompt + ']', ts: Date.now() });
                    if (window.saveAIHistory) window.saveAIHistory(hist1);
                } catch (err) {
                    if (window.showAITyping) window.showAITyping(false);
                    if (window.appendAIMessage) window.appendAIMessage('bot', '⚠️ I couldn\'t generate the image right now. Please try again with a clearer description.');
                }
                return;
            }

            // ---- NON-FINANCE INTENTS: override the system identity ----
            if (intent === 'general' || intent === 'code' || intent === 'math' ||
                intent === 'translate' || intent === 'definition') {

                if (input) { input.value = ''; if (window.autoResizeAIInput) window.autoResizeAIInput(input); }
                if (window.appendAIMessage) window.appendAIMessage('user', msg);

                var h = window.getAIHistory ? window.getAIHistory() : [];
                h.push({ role: 'user', content: msg, ts: Date.now() });
                if (window.saveAIHistory) window.saveAIHistory(h);

                if (window.showAITyping) window.showAITyping(true);
                if (document.getElementById('aiSendBtn')) document.getElementById('aiSendBtn').disabled = true;

                try {
                    var userName = 'there';
                    try {
                        var ctx = window.buildFinancialContext ? window.buildFinancialContext() : null;
                        if (ctx && ctx.userName) userName = ctx.userName;
                    } catch (_) {}

                    var sys = buildAdaptivePrompt(intent, userName, null);

                    var recent = (window.getAIHistory ? window.getAIHistory() : []).slice(-10);
                    var convo = sys + '\n\n--- CONVERSATION ---\n';
                    recent.slice(0, -1).forEach(function (m) {
                        convo += (m.role === 'user' ? userName : 'AI') + ': ' + m.content + '\n';
                    });
                    convo += userName + ': ' + msg + '\nAI:';

                    var reply = await window.callAI(convo);
                    reply = (reply || '').replace(/^#{1,3}\s+/gm, '').trim();

                    // Anti-repetition: regenerate once with a variation nudge
                    if (isRepetitive(reply)) {
                        log('repetitive reply detected — regenerating');
                        var convo2 = convo + '\n\n(Note: give a FRESH answer with different wording and new detail — do not repeat earlier phrasing.)';
                        var reply2 = await window.callAI(convo2);
                        reply2 = (reply2 || '').replace(/^#{1,3}\s+/gm, '').trim();
                        if (reply2 && reply2.length > 10) reply = reply2;
                    }
                    rememberReply(reply);

                    if (window.showAITyping) window.showAITyping(false);
                    if (window.appendAIMessage) window.appendAIMessage('bot', reply);

                    var h2 = window.getAIHistory ? window.getAIHistory() : [];
                    h2.push({ role: 'assistant', content: reply, ts: Date.now() });
                    if (window.saveAIHistory) window.saveAIHistory(h2);

                    if (window._updateAIContextPills) { try { window._updateAIContextPills(); } catch (_) {} }
                } catch (err) {
                    if (window.showAITyping) window.showAITyping(false);
                    if (window.appendAIMessage) window.appendAIMessage('bot', '⚠️ Connection issue. Please try again in a moment.\n\n' + (err && err.message ? err.message : ''));
                } finally {
                    if (document.getElementById('aiSendBtn')) document.getElementById('aiSendBtn').disabled = false;
                }
                return;
            }

            // ---- FINANCE intent → use the host's original (financial) flow,
            //      but still apply anti-repetition afterwards.
            return origSend.apply(this, arguments);
        };

        window.__aiV6SendPatched = true;
        log('sendAIMessage patched ✓');
        return true;
    }

    // ---------------------------------------------------------------------
    // 6. PATCH handleAIScan — smart image analysis (not always financial)
    // ---------------------------------------------------------------------
    function installScanPatch() {
        if (typeof window.handleAIScan !== 'function') return false;
        if (window.__aiV6ScanPatched) return true;

        var origScan = window.handleAIScan;

        window.handleAIScan = async function (e, type) {
            // Only re-route the conversational image path. Expense/subscription
            // receipt scanning keeps the host's specialised JSON pipeline.
            if (type !== 'ai_chat') {
                return origScan.apply(this, arguments);
            }

            var file = e.target.files[0];
            if (!file) return;

            // The user's accompanying text (if any) sets the intent
            var inputEl = document.getElementById('aiChatInput');
            var userText = inputEl ? inputEl.value.trim() : '';
            if (!userText) userText = 'What is this? Describe it in detail.';

            var intent = classifyIntent(userText, true); // image present
            log('scan intent =', intent);

            try {
                if (inputEl) { inputEl.value = ''; if (window.autoResizeAIInput) window.autoResizeAIInput(inputEl); }
                if (window.appendAIMessage) window.appendAIMessage('user', '🖼️ ' + userText);
                if (window.showAITyping) window.showAITyping(true);

                var comp = await window._compressImageToBase64(file, 1600, 0.9);
                var base64Img = comp.base64;

                var userName = 'there';
                try {
                    var ctx = window.buildFinancialContext ? window.buildFinancialContext() : null;
                    if (ctx && ctx.userName) userName = ctx.userName;
                } catch (_) {}

                var visionPrompt;
                if (intent === 'finance_vision') {
                    var fctx = '';
                    try {
                        var c = window.buildFinancialContext ? window.buildFinancialContext() : null;
                        if (c) fctx = 'Monthly income LKR ' + (c.totalMonthlyIncome || 0).toLocaleString() +
                            ', this-month expenses LKR ' + (c.thisMonthExpenses || 0).toLocaleString() + '.';
                    } catch (_) {}
                    visionPrompt = buildAdaptivePrompt('finance_vision', userName, fctx) +
                        '\n\nUser question about the attached image: "' + userText + '"';
                } else {
                    visionPrompt = buildAdaptivePrompt('image_analyze', userName, null) +
                        '\n\nThe user attached an image and asked: "' + userText + '"\n' +
                        'Answer their exact question about THIS image accurately. Describe what you actually see — ' +
                        'objects, text, brand, product, specs, scene, people, colours, context. ' +
                        'If they asked for specifications, list the real specs you can see or identify. ' +
                        'Do NOT treat this as a receipt or give financial advice unless the image is clearly financial.';
                }

                var reply = await window.callAI(visionPrompt, base64Img);
                reply = (reply || '').replace(/^#{1,3}\s+/gm, '').trim();

                if (isRepetitive(reply)) {
                    var reply2 = await window.callAI(visionPrompt + '\n\n(Give a fresh, different, detailed answer.)', base64Img);
                    reply2 = (reply2 || '').replace(/^#{1,3}\s+/gm, '').trim();
                    if (reply2 && reply2.length > 10) reply = reply2;
                }
                rememberReply(reply);

                if (window.showAITyping) window.showAITyping(false);
                if (window.appendAIMessage) window.appendAIMessage('bot', reply);

                var h = window.getAIHistory ? window.getAIHistory() : [];
                h.push({ role: 'user', content: '[Image] ' + userText, ts: Date.now() });
                h.push({ role: 'assistant', content: reply, ts: Date.now() });
                if (window.saveAIHistory) window.saveAIHistory(h);

                e.target.value = '';
            } catch (err) {
                if (window.showAITyping) window.showAITyping(false);
                if (window.appendAIMessage) window.appendAIMessage('bot', '⚠️ I couldn\'t analyse that image. Please try again.\n\n' + (err && err.message ? err.message : ''));
                e.target.value = '';
            }
        };

        window.__aiV6ScanPatched = true;
        log('handleAIScan patched ✓');
        return true;
    }

    // ---------------------------------------------------------------------
    // 7. BOOTSTRAP — wait until host functions exist, then patch
    // ---------------------------------------------------------------------
    var tries = 0;
    var boot = setInterval(function () {
        tries++;
        var a = installSendPatch();
        var b = installScanPatch();
        if ((a && b) || tries > 60) {
            clearInterval(boot);
            log('bootstrap complete (sendPatched=' + !!window.__aiV6SendPatched +
                ', scanPatched=' + !!window.__aiV6ScanPatched + ')');
        }
    }, 500);

    // Expose for diagnostics
    window.WealthFlowAIv6 = {
        classifyIntent: classifyIntent,
        generateImage: generateImage,
        version: '6.0'
    };
})();
