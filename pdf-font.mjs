/* =============================================================================
 * pdf-font.mjs — read a TrueType font and cut it down to the glyphs a document uses
 * -----------------------------------------------------------------------------
 * A PDF that shows Sinhala has to carry the letters with it (the 14 standard fonts have none), and a whole font is
 * ~240 KB per weight. A statement uses a few dozen distinct glyphs, so the font that goes into the file keeps only
 * those: the outlines of the glyphs that were drawn (and the parts of any composite among them) and nothing else.
 *
 * GLYPH NUMBERS ARE NOT CHANGED. The text in the PDF names glyphs by number (the shaper's answer), so a subset that
 * kept the numbers can be embedded with an identity map and needs no translation table, and a bug in renumbering is
 * not possible. A glyph that was not used keeps its slot with an empty outline. What is dropped is everything a viewer
 * does not need to DRAW glyphs it was told to draw by number: the character map, the shaping tables (GSUB, GPOS, GDEF),
 * names, OS/2, post, kerning. The file keeps head, hhea, maxp, hmtx, loca, glyf (and prep/cvt/fpgm when the font has
 * them), the set PDF viewers require of an embedded TrueType program.
 *
 * Pure: bytes in, bytes out, no files, no network.
 * ===========================================================================*/

const need = (cond, what) => { if (!cond) throw new Error(`font: ${what}`); };

/** The tables a PDF viewer needs to draw glyphs by number. */
const KEEP = ['cvt ', 'fpgm', 'glyf', 'head', 'hhea', 'hmtx', 'loca', 'maxp', 'prep'];

/**
 * Parse what the subsetter and the PDF writer need.
 * @param {Buffer|Uint8Array} input a TrueType (glyf) font file
 */
export function readFont(input) {
    const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
    need(buf.length > 12, 'too short');
    const kind = buf.readUInt32BE(0);
    need(kind === 0x00010000 || kind === 0x74727565, 'not a TrueType font (an OpenType/CFF font cannot be embedded this way)');
    const count = buf.readUInt16BE(4);
    need(buf.length >= 12 + count * 16, 'truncated table directory');
    const tables = new Map();
    for (let i = 0; i < count; i += 1) {
        const at = 12 + i * 16;
        const tag = buf.toString('latin1', at, at + 4);
        const offset = buf.readUInt32BE(at + 8);
        const length = buf.readUInt32BE(at + 12);
        need(offset + length <= buf.length, `table ${tag} runs past the end of the file`);
        tables.set(tag, { offset, length });
    }
    for (const t of ['head', 'hhea', 'maxp', 'hmtx', 'loca', 'glyf']) need(tables.has(t), `no ${t} table`);
    const head = tables.get('head').offset;
    const hhea = tables.get('hhea').offset;
    const upem = buf.readUInt16BE(head + 18);
    need(upem >= 16 && upem <= 16384, 'unreasonable units per em');
    const locaFormat = buf.readInt16BE(head + 50);
    need(locaFormat === 0 || locaFormat === 1, 'unknown loca format');
    const numGlyphs = buf.readUInt16BE(tables.get('maxp').offset + 4);
    const numHM = buf.readUInt16BE(hhea + 34);
    need(numHM >= 1 && numHM <= numGlyphs, 'bad hhea');
    const hmtx = tables.get('hmtx').offset;
    need(tables.get('hmtx').length >= numHM * 4, 'short hmtx');
    const advances = new Array(numGlyphs);
    for (let g = 0; g < numGlyphs; g += 1) advances[g] = buf.readUInt16BE(hmtx + 4 * Math.min(g, numHM - 1));
    const locaT = tables.get('loca');
    need(locaT.length >= (numGlyphs + 1) * (locaFormat ? 4 : 2), 'short loca');
    const loca = new Array(numGlyphs + 1);
    for (let g = 0; g <= numGlyphs; g += 1) loca[g] = locaFormat ? buf.readUInt32BE(locaT.offset + 4 * g) : buf.readUInt16BE(locaT.offset + 2 * g) * 2;
    const glyfLength = tables.get('glyf').length;
    for (let g = 0; g < numGlyphs; g += 1) need(loca[g] <= loca[g + 1] && loca[g + 1] <= glyfLength, `glyph ${g} is outside the glyf table`);
    return {
        buf, tables, upem, numGlyphs, advances, loca,
        bbox: [buf.readInt16BE(head + 36), buf.readInt16BE(head + 38), buf.readInt16BE(head + 40), buf.readInt16BE(head + 42)],
        ascent: buf.readInt16BE(hhea + 4), descent: buf.readInt16BE(hhea + 6),
    };
}


