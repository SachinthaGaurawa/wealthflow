import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { intakeStatement, unlockHtml, QUARANTINE } from '../wealthflow-mail-intake.js';

const plain = '<html><body>American Express account statement opening balance 100.00 closing balance 90.00<table><tr><td>01/09/2026</td><td>STORE</td><td>10.00</td></tr></table><script>throw new Error("must not execute")</script></body></html>';
function reader() {
    return {
        isEncryptedHtmlStatement: s => s.includes('encrypted-envelope'),
        decrypt: vi.fn(async (_, password) => password === '01021990' ? plain : ''),
        htmlToText: vi.fn(s => s.replace(/<[^>]*>/g, '')),
        renderInSandbox: vi.fn(() => { throw new Error('forbidden'); }),
        promptPassword: vi.fn(() => { throw new Error('forbidden'); }),
    };
}

describe('mail HTML statements use the vault without running attachments', () => {
    it('opens an independently encrypted NTB-shaped envelope with the real HTML reader', async () => {
        const salt = '0123456789abcdef0123456789abcdef';
        const iv = 'fedcba9876543210fedcba9876543210';
        const key = crypto.pbkdf2Sync('01021990', Buffer.from(salt, 'hex'), 15000, 16, 'sha1');
        const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex'));
        const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
        const envelope = `<html><script>var embedded="${ciphertext}"; var salt="${salt}"; var iv="${iv}"; function decrypt(){ CryptoJS.AES.decrypt(); } var options={iterations:15000,keySize:4};</script></html>`;
        const window = { crypto: crypto.webcrypto };
        vm.runInNewContext(readFileSync(new URL('../wealthflow-html-statement.js', import.meta.url), 'utf8'), {
            window, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, atob, btoa,
            console: { log() {} },
        });
        const result = await unlockHtml(envelope, ['incorrect', '01021990'], window.WFHtmlStatement);
        expect(result.ok).toBe(true);
        expect(result.encrypted).toBe(true);
        expect(result.usedIndex).toBe(1);
        expect(result.text).toContain('STORE');
        expect(result.text).not.toContain('must not execute');
    });
    it('tries exact keys in order, suppresses duplicates, strips active content', async () => {
        const html = reader();
        const result = await unlockHtml('encrypted-envelope', ['wrong', 'wrong', '01021990'], html);
        expect(result.ok).toBe(true);
        expect(html.decrypt.mock.calls.map(c => c[1])).toEqual(['wrong', '01021990']);
        expect(result.text).not.toContain('must not execute');
        expect(JSON.stringify(result)).not.toContain('01021990');
        expect(html.promptPassword).not.toHaveBeenCalled();
        expect(html.renderInSandbox).not.toHaveBeenCalled();
    });
    it('quarantines unavailable keys and reader errors without leaking credentials', async () => {
        expect((await unlockHtml('encrypted-envelope', [], reader())).reason).toBe(QUARANTINE.NO_VAULT_KEYS);
        expect((await unlockHtml('encrypted-envelope', ['wrong'], reader())).reason).toBe(QUARANTINE.PASSWORD_FAILED);
        const html = reader();
        html.decrypt.mockRejectedValue(new Error('secret 01021990'));
        const result = await unlockHtml('encrypted-envelope', ['01021990'], html);
        expect(result.reason).toBe(QUARANTINE.HTML_UNREADABLE);
        expect(JSON.stringify(result)).not.toContain('01021990');
    });
    it('refuses unbounded key derivation before attempting a password', async () => {
        const html = reader();
        html._params = () => ({ iterations: 1000000000, keySize: 4 });
        expect((await unlockHtml('encrypted-envelope', ['01021990'], html)).reason).toBe(QUARANTINE.HTML_UNREADABLE);
        expect(html.decrypt).not.toHaveBeenCalled();
    });
    it('routes HTML through the same parser and direction checks as PDF', async () => {
        const html = reader();
        const openPdf = vi.fn();
        const row = { date: '2026-09-01', narration: 'STORE', amount: 10, direction: 'debit', directionSource: 'balance' };
        const parse = vi.fn(() => ({ rows: [row] }));
        const result = await intakeStatement({ manifest: { filename: 'statement.html', d: Buffer.from('encrypted-envelope').toString('base64') } }, {
            htmlStatement: html, openPdf, extractText: vi.fn(), vaultKeys: () => ['01021990'],
            parse, route: rows => rows.map(row => ({ row, module: 'income', confidence: 1, fields: {} })),
        });
        expect(openPdf).not.toHaveBeenCalled();
        expect(parse).toHaveBeenCalledOnce();
        expect(result.applied).toHaveLength(0);
        expect(result.quarantined[0].reason).toBe(QUARANTINE.ROUTING_CONFLICT);
    });
});
