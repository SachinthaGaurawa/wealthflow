/* =============================================================================
 * test/ai_matrix_wiring_test.js — the handler actually uses the matrix
 * -----------------------------------------------------------------------------
 * api/ai-matrix.mjs is tested thoroughly on its own. That proves the decision
 * logic is right; it proves nothing about whether api/ai.js CALLS it.
 *
 * This repository's most repeated defect is a facility built and wired to
 * nothing — a scanner with no pattern for a shape, a control that writes a value
 * nothing reads, a label the pipeline never applied. A cross-check module that
 * the endpoint does not import would be the same bug with better tests.
 *
 * So this file reads the handler as text and asserts the wiring. It cannot run
 * the handler — that would mean sixteen live provider calls, and a test suite
 * must never touch real infrastructure — so it checks the two things that are
 * checkable without one: the matrix is imported and used, and the bare race is
 * no longer the default.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'api', 'ai.js'), 'utf8');

describe('api/ai.js is wired to the matrix', () => {
    it('imports it (guards against a module nothing calls)', () => {
        expect(SRC).toMatch(/import\s+\*\s+as\s+Matrix\s+from\s+['"]\.\/ai-matrix\.mjs['"]/);
    });

    it('calls decide() rather than choosing an answer by itself', () => {
        expect(SRC).toContain('Matrix.decide(');
        // Both paths: the quorum path and the full-consensus prose path.
        expect((SRC.match(/Matrix\.decide\(/g) || []).length).toBeGreaterThanOrEqual(2);
    });

    it('reports how well supported the answer is, on every path', () => {
        // Two `return res.status(200)` payloads reach a caller. Both must carry
        // the corroboration, or a caller has to know which branch answered it
        // in order to find out whether anything checked the answer.
        const payloads = SRC.match(/return res\.status\(200\)\.json\(\{[\s\S]*?\}\);/g) || [];
        expect(payloads.length).toBeGreaterThanOrEqual(2);
        for (const p of payloads) {
            expect(p, 'a 200 response without corroboration').toContain('corroboration');
            expect(p, 'a 200 response without a trust verdict').toContain('trustworthy');
        }
    });

    it('no longer defaults prose and chat to the bare race', () => {
        // THE DEFECT THIS WHOLE CHANGE EXISTS FOR. The old line read:
        //   const mode = requestedMode || ((isVision || wantsJSON) ? 'consensus' : 'fastest');
        const line = (SRC.match(/const mode = requestedMode.*/) || [''])[0];
        expect(line).toContain("'corroborated'");
        expect(line).not.toMatch(/:\s*'fastest'/);
    });

    it('no longer returns a winner the moment one engine replies', () => {
        // The old race resolved on the FIRST valid reply. The quorum target
        // must come from a constant, not be hardcoded to one.
        expect(SRC).toMatch(/const QUORUM = \d+/);
        expect(SRC).toContain('valid >= target');
    });

    it('still honours an explicit fastest request rather than silently ignoring it', () => {
        // Removing a caller's choice without telling them is its own bug. The
        // mode is still served; what changed is that its answer is labelled.
        expect(SRC).toContain("mode === 'fastest'");
    });

    it('the prose branch no longer picks the longest answer', () => {
        expect(SRC).not.toMatch(/reply\.trim\(\)\.length - a\.reply\.trim\(\)\.length/);
    });

    it('parses as JavaScript (guards against a broken edit shipping)', async () => {
        // Importing it would run nothing — the handler is the default export —
        // but a syntax error would throw here rather than at request time.
        await expect(import('../api/ai.js')).resolves.toBeTruthy();
    });
});
