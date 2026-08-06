/* =============================================================================
 * test/cross_page_probe_test.js
 * -----------------------------------------------------------------------------
 * The instrument from issue #66, tested. An instrument nobody has tested is not
 * evidence, and this one was trusted to veto a change that would have removed a
 * quarter of the DOM — so its two load-bearing parts are exercised directly:
 *
 *   installAccessRecorder()  the prototype patch that notices a hit landing
 *                            inside a `.page` that is not `.active`
 *   summarise()              the pure step that turns those hits into the
 *                            safe/unsafe verdict
 *
 * The browser driver in between is not unit-tested — it is Playwright glue, and
 * its output is the numbers already recorded in PR #87.
 * ===========================================================================*/

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
    summarise, installAccessRecorder,
} from '../test/e2e/cross-page-probe.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');

describe('summarise() makes the safe/unsafe call', () => {
    const facts = {
        total: 1000,
        pages: [
            { id: 'page-dashboard', nodes: 80, active: true },
            { id: 'page-expenses', nodes: 40, active: false },
            { id: 'page-quiet', nodes: 25, active: false },
        ],
        raw: { 'page-expenses': ['expTotal', 'expList'] },
    };

    it('marks a hidden page that is written to as UNSAFE', () => {
        const r = summarise(facts);
        const exp = r.rows.find((x) => x.id === 'page-expenses');
        expect(exp.safeToDetach).toBe(false);
        expect(exp.touchedCount).toBe(2);
    });

    it('marks a hidden page nobody touches as safe', () => {
        const quiet = summarise(facts).rows.find((x) => x.id === 'page-quiet');
        expect(quiet.safeToDetach).toBe(true);
    });

    it('never calls the ACTIVE page safe — it is on screen', () => {
        // The bug that would make this instrument dangerous: recommending the
        // detachment of the page the user is looking at.
        const dash = summarise(facts).rows.find((x) => x.id === 'page-dashboard');
        expect(dash.active).toBe(true);
        expect(dash.safeToDetach).toBe(false);
    });

    it('totals only hidden pages, and keeps the two buckets disjoint', () => {
        const r = summarise(facts);
        expect(r.safeNodes).toBe(25);         // page-quiet
        expect(r.unsafeNodes).toBe(40);       // page-expenses
        expect(r.safeNodes + r.unsafeNodes).toBe(65);   // dashboard's 80 excluded
        expect(r.hiddenPages).toBe(2);
    });

    it('reproduces the real #66 verdict when nothing is safe', () => {
        const r = summarise({
            total: 2561,
            pages: [{ id: 'page-a', nodes: 108, active: false }, { id: 'page-b', nodes: 103, active: false }],
            raw: { 'page-a': ['x'], 'page-b': ['y'] },
        });
        expect(r.safeNodes).toBe(0);
        expect(r.unsafeNodes).toBe(211);
        expect(r.verdict).toMatch(/No hidden page is safe to detach/);
    });

    it('says so plainly when something IS safe', () => {
        const r = summarise({ total: 100, pages: [{ id: 'p', nodes: 10, active: false }], raw: {} });
        expect(r.verdict).toMatch(/10 node\(s\) across 1 page\(s\)/);
    });

    it('sorts biggest first, so the interesting page is at the top', () => {
        expect(summarise(facts).rows.map((r) => r.id)).toEqual(['page-dashboard', 'page-expenses', 'page-quiet']);
    });

    it('survives being handed nothing', () => {
        const r = summarise();
        expect(r.rows).toEqual([]);
        expect(r.safeNodes).toBe(0);
        expect(() => summarise(null)).not.toThrow();
    });
});

describe('installAccessRecorder() actually notices cross-page reads', () => {
    let realDocument, realDocumentProto;

    /** Minimal DOM: elements that know their page and whether it is active. */
    const mkEl = (id, page) => ({
        id, tagName: 'DIV',
        closest: (sel) => (sel === '.page' ? page : null),
    });
    const mkPage = (id, active) => ({ id, classList: { contains: (c) => c === 'active' && active } });

    beforeEach(() => {
        realDocument = globalThis.document;
        realDocumentProto = globalThis.Document;
        const store = new Map();
        const proto = {
            getElementById(id) { return store.get(id) || null; },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        };
        globalThis.Document = { prototype: proto };
        globalThis.document = Object.create(proto);
        globalThis.document._store = store;
    });

    afterEach(() => {
        globalThis.document = realDocument;
        globalThis.Document = realDocumentProto;
        delete globalThis.__wfCrossPage;
    });

    it('records a read of an element inside an INACTIVE page', () => {
        const hidden = mkPage('page-expenses', false);
        globalThis.document._store.set('expTotal', mkEl('expTotal', hidden));
        installAccessRecorder();

        globalThis.document.getElementById('expTotal');

        expect(globalThis.__wfCrossPage['page-expenses']).toBeTruthy();
        expect(Object.keys(globalThis.__wfCrossPage['page-expenses'])).toContain('expTotal');
    });

    it('does NOT record a read inside the active page', () => {
        const shown = mkPage('page-dashboard', true);
        globalThis.document._store.set('dashTotal', mkEl('dashTotal', shown));
        installAccessRecorder();

        globalThis.document.getElementById('dashTotal');

        expect(globalThis.__wfCrossPage['page-dashboard']).toBeUndefined();
    });

    it('ignores elements that belong to no page at all', () => {
        globalThis.document._store.set('topbar', { id: 'topbar', tagName: 'DIV', closest: () => null });
        installAccessRecorder();
        globalThis.document.getElementById('topbar');
        expect(Object.keys(globalThis.__wfCrossPage)).toEqual([]);
    });

    it('still returns what the caller asked for — the app must not change', () => {
        // The patch is observational. If it altered a return value it would be
        // changing the thing it is measuring.
        const hidden = mkPage('page-x', false);
        const el = mkEl('thing', hidden);
        globalThis.document._store.set('thing', el);
        installAccessRecorder();
        expect(globalThis.document.getElementById('thing')).toBe(el);
        expect(globalThis.document.getElementById('missing')).toBe(null);
    });

    it('never throws on a null or exotic result', () => {
        installAccessRecorder();
        expect(() => globalThis.document.getElementById('nope')).not.toThrow();
        globalThis.document._store.set('weird', { id: 'weird' });   // no closest()
        expect(() => globalThis.document.getElementById('weird')).not.toThrow();
    });
});

describe('the artifact is durable, which was the entire point', () => {
    it('lives in the repository, not a scratch directory', () => {
        const p = path.join(ROOT, 'test', 'e2e', 'cross-page-probe.mjs');
        expect(fs.existsSync(p)).toBe(true);
        const src = fs.readFileSync(p, 'utf8');
        expect(src).toMatch(/export function installAccessRecorder/);
        expect(src).toMatch(/export function summarise/);
        expect(src).toMatch(/export async function probeCrossPageAccess/);
    });

    it('records why it exists, so the next reader does not have to rediscover it', () => {
        const src = fs.readFileSync(path.join(ROOT, 'test', 'e2e', 'cross-page-probe.mjs'), 'utf8');
        expect(src).toMatch(/SAFE to detach\s*:\s*0 nodes/);
        expect(src).toMatch(/structurally sound and functionally destructive/);
    });
});
