// =============================================================================
// WealthFlow Shadow Test Harness — autonomous discovery
// =============================================================================
// The discovery scanner is what makes the pipeline SELF-DIRECTED instead of
// merely reactive. That also makes it dangerous: a scanner that files junk
// trains you to ignore the queue, and a queue you ignore is worse than an empty
// one. So the tests here weight false positives as heavily as misses.
//
// Two of these are regressions for false positives caught on the very first
// real run against this repository:
//   1. `/manifest.json` reported missing while `manifest.json` sat in the root
//      (web-absolute path never resolved to a repo path).
//   2. `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)` reported as an
//      unguarded parse — inside the block COMMENT that documents the historical
//      bug. The scanner filed a bug against its own changelog.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import {
    parseAudit, resolveLocalAsset, findBrokenAssets, findUnguardedJsonParse,
    findImagesMissingAlt, stripComments, fingerprint, stampBody, fingerprintsIn,
    renderIssue, FINGERPRINT_TAG,
} from '../autonomy/discover.mjs';

// ── dependency vulnerabilities ───────────────────────────────────────────────
describe('discover: vulnerable dependencies', () => {
    const audit = JSON.stringify({
        vulnerabilities: {
            nodemailer: {
                severity: 'high', range: '<7.0.7', fixAvailable: true,
                via: [{ title: 'SMTP command injection' }, { title: 'Improper TLS Certificate Validation' }],
            },
            vitest: { severity: 'critical', range: '*', fixAvailable: true, via: [{ title: 'Arbitrary file read' }] },
            leftpad: { severity: 'low', range: '*', via: [{ title: 'noise' }] },
        },
    });

    it('keeps only high and critical — low/moderate noise is not worth an issue', () => {
        const f = parseAudit(audit, new Set());
        expect(f.map((x) => x.package).sort()).toEqual(['nodemailer', 'vitest']);
    });

    it('escalates a PRODUCTION dependency above a dev one', () => {
        // nodemailer is `high` in the raw audit but ships in send-otp.js, so it
        // must outrank a `critical` that only ever runs on a build machine.
        const f = parseAudit(audit, new Set(['nodemailer']));
        expect(f[0].package).toBe('nodemailer');
        expect(f[0].production).toBe(true);
        expect(f[0].severity).toBe('critical');
    });

    it('carries the advisory titles through as evidence', () => {
        const f = parseAudit(audit, new Set(['nodemailer']));
        expect(f[0].advisories.join(' ')).toMatch(/SMTP command injection/);
    });

    it('never throws on malformed audit output', () => {
        expect(parseAudit('not json')).toEqual([]);
        expect(parseAudit('')).toEqual([]);
        expect(parseAudit('{}')).toEqual([]);
        expect(parseAudit(null)).toEqual([]);
    });

    it('renders a production vulnerability as a security issue that says so', () => {
        const [f] = parseAudit(audit, new Set(['nodemailer']));
        const issue = renderIssue(f);
        expect(issue.labels).toContain('security');
        expect(issue.body).toMatch(/PRODUCTION dependency/);
        expect(issue.body).toMatch(/npm audit/);          // reproducible evidence
    });
});

// ── broken assets (regression #1) ────────────────────────────────────────────
describe('discover: broken assets', () => {
    it('resolves a web-absolute path to a repo path (FALSE-POSITIVE regression)', () => {
        // `/manifest.json` is served from the web root; on disk it is `manifest.json`.
        // The first draft reported it missing while the file was sitting right there.
        expect(resolveLocalAsset('/manifest.json')).toBe('manifest.json');
        expect(resolveLocalAsset('./app.js')).toBe('./app.js');
        expect(resolveLocalAsset('/css/x.css?v=3')).toBe('css/x.css');
        expect(resolveLocalAsset('/a.js#frag')).toBe('a.js');
    });

    it('ignores anything that is not a checkable local file', () => {
        expect(resolveLocalAsset('https://cdn.example.com/x.js')).toBeNull();
        expect(resolveLocalAsset('//cdn.example.com/x.js')).toBeNull();
        expect(resolveLocalAsset('data:image/png;base64,AAAA')).toBeNull();
        expect(resolveLocalAsset('${userPhoto}')).toBeNull();       // template expression
        expect(resolveLocalAsset('#section')).toBeNull();
        expect(resolveLocalAsset('')).toBeNull();
    });

    it('flags a genuinely missing local asset', () => {
        const html = '<script src="/definitely-not-here-9e3f.js"></script>';
        const f = findBrokenAssets(html, process.cwd());
        expect(f).toHaveLength(1);
        expect(f[0].asset).toBe('definitely-not-here-9e3f.js');
    });

    it('does NOT flag an asset that exists', () => {
        expect(findBrokenAssets('<link rel="manifest" href="/manifest.json">', process.cwd())).toHaveLength(0);
    });

    it('never throws on arbitrary markup', () => {
        fc.assert(fc.property(fc.string({ maxLength: 300 }), (s) => {
            expect(() => findBrokenAssets(s, process.cwd())).not.toThrow();
        }), { numRuns: runs(200) });
    });
});

