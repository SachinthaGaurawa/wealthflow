/* =============================================================================
 * test/ai_scan_pdf_memory_test.js
 * -----------------------------------------------------------------------------
 * The owner's report: "A problem repeatedly occurred on wealthflow-personal.
 * vercel.app" — Mobile Safari's own words for its web-content process being
 * killed for using too much memory, then killed again on the next launch, and
 * the one after that. That is not a JS error (nothing throws, nothing is
 * caught, nothing is logged) and it is not the reload loop PR #202 already
 * fixed — it is the renderer itself dying.
 *
 * wealthflow-stability.js documents the same failure mode for AI-answer
 * charts ("Ask the AI for ten charts and you leak ten of them. On iOS that is
 * exactly how a renderer dies.") and wealthflow-ai-v4.js documents it again
 * for full-resolution phone photos ("a 12MP phone photo decoded at full
 * resolution... spiked the iOS web-process past its memory ceiling"). Both of
 * those were hardened. The PDF path — used by AI chat attachments, CRIB
 * report scanning (up to 6 pages), and vision OCR (up to 6 pages) — was not:
 *
 *   · renderPdfPageAdaptive() creates up to 5 full-size canvases per page
 *     (scale 2.0 down to 0.8, each up to 2200x2200) and never released a
 *     rejected one before trying the next — exactly the pattern the image
 *     path's own comment says starves the process.
 *   · fileToImagesV4()'s PDF branch never called pdf.destroy() once every
 *     page was rendered, so the whole PDF.js document — fonts, XRef table,
 *     every fetched page's cached operator list — stayed resident for the
 *     rest of the session. Scan three statements and three full documents
 *     never come back.
 *
 * These tests execute the real functions (extracted from source, not
 * reimplemented) against fake pdf.js / canvas objects that record what was
 * released and what was not, so a regression that stops calling destroy() or
 * stops zeroing a canvas fails here rather than on someone's phone.
 * ===========================================================================*/

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');

