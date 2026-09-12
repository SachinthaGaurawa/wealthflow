import { describe, it, expect } from 'vitest';
import { learnCloudLayout, proposeCloudLayouts, validateCloudTemplate } from '../statement-layout.mjs';
import { readStatement } from '../statement-reader.mjs';

const text = 'Nations Trust Bank Credit Card Statement\n14.09.2026 SHOP 123.45 DR\n15.09.2026 PAYMENT 50.00 CR';
const rows = [{ date: '2026-09-14', amount: 123.45, direction: 'debit' }, { date: '2026-09-15', amount: 50, direction: 'credit' }];
describe('durable bank scoped learned layouts', () => {
    it('derives a template from complete human rows and reuses it on a future statement', async () => {
        const learned = await learnCloudLayout(text, rows, { bank: 'NTB' });
        expect(learned.ok).toBe(true);
        expect(learned.template.id).toBeTruthy();
        const future = '<html><body><p>Nations Trust Bank Credit Card Statement</p><p>16.10.2026 SHOP 200.00 DR</p></body></html>';
        const parsed = await readStatement({ bytes: Buffer.from(future), filename: 'statement.html', bank: 'NTB', layouts: [learned.template] });
        expect(parsed.parsed.rows[0]).toMatchObject({ date: '2026-10-16', amount: 200, direction: 'debit' });
        expect(parsed.parsed.layout.learnedTemplate).toBe(learned.template.id);
    });
    it('rejects incomplete mappings, changed direction, extra repeated rows and impossible dates', async () => {
        expect((await learnCloudLayout(text, rows.slice(0, 1), { bank: 'NTB' })).ok).toBe(false);
        expect((await learnCloudLayout(text, [{ ...rows[0], direction: 'credit' }, rows[1]], { bank: 'NTB' })).ok).toBe(false);
        expect((await learnCloudLayout(text, [...rows, rows[0]], { bank: 'NTB' })).ok).toBe(false);
        await expect(learnCloudLayout(text, [{ ...rows[0], date: '2026-02-31' }], { bank: 'NTB' })).rejects.toThrow();
    });
    it('never compiles arbitrary persisted regex or crosses bank boundaries', async () => {
        const learned = await learnCloudLayout(text, rows, { bank: 'NTB' });
        expect(() => validateCloudTemplate({ ...learned.template, re: '(a+)+$' }, 'NTB')).toThrow('INVALID_LAYOUT_TEMPLATE');
        expect(() => validateCloudTemplate(learned.template, 'HNB')).toThrow('INVALID_LAYOUT_TEMPLATE');
        const parsed = await readStatement({ bytes: Buffer.from('<html><body>14.09.2026 SHOP 123.45 DR</body></html>'), filename: 's.html', bank: 'HNB', layouts: [learned.template] });
        expect(parsed.parsed.rows).toHaveLength(0);
    });
    it('offers proposals from inert text without treating proposals as confirmation', async () => {
        const candidates = await proposeCloudLayouts(text, { bank: 'NTB' });
        expect(candidates.length).toBeGreaterThan(0);
        expect(candidates[0].template.bank).toBe('NTB');
    });
});
