/* =============================================================================
 * test/update_manifest_merge_test.js — a stalled database record must never
 * hide shipped code from users
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * `_loadManifest()` returned the moment the Firestore manifest had a `latest`:
 *
 *     const doc = await db.collection('system').doc('manifest').get();
 *     if (m && m.latest) { _manifest = m; return _manifest; }
 *     // …version.json below was never reached
 *
 * So `system/manifest` was a single point of failure for the entire update
 * pathway. If the release brain stopped writing it — or wrote it once and froze
 * — the document kept answering with an old version forever,
 * `_updateAvailable()` compared against that old number, and every user was
 * told they were up to date while newer code sat on the server.
 *
 * The direction of the failure is what makes it serious. A MISSING manifest is
 * obvious: the client falls through to version.json and carries on. A STALE one
 * is indistinguishable from a healthy one, and it suppresses rather than
 * over-reports — nobody files a bug for an update they were never offered.
 *
 * This is the same family as everything else fixed in this session: not a
 * crash, but a component answering confidently with the wrong thing while every
 * indicator stays green.
 *
 * THE FIX
 *
 * Both sources are read on every check, in parallel, and `latest` is the
 * MAXIMUM of the two. Neither can mask the other, and either can answer alone.
 *
 * HOW THIS FILE TESTS A BROWSER IIFE
 *
 * wealthflow-update-system.js is a classic <script>, not a module — there is
 * nothing to import. The pure helpers are lifted out of the shipped source and
 * evaluated, so these assertions run against the bytes that reach the browser
 * rather than a copy written for the test. Getting this wrong is a live risk in
 * this repo: an earlier test in this session re-implemented the algorithm it
 * claimed to check and passed against a version that was still broken.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

/** Lift a named function out of the shipped file, verbatim. */
function lift(name) {
    const re = new RegExp(`\\n    function ${name}\\([\\s\\S]*?\\n    \\}`);
    const m = SRC.match(re);
    if (!m) throw new Error(`could not lift ${name}() from the shipped source`);
    return m[0];
}

// `_cmp` is a one-liner and the others depend on it, so it comes along too.
const CMP = (SRC.match(/\n    function _cmp\(a,b\)\{.*\}/) || [])[0];

const evaluated = new Function(`
    ${CMP}
    ${lift('_validVersion')}
    ${lift('_maxVersion')}
    ${lift('_mergeManifests')}
    return { _cmp, _validVersion, _maxVersion, _mergeManifests };
`)();
const { _cmp, _validVersion, _maxVersion, _mergeManifests } = evaluated;

const local = (latest, over) => Object.assign({ latest, mandatory: [], notes: {} }, over || {});
const remote = local;

describe('the lift actually got the shipped code', () => {
    it('found all three helpers and _cmp', () => {
        // Without this the whole file could pass against an empty sandbox.
        for (const f of [_cmp, _validVersion, _maxVersion, _mergeManifests]) {
            expect(typeof f).toBe('function');
        }
    });

    it('is reading the real file, not a stub', () => {
        expect(SRC.length).toBeGreaterThan(10000);
        expect(SRC).toMatch(/_loadLocalManifest/);
        expect(SRC).toMatch(/_loadRemoteManifest/);
    });
});

describe('THE BUG: a frozen remote manifest cannot hide a shipped version', () => {
    it('takes the local version when the remote has stalled', () => {
        // The exact scenario: brain stopped writing months ago, releases kept
        // shipping. Before the fix this resolved to 7.13.1 and every user was
        // told they were current.
        const m = _mergeManifests(local('7.69.30'), remote('7.13.1'));
        expect(m.latest).toBe('7.69.30');
    });

    it('still lets an approved remote announcement lead the static file', () => {
        // The reverse must keep working: approve-release.js can announce a
        // version with no redeploy, so the remote is allowed to be ahead.
        const m = _mergeManifests(local('7.69.24'), remote('7.70.0'));
        expect(m.latest).toBe('7.70.0');
    });

    it('agrees with itself when both sources agree', () => {
        expect(_mergeManifests(local('7.69.24'), remote('7.69.24')).latest).toBe('7.69.24');
    });
});

describe('either source can answer alone', () => {
    it('works with no remote at all — Firestore down, offline, no permission', () => {
        expect(_mergeManifests(local('7.69.30'), null).latest).toBe('7.69.30');
    });

    it('works with no local at all — version.json fetch failed', () => {
        expect(_mergeManifests(null, remote('7.70.0')).latest).toBe('7.70.0');
    });

    it('answers null when it genuinely knows nothing', () => {
        // Null is correct here: _latestVersion() then falls back to
        // CURRENT_VERSION and claims no update, which is the honest answer.
        expect(_mergeManifests(null, null)).toBe(null);
        expect(_mergeManifests({}, {})).toBe(null);
    });
});

