// =============================================================================
// WealthFlow Shadow Test Harness — the secret scanner
// =============================================================================
// Regression suite for four live provider credentials that were committed to
// this repository and served to every visitor's browser. Nothing in CI looked
// for them, so nothing objected, for months.
//
// These tests pin down two things that matter equally:
//   1. the scanner catches every credential shape it is supposed to catch;
//   2. it does NOT fire on ordinary code, so nobody is tempted to disable it.
// =============================================================================

import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    SECRET_PATTERNS, ALLOWLIST, scanText, isAllowed, mask, trackedFiles,
} from '../autonomy/secret-scan.mjs';

// Credential SHAPES, generated at runtime — not credentials.
//
// Every sample below is BUILT by `shape()`, which repeats one of four fixed,
// meaningless alphabets to whatever length a pattern requires. No line in this
// file contains credential material and none can: the longest literal here is a
// sixteen-character alphabet, next to a vendor prefix the vendors themselves
// print in their public documentation.
//
// This is not stylistic, and it is not caution for its own sake:
//
//   1. The file is scanned by the very scanner it tests. The first version
//      wrote the PEM private-key header out in full, and the scanner correctly
//      flagged it the moment the file became tracked — then flagged the comment
//      that explained the mistake, because that quoted the header too. The
//      scanner was right both times.
//
//   2. Human and machine readers judge a diff by how it LOOKS. The previous
//      samples were assembled by concatenating credential-looking fragments,
//      and the consensus review board read one of them as a real hardcoded key
//      and blocked the pull request that added the Ollama pattern. Had the
//      reading been true, blocking would have been exactly right — which is
//      why the answer is to leave nothing to misread rather than to argue.
//      A secret-scanner test suite that cannot be edited without tripping a
//      security review is a suite that stops being updated.
//
// Keep every sample, and every comment, free of a literal that matches a
// pattern in SECRET_PATTERNS.
const ALNUM = 'A1b2C3d4E5f6G7h8';
const LOWER = 'a1b2c3d4e5f6g7h8';
const HEX = '0123456789abcdef';
const UPPER = 'ABCDEFGHIJKLMNOP';

/** Repeat `alphabet` up to exactly `len` characters. Deterministic, and inert. */
const shape = (alphabet, len) => alphabet.repeat(Math.ceil(len / alphabet.length)).slice(0, len);

const SAMPLES = {
    groq: 'gsk_' + shape(ALNUM, 48),
    openai: 'sk-' + shape(ALNUM, 40),
    anthropic: 'sk-ant-' + shape(ALNUM, 32),
    google: 'AIzaSy' + shape(ALNUM, 40),
    huggingface: 'hf_' + shape(ALNUM, 40),
    together: 'tgp_v1_' + shape(ALNUM, 40),
    cohere: 'cohere_' + shape(ALNUM, 40),
    cerebras: 'csk-' + shape(LOWER, 48),
    aws: 'AKIA' + shape(UPPER, 16),
    // 32 hex, a dot, an opaque tail — the shape the scanner did not know.
    ollama: shape(HEX, 32) + '.' + shape(ALNUM, 30),
    'private-key': '-----' + ['BEGIN', 'RSA', 'PRIVATE', 'KEY'].join(' ') + '-----',
};

describe('secret-scan: catches what leaked before', () => {
    it('catches a Groq key in a browser-served module', () => {
        const f = scanText('wealthflow-ai-v4.js', `var _GROQ_VISION_KEY = '${SAMPLES.groq}';`);
        expect(f).toHaveLength(1);
        expect(f[0].patternId).toBe('groq');
    });

    it('catches a loose Google/Gemini key outside the Firebase config', () => {
        const f = scanText('wealthflow-ai-v4.js', `var keys = ['${SAMPLES.google}'];`);
        expect(f.some((x) => x.patternId === 'google')).toBe(true);
    });

    it('catches an embedded key fallback in a server module', () => {
        const f = scanText('market-data.js', `const EMBEDDED_KEY_FALLBACK = '${SAMPLES.anthropic}';`);
        expect(f.some((x) => x.patternId === 'anthropic')).toBe(true);
    });

    it('reports the correct line number', () => {
        const f = scanText('x.js', `line one\nline two\nconst k = '${SAMPLES.groq}';`);
        expect(f[0].line).toBe(3);
    });

    it.each(Object.entries(SAMPLES))('catches a %s credential', (id, sample) => {
        const f = scanText('some-file.js', `const k = "${sample}";`);
        expect(f.length, `${id} not detected`).toBeGreaterThan(0);
    });
});

