import { describe, it, expect } from 'vitest';
import { taskCard, effortFor, cardPrompt, cardMarkdown, DEPTHS, MODES_BY_LANE } from '../autonomy/task-card.mjs';

describe('the task card: the original prompt\'s task parameters, filled in by a program', () => {
    it('depth follows what the change touches', () => {
        expect(effortFor({ role: 'ui', file: 'wealthflow-theme.js', text: 'the button label is too small' }).depth).toBe('standard');
        expect(effortFor({ role: 'bug', file: 'wealthflow-notes.js', text: 'the note box loses focus' }).depth).toBe('deep');
        expect(effortFor({ role: 'feature', file: 'wealthflow-notes.js', text: 'add a pin' }).depth).toBe('deep');
        expect(effortFor({ role: 'bug', file: 'wealthflow-statements.js', text: 'x' }).depth).toBe('comprehensive');
        expect(effortFor({ role: 'bug', file: 'wealthflow-home.js', text: 'The total balance is wrong and a statement was counted twice' }).depth).toBe('comprehensive');
        expect(effortFor({ role: 'ui', file: 'wealthflow-theme.js', text: 'x', guarded: true }).depth).toBe('comprehensive');
        expect(effortFor({ lane: 'build', role: 'feature', text: 'a calculator' }).depth).toBe('deep');
        // CSS in a real browser, even on a money screen name, is a layout change
        expect(effortFor({ lane: 'layout', role: 'ui', file: 'cc-instalments screen', text: 'overlap' }).depth).toBe('standard');
        for (const d of ['standard', 'deep', 'comprehensive']) expect(DEPTHS).toContain(d);
    });

    it('every parameter of the original is on the card, in the owner\'s words where they are the owner\'s', () => {
        const c = taskCard({ issue: { title: 'Total shows 10 less than the statement', number: 77 }, role: 'bug', file: 'wealthflow-statements.js', text: 'balance total wrong' });
        expect(c.outcome).toBe('Total shows 10 less than the statement');
        expect(c.depth).toBe('comprehensive');
        expect(c.depthWhy.length).toBeGreaterThan(0);
        for (const k of ['horizon', 'scope', 'format', 'evidence', 'constraints', 'criteria', 'modes']) expect(c[k] && c[k].length).toBeGreaterThan(0);
        expect(c.evidence.join(' ')).toMatch(/fails on the original file and passes on the changed one/);
        expect(c.evidence.join(' ')).toMatch(/real phone/);          // comprehensive depth asks for the one check no run here can do
        expect(c.criteria.join(' ')).toMatch(/canary/);
        expect(c.constraints.join(' ')).toMatch(/public/);
        expect(c.modes).toEqual(MODES_BY_LANE.bug);
    });

    it('lanes differ: layout is measured, build is machine-checked, a standard change does not ask for the analysis', () => {
        const lay = taskCard({ issue: { title: 'overlap' }, role: 'ui', lane: 'layout' });
        expect(lay.evidence.join(' ')).toMatch(/real Chromium/);
        expect(lay.format).toMatch(/CSS only/);
        const b = taskCard({ issue: { title: 'new page' }, role: 'feature', lane: 'build' });
        expect(b.evidence.join(' ')).toMatch(/cannot write to the books/);
        const std = taskCard({ issue: { title: 'colour' }, role: 'ui', file: 'wealthflow-theme.js', text: 'colour' });
        expect(std.depth).toBe('standard');
        expect(std.evidence.join(' ')).not.toMatch(/independent analysis/);
        expect(taskCard({ issue: { title: 'x' }, role: 'bug', depth: 'deep' }).depthWhy).toEqual(['set by the caller']);
    });

    it('the prompt block and the PR section say a program wrote them and carry the owner\'s words once', () => {
        const c = taskCard({ issue: { title: 'Hide the zero rows' }, role: 'ui', file: 'wealthflow-theme.js', text: 'x' });
        const p = cardPrompt(c);
        expect(p).toMatch(/^TASK CARD \(written by a program/);
        expect(p).toMatch(/Desired outcome: Hide the zero rows/);
        expect(p).toMatch(/FORMAT FIRST/);
        expect(p.length).toBeLessThan(2400);
        expect(cardMarkdown(c)).toMatch(/### Task card/);
        expect(cardMarkdown(c)).toMatch(/never opens or closes a gate/);
        expect(cardPrompt(null)).toBe('');
        expect(cardMarkdown(undefined)).toBe('');
    });
});
