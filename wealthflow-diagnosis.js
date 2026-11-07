/* =============================================================================
 *  WealthFlow — Update-system diagnosis      ·      window.WFDiagnosis
 *
 *  "Copy diagnostics" described the device and said nothing about the chain the owner keeps asking about:
 *  does a report he files become a fix he receives? That chain has ten links and every break looked the same
 *  from the phone — nothing happened. judge() walks the links in order, names the FIRST one that is not
 *  healthy, with the evidence and the next step.
 *
 *  Honesty rules: every link is ok / warn / fail / unknown ("could not be measured" is never healthy); the
 *  verdict is computed from the links; judge() is a pure function of one evidence object, so a test can
 *  feed it the evidence of a real broken device; collect() never waits for the network (a clipboard write
 *  must stay inside its tap) while refresh() fetches ahead of time; nothing financial and no free text
 *  leaves the device — a feedback item contributes issue number, kind, status and age only.
 * ========================================================================== */
(function () {
    'use strict';
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WFDiagnosis) return;

    var K_EVIDENCE = 'wf_diag_evidence';   // the last server answers, so the first copy after a restart still has them
    var K_SEEN = 'wf_diag_seen';           // when this device first saw an offer / a waiting worker / a deploy change
    var H = 3600 * 1000;
    var MIN = 60 * 1000;
    var LIMITS = {
        unsentFeedbackMs: 15 * MIN,        // saved on the device but not filed as a work item
        idleFeedbackMs: 48 * H,            // filed, and nobody (no AI) has picked it up
        offerMs: 48 * H,                   // an update was offered and still is not installed
        claimMs: 10 * MIN,                 // "I am updating" that never settled
        waitingWorkerMs: 10 * MIN,         // a new service worker waiting to take over
        staleChangeDays: 30,               // no real change for this long
        evidenceMaxAgeMs: 6 * H            // older server evidence is reported, but flagged
    };

    /* ── small readers (every one of them survives a missing or corrupt value) ─────────────────── */
    function LS() { try { return W.localStorage; } catch (_) { return null; } }
    function read(k, d) { try { var s = LS() && LS().getItem(k); if (s === null || s === undefined || s === '') return d; return JSON.parse(s); } catch (_) { return d; } }
    function readRaw(k) { try { var s = LS() && LS().getItem(k); return (s === undefined) ? null : s; } catch (_) { return null; } }
    function write(k, v) { try { LS() && LS().setItem(k, JSON.stringify(v)); } catch (_) {} }
    function num(x) { var n = Number(x); return isFinite(n) ? n : null; }
    function ts(x) { if (typeof x === 'number') return x; var t = Date.parse(x); return isNaN(t) ? null : t; }
    function ver(v) { return (typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)) ? v : null; }
    function cmp(a, b) {
        var x = String(a).split('.'), y = String(b).split('.');
        for (var i = 0; i < 3; i++) { var d = (parseInt(x[i], 10) || 0) - (parseInt(y[i], 10) || 0); if (d) return d < 0 ? -1 : 1; }
        return 0;
    }
    function ago(ms) {
        if (ms == null) return '?';
        var m = Math.round(ms / MIN);
        if (m < 90) return m + ' min';
        var h = Math.round(ms / H);
        if (h < 72) return h + ' h';
        return Math.round(ms / (24 * H)) + ' days';
    }

    /* ── release notes: a shape check, because a note that is an object, or the owner's own words, has shipped before.
     *    A note is plain text, a list of texts, or the structured card { headline, date, sections: [{ title, items: [text] }] }. */
    function textProblem(p) {
        if (typeof p !== 'string' || !p.trim()) return 'a note is ' + (typeof p === 'string' ? 'empty' : (p === null ? 'null' : 'a ' + typeof p) + ', not text');
        if (/\[object Object\]/.test(p)) return 'a note contains "[object Object]"';
        if (/^\s*[{[]\s*"/.test(p)) return 'a note is raw JSON, not a sentence';
        if (/^\s*(addressed|fixed in response to)\s*:/i.test(p) && /feedback/i.test(p)) return 'a note quotes the owner\'s own feedback instead of describing the change';
        return null;
    }
    function noteItems(v) {
        if (typeof v === 'string') return [v];
        if (Array.isArray(v)) return v;
        if (v && typeof v === 'object' && Array.isArray(v.sections)) {
            var out = [];
            v.sections.forEach(function (sec) { if (sec && Array.isArray(sec.items)) out = out.concat(sec.items); else out.push(undefined); });
            return out;
        }
        return null;
    }
    function noteProblem(v) {
        if (v === undefined || v === null || v === '') return 'there is no note for this release';
        var items = noteItems(v);
        if (items === null) return 'a note is a ' + typeof v + ' without sections, not text';
        if (!items.length) return 'the note has no items';
        for (var i = 0; i < items.length; i++) { var bad = textProblem(items[i]); if (bad) return bad; }
        return null;
    }

    /* ── the chain ─────────────────────────────────────────────────────────────────────────────── */
    var LINKS = [
        { id: 'feedback', label: 'Your report is saved and becomes a work item' },
        { id: 'agent', label: 'The AI fix agent is able to work' },
        { id: 'release', label: 'Real changes are released (not empty version bumps)' },
        { id: 'deploy', label: 'The server serves the release' },
        { id: 'notes', label: 'The release notes describe the change honestly' },
        { id: 'offer', label: 'This device is told when a newer version exists' },
        { id: 'install', label: 'An install lands on this device' },
        { id: 'worker', label: 'The service worker can apply updates' },
        { id: 'welcome', label: 'The "what changed" sheet is shown after an update' },
        { id: 'stability', label: 'The running build does not crash' }
    ];

    function link(id, state, detail, hint) {
        var l = null;
        for (var i = 0; i < LINKS.length; i++) if (LINKS[i].id === id) l = LINKS[i];
        return { id: id, label: l ? l.label : id, state: state, detail: detail, hint: hint || '' };
    }

    function judgeFeedback(ev) {
        var items = Array.isArray(ev.feedback) ? ev.feedback : [];
        if (!items.length) return link('feedback', 'ok', 'No report of yours is waiting.');
        var now = ev.now, unsent = [], idle = [], stuck = [], done = 0, working = 0;
        items.forEach(function (f) {
            var age = (f.at != null) ? now - f.at : null;
            if (!f.issue) { if (age != null && age > LIMITS.unsentFeedbackMs && ev.online !== false) unsent.push(f); return; }
            if (f.status === 'completed' || f.status === 'declined') { done++; return; }
            if (f.status === 'needs-attention') { stuck.push(f); return; }
            if (f.status === 'in-progress') { working++; return; }
            if (age != null && age > LIMITS.idleFeedbackMs) idle.push(f);
        });
        var nums = function (a) { return a.map(function (f) { return f.issue ? '#' + f.issue : '(unfiled)'; }).join(', '); };
        if (stuck.length) return link('feedback', 'fail', nums(stuck) + ' reached the limit of AI attempts and is waiting for a person.', 'Open the issue on GitHub: its last comment names the stage the agent stopped at.');
        if (unsent.length) return link('feedback', 'warn', unsent.length + ' report(s) saved here for over ' + ago(LIMITS.unsentFeedbackMs) + ' were never filed as work items.', 'Open Settings > Software Update > Send Feedback, or check /api/feedback-triage (GITHUB token / issues enabled).');
        if (ev.feedbackStatusDown) return link('feedback', 'warn', 'Your reports are filed, but completion cannot be checked: ' + ev.feedbackStatusDown + '.', 'Set GITHUB_REPO and a GitHub token (GH_PAT) in Vercel so /api/feedback-status can answer.');
        if (idle.length) return link('feedback', 'warn', nums(idle) + ' filed for over ' + ago(LIMITS.idleFeedbackMs) + ' with no AI work started.', 'Run the "Autonomous fix agent" workflow for that issue and read its log.');
        return link('feedback', 'ok', items.length + ' report(s): ' + done + ' done, ' + working + ' in progress, ' + (items.length - done - working) + ' queued.');
    }

    function judgeAgent(ev) {
        var a = ev.server && ev.server.autonomy;
        if (!a || !a.ok) return link('agent', 'unknown', 'Could not read /api/autonomy-status' + (a && a.error ? ' (' + a.error + ')' : '') + '.', 'Open /api/autonomy-status?full=1 in a browser.');
        var failing = (a.failing || []).map(function (c) { return c.id + ': ' + c.summary; }).slice(0, 4).join(' | ');
        if (a.overall === 'unknown') return link('agent', 'unknown', 'The server could not read GitHub just now, so it cannot say whether the fix agent is running.', 'Try again in a minute; open /api/autonomy-status?full=1 to see what it could not read.');
        if (a.overall === 'broken' || a.canActuallyFixBugs === false) return link('agent', 'fail', 'The server says automatic fixing is not working. ' + failing, 'Fix the failing check first: it names the provider, key or file.');
        if (a.overall === 'degraded') return link('agent', 'warn', 'Working below full strength. ' + failing, 'Dead provider models or missing keys reduce who can write and who can review a change.');
        return link('agent', 'ok', 'The pipeline says it can fix reported problems.' + (a.headline ? ' ' + a.headline : ''));
    }

    function judgeRelease(ev) {
        var a = ev.server && ev.server.autonomy;
        if (!a || !a.ok) return link('release', 'unknown', 'Release history unavailable.');
        if (a.overall === 'unknown') return link('release', 'unknown', 'Release history unavailable.');
        if (a.releaseFailing) return link('release', 'fail', 'The latest Auto Release run did not succeed, so fixes may not reach the app.', 'Open the Auto Release workflow on GitHub and read the failing step.');
        if (a.emptyVersionBumpsRecently > 0) return link('release', 'warn', a.emptyVersionBumpsRecently + ' recent version bump(s) carried no functional change.', 'Compare the release commit with the merged PR before it: the stamp commit only changes version files.');
        var lr = a.lastRealChange;
        if (lr && lr.daysAgo != null && lr.daysAgo > LIMITS.staleChangeDays) return link('release', 'warn', 'The last real change shipped ' + lr.daysAgo + ' days ago.', 'Check that merged PRs are being released (Auto Release workflow).');
        return link('release', 'ok', lr ? 'Last real change ' + (lr.daysAgo == null ? '' : lr.daysAgo + ' day(s) ago: ') + String(lr.summary || '').slice(0, 110) : 'No empty version bumps recently.');
    }

    function judgeDeploy(ev) {
        var s = ev.server || {}, v = s.version, m = s.manifest;
        if (!v || !v.ok) return link('deploy', (v && v.error) ? 'fail' : 'unknown', 'Could not read /api/version' + (v && v.error ? ': ' + v.error : '') + '.', 'The app server may be down or the route missing.');
        if (m && m.ok && ver(m.latest) && ver(v.version) && m.latest !== v.version) return link('deploy', 'warn', '/api/version says ' + v.version + ' but version.json says ' + m.latest + '.', 'One of them is from a different deploy: wait a minute and copy again; if it persists the release stamp did not reach every file.');
        var d = ev.deploy || {};
        if (d.changed) return link('deploy', 'ok', 'Serving ' + v.version + ' (deploy ' + v.sha + '); a newer deploy of the same version went live since this device last looked (' + d.changed + ').');
        return link('deploy', 'ok', 'Serving ' + v.version + ' (deploy ' + v.sha + ', ' + (v.env || '?') + ').');
    }

    function judgeNotes(ev) {
        var m = ev.server && ev.server.manifest;
        if (!m || !m.ok) return link('notes', 'unknown', 'version.json could not be read' + (m && m.error ? ' (' + m.error + ')' : '') + '.');
        if (m.problem) return link('notes', m.problem.indexOf('no note') === 0 ? 'warn' : 'fail', 'Notes for ' + m.latest + ': ' + m.problem + '.', 'Notes must come only from the commits (autonomy/release-notes.cjs). Re-run the release stamp.');
        return link('notes', 'ok', 'Notes for ' + m.latest + ' read as ' + (m.noteCount || 1) + ' plain sentence(s).');
    }

    function judgeOffer(ev) {
        var run = ver(ev.running), v = ev.server && ev.server.version, m = ev.server && ev.server.manifest;
        var newest = null;
        if (v && v.ok && ver(v.version)) newest = v.version;
        if (m && m.ok && ver(m.latest) && (!newest || cmp(m.latest, newest) > 0)) newest = m.latest;
        if (!run) return link('offer', 'fail', 'The app does not know which version it is.', 'Hard-reload the app once.');
        if (!newest) return link('offer', 'unknown', 'Running ' + run + '; the newest version could not be read.');
        var c = cmp(run, newest);
        if (c === 0) return link('offer', 'ok', 'Running ' + run + ', the newest.');
        if (c > 0) return link('offer', 'warn', 'Running ' + run + ' but the server serves ' + newest + ': this device is ahead of the deploy (a rollback, or a stale deploy).', 'Check Vercel production deployments and the health watchdog history.');
        var seen = ev.offerSeen && ev.offerSeen.target === newest ? ev.offerSeen.at : null;
        var age = seen != null ? ev.now - seen : null;
        // Postponing or skipping is the person's right (as on Android and iOS), not a fault. Only a choice for THIS version counts,
        // a "later" only until it runs out, and a required update cannot be skipped (wealthflow-update-policy.js).
        var ch = ev.updateChoice;
        if (ch && ch.version === newest) {
            if (ch.action === 'skip') return link('offer', 'ok', 'Update ' + newest + ' is available; you chose to skip it. Running ' + run + '.');
            if (ch.action === 'later' && ev.now < Number(ch.until || 0)) return link('offer', 'ok', 'Update ' + newest + ' is available; you asked to be reminded later. Running ' + run + '.');
            if (ch.action === 'idle') return link('offer', 'ok', 'Update ' + newest + ' is set to install when you are not using the app. Running ' + run + '.');
        }
        if (age != null && age > LIMITS.offerMs) return link('offer', 'warn', 'Update ' + newest + ' has been available for ' + ago(age) + ' and is not installed.', 'Open Settings > Software Update and tap Update now (updates are always your own choice).');
        return link('offer', 'ok', 'Update ' + newest + ' is available' + (age != null ? ' (offered ' + ago(age) + ' ago)' : '') + '; running ' + run + '.');
    }

    function judgeInstall(ev) {
        var f = ev.failedTarget, c = ev.claim;
        if (f && ver(f.target)) return link('install', 'fail', 'The last update to ' + f.target + ' did NOT land' + (f.at ? ' (' + ago(ev.now - f.at) + ' ago)' : '') + '; still running ' + ev.running + '.', 'Open Settings > Software Update > Check now; if it repeats, the service worker is serving an old copy (see the worker link).');
        if (c && c.at && ev.now - c.at > LIMITS.claimMs) return link('install', 'warn', 'An update to ' + c.target + ' was started ' + ago(ev.now - c.at) + ' ago and never settled' + (c.total ? ' (' + (c.fetched || 0) + '/' + c.total + ' files fetched)' : '') + '.', 'Reopen the app: the next start settles it against the version that really loaded.');
        if (ev.anomaly) return link('install', 'warn', 'The stored version was ahead of the running code once; the app healed it to ' + ev.running + '.', 'No action needed unless it repeats.');
        if (ev.installed && ver(ev.installed) && ev.installed !== ev.running) return link('install', 'warn', 'Stored version ' + ev.installed + ' differs from the running build ' + ev.running + '.', 'Reopen the app; the update module reconciles it on start.');
        var pb = ev.preBackup;
        if (pb && pb.result === 'not-saved' && pb.target === ev.running) return link('install', 'warn', 'Running ' + ev.running + '; no update is half-done, but no restore point was saved before the last update (signed out, offline or nothing to back up). An update never changes your data.', 'Open Settings > Backup and tap Backup now, so a restore point exists before the next update.');
        return link('install', 'ok', 'Running ' + ev.running + '; no update is half-done.' + (pb ? (pb.result === 'saved' ? ' A restore point was saved before the last update (' + ago(ev.now - pb.at) + ' ago).' : '') : ''));
    }

    function judgeWorker(ev) {
        var w = ev.sw;
        if (!w) return link('worker', 'unknown', 'Not measured.');
        if (w.supported === false) return link('worker', 'ok', 'This browser has no service worker: updates apply on reload.');
        if (w.error) return link('worker', 'unknown', 'Could not inspect it: ' + w.error + '.');
        if (!w.registered) return link('worker', 'warn', 'No service worker is registered: offline use and background update checks are off.', 'Reload once; if it persists check that /sw.js loads (not a download).');
        if (w.waiting && ev.waitingSince != null && ev.now - ev.waitingSince > LIMITS.waitingWorkerMs) return link('worker', 'warn', 'A new service worker has been waiting ' + ago(ev.now - ev.waitingSince) + ' to take over.', 'Close all tabs of the app, or use Update now.');
        return link('worker', 'ok', 'Registered' + (w.controller ? ', controlling this page' : ', not yet controlling this page') + (w.waiting ? '; a new one is waiting' : '') + '.');
    }

    function judgeWelcome(ev) {
        if (ev.popupSeen === null || ev.popupSeen === undefined) return link('welcome', 'ok', 'Fresh install: nothing to announce yet.');
        if (ev.popupSeen === ev.running) return link('welcome', 'ok', 'The sheet for ' + ev.running + ' has been shown.');
        if (ev.popupSeen === '') return link('welcome', 'ok', 'Waiting to show the "what changed" sheet on the next open.');
        return link('welcome', 'ok', 'Last shown for ' + ev.popupSeen + '; ' + ev.running + ' will show its own.');
    }

    function judgeStability(ev) {
        var c = ev.crashes;
        if (!c || !c.total) return link('stability', 'ok', 'No crash has been recorded on this device.');
        if (c.onThisBuild > 0) return link('stability', 'fail', c.onThisBuild + ' crash(es) on the running build ' + ev.running + (c.lastPage ? '; the latest on the ' + c.lastPage + ' page' : '') + '.', 'The crash record names the page, the DOM size and the breadcrumbs: copy diagnostics and look at the stability line.');
        var by = c.byBuild || {}, parts = Object.keys(by).sort().map(function (b) { return b + ' ×' + by[b]; }).join(', ');
        return link('stability', 'ok', c.total + ' earlier crash(es) (' + (parts || 'builds not recorded') + '); none on ' + ev.running + '.');
    }

    var SEVERITY = { fail: 'error', warn: 'warn', unknown: 'info' };

    function judge(ev) {
        ev = ev || {};
        if (typeof ev.now !== 'number') ev.now = Date.now();
        var chain = [
            judgeFeedback(ev), judgeAgent(ev), judgeRelease(ev), judgeDeploy(ev), judgeNotes(ev),
            judgeOffer(ev), judgeInstall(ev), judgeWorker(ev), judgeWelcome(ev), judgeStability(ev)
        ];
        var issues = [], firstBreak = null, ok = 0, unknown = 0, fail = 0, warn = 0;
        chain.forEach(function (l) {
            if (l.state === 'ok') { ok++; return; }
            if (l.state === 'fail') fail++; else if (l.state === 'warn') warn++; else unknown++;
            if (!firstBreak && l.state !== 'unknown') firstBreak = l.id;
            issues.push({ severity: SEVERITY[l.state], area: 'update-system', message: l.label + ' — ' + l.detail, hint: l.hint || '' });
        });
        var st = ev.statementReview;
        if (st && st.total > 0) {
            var why = Object.keys(st.byReason || {}).map(function (k) { return k + ' ' + st.byReason[k]; }).join(', ');
            issues.push({ severity: 'warn', area: 'statements', message: st.total + ' statement entr' + (st.total === 1 ? 'y is' : 'ies are') + ' waiting for review' + (why ? ' (' + why + ')' : '') + '.', hint: 'Statement Sync > Open reviews lists them; "unproven-direction" rows are filed by the card sweep at the end of each statement run.' });
        }
        var staleEvidence = ev.server && ev.server.at != null && (ev.now - ev.server.at) > LIMITS.evidenceMaxAgeMs;
        var noServer = !ev.server || ev.server.at == null;
        if (noServer) issues.push({ severity: 'info', area: 'update-system', message: 'No server evidence has been collected on this device yet; the server-side links read "unknown".', hint: 'It is collected a few seconds after the app opens; copy again.' });
        else if (staleEvidence) issues.push({ severity: 'info', area: 'update-system', message: 'The server evidence is ' + ago(ev.now - ev.server.at) + ' old.', hint: 'Open the app online for a moment and copy again.' });
        var verdict = fail ? 'broken' : (warn ? 'degraded' : (unknown >= chain.length / 2 ? 'unknown' : 'healthy'));
        var first = null;
        for (var i = 0; i < chain.length; i++) if (chain[i].id === firstBreak) first = chain[i];
        var summary = ok + ' of ' + chain.length + ' links healthy' + (unknown ? ', ' + unknown + ' not measurable' : '') + '.' +
            (first ? ' First break: "' + first.label + '" — ' + first.detail : '');
        return { verdict: verdict, firstBreak: firstBreak, summary: summary, counts: { ok: ok, warn: warn, fail: fail, unknown: unknown }, chain: chain, issues: issues };
    }

    /* ── evidence from this device ─────────────────────────────────────────────────────────────── */
    var _server = null;       // the last server answers: { at, version, manifest, autonomy }
    var _sw = null;           // the last service worker inspection
    var _bootSha = null;      // the first deploy sha seen in THIS page load
    var _refreshing = null;

    function running() {
        try { if (W.WF_APP_VERSION) return String(W.WF_APP_VERSION); } catch (_) {}
        try { if (W.wfUpdate && W.wfUpdate.CURRENT_VERSION) return String(W.wfUpdate.CURRENT_VERSION); } catch (_) {}
        return null;
    }

    function crashEvidence(run) {
        var out = { total: 0, recorded: 0, onThisBuild: 0, byBuild: {}, lastBuild: null, lastAt: null, lastPage: null };
        try {
            var S = W.WFStability;
            if (!S) return out;
            var list = (S.crashes && S.crashes()) || [];
            out.recorded = list.length;
            out.total = (S.totalCrashCount && S.totalCrashCount()) || list.length;
            list.forEach(function (c) {
                var b = (c && c.build) || '?';
                out.byBuild[b] = (out.byBuild[b] || 0) + 1;
                if (b === run) out.onThisBuild++;
            });
            var last = list[list.length - 1];
            if (last) { out.lastBuild = last.build || null; out.lastAt = last.when || null; out.lastPage = last.page || null; }
        } catch (_) {}
        return out;
    }

    function feedbackEvidence() {
        var q = read('wf_feedback_queue', []);
        if (!Array.isArray(q)) return [];
        return q.slice(-25).map(function (x) {
            return { issue: x && x.issue ? Number(x.issue) : null, status: x ? (x._status || (x._pending ? 'pending' : 'open')) : 'open', type: x && x.type ? String(x.type).slice(0, 20) : null, at: x ? ts(x.createdAt || x.t) : null };
        });
    }

    function deviceEvidence() {
        var run = running();
        var seen = read(K_SEEN, {}) || {};
        var installed = null;
        try { installed = (W.wfUpdate && W.wfUpdate._installedVersion) ? W.wfUpdate._installedVersion() : readRaw('wf_installed_version'); } catch (_) { installed = readRaw('wf_installed_version'); }
        var pre = read('wf_preupdate_backup', null);
        var statementReview = null;
        try { if (W.WFStatementCloud && W.WFStatementCloud.reviewSummary) { var r = W.WFStatementCloud.reviewSummary(); if (r) statementReview = { total: r.total || 0, byReason: r.byReason || {} }; } } catch (_) {}
        var down = null;
        try { if (W.wfUpdate && W.wfUpdate._feedbackStatusReason) down = W.wfUpdate._feedbackStatusReason(); } catch (_) {}
        return {
            now: Date.now(), online: (typeof navigator !== 'undefined') ? navigator.onLine !== false : true,
            running: run, installed: installed,
            claim: read('wf_update_claimed', null), failedTarget: read('wf_update_failed_target', null), anomaly: read('wf_version_anomaly', null),
            pending: readRaw('wf_update_pending'),
            preBackup: pre && pre.at ? { at: Number(pre.at), result: pre.result === 'saved' ? 'saved' : 'not-saved', target: pre.target || null } : null,
            popupSeen: readRaw('wf_update_popup_seen'),
            feedback: feedbackEvidence(), feedbackStatusDown: down,
            crashes: crashEvidence(run), statementReview: statementReview,
            offerSeen: seen.offer || null, waitingSince: seen.waitingAt || null, updateChoice: read('wf_update_choice', null),
            sw: _sw
        };
    }

    function evidence() {
        var ev = deviceEvidence();
        ev.server = _server || read(K_EVIDENCE, null);
        var seen = read(K_SEEN, {}) || {};
        var d = {};
        if (_server && _server.version && _server.version.ok && seen.sha && seen.sha !== _server.version.sha) d.changed = seen.sha + ' → ' + _server.version.sha;
        else if (_bootSha && ev.server && ev.server.version && ev.server.version.ok && _bootSha !== ev.server.version.sha) d.changed = _bootSha + ' → ' + ev.server.version.sha;
        ev.deploy = d;
        return ev;
    }

    /** Synchronous, no network: safe to call inside a tap. */
    function collect(opts) {
        var compact = !!(opts && opts.compact);
        var ev = evidence();
        var j = judge(ev);
        var out = {
            verdict: j.verdict, firstBreak: j.firstBreak, summary: j.summary, counts: j.counts,
            evidenceAgeSec: (ev.server && ev.server.at != null) ? Math.max(0, Math.round((ev.now - ev.server.at) / 1000)) : null,
            chain: j.chain.map(function (l) { return compact ? { id: l.id, state: l.state, detail: String(l.detail).slice(0, 160) } : { id: l.id, state: l.state, label: l.label, detail: l.detail, hint: l.hint }; }),
            issues: compact ? undefined : j.issues
        };
        if (!compact) {
            out.evidence = {
                running: ev.running, installed: ev.installed, claim: ev.claim, failedTarget: ev.failedTarget, pending: ev.pending,
                popupSeen: ev.popupSeen, preUpdateBackup: ev.preBackup ? { result: ev.preBackup.result, ageMin: Math.round((ev.now - ev.preBackup.at) / MIN) } : null,
                crashes: ev.crashes, feedback: ev.feedback, serviceWorker: ev.sw,
                server: ev.server ? {
                    at: ev.server.at ? new Date(ev.server.at).toISOString() : null,
                    version: ev.server.version, manifest: ev.server.manifest,
                    autonomy: ev.server.autonomy
                } : null,
                deploy: ev.deploy
            };
        }
        return out;
    }

    /* ── gathering the server's side, ahead of time ────────────────────────────────────────────── */
    function getJson(url, ms) {
        var ctl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
        var timer = setTimeout(function () { try { ctl && ctl.abort(); } catch (_) {} }, ms || 4500);
        return fetch(url, { cache: 'no-store', signal: ctl ? ctl.signal : undefined }).then(function (r) {
            clearTimeout(timer);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        }).catch(function (e) { clearTimeout(timer); throw e; });
    }
    function oneLine(e) { return String((e && e.message) || e).slice(0, 120); }

    function inspectWorker() {
        return new Promise(function (resolve) {
            try {
                var sw = (typeof navigator !== 'undefined') ? navigator.serviceWorker : null;
                if (!sw || !sw.getRegistration) return resolve({ supported: false });
                var done = false, t = setTimeout(function () { if (!done) { done = true; resolve({ supported: true, error: 'no answer within 3 s' }); } }, 3000);
                sw.getRegistration().then(function (reg) {
                    if (done) return; done = true; clearTimeout(t);
                    resolve({ supported: true, registered: !!reg, controller: !!sw.controller, waiting: !!(reg && reg.waiting), installing: !!(reg && reg.installing), scope: reg && reg.scope ? String(reg.scope).replace(/^https?:\/\/[^/]+/, '') : null });
                }, function (e) { if (done) return; done = true; clearTimeout(t); resolve({ supported: true, error: oneLine(e) }); });
            } catch (e) { resolve({ supported: true, error: oneLine(e) }); }
        });
    }

    function refresh() {
        if (_refreshing) return _refreshing;
        var started = Date.now();
        var pv = getJson('/api/version').then(function (j) { return { ok: true, sha: String(j.sha || '').slice(0, 12), version: ver(j.version) ? j.version : null, env: j.env || null, ts: j.ts || null }; }, function (e) { return { ok: false, error: oneLine(e) }; });
        var pm = getJson('/version.json?_=' + started).then(function (j) {
            var latest = ver(j.latest) ? j.latest : null, notes = j.notes && latest ? j.notes[latest] : undefined;
            var items = noteItems(notes);
            return { ok: true, latest: latest, noteCount: items ? items.length : 0, problem: noteProblem(notes) };
        }, function (e) { return { ok: false, error: oneLine(e) }; });
        var pa = getJson('/api/autonomy-status?full=1').then(function (j) {
            // The endpoint answers HTTP 200 with overall "unknown" when its own self-check could not run, and ok:false
            // for "broken" too. Only healthy / degraded / broken are measurements; anything else is "not measured",
            // which must stay unknown instead of being turned into a confirmed failure or a clean bill.
            if (!j || (j.overall !== 'healthy' && j.overall !== 'degraded' && j.overall !== 'broken')) {
                return { ok: false, error: String((j && (j.error || j.headline)) || 'the server could not measure it').slice(0, 140) };
            }
            var failing = (j.checks || []).filter(function (c) { return c.status && c.status !== 'pass' && c.status !== 'ok' && c.status !== 'healthy'; }).slice(0, 6).map(function (c) { return { id: c.id, status: c.status, summary: String(c.summary || '').slice(0, 140) }; });
            return { ok: true, overall: j.overall, canActuallyFixBugs: j.canActuallyFixBugs, headline: j.headline, lastRealChange: j.lastRealChange || null, emptyVersionBumpsRecently: j.emptyVersionBumpsRecently || 0, failing: failing };
        }, function (e) { return { ok: false, error: oneLine(e) }; });
        _refreshing = Promise.all([pv, pm, pa, inspectWorker()]).then(function (r) {
            _server = { at: Date.now(), version: r[0], manifest: r[1], autonomy: r[2] };
            _sw = r[3];
            // remember what this device has seen, so "offered for 3 days" and "deploy changed" can be told later
            var seen = read(K_SEEN, {}) || {};
            var newest = (r[0].ok && r[0].version) || (r[1].ok && r[1].latest) || null;
            var run = running();
            if (newest && run && cmp(run, newest) < 0) { if (!seen.offer || seen.offer.target !== newest) seen.offer = { target: newest, at: Date.now() }; }
            else delete seen.offer;
            if (_sw && _sw.waiting) { if (!seen.waitingAt) seen.waitingAt = Date.now(); } else delete seen.waitingAt;
            if (r[0].ok && r[0].sha) { if (!_bootSha) _bootSha = r[0].sha; seen.sha = r[0].sha; }
            write(K_SEEN, seen);
            write(K_EVIDENCE, _server);
            standby();
            return _server;
        }).catch(function () { return null; }).then(function (x) { _refreshing = null; return x; });
        return _refreshing;
    }


    /* ── standby: a device that cannot update says so by itself (owner, 2026-11-07: "always stand by")
     *    The chain above only spoke when someone copied it. The one break that is the device's own and that nobody else can see is an
     *    update that did not land, so that, and only that, is filed: one report per target and running build per day, at most two a day,
     *    nothing offline, through the same endpoint as a crash report. It carries two version numbers and no free text. Switch off with
     *    localStorage "wf_diag_standby_off" = "1". */
    var K_STANDBY = 'wf_diag_standby', STANDBY_OFF = 'wf_diag_standby_off', STANDBY_PER_DAY = 2, DAY_MS = 24 * H;
    function standbyPayload(ev) {
        var f = ev && ev.failedTarget, run = ev && ev.running;
        if (!f || !ver(f.target) || !ver(run) || cmp(run, f.target) >= 0) return null;
        var fp = 'install-failed:' + f.target + ':' + run;
        return {
            fp: fp,
            body: {
                text: '[Auto diagnosis] The update to ' + f.target + ' did not land on a device that is still running ' + run + '.',
                type: 'bug', source: 'auto-diagnosis',
                diagnostics: { activePage: '', online: true, errors: [], updateSystem: { firstBreak: 'install', target: f.target, running: run, claim: ev.claim ? { fetched: ev.claim.fetched || 0, total: ev.claim.total || 0 } : null } }
            }
        };
    }
    function standbyAllowed(fp, now) {
        try { if (W.localStorage && W.localStorage.getItem(STANDBY_OFF) === '1') return false; } catch (_) {}
        if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
        var seen = read(K_STANDBY, {}) || {};
        var recent = Object.keys(seen).filter(function (k) { return now - seen[k] < DAY_MS; });
        if (seen[fp] && now - seen[fp] < DAY_MS) return false;
        return recent.length < STANDBY_PER_DAY;
    }
    function standby() {
        try {
            var p = standbyPayload(deviceEvidence());
            if (!p || typeof W.fetch !== 'function') return false;
            var now = Date.now();
            if (!standbyAllowed(p.fp, now)) return false;
            var seen = read(K_STANDBY, {}) || {}; seen[p.fp] = now; write(K_STANDBY, seen);
            W.fetch('/api/feedback-triage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(p.body), keepalive: true }).catch(function () {});
            return true;
        } catch (_) { return false; }
    }

    W.WFDiagnosis = { collect: collect, refresh: refresh, judge: judge, standby: standby, standbyPayload: standbyPayload, standbyAllowed: standbyAllowed, noteProblem: noteProblem, LINKS: LINKS, LIMITS: LIMITS, VERSION: '1.0' };

    /* evidence is gathered a few seconds after the app opens and again every 15 minutes while it is in front */
    try {
        if (typeof setTimeout === 'function' && typeof document !== 'undefined') {
            setTimeout(refresh, 9000);
            setInterval(function () { try { if (document.visibilityState !== 'hidden') refresh(); } catch (_) {} }, 15 * MIN);
            document.addEventListener('visibilitychange', function () {
                try {
                    if (document.visibilityState === 'visible' && (!_server || Date.now() - _server.at > 5 * MIN)) refresh();
                } catch (_) {}
            });
        }
    } catch (_) {}
})();