/** Brace-counted body of a top-level (possibly async) named function. */
function extractFn(src, name) {
    const at = src.search(new RegExp(`\\n[ \\t]*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    const braceStart = src.indexOf('{', at);
    let depth = 0;
    for (let j = braceStart; j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
    }
    return '';
}

const NEEDED = ['fmtBytes', 'approxBase64Bytes', 'ensurePdfJs', 'renderPdfPageAdaptive', 'fileToImagesV4'];
const BODIES = Object.fromEntries(NEEDED.map((n) => [n, extractFn(SRC, n)]));

describe('the functions this file depends on are still where it expects', () => {
    // If any of these go missing (renamed, restructured) every test below
    // would either fail to load or, worse, silently exercise nothing.
    for (const name of NEEDED) {
        it(`${name} was found and is non-trivial`, () => {
            expect(BODIES[name], `${name} not found — retarget this test`).toBeTruthy();
            expect(BODIES[name].length).toBeGreaterThan(30);
        });
    }
});

/** A canvas double that records every width/height write, so a rung that is
 *  never explicitly zeroed shows up as still "holding" its backing store. */
function makeCanvas(reg) {
    const rec = { widthLog: [], heightLog: [] };
    const c = {
        _w: 0, _h: 0,
        get width() { return c._w; },
        set width(v) { c._w = v; rec.widthLog.push(v); },
        get height() { return c._h; },
        set height(v) { c._h = v; rec.heightLog.push(v); },
        getContext: () => ({ fillStyle: '', fillRect() {} }),
        // Encoded size scales with area, so a small `maxBytes` forces the
        // loop through several scales/qualities before one fits — the exact
        // shape that used to leak every earlier attempt.
        toDataURL: (_type, quality) => {
            const bytes = Math.max(1, Math.round(c._w * c._h * quality * 0.02));
            return 'data:image/jpeg;base64,' + 'A'.repeat(Math.ceil(bytes / 0.75));
        },
        _rec: rec,
    };
    reg.push(c);
    return c;
}

function makePage(renderShouldThrow) {
    let cleanupCalls = 0;
    return {
        getViewport: ({ scale }) => ({ width: 1000 * scale, height: 1400 * scale }),
        render: () => ({
            promise: renderShouldThrow
                ? Promise.reject(new Error('render failed'))
                : Promise.resolve(),
        }),
        cleanup: () => { cleanupCalls += 1; },
        _cleanupCalls: () => cleanupCalls,
    };
}

function loadModule() {
    const body = [
        "var V = 'test-harness';",
        BODIES.fmtBytes,
        BODIES.approxBase64Bytes,
        BODIES.ensurePdfJs,
        BODIES.renderPdfPageAdaptive,
        BODIES.fileToImagesV4,
        'return { renderPdfPageAdaptive, fileToImagesV4 };',
    ].join('\n');
    // Only `document.createElement('canvas')` and `window.pdfjsLib` are ever
    // touched on the PDF path being exercised — no real DOM required.
    const fn = new Function('window', 'document', 'console', 'localStorage', body);
    return fn;
}

describe('renderPdfPageAdaptive() releases every canvas it creates', () => {
    let createdCanvases;
    let mod;

    beforeAll(() => {
        const loader = loadModule();
        createdCanvases = [];
        const doc = { createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            return makeCanvas(createdCanvases);
        } };
        mod = loader({ pdfjsLib: {} }, doc, { log() {}, warn() {} }, {
            getItem: () => null, setItem() {}, removeItem() {},
        });
    });

    it('zeroes every rung it tried, including the one it returned', async () => {
        // maxBytes forces several rungs before one is small enough to fit —
        // the exact case that used to abandon every earlier canvas unreleased.
        const page = makePage(false);
        const result = await mod.renderPdfPageAdaptive({ getPage: async () => page }, 1, 12000);
        expect(result).toBeTruthy();
        expect(createdCanvases.length).toBeGreaterThan(1); // more than one rung was actually tried
        for (const c of createdCanvases) {
            expect(c.width, 'a rejected/winning canvas was left holding its backing store').toBe(0);
            expect(c.height).toBe(0);
        }
    });

    it('calls page.cleanup() exactly once after a successful render', async () => {
        const page = makePage(false);
        await mod.renderPdfPageAdaptive({ getPage: async () => page }, 1, 12000);
        expect(page._cleanupCalls()).toBe(1);
    });

    it('still zeroes every canvas and calls cleanup() when no rung is ever small enough', async () => {
        createdCanvases.length = 0;
        const page = makePage(false);
        // maxBytes of 1 byte: nothing ever fits, so every scale/quality is tried
        // and the function throws — cleanup must still run (finally), and every
        // canvas made along the way must still be released.
        await expect(mod.renderPdfPageAdaptive({ getPage: async () => page }, 1, 1))
            .rejects.toThrow(/too large/);
        expect(createdCanvases.length).toBe(5); // one per scale rung
        for (const c of createdCanvases) { expect(c.width).toBe(0); expect(c.height).toBe(0); }
        expect(page._cleanupCalls()).toBe(1);
    });

    it('calls page.cleanup() even when page.render() itself throws', async () => {
        const page = makePage(true);
        await expect(mod.renderPdfPageAdaptive({ getPage: async () => page }, 1, 4000))
            .rejects.toThrow('render failed');
        expect(page._cleanupCalls()).toBe(1);
    });
});

describe('fileToImagesV4() destroys the PDF.js document once it is done with it', () => {
    let mod;

    beforeAll(() => {
        const loader = loadModule();
        const doc = { createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            return makeCanvas([]);
        } };
        mod = loader({ pdfjsLib: {} }, doc, { log() {}, warn() {} }, {
            getItem: () => null, setItem() {}, removeItem() {},
        });
    });

    function fakePdfFile(numPages, { pageShouldThrow = false } = {}) {
        let destroyCalls = 0;
        const pdf = {
            numPages,
            getPage: async () => makePage(pageShouldThrow),
            destroy: async () => { destroyCalls += 1; },
            _destroyCalls: () => destroyCalls,
        };
        const file = {
            type: 'application/pdf',
            name: 'statement.pdf',
            arrayBuffer: async () => new ArrayBuffer(8),
        };
        return { file, pdf, destroyCalls: () => destroyCalls };
    }

    it('destroys the document exactly once after every page renders successfully', async () => {
        const { file, pdf, destroyCalls } = fakePdfFile(3);
        const win = { pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) } };
        const loader = loadModule();
        const doc = { createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            return makeCanvas([]);
        } };
        const m = loader(win, doc, { log() {}, warn() {} }, { getItem: () => null, setItem() {}, removeItem() {} });

        const res = await m.fileToImagesV4(file, { maxPages: 3, maxBytes: 12000 });
        expect(res.isPdf).toBe(true);
        expect(res.pageCount).toBe(3);
        expect(destroyCalls()).toBe(1);
    });

    it('still destroys the document when a later page fails mid-loop', async () => {
        // Page 1 succeeds, page 2 throws inside render() — fileToImagesV4 breaks
        // out of the loop and returns what it has. The finally block must still
        // run: this is the exact path a leak hides in, because it never reaches
        // the "happy path" line at the bottom of the try.
        let call = 0;
        const pdf = {
            numPages: 3,
            getPage: async () => makePage(call++ === 1), // page index 1 (the 2nd page) throws
            destroy: async () => { pdf._n = (pdf._n || 0) + 1; },
        };
        const win = { pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) } };
        const loader = loadModule();
        const doc = { createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            return makeCanvas([]);
        } };
        const m = loader(win, doc, { log() {}, warn() {} }, { getItem: () => null, setItem() {}, removeItem() {} });
        const file = { type: 'application/pdf', name: 'statement.pdf', arrayBuffer: async () => new ArrayBuffer(8) };

        const res = await m.fileToImagesV4(file, { maxPages: 3, maxBytes: 12000 });
        expect(res.pageCount).toBe(1); // only page 1 made it before page 2 broke the loop
        expect(pdf._n).toBe(1);
    });

    it('never leaves more than one PDF document alive across two sequential scans', async () => {
        // The scenario the owner actually hit: scan one statement, then another,
        // in the same session. Without the fix, destroy() is never called, so
        // this loop leaves N full documents resident for N scans.
        const loader = loadModule();
        const doc = { createElement: (tag) => {
            if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
            return makeCanvas([]);
        } };
        let totalDestroyed = 0, totalCreated = 0;
        for (let n = 0; n < 4; n += 1) {
            const pdf = { numPages: 2, getPage: async () => makePage(false), destroy: async () => { totalDestroyed += 1; } };
            totalCreated += 1;
            const win = { pdfjsLib: { getDocument: () => ({ promise: Promise.resolve(pdf) }) } };
            const m = loader(win, doc, { log() {}, warn() {} }, { getItem: () => null, setItem() {}, removeItem() {} });
            const file = { type: 'application/pdf', name: `s${n}.pdf`, arrayBuffer: async () => new ArrayBuffer(8) };
            await m.fileToImagesV4(file, { maxPages: 2, maxBytes: 12000 });
        }
        expect(totalDestroyed).toBe(totalCreated);
    });
});
