/* =============================================================================
 * wf-video-reader.mjs — read a screen recording the way a person watches it, then say what happened   (feedback attachments)
 * -----------------------------------------------------------------------------
 * WHY (owner, 2026-11-20): "videos and screen recordings in Send Feedback; understand them frame by frame, like a person, by several
 * models, and hand it to the autonomous system". A model that is shown only a postage-stamp thumbnail of a recording learns nothing, and a
 * model asked to watch a whole video in one go is both slow and unreliable on the free tiers. So the work is split the way a person would do it:
 *
 *   1. THE DEVICE chooses the frames (wealthflow-video-frames.js): the first and last, the moments where the picture changed most, the screen
 *      just before a tap and once it had settled. The video itself never leaves the phone.
 *   2. EACH FRAME is read on its own by a vision model (describeImpl = wf-screenshot-reader describeScreenshot), a few at a time, so one slow
 *      provider cannot cost the other frames and every frame is looked at with the same care a single screenshot gets.
 *   3. THE ORDER is read as a whole: one text model writes what the person did and what the app did, step by step with the seconds, and says where
 *      the problem shows. A SECOND model on a different provider then checks that story against the frame readings and says CONFIRMED or lists
 *      corrections (the same two-reader rule single screenshots use). With one provider only, the story says it was not cross-checked.
 *
 * LIMITS, said in the issue itself: the sound is not heard, a moment between two frames is not seen, and a machine reading can be wrong.
 *
 * PRIVACY. The issue is PUBLIC. A recording of the app is described as it is (that is what the fix agent needs), exactly as a screenshot is.
 * A recording can also show another app: the reading is told to say only "another app" and not copy names, numbers or messages from it, and
 * maskIdentifiers() then ENFORCES the part that matters most: e-mail addresses and long numbers never reach the issue, whatever a model wrote.
 * The frame readers and the story writer are never given a file name.
 *
 * Pure apart from the two functions it is given (describeImpl, chatImpl), so the tests run without a model. Never throws.
 * ===========================================================================*/

export const MAX_VIDEO_FRAMES = 10;
const FRAME_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_FRAME_CHARS = 1_100_000;
const WHY = new Set(['first', 'last', 'change', 'settled', 'before', 'even']);
const WHY_WORDS = {
    first: 'the first moment', last: 'the last moment', change: 'the screen changed here', settled: 'the screen once it had settled',
    before: 'just before the screen changed', even: 'a moment between',
};

/**
 * The issue is PUBLIC and a recording can show something that is not the app. The prompt asks the reader to say only "another app", but a prompt is a request,
 * not a rule: whatever the readers wrote, this removes e-mail addresses and long numbers (cards, accounts, phones, references: eight digits or more, even when
 * written in groups) before anything is kept. Amounts and words stay: the fix agent needs to see what the app showed. Idempotent, never throws.
 */
export function maskIdentifiers(text) {
    try {
        return String(text == null ? '' : text)
            .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, '[e-mail]')
            .replace(/\+?\d(?:[ .-]?\d){7,}/g, '[number]');
    } catch (_) { return ''; }
}

/** Only real raster data URLs, at most ten, in time order, with a time that is a plausible number and a reason from the fixed list. */
export function validVideoFrames(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const f of list.slice(0, MAX_VIDEO_FRAMES * 2)) {
        if (!f || typeof f !== 'object') continue;
        const image = f.image;
        if (typeof image !== 'string' || image.length > MAX_FRAME_CHARS || !FRAME_URL.test(image)) continue;
        const t = Number(f.t);
        if (!Number.isFinite(t) || t < 0 || t > 3600) continue;
        const why = WHY.has(String(f.why)) ? String(f.why) : 'even';
        out.push({ t: Math.round(t * 10) / 10, why, image });
        if (out.length >= MAX_VIDEO_FRAMES) break;
    }
    return out.sort((a, b) => a.t - b.t);
}

/** [second, change] pairs: finite numbers, at most 60. */
export function cleanMotion(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const r of list.slice(0, 200)) {
        if (!Array.isArray(r)) continue;
        const t = Number(r[0]), c = Number(r[1]);
        if (Number.isFinite(t) && Number.isFinite(c) && t >= 0 && t <= 3600 && c >= 0 && c <= 1) out.push([Math.round(t * 10) / 10, Math.round(c * 1000) / 1000]);
        if (out.length >= 60) break;
    }
    return out;
}

/** The busiest moments of the recording in words: "3.1 s, 7.4 s ...", so the story writer knows where the screen really moved. */
export function motionSummary(motion, duration) {
    const rows = cleanMotion(motion);
    if (!rows.length) return '';
    const busiest = rows.filter((r) => r[1] > 0.012).sort((a, b) => b[1] - a[1]).slice(0, 6).map((r) => r[0]).sort((a, b) => a - b);
    const still = rows.filter((r) => r[1] <= 0.012).length;
    const d = Number(duration) > 0 ? ` of ${Number(duration).toFixed(1)} s` : '';
    return busiest.length
        ? `The screen changed most at ${busiest.map((t) => t.toFixed(1) + ' s').join(', ')}${d}; it was still at ${still} of ${rows.length} looks.`
        : `The screen hardly changed at all in the recording${d}.`;
}

