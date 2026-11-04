// wf-agent-fixes.css is written by an AI agent without a person reading it first, so the file is
// re-validated on every CI run with the same strict reader the agent's own output goes through.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import { validateLaneFile } from '../autonomy/css-lane.mjs';

describe('wf-agent-fixes.css', () => {
    const css = fs.readFileSync('wf-agent-fixes.css', 'utf8');
    it('passes the lane validator as it stands', () => {
        const v = validateLaneFile(css);
        expect(v.problems, v.problems.join('; ')).toEqual([]);
    });
    it('never un-pins the actions column the shell check requires pinned (the #519 regression)', () => {
        // test/e2e/ui-toolbars.mjs: a table that slides sideways must keep its last column position:sticky, or Edit/Delete scroll out of view.
        const blocks = css.replace(/\/\*[\s\S]*?\*\//g, '').split('}');
        const bad = blocks.filter((b) => /\b(th|td)\b/.test(b.split('{')[0]) && /\bposition\s*:/.test(b.split('{')[1] || ''));
        expect(bad.map((b) => b.trim().slice(0, 80))).toEqual([]);
    });
    it('is loaded by the page after wf-ui.css, and only once', () => {
        const html = fs.readFileSync('index.html', 'utf8');
        const ui = html.indexOf('href="/wf-ui.css"');
        const fixes = html.indexOf('href="/wf-agent-fixes.css"');
        expect(ui).toBeGreaterThan(-1);
        expect(fixes).toBeGreaterThan(ui);
        expect(html.split('href="/wf-agent-fixes.css"').length - 1).toBe(1);
    });
});
