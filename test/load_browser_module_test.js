/* The shared loader the autonomous fix agent (and anyone else) uses to test a browser module against
 * a real DOM. If this stops working, every generated proving test for a UI change fails at the proof
 * stage again, so the loader is itself tested: against the real Software Update module, with the
 * assertions a person would make (what the Settings card says), not "it did not throw".
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const RUNNING = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')).version;

describe('loadBrowserModule', () => {
    it('runs the real update-system module and renders the Settings card into a real DOM', () => {
        const { window, document } = loadBrowserModule('wealthflow-update-system.js', {
            html: '<div id="wfUpdateCard"></div>',
        });
        expect(typeof window.wfUpdate.refresh).toBe('function');
        window.wfUpdate.refresh();
        const card = document.getElementById('wfUpdateCard');
        expect(card.querySelector('.settings-title').textContent).toBe('Software Update');
        expect(card.textContent).toMatch(/Current version/);
        expect(card.textContent).toMatch(/WealthFlow v\d+\.\d+\.\d+/);
        expect(card.textContent).toMatch(/Send Feedback/);
    });

    it('shows the build that is running, even when localStorage remembers a newer one', () => {
        const { window, document, localStorage } = loadBrowserModule('wealthflow-update-system.js', {
            html: '<div id="wfUpdateCard"></div>',
            localStorage: { wf_installed_version: '99.1.2' },
        });
        window.wfUpdate.refresh();
        const text = document.getElementById('wfUpdateCard').textContent;
        expect(text).toContain('WealthFlow v' + RUNNING);
        expect(text).not.toContain('99.1.2');
        expect(localStorage.getItem('wf_installed_version')).toBe(RUNNING);
    });

    it('gives every call its own window: nothing leaks between two loads', () => {
        const a = loadBrowserModule('wealthflow-update-system.js', { html: '<div id="wfUpdateCard"></div>' });
        const b = loadBrowserModule('wealthflow-update-system.js', { html: '<div id="wfUpdateCard"></div>' });
        a.localStorage.setItem('only-in-a', '1');
        a.document.getElementById('wfUpdateCard').textContent = 'marker';
        expect(b.localStorage.getItem('only-in-a')).toBeNull();
        expect(b.document.getElementById('wfUpdateCard').textContent).toBe('');
        expect(a.window).not.toBe(b.window);
        expect(a.window.wfUpdate).not.toBe(b.window.wfUpdate);
    });

    it('a missing file is an error, not a silent empty window', () => {
        expect(() => loadBrowserModule('no-such-module.js')).toThrow();
    });
});

// Requirement 8 of the owner's brief: a NEW sign-up starts on the newest version, so it is not shown a "what changed" sheet;
// an update (the stored welcome mark cleared to '') still is.
describe('the welcome sheet after an update', () => {
    afterEach(() => { vi.useRealTimers(); });
    // the manifest the site really serves
    const MANIFEST = fs.readFileSync(path.join(import.meta.dirname, '..', 'version.json'), 'utf8');
    const site = async (url) => (/version\.json/.test(String(url))
        ? { ok: true, status: 200, json: async () => JSON.parse(MANIFEST), text: async () => MANIFEST }
        : { ok: false, status: 404, json: async () => ({}), text: async () => '' });
    const boot = async (localStorage) => {
        vi.useFakeTimers();
        const m = loadBrowserModule('wealthflow-update-system.js', { html: '<div id="app" class="show"></div>', localStorage, fetchImpl: site });
        await vi.advanceTimersByTimeAsync(4000);
        return m;
    };

    it('is NOT shown to a brand-new install, and that build is marked as seen', async () => {
        const { document, localStorage } = await boot({});
        expect(document.getElementById('wfPostUpdate')).toBeNull();
        expect(localStorage.getItem('wf_update_popup_seen')).toBe(RUNNING);
    });

    it('IS shown after an update (the flow clears the mark to an empty string)', async () => {
        const { document } = await boot({ wf_update_popup_seen: '', wf_installed_version: '7.60.0' });
        const o = document.getElementById('wfPostUpdate');
        expect(o).not.toBeNull();
        expect(o.textContent).toContain('Welcome to v' + RUNNING);
        expect(o.textContent).toMatch(/Return to Dashboard/);
    });

    it('is shown once: closing it records the build, and a restart does not show it again', async () => {
        const first = await boot({ wf_update_popup_seen: '' });
        expect(first.document.getElementById('wfPostUpdate')).not.toBeNull();
        first.window.wfUpdate._closePost && first.window.wfUpdate._closePost();
        const again = await boot({ wf_update_popup_seen: first.localStorage.getItem('wf_update_popup_seen') });
        expect(again.document.getElementById('wfPostUpdate')).toBeNull();
    });
});
