/* WealthFlow update policy: the rules for WHEN an update is offered and what the person may do about it.
 *
 * Pure functions, no DOM, no storage, no network, so every rule is testable and the update screen only draws the answer.
 * Loaded before wealthflow-update-system.js, which falls back to its old behaviour if this file is missing.
 *
 * WHERE THE RULES COME FROM (verified 2026-11-07; docs/update-model-research.md has the sources and the limits)
 *  - Android in-app updates: a release carries a PRIORITY 0 to 5 and the app reads how many days it has been
 *    available (staleness). Low priority is not prompted, medium is a "flexible" update the person can finish later,
 *    critical is "immediate".                                              developer.android.com/guide/playcore/in-app-updates
 *  - Google Play staged rollout: a random share of users gets a release, the share is raised by hand, a rollout can be
 *    halted and resumed with the same users, and halting is not a rollback.     support.google.com/googleplay/android-developer/answer/6346149
 *  - Apple phased release: 7 days at 1, 2, 5, 10, 20, 50, 100 percent of users with automatic updates; anyone can still
 *    update by hand at any time.                    developer.apple.com/help/app-store-connect/update-your-app/release-a-version-update-in-phases
 *  - Apple Background Security Improvements and Android Mainline: small security fixes ship between full updates, are
 *    on by default, can be turned off, and can be pulled again.            support.apple.com/102657, source.android.com/docs/core/ota/modular-system
 *
 * WHERE WEALTHFLOW DELIBERATELY DIFFERS: Android's "immediate" flow blocks the app until it is updated. WealthFlow is the
 * only way to reach a person's money records, and an update that fails half way must never lock them out, so even the
 * highest priority never blocks: it stops allowing "skip", shortens "later", and says so plainly. */
