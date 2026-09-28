import { describe, it, expect } from 'vitest';
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import { readStatement, pdfLinesFromItems, STATEMENT_LIMITS } from '../statement-reader.mjs';
import { learnCloudLayout } from '../statement-layout.mjs';

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
    it('orders scrambled PDF text by visual row and column coordinates', () => {
        const items = [
            { str: '123.45 DR', transform: [1, 0, 0, 1, 450, 700] },
            { str: 'KEELLS STORE', transform: [1, 0, 0, 1, 140, 700] },
            { str: 'Statement', transform: [1, 0, 0, 1, 50, 740] },
            { str: '14/09/2026', transform: [1, 0, 0, 1, 50, 700] },
        ];
        expect(pdfLinesFromItems(items)).toEqual([
            'Statement',
            '14/09/2026 KEELLS STORE 123.45 DR',
        ]);
    });
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
    it('falls back to line-by-line reading when a statement has no <table> or script-embedded data', async () => {
        // A "Consolidated eStatement" export that lays out each field of a
        // transaction in its own <div> instead of a <table> row or a script
        // array — real dates and amounts, but neither layer that existed here
        // before could see them: the primary parser gets each field on a
        // separate line once htmlText() flattens the document, and until this
        // fix nothing else was ever tried.
        const html = '<html><body><h1>Nations Trust Bank Consolidated Statement</h1>'
            + '<div>14/09/2026</div><div>KEELLS STORE</div><div>123.45 DR</div>'
            + '<div>15/09/2026</div><div>SALARY PAYMENT</div><div>50000.00 CR</div>'
            + '</body></html>';
        const result = await readStatement({ bytes: Buffer.from(html), filename: 'statement.html' });
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.rows.map(r => [r.amount, r.direction])).toEqual([[123.45, 'debit'], [50000, 'credit']]);
        expect(result.parsed.verdict).toBe('unverified');
        expect(result.parsed.understood).toBe(false);
        expect(result.parsed.reason).toMatch(/line by line/i);
    });
    it('keeps two genuinely identical same-day transactions distinct in the line-by-line reading', async () => {
        // A P1 finding on the PR that introduced the line-by-line fallback:
        // _layerText (unlike _layerScripts, which this same adapter already
        // patches) still called wealthflow-html-statement.js's own _dedupe(),
        // so an ATM fee charged twice on the same day at the identical amount
        // — a real, ordinary occurrence, not a parsing artifact — silently
        // lost the second charge before WFStatementParser.parseStatement()
        // ever got a chance to apply its own tested duplicate-preserving logic.
        const html = '<html><body><h1>Nations Trust Bank Consolidated Statement</h1>'
            + '<div>14/09/2026</div><div>ATM WITHDRAWAL FEE</div><div>60.00 DR</div>'
            + '<div>14/09/2026</div><div>ATM WITHDRAWAL FEE</div><div>60.00 DR</div>'
            + '</body></html>';
        const result = await readStatement({ bytes: Buffer.from(html), filename: 'statement.html' });
        expect(result.parsed.rows).toHaveLength(2);
        expect(result.parsed.rows.map(r => [r.date, r.amount, r.direction])).toEqual([
            ['2026-09-14', 60, 'debit'], ['2026-09-14', 60, 'debit'],
        ]);
    });
    it('tries line-by-line reading only after both the table and script layers find nothing', async () => {
        // Same statement as above, but with a script-embedded array present too.
        // The script layer must win — it is the more reliable source — and the
        // line reading must never even run.
        const row = ['14/09/2026', 'KEELLS STORE', '123.45', 'DR'];
        const html = '<html><body><h1>AMEX Statement</h1>'
            + `<script>var transactions=${JSON.stringify([row])};</script>`
            + '<div>15/09/2026</div><div>SALARY PAYMENT</div><div>50000.00 CR</div>'
            + '</body></html>';
        const result = await readStatement({ bytes: Buffer.from(html), filename: 'statement.html' });
        expect(result.parsed.rows).toHaveLength(1);
        expect(result.parsed.rows[0].amount).toBe(123.45);
        expect(result.parsed.reason).toMatch(/embedded transaction data/i);
    });
    it('trusts a date reading the owner just confirmed even when the statement\'s own total does not reconcile', async () => {
        // Reproduces the live bug reported after "Map statement layout" -> "Yes":
        // the client's own teach screen already offers (and lets the owner
        // confirm) a reading whose reconciliation note says the totals do not
        // add up — that is disclosed, not blocked. The server used to require
        // strict reconciliation regardless, silently re-quarantining the
        // freshly-confirmed statement with the exact same generic reason,
        // forever, no matter how many times the owner confirmed it.
        const dotted = [
            'ACCOUNT STATEMENT', 'OPENING BALANCE 100,000.00',
            '02.07.2026 KEELLS SUPER COLOMBO 4,250.00 95,750.00',
            '03.07.2026 SALARY JULY 250,000.00 345,750.00',
            '05.07.2026 CEB ELECTRICITY 8,430.50 337,319.50',
            'CLOSING BALANCE 999,999.99', // wrong on purpose: real close is 337,319.50
        ].join('\n');
        const html = Buffer.from(`<html><body>${dotted}</body></html>`);

        // Unlearned: genuinely unreadable, exactly like production before teaching.
        const cold = await readStatement({ bytes: html, filename: 'statement.html' });
        expect(cold.parsed.rows).toHaveLength(0);

        // The owner confirms these exact three rows (mirrors what the teach
        // modal sends as action:'layout' rows).
        const learned = await learnCloudLayout(cold.text, [
            { date: '2026-07-02', amount: 4250, direction: 'debit' },
            { date: '2026-07-03', amount: 250000, direction: 'credit' },
            { date: '2026-07-05', amount: 8430.5, direction: 'debit' },
        ], { bank: 'Sampath Bank' });
        expect(learned.ok).toBe(true);

        // mapReviewLayout() (statement-sync.js) never stores or confirms a
        // template under its own template.id — it hashes [bank, template.id]
        // into a Firestore document id and stamps THAT hash onto the source
        // as learnedTemplate. An earlier version of this test passed
        // learned.template.id directly as confirmedTemplateId, which matched
        // only because the test skipped that hashing step entirely — it
        // could never have caught the bypass being unreachable in production.
        // Reproducing the real key here is the whole point of the assertion.
        const docId = createHash('sha256').update(JSON.stringify(['Sampath Bank', learned.template.id])).digest('hex');

        // Reprocessing with the owner's own just-confirmed template: rows come
        // back despite the reconciliation mismatch, explicitly flagged as such.
        const confirmed = await readStatement({ bytes: html, filename: 'statement.html', bank: 'Sampath Bank',
            layouts: [{ template: learned.template, _docId: docId }], confirmedTemplateId: docId });
        expect(confirmed.parsed.rows).toHaveLength(3);
        expect(confirmed.parsed.verdict).toBe('unverified');
        expect(confirmed.parsed.reconciliation.ok).toBe(false);
        expect(confirmed.parsed.layout.reconciliationBypassed).toBe(true);
        expect(confirmed.parsed.layout.learnedTemplate).toBe(docId);

        // The exact same template, opportunistically tried on some OTHER
        // statement the owner never confirmed (confirmedTemplateId unset, or
        // naming a different template) — the strict requirement still holds.
        const unconfirmed = await readStatement({ bytes: html, filename: 'statement.html', bank: 'Sampath Bank',
            layouts: [{ template: learned.template, _docId: docId }] });
        expect(unconfirmed.parsed.rows).toHaveLength(0);
        const wrongId = await readStatement({ bytes: html, filename: 'statement.html', bank: 'Sampath Bank',
            layouts: [{ template: learned.template, _docId: docId }], confirmedTemplateId: 'some-other-template-id' });
        expect(wrongId.parsed.rows).toHaveLength(0);
    });
    it('bounds attachments and returns sanitized malformed-PDF errors', async () => {
        await expect(readStatement({ bytes: Buffer.alloc(STATEMENT_LIMITS.bytes + 1), filename: 's.html' })).rejects.toMatchObject({ code: 'ATTACHMENT_SIZE_LIMIT' });
        await expect(readStatement({ bytes: Buffer.from('%PDF-broken'), filename: 's.pdf' })).rejects.toMatchObject({ code: 'PDF_UNREADABLE' });
        await expect(readStatement({ bytes: Buffer.from('random receipt'), filename: 's.txt' })).rejects.toMatchObject({ code: 'ATTACHMENT_TYPE_UNSUPPORTED' });
    });
});
