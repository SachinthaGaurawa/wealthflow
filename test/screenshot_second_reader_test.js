// =============================================================================
// Reading a screenshot well (owner, 2026-11-06: "the AI's accuracy on an attached image is far too low").
// What these pin down:
//   - GitHub Models is retired (2026-07-30): no route may depend on it, and the run's own token is not a vision credential.
//   - A reading is checked by a DIFFERENT provider; disagreement is written into the text, not hidden.
//   - What the reader says it saw is looked up in the app's own code by a program, and the line is named.
//   - The device facts the app recorded reach the reader.
// No real provider is called: every fetch is injected.
// =============================================================================
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    visionKey, visionModels, visionPrompt, verifyPrompt, describeScreenshot, screenshotContext, groundReading, transcriptPhrases, viewportOf, IMAGE_MARKER,
} from '../wf-screenshot-reader.mjs';
import { PROVIDERS } from '../wf-llm-router.mjs';

const PNG = 'data:image/png;base64,' + 'iVBORw0KGgo'.repeat(40);
const ok = (json) => ({ ok: true, status: 200, json: async () => json });
const text = (t) => ok({ choices: [{ message: { content: t } }] });
const gemini = (t) => ok({ candidates: [{ content: { parts: [{ text: t }] } }] });

const READING = ['TRANSCRIPT:', 'Monthly CC', 'Payments', 'LKR 15,749.51', 'due each month', 'Total CC Financed', 'SCREEN: CC Instalments, phone', 'PROBLEM: label overlaps value'].join('\n');

describe('GitHub Models is retired and is not a vision route', () => {
    it('the run\'s own token is not a vision credential, in or out of Actions', () => {
        const gh = PROVIDERS.find((p) => p.id === 'github-models');
        expect(visionKey('github-models', gh, { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 't' })).toBeNull();
        expect(visionModels('github-models', {})).toEqual([]);
    });
    it('with only the run token no provider is asked at all', async () => {
        let calls = 0;
        const r = await describeScreenshot({ dataUrl: PNG, env: { GITHUB_ACTIONS: 'true', GITHUB_TOKEN: 'tok' }, fetchImpl: async () => { calls++; return text('x'); }, verify: false });
        expect(r.ok).toBe(false);
        expect(calls).toBe(0);
    });
    it('the reader asks Gemini first, then the others, with the owner\'s keys', async () => {
        const seen = [];
        const fetchImpl = async (url) => { seen.push(String(url)); return gemini('TRANSCRIPT:\nhello world'); };
        const r = await describeScreenshot({ dataUrl: PNG, env: { GEMINI_API_KEY: 'g', MISTRAL_API_KEY: 'm' }, fetchImpl, verify: false });
        expect(r).toMatchObject({ ok: true, provider: 'gemini' });
        expect(seen[0]).toMatch(/generativelanguage\.googleapis\.com/);
    });
});

