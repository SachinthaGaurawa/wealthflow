/* Video feedback (owner, 2026-11-20): a screen recording is accepted in Send Feedback and read frame by frame, like a person watching,
   by more than one model, then handed to the autonomous system as words. The video itself never leaves the phone. These pin:
   the device side (which frames are picked, what the picker takes and refuses), the server side (frame validation, budgets, each frame read
   on its own, the story written by one provider and checked by a different one, a failure never costing the report) and the issue text. */
import { describe, it, expect } from 'vitest';
import { loadBrowserModule } from './helpers/load-browser-module.js';
import { normalizeAttachments, readAllAttachments, MAX_READING_TOTAL, READING_MARKER, COUNT_MARKER, VIDEO_MARKER } from '../wf-feedback-attachments.mjs';
import { screenshotContext } from '../wf-screenshot-reader.mjs';
import { validVideoFrames, cleanMotion, motionSummary, framePrompt, storyPrompt, checkPrompt, readVideo, videoBlock, MAX_VIDEO_FRAMES } from '../wf-video-reader.mjs';

const jpeg = (n, tag = 'A') => 'data:image/jpeg;base64,' + tag.repeat(n);
const frame = (t, why = 'even', n = 60) => ({ t, why, image: jpeg(n) });
const FRAMES = [frame(0, 'first'), frame(2.5, 'before'), frame(3.1, 'change'), frame(4, 'settled'), frame(9.8, 'last')];

// ── the device: which frames, what the picker does ────────────────────────────────────────────────────────────────
describe('the device picks the frames a person would look at', () => {
    const { window } = loadBrowserModule('wealthflow-video-frames.js', { html: '<div></div>' });
    const V = window.WFVideoFrames;

    it('knows videos by type or by extension, and nothing else', () => {
        expect(V.isVideo({ name: 'a.mp4', type: 'video/mp4' })).toBe(true);
        expect(V.isVideo({ name: 'Screen Recording.MOV', type: '' })).toBe(true);
        expect(V.isVideo({ name: 'a.png', type: 'image/png' })).toBe(false);
    });

    it('looks at the very beginning and end, never more than 120 times', () => {
        for (const d of [0.5, 3, 20, 120, 300]) {
            const t = V.sampleTimes(d);
            expect(t[0]).toBe(0);
            expect(t.length).toBeGreaterThanOrEqual(2);
            expect(t.length).toBeLessThanOrEqual(120);
            expect(t[t.length - 1]).toBeLessThanOrEqual(d);
            expect([...t].sort((a, b) => a - b)).toEqual(t);
        }
        expect(V.sampleTimes(0)).toEqual([0]);
        expect(V.sampleTimes(NaN)).toEqual([0]);
    });

    it('picks the first and last, the moment the screen changed, the screen before it and once it settled', () => {
        const samples = [];
        for (let i = 0; i <= 40; i++) samples.push({ t: i * 0.25, change: i === 12 ? 0.4 : i === 13 ? 0.1 : i === 14 ? 0.02 : 0.002 });
        const picks = V.pickFrames(samples, { max: 10 });
        const whys = picks.map((p) => p.why);
        expect(picks[0].why).toBe('first');
        expect(picks[picks.length - 1].why).toBe('last');
        expect(whys).toContain('change');
        expect(whys).toContain('before');
        expect(whys).toContain('settled');
        const ch = picks.find((p) => p.why === 'change');
        expect(ch.t).toBe(3);
        expect(picks.length).toBeLessThanOrEqual(10);
        expect(picks.map((p) => p.t)).toEqual([...picks.map((p) => p.t)].sort((a, b) => a - b));
    });

    it('a recording where nothing moves is still shown at several even moments, and is never over the cap', () => {
        const still = Array.from({ length: 50 }, (_, i) => ({ t: i * 0.2, change: 0 }));
        const p = V.pickFrames(still, { max: 10 });
        expect(p.length).toBeGreaterThanOrEqual(4);
        expect(p.length).toBeLessThanOrEqual(10);
        const busy = Array.from({ length: 200 }, (_, i) => ({ t: i * 0.1, change: i % 2 ? 0.3 : 0.05 }));
        expect(V.pickFrames(busy, { max: 10 }).length).toBeLessThanOrEqual(10);
        expect(V.pickFrames([], {})).toEqual([]);
    });

    it('measures how much two greyscale pictures differ', () => {
        expect(V.signatureDiff([0, 0, 0], [0, 0, 0])).toBe(0);
        expect(V.signatureDiff([0, 0], [255, 255])).toBe(1);
        expect(V.signatureDiff([1], [1, 2])).toBe(0);
    });

    it('keeps the motion timeline short but keeps the strongest moments', () => {
        const samples = Array.from({ length: 120 }, (_, i) => ({ t: i * 0.5, change: i === 77 ? 0.9 : 0.001 }));
        const rows = V.motionTimeline(samples, 20);
        expect(rows.length).toBeLessThanOrEqual(20);
        expect(rows.some((r) => r[1] === 0.9)).toBe(true);
        expect(rows[0][0]).toBe(0);
    });

    it('refuses a recording over 1.5 GB without opening it', async () => {
        const r = await V.extract({ name: 'big.mp4', type: 'video/mp4', size: 2 * 1024 * 1024 * 1024 });
        expect(r.ok).toBe(false);
        expect(r.reason).toMatch(/1\.5 GB/);
    });
});

