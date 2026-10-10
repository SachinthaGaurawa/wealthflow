/* =============================================================================
 * test/tenant_lang_test.js — the statement page in Sinhala
 * -----------------------------------------------------------------------------
 * The page's words are looked up by their English text, so the risk is a sentence that was added in
 * English and never translated (the person would see English in the middle of a Sinhala page) or a
 * server sentence that was reworded (the lookup would quietly stop matching). Both are pinned here by
 * reading the sources, so adding a sentence without its translation fails a test instead of reaching a person.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { SI, LANGS, LANG_BUTTON, detectLang, makeT, fill, noteText } from '../tenant-lang.js';
import { MSG } from '../tenant-portal.mjs';
globalThis.__WF_TENANT_NO_BOOT = true;
const { COPY } = await import('../tenant-page.js');

// the page and the tools it calls (tenant-tools.js words the day counts and the calendar reminder)
const PAGE = readFileSync(new URL('../tenant-page.js', import.meta.url), 'utf8') + '\n' + readFileSync(new URL('../tenant-tools.js', import.meta.url), 'utf8');
const PDF = readFileSync(new URL('../tenant-pdf.mjs', import.meta.url), 'utf8');
const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, ' ').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n');
const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\\\/g, '\\');

/** Every sentence the page passes to t('...') as a literal, and every screen title it passes to mount('...') (mount translates it for the tab). */
const literals = () => [...strip(PAGE).matchAll(/\b(?:t|mount)\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));

/** The same for the PDF writer: its sentences are looked up in the same table, plus the words it keeps in small tables (how often interest is paid, what a loan movement is, a loan's state). */
const pdfLiterals = () => {
    const out = [...strip(PDF).matchAll(/\bt\(\s*'((?:[^'\\]|\\.)*)'/g)].map((m) => unescape(m[1]));
    for (const table of strip(PDF).matchAll(/\bconst (?:FREQ|LOAN_EVENT|STATUS|TAG) = \{([^}]*)\}/g)) for (const v of table[1].matchAll(/: '([^']*)'/g)) out.push(v[1]);
    return out;
};

describe('choosing a language', () => {
    it('Sinhala only when the browser lists it, anywhere in its preferences', () => {
        expect(detectLang({ languages: ['en-US', 'si-LK'] })).toBe('si');
        expect(detectLang({ languages: ['si'] })).toBe('si');
        expect(detectLang({ language: 'si-LK' })).toBe('si');
        expect(detectLang({ languages: ['SI_lk'] })).toBe('si');
        expect(detectLang({ languages: ['en-GB', 'ta-LK'] })).toBe('en');
        expect(detectLang({ languages: ['sinhalese'] })).toBe('en');             // not the language code
        for (const odd of [null, undefined, {}, 'si', 5, { languages: [] }, { languages: [null] }]) expect(detectLang(odd), String(odd)).toBe('en');
        expect(LANGS).toEqual(['en', 'si']);
    });

    it('the button offers the OTHER language, in its own letters', () => {
        expect(LANG_BUTTON).toEqual({ en: 'සිංහල', si: 'English' });
    });
});

describe('looking words up', () => {
    it('English is the text itself, with its places filled', () => {
        const en = makeT('en');
        expect(en('Sign out')).toBe('Sign out');
        expect(en('This code expires in {t}.', { t: '2:41' })).toBe('This code expires in 2:41.');
        expect(en('Send a new code ({n}s)', { n: 12 })).toBe('Send a new code (12s)');
        expect(en('A sentence nobody wrote')).toBe('A sentence nobody wrote');
    });

    it('Sinhala is looked up by the English text, and a sentence with no entry stays English rather than going blank', () => {
        const si = makeT('si');
        expect(si('Sign out')).toBe(SI['Sign out']);
        expect(si('Download PDF')).toBe('PDF බාගන්න');
        expect(si('This code expires in {t}.', { t: '2:41' })).toBe('මෙම කේතය 2:41 කින් කල් ඉකුත් වේ.');
        expect(si('{n}% a year', { n: 24 })).toBe('වසරකට 24%');
        expect(si('A sentence nobody wrote')).toBe('A sentence nobody wrote');
        expect(si('constructor')).toBe('constructor');                              // a lookup is never a property of Object
        expect(si('__proto__')).toBe('__proto__');
    });

    it('fills only the places it is given, and never prints "undefined"', () => {
        expect(fill('a {x} b {y}', { x: 1 })).toBe('a 1 b {y}');
        expect(fill('no places', { x: 1 })).toBe('no places');
        expect(fill('a {x}', null)).toBe('a {x}');
        expect(fill('a {toString}', {})).toBe('a {toString}');
    });
});

