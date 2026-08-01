/* =============================================================================
 *  WealthFlow — Crash Forensics   ·   window.WFCrashForensics
 *  Implements points 1, 2 and 4 of issue #54.
 * -----------------------------------------------------------------------------
 *  WHAT PROMPTED THIS
 *
 *  Two things sat in the diagnostics attached to #46, on a real device:
 *
 *    · 19 crashes recorded — sessions killed without a clean exit;
 *    · "Script https://…/sw.js load failed".
 *
 *  Neither was reported by the user. They reported a button. Both were in the
 *  app's own logs, and the only reason anyone saw them is that the "send system
 *  diagnosis" box happened to be ticked while filing something unrelated.
 *
 *  THE SERVICE WORKER FAILURE WAS CAUGHT AND THROWN AWAY
 *
 *      catch (err) {
 *          console.warn('[SW] Registration failed:', err.message);
 *          return null;
 *      }
 *
 *  Detected, written to a console nobody has open on a phone, discarded. `null`
 *  was returned and no caller distinguished it from success. What silently stops
 *  working: offline access, install-to-home-screen, push notifications, and the
 *  update mechanism wealthflow-update-system.js drives through skipWaiting. The
 *  app degrades from a PWA to a web page and says nothing.
 *
 *  That is the standing review question exactly — who reads this output, and is
 *  there a test proving they do? Nobody did, and nothing proved anything.
 *
 *  TWO CRASH STORES THAT NOTHING RECONCILED
 *
 *  window._wfCrashReport() reads `wf_error_log` (JS errors, with stacks).
 *  wealthflow-stability.js keeps `wf_crash_log` (sessions that died without a
 *  clean exit — an iOS renderer kill runs no JS error handler, so it can never
 *  appear in the first store). A reader of either saw half the picture, and
 *  "19 crashes" meant different things depending on which half you asked.
 *
 *  WHAT THIS DOES NOT DO
 *
 *  It does not file anything. Point 3 of the proposal — offering to report
 *  accumulated crashes through the feedback pipeline — was deliberately left
 *  unbuilt: it was scoped as opt-in and was not authorised, and an app that
 *  files issues about itself unprompted is a different product. This module
 *  reads, merges and reports. Nothing leaves the device.
 * ========================================================================== */
