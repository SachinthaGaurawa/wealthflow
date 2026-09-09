/* =============================================================================
 * test/password_shapes_test.js — the date of birth with slashes in it
 * -----------------------------------------------------------------------------
 * THE OWNER'S QUESTION:
 *
 *   "Why didn't you anticipate that a user's password might be a Date of Birth
 *    with slashes (DD/MM/YYYY)?"
 *
 * Two answers, and both are fixed here.
 *
 *   1. The derivation only ever produced bare digits. wealthflow-intelligence.js
 *      built DDMMYYYY, YYYYMMDD, DDMMYY, YYMMDD, MMDDYYYY, DDMM and YYYYDDMM by
 *      hand — seven forms of one date, not one with a separator. A bank whose
 *      letter says "your password is your date of birth, e.g. 07/07/1993" was
 *      never going to be opened.
 *
 *   2. The vault only ever asked for an OPAQUE STRING, so 07/07/1993 and
 *      07071993 were two different secrets as far as it could tell. Declaring
 *      the kind is what makes them one secret written two ways.
 *
 * The rule that must not be broken by any of this: WHAT THE OWNER TYPED IS
 * ALWAYS TRIED. A mistyped dropdown may add wrong guesses; it may never remove
 * the one string they were sure of.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    PW_KIND, KIND_OPTIONS, DATE_FORMATS, DEFAULT_DATE_FORMAT,
    dateParts, renderDate, expand, expandAll, describe as describeEntry,
} from '../wealthflow-password-shapes.js';
import { candidatesFor, normaliseEntry } from '../wealthflow-vault.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const INTEL = fs.readFileSync(path.join(ROOT, 'wealthflow-intelligence.js'), 'utf8');

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT WAS ASKED ABOUT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a date of birth, written every way a bank writes it', () => {
    const dob = { password: '1993-07-07', kind: PW_KIND.BIRTHDAY, format: 'DD/MM/YYYY' };

    it('THE COMPLAINT: the slashed form is generated', () => {
        expect(expand(dob)).toContain('07/07/1993');
    });

    it('and so is every other separator, which none of them used to be', () => {
        const out = expand(dob);
        for (const want of ['07-07-1993', '07.07.1993', '1993-07-07', '1993/07/07', '07/07/93']) {
            expect(out, want + ' is not offered').toContain(want);
        }
    });

    it('the bare-digit forms the old code produced are all still there', () => {
        /* A fix that adds separators and loses the digits would trade one set
         * of unopenable statements for another. */
        const out = expand(dob);
        for (const want of ['07071993', '19930707', '070793', '930707', '0707']) {
            expect(out).toContain(want);
        }
    });

    it('THE DECLARED FORM IS FIRST, because that is the one the bank printed', () => {
        expect(expand({ ...dob, format: 'YYYYMMDD' })[0]).toBe('19930707');
        expect(expand({ ...dob, format: 'DD-MM-YYYY' })[0]).toBe('07-07-1993');
        expect(expand(dob)[0]).toBe('07/07/1993');
    });

    it('reads the date out of whatever the owner typed', () => {
        for (const written of ['1993-07-07', '07/07/1993', '07.07.1993', '19930707', '07071993']) {
            expect(dateParts(written), written + ' was not understood').toEqual(
                { Y: '1993', M: '07', D: '07', yy: '93' },
            );
        }
    });

    it('refuses a date that does not exist rather than inventing eleven wrong forms', () => {
        expect(dateParts('31/02/1993')).toBe(null);
        expect(dateParts('1993-13-01')).toBe(null);
        expect(dateParts('not a date')).toBe(null);
        expect(dateParts('')).toBe(null);
    });

    it('an unparseable birthday still keeps what was typed', () => {
        /* Losing a password the owner saved is the worst outcome available. */
        expect(expand({ password: 'my birthday', kind: PW_KIND.BIRTHDAY })).toEqual(['my birthday']);
    });

    it('every format in the dropdown renders, and no two labels collide', () => {
        const ids = DATE_FORMATS.map((f) => f.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const f of DATE_FORMATS) {
            expect(renderDate('1993-07-07', f.id), f.id).not.toBe('');
            expect(f.example, f.id + ' example does not match its own rule')
                .toBe(renderDate('1993-07-07', f.id));
        }
        expect(ids).toContain(DEFAULT_DATE_FORMAT);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER FOUR KINDS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the shapes of the other things banks use', () => {
    it('a NIC, with and without the trailing letter', () => {
        const out = expand({ password: '931885123V', kind: PW_KIND.NIC });
        expect(out).toContain('931885123V');
        expect(out).toContain('931885123v');
        expect(out).toContain('931885123');
        expect(out).toContain('5123');          // the last four
    });

    it('a NIC typed without the letter gains it', () => {
        const out = expand({ password: '931885123', kind: PW_KIND.NIC });
        expect(out).toContain('931885123V');
    });

    it('a mobile number, local and international', () => {
        const out = expand({ password: '0771234567', kind: PW_KIND.MOBILE });
        expect(out).toContain('0771234567');
        expect(out).toContain('771234567');
        expect(out).toContain('94771234567');
        expect(out).toContain('4567');
        /* And the same number typed the other way lands on the same set. */
        const intl = expand({ password: '94771234567', kind: PW_KIND.MOBILE });
        expect(intl).toContain('0771234567');
    });

    it('an account number, whole and abbreviated', () => {
        const out = expand({ password: '004-1-002-9-1234567', kind: PW_KIND.ACCOUNT });
        expect(out).toContain('004-1-002-9-1234567');
        expect(out).toContain('00410029 1234567'.replace(/\s/g, ''));
        expect(out).toContain('4567');
    });

    it('OTHER DERIVES NOTHING, deliberately', () => {
        /* A password the bank simply chose has no structure to exploit, and
         * inventing variations would push wrong guesses ahead of the right
         * answer in the list. */
        expect(expand({ password: 'Hunter2!', kind: PW_KIND.OTHER })).toEqual(['Hunter2!']);
        expect(expand({ password: 'Hunter2!' })).toEqual(['Hunter2!']);   // no kind at all
    });

    it('the dropdown offers exactly the kinds the module can expand', () => {
        const offered = KIND_OPTIONS.map((o) => o.id).sort();
        expect(offered).toEqual(Object.values(PW_KIND).sort());
        /* "A password the bank gave me" is first: it is the commonest case and
         * the one that must never be reordered behind a guess. */
        expect(KIND_OPTIONS[0].id).toBe(PW_KIND.OTHER);
    });
});

