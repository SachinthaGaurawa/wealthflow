// Feedback typed in ANY language must be understood (owner, 2026-11-04). Scripted model replies only: no network.
import { describe, it, expect } from 'vitest';
import {
    detectLanguage, needsTranslation, multilingualClassify, parseTranslation, understandFeedback,
    translationSection, withTranslation, userWords, hasTranslation, TRANSLATION_MARKER,
} from '../autonomy/feedback-language.mjs';
import handler, { fingerprint } from '../feedback-triage.js';

const SI = 'ණය කාඩ් වාරික පිටුවේ Edit සහ Delete බොත්තම් පේන්නේ නෑ, අකුරු එකිනෙක උඩින් යනවා';
const SI_FEATURE = 'මාසික වාර්තාවක් PDF එකක් විදියට බාගත කරන්න අලුත් option එකක් එකතු කරන්න ඕනේ';
const TA = 'கடன் அட்டை பக்கத்தில் பொத்தான்கள் வேலை செய்யவில்லை';
const SINGLISH = 'mage cc instalment page eke edit button eka penenne naha, mata balanna ona';
const EN = 'The Edit and Delete buttons on the CC Instalments page are hidden behind the table, please fix it';

const ok = (obj) => async () => ({ text: JSON.stringify(obj), provider: 'fake' });

describe('detectLanguage', () => {
    it('knows Sinhala, Tamil and other scripts from the writing system', () => {
        expect(detectLanguage(SI)).toMatchObject({ code: 'si', english: false });
        expect(detectLanguage(TA)).toMatchObject({ code: 'ta', english: false });
        expect(detectLanguage('यह बटन काम नहीं कर रहा है')).toMatchObject({ code: 'hi', english: false });
        expect(detectLanguage('这个按钮不能用')).toMatchObject({ english: false });
        expect(detectLanguage('кнопка не работает на этой странице')).toMatchObject({ code: 'ru', english: false });
    });
    it('knows Sinhala typed in English letters', () => {
        expect(detectLanguage(SINGLISH)).toMatchObject({ code: 'si-latn', english: false, romanised: true });
    });
    it('treats English as English, including a stray foreign symbol or one quoted word', () => {
        expect(detectLanguage(EN).english).toBe(true);
        expect(detectLanguage('Rs. 5,000 charged twice on my card ₹ today').english).toBe(true);
        expect(detectLanguage('The word "ණය" shows as a box on the loans page and the whole row looks wrong').english).toBe(true);
        expect(detectLanguage('').english).toBe(true);
        expect(detectLanguage('12345 !!!').english).toBe(true);
    });
    it('spots another Latin-script language by the absence of English function words', () => {
        const r = detectLanguage('el botón de editar no funciona en la página de las cuotas de la tarjeta');
        expect(r.english).toBe(false);
    });
    it('does not mistake short or technical English for another language', () => {
        expect(detectLanguage('crash').english).toBe(true);
        expect(detectLanguage('CC instalments overlap').english).toBe(true);
        expect(needsTranslation(EN)).toBe(false);
        expect(needsTranslation(SI)).toBe(true);
    });
    it('handles mixed Sinhala with English product words', () => {
        expect(detectLanguage('මගේ CC instalments page එකේ buttons පේන්නේ නෑ').english).toBe(false);
    });
});

describe('multilingualClassify (no AI available)', () => {
    it('reads Sinhala, Tamil and Singlish keywords', () => {
        expect(multilingualClassify(SI).type).toBe('bug');
        expect(multilingualClassify(SI_FEATURE).type).toBe('feature');
        expect(multilingualClassify(TA).type).toBe('bug');
        expect(multilingualClassify('app eka hang wenawa, white screen ekak').type).toBe('crash');
        expect(multilingualClassify('mage password eka hack una wage').type).toBe('security');
        expect(multilingualClassify('xyz qrs')).toBe(null);
    });
});

describe('understandFeedback', () => {
    it('does not call the AI for English', async () => {
        let calls = 0;
        const u = await understandFeedback(EN, { chatImpl: async () => { calls++; return { text: '{}' }; } });
        expect(calls).toBe(0);
        expect(u).toMatchObject({ translated: false, via: 'none' });
    });
    it('returns the translation, summary and type from the model', async () => {
        const u = await understandFeedback(SI, { chatImpl: ok({ language: 'Sinhala', english: 'The Edit and Delete buttons on the CC instalments page are not visible and the letters overlap', summary: 'CC instalments buttons not visible', type: 'bug' }) });
        expect(u).toMatchObject({ translated: true, via: 'ai', type: 'bug', provider: 'fake' });
        expect(u.english).toMatch(/Edit and Delete/);
        expect(u.language.name).toBe('Sinhala');
    });
    it('never throws: a failing, slow or nonsense model leaves the original words and the keyword guess', async () => {
        const boom = await understandFeedback(SI, { chatImpl: async () => { throw new Error('429'); } });
        expect(boom).toMatchObject({ translated: false, via: 'keywords', type: 'bug' });
        const slow = await understandFeedback(SI, { chatImpl: () => new Promise(() => {}), timeoutMs: 30 });
        expect(slow.translated).toBe(false);
        const junk = await understandFeedback(SI, { chatImpl: async () => ({ text: 'sorry I cannot' }) });
        expect(junk.translated).toBe(false);
    });
    it('parseTranslation validates strictly', () => {
        expect(parseTranslation('{"english":""}')).toBe(null);
        expect(parseTranslation('nothing')).toBe(null);
        expect(parseTranslation('```json\n{"english":"hello","type":"weird","summary":"s"}\n```')).toMatchObject({ english: 'hello', type: null });
    });
});