describe('the picker takes one recording and says why it refuses another', () => {
    const { window } = loadBrowserModule('wealthflow-feedback-attach.js', { html: '<div id="wfFbAttach"></div>' });
    const A = window.WFFeedbackAttach;
    const f = (name, type, size = 1000) => ({ name, type, size });

    it('knows a recording by type or extension', () => {
        expect(A.kindOf(f('r.mp4', 'video/mp4'))).toBe('video');
        expect(A.kindOf(f('Screen Recording.mov', ''))).toBe('video');
        expect(A.kindOf(f('a.png', 'image/png'))).toBe('image');
    });
    it('takes one and refuses a second, and one over 1.5 GB', () => {
        const p = A.plan([], [f('1.mp4', 'video/mp4'), f('2.mp4', 'video/mp4'), f('3.png', 'image/png')]);
        expect(p.take.map((t) => t.name)).toEqual(['1.mp4', '3.png']);
        expect(p.refuse[0].why).toMatch(/only one screen recording/);
        const big = A.plan([], [f('b.mp4', 'video/mp4', 2 * 1024 * 1024 * 1024)]);
        expect(big.take).toHaveLength(0);
        expect(big.refuse[0].why).toMatch(/1\.5 GB/);
        const held = A.plan([{ name: 'a.mp4', size: 5, kind: 'video' }], [f('b.mov', '')]);
        expect(held.take).toHaveLength(0);
    });
    it('the recording gets a larger share of the request than a picture, and the budget never goes over the total', () => {
        const b = A.budgets([{ kind: 'video' }, { kind: 'image' }]);
        expect(b.videoShare).toBeGreaterThan(b.share);
        expect(b.thumbCap).toBeGreaterThan(0);
    });
    it('shows that it accepts video', () => {
        expect(A.hasVideo()).toBe(false);
    });
});

