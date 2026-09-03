/* =============================================================================
 * test/pdf_unlock_vault_test.js — the saved passwords are actually tried
 * -----------------------------------------------------------------------------
 * THE REQUIREMENT: "when a new, unrecognised bank's PDF is caught, the system
 * must not crash. It must iteratively and relentlessly try every single password
 * saved in the Security Vault (NIC, DOB, custom pins) until the PDF is
 * unlocked."
 *
 * ── WHAT WAS ACTUALLY THERE ─────────────────────────────────────────────────
 *
 * All the pieces: wealthflow-vault.js holds the passwords the owner typed,
 * wealthflow-intelligence.js derives NIC/DOB guesses, and candidatesFor()
 * orders every one of them most-likely-first. Two callers used them — the
 * mail-statement path in index.html and the loader in wealthflow-ai-v4.js.
 *
 * wealthflow-pdf-unlock.js did not. And that is the module whose own header
 * says it handles "Upload Statement, CC One-Time, any upload". So a locked PDF
 * arriving through getStatementText() went straight to a password box and asked
 * the owner to type a password they had already saved, while the same PDF
 * arriving through a different door opened itself.
 *
 * A facility built and wired to SOME of its callers is this repository's most
 * repeated defect, and it is the one shape that never announces itself: both
 * paths work, so nothing is ever red.
 *
 * These tests drive the real tryCandidates() with an injected `open`, so no
 * browser and no pdf.js are needed, and assert the wiring by reading the file.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { candidatesFor } from '../wealthflow-vault.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-pdf-unlock.js'), 'utf8');

/* The module is a browser IIFE. Evaluate it with the smallest window it needs,
 * then read the API off that — running the real code rather than a copy of it. */
function loadModule() {
    const win = { pdfjsLib: { getDocument: () => ({ promise: Promise.reject(new Error('unused')) }), GlobalWorkerOptions: {} } };
    const doc = { createElement: () => ({}), head: { appendChild() {} } };
    // eslint-disable-next-line no-new-func
    new Function('window', 'document', 'console', SRC)(win, doc, { log() {} });
    return win.WFPdfUnlock;
}

const pwErr = (msg = 'Incorrect Password') => Object.assign(new Error(msg), { name: 'PasswordException', code: 2 });

describe('the unlocker knows a password error from a real one', () => {
    const { _isPasswordError } = loadModule();

    it('reads pdf.js PasswordException', () => {
        expect(_isPasswordError(pwErr())).toBe(true);
        expect(_isPasswordError(new Error('No password given'))).toBe(true);
    });

    it('does NOT treat a corrupt file as a password problem', () => {
        // Retrying a corrupt PDF against forty saved passwords is forty ways to
        // say the same thing slowly, and it would report the wrong reason.
        expect(_isPasswordError(new Error('Invalid PDF structure'))).toBe(false);
        expect(_isPasswordError(null)).toBe(false);
        expect(_isPasswordError(undefined)).toBe(false);
    });
});

describe('every saved password is tried, in order, until one opens it', () => {
    const { tryCandidates } = loadModule();

    const opener = (correct, log) => async (pw) => {
        if (log) log.push(pw);
        if (pw === correct) return { opened: true, with: pw };
        throw pwErr();
    };

    it('opens with the third saved password and reports which attempt it was', async () => {
        const tried = [];
        const hit = await tryCandidates(opener('c', tried), null, ['a', 'b', 'c', 'd']);
        expect(hit).toBeTruthy();
        expect(hit.index).toBe(2);
        expect(tried).toEqual(['a', 'b', 'c']);      // stops at the one that worked
    });

    it('returns null when none of them fit — the prompt is still ahead', async () => {
        expect(await tryCandidates(opener('zzz'), null, ['a', 'b'])).toBeNull();
    });

    it('an empty vault is not an error', async () => {
        expect(await tryCandidates(opener('a'), null, [])).toBeNull();
    });

    it('a REAL error stops the loop rather than burning the whole list', async () => {
        const tried = [];
        const open = async (pw) => {
            tried.push(pw);
            if (pw === 'a') throw pwErr();
            throw new Error('Invalid PDF structure');
        };
        await expect(tryCandidates(open, null, ['a', 'b', 'c'])).rejects.toThrow('Invalid PDF structure');
        expect(tried).toEqual(['a', 'b']);
    });

    it('relentless: it does not stop early on a long list', async () => {
        const many = Array.from({ length: 60 }, (_, i) => `p${i}`);
        const hit = await tryCandidates(opener('p59'), null, many);
        expect(hit.index).toBe(59);
    });
});

