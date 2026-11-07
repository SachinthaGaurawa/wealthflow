/* =============================================================================
 * wf-feedback-language.mjs — understand feedback written in ANY language
 * ---------------------------------------------------------------------------
 * WHY (owner, 2026-11-04): "if I type feedback in any language it must be understood". The owner writes in
 * Sinhala (and sometimes Sinhala typed in English letters, "Singlish"). Until now:
 *   - localClassify, roleFor, layoutLaneFor, buildLaneFor and conceptBoardFor are English-only regexes, so a Sinhala
 *     report was routed as a default "bug" and could never reach the layout, build or concept lanes;
 *   - fingerprint() strips everything outside a-z0-9, so a Sinhala report got a RANDOM label and was never de-duplicated;
 *   - the issue title was the first 60 characters of the raw text.
 *
 * WHAT THIS DOES
 *   detectLanguage(text)     which writing system it is (Sinhala, Tamil, Hindi, Arabic, Chinese, ...), or Singlish /
 *                            another non-English Latin language, or English. Pure, no network.
 *   understandFeedback(text) asks the AI board ONE question (any provider that has a key) for a faithful English
 *                            translation + a type + a one-line English summary. Never fatal: with no key or a timeout
 *                            it returns what the pure detector knows, and the original text is always kept verbatim.
 *   multilingualClassify     keyword fallback for Sinhala / Tamil / Singlish when no AI answered.
 *   translationSection       the issue-body block that carries the translation (marker for the fix agent).
 *   withTranslation(issue)   fix-agent side: an older or untranslated issue gets its translation added lazily, so the
 *                            English routers read it.
 *
 * HONESTY: a translation is a machine reading. The block says so, always shows the owner's own words first, and the
 * fix agent is told to trust the original when the two differ.
 * One local import (the charter); the AI call is injectable (`chatImpl`) so tests never touch the network.
 * ===========================================================================*/

import { withCharter } from './wf-charter.mjs';

export const TRANSLATION_MARKER = 'wf-translation';
const MARKER_RE = new RegExp('<!--\\s*' + TRANSLATION_MARKER + '\\b');

/** Writing systems by Unicode range. First match with the most letters wins. */
const SCRIPTS = [
    ['Sinhala', /[඀-෿]/g],
    ['Tamil', /[஀-௿]/g],
    ['Hindi/Devanagari', /[ऀ-ॿ]/g],
    ['Bengali', /[ঀ-৿]/g],
    ['Arabic/Urdu', /[؀-ۿݐ-ݿ]/g],
    ['Hebrew', /[֐-׿]/g],
    ['Thai', /[฀-๿]/g],
    ['Chinese/Japanese', /[぀-ヿ㐀-鿿]/g],
    ['Korean', /[가-힯ᄀ-ᇿ]/g],
    ['Cyrillic', /[Ѐ-ӿ]/g],
    ['Greek', /[Ͱ-Ͽ]/g],
];

/** Sinhala typed in English letters. Two or more of these in a short report is a strong signal. */
const SINGLISH = new Set(['eka', 'ekak', 'ekata', 'eke', 'mage', 'mata', 'oni', 'ona', 'nathi', 'nethi', 'naha', 'wada', 'wedak',
    'karanna', 'karala', 'kiyala', 'balanna', 'denna', 'danna', 'thiyenawa', 'tiyenawa', 'thiyena', 'hari', 'harima',
    'awul', 'awulak', 'wage', 'wagema', 'puluwan', 'puluwanda', 'thama', 'mokakda', 'mokada', 'meka', 'meke', 'oya',
    'ape', 'eyaa', 'yanawa', 'enawa', 'wenawa', 'wenna', 'hadanna', 'hadala', 'gannawa', 'ganna', 'dapan', 'danawa',
    'penenne', 'pennanne', 'penawa', 'lassana', 'amaru', 'godak', 'poddak', 'tikak', 'ikmanata', 'ikmanin', 'epa', 'ethi']);

