/* =============================================================================
 * test/estatement_decrypt_test.js — encrypted HTML e-statements must open with
 * no third-party download
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG (measured against the real file a user could not open)
 *
 * Banks like Nations Trust email an "American Express Smart Statement" as ONE
 * self-contained .html file. The transactions are AES-encrypted inside it and
 * unlocked in-page with the cardholder's Date of Birth (DDMMYYYY):
 *
 *     var embedded = "<~1.8 MB base64 ciphertext>";
 *     salt = "0c0A57be2DA58e81FF6eb906F63A9903"; iv = "24bFA41F6267cF8A7Fb7470beeF0Fb41";
 *     key  = CryptoJS.PBKDF2(dob, Hex.parse(salt), { keySize: 4, iterations: 15000 });   // SHA-1, 128-bit
 *     AES.decrypt({ ciphertext: Base64.parse(embedded) }, key, { iv: Hex.parse(iv) });    // CBC + PKCS7
 *
 * WealthFlow already detected and parsed these — but it could only decrypt AFTER
 * fetching CryptoJS from a CDN at click time. On a phone behind a strict CSP, an
 * offline network, or a slow link, that fetch failed and the statement never
 * opened — surfacing, at best, as "wrong Date of Birth" on a correct DOB.
 *
 * THE FIX: decrypt with native WebCrypto (PBKDF2-SHA1 128-bit / 15000 / AES-CBC),
 * which every secure-context browser and Node already have. No download, so the
 * statement opens offline and under any CSP. CryptoJS stays only as a fallback
 * for a webview that lacks crypto.subtle.
 *
 * HOW THIS IS PROVEN WITHOUT THE REAL DOB
 *
 * The real file is a stranger's financial data encrypted with their DOB — it is
 * NOT in the repo and cannot be decrypted here. Instead the test builds its own
 * ciphertext with an INDEPENDENT implementation (Node's crypto: PBKDF2-HMAC-SHA1
 * + AES-128-CBC/PKCS7) using the real file's exact salt and iv, then decrypts it
 * through the module's real `decrypt()`. Two independent implementations agreeing
 * on the same envelope is the correctness proof; the earlier bench run also
 * confirmed WebCrypto is byte-identical to the bank's own bundled CryptoJS.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-html-statement.js'), 'utf8');

// The real file's envelope parameters (public — salt/iv are not secrets; the DOB
// key is, and is absent here).
const SALT = '0c0A57be2DA58e81FF6eb906F63A9903';
const IV   = '24bFA41F6267cF8A7Fb7470beeF0Fb41';

/* ── load the browser IIFE into a minimal window, with a faithful table-only
 * DOMParser shim (Node has none, and adding a DOM library would betray the
 * no-dependency design the fix itself restores). The shim implements exactly the
 * calls htmlToTransactions/htmlToText make: querySelectorAll('table'|'tr'|'td'|
 * 'script,style,noscript'), textContent/innerText, remove(). It is deliberately
 * tiny and is itself asserted in the first test so it cannot pass work it did not
 * do. */
function makeDom(html) {
    // strip scripts/styles first (the module removes them anyway)
    const clean = html.replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, '');
    const tables = [];
    const tableRe = /<table[^>]*>([\s\S]*?)<\/table>/gi;
    let tm;
    while ((tm = tableRe.exec(clean))) {
        const rows = [];
        const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
        let rm;
        while ((rm = trRe.exec(tm[1]))) {
            const cells = [];
            const tdRe = /<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi;
            let cm;
            while ((cm = tdRe.exec(rm[1]))) {
                const txt = cm[1].replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ')
                    .replace(/\s+/g, ' ').trim();
                cells.push({ innerText: txt, textContent: txt });
            }
            rows.push({ querySelectorAll: (s) => (s === 'td' ? cells : []) });
        }
        tables.push({ querySelectorAll: (s) => (s === 'tr' ? rows : []) });
    }
    const bodyText = clean.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    return {
        body: { innerText: bodyText, textContent: bodyText },
        querySelectorAll: (sel) => {
            if (sel === 'table') return tables;
            if (/script/.test(sel)) return [];
            return [];
        },
    };
}
function loadModule() {
    const window = {};
    const DOMParser = function () {};
    DOMParser.prototype.parseFromString = (html) => makeDom(html);
    // eslint-disable-next-line no-new-func
    const run = new Function('window', 'document', 'DOMParser', 'console', SRC);
    run(window, { createElement: () => ({ style: {} }), head: {}, body: {} }, DOMParser, console);
    return window.WFHtmlStatement;
}

/** Encrypt like the bank does, with an INDEPENDENT implementation (node:crypto).
 *  Returns a synthetic self-contained statement .html string. */
function bankStyleFile(innerHtml, dob, { salt = SALT, iv = IV, iterations = 15000 } = {}) {
    const key = crypto.pbkdf2Sync(dob, Buffer.from(salt, 'hex'), iterations, 16, 'sha1'); // keySize 4 = 16 bytes
    const c = crypto.createCipheriv('aes-128-cbc', key, Buffer.from(iv, 'hex')); // PKCS7 by default
    const ct = Buffer.concat([c.update(Buffer.from(innerHtml, 'utf8')), c.final()]).toString('base64');
    return [
        '<!DOCTYPE html><html><head><title>Smart Statement</title></head><body>',
        '<script>',
        'var embedded = "' + ct + '";',
        'var salt = "' + salt + '";',
        'var iv = "' + iv + '";',
        'function decryptDocument(p){ var key = CryptoJS.PBKDF2(p, CryptoJS.enc.Hex.parse(salt),',
        '  { keySize: 4, iterations: ' + iterations + ' }); return CryptoJS.AES.decrypt(',
        '  CryptoJS.lib.CipherParams.create({ ciphertext: CryptoJS.enc.Base64.parse(embedded) }),',
        '  key, { iv: CryptoJS.enc.Hex.parse(iv) }).toString(CryptoJS.enc.Utf8); }',
        '</script></body></html>',
    ].join('\n');
}

