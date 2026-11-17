/* =============================================================================
 * test/feedback_screenshot_canvas_release_test.js
 * -----------------------------------------------------------------------------
 * Part of the memory-safety audit that followed the mobile-only "A problem repeatedly occurred" crashes: a canvas that
 * is not zeroed after it is encoded keeps its backing store until the GC gets round to it.
 *
 * Feedback attachments (up to five) are drawn by wealthflow-image-prep.js (pictures) and wealthflow-feedback-attach.js
 * (PDF pages). Every canvas either of them creates must be zeroed once its data URL has been taken. This test runs the
 * REAL modules against recording canvas doubles, so five pictures in a row cannot pile canvases up on a phone.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

function recordingDocument() {
    const created = [];
    const document = {
        createElement(tag) {
            if (tag !== 'canvas') return {};
            const c = {
                _w: 0, _h: 0,
                get width() { return c._w; }, set width(v) { c._w = v; },
                get height() { return c._h; }, set height(v) { c._h = v; },
                getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v) {} }),
                toDataURL: (_t, q) => 'data:image/jpeg;base64,' + 'A'.repeat(Math.max(8, Math.round(c._w * c._h * q * 0.05))),
            };
            created.push(c);
            return c;
        },
    };
    return { document, created };
}

function loadImagePrep(document) {
    const sb = { document };
    sb.window = sb; sb.globalThis = sb;
    new Function('window', 'globalThis', 'document', fs.readFileSync(path.join(ROOT, 'wealthflow-image-prep.js'), 'utf8'))(sb, sb, document);
    return sb.WFImagePrep;
}

describe('attachment canvases are released after encoding', () => {
    it('image-prep zeroes every canvas it made, for one picture and for a tall one cut into parts', () => {
        const { document, created } = recordingDocument();
        const P = loadImagePrep(document);
        for (const [w, h] of [[1440, 900], [1170, 9000]]) {
            const out = P.prepareSource({ width: w, height: h }, {});
            expect(out.ok).toBe(true);
        }
        expect(created.length).toBeGreaterThan(0);
        created.forEach((c, i) => {
            expect(c.width, `canvas ${i} leaked its width`).toBe(0);
            expect(c.height, `canvas ${i} leaked its height`).toBe(0);
        });
    });

    it('five pictures in a row leave no canvas holding pixels', () => {
        const { document, created } = recordingDocument();
        const P = loadImagePrep(document);
        for (let i = 0; i < 5; i++) P.prepareSource({ width: 1600, height: 1000 }, { thumbCap: 8000, readCap: 200000, maxTiles: 1 });
        expect(created.length).toBeGreaterThanOrEqual(5);
        expect(created.every((c) => c.width === 0 && c.height === 0)).toBe(true);
    });

    it('the PDF page renderer zeroes its canvas too (source check: every canvas it creates is released)', () => {
        const src = fs.readFileSync(path.join(ROOT, 'wealthflow-feedback-attach.js'), 'utf8');
        const creates = (src.match(/createElement\('canvas'\)/g) || []).length;
        const zeroes = (src.match(/\.width\s*=\s*(?:[a-z.]+\.height\s*=\s*)?0\b/g) || []).length;
        expect(creates).toBeGreaterThan(0);
        expect(zeroes).toBeGreaterThanOrEqual(creates);
    });

    it('the old single-file handler is gone from the sheet: no FileReader/canvas path is left in openFeedback', () => {
        const us = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');
        const at = us.search(/function openFeedback\s*\(/);
        expect(at).toBeGreaterThan(-1);
        const end = us.indexOf('\n    }\n', at);
        const body = us.slice(at, end > at ? end : at + 6000);
        expect(body).not.toMatch(/createElement\('canvas'\)/);
        expect(body).not.toMatch(/new FileReader/);
        expect(body).toMatch(/WFFeedbackAttach\.mount\(/);
    });
});
