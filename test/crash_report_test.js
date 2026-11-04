/* =============================================================================
 * test/crash_report_test.js — a crash reports itself   (owner, 2026-11-04: "crashes auto fix")
 * Pins: what is reported (our own code only), what is never sent (data), how often (once per
 * crash per day, three a day), and that nothing it does can throw.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { loadBrowserModule } from './helpers/load-browser-module.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const ours = (msg, line = 10) => ({ message: msg, filename: 'https://wf.app/wealthflow-loans.js', lineno: line, error: { message: msg, stack: `TypeError: ${msg}\n    at calc (https://wf.app/wealthflow-loans.js:${line}:5)` } });

function load(opts = {}) {
    const sent = [];
    const fetchImpl = async (url, init) => { sent.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({}) }; };
    const m = loadBrowserModule('wealthflow-crash-report.js', { fetchImpl, ...opts });
    return { ...m, sent, R: m.window.WFCrashReport };
}

describe('sanitize: nothing a person typed or earned leaves the device', () => {
    const { R } = load();
    it('removes numbers, e-mail addresses, quoted text and query strings, and keeps identifiers', () => {
        const out = R.sanitize(`Cannot parse "LKR 52,000.00" for sachin@example.com at https://wf.app/page.js?token=abc123 (reading 'amount') balance 4200000`);
        expect(out).not.toMatch(/52,000|4200000|sachin|example\.com|token|abc123/);
        expect(out).toMatch(/'amount'/);
        expect(out).toMatch(/<email>/);
    });
    it('also masks three-digit amounts', () => { expect(R.sanitize('balance 500 after 250.75')).not.toMatch(/500|250/); });
    it('caps the length', () => { expect(R.sanitize('x'.repeat(5000), 100)).toHaveLength(100); });
    it('copes with null and objects', () => { expect(R.sanitize(null)).toBe(''); expect(typeof R.sanitize({})).toBe('string'); });
});

describe('the stack is positions, not values', () => {
    const { R } = load();
    it('keeps function names and file:line, drops everything else', () => {
        expect(R.frames("TypeError: bad 'LKR 52,000'\n    at calc (https://wf.app/js/wealthflow-loans.js:42:5)\n    at async run (https://wf.app/wealthflow-sync.js:7:3)")).toBe('calc (wealthflow-loans.js:42) | async run (wealthflow-sync.js:7)'.replace('async run', 'run'));
    });
    it('reads the Firefox and Safari shape too', () => { expect(R.frames('calc@https://wf.app/wealthflow-loans.js:42:5')).toBe('calc (wealthflow-loans.js:42)'); });
    it('is empty for nothing', () => { expect(R.frames('')).toBe(''); expect(R.frames(null)).toBe(''); });
});

describe('what counts as a crash worth reporting', () => {
    it('reports an error from our own file, with type crash, a stack and the file and line', () => {
        const { R, sent } = load();
        expect(R.report(ours("Cannot read properties of undefined (reading 'amount')", 42))).toBe(true);
        expect(sent).toHaveLength(1);
        expect(sent[0].url).toBe('/api/feedback-triage');
        expect(sent[0].body.type).toBe('crash');
        expect(sent[0].body.text).toMatch(/^\[Auto crash report\] Cannot read properties of undefined \(reading 'amount'\) \(\/wealthflow-loans\.js:42\)$/);
        expect(sent[0].body.diagnostics.errors[0].stack).toBe('calc (wealthflow-loans.js:42)');
    });
    it.each([
        ['an extension', { message: 'boom', filename: 'chrome-extension://abc/x.js', lineno: 1, error: { message: 'boom', stack: 'at chrome-extension://abc/x.js:1:1' } }],
        ['another site', { message: 'boom', filename: 'https://cdn.example.net/ad.js', lineno: 1 }],
        ['a cross-origin opaque error', { message: 'Script error.', filename: '' }],
        ['a ResizeObserver notice', ours('ResizeObserver loop completed with undelivered notifications.')],
        ['a network that is down', ours('Failed to fetch')],
        ['a full storage', ours('QuotaExceededError')],
        ['nothing at all', {}],
    ])('does not report %s', (_, ev) => {
        const { R, sent } = load();
        expect(R.report(ev)).toBe(false); expect(sent).toHaveLength(0);
    });
    it('reports an unhandled rejection whose stack is ours', () => {
        const { R, sent } = load();
        const err = new Error('state is null'); err.stack = 'Error: state is null\n    at run (https://wf.app/wealthflow-sync.js:7:3)';
        expect(R.report({ message: err.message, error: err, reason: err, filename: '' })).toBe(true);
        expect(sent[0].body.text).toMatch(/\(\/wealthflow-sync\.js:7\)/);
    });
});

describe('it can never become noise', () => {
    it('sends one report per distinct crash per day', () => {
        const { R, sent } = load();
        expect(R.report(ours('same crash'))).toBe(true);
        expect(R.report(ours('same crash'))).toBe(false);
        expect(sent).toHaveLength(1);
    });
    it('remembers across page loads', () => {
        const a = load(); a.R.report(ours('same crash'));
        const b = load({ localStorage: Object.fromEntries(a.localStorage.store) });
        expect(b.R.report(ours('same crash'))).toBe(false);
    });
    it('reports the same crash again after a day', () => {
        const { R, sent, window } = load();
        R.report(ours('same crash'));
        const key = JSON.parse(window.localStorage.getItem('wf_crash_report_seen'));
        const fp = Object.keys(key)[0];
        expect(R.shouldReport(fp, Date.now() + 25 * 3600 * 1000)).toBe(true);
        expect(sent).toHaveLength(1);
    });
    it('sends at most three different crashes', () => {
        const { R, sent } = load();
        ['one', 'two', 'three', 'four', 'five'].forEach((w) => R.report(ours('crash ' + w, w.length)));
        expect(sent).toHaveLength(3);
    });
    it('sends nothing when switched off', () => {
        const { R, sent } = load({ localStorage: { wf_crash_report_off: '1' } });
        expect(R.report(ours('a crash'))).toBe(false); expect(sent).toHaveLength(0);
    });
    it('sends nothing offline', () => {
        const { R, sent } = load({ globals: { navigator: { userAgent: 'x', onLine: false } } });
        expect(R.report(ours('a crash'))).toBe(false); expect(sent).toHaveLength(0);
    });
});

describe('it cannot cause a second crash', () => {
    it('survives a fetch that rejects, throws, or is missing', async () => {
        for (const fetchImpl of [async () => { throw new Error('down'); }, () => { throw new Error('sync'); }]) {
            const { R } = load({ fetchImpl });
            expect(() => R.report(ours('a crash'))).not.toThrow();
        }
        const { R } = load({ globals: { fetch: undefined } });
        expect(() => R.report(ours('a crash'))).not.toThrow();
    });
    it('survives blocked storage and hostile input', () => {
        const { R } = load({ globals: { localStorage: { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } } } });
        expect(() => R.report(ours('a crash'))).not.toThrow();
        expect(() => R.report(null)).not.toThrow();
        expect(() => R.report({ message: { toString() { throw new Error('x'); } } })).not.toThrow();
    });
    it('installs its listeners once', () => {
        const { window } = load();
        expect(window.__wfCrashReportOn).toBe(true);
        window.WFCrashReport.install();
        expect(window.__wfCrashReportOn).toBe(true);
    });
});

describe('it is on the page and inside the budget', () => {
    it('index.html loads it deferred', () => {
        expect(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').includes('<script src="wealthflow-crash-report.js" defer></script>')).toBe(true);
    });
    it('never touches the books or Firebase (it does use the network and its own storage key, by design)', () => {
        const src = fs.readFileSync(path.join(ROOT, 'wealthflow-crash-report.js'), 'utf8');
        expect(src).not.toMatch(/\bDB\s*\.|firebase|firestore/i);
    });
});
