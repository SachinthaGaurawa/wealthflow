/* =============================================================================
 * test/feedback_screenshot_canvas_release_test.js
 * -----------------------------------------------------------------------------
 * Part of the broader memory-safety audit that followed the mobile-only "A
 * problem repeatedly occurred" crashes. openFeedback()'s screenshot-attach
 * handler in wealthflow-update-system.js downscales the chosen image onto a
 * canvas (capped at 900px, so the leak here is small) and read its encoded
 * result into _fbImageData — but never released the canvas's own backing
 * store afterwards, unlike every other canvas-using path in this codebase.
 * Low risk on its own, but the exact same pattern already caused real
 * crashes elsewhere in this app, so it is fixed and tested for consistency
 * rather than left as the one canvas nobody zeroes.
 *
 * This test runs the REAL openFeedback() (extracted from source, not
 * reimplemented) against a real linkedom DOM plus fake Image/FileReader/
 * canvas doubles, and drives the actual <input type="file"> onchange handler
 * exactly as the browser would.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-update-system.js'), 'utf8');

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

const BODY = extractFn(SRC, 'openFeedback');

describe('the function this file depends on is still where it expects', () => {
    it('openFeedback was found and is non-trivial', () => {
        expect(BODY, 'openFeedback not found — retarget this test').toBeTruthy();
        expect(BODY.length).toBeGreaterThan(30);
    });
});

function makeImageCtor({ width = 1800, height = 1200 } = {}) {
    function FakeImage() {
        this._src = '';
        this.onload = null;
        this.onerror = null;
        this.width = width;
        this.height = height;
    }
    Object.defineProperty(FakeImage.prototype, 'src', {
        get() { return this._src; },
        set(v) { this._src = v; if (v && this.onload) this.onload(); },
    });
    return FakeImage;
}

function makeFileReaderCtor() {
    return function FakeFileReader() {
        this.onload = null;
        this.readAsDataURL = function () {
            this.result = 'data:image/jpeg;base64,cmVhZA==';
            if (this.onload) this.onload();
        };
    };
}

function loadModule(doc) {
    const body = [
        'var _fbImageData = null;',
        'function _closeOverlay() {}',
        'function _overlayCss() { return ""; }',
        // The real _sheet() wraps title/subtitle chrome around its html args;
        // all the ids openFeedback() needs live inside those html args, so
        // concatenating everything past the first two params reproduces the
        // exact markup this test needs without pulling _sheet() in too.
        'function _sheet() { return Array.prototype.slice.call(arguments, 2).join(""); }',
        'function _submitFeedback() {}',
        BODY,
        'return { openFeedback: openFeedback, getFbImageData: function () { return _fbImageData; } };',
    ].join('\n');
    const fn = new Function('document', 'requestAnimationFrame', 'Image', 'FileReader', body);
    return fn(doc, (f) => f(), makeImageCtor(), makeFileReaderCtor());
}

describe('openFeedback() releases the screenshot-attach canvas after encoding it', () => {
    it('zeroes the canvas right after toDataURL, not just leaving it to the GC', async () => {
        const { document } = parseHTML('<!doctype html><html><body></body></html>');
        const created = [];
        const realCreateElement = document.createElement.bind(document);
        document.createElement = (tag) => {
            if (tag !== 'canvas') return realCreateElement(tag);
            const rec = { widthLog: [], heightLog: [] };
            const c = {
                _w: 0, _h: 0,
                get width() { return c._w; },
                set width(v) { c._w = v; rec.widthLog.push(v); },
                get height() { return c._h; },
                set height(v) { c._h = v; rec.heightLog.push(v); },
                getContext: () => ({ drawImage() {} }),
                toDataURL: () => 'data:image/jpeg;base64,ZW5jb2RlZA==',
                _rec: rec,
            };
            created.push(c);
            return c;
        };

        const mod = loadModule(document);
        mod.openFeedback();
        const ov = document.getElementById('wfFeedback');
        expect(ov, 'openFeedback() did not create the #wfFeedback overlay').toBeTruthy();

        const imgInput = ov.querySelector('#wfFbImg');
        expect(imgInput, 'openFeedback() markup is missing #wfFbImg').toBeTruthy();
        imgInput.files = [{ name: 'screenshot.png', type: 'image/png' }];

        expect(typeof imgInput.onchange).toBe('function');
        imgInput.onchange();

        expect(created.length, 'no canvas was ever created for the downscale').toBe(1);
        expect(mod.getFbImageData()).toBe('data:image/jpeg;base64,ZW5jb2RlZA==');
        expect(created[0].width, 'screenshot canvas leaked — never zeroed after encoding').toBe(0);
        expect(created[0].height).toBe(0);
    });
});
