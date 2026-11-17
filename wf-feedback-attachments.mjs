/* =============================================================================
 * wf-feedback-attachments.mjs — up to five attachments on one feedback report, read when the report is filed
 * -----------------------------------------------------------------------------
 * The app sends `attachments` (see wealthflow-feedback-attach.js): pictures, the first pages of a PDF drawn as pictures, and the
 * first characters of text files. This module
 *   1. normalizes them (at most five, only real raster data URLs, bounded sizes, and an old client's single `image` /
 *      `imageReading` still works);
 *   2. has a vision model read every picture on its own deadline, so one slow provider cannot cost the others;
 *   3. writes ONE section for the issue: what each attachment shows, labelled by number and kind.
 *
 * PRIVACY. The issue is PUBLIC. A screenshot of the app is described as it is (that is what the fix agent needs). A DOCUMENT may be
 * a statement or a log: what is read from a PDF page and what is kept of a text file goes through the one diagnosis rule
 * (wealthflow-diag-scrub.js: amounts, long numbers, e-mails, quoted record text and capitalised merchant names are masked),
 * and the file's NAME is never written (a name can be an account number). Pictures embedded as thumbnails are the person's own
 * choice, as before.
 *
 * Pure apart from the reader it is given; the reader is injectable so the tests run without a model.
 * ===========================================================================*/

import { scrubText } from './wealthflow-diag-scrub.js';

// The reader pulls in the model router; it is loaded only when a picture is actually read, so a report without pictures (and the
// normalizing below) costs the serverless function nothing. The two constants below are the reader's, and a test holds them equal.
export const READING_MARKER = 'wf-screenshot-reading';
const READING_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_READING_IMAGES = 3;
const MAX_READING_CHARS = 1_100_000;
function validReadingImages(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' && x.length <= MAX_READING_CHARS && READING_URL.test(x)).slice(0, MAX_READING_IMAGES);
}

export const MAX_ATTACHMENTS = 5;
/** Characters of reading pictures the whole report may carry (the request body limit is ~4.5 MB; the client budgets 3.2 M). */
export const MAX_READING_TOTAL = 3_400_000;
export const MAX_TEXT_CHARS = 12_000;
/** One thumbnail. The client budgets 43,500 for all of them together. */
export const MAX_THUMB_CHARS = 60_000;
/** Marker for the thumbnails after the first, and for the number of attachments (the agent skips its single-picture cross-check when it is above one). */
export const EXTRA_MARKER = 'wf-feedback-image-extra';
export const COUNT_MARKER = 'wf-attachments';

const THUMB_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const KINDS = new Set(['image', 'pdf', 'text']);

/**
 * @param {object} body  the request body of /api/feedback-triage
 * @returns {{ n:number, kind:'image'|'pdf'|'text', thumb:string, reading:string[], text:string, pages:number, totalPages:number, truncated:boolean }[]}
 */
export function normalizeAttachments(body) {
    const b = body && typeof body === 'object' ? body : {};
    let raw = Array.isArray(b.attachments) ? b.attachments : null;
    if (!raw || !raw.length) {
        // an older client: one picture as `image` and its reading parts as `imageReading`
        const reading = validReadingImages(b.imageReading);
        const thumb = typeof b.image === 'string' ? b.image : '';
        raw = (reading.length || thumb) ? [{ kind: 'image', thumb, reading: b.imageReading }] : [];
    }
    const out = [];
    let budget = MAX_READING_TOTAL;
    // look at a few more than five so one unusable entry does not cost a good one; stop at five accepted
    for (const a of raw.slice(0, MAX_ATTACHMENTS * 3)) {
        if (out.length >= MAX_ATTACHMENTS) break;
        if (!a || typeof a !== 'object' || !KINDS.has(a.kind)) continue;
        const thumb = typeof a.thumb === 'string' && a.thumb.length <= MAX_THUMB_CHARS && THUMB_URL.test(a.thumb) ? a.thumb : '';
        let reading = [];
        if (a.kind !== 'text') {
            for (const r of validReadingImages(a.reading)) {
                if (r.length > budget) break;
                budget -= r.length; reading.push(r);
            }
            if (a.kind === 'pdf') reading = reading.slice(0, 2);
        }
        const text = a.kind === 'text' && typeof a.text === 'string' ? a.text.slice(0, MAX_TEXT_CHARS) : '';
        if (!thumb && !reading.length && !text.trim()) continue;
        out.push({
            n: out.length + 1, kind: a.kind, thumb, reading, text,
            pages: a.kind === 'pdf' ? Math.max(1, Math.min(2, Number(a.pages) || reading.length || 1)) : 0,
            totalPages: a.kind === 'pdf' ? Math.max(1, Math.min(9999, Number(a.totalPages) || 1)) : 0,
            truncated: !!a.truncated,
        });
    }
    return out;
}

const KIND_WORD = { image: 'screenshot', pdf: 'PDF document', text: 'text file' };

