import { describe, expect, it } from 'vitest';
import { monthOf, seriesOf, coverageOf, gapQuery, domainsOf, filenameStem, auditLogOf, gridOf, gridLines, bankKeyOf, _internal } from '../statement-coverage.mjs';

const at = iso => Date.parse(iso + 'T12:00:00Z');
const ntb = (month, extra = {}) => ({ bank: 'NTB', filename: `Consolidated_eStatement_2026${month}_458290.html`, status: 'filed', filed: true, from: 'Statements <statements@nationstrust.com>', ...extra });
const amex = (month, extra = {}) => ({ bank: 'AMEX', filename: `eStatement_376657XXXXX0276_2026${month}_265604.html`, status: 'filed', filed: true, from: 'card@nationstrust.com', ...extra });

describe('the month a statement is for', () => {
    it('reads it from the file name in every shape banks use', () => {
        expect(monthOf({ filename: 'Consolidated_eStatement_2026MAR_458,290.html' })).toBe('2026-03');
        expect(monthOf({ filename: 'eStatement_376657XXXXX0276_2026AUG_265604.html' })).toBe('2026-08');
        expect(monthOf({ filename: 'statement-2026-11.pdf' })).toBe('2026-11');
        expect(monthOf({ filename: 'Stmt_202604.pdf' })).toBe('2026-04');
        expect(monthOf({ filename: 'Statement Dec 2025.pdf' })).toBe('2025-12');
        expect(monthOf({ filename: 'x_2026_jan.pdf' })).toBe('2026-01');
    });
    it('falls back to the month it arrived when the name says nothing, and to nothing when it knows nothing', () => {
        expect(monthOf({ filename: '5996631318_455.pdf', receivedMs: at('2026-07-03') })).toBe('2026-07');
        expect(monthOf({ filename: 'a.pdf' })).toBe('');
    });
});

describe('one series per statement product', () => {
    it('is the same across months and different across products, even from one mailbox', () => {
        expect(seriesOf(ntb('JAN'))).toBe(seriesOf(ntb('MAR')));
        expect(seriesOf(ntb('JAN'))).not.toBe(seriesOf(amex('JAN')));
        expect(seriesOf({ bank: 'NTB', filename: 'Consolidated_eStatement_2026JAN_111.html' })).toBe(seriesOf({ bank: 'NTB', filename: 'Consolidated_eStatement_2026JUN_999999.html' }));
    });
});