describe('nothing is left untranslated', () => {
    it('every sentence the page translates has a Sinhala entry', () => {
        const wanted = [...new Set(literals())];
        expect(wanted.length).toBeGreaterThan(50);
        const missing = wanted.filter((w) => !Object.prototype.hasOwnProperty.call(SI, w));
        expect(missing).toEqual([]);
    });

    it('every sentence the PDF translates has a Sinhala entry too, so a Sinhala file never has English in the middle of it', () => {
        const wanted = [...new Set(pdfLiterals())];
        expect(wanted.length).toBeGreaterThan(40);
        expect(wanted.filter((w) => !Object.prototype.hasOwnProperty.call(SI, w))).toEqual([]);
    });

    it('so do the page\'s own messages and the server\'s fixed sentences, word for word', () => {
        for (const [key, text] of Object.entries(COPY)) expect(SI[text], `COPY.${key}`).toBeTruthy();
        for (const [key, text] of Object.entries(MSG)) expect(SI[text], `MSG.${key}`).toBeTruthy();
        expect(SI['This service is temporarily unavailable. Please try again later.']).toBeTruthy();
        expect(SI['Too many attempts. Please wait a while and try again.']).toBeTruthy();
    });

    it('so do the table values the page looks up (how often interest is paid, what a loan movement is)', () => {
        for (const v of ['Monthly', 'Every 3 months', 'Yearly', 'Loan paid out', 'Further advance', 'Repayment', 'Light', 'Dark', 'Auto']) {
            expect(PAGE).toContain(`'${v}'`);
            expect(SI[v], v).toBeTruthy();
        }
    });

    it('has no entry that nothing uses (a reworded sentence leaves its old translation behind, silently)', () => {
        const used = new Set([...literals(), ...pdfLiterals(), ...Object.values(COPY), ...Object.values(MSG), 'This service is temporarily unavailable. Please try again later.', 'Too many attempts. Please wait a while and try again.',
            'Monthly', 'Every 3 months', 'Yearly', 'Loan paid out', 'Further advance', 'Repayment', 'Light', 'Dark', 'Auto']);
        const stale = Object.keys(SI).filter((k) => !used.has(k));
        expect(stale).toEqual([]);
    });

    it('keeps every {place} of the English in the Sinhala, and adds none', () => {
        for (const [en, si] of Object.entries(SI)) {
            const places = (text) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
            expect(places(si), en).toBe(places(en));
        }
    });

    it('is Sinhala, not a copy of the English: every entry has Sinhala letters or is a fixed code', () => {
        for (const [en, si] of Object.entries(SI)) {
            if (/[඀-෿]/.test(si)) continue;
            expect(si, en).toMatch(/^PDF|^SWIFT/);
        }
    });

    it('carries no markup and no script: it is only ever put on the page as text, but it should never need to be anything else', () => {
        for (const [en, si] of Object.entries(SI)) { expect(si, en).not.toMatch(/[<>]/); expect(en).not.toMatch(/[<>]/); }
    });
});


describe('the lender\'s note on a bank account in Sinhala', () => {
    const SINHALA = /[\u0D80-\u0DFF]/;
    it('shows the Sinhala note the owner wrote, ahead of anything else', () => {
        expect(noteText({ note: 'Please write your NIC in the payment references', noteSi: 'මගේ සටහන' }, 'si')).toBe('මගේ සටහන');
    });
    it('translates the notes lenders write most, whatever the case or punctuation', () => {
        for (const note of ['PLEASE WRITE YOUR NIC IN THE PAYMENT REFERENCES', 'Please write your NIC in the payment reference.', 'put your N.I.C. number in the reference', 'Write NIC in ref']) {
            const out = noteText({ note }, 'si');
            expect(out, note).toMatch(SINHALA);
            expect(out, note).not.toMatch(/PLEASE|WRITE/i);
        }
        expect(noteText({ note: 'Please send the payment slip on WhatsApp' }, 'si')).toMatch(SINHALA);
        expect(noteText({ note: 'Call me once you have paid' }, 'si')).toMatch(SINHALA);
    });
    it('shows a note it cannot translate exactly as written, and never an empty one', () => {
        expect(noteText({ note: 'Branch closes at 3pm' }, 'si')).toBe('Branch closes at 3pm');
        expect(noteText({ note: '' }, 'si')).toBe('');
        expect(noteText(null, 'si')).toBe('');
    });
    it('leaves English readers with what the owner typed', () => {
        expect(noteText({ note: 'PLEASE WRITE YOUR NIC IN THE PAYMENT REFERENCES', noteSi: 'x' }, 'en')).toBe('PLEASE WRITE YOUR NIC IN THE PAYMENT REFERENCES');
    });
    it('the translator carries its language so the page and the PDF can pick the variant', () => {
        expect(makeT('si').lang).toBe('si');
        expect(makeT('en').lang).toBe('en');
        expect(makeT('fr').lang).toBe('en');
    });
});