// ── the server ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('frames and motion from the device are checked, not trusted', () => {
    it('keeps only raster data URLs, a plausible time and a known reason, in time order, at most ten', () => {
        const list = [
            frame(5), frame(1, 'first'), { t: 2, why: 'x', image: 'https://evil/x.png' }, { t: -1, image: jpeg(5) }, { t: 'a', image: jpeg(5) },
            { t: 3, why: 'weird', image: jpeg(5) }, null, 'str', { t: 9999, image: jpeg(5) }, { t: 4, image: 'data:image/svg+xml;base64,AAA' },
        ];
        const v = validVideoFrames(list);
        expect(v.map((x) => x.t)).toEqual([1, 3, 5]);
        expect(v.find((x) => x.t === 3).why).toBe('even');
        expect(validVideoFrames(Array.from({ length: 30 }, (_, i) => frame(i))).length).toBe(MAX_VIDEO_FRAMES);
        expect(validVideoFrames('nope')).toEqual([]);
    });
    it('motion rows are finite numbers in range, at most sixty', () => {
        const m = cleanMotion([[1, 0.2], [2, 5], ['a', 1], [3], null, [4, 0.0004], ...Array.from({ length: 200 }, (_, i) => [i / 10, 0.1])]);
        expect(m[0]).toEqual([1, 0.2]);
        expect(m[1]).toEqual([4, 0]);
        expect(m.length).toBeLessThanOrEqual(60);
        expect(cleanMotion(undefined)).toEqual([]);
    });
    it('says in words where the screen moved', () => {
        expect(motionSummary([[0, 0], [3.1, 0.4], [4, 0.002], [7.4, 0.2]], 10)).toMatch(/3\.1 s, 7\.4 s of 10\.0 s/);
        expect(motionSummary([[0, 0], [1, 0.001]], 2)).toMatch(/hardly changed/);
        expect(motionSummary([], 2)).toBe('');
    });
    it('every frame reader is told which second it is, and the privacy rule', () => {
        const p = framePrompt({ t: 3.1, why: 'change' }, 2, 5, 9.8);
        expect(p).toMatch(/Frame 3 of 5/);
        expect(p).toMatch(/second 3\.1/);
        expect(p).toMatch(/another app/);
    });
});

describe('normalizeAttachments carries a recording', () => {
    const body = { attachments: [{ kind: 'video', thumb: jpeg(30), frames: FRAMES, motion: [[1, 0.2]], duration: 9.8 }] };
    it('keeps the frames, the motion and the length', () => {
        const [a] = normalizeAttachments(body);
        expect(a.kind).toBe('video');
        expect(a.frames).toHaveLength(5);
        expect(a.motion).toEqual([[1, 0.2]]);
        expect(a.duration).toBe(9.8);
        expect(a.reading).toEqual([]);
    });
    it('a recording with no usable frame and no thumbnail is dropped; a bad duration is zero', () => {
        expect(normalizeAttachments({ attachments: [{ kind: 'video', frames: [{ t: 1, image: 'x' }] }] })).toEqual([]);
        const [a] = normalizeAttachments({ attachments: [{ kind: 'video', frames: FRAMES, duration: -4 }] });
        expect(a.duration).toBe(0);
    });
    it('frames count against the same budget as pictures', () => {
        const huge = [frame(1, 'first', 1_000_000), frame(2, 'even', 1_000_000), frame(3, 'even', 1_000_000), frame(4, 'last', 1_000_000)];
        const [a] = normalizeAttachments({ attachments: [{ kind: 'video', frames: huge }] });
        expect(a.frames.reduce((s, f) => s + f.image.length, 0)).toBeLessThanOrEqual(MAX_READING_TOTAL);
        expect(a.frames.length).toBeLessThan(4);
    });
});

// a vision reader and a text reader that never touch the network
const describeOk = (calls = []) => async ({ dataUrl, text }) => {
    calls.push(text);
    const m = /second ([\d.]+)/.exec(text), sec = m ? m[1] : '0';
    return { ok: true, text: `The Instalments page at ${sec}s with a sheet open.`, provider: 'gemini', model: 'g-vision', tried: [] };
};
const chatTwo = (seen = []) => async ({ prompt, exclude = [] }) => {
    seen.push({ prompt, exclude });
    return /FRAME READINGS:\n/.test(prompt) && /STORY:/.test(prompt)
        ? { text: 'CONFIRMED', provider: 'groq' }
        : { text: '1. 0.0 s the page opens.\n2. 3.1 s the person taps Details and the sheet opens.\nTHE PROBLEM: none.', provider: 'mistral' };
};

