/* =============================================================================
 * test/pwa_update_test.js — PWA Self-Healing & Client Invalidation Test Suite
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('Service Worker (sw.js) Architecture & Safety', () => {
    const swPath = path.resolve('sw.js');
    const swContent = fs.readFileSync(swPath, 'utf8');

    it('implements self.skipWaiting() on install', () => {
        expect(swContent).toMatch(/self\.addEventListener\(['"]install['"]/);
        expect(swContent).toMatch(/self\.skipWaiting\(\)/);
    });

    it('claims clients and purges obsolete caches on activate', () => {
        expect(swContent).toMatch(/self\.addEventListener\(['"]activate['"]/);
        expect(swContent).toMatch(/caches\.delete/);
        expect(swContent).toMatch(/clients\.claim\(\)/);
    });

    it('listens for SKIP_WAITING message from client', () => {
        expect(swContent).toMatch(/event\.data\.type === ['"]SKIP_WAITING['"]/);
    });

    it('provides hard reset self-heal emergency mechanism', () => {
        expect(swContent).toMatch(/event\.data\.type === ['"]WF_HARD_RESET['"]/);
        expect(swContent).toMatch(/registration\.unregister\(\)/);
    });

    it('never caches API endpoints or version checks', () => {
        expect(swContent).toMatch(/\/api\//);
        expect(swContent).toMatch(/\/version\.json/);
    });
});

describe('PWA Updater (pwa-updater.js) Architecture & Invalidation', () => {
    const updaterPath = path.resolve('pwa-updater.js');
    const updaterContent = fs.readFileSync(updaterPath, 'utf8');

    it('exists and is properly formatted as a standalone module', () => {
        expect(fs.existsSync(updaterPath)).toBe(true);
        expect(updaterContent.length).toBeGreaterThan(500);
    });

    it('fetches version with no-store to prevent stale checks', () => {
        expect(updaterContent).toMatch(/cache:\s*['"]no-store['"]/);
    });

    it('sends SKIP_WAITING to waiting service worker on update', () => {
        expect(updaterContent).toMatch(/type:\s*['"]SKIP_WAITING['"]/);
    });

    it('includes anti-loop reload protection', () => {
        expect(updaterContent).toMatch(/MIN_RELOAD_GAP_MS/);
    });

    it('exposes public API window.wfPwaUpdater', () => {
        expect(updaterContent).toMatch(/window\.wfPwaUpdater\s*=/);
    });
});

describe('Vercel Ignore & Routing Protection', () => {
    const ignorePath = path.resolve('.vercelignore');
    const ignoreContent = fs.readFileSync(ignorePath, 'utf8');
    const vercelJsonPath = path.resolve('vercel.json');
    const vercelJson = JSON.parse(fs.readFileSync(vercelJsonPath, 'utf8'));

    it('.vercelignore ignores test directory, CI workflows, and heavy tooling', () => {
        expect(ignoreContent).toMatch(/^test\/$/m);
        expect(ignoreContent).toMatch(/^\.github\/$/m);
        expect(ignoreContent).toMatch(/^policy\/$/m);
        expect(ignoreContent).toMatch(/^autonomy\/$/m);
        expect(ignoreContent).toMatch(/^autonomous-fix-agent\.js$/m);
        expect(ignoreContent).toMatch(/^consensus-review\.mjs$/m);
    });

    it('vercel.json specifies no-store/no-cache headers for sw.js and version.json', () => {
        const headers = vercelJson.headers || [];
        const swHeader = headers.find(h => h.source && h.source.includes('sw'));
        expect(swHeader).toBeDefined();
        const noStore = swHeader.headers.some(kv => kv.key === 'Cache-Control' && kv.value.includes('no-cache'));
        expect(noStore).toBe(true);
    });
});