/**
 * For each glyph that the font reaches directly from a character, the (lowest) character: glyph number -> code point.
 * This is what a PDF's ToUnicode map needs for a glyph whatever text it appears in. Glyphs the font only reaches through
 * shaping (a conjunct, a half form) are not in it. Reads format 4 and format 12 subtables; a font with neither gives an empty map.
 * @param {ReturnType<typeof readFont>} font
 * @returns {Map<number, number>}
 */
export function glyphCodePoints(font) {
    const out = new Map();
    const t = font.tables.get('cmap');
    if (!t) return out;
    const buf = font.buf;
    const n = buf.readUInt16BE(t.offset + 2);
    const take = (gid, cp) => { if (gid <= 0 || gid >= font.numGlyphs || (cp >= 0xD800 && cp <= 0xDFFF)) return; if (!out.has(gid) || out.get(gid) > cp) out.set(gid, cp); };
    for (let i = 0; i < n; i += 1) {
        const rec = t.offset + 4 + i * 8;
        const sub = t.offset + buf.readUInt32BE(rec + 4);
        if (sub + 4 > buf.length) continue;
        const format = buf.readUInt16BE(sub);
        if (format === 12) {
            const groups = buf.readUInt32BE(sub + 12);
            for (let g = 0; g < groups && sub + 16 + g * 12 + 12 <= buf.length; g += 1) {
                const at = sub + 16 + g * 12;
                const start = buf.readUInt32BE(at); const end = buf.readUInt32BE(at + 4); const first = buf.readUInt32BE(at + 8);
                if (end < start || end - start > 0x10FFFF) continue;
                for (let cp = start; cp <= end; cp += 1) take(first + (cp - start), cp);
            }
        } else if (format === 4) {
            const segX2 = buf.readUInt16BE(sub + 6);
            const ends = sub + 14; const starts = ends + segX2 + 2; const deltas = starts + segX2; const ranges = deltas + segX2;
            for (let s = 0; s < segX2 / 2 && ranges + segX2 <= buf.length; s += 1) {
                const end = buf.readUInt16BE(ends + 2 * s); const start = buf.readUInt16BE(starts + 2 * s);
                const delta = buf.readInt16BE(deltas + 2 * s); const off = buf.readUInt16BE(ranges + 2 * s);
                if (start === 0xFFFF) continue;
                for (let cp = start; cp <= end; cp += 1) {
                    let gid;
                    if (off === 0) gid = (cp + delta) & 0xFFFF;
                    else {
                        const at = ranges + 2 * s + off + 2 * (cp - start);
                        if (at + 2 > buf.length) continue;
                        gid = buf.readUInt16BE(at);
                        if (gid) gid = (gid + delta) & 0xFFFF;
                    }
                    take(gid, cp);
                }
            }
        }
    }
    return out;
}

/** The glyphs a composite glyph is built from (none for a simple glyph or an empty one). */
function componentsOf(font, gid) {
    const from = font.loca[gid];
    const to = font.loca[gid + 1];
    if (to - from < 10) return [];
    const base = font.tables.get('glyf').offset + from;
    if (font.buf.readInt16BE(base) >= 0) return [];
    const out = [];
    let p = base + 10;
    for (;;) {
        need(p + 4 <= base + (to - from), `composite glyph ${gid} is cut short`);
        const flags = font.buf.readUInt16BE(p);
        const part = font.buf.readUInt16BE(p + 2);
        need(part < font.numGlyphs, `composite glyph ${gid} names a glyph that does not exist`);
        out.push(part);
        p += 4 + (flags & 0x0001 ? 4 : 2);
        if (flags & 0x0008) p += 2;
        else if (flags & 0x0040) p += 4;
        else if (flags & 0x0080) p += 8;
        if (!(flags & 0x0020)) break;
    }
    return out;
}