/** The most common English words: a report with none of them (and enough words) is probably not English. */
const ENGLISH_COMMON = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'it', 'to', 'of', 'and', 'in', 'on', 'for', 'not', 'this', 'that',
    'i', 'my', 'me', 'you', 'can', 'please', 'when', 'with', 'but', 'be', 'have', 'has', 'do', 'does', 'add', 'fix', 'show', 'there', 'app',
    'page', 'button', 'screen', 'wrong', 'error', 'bug', 'should', 'would', 'too', 'very', 'all', 'how', 'why', 'what', 'no', 'if', 'or']);

const LATIN_ACCENT = /[À-ɏ]/;

function countMatches(text, re) {
    const m = String(text).match(re);
    return m ? m.length : 0;
}

/**
 * @returns {{ code:string, name:string, script:string, english:boolean, romanised:boolean, confidence:'high'|'medium'|'low' }}
 *   english=true means no translation is needed. `code` is a short tag ('en', 'si', 'ta', 'hi', 'si-latn', 'other').
 */
export function detectLanguage(text) {
    const t = String(text == null ? '' : text);
    const letters = countMatches(t, /[\p{L}\p{M}]/gu);
    if (!letters) return { code: 'en', name: 'English', script: 'Latin', english: true, romanised: false, confidence: 'low' };

    let best = null;
    for (const [name, re] of SCRIPTS) {
        const n = countMatches(t, re);
        if (n && (!best || n > best.n)) best = { name, n };
    }
    // A handful of foreign characters in an English sentence (a currency sign, one quoted word) is not a language switch.
    if (best && best.n / letters >= 0.2) {
        const code = { Sinhala: 'si', Tamil: 'ta', 'Hindi/Devanagari': 'hi', Bengali: 'bn', 'Arabic/Urdu': 'ar', Hebrew: 'he', Thai: 'th',
            'Chinese/Japanese': 'zh', Korean: 'ko', Cyrillic: 'ru', Greek: 'el' }[best.name] || 'other';
        return { code, name: best.name === 'Chinese/Japanese' ? 'Chinese or Japanese' : best.name, script: best.name, english: false, romanised: false, confidence: best.n / letters > 0.5 ? 'high' : 'medium' };
    }

    const words = t.toLowerCase().match(/[a-zÀ-ɏ']+/g) || [];
    const sing = words.filter((w) => SINGLISH.has(w)).length;
    const english = words.filter((w) => ENGLISH_COMMON.has(w)).length;
    if (sing >= 2 && sing >= english) return { code: 'si-latn', name: 'Sinhala (typed in English letters)', script: 'Latin', english: false, romanised: true, confidence: sing >= 3 ? 'high' : 'medium' };
    // Another Latin-script language (Spanish, French, German, Indonesian, ...): few English function words in a real sentence.
    if (words.length >= 5 && english / words.length < 0.08) {
        return { code: 'other', name: 'a non-English language', script: 'Latin', english: false, romanised: false, confidence: LATIN_ACCENT.test(t) ? 'medium' : 'low' };
    }
    return { code: 'en', name: 'English', script: 'Latin', english: true, romanised: false, confidence: english >= 2 ? 'high' : 'low' };
}

/** Does this text need the AI to translate it before the English-only routers can read it? */
export function needsTranslation(text) {
    return !detectLanguage(text).english;
}

/* ---------------------------------------------------------------- keyword fallback (no AI) */

const PATTERNS = [
    // security first, then crash, bug, ui, feature: same order as localClassify
    ['security', /මුරපද|හැක්|කාන්දු|පෞද්ගලික|ආරක්ෂා|கடவுச்சொல்|ஹேக்|பாதுகாப்பு|\b(password|hack|leak|mura ?pada|hack una)\b/iu],
    ['crash', /හිරවෙ|හිර වෙ|හිරවුණ|ක්‍රෑෂ්|වහනවා|නොවැඩ|වැසෙනවා|செயலிழ|முடங்க|உறைந்|\b(crash|hang|hang wenawa|hirawenawa|wahenawa|white screen|kalu screen)\b/iu],
    ['bug', /පේන්නේ\s*නෑ|පේන්නෙ\s*නෑ|පේන්නේ\s*නැහැ|නොපෙනේ|වැරදි|වැරැද්ද|වැඩ\s*නෑ|වැඩ\s*නැහැ|වැඩ\s*කරන්නේ\s*නෑ|අවුල්|දෝෂ|பிழை|தவறு|வேலை\s*செய்ய(வில்லை|ல)|\b(penenne naha|penenne na|wada na|wada nathi|wada karanne na|wada nehe|waradi|warade|awul|awulak|error|bug|not working|wrong)\b/iu],
    ['ui', /පෙනුම|ලස්සන|අකුරු|වර්ණ|පාට|ඇඳුම|හැඩය|අතුරු\s*මුහුණත|ලොකුයි|පොඩියි|தோற்றம்|நிறம்|எழுத்து|அழகு|\b(penuma|lassana|akuru|pata|paata|ugly|design|layout|colour|color|font|podi wage|loku wage)\b/iu],
    ['feature', /එකතු\s*කරන්න|අලුත්|ඕනේ|ඕන|හදන්න|ඇතුළත්\s*කරන්න|තියෙන්න\s*ඕනේ|කරන්න\s*පුළුවන්ද|சேர்க்க|புதிய|வேண்டும்|\b(add karanna|aluth|aluth ekak|ona wenawa|oni|hadanna|puluwan nam|puluwanda|please add|feature)\b/iu],
];

/** Type guess for a report in Sinhala, Tamil or Singlish (and any English keyword). `null` when nothing matched. */
export function multilingualClassify(text) {
    const t = String(text == null ? '' : text);
    for (const [type, re] of PATTERNS) if (re.test(t)) return { type, severity: type === 'security' || type === 'crash' ? 'critical' : type === 'bug' ? 'high' : type === 'ui' ? 'medium' : 'low' };
    return null;
}

/* ---------------------------------------------------------------- AI translation */

const TYPES = ['bug', 'crash', 'ui', 'feature', 'security', 'other'];
const MAX_TRANSLATION = 3000;

export function translationPrompt(text, lang) {
    return [
        'You help the owner of a personal-finance web app (WealthFlow) whose feedback may be written in ANY language,',
        'including Sinhala, Tamil, or Sinhala typed in English letters ("Singlish"). Translate the feedback into plain, faithful English',
        'for the developers. Keep every number, amount, date, name and quoted word exactly. Do not add, remove or soften anything.',
        'If the text is already English, copy it.',
        'Detected writing system (a guess): ' + (lang && lang.name ? lang.name : 'unknown'),
        '',
        'Reply with ONLY compact JSON:',
        '{"language":"<name of the language in English>","english":"<faithful English translation>","summary":"<=12 words, English","type":"bug|crash|ui|feature|security|other"}',
        '',
        'Feedback:',
        String(text).slice(0, 4000),
    ].join('\n');
}

function extractFirstJson(raw) {
    const m = String(raw || '').match(/\{[\s\S]*\}/);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
}

/** Validate a model reply; never trust it blindly. */
export function parseTranslation(raw) {
    const j = typeof raw === 'object' && raw ? raw : extractFirstJson(raw);
    if (!j || typeof j.english !== 'string' || !j.english.trim()) return null;
    const english = j.english.replace(/\s+/g, ' ').trim().slice(0, MAX_TRANSLATION);
    return {
        language: String(j.language || '').replace(/[^\p{L}\p{N} ()/-]/gu, '').slice(0, 40),
        english,
        summary: String(j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 120),
        type: TYPES.includes(String(j.type || '').toLowerCase()) ? String(j.type).toLowerCase() : null,
    };
}

/**
 * Understand one piece of feedback. Never throws, never blocks longer than `timeoutMs`.
 * @returns {Promise<{ language:{code:string,name:string,english:boolean,romanised:boolean}, translated:boolean, english:string,
 *   summary:string, type:string|null, via:'none'|'ai'|'keywords', provider?:string }>}
 */
export async function understandFeedback(text, { chatImpl, timeoutMs = 20000, env = process.env } = {}) {
    const lang = detectLanguage(text);
    const base = { language: lang, translated: false, english: '', summary: '', type: null, via: 'none' };
    if (lang.english) return base;

    const kw = multilingualClassify(text);
    if (kw) { base.type = kw.type; base.via = 'keywords'; }

    let chatFn = chatImpl;
    try {
        if (!chatFn) chatFn = (await import('./wf-llm-router.mjs')).chat;
    } catch { return base; }

    let timer;
    try {
        const res = await Promise.race([
            chatFn({ prompt: translationPrompt(text, lang), system: withCharter('You are a precise translator. Output JSON only.', 'translate'), maxTokens: 700, temperature: 0, timeoutMs: Math.max(5000, timeoutMs - 2000), env }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('translation timed out')), timeoutMs); if (timer.unref) timer.unref(); }),
        ]);
        const parsed = parseTranslation(res && res.text !== undefined ? res.text : res);
        if (!parsed) return base;
        return {
            language: { ...lang, name: parsed.language || lang.name },
            translated: true, english: parsed.english, summary: parsed.summary, type: parsed.type || base.type, via: 'ai',
            provider: res && res.provider,
        };
    } catch {
        return base;
    } finally { clearTimeout(timer); }
}

