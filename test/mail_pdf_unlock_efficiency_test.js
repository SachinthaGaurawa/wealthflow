/* =============================================================================
 * test/mail_pdf_unlock_efficiency_test.js
 * -----------------------------------------------------------------------------
 * The owner's report, after the previous PDF-memory fix already shipped:
 * "Email statements ටික sync වෙලා ඉවර උනාම ආයෙ restart වෙනවා" — right when a
 * batch of mailed statements finishes syncing, the app restarts. Not mid-scan,
 * not on one statement — at the end of the batch, which is where accumulated
 * memory/CPU pressure across the whole run would peak.
 *
 * wealthflow-mail-intake.js's unlock() already owns the correct shape: try no
 * password, then every vault candidate in order, stop at the first hit. It
 * drove that loop by calling window.WFPdfUnlock.openPdf() — a function that
 * is NOT a single attempt. openPdf() is the full cascade used for a single
 * uploaded file: try unencrypted, then internally re-fetch and retry the
 * ENTIRE vault itself (_vaultCandidates + tryCandidates), and only then look
 * at the specific password it was actually asked to try.
 *
 * So for a vault of V saved passwords, unlocking ONE locked mailed statement
 * cost roughly V outer attempts, each re-running an up-to-V-deep internal
 * cascade: O(V^2) PDF.js document create/decrypt/destroy cycles instead of
 * O(V). Every real bank statement is locked, so a sync batch with several of
 * them turned into dozens of rapid PDF.js cycles — real churn, not a classic
 * "forgot to free it" leak, peaking exactly when the batch finished.
 *
 * These tests pin the fix at both ends: the raw primitive makes exactly one
 * decrypt attempt per call, and the mail-sync wiring in index.html calls that
 * raw primitive rather than the cascading one.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { unlock } from '../wealthflow-mail-intake.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PDF_SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-pdf-unlock.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Evaluate the real module against a counting fake pdf.js, exactly as
 *  test/pdf_unlock_vault_test.js does — running the real code, not a copy. */
function loadModule(getDocumentImpl) {
    const win = { pdfjsLib: { getDocument: getDocumentImpl, GlobalWorkerOptions: {} } };
    const doc = { createElement: () => ({}), head: { appendChild() {} } };
    new Function('window', 'document', 'console', PDF_SRC)(win, doc, { log() {} });
    return win.WFPdfUnlock;
}

/** A fake pdf.js that only "correct" opens; every other password is a
 *  PasswordException. Counts every loading task it creates and every one it
 *  destroys, so a leaked or duplicated attempt shows up directly. */
function fakePdfJs(correct) {
    let created = 0, destroyed = 0;
    const getDocument = ({ password }) => {
        created += 1;
        const task = {
            promise: (password === correct)
                ? Promise.resolve({ numPages: 1 })
                : Promise.reject(Object.assign(new Error('Incorrect Password'), { name: 'PasswordException' })),
            destroy: () => { destroyed += 1; return Promise.resolve(); },
        };
        return task;
    };
    return { getDocument, created: () => created, destroyed: () => destroyed };
}

describe('openPdfOnce() is a single decrypt attempt, not a cascade', () => {
    it('makes exactly one getDocument call per invocation, whatever the password', async () => {
        const pj = fakePdfJs('c');
        const mod = loadModule(pj.getDocument);
        for (const pw of ['a', 'b', 'c', 'd']) {
            try { await mod.openPdfOnce(new Uint8Array([1]), pw); } catch (_) { /* wrong password */ }
        }
        // Four candidates tried, one call each — not "each call re-tries the
        // whole set", which is the defect this closes.
        expect(pj.created()).toBe(4);
    });

    it('destroys the loading task on a wrong password, so nothing is left resident', async () => {
        const pj = fakePdfJs('the-real-one');
        const mod = loadModule(pj.getDocument);
        await expect(mod.openPdfOnce(new Uint8Array([1]), 'wrong')).rejects.toThrow();
        expect(pj.destroyed()).toBe(1);
    });

    it('does not destroy the task once it actually opens', async () => {
        const pj = fakePdfJs('yes');
        const mod = loadModule(pj.getDocument);
        const doc = await mod.openPdfOnce(new Uint8Array([1]), 'yes');
        expect(doc.numPages).toBe(1);
        expect(pj.destroyed()).toBe(0);
    });

    it('passing null/undefined (the "try unencrypted" probe) never sends the literal password field a string', async () => {
        let sentPassword;
        const pj = fakePdfJs(undefined);
        const mod = loadModule(({ password }) => { sentPassword = password; return pj.getDocument({ password }); });
        await mod.openPdfOnce(new Uint8Array([1]), null);
        expect(sentPassword).toBeUndefined();
    });
});

