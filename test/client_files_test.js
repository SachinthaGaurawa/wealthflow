// "Update available" must mean the phone's copy of the app changed
// (owner, 2026-11-06: "only the version numbers go up, one by one, and it says update").
// v7.69.52 changed feedback-triage.js and three wf-*.mjs files: server functions Vercel deploys on merge,
// nothing the phone loads. The gate counted them as user-facing and cut a release for an identical app.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { clientReachable, isServerOnlyFile } = require('../autonomy/client-files.cjs');
const { classifyDiff } = require('../autonomy/substantive.cjs');
const { describeRelease, touchesUserFacing } = require('../autonomy/release-notes.cjs');

function site(files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-site-'));
    for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
    return dir;
}

describe('which files does the phone load', () => {
    const dir = site({
        'index.html': '<script src="app-main.js"></script><link rel="stylesheet" href="look.css">',
        'sw.js': "importScripts('sw-extra.js');",
        'manifest.json': '{}',
        'app-main.js': "import('./lazy-chart.mjs'); fetch('/api/feedback-triage', {method:'POST'}); // see server-only-notes.js",
        'lazy-chart.mjs': 'export const x = 1;',
        'sw-extra.js': '',
        'look.css': '',
        'feedback-triage.js': "import { a } from './wf-helper-module.mjs'; export default () => a;",
        'wf-helper-module.mjs': 'export const a = 1;',
        'server-only-notes.js': '',
        'version.json': '{"notes":"Fix feedback-triage and wf-helper-module importing things"}',
    });
    const reach = clientReachable(dir);

    it('follows script tags, dynamic imports and the service worker, transitively', () => {
        for (const f of ['index.html', 'app-main.js', 'lazy-chart.mjs', 'sw-extra.js', 'look.css']) expect(reach.has(f)).toBe(true);
    });

    it('does not count a fetch to /api/<name> as the phone loading the server file', () => {
        expect(reach.has('feedback-triage.js')).toBe(false);
        expect(isServerOnlyFile('feedback-triage.js', reach)).toBe(true);
        expect(isServerOnlyFile('wf-helper-module.mjs', reach)).toBe(true);
    });

    it('does not count a file name inside a comment or inside release-note prose', () => {
        expect(reach.has('server-only-notes.js')).toBe(false);
        expect(reach.has('wf-helper-module.mjs')).toBe(false);
    });

    it('treats anything it cannot place as part of the app', () => {
        expect(isServerOnlyFile('look.css', reach)).toBe(false);
        expect(isServerOnlyFile('icons/logo.png', reach)).toBe(false);
        expect(isServerOnlyFile('app-main.js', reach)).toBe(false);
        expect(isServerOnlyFile('', reach)).toBe(false);
        expect(isServerOnlyFile('api/anything.js', reach)).toBe(true);
    });
});

describe('the real repository', () => {
    const reach = clientReachable(path.resolve(import.meta.dirname, '..'));
    it('knows the server modules of the feedback pipeline never reach the phone', () => {
        for (const f of ['feedback-triage.js', 'feedback-status.js', 'wf-feedback-language.mjs', 'wf-llm-router.mjs', 'wf-screenshot-reader.mjs']) {
            expect(isServerOnlyFile(f, reach), f).toBe(true);
        }
    });
    it('knows the pages and scripts the phone runs do reach it', () => {
        for (const f of ['index.html', 'sw.js', 'wealthflow-update-system.js', 'wealthflow-feedback-ai.js', 'wf-agent-fixes.css']) {
            expect(isServerOnlyFile(f, reach), f).toBe(false);
        }
    });
});

describe('the release gate uses it', () => {
    const diff = (file, add) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+${add}\n`;
    const only = (f) => /^(?:feedback-triage\.js|api\/.*)$/.test(f);

    it('a release made only of server changes is not an app update', () => {
        const r = classifyDiff(diff('feedback-triage.js', 'new') + diff('version.json', '1'), { isServerOnly: only });
        expect(r.substantive).toBe(false);
        expect(r.server).toEqual(['feedback-triage.js']);
        expect(r.reason).toMatch(/no change on the phone/);
    });

    it('a server change next to a page change is still an update, and the page file is what counts', () => {
        const r = classifyDiff(diff('feedback-triage.js', 'new') + diff('index.html', 'new'), { isServerOnly: only });
        expect(r.substantive).toBe(true);
        expect(r.substantiveFiles).toEqual(['index.html']);
    });

    it('without the scan every code change still counts (never silently skips an update)', () => {
        expect(classifyDiff(diff('feedback-triage.js', 'new')).substantive).toBe(true);
        expect(classifyDiff(diff('feedback-triage.js', 'new'), { isServerOnly: () => { throw new Error('boom'); } }).substantive).toBe(true);
    });

    it('release notes put a server-only change under the hood, not in "What changed for you"', () => {
        expect(touchesUserFacing(['feedback-triage.js'], only)).toBe(false);
        expect(touchesUserFacing(['feedback-triage.js'])).toBe(true);
        const n = describeRelease([
            { sha: 'a', subject: 'fix: the AI reads screenshots again (#523)', files: ['feedback-triage.js'] },
            { sha: 'b', subject: 'feat: marks fixed reports (#525)', files: ['wealthflow-feedback-ai.js'] },
        ], { isServerOnly: only });
        expect(n.userFacing).toBe(1);
        expect(n.internal).toBe(1);
    });
});
