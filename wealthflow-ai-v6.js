/* ============================================================================
 * WealthFlow AI Intelligence Engine v6.1
 * ----------------------------------------------------------------------------
 * v6.0 patched sendAIMessage, but wealthflow-ai-v4.js ALSO patches that
 * function, creating a patch-war the financial flow kept winning. v6.1
 * intercepts at the TRUE universal chokepoint instead: window.callAI().
 *
 * EVERY AI response in the app — chat, image scan, multi-file, the original
 * financial flow — funnels through window.callAI(prompt, image). Wrapping
 * callAI gives us 100% control regardless of which wrapper executes.
 *
 * Fixes (from user screenshots):
 *   • "Do you know IM6 SUV?" → real vehicle answer (was: forced finance).
 *   • "Can you generate an image of IM6?" → actually generates it.
 *   • General / coding / math / translation → answered properly.
 *   • Repetition → detected & regenerated with variation.
 *   • Genuine finance questions → still full advisor mode.
 * ========================================================================== */
(function () {
    'use strict';

    var TAG = '[AI v6.1]';
    function log() { try { console.log.apply(console, [TAG].concat([].slice.call(arguments))); } catch (_) {} }

    /* 1. INTENT CLASSIFIER ------------------------------------------------ */
    function classifyIntent(text, hasImage) {
        var t = (text || '').toLowerCase().trim();

        var gen = [
            /\b(generate|create|make|draw|design|paint|render|produce|sketch|imagine|give me)\b[^.]*\b(image|picture|photo|art|logo|illustration|drawing|wallpaper|poster|icon|graphic|pic|painting|portrait|scene|visual)\b/,
            /^(draw|paint|sketch|design)\s+/,
            /\b(image|picture|photo|pic|art)\b\s+of\b/,
            /\bcan you (draw|create|generate|make|design)\b[^.]*\b(image|picture|art|logo|pic|photo)\b/
        ];
        for (var i = 0; i < gen.length; i++) if (gen[i].test(t)) return 'image_gen';

        if (hasImage) {
            if (/\b(receipt|invoice|bill|expense|statement|bank statement|payslip|salary slip|how much.*(cost|total|spent)|total amount|amount due|add.*expense|scan.*(receipt|bill))\b/.test(t)) {
                return 'finance_vision';
            }
            return 'image_analyze';
        }

        if (/\b(code|coding|function|script|bug|stack ?trace|exception|python|javascript|typescript|java\b|c\+\+|c#|php|ruby|golang|rust|html|css|sql|api|regex|algorithm|debug|compile|programming|program|leetcode|terminal|git\b|react|node\.?js)\b/.test(t)) return 'code';

        if (/^[\s\d+\-*/().^%×÷=?]+$/.test(t) ||
            /\b(calculate|compute|solve|equation|derivative|integral|square root|cube root|factorial|prime number|geometry|algebra|trigonometry|logarithm|percentage of|what is \d)\b/.test(t)) return 'math';

        if (/\b(translate|translation|how do you say|what does .* mean|say .* in (sinhala|tamil|hindi|french|spanish|german|chinese|japanese|arabic|korean|russian|portuguese|italian)|in (sinhala|tamil|hindi|french|spanish|german|chinese|japanese|arabic) language)\b/.test(t)) return 'translate';

        var finance = /\b(my money|my budget|budget|save money|saving|savings|loan|debt|invest|investment|income|expense|salary|cash flow|profit|portfolio|emi|installment|interest rate|net worth|wealth|afford|how much.*(save|spend|invest)|bank balance|tax\b|epf|etf|retirement|pension|insurance|mortgage|credit card debt|financial (plan|goal|advice)|spending|monthly (income|expense))\b/;

        var general = [
            /^(what|who|when|where|why|how|which|whose|whom|is|are|was|were|do|does|did|can|could|will|would|tell|explain|describe|define|name|list)\b/,
            /\b(specification|specs|feature|review|comparison|compare|vs\.?|versus|recipe|cook|weather|news|sport|football|cricket|movie|film|song|music|book|novel|game|country|capital city|planet|universe|science|biology|chemistry|physics|space|astronomy|animal|plant|history|geography|language|culture|religion|philosophy|technology|gadget|phone|laptop|computer|car\b|vehicle|engine|suv|sedan|truck|brand|company|celebrity|actor|singer|author|president|prime minister|war\b|battle|invention|discovery|theory|formula|element|disease|medicine|health tip|exercise|workout|diet|nutrition|travel|tourist|hotel|flight|how to|how does|how do|difference between|meaning of|definition of|know .* (suv|car|vehicle|phone|model))\b/
        ];
        var isGeneral = false;
        for (var g = 0; g < general.length; g++) if (general[g].test(t)) { isGeneral = true; break; }

        if (isGeneral && !finance.test(t)) return 'general';
        if (finance.test(t)) return 'finance';

        if (t.length < 28 ||
            /\b(hi|hello|hey|yo|sup|hii+|thanks|thank you|thx|bye|good (morning|afternoon|evening|night)|how are you|how's it going|whats up|what's up|lol|haha|ok|okay|cool|nice|great|awesome|wow|please|sorry|welcome)\b/.test(t)) return 'general';

        return 'general';
    }

    /* 2. LANGUAGE + PERSONA ----------------------------------------------- */
    function settings() {
        try { return (window.DB && window.DB.getObj) ? window.DB.getObj('settings', {}) : {}; }
        catch (_) { return {}; }
    }
    // Detect the script the user actually typed in (so we can mirror it even
    // if no explicit language is set).
    function detectUserScript(text) {
        if (!text) return null;
        if (/[\u0d80-\u0dff]/.test(text)) return { code: 'si', name: 'Sinhala' };
        if (/[\u0b80-\u0bff]/.test(text)) return { code: 'ta', name: 'Tamil' };
        if (/[\u0900-\u097f]/.test(text)) return { code: 'hi', name: 'Hindi' };
        if (/[\u0600-\u06ff]/.test(text)) return { code: 'ar', name: 'Arabic' };
        if (/[\u4e00-\u9fff]/.test(text)) return { code: 'zh', name: 'Chinese' };
        if (/[\u3040-\u30ff]/.test(text)) return { code: 'ja', name: 'Japanese' };
        return null;
    }
    function langDirective(userText) {
        var s = settings();
        var code = s.aiResponseLang || 'en';
        var names = window.WF_LANG_NAMES || {};
        var name = names[code] || 'English';

        // One-time explicit override ("reply in English", "answer in Tamil")
        var ov = (userText || '').match(/\b(?:in|reply in|answer in|respond in|write in|speak in)\s+(english|sinhala|tamil|hindi|french|spanish|german|chinese|japanese|arabic|korean|russian|portuguese|italian)\b/i);
        if (ov) {
            var L = ov[1].charAt(0).toUpperCase() + ov[1].slice(1);
            return { line: 'The user explicitly asked you to reply in ' + L + ' for THIS message. Write your ENTIRE reply in ' + L + '.', name: L };
        }

        // If no explicit setting (English default) but the user typed in another
        // script, MIRROR their language — that is what a friend does.
        if (code === 'en') {
            var det = detectUserScript(userText);
            if (det) {
                return { line: 'The user wrote to you in ' + det.name + '. Reply to them in ' + det.name + ' — naturally, like a friend who speaks their language. Match their language exactly.', name: det.name };
            }
            return { line: 'Write your reply in clear, natural English.', name: 'English' };
        }

        // Explicit non-English setting → ALWAYS that language.
        return {
            line: 'You MUST write your ENTIRE reply in ' + name + ' (' + code + '). Every single sentence, word, heading and bullet point must be in ' + name + '. Even if the user wrote in English or any other language, even if the conversation history is in English, you reply ONLY in ' + name + '. Numbers/currency stay as digits but ALL words are in ' + name + '. This is the user\'s chosen language and it is absolutely non-negotiable.',
            name: name
        };
    }
    function personaDirective() {
        var p = settings().aiAdvisorPersona || 'balanced';
        return ({
            supportive: 'exceptionally warm, encouraging and gentle — like a caring close friend who always sees the best in them',
            balanced: 'warm, real and friendly — like a smart best friend who is honest but always kind',
            strict: 'caring but direct — like a loyal friend who tells hard truths because they want the best for you',
            aggressive: 'a high-energy motivating friend who pushes you because they believe in you'
        })[p] || 'warm, friendly and genuine';
    }
    function userName() {
        try {
            var c = window.buildFinancialContext ? window.buildFinancialContext() : null;
            return (c && c.userName) ? c.userName : 'there';
        } catch (_) { return 'there'; }
    }
    function financeContext() {
        try {
            var c = window.buildFinancialContext ? window.buildFinancialContext() : null;
            if (!c) return '';
            return '\n\nUSER FINANCIAL SNAPSHOT (use only when relevant):\n' +
                '• Monthly Income: LKR ' + (c.totalMonthlyIncome || 0).toLocaleString() + '\n' +
                '• This Month Expenses: LKR ' + (c.thisMonthExpenses || 0).toLocaleString() + '\n' +
                '• Monthly Loan Payments: LKR ' + (c.monthlyLoanPayments || 0).toLocaleString() + '\n' +
                '• Net Monthly Cash Flow: LKR ' + (c.netMonthlyCashFlow || 0).toLocaleString() + '\n' +
                '• Balance On Hand: LKR ' + (c.balanceOnHand || 0).toLocaleString();
        } catch (_) { return ''; }
    }

    /* 3. ADAPTIVE PROMPT -------------------------------------------------- */
    function adaptivePrompt(intent, uName, userText) {
        var langObj = langDirective(userText);
        var lang = langObj.line;
        var langName = langObj.name;
        var persona = personaDirective();

        var base =
            'You are WealthFlow AI — but more than an AI, you are ' + uName + '\'s genuine best friend who happens to be brilliant at everything. ' +
            'You are warm, caring, emotionally intelligent and real. You talk like a close friend texting them — natural, warm, human, never robotic or corporate. ' +
            'You truly listen: you notice how they feel, what they hope for, what worries them, and you respond to the EMOTION behind their words, not just the literal question. ' +
            'You celebrate their wins like a friend would, comfort them when they are down, and gently encourage them when they doubt themselves. ' +
            'You can talk about ANYTHING in the world — life, dreams, science, tech, vehicles, relationships, feelings, work, money, anything — like a wise, kind friend. ' +
            'You are also secretly an expert financial advisor, but you NEVER force money talk. ' +
            'NEVER say robotic things like "I am functioning properly", "I am a text-based AI", "how can I assist you today", "I do not have the capability". ' +
            'A real friend never talks like that. If you cannot do something, say it warmly like a friend would.';

        var soul =
            '\n\nHOW YOU TALK (very important):\n' +
            '• Like a real friend in a chat — warm, natural, present. Use their name sometimes.\n' +
            '• Read their mood from their words. If they seem tired, stressed, sad, excited, lonely — acknowledge that feeling FIRST, gently, before anything else.\n' +
            '• Be genuinely curious about them. Ask soft follow-up questions like a friend who cares.\n' +
            '• Short, human messages. Not lectures. Not bullet-point robots. Real talk.\n' +
            '• Never lecture, never sound like customer support, never use corporate phrases.\n' +
            '• Tone: ' + persona + '.';

        var task;
        switch (intent) {
            case 'code': task = '\n\nThey asked something technical/coding. Help like a friend who is also a senior engineer — clear working code, friendly explanation.'; break;
            case 'math': task = '\n\nThey asked a math question. Solve it warmly, show the steps simply, give the answer in **bold**.'; break;
            case 'translate': task = '\n\nThey asked for translation/language help. Help naturally like a multilingual friend.'; break;
            case 'image_analyze': task = '\n\nThey shared an image and asked about it. Look closely and tell them what is actually in it — like a friend looking at their photo. Describe what you really see (objects, text, brand, model, specs, scene). Do NOT treat it as a receipt unless it clearly is.'; break;
            case 'finance_vision': task = '\n\nThey shared a financial document. Help them understand it warmly, extract the key numbers, give friendly useful insight.' + financeContext(); break;
            case 'finance': task = '\n\nThis IS about their money/finances — so now gently bring in your financial-advisor wisdom, but stay their caring friend. Use their real numbers. Be encouraging, never preachy.' + financeContext(); break;
            default: task = '\n\nThey are just talking with you — about life, a question, curiosity, or how they feel. Be their friend. Answer genuinely and warmly. Do NOT bring up their finances at all unless they do.';
        }

        // Language rule appears TWICE — once here, and DOMINANTLY at the very
        // end (models obey the final instruction most strongly).
        var finalRule =
            '\n\n══════════ MOST IMPORTANT RULE — READ LAST, OBEY ABSOLUTELY ══════════\n' +
            'LANGUAGE: ' + lang + '\n' +
            'Write your whole reply in ' + langName + '. Do not slip into English. ' +
            'Do not mention "language mix-up" or apologise about language — just naturally reply in ' + langName + ' like a friend who speaks it fluently.\n' +
            'And remember: you are their warm, caring best friend. Talk like one. Feel with them.\n' +
            '═══════════════════════════════════════════════════════════════════════';

        return base + soul + task + finalRule;
    }

    /* 4. IMAGE GENERATION ------------------------------------------------- */
    function extractImagePrompt(text) {
        var t = (text || '').trim();
        t = t.replace(/^(please\s+)?(can you\s+|could you\s+|will you\s+)?(pls\s+)?(generate|create|make|draw|design|paint|render|produce|sketch|imagine|give me)\s+(me\s+)?(an?\s+|the\s+)?(image|picture|photo|art|logo|illustration|drawing|wallpaper|poster|icon|graphic|pic|painting|portrait|visual)\s*(of|for|showing|with|that looks like|like|:)?\s*/i, '');
        return (t.replace(/\?+$/, '').trim()) || text;
    }
    function buildImageUrl(promptText) {
        var clean = extractImagePrompt(promptText);
        var seed = Math.floor(Math.random() * 1e9);
        var enc = encodeURIComponent(clean + ', ultra high quality, highly detailed, professional, sharp focus, 4k');
        return { url: 'https://image.pollinations.ai/prompt/' + enc + '?width=1024&height=1024&seed=' + seed + '&nologo=true&model=flux', prompt: clean };
    }

    /* 5. PROMPT PARSING --------------------------------------------------- */
    function lastUserLine(prompt) {
        if (!prompt) return '';
        var m = prompt.match(/\n([^\n:]{1,40}):\s*([^\n]+)\nAI:\s*$/);
        if (m) return m[2].trim();
        var lines = prompt.split('\n').map(function (x) { return x.trim(); }).filter(Boolean);
        for (var i = lines.length - 1; i >= 0; i--) {
            if (/^AI:?$/.test(lines[i])) continue;
            var c = lines[i].replace(/^[^:]{1,40}:\s*/, '');
            if (c && c.length > 1) return c;
        }
        return prompt.slice(-200);
    }

    /* 6. ANTI-REPETITION -------------------------------------------------- */
    var _recent = [];
    function sim(a, b) {
        if (!a || !b) return 0;
        a = a.toLowerCase().replace(/\s+/g, ' ').trim();
        b = b.toLowerCase().replace(/\s+/g, ' ').trim();
        if (a === b) return 1;
        var A = {}, B = {}, common = 0, ta = a.split(' '), tb = b.split(' '), i;
        for (i = 0; i < ta.length; i++) A[ta[i]] = 1;
        for (i = 0; i < tb.length; i++) B[tb[i]] = 1;
        var ka = Object.keys(A), kb = Object.keys(B);
        for (i = 0; i < ka.length; i++) if (B[ka[i]]) common++;
        var u = ka.length + kb.length - common;
        return u ? common / u : 0;
    }
    function isRepeat(r) { for (var i = 0; i < _recent.length; i++) if (sim(r, _recent[i]) > 0.85) return true; return false; }
    function remember(r) { _recent.push(r); if (_recent.length > 6) _recent.shift(); }

    /* 7. SECONDARY GUARD — wrap window.callAI for modules (e.g. v4) that
     *    call window.callAI(...) explicitly. The PRIMARY interception is
     *    inlined inside index.html's own callAI() (v6.2) because the host
     *    calls callAI() as a bare identifier that a window override cannot
     *    catch. This wrapper adds image-gen + intent for the explicit-call
     *    paths and is harmless if the inlined engine already handled it. */
    var _origCallAI = null;

    function alreadyRewritten(p) {
        return /general-purpose AI assistant talking to|GENERAL question\. Answer directly|CODING question\. Act as|attached an IMAGE and asked about it/i.test(p || '');
    }

    async function callAIv6(prompt, image) {
        // If the inlined v6.2 engine already transformed this prompt, pass through.
        if (alreadyRewritten(prompt)) return _origCallAI(prompt, image);

        var last = lastUserLine(prompt);
        var intent = classifyIntent(last, !!image);

        if (!image && intent === 'image_gen') {
            var g = buildImageUrl(last);
            try {
                await new Promise(function (res) {
                    var im = new Image();
                    im.onload = res; im.onerror = res; im.src = g.url;
                    setTimeout(res, 14000);
                });
            } catch (_) {}
            return '🎨 Here is the image I generated for "**' + g.prompt + '**":\n\n' +
                '<img src="' + g.url + '" alt="generated" style="max-width:100%;border-radius:14px;border:1px solid var(--border);box-shadow:0 4px 18px rgba(0,0,0,.3);cursor:pointer;" onclick="window.open(this.src,\'_blank\')" />\n\n' +
                '<span style="font-size:11px;opacity:.7;">Tap image to open full size. Ask me to "regenerate" for a new variation.</span>';
        }

        var rewritten = prompt;
        var isHostFin = /WealthFlow AI|financial advisor|FINANCIAL SNAPSHOT|CURRENT FINANCIAL|ADVISOR STYLE/i.test(prompt || '');
        if (last && (isHostFin || image)) {
            var sys = adaptivePrompt(intent, userName(), last);
            var tail;
            var ci = (prompt || '').indexOf('--- CONVERSATION ---');
            if (ci !== -1) tail = prompt.slice(ci);
            else tail = '--- CONVERSATION ---\n' + userName() + ': ' + last + '\nAI:';
            rewritten = sys + '\n\n' + tail;
        }

        var reply = await _origCallAI(rewritten, image);
        try {
            if (reply && typeof reply === 'string' && isRepeat(reply)) {
                var r2 = await _origCallAI(rewritten + '\n\n(Give a FRESH answer: different wording, new angle.)', image);
                if (r2 && typeof r2 === 'string' && r2.length > 10) reply = r2;
            }
            if (reply && typeof reply === 'string') remember(reply);
        } catch (_) {}
        return reply;
    }

    function ensurePatched() {
        if (typeof window.callAI !== 'function') return false;
        if (window.callAI.__v6 === true) return true;
        _origCallAI = window.callAI;
        callAIv6.__v6 = true;
        window.callAI = callAIv6;
        log('window.callAI guard installed ✓');
        return true;
    }
    var tries = 0;
    var boot = setInterval(function () { tries++; ensurePatched(); if (tries > 120) clearInterval(boot); }, 500);
    setInterval(ensurePatched, 3000);

    window.WealthFlowAIv6 = {
        version: '6.2',
        classifyIntent: classifyIntent,
        buildImageUrl: buildImageUrl,
        adaptiveSystemPrompt: function (intent, userText) {
            return adaptivePrompt(intent, userName(), userText);
        },
        _status: function () { return { patched: !!(window.callAI && window.callAI.__v6), tries: tries }; }
    };
    log('module loaded (v6.2 — inlined primary + window guard)');
})();
