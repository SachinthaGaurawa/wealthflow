/* =============================================================================
 * wealthflow-money-input.js — 2000 becomes 2,000 while you are still typing
 * -----------------------------------------------------------------------------
 * THE COMPLAINT: "typing 2000 must instantly become 2,000 in EVERY amount
 * input." The rule already existed and had been correct for a long time. What
 * was wrong was WHERE it applied, and it is this repository's standing defect:
 * a facility wired to some callers.
 *
 *   • It was attached per element by initMoneyInputs(), which walks the DOM
 *     once. Every field drawn afterwards — every modal, every table row, the
 *     card-reconcile amount cells, the past-months confirmation panel — had the
 *     class, looked identical, and behaved like a plain text box, because
 *     nothing had walked the DOM since it was created.
 *
 *   • Four money fields never had the class at all: the pawn principal, the
 *     debtor amount, the debtor-event amount and the past-month amount.
 *
 * So the attachment moves to the document. ONE `input` listener, one `focusin`,
 * one `focusout`, matched by class at event time — a field created in the next
 * second is covered by the listener that was installed a minute ago, and the
 * next money field somebody adds is covered without them knowing this file
 * exists. There is nothing left to remember to call.
 *
 * WHY THE CARET LOGIC IS THE HARD PART. Rewriting the value moves the caret to
 * the end, so typing a digit in the middle of "1,234,567" throws you to the
 * end of the field on every keystroke. typed() counts the digits and dots to
 * the left of the caret, reformats, then puts the caret back after the same
 * number of digits and dots. Commas are formatting and are deliberately not
 * counted — otherwise inserting one would drag the caret sideways.
 *
 * WHAT IT WILL NOT DO. It never rounds, never drops a digit that was typed, and
 * never rewrites a field that is not marked as money. A percentage box, a term
 * in months and a day-of-month are NOT money and grouping them would be wrong;
 * they are matched by nothing here.
 *
 * Pure except install(), which is the only part that touches a DOM.
 * test/money_input_test.js drives typed() character by character.
 * ===========================================================================*/

/** The class that says "this is an amount". */
export const MONEY_CLASS = 'money-input';
/** Two decimals, always — a credit-card payment is 20,000.00 and not 20,000. */
export const CENTS_CLASS = 'money-cents';

const MAX_DECIMALS = 2;

/**
 * What the field should say, and where the caret should be, after a keystroke.
 *
 * @param {string} value   the field's value right now, mid-edit
 * @param {number} caret   selectionStart right now
 * @returns {{value: string, caret: number}}
 */
export function typed(value, caret) {
    const old = String(value == null ? '' : value);
    const at = Math.max(0, Math.min(old.length, Number.isFinite(+caret) ? Math.floor(+caret) : old.length));

    /* Digits and dots to the left of the caret. The dot is counted so that
     * typing "." moves the caret past it instead of snapping back to the digit
     * count; commas are not, because they are inserted by this function. */
    const before = (old.slice(0, at).match(/[\d.]/g) || []).length;

    const cleaned = old.replace(/[^0-9.]/g, '');
    const firstDot = cleaned.indexOf('.');
    /* Everything after the FIRST dot loses its dots. "1.2.3" is one number
     * being typed badly, not three. */
    const one = firstDot === -1
        ? cleaned
        : cleaned.slice(0, firstDot + 1) + cleaned.slice(firstDot + 1).replace(/\./g, '');

    const parts = one.split('.');
    const int = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const dec = parts.length > 1 ? '.' + parts[1].slice(0, MAX_DECIMALS) : '';
    const out = int + dec;

    let put = out.length;
    let counted = 0;
    for (let i = 0; i < out.length; i += 1) {
        if (counted >= before) { put = i; break; }
        if (/[\d.]/.test(out[i])) counted += 1;
    }
    return { value: out, caret: put };
}