/** What each frame reader is told: where in the recording this is, and the privacy rule. */
export function framePrompt(frame, i, n, duration) {
    return `[Frame ${i + 1} of ${n} of ONE screen recording of a phone app` + (duration ? `, ${Number(duration).toFixed(1)} s long` : '') +
        `. This frame is from second ${frame.t.toFixed(1)} (${WHY_WORDS[frame.why] || 'a moment'}). Describe exactly this moment: which screen it is, what is on it, anything that overlaps, is cut off or looks wrong, ` +
        'a dialog, message or toast, and any tap or touch marker. The other frames are read separately; do not guess what came before or after. ' +
        'If something other than the WealthFlow app is on screen, say only "another app" and do NOT copy names, numbers or messages from it.] ';
}

function withTimeout(promise, ms, fallback) {
    let timer;
    return Promise.race([
        promise,
        new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), Math.max(1, ms)); if (timer.unref) timer.unref(); }),
    ]).finally(() => clearTimeout(timer));
}

/** Run `fn` over `items` at most `size` at a time; items not started before `until` (ms since epoch) are skipped. */
async function pool(items, size, until, fn) {
    const results = new Array(items.length);
    let next = 0;
    const worker = async () => {
        for (;;) {
            const i = next++;
            if (i >= items.length) return;
            if (Date.now() > until) { results[i] = { skipped: true }; continue; }
            results[i] = await fn(items[i], i);
        }
    };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, worker));
    return results;
}

function readingsText(rows) {
    return rows.filter((r) => r.text).map((r) => `- ${r.t.toFixed(1)} s (${WHY_WORDS[r.why] || r.why}): ${r.text.replace(/\s+/g, ' ').slice(0, 520)}`).join('\n');
}

export function storyPrompt({ title = '', text = '', rows, duration, motion }) {
    return [
        'You are reading a screen recording of a phone app through frames that were already described one by one. You were NOT shown the video, only these readings.',
        'Report title: ' + String(title).slice(0, 200),
        'The person wrote: ' + String(text).slice(0, 600),
        duration ? `Recording length: ${Number(duration).toFixed(1)} s.` : '',
        motionSummary(motion, duration),
        '',
        'FRAME READINGS, in time order:',
        readingsText(rows),
        '',
        'Write, in plain English and at most 1,800 characters:',
        '1. WHAT HAPPENED: numbered steps in order, each with its second, saying what the person did and what the app did (only what the readings support).',
        '2. THE PROBLEM: the second where it shows, which screen, and what is wrong (cut off, overlapping, wrong number, dead tap, error). If the readings show no problem, say so.',
        '3. NOT VISIBLE: what you cannot tell from these frames (a moment between frames, sound).',
        'Do not invent frames, numbers or screens that are not in the readings.',
    ].filter(Boolean).join('\n');
}

export function checkPrompt({ story, rows }) {
    return [
        'Below are frame readings of a screen recording and a story someone wrote from them. Check the story against the readings ONLY.',
        '', 'FRAME READINGS:', readingsText(rows), '', 'STORY:', String(story).slice(0, 2000), '',
        'If every step of the story follows from the readings, answer exactly: CONFIRMED',
        'Otherwise answer: CORRECTIONS: then a short bullet list (at most 800 characters) of what the readings do not support or what the story missed.',
    ].join('\n');
}

const STORY_SYSTEM = 'You describe what happened in a screen recording from frame readings. You never invent what is not in the readings. Plain text only.';

/**
 * Read a recording. Frames are read at most `concurrency` at a time inside `frameWindowMs`; then the story is written and checked inside what is left of `deadlineMs`.
 * @returns {Promise<{ status:'read'|'partial'|'unreadable', rows:{t:number,why:string,text:string,ok:boolean}[], read:number, story:string, storyBy:string, checkedBy:string, checked:'confirmed'|'corrected'|'alone'|'none', who:string, tried:string[], timedOut:boolean }>}
 */
