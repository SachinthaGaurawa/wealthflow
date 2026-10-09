/* =============================================================================
 * pdf-shape.mjs — turn text into the glyphs a PDF has to draw, Sinhala included
 * -----------------------------------------------------------------------------
 * Sinhala is not drawn letter by letter. A vowel sign that is typed after its consonant is drawn BEFORE it, a vowel can
 * be split into a part on each side, and consonant clusters become single joined shapes. Which glyph that is, and where
 * it goes, is the font's own business, written as lookup tables (GSUB, GPOS) that only a shaping engine can apply.
 * That engine is HarfBuzz (the one browsers and phones use), compiled to WebAssembly by the `harfbuzzjs` package.
 *
 * What this file does with it: shape a string with a given font, and report for every glyph its number, how far to
 * move on, and any offset it is drawn at, plus the characters each cluster of glyphs came from (so the PDF can say what
 * the text says, for search and copy). Latin letters and digits are in the same font (Noto Sans Sinhala carries
 * them), so a line mixing Sinhala with amounts and references is one font, one baseline.
 *
 * LOADED ON DEMAND. The engine (about 0.4 MB) and the two fonts are read the first time a document needs them, never
 * for an English statement. Nothing here runs at import. A failure to load is reported to the caller, who falls back to
 * the English file; it is never swallowed into a file with wrong letters.
 * ===========================================================================*/

import fs from 'node:fs';
import { readFont } from './pdf-font.mjs';

export const FONT_FILES = Object.freeze({ regular: 'NotoSansSinhala-Regular.ttf', bold: 'NotoSansSinhala-Bold.ttf' });
const CACHE_MAX = 4000;
const LATIN_SPACE = 0.56;

/** Sinhala block, plus the joiners that live inside its clusters. */
export const SINHALA = /[඀-෿]/;
const isSinhalaCp = (cp) => (cp >= 0x0D80 && cp <= 0x0DFF);
const isJoiner = (cp) => cp === 0x200C || cp === 0x200D;

/** Does this text need the shaper to be drawn faithfully? */
export const needsShaping = (text) => SINHALA.test(String(text == null ? '' : text));

/**
 * Split into runs of one script: Sinhala letters (with the joiners between them), and everything else. A space
 * between two Sinhala words stays inside the Sinhala run, so a phrase is shaped as one.
 */
export function scriptRuns(text) {
    const chars = Array.from(String(text));
    const kind = chars.map((ch) => { const cp = ch.codePointAt(0); return isSinhalaCp(cp) ? 'sinh' : isJoiner(cp) ? 'join' : ch === ' ' ? 'space' : 'other'; });
    // a joiner takes the script of what is beside it; a space is Sinhala only between two Sinhala things
    for (let i = 0; i < kind.length; i += 1) if (kind[i] === 'join') kind[i] = (kind[i - 1] === 'sinh' || kind[i + 1] === 'sinh') ? 'sinh' : 'other';
    for (let i = 0; i < kind.length; i += 1) {
        if (kind[i] !== 'space') continue;
        let a = i - 1; while (a >= 0 && kind[a] === 'space') a -= 1;
        let b = i + 1; while (b < kind.length && kind[b] === 'space') b += 1;
        kind[i] = (a >= 0 && b < kind.length && kind[a] === 'sinh' && kind[b] === 'sinh') ? 'sinh' : 'other';
    }
    const runs = [];
    let offset = 0;                                   // in UTF-16 units, which is what the shaper's clusters count
    let cur = null;
    chars.forEach((ch, i) => {
        const script = kind[i] === 'sinh' ? 'Sinh' : 'Latn';
        if (!cur || cur.script !== script) { cur = { text: '', script, offset }; runs.push(cur); }
        cur.text += ch;
        offset += ch.length;
    });
    return runs;
}

/**
 * @param {object} hb the harfbuzzjs module
 * @param {{regular:Buffer, bold:Buffer}} files the font files
 */