(function (root) {
    'use strict';
    var DAY = 86400000;

    function validVersion(v) { return (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v.trim())) ? v.trim() : null; }
    function cmp(a, b) {
        var pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
        for (var i = 0; i < 3; i++) { if ((pa[i] || 0) > (pb[i] || 0)) return 1; if ((pa[i] || 0) < (pb[i] || 0)) return -1; }
        return 0;
    }
    function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
    function has(list, v) { return Array.isArray(list) && list.indexOf(v) >= 0; }

    /* ---------- priority and stance ---------- */

    /** 0 to 5. An explicit number in the manifest wins; otherwise it follows what the release is. */
    function priorityOf(version, manifest, type) {
        var m = manifest || {};
        var p = m.priority && Number(m.priority[version]);
        if (m.priority && m.priority[version] !== undefined && isFinite(p)) return clamp(Math.round(p), 0, 5);
        if (has(m.mandatory, version)) return 5;
        if (type === 'security') return 4;
        if (type === 'full') return 3;
        return 2;
    }
    /** What the screens do with a priority. quiet: Settings only. offer: pill and badge. urge: the same with a nudge. required: cannot be skipped. */
    function stanceOf(priority) { return priority >= 5 ? 'required' : priority >= 4 ? 'urge' : priority >= 2 ? 'offer' : 'quiet'; }
    function canSkip(priority) { return priority < 5; }
    function maxSnoozeDays(priority) { return priority >= 5 ? 1 : priority >= 4 ? 3 : 7; }

    /* ---------- the person's choice about one version ---------- */

    /** "Remind me later". Capped by priority, so a required update can be put off for a day, not a week. */
    function later(version, days, priority, now) {
        var d = clamp(Number(days) || 1, 1, maxSnoozeDays(priority));
        return { version: version, action: 'later', until: now + d * DAY, at: now, days: d };
    }
    /** "Skip this version". Null when the priority does not allow it. */
    function skip(version, priority, now) {
        return canSkip(priority) ? { version: version, action: 'skip', at: now } : null;
    }
    /** "Install when I am not using the app". The update screen acts on it; this only names the choice. */
    function whenIdle(version, now) { return { version: version, action: 'idle', at: now }; }

    /** A choice only ever applies to the version it was made for: a newer version starts clean. */
    function activeChoice(choice, version, priority, now) {
        if (!choice || choice.version !== version) return null;
        if (choice.action === 'skip') return canSkip(priority) ? choice : null;
        if (choice.action === 'later') return now < Number(choice.until || 0) ? choice : null;
        if (choice.action === 'idle') return choice;
        return null;
    }

    /* ---------- staged rollout ---------- */

    /** A stable 0 to 99 per device. Random once, then kept, like Play's random user selection that stays the same on resume. */
    function bucketOf(stored, randomInt) {
        var n = Number(stored);
        if (stored !== null && stored !== undefined && stored !== '' && isFinite(n) && n >= 0 && n < 100) return Math.floor(n);
        return clamp(Math.floor(Number(randomInt) || 0), 0, 99);
    }
    function rolloutPercent(version, manifest) {
        var r = manifest && manifest.rollout && manifest.rollout[version];
        return r === undefined || !isFinite(Number(r)) ? 100 : clamp(Math.round(Number(r)), 0, 100);
    }
    function isHalted(version, manifest) { return has(manifest && manifest.halted, version); }
    /** Is this device inside the rollout? Early access devices are always first in line. A halted version is offered to nobody. */
    function inRollout(version, manifest, bucket, early) {
        if (isHalted(version, manifest)) return false;
        var pct = rolloutPercent(version, manifest);
        if (pct <= 0) return false;
        return !!early || bucket < pct;
    }

    /* ---------- should the pill and badge show ---------- */

    /** {show, why}. The Settings card does not use this: whoever goes looking always sees what is available. */
    function announce(s) {
        if (!s.available) return { show: false, why: 'current' };
        if (isHalted(s.version, s.manifest)) return { show: false, why: 'halted' };
        if (stanceOf(s.priority) === 'quiet') return { show: false, why: 'quiet' };
        if (!s.inRollout) return { show: false, why: 'rolling-out' };
        var c = activeChoice(s.choice, s.version, s.priority, s.now);
        if (c && c.action === 'skip') return { show: false, why: 'skipped' };
        if (c && c.action === 'later') return { show: false, why: 'later' };
        return { show: true, why: c ? 'idle' : 'offer' };
    }
    /** Whole days since this version was first seen, for the wording ("offered 4 days ago"). */
    function staleDays(firstSeen, version, now) {
        if (!firstSeen || firstSeen.version !== version || !isFinite(Number(firstSeen.at))) return 0;
        return Math.max(0, Math.floor((now - Number(firstSeen.at)) / DAY));
    }

    /* ---------- everything since the version this device had ---------- */

    function versionsBetween(notes, from, to) {
        return Object.keys(notes || {}).filter(function (v) { return validVersion(v) && cmp(v, from) > 0 && cmp(v, to) <= 0; })
            .sort(function (a, b) { return cmp(b, a); });
    }
    /** One list for a device that skipped several releases: sections joined by title, newest item first, repeats removed. */
    function mergeNotes(entries) {
        var order = [], by = {}, count = 0, newest = null, oldest = null;
        (entries || []).forEach(function (e) {
            if (!e || !e.notes || !Array.isArray(e.notes.sections)) return;
            count++;
            if (!newest || cmp(e.version, newest) > 0) newest = e.version;
            if (!oldest || cmp(e.version, oldest) < 0) oldest = e.version;
            e.notes.sections.forEach(function (s) {
                var t = s.title || 'Highlights';
                if (!by[t]) { by[t] = { title: t, items: [], security: false }; order.push(t); }
                if (s.security) by[t].security = true;
                (s.items || []).forEach(function (it) { if (by[t].items.indexOf(it) < 0) by[t].items.push(it); });
            });
        });
        if (!count) return null;
        order.sort(function (a, b) { return (a === 'Under the hood') - (b === 'Under the hood'); });
        return { count: count, newest: newest, oldest: oldest, sections: order.map(function (t) { return by[t]; }) };
    }

    /* ---------- connection ---------- */

    /** true: metered or data saver, false: Wi-Fi or wired, null: this browser does not say (Safari does not expose it). */
    function metered(conn) {
        if (!conn) return null;
        if (conn.saveData === true) return true;
        if (conn.type === 'cellular') return true;
        if (conn.type === 'wifi' || conn.type === 'ethernet') return false;
        return null;
    }
    /** An automatic install waits only when the person asked for Wi-Fi only AND the browser says the connection is metered. */
    function mayInstallAutomatically(wifiOnly, conn) { return !(wifiOnly && metered(conn) === true); }

    /* ---------- features that differ from device to device ---------- */

    function hash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
    /** {on, why}. The person's own switch always wins; then the release channel; then the staged share; then the default. */
    function featureState(id, def, prefs, installed) {
        var p = prefs || {}, d = def || {};
        if (p.overrides && typeof p.overrides[id] === 'boolean') return { on: p.overrides[id], why: 'your choice' };
        if (d.since && validVersion(d.since) && cmp(installed, d.since) < 0) return { on: false, why: 'needs v' + d.since };
        if (d.channel === 'early' && !p.early) return { on: false, why: 'early access only' };
        var r = d.rollout === undefined ? 100 : clamp(Math.round(Number(d.rollout) || 0), 0, 100);
        if (r < 100 && !p.early && ((Number(p.bucket) || 0) + hash(id)) % 100 >= r) return { on: false, why: 'rolling out (' + r + '%)' };
        return { on: d.default !== false, why: d.default === false ? 'off by default' : 'on' };
    }

    /* ---------- one account, several devices ----------
     *
     * The account document is shared by every device signed in to it, and it merges leaf by leaf (docs/sync-architecture.md). So the
     * record is shaped so that ONE LEAF is ONE FACT: a leaf written by one device is never half overwritten by another.
     *   updateSync.devices[deviceId] = "version|at|name"   what that device runs, when it last said so
     *   updateSync.wanted            = "version|by|at"     the newest version the person deliberately installed on any device
     *   updateSync.agreed[line]      = at                  the agreement for major.minor `line` was accepted on some device
     * `wanted` only ever moves up, and only when a device that is not on early access installs through the update screen: a reload
     * that happens to bring new code, a test phone on early access, or a rollback never pulls the other devices anywhere. */
    var ACCOUNT_STALE_DAYS = 60, DEVICE_SHOWN_DAYS = 90, DEVICE_BEAT_MS = 12 * 3600000, DEVICE_KEEP = 16;

    function plainObj(o) { return !!o && typeof o === 'object' && !Array.isArray(o); }
    function cleanName(n) { return String(n == null ? '' : n).replace(/[|\r\n]/g, ' ').trim().slice(0, 40); }
    function parseDevice(s) {
        if (typeof s !== 'string') return null;
        var a = s.split('|'), v = validVersion(a[0]), at = Number(a[1]);
        return v && isFinite(at) && at > 0 ? { v: v, at: at, name: cleanName(a.slice(2).join(' ')) } : null;
    }
    function parseWanted(s) {
        if (typeof s !== 'string') return null;
        var a = s.split('|'), v = validVersion(a[0]), at = Number(a[2]);
        return v && a[1] && isFinite(at) && at > 0 ? { v: v, by: a[1], at: at } : null;
    }
    /** "Chrome on Windows", "Safari on iPhone". What a browser says about itself, no guessing about phone or laptop. */
    function deviceLabel(ua) {
        var u = String(ua || '');
        var os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android' : /Windows/.test(u) ? 'Windows' : /Macintosh|Mac OS X/.test(u) ? 'Mac' : /CrOS/.test(u) ? 'Chromebook' : /Linux/.test(u) ? 'Linux' : '';
        var br = /Edg\//.test(u) ? 'Edge' : /OPR\/|Opera/.test(u) ? 'Opera' : /Firefox|FxiOS/.test(u) ? 'Firefox' : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : '';
        return br && os ? br + ' on ' + os : br || os || 'This device';
    }
    /** The account record after this device reports what it runs. The SAME object comes back when nothing needs saving, so a caller writes only on a change.
     *  advance: this device just installed `version` on purpose, so the account's wanted version moves up to it. */
    function reportDevice(sync, id, version, name, now, advance) {
        var v = validVersion(version);
        if (!id || !v || !isFinite(now)) return sync;
        var s = plainObj(sync) ? sync : {}, devices = plainObj(s.devices) ? s.devices : {};
        var cur = parseDevice(devices[id]), nm = cleanName(name) || (cur && cur.name) || '';
        var w = parseWanted(s.wanted);
        var moves = !!advance && (!w || cmp(v, w.v) > 0);
        var stale = !cur || cur.v !== v || cur.name !== nm || now - cur.at >= DEVICE_BEAT_MS;
        if (!stale && !moves) return sync;
        var out = { devices: Object.assign({}, devices) };
        out.devices[id] = v + '|' + now + '|' + nm;
        if (plainObj(s.agreed)) out.agreed = s.agreed;
        out.wanted = moves ? v + '|' + id + '|' + now : s.wanted;
        if (out.wanted === undefined) delete out.wanted;
        // Keep the record small: past DEVICE_KEEP entries, the longest-silent ones are blanked (a merge cannot delete a key).
        var ids = Object.keys(out.devices);
        if (ids.length > DEVICE_KEEP) {
            ids.map(function (k) { var d = parseDevice(out.devices[k]); return { k: k, at: d ? d.at : 0 }; })
                .sort(function (a, b) { return a.at - b.at; })
                .slice(0, ids.length - DEVICE_KEEP)
                .forEach(function (e) { if (e.k !== id && out.devices[e.k] !== '') out.devices[e.k] = ''; });
        }
        return out;
    }
    /** The agreement for this major.minor line was accepted on one device: every device of the account counts it as read. */
    function noteAgreed(sync, line, now) {
        var s = plainObj(sync) ? sync : {};
        if (!/^\d+\.\d+$/.test(String(line)) || (plainObj(s.agreed) && Number(s.agreed[line]) > 0)) return sync;
        var out = Object.assign({}, s);
        out.agreed = Object.assign({}, plainObj(s.agreed) ? s.agreed : {});
        out.agreed[line] = now;
        return out;
    }
    function agreedOn(sync, line) { return !!(plainObj(sync) && plainObj(sync.agreed) && Number(sync.agreed[line]) > 0); }

    /** What this device should do about a version the account already has. act: none | install.
     *  The install target is what the server offers NOW, which is never older than what the other device installed (a
     *  deployment serves one build, so "the same version" can only mean "at least that one"). The rollout share does not apply:
     *  the person has already taken this version on another device. The person's own skip or postponement for the target does. */
    function followDecision(sync, id, running, manifest, o) {
        o = o || {};
        var none = function (why) { return { act: 'none', why: why }; };
        if (o.on === false) return none('off');
        var w = plainObj(sync) ? parseWanted(sync.wanted) : null;
        if (!w) return none('no-target');
        var run = validVersion(running);
        if (!run || cmp(w.v, run) <= 0) return none('current');
        if (w.by === id) return none('self');
        var now = Number(o.now) || 0;
        if (now && now - w.at > ACCOUNT_STALE_DAYS * DAY) return none('stale');
        var target = validVersion(manifest && manifest.latest);
        if (!target || cmp(target, w.v) < 0) return none('not-deployed');
        if (isHalted(target, manifest)) return none('halted');
        var c = activeChoice(o.choice, target, priorityOf(target, manifest, o.type), now);
        if (c && c.action === 'skip') return none('skipped');
        if (c && c.action === 'later') return none('later');
        var d = parseDevice(sync.devices && sync.devices[w.by]);
        return { act: 'install', version: target, account: w.v, from: { id: w.by, name: (d && d.name) || 'another device' }, why: 'account' };
    }
    /** The devices to show, this one first. Two devices with the same label get the end of their id so they can be told apart. */
    function deviceList(sync, id, now) {
        var devices = plainObj(sync) && plainObj(sync.devices) ? sync.devices : {};
        var rows = Object.keys(devices).map(function (k) { var d = parseDevice(devices[k]); return d ? { id: k, v: d.v, at: d.at, name: d.name || 'Device', isThis: k === id } : null; })
            .filter(function (r) { return r && (r.isThis || now - r.at <= DEVICE_SHOWN_DAYS * DAY); });
        var count = {};
        rows.forEach(function (r) { count[r.name] = (count[r.name] || 0) + 1; });
        rows.forEach(function (r) { if (count[r.name] > 1) r.name += ' (' + String(r.id).slice(-3) + ')'; });
        rows.sort(function (a, b) { return a.isThis ? -1 : b.isThis ? 1 : b.at - a.at; });
        var top = rows.reduce(function (m, r) { return !m || cmp(r.v, m) > 0 ? r.v : m; }, null);
        rows.forEach(function (r) { r.behind = !!top && cmp(r.v, top) < 0; });
        return rows;
    }

    /* ---------- history ---------- */

    function pushHistory(list, entry, max) {
        var out = (Array.isArray(list) ? list : []).concat([entry]);
        return out.slice(-(max || 30));
    }

    var API = {
        validVersion: validVersion, cmp: cmp,
        priorityOf: priorityOf, stanceOf: stanceOf, canSkip: canSkip, maxSnoozeDays: maxSnoozeDays,
        later: later, skip: skip, whenIdle: whenIdle, activeChoice: activeChoice,
        bucketOf: bucketOf, rolloutPercent: rolloutPercent, isHalted: isHalted, inRollout: inRollout,
        announce: announce, staleDays: staleDays,
        versionsBetween: versionsBetween, mergeNotes: mergeNotes,
        metered: metered, mayInstallAutomatically: mayInstallAutomatically,
        featureState: featureState, pushHistory: pushHistory, DAY: DAY,
        parseDevice: parseDevice, parseWanted: parseWanted, deviceLabel: deviceLabel, reportDevice: reportDevice, noteAgreed: noteAgreed, agreedOn: agreedOn,
        followDecision: followDecision, deviceList: deviceList
    };
    root.WF_UPDATE_POLICY = API;
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
})(typeof window !== 'undefined' ? window : globalThis);
