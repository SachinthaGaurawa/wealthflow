/* A large pull request is shown to the board with a list of EVERY changed file, sensitive files first, and a file that does not
 * fit is cut with a note instead of vanishing (#566: three reviewers wrote that they could not see files that were in the PR). */
import { describe, it, expect } from 'vitest';
import { prioritiseDiff } from '../consensus-review.mjs';

const file = (name, lines, body = 'const x = 1;') => `diff --git a/${name} b/${name}\n--- a/${name}\n+++ b/${name}\n@@ -0,0 +1,${lines} @@\n` + Array.from({ length: lines }, (_, i) => `+${body} // ${name} ${i}`).join('\n') + '\n';

describe('prioritiseDiff', () => {
    it('returns a small diff untouched', () => {
        const d = file('a.js', 3);
        expect(prioritiseDiff(d, 10_000)).toEqual({ text: d, truncated: false });
    });

    it('lists every changed file, with counts, even when most do not fit', () => {
        const names = Array.from({ length: 12 }, (_, i) => `mod${i}.js`);
        const d = names.map((n) => file(n, 120)).join('');
        const r = prioritiseDiff(d, 12_000);
        expect(r.truncated).toBe(true);
        expect(r.text.length).toBeLessThanOrEqual(12_000);
        for (const n of names) expect(r.text).toContain(`#   ${n}  +120 -0`);
        expect(r.text).toMatch(/\[partly shown\]|\[not shown\]/);
    });

    it('puts a sensitive file first and shows it whole while a plain one is cut with a note', () => {
        const plain = file('docs-notes.js', 400);
        const risky = file('auth-token.js', 60);
        const r = prioritiseDiff(plain + risky, 9_000);
        expect(r.text.indexOf('+const x = 1; // auth-token.js 59')).toBeGreaterThan(-1);   // last line of the sensitive file is there
        expect(r.text).toMatch(/\[\.\.\. \d+ more line\(s\) of docs-notes\.js not shown \.\.\.\]/);
        expect(r.text).toContain('#   docs-notes.js  +400 -0  [partly shown]');
        expect(r.text).toContain('#   auth-token.js  +60 -0');
        expect(r.text).not.toContain('#   auth-token.js  +60 -0  [');
    });

    it('a cut never lands mid-line and the result never exceeds the budget', () => {
        const d = file('big.js', 2000, 'const longerLine = "abcdefghijklmnopqrstuvwxyz";');
        const r = prioritiseDiff(d, 6_000);
        expect(r.text.length).toBeLessThanOrEqual(6_000);
        const body = r.text.split('\n').filter((l) => l.startsWith('+const'));
        expect(body.length).toBeGreaterThan(5);
        for (const l of body) expect(l.endsWith(`big.js ${l.split('big.js ')[1]}`)).toBe(true);   // every shown line is whole
    });

    it('lists all of 60 files even when the budget fits only a few bodies, and never cuts the list', () => {
        const names = Array.from({ length: 60 }, (_, i) => `src/module-number-${i}.js`);
        const d = names.map((n) => file(n, 80)).join('');
        const r = prioritiseDiff(d, 9_000);
        expect(r.text.length).toBeLessThanOrEqual(9_000);
        for (const n of names) expect(r.text).toMatch(new RegExp(`#   ${n.replace(/\./g, '\\.')}  \\+80 -0`));
        expect(r.text.split('\n').filter((l) => l.startsWith('#   ')).length).toBe(60);
    });

    it('past 400 files the list says how many it leaves out', () => {
        const d = Array.from({ length: 450 }, (_, i) => file(`f${i}.js`, 2)).join('');
        const r = prioritiseDiff(d, 40_000);
        expect(r.text).toContain('#   ... and 50 more file(s) not listed');
    });
});
