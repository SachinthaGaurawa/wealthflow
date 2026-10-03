/* =============================================================================
 * test/scan_progress_flow_test.js — what the upload overlay SAYS while the real handler runs (wealthflow-ai-v4.js)
 * -----------------------------------------------------------------------------
 * scan_progress_test.js holds the numbers to their rules. This file runs the REAL upload handler (extracted from source, not reimplemented) against a fake page and records every
 * frame the overlay is given, to hold the wiring to the rules that matter on screen:
 *
 *   - the text-PDF path reports pages read of N, then names the bank and asks the registry under labels that say so (it used to sit at a typed-in 20% under "Reading statement text…"
 *     through all of it);
 *   - the scanned-page / photo path reports pages drawn, then pages the AI has answered;
 *   - a password box, a cancelled box, a duplicate, an error and a second upload all leave the overlay closed, and none of them closes or moves another upload's overlay;
 *   - an upload that shows no overlay (the AI chat attachment) draws nothing.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createTracker, NOOP, CAP } from '../wealthflow-scan-progress.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const V4 = fs.readFileSync(path.join(ROOT, 'wealthflow-ai-v4.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');

/** Brace-counted end of the function that starts at `at`. */
function endOf(src, at) {
    let depth = 0;
    for (let i = src.indexOf('{', at); i < src.length; i += 1) {
        if (src[i] === '{') depth += 1;
        else if (src[i] === '}' && (depth -= 1) === 0) return i + 1;
    }
    return -1;
}
const startOf = (src, header) => { const at = src.indexOf(header); expect(at, `${header} is gone`).toBeGreaterThan(-1); return at; };
const fnSource = (src, header) => { const at = startOf(src, header); return src.slice(at, endOf(src, at)); };

/* From the first helper of the registry/bank section to the end of the handler: the helpers, the plan, the run and both halves of the handler, as one contiguous piece of the file. */
const HANDLER = (() => {
    const from = startOf(V4, 'function _wfStatementGuard(');
    const at = startOf(V4, 'async function _handleAIScanV4(');
    return V4.slice(from, endOf(V4, at));
})();
/* The real pure helpers. extractJSON is not among them: its regular expressions hold a bare `}` that a brace counter would trip on, and it only parses a JSON string. */
const PURE = ['classifyCCOTRow', 'normaliseCCOTDate', 'normaliseAmount'].map((n) => fnSource(V4, `function ${n}(`)).join('\n');

const WHEN = { today: () => '2026-10-03', ymd: () => '2026-10-03', zone: () => 'Asia/Colombo' };
const file = (over) => ({ name: 'statement.pdf', type: 'application/pdf', size: 2_400_000, ...over });