export function createShaper(hb, files) {
    const faces = {};
    for (const [name, data] of Object.entries(files)) {
        const bytes = Buffer.from(data);
        const blob = new hb.Blob(bytes);
        const face = new hb.Face(blob);
        const font = new hb.Font(face);
        faces[name] = { bytes, face, font, parsed: readFont(bytes), supported: new Set(face.collectUnicodes()) };
    }
    const cache = new Map();
    const weight = (bold) => (bold ? faces.bold : faces.regular);

    /** The text as the font can show it: what it has, normalised, anything else a question mark. */
    function clean(text, bold = false) {
        const have = weight(bold).supported;
        let out = '';
        for (const ch of String(text == null ? '' : text).normalize('NFC')) {
            const cp = ch.codePointAt(0);
            if (cp === 9 || cp === 10 || cp === 13 || cp === 0xA0) out += ' ';
            else if (cp < 32 || cp === 127 || (cp >= 0xD800 && cp <= 0xDFFF) || cp === 0x200B || cp === 0x200E || cp === 0x200F || cp === 0xFEFF) continue;
            else out += have.has(cp) ? ch : '?';
        }
        return out.replace(/ {2,}/g, ' ');
    }

    /**
     * Shape already-clean text.
     * @returns {{glyphs:{gid:number, adv:number, dx:number, dy:number, from:number, to:number}[], width:number}} units are font units (upem)
     *   `from`/`to`: the slice of the text this glyph came from (the cluster it belongs to)
     */
    function shape(text, bold = false) {
        const key = `${bold ? 'b' : 'r'}|${text}`;
        if (cache.has(key)) return cache.get(key);
        const { font } = weight(bold);
        const glyphs = [];
        for (const run of scriptRuns(text)) {
            const buf = new hb.Buffer();
            try {
                buf.addText(run.text);
                buf.setDirection(hb.Direction ? hb.Direction.LTR : 4);
                buf.setScript(run.script);
                buf.setLanguage(run.script === 'Sinh' ? 'si' : 'en');
                hb.shape(font, buf);
                const infos = buf.getGlyphInfos();
                const pos = buf.getGlyphPositions();
                // the cluster of each glyph reaches to the next different cluster value
                const starts = [...new Set(infos.map((g) => g.cluster))].sort((a, b) => a - b);
                const endOf = (c) => { const i = starts.indexOf(c); return i + 1 < starts.length ? starts[i + 1] : run.text.length; };
                infos.forEach((g, i) => glyphs.push({
                    gid: g.codepoint,
                    // the font's space is as wide as a Sinhala word break wants (half an em); between Latin words and numbers that reads as a gap, so it is narrowed there
                    adv: run.script === 'Latn' && run.text[g.cluster] === ' ' ? Math.round(pos[i].xAdvance * LATIN_SPACE) : pos[i].xAdvance,
                    dx: pos[i].xOffset, dy: pos[i].yOffset,
                    from: run.offset + g.cluster, to: run.offset + endOf(g.cluster),
                }));
            } finally { if (typeof buf.destroy === 'function') buf.destroy(); }
        }
        const out = { glyphs, width: glyphs.reduce((a, g) => a + g.adv, 0) };
        if (cache.size >= CACHE_MAX) cache.clear();
        cache.set(key, out);
        return out;
    }

    /** Width in points of clean text at `size`. */
    const width = (text, bold, size) => (shape(text, bold).width * size) / weight(bold).parsed.upem;

    return {
        clean, shape, width, weight,
        upem: faces.regular.parsed.upem,
        font: (bold) => weight(bold).parsed,
        /** the glyph advance the PDF's own width table will state for `gid` */
        advanceOf: (gid, bold) => weight(bold).parsed.advances[gid] || 0,
    };
}

let loading = null;

/**
 * The shared shaper, loaded once per server instance. A failed load is not remembered, so the next request tries again.
 * `deps` exist for tests: the package, the file reader.
 */
export function loadShaper(deps = {}) {
    if (deps.fresh) return build(deps);
    if (!loading) loading = build(deps).catch((e) => { loading = null; throw e; });
    return loading;
}

async function build({ importHb = () => import('harfbuzzjs'), readFile = (name) => fs.readFileSync(new URL(`./assets/fonts/${name}`, import.meta.url)) } = {}) {
    const hb = await importHb();
    return createShaper(hb, { regular: readFile(FONT_FILES.regular), bold: readFile(FONT_FILES.bold) });
}

export default { createShaper, loadShaper, scriptRuns, needsShaping, FONT_FILES };
