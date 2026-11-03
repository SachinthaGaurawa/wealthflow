/* The restore point taken before an update is recorded as it came out, and nothing claims more than that.
 *
 * WHAT WAS WRONG (found auditing the update journey against the "iOS-like" requirement, 2026-11-03):
 *   - the update flow called backupNow() and threw its answer away, so an update that was started signed out, offline or with
 *     nothing to back up looked exactly like one that had a restore point;
 *   - it also copied every wf2_ key into localStorage under wf_preupdate_snapshot, "so self-heal can roll data back". Nothing
 *     ever read that copy back. It doubled the space the app's own data takes (a full quota silently breaks saves) and made the
 *     diagnosis say "a pre-update backup exists";
 *   - the agreement said "your data is restored from the pre-update backup" when an update replaces app files and never touches
 *     data, and restoring is a manual step in Settings.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const boot = (globals = {}, seed = {}) => loadBrowserModule('wealthflow-update-system.js', { localStorage: seed, html: '', globals });
const recorded = (localStorage) => JSON.parse(localStorage.getItem('wf_preupdate_backup'));

describe('_preUpdateBackup', () => {
    it('records "saved" only when backupNow() says a copy exists afterwards', async () => {
        const calls = [];
        const { window, localStorage } = boot({ backupNow: async (silent, trigger) => { calls.push([silent, trigger]); return true; } });
        expect(await window.wfUpdate._preUpdateBackup('7.70.0')).toBe('saved');
        expect(calls).toEqual([[true, 'pre-update']]);
        expect(recorded(localStorage)).toMatchObject({ result: 'saved', target: '7.70.0' });
        expect(typeof recorded(localStorage).at).toBe('number');
    });

    it('records "not-saved" when backupNow() answers false (signed out, offline, nothing to back up)', async () => {
        const { window, localStorage } = boot({ backupNow: async () => false });
        expect(await window.wfUpdate._preUpdateBackup('7.70.0')).toBe('not-saved');
        expect(recorded(localStorage).result).toBe('not-saved');
    });

    it('records "not-saved" when backupNow() throws, when it answers something that is not true, and when it does not exist', async () => {
        for (const g of [{ backupNow: async () => { throw new Error('boom'); } }, { backupNow: async () => 'yes' }, { backupNow: async () => undefined }, {}]) {
            const { window, localStorage } = boot(g);
            expect(await window.wfUpdate._preUpdateBackup('7.70.0')).toBe('not-saved');
            expect(recorded(localStorage).result).toBe('not-saved');
        }
    });

    it('no longer copies every wf2_ key into a second place, and clears the copy older builds left', async () => {
        const seed = { wf2_transactions: JSON.stringify([{ a: 1 }]), wf2_settings: '{}', wf_preupdate_snapshot: JSON.stringify({ at: 1, data: { x: 'y' } }) };
        const { window, localStorage } = boot({ backupNow: async () => true }, seed);
        await window.wfUpdate._preUpdateBackup('7.70.0');
        expect(localStorage.getItem('wf_preupdate_snapshot')).toBe(null);
        expect(localStorage.getItem('wf2_transactions')).toBe(seed.wf2_transactions);   // the data itself is untouched
        expect(Object.keys(JSON.parse(localStorage.getItem('wf_preupdate_backup'))).sort()).toEqual(['at', 'result', 'target']);
    });
});

describe('the words around it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');
    it('the agreement does not promise an automatic restore that does not exist', () => {
        expect(src).not.toMatch(/your data is restored from the pre-update backup/);
        expect(src).toMatch(/An update replaces app files, never your data/);
    });
    it('the end of the flow says so when no restore point was saved', () => {
        expect(src).toMatch(/No restore point was saved first; an update never changes your data/);
    });
});

describe('the diagnosis reads the recorded result, not the old copy', () => {
    const verdict = (running, pre) => {
        const { window } = loadBrowserModule('wealthflow-diagnosis.js', {
            html: '', localStorage: pre ? { wf_preupdate_backup: JSON.stringify(pre) } : {},
            globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: running },
        });
        return window.WFDiagnosis.collect().chain.find((l) => l.id === 'install');
    };
    it('"saved" is stated with its age', () => {
        const l = verdict('7.70.0', { at: Date.now() - 5 * 60000, result: 'saved', target: '7.70.0' });
        expect(l.state).toBe('ok');
        expect(l.detail).toMatch(/restore point was saved before the last update/);
    });
    it('"not-saved" for the running build is a warning that says what to do', () => {
        const l = verdict('7.70.0', { at: Date.now() - 60000, result: 'not-saved', target: '7.70.0' });
        expect(l.state).toBe('warn');
        expect(l.detail).toMatch(/no restore point was saved before the last update/);
        expect(l.hint).toMatch(/Backup now/);
    });
    it('an old "not-saved" for another build is not held against this one', () => {
        expect(verdict('7.70.1', { at: Date.now() - 60000, result: 'not-saved', target: '7.70.0' }).state).toBe('ok');
    });
    it('the old snapshot key is not evidence of anything', () => {
        const { window } = loadBrowserModule('wealthflow-diagnosis.js', { html: '', localStorage: { wf_preupdate_snapshot: JSON.stringify({ at: Date.now(), data: {} }) }, globals: { setInterval: () => 0, setTimeout: () => 0, WF_APP_VERSION: '7.70.0' } });
        expect(window.WFDiagnosis.collect().chain.find((l) => l.id === 'install').detail).not.toMatch(/backup exists|restore point/);
    });
});
