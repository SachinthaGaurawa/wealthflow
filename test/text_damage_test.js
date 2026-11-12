import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import R from '../wealthflow-statement-router.js';
import { looksGarbled as auditLooksGarbled, statementSelfAudit } from '../wf-statement-self-audit.mjs';

const ai = fs.readFileSync(new URL('../wealthflow-ai-v4.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const row = (description) => ({ description, amount: 100, direction: 'debit' });

describe('a damaged text layer is named by its rows, once, for every reader', () => {
    it('the audit and the router share one detector', () => {
        expect(auditLooksGarbled).toBe(R.looksGarbled);
    });
    it('a few scrambled rows are marked, the statement is still read as text', () => {
        const rows = [row('S1NGER K3ELLS M4RKET C0LOMBO'), ...Array.from({ length: 9 }, (_, i) => row('KEELLS SUPER COLOMBO ' + i))];
        const d = R.textDamage(rows);
        expect(d.bad).toEqual([0]);
        expect(d.whole).toBe(false);
    });
    it('a third or more of the rows scrambled means the text layer cannot be trusted at all', () => {
        const bad = (i) => row('AB��CD EF�GH ' + i);
        const rows = [bad(1), bad(2), bad(3), row('KEELLS SUPER COLOMBO'), row('ONLINE PYMT THANK YOU'), row('DIALOG AXIATA BILL')];
        const d = R.textDamage(rows);
        expect(d.whole).toBe(true);
        expect(d.bad).toHaveLength(3);
    });
    it('fewer than six rows never condemn a statement, and nothing at all is fine', () => {
        expect(R.textDamage([row('��������'), row('��������')]).whole).toBe(false);
        expect(R.textDamage([])).toMatchObject({ rows: 0, bad: [], whole: false });
        expect(R.textDamage(null).whole).toBe(false);
    });
    it('the daily audit still raises garbled-text on the same rule', () => {
        const bad = (i) => ({ description: 'AB��CD EF�GH ' + i, amount: 10, direction: 'debit' });
        expect(statementSelfAudit({ rows: [bad(1), bad(2), bad(3), bad(4), row('A LONG ENOUGH DESC'), row('ANOTHER LONG DESC')] }).map(f => f.kind)).toContain('garbled-text');
    });
});

describe('the page uses it', () => {
    it('a damaged PDF text layer goes to the image scanner, a few damaged rows stay in review', () => {
        expect(ai).toContain('WFStatementRouter.textDamage(_rows)');
        expect(ai).toContain('if (_dmg && _dmg.whole)');
        expect(ai).toContain('_dmg.bad.forEach(function (i)');
    });
    it('the e-mail review keeps damaged rows as doubts', () => {
        expect(html).toContain('window.WFStatementRouter.textDamage(rows)');
    });
});

describe('two more things the reader notices by itself', () => {
    const r = (description, directionSource, direction = 'debit') => ({ description, amount: 10, direction, directionSource });
    const kinds = (rows, card = false) => statementSelfAudit({ rows, card }).map((f) => f.kind);

    it('direction-guessed: most rows proven, a fifth or more only assumed', () => {
        const rows = [
            ...Array.from({ length: 6 }, (_, i) => r('SHOP NUMBER ' + i, 'balance')),
            r('LINE A WITHOUT MARKER', 'assumed'), r('LINE B WITHOUT MARKER', 'assumed'), r('LINE C WITHOUT MARKER', 'assumed'),
        ];
        expect(kinds(rows)).toContain('direction-guessed');
    });
    it('direction-guessed stays quiet when nothing was proven (that is a different, known case), or too few were guessed', () => {
        const all = Array.from({ length: 8 }, (_, i) => r('SHOP NUMBER ' + i, 'assumed'));
        expect(kinds(all)).not.toContain('direction-guessed');
        const few = [...Array.from({ length: 8 }, (_, i) => r('SHOP NUMBER ' + i, 'balance')), r('ONE ASSUMED LINE', 'assumed')];
        expect(kinds(few)).not.toContain('direction-guessed');
    });
    it('card-interest-unexplained: interest on a card that no plan explains; not on a bank statement, not on a plan line', () => {
        const interest = [r('INTEREST CHARGE ON BALANCE', 'balance')];
        expect(kinds(interest, true)).toContain('card-interest-unexplained');
        expect(kinds(interest, false)).not.toContain('card-interest-unexplained');
        expect(kinds([r('INSTALLMENT 03/12 ABANS INTEREST', 'balance')], true)).not.toContain('card-interest-unexplained');
    });
});
