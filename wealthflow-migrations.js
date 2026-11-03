/* wealthflow-migrations.js - changing the SHAPE of the books without being able to lose them (docs/data-migrations.md).
 * A migration is proved on a copy (same keys, same record count, same money, idempotent, reversible on its fixture) BEFORE any write,
 * written through DB.set only with a restore point of the touched keys already saved, read back, and put back from that restore point
 * if anything is off. A page that dies half way is put back on the next launch. A failed migration is not retried on the same build.
 * The registry below is EMPTY today, so run() does nothing. Editing this file needs a human's approval (a migration rewrites the books). */
(function () {
    'use strict';

    var LS_LEDGER = 'wf_migrations';           // { applied:{id:{at,build,cloudBackup}}, failed:{id:{at,build,why}}, undone:{id:at} }
    var LS_SNAP = 'wf_migration_snapshot';     // { id, at, status:'in-progress'|'applied'|'refused'|'reverted'|'revert-failed', before:{key:value} }
    var MAX_SNAPSHOT = 1500000;                // characters. localStorage is about 5 MB and the books live there too
    var BACKUP_WAIT_MS = 8000;
    var ID_RE = /^\d{4}-\d{2}-\d{2}-[a-z0-9][a-z0-9-]*$/;

    /* THE REGISTRY. Append a migration; never edit one that has shipped (write a new one). Shape:
     *   { id:'2026-11-05-split-memo', touches:['transactions'],
     *     up:function (data) { ...; return data; }, down:function (data) { ...; return data; },     // data = { key: value } copies
     *     fixture:{ transactions:[...] },          // old-shaped sample; up/down are proved on it before the migration may ship
     *     countMayChange:false, moneyMayChange:false, moneyFields:['amount'], check:function (before, after) { return true; } }  */
    var MIGRATIONS = [];

    // ── small, pure helpers ────────────────────────────────────────────────
    function clone(v) { return v === undefined ? null : JSON.parse(JSON.stringify(v)); }
    function same(a, b) { try { return JSON.stringify(a) === JSON.stringify(b); } catch (_) { return false; } }
    function isArr(v) { return Object.prototype.toString.call(v) === '[object Array]'; }
    function money(arr, fields) {
        var t = 0;
        for (var i = 0; i < arr.length; i++) {
            var r = arr[i];
            if (!r || typeof r !== 'object') continue;
            for (var j = 0; j < fields.length; j++) { var n = Number(r[fields[j]]); if (isFinite(n)) t += Math.abs(n); }
        }
        return Math.round(t * 100) / 100;
    }
    function keysOf(o) { return Object.keys(o || {}).sort(); }

    /** What differs between two states of the touched keys, in words. Empty means they hold the same records and the same money. */
    function invariantProblems(before, after, m) {
        var out = [];
        var fields = (m && m.moneyFields && m.moneyFields.length) ? m.moneyFields : ['amount'];
        if (!same(keysOf(before), keysOf(after))) { out.push('the result has other keys than the ones declared (' + keysOf(after).join(',') + ')'); return out; }
        keysOf(before).forEach(function (k) {
            var b = before[k], a = after[k];
            if (isArr(b) && isArr(a)) {
                if (!(m && m.countMayChange) && b.length !== a.length) out.push(k + ': ' + b.length + ' records became ' + a.length);
                if (!(m && m.moneyMayChange)) {
                    var mb = money(b, fields), ma = money(a, fields);
                    if (mb !== ma) out.push(k + ': the money changed (' + mb + ' became ' + ma + ')');
                }
            } else if (isArr(b) !== isArr(a)) out.push(k + ': a list became something else');
        });
        return out;
    }

    /** Everything that must hold before a migration may ship. Pure; also run by the test suite over the registry. */
    function checkMigration(m) {
        var p = [];
        if (!m || typeof m !== 'object') return ['not an object'];
        if (typeof m.id !== 'string' || !ID_RE.test(m.id)) p.push('id must look like 2026-11-05-short-name');
        if (!isArr(m.touches) || !m.touches.length || m.touches.some(function (k) { return typeof k !== 'string' || !k; })) p.push('touches must list the keys it changes');
        else if (m.touches.filter(function (k, i) { return m.touches.indexOf(k) !== i; }).length) p.push('touches lists a key twice');
        if (typeof m.up !== 'function') p.push('up is missing');
        if (typeof m.down !== 'function') p.push('down is missing: a migration that cannot go back does not ship');
        if (!m.fixture || typeof m.fixture !== 'object') p.push('fixture is missing: up and down are proved on it');
        if (p.length) return p;
        for (var i = 0; i < m.touches.length; i++) if (!(m.touches[i] in m.fixture)) p.push('fixture has no ' + m.touches[i]);
        if (p.length) return p;
        try {
            var fx = {}; m.touches.forEach(function (k) { fx[k] = clone(m.fixture[k]); });
            var up = m.up(clone(fx));
            if (!up || typeof up !== 'object') return ['up returned nothing'];
            JSON.stringify(up);
            invariantProblems(fx, up, m).forEach(function (x) { p.push('on the fixture, ' + x); });
            if (typeof m.check === 'function' && m.check(clone(fx), clone(up)) !== true) p.push('its own check refused the fixture result');
            if (!same(m.up(clone(up)), up)) p.push('up is not idempotent: running it twice changed the result again');
            if (!same(m.down(clone(up)), fx)) p.push('down does not give the fixture back exactly');
        } catch (e) { p.push('threw on the fixture: ' + String((e && e.message) || e)); }
        return p;
    }

    // ── ledger and restore point ───────────────────────────────────────────
    function readJSON(k, fallback) { try { var s = localStorage.getItem(k); return s ? JSON.parse(s) : fallback; } catch (_) { return fallback; } }
    function writeJSON(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (_) { return false; } }
    function ledger() { var l = readJSON(LS_LEDGER, null) || {}; return { applied: l.applied || {}, failed: l.failed || {}, undone: l.undone || {} }; }
    function build() { return String(window.WF_APP_VERSION || ''); }
    function log(m) { try { console.log('[Migrate] ' + m); } catch (_) {} }

    function defaultStore() {
        var DB = window.DB;
        if (!DB || typeof DB.get !== 'function' || typeof DB.set !== 'function') return null;
        return { get: function (k) { return DB.get(k, null); }, set: function (k, v) { DB.set(k, v); } };
    }
    function readTouched(store, keys) { var o = {}; keys.forEach(function (k) { o[k] = clone(store.get(k)); }); return o; }
    function writeFailed(id, why) { var l = ledger(); l.failed[id] = { at: Date.now(), build: build(), why: String(why).slice(0, 300) }; writeJSON(LS_LEDGER, l); }

    /** Put the saved keys back and read them again. Returns '' when they are back, else what is still wrong. */
    function restore(store, before, m) {
        var bad = [];
        Object.keys(before).forEach(function (k) { try { store.set(k, clone(before[k])); } catch (e) { bad.push(k + ' could not be written back: ' + ((e && e.message) || e)); } });
        try {
            var now = readTouched(store, Object.keys(before));
            invariantProblems(before, now, { countMayChange: false, moneyMayChange: false, moneyFields: m && m.moneyFields }).forEach(function (x) { bad.push(x); });
        } catch (e) { bad.push('could not read back: ' + ((e && e.message) || e)); }
        return bad.join('; ');
    }

    function withTimeout(p, ms) { return new Promise(function (res) { var t = setTimeout(function () { res('not-saved'); }, ms); p.then(function (v) { clearTimeout(t); res(v); }, function () { clearTimeout(t); res('not-saved'); }); }); }
    function cloudBackup() {
        if (typeof window.backupNow !== 'function') return Promise.resolve('not-saved');
        try { return withTimeout(Promise.resolve(window.backupNow(true, 'pre-migration')).then(function (r) { return r === true ? 'saved' : 'not-saved'; }), BACKUP_WAIT_MS); } catch (_) { return Promise.resolve('not-saved'); }
    }

    // ── one migration, forward ─────────────────────────────────────────────
    async function apply(m, store) {
        var problems = checkMigration(m);
        if (problems.length) { writeFailed(m && m.id || '(no id)', 'invalid: ' + problems[0]); return { id: m && m.id, result: 'invalid', why: problems.join('; ') }; }
        var before = readTouched(store, m.touches);
        for (var i = 0; i < m.touches.length; i++) if (before[m.touches[i]] === null) return { id: m.id, result: 'waiting-for-data', why: m.touches[i] + ' is not there yet' };
        var snapText = JSON.stringify({ id: m.id, at: Date.now(), status: 'in-progress', before: before });
        if (snapText.length > MAX_SNAPSHOT) { writeFailed(m.id, 'too large to keep a restore point'); return { id: m.id, result: 'skipped', why: 'too-large' }; }
        try { localStorage.setItem(LS_SNAP, snapText); } catch (_) { writeFailed(m.id, 'no room for a restore point'); return { id: m.id, result: 'skipped', why: 'no-restore-point' }; }
        var cloud = await cloudBackup();

        // 3. up, on a copy, and everything proved before a single write
        var after;
        try {
            after = m.up(clone(before));
            if (!after || typeof after !== 'object') throw new Error('up returned nothing');
            after = clone(after);
            var bad = invariantProblems(before, after, m);
            if (!bad.length && typeof m.check === 'function' && m.check(clone(before), clone(after)) !== true) bad.push('its own check refused the result');
            if (!bad.length && !same(m.up(clone(after)), after)) bad.push('up is not idempotent on this data');
            if (bad.length) throw new Error(bad.join('; '));
        } catch (e) {
            var why = String((e && e.message) || e);
            writeFailed(m.id, why);
            writeJSON(LS_SNAP, { id: m.id, at: Date.now(), status: 'refused', before: before, note: 'nothing was written' });
            log(m.id + ' refused, nothing was written: ' + why);
            return { id: m.id, result: 'refused', why: why };
        }

        // 4. write, then read back
        var failure = '';
        try {
            m.touches.forEach(function (k) { store.set(k, clone(after[k])); });
            var back = readTouched(store, m.touches);
            invariantProblems(after, back, m).forEach(function (x) { failure += (failure ? '; ' : '') + 'after writing, ' + x; });
        } catch (e) { failure = 'a write failed: ' + String((e && e.message) || e); }
        if (failure) {
            var left = restore(store, before, m);
            writeJSON(LS_SNAP, { id: m.id, at: Date.now(), status: left ? 'revert-failed' : 'reverted', before: before, note: failure });
            writeFailed(m.id, failure + (left ? ' | REVERT INCOMPLETE: ' + left : ''));
            log(m.id + (left ? ' FAILED AND COULD NOT BE FULLY REVERTED: ' + left : ' failed and was reverted: ' + failure));
            return { id: m.id, result: left ? 'revert-failed' : 'reverted', why: failure + (left ? ' | ' + left : '') };
        }
        var l = ledger(); l.applied[m.id] = { at: Date.now(), build: build(), cloudBackup: cloud }; delete l.failed[m.id]; delete l.undone[m.id];
        writeJSON(LS_LEDGER, l);
        writeJSON(LS_SNAP, { id: m.id, at: Date.now(), status: 'applied', before: before });
        log(m.id + ' applied (' + m.touches.join(', ') + '; cloud backup ' + cloud + ')');
        return { id: m.id, result: 'applied', cloudBackup: cloud };
    }

    /** A page that died after the first write leaves its restore point "in-progress". Put it back before anything else runs. */
    function recoverInterrupted(store) {
        var snap = readJSON(LS_SNAP, null);
        if (!snap || snap.status !== 'in-progress' || !snap.before) return null;
        var m = null; MIGRATIONS.forEach(function (x) { if (x.id === snap.id) m = x; });
        var left = restore(store, snap.before, m);
        writeJSON(LS_SNAP, { id: snap.id, at: Date.now(), status: left ? 'revert-failed' : 'reverted', before: snap.before, note: 'interrupted' });
        writeFailed(snap.id, 'the page closed in the middle of it' + (left ? ' | REVERT INCOMPLETE: ' + left : ''));
        log(snap.id + ' was interrupted; ' + (left ? 'could not be fully put back: ' + left : 'put back from its restore point'));
        return { id: snap.id, result: left ? 'revert-failed' : 'reverted-after-interruption', why: left };
    }

    /** Apply what is pending, oldest first, stopping at the first one that does not go through (later ones may rely on it). */
    async function run(opts) {
        var results = [];
        if (window._isDecoyMode === true) return results;
        var store = (opts && opts.store) || defaultStore();
        if (!store) return results;
        var rec = recoverInterrupted(store);
        if (rec) results.push(rec);
        var l = ledger();
        for (var i = 0; i < MIGRATIONS.length; i++) {
            var m = MIGRATIONS[i];
            if (l.applied[m.id] || l.undone[m.id]) continue;          // an undo is a decision: it is not quietly redone on the next launch
            if (l.failed[m.id] && l.failed[m.id].build === build()) { results.push({ id: m.id, result: 'not-retried', why: 'it failed on this build' }); break; }
            var r = await apply(m, store);
            results.push(r);
            if (r.result !== 'applied') break;
            l = ledger();
        }
        return results;
    }

    /** Take one applied migration back by its own `down`, with the same proof and the same revert-on-failure. */
    async function undo(id, opts) {
        var m = null; MIGRATIONS.forEach(function (x) { if (x.id === id) m = x; });
        var store = (opts && opts.store) || defaultStore();
        if (!m || !store) return { id: id, result: 'unknown' };
        if (!ledger().applied[id]) return { id: id, result: 'not-applied' };
        var before = readTouched(store, m.touches), after;
        try {
            after = clone(m.down(clone(before)));
            var bad = invariantProblems(before, after, m);
            if (bad.length) throw new Error(bad.join('; '));
        } catch (e) { return { id: id, result: 'refused', why: String((e && e.message) || e) }; }
        var failure = '';
        try { m.touches.forEach(function (k) { store.set(k, clone(after[k])); }); } catch (e) { failure = String((e && e.message) || e); }
        if (failure) { var left = restore(store, before, m); return { id: id, result: left ? 'revert-failed' : 'reverted', why: failure + (left ? ' | ' + left : '') }; }
        var l = ledger(); delete l.applied[id]; l.undone[id] = Date.now(); writeJSON(LS_LEDGER, l);
        log(id + ' undone');
        return { id: id, result: 'undone' };
    }

    function register(m) { var p = checkMigration(m); if (p.length) throw new Error('migration ' + (m && m.id) + ' refused: ' + p.join('; ')); MIGRATIONS.push(m); }
    function status() { var l = ledger(); return { registered: MIGRATIONS.map(function (m) { return m.id; }), applied: l.applied, failed: l.failed, undone: l.undone, snapshot: (function () { var s = readJSON(LS_SNAP, null); return s ? { id: s.id, status: s.status, at: s.at } : null; })() }; }

    window.WFMigrations = { run: run, undo: undo, register: register, status: status, list: function () { return MIGRATIONS.slice(); }, checkMigration: checkMigration, invariantProblems: invariantProblems, _apply: apply, _recover: recoverInterrupted };
})();
