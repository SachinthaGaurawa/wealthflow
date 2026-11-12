// =============================================================================
// The fix agent can SEE the screenshot a user attached to a report.
// Found on issue #514 (2026-11-04): the picture was written into the issue and
// then nothing ever read it, so a layout bug only a picture shows was handed to
// a text-only model as one sentence. These tests use an injected fetch; no real
// vision provider is called (none has a key in CI), and that limit is stated in
// the agent's own comment when a provider cannot read the image.
// =============================================================================
import { describe, it, expect } from 'vitest';
import { imageSection, imageRoom, IMAGE_BUDGET, IMAGE_BUDGET_MAX } from '../feedback-triage.js';
import {
    extractScreenshot, withoutScreenshot, visionPrompt, visionModels, describeScreenshot, screenshotContext, IMAGE_MARKER,
} from '../autonomy/screenshot-reader.mjs';
import { lastAttemptAgeMs } from '../autonomy/work-queue.mjs';

const PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40);
const issueWithImage = () => ({
    number: 514, title: '[CRITICAL] CC installments overlap',
    body: '## Autonomous feedback issue\n\n### User feedback\n> overlap on phone\n\n' + imageSection(PNG, 56000) + '\n_Filed automatically._',
});
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const openAiText = (t) => ok({ choices: [{ message: { content: t } }] });

describe('screenshot-reader: finding the picture', () => {
    it('round-trips what feedback-triage writes', () => {
        const body = issueWithImage().body;
        expect(body).toContain(IMAGE_MARKER);
        expect(extractScreenshot(body)).toBe(PNG);
    });
    it('removes the base64 from the text the other agents read', () => {
        const stripped = withoutScreenshot(issueWithImage().body);
        expect(stripped).not.toContain('iVBORw0KGgo');
        expect(stripped).toContain('overlap on phone');
    });
    it('returns nothing for a body without a screenshot or with junk', () => {
        expect(extractScreenshot('plain text')).toBe('');
        expect(extractScreenshot(null)).toBe('');
        expect(withoutScreenshot(undefined)).toBe('');
    });
    it('only vision-capable models are listed, and the env override comes first', () => {
        expect(visionModels('groq', { GROQ_VISION_MODEL: 'x/y' })[0]).toBe('x/y');
        expect(visionModels('groq', {}).length).toBeGreaterThan(0);
        expect(visionModels('cerebras', {})).toEqual([]);
    });
    it('asks for what is visible, not for a guess at the code', () => {
        const p = visionPrompt({ title: 'T', text: 'overlap' });
        expect(p).toMatch(/Describe ONLY what is visible/);
        expect(p).toMatch(/TRANSCRIPT:/);
        expect(p).toMatch(/LAYOUT:/);
        expect(p).toMatch(/LIKELY CAUSE:/);
    });
});

describe('screenshot-reader: reading it', () => {
    it('uses the first provider that has a key and answers', async () => {
        const calls = [];
        const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return openAiText('SCREEN: CC Instalments, phone.\nPROBLEM: two cards overlap.'); };
        const r = await describeScreenshot({ dataUrl: PNG, title: 't', text: 'x', env: { MISTRAL_API_KEY: 'k' }, fetchImpl });
        expect(r.ok).toBe(true);
        expect(r.provider).toBe('mistral');
        expect(r.text).toMatch(/overlap/);
        expect(calls[0].body.messages[0].content.some((c) => c.type === 'image_url')).toBe(true);
    });
    it('falls through to the next provider on a quota error, and says what it tried', async () => {
        let n = 0;
        const fetchImpl = async () => (n++ === 0 ? { ok: false, status: 429, json: async () => ({}) } : openAiText('SCREEN: ok'));
        const r = await describeScreenshot({ dataUrl: PNG, env: { MISTRAL_API_KEY: 'k', GROQ_API_KEY: 'g' }, fetchImpl });
        expect(r.ok).toBe(true);
        expect(r.provider).toBe('groq');
        expect(r.tried[0]).toMatch(/mistral.*429/);
    });
    it('says plainly that nothing read it when there is no key', async () => {
        const r = await describeScreenshot({ dataUrl: PNG, env: {}, fetchImpl: async () => { throw new Error('must not be called'); } });
        expect(r.ok).toBe(false);
        expect(r.tried).toEqual([]);
    });
    it('a network error never throws out of the reader', async () => {
        const r = await describeScreenshot({ dataUrl: PNG, env: { GROQ_API_KEY: 'g' }, fetchImpl: async () => { throw new Error('boom'); } });
        expect(r.ok).toBe(false);
        expect(r.tried.join()).toMatch(/boom/);
    });
});