function rig(over = {}) {
    const frames = [];
    const log = [];
    const env = {
        show: (stage, detail, pct, icon) => frames.push({ stage, detail, pct, icon }),
        hide: () => frames.push({ hidden: true }),
    };
    const tracker = createTracker(env);
    const notices = [];
    const reviews = [];
    const win = {
        _showScanOverlay: env.show, _hideScanOverlay: env.hide,
        WFScanProgress: { begin: tracker.begin, NOOP },
        WFWhen: WHEN,
        notify: (m, k) => notices.push([m, k]),
        triggerHaptic: () => {},
        _showCCReviewModal: (parsed, bank) => { log.push('review'); reviews.push({ parsed, bank }); },
        WFStatementParser: {
            hasTextLayer: () => true,
            parseStatement: () => ({ rows: [{ date: '01/09/2026', narration: 'KEELLS', amount: 1500, direction: 'debit', valid: true }, { date: '02/09/2026', narration: 'DIALOG', amount: 990, direction: 'debit', valid: true }], reconciliation: { ok: true } }),
        },
        WFPdfUnlock: {
            getStatementText: async (f, ask, opts) => {
                for (let d = 0; d <= 3; d += 1) opts.onProgress({ phase: 'pages', done: d, total: 3 });
                return { cancelled: false, text: 'Statement Period: 01/09/2026 - 30/09/2026\nCard 123456xxxxxx4421\nKEELLS\nDIALOG', meta: null };
            },
        },
        WFBankDetect: { detect: () => ({ ok: true, name: 'Test Bank', lockName: 'Test Bank', issuer: 'Test Bank' }), tailsOf: () => [] },
        WFStatementCloud: { guard: {
            file: async () => ({ sha: 'a'.repeat(64), duplicate: false }),
            parsed: async (args) => ({ info: { ...args } }),
            accountTailOf: () => '',
            identify: async () => null,
        } },
        localStorage: { getItem: () => null, setItem() {} },
        ...over.win,
    };
    const sandbox = {
        window: win, console: { log() {}, warn() {}, error() {}, group() {}, groupEnd() {}, table() {} },
        navigator: { language: 'en-LK' },
        V: 'test', Array, String, Object, Number, Math, Date, JSON, Promise, Set, Error, parseInt, parseFloat, isFinite, isNaN, setTimeout, clearTimeout,
        buildCCStatementPrompt: () => 'prompt',
        extractJSON: (text) => { try { return JSON.parse(text); } catch (_) { return null; } },
        isEndpointAvailable: async () => true,
        legacyAICall: async () => { throw new Error('no AI in this test'); },
        visionScanCall: async () => { throw new Error('no vision in this test'); },
        fileToImagesV4: async () => { throw new Error('no pictures in this test'); },
        handleAIChatAttachment: async () => {},
        findMatchingPriorExpense: () => null,
        populateExpenseForm: () => true,
        populateCCOTForm: () => true,
        populateSubscriptionForm: () => true,
        buildReceiptPrompt: () => 'prompt',
        _enhanceImageForOCR: async (x) => x,
        cloudVisionOCR: async () => null,
        ...over.sandbox,
    };
    vm.createContext(sandbox);
    vm.runInContext(`${PURE}\n${HANDLER}\nthis.__handle = handleAIScanV4;`, sandbox);
    const upload = (f, type = 'ccot') => sandbox.__handle({ target: { files: [f], value: 'x' } }, type);
    const shown = () => frames.filter((x) => !x.hidden);
    return { frames, shown, notices, reviews, log, upload, win, sandbox, tracker };
}

const monotonic = (frames) => {
    const pcts = frames.filter((f) => !f.hidden).map((f) => f.pct);
    return pcts.every((p, i) => p >= 0 && p <= CAP && (i === 0 || p >= pcts[i - 1]));
};
const labels = (frames) => frames.filter((f) => !f.hidden).map((f) => f.stage);