describe('issue text', () => {
    it('writes a labelled translation block, with the marker, and keeps trust in the original', () => {
        const u = { language: { name: 'Sinhala', english: false }, translated: true, english: 'Buttons are hidden', provider: 'fake' };
        const sec = translationSection(u);
        expect(sec).toContain(`<!-- ${TRANSLATION_MARKER} status=ok -->`);
        expect(sec).toMatch(/source of truth/);
        expect(sec).toContain('> Buttons are hidden');
        expect(translationSection({ language: { english: true } })).toBe('');
        expect(translationSection({ language: { name: 'Tamil', english: false }, translated: false })).toMatch(/No AI translation was available/);
    });
    it('withTranslation adds a reading to an older Sinhala issue, once', async () => {
        const issue = { number: 9, title: '[CRITICAL] ' + SI.slice(0, 30), body: '### User feedback\n> ' + SI + '\n\n_footer_' };
        const r = await withTranslation(issue, { chatImpl: ok({ language: 'Sinhala', english: 'Edit and Delete buttons are not visible, the text overlaps', summary: 's', type: 'bug' }) });
        expect(r.status).toBe('translated');
        expect(hasTranslation(r.issue.body)).toBe(true);
        expect(r.issue.body).toMatch(/Edit and Delete buttons/);
        const again = await withTranslation(r.issue, { chatImpl: async () => { throw new Error('must not be called'); } });
        expect(again.status).toBe('none');
        const english = await withTranslation({ number: 1, title: 't', body: '### User feedback\n> ' + EN }, { chatImpl: async () => { throw new Error('no'); } });
        expect(english.status).toBe('none');
    });
    it('a failed translation is retried later, not remembered as done', async () => {
        const body = '### User feedback\n> ' + SI + '\n\n' + translationSection({ language: { name: 'Sinhala', english: false }, translated: false });
        const r = await withTranslation({ number: 3, title: 't', body }, { chatImpl: ok({ language: 'Sinhala', english: 'Buttons hidden', summary: 's', type: 'bug' }) });
        expect(r.status).toBe('translated');
    });
    it('userWords reads the quoted block', () => {
        expect(userWords('x\n### User feedback\n> line one\n> line two\n\nmore')).toBe('line one\nline two');
    });
});

describe('fingerprint for other writing systems', () => {
    it('gives identical Sinhala text an identical label, and different text a different one', () => {
        const a = fingerprint(SI), b = fingerprint(SI), c = fingerprint(SI_FEATURE);
        expect(a).toBe(b);
        expect(a).not.toBe(c);
        expect(a).toMatch(/^fb-u-[0-9a-f]{8}$/);
        expect(a.length).toBeLessThanOrEqual(50);
    });
    it('still never matches two junk reports', () => {
        expect(fingerprint('ok')).not.toBe(fingerprint('ok'));
    });
});

describe('the triage endpoint, end to end with a scripted world', () => {
    async function run(text, { translateTo } = {}) {
        const created = [];
        const realFetch = globalThis.fetch;
        process.env.GITHUB_REPO = 'o/r'; process.env.GITHUB_TOKEN = 'ghp_test';
        delete process.env.EDENAI_API_KEY;
        globalThis.fetch = async (url, init) => {
            const u = String(url);
            if (u.includes('/issues') && init && init.method === 'POST') { created.push(JSON.parse(init.body)); return { ok: true, status: 201, json: async () => ({ number: 77 }) }; }
            return { ok: true, status: 200, json: async () => [] };
        };
        const res = { statusCode: 0, headers: {}, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(o) { this.body = o; return this; }, end() { return this; } };
        try { await handler({ method: 'POST', body: { text, type: 'other' }, headers: {} }, res); } finally { globalThis.fetch = realFetch; }
        return { created: created[0], res };
    }
    it('files a Sinhala report with the owner words intact and an honest language note when no AI answers', async () => {
        const { created, res } = await run(SI);
        expect(created).toBeTruthy();
        expect(created.body).toContain(SI);
        expect(created.body).toMatch(/wrote in \*\*Sinhala\*\*/);
        expect(created.labels.some((l) => /^fb-u-/.test(l))).toBe(true);
        expect(JSON.stringify(res.body)).toMatch(/"language"/);
    });
    it('does not touch an English report', async () => {
        const { created } = await run(EN);
        expect(created.body).not.toContain(TRANSLATION_MARKER);
    });
});
