/* =============================================================================
 * wealthflow-crash-report.js — a crash reports itself   (window.WFCrashReport)
 * -----------------------------------------------------------------------------
 * WHY (owner, 2026-11-04 18:20Z): "crashes auto fix". The fix agent can repair a crash, but it only ever heard about
 * the ones the owner stopped to describe in the feedback form. A white screen that happens at 2 a.m. was never filed.
 *
 * WHAT IT DOES: when WealthFlow's own code throws (window error or unhandled rejection), it files ONE report through the
 * same endpoint as the feedback form (/api/feedback-triage, type "crash"). The server de-duplicates by text, so the same
 * crash is one issue; the autonomous system picks it up like any other report.
 *
 * WHAT IT SENDS: the error message and the top of its stack with numbers, e-mail addresses, quoted text and query strings
 * removed; the file and line; the build id; the page name; the browser. It never sends records, amounts, names or tokens.
 *
 * LIMITS (so it can never become noise): first-party errors only (not extensions, not cross-origin "Script error.", not a
 * network that is simply down); one report per distinct crash per 24 h; three per day; nothing at all offline; switch off
 * with localStorage "wf_crash_report_off" = "1".
 * ===========================================================================*/
(function (root) {
    'use strict';

    var KEY = 'wf_crash_report_seen', OFF = 'wf_crash_report_off';
    var PER_CRASH_MS = 24 * 3600 * 1000, PER_DAY = 3;
    var IGNORE = /ResizeObserver loop|Script error\.?$|Load failed|Failed to fetch|NetworkError|network request failed|AbortError|The operation was aborted|chrome-extension:|moz-extension:|safari-extension:|Non-Error promise rejection|QuotaExceededError/i;
    var sentThisPage = 0;

    function ls() { try { return root.localStorage; } catch (_) { return null; } }
    function read() { try { var s = ls(); return JSON.parse((s && s.getItem(KEY)) || '{}') || {}; } catch (_) { return {}; } }
    function write(o) { try { var s = ls(); if (s) s.setItem(KEY, JSON.stringify(o)); } catch (_) { /* storage full or blocked: report less, never throw */ } }

    /** Take out everything that could be a person's data; keep what a developer needs. */
    function sanitize(text, max) {
        var t = String(text == null ? '' : text);
        t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '<email>')
            .replace(/\bhttps?:\/\/[^\s)'"]+/gi, function (u) { try { var p = new URL(u); return p.pathname.split('/').pop() || p.hostname; } catch (_) { return '<url>'; } })
            .replace(/(["'`])((?:(?!\1).){0,200})\1/g, function (_, q, inner) { return /^[A-Za-z_$][\w$]{0,40}$/.test(inner) ? q + inner + q : q + '...' + q; })
            .replace(/\d[\d,.]{3,}\d|\d{4,}/g, '#')
            .replace(/\s+/g, ' ').trim();
        return t.slice(0, max || 300);
    }

    function fileOf(e) {
        var f = e && (e.filename || '');
        if (!f && e && e.error && e.error.stack) { var m = /(?:\(|@|\bat\s)([^\s()]+?):(\d+):\d+/.exec(String(e.error.stack)); f = m ? m[1] + ':' + m[2] : ''; }
        else if (f && e.lineno) f = f + ':' + e.lineno;
        return String(f).replace(/^[a-z]+:\/\/[^/]+/i, '').replace(/[?#].*?(?=:\d+$|$)/, '');
    }

    /** Is this crash in OUR code? Anything else (an extension, an ad script, a CDN) is not ours to fix. */
    function isOurs(e) {
        var f = (e && (e.filename || '')) || '';
        var stack = (e && e.error && e.error.stack) ? String(e.error.stack) : '';
        var own = root.location && root.location.origin ? root.location.origin : '';
        if (/-extension:/.test(f + stack)) return false;
        if (f) return !own || f.indexOf(own) === 0;
        return stack ? (!own || stack.indexOf(own) >= 0 || /wealthflow|index\.html|\/app/i.test(stack)) : false;
    }

    function fingerprint(msg, file) {
        var s = String(msg) + '|' + String(file), h = 5381;
        for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
        return (h >>> 0).toString(36);
    }

    function shouldReport(fp, now) {
        now = now || Date.now();
        try { var s = ls(); if (s && s.getItem(OFF) === '1') return false; } catch (_) { /* storage blocked: carry on */ }
        if (root.navigator && root.navigator.onLine === false) return false;
        var seen = read(), today = Object.keys(seen).filter(function (k) { return now - seen[k] < PER_CRASH_MS; });
        if (seen[fp] && now - seen[fp] < PER_CRASH_MS) return false;
        return today.length < PER_DAY && sentThisPage < PER_DAY;
    }

    function build() {
        try { var el = root.document && root.document.querySelector('meta[name="wf-build"]'); if (el) return el.content; } catch (_) { /* optional */ }
        return (root.WF_BUILD || root.__WF_VERSION || '') + '';
    }

    function payload(e) {
        var err = e && (e.error || e.reason);
        var rawMsg = (e && e.message) || (err && err.message) || (typeof err === 'string' ? err : '') || '';
        var msg = sanitize(rawMsg, 220), file = fileOf(e);
        var stack = sanitize(err && err.stack ? String(err.stack).split('\n').slice(0, 6).join(' | ') : '', 800);
        var page = ''; try { page = (root.location && (root.location.hash || root.location.pathname) || '').replace(/[?].*$/, '').slice(0, 60); } catch (_) { /* optional */ }
        var text = '[Auto crash report] ' + (msg || 'the app threw an error') + (file ? ' (' + file + ')' : '');
        return {
            fp: fingerprint(msg, file),
            body: {
                text: text, type: 'crash', source: 'auto-crash-report',
                diagnostics: {
                    activePage: page, ua: sanitize((root.navigator && root.navigator.userAgent) || '', 160), online: true,
                    errors: [{ msg: msg, stack: stack, page: page, ver: build() }],
                },
            },
        };
    }

    function report(e) {
        try {
            var raw = (e && e.message) || (e && e.reason && (e.reason.message || String(e.reason))) || '';
            if (IGNORE.test(String(raw))) return false;
            if (!isOurs(e || {})) return false;
            var p = payload(e);
            if (!shouldReport(p.fp)) return false;
            var seen = read(); seen[p.fp] = Date.now(); write(seen); sentThisPage++;
            if (typeof root.fetch !== 'function') return false;
            root.fetch('/api/feedback-triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.body), keepalive: true })
                .catch(function () { /* a report that cannot be sent must never cause a second crash */ });
            return true;
        } catch (_) { return false; }
    }

    function install() {
        if (!root.addEventListener || root.__wfCrashReportOn) return;
        root.__wfCrashReportOn = true;
        root.addEventListener('error', function (ev) { report(ev); });
        root.addEventListener('unhandledrejection', function (ev) {
            var r = ev && ev.reason;
            // a rejection carries no filename: its stack decides whether it is ours
            report({ message: r && r.message ? r.message : String(r || ''), error: r && typeof r === 'object' ? r : null, reason: r, filename: '' });
        });
    }

    root.WFCrashReport = { sanitize: sanitize, fingerprint: fingerprint, isOurs: isOurs, shouldReport: shouldReport, payload: payload, report: report, install: install };
    install();
})(typeof window !== 'undefined' ? window : globalThis);
