/* =============================================================================
   WealthFlow SMS Paste v1.0 — Manual Bank-SMS Classifier
   ---------------------------------------------------------------------------
   The user receives bank SMS messages on their phone (Sri Lankan banks, AMEX,
   HSBC, international banks, etc). They copy any SMS — one at a time, or a
   batch of 50 pasted together — into this module's textarea. We:

     1. Split the paste into individual SMS messages (smart splitter: handles
        SMSes separated by blank lines, "---", date headers, or just one big
        run-on paste — uses bank-sender markers + transaction-verb anchors).
     2. Send each one through /api/autonomous-brain → get back parsed amount,
        currency, date, merchant name, category, suggested module.
     3. Show a 1000%-accurate "Preview Before Filing" grid:
            ┌──────────────────────────────────────────────────────────────┐
            │ 29 May 2026  •  CARGILLS FOOD CITY                           │
            │              💸 LKR 2,498.74  → Food & Groceries  (98% sure) │
            │              📁 Monthly Expenses → May 2026                  │
            │  [✓ File]  [📂 Change tab]  [✏ Edit]  [✕ Skip]               │
            └──────────────────────────────────────────────────────────────┘
     4. User taps "File All" (one tap to commit all) OR reviews + tweaks each
        row first. Each transaction is then routed via wfAllocate() which
        stamps month/year so it lands in the correct calendar tab.
     5. Anything below 95% confidence gets flagged for the existing Quarantine
        Zone in wealthflow-intelligence.js.

   Exposes:
     • window.wfOpenSmsPaste()       — opens the paste modal
     • window.wfClassifySmsBatch(txt)— programmatic API (returns array of brain results)

   No external dependency. No API key the user has to set up. Works offline
   (brain returns lower confidence without the optional Tavily lookup, but
   still resolves 250+ merchants deterministically from the local DB).
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_SMS_PASTE_LOADED) return;
    window.WF_SMS_PASTE_LOADED = '1.0';

    // ─────────────────────────── tiny helpers ────────────────────────────────
    function _notify(m, t) { try { if (typeof window.notify === 'function') window.notify(m, t || 'info'); } catch (_) {} }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]); }
    function _money(amt, cur) { try { return (cur || 'LKR') + ' ' + (Number(amt) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); } catch { return (cur || 'LKR') + ' ' + amt; } }
    function _dateLabel(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
    }
    function _monthLabel(ts) {
        if (!ts) return '';
        const d = new Date(ts);
        if (isNaN(d.getTime())) return '';
        return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
    }
    function _moduleLabel(mod) {
        return ({
            expenses: '💸 Monthly Expenses',
            income: '💰 Income & Investments',
            subscriptions: '🔁 Subscriptions',
            cconetime: '💳 CC One-Time Payments',
            ccinstall: '🗓 CC Installments',
            loan: '🏦 Loan Payment',
            loans: '🏦 Loan Payment',
            goal: '🎯 Savings Goal',
            cc_payment: '🔄 CC Bill Payment (FIFO reconcile)'
        })[mod] || ('📁 ' + mod);
    }
    function _confColor(c) {
        if (c == null) return '#94a3b8';
        if (c >= 0.95) return '#10b981';
        if (c >= 0.85) return '#84cc16';
        if (c >= 0.70) return '#f59e0b';
        return '#ef4444';
    }
    function _confLabel(c) {
        if (c == null) return '—';
        return Math.round(c * 100) + '% sure';
    }

    // ─────────────────── Smart SMS splitter ──────────────────────────────────
    // Splits a paste containing one OR many SMSes into individual messages.
    // 5 strategies, tried in order:
    //   1. Triple-dash / equal / asterisk separators ("---", "===", "***")
    //   2. Blank lines between blocks
    //   3. Bank-sender prefixes (line-anchored OR mid-line)
    //   4. Multi-anchor line-by-line (each line = its own SMS)
    //   5. Single-paragraph multi-anchor (split before each amount in a blob)
    // Falls back to treating the whole paste as a single SMS.
    function splitSmsBatch(raw) {
        const text = String(raw || '').trim();
        if (!text) return [];

        // 1. Explicit separator?
        const sepRe = /\n\s*(?:-{3,}|={3,}|\*{3,}|_{3,}|#{3,})\s*\n/;
        if (sepRe.test(text)) {
            return text.split(sepRe).map(s => s.trim()).filter(s => s.length > 10);
        }

        // 2. Blank-line separated?
        if (/\n\s*\n/.test(text)) {
            const parts = text.split(/\n\s*\n+/).map(s => s.trim()).filter(s => s.length > 10);
            if (parts.length >= 2 && parts.every(p => /\d/.test(p))) return parts;
        }

        // 3. Bank-sender prefix split — works for both newline-prefixed AND
        //    mid-text occurrences (e.g. "Combank: ... HNB: ..." on one line).
        const senderTokenRe = /(?:HNB|Combank|COMBANK|Comm\.?\s?Bank|Sampath|NTB|Nations\s?Trust|Seylan|DFCC|NDB|BOC|People['']?s\s?Bank|Pan\s?Asia|Union\s?Bank|StanChart|Standard\s?Chartered|HSBC|AMEX|American\s?Express|NSB|Citi|Citibank|Mashreq|Emirates\s?NBD|ADCB|FAB|HDFC|ICICI|SBI|Axis|Kotak|Chase|Wells\s?Fargo|Bank\s?of\s?America|Lloyds|Barclays|NatWest|Santander|DBS|UOB|OCBC|InfoSMS|BankSMS|Alert)\s*[:\-]/gi;
        const senderMatches = [];
        let mm;
        senderTokenRe.lastIndex = 0;
        while ((mm = senderTokenRe.exec(text)) !== null) senderMatches.push(mm.index);
        if (senderMatches.length >= 2) {
            const parts = [];
            for (let i = 0; i < senderMatches.length; i++) {
                const start = senderMatches[i];
                const end = (i + 1 < senderMatches.length) ? senderMatches[i + 1] : text.length;
                parts.push(text.slice(start, end).trim());
            }
            const cleaned = parts.filter(p => p.length > 10);
            if (cleaned.length >= 2) return cleaned;
        }

        // 4. Multi-anchor line-by-line (each line ends up its own SMS if all
        //    lines look like transaction anchors)
        const verbRe = /\b(?:debited|credited|withdrawn|deposited|purchase|charged|paid|received|spent|transfer|payment|withdraw|deposit)\b/i;
        const amountRe = /(?:LKR|Rs\.?|USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CHF|[$€£₹¥])\s*[\d,]+(?:\.\d{1,2})?/i;
        const isAnchor = (l) => verbRe.test(l) && amountRe.test(l);
        const lines = text.split(/\n+/).map(l => l.trim()).filter(Boolean);
        if (lines.length >= 2) {
            const anchorIdx = lines.map((l, i) => isAnchor(l) ? i : -1).filter(i => i >= 0);
            if (anchorIdx.length === lines.length && anchorIdx.length >= 2) {
                // Every line is its own SMS
                return lines.slice();
            }
            if (anchorIdx.length >= 2) {
                const blocks = [];
                for (let i = 0; i < anchorIdx.length; i++) {
                    const start = anchorIdx[i];
                    const end = (i + 1 < anchorIdx.length) ? anchorIdx[i + 1] : lines.length;
                    blocks.push(lines.slice(start, end).join(' ').trim());
                }
                return blocks.filter(b => b.length > 10);
            }
        }

        // Backwards-compat alias used by branch 5 below
        const amountVerbRe = { test: (s) => isAnchor(s) };

        // 5. Single-paragraph multi-anchor: paste is one blob with several
        //    amount+verb pairs separated by connecting words ("then", "and",
        //    "also", "next", or just a sentence break). Walk back from each
        //    amount-anchor to find a boundary and split there.
        const inlineAnchorRe = /(?:LKR|Rs\.?|USD|EUR|GBP|INR|AED|SGD|AUD|JPY|CHF|[$€£₹¥])\s*[\d,]+(?:\.\d{1,2})?/gi;
        const anchorPositions = [];
        let am;
        inlineAnchorRe.lastIndex = 0;
        while ((am = inlineAnchorRe.exec(text)) !== null) {
            anchorPositions.push(am.index);
            if (am[0].length === 0) inlineAnchorRe.lastIndex++; // safety
        }
        if (anchorPositions.length >= 2) {
            const splits = [0];
            for (let i = 1; i < anchorPositions.length; i++) {
                const here = anchorPositions[i];
                const lookback = text.slice(Math.max(0, here - 80), here);
                // Non-greedy boundary detection — find LAST connector word
                // before this anchor (sentence-end + space, "then", "and", etc.)
                let boundary = -1;
                const connectorRe = /(?:[.!?]\s+|\bthen\s+|\band\s+|\balso\s+|\bnext\s+|\bagain\s+)/gi;
                let cm;
                connectorRe.lastIndex = 0;
                while ((cm = connectorRe.exec(lookback)) !== null) {
                    if (cm[0].length === 0) { connectorRe.lastIndex++; continue; } // safety
                    boundary = cm.index + cm[0].length;
                }
                splits.push(Math.max(0, here - 80) + Math.max(0, boundary));
            }
            splits.push(text.length);
            const parts = [];
            for (let i = 0; i < splits.length - 1; i++) {
                const piece = text.slice(splits[i], splits[i + 1]).trim();
                if (piece.length > 10 && amountVerbRe.test(piece)) parts.push(piece);
            }
            if (parts.length >= 2) return parts;
        }

        // 6. Single SMS
        return [text];
    }
    window.wfSplitSmsBatch = splitSmsBatch;

    // ─────────────────── Brain dispatcher (concurrent) ───────────────────────
    async function classifyOne(sms) {
        try {
            const cardRegistry = (window.wfCardRegistry && window.wfCardRegistry.get && window.wfCardRegistry.get()) || {};
            const knownLoans = (window.DB && window.DB.get && window.DB.get('loans')) || [];
            const r = await fetch('/api/autonomous-brain', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sms,
                    phone_number: 'manual-paste',
                    received_at_ms: Date.now(),
                    device_id: 'manual',
                    card_registry: cardRegistry,
                    known_loans: knownLoans
                })
            });
            return await r.json();
        } catch (e) {
            return { ok: false, error: String(e && e.message || e) };
        }
    }

    async function classifyBatch(rawText, onProgress) {
        const messages = splitSmsBatch(rawText);
        if (!messages.length) return [];
        const out = new Array(messages.length);
        const POOL = 6;
        let cursor = 0;
        let done = 0;
        async function worker() {
            while (true) {
                const i = cursor++;
                if (i >= messages.length) return;
                out[i] = { raw: messages[i], brain: await classifyOne(messages[i]) };
                done++;
                if (typeof onProgress === 'function') onProgress(done, messages.length);
            }
        }
        await Promise.all(Array.from({ length: Math.min(POOL, messages.length) }, worker));
        return out;
    }
    window.wfClassifySmsBatch = classifyBatch;
    // Expose the single-message classifier so the background queue engine
    // (wealthflow-queue.js) can route items through the exact same brain call.
    window.wfBrainClassify = classifyOne;

    // ─────────────────── Modal UI ────────────────────────────────────────────
    const MODAL_CSS = `
        .wfsms-overlay{position:fixed;inset:0;z-index:99998;background:rgba(0,0,0,0.7);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:0;}
        .wfsms-modal{background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:0;width:100%;height:100%;max-width:760px;max-height:100vh;display:flex;flex-direction:column;box-shadow:0 30px 90px rgba(0,0,0,0.65);}
        @media(min-width:760px){.wfsms-overlay{padding:20px;}.wfsms-modal{height:auto;max-height:92vh;border-radius:18px;}}
        .wfsms-head{display:flex;justify-content:space-between;align-items:center;padding:18px 22px;padding-top:max(18px, calc(env(safe-area-inset-top, 0px) + 14px));border-bottom:1px solid var(--border,#1f2638);}
        .wfsms-title{font-weight:800;font-size:17px;background:linear-gradient(135deg,#10b981,#d4af37);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;}
        .wfsms-close{background:transparent;border:none;color:var(--text3,#8b95a8);font-size:26px;line-height:1;cursor:pointer;padding:4px 10px;border-radius:8px;}
        .wfsms-close:hover{background:rgba(255,255,255,0.06);color:var(--text,#e6e7eb);}
        .wfsms-body{flex:1;overflow-y:auto;padding:18px 22px;-webkit-overflow-scrolling:touch;}
        .wfsms-foot{padding:14px 22px;border-top:1px solid var(--border,#1f2638);display:flex;gap:10px;align-items:center;flex-wrap:wrap;}
        .wfsms-tabs{display:flex;gap:6px;background:var(--bg2,#0a0e1a);padding:4px;border-radius:11px;margin-bottom:14px;}
        .wfsms-tab{flex:1;padding:8px 12px;border-radius:8px;background:transparent;border:none;color:var(--text2,#94a3b8);font-weight:700;font-size:12.5px;cursor:pointer;transition:all .15s;}
        .wfsms-tab.active{background:linear-gradient(135deg,rgba(16,185,129,0.18),rgba(212,175,55,0.10));color:var(--text,#e6e7eb);box-shadow:0 2px 8px rgba(0,0,0,0.2);}
        .wfsms-ta{width:100%;min-height:220px;padding:14px;border-radius:12px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);color:var(--text,#e6e7eb);font-family:ui-monospace,'SF Mono',Menlo,monospace;font-size:12.5px;line-height:1.55;resize:vertical;box-sizing:border-box;}
        .wfsms-ta:focus{outline:none;border-color:#10b981;box-shadow:0 0 0 3px rgba(16,185,129,0.15);}
        .wfsms-hint{font-size:11.5px;color:var(--text3,#8b95a8);margin-top:8px;line-height:1.55;}
        .wfsms-btn{padding:11px 17px;border-radius:11px;font-weight:800;font-size:13.5px;cursor:pointer;border:none;transition:all .15s;font-family:inherit;}
        .wfsms-btn:disabled{opacity:.5;cursor:wait;}
        .wfsms-btn-primary{background:linear-gradient(135deg,#10b981,#d4af37);color:#0a0e1a;flex:1;min-width:140px;}
        .wfsms-btn-primary:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px);}
        .wfsms-btn-ghost{background:transparent;border:1px solid var(--border2,#1f2638);color:var(--text,#e6e7eb);}
        .wfsms-btn-ghost:hover{background:rgba(255,255,255,0.05);}
        .wfsms-btn-danger{background:transparent;border:1px solid #ef4444;color:#ef4444;}
        .wfsms-card{background:var(--bg2,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:14px;padding:14px;margin-bottom:11px;transition:all .15s;}
        .wfsms-card.staged{border-color:rgba(16,185,129,0.45);background:linear-gradient(135deg,rgba(16,185,129,0.05),var(--bg2,#0a0e1a));}
        .wfsms-card.dup{border-color:rgba(245,158,11,0.45);background:linear-gradient(135deg,rgba(245,158,11,0.05),var(--bg2,#0a0e1a));}
        .wfsms-card.skip{opacity:.5;border-style:dashed;}
        .wfsms-card.err{border-color:rgba(239,68,68,0.45);background:linear-gradient(135deg,rgba(239,68,68,0.05),var(--bg2,#0a0e1a));}
        .wfsms-r1{display:flex;justify-content:space-between;align-items:flex-start;gap:10px;}
        .wfsms-r1l{min-width:0;flex:1;}
        .wfsms-merchant{font-weight:800;font-size:14.5px;color:var(--text,#e6e7eb);}
        .wfsms-meta{font-size:11.5px;color:var(--text3,#8b95a8);margin-top:3px;line-height:1.5;}
        .wfsms-amt{font-weight:900;font-size:16px;color:#d4af37;white-space:nowrap;flex-shrink:0;}
        .wfsms-cat{display:inline-block;padding:3px 9px;border-radius:7px;background:rgba(16,185,129,0.12);color:#10b981;font-size:11px;font-weight:700;margin-right:6px;margin-top:4px;}
        .wfsms-mod{display:inline-block;padding:3px 9px;border-radius:7px;background:rgba(212,175,55,0.12);color:#d4af37;font-size:11px;font-weight:700;margin-right:6px;margin-top:4px;}
        .wfsms-conf{display:inline-block;padding:3px 9px;border-radius:7px;font-size:11px;font-weight:700;margin-top:4px;}
        .wfsms-raw{margin-top:9px;padding:9px 11px;background:rgba(0,0,0,0.3);border-radius:8px;font-family:ui-monospace,monospace;font-size:11px;color:var(--text3,#8b95a8);max-height:60px;overflow:hidden;line-height:1.45;}
        .wfsms-actions{display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;}
        .wfsms-act{padding:7px 11px;border-radius:9px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);color:var(--text,#e6e7eb);font-size:11.5px;font-weight:700;cursor:pointer;}
        .wfsms-act:hover{background:rgba(16,185,129,0.10);border-color:#10b981;}
        .wfsms-act.danger{color:#ef4444;}
        .wfsms-act.danger:hover{background:rgba(239,68,68,0.1);border-color:#ef4444;}
        .wfsms-stat{font-size:12px;color:var(--text2,#94a3b8);margin-right:auto;}
        .wfsms-stat b{color:var(--text,#e6e7eb);}
        .wfsms-progress{height:4px;background:var(--bg,#060a14);border-radius:99px;overflow:hidden;margin-top:10px;}
        .wfsms-progress > span{display:block;height:100%;background:linear-gradient(90deg,#10b981,#d4af37);transition:width .25s;}
        .wfsms-empty{text-align:center;padding:50px 20px;color:var(--text3,#8b95a8);}
        .wfsms-empty .ico{font-size:42px;margin-bottom:12px;opacity:.5;}
        .wfsms-edit{display:none;margin-top:10px;padding:11px;background:var(--bg,#060a14);border-radius:9px;border:1px solid var(--border,#1f2638);}
        .wfsms-card.editing .wfsms-edit{display:block;}
        .wfsms-edit label{display:block;font-size:11px;color:var(--text3,#8b95a8);text-transform:uppercase;letter-spacing:.5px;margin:6px 0 4px;}
        .wfsms-edit input,.wfsms-edit select{width:100%;padding:8px 10px;background:var(--bg2,#0a0e1a);border:1px solid var(--border2,#1f2638);border-radius:7px;color:var(--text,#e6e7eb);font-size:13px;font-family:inherit;box-sizing:border-box;}
        .wfsms-edit-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;}
    `;

    function _injectCss() {
        if (document.getElementById('wfsms-css')) return;
        const s = document.createElement('style');
        s.id = 'wfsms-css';
        s.textContent = MODAL_CSS;
        document.head.appendChild(s);
    }

    let _state = {
        rows: [],   // [{id, raw, brain, status: 'staged'|'skip'|'dup'|'err', edited:{...}}]
        editing: null
    };

    // Per-screenshot OCR text blocks: { blockId: "ocr text" }. Lets us remove
    // exactly the text that came from a screenshot when its × is tapped.
    // Tracks the demo-sample text so we never file the untouched sample as the
    // user's real data. Cleared the moment the user changes the textarea.
    let _sampleText = null;
    let _imgBlocks = {};
    // Invisible markers wrap each screenshot's text inside the textarea so it
    // can be surgically removed. Use control chars users will never type.
    const _BLOCK_OPEN = '\u0001wfimg\u0002';
    const _BLOCK_MID = '\u0003';
    const _BLOCK_CLOSE = '\u0004';
    const _BLOCK_OPEN_RE = '\\u0001wfimg\\u0002';
    const _BLOCK_MID_RE = '\\u0003';
    const _BLOCK_CLOSE_RE = '\\u0004';
    const _BLOCK_SEP_CLASS = '\\u0003';

    function _uid() { return 'sms_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

    function _render() {
        const list = document.getElementById('wfsmsList');
        if (!list) return;
        if (!_state.rows.length) {
            list.innerHTML = '<div class="wfsms-empty"><div class="ico">📋</div><div style="font-weight:700;color:var(--text2,#94a3b8);">Paste your bank SMSes above and tap <b style="color:#10b981;">Analyse</b>.</div><div style="font-size:12px;margin-top:8px;">Works with one SMS at a time or 50 pasted together.</div></div>';
            _renderFooter();
            return;
        }
        list.innerHTML = _state.rows.map(_renderRow).join('');
        _renderFooter();
    }

    function _renderRow(r) {
        const b = r.brain || {};
        const p = b.parsed || {};
        const m = b.resolved_merchant || {};
        const routed = b.routed || {};
        const f = routed.suggested_fields || {};
        const e = r.edited || {};
        const tb = b.time_bucket || {};

        // Use edited values if present
        const amt = e.amount != null ? e.amount : (f.amount != null ? f.amount : p.amount);
        const cur = e.currency || p.currency || 'LKR';
        const ts = e.timestamp || f.date || f.timestamp || p.timestamp || Date.now();
        const merchantName = e.merchant || m.name || 'Unknown';
        const cat = e.cat || f.cat || m.category || f.category || 'Other';
        const mod = e.module || routed.module || 'expenses';
        const confR = routed.confidence != null ? routed.confidence : 1;
        const confM = m.confidence != null ? m.confidence : 1;
        const conf = Math.min(confR, confM);

        const klass = ['wfsms-card', 'rid-' + r.id, r.status === 'staged' ? 'staged' : '', r.status === 'skip' ? 'skip' : '', r.status === 'dup' ? 'dup' : '', r.status === 'err' ? 'err' : '', _state.editing === r.id ? 'editing' : ''].filter(Boolean).join(' ');

        if (r.status === 'err' || !b.ok) {
            return '<div class="' + klass + '">' +
                '<div class="wfsms-r1"><div class="wfsms-r1l"><div class="wfsms-merchant">⚠ Could not parse</div>' +
                '<div class="wfsms-meta">' + _esc(b.error || b.reason || 'Brain returned no classification.') + '</div></div></div>' +
                '<div class="wfsms-raw">' + _esc(r.raw.slice(0, 220)) + (r.raw.length > 220 ? '…' : '') + '</div>' +
                '<div class="wfsms-actions"><button class="wfsms-act danger" data-act="remove" data-rid="' + r.id + '">✕ Discard</button></div>' +
                '</div>';
        }

        const dupBadge = r.status === 'dup' ? '<div style="background:rgba(245,158,11,0.15);border:1px solid rgba(245,158,11,0.4);color:#f59e0b;font-size:11.5px;padding:7px 10px;border-radius:8px;margin-bottom:10px;font-weight:700;">⚠ Duplicate detected — already in your records on ' + _dateLabel(r.dupOf && (r.dupOf.date_ms || r.dupOf.date)) + '</div>' : '';

        const editForm = '<div class="wfsms-edit">' +
            '<label>Merchant</label><input type="text" data-edit="merchant" data-rid="' + r.id + '" value="' + _esc(merchantName) + '">' +
            '<div class="wfsms-edit-row">' +
                '<div><label>Amount</label><input type="number" step="0.01" data-edit="amount" data-rid="' + r.id + '" value="' + amt + '"></div>' +
                '<div><label>Date</label><input type="date" data-edit="date" data-rid="' + r.id + '" value="' + new Date(ts).toISOString().slice(0, 10) + '"></div>' +
            '</div>' +
            '<div class="wfsms-edit-row">' +
                '<div><label>Category</label><input type="text" data-edit="cat" data-rid="' + r.id + '" value="' + _esc(cat) + '"></div>' +
                '<div><label>File into</label><select data-edit="module" data-rid="' + r.id + '">' +
                    ['expenses','income','subscriptions','cconetime','ccinstall','loan','goal'].map(k =>
                        '<option value="' + k + '"' + (k === mod ? ' selected' : '') + '>' + _moduleLabel(k) + '</option>'
                    ).join('') + '</select></div>' +
            '</div>' +
            '<button class="wfsms-act" data-act="endedit" data-rid="' + r.id + '" style="margin-top:10px;">✓ Done editing</button>' +
            '</div>';

        return '<div class="' + klass + '">' +
            dupBadge +
            '<div class="wfsms-r1">' +
                '<div class="wfsms-r1l">' +
                    '<div class="wfsms-merchant">' + _esc(merchantName) + '</div>' +
                    '<div class="wfsms-meta">' + _esc(_dateLabel(ts)) + '  •  files into ' + _esc(_monthLabel(ts)) + (p.card_last4 ? '  •  card ••••' + _esc(p.card_last4) : '') + '</div>' +
                '</div>' +
                '<div class="wfsms-amt">' + _money(amt, cur) + '</div>' +
            '</div>' +
            '<div style="margin-top:7px;">' +
                '<span class="wfsms-cat">📂 ' + _esc(cat) + '</span>' +
                '<span class="wfsms-mod">' + _esc(_moduleLabel(mod)) + '</span>' +
                '<span class="wfsms-conf" style="background:' + _confColor(conf) + '22;color:' + _confColor(conf) + ';">' + _confLabel(conf) + '</span>' +
            '</div>' +
            '<div class="wfsms-raw">' + _esc(r.raw.slice(0, 220)) + (r.raw.length > 220 ? '…' : '') + '</div>' +
            '<div class="wfsms-actions">' +
                (r.status === 'skip' ?
                    '<button class="wfsms-act" data-act="include" data-rid="' + r.id + '">↻ Include</button>' :
                    '<button class="wfsms-act" data-act="skip" data-rid="' + r.id + '">✕ Skip</button>') +
                '<button class="wfsms-act" data-act="edit" data-rid="' + r.id + '">✏ Edit</button>' +
                '<button class="wfsms-act danger" data-act="remove" data-rid="' + r.id + '">🗑 Remove</button>' +
            '</div>' +
            editForm +
            '</div>';
    }

    function _renderFooter() {
        const foot = document.getElementById('wfsmsFoot');
        if (!foot) return;
        const total = _state.rows.length;
        if (!total) { foot.innerHTML = ''; return; }
        const staged = _state.rows.filter(r => r.status === 'staged').length;
        const dup = _state.rows.filter(r => r.status === 'dup').length;
        const skip = _state.rows.filter(r => r.status === 'skip').length;
        const err = _state.rows.filter(r => r.status === 'err').length;

        foot.innerHTML = '<div class="wfsms-stat">' +
            '<b>' + staged + '</b> ready · ' +
            (dup ? '<b style="color:#f59e0b;">' + dup + '</b> duplicate · ' : '') +
            (err ? '<b style="color:#ef4444;">' + err + '</b> error · ' : '') +
            (skip ? '<b>' + skip + '</b> skipped' : '') +
            '</div>' +
            '<button class="wfsms-btn wfsms-btn-ghost" data-act="clearAll">Clear all</button>' +
            '<button class="wfsms-btn wfsms-btn-primary" data-act="fileAll"' + (staged === 0 ? ' disabled' : '') + '>✓ File ' + staged + ' transaction' + (staged === 1 ? '' : 's') + '</button>';
    }

    // Duplicate check (uses the allocator's fuzzy matcher when available)
    function _markDuplicates() {
        if (typeof window.wfFindDuplicate !== 'function') return;
        for (const r of _state.rows) {
            if (r.status === 'skip' || r.status === 'err') continue;
            if (!r.brain || !r.brain.ok) continue;
            const dup = window.wfFindDuplicate(r.brain);
            if (dup && dup.dup) {
                r.status = 'dup';
                r.dupOf = dup.dup;
            } else if (r.status === 'dup') {
                r.status = 'staged';
                r.dupOf = null;
            }
        }
    }

    // ⚡ Fire-and-forget: hand the whole paste to the background queue engine
    // and close the modal immediately. The AI files everything it's sure about
    // and parks anything ambiguous in the review queue for later.
    // Returns true (and warns) if the textarea still holds the untouched demo
    // sample — so neither Auto-file nor Review-first can save the example.
    function _isUntouchedSample() {
        const ta = document.getElementById('wfsmsInput');
        if (!ta || !_sampleText) return false;
        if (_visibleInput().trim() === _sampleText.trim()) {
            _notify('That\'s just the demo sample — type or paste your own bank SMS to file it for real.', 'warn');
            return true;
        }
        return false;
    }

    async function _runAutoFile() {
        if (_isUntouchedSample()) return;
        const ta = document.getElementById('wfsmsInput');
        if (!ta) return;
        const text = _visibleInput().trim();
        if (!text) { _notify('Paste at least one bank SMS first.', 'warn'); return; }
        if (!window.wfQueue || typeof window.wfQueue.enqueueSms !== 'function') {
            // queue engine not present — fall back to the review-first flow
            _notify('Background engine loading — using review mode.', 'info');
            return _runAnalyse();
        }
        const n = await window.wfQueue.enqueueSms(text, 'paste');
        _notify(n > 0
            ? '⚡ Handed ' + n + ' transaction' + (n === 1 ? '' : 's') + ' to the AI — you can close this or keep working.'
            : 'Nothing to process — check your paste.', n > 0 ? 'success' : 'warn');
        if (n > 0) closeModal();
    }

    async function _runAnalyse() {
        if (_isUntouchedSample()) return;
        const ta = document.getElementById('wfsmsInput');
        if (!ta) return;
        const text = _visibleInput().trim();
        if (!text) { _notify('Paste at least one bank SMS first.', 'warn'); return; }

        const analyseBtn = document.getElementById('wfsmsAnalyseBtn');
        const prog = document.getElementById('wfsmsProg');
        if (analyseBtn) { analyseBtn.disabled = true; analyseBtn.textContent = '⟳ Analysing…'; }
        if (prog) prog.style.display = '';

        try {
            const results = await classifyBatch(text, (done, total) => {
                const bar = document.getElementById('wfsmsProgBar');
                if (bar) bar.style.width = (done / total * 100) + '%';
                if (analyseBtn) analyseBtn.textContent = '⟳ Analysing ' + done + '/' + total + '…';
            });

            // Apply self-learning memory: if the user has confirmed this
            // merchant before, the preview shows the learned category/tab and
            // a near-certain confidence — no need to ask again.
            if (window.wfMemory && typeof window.wfMemory.applyToBrain === 'function') {
                for (const x of results) {
                    if (x && x.brain && x.brain.ok) {
                        try { x.brain = await window.wfMemory.applyToBrain(x.brain); } catch (_) {}
                    }
                }
            }

            // Build state rows
            _state.rows = results.map(x => ({
                id: _uid(),
                raw: x.raw,
                brain: x.brain,
                status: (x.brain && x.brain.ok && x.brain.classified) ? 'staged' : 'err',
                edited: null,
                dupOf: null
            }));

            _markDuplicates();
            _render();

            const ok = _state.rows.filter(r => r.status === 'staged').length;
            const dup = _state.rows.filter(r => r.status === 'dup').length;
            const err = _state.rows.filter(r => r.status === 'err').length;
            _notify('Analysed ' + results.length + ' message' + (results.length === 1 ? '' : 's') + ' · ' + ok + ' ready' + (dup ? ' · ' + dup + ' duplicate' : '') + (err ? ' · ' + err + ' unparseable' : ''), 'success');

            // Switch to the preview tab
            _switchTab('preview');
        } catch (e) {
            _notify('Analysis failed: ' + (e && e.message), 'error');
        } finally {
            if (analyseBtn) { analyseBtn.disabled = false; analyseBtn.textContent = '🧠 Analyse'; }
            if (prog) prog.style.display = 'none';
        }
    }

    async function _runFileAll() {
        const staged = _state.rows.filter(r => r.status === 'staged');
        if (!staged.length) { _notify('No transactions staged to file.', 'warn'); return; }
        if (typeof window.wfAllocate !== 'function' && typeof window.wfApplyBrainResult !== 'function') {
            _notify('Allocator not loaded. Reload the app and try again.', 'error');
            return;
        }
        const btn = document.querySelector('[data-act="fileAll"]');
        if (btn) { btn.disabled = true; btn.textContent = '⟳ Filing…'; }
        let ok = 0, fail = 0, quarantined = 0;
        for (const r of staged) {
            try {
                // Apply edits to the brain result
                const brainPatched = JSON.parse(JSON.stringify(r.brain));
                if (r.edited) {
                    const f = brainPatched.routed.suggested_fields || {};
                    if (r.edited.merchant) {
                        if ('desc' in f) f.desc = r.edited.merchant;
                        if ('name' in f) f.name = r.edited.merchant;
                        if ('source' in f) f.source = r.edited.merchant;
                        brainPatched.resolved_merchant.name = r.edited.merchant;
                    }
                    if (r.edited.amount != null) f.amount = Number(r.edited.amount);
                    if (r.edited.cat) { f.cat = r.edited.cat; f.category = r.edited.cat; }
                    if (r.edited.date) {
                        const ms = new Date(r.edited.date + 'T12:00:00').getTime();
                        f.date = ms; f.date_ms = ms; f.timestamp = ms;
                    }
                    if (r.edited.module) brainPatched.routed.module = r.edited.module;
                }
                const result = (typeof window.wfAllocate === 'function')
                    ? await window.wfAllocate(brainPatched)
                    : await window.wfApplyBrainResult(brainPatched);
                if (result && result.ok) {
                    if (result.module === 'quarantine' || result.module === 'review') quarantined++;
                    else ok++;
                    // Teach the self-learning memory. An edited row is an
                    // authoritative user signal; an untouched row is a softer
                    // confirmation. Either way the merchant→category is learned.
                    try {
                        if (window.wfMemory && result.module && result.module !== 'quarantine' && result.module !== 'review') {
                            const mname = (r.edited && r.edited.merchant) || (brainPatched.resolved_merchant && brainPatched.resolved_merchant.name);
                            const mcat = (r.edited && r.edited.cat) || (brainPatched.routed.suggested_fields && brainPatched.routed.suggested_fields.cat) || (brainPatched.resolved_merchant && brainPatched.resolved_merchant.category);
                            await window.wfMemory.learn(mname, {
                                category: mcat, module: result.module,
                                source: r.edited ? 'user' : 'confirm',
                                cardLast4: (brainPatched.parsed && brainPatched.parsed.card_last4) || null
                            });
                        }
                    } catch (_) {}
                    // Remove from list
                    _state.rows = _state.rows.filter(x => x.id !== r.id);
                } else {
                    r.status = 'err';
                    r.brain.error = (result && result.reason) || 'allocation failed';
                    fail++;
                }
            } catch (e) {
                fail++;
                r.status = 'err';
                r.brain.error = e && e.message;
            }
        }
        _render();

        // Refresh UI tabs
        ['renderDash','renderExpenses','renderIncome','renderSubscriptions','renderCCOneTime','renderCCInstall','renderLoans','renderTargets'].forEach(fn => {
            try { if (typeof window[fn] === 'function') window[fn](); } catch (_) {}
        });

        const msg = '✓ Filed ' + ok + (quarantined ? ' · ' + quarantined + ' to review' : '') + (fail ? ' · ' + fail + ' failed' : '');
        _notify(msg, ok > 0 ? 'success' : 'warn');

        if (ok > 0 && fail === 0 && _state.rows.length === 0) {
            // Auto-close after a moment
            setTimeout(() => closeModal(), 1200);
        }
    }

    function _switchTab(name) {
        document.querySelectorAll('.wfsms-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
        document.getElementById('wfsmsPaneInput').style.display = name === 'input' ? '' : 'none';
        document.getElementById('wfsmsPanePreview').style.display = name === 'preview' ? '' : 'none';
    }

    function _onClick(e) {
        // image thumbnail remove (×) — handled before the [data-act] gate
        const rmBtn = e.target.closest('[data-rmblock]');
        if (rmBtn) {
            e.preventDefault(); e.stopPropagation();
            _removeImageBlock(rmBtn.getAttribute('data-rmblock'));
            return;
        }
        const t = e.target.closest('[data-act]');
        if (!t) return;
        const act = t.dataset.act;
        const rid = t.dataset.rid;
        if (act === 'analyse') return _runAnalyse();
        if (act === 'autoFile') return _runAutoFile();
        if (act === 'fileAll') return _runFileAll();
        if (act === 'clearAll') { _state.rows = []; _state.editing = null; _render(); return; }
        if (act === 'clearInput') { const ta = document.getElementById('wfsmsInput'); if (ta) ta.value = ''; _imgBlocks = {}; const th = document.getElementById('wfsmsThumbs'); if (th) th.innerHTML = ''; return; }
        if (act === 'pasteSample') {
            const ta = document.getElementById('wfsmsInput');
            // Generic demo SMS — NOT real user data. Fake card tail, generic
            // Colombo merchant and date so nobody's real details appear.
            const SAMPLE = "Your A/C No: ********1234 is debited with LKR1,250.00 on 15 JUN 2026 ref: KEELLS SUPER-COLOMBO 03. Your bal is LKR85,400.00. If unauthorized call 0112000000";
            if (ta) { ta.value = SAMPLE; ta.focus(); }
            _sampleText = SAMPLE;   // remember it so we can refuse to file the untouched sample
            _notify('This is a demo SMS so you can see how it works. It won\'t be saved. Type or paste your own to file for real.', 'info');
            return;
        }
        if (!rid) return;
        const row = _state.rows.find(r => r.id === rid);
        if (!row) return;
        if (act === 'skip') { row.status = 'skip'; _render(); return; }
        if (act === 'include') { row.status = 'staged'; _markDuplicates(); _render(); return; }
        if (act === 'remove') { _state.rows = _state.rows.filter(r => r.id !== rid); _render(); return; }
        if (act === 'edit') {
            _state.editing = (_state.editing === rid) ? null : rid;
            if (!row.edited) row.edited = {};
            _render();
            return;
        }
        if (act === 'endedit') { _state.editing = null; _render(); return; }
    }

    function _onInput(e) {
        // If the user edits the main paste box, it's no longer the demo sample.
        if (e.target && e.target.id === 'wfsmsInput') {
            if (_sampleText && _visibleInput().trim() !== _sampleText.trim()) _sampleText = null;
        }
        const t = e.target.closest('[data-edit]');
        if (!t) return;
        const rid = t.dataset.rid;
        const field = t.dataset.edit;
        const row = _state.rows.find(r => r.id === rid);
        if (!row) return;
        if (!row.edited) row.edited = {};
        if (field === 'amount') row.edited.amount = parseFloat(t.value) || 0;
        else if (field === 'date') row.edited.timestamp = new Date(t.value + 'T12:00:00').getTime();
        else row.edited[field] = t.value;
    }

    function _onTabClick(e) {
        const t = e.target.closest('.wfsms-tab');
        if (!t) return;
        _switchTab(t.dataset.tab);
    }

    function openModal() {
        _injectCss();
        // Warm up the OCR engine in the background so attaching is instant.
        try { if (window.wfVisionSms && window.wfVisionSms.ready) window.wfVisionSms.ready(); } catch (_) {}
        // Re-open clean
        _state = { rows: [], editing: null };
        const ov = document.createElement('div');
        ov.className = 'wfsms-overlay';
        ov.id = 'wfsmsOverlay';
        ov.innerHTML = '<div class="wfsms-modal">' +
            '<div class="wfsms-head">' +
                '<div class="wfsms-title">Paste Bank SMS</div>' +
                '<button class="wfsms-close" data-act="close" aria-label="Close">×</button>' +
            '</div>' +
            '<div class="wfsms-body">' +
                '<div class="wfsms-tabs">' +
                    '<button class="wfsms-tab active" data-tab="input">1. Paste</button>' +
                    '<button class="wfsms-tab" data-tab="preview">2. Preview &amp; File</button>' +
                '</div>' +
                '<div id="wfsmsPaneInput">' +
                    '<textarea id="wfsmsInput" class="wfsms-ta" placeholder="Copy your bank SMS from your phone and paste here — OR tap &#39;Attach screenshots&#39; below to let the AI read them.&#10;&#10;Examples that work:&#10;&#10;• One SMS at a time&#10;• Multiple SMSes pasted together&#10;• Screenshots of your bank-SMS thread (one or many)&#10;• Any bank: Commercial, HNB, Sampath, NTB, Seylan, DFCC, AMEX, HSBC + 25 international banks"></textarea>' +
                    '<div id="wfsmsDrop" style="margin-top:10px;border:1.5px dashed var(--border2,#1f2638);border-radius:12px;padding:14px;text-align:center;cursor:pointer;transition:all .15s;">' +
                        '<div style="font-size:22px;margin-bottom:4px;">🖼️</div>' +
                        '<div style="font-weight:700;font-size:13px;color:var(--text,#e6e7eb);">Attach screenshots</div>' +
                        '<div style="font-size:11.5px;color:var(--text3,#8b95a8);margin-top:3px;">Tap to pick one or many images — the AI reads the SMS text for you. You can also drag &amp; drop, or paste an image.</div>' +
                        '<input id="wfsmsFileInput" type="file" accept="image/*" multiple style="display:none;">' +
                    '</div>' +
                    '<div id="wfsmsThumbs" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:10px;"></div>' +
                    '<div class="wfsms-hint">' +
                        '🎯 The AI knows 250+ merchants (Cargills, Keells, KOKO, Dialog, Netflix, Apple, AWS, etc.) and routes each transaction to the right tab + month + year.<br>' +
                        '🧠 It learns: confirm a shop once and it remembers the category forever.<br>' +
                        '🔁 Many SMSes (pasted or in a screenshot)? They\'re auto-split and processed in parallel.<br>' +
                        '🛡 Duplicates are detected automatically — even across screenshots & re-pastes.' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">' +
                        '<button id="wfsmsAutoBtn" class="wfsms-btn wfsms-btn-primary" data-act="autoFile" style="background:linear-gradient(135deg,#10b981,#0ea371);">⚡ Auto-file (walk away)</button>' +
                        '<button id="wfsmsAnalyseBtn" class="wfsms-btn wfsms-btn-ghost" data-act="analyse">🧠 Review first</button>' +
                    '</div>' +
                    '<div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">' +
                        '<button class="wfsms-btn wfsms-btn-ghost" data-act="clearInput">Clear</button>' +
                        '<button class="wfsms-btn wfsms-btn-ghost" data-act="pasteSample">📋 Try a sample</button>' +
                    '</div>' +
                    '<div class="wfsms-hint" style="margin-top:10px;">' +
                        '⚡ <b>Auto-file</b> hands everything to the background AI and closes this window instantly — keep using the app or close it, the AI keeps working and only asks you about anything it\'s unsure of (later is fine).' +
                    '</div>' +
                    '<div id="wfsmsProg" class="wfsms-progress" style="display:none;"><span id="wfsmsProgBar" style="width:0%;"></span></div>' +
                '</div>' +
                '<div id="wfsmsPanePreview" style="display:none;">' +
                    '<div id="wfsmsList"></div>' +
                '</div>' +
            '</div>' +
            '<div class="wfsms-foot" id="wfsmsFoot"></div>' +
            '</div>';

        ov.addEventListener('click', (e) => {
            if (e.target === ov) closeModal();
            else if (e.target.closest('[data-act="close"]')) closeModal();
            else if (e.target.closest('.wfsms-tab')) _onTabClick(e);
            else if (e.target.closest('#wfsmsDrop')) { const fi = document.getElementById('wfsmsFileInput'); if (fi) fi.click(); }
            else _onClick(e);
        });
        ov.addEventListener('input', _onInput);
        // Use change for edit-field selects, but ignore the file input (handled below)
        ov.addEventListener('change', (e) => { if (e.target && e.target.id === 'wfsmsFileInput') return; _onInput(e); });

        document.body.appendChild(ov);

        // ── image attach wiring ──
        const fileInput = document.getElementById('wfsmsFileInput');
        if (fileInput) {
            fileInput.addEventListener('change', (e) => {
                const files = e.target.files;
                if (files && files.length) _handleImages(files);
                e.target.value = ''; // allow re-selecting the same file
            });
        }
        const drop = document.getElementById('wfsmsDrop');
        if (drop) {
            ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.style.borderColor = '#10b981'; drop.style.background = 'rgba(16,185,129,0.06)'; }));
            ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, (e) => { e.preventDefault(); e.stopPropagation(); drop.style.borderColor = ''; drop.style.background = ''; }));
            drop.addEventListener('drop', (e) => {
                const files = e.dataTransfer && e.dataTransfer.files;
                if (files && files.length) _handleImages(Array.from(files).filter(f => /^image\//.test(f.type)));
            });
        }
        // paste-an-image directly into the textarea
        const ta = document.getElementById('wfsmsInput');
        if (ta) {
            ta.addEventListener('paste', (e) => {
                const items = e.clipboardData && e.clipboardData.items;
                if (!items) return;
                const imgs = [];
                for (const it of items) if (it.type && it.type.indexOf('image') === 0) { const f = it.getAsFile(); if (f) imgs.push(f); }
                if (imgs.length) { e.preventDefault(); _handleImages(imgs); }
            });
        }

        // Focus textarea
        setTimeout(() => { const t = document.getElementById('wfsmsInput'); if (t) t.focus(); }, 80);
        _render();
    }

    // OCR attached screenshots → append extracted text into the textarea, then
    // the user can tap Auto-file / Review exactly as with pasted text.
    async function _handleImages(files) {
        const arr = Array.from(files || []).filter(f => f && /^image\//.test(f.type || ''));
        if (!arr.length) { _notify('Those didn\'t look like images.', 'warn'); return; }
        if (!window.wfVisionSms || typeof window.wfVisionSms.readImages !== 'function') {
            _notify('Image reader still loading — try again in a moment.', 'info');
            return;
        }
        const thumbs = document.getElementById('wfsmsThumbs');
        const drop = document.getElementById('wfsmsDrop');
        const prog = document.getElementById('wfsmsProg');
        const bar = document.getElementById('wfsmsProgBar');

        if (drop) { drop.style.pointerEvents = 'none'; drop.style.opacity = '0.6'; }
        if (prog) prog.style.display = '';

        // Process each image individually so each thumbnail owns its own OCR
        // text block — that way the × button can remove exactly that block.
        for (let idx = 0; idx < arr.length; idx++) {
            const f = arr[idx];
            const blockId = 'img_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 6);
            let url = '';
            try { url = URL.createObjectURL(f); } catch (_) {}

            // build the thumbnail with a remove (×) button
            let tile = null;
            if (thumbs) {
                tile = document.createElement('div');
                tile.dataset.block = blockId;
                tile.style.cssText = 'position:relative;width:54px;height:54px;border-radius:9px;overflow:hidden;border:1px solid var(--border2,#1f2638);';
                tile.innerHTML =
                    '<img src="' + url + '" style="width:100%;height:100%;object-fit:cover;">' +
                    '<div class="wfsms-thumb-spin" style="position:absolute;inset:0;background:rgba(0,0,0,0.55);display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;">⟳</div>' +
                    '<button type="button" class="wfsms-thumb-x" data-rmblock="' + blockId + '" ' +
                    'style="position:absolute;top:1px;right:1px;width:18px;height:18px;border:none;border-radius:50%;background:rgba(0,0,0,0.7);color:#fff;font-size:13px;line-height:1;cursor:pointer;display:flex;align-items:center;justify-content:center;padding:0;z-index:2;">×</button>';
                thumbs.appendChild(tile);
            }

            try {
                const text = await window.wfVisionSms.readImages([f], (p) => {
                    if (bar && p) {
                        const overall = (((idx) + (p.progress || 0)) / arr.length) * 100;
                        bar.style.width = Math.min(99, overall) + '%';
                    }
                });
                const clean = (text || '').trim();
                // mark this tile done
                if (tile) { const sp = tile.querySelector('.wfsms-thumb-spin'); if (sp) { sp.textContent = '✓'; sp.style.background = 'rgba(16,185,129,0.5)'; } }

                if (!clean || clean.replace(/\s/g, '').length < 8) {
                    if (tile) { const sp = tile.querySelector('.wfsms-thumb-spin'); if (sp) { sp.textContent = '⚠'; sp.style.background = 'rgba(239,68,68,0.5)'; } }
                    _notify('Couldn\'t read text from one screenshot. Try a clearer image.', 'warn');
                } else {
                    // record the block + append a tagged segment to the textarea
                    _imgBlocks[blockId] = clean;
                    _appendImageBlock(blockId, clean);
                    const n = (typeof window.wfSplitSmsBatch === 'function') ? window.wfSplitSmsBatch(clean).length : 1;
                    _notify('📖 Read screenshot → found ' + n + ' transaction' + (n === 1 ? '' : 's') + '.', 'success');
                }
            } catch (e) {
                if (tile) { const sp = tile.querySelector('.wfsms-thumb-spin'); if (sp) { sp.textContent = '⚠'; sp.style.background = 'rgba(239,68,68,0.5)'; } }
                _notify('Image reading failed: ' + (e && e.message), 'error');
            }
        }

        if (drop) { drop.style.pointerEvents = ''; drop.style.opacity = ''; }
        if (prog) prog.style.display = 'none';
        if (bar) bar.style.width = '0%';
    }

    // Textarea is segmented by hidden block markers so we can surgically remove
    // the text that came from a specific screenshot when its × is tapped.
    function _appendImageBlock(blockId, text) {
        const ta = document.getElementById('wfsmsInput');
        if (!ta) return;
        const marker = '\n' + _BLOCK_OPEN + blockId + _BLOCK_MID + text + _BLOCK_CLOSE;
        ta.value = (ta.value || '') + marker;
    }

    // Build the user-visible textarea value (markers stripped) for analysis.
    function _visibleInput() {
        const ta = document.getElementById('wfsmsInput');
        if (!ta) return '';
        return _stripBlockMarkers(ta.value || '');
    }
    function _stripBlockMarkers(s) {
        // remove the marker wrappers but keep the inner text
        return String(s || '')
            .replace(new RegExp(_BLOCK_OPEN_RE + '[^' + _BLOCK_SEP_CLASS + ']*' + _BLOCK_MID_RE, 'g'), '')
            .replace(new RegExp(_BLOCK_CLOSE_RE, 'g'), '')
            .replace(/\u0000/g, '');
    }
    function _removeImageBlock(blockId) {
        const ta = document.getElementById('wfsmsInput');
        if (ta && _imgBlocks[blockId] != null) {
            // remove the whole marked segment for this block
            const seg = _BLOCK_OPEN + blockId + _BLOCK_MID + _imgBlocks[blockId] + _BLOCK_CLOSE;
            let v = ta.value || '';
            const i = v.indexOf(seg);
            if (i >= 0) v = v.slice(0, i) + v.slice(i + seg.length);
            else {
                // fallback: regex remove by id if exact text drifted
                v = v.replace(new RegExp(_BLOCK_OPEN_RE + blockId + '[\\s\\S]*?' + _BLOCK_CLOSE_RE), '');
            }
            ta.value = v.replace(/\n{3,}/g, '\n\n').trim();
        }
        delete _imgBlocks[blockId];
        const tile = document.querySelector('#wfsmsThumbs [data-block="' + blockId + '"]');
        if (tile) tile.remove();
    }

    function closeModal() {
        const ov = document.getElementById('wfsmsOverlay');
        if (ov) ov.remove();
        _state = { rows: [], editing: null };
    }

    window.wfOpenSmsPaste = openModal;

    // ─────────────────── Settings/Dashboard auto-inject ──────────────────────
    function _autoInject() {
        // Inject a "Paste SMS" button into the Settings → AI Intelligence
        // section (via the existing wfEmailSyncMount slot if present, OR a
        // fallback to settingsAI / settingsContent).
        const mountIds = ['wfSmsPasteMount', 'wfEmailSyncMount', 'settingsAI', 'page-settings', 'settings-page', 'settingsContent'];
        for (const id of mountIds) {
            const host = document.getElementById(id);
            if (!host) continue;
            if (document.getElementById('wfSmsPasteBanner')) break;
            const wrap = document.createElement('div');
            wrap.id = 'wfSmsPasteBanner';
            wrap.style.cssText = 'margin:14px 0;';
            wrap.innerHTML =
                '<div style="display:flex;align-items:center;gap:10px;padding:14px;background:linear-gradient(135deg,rgba(16,185,129,0.08),rgba(212,175,55,0.04),var(--card,#1a1f2e));border:1px solid rgba(16,185,129,0.45);border-radius:14px;">' +
                  '<div style="font-size:24px;">📲</div>' +
                  '<div style="flex:1;min-width:0;">' +
                    '<div style="font-weight:800;font-size:14px;">Paste Bank SMS</div>' +
                    '<div style="font-size:12px;color:var(--text2,#94a3b8);margin-top:2px;line-height:1.5;">Copy any bank SMS from your phone, paste here, AI files it to the right tab + month + year. Works for any bank.</div>' +
                  '</div>' +
                  '<button onclick="wfOpenSmsPaste()" style="background:linear-gradient(135deg,#10b981,#d4af37);color:#0a0e1a;border:none;border-radius:10px;padding:9px 14px;font-weight:800;font-size:13px;cursor:pointer;flex-shrink:0;">Open</button>' +
                '</div>';
            host.insertBefore(wrap, host.firstChild);
            break;
        }
    }

    if (typeof document !== 'undefined') {
        document.addEventListener('DOMContentLoaded', () => {
            setTimeout(_autoInject, 2200);
            // Re-inject on navigation
            window.addEventListener('hashchange', () => setTimeout(_autoInject, 150));
        });
    }

    console.log('[SMS Paste] ✓ WealthFlow SMS Paste v1.0 loaded — call wfOpenSmsPaste() to open');
})();
