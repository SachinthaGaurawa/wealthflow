/* =============================================================================
 * test/image_fallback_canvas_release_test.js
 * -----------------------------------------------------------------------------
 * Part of the broader memory-safety audit that followed the mobile-only "A
 * problem repeatedly occurred" crashes. Two files — wealthflow-vision-ocr.js
 * (fileToImages' minimal fallback) and wealthflow-crib.js (_minimalRead) —
 * both run the SAME shape of code when the richer AI-v4 extractor isn't
 * available: decode an attached image onto a canvas, encode it back out as a
 * base64 JPEG, resolve a Promise with the result.
 *
 * Neither had a try/catch of its own around that work. A throw anywhere
 * inside — a tainted canvas, an allocation failure on toDataURL, anything —
 * had two effects at once: the canvas already created was never released
 * (no `c.width = c.height = 0`), AND the enclosing Promise was never
 * resolved or rejected, so the caller hung forever holding that reference.
 * On a memory-constrained phone, that is a leaked canvas on every failure
 * plus a stuck UI, compounding across every image the owner ever failed to
 * scan.
 *
 * These tests run the REAL onload handlers (extracted from source) against
 * fake Image/FileReader/canvas doubles that can be made to throw at the
 * exact point that used to go unguarded, and confirm the canvas is always
 * released and the promise always settles.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

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

/** A canvas double that records every width/height write and can be made to
 *  throw from toDataURL(), the exact unguarded line both fallbacks share. */
function makeCanvasCtor(reg, { throwOnEncode = false } = {}) {
    return function fakeCreateElement(tag) {
        if (tag !== 'canvas') throw new Error('unexpected element ' + tag);
        const rec = { widthLog: [], heightLog: [] };
        const c = {
            _w: 0, _h: 0,
            get width() { return c._w; },
            set width(v) { c._w = v; rec.widthLog.push(v); },
            get height() { return c._h; },
            set height(v) { c._h = v; rec.heightLog.push(v); },
            getContext: () => ({
                fillStyle: '', fillRect() {}, drawImage() {},
                imageSmoothingEnabled: false, imageSmoothingQuality: '',
                getImageData: () => ({ data: new Uint8ClampedArray(16) }),
                putImageData() {},
            }),
            toDataURL: () => {
                if (throwOnEncode) throw new Error('tainted canvas / OOM on encode');
                return 'data:image/jpeg;base64,ZmFrZQ==';
            },
            _rec: rec,
        };
        reg.push(c);
        return c;
    };
}

/** Fake Image whose `src` setter synchronously fires onload/onerror, mirroring
 *  how the code under test drives it from inside FileReader's own onload. */
function makeImageCtor({ naturalWidth = 800, naturalHeight = 600, fail = false } = {}) {
    function FakeImage() {
        this._src = '';
        this.onload = null;
        this.onerror = null;
        this.naturalWidth = naturalWidth;
        this.naturalHeight = naturalHeight;
    }
    Object.defineProperty(FakeImage.prototype, 'src', {
        get() { return this._src; },
        set(v) {
            this._src = v;
            if (!v) return; // the finally block's `image.src = ''` must not re-fire onload
            if (fail) { if (this.onerror) this.onerror(); }
            else if (this.onload) this.onload();
        },
    });
    return FakeImage;
}

function makeFileReaderCtor() {
    return function FakeFileReader() {
        this.onload = null;
        this.onerror = null;
        this.result = null;
        this.readAsDataURL = function () {
            this.result = 'data:image/jpeg;base64,cmVhZA==';
            if (this.onload) this.onload();
        };
    };
}