describe('malformed input cannot win the comparison', () => {
    it('ignores junk versions rather than ranking them', () => {
        for (const junk of ['latest', '', '7.69', 'v7.70.0', null, undefined, 42, {}]) {
            const m = _mergeManifests(local('7.69.24'), { latest: junk });
            expect(m && m.latest, `junk "${JSON.stringify(junk)}" beat a real version`).toBe('7.69.24');
        }
    });

    it('_validVersion accepts only a real triple', () => {
        expect(_validVersion('7.69.24')).toBe('7.69.24');
        expect(_validVersion('  7.69.24  ')).toBe('7.69.24');
        expect(_validVersion('7.69')).toBe(null);
        expect(_validVersion('7.69.24-rc1')).toBe(null);
        expect(_validVersion(7)).toBe(null);
    });

    it('_maxVersion compares numerically, not as strings', () => {
        // '7.9.0' > '7.10.0' lexically. This is the comparison the whole
        // update prompt hangs on.
        expect(_maxVersion('7.9.0', '7.10.0')).toBe('7.10.0');
        expect(_maxVersion('7.69.9', '7.69.23')).toBe('7.69.23');
    });
});

describe('mandatory is a union, and stays clean', () => {
    it('keeps a flag from either source', () => {
        expect(_mergeManifests(local('7.70.0', { mandatory: ['7.70.0'] }), remote('7.69.24')).mandatory)
            .toContain('7.70.0');
        expect(_mergeManifests(local('7.69.24'), remote('7.70.0', { mandatory: ['7.70.0'] })).mandatory)
            .toContain('7.70.0');
    });

    it('deduplicates when both flag the same version', () => {
        const m = _mergeManifests(
            local('7.70.0', { mandatory: ['7.70.0'] }),
            remote('7.70.0', { mandatory: ['7.70.0'] }),
        );
        expect(m.mandatory).toEqual(['7.70.0']);
    });

    it('drops junk entries instead of carrying them into _isMandatory', () => {
        const m = _mergeManifests(local('7.70.0', { mandatory: ['7.70.0', null, 'x', 7] }), null);
        expect(m.mandatory).toEqual(['7.70.0']);
    });

    it('survives a missing or malformed mandatory field', () => {
        expect(_mergeManifests({ latest: '7.70.0' }, { latest: '7.69.0' }).mandatory).toEqual([]);
    });
});

describe('notes follow the resolved version, whichever source knows them', () => {
    it('THE POINT: a version only the local file knows still has notes', () => {
        // If the remote froze and the local shipped 7.69.30, the update prompt
        // must be able to say what changed. Otherwise the fix trades a silent
        // suppression for an empty What's New.
        const m = _mergeManifests(
            local('7.69.30', { notes: { '7.69.30': 'shipped while the brain was down' } }),
            remote('7.13.1', { notes: { '7.13.1': 'ancient' } }),
        );
        expect(m.latest).toBe('7.69.30');
        expect(m.notes['7.69.30']).toBe('shipped while the brain was down');
    });

    it('the approved remote note wins for a version both describe', () => {
        // Preserves the behaviour this file had whenever the remote existed:
        // the owner-approved announcement is the one users read.
        const m = _mergeManifests(
            local('7.70.0', { notes: { '7.70.0': 'derived from the diff' } }),
            remote('7.70.0', { notes: { '7.70.0': 'approved announcement' } }),
        );
        expect(m.notes['7.70.0']).toBe('approved announcement');
    });

    it('keeps history from both sides rather than replacing it', () => {
        const m = _mergeManifests(
            local('7.70.0', { notes: { '7.69.0': 'a', '7.70.0': 'b' } }),
            remote('7.69.0', { notes: { '7.68.0': 'c' } }),
        );
        expect(Object.keys(m.notes).sort()).toEqual(['7.68.0', '7.69.0', '7.70.0']);
    });

    it('never throws on a missing notes object', () => {
        expect(() => _mergeManifests({ latest: '7.70.0' }, { latest: '7.69.0' })).not.toThrow();
        expect(_mergeManifests({ latest: '7.70.0' }, null).notes).toEqual({});
    });
});

describe('the loader consults both sources, and cannot return early on one', () => {
    /* Source-level assertions: the merge above is only correct if both inputs
     * actually get fetched. The original defect was precisely an early return,
     * so a perfect merge function reached with one argument always null would
     * still be broken. */
    const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '')
        .split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');

    it('fetches them in parallel, not one-then-maybe-the-other', () => {
        expect(CODE).toMatch(/Promise\.all\(\[_loadLocalManifest\(\), _loadRemoteManifest\(\)\]\)/);
    });

    it('no longer returns the remote manifest directly', () => {
        // The deleted line was: if (m && m.latest) { _manifest = m; return _manifest; }
        expect(CODE, 'the early return is back — version.json is unreachable again')
            .not.toMatch(/_manifest = m;\s*return _manifest/);
    });

    it('routes every non-inline result through the merge', () => {
        expect(CODE).toMatch(/_manifest = _mergeManifests\(both\[0\], both\[1\]\)/);
    });

    it('still bypasses the service-worker cache on the local fetch', () => {
        // sw.js:47 excludes /version.json for this reason; the no-store here is
        // the client half of that agreement. A cached version.json would
        // reintroduce the stale-source bug from the other direction.
        expect(CODE).toMatch(/fetch\('version\.json\?_=' \+ Date\.now\(\), \{ cache: 'no-store' \}\)/);
    });

    it('the comment-stripper did not gut the file it is scanning', () => {
        expect(CODE).toMatch(/function _loadManifest/);
        expect(CODE.length).toBeGreaterThan(5000);
    });
});
