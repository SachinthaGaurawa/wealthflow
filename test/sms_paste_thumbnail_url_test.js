/* =============================================================================
 * test/sms_paste_thumbnail_url_test.js
 * -----------------------------------------------------------------------------
 * Part of the broader memory-safety audit that followed the mobile-only "A
 * problem repeatedly occurred" crashes fixed in wealthflow-ai-v4.js and
 * wealthflow-pdf-unlock.js. wealthflow-sms-paste.js's image-attach handler
 * creates a genuine blob: URL per pasted/attached screenshot via
 * URL.createObjectURL(f) for the thumbnail's <img src>, but nothing in the
 * file ever called URL.revokeObjectURL — removing a thumbnail's DOM node, or
 * closing the whole modal, dropped every reference to the blob URL without
 * ever releasing the bytes it points at, so each attached screenshot stayed
 * resident in memory for the rest of the session (or the whole app lifetime,
 * for a phone that is never fully closed).
 *
 * These tests run the real _revokeThumbUrl / _removeImageBlock / closeModal
 * functions (extracted from source, not reimplemented) against a real
 * linkedom DOM, so a regression that stops revoking fails here.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { parseHTML } from 'linkedom';

const ROOT = path.resolve(import.meta.dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-sms-paste.js'), 'utf8');

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

const NEEDED = ['_revokeThumbUrl', '_removeImageBlock', 'closeModal'];
const BODIES = Object.fromEntries(NEEDED.map((n) => [n, extractFn(SRC, n)]));

describe('the functions this file depends on are still where it expects', () => {
    for (const name of NEEDED) {
        it(`${name} was found and is non-trivial`, () => {
            expect(BODIES[name], `${name} not found — retarget this test`).toBeTruthy();
            expect(BODIES[name].length).toBeGreaterThan(20);
        });
    }
});

function loadModule(doc, revokeObjectURL) {
    const body = [
        "var _imgBlocks = {};",
        "var _state = { rows: [], editing: null };",
        "var _BLOCK_OPEN = '\\u0001wfimg\\u0002';",
        "var _BLOCK_MID = '\\u0003';",
        "var _BLOCK_CLOSE = '\\u0004';",
        "var _BLOCK_OPEN_RE = '\\\\u0001wfimg\\\\u0002';",
        "var _BLOCK_CLOSE_RE = '\\\\u0004';",
        BODIES._revokeThumbUrl,
        BODIES._removeImageBlock,
        BODIES.closeModal,
        'return {',
        '  _revokeThumbUrl: _revokeThumbUrl,',
        '  _removeImageBlock: _removeImageBlock,',
        '  closeModal: closeModal,',
        '  setImgBlock: function (id, v) { _imgBlocks[id] = v; },',
        '  getState: function () { return _state; },',
        '};',
    ].join('\n');
    const fn = new Function('document', 'URL', body);
    return fn(doc, { revokeObjectURL, createObjectURL: () => 'blob:fake' });
}

function makeThumbsDom(tiles) {
    const html = '<!doctype html><html><body>' +
        '<div id="wfsmsOverlay"><div id="wfsmsThumbs">' +
        tiles.map((t) => `<div data-block="${t.id}"><img src="${t.src}"></div>`).join('') +
        '</div></div></body></html>';
    return parseHTML(html).document;
}

describe('_revokeThumbUrl() only revokes real blob: thumbnail URLs', () => {
    it('revokes a blob: src', () => {
        const doc = makeThumbsDom([{ id: 'b1', src: 'blob:https://x/1' }]);
        const calls = [];
        const m = loadModule(doc, (u) => calls.push(u));
        m._revokeThumbUrl(doc.querySelector('[data-block="b1"]'));
        expect(calls).toEqual(['blob:https://x/1']);
    });

    it('leaves a non-blob src (e.g. a data: URL) alone', () => {
        const doc = makeThumbsDom([{ id: 'b1', src: 'data:image/png;base64,AAAA' }]);
        const calls = [];
        const m = loadModule(doc, (u) => calls.push(u));
        m._revokeThumbUrl(doc.querySelector('[data-block="b1"]'));
        expect(calls).toEqual([]);
    });

    it('never throws when the tile has no <img> at all', () => {
        const doc = makeThumbsDom([]);
        const div = doc.createElement('div');
        const m = loadModule(doc, () => {});
        expect(() => m._revokeThumbUrl(div)).not.toThrow();
    });
});

describe('_removeImageBlock() revokes the blob URL before dropping the tile', () => {
    it('revokes the removed block\'s URL and removes it from the DOM', () => {
        const doc = makeThumbsDom([
            { id: 'b1', src: 'blob:https://x/1' },
            { id: 'b2', src: 'blob:https://x/2' },
        ]);
        const calls = [];
        const m = loadModule(doc, (u) => calls.push(u));
        m.setImgBlock('b1', 'AAA');
        m.setImgBlock('b2', 'BBB');

        m._removeImageBlock('b1');

        expect(calls).toEqual(['blob:https://x/1']); // only the removed one
        expect(doc.querySelector('[data-block="b1"]')).toBeNull(); // gone from the DOM
        expect(doc.querySelector('[data-block="b2"]')).not.toBeNull(); // untouched
    });
});

describe('closeModal() revokes every remaining thumbnail before tearing down the overlay', () => {
    it('revokes all outstanding blob URLs, not just the ones removed one at a time', () => {
        // The owner's real path: paste 3 screenshots, close the modal without
        // tapping the x on any of them individually.
        const doc = makeThumbsDom([
            { id: 'b1', src: 'blob:https://x/1' },
            { id: 'b2', src: 'blob:https://x/2' },
            { id: 'b3', src: 'blob:https://x/3' },
        ]);
        const calls = [];
        const m = loadModule(doc, (u) => calls.push(u));

        m.closeModal();

        expect(calls.sort()).toEqual(['blob:https://x/1', 'blob:https://x/2', 'blob:https://x/3']);
        expect(doc.getElementById('wfsmsOverlay')).toBeNull(); // overlay itself is gone too
    });

    it('resets in-memory state even when there is no overlay to remove', () => {
        const doc = parseHTML('<!doctype html><html><body></body></html>').document;
        const m = loadModule(doc, () => {});
        expect(() => m.closeModal()).not.toThrow();
        expect(m.getState()).toEqual({ rows: [], editing: null });
    });
});