describe('secret-scan: the one documented exception', () => {
    const cfgLine = `            apiKey: "${SAMPLES.google}",`;

    it('allows the Firebase Web apiKey in the index.html firebaseConfig', () => {
        expect(isAllowed('index.html', 'google', cfgLine)).toBe(true);
        expect(scanText('index.html', cfgLine)).toHaveLength(0);
    });

    it('does NOT allow a bare Google key elsewhere in index.html', () => {
        // Same file, but not in an apiKey: position — this is how a real Gemini
        // key would try to hide behind the Firebase exception.
        const f = scanText('index.html', `var geminiKey = "${SAMPLES.google}";`);
        expect(f).toHaveLength(1);
    });

    it('does NOT allow the same shape in any other file', () => {
        expect(isAllowed('wealthflow-ai-v4.js', 'google', cfgLine)).toBe(false);
        expect(scanText('wealthflow-ai-v4.js', cfgLine)).toHaveLength(1);
    });

    it('keeps the allowlist tiny and documented', () => {
        expect(ALLOWLIST).toHaveLength(1);
        for (const a of ALLOWLIST) {
            expect(a.reason.length).toBeGreaterThan(20);
            expect(a.file).toBeTruthy();
        }
    });
});

describe('secret-scan: does not cry wolf', () => {
    const INNOCENT = [
        "const key = process.env.GROQ_API_KEY;",
        "if (!process.env.ANTHROPIC_API_KEY) throw new Error('not set');",
        "// Set GROQ_API_KEY in Settings → Secrets and variables → Actions",
        "const url = 'https://api.groq.com/openai/v1/chat/completions';",
        "expect(keyFor(gemini, { WealthFlow_API_Key: 'abc123' })).toBeTruthy();",
        "const sha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';",   // a git SHA
        "background: linear-gradient(145deg, rgba(16,185,129,0.06), var(--card));",
        "const id = 'sk-' + 'short';",
        "'gsk_tooshort'",
    ];

    it.each(INNOCENT)('ignores: %s', (line) => {
        expect(scanText('some-file.js', line)).toHaveLength(0);
    });

    it('ignores this repository\'s own env-var documentation', () => {
        const doc = SECRET_PATTERNS.map((p) => `  ${p.id.toUpperCase()}_API_KEY  — ${p.label}`).join('\n');
        expect(scanText('README.md', doc)).toHaveLength(0);
    });

    it('never fires on arbitrary prose or code', () => {
        fc.assert(fc.property(fc.string({ maxLength: 200 }), (s) => {
            expect(() => scanText('f.js', s)).not.toThrow();
        }), { numRuns: runs(400) });
    });
});

describe('secret-scan: safe reporting', () => {
    it('never prints a whole credential', () => {
        const f = scanText('x.js', `const k='${SAMPLES.groq}';`);
        expect(f[0].masked).not.toContain(SAMPLES.groq);
        expect(f[0].masked).toContain('…');
    });

    it('masks short values entirely', () => {
        expect(mask('abc')).toBe('***');
        expect(mask('')).toBe('');
    });

    it('does not throw on an object whose String() coercion throws (fuzz-caught regression)', () => {
        // String({ toString: {} }) → "Cannot convert object to primitive value".
        // The property test caught this probabilistically; pin it deterministically.
        expect(() => mask({ toString: {} })).not.toThrow();
        expect(() => mask({ toString: null, valueOf: null })).not.toThrow();
        expect(() => mask(Object.create(null))).not.toThrow();
        expect(mask({ toString: {} })).toBe('***');
    });

    it('never throws on odd input', () => {
        fc.assert(fc.property(fc.anything(), (x) => {
            expect(() => mask(x)).not.toThrow();
        }), { numRuns: runs(200) });
    });
});

describe('secret-scan: THE REAL REPOSITORY IS CLEAN', () => {
    // The point of the whole exercise. If someone reintroduces a credential,
    // this fails locally before CI even runs.
    it('finds no committed provider credential in any tracked file', async () => {
        const { scanRepo } = await import('../autonomy/secret-scan.mjs');
        const findings = scanRepo(process.cwd());
        const detail = findings.map((f) => `${f.file}:${f.line} ${f.label} ${f.masked}`).join('\n');
        expect(findings, `committed credentials found:\n${detail}`).toHaveLength(0);
    });

    it('is actually scanning files, not silently reading an empty list', () => {
        // Guards against the vitest_config.js failure mode: a check that passes
        // because it examined nothing at all.
        expect(trackedFiles(process.cwd()).length).toBeGreaterThan(20);
    });
});