describe('a second reader checks the first one', () => {
    const env = { GEMINI_API_KEY: 'g', MISTRAL_API_KEY: 'm' };
    const route = (first, second) => async (url) => (String(url).includes('generativelanguage') ? gemini(first) : text(second));
    it('says so when a different provider confirms', async () => {
        const r = await describeScreenshot({ dataUrl: PNG, env, fetchImpl: route(READING, 'CONFIRMED.') });
        expect(r).toMatchObject({ ok: true, provider: 'gemini', checked: 'confirmed' });
        expect(r.checker).toMatch(/^mistral\//);
        expect(r.text).toBe(READING);
    });
    it('writes the disagreement into the reading instead of hiding it', async () => {
        const r = await describeScreenshot({ dataUrl: PNG, env, fetchImpl: route(READING, 'CORRECTIONS:\n- the value is drawn OVER the label, not beside it') });
        expect(r.checked).toBe('corrected');
        expect(r.text).toContain(READING.slice(0, 40));
        expect(r.text).toMatch(/SECOND READER \(mistral\/.*\) CORRECTS/);
        expect(r.text).toContain('drawn OVER the label');
    });
    it('a lone reader says it was not cross-checked, and a failing checker does not lose the reading', async () => {
        const lone = await describeScreenshot({ dataUrl: PNG, env: { GEMINI_API_KEY: 'g' }, fetchImpl: route(READING, '') });
        expect(lone).toMatchObject({ ok: true, checked: 'alone' });
        const broken = await describeScreenshot({ dataUrl: PNG, env, fetchImpl: async (url) => (String(url).includes('generativelanguage') ? gemini(READING) : { ok: false, status: 500, json: async () => ({}) }) });
        expect(broken).toMatchObject({ ok: true, checked: 'alone' });
        expect(broken.text).toBe(READING);
    });
    it('the checker is shown the reading and asked for one of two answers', () => {
        const p = verifyPrompt({ reading: READING, title: 't', text: 'x' });
        expect(p).toContain('Monthly CC');
        expect(p).toMatch(/CONFIRMED/);
        expect(p).toMatch(/CORRECTIONS:/);
    });
    it('the reader is told the device facts the app recorded', () => {
        const body = '| Device | Mozilla/5.0 (iPhone; CPU iPhone OS 18_7) |\n| Screen | 430x932 |\n| Viewport | 430x932 |\n| DPR | 3 |\n';
        expect(viewportOf(body)).toBe('a phone, screen 430x932 CSS pixels at 3x. The screenshot may be a crop of that screen.');
        expect(visionPrompt({ viewport: viewportOf(body) })).toMatch(/430x932/);
        expect(viewportOf('nothing here')).toBe('');
    });
});

describe('what the reader saw is looked up in the code', () => {
    it('lists the phrases of the TRANSCRIPT and ignores bare numbers and fragments', () => {
        const p = transcriptPhrases(READING);
        expect(p).toContain('Monthly CC');
        expect(p).toContain('due each month');
        expect(p.some((x) => /15,749/.test(x))).toBe(false);        // an amount names no screen
        expect(p.every((x) => /[A-Za-z]{3}/.test(x))).toBe(true);
        expect(transcriptPhrases('no sections here')).toEqual([]);
    });
    it('names the file and line that draws each phrase, and flags the ones that are nowhere', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ground-'));
        fs.writeFileSync(path.join(dir, 'index.html'), '<html>\n<div>\n<div class="stat-label">Monthly CC Payments</div>\n<div>due each month</div>\n');
        fs.writeFileSync(path.join(dir, 'wf-other.js'), 'const x = 1;\n');
        const g = groundReading(READING, dir);
        expect(g.found.find((f) => f.phrase === 'due each month').where).toBe('index.html:4');
        expect(g.missing).toContain('Total CC Financed');
        expect(g.section).toMatch(/looked up by a program/i);
        expect(g.section).toContain('index.html:4');
        expect(groundReading('x', dir).section).toBe('');
        expect(groundReading(READING, '/nonexistent-dir-xyz').found).toEqual([]);
    });
    it('the fix agent gets the lookup appended to the reading it works from', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-ground-'));
        fs.writeFileSync(path.join(dir, 'index.html'), 'a\nMonthly CC Payments\n');
        const body = `### User feedback\n> overlap\n| Viewport | 430x932 |\n<!-- ${IMAGE_MARKER} -->\n<details>\n\n\`\`\`\n${PNG}\n\`\`\`\n\n</details>`;
        const r = await screenshotContext({ issue: { title: 't', body }, repoDir: dir, env: { GEMINI_API_KEY: 'g' }, fetchImpl: async () => gemini(READING) });
        expect(r.status).toBe('read');
        expect(r.body).toContain('index.html:2');
        expect(r.note).toMatch(/Not cross-checked/);
        expect(r.body).not.toContain('iVBORw0KGgo');
    });
    it('names the readers that failed before the one that worked (a quiet provider is not a broken one)', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wf-tried-'));
        const body = `### User feedback\n> overlap\n<!-- ${IMAGE_MARKER} -->\n<details>\n\n\`\`\`\n${PNG}\n\`\`\`\n\n</details>`;
        const fetchImpl = async (url) => (String(url).includes('generativelanguage') ? { ok: false, status: 403, json: async () => ({ error: { message: 'no access' } }), text: async () => 'no access' } : text(READING));
        const r = await screenshotContext({ issue: { title: 't', body }, repoDir: dir, env: { GEMINI_API_KEY: 'g', MISTRAL_API_KEY: 'm' }, fetchImpl });
        expect(r.status).toBe('read');
        expect(r.provider).toBe('mistral');
        expect(r.note).toMatch(/Tried first and failed: gemini\/[^;]*HTTP 403/);
    });
});
