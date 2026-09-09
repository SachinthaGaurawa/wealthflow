/* =============================================================================
 * test/money_input_test.js — 2,000 while you are still typing it
 * -----------------------------------------------------------------------------
 * The owner: "typing 2000 must instantly become 2,000 in EVERY amount input."
 *
 * The rule was never wrong. WHERE it applied was: it was attached element by
 * element by a DOM walk, so every field drawn afterwards — every modal, every
 * table row, the card-reconcile amount cells, the past-months confirmation
 * panel — carried the class, looked identical, and behaved like a plain text
 * box. Four money fields never carried the class at all.
 *
 * Two things are proved here, and they are different things:
 *
 *   THE RULE — typed() is driven a character at a time, the way a person types,
 *   including into the middle of an existing number, because the caret is what
 *   makes or breaks a live formatter. A formatter that jumps the caret to the
 *   end on every keystroke is worse than no formatter.
 *
 *   THE REACH — install() is run against a hand-built document, and a field
 *   created AFTER the install is typed into. That is the actual bug: a listener
 *   that only knows about elements that existed when it ran.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    typed, amountOf, settled, editing, install, MONEY_CLASS, CENTS_CLASS,
} from '../wealthflow-money-input.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** Type a string into an empty field one character at a time, as a person does. */
function typeOut(chars) {
    let value = '';
    let caret = 0;
    for (const ch of chars) {
        value = value.slice(0, caret) + ch + value.slice(caret);
        caret += 1;
        const out = typed(value, caret);
        value = out.value; caret = out.caret;
    }
    return { value, caret };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('what the field says while it is being typed into', () => {
    it('THE COMPLAINT: 2000 becomes 2,000', () => {
        expect(typeOut('2000').value).toBe('2,000');
    });

    it('and it groups at every width, from the first keystroke', () => {
        expect(typeOut('2').value).toBe('2');
        expect(typeOut('20').value).toBe('20');
        expect(typeOut('200').value).toBe('200');
        expect(typeOut('2000').value).toBe('2,000');
        expect(typeOut('20000').value).toBe('20,000');
        expect(typeOut('2000000').value).toBe('2,000,000');
    });

    it('decimals survive, and stop at two', () => {
        expect(typeOut('1234.5').value).toBe('1,234.5');
        expect(typeOut('1234.56').value).toBe('1,234.56');
        expect(typeOut('1234.5678').value).toBe('1,234.56');
    });

    it('a second dot is ignored, not obeyed', () => {
        expect(typeOut('1.2.3').value).toBe('1.23');
    });

    it('letters and currency symbols never reach the field', () => {
        expect(typed('LKR 2000abc', 11).value).toBe('2,000');
    });

    it('THE CARET STAYS WHERE THE TYPING IS', () => {
        /* The whole reason this is hard. Rewriting the value moves the caret to
         * the end, so editing the middle of 1,234,567 throws you to the end on
         * every keystroke. */
        expect(typeOut('1234567').caret).toBe(9);       // "1,234,567"
        // insert a 9 after the leading 1 of "1,234" -> "19,234", caret after the 9
        const out = typed('19,234', 2);
        expect(out.value).toBe('19,234');
        expect(out.caret).toBe(2);
    });

    it('typing a dot moves the caret past it instead of snapping back', () => {
        const out = typed('1234.', 5);
        expect(out.value).toBe('1,234.');
        expect(out.value.slice(out.caret)).toBe('');
    });

    it('an empty field stays empty — it never invents a zero', () => {
        expect(typed('', 0).value).toBe('');
        expect(settled('', 2)).toBe('');
        expect(editing('')).toBe('');
    });

    it('NEVER LOSES A DIGIT, whatever is typed at it', () => {
        fc.assert(fc.property(
            fc.string({ maxLength: 24 }), fc.nat(30),
            (raw, caret) => {
                const out = typed(raw, caret);
                const inDigits = (raw.match(/\d/g) || []).join('');
                const outDigits = (out.value.match(/\d/g) || []).join('');
                /* Everything that survives cleaning is kept in order; only the
                 * third decimal onward is dropped, and only ever from the end. */
                expect(inDigits.startsWith(outDigits) || inDigits === outDigits).toBe(true);
                expect(out.caret).toBeGreaterThanOrEqual(0);
                expect(out.caret).toBeLessThanOrEqual(out.value.length);
            },
        ), { numRuns: runs(300) });
    });

    it('formatting an already-formatted value changes nothing', () => {
        fc.assert(fc.property(fc.string({ maxLength: 20 }), (raw) => {
            const once = typed(raw, raw.length);
            const twice = typed(once.value, once.caret);
            expect(twice.value).toBe(once.value);
        }), { numRuns: runs(200) });
    });

    it('never throws, on anything', () => {
        for (const bad of [null, undefined, 0, {}, [], NaN]) {
            expect(() => typed(bad, bad)).not.toThrow();
        }
    });
});

describe('what the field says when the caret arrives and leaves', () => {
    it('THE SEPARATORS STAY ON FOCUS, which they did not used to', () => {
        /* The old handler replaced "350,000.00" with "350000" on focus — so the
         * one moment the owner is looking at the field was the one moment it
         * had no separators, the exact opposite of what was asked for. */
        expect(editing('350,000.00')).toBe('350,000');
        expect(editing('1,234.56')).toBe('1,234.56');
    });

    it('settles to the canonical form when the caret leaves', () => {
        expect(settled('2000', 2)).toBe('2,000.00');
        expect(settled('2,000.5', 2)).toBe('2,000.50');
        expect(settled('2000', 0)).toBe('2,000');       // the "round amounts" preference
    });

    it('reads the number back out of any of those shapes', () => {
        expect(amountOf('1,234.56')).toBe(1234.56);
        expect(amountOf('')).toBe(0);
        expect(amountOf('nonsense')).toBe(0);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE REACH — the actual defect
 * ═══════════════════════════════════════════════════════════════════════════*/
function fakeDoc() {
    const handlers = {};
    return {
        addEventListener(type, fn, capture) { (handlers[type] = handlers[type] || []).push({ fn, capture }); },
        removeEventListener(type, fn) {
            handlers[type] = (handlers[type] || []).filter((h) => h.fn !== fn);
        },
        fire(type, target) { (handlers[type] || []).forEach((h) => h.fn({ target })); },
        count(type) { return (handlers[type] || []).length; },
    };
}
function fakeField(classes, value = '') {
    const set = new Set(classes);
    return {
        value,
        selectionStart: value.length,
        classList: { contains: (c) => set.has(c), add: (c) => set.add(c) },
        setSelectionRange(a) { this.selectionStart = a; },
    };
}

describe('a field created after the install is still a money field', () => {
    it('THE BUG: typing into a field that did not exist at install time formats it', () => {
        const doc = fakeDoc();
        install({ doc });
        /* The modal opens NOW, a minute after the page loaded. Under the old
         * per-element attachment this field behaved like a plain text box. */
        const later = fakeField([MONEY_CLASS], '2000');
        doc.fire('input', later);
        expect(later.value).toBe('2,000');
    });

    it('a field that is not money is never touched', () => {
        const doc = fakeDoc();
        install({ doc });
        const rate = fakeField(['fi'], '2000');
        doc.fire('input', rate);
        expect(rate.value, 'a percentage or a term in months must not be grouped').toBe('2000');
    });

    it('focus keeps the grouping, blur settles it', () => {
        const doc = fakeDoc();
        install({ doc, decimalsFor: () => 2 });
        const f = fakeField([MONEY_CLASS], '350,000.00');
        doc.fire('focusin', f);
        expect(f.value).toBe('350,000');
        doc.fire('focusout', f);
        expect(f.value).toBe('350,000.00');
    });

    it('a cents field settles to two decimals whatever the preference says', () => {
        const doc = fakeDoc();
        install({ doc, decimalsFor: () => 0 });          // "round amounts" is on
        const cents = fakeField([MONEY_CLASS, CENTS_CLASS], '20000');
        const plain = fakeField([MONEY_CLASS], '20000');
        doc.fire('focusout', cents);
        doc.fire('focusout', plain);
        expect(cents.value).toBe('20,000.00');
        expect(plain.value).toBe('20,000');
    });

    it('installing twice does not double-handle a keystroke', () => {
        const doc = fakeDoc();
        install({ doc }); install({ doc }); install({ doc });
        expect(doc.count('input')).toBe(1);
    });

    it('uninstall removes exactly what it added', () => {
        const doc = fakeDoc();
        const off = install({ doc });
        off();
        expect(doc.count('input')).toBe(0);
        expect(doc.count('focusin')).toBe(0);
        expect(doc.count('focusout')).toBe(0);
    });

    it('survives a document that cannot do selection ranges', () => {
        const doc = fakeDoc();
        install({ doc });
        const odd = fakeField([MONEY_CLASS], '2000');
        odd.setSelectionRange = () => { throw new Error('not supported on this input type'); };
        expect(() => doc.fire('input', odd)).not.toThrow();
        expect(odd.value).toBe('2,000');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PAGE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the page uses it, and every amount field is marked', () => {
    it('the module is loaded and installed', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-money-input.js"></script>');
        expect(HTML).toContain('window.WFMoneyInput.install({');
        /* Installed on parse AND after the deferred modules run, because this
         * inline script executes before a type="module" one does. */
        expect(HTML).toContain("document.addEventListener('DOMContentLoaded', _installMoneyInputs);");
    });

    it('the per-element attachment is gone', () => {
        /* It is what made a field's behaviour depend on when it was created. */
        expect(HTML).not.toContain("document.querySelectorAll('.money-input').forEach");
        expect(HTML).not.toContain('inp._wfMoneyAttached');
    });

    it('THE FOUR THAT NEVER HAD THE CLASS now have it', () => {
        for (const id of ['_pw_principal', '_db_amount', '_ev_amount']) {
            const at = HTML.indexOf('id="' + id + '"');
            expect(at, id + ' is gone from the page').toBeGreaterThan(-1);
            expect(HTML.slice(Math.max(0, at - 120), at)).toContain('money-input');
        }
        expect(HTML).toContain('class="pm-amount money-input"');
    });

    it('and every decimal amount field carries it — except the one that is a percentage', () => {
        const tags = HTML.match(/<input\b[^>]*>/gs) || [];
        const missing = tags.filter((t) => !t.includes('money-input') && t.includes('inputmode="decimal"'));
        /* Both are monthly interest RATES — the one on a pawn ticket and the
         * one on its renewal. Grouping a percentage would be wrong, so each is
         * named here rather than quietly excluded by a pattern that would also
         * excuse the next real money field somebody forgets. */
        const ids = missing.map((t) => (/id="([^"]+)"/.exec(t) || [])[1]).sort();
        expect(ids).toEqual(['_pw_rate', '_px_rate']);
    });

    it('the numpad filter is delegated too, so it cannot stack listeners', () => {
        /* The old one attached a fresh listener to every numpad field on every
         * call, so opening the lock screen five times left five on each. */
        expect(HTML).not.toContain("document.querySelectorAll('.auth-numpad-only').forEach");
        expect(HTML).toContain("classList.contains('auth-numpad-only')");
    });
});
