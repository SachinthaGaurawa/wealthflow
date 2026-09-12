import { describe, it, expect } from 'vitest';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';
import { readStatement, STATEMENT_LIMITS } from '../statement-reader.mjs';

const password = '01021990';
const plain = '<html><body><h1>American Express Card Statement</h1><p>Card No: 376657XXXXX0276</p><table><tr><th>Date</th><th>Description</th><th>Amount</th></tr><tr><td>14/09/2026</td><td>KEELLS STORE</td><td>123.45 DR</td></tr><tr><td>15/09/2026</td><td>PAYMENT THANK YOU</td><td>50.00 CR</td></tr></table><script>globalThis.stolen="01021990"; throw Error("must not execute")</script></body></html>';
function envelope(inner = plain, options = {}) {
    const salt = '0123456789abcdef0123456789abcdef', iv = 'fedcba9876543210fedcba9876543210';
    const cipher = createCipheriv('aes-128-cbc', pbkdf2Sync(password, Buffer.from(salt, 'hex'), 15000, 16, 'sha1'), Buffer.from(iv, 'hex'));
    const payload = Buffer.concat([cipher.update(inner), cipher.final()]).toString('base64');
    return Buffer.from(`<html><script>var embedded="${payload}";var salt="${salt}";var iv="${iv}";function decrypt(){CryptoJS.AES.decrypt()} var options={iterations:${options.iterations || 15000},keySize:4};</script></html>`);
}
function pdf(texts) {
    const stream = `BT /F1 12 Tf 50 750 Td ${texts.map((t, i) => `${i ? '0 -20 Td ' : ''}(${t.replace(/[()\\]/g, '\\$&')}) Tj`).join('\n')} ET`;
    const objects = [
        '<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
    ];
    let out = '%PDF-1.4\n', offsets = [0];
    objects.forEach((o, i) => { offsets.push(Buffer.byteLength(out)); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
    const start = Buffer.byteLength(out);
    out += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF`;
    return Buffer.from(out);
}

describe('server statement reader', () => {
    it('opens a real NTB cryptographic envelope, exact vault passwords, inert HTML and both money directions', async () => {
        const result = await readStatement({ bytes: envelope(), filename: 'AMEX.html', passwords: ['wrong', 'wrong', password] });
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.rows.map(r => [r.date, r.amount, r.direction])).toEqual([['2026-09-14', 123.45, 'debit'], ['2026-09-15', 50, 'credit']]);
        expect(result.parsed.layout.accountLast4).toBe('0276');
        expect(result.parsed.layout.statementType).toBe('credit-card');
        expect(JSON.stringify(result)).not.toContain(password);
        expect(result.text).not.toContain('must not execute');
        expect(globalThis.stolen).toBeUndefined();
    });
    it('supports a base64 wrapped inner HTML payload', async () => {
        const result = await readStatement({ bytes: envelope(Buffer.from(plain).toString('base64')), filename: 'statement.html', passwords: [password] });
        expect(result.parsed.rows).toHaveLength(2);
    });
    it('fails safely for absent and wrong keys and unbounded derivation', async () => {
        await expect(readStatement({ bytes: envelope(), filename: 'statement.html' })).rejects.toMatchObject({ code: 'NO_VAULT_KEYS' });
        await expect(readStatement({ bytes: envelope(), filename: 'statement.html', passwords: ['wrong'] })).rejects.toMatchObject({ code: 'PASSWORD_FAILED' });
        await expect(readStatement({ bytes: envelope(plain, { iterations: 1000000000 }), filename: 'statement.html', passwords: [password] })).rejects.toMatchObject({ code: 'HTML_ENCRYPTION_UNSUPPORTED' });
    });
    it('does not accept impossible dates and preserves equal printed transactions', async () => {
        const valid = '<tr><td>14/09/2026</td><td>KEELLS STORE</td><td>123.45 DR</td></tr>';
        const result = await readStatement({ bytes: Buffer.from(`<html><body><h1>AMEX Credit Card Statement</h1><table>${valid}${valid}<tr><td>31/02/2026</td><td>INVALID DATE</td><td>80.00 DR</td></tr></table></body></html>`), filename: 'statement.html' });
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.understood).toBe(false);
        expect(result.parsed.invalidDates).toBeGreaterThan(0);
    });
    it('extracts PDF text using PDF.js with no attachment code execution', async () => {
        const result = await readStatement({ bytes: pdf(['American Express Credit Card Statement', '14/09/2026 KEELLS STORE 123.45 DR']), filename: 'statement.pdf' });
        expect(result.parsed.rows).toHaveLength(1);
        expect(result.parsed.rows[0].amount).toBe(123.45);
    });
    it('reads inert JSON transaction arrays, preserves repeated rows and requests layout verification', async () => {
        const row = ['14/09/2026', 'KEELLS STORE', '123.45', 'DR'];
        const html = `<html><body><h1>AMEX Credit Card Statement</h1><script>var transactions=${JSON.stringify([row, row])};throw Error('never execute');</script></body></html>`;
        const result = await readStatement({ bytes: Buffer.from(html), filename: 'statement.html' });
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.verdict).toBe('unverified');
        expect(result.parsed.understood).toBe(false);
        expect(result.text).not.toContain('never execute');
    });
    it('bounds attachments and returns sanitized malformed-PDF errors', async () => {
        await expect(readStatement({ bytes: Buffer.alloc(STATEMENT_LIMITS.bytes + 1), filename: 's.html' })).rejects.toMatchObject({ code: 'ATTACHMENT_SIZE_LIMIT' });
        await expect(readStatement({ bytes: Buffer.from('%PDF-broken'), filename: 's.pdf' })).rejects.toMatchObject({ code: 'PDF_UNREADABLE' });
        await expect(readStatement({ bytes: Buffer.from('random receipt'), filename: 's.txt' })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    });
});
