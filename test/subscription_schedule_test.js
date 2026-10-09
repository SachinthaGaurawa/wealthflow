import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const SRC = fs.readFileSync(path.join(process.cwd(), 'wealthflow-subscriptions.js'), 'utf8');

function api() {
    const window = { console: { log() {} } };
    new Function('window', SRC)(window);
    return window.WFSubs;
}

describe('subscription payment schedule', () => {
    it('uses an exact due date for a one-time payment instead of its creation month', () => {
        const S = api();
        const sub = { id: 'o1', cycle: 'once', amount: 1000, dueDay: 20,
            dueDate: '2026-12-20', createdAt: '2026-10-01T00:00:00Z' };
        expect(S.occurrence(sub, new Date('2026-12-18T12:00:00Z'))).toMatchObject({
            active: true, paid: false, date: '2026-12-20', oneTime: true,
        });
        expect(S.occurrence(sub, new Date('2027-01-18T12:00:00Z')).date).toBe('2026-12-20');
    });

    it('marks a one-time payment inactive after completion', () => {
        const S = api();
        const out = S.occurrence({ cycle: 'once', dueDate: '2026-12-20', completed: true }, new Date('2026-12-18T12:00:00Z'));
        expect(out).toMatchObject({ active: false, paid: true, oneTime: true });
    });

    it('does not treat unrelated old recurring history as payment for a newly scheduled one-time bill', () => {
        const S = api();
        const out = S.occurrence({ cycle: 'once', dueDate: '2026-12-20',
            history: [{ month: '2026-08', date: '2026-08-05', amount: 1000 }] }, new Date('2026-12-18T12:00:00Z'));
        expect(out).toMatchObject({ active: true, paid: false, date: '2026-12-20' });
    });

    it('only activates quarterly and yearly bills in their real cycle month', () => {
        const S = api();
        const q = { cycle: 'quarterly', dueDay: 15, createdAt: '2026-01-04T00:00:00Z' };
        expect(S.occurrence(q, new Date('2026-02-10T12:00:00Z')).active).toBe(false);
        expect(S.occurrence(q, new Date('2026-04-10T12:00:00Z')).date).toBe('2026-04-15');
        const y = { cycle: 'yearly', dueDay: 5, createdAt: '2026-08-04T00:00:00Z' };
        expect(S.occurrence(y, new Date('2027-07-01T12:00:00Z')).active).toBe(false);
        expect(S.occurrence(y, new Date('2027-08-01T12:00:00Z')).date).toBe('2027-08-05');
    });

    it('recognises a payment recorded for the current cycle', () => {
        const S = api();
        const sub = { cycle: 'monthly', dueDay: 5, createdAt: '2026-01-01T00:00:00Z',
            history: [{ month: '2026-10', amount: 3000, date: '2026-10-05', source: 'statement' }] };
        expect(S.occurrence(sub, new Date('2026-10-07T12:00:00Z'))).toMatchObject({ active: false, paid: true, date: '2026-10-05' });
    });

    it('closes a one-time payment when a statement records it early or late', () => {
        const S = api();
        const sub = { id: 'o2', cycle: 'once', amount: 1000, dueDay: 20,
            dueDate: '2026-12-20', createdAt: '2026-10-01T00:00:00Z', history: [], monthOverrides: {} };
        S.recordPayment(sub, { date: '2026-11-30', amount: 1000 });
        expect(sub).toMatchObject({ paid: true, completed: true, paidAt: '2026-11-30' });
        expect(S.occurrence(sub, new Date('2026-12-21T12:00:00Z'))).toMatchObject({ active: false, paid: true });
    });

    it('clamps a legacy day 31 to the real last day of a short month', () => {
        const S = api();
        expect(S.legacyDueDate({ cycle: 'once', dueDay: 31, createdAt: '2026-02-02T00:00:00Z' })).toBe('2026-02-28');
        expect(S.legacyDueDate({ cycle: 'once', dueDay: 31, createdAt: '2024-02-02T00:00:00Z' })).toBe('2024-02-29');
    });
});
