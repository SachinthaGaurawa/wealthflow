/* test/feedback_attachments_test.js
 *
 * Owner, 2026-11-13: "Send feedback" took ONE picture or document. It now takes up to five, picture or document, and every one
 * of them has to be read when the report is filed. These tests hold: the picker (limits, kinds, budgets that keep the request under
 * the serverless body limit), the server (normalizing, reading each on its own deadline, privacy of documents, the marker the agent
 * uses), and the handler end to end. Every picture here is a few characters of fake base64; no real statement, name or number.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fc from 'fast-check';
import fs from 'node:fs';
import { runs } from './fuzz-config.js';
import { loadBrowserModule } from './helpers/load-browser-module.js';
import {
    normalizeAttachments, readAllAttachments, extraImagesSection, MAX_ATTACHMENTS, MAX_READING_TOTAL, READING_MARKER, COUNT_MARKER, EXTRA_MARKER,
} from '../wf-feedback-attachments.mjs';
import { READING_MARKER as READER_MARKER, MAX_READING_IMAGES, MAX_READING_CHARS, withoutScreenshot, screenshotContext } from '../wf-screenshot-reader.mjs';

const jpeg = (n, tag = 'A') => 'data:image/jpeg;base64,' + tag.repeat(n);
const att = (o) => ({ kind: 'image', thumb: jpeg(40), reading: [jpeg(100)], ...o });

// ── the picker ─────────────────────────────────────────────────────────────────────────────────────────────────────
function picker(extra = {}) {
    return loadBrowserModule('wealthflow-feedback-attach.js', { html: '<div id="wfFbAttach"></div>', ...extra });
}
const file = (name, type, size = 1000, extra = {}) => ({ name, type, size, ...extra });

describe('the picker: what it takes and what it refuses', () => {
    const { window } = picker();
    const A = window.WFFeedbackAttach;

    it('knows pictures, PDFs and text files, and says plainly that Office files cannot be opened', () => {
        expect(A.kindOf(file('a.png', 'image/png'))).toBe('image');
        expect(A.kindOf(file('IMG_1.HEIC', ''))).toBe('image');
        expect(A.kindOf(file('s.pdf', 'application/pdf'))).toBe('pdf');
        expect(A.kindOf(file('s.PDF', ''))).toBe('pdf');
        for (const n of ['a.txt', 'b.csv', 'c.json', 'd.log', 'e.md', 'f.tsv']) expect(A.kindOf(file(n, ''))).toBe('text');
        expect(A.kindOf(file('r.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'))).toBe('office');
        expect(A.kindOf(file('r.xlsx', ''))).toBe('office');
        expect(A.kindOf(file('r.exe', 'application/x-msdownload'))).toBe('');
    });

    it('takes at most five, keeps order, and names what it refused and why', () => {
        const files = ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png', '7.png'].map((n, i) => file(n, 'image/png', 100 + i));
        const p = A.plan([], files);
        expect(p.take.map((t) => t.name)).toEqual(['1.png', '2.png', '3.png', '4.png', '5.png']);
        expect(p.refuse).toHaveLength(2);
        expect(p.refuse[0].why).toMatch(/only 5/);
    });

    it('counts files already held, so five in total are never exceeded across picks', () => {
        const held = [1, 2, 3, 4].map((i) => ({ name: i + '.png', size: i, kind: 'image' }));
        const p = A.plan(held, [file('a.png', 'image/png', 9), file('b.png', 'image/png', 10)]);
        expect(p.take).toHaveLength(1);
        expect(p.refuse).toHaveLength(1);
    });

    it('ignores the same file picked twice, refuses Office and unknown files with a reason', () => {
        const held = [{ name: 'a.png', size: 5, kind: 'image' }];
        const p = A.plan(held, [file('a.png', 'image/png', 5), file('r.docx', '', 9), file('x.bin', '', 9), file('ok.csv', 'text/csv', 9)]);
        expect(p.take.map((t) => t.name)).toEqual(['ok.csv']);
        expect(p.refuse.map((r) => r.why).join('|')).toMatch(/already attached.*Word, Excel.*cannot be read/);
    });

    it('refuses a PDF over 30 MB and a text file over 8 MB', () => {
        const p = A.plan([], [file('big.pdf', 'application/pdf', 31 * 1048576), file('big.txt', 'text/plain', 9 * 1048576)]);
        expect(p.take).toHaveLength(0);
        expect(p.refuse).toHaveLength(2);
    });

    it('never takes more than five whatever it is given', () => {
        fc.assert(fc.property(fc.array(fc.record({ name: fc.string({ maxLength: 12 }), type: fc.constantFrom('image/png', 'application/pdf', 'text/plain', ''), size: fc.nat(5e7) }), { maxLength: 30 }), (fs_) => {
            expect(A.plan([], fs_).take.length).toBeLessThanOrEqual(5);
        }), { numRuns: runs(200) });
    });
});

describe('the budgets keep one request under the serverless body limit', () => {
    const { window } = picker();
    const A = window.WFFeedbackAttach;
    it('one picture keeps today\'s quality; more files get equal shares that always add up inside the totals', () => {
        const one = A.budgets(['image']);
        expect(one.maxTiles).toBe(3);
        expect(one.thumbCap).toBe(43500);
        expect(one.share).toBe(3200000);
        for (let n = 1; n <= 5; n++) {
            for (const kind of ['image', 'pdf']) {
                const b = A.budgets(Array(n).fill(kind));
                expect(n * b.share).toBeLessThanOrEqual(3200000);
                expect(n * b.thumbCap).toBeLessThanOrEqual(43500);
                // the parts of one file divide its share, so even a tall page (3 parts) or a 2-page PDF stays inside it
                expect(b.share / b.maxTiles).toBeGreaterThanOrEqual(60000);
                expect(b.share / b.pdfPages).toBeGreaterThanOrEqual(60000);
            }
        }
        // five pictures: a tall capture is still cut into parts (it was one squashed picture before)
        expect(A.budgets(Array(5).fill('image')).maxTiles).toBe(3);
        expect(A.budgets(Array(5).fill('pdf')).pdfPages).toBe(2);
        // text files take no picture room
        expect(A.budgets(['image', 'text', 'text', 'text', 'text']).share).toBe(3200000);
    });
});

describe('extra thumbnails keep the attachment number', () => {
    it('a text file in between does not shift the numbering', () => {
        const t = 'data:image/jpeg;base64,' + 'A'.repeat(40);
        const out = extraImagesSection([{ n: 3, thumb: t }, { n: 5, thumb: t }], 10_000);
        expect(out).toContain('wf-feedback-image-extra n=3');
        expect(out).toContain('Attachment 5 thumbnail');
        expect(out).not.toContain('Attachment 2');
    });
});

describe('the picker in the sheet', () => {
    it('mounts one button, lists files as chips with a remove button, and stops at five', () => {
        const { window, document } = picker();
        const notes = [];
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), { notify: (m, t) => notes.push([m, t]) });
        const input = document.getElementById('wfFbImg');
        expect(input.multiple).toBe(true);
        expect(input.accept).toContain('application/pdf');
        expect(document.getElementById('wfFbImgBtn').textContent).toMatch(/up to 5/);
        window.WFFeedbackAttach.add(['1', '2', '3', '4', '5', '6'].map((n) => file(n + '.png', 'image/png', 10 + Number(n))));
        expect(window.WFFeedbackAttach.count()).toBe(5);
        expect(document.getElementById('wfFbImgPreview').children).toHaveLength(5);
        expect(document.getElementById('wfFbImgBtn').disabled).toBe(true);
        expect(notes[0][0]).toMatch(/Not attached.*6\.png.*only 5/);
        // remove one: room again
        document.getElementById('wfFbImgPreview').children[0].querySelector('button').onclick();
        expect(window.WFFeedbackAttach.count()).toBe(4);
        expect(document.getElementById('wfFbImgBtn').disabled).toBe(false);
    });

    it('shows a file name as text, never as markup', () => {
        const { window, document } = picker();
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), {});
        window.WFFeedbackAttach.add([file('<img src=x onerror=alert(1)>.txt', 'text/plain', 10)]);
        const chip = document.getElementById('wfFbImgPreview').children[0];
        expect(chip.querySelector('img')).toBeNull();
        expect(chip.textContent).toContain('<img src=x onerror=alert(1)>.txt');
    });

    it('a new sheet starts with nothing attached', () => {
        const { window, document } = picker();
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), {});
        window.WFFeedbackAttach.add([file('a.txt', 'text/plain', 10)]);
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), {});
        expect(window.WFFeedbackAttach.count()).toBe(0);
    });

    it('collect() prepares every file for the real count: pictures, a text file, and says what it had to leave out', async () => {
        const prepared = [];
        const { window, document } = picker({
            globals: {
                WFImagePrep: { prepare: async (f, o) => { prepared.push(o); return f.name === 'bad.png' ? { ok: false, thumb: '', reading: [] } : { ok: true, thumb: jpeg(30), reading: [jpeg(80)] }; } },
            },
        });
        const notes = [];
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), { notify: (m) => notes.push(m) });
        const text = { name: 'log.txt', type: 'text/plain', size: 30, slice() { return this; }, text: async () => 'error at line 3\nstatus 429' };
        window.WFFeedbackAttach.add([
            { name: 'a.png', type: 'image/png', size: 11 }, { name: 'bad.png', type: 'image/png', size: 12 }, text,
            { name: 'c.png', type: 'image/png', size: 13 },
        ]);
        const r = await window.WFFeedbackAttach.collect();
        expect(r.count).toBe(4);
        expect(r.attachments.map((a) => a.kind)).toEqual(['image', 'text', 'image']);
        expect(r.attachments[1].text).toContain('status 429');
        expect(r.skipped.map((s) => s.name)).toEqual(['bad.png']);
        expect(notes.join(' ')).toMatch(/Sent without: bad\.png/);
        // three pictures share the request: each may use up to three parts inside an equal third of the reading room, and a third of the thumbnail room
        expect(prepared.every((o) => o.maxTiles === 3 && o.thumbCap === 14500 && o.readShare === Math.floor(3200000 / 3))).toBe(true);
        // what is stored (Firestore, the local copy) holds the kind and the thumbnail only: no reading pictures, no text
        expect(r.stored).toEqual([{ kind: 'image', n: 1, thumb: jpeg(30) }, { kind: 'text', n: 3, thumb: '' }, { kind: 'image', n: 4, thumb: jpeg(30) }]);
        expect(JSON.stringify(r.stored)).not.toContain('status 429');
        expect(r.image).toBe(jpeg(30));
    });

    it('collect() with nothing attached costs nothing, and never rejects', async () => {
        const { window, document } = picker();
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), {});
        expect(await window.WFFeedbackAttach.collect()).toMatchObject({ attachments: [], count: 0, image: null });
    });

    it('a PDF is drawn page by page with the app\'s PDF.js and a wrong password is said in words', async () => {
        const pdfDoc = { numPages: 7, getPage: async () => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ promise: Promise.resolve() }) }), destroy() {} };
        const lib = { getDocument: () => ({ promise: Promise.resolve(pdfDoc) }) };
        const { window, document } = picker({
            globals: {
                pdfjsLib: lib,
                WFImagePrep: { prepare: async () => ({ ok: true }), prepareSource: (cv, o) => ({ thumb: jpeg(10), reading: [jpeg(20)], opts: o }) },
            },
        });
        document.createElement = ((orig) => (t) => { const el = orig.call(document, t); if (t === 'canvas') el.getContext = () => ({}); return el; })(document.createElement);
        window.WFFeedbackAttach.mount(document.getElementById('wfFbAttach'), {});
        window.WFFeedbackAttach.add([{ name: 's.pdf', type: 'application/pdf', size: 99, arrayBuffer: async () => new ArrayBuffer(8) }]);
        const r = await window.WFFeedbackAttach.collect();
        expect(r.attachments).toHaveLength(1);
        expect(r.attachments[0]).toMatchObject({ kind: 'pdf', pages: 2, totalPages: 7 });
        expect(r.attachments[0].reading).toHaveLength(2);

        const locked = { getDocument: () => ({ promise: Promise.reject(Object.assign(new Error('x'), { name: 'PasswordException' })) }) };
        const w2 = picker({ globals: { pdfjsLib: locked, WFImagePrep: { prepareSource: () => ({}) } } });
        w2.window.WFFeedbackAttach.mount(w2.document.getElementById('wfFbAttach'), {});
        w2.window.WFFeedbackAttach.add([{ name: 'l.pdf', type: 'application/pdf', size: 9, arrayBuffer: async () => new ArrayBuffer(1) }]);
        const r2 = await w2.window.WFFeedbackAttach.collect();
        expect(r2.attachments).toHaveLength(0);
        expect(r2.skipped[0].why).toMatch(/password/);
    });
});

// ── the server ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('the server: normalizing what the app sent', () => {
    it('keeps the reader constants the module copies in step with the reader', () => {
        expect(READING_MARKER).toBe(READER_MARKER);
        expect(MAX_READING_IMAGES).toBe(3);
        expect(MAX_READING_CHARS).toBe(1_100_000);
    });

    it('takes at most five, drops what is not a real picture, and numbers them', () => {
        const list = Array.from({ length: 8 }, () => att({}));
        list.splice(2, 0, { kind: 'image', thumb: 'javascript:alert(1)', reading: ['data:image/svg+xml;base64,AAAA'] }, { kind: 'exe', thumb: jpeg(5) }, null, 'x');
        const out = normalizeAttachments({ attachments: list });
        expect(out).toHaveLength(MAX_ATTACHMENTS);
        expect(out.map((a) => a.n)).toEqual([1, 2, 3, 4, 5]);
        expect(out.every((a) => a.thumb.startsWith('data:image/jpeg;base64,'))).toBe(true);
    });

    it('holds the whole report to the reading budget, and a PDF to two pages', () => {
        const big = 1_000_000;
        const out = normalizeAttachments({ attachments: [
            { kind: 'image', reading: [jpeg(big), jpeg(big), jpeg(big)] },
            { kind: 'pdf', pages: 2, totalPages: 9, reading: [jpeg(big), jpeg(big), jpeg(big)] },
        ] });
        const total = out.reduce((n, a) => n + a.reading.reduce((m, r) => m + r.length, 0), 0);
        expect(total).toBeLessThanOrEqual(MAX_READING_TOTAL);
        expect(out[1] ? out[1].reading.length : 0).toBeLessThanOrEqual(2);
    });

    it('still takes what an older app sends: one picture as `image` and `imageReading`', () => {
        const out = normalizeAttachments({ image: jpeg(30), imageReading: [jpeg(90)] });
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ n: 1, kind: 'image' });
        expect(out[0].reading).toHaveLength(1);
        expect(normalizeAttachments({})).toEqual([]);
        expect(normalizeAttachments(null)).toEqual([]);
    });

    it('never throws on anything', () => {
        fc.assert(fc.property(fc.anything(), (x) => { expect(Array.isArray(normalizeAttachments(x))).toBe(true); expect(Array.isArray(normalizeAttachments({ attachments: x }))).toBe(true); }), { numRuns: runs(300) });
    });
});

describe('the server: reading each attachment', () => {
    // a vision model that says which attachment it was given
    const describeImpl = async ({ dataUrl, text }) => ({ ok: true, provider: 'groq', model: 'v', text: `shows ${dataUrl.slice(-4)} | ${text.slice(0, 60)}` });

    it('reads every picture on its own, labelled by number and kind, with the marker the agent looks for', async () => {
        const a = normalizeAttachments({ attachments: [att({ reading: [jpeg(50, 'B')] }), { kind: 'pdf', pages: 2, totalPages: 4, reading: [jpeg(50, 'C'), jpeg(50, 'D')] }, { kind: 'text', text: 'line one\nstatus 429' }] });
        const r = await readAllAttachments({ attachments: a, title: 't', text: 'the report', describeImpl });
        expect(r.status).toBe('read');
        expect(r.section).toContain(`<!-- ${READING_MARKER} -->`);
        expect(r.section).toContain(`<!-- ${COUNT_MARKER}:3 -->`);
        expect(r.section).toMatch(/Attachment 1 of 3 — screenshot/);
        expect(r.section).toMatch(/Attachment 2 of 3 — PDF document \(pages 1-2 of 4\)/);
        expect(r.section).toMatch(/Attachment 3 of 3 — text file/);
        expect(r.section).toContain('status 429');
        expect(r.section).toMatch(/Page 2:/);
    });

    it('a picture that cannot be read does not cost the others, and the issue says which', async () => {
        const flaky = async (o) => (o.dataUrl.endsWith('CCCC') ? { ok: false, tried: ['quota'] } : describeImpl(o));
        const a = normalizeAttachments({ attachments: [att({ reading: [jpeg(4, 'B')] }), att({ reading: [jpeg(4, 'C')] })] });
        const r = await readAllAttachments({ attachments: a, describeImpl: flaky });
        expect(r.status).toBe('partial');
        expect(r.section).toMatch(/Attachment 1 of 2[\s\S]*shows BBBB/);
        expect(r.section).toMatch(/Attachment 2 of 2[\s\S]*Could not be read by a vision model/);
    });

    it('a model that never answers is given up on at the deadline, and what was read is kept', async () => {
        const slow = async (o) => (o.dataUrl.endsWith('CCCC') ? new Promise(() => {}) : describeImpl(o));
        const a = normalizeAttachments({ attachments: [att({ reading: [jpeg(4, 'B')] }), att({ reading: [jpeg(4, 'C')] })] });
        const t0 = Date.now();
        const r = await readAllAttachments({ attachments: a, describeImpl: slow, deadlineMs: 60 });
        expect(Date.now() - t0).toBeLessThan(2000);
        expect(r.status).toBe('partial');
        expect(r.section).toMatch(/in time/);
    });

    it('a document is masked: figures, card numbers and merchants in a PDF reading or a text file never reach the public issue', async () => {
        const model = async () => ({ ok: true, provider: 'groq', model: 'v', text: 'A statement page. Total Rs. 48,200.00 due, card 4532123412341234, paid to KEELLS SUPER NUGEGODA.' });
        const a = normalizeAttachments({ attachments: [
            { kind: 'pdf', pages: 1, totalPages: 1, reading: [jpeg(20)] },
            { kind: 'text', text: 'Date,Narration,Amount\n2026-01-03,KEELLS SUPER NUGEGODA,4,820.50\nowner jane@example.com card 4532123412341234' },
        ] });
        const r = await readAllAttachments({ attachments: a, describeImpl: model });
        for (const bad of [/48,200/, /4532123412341234/, /KEELLS/, /4,820\.50/, /jane@example\.com/]) expect(r.section).not.toMatch(bad);
        expect(r.section).toContain('A statement page.');
    });

    it('a screenshot of the app is described as it is (a fixer needs the words on it)', async () => {
        const model = async () => ({ ok: true, provider: 'groq', model: 'v', text: 'The label "Monthly CC Payments" overlaps the figure Rs. 12,400 on the CC Instalments card.' });
        const r = await readAllAttachments({ attachments: normalizeAttachments({ attachments: [att({})] }), describeImpl: model });
        expect(r.section).toContain('Monthly CC Payments');
    });

    it('never writes a file name, and a ``` in a text file cannot break out of its fence', async () => {
        const a = normalizeAttachments({ attachments: [{ kind: 'text', name: 'HNB_4532_secret.csv', text: 'a ``` b\n## injected heading' }] });
        const r = await readAllAttachments({ attachments: a, describeImpl });
        expect(r.section).not.toMatch(/HNB_4532|secret\.csv/);
        const fences = r.section.match(/```/g) || [];
        expect(fences.length).toBe(2);
    });

    it('a text file alone needs no vision model at all', async () => {
        const a = normalizeAttachments({ attachments: [{ kind: 'text', text: 'hello world error' }] });
        const r = await readAllAttachments({ attachments: a, describeImpl: async () => { throw new Error('should not be called'); } });
        expect(r.status).toBe('read');
        expect(r.section).toContain('hello world error');
    });

    it('stays under 14,000 characters whatever is read', async () => {
        const long = async () => ({ ok: true, provider: 'g', model: 'm', text: 'x'.repeat(6000) });
        const a = normalizeAttachments({ attachments: [att({}), att({}), att({}), att({}), { kind: 'text', text: 'y'.repeat(12000) }] });
        const r = await readAllAttachments({ attachments: a, describeImpl: long });
        expect(r.section.length).toBeLessThanOrEqual(14000);
    });

    it('nothing attached, nothing written', async () => {
        expect(await readAllAttachments({ attachments: [] })).toMatchObject({ status: 'none', section: '' });
        expect(await readAllAttachments({})).toMatchObject({ status: 'none' });
    });
});

describe('the thumbnails after the first', () => {
    it('are written under their own marker, only as many as fit, and the agent strips them with the first', () => {
        const thumbs = [jpeg(100, 'B'), jpeg(100, 'C'), jpeg(5000, 'D')];
        const s = extraImagesSection(thumbs, 1000);
        expect(s).toContain(`<!-- ${EXTRA_MARKER} n=2 -->`);
        expect(s).toContain(`<!-- ${EXTRA_MARKER} n=3 -->`);
        expect(s).not.toContain('DDDD');            // did not fit
        expect(extraImagesSection(thumbs, 10)).toBe('');
        expect(extraImagesSection(['javascript:alert(1)'], 99999)).toBe('');
        const issue = '### Screenshot\n\n<!-- wf-feedback-image -->\n<details><summary>x</summary>\n\n```\n' + jpeg(60) + '\n```\n\n</details>\n\n' + s;
        const stripped = withoutScreenshot(issue);
        expect(stripped).not.toMatch(/base64/);
        expect(stripped).toContain('Screenshot data removed');
    });
});

describe('the agent: several attachments are not "corrected" against one thumbnail', () => {
    it('keeps the filing reading and says it was not cross-checked', async () => {
        const body = [
            '## Autonomous feedback issue', '',
            '### What the AI saw in the screenshot', '', `<!-- ${READING_MARKER} -->`, `<!-- ${COUNT_MARKER}:2 -->`, '**Attachment 1 of 2 — screenshot**', 'the label overlaps', '',
            '### Screenshot', '', '<!-- wf-feedback-image -->', '<details><summary>x</summary>', '', '```', jpeg(60), '```', '', '</details>', '',
            '_Filed automatically by the feedback triage agent._',
        ].join('\n');
        const fetchImpl = async () => { throw new Error('the agent must not call a vision model here'); };
        const r = await screenshotContext({ issue: { title: 't', body }, fetchImpl, env: {} });
        expect(r.status).toBe('read');
        expect(r.note).toMatch(/several, so the reading was not cross-checked/);
        expect(r.body).not.toMatch(/base64/);
    });
});

// ── the handler, end to end ─────────────────────────────────────────────────────────────────────────────────────
describe('the handler files one issue with every attachment in it', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

    async function file_(body) {
        vi.stubEnv('GITHUB_REPO', 'owner/repo'); vi.stubEnv('GH_PAT', 'tok'); vi.stubEnv('EDENAI_API_KEY', '');
        const posted = [];
        vi.stubGlobal('fetch', async (url, init = {}) => {
            const u = String(url);
            if (u.includes('/issues') && init.method === 'POST') { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ number: 77 }), { status: 201 }); }
            return new Response(JSON.stringify({ items: [] }), { status: 200 });
        });
        const { default: handler } = await import('../feedback-triage.js');
        const out = {};
        const res = { setHeader() {}, status(c) { out.status = c; return this; }, json(o) { out.json = o; return this; } };
        await handler({ method: 'POST', body, headers: {} }, res);
        return { posted, out };
    }

    it('thumbnails, a text file and the count marker are all in the body, which stays under the GitHub limit', async () => {
        const { posted, out } = await file_({
            type: 'bug', text: 'The CC Instalments card overlaps on my phone, see the pictures and the log',
            attachments: [
                att({ thumb: jpeg(9000, 'B'), reading: [] }), att({ thumb: jpeg(9000, 'C'), reading: [] }), att({ thumb: jpeg(9000, 'D'), reading: [] }),
                { kind: 'text', text: 'TypeError: x is null\nstatus 500' },
            ],
        });
        expect(out.json.issue).toBe(77);
        expect(out.json.attachments).toBe(4);
        expect(posted).toHaveLength(1);
        const issue = posted[0].body;
        expect(issue.length).toBeLessThan(65536);
        expect(issue).toContain('wf-feedback-image -->');
        expect(issue).toContain(`${EXTRA_MARKER} n=2`);
        expect(issue).toContain(`${EXTRA_MARKER} n=3`);
        expect(issue).toContain('TypeError: x is null');
        expect(issue).toContain(`${COUNT_MARKER}:4`);
    });

    it('an older app with one picture still files exactly as before', async () => {
        const { posted, out } = await file_({ type: 'bug', text: 'overlap on the stat card', image: jpeg(500) });
        expect(out.json.attachments).toBe(1);
        expect(posted[0].body).toContain('wf-feedback-image -->');
        expect(posted[0].body).not.toContain(EXTRA_MARKER);
    });

    it('no attachment, no section', async () => {
        const { posted } = await file_({ type: 'idea', text: 'please add a dark mode toggle on the dashboard' });
        expect(posted[0].body).not.toContain('wf-feedback-image');
        expect(posted[0].body).not.toContain(COUNT_MARKER);
    });
});

describe('the sheet and the page', () => {
    it('the sheet mounts the picker, sends every file to triage and keeps only thumbnails in what it stores', () => {
        const us = fs.readFileSync('wealthflow-update-system.js', 'utf8');
        expect(us).toContain('<div id="wfFbAttach"></div>');
        expect(us).toMatch(/WFFeedbackAttach\.mount\(/);
        expect(us).toMatch(/attachments: att\.attachments/);
        expect(us).not.toMatch(/accept="image\/\*"/);
    });
    it('index.html loads the picker as a deferred script', () => {
        expect(fs.readFileSync('index.html', 'utf8')).toContain('<script src="wealthflow-feedback-attach.js" defer></script>');
    });
});
