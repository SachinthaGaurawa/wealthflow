/* =============================================================================
 * test/scan_overlay_test.js
 * -----------------------------------------------------------------------------
 * The receipt scanner, migrated from emoji to icons. Twenty-seven glyphs across
 * handleAIScan alone, in three different kinds of sink, each needing a different
 * answer:
 *
 *   1. THE PROGRESS OVERLAY writes with `textContent`. A spelled-out WFIcon()
 *      call there renders as literal markup — the trap the lock-screen title
 *      fell into two migrations ago — so the stage line has to be built from an
 *      icon NODE, and the sink had to grow a parameter to take one.
 *
 *   2. THE TOASTS already draw an icon for their type. Their leading glyph was
 *      duplicating it: a success toast said "✅ Scanned…" beside a checkCircle.
 *      Those come off with nothing to replace them.
 *
 *   3. THE NOTES ANNOTATIONS are neither. They live in an <input>'s value, which
 *      WFIconStripEmoji skips by design — so they were the one place on this
 *      screen where a raw emoji actually reached the user. They become words,
 *      and that is a DATA format change, which is the part of this that can go
 *      wrong quietly. Most of this file is about that.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');
const V4 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');

/** Brace-counted body of a top-level function, with an end check. */
function fn(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let depth = 0;
    for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    return '';
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The notes annotations — the only part that touches saved data
 * ═══════════════════════════════════════════════════════════════════════════*/
function loadReplaceScanNote() {
    const rx = fn('_replaceScanNote');
    expect(rx, '_replaceScanNote is gone — every test below would pass vacuously').toBeTruthy();
    const decl = (HTML.match(/const _SCAN_NOTE_RX = [^\n]+/) || [])[0];
    expect(decl, 'the annotation pattern is gone').toBeTruthy();
    return new Function(`${decl}\n${rx}\nreturn _replaceScanNote;`)();
}

describe('the scanner rewrites its own note and never stacks a second one', () => {
    const replace = loadReplaceScanNote();

    /* Written as escapes: this file argues against emoji and carries none.
     * U+1F4E6 prefixed the items note, U+1F524 the OCR note. */
    const OLD_ITEMS = '\u{1F4E6}';
    const OLD_OCR = '\u{1F524}';

    it('writes the annotation into an empty note', () => {
        expect(replace('', 'Items: rice, dhal')).toBe('Items: rice, dhal');
    });

    it('keeps what the owner typed', () => {
        expect(replace('reimburse from Amal', 'OCR: TOTAL 1500'))
            .toBe('reimburse from Amal | OCR: TOTAL 1500');
    });

    it('replaces its own previous annotation rather than adding another', () => {
        const once = replace('', 'Items: rice');
        const twice = replace(once, 'Items: rice, dhal');
        expect(twice).toBe('Items: rice, dhal');
    });

    it('REPLACES A GLYPH-ERA ANNOTATION, so old notes do not grow on re-scan', () => {
        /* The heart of this file. A note saved before this change carries the
         * glyph prefix. If the filter only knew the new words, every re-scan
         * would append and the field would grow without bound — silently, on
         * data the owner already has. Both legacy prefixes, and mixed with
         * text that must survive. */
        expect(replace(`${OLD_ITEMS} rice, dhal`, 'Items: rice, dhal, sugar'))
            .toBe('Items: rice, dhal, sugar');
        expect(replace(`${OLD_OCR} OCR: TOTAL 1500`, 'OCR: TOTAL 1650'))
            .toBe('OCR: TOTAL 1650');
        expect(replace(`petty cash | ${OLD_ITEMS} rice | ${OLD_OCR} OCR: junk`, 'Items: rice, dhal'))
            .toBe('petty cash | Items: rice, dhal');
    });

    it('a re-scan of an already-migrated note is idempotent, ten times over', () => {
        let note = `paid by card | ${OLD_ITEMS} old items`;
        for (let i = 0; i < 10; i += 1) note = replace(note, 'Items: rice');
        expect(note).toBe('paid by card | Items: rice');
    });

    it('survives the empty and absent cases callers pass', () => {
        expect(replace(undefined, 'OCR: x')).toBe('OCR: x');
        expect(replace(null, 'OCR: x')).toBe('OCR: x');
        expect(replace('   |  | ', 'OCR: x')).toBe('OCR: x');
    });

    it('does not eat a note that merely mentions the words', () => {
        /* The pattern is anchored, so "Items:" has to START the segment.
         * An unanchored one would delete the owner's own sentence. */
        expect(replace('check the Items: list on the fridge', 'OCR: x'))
            .toBe('check the Items: list on the fridge | OCR: x');
    });

    it('is the single definition — neither call site kept its own copy', () => {
        /* Both sites used to carry the same filter by copy. That is how the two
         * drift apart: someone teaches one of them the new prefix and the other
         * keeps appending forever. */
        const copies = (HTML.match(/filter\(p => p && !p\.startsWith/g) || []).length;
        expect(copies, 'a hand-rolled copy of the annotation filter is back').toBe(0);
        expect((HTML.match(/_replaceScanNote\(/g) || []).length,
            'both writers should go through the helper').toBeGreaterThanOrEqual(3);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. The progress overlay
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the scan overlay stage line', () => {
    function drive(stage, detail, pct, icon) {
        const src = fn('_showScanOverlay');
        expect(src, '_showScanOverlay is gone').toBeTruthy();
        const made = [];
        const el = (tag) => {
            const n = {
                tagName: String(tag).toUpperCase(), children: [], text: null,
                style: {}, className: '',
                appendChild(c) { this.children.push(c); return c; },
                set textContent(v) { this.text = String(v); this.children = []; },
                get textContent() { return this.text; },
                set innerHTML(v) { throw new Error('the stage line was built as markup: ' + v); },
            };
            made.push(n);
            return n;
        };
        const nodes = { aiScanOverlay: el('div'), aiScanStage: el('div'), aiScanDetail: el('div'), aiScanBar: el('div') };
        const asked = [];
        const win = { WFIconNode(name) { asked.push(name); const n = el('svg'); n.icon = name; return n; } };
        const doc = { createElement: el, createTextNode: (t) => ({ tagName: '#text', text: String(t), children: [] }) };
        new Function('$', 'window', 'document', `${src}\n_showScanOverlay(${JSON.stringify(stage)}, ${JSON.stringify(detail)}, ${pct}, ${JSON.stringify(icon) || 'undefined'});`)(
            (id) => nodes[id] || null, win, doc,
        );
        return { stage: nodes.aiScanStage, asked, bar: nodes.aiScanBar };
    }

    it('puts a real icon node before the text', () => {
        const { stage, asked } = drive('Deep Scanning Receipt…', 'x', 60, 'scan');
        expect(asked).toEqual(['scan']);
        expect(stage.children.map((c) => c.tagName)).toEqual(['SVG', '#text', '#text']);
        expect(stage.children[2].text).toBe('Deep Scanning Receipt…');
    });

    it('never builds the stage line as markup', () => {
        /* This element is written with textContent. A WFIcon() STRING here
         * would show the reader `<svg …>` as words — which is exactly what
         * happened when an inline SVG was handed to an OS notification title.
         * The modelled innerHTML setter above throws, so that cannot come back. */
        expect(() => drive('<b>x</b>', 'y', 10, 'camera')).not.toThrow();
        const { stage } = drive('<b>x</b>', 'y', 10, 'camera');
        expect(stage.children[2].text).toBe('<b>x</b>');
    });

    it('still shows its text for a caller that passes no icon', () => {
        const { stage, asked } = drive('Working…', 'y', 50, undefined);
        expect(asked).toEqual([]);
        expect(stage.children.map((c) => c.text)).toEqual(['Working…']);
    });

    it('clears the previous stage instead of appending to it', () => {
        const { stage } = drive('Second stage', 'y', 80, 'chartLine');
        expect(stage.children.filter((c) => c.tagName === '#text' && c.text.trim()).length).toBe(1);
    });

    it('still moves the bar', () => {
        expect(drive('x', 'y', 85, 'scan').bar.style.width).toBe('85%');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. Every stage names a real icon
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the scanner pipeline', () => {
    const calls = HTML.match(/_showScanOverlay\((?!stage)[^;]*?\);/g) || [];

    it('has call sites to check', () => {
        expect(calls.length, 'the call-site scan found nothing').toBeGreaterThanOrEqual(11);
    });

    it('passes an icon at every stage, and every icon exists', () => {
        const missing = [];
        for (const c of calls) {
            const m = c.match(/,\s*'([a-zA-Z][a-zA-Z0-9]*)'\s*\)/);
            if (!m) { missing.push(`no icon: ${c.slice(0, 70)}`); continue; }
            if (!ICONS.includes(`${m[1]}:`)) missing.push(`icon "${m[1]}" is not in the set`);
        }
        expect(missing, missing.join(' | ')).toEqual([]);
    });

    it('names an icon suited to its stage rather than one generic mark', () => {
        /* Removing an icon is not an emoji violation, so the count cannot catch
         * a migration that replaced twelve distinct marks with twelve identical
         * ones. Naming them is the only thing that does. */
        for (const [text, icon] of [
            ['Optimizing Image…', 'camera'],
            ['AI Vision Analyzing…', 'bot'],
            ['Deep Scanning Receipt…', 'scan'],
            ['Processing Results…', 'chartLine'],
            ['Quick AI Retry…', 'sparkles'],
            ['Cloud OCR API…', 'cloud'],
            ['Tesseract OCR Engine…', 'fileText'],
            ['Writing notes…', 'edit'],
        ]) {
            const hit = calls.find((c) => c.includes(text));
            expect(hit, `the "${text}" stage is gone`).toBeTruthy();
            expect(hit, `"${text}" lost its ${icon} icon`).toContain(`'${icon}'`);
        }
    });

    it('the overlay opens on an icon rather than a glyph', () => {
        const first = (HTML.match(/id="aiScanStage"[^>]*>([^<]*<i[^>]*>)?/) || [])[0] || '';
        expect(first, 'the static first frame lost its icon placeholder').toContain('data-wfi="camera"');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. The toasts stopped duplicating the icon the toast already draws
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the scanner toasts', () => {
    it('carry no glyph of their own', () => {
        const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
        for (const name of ['handleAIScan', '_populateExpenseFromScan', '_ocrWithTesseract']) {
            const body = fn(name);
            expect(body, `${name} not found`).toBeTruthy();
            const found = body.match(EMOJI) || [];
            expect(found, `emoji in ${name}: ${found.join(' ')}`).toEqual([]);
        }
    });

    it('still say what happened', () => {
        /* A migration that deleted the glyph AND the sentence would pass an
         * emoji count and lose the message. */
        const body = fn('handleAIScan');
        for (const phrase of [
            'Scanned in ${elapsed}s',
            'Receipt scanned (quick mode)',
            'Scanned via Cloud OCR',
            'Could not read receipt. Try a clearer, well-lit photo.',
            'All scan methods failed. Please enter manually.',
        ]) {
            expect(body, `the toast "${phrase}" is gone`).toContain(phrase);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 5. WHICH implementation actually runs
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the overlay that is really on screen', () => {
    /* The lesson of this change, and the one worth keeping.
     *
     * Every test above reads index.html. index.html declares
     * `function _showScanOverlay(...)` at global scope — and wealthflow-ai-v4.js
     * then does `window._showScanOverlay = _showScanOverlayV5`. At global scope
     * the declaration IS the window property, so that assignment replaces the
     * binding the host's own call sites resolve. index.html's version, and the
     * #aiScanOverlay markup it writes into, never run again.
     *
     * The first version of this migration gave the host's copy a fourth `icon`
     * parameter and wired eleven call sites to it. Every source test passed.
     * Driving a real Chromium showed the overlay unchanged on all eleven
     * stages, because the argument was going to a three-parameter function and
     * being discarded in silence.
     *
     * A signature mismatch between an overridden function and its override is
     * invisible in JavaScript. These tests make it visible. */
    const arity = (src, name) => {
        const m = src.match(new RegExp(`function ${name}\\s*\\(([^)]*)\\)`));
        expect(m, `${name} not found`).toBeTruthy();
        return m[1].split(',').map((a) => a.trim()).filter(Boolean);
    };

    it('is _showScanOverlayV5, and it is installed over the host copy', () => {
        expect(V4).toContain('window._showScanOverlay = _showScanOverlayV5');
        expect(V4).toContain('window._hideScanOverlay = _hideScanOverlayV5');
    });

    it('takes the icon argument the host call sites pass', () => {
        /* The load-bearing assertion. If someone re-points the override at a
         * narrower function, or drops the parameter here, every stage silently
         * loses its mark and nothing else in this suite would notice. */
        const params = arity(V4, '_showScanOverlayV5');
        expect(params.length, 'the live overlay stopped taking an icon').toBe(4);
        expect(params[3]).toBe('icon');
    });

    it('agrees with the host declaration it replaces', () => {
        expect(arity(HTML, '_showScanOverlay')).toEqual(arity(V4, '_showScanOverlayV5'));
    });

    it('builds its stage from a node, not from a string of markup', () => {
        const body = (V4.match(/function _showScanOverlayV5[\s\S]*?\n    \}/) || [''])[0];
        expect(body).toContain('WFIconNode');
        expect(body).toContain('createTextNode');
        expect(body, 'wf5ScanStage is written with textContent — markup would show as words')
            .not.toContain('innerHTML');
    });

    it('names an icon at every one of its own stages, and each one exists', () => {
        const calls = V4.match(/window\._showScanOverlay\([\s\S]*?\);/g) || [];
        expect(calls.length, 'the v4 call-site scan found nothing').toBeGreaterThanOrEqual(19);
        const bad = [];
        for (const c of calls) {
            const names = [...c.matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'\s*(?:\)|:)/g)].map((m) => m[1]);
            const icon = names.filter((n) => ICONS.includes(`${n}:`)).pop();
            if (!icon) bad.push(c.replace(/\s+/g, ' ').slice(0, 80));
        }
        expect(bad, `stages with no usable icon: ${bad.join(' | ')}`).toEqual([]);
    });

    it('carries no emoji on any stage line', () => {
        const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
        const calls = V4.match(/window\._showScanOverlay\([\s\S]*?\);/g) || [];
        const found = calls.flatMap((c) => c.match(EMOJI) || []);
        expect(found, `emoji still on the live stages: ${found.join(' ')}`).toEqual([]);
        const shell = (V4.match(/id="wf5ScanStage"[^']*/) || [''])[0];
        expect(shell.match(EMOJI) || [], 'the overlay opens on a glyph').toEqual([]);
        expect(shell, 'the overlay lost its opening icon').toContain('data-wfi="camera"');
    });
});