/** The number behind a formatted field. The app's parseMoney, without a DOM. */
export function amountOf(value) {
    const n = parseFloat(String(value == null ? '' : value).replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
}

/**
 * What a field shows once the caret leaves it.
 *
 * `digits` is how many decimals to force: 2 for a cents field, or whatever the
 * app's display preference says. An EMPTY field stays empty — writing "0.00"
 * into a box the owner deliberately cleared is the app inventing a figure.
 */
export function settled(value, digits) {
    const raw = String(value == null ? '' : value).trim();
    if (raw === '') return '';
    const n = amountOf(raw);
    const d = Number.isFinite(+digits) ? Math.max(0, Math.min(4, Math.floor(+digits))) : 2;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

/**
 * What a field shows when the caret ARRIVES.
 *
 * THE SEPARATORS STAY. The old handler replaced "350,000.00" with "350000" on
 * focus, so the one moment the owner is actually looking at the field was the
 * one moment it had no separators in it — the opposite of what was asked for.
 * The trailing ".00" goes, because ".00" is display and gets in the way of
 * typing; the grouping is what makes the number readable and it stays.
 */
export function editing(value) {
    const raw = String(value == null ? '' : value).trim();
    if (raw === '') return '';
    const n = amountOf(raw);
    if (!n) return raw === '0' ? '0' : '';
    const whole = Math.trunc(Math.abs(n)) === Math.abs(n);
    return n.toLocaleString('en-US', {
        minimumFractionDigits: 0,
        maximumFractionDigits: whole ? 0 : MAX_DECIMALS,
    });
}

const isMoney = (el) => !!(el && el.classList && el.classList.contains(MONEY_CLASS));
const wantsCents = (el) => !!(el && el.classList && el.classList.contains(CENTS_CLASS));

/**
 * Bind every money field on the page — including the ones that do not exist yet.
 *
 * `decimalsFor(el)` lets the app decide how many decimals a settled field
 * shows, because that is a display preference this module has no business
 * knowing about. Returns an uninstall function; calling install twice on the
 * same document is a no-op, so a defensive call from a render is harmless.
 */
export function install({ doc, decimalsFor = null } = {}) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.addEventListener) return () => {};
    if (d.__wfMoneyInstalled) return d.__wfMoneyUninstall || (() => {});

    const decimals = (el) => {
        if (wantsCents(el)) return 2;
        if (typeof decimalsFor === 'function') {
            const n = decimalsFor(el);
            if (Number.isFinite(+n)) return +n;
        }
        return 2;
    };

    const onInput = (e) => {
        const el = e.target;
        if (!isMoney(el)) return;
        const out = typed(el.value, el.selectionStart);
        if (out.value !== el.value) el.value = out.value;
        /* Not every input type supports a selection range, and asking throws
         * on some of them rather than returning null. */
        try { el.setSelectionRange(out.caret, out.caret); } catch (_) {}
    };
    const onFocus = (e) => { if (isMoney(e.target)) e.target.value = editing(e.target.value); };
    const onBlur = (e) => {
        const el = e.target;
        if (isMoney(el)) el.value = settled(el.value, decimals(el));
    };

    /* Capture phase. A field inside a component that stops propagation on its
     * own input events would otherwise be silently excluded, which is exactly
     * the "works everywhere except here" defect this replaces. */
    d.addEventListener('input', onInput, true);
    d.addEventListener('focusin', onFocus, true);
    d.addEventListener('focusout', onBlur, true);

    const off = () => {
        d.removeEventListener('input', onInput, true);
        d.removeEventListener('focusin', onFocus, true);
        d.removeEventListener('focusout', onBlur, true);
        d.__wfMoneyInstalled = false;
        d.__wfMoneyUninstall = null;
    };
    d.__wfMoneyInstalled = true;
    d.__wfMoneyUninstall = off;
    return off;
}

const API = { MONEY_CLASS, CENTS_CLASS, typed, amountOf, settled, editing, install };
if (typeof window !== 'undefined') window.WFMoneyInput = API;
export default API;