const pad4 = (n) => (n + 3) & ~3;

function checksum(buf) {
    let sum = 0;
    const whole = buf.length & ~3;
    for (let i = 0; i < whole; i += 4) sum = (sum + buf.readUInt32BE(i)) >>> 0;
    if (buf.length > whole) {
        const tail = Buffer.alloc(4);
        buf.copy(tail, 0, whole);
        sum = (sum + tail.readUInt32BE(0)) >>> 0;
    }
    return sum;
}

/**
 * A font file holding only `glyphs` (and what they are made of). Glyph numbers are the original ones.
 * @param {ReturnType<typeof readFont>} font
 * @param {Iterable<number>} glyphs
 * @returns {{file:Buffer, kept:number[]}}
 */
export function subsetFont(font, glyphs) {
    const keep = new Set([0]);
    const queue = [];
    for (const g of glyphs) {
        need(Number.isInteger(g) && g >= 0 && g < font.numGlyphs, `glyph ${g} is not in the font`);
        if (!keep.has(g)) { keep.add(g); queue.push(g); }
    }
    for (let g = queue.pop(); g !== undefined; g = queue.pop()) {
        for (const part of componentsOf(font, g)) if (!keep.has(part)) { keep.add(part); queue.push(part); }
    }

    // glyf and loca: a long loca (4-byte offsets), every kept outline padded to a multiple of four
    const glyfStart = font.tables.get('glyf').offset;
    const chunks = [];
    const loca = Buffer.alloc((font.numGlyphs + 1) * 4);
    let at = 0;
    for (let g = 0; g < font.numGlyphs; g += 1) {
        loca.writeUInt32BE(at, g * 4);
        if (!keep.has(g)) continue;
        const len = font.loca[g + 1] - font.loca[g];
        if (!len) continue;
        const chunk = Buffer.alloc(pad4(len));
        font.buf.copy(chunk, 0, glyfStart + font.loca[g], glyfStart + font.loca[g + 1]);
        chunks.push(chunk);
        at += chunk.length;
    }
    loca.writeUInt32BE(at, font.numGlyphs * 4);
    const glyf = Buffer.concat(chunks);

    const out = new Map();
    for (const tag of KEEP) {
        const t = font.tables.get(tag);
        if (tag === 'glyf') out.set(tag, glyf);
        else if (tag === 'loca') out.set(tag, loca);
        else if (t) out.set(tag, Buffer.from(font.buf.subarray(t.offset, t.offset + t.length)));
    }
    const head = out.get('head');
    head.writeUInt32BE(0, 8);                 // checkSumAdjustment is worked out last
    head.writeInt16BE(1, 50);                 // the loca written above is the long form

    const tags = [...out.keys()].sort();
    const dirLen = 12 + 16 * tags.length;
    let offset = pad4(dirLen);
    const placed = tags.map((tag) => { const data = out.get(tag); const row = { tag, data, offset, sum: checksum(data) }; offset += pad4(data.length); return row; });
    const file = Buffer.alloc(offset);
    file.writeUInt32BE(0x00010000, 0);
    file.writeUInt16BE(tags.length, 4);
    const pow = 2 ** Math.floor(Math.log2(tags.length));
    file.writeUInt16BE(pow * 16, 6);
    file.writeUInt16BE(Math.log2(pow), 8);
    file.writeUInt16BE(tags.length * 16 - pow * 16, 10);
    placed.forEach((row, i) => {
        const p = 12 + i * 16;
        file.write(row.tag, p, 'latin1');
        file.writeUInt32BE(row.sum, p + 4);
        file.writeUInt32BE(row.offset, p + 8);
        file.writeUInt32BE(row.data.length, p + 12);
        row.data.copy(file, row.offset);
    });
    const adjust = (0xB1B0AFBA - checksum(file)) >>> 0;
    file.writeUInt32BE(adjust, placed.find((r) => r.tag === 'head').offset + 8);
    return { file, kept: [...keep].sort((a, b) => a - b) };
}

export default { readFont, subsetFont, glyphCodePoints };