describe('screenshotContext: what the agent is given', () => {
    it('adds a labelled machine reading and strips the base64', async () => {
        const fetchImpl = async () => openAiText('PROBLEM: the card title is clipped.');
        const c = await screenshotContext({ issue: issueWithImage(), env: { MISTRAL_API_KEY: 'k' }, fetchImpl });
        expect(c.status).toBe('read');
        expect(c.body).toMatch(/### What the screenshot shows/);
        expect(c.body).toMatch(/machine reading and can be wrong/);
        expect(c.body).toMatch(/clipped/);
        expect(c.body).not.toContain('iVBORw0KGgo');
        expect(c.note).toMatch(/mistral/);
    });
    it('does not pretend to have seen it when no model could read it', async () => {
        const c = await screenshotContext({ issue: issueWithImage(), env: {}, fetchImpl: async () => { throw new Error('no'); } });
        expect(c.status).toBe('unreadable');
        expect(c.body).toMatch(/no vision model could read it/);
        expect(c.body).not.toMatch(/machine reading/);
    });
    it('reports an oversize screenshot instead of staying silent', async () => {
        const issue = { title: 't', body: '### Screenshot\n_A screenshot was attached (~91 KB) but exceeds the room in this issue._' };
        const c = await screenshotContext({ issue, env: {} });
        expect(c.status).toBe('oversize');
        expect(c.note).toMatch(/too large/);
    });
    it('is a no-op for an issue without a screenshot', async () => {
        const c = await screenshotContext({ issue: { title: 't', body: 'just text' }, env: {} });
        expect(c).toMatchObject({ status: 'none', body: 'just text', note: '' });
    });
});

describe('feedback-triage: room for the picture', () => {
    it('grows with the free space but stays inside the floor and the ceiling', () => {
        expect(imageRoom(0)).toBe(IMAGE_BUDGET_MAX);
        expect(imageRoom(60000)).toBe(IMAGE_BUDGET);
        expect(imageRoom(NaN)).toBe(IMAGE_BUDGET_MAX);
        for (const n of [0, 3000, 9000, 20000, 70000]) {
            const r = imageRoom(n);
            expect(r).toBeGreaterThanOrEqual(IMAGE_BUDGET);
            expect(r).toBeLessThanOrEqual(IMAGE_BUDGET_MAX);
        }
    });
    it('keeps a 52,000-character screenshot (issue #514) that the old fixed budget dropped', () => {
        const big = 'data:image/jpeg;base64,' + 'A'.repeat(52000);
        expect(imageSection(big, IMAGE_BUDGET)).toMatch(/exceeds/);
        expect(imageSection(big, imageRoom(6000))).toContain(IMAGE_MARKER);
    });
});

describe('work-queue: attempt cooldown', () => {
    const at = (ms) => ({ user: { login: 'github-actions[bot]' }, body: '<!-- wf-agent-attempt -->\nAttempt', created_at: new Date(ms).toISOString() });
    it('returns null with no attempts and the age of the newest one otherwise', () => {
        const now = Date.now();
        expect(lastAttemptAgeMs([], now)).toBeNull();
        expect(lastAttemptAgeMs([{ body: 'hi', created_at: new Date(now).toISOString() }], now)).toBeNull();
        expect(lastAttemptAgeMs([at(now - 600_000), at(now - 35_000)], now)).toBe(35_000);
    });
});
