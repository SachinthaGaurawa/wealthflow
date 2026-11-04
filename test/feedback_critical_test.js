// Every feedback report is critical, end to end (owner, 2026-11-04): the panel shows no score,
// and the issue the server files carries the label, the title prefix and the words.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

describe('Your Feedback panel: no score, always critical', () => {
    const src = fs.readFileSync('wealthflow-feedback-ai.js', 'utf8');
    it('shows no score or ranking text to the user', () => {
        expect(src).not.toMatch(/score ' \+ pct/);
        expect(src).not.toMatch(/scored by priority/i);
        expect(src).not.toMatch(/Ranked by:/);
        expect(src).not.toMatch(/Repeated reports raise the score/);
    });
    it('puts every cluster at critical and sorts newest first', () => {
        expect(src).toMatch(/clusters\[k\]\.priority = 'critical';/);
        expect(src).toMatch(/clusters\.sort\(function \(a, b\) \{ return b\.latest - a\.latest/);
    });
});

describe('feedback issue: filed as critical and said so in words', () => {
    const src = fs.readFileSync('feedback-triage.js', 'utf8');
    it('labels the issue critical and tells the agent in the body', () => {
        expect(src).toMatch(/labels: \[labelType, fp, 'autonomous', 'user-feedback', 'critical'\]/);
        expect(src).toMatch(/\*\*Priority: CRITICAL\.\*\*/);
    });
});