describe('the text-PDF path says what it is doing, and counts the pages it reads', () => {
    it('walks the stages in order, every page counted, then names the bank and asks the registry, then closes before the review opens', async () => {
        const r = rig();
        r.win._showCCReviewModal = (p, b) => { r.log.push(r.frames.at(-1).hidden ? 'review-after-close' : 'review-while-open'); r.reviews.push({ p, b }); };
        await r.upload(file());
        const seq = labels(r.frames);
        const order = ['Checking the file…', 'Opening PDF…', 'Reading statement text…', 'Finding the transactions…', 'Identifying the bank…', 'Checking your books…'];
        let at = -1;
        for (const l of order) { const i = seq.indexOf(l, at + 1); expect(i, `"${l}" is missing or out of order in ${JSON.stringify(seq)}`).toBeGreaterThan(at); at = i; }
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.log).toEqual(['review-after-close']);
        expect(r.reviews[0].b).toBe('Test Bank');
        expect(monotonic(r.frames)).toBe(true);
    });

    it('the pages move the bar: page 1 of 3, 2 of 3, 3 of 3 are three different, rising positions', async () => {
        const r = rig();
        await r.upload(file());
        const pages = r.shown().filter((f) => f.stage === 'Reading statement text…');
        const at = (re) => pages.find((f) => re.test(f.detail));
        const p0 = at(/Reading page 1 of 3/), p1 = at(/Reading page 2 of 3/), p2 = at(/Reading page 3 of 3/), p3 = at(/All 3 pages read/);
        expect(p0 && p1 && p2 && p3, JSON.stringify(pages)).toBeTruthy();
        expect(p1.pct).toBeGreaterThan(p0.pct);
        expect(p2.pct).toBeGreaterThan(p1.pct);
        expect(p3.pct).toBeGreaterThan(p2.pct);
        expect(p1.detail).toMatch(/ · \d+%$/);                           // the number is shown because pages were counted
    });

    it('the stages with no unit hold the bar and show no percentage', async () => {
        const r = rig();
        await r.upload(file());
        for (const l of ['Checking the file…', 'Identifying the bank…', 'Checking your books…']) {
            const f = r.shown().find((x) => x.stage === l);
            expect(f.detail, l).not.toMatch(/%/);
        }
        const bank = r.shown().find((x) => x.stage === 'Identifying the bank…');
        const read = r.shown().filter((x) => x.stage === 'Reading statement text…').at(-1);
        const parse = r.shown().find((x) => x.stage === 'Finding the transactions…');
        expect(bank.pct).toBeGreaterThan(parse.pct);
        expect(parse.pct).toBeGreaterThanOrEqual(read.pct);
    });

    it('never shows 100 before the end, and the opening frame is the file, not a made-up number', async () => {
        const r = rig();
        await r.upload(file());
        expect(Math.max(...r.shown().map((f) => f.pct))).toBeLessThan(100);
        expect(r.shown()[0]).toMatchObject({ stage: 'Opening file…', pct: 0, detail: '2.29 MB' });
    });

    it('a password box says so, holds the bar, and a cancel closes the overlay', async () => {
        const r = rig({ win: { WFPdfUnlock: { getStatementText: async (f, ask, opts) => { opts.onProgress({ phase: 'saved', done: 0, total: 2 }); opts.onProgress({ phase: 'password' }); return { cancelled: true, text: '' }; } } } });
        await r.upload(file());
        expect(labels(r.frames)).toEqual(expect.arrayContaining(['Trying your saved passwords…', 'Waiting for the PDF password…']));
        expect(r.shown().find((f) => f.stage === 'Trying your saved passwords…').detail).toBe('Password 1 of 2');
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.reviews).toHaveLength(0);
        expect(r.frames.filter((f) => f.hidden)).toHaveLength(1);
    });

    it('a statement already in the books closes the overlay, says so, and opens no review', async () => {
        const r = rig();
        r.win.WFStatementCloud.guard.parsed = async () => ({ duplicate: true, notice: 'Already Added' });
        await r.upload(file());
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.reviews).toHaveLength(0);
        expect(r.notices[0][0]).toContain('already in your books');
    });

    it('the file-level duplicate check shows the overlay while it runs, and closes it on a duplicate', async () => {
        const r = rig();
        r.win.WFStatementCloud.guard.file = async () => ({ sha: 'b'.repeat(64), duplicate: true, notice: 'Already Added' });
        await r.upload(file());
        expect(labels(r.frames)).toContain('Checking the file…');
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.reviews).toHaveLength(0);
    });
});