/* ---------------------------------------------------------------- issue text */

export function hasTranslation(body) { return MARKER_RE.test(String(body || '')); }

/** The block put into the issue body, or '' when the report is English. */
export function translationSection(u) {
    if (!u || (u.language && u.language.english)) return '';
    const name = (u.language && u.language.name) || 'another language';
    if (!u.translated) {
        return [
            `<!-- ${TRANSLATION_MARKER} status=unavailable -->`,
            '### Language',
            `The owner wrote in **${name}**. No AI translation was available when this was filed, so read the original words above: they are the source of truth.`,
            '',
        ].join('\n');
    }
    return [
        `<!-- ${TRANSLATION_MARKER} status=ok -->`,
        '### English translation (AI)',
        `_The owner wrote in **${name}**. This is a machine translation${u.provider ? ' by ' + u.provider : ''} so every agent can read it. The owner's own words above are the source of truth: if the two ever differ, trust the original._`,
        '',
        '> ' + u.english.replace(/\n/g, '\n> '),
        '',
    ].join('\n');
}

/** Words an English-only router can read: the English summary, or the translation, or nothing. */
export function englishFor(u, text) {
    if (!u || u.language.english) return String(text || '');
    return u.english || '';
}

/**
 * Fix-agent side. An issue in another language that carries no translation (filed before this existed, or when no AI
 * answered) gets one now, appended to the body so roleFor / the lanes read it. Returns the issue unchanged when nothing applies.
 */
export async function withTranslation(issue, opts = {}) {
    const body = String((issue && issue.body) || '');
    if (!issue || hasTranslation(body) && !/status=unavailable/.test(body)) return { issue, status: 'none', note: '' };
    const source = userWords(body) || `${issue.title || ''}\n${body}`.slice(0, 4000);
    const lang = detectLanguage(source);
    if (lang.english) return { issue, status: 'none', note: '' };
    const u = await understandFeedback(source, opts);
    if (!u.translated) return { issue, status: 'untranslated', note: `Report is in ${lang.name}; no AI translation available — routing by keywords.` };
    return {
        issue: { ...issue, body: body + '\n\n' + translationSection(u) },
        status: 'translated',
        note: `Translated from ${u.language.name}${u.provider ? ' by ' + u.provider : ''}.`,
    };
}

/** The owner's quoted words from an issue body ("### User feedback" block), or ''. */
export function userWords(body) {
    const m = String(body || '').match(/###\s*User feedback\s*\n((?:>.*(?:\n|$))+)/);
    return m ? m[1].replace(/^>\s?/gm, '').trim() : '';
}