describe('the rule none of this may break', () => {
    it('WHAT THE OWNER TYPED IS ALWAYS IN THE LIST, whatever the kind says', () => {
        fc.assert(fc.property(
            fc.string({ minLength: 1, maxLength: 24 }),
            fc.constantFrom(...Object.values(PW_KIND), 'nonsense', '', null),
            (password, kind) => {
                if (!password.trim() && !password) return;
                const out = expand({ password, kind });
                expect(out).toContain(password);
            },
        ), { numRuns: runs(400) });
    });

    it('never returns a duplicate, and never an empty string', () => {
        fc.assert(fc.property(
            fc.string({ maxLength: 20 }), fc.constantFrom(...Object.values(PW_KIND)),
            (password, kind) => {
                const out = expand({ password, kind });
                expect(new Set(out).size).toBe(out.length);
                expect(out.every((x) => typeof x === 'string' && x.length > 0)).toBe(true);
            },
        ), { numRuns: runs(300) });
    });

    it('an empty password produces nothing at all', () => {
        expect(expand({ password: '', kind: PW_KIND.BIRTHDAY })).toEqual([]);
        expect(expand(null)).toEqual([]);
        expect(expandAll(null)).toEqual([]);
    });

    it('never throws', () => {
        for (const bad of [null, undefined, 0, '', [], { password: {} }, { password: 5, kind: 7 }]) {
            expect(() => expand(bad)).not.toThrow();
            expect(() => describeEntry(bad)).not.toThrow();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WIRING — a shape nothing tries is not a fix
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the expansions actually reach a locked PDF', () => {
    it('the vault carries the kind and the format through its store', () => {
        const e = normaliseEntry({ bank: 'HNB', password: '07/07/1993', kind: 'birthday', format: 'DD/MM/YYYY' });
        expect(e.kind).toBe('birthday');
        expect(e.format).toBe('DD/MM/YYYY');
    });

    it('an entry saved before these fields existed still behaves exactly as before', () => {
        const e = normaliseEntry({ bank: 'HNB', password: 'Hunter2!' });
        expect(e.kind).toBe('');
        expect(candidatesFor('HNB', [e])).toEqual(['Hunter2!']);
    });

    it('THE END TO END: a birthday in the vault becomes eleven candidates', () => {
        const list = [{ bank: 'HNB', password: '1993-07-07', kind: 'birthday', format: 'DD/MM/YYYY' }];
        const out = candidatesFor('HNB', list);
        expect(out[0]).toBe('07/07/1993');
        expect(out).toContain('19930707');
        expect(out.length).toBeGreaterThan(8);
    });

    it('and the matching bank still comes before the others', () => {
        const out = candidatesFor('DFCC', [
            { bank: 'HNB', password: 'hnb-one' },
            { bank: 'DFCC', password: 'dfcc-one' },
        ]);
        expect(out[0]).toBe('dfcc-one');
    });

    it('the ID vault stopped hand-building date forms and asks the module', () => {
        /* Two hand-maintained copies of "how a date can be written" is how one
         * of them ends up without the slashes — which is what happened. */
        expect(INTEL).not.toContain('push(D + M + Y);');
        expect(INTEL).toContain("window.WFPwShapes.expand({ password: v.dob, kind: 'birthday' })");
    });
});

describe('the vault screen asks the question', () => {
    it('the module is loaded before the two files that read it', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-password-shapes.js"></script>');
        /* The TAGS, not the prose. A comment naming a file is not a load of
         * it, and matching the comment made this assertion measure nothing. */
        expect(HTML.indexOf('<script type="module" src="wealthflow-password-shapes.js">'))
            .toBeLessThan(HTML.indexOf('<script src="wealthflow-intelligence.js"'));
    });

    it('there is a kind dropdown, and a format dropdown that only birthdays see', () => {
        expect(HTML).toContain('_bv_kind');
        expect(HTML).toContain('_bv_fmt');
        expect(HTML).toContain('S.KIND_OPTIONS');
        expect(HTML).toContain('S.DATE_FORMATS');
        /* Hidden unless the kind is a birthday: a format question about a
         * password the bank chose has no answer, and a dropdown that is usually
         * meaningless is how a form starts being ignored. */
        expect(HTML).toContain("fmtEl.style.display = (kindEl.value === (S ? S.PW_KIND.BIRTHDAY : 'birthday')) ? '' : 'none';");
    });

    it('the password can be shown, and the button says which state it is in', () => {
        expect(HTML).toContain('_bv_eye');
        expect(HTML).toContain('aria-label="Show or hide this password"');
        expect(HTML).toContain("ev.currentTarget.setAttribute('aria-pressed', showing ? 'true' : 'false');");
    });

    it('the screen says what will be tried, so the dropdown is not a guess', () => {
        expect(HTML).toContain('_bv_says');
        expect(HTML).toContain('S.describe(rows[i])');
    });

    it('a new row starts with the two fields set, not undefined', () => {
        expect(HTML).toContain("rows.push({ bank: '', label: '', password: '', kind:");
    });
});
