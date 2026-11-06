// Any-size feedback screenshot, understood by the AI (owner, 2026-11-04):
//   browser: wealthflow-image-prep.js makes an issue-sized thumbnail AND up to three reading-quality parts;
//   server : feedback-triage.js reads those parts when the report is filed and writes WORDS into the issue;
//   agent  : a screenshot already read at filing time is not read a second time from the thumbnail.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import {
    readAttachments, validReadingImages, screenshotContext, READING_MARKER, MAX_READING_CHARS, MAX_READING_IMAGES, IMAGE_MARKER,
} from '../autonomy/screenshot-reader.mjs';

const jpeg = (n) => 'data:image/jpeg;base64,' + 'A'.repeat(n);

// A canvas whose output size behaves like JPEG's: bigger pictures and higher quality give more characters.
function sandbox(decode) {
    const sb = {
        createImageBitmap: decode,
        document: {
            createElement: () => {
                const cv = {
                    width: 0, height: 0,
                    getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v) {} }),
                    toDataURL: (_t, q) => 'data:image/jpeg;base64,' + 'A'.repeat(Math.round(cv.width * cv.height * q * 0.35)),
                };
                return cv;
            },
        },
    };
    sb.window = sb; sb.globalThis = sb;
    new Function('window', 'globalThis', 'createImageBitmap', 'document', fs.readFileSync('wealthflow-image-prep.js', 'utf8'))(sb, sb, sb.createImageBitmap, sb.document);
    return sb.WFImagePrep;
}

describe('wealthflow-image-prep: any size in, something the AI can read out', () => {
    const P = sandbox(async () => ({ width: 100, height: 100 }));
    it('a normal picture is one tile', () => {
        expect(P.planTiles(1440, 900)).toEqual([{ sx: 0, sy: 0, sw: 1440, sh: 900 }]);
        expect(P.planTiles(390, 844)).toHaveLength(1);
    });
    it('a tall capture is cut into overlapping parts that cover all of it', () => {
        const t = P.planTiles(1170, 9000);
        expect(t.length).toBeGreaterThan(1);
        expect(t.length).toBeLessThanOrEqual(P.MAX_TILES);
        expect(t[0].sy).toBe(0);
        expect(t[t.length - 1].sy + t[t.length - 1].sh).toBe(9000);
        for (let i = 1; i < t.length; i++) expect(t[i].sy).toBeLessThan(t[i - 1].sy + t[i - 1].sh);   // they overlap
        t.forEach((x) => { expect(x.sx).toBe(0); expect(x.sw).toBe(1170); expect(x.sy).toBeGreaterThanOrEqual(0); });
    });
    it('a wide strip is cut left to right', () => {
        const t = P.planTiles(8000, 800);
        expect(t.length).toBeGreaterThan(1);
        expect(t[t.length - 1].sx + t[t.length - 1].sw).toBe(8000);
        t.forEach((x) => { expect(x.sy).toBe(0); expect(x.sh).toBe(800); });
    });
    it('never invents a tile outside the picture, whatever it is given', () => {
        for (const [w, h] of [[1, 1], [1, 100000], [100000, 1], [0, 0], [-5, 7.9], [4000, 4000]]) {
            for (const x of P.planTiles(w, h)) {
                expect(x.sx).toBeGreaterThanOrEqual(0); expect(x.sy).toBeGreaterThanOrEqual(0);
                expect(x.sw).toBeGreaterThan(0); expect(x.sh).toBeGreaterThan(0);
                expect(x.sx + x.sw).toBeLessThanOrEqual(Math.max(1, Math.floor(w)));
                expect(x.sy + x.sh).toBeLessThanOrEqual(Math.max(1, Math.floor(h)));
            }
        }
    });
    it('never scales a small picture up', () => {
        expect(P.scaledSize(300, 200, 1568)).toEqual({ w: 300, h: 200 });
        expect(P.scaledSize(3136, 1568, 1568)).toEqual({ w: 1568, h: 784 });
    });
    it('a huge retina capture comes out as a thumbnail that fits an issue and reading parts under the server cap', async () => {
        const Q = sandbox(async () => ({ width: 5760, height: 3600, close() {} }));
        const r = await Q.prepare({ name: 'big.png', size: 25_000_000 });
        expect(r.ok).toBe(true);
        expect(r.thumb.length).toBeGreaterThan(0);
        expect(r.thumb.length).toBeLessThanOrEqual(43500);
        expect(r.reading.length).toBe(1);
        expect(r.reading[0].length).toBeLessThanOrEqual(1_000_000);
        expect(r.reading[0].length).toBeLessThanOrEqual(MAX_READING_CHARS);
        expect(r.reading[0].length).toBeGreaterThan(r.thumb.length);   // it really is the better picture
    });
    it('a tall page capture yields several readable parts, each within the cap', async () => {
        const Q = sandbox(async () => ({ width: 1170, height: 12000 }));
        const r = await Q.prepare({});
        expect(r.reading.length).toBeGreaterThan(1);
        expect(r.reading.length).toBeLessThanOrEqual(MAX_READING_IMAGES);
        r.reading.forEach((x) => expect(x.length).toBeLessThanOrEqual(1_000_000));
    });
    it('a picture that cannot be decoded is reported, not thrown', async () => {
        const Q = sandbox(async () => { throw new Error('bad image'); });
        const r = await Q.prepare({});
        expect(r).toMatchObject({ ok: false, thumb: '', reading: [] });
        expect(r.reason).toMatch(/bad image/);
    });
});