describe('the scanned-page and photo path counts pages drawn and pages the AI has answered', () => {
    const answer = (rows) => ({ reply: JSON.stringify({ bank_name: '', transactions: rows }) });
    const pictures = (n) => async (f, opts) => {
        for (let d = 0; d <= n; d += 1) opts.onProgress({ phase: 'pages', done: d, total: n });
        return { images: Array.from({ length: n }, (_, i) => `img${i}`), isPdf: true, pageCount: n, dimensions: [] };
    };

    it('a PDF without a text layer: pages drawn of N, then page 1 and page 2 of the AI, then the books, never backwards', async () => {
        const calls = [];
        const r = rig({
            win: { WFStatementParser: { hasTextLayer: () => false, parseStatement: () => ({ rows: [] }) } },
            sandbox: {
                fileToImagesV4: pictures(2),
                legacyAICall: async (prompt, image) => { calls.push(image); return answer(image === 'img0' ? [{ date: '2026-09-01', description: 'KEELLS', amount: 1500 }] : [{ date: '2026-09-02', description: 'DIALOG', amount: 990 }]); },
            },
        });
        await r.upload(file());
        expect(calls).toEqual(['img0', 'img1']);
        const seq = labels(r.frames);
        for (const l of ['Reading PDF…', 'Connecting…', 'Identifying the bank…', 'AI parsing CC statement…', 'Page 2 of 2…', 'Found 2 transactions…']) expect(seq, l).toContain(l);
        const drawn = r.shown().filter((f) => f.stage === 'Reading PDF…' && /Preparing page|ready/.test(f.detail));
        expect(drawn.map((f) => f.detail.replace(/ · \d+%$/, ''))).toEqual(['Preparing page 1 of 2', 'Preparing page 2 of 2', 'All 2 pages ready']);
        expect(drawn[1].pct).toBeGreaterThan(drawn[0].pct);
        const ai = r.shown().filter((f) => /^(AI parsing CC statement…|Page 2 of 2…)$/.test(f.stage));
        expect(ai.at(-1).pct).toBeGreaterThan(ai[0].pct);
        expect(monotonic(r.frames)).toBe(true);
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.reviews[0].parsed.transactions).toHaveLength(2);
    });

    it('the PDF text path falling through to pictures redraws the plan from where the bar stood: it never goes back', async () => {
        const r = rig({
            win: { WFStatementParser: { hasTextLayer: () => false, parseStatement: () => ({ rows: [] }) } },
            sandbox: { fileToImagesV4: pictures(1), legacyAICall: async () => answer([{ date: '2026-09-01', description: 'KEELLS', amount: 1500 }]) },
        });
        await r.upload(file());
        const opened = r.shown().find((f) => f.stage === 'Opening PDF…').pct;
        const firstPicture = r.shown().find((f) => f.stage === 'Reading PDF…');
        expect(firstPicture.pct).toBeGreaterThanOrEqual(opened);
        expect(monotonic(r.frames)).toBe(true);
    });

    it('a photo is one unit with no inner count: it says what it is doing and claims no percentage for it', async () => {
        const r = rig({ sandbox: { fileToImagesV4: async () => ({ images: ['i'], isPdf: false, pageCount: 1, dimensions: [] }), legacyAICall: async () => answer([{ date: '2026-09-01', description: 'KEELLS', amount: 1500 }]) } });
        await r.upload(file({ name: 'IMG_1.jpg', type: 'image/jpeg', size: 900_000 }));
        const reading = r.shown().find((f) => f.stage === 'Reading Image…');
        expect(reading.detail).toBe('Optimising 0.86MB photo');
        expect(r.reviews).toHaveLength(1);
        expect(monotonic(r.frames)).toBe(true);
    });

    it('a failed read closes the overlay with the reason and opens nothing', async () => {
        const r = rig({ win: { WFStatementParser: { hasTextLayer: () => false, parseStatement: () => ({ rows: [] }) } }, sandbox: { fileToImagesV4: async () => { throw new Error('PDF has no pages'); } } });
        await r.upload(file());
        expect(r.frames.at(-1)).toEqual({ hidden: true });
        expect(r.notices.some(([m, k]) => /Scan failed: PDF could not be read|Scan failed/.test(m) && k === 'error')).toBe(true);
        expect(r.reviews).toHaveLength(0);
    });

    it('when the AI finds nothing the Cloud Vision pass gets its own share of what is left, and the bar still only rises', async () => {
        const r = rig({
            win: { WFStatementParser: { hasTextLayer: () => false, parseStatement: () => ({ rows: [] }) } },
            sandbox: {
                fileToImagesV4: pictures(2),
                legacyAICall: async (prompt, image) => (image ? answer([]) : answer([{ date: '2026-09-01', description: 'KEELLS', amount: 1500 }])),
                cloudVisionOCR: async () => ({ text: 'KEELLS 1500' }),
            },
        });
        await r.upload(file());
        const cv = r.shown().filter((f) => f.stage === 'Cloud Vision OCR…');
        expect(cv.length).toBeGreaterThan(1);
        expect(cv.at(-1).pct).toBeGreaterThan(cv[0].pct);
        expect(monotonic(r.frames)).toBe(true);
        expect(r.reviews).toHaveLength(1);
    });
});

