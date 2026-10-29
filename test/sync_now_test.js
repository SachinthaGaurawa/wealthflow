/* =============================================================================
 * test/sync_now_test.js — "Sync now" syncs, and then everything on screen is current
 * -----------------------------------------------------------------------------
 * Reported 2026-10-29: tapping Sync now in the More sheet opened the AI Financial Advisor instead of syncing, and "when it syncs, everything
 * in the whole system has to refresh".
 *
 * THE CAUSE. The page has ONE document-level handler that sends the question in `data-q` to the advisor, and it matched ANY element with that
 * attribute. The More sheet's four quick buttons (Search, Sync now, Light mode, Sign out) used `data-q` too, so a tap on any of them also sent
 * "sync" (or "search", "theme", "signout") to the advisor as a question and opened the advisor page. The sync the button was for ran behind it.
 *
 * What is pinned here:
 *   - the sheet no longer uses the advisor's attribute, the advisor's handler only matches the advisor's own questions, and no other source file
 *     may use `data-q` without being on the short list of files that draw advisor questions (so the collision cannot come back);
 *   - the steps Sync now runs, in the order they have to happen, each with its own deadline, one failing never stopping the next;
 *   - the page lists every step, and the sync runs them through the one runner.
 * The real page is driven by test/e2e/sync-now.mjs.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { runRefresh, refreshNote, REFRESH } from '../wealthflow-sync-health.js';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const HTML = read('index.html');
const SHELL = read('wealthflow-shell.js');

describe('the advisor only hears its own questions', () => {
    it('the More sheet\'s quick buttons do not carry the advisor\'s attribute', () => {
        expect(SHELL).not.toMatch(/data-q\b/);
        for (const act of ['search', 'sync', 'theme', 'signout']) expect(SHELL).toContain('data-wf-act="' + act + '"');
        expect(SHELL).toContain("closest('[data-wf-act]')");
    });

    it('the one document-level advisor handler matches the advisor\'s pills and the briefing\'s asks, and nothing else', () => {
        const at = HTML.indexOf('if (!window._wfPillGlobalBound)');
        expect(at).toBeGreaterThan(0);
        const handler = HTML.slice(at, at + 1600);
        expect(handler).toContain("ev.target.closest('.ai-suggestion-pill, #aiBriefing [data-q]')");
        expect(handler).not.toMatch(/closest\('[^']*,\s*\[data-q\]'\)/);                    // the bare attribute selector that caused it
    });

    it('no other file draws data-q: a new one has to be added here, on purpose, after reading why', () => {
        const allowed = new Set(['index.html', 'wealthflow-advisor-briefing.js']);          // the advisor's pills (index.html) and the briefing's asks
        const offenders = [];
        const walk = (dir) => {
            for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
                if (['node_modules', '.git', 'test', 'docs', 'native', 'dist', 'public', '.github'].includes(e.name)) continue;
                const rel = path.join(dir, e.name);
                if (e.isDirectory()) { walk(rel); continue; }
                if (!/\.(js|mjs|html|css)$/.test(e.name)) continue;
                if (allowed.has(rel)) continue;
                if (/data-q\b/.test(fs.readFileSync(path.join(ROOT, rel), 'utf8'))) offenders.push(rel);
            }
        };
        walk('');
        expect(offenders).toEqual([]);
    });
});

describe('what Sync now runs', () => {
    const mk = (log, over = {}) => ({ id: 'x', label: 'x', phase: 'data', run: async () => { log.push(over.id || 'x'); }, ...over });

    it('pulls the account first and alone, then the rest together, then repaints in order', async () => {
        const log = [];
        const gate = {}; gate.p = new Promise((r) => { gate.go = r; });
        const steps = [
            { id: 'phone', label: 'phone', phase: 'data', run: async () => { log.push('phone:start'); await Promise.resolve(); log.push('phone:end'); } },
            { id: 'screens', label: 'screens', phase: 'paint', run: () => { log.push('screens'); } },
            { id: 'cloud', label: 'account', phase: 'data', first: true, run: async () => { log.push('cloud:start'); await gate.p; log.push('cloud:end'); } },
            { id: 'texts', label: 'texts', phase: 'data', run: async () => { log.push('texts:start'); await Promise.resolve(); log.push('texts:end'); } },
            { id: 'notes', label: 'notes', phase: 'paint', run: () => { log.push('notes'); } },
        ];
        const done = runRefresh(steps);
        await new Promise((r) => setTimeout(r, 5));
        expect(log).toEqual(['cloud:start']);                                              // nothing else starts until the account has been merged
        gate.go();
        const out = await done;
        expect(log.slice(0, 2)).toEqual(['cloud:start', 'cloud:end']);
        expect(log.slice(2, 4).sort()).toEqual(['phone:start', 'texts:start']);              // the rest start together
        expect(log.slice(-2)).toEqual(['screens', 'notes']);                                // the screens only after every data step has finished, in the order listed
        expect(out.ok).toBe(true);
        expect(out.rows.map((r) => r.id)).toContain('screens');
    });

    it('a step that never answers is timed out on its own and delays nothing else', async () => {
        const log = [];
        const out = await runRefresh([
            { id: 'cloud', label: 'account', phase: 'data', first: true, run: async () => { log.push('cloud'); } },
            { id: 'hang', label: 'the slow thing', phase: 'data', run: () => new Promise(() => {}) },
            { id: 'texts', label: 'texts', phase: 'data', run: async () => { log.push('texts'); } },
            { id: 'screens', label: 'screens', phase: 'paint', run: () => { log.push('screens'); } },
        ], { timeoutMs: 30 });
        expect(log).toEqual(['cloud', 'texts', 'screens']);
        expect(out.ok).toBe(false);
        expect(out.failed).toEqual(['the slow thing']);
        expect(out.rows.find((r) => r.id === 'hang').detail).toMatch(/did not answer/);
        expect(REFRESH.STEP_TIMEOUT_MS).toBeGreaterThanOrEqual(10000);
    });

    it('a repaint that throws does not stop the repaints after it, and is reported', async () => {
        const log = [];
        const out = await runRefresh([
            { id: 'a', label: 'a', phase: 'paint', run: () => { throw new Error('bad record'); } },
            { id: 'b', label: 'b', phase: 'paint', run: () => { log.push('b'); } },
        ]);
        expect(log).toEqual(['b']);
        expect(out.failed).toEqual(['a']);
        expect(out.rows[0].detail).toBe('bad record');
    });

    it('a step with nothing to do is skipped, not failed, and a step may report a soft failure', async () => {
        const out = await runRefresh([
            { id: 'texts', label: 'text messages', phase: 'data', when: () => false, run: () => { throw new Error('must not run'); } },
            { id: 'phone', label: 'phone', phase: 'data', run: async () => ({ ok: false, detail: 'pull failed: 503' }) },
            { id: 'devices', label: 'devices', phase: 'data', run: async () => ({ ok: true, detail: '2 added' }) },
        ]);
        expect(out.rows.find((r) => r.id === 'texts')).toMatchObject({ skipped: true, ok: true });
        expect(out.rows.find((r) => r.id === 'phone')).toMatchObject({ ok: false, detail: 'pull failed: 503' });
        expect(out.rows.find((r) => r.id === 'devices').detail).toBe('2 added');
        expect(out.failed).toEqual(['phone']);
    });

    it('runs every paint step even when every data step failed (the screen is repainted whether or not anything new came)', async () => {
        const log = [];
        const out = await runRefresh([
            { id: 'cloud', label: 'account', phase: 'data', first: true, run: async () => { throw new Error('offline'); } },
            { id: 'phone', label: 'phone', phase: 'data', run: async () => { throw new Error('offline'); } },
            { id: 'screens', label: 'screens', phase: 'paint', run: () => { log.push('screens'); } },
        ]);
        expect(log).toEqual(['screens']);
        expect(out.failed).toEqual(['account', 'phone']);
    });

    it('survives nonsense: no steps, a step with no run, a listener that throws', async () => {
        expect(await runRefresh(undefined)).toEqual({ ok: true, rows: [], failed: [] });
        expect(await runRefresh([null, {}, { id: 'x' }])).toEqual({ ok: true, rows: [], failed: [] });
        const out = await runRefresh([{ id: 'a', label: 'a', run: () => 1 }], { onStep: () => { throw new Error('ui'); } });
        expect(out.ok).toBe(true);
    });

    it('says what could not be refreshed, and says nothing about the account (the sync reports that itself)', () => {
        expect(refreshNote({ rows: [{ id: 'cloud', label: 'your account', ok: false }] })).toBe('');
        expect(refreshNote({ rows: [{ id: 'cloud', ok: true }, { id: 'phone', label: 'transactions sent from your phone', ok: false }, { id: 'texts', label: 'text messages', ok: false }] }))
            .toBe('Synced, but this could not be refreshed just now: transactions sent from your phone, text messages. It will be tried again on its own.');
        expect(refreshNote({ rows: [{ id: 'screens', ok: true }] })).toBe('');
        expect(refreshNote(null)).toBe('');
    });
});

describe('the page wires it', () => {
    const fn = HTML.slice(HTML.indexOf('function _wfRefreshSteps() {'), HTML.indexOf('window.refreshApp = refreshApp;'));

    it('lists every step, the account first, then data, then repaints', () => {
        expect(fn.length).toBeGreaterThan(1000);
        const ids = [...fn.matchAll(/\{ id: '([a-z-]+)', label: '[^']+', phase: '(data|paint)'/g)].map((m) => m[1] + ':' + m[2]);
        expect(ids).toEqual(['cloud:data', 'phone:data', 'texts:data', 'devices:data', 'screens:paint', 'notifications:paint', 'advisor:paint', 'texts-log:paint', 'update-card:paint', 'sync-notice:paint']);
        expect(fn).toMatch(/id: 'cloud'[^]*first: true/);
        expect(fn).toContain('forceSyncFromCloud()');
        expect(fn).toContain('window.wfDrainServerInbox()');
        expect(fn).toContain('window.WFSms.kickNow()');
        expect(fn).toContain('refreshAllSurfaces()');
    });

    it('refreshApp runs them through the one runner and says what could not be refreshed', () => {
        expect(fn).toContain('H.runRefresh(_wfRefreshSteps())');
        expect(fn).toContain('H.refreshNote(result)');
        expect(fn).toContain('_refreshInFlight');                                           // still one at a time
    });

    it('a refusal from the phone inbox (401, 403, 404...) is "not set up", never a notice at every sync; only an answer that did not come is reported', () => {
        expect(fn).toContain("code >= 400 && code < 500 && code !== 408 && code !== 429");
        expect(fn).toContain("detail: 'not set up'");
    });

    it('says it has started when the top bar button, which is not drawn on a phone, is the one that was pressed', () => {
        expect(fn).toContain("if (!btn || !btn.getClientRects().length) notify('Syncing…', 'info');");
    });

    it('the text-message nudge is only made for an account that uses text messages', () => {
        // the signature covers the records with the switch (on or off) AND the owner's own due-date alerts: an account with only those is still asked
        expect(fn).toMatch(/id: 'texts'[^]*WFSms\.signatureOf\(appData\) !== ''/);
        expect(fn).not.toMatch(/id: 'texts'[^]*countOn/);
    });
});
