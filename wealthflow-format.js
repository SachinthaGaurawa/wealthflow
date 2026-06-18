/*  wealthflow-format.js — shared AI markdown → HTML renderer  (v7.23)
 *  ===========================================================================
 *  Every place the app shows AI text must render markdown the SAME way. Before
 *  this module, the chat had its own inline formatter (so **bold** worked there)
 *  but the CRIB analysis/advice and several other AI panels printed the raw text
 *  — so users saw literal "**...**", "##", "*" etc. (see the Sinhala CRIB advice
 *  screenshot). This module gives ONE safe renderer used everywhere.
 *
 *  It is XSS-safe: the input is HTML-escaped FIRST, then a small, well-scoped set
 *  of markdown transforms is applied to the escaped text. Works for any language
 *  (Sinhala, Tamil, Arabic/RTL, etc.) because it only keys off markdown symbols
 *  and digits, never word characters.
 *
 *  Reuses the app's existing AI CSS classes (.ai-bullet, .ai-numbered, .ai-num,
 *  .ai-money, .ai-section-header, .ai-callout, .ai-spacer, .ai-table, .ai-code-
 *  block) so CRIB output looks identical to the chat.
 *
 *  Public API (window.WFFmt):
 *    render(text, opts?) → safe HTML string   (opts.money=true highlights money)
 *    escape(text)        → HTML-escaped string
 *    strip(text)         → plain text with markdown removed
 *  ===========================================================================*/