describe('readVideo: each frame on its own, then the story, then a different reader checks it', () => {
    it('reads every frame, writes the story and has a different provider confirm it', async () => {
        const calls = [], seen = [];
        const r = await readVideo({ frames: FRAMES, motion: [[3.1, 0.4]], duration: 9.8, title: 't', text: 'the sheet is cut off', describeImpl: describeOk(calls), chatImpl: chatTwo(seen) });
        expect(r.status).toBe('read');
        expect(r.read).toBe(5);
        expect(calls).toHaveLength(5);
        expect(r.story).toMatch(/taps Details/);
        expect(r.storyBy).toBe('mistral');
        expect(r.checkedBy).toBe('groq');
        expect(r.checked).toBe('confirmed');
        expect(seen[1].exclude).toEqual(['mistral']);
        expect(seen[0].prompt).toMatch(/3\.1 s/);
        expect(seen[0].prompt).toMatch(/The screen changed most at 3\.1 s/);
    });
    it('a checker that disagrees puts its corrections into the story', async () => {
        let n = 0;
        const chat = async () => (++n === 1 ? { text: 'Step 1 the app crashes.', provider: 'a' } : { text: 'CORRECTIONS:\n- nothing crashes in any frame', provider: 'b' });
        const r = await readVideo({ frames: FRAMES, duration: 9.8, describeImpl: describeOk(), chatImpl: chat });
        expect(r.checked).toBe('corrected');
        expect(r.story).toMatch(/SECOND READER \(b\) CORRECTS/);
        expect(r.story).toMatch(/nothing crashes/);
        expect(r.story).not.toMatch(/CORRECTIONS:/);
    });
    it('with one provider only it says it was not cross-checked, and keeps the story', async () => {
        let n = 0;
        const chat = async () => (++n === 1 ? { text: 'Step 1.', provider: 'a' } : null);
        const r = await readVideo({ frames: FRAMES, describeImpl: describeOk(), chatImpl: chat });
        expect(r.checked).toBe('alone');
        expect(r.story).toBe('Step 1.');
    });
    it('a frame that cannot be read is named, the rest still count, and nothing throws', async () => {
        const describe = async ({ text }) => (/second 3\.1/.test(text) ? Promise.reject(new Error('boom')) : { ok: true, text: 'a screen', provider: 'p', model: 'm', tried: [] });
        const r = await readVideo({ frames: FRAMES, describeImpl: describe, chatImpl: async () => ({ text: 'story', provider: 'a' }) });
        expect(r.status).toBe('partial');
        expect(r.read).toBe(4);
        expect(r.rows.find((x) => x.t === 3.1).ok).toBe(false);
    });
    it('when no frame is read there is no story and the status says so', async () => {
        const r = await readVideo({ frames: FRAMES, describeImpl: async () => ({ ok: false, tried: ['x'] }), chatImpl: async () => { throw new Error('should not be called'); } });
        expect(r.status).toBe('unreadable');
        expect(r.story).toBe('');
    });
    it('a story writer that throws still leaves the frame readings', async () => {
        const r = await readVideo({ frames: FRAMES, describeImpl: describeOk(), chatImpl: async () => { throw new Error('down'); } });
        expect(r.status).toBe('read');
        expect(r.story).toBe('');
    });
    it('frames not started before the window closes are skipped, not waited for', async () => {
        const slow = async () => { await new Promise((r) => setTimeout(r, 30)); return { ok: true, text: 'a', provider: 'p', model: 'm', tried: [] }; };
        const r = await readVideo({ frames: FRAMES, describeImpl: slow, chatImpl: async () => null, concurrency: 1, frameWindowMs: 50 });
        expect(r.timedOut).toBe(true);
        expect(r.read).toBeLessThan(5);
    });
    it('no frames is unreadable', async () => {
        expect((await readVideo({ frames: [] })).status).toBe('unreadable');
    });
});

describe('the story and check prompts only use the readings', () => {
    const rows = [{ t: 0, why: 'first', text: 'Home' }, { t: 3.1, why: 'change', text: 'Sheet' }];
    it('lists the readings in time order and forbids inventing', () => {
        const p = storyPrompt({ title: 'T', text: 'x', rows, duration: 9.8, motion: [[3.1, 0.4]] });
        expect(p.indexOf('0.0 s')).toBeLessThan(p.indexOf('3.1 s (the screen changed here)'));
        expect(p).toMatch(/NOT shown the video/);
        expect(p).toMatch(/Do not invent/);
        expect(checkPrompt({ story: 's', rows })).toMatch(/CONFIRMED/);
    });
});

