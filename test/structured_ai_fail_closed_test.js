import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

describe('structured financial AI remains fail-closed in the browser', () => {
    it('requires the server trust verdict and forbids single-engine fallback', () => {
        expect(HTML).toContain("d.trustworthy === true && d.financialDecision === true");
        expect(HTML).toContain("if (wantJSON) throw new Error('Unverified structured result withheld.')");
        const trustGate = HTML.indexOf('if (wantJSON) throw new Error');
        const fallback = HTML.indexOf('var g = await _tryGemini', trustGate);
        expect(trustGate).toBeGreaterThan(0);
        expect(fallback).toBeGreaterThan(trustGate);
    });

    it('uses an object contract that the unanimous reducer can validate', () => {
        expect(HTML).toContain('{"decisions":[...]}');
        expect(HTML).toContain('payload && Array.isArray(payload.decisions)');
        expect(HTML).toContain('arr.length === items.length');
        expect(HTML).toContain('Number(row.i) === i');
        expect(HTML).toContain("'re_payment'");
    });
});