describe('the ordering comes from the vault, and every saved password is offered', () => {
    // candidatesFor is the existing rule and this pins the property the
    // requirement actually asks for: nothing the owner typed goes unused.
    const entries = [
        { bank: 'Seylan Bank', password: 'seylan-one' },
        { bank: 'Sampath Bank', password: 'sampath-one' },
        { bank: '', password: 'no-bank-noted' },
    ];

    it('puts the named bank first but keeps ALL of them', () => {
        const out = candidatesFor('Sampath Bank', entries, ['nic-guess']);
        expect(out[0]).toBe('sampath-one');
        expect(out).toContain('seylan-one');
        expect(out).toContain('no-bank-noted');
        expect(out[out.length - 1]).toBe('nic-guess');     // guesses last
    });

    it('offers everything when the bank is unknown — which is the usual case', () => {
        // A locked PDF's bank is not known until it opens. That is the whole
        // problem, so a bank-strict list would return nothing but guesses.
        const out = candidatesFor('', entries, ['nic-guess']);
        expect(out).toHaveLength(4);
    });
});

describe('the wiring, which is the part that was missing', () => {
    it('openPdf consults the vault before anyone is asked', () => {
        expect(SRC).toContain('_vaultCandidates(opts.bank, opts.getCandidates)');
        const body = SRC.slice(SRC.indexOf('async function openPdf('), SRC.indexOf('// Reconstruct line-structured'));
        expect(body.indexOf('_vaultCandidates')).toBeLessThan(body.indexOf('askPassword || promptPassword'));
    });

    it('it reaches the vault through the one function the app already exposes', () => {
        // Not a second reader of the vault. wealthflow-intelligence.js already
        // combines the encrypted store with the derived guesses; a copy here
        // would be a second answer to one question.
        expect(SRC).toContain('window.wfVaultPdfPasswords');
        expect(SRC).not.toContain('WFVault.list(');
    });

    it('an UNENCRYPTED pdf never causes a password to be read out of storage', () => {
        const body = SRC.slice(SRC.indexOf('async function openPdf('), SRC.indexOf('// Reconstruct line-structured'));
        expect(body).toContain('var plain = await open(undefined);');
        expect(body.indexOf('await open(undefined)')).toBeLessThan(body.indexOf('_vaultCandidates'));
    });

    it('reports the SOURCE, never the password', () => {
        expect(SRC).toContain("__unlockedBy = 'vault'");
        expect(SRC).toContain("__unlockedBy = 'typed'");
        expect(SRC).toContain('unlockedBy: pdf.__unlockedBy');
        // The password itself must not ride out on the result.
        const ret = SRC.slice(SRC.indexOf('return {\n            cancelled: false'), SRC.indexOf('async function _dataUrl') + 1);
        expect(ret).not.toContain('password:');
    });

    it('a vault that will not open is not a failed upload', () => {
        // Degrades to exactly the behaviour it had before: the password box.
        expect(SRC).toContain('return [];');
        expect(SRC).toContain("if (typeof fn !== 'function') return [];");
    });

    it('getStatementText passes its options through, or the bank hint is lost', () => {
        expect(SRC).toContain('async function getStatementText(file, askPassword, opts)');
        expect(SRC).toContain('openPdf(buf, askPassword, opts)');
    });
});