describe('which months are missing', () => {
    const now = at('2026-09-30');
    it('finds a hole between two statements that are present', () => {
        const c = coverageOf([ntb('JAN'), ntb('FEB'), ntb('APR'), ntb('MAY'), ntb('JUN'), ntb('JUL'), ntb('AUG')], { now });
        expect(c.series).toHaveLength(1);
        expect(c.series[0].missing).toEqual(['2026-03']);
        expect(c.missing).toBe(1);
    });
    it('a complete run has none, and the current month is not yet due', () => {
        const c = coverageOf(['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG'].map(m => ntb(m)), { now });
        expect(c.series[0].missing).toEqual([]);
    });
    it('expects the latest month once it is over and the bank has had time to send it', () => {
        const items = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL'].map(m => ntb(m));
        expect(coverageOf(items, { now: at('2026-09-05') }).series[0].missing).toEqual([]);           // AUG is over but not yet due
        expect(coverageOf(items, { now: at('2026-09-30') }).series[0].missing).toEqual(['2026-08']);   // AUG is due
        expect(coverageOf(items, { now: at('2026-10-20') }).series[0].missing).toEqual(['2026-08', '2026-09']);
    });
    it('does not flag a series that stopped long ago — a closed account is not a hole', () => {
        const c = coverageOf([ntb('JAN'), ntb('FEB'), ntb('MAR')], { now: at('2026-09-30') });
        expect(c.series[0].missing).toEqual([]);
    });
    it('keeps products apart: American Express missing a month says nothing about NTB', () => {
        const c = coverageOf([...['JAN', 'FEB', 'MAR'].map(m => ntb(m)), ...['JAN', 'MAR'].map(m => amex(m))], { now: at('2026-03-30') });
        expect(c.series.find(s => /estatement_#/.test(s.key) && s.bank === 'AMEX').missing).toEqual(['2026-02']);
        expect(c.series.find(s => s.bank === 'NTB').missing).toEqual([]);
    });
    it('counts a statement in review as present — it arrived; only its reading is pending', () => {
        const c = coverageOf([ntb('JAN'), ntb('FEB', { status: 'needs_review', filed: false }), ntb('MAR')], { now: at('2026-04-01') });
        expect(c.series[0].missing).toEqual([]);
        expect(c.series[0].months['2026-02']).toBe('review');
    });
    it('the better of two copies of one month wins', () => {
        const c = coverageOf([ntb('JAN', { status: 'needs_review', filed: false }), ntb('JAN')], { now: at('2026-02-20') });
        expect(c.series[0].months['2026-01']).toBe('filed');
    });
    it('ignores documents it cannot place in a month', () => {
        expect(coverageOf([{ bank: 'X', filename: 'a.pdf' }, { bank: 'Y' }, null], { now }).series).toEqual([]);
    });
    it('does month arithmetic across a year boundary', () => {
        expect(_internal.addMonths('2026-12', 1)).toBe('2027-01');
        expect(_internal.addMonths('2026-01', -1)).toBe('2025-12');
        const c = coverageOf([ntb('NOV'), { ...ntb('JAN'), filename: 'Consolidated_eStatement_2027JAN_1.html' }].map(x => x), { now: at('2027-02-25') });
        expect(c.series[0].missing).toEqual(['2026-12']);
    });
});

describe('looking for a missing month', () => {
    it('searches everything the bank\'s domain sent around that month, with no attachment filter', () => {
        expect(gapQuery('2026-03', ['nationstrust.com'])).toBe('after:2026/03/01 before:2026/04/22 {from:nationstrust.com}');
        expect(gapQuery('2026-12', ['nationstrust.com', 'americanexpress.com'])).toBe('after:2026/12/01 before:2027/01/22 {from:nationstrust.com from:americanexpress.com}');
        expect(gapQuery('2026-03', [])).toBe('');
    });
    it('takes the domains out of the stored From headers, whatever the display name says', () => {
        expect(domainsOf(['"Statements <x@evil.example>" <statements@nationstrust.com>', 'card@Nationstrust.com', 'no address'])).toEqual(['nationstrust.com']);
    });
});

describe('filenameStem: what "the same kind of statement" means', () => {
    it('is the same for every month and account number of one series, and differs between series', () => {
        expect(filenameStem('Consolidated_eStatement_2026JAN_458290.html')).toBe(filenameStem('Consolidated_eStatement_2026MAR_458290.html'));
        expect(filenameStem('Consolidated_eStatement_2026JAN_458290.html')).toBe(filenameStem('Consolidated_eStatement_2027DEC_999999.html'));
        expect(filenameStem('Consolidated_eStatement_2026JAN_458290.html')).not.toBe(filenameStem('eStatement_0276_2026MAY.html'));
        expect(filenameStem('')).toBe('');
        expect(filenameStem(undefined)).toBe('');
    });
});

describe('auditLogOf: one line per statement, saying what became of it', () => {
    const item = (o = {}) => ({ id: 'i', bank: 'NTB', filename: 'Consolidated_eStatement_2026MAR_458290.html', status: 'filed', filed: true, storedMs: at('2026-04-02'), contentSha256: 'a'.repeat(64), ...o });
    it('calls a statement from the normal path Synced and one the audit, a gap search, a sibling address or the owner found Missing-Added', () => {
        const [a] = auditLogOf([item()]);
        expect(a).toMatchObject({ status: 'Synced', math: 'NOT-RECORDED', month: '2026-03', sha: 'aaaaaaaaaaaa' });
        for (const via of ['audit', 'gap', 'series', 'owner']) expect(auditLogOf([item({ via })])[0].status).toBe('Missing-Added');
    });
    it('reports the maths a statement proved when it was filed, and never claims a proof that was not kept', () => {
        expect(auditLogOf([item({ proof: { math: 'passed', last4: '8057', closing: 1234.5 } })])[0]).toMatchObject({ math: 'PASSED', last4: '8057', closing: 1234.5 });
        expect(auditLogOf([item({ proof: { math: 'owner-confirmed' } })])[0].math).toBe('OWNER-CONFIRMED');
        expect(auditLogOf([item({ proof: { math: 'unchecked' } })])[0].math).toBe('NOT-RECORDED');
        expect(auditLogOf([item({ emptyStatement: true })])[0]).toMatchObject({ status: 'Synced', math: 'PASSED' });
    });
    it('separates waiting, retrying, asking the owner, and refused', () => {
        const log = auditLogOf([item({ status: 'pending', filed: false, filename: 'a_2026JAN.html' }), item({ status: 'pending', filed: false, retryCount: 2, filename: 'b_2026FEB.html' }),
            item({ status: 'needs_review', filed: false, reviewReason: 'statement-layout-or-reconciliation-needs-review', filename: 'c_2026MAR.html' }),
            item({ status: 'needs_review', filed: false, reviewReason: 'PASSWORD_FAILED', filename: 'd_2026APR.html' }),
            item({ status: 'rejected_non_statement', filed: false, filename: 'e_2026MAY.html' })]);
        const by = Object.fromEntries(log.map(e => [e.file[0], [e.status, e.math]]));
        expect(by).toEqual({ a: ['Queued', 'NOT-CHECKED'], b: ['Failed-Queued', 'NOT-CHECKED'], c: ['Needs-Review', 'FAILED'], d: ['Needs-Review', 'NOT-CHECKED'], e: ['Rejected', 'NOT-CHECKED'] });
    });
    it('is newest month first, bounded, skips entries with no file name, and is safe to store (no undefined anywhere)', () => {
        const many = Array.from({ length: 80 }, (_, i) => item({ id: 'x' + i, filename: `Consolidated_eStatement_2026${['JAN', 'FEB', 'MAR', 'APR'][i % 4]}_${i}.html` }));
        const log = auditLogOf([...many, { id: 'nofile', status: 'filed' }]);
        expect(log).toHaveLength(60);
        expect(log[0].month >= log.at(-1).month).toBe(true);
        expect(JSON.stringify(log)).not.toContain('undefined');
        expect(JSON.parse(JSON.stringify(log))).toEqual(log);
        expect(auditLogOf(null)).toEqual([]);
    });
});

describe('"DFCC Bank Statement - Aug 26.pdf" is August 2026, not the month it arrived', () => {
    const pdf = (mon, received, extra = {}) => ({ bank: 'DFCC Bank', filename: `DFCC Bank Statement - ${mon}.pdf`, receivedMs: at(received), status: 'filed', filed: true, ...extra });
    it('reads a month word and two digits as the month of that year, whichever month the mail arrived in', () => {
        expect(monthOf(pdf('Aug 26', '2026-09-04'))).toBe('2026-08');        // arrived the month after: it said September before, and the owner looked for August
        expect(monthOf(pdf('Jan 26', '2026-02-03'))).toBe('2026-01');
        expect(monthOf(pdf('Dec 25', '2026-01-03'))).toBe('2025-12');
        expect(monthOf(pdf('Aug 26', '2026-08-31'))).toBe('2026-08');
    });
    it('reads it as a day when the year would be a statement from the future, and never without a date of arrival', () => {
        expect(monthOf(pdf('Mar 12', '2026-04-02'))).toBe('2026-03');
        expect(monthOf(pdf('Nov 30', '2026-01-02'))).toBe('2025-11');
        expect(monthOf({ bank: 'DFCC Bank', filename: 'DFCC Bank Statement - Aug 26.pdf' })).toBe('');
    });
    it('still takes a full year and a month in the name before anything else', () => {
        expect(monthOf({ filename: 'DFCC_Statement_202605.html', receivedMs: at('2026-06-04') })).toBe('2026-05');
    });
    it('every month of such a file name is one series, not one per month', () => {
        expect(seriesOf(pdf('Aug 26', '2026-09-04'))).toBe(seriesOf(pdf('Jan 26', '2026-02-03')));
        const c = coverageOf([pdf('May 26', '2026-06-03'), pdf('Jun 26', '2026-07-03'), pdf('Aug 26', '2026-09-04')], { now: at('2026-09-30') });
        expect(c.series).toHaveLength(1);
        expect(c.series[0].missing).toEqual(['2026-07']);
    });
});

describe('one bank under two labels is one bank', () => {
    it('"DFCC Bank" and "Dfccbank", "HNB" and "Hnb" share a key; different banks do not', () => {
        expect(bankKeyOf('Dfccbank')).toBe(bankKeyOf('DFCC Bank'));
        expect(bankKeyOf('Hnb')).toBe(bankKeyOf('HNB'));
        expect(bankKeyOf('NTB')).not.toBe(bankKeyOf('AMEX'));
        expect(bankKeyOf('Some Unknown Bank')).toBe('someunknown');
    });
    it('a statement that came under the other label fills the month instead of leaving a hole in each', () => {
        const a = m => ({ bank: 'Dfccbank', filename: `DFCC_Statement_2026${m}.html`, status: 'filed', filed: true });
        const b = m => ({ bank: 'DFCC Bank', filename: `DFCC_Statement_2026${m}.html`, status: 'filed', filed: true });
        const c = coverageOf([a('05'), b('06'), a('07')], { now: at('2026-07-30') });
        expect(c.series).toHaveLength(1);
        expect(c.series[0].missing).toEqual([]);
    });
});

describe('gridOf: what the books hold, bank by bank and month by month', () => {
    const f = (bank, filename, extra = {}) => ({ bank, filename, status: 'filed', filed: true, receivedMs: at('2026-09-04'), ...extra });
    it('puts August where August is, counts the rows each month brought in, and counts a second copy of a statement once', () => {
        const grid = gridOf([
            f('DFCC Bank', 'DFCC Bank Statement - Aug 26.pdf', { proof: { rows: 77 } }),
            f('Dfccbank', 'DFCC_Statement_202608.html', { proof: { rows: 119, math: 'duplicate-of' }, duplicateOf: 'x' }),
            f('Dfccbank', 'DFCC_Statement_202607.html', { totalRows: 90, receivedMs: at('2026-08-04') }),
            f('HNB', '074.pdf', { emptyStatement: true }),
        ]);
        const dfcc = grid.find(g => /dfcc/i.test(g.bank));
        expect(dfcc.months['2026-08']).toEqual(['filed', 77]);
        expect(dfcc.months['2026-07']).toEqual(['filed', 90]);
        expect(Object.keys(dfcc.months)).toEqual(['2026-08', '2026-07']);      // newest first
        expect(grid.find(g => /hnb/i.test(g.bank)).months['2026-09']).toEqual(['empty', 0]);
    });
    it('shows a statement that is waiting or in review as that, and is bounded and safe to store', () => {
        const grid = gridOf([f('NTB', 'Consolidated_eStatement_2026MAR_1.html', { status: 'needs_review', filed: false }), ...Array.from({ length: 30 }, (_, i) => f('HNB', `s_${2020 + Math.floor(i / 12)}${['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'][i % 12]}.pdf`))]);
        expect(grid.find(g => g.bank === 'NTB' || /nations/i.test(g.bank)).months['2026-03'][0]).toBe('review');
        const hnb = grid.find(g => /hnb/i.test(g.bank));
        expect(Object.keys(hnb.months)).toHaveLength(18);
        expect(hnb.earlier).toBe(12);
        expect(JSON.parse(JSON.stringify(grid))).toEqual(grid);
        expect(gridOf(null)).toEqual([]);
    });
    it('formats a bank as one line the overlay shows as it is', () => {
        const lines = gridLines([{ bank: 'DFCC Bank', months: { '2026-08': ['filed', 119], '2026-07': ['review', 0], '2026-06': ['empty', 0] }, earlier: 3 }]);
        expect(lines).toEqual(['DFCC Bank: 2026-08 filed (119 rows) · 2026-07 in review · 2026-06 nothing moved · 3 earlier']);
        expect(gridLines(null)).toEqual([]);
    });
    it('the audit log carries the rows each statement brought in', () => {
        expect(auditLogOf([f('DFCC Bank', 'DFCC Bank Statement - Aug 26.pdf', { proof: { rows: 77 } })])[0]).toMatchObject({ month: '2026-08', rows: 77 });
        expect(auditLogOf([f('DFCC Bank', 'DFCC Bank Statement - Aug 26.pdf')])[0].rows).toBe(0);
    });
});