describe('a receipt or a bill: the same overlay, the same rules', () => {
    it('reading, connecting, the AI, filling the form: each says so, and the bar rises through them', async () => {
        const r = rig({
            sandbox: {
                fileToImagesV4: async () => ({ images: ['i'], isPdf: false, pageCount: 1, dimensions: [] }),
                visionScanCall: async () => ({ result: { amount: 1500, vendor: 'KEELLS', date: '2026-09-01' }, confidence: { overall: 0.9 }, engines: [{ success: true }] }),
            },
        });
        await r.upload(file({ name: 'bill.jpg', type: 'image/jpeg', size: 400_000 }), 'expense');
        expect(labels(r.frames)).toEqual(expect.arrayContaining(['Reading Image…', 'Connecting…', 'AI Vision…', 'Filling form…']));
        expect(monotonic(r.frames)).toBe(true);
        expect(r.frames.at(-1)).toEqual({ hidden: true });
    });

    it('an AI chat attachment shows no overlay at all', async () => {
        const r = rig({ sandbox: { fileToImagesV4: async () => ({ images: ['i'], isPdf: false, pageCount: 1, dimensions: [] }) } });
        await r.upload(file({ name: 'x.jpg', type: 'image/jpeg' }), 'ai_chat');
        expect(r.frames).toEqual([]);
    });
});

describe('one upload at a time', () => {
    it('the first upload finishing late does not close or move the second one\'s overlay', async () => {
        let releaseFirst;
        const gate = new Promise((res) => { releaseFirst = res; });
        let n = 0;
        const r = rig();
        r.win.WFPdfUnlock.getStatementText = async (f, ask, opts) => {
            n += 1;
            if (n === 1) { opts.onProgress({ phase: 'password' }); await gate; return { cancelled: true, text: '' }; }
            return { cancelled: false, text: 'x', meta: null };
        };
        const first = r.upload(file({ name: 'first.pdf' }));
        await new Promise((res) => setTimeout(res, 0));
        const second = r.upload(file({ name: 'second.pdf' }));
        await second;
        expect(r.reviews).toHaveLength(1);
        const hiddenBefore = r.frames.filter((f) => f.hidden).length;
        expect(hiddenBefore).toBe(1);                                    // the second upload closed it, once
        const framesBefore = r.frames.length;
        releaseFirst();
        await first;
        expect(r.frames.length).toBe(framesBefore);                      // the first upload's late exit changed nothing
    });

    it('the second upload starts the bar from zero', async () => {
        const r = rig();
        await r.upload(file());
        const before = r.frames.length;
        await r.upload(file());
        expect(r.frames[before]).toMatchObject({ stage: 'Opening file…', pct: 0 });
    });
});