describe('unlocking a mailed statement against the real vault-candidate loop costs O(V), not O(V^2)', () => {
    it('a vault of 5 passwords costs 6 decrypt attempts total (1 unencrypted probe + 5 candidates), not 30', async () => {
        const correct = 'p4';
        const candidates = ['p0', 'p1', 'p2', 'p3', 'p4'];
        const pj = fakePdfJs(correct);
        const mod = loadModule(pj.getDocument);

        // Exactly what runMailSync() wires today: unlock() drives openPdfOnce
        // directly, one call per candidate, no nested cascade.
        const result = await unlock(new Uint8Array([1]), candidates, (bytes, pw) => mod.openPdfOnce(bytes, pw));

        expect(result.ok).toBe(true);
        expect(result.usedIndex).toBe(4);
        // 1 (unencrypted probe, fails) + 5 (every candidate, stops at the hit) = 6.
        // The pre-fix wiring — routing each of those 6 through the full cascade,
        // which itself retries all 5 candidates before giving up — cost up to
        // 6 + 5*5 = 31 attempts for the same vault. Linear vs quadratic is the
        // whole fix; this pins the linear number precisely.
        expect(pj.created()).toBe(6);
    });

    it('scales linearly as the vault grows — 20 passwords costs 21 attempts, not ~420', async () => {
        const candidates = Array.from({ length: 20 }, (_, i) => `pw${i}`);
        const correct = candidates[19]; // worst case: the last one tried
        const pj = fakePdfJs(correct);
        const mod = loadModule(pj.getDocument);

        const result = await unlock(new Uint8Array([1]), candidates, (bytes, pw) => mod.openPdfOnce(bytes, pw));
        expect(result.ok).toBe(true);
        expect(pj.created()).toBe(21); // 1 unencrypted probe + 20 candidates
    });
});

describe('the mail-sync wiring in index.html actually uses the linear primitive', () => {
    // Source-anchored: the behavioural tests above prove openPdfOnce() itself
    // is linear, but only reading the actual call site proves runMailSync()
    // is wired to it rather than to the cascading openPdf() — which is
    // exactly the kind of drift this repository has shipped before (a fixed
    // primitive with a caller nobody repointed at it).
    it('injects openPdfOnce, not the full openPdf cascade, into intakeStatement', () => {
        const i = HTML.indexOf('WFMailIntake.intakeStatement(');
        expect(i, 'intakeStatement call site not found — retarget this test').toBeGreaterThan(-1);
        const body = HTML.slice(i, i + 2000);
        const openPdfDep = /openPdf:\s*\(bytes,\s*password\)\s*=>\s*\{[\s\S]*?\n\s*\},/.exec(body);
        expect(openPdfDep, 'the injected openPdf dependency has moved — retarget this test').toBeTruthy();
        expect(openPdfDep[0]).toContain('window.WFPdfUnlock.openPdfOnce(bytes, password)');
        expect(openPdfDep[0]).not.toMatch(/WFPdfUnlock\.openPdf\(bytes/);
    });

    it('openPdfOnce is exported for that call site to reach', () => {
        expect(PDF_SRC).toContain('openPdfOnce: openPdfOnce');
    });
});
