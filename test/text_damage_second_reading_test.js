import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import R from '../wealthflow-statement-router.js';

const ai = fs.readFileSync(new URL('../wealthflow-ai-v4.js', import.meta.url), 'utf8');
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const t = (date, narration, amount, direction = 'debit') => ({ date, narration, amount, direction });

describe('a second reading mends the words of scrambled rows, never the money', () => {
    const rows = [t('01/03/2026', 'S1NGER K3ELLS M4RKET', 1250.5), t('02/03/2026', 'DIALOG AXIATA BILL', 800), t('03/03/2026', 'AB�CD EF�GH IJ', 99.99)];
    it('adopts the words of a row with the same date, amount and direction', () => {
        const other = [t('01/03/2026', 'KEELLS SUPER MARKET', 1250.5), t('02/03/2026', 'DIALOG AXIATA BILL', 800)];
        const r = R.repairDamagedRows(rows, other, [0, 2]);
        expect(r.repaired).toEqual([0]);
        expect(r.stillBad).toEqual([2]);
        expect(r.rows[0].narration).toBe('KEELLS SUPER MARKET');
        expect(r.rows[0].amount).toBe(1250.5);
        expect(r.rows[0].date).toBe('01/03/2026');
        expect(rows[0].narration).toBe('S1NGER K3ELLS M4RKET');         // the input is not changed
    });
    it('does not mend from a different amount, a different day or the opposite direction', () => {
        const r = R.repairDamagedRows(rows, [t('01/03/2026', 'KEELLS SUPER MARKET', 1250.51), t('02/03/2026', 'KEELLS SUPER MARKET', 1250.5), t('01/03/2026', 'KEELLS SUPER MARKET', 1250.5, 'credit')], [0]);
        expect(r.repaired).toEqual([]);
        expect(r.stillBad).toEqual([0]);
    });
    it('does not take words that are scrambled themselves, and uses each second-reading row once', () => {
        const two = [t('01/03/2026', 'S1NGER K3ELLS M4RKET', 100), t('01/03/2026', 'S1NGER K3ELLS M4RKET', 100)];
        expect(R.repairDamagedRows(two, [t('01/03/2026', 'AB�CD EF�GH', 100)], [0]).repaired).toEqual([]);
        const once = R.repairDamagedRows(two, [t('01/03/2026', 'CITY HOSPITAL PHARMACY', 100)], [0, 1]);
        expect(once.repaired).toEqual([0]);
        expect(once.stillBad).toEqual([1]);
    });
    it('a zero amount never matches, and empty input is safe', () => {
        expect(R.repairDamagedRows([t('01/03/2026', 'S1NGER K3ELLS M4RKET', 0)], [t('01/03/2026', 'KEELLS SUPER MARKET', 0)], [0]).repaired).toEqual([]);
        expect(R.repairDamagedRows(null, null, null)).toEqual({ rows: [], repaired: [], stillBad: [] });
    });
    it('is wired into the page upload, and the e-mail review holds a wholly scrambled statement', () => {
        expect(ai).toContain('_wfRereadDamaged');
        expect(ai).toContain('repairDamagedRows');
        expect(ai).toContain('read again from the page picture');
        expect(html).toContain("why: 'TEXT_DAMAGED'");
    });
});