describe('the handler closes the overlay on every way out', () => {
    it('even when the work throws something nobody caught: the wrapper\'s finally ends the run', async () => {
        const frames = [];
        const env = { show: (s, d, p, i) => frames.push({ s, d, p, i }), hide: () => frames.push({ hidden: true }) };
        const tracker = createTracker(env);
        const sandbox = { window: { WFScanProgress: { begin: tracker.begin, NOOP } }, _handleAIScanV4: async () => { throw new Error('boom'); } };
        vm.createContext(sandbox);
        vm.runInContext(`${fnSource(V4, 'function _wfPlainRun(')}\n${fnSource(V4, 'function _wfScanRun(')}\nvar _wfNoRun = {};\n${fnSource(V4, 'async function handleAIScanV4(')}\nthis.__h = handleAIScanV4;`, sandbox);
        await expect(sandbox.__h({ target: { files: [{ name: 'a.pdf', size: 10 }] } }, 'ccot')).rejects.toThrow('boom');
        expect(frames.at(-1)).toEqual({ hidden: true });
    });

    it('with no progress module loaded the overlay still opens and closes, and no number is made up', async () => {
        const frames = [];
        const sandbox = {
            window: { _showScanOverlay: (s, d, p, i) => frames.push({ s, d, p, i }), _hideScanOverlay: () => frames.push({ hidden: true }) },
            _handleAIScanV4: async (e, t, P) => { P.plan([]).stage('read', 'Reading', 'x', 'fileText').step(1, 2); },
        };
        vm.createContext(sandbox);
        vm.runInContext(`${fnSource(V4, 'function _wfPlainRun(')}\n${fnSource(V4, 'function _wfScanRun(')}\nvar _wfNoRun = {};\n${fnSource(V4, 'async function handleAIScanV4(')}\nthis.__h = handleAIScanV4;`, sandbox);
        await sandbox.__h({ target: { files: [{ name: 'a.pdf', size: 10 }] } }, 'ccot');
        expect(frames.filter((f) => !f.hidden).every((f) => f.p === 0)).toBe(true);
        expect(frames.at(-1)).toEqual({ hidden: true });
    });
});

describe('the wiring, read from the source', () => {
    const body = HANDLER.slice(HANDLER.indexOf('async function _handleAIScanV4('));

    it('the handler draws nothing by itself any more: every overlay call goes through the run', () => {
        expect(body).not.toMatch(/_showScanOverlay\(/);
        expect(body).not.toMatch(/_hideScanOverlay\(/);
        expect(body.match(/\bP\.(stage|say)\(/g).length).toBeGreaterThanOrEqual(25);
    });

    it('no stage is given a hand-typed percentage', () => {
        for (const m of body.matchAll(/\bP\.(stage|say)\(([\s\S]*?)\);/g)) {
            expect(m[2], `a number passed as a position: ${m[0].slice(0, 90)}`).not.toMatch(/,\s*\d+\s*,\s*'[a-zA-Z]+'\s*$/);
        }
    });

    it('every stage and every retry names a real icon', () => {
        const bad = [];
        for (const m of body.matchAll(/\bP\.(stage|say)\(([\s\S]*?)\);/g)) {
            const names = [...m[2].matchAll(/'([a-zA-Z][a-zA-Z0-9]*)'\s*$/g)].map((x) => x[1]);
            const icon = names.at(-1);
            if (!icon || !ICONS.includes(`${icon}:`)) bad.push(m[0].replace(/\s+/g, ' ').slice(0, 90));
        }
        expect(bad).toEqual([]);
    });

    it('the unlocker, the e-statement reader and the picture renderer are asked to report their progress', () => {
        expect(body).toMatch(/WFPdfUnlock\.getStatementText\(file, undefined, \{\s*[\s\S]*?onProgress:/);
        expect(body).toMatch(/WFHtmlStatement\.getStatementText\(file, \{\s*onWait:/);
        expect(body).toMatch(/fileToImagesV4\(file, \{[\s\S]*?onProgress:/);
        expect(fnSource(V4, 'async function fileToImagesV4(')).toMatch(/tell\(0, pages\)[\s\S]*tell\(i, pages\)/);
    });

    it('the overlay is emptied when it closes, so the next upload opens at zero', () => {
        expect(fnSource(V4, 'function _hideScanOverlayV5(')).toMatch(/wf5ScanBar[\s\S]*width = '0%'/);
    });

    it('index.html loads the module as a module, and the Drive download and the Save step use it', () => {
        expect(HTML).toMatch(/<script type="module" src="wealthflow-scan-progress\.js"><\/script>/);
        expect(HTML).toMatch(/readBlob\(resp, sizeHint/);
        expect(HTML.match(/run\.handoff\(\)/g)).toHaveLength(2);
        expect(HTML).toMatch(/_spStage\('notes', 'Writing notes…', 'Letting AI label each transaction', 'edit'\)/);
        expect(HTML, 'the Save step still draws the notes stage at a typed-in 90%').not.toMatch(/_showScanOverlay\('Writing notes…'[^)]*90/);
    });
});