export async function readVideo({ frames, motion = [], duration = 0, title = '', text = '', env = process.env, fetchImpl = globalThis.fetch, describeImpl, chatImpl, deadlineMs = 34_000, frameWindowMs = 20_000, concurrency = 4, log = () => {} } = {}) {
    const start = Date.now();
    const list = validVideoFrames(frames);
    const none = { status: 'unreadable', rows: [], read: 0, story: '', storyBy: '', checkedBy: '', checked: 'none', who: '', tried: [], timedOut: false };
    if (!list.length) return none;
    try {
        if (!describeImpl) describeImpl = (await import('./wf-screenshot-reader.mjs')).describeScreenshot;
    } catch (_) { return none; }

    const results = await pool(list, concurrency, start + frameWindowMs, async (f, i) => {
        const r = await withTimeout(
            Promise.resolve(describeImpl({ dataUrl: f.image, title, text: framePrompt(f, i, list.length, duration) + String(text).slice(0, 500), env, fetchImpl, log, verify: false }))
                .catch((e) => ({ ok: false, tried: [String((e && e.message) || e).slice(0, 80)] })),
            Math.max(2000, start + frameWindowMs + 8000 - Date.now()), { ok: false, tried: ['timed out'] });
        return r || { ok: false, tried: [] };
    });
    const rows = list.map((f, i) => {
        const r = results[i] || {};
        return { t: f.t, why: f.why, text: r.ok ? maskIdentifiers(String(r.text || '').trim()) : '', ok: !!r.ok, provider: r.provider, model: r.model };
    });
    const readRows = rows.filter((r) => r.ok && r.text);
    const tried = [...new Set(results.flatMap((r) => (r && r.tried) || []))].slice(0, 4);
    const who = [...new Set(rows.filter((r) => r.ok).map((r) => `${r.provider}/${r.model}`))].join(', ');
    const out = { status: readRows.length === rows.length ? 'read' : readRows.length ? 'partial' : 'unreadable', rows, read: readRows.length, story: '', storyBy: '', checkedBy: '', checked: 'none', who, tried, timedOut: results.some((r) => r && r.skipped) };
    if (!readRows.length) return out;

    // the order, read as a whole: one writer, then a checker on another provider
    let chat = chatImpl;
    try { if (!chat) chat = (await import('./wf-llm-router.mjs')).chat; } catch (_) { return out; }
    const left = () => start + deadlineMs - Date.now();
    if (left() < 5000) return out;
    try {
        const a = await withTimeout(chat({ prompt: storyPrompt({ title, text, rows, duration, motion }), system: STORY_SYSTEM, maxTokens: 800, temperature: 0.1, timeoutMs: Math.min(left(), 14_000), env }), Math.min(left(), 15_000), null);
        const story = a && maskIdentifiers(String(a.text || '').trim());
        if (!story) return out;
        out.story = story.slice(0, 2000); out.storyBy = String(a.provider || ''); out.checked = 'alone';
        if (left() < 4000) return out;
        const b = await withTimeout(chat({ prompt: checkPrompt({ story: out.story, rows }), system: STORY_SYSTEM, maxTokens: 400, temperature: 0, exclude: a.provider ? [a.provider] : [], timeoutMs: Math.min(left(), 10_000), env }), Math.min(left(), 11_000), null);
        const answer = b && maskIdentifiers(String(b.text || '').trim());
        if (!answer) return out;
        out.checkedBy = String(b.provider || '');
        if (/^\W*confirmed\b/i.test(answer) && answer.length < 200) { out.checked = 'confirmed'; return out; }
        out.checked = 'corrected';
        out.story = (out.story + `\n\nSECOND READER (${out.checkedBy}) CORRECTS THE STORY ABOVE: where they differ, trust these corrections:\n` + answer.replace(/^\W*corrections\s*:?/i, '').trim().slice(0, 900)).slice(0, 3000);
    } catch (e) { log(`[video] the story could not be written: ${String((e && e.message) || e).slice(0, 120)}`); }
    return out;
}

/**
 * The block for the issue. Frame texts go in as the screen readings they are (the app is described as it is); the contact sheet is the issue's thumbnail.
 * @returns {string}
 */
export function videoBlock({ head, result, duration }) {
    const r = result;
    const notRead = r.rows.length - r.read;
    const lines = [head, `_A screen recording, read frame by frame by a vision model${r.who ? ` (${r.who})` : ''}${duration ? `, ${Number(duration).toFixed(1)} s long` : ''}. The sound is not heard and a moment between two frames is not seen. It is a machine reading and can be wrong: use it to decide where to look, and trust the code over it._`, ''];
    if (r.story) {
        lines.push(`**What happened, in order** _(written by ${r.storyBy || 'a model'}; ${r.checked === 'confirmed' ? `checked by ${r.checkedBy}: confirmed` : r.checked === 'corrected' ? `checked by ${r.checkedBy}, which corrected it` : 'not cross-checked, only one reader was available'})_`, '', r.story, '');
    }
    lines.push('**Frame by frame**', '');
    for (const f of r.rows) {
        lines.push(f.text
            ? `- **${f.t.toFixed(1)} s** _(${WHY_WORDS[f.why] || f.why})_: ${f.text.replace(/\s+/g, ' ').slice(0, 700)}`
            : `- **${f.t.toFixed(1)} s** _(${WHY_WORDS[f.why] || f.why})_: _could not be read_`);
    }
    if (notRead > 0) lines.push('', `_${notRead} of ${r.rows.length} frames could not be read${r.timedOut ? ' in time' : ''}._`);
    return lines.join('\n');
}
