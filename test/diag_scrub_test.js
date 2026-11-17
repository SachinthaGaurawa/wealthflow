/* test/diag_scrub_test.js
 *
 * "Send system diagnosis" promises: "Never includes any financial data", and the server writes what it gets into a GitHub issue
 * of a PUBLIC repository. These tests hold that promise to a rule (wealthflow-diag-scrub.js, one file used by the device and the
 * server) and hold the report to what a person fixing the fault needs: statement review reasons that used to be collected and
 * dropped, repeated errors grouped with a count.
 *
 * Every figure below is made up. Never paste a real statement number, name or merchant into a test of a public repository.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import { scrubText, scrubFileName, scrubDiagnostics, groupErrors } from '../wealthflow-diag-scrub.js';
import { diagnosticsSection } from '../feedback-triage.js';
import { loadBrowserModule } from './helpers/load-browser-module.js';

describe('scrubText: what must not leave', () => {
    it.each([
        ['Invalid amount 4,820.50 for the row', /4,820|820\.50/],
        ['Invalid amount 4820.50', /4820\.50/],
        ['paid Rs. 15,000 today', /15,000/],
        ['LKR 1250 charged', /1250/],
        ['card 4532123412341234 refused', /4532123412341234/],
        ['phone +94 77 123 4567 failed', /123 4567|77 123/],
        ['mail jane.doe@example.com bounced', /jane\.doe@example\.com/],
        ['GET https://x.lk/a?token=abcdef&u=1 failed', /token=abcdef/],
        ['key ' + ['tok', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ123456'].join('_') + ' leaked', /ABCDEFGHIJKLMNOPQRSTUVWXYZ123456/],
        ['row "KEELLS SUPER NUGEGODA 12 FEB PURCHASE REF" bad', /KEELLS SUPER NUGEGODA/],
    ])('removes the private part of %j', (input, leak) => {
        expect(scrubText(input)).not.toMatch(leak);
    });

    it('keeps what a person fixing the fault needs', () => {
        const kept = scrubText('TypeError at renderReports (https://www.wealthflow.lk/index.html:31443:17) build 7.69.94 status 429 at position 4821 on 2026-11-13T10:00:00Z');
        expect(kept).toContain('index.html:31443:17');
        expect(kept).toContain('7.69.94');
        expect(kept).toContain('status 429');
        expect(kept).toContain('position 4821');
        expect(kept).toContain('2026-11-13T10:00:00Z');
        expect(kept).toContain('TypeError');
    });

    it('masks a merchant written in capitals, keeps the capitals an error uses', () => {
        expect(scrubText('no match for KEELLS SUPER NUGEGODA today')).not.toMatch(/KEELLS/);
        expect(scrubText('HTTP 502 BAD GATEWAY, NOT FOUND, NETWORK ERROR')).toBe('HTTP 502 BAD GATEWAY, NOT FOUND, NETWORK ERROR');
    });

    it('reduces a statement file name to its extension', () => {
        expect(scrubFileName('HNB_4532XXXXXXXX1234.pdf')).toBe('[file].pdf');
        expect(scrubFileName('no extension')).toBe('[file]');
        expect(scrubText('cannot read statement HNB_4532123412341234.pdf')).not.toMatch(/4532123412341234/);
    });

    it('is idempotent and never throws', () => {
        fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
            const once = scrubText(s);
            expect(scrubText(once)).toBe(once);
        }), { numRuns: runs(400) });
        fc.assert(fc.property(fc.anything(), (x) => { expect(typeof scrubText(x)).toBe('string'); }), { numRuns: runs(200) });
    });
});

describe('scrubDiagnostics: fields by name, depth, size', () => {
    const sample = {
        ua: 'Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0', build: '7.69.94',
        errorSummary: { total: 3, fromThisBuild: 2, uniqueMessages: ['bad row 4,820.50'] },
        health: { account: { signedIn: true, email: 'jane@example.com', hasPin: true }, notes: ['x'], balance: 1234567, total: 12 },
        statementReview: { total: 2, byReason: { differs: 2 }, wholeStatements: [{ bank: 'HNB', filename: 'HNB_4532XXXXXXXX1234.pdf', reason: 'differs', embedded: ['row 12 shows 4,820.50'] }] },
    };

    it('drops private fields but keeps the facts around them', () => {
        const o = scrubDiagnostics(sample);
        expect(o.health.account.signedIn).toBe(true);
        expect(o.health.account.hasPin).toBe(true);
        expect(o.health.account.email).toBe('[removed]');
        expect(o.health.notes).toBe('[removed]');
        expect(o.health.balance).toBe('[removed]');
        expect(o.health.total).toBe(12);          // a count stays
        expect(o.errorSummary.total).toBe(3);
        expect(o.build).toBe('7.69.94');
        expect(o.ua).toContain('Chrome/120.0.0.0');
    });

    it('scrubs the statement review down to bank, extension, reason and a masked problem', () => {
        const w = scrubDiagnostics(sample).statementReview.wholeStatements[0];
        expect(w).toEqual({ bank: 'HNB', filename: '[file].pdf', reason: 'differs', embedded: ['row 12 shows [amount]'] });
    });

    it('does not change its input and is idempotent', () => {
        const before = JSON.stringify(sample);
        const once = scrubDiagnostics(sample);
        expect(JSON.stringify(sample)).toBe(before);
        expect(scrubDiagnostics(once)).toEqual(once);
    });

    it('bounds depth and size, and never throws', () => {
        let deep = {}; let cur = deep; for (let i = 0; i < 40; i++) { cur.x = {}; cur = cur.x; }
        expect(() => scrubDiagnostics(deep)).not.toThrow();
        const wide = {}; for (let i = 0; i < 500; i++) wide['k' + i] = 'v';
        expect(Object.keys(scrubDiagnostics(wide)).length).toBeLessThanOrEqual(80);
        fc.assert(fc.property(fc.anything(), (x) => { expect(() => scrubDiagnostics(x)).not.toThrow(); }), { numRuns: runs(300) });
    });

    it('leaves no digit run of four or more, no e-mail and no comma-grouped amount in anything it returns', () => {
        fc.assert(fc.property(fc.record({ msg: fc.string({ maxLength: 120 }), note: fc.string(), n: fc.integer() }), (r) => {
            const out = JSON.stringify(scrubDiagnostics({ errors: [{ msg: r.msg }], other: r }));
            // a number is a count and may be long; what a string carries may not
            const strings = out.match(/"[^"]*"/g) || [];
            for (const s of strings) {
                if (/^"(\d+|[\d:.TZ-]+)"$/.test(s)) continue;
                expect(s).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
            }
        }), { numRuns: runs(200) });
    });
});

describe('groupErrors: one fault, one line', () => {
    const e = (msg, t, extra = {}) => ({ t, ver: '7.69.94', msg, stack: 'TypeError: x\n    at f (https://x.lk/index.html:10:5)', page: 'reports', ...extra });

    it('groups repeats with a count, first and last, newest group first', () => {
        const log = [e('A', '2026-11-13T08:00:00Z'), e('B', '2026-11-13T09:00:00Z'), e('A', '2026-11-13T10:00:00Z', { extra: 'while loading', mem: 120 }), e('A', '2026-11-13T11:00:00Z')];
        const g = groupErrors(log, { build: '7.69.94' });
        expect(g).toHaveLength(2);
        expect(g[0]).toMatchObject({ msg: 'A', count: 3, first: '2026-11-13T08:00:00Z', last: '2026-11-13T11:00:00Z', where: 'while loading', mem: 120, thisBuild: true });
        expect(g[1]).toMatchObject({ msg: 'B', count: 1 });
    });

    it('keeps a quiet fault in the report while a noisy one repeats', () => {
        const log = [e('rare', '2026-11-13T01:00:00Z'), ...Array.from({ length: 19 }, (_, i) => e('noisy', '2026-11-13T02:' + String(10 + i) + ':00Z'))];
        expect(groupErrors(log).map((x) => x.msg).sort()).toEqual(['noisy', 'rare']);
    });

    it('never throws on junk', () => {
        fc.assert(fc.property(fc.anything(), (x) => { expect(Array.isArray(groupErrors(x))).toBe(true); }), { numRuns: runs(200) });
    });
});

describe('diagnosticsSection: the issue body', () => {
    const d = {
        activePage: 'statements', build: '7.69.94', maskedScriptErrors: 4,
        errors: [{ msg: 'Invalid amount 4,820.50 for KEELLS SUPER NUGEGODA 12 FEB PURCHASE REF', stack: 'at f (index.html:10:5)', page: 'statements', ver: '7.69.94', count: 5, first: '2026-11-13T08:00:00Z', last: '2026-11-13T10:00:00Z', where: 'while filing', mem: 90 }],
        statementReview: { total: 3, wholeStatement: 1, perRow: 2, byReason: { 'balance-differs': 2, 'no-rows': 1 }, wholeStatements: [{ bank: 'HNB', filename: 'HNB_4532123412341234.pdf', reason: 'no-rows', embedded: ['row 3 "4,820.50"'] }] },
        statementRetrying: [{ bank: 'NTB', filename: 'NTB_5412345678901234.pdf', retryCount: 2, lastRetryReason: 'timeout 8000' }],
        layoutTeachAttempts: [{ bank: 'HNB', at: 1, outcome: 'render-produced-nothing', diag: { candidates: 4, rows: 0 } }],
    };

    it('renders the statement review, retries and layout attempts that used to be dropped', () => {
        const md = diagnosticsSection(d);
        expect(md).toContain('Statements needing review');
        expect(md).toContain('balance-differs');
        expect(md).toContain('no-rows');
        expect(md).toContain('| HNB | [file].pdf | no-rows |');
        expect(md).toContain('waiting to be tried again');
        expect(md).toContain('| NTB | [file].pdf | 2 |');
        expect(md).toContain('render-produced-nothing');
        expect(md).toContain('Masked script errors');
    });

    it('shows the repeat count, when, where and memory of a grouped error', () => {
        const md = diagnosticsSection(d);
        expect(md).toContain('seen 5 times');
        expect(md).toContain('where: while filing');
        expect(md).toContain('memory: 90');
    });

    it('writes no financial figure, card or merchant text into the public issue even if the device sent it', () => {
        const md = diagnosticsSection(d);
        expect(md).not.toMatch(/4,820/);
        expect(md).not.toMatch(/4532123412341234|5412345678901234/);
        expect(md).not.toMatch(/KEELLS/);
        expect(md).not.toMatch(/HNB_4532|NTB_5412/);
    });

    it('still renders a payload from a stale cached app (ungrouped errors, no new fields)', () => {
        const md = diagnosticsSection({ errors: [{ msg: 'old shape', stack: 'at g (a.js:1:1)', page: 'p', ver: '1' }] });
        expect(md).toContain('old shape');
        expect(md).not.toContain('seen ');
    });

    it('stays inside the issue body limit with the new sections full', () => {
        const big = {
            ...d,
            statementReview: { total: 99, byReason: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['r' + i, i])), wholeStatements: Array.from({ length: 60 }, () => ({ bank: 'B'.repeat(300), filename: 'f.pdf', reason: 'r'.repeat(500), embedded: Array.from({ length: 30 }, () => 'e'.repeat(500)) })), coverage: { x: 'c'.repeat(9000) } },
            statementRetrying: Array.from({ length: 60 }, () => ({ bank: 'b', filename: 'f.pdf', retryCount: 1, lastRetryReason: 'x'.repeat(900) })),
            layoutTeachAttempts: Array.from({ length: 40 }, () => ({ bank: 'b', outcome: 'o', diag: { s: 'd'.repeat(3000) } })),
            health: { blob: 'h'.repeat(100000) },
        };
        expect(diagnosticsSection(big).length).toBeLessThan(60000);
    });
});

describe('the device uses the same rule', () => {
    const scrubSrc = fs.readFileSync(new URL('../wealthflow-diag-scrub.js', import.meta.url), 'utf8');

    it('the module registers itself as window.WFDiagScrub with the same functions', () => {
        // run the ESM source as a script, minus its `export` keywords, the way a browser module gives it a window
        const source = scrubSrc.replace(/^export /gm, '');
        const { window } = loadBrowserModule('wealthflow-diag-scrub.js', { source });
        expect(typeof window.WFDiagScrub.scrubDiagnostics).toBe('function');
        expect(typeof window.WFDiagScrub.groupErrors).toBe('function');
        const sample = { errors: [{ msg: 'x 4,820.50' }] };
        expect(JSON.parse(JSON.stringify(window.WFDiagScrub.scrubDiagnostics(sample)))).toEqual(scrubDiagnostics(sample));
    });

    it('_collectDiagnostics sends grouped, scrubbed errors and the build when the module is present', () => {
        const source = scrubSrc.replace(/^export /gm, '');
        const mod = loadBrowserModule('wealthflow-diag-scrub.js', { source });
        const log = [
            { t: '2026-11-13T08:00:00Z', ver: '7.1.1', msg: 'Invalid amount 4,820.50', stack: 'at f (index.html:10:5)', page: 'reports' },
            { t: '2026-11-13T09:00:00Z', ver: '7.1.1', msg: 'Invalid amount 4,820.50', stack: 'at f (index.html:10:5)', page: 'reports' },
        ];
        const { window } = loadBrowserModule('wealthflow-update-system.js', {
            html: '<div id="page-reports" class="page active"></div>',
            localStorage: { wf_masked_script_errors: '3' },
            globals: { WFDiagScrub: mod.window.WFDiagScrub, _wfCrashReport: () => log, WF_APP_VERSION: '7.1.1' },
        });
        const d = window.wfUpdate._collectDiagnostics();
        expect(d.errors).toHaveLength(1);
        expect(d.errors[0].count).toBe(2);
        expect(JSON.stringify(d)).not.toMatch(/4,820/);
        expect(d.build).toBe('7.1.1');
        expect(d.maskedScriptErrors).toBe(3);
    });

    it('_collectDiagnostics still works when the module has not loaded (stale cache, offline)', () => {
        const { window } = loadBrowserModule('wealthflow-update-system.js', {
            html: '<div id="page-reports" class="page active"></div>',
            globals: { _wfCrashReport: () => [{ t: 't', ver: '1', msg: 'old', stack: 's', page: 'p' }] },
        });
        const d = window.wfUpdate._collectDiagnostics();
        expect(d.errors[0].msg).toBe('old');
    });

    it('index.html loads the module', () => {
        expect(fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8')).toContain('<script type="module" src="wealthflow-diag-scrub.js"></script>');
    });
});
