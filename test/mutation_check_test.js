import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { changedLines, makeMutants, mutationCheck, weakTestReason, MIN_MUTANTS_TO_JUDGE } from '../autonomy/mutation-check.mjs';

const BEFORE = ['function f(a, b) {', '  return a;', '}', ''].join('\n');
const AFTER = [
    'function f(a, b) {',
    '  if (a >= b && b !== 0) return a + b;',
    '  const ok = true;',
    '  return ok ? a : b;',
    '}', '',
].join('\n');

describe('mutation check on the lines the agent changed', () => {
    it('finds only the changed lines', () => {
        expect(changedLines(BEFORE, AFTER)).toEqual([2, 3, 4]);
    });

    it('mutates only those lines, one mechanical swap per line, and stays within the cap', () => {
        const ms = makeMutants(AFTER, [2, 3, 4], 6);
        expect(ms.map((m) => m.line)).toEqual([2, 3]);
        expect(ms[0].rule).toBe('>= to >');
        expect(ms[0].source.split('\n')[1]).toContain('a > b');
        expect(makeMutants(AFTER, [1, 5]).length).toBe(0);
        const many = Array.from({ length: 40 }, (_, i) => `  const v${i} = x${i} === y${i};`).join('\n');
        expect(makeMutants(many, Array.from({ length: 40 }, (_, i) => i + 1), 6).length).toBe(6);
    });

    it('ignores operators inside strings and comments', () => {
        expect(makeMutants('const s = "a >= b"; // x === y', [1]).length).toBe(0);
    });

    function sandbox(runner) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mut-'));
        fs.writeFileSync(path.join(dir, 'f.js'), AFTER);
        const res = mutationCheck({
            repoDir: dir, targetFile: 'f.js', before: BEFORE, after: AFTER, testFile: 't.test.js', testSource: '// t',
            run: () => runner(fs.readFileSync(path.join(dir, 'f.js'), 'utf8')),
        });
        const restored = fs.readFileSync(path.join(dir, 'f.js'), 'utf8');
        expect(fs.existsSync(path.join(dir, 't.test.js'))).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
        return { res, restored };
    }

    it('a test that fails on every mutant is strong; the fixed file is restored', () => {
        const { res, restored } = sandbox((src) => ({ passed: src === AFTER }));
        expect(res).toMatchObject({ skipped: false, total: 2, killed: 2, weak: false });
        expect(restored).toBe(AFTER);
    });

    it('a test that stays green on mutants is reported with the surviving lines', () => {
        const { res } = sandbox(() => ({ passed: true }));
        expect(res.killed).toBe(0);
        expect(res.survived.map((s) => s.line)).toEqual([2, 3]);
        // two mutants are too few to judge: measured, never called weak
        expect(res.total).toBeLessThan(MIN_MUTANTS_TO_JUDGE);
        expect(res.weak).toBe(false);
        const text = weakTestReason({ killed: 0, total: 4, survived: res.survived });
        expect(text).toContain('0 of 4');
        expect(text).toContain('line 2 (>= to >)');
    });

    it('is called weak only with enough mutants and under half caught', () => {
        const src = Array.from({ length: 6 }, (_, i) => `const v${i} = a${i} === b${i};`).join('\n');
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-mut-'));
        fs.writeFileSync(path.join(dir, 'g.js'), src);
        const base = { repoDir: dir, targetFile: 'g.js', before: '', after: src, testFile: 't.test.js', testSource: '// t' };
        expect(mutationCheck({ ...base, run: () => ({ passed: true }) }).weak).toBe(true);
        expect(mutationCheck({ ...base, run: () => ({ passed: false }) }).weak).toBe(false);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does nothing without a runner or when no mutation fits', () => {
        expect(mutationCheck({ targetFile: 'f.js', testFile: 't', before: '', after: 'x' }).skipped).toBe(true);
        expect(mutationCheck({ targetFile: 'f.js', testFile: 't', before: '', after: 'let a = 1;', run: () => ({ passed: true }) }).skipped).toBe(true);
    });
});
