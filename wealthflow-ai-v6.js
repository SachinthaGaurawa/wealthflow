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
    function langDirective(userText) {
        var s = settings();
        var code = s.aiResponseLang || 'en';
        var names = window.WF_LANG_NAMES || {};
        var name = names[code] || 'English';
        var ov = (userText || '').match(/\b(?:in|reply in|answer in|respond in|write in)\s+(english|sinhala|tamil|hindi|french|spanish|german|chinese|japanese|arabic|korean|russian|portuguese|italian)\b/i);
        if (ov) return 'The user explicitly asked you to reply in ' + ov[1] + ' for THIS message. Write the entire reply in ' + ov[1] + '.';
        if (code === 'en') return 'Write the reply in English.';
        return 'CRITICAL LANGUAGE RULE: Write your ENTIRE reply in ' + name + ' (' + code + '). Every sentence, heading and bullet, even if the user wrote in English. This overrides everything.';
    }
    function personaDirective() {
        var p = settings().aiAdvisorPersona || 'balanced';
        return ({
            supportive: 'Tone: exceptionally warm, encouraging, gentle. Lead with positives.',
            balanced: 'Tone: realistic, professional, friendly — a knowledgeable friend.',
            strict: 'Tone: blunt, direct, disciplined. No sugar-coating. Minimal emojis.',
            aggressive: 'Tone: high-energy coach. Push hard. Strong action verbs.'
        })[p] || 'Tone: friendly and professional.';
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
        var lang = langDirective(userText);
        var persona = personaDirective();
        var base =
            'You are WealthFlow AI — a brilliant, friendly, genuinely helpful general-purpose AI assistant talking to ' + uName + '. ' +
            'You can discuss ANY topic in the world: science, technology, vehicles, gadgets, history, cooking, health, travel, ' +
            'entertainment, coding, math, languages, general knowledge, life advice — anything at all. ' +
            'You ALSO happen to be an expert financial advisor, but you are absolutely NOT limited to finance. ' +
            'Answer EXACTLY what the user asked. NEVER pivot a non-financial question back to their money, budget, income or savings. ' +
            'NEVER say things like "let me shift the conversation to your financial situation" or "as your financial advisor". ' +
            'That behaviour is wrong and explicitly unwanted by the user.';
        var rules =
            '\n\nRULES:\n' +
            '1. Answer the actual question accurately with real facts and detail.\n' +
            '2. Product/vehicle/phone questions (e.g. "IM6 SUV", "iPhone 15 specs") → give real specs & info, NOT financial advice.\n' +
            '3. Match length to the question.\n' +
            '4. Never repeat an earlier answer verbatim.\n' +
            '5. Be warm and human. No unwanted disclaimers.\n' +
            '6. ' + persona + '\n7. ' + lang;

        switch (intent) {
            case 'code': return base + '\n\nCODING question. Act as a senior software engineer. Correct, working, clearly-explained code in code blocks.' + rules;
            case 'math': return base + '\n\nMATH question. Solve step-by-step, show working, final answer in **bold**.' + rules;
            case 'translate': return base + '\n\nTRANSLATION request. Accurate translation + pronunciation if helpful + short usage note.' + rules;
            case 'image_analyze': return base + '\n\nThe user attached an IMAGE and asked about it. Describe & analyse what is ACTUALLY visible — objects, text, brand, product, model, specifications, scene, people, colours. Answer their exact question about THIS image. Do NOT treat it as a receipt or give financial advice unless it is clearly financial.' + rules;
            case 'finance_vision': return base + '\n\nThe user attached a financial document. Extract key figures, give a clear useful breakdown & insight.' + financeContext() + rules;
            case 'finance': return base + '\n\nThis IS a genuine financial question — now act as the user\'s expert personal financial advisor. Be specific with their real numbers. Format longer answers with a headline, 2-3 emoji section headers, **bold LKR numbers**, and a "Bottom line:".' + financeContext() + rules;
            default: return base + '\n\nGENERAL question. Answer directly and thoroughly like a brilliant expert + friendly teacher. Do NOT mention the user\'s finances at all unless they explicitly ask about money.' + rules;
        }
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
