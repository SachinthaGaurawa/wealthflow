/* =============================================================================
 * test/release_version_floor_test.js — the brain may never announce a version
 * older than the one already shipping
 * -----------------------------------------------------------------------------
 * WHAT HAPPENED
 *
 * On its FIRST EVER successful run (2026-08-16 13:25 UTC, Auto Release #85),
 * release-brain.js wrote this to production Firestore:
 *
 *     "wrote": ["feedbackPriority", "pendingRelease", "manifest(urgent 7.13.1)"]
 *
 * The app was on **v7.69.23**. It announced **v7.13.1** — 56 patch releases in
 * the past — and pushed it onto `system/manifest.mandatory`.
 *
 * The cause:
 *
 *     let curVersion = '7.13.0';
 *     try { const m = await db.collection('system').doc('manifest').get();
 *           if (m.exists && m.data().latest) curVersion = m.data().latest; } catch (_) {}
 *     const nextVersion = bumpPatch(curVersion);
 *
 * `system/manifest` had never been written, because the brain had never run —
 * it called `require()` inside an ESM module and died on its first statement
 * (see test/esm_require_test.js). So the read found nothing, `curVersion` kept
 * a constant that was stale by two months, and bumpPatch produced 7.13.1.
 *
 * A LATENT BUG THAT COULD ONLY FIRE ONCE THE OTHER BUG WAS FIXED. Every guard
 * in this repository assumed the brain worked; nothing checked what it would do
 * the first time it did.
 *
 * USER IMPACT, measured against the real client rather than assumed:
 * wealthflow-update-system.js gates the update prompt on
 * `_cmp(latest, installed) > 0`, and 7.13.1 < 7.69.23, so the prompt was
 * correctly suppressed. But `_renderCard` computes
 * `avail = _updateAvailable() || !!_swWaiting` — and a browser holding a
 * waiting service-worker update satisfies the second clause. Those users saw a
 * red "Required security update — please install to keep your finances
 * protected." banner labelled **v7.13.1**, because `_isMandatory` found that
 * string in the array the brain had just written.
 *
 * The fix is two guards, because one was demonstrably not enough:
 *   1. version.json is the source of truth — release.cjs enforces it across
 *      seven files. The manifest is a cache, not the record.
 *   2. Take the MAXIMUM of the two, so a stale or corrupted manifest can only
 *      ever be corrected upward.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import { cmpVer, shippedVersion, resolveCurrentVersion, pruneMandatory } from '../release-brain.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'version.json'), 'utf8')).latest;

describe('cmpVer compares versions numerically', () => {
    it('orders the versions from the incident correctly', () => {
        expect(cmpVer('7.13.1', '7.69.23')).toBeLessThan(0);
        expect(cmpVer('7.69.23', '7.13.1')).toBeGreaterThan(0);
        expect(cmpVer('7.69.23', '7.69.23')).toBe(0);
    });

    it('is not a string comparison', () => {
        // The trap that makes "7.9.0 > 7.10.0" look true.
        expect(cmpVer('7.9.0', '7.10.0')).toBeLessThan(0);
        expect(cmpVer('7.69.9', '7.69.23')).toBeLessThan(0);
    });

    it('treats junk as zero rather than throwing', () => {
        expect(() => cmpVer(null, undefined)).not.toThrow();
        expect(cmpVer('', '')).toBe(0);
        expect(cmpVer('1.0.0', '')).toBeGreaterThan(0);
    });
});

describe('the shipped version comes from version.json', () => {
    it('reads the file release.cjs actually enforces', () => {
        // Not a constant in the source. That constant is what went stale.
        expect(shippedVersion()).toBe(SHIPPED);
        expect(shippedVersion()).toMatch(/^\d+\.\d+\.\d+$/);
    });

    it('is nowhere near the hardcoded fallback any more', () => {
        // Guards the guard: if version.json ever reverted to 7.13.x this test
        // would pass for the wrong reason, so assert the gap explicitly.
        expect(cmpVer(SHIPPED, '7.13.0'), 'version.json regressed to the stale constant').toBeGreaterThan(0);
    });
});

describe('resolveCurrentVersion never moves backwards', () => {
    it('REPRODUCES THE INCIDENT and answers correctly now', () => {
        // shipped 7.69.23, manifest absent → old code used '7.13.0' → 7.13.1.
        expect(resolveCurrentVersion('7.69.23', null)).toBe('7.69.23');
    });

    it('ignores a manifest that is behind the shipped code', () => {
        // This is the state production is in right now: manifest.latest is
        // 7.13.1 while the app is 7.69.23. The next run must correct it upward,
        // not continue counting from 7.13.1.
        expect(resolveCurrentVersion('7.69.23', '7.13.1')).toBe('7.69.23');
    });

    it('accepts a manifest that is genuinely ahead', () => {
        // A release announced but not yet reflected in this checkout's
        // version.json is legitimate — take the newer one.
        expect(resolveCurrentVersion('7.69.23', '7.70.0')).toBe('7.70.0');
    });

    it('falls back to whichever single source it has', () => {
        expect(resolveCurrentVersion(null, '7.70.0')).toBe('7.70.0');
        expect(resolveCurrentVersion('7.69.23', undefined)).toBe('7.69.23');
    });

    it('rejects malformed input rather than trusting it', () => {
        expect(resolveCurrentVersion('not-a-version', '7.69.23')).toBe('7.69.23');
        expect(resolveCurrentVersion('7.69.23', 'latest')).toBe('7.69.23');
        expect(resolveCurrentVersion('7.69', '7.69.23')).toBe('7.69.23');
    });

    it('only reaches the last-resort constant when it knows nothing at all', () => {
        expect(resolveCurrentVersion(null, null)).toBe('7.13.0');
    });

    it('always produces a next version ahead of what is shipping', () => {
        // The property that actually matters, stated directly.
        for (const manifestValue of [null, '7.13.1', '1.0.0', 'garbage', SHIPPED]) {
            const cur = resolveCurrentVersion(SHIPPED, manifestValue);
            expect(cmpVer(cur, SHIPPED), `manifest=${manifestValue} resolved to ${cur}, behind ${SHIPPED}`)
                .toBeGreaterThanOrEqual(0);
        }
    });
});

describe('pruneMandatory clears versions that can never be pending', () => {
    it('drops the bogus 7.13.1 this bug wrote into production', () => {
        expect(pruneMandatory(['7.13.1'], '7.69.23')).toEqual([]);
    });

    it('keeps a genuinely future mandatory version', () => {
        expect(pruneMandatory(['7.13.1', '7.70.1'], '7.69.23')).toEqual(['7.70.1']);
    });

    it('drops the current version too — you cannot update to what you have', () => {
        expect(pruneMandatory(['7.69.23'], '7.69.23')).toEqual([]);
    });

    it('deduplicates and survives junk', () => {
        expect(pruneMandatory(['7.70.1', '7.70.1', null, 42, 'x'], '7.69.23')).toEqual(['7.70.1']);
        expect(pruneMandatory(null, '7.69.23')).toEqual([]);
        expect(pruneMandatory(undefined, '7.69.23')).toEqual([]);
    });
});

describe('the client contract this protects is still what it was', () => {
    /* These assertions are about wealthflow-update-system.js, not the brain.
     * They record WHY a stale `latest` was user-visible, so that if the client
     * changes shape the reasoning above is re-examined rather than trusted. */
    const client = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

    it('still suppresses the prompt when latest is older than installed', () => {
        expect(client).toMatch(/_cmp\(_latestVersion\(\),\s*installed\)\s*>\s*0/);
    });

    it('still renders the card on a waiting service worker alone', () => {
        // This is the clause that made the bogus version visible despite the
        // comparison above being correct.
        expect(client).toMatch(/_updateAvailable\(\)\s*\|\|\s*!!_swWaiting/);
    });

    it('still treats membership of manifest.mandatory as authoritative', () => {
        expect(client).toMatch(/_manifest\.mandatory\.indexOf\(v\)\s*>=\s*0/);
    });
});