describe('the section for the issue', () => {
    it('readAllAttachments writes the story, the frame list and the limits, with a recording beside a picture', async () => {
        const atts = normalizeAttachments({ attachments: [
            { kind: 'image', thumb: jpeg(20), reading: [jpeg(100)] },
            { kind: 'video', thumb: jpeg(30), frames: FRAMES, motion: [[3.1, 0.4]], duration: 9.8 },
        ] });
        const r = await readAllAttachments({ attachments: atts, title: 't', text: 'x', describeImpl: describeOk(), chatImpl: chatTwo() });
        expect(r.status).toBe('read');
        expect(r.count).toBe(2);
        expect(r.section).toMatch(/Attachment 2 of 2 — screen recording \(9\.8 s, 5 frames looked at\)/);
        expect(r.section).toMatch(/What happened, in order/);
        expect(r.section).toMatch(/checked by groq: confirmed/);
        expect(r.section).toMatch(/\*\*3\.1 s\*\* _\(the screen changed here\)_/);
        expect(r.section).toMatch(/sound is not heard/);
        expect(r.section).toMatch(/Attachment 1 of 2 — screenshot/);
        expect(r.section.length).toBeLessThanOrEqual(20_000);
    });
    it('a recording that could not be read is named in the issue, and the report is still filed', async () => {
        const atts = normalizeAttachments({ attachments: [{ kind: 'video', thumb: jpeg(30), frames: FRAMES, duration: 9.8 }] });
        const r = await readAllAttachments({ attachments: atts, describeImpl: async () => ({ ok: false, tried: [] }), chatImpl: async () => null });
        expect(r.status).toBe('unreadable');
        expect(r.section).toBe('');
    });
    it('videoBlock says when frames were not read and when no second reader was available', () => {
        const result = { rows: [{ t: 0, why: 'first', text: 'Home' }, { t: 2, why: 'last', text: '' }], read: 1, story: 'S', storyBy: 'a', checked: 'alone', checkedBy: '', who: 'p/m', timedOut: true };
        const b = videoBlock({ head: '**H**', result, duration: 2 });
        expect(b).toMatch(/not cross-checked/);
        expect(b).toMatch(/could not be read_/);
        expect(b).toMatch(/1 of 2 frames could not be read in time/);
    });
});

describe('the agent does not check a recording reading against its contact-sheet thumbnail', () => {
    it('marks the section, and a lone recording is not sent to a vision model again', async () => {
        const atts = normalizeAttachments({ attachments: [{ kind: 'video', thumb: jpeg(30), frames: FRAMES, duration: 9.8 }] });
        const r = await readAllAttachments({ attachments: atts, describeImpl: describeOk(), chatImpl: chatTwo() });
        expect(r.section).toContain(`<!-- ${VIDEO_MARKER} -->`);
        expect(r.section).toContain(`<!-- ${COUNT_MARKER}:1 -->`);
        const body = ['## Autonomous feedback issue', '', r.section, '### Screenshot', '', '<!-- wf-feedback-image -->', '<details><summary>x</summary>', '', '```', jpeg(60), '```', '', '</details>', '', '_Filed automatically by the feedback triage agent._'].join('\n');
        const fetchImpl = async () => { throw new Error('the agent must not call a vision model here'); };
        const ctx = await screenshotContext({ issue: { title: 't', body }, fetchImpl, env: {} });
        expect(ctx.status).toBe('read');
        expect(ctx.note).toMatch(/screen recording/);
        expect(ctx.body).not.toMatch(/base64/);
        expect(ctx.body).toContain(READING_MARKER);
    });
    it('a recording that was not read does not set the marker', async () => {
        const atts = normalizeAttachments({ attachments: [{ kind: 'image', thumb: jpeg(20), reading: [jpeg(100)] }, { kind: 'video', thumb: jpeg(30), frames: FRAMES }] });
        const describe = async ({ text }) => (/Frame \d of/.test(text) ? { ok: false, tried: [] } : { ok: true, text: 'a screen', provider: 'p', model: 'm', tried: [] });
        const r = await readAllAttachments({ attachments: atts, describeImpl: describe, chatImpl: async () => null });
        expect(r.section).not.toContain(VIDEO_MARKER);
        expect(r.section).toMatch(/frames could not be read/);
    });
});