function imageFile() {
    return { type: 'image/jpeg', name: 'photo.jpg' };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * wealthflow-vision-ocr.js — fileToImages() minimal fallback
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('wealthflow-vision-ocr.js fileToImages() fallback releases its canvas on every path', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-vision-ocr.js'), 'utf8');
    const BODY = extractFn(SRC, 'fileToImages');

    it('fileToImages was found and is non-trivial', () => {
        expect(BODY, 'fileToImages not found — retarget this test').toBeTruthy();
        expect(BODY.length).toBeGreaterThan(30);
    });

    function run({ throwOnEncode = false, imageFails = false } = {}) {
        const created = [];
        const doc = { createElement: makeCanvasCtor(created, { throwOnEncode }) };
        const fn = new Function(
            'window', 'document', 'Image', 'FileReader',
            BODY + '\nreturn fileToImages;',
        );
        const fileToImages = fn(
            {}, // no WF_AI_V4 → forces the minimal fallback
            doc,
            makeImageCtor({ fail: imageFails }),
            makeFileReaderCtor(),
        );
        return { fileToImages, created };
    }

    it('resolves with the encoded image and zeroes the canvas on success', async () => {
        const { fileToImages, created } = run();
        const imgs = await fileToImages(imageFile());
        expect(imgs).toEqual(['ZmFrZQ==']);
        expect(created.length).toBe(1);
        expect(created[0].width).toBe(0);
        expect(created[0].height).toBe(0);
    });

    it('a throw from toDataURL (tainted canvas / OOM) still releases the canvas and settles the promise', async () => {
        const { fileToImages, created } = run({ throwOnEncode: true });
        // Previously: no try/catch here meant this promise never settled at
        // all. If the fix regresses, this test hangs until Vitest's timeout
        // instead of failing fast — still a real, visible failure.
        const imgs = await fileToImages(imageFile());
        expect(imgs).toEqual([]); // falls back to "no images" rather than hanging
        expect(created.length).toBe(1);
        expect(created[0].width, 'canvas leaked after a thrown encode error').toBe(0);
        expect(created[0].height).toBe(0);
    });

    it('an Image decode failure resolves empty without creating a canvas', async () => {
        const { fileToImages, created } = run({ imageFails: true });
        const imgs = await fileToImages(imageFile());
        expect(imgs).toEqual([]);
        expect(created.length).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * wealthflow-crib.js — _minimalRead()
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('wealthflow-crib.js _minimalRead() releases its canvas on every path', () => {
    const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-crib.js'), 'utf8');
    const BODY = extractFn(SRC, '_minimalRead');

    it('_minimalRead was found and is non-trivial', () => {
        expect(BODY, '_minimalRead not found — retarget this test').toBeTruthy();
        expect(BODY.length).toBeGreaterThan(30);
    });

    function run({ throwOnEncode = false, imageFails = false } = {}) {
        const created = [];
        const doc = { createElement: makeCanvasCtor(created, { throwOnEncode }) };
        const fn = new Function(
            'document', 'Image', 'FileReader',
            BODY + '\nreturn _minimalRead;',
        );
        const _minimalRead = fn(doc, makeImageCtor({ fail: imageFails }), makeFileReaderCtor());
        return { _minimalRead, created };
    }

    it('resolves with the encoded image and zeroes the canvas on success', async () => {
        const { _minimalRead, created } = run();
        const imgs = await _minimalRead(imageFile());
        expect(imgs).toEqual(['ZmFrZQ==']);
        expect(created[0].width).toBe(0);
        expect(created[0].height).toBe(0);
    });

    it('a throw from toDataURL rejects (instead of hanging) and still releases the canvas', async () => {
        const { _minimalRead, created } = run({ throwOnEncode: true });
        await expect(_minimalRead(imageFile())).rejects.toThrow(/tainted canvas/);
        expect(created.length).toBe(1);
        expect(created[0].width, 'canvas leaked after a thrown encode error').toBe(0);
        expect(created[0].height).toBe(0);
    });

    it('an Image decode failure rejects without leaking a canvas', async () => {
        const { _minimalRead, created } = run({ imageFails: true });
        await expect(_minimalRead(imageFile())).rejects.toThrow(/decode failed/);
        expect(created.length).toBe(0);
    });

    it('a PDF file short-circuits to an empty array before touching Image/canvas', async () => {
        const { _minimalRead, created } = run();
        const imgs = await _minimalRead({ type: 'application/pdf', name: 'statement.pdf' });
        expect(imgs).toEqual([]);
        expect(created.length).toBe(0);
    });
});