(function () {
    var W = (typeof window !== 'undefined') ? window
        : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_CRASH_FORENSICS === '1.0') return;
    W.WF_CRASH_FORENSICS = '1.0';

    var K_ERRORS = 'wf_error_log';   // index.html — JS errors with stacks
    var K_CRASHES = 'wf_crash_log';  // wealthflow-stability.js — unclean exits
    var K_SW = 'wf_sw_status';       // written by the registration path below

    function store() {
        try { return W.localStorage; } catch (_) { return null; }
    }
    function readJSON(key, fallback) {
        try {
            var s = store(); if (!s) return fallback;
            var raw = s.getItem(key);
            if (!raw) return fallback;
            var v = JSON.parse(raw);
            return v == null ? fallback : v;
        } catch (_) { return fallback; }
    }
    function writeJSON(key, value) {
        // Returns whether the write ACTUALLY happened. The first version
        // returned true unconditionally, so with no localStorage at all it
        // reported success for a write that never occurred — the precise
        // failure this whole module exists to stop, committed inside it.
        try {
            var s = store();
            if (!s || typeof s.setItem !== 'function') return false;
            s.setItem(key, JSON.stringify(value));
            return true;
        } catch (_) { return false; }
    }
    function str(v) { return String(v == null ? '' : v); }

    /**
     * Record what the service-worker registration actually did.
     *
     * The whole point of #54: the result stops being a console line and becomes
     * a state something can read. Called from registerServiceWorker() on both
     * paths — success clears the flag, so a device that recovers on the next
     * launch does not keep claiming it is degraded.
     */
    function noteServiceWorker(ok, reason) {
        return writeJSON(K_SW, {
            ok: !!ok,
            reason: ok ? '' : str(reason).slice(0, 200),
            at: Date.now(),
        });
    }

    /**
     * Is this device running degraded, and what stopped working?
     * `ok: null` means never recorded — not the same as working, and it must not
     * be reported as either.
     */
    function serviceWorkerStatus() {
        var rec = readJSON(K_SW, null);
        if (!rec || typeof rec.ok !== 'boolean') {
            return { ok: null, known: false, reason: '', lost: [] };
        }
        return {
            ok: rec.ok, known: true, at: rec.at || null,
            reason: str(rec.reason),
            lost: rec.ok ? [] : ['offline access', 'install to home screen', 'push notifications', 'automatic updates'],
        };
    }

    /** Normalise a row from either store into one shape. */
    function normalise(e, source) {
        var r = e && typeof e === 'object' ? e : {};
        return {
            source: source,
            message: str(r.msg || r.message || r.reason || (source === 'session' ? 'session ended without a clean exit' : '')),
            stack: str(r.stack).slice(0, 900),
            page: r.page || null,
            version: r.ver || r.version || null,
            at: r.t || r.when || r.at || r.start || null,
        };
    }

    /**
     * One history from both stores, newest first.
     *
     * An iOS renderer kill runs no JS handler, so it can only ever appear in
     * `wf_crash_log`; a caught exception can only appear in `wf_error_log`.
     * Reading one and calling the number "crashes" was wrong in both directions.
     */
    function history() {
        var a = readJSON(K_ERRORS, []);
        var b = readJSON(K_CRASHES, []);
        var out = [];
        if (Array.isArray(a)) for (var i = 0; i < a.length; i++) out.push(normalise(a[i], 'error'));
        if (Array.isArray(b)) for (var j = 0; j < b.length; j++) out.push(normalise(b[j], 'session'));

        // One event can land in BOTH stores — a crash that also raised an error.
        // Deduping is therefore only ever correct ACROSS sources: two identical
        // messages inside the SAME store are two real occurrences, and folding
        // them together undercounts. The first version keyed on message+second
        // regardless of source, which silently collapsed a repeated error into
        // one and made "most common failure" report the wrong message.
        var seen = {}, dedup = [];
        for (var k = 0; k < out.length; k++) {
            var e = out[k];
            var sig = e.message + '|' + (e.at ? Math.floor(Number(e.at) / 1000) : '');
            if (seen[sig] && seen[sig] !== e.source) continue;   // same event, other store
            seen[sig] = e.source;
            dedup.push(e);
        }
        dedup.sort(function (x, y) { return (Number(y.at) || 0) - (Number(x.at) || 0); });
        return dedup;
    }

    /** Counts a person can act on, with the two sources kept distinguishable. */
    function summary(opts) {
        var o = opts || {};
        var all = history();
        var build = o.version || W.WF_APP_VERSION || null;
        var msgs = {}, fromBuild = 0, errors = 0, sessions = 0;
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            if (e.source === 'error') errors += 1; else sessions += 1;
            if (build && e.version && String(e.version) === String(build)) fromBuild += 1;
            if (e.message) msgs[e.message] = (msgs[e.message] || 0) + 1;
        }
        var unique = Object.keys(msgs).sort(function (a, b) { return msgs[b] - msgs[a]; });
        return {
            total: all.length, errors: errors, sessions: sessions,
            fromThisBuild: build ? fromBuild : null,
            uniqueMessages: unique.slice(0, 10),
            worst: unique.length ? { message: unique[0], n: msgs[unique[0]] } : null,
            serviceWorker: serviceWorkerStatus(),
        };
    }

    /**
     * What to tell the user, or null when there is nothing worth saying.
     * Silence is the correct output for a healthy device — a banner that is
     * always on is a banner nobody reads.
     */
    function report() {
        var s = summary();
        var out = [];
        if (s.serviceWorker.known && s.serviceWorker.ok === false) {
            out.push({
                level: 'warn', kind: 'sw_failed',
                title: 'This device is running without offline support',
                body: 'The background worker could not start' + (s.serviceWorker.reason ? ' (' + s.serviceWorker.reason + ')' : '')
                    + ', so ' + s.serviceWorker.lost.join(', ') + ' are unavailable until it does. '
                    + 'Reopening the app usually fixes it.',
            });
        }
        if (s.total > 0) {
            out.push({
                level: s.total >= 5 ? 'warn' : 'info', kind: 'crash_history',
                title: s.total + ' crash' + (s.total === 1 ? '' : 'es') + ' recorded on this device',
                body: (s.sessions ? s.sessions + ' ended without a clean exit' : '')
                    + (s.sessions && s.errors ? ' and ' : '')
                    + (s.errors ? s.errors + ' raised an error' : '')
                    + (s.worst ? '. Most common: ' + s.worst.message : '') + '.',
            });
        }
        return out;
    }

    W.WFCrashForensics = {
        KEYS: { errors: K_ERRORS, crashes: K_CRASHES, sw: K_SW },
        noteServiceWorker: noteServiceWorker, serviceWorkerStatus: serviceWorkerStatus,
        history: history, summary: summary, report: report, VERSION: '1.0',
    };
    try { console.log('[WFCrashForensics] v1.0 loaded'); } catch (_) {}
})();