/** A realistic AmEx-style inner statement, as it looks AFTER decryption. */
const INNER = `<!DOCTYPE html><html><body>
<h2>American Express Smart Statement</h2>
<div>Card No: 376657XXXXX0276 &nbsp; Statement Period: 11-Jul-2026 to 10-Aug-2026</div>
<table>
  <tr><th>Post Date</th><th>Description</th><th>Currency</th><th>Amount (LKR)</th></tr>
  <tr><td>02-Aug-2026</td><td>KEELLS SUPER COLOMBO 03</td><td>LKR</td><td>4,500.00 Dr</td></tr>
  <tr><td>05-Aug-2026</td><td>UBER *TRIP HELP.UBER.COM</td><td>LKR</td><td>1,250.50 Dr</td></tr>
  <tr><td>07-Aug-2026</td><td>PAYMENT RECEIVED - THANK YOU</td><td>LKR</td><td>15,000.00 Cr</td></tr>
</table></body></html>`;

const WF = loadModule();

describe('the module exposes the expected surface', () => {
    it('loaded and exported its API', () => {
        for (const fn of ['isEncryptedHtmlStatement', 'decrypt', 'htmlToTransactions', '_params', 'looksLikeStatement']) {
            expect(typeof WF[fn], `WFHtmlStatement.${fn} missing`).toBe('function');
        }
    });
    it('the DOM shim actually parses a table (guards a vacuous pass below)', () => {
        const dom = makeDom(INNER);
        const tables = dom.querySelectorAll('table');
        expect(tables.length).toBe(1);
        expect(tables[0].querySelectorAll('tr').length).toBe(4);
    });
});

describe('detection recognises the real NTB envelope', () => {
    it('flags an encrypted statement by its signature', () => {
        const file = bankStyleFile(INNER, '23101984');
        expect(WF.isEncryptedHtmlStatement(file)).toBe(true);
        const p = WF._params(file);
        expect(p.salt).toBe(SALT);
        expect(p.iv).toBe(IV);
        expect(p.iterations).toBe(15000);
        expect(p.keySize).toBe(4);
        expect(p.embedded.length).toBeGreaterThan(100);
    });
    it('does not flag an ordinary HTML file', () => {
        expect(WF.isEncryptedHtmlStatement('<html><body><p>hello</p></body></html>')).toBe(false);
        expect(WF.isEncryptedHtmlStatement('')).toBe(false);
    });
});

describe('THE FIX: WebCrypto decrypts the real envelope with no CDN', () => {
    it('recovers the exact inner statement from a correct DOB', async () => {
        const file = bankStyleFile(INNER, '23101984');
        const html = await WF.decrypt(file, '23101984');
        expect(html).toContain('American Express Smart Statement');
        expect(html).toContain('KEELLS SUPER');
        expect(html).toContain('PAYMENT RECEIVED');
    });

    it('never touches the CryptoJS CDN on the happy path', async () => {
        // If WebCrypto were not the primary path, decrypt() would call
        // ensureCryptoJS() (the retained CryptoJS stub). Make it throw: a passing
        // decrypt proves WebCrypto is the sole path and no library is needed.
        const file = bankStyleFile(INNER, '01012000');
        const guarded = loadModule();
        guarded.ensureCryptoJS = () => { throw new Error('CDN must not be used'); };
        const html = await guarded.decrypt(file, '01012000');
        expect(html).toContain('KEELLS SUPER');
    });

    it('returns empty string on a wrong DOB — no crash, no garbage accepted', async () => {
        const file = bankStyleFile(INNER, '23101984');
        const html = await WF.decrypt(file, '01011990');   // wrong
        expect(html === '' || !/KEELLS SUPER|American Express/.test(html)).toBe(true);
    });

    it('handles Unicode and multi-block statements', async () => {
        const inner = '<html><body><table><tr><td>02-Aug-2026</td><td>CAFÉ MÖWE — αβγ 日本語</td><td>LKR</td><td>2,345.67 Dr</td></tr></table></body></html>';
        const file = bankStyleFile(inner, '31121999');
        const html = await WF.decrypt(file, '31121999');
        expect(html).toContain('CAFÉ MÖWE');
        expect(html).toContain('日本語');
    });

    it('rejects a file that is not a recognised statement', async () => {
        await expect(WF.decrypt('<html>no envelope here</html>', '23101984')).rejects.toThrow(/not a recognised/);
    });
});

describe('the decrypted statement parses into transactions', () => {
    it('extracts every row with correct date, amount and direction', async () => {
        const file = bankStyleFile(INNER, '23101984');
        const html = await WF.decrypt(file, '23101984');
        const txns = WF.htmlToTransactions(html);
        expect(txns.length).toBe(3);

        const keells = txns.find((t) => /KEELLS/.test(t.narration));
        expect(keells).toBeTruthy();
        expect(keells.date).toBe('2026-08-02');
        expect(keells.amount).toBe(4500);
        expect(keells.direction).toBe('debit');

        const payment = txns.find((t) => /PAYMENT RECEIVED/.test(t.narration));
        expect(payment.direction).toBe('credit');
        expect(payment.amount).toBe(15000);
    });
});