(function () {
    'use strict';
    if (window.WFFmt && window.WFFmt.__v && window.WFFmt.__v >= 723) return;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    // Safe URL test — only http/https/mailto become links.
    function _safeUrl(u) {
        return /^(https?:\/\/|mailto:)/i.test(String(u || '').trim());
    }

    function render(text, opts) {
        opts = opts || {};
        if (text == null) return '';
        var f = esc(String(text));

        // ── fenced code blocks first (``` ... ```), protect their content ──────
        var codeStore = [];
        f = f.replace(/```([\s\S]*?)```/g, function (_m, body) {
            codeStore.push(body);
            return '\u0000CODE' + (codeStore.length - 1) + '\u0000';
        });

        // ── markdown tables  | a | b |  /  | --- | --- | ─────────────────────────
        f = f.replace(/((?:^|\n)[ \t]*\|.*\|[ \t]*(?:\n[ \t]*\|.*\|[ \t]*)+)/g, function (match) {
            var rows = match.split('\n').map(function (r) { return r.trim(); })
                .filter(function (r) { return r.indexOf('|') === 0 && r.length > 1; });
            if (rows.length < 2) return match;
            var isSep = function (r) { return /^\|?[\s:|\-]+\|?$/.test(r) && /-{2,}/.test(r); };
            var html = '<table class="ai-table">';
            var headerDone = false;
            rows.forEach(function (row) {
                if (isSep(row)) { headerDone = true; return; }
                var cells = row.split('|');
                if (cells[0].trim() === '') cells.shift();
                if (cells.length && cells[cells.length - 1].trim() === '') cells.pop();
                var isHeader = !headerDone && html.indexOf('<tr>') === -1;
                var tag = isHeader ? 'th' : 'td';
                html += '<tr>' + cells.map(function (c) { return '<' + tag + '>' + c.trim() + '</' + tag + '>'; }).join('') + '</tr>';
            });
            return '\n' + html + '</table>\n';
        });

        // ── headings (#, ##, ###) at line start ────────────────────────────────
        f = f.replace(/(^|\n)#{1,6}\s+(.+)/g, '$1<div class="ai-section-header">$2</div>');

        // ── bold **x** / __x__  (before italic) ────────────────────────────────
        f = f.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
        f = f.replace(/__([^_]+?)__/g, '<strong>$1</strong>');

        // ── italic *x* / _x_  (avoid touching ** already consumed) ──────────────
        f = f.replace(/(^|[\s(])\*([^\s*][^*]*?[^\s*]|\S)\*(?=[\s).,!?:;]|$)/gm, '$1<em>$2</em>');
        f = f.replace(/(^|[\s(])_([^\s_][^_]*?[^\s_]|\S)_(?=[\s).,!?:;]|$)/gm, '$1<em>$2</em>');

        // ── inline code `x` ─────────────────────────────────────────────────────
        f = f.replace(/`([^`]+?)`/g, '<code class="ai-inline-code">$1</code>');

        // ── links [text](url) — only safe schemes ───────────────────────────────
        f = f.replace(/\[([^\]]+)\]\((&#39;|&quot;)?([^)\s]+?)\2?\)/g, function (m, label, _q, url) {
            var clean = url.replace(/&amp;/g, '&');
            if (!_safeUrl(clean)) return label;
            return '<a href="' + esc(clean) + '" target="_blank" rel="noopener noreferrer" style="color:var(--accent,#f5a623);text-decoration:none;font-weight:600;">' + label + '</a>';
        });

        // ── callouts (warning / success / info) ─────────────────────────────────
        f = f.replace(/(^|\n)(?:⚠️|⚠)\s*(.+)/g, '$1<div class="ai-callout warning"><span class="ai-callout-icon">⚠️</span><span>$2</span></div>');
        f = f.replace(/(^|\n)✅\s*(.+)/g, '$1<div class="ai-callout success"><span class="ai-callout-icon">✅</span><span>$2</span></div>');
        f = f.replace(/(^|\n)💡\s*(.+)/g, '$1<div class="ai-callout info"><span class="ai-callout-icon">💡</span><span>$2</span></div>');

        // ── bullets (-, •, *) at line start ─────────────────────────────────────
        f = f.replace(/(^|\n)[ \t]*[\-•]\s+(.+)/g, '$1<div class="ai-bullet">$2</div>');

        // ── numbered list with badge ────────────────────────────────────────────
        f = f.replace(/(^|\n)[ \t]*(\d{1,2})[.)]\s+(.+)/g, '$1<div class="ai-numbered"><span class="ai-num">$2</span> <span>$3</span></div>');

        // ── money highlight (optional) ──────────────────────────────────────────
        if (opts.money !== false) {
            f = f.replace(/((?:LKR|USD|EUR|GBP|INR|AUD|CAD|JPY|CNY|SGD|AED|SAR|Rs\.?|රු)\s?[\d,]+(?:\.\d+)?)/g, '<span class="ai-money">$1</span>');
        }

        // ── strip any stray leftover markdown bullets/asterisks that didn't pair ──
        f = f.replace(/(^|\n)\s*\*\s+/g, '$1• ');     // lone "* " → bullet dot
        f = f.replace(/\*{1,2}/g, '');                 // remove orphan * / **

        // ── paragraph + line spacing ────────────────────────────────────────────
        f = f.replace(/\n{2,}/g, '<div class="ai-spacer"></div>');
        f = f.replace(/\n/g, '<br>');

        // ── restore code blocks ─────────────────────────────────────────────────
        f = f.replace(/\u0000CODE(\d+)\u0000/g, function (_m, i) {
            return '<pre class="ai-code-block">' + (codeStore[+i] || '') + '</pre>';
        });

        return f;
    }

    function strip(text) {
        return String(text == null ? '' : text)
            .replace(/```[\s\S]*?```/g, ' ')
            .replace(/[*_`#>]/g, '')
            .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
            .replace(/\s+/g, ' ')
            .trim();
    }

    window.WFFmt = { __v: 723, render: render, escape: esc, strip: strip };

    // tiny CSS for inline code (the app already styles the other ai-* classes)
    try {
        if (!document.getElementById('wfFmtCss')) {
            var st = document.createElement('style');
            st.id = 'wfFmtCss';
            st.textContent = '.ai-inline-code{font-family:var(--mono,monospace);font-size:.92em;background:rgba(255,255,255,.07);padding:1px 5px;border-radius:5px;}';
            (document.head || document.documentElement).appendChild(st);
        }
    } catch (_) {}

    try { console.log('[WFFmt] \u2713 shared AI markdown renderer ready'); } catch (_) {}
})();
