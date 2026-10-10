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

    it('keeps legacy monthly bills active when they predate createdAt', () => {
        const S = api();
        const sub = { cycle: 'monthly', dueDay: 12, amount: 2500 };
        expect(S.occurrence(sub, new Date('2026-10-10T12:00:00Z'))).toMatchObject({
            active: true, paid: false, date: '2026-10-12', cycle: 'monthly',
        });
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

    it('keeps an explicitly reopened one-time payment actionable despite old statement history', () => {
        const S = api();
        const sub = { id: 'o3', cycle: 'once', amount: 1000, dueDay: 20,
            dueDate: '2026-12-20', createdAt: '2026-10-01T00:00:00Z', reopened: true,
            history: [{ month: '2026-12', date: '2026-12-18', amount: 1000, source: 'statement' }],
            monthOverrides: { '2026-12': 1000 } };
        expect(S.occurrence(sub, new Date('2026-12-21T12:00:00Z'))).toMatchObject({ active: true, paid: false });
        S.recordPayment(sub, { date: '2026-12-22', amount: 1000 });
        expect(sub.reopened).toBe(false);
        expect(S.occurrence(sub, new Date('2026-12-23T12:00:00Z'))).toMatchObject({ active: false, paid: true });
    });

    it('an exact re-import of a payment already on a reopened bill does not close it again', () => {
        const S = api();
        const sub = { id: 'o4', cycle: 'once', amount: 1000, dueDay: 20, dueDate: '2026-12-20', createdAt: '2026-10-01T00:00:00Z', reopened: true,
            history: [{ month: '2026-12', date: '2026-12-18', amount: 1000, source: 'statement' }], monthOverrides: { '2026-12': 1000 } };
        const r = S.recordPayment(sub, { date: '2026-12-18', amount: 1000 });
        expect(r.added).toBe(false);
        expect(sub.reopened).toBe(true);
        expect(sub.paid).toBeFalsy();
    });

    it('clamps a legacy day 31 to the real last day of a short month', () => {
        const S = api();
        expect(S.legacyDueDate({ cycle: 'once', dueDay: 31, createdAt: '2026-02-02T00:00:00Z' })).toBe('2026-02-28');
        expect(S.legacyDueDate({ cycle: 'once', dueDay: 31, createdAt: '2024-02-02T00:00:00Z' })).toBe('2024-02-29');
    });

    it('a finished one-time bill is not matched by a later charge from the same merchant, but an exact re-import and a reopened bill still are', () => {
        const S = api();
        const route = { subName: 'Landlord' };
        const done = { id: 'o1', name: 'Landlord', cycle: 'once', dueDate: '2026-09-20', paid: true, completed: true,
            merchantKeys: ['desc:landlord'], history: [{ month: '2026-09', amount: 500, date: '2026-09-20', source: 'statement' }] };
        const later = { date: '2026-10-21', amount: -700, description: 'Landlord' };
        const r = S.applyToArrays(later, route, [done], {});
        expect(r.created).toBe(true);
        expect(r.subscriptions[0].history).toHaveLength(1);
        const again = S.applyToArrays({ date: '2026-09-20', amount: -500, description: 'Landlord' }, route, [done], {});
        expect(again.created).toBe(false);
        expect(again.paymentAdded).toBe(false);
        const reopened = S.applyToArrays(later, route, [{ ...done, reopened: true }], {});
        expect(reopened.created).toBe(false);
    });

    it('the page: a Paid answer in the verification queue finishes a one-time bill, and a one-time bill counts in its own past-due month', () => {
        const page = fs.readFileSync(path.join(process.cwd(), 'index.html'), 'utf8');
        expect(page).toMatch(/if \(row\.oneTime\) \{[^]*?paidSource: 'queue', reopened: false/);
        expect(page).toMatch(/if \(!onceBill && created && \(created\.getFullYear\(\) > year/);
    });
});
