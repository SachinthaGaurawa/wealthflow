// One update for the feedback of one day; a lone report gets its own, at once; nothing waits for weeks (owner, 2026-11-07).
import { describe, it, expect } from 'vitest';
import { dayKey, isFeedback, siblingsOf, quietWaitSeconds, groupTitle, MAX_GROUP } from '../autonomy/feedback-group.mjs';

const fb = (number, created_at, extra = []) => ({ number, created_at, title: `[CRITICAL] report ${number}`, labels: [{ name: 'user-feedback' }, ...extra.map((name) => ({ name }))] });

describe('which reports ride together', () => {
    it('the day is the owner\'s day in Sri Lanka, not UTC', () => {
        expect(dayKey('2026-11-07T18:00:00Z')).toBe('2026-11-07');     // 23:30 in Colombo
        expect(dayKey('2026-11-07T19:00:00Z')).toBe('2026-11-08');     // 00:30 next day in Colombo
        expect(dayKey('nonsense')).toBe(null);
    });
    it('three reports on one day go together; one from another day does not', () => {
        const first = fb(1, '2026-11-07T04:00:00Z');
        const list = [first, fb(2, '2026-11-07T09:00:00Z'), fb(3, '2026-11-07T15:00:00Z'), fb(4, '2026-11-06T09:00:00Z'), fb(5, '2026-11-07T19:30:00Z')];
        expect(siblingsOf(first, list).map((i) => i.number)).toEqual([2, 3]);
    });
    it('a lone report has no siblings, so it ships by itself', () => {
        const only = fb(1, '2026-11-07T04:00:00Z');
        expect(siblingsOf(only, [only])).toEqual([]);
    });
    it('only reports from the feedback form are grouped, and the group is capped, least severe cut first', () => {
        const first = fb(1, '2026-11-07T04:00:00Z');
        const issue = { number: 9, created_at: '2026-11-07T05:00:00Z', labels: [{ name: 'bug' }] };
        expect(isFeedback(issue)).toBe(false);
        const many = Array.from({ length: 12 }, (_, i) => fb(i + 2, '2026-11-07T06:00:00Z'));
        const sib = siblingsOf(first, [first, issue, ...many]);
        expect(sib.length).toBe(MAX_GROUP - 1);
        expect(sib.map((i) => i.number)).toEqual([2, 3, 4, 5]);
        expect(siblingsOf(issue, [issue, first])).toEqual([]);
    });
});

describe('when the fix run starts', () => {
    const t = Date.parse('2026-11-07T10:00:00Z');
    it('waits until the burst is over, counted from the newest report', () => {
        expect(quietWaitSeconds({ now: t, newestAt: t, oldestAt: t })).toBe(15 * 60);
        expect(quietWaitSeconds({ now: t, newestAt: t - 10 * 60_000, oldestAt: t - 10 * 60_000 })).toBe(5 * 60);
    });
    it('starts at once when nothing new arrived for a quarter of an hour', () => {
        expect(quietWaitSeconds({ now: t, newestAt: t - 16 * 60_000, oldestAt: t - 16 * 60_000 })).toBe(0);
        expect(quietWaitSeconds({ now: t, newestAt: null, oldestAt: null })).toBe(0);
    });
    it('never holds the oldest report for more than 45 minutes however long the burst runs', () => {
        expect(quietWaitSeconds({ now: t, newestAt: t, oldestAt: t - 40 * 60_000 })).toBe(5 * 60);
        expect(quietWaitSeconds({ now: t, newestAt: t, oldestAt: t - 50 * 60_000 })).toBe(0);
    });
});

describe('the title of the one pull request', () => {
    it('names a lone fix as before and a group as one update', () => {
        expect(groupTitle([{ title: '[CRITICAL] fix: Save button does nothing' }])).toBe('fix: Save button does nothing');
        expect(groupTitle([{ title: '[HIGH] Save button' }, { title: 'x' }, { title: 'y' }])).toBe('fix: 3 reports in one update (Save button and 2 more)');
        expect(groupTitle([])).toBe('fix: automated patch');
    });
});