describe('reading the attachment when the report is filed', () => {
    const ok = (t) => async () => ({ ok: true, text: t, provider: 'gemini', model: 'gemini-2.5-flash', tried: [] });
    it('accepts only real raster data URLs, at most three, none over the cap', () => {
        expect(validReadingImages([jpeg(10), 'https://evil/x.png', 'data:image/svg+xml;base64,AAAA', jpeg(MAX_READING_CHARS + 5), jpeg(20), jpeg(30), jpeg(40)])).toHaveLength(3);
        expect(validReadingImages(null)).toEqual([]);
        expect(validReadingImages('x')).toEqual([]);
    });
    it('writes what the picture shows into the issue, with the marker and an honest caveat', async () => {
        const r = await readAttachments({ images: [jpeg(50)], title: 't', text: 'overlap', describeImpl: ok('SCREEN: CC Instalments, phone. PROBLEM: the Actions column covers Bank.') });
        expect(r.status).toBe('read');
        expect(r.section).toContain('### What the AI saw in the screenshot');
        expect(r.section).toContain(`<!-- ${READING_MARKER} -->`);
        expect(r.section).toMatch(/machine reading and can be wrong/);
        expect(r.section).toContain('Actions column covers Bank');
    });
    it('tells the model each part belongs to one tall picture, and labels the parts', async () => {
        const seen = [];
        const r = await readAttachments({ images: [jpeg(1), jpeg(2), jpeg(3)], text: 'x', describeImpl: async (a) => { seen.push(a.text); return { ok: true, text: 'part text', provider: 'gemini', model: 'm', tried: [] }; } });
        expect(seen[1]).toMatch(/part 2 of 3/);
        expect(r.section).toContain('**Part 3 of 3**');
    });
    it('says plainly when some parts could not be read, and when none could', async () => {
        let n = 0;
        const some = await readAttachments({ images: [jpeg(1), jpeg(2)], describeImpl: async () => (n++ ? { ok: false, tried: ['x'] } : { ok: true, text: 'seen', provider: 'p', model: 'm', tried: [] }) });
        expect(some.status).toBe('read');
        expect(some.section).toMatch(/1 of 2 parts could not be read/);
        const none = await readAttachments({ images: [jpeg(1)], describeImpl: async () => ({ ok: false, tried: ['gemini/x: HTTP 429'] }) });
        expect(none).toMatchObject({ status: 'unreadable', section: '' });
        expect(none.tried.join()).toMatch(/429/);
    });
    it('a provider that throws does not break the report', async () => {
        const r = await readAttachments({ images: [jpeg(1)], describeImpl: async () => { throw new Error('boom'); } });
        expect(r.status).toBe('unreadable');
    });
    it('nothing to read is not an error', async () => {
        expect(await readAttachments({ images: [] })).toEqual({ status: 'none', section: '' });
        expect(await readAttachments({})).toEqual({ status: 'none', section: '' });
    });
});

describe('the fix agent does not read the thumbnail again', () => {
    it('keeps the filing-time reading and only has a second reader check it (a failed check leaves the reading standing)', async () => {
        let calls = 0;
        const body = `## Autonomous feedback issue\n### What the AI saw in the screenshot\n\n<!-- ${READING_MARKER} -->\nPROBLEM: overlap\n\n<!-- ${IMAGE_MARKER} -->\n<details>\n\n\`\`\`\n${'data:image/jpeg;base64,' + 'A'.repeat(60)}\n\`\`\`\n\n</details>`;
        const r = await screenshotContext({ issue: { title: 't', body }, env: { GEMINI_API_KEY: 'k' }, fetchImpl: async () => { calls++; return { ok: true, json: async () => ({}) }; } });
        expect(calls).toBeGreaterThan(0);        // the second reader was asked
        expect(r.status).toBe('read');
        expect(r.body).toContain('PROBLEM: overlap');
        expect(r.body).not.toContain('AAAAAAAAAA');
    });
    it('still reads the thumbnail itself when the filing-time reading failed', async () => {
        const body = `### User feedback\n> x\n<!-- ${IMAGE_MARKER} -->\n<details>\n\n\`\`\`\n${'data:image/jpeg;base64,' + 'A'.repeat(60)}\n\`\`\`\n\n</details>`;
        const r = await screenshotContext({ issue: { title: 't', body }, env: {}, fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
        expect(r.status).toBe('unreadable');
    });
});

describe('wiring', () => {
    it('the server reads the parts and puts the words in the issue head', () => {
        const src = fs.readFileSync('feedback-triage.js', 'utf8');
        expect(src).toMatch(/body\.imageReading/);
        expect(src).toMatch(/readAttachments\(\{ images: body\.imageReading/);
        expect(src).toMatch(/readingSection,\s*\n\s*diagnosticsSection\(diagnostics\)/);
        expect(src).toMatch(/out\.imageRead/);
    });
    it('the page loads the module and the picker uses it; the reading parts are never stored', () => {
        const html = fs.readFileSync('index.html', 'utf8');
        expect(html.split('src="wealthflow-image-prep.js"').length - 1).toBe(1);
        const us = fs.readFileSync('wealthflow-update-system.js', 'utf8');
        expect(us).toMatch(/window\.WFImagePrep\.prepare\(f\)/);
        expect(us).toMatch(/imageReading: readingImgs/);
        // the Firestore/local copy is `payload`; the reading parts must not be a field of it
        const payload = us.slice(us.indexOf('const payload = {'), us.indexOf('const payload = {') + 900);
        expect(payload).not.toMatch(/imageReading/);
    });
});
