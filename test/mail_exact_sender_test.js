import { describe, expect, it } from 'vitest';
import { addSender, approvedClauses, hasApproved, matchSender, policyFrom, setStatus } from '../wealthflow-mail-senders.mjs';
import { planMessage, selectAttachments } from '../wealthflow-mail-ingest.mjs';
import { windowFor } from '../gmail-scan.mjs';

describe('exact sender intake boundary', () => {
    const entry = { id: 'statement@hnb.lk', status: 'approved' };
    const mail = (subject, filename, from = entry.id) => ({
        id: 'm-' + filename,
        internalDate: '1788000000000',
        payload: {
            headers: [
                { name: 'From', value: from },
                { name: 'Subject', value: subject },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@hnb.lk' },
            ],
            parts: [{ filename, mimeType: 'application/pdf', body: { attachmentId: 'a', size: 500 } }],
        },
    });
    it('legacy domains and wildcards never authorize an import or a query', () => {
        for (const id of ['hnb.lk', '@hnb.lk', '*.hnb.lk', '*@hnb.lk', 'x@hnb.lk OR from:evil.example']) {
            const list = [{ id, status: 'approved' }];
            expect(matchSender(list, 'statement@hnb.lk').verdict).not.toBe('approved');
            expect(approvedClauses(list)).toEqual([]);
            expect(hasApproved(list)).toBe(false);
        }
    });
    it('requires explicit exact-address approval and retains domain blocking', () => {
        expect(addSender([], 'hnb.lk').ok).toBe(false);
        expect(setStatus([{ id: 'hnb.lk', status: 'new' }], 'hnb.lk', 'approved').ok).toBe(false);
        const block = addSender([], 'hnb.lk', { status: 'blocked' });
        expect(block.ok).toBe(true);
        expect(matchSender(block.list, entry.id).verdict).toBe('blocked');
    });
    it('accepts the exact mailbox but rejects same-domain siblings and subdomains', () => {
        expect(matchSender([entry], 'HNB <STATEMENT@HNB.LK>').verdict).toBe('approved');
        for (const from of ['promo@hnb.lk', 'statement@news.hnb.lk', 'statement+promo@hnb.lk', 'statement@hnb.lk.evil.example']) {
            expect(matchSender([entry], from).verdict).not.toBe('approved');
        }
        expect(approvedClauses([entry])).toEqual(['from:statement@hnb.lk']);
    });
    it('refuses unknown senders before emitting attachment work even with passing DKIM', () => {
        const message = { id: 'm', internalDate: '1788000000000', payload: {
            headers: [
                { name: 'From', value: 'promo@hnb.lk' },
                { name: 'Subject', value: 'Account statement' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@hnb.lk' },
            ], parts: [{ filename: 'statement.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a', size: 500 } }],
        } };
        const plan = planMessage(message, policyFrom([entry]));
        expect(plan.ok).toBe(false);
        expect(plan.items).toBeUndefined();
    });
    it('rejects bills, receipts and invoices even from the exact approved address', () => {
        for (const [subject, filename] of [
            ['Your utility bill is ready', 'utility-bill.pdf'],
            ['Payment confirmation', 'Receipt-2402-5154-7274.pdf'],
            ['Document attached', 'invoice-113674.pdf'],
            ['Your monthly payslip', 'salary-slip.pdf'],
        ]) {
            const plan = planMessage(mail(subject, filename), policyFrom([entry]));
            expect(plan.ok).toBe(false);
            expect(plan.reason).toBe('the-attachment-is-not-a-bank-statement');
            expect(plan.items).toBeUndefined();
        }
    });
    it('allows a real statement name from the exact approved address', () => {
        const plan = planMessage(mail('Your monthly e-statement', 'account-statement.pdf'), policyFrom([entry]));
        expect(plan.ok).toBe(true);
        expect(plan.items).toHaveLength(1);
        expect(plan.items[0].approved).toBe(true);
    });
    it('an ordinary scan with no valid whitelist cannot query the mailbox', () => {
        const params = { months: 1, index: 0, now: Date.UTC(2026, 8, 12) };
        expect(windowFor(params)).toBeNull();
        expect(windowFor({ ...params, senders: [] })).toBeNull();
        expect(windowFor({ ...params, senders: approvedClauses([entry]) }).query).toContain('from:statement@hnb.lk');
        expect(windowFor({ ...params, senders: [], discover: true }).discovery).toBe(true);
    });
    it('selects HTML smart attachments without treating the inline email body as a statement', () => {
        const payload = { mimeType: 'text/html', body: { data: 'inline-mail-body' }, parts: [
            { filename: 'smart.html', mimeType: 'text/html', body: { attachmentId: 'html', size: 500 } },
            { filename: 'smart.htm', mimeType: 'application/octet-stream', body: { attachmentId: 'htm', size: 500 } },
            { filename: 'script.js', mimeType: 'text/html', body: { attachmentId: 'bad', size: 500 } },
        ] };
        expect(selectAttachments(payload).take.map(p => p.attachmentId)).toEqual(['html', 'htm']);
        expect(selectAttachments({ mimeType: 'text/html', body: { data: 'inline' } }).ok).toBe(false);
    });
});