/** `what each attachment shows` in words, with a deadline per attachment. Never throws. */
async function readOne(att, total, { title, text, env, fetchImpl, describeImpl, deadlineMs, log }) {
    if (!att.reading.length) return { att, status: 'none' };
    const { readParts } = await import('./wf-screenshot-reader.mjs');
    const lead = `[This is attachment ${att.n} of ${total} on one report, ${att.kind === 'pdf' ? `a PDF document (${att.pages === 1 ? 'page 1' : 'its first ' + att.pages + ' pages'} of ${att.totalPages}); each picture is one page` : 'a screenshot'}. The other attachments are separate files.] `;
    let timer;
    try {
        const r = await Promise.race([
            readParts({
                images: att.reading, title, text: lead + String(text || '').slice(0, 600), env, fetchImpl, describeImpl, log,
                partNote: att.kind === 'pdf'
                    ? (i, n) => `[Page ${i + 1} of ${n} that was read. Describe the layout and what kind of document it is; do NOT copy account or card numbers, names or amounts.] `
                    : (i, n) => (n > 1 ? `[This is part ${i + 1} of ${n} of ONE tall or wide screenshot, cut top to bottom (or left to right) with a small overlap.] ` : ''),
            }),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ status: 'timeout', read: [], list: att.reading, who: '', tried: [] }), deadlineMs); if (timer.unref) timer.unref(); }),
        ]);
        return { att, ...r };
    } catch (_) { return { att, status: 'unreadable', read: [], list: att.reading, who: '', tried: [] }; } finally { clearTimeout(timer); }
}

const fenceSafe = (t) => String(t).replace(/```/g, "'''");

/**
 * Read every attachment and write the issue section.
 * @returns {Promise<{ status:'none'|'read'|'partial'|'unreadable', section:string, count:number, read:number, provider?:string }>}
 */
export async function readAllAttachments({ attachments, title = '', text = '', env = process.env, fetchImpl = globalThis.fetch, describeImpl, deadlineMs = 32_000, log = () => {} } = {}) {
    const list = Array.isArray(attachments) ? attachments : [];
    if (!list.length) return { status: 'none', section: '', count: 0, read: 0 };
    const total = list.length;
    const results = await Promise.all(list.map((att) => readOne(att, total, { title, text, env, fetchImpl, describeImpl, deadlineMs, log })));

    const pictures = results.filter((r) => r.att.reading.length);
    const textFiles = results.filter((r) => r.att.kind === 'text' && r.att.text.trim());
    const readOk = pictures.filter((r) => r.status === 'read');
    if (!readOk.length && !textFiles.length) return { status: pictures.length ? 'unreadable' : 'none', section: '', count: total, read: 0 };

    const who = [...new Set(readOk.map((r) => r.who).filter(Boolean))].join(', ');
    const perPicture = Math.max(1400, Math.floor(8400 / Math.max(1, pictures.length)));
    const blocks = [];
    for (const r of results) {
        const a = r.att, head = `**Attachment ${a.n} of ${total} — ${KIND_WORD[a.kind]}${a.kind === 'pdf' ? ` (${a.pages === 1 ? 'page 1' : 'pages 1-' + a.pages} of ${a.totalPages})` : ''}**`;
        if (a.kind === 'text') {
            if (!a.text.trim()) continue;
            const body = scrubText(a.text, MAX_TEXT_CHARS).slice(0, 2500);
            blocks.push([head, `_The start of the file${a.truncated ? ' (it is longer)' : ''}, with amounts, long numbers, e-mail addresses and quoted record text masked:_`, '', '```', fenceSafe(body), '```'].join('\n'));
            continue;
        }
        if (r.status !== 'read') { blocks.push(`${head}\n_Could not be read by a vision model${r.status === 'timeout' ? ' in time' : ''}. Work from the written report._`); continue; }
        const parts = r.read.map(({ p, i }) => (r.list.length > 1 ? `_${a.kind === 'pdf' ? 'Page' : 'Part'} ${i + 1}:_ ` : '') + p.text).join('\n\n');
        // a document may carry money and identity; a screenshot of the app is described as it is
        const words = a.kind === 'pdf' ? scrubText(parts, 4000) : parts;
        const missing = r.list.length - r.read.length;
        blocks.push(`${head}\n${words.slice(0, perPicture)}${missing ? `\n_(${missing} of ${r.list.length} pictures could not be read.)_` : ''}`);
    }
    const section = [
        '### What the AI saw in the screenshot', '',
        `<!-- ${READING_MARKER} -->`,
        `<!-- ${COUNT_MARKER}:${total} -->`,
        `_${total} attachment${total === 1 ? '' : 's'} read from the full-quality files when the report was filed${who ? `, by a vision model (${who})` : ''}. It is a machine reading and can be wrong: use it to decide where to look, and trust the code over it. Names of files are not recorded._`,
        '', blocks.join('\n\n'), '',
    ].join('\n').slice(0, 14_000);
    const status = readOk.length === pictures.length ? 'read' : (readOk.length || textFiles.length ? 'partial' : 'unreadable');
    return { status, section, count: total, read: readOk.length + textFiles.length, provider: readOk[0] && readOk[0].provider };
}

/**
 * The thumbnails after the first, as extra marker blocks the agent strips with the first one. Each must fit what is left.
 * @param {(string|{n:number, thumb:string})[]} thumbs  the thumbnails of the attachments after the first one that has one, in order;
 *        an item may carry its attachment number `n` (a text file in between does not shift the numbering)
 * @param {number} budget    characters available for all of them
 */
export function extraImagesSection(thumbs, budget) {
    const out = [];
    let left = Number(budget) || 0;
    (Array.isArray(thumbs) ? thumbs : []).forEach((item, i) => {
        const t = item && typeof item === 'object' ? item.thumb : item;
        const n = item && typeof item === 'object' && Number(item.n) > 0 ? Math.floor(Number(item.n)) : i + 2;
        if (typeof t !== 'string' || !THUMB_URL.test(t)) return;
        const block = [`<!-- ${EXTRA_MARKER} n=${n} -->`, `<details><summary>Attachment ${n} thumbnail (for the fix agent's vision pass)</summary>`, '', '```', t, '```', '', '</details>', ''].join('\n');
        if (block.length > left) return;
        left -= block.length; out.push(block);
    });
    return out.length ? ['### More attachments', '', ...out].join('\n') : '';
}