// ── comment stripping (regression #2) ────────────────────────────────────────
describe('discover: comments are not evidence', () => {
    it('blanks comments while preserving line numbers', () => {
        const src = 'const a = 1;\n// JSON.parse(process.env.X)\nconst b = 2;';
        const out = stripComments(src);
        expect(out.split('\n')).toHaveLength(3);            // numbering intact
        expect(out).not.toMatch(/JSON\.parse/);
        expect(out).toMatch(/const a = 1;/);
        expect(out).toMatch(/const b = 2;/);
    });

    it('strips block comments across lines', () => {
        const src = '/*\n * JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)\n */\nlet ok = 1;';
        const out = stripComments(src);
        expect(out).not.toMatch(/JSON\.parse/);
        expect(out.split('\n')).toHaveLength(4);
        expect(out).toMatch(/let ok = 1;/);
    });

    it('does NOT strip a // inside a string literal', () => {
        const src = 'const url = "https://api.groq.com/v1";';
        expect(stripComments(src)).toMatch(/https:\/\/api\.groq\.com\/v1/);
    });

    it('does not flag a JSON.parse that only appears in documentation', () => {
        // Verbatim shape of the real false positive.
        const src = [
            '/* =====================================================',
            ' *   The first thing the old agent did was',
            ' *       JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)',
            ' *   on an unset variable. It threw and exited 78.',
            ' * ===================================================*/',
            'export function fine() { return 1; }',
        ].join('\n');
        expect(findUnguardedJsonParse(src, 'x.js')).toHaveLength(0);
    });

    it('survives a regex literal holding unbalanced quotes (desync regression)', () => {
        // The character-by-character tokeniser died here: this regex has an ODD
        // number of double quotes, so it read the first as a string opener and
        // never recovered — every later `//` looked like string content, and the
        // scanner reported its own docs as unguarded parses. Found when discover
        // flagged discover.mjs itself.
        const src = [
            'const re = /(?:src|href)\\s*=\\s*"([^"]+\\.(?:js|mjs))"/gi;',
            '// JSON.parse(process.env.SECRET) mentioned only in a comment',
            'export const ok = 1;',
        ].join('\n');
        const out = stripComments(src);
        expect(out).not.toMatch(/JSON\.parse/);              // the comment is gone
        expect(out).toMatch(/export const ok = 1;/);         // real code survives
        expect(findUnguardedJsonParse(src, 'x.js')).toHaveLength(0);
    });

    it('does not flag this repository\'s own detector source', () => {
        // Self-consistency: the scanner must not file bugs against itself.
        const src = fs.readFileSync('autonomy/discover.mjs', 'utf8');
        expect(findUnguardedJsonParse(src, 'autonomy/discover.mjs')).toHaveLength(0);
    });

    it('never throws on adversarial source', () => {
        fc.assert(fc.property(fc.string({ maxLength: 400 }), (s) => {
            expect(() => stripComments(s)).not.toThrow();
            expect(() => findUnguardedJsonParse(s, 'f.js')).not.toThrow();
        }), { numRuns: runs(300) });
    });
});

// ── unguarded JSON.parse ─────────────────────────────────────────────────────
describe('discover: unguarded JSON.parse of external data', () => {
    it('flags a bare parse of an environment variable', () => {
        const f = findUnguardedJsonParse('const creds = JSON.parse(process.env.SERVICE_ACCOUNT);', 'a.js');
        expect(f).toHaveLength(1);
        expect(f[0].line).toBe(1);
    });

    it('does NOT flag one wrapped in try/catch', () => {
        const src = 'try {\n  const c = JSON.parse(process.env.SERVICE_ACCOUNT);\n} catch { }';
        expect(findUnguardedJsonParse(src, 'a.js')).toHaveLength(0);
    });

    it('does NOT flag a parse of a local literal', () => {
        expect(findUnguardedJsonParse('const o = JSON.parse(\'{"a":1}\');', 'a.js')).toHaveLength(0);
    });
});

// ── accessibility ────────────────────────────────────────────────────────────
describe('discover: images without alt text', () => {
    it('flags an img with no alt', () => {
        expect(findImagesMissingAlt('<img src="/a.png">')).toHaveLength(1);
    });

    it('does not flag an img that has alt', () => {
        expect(findImagesMissingAlt('<img src="/a.png" alt="a chart">')).toHaveLength(0);
        expect(findImagesMissingAlt('<img src="/a.png" alt="">')).toHaveLength(0);
    });

    it('accepts a decorative image that is correctly hidden', () => {
        expect(findImagesMissingAlt('<img src="/d.png" aria-hidden="true">')).toHaveLength(0);
    });

    it('routes to the UI role so the right agent picks it up', () => {
        const [f] = findImagesMissingAlt('<img src="/a.png">');
        expect(renderIssue(f).labels).toContain('ui/ux');
    });
});

// ── dedup ────────────────────────────────────────────────────────────────────
describe('discover: never files the same finding twice', () => {
    it('produces a stable fingerprint for the same finding', () => {
        expect(fingerprint('dep-vuln', 'nodemailer')).toBe(fingerprint('dep-vuln', 'nodemailer'));
        expect(fingerprint('dep-vuln', 'nodemailer')).not.toBe(fingerprint('dep-vuln', 'vite'));
        expect(fingerprint('dep-vuln', 'x')).not.toBe(fingerprint('img-missing-alt', 'x'));
    });

    it('round-trips a fingerprint through an issue body', () => {
        const fp = fingerprint('dep-vuln', 'nodemailer');
        const body = stampBody('## Vulnerable dependency', fp);
        expect(body).toContain(`${FINGERPRINT_TAG}:${fp}`);
        expect(fingerprintsIn([{ body }]).has(fp)).toBe(true);
    });

    it('reads fingerprints out of a mixed issue list, ignoring hand-written ones', () => {
        const fp = fingerprint('dep-vuln', 'vite');
        const found = fingerprintsIn([
            { body: 'a human filed this' },
            { body: stampBody('scanner', fp) },
            { body: null },
            {},
        ]);
        expect(found.size).toBe(1);
        expect(found.has(fp)).toBe(true);
    });
});
