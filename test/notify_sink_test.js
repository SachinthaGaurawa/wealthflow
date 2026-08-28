/* =============================================================================
 * test/notify_sink_test.js
 * -----------------------------------------------------------------------------
 * `notify(msg, type)` is the single toast every screen in this app speaks
 * through — 277 call sites at the time of writing. It used to end with:
 *
 *     el.innerHTML = `<span class="notif-ico">${icon}</span><span>${msg}</span>`;
 *
 * so every one of those 277 messages was parsed as part of the page. Almost all
 * of them are literals the repository controls. The ones that are not are the
 * whole problem:
 *
 *   - the receipt scanner reports `result.vendor` and `result.items`, both read
 *     off a photograph by a language model and passed through verbatim;
 *   - the OCR fallbacks report text lifted straight out of an image;
 *   - dozens of handlers report `err.message` from a server or an SDK;
 *   - others report an account name, a goal name, a category — owner-typed
 *     strings that round-trip through cloud sync.
 *
 * Not one call site escaped its argument, and no call site should have had to:
 * a function called `notify` that takes a message is not announcing that it
 * accepts markup. The fix is at the sink, once, where it cannot be forgotten
 * by the next caller — the same reasoning as consensus-review.mjs's "enforcement
 * belongs in code, not prompts".
 *
 * These tests RUN the real function. A grep for `innerHTML` would have passed
 * on a version that built the same string and assigned it through a variable.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const ICONS = fs.readFileSync(path.join(ROOT, 'wealthflow-icons.js'), 'utf8');

/* ── lift the real source ────────────────────────────────────────────────── */

function notifySource() {
    const at = HTML.indexOf("function notify(msg, type = 'success') {");
    expect(at, 'notify() is gone or its signature changed — this suite would pass vacuously')
        .toBeGreaterThan(-1);
    let depth = 0;
    for (let j = HTML.indexOf('{', at); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    throw new Error('notify() never closes');
}

const SRC = notifySource();

it('the extracted body is the whole function, not a fragment', () => {
    /* Brace counting is only as good as its end. An extractor that stopped
     * early would hand every test below a truncated function that quietly
     * proves nothing — three harness bugs in this repository have done exactly
     * that. So: it must end at the close, and it must still contain the last
     * statement of the real body. */
    expect(SRC.trimEnd().endsWith('}')).toBe(true);
    expect(SRC).toContain("el.classList.remove('show')");
});

/* ── a DOM modelled only as far as notify uses it ────────────────────────── */

function harness() {
    const created = [];
    const el = (tag) => {
        const node = {
            tagName: String(tag).toUpperCase(),
            className: '',
            children: [],
            text: null,
            attrs: {},
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return this.attrs[k] ?? null; },
            appendChild(n) { this.children.push(n); return n; },
            remove() {},
            classList: { add() {}, remove() {} },
            style: {},
            set textContent(v) { this.text = String(v); this.children = []; },
            get textContent() { return this.text; },
            /* The canary. Nothing in this function may hand a string to the
             * HTML parser, however it gets there. */
            set innerHTML(v) { throw new Error('notify assigned innerHTML: ' + v); },
        };
        created.push(node);
        return node;
    };

    const host = el('div');
    const iconNodes = [];
    const scope = {
        document: { createElement: el },
        window: {
            WFIconNode(name) { const n = el('svg'); n.icon = name; iconNodes.push(name); return n; },
        },
        $: (id) => (id === 'notifs' ? host : null),
        triggerHaptic() {},
        requestAnimationFrame() {},
        setTimeout() {},
    };
    scope.WFIconNode = scope.window.WFIconNode;

    const make = new Function(
        'document', 'window', '$', 'triggerHaptic', 'requestAnimationFrame', 'setTimeout',
        `let _wfLastNotifMsg = '', _wfLastNotifTs = 0; ${SRC}; return notify;`,
    );
    const notify = make(
        scope.document, scope.window, scope.$, scope.triggerHaptic,
        scope.requestAnimationFrame, scope.setTimeout,
    );
    return { notify, host, created, iconNodes };
}

/* Walk a toast and return everything that is NOT a text node — i.e. everything
 * the parser would have had to build. */
function elementsUnder(node, out = []) {
    for (const c of node.children) { out.push(c); elementsUnder(c, out); }
    return out;
}

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. The message is data
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a toast message can never become part of the page', () => {
    /* Canaries, not exploits: each is a string a receipt, an error, or a synced
     * account label could plausibly carry. What matters is only that none of
     * them produces a node. */
    const hostile = [
        '<img src=x onerror=alert(1)>',
        'Saved <b>Kandy</b> Stores',
        '</span><script>1</script>',
        'A & B < C > D',
        '<svg onload=1>',
    ];

    it.each(hostile)('%s stays literal text', (msg) => {
        const { notify, host } = harness();
        notify(msg, 'success');

        const toast = host.children[0];
        expect(toast, 'nothing was appended to #notifs').toBeTruthy();

        // exactly the two spans the CSS expects — icon, then body
        expect(toast.children.map((c) => c.tagName)).toEqual(['SPAN', 'SPAN']);

        const body = toast.children[1];
        expect(body.text, 'the message was altered on its way in').toBe(msg);
        expect(body.children, 'the message produced elements').toEqual([]);
    });

    it('a message is never handed to the HTML parser by any route', () => {
        /* The `innerHTML` setter above throws. This asserts it did not fire —
         * catching a rewrite that assembles the same string indirectly, which a
         * grep for the word `innerHTML` would miss. */
        const { notify } = harness();
        for (const type of ['success', 'error', 'info', 'warn', 'nonsense']) {
            expect(() => notify('<i>x</i> ' + type, type)).not.toThrow();
        }
    });

    it('survives the values callers actually pass when something went wrong', () => {
        const { notify, host } = harness();
        notify(undefined, 'error');
        notify(null, 'info');
        notify(42, 'success');
        const texts = host.children.map((t) => t.children[1].text);
        expect(texts).toEqual(['', '', '42']);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. The icon is chosen, not derived
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the toast icon', () => {
    it('comes from a fixed table keyed by type, and is a real icon', () => {
        const cases = [['success', 'checkCircle'], ['error', 'x'], ['info', 'info'], ['warn', 'alert']];
        for (const [type, icon] of cases) {
            const { notify, iconNodes } = harness();
            notify('done', type);
            expect(iconNodes, `${type} toast asked for the wrong icon`).toEqual([icon]);
        }
    });

    it("treats 'warning' as 'warn', which is what eleven call sites pass", () => {
        /* `warning` was never a type this function knew. The class became
         * `notif warning`, which no stylesheet rule matches, so the toast lost
         * its coloured border and took the neutral info icon — every one of
         * those eleven was written meaning to warn and looked like a note.
         * Among them the receipt scanner's low-confidence result, which is
         * exactly the case a user most needs flagged. */
        const { notify, host, iconNodes } = harness();
        notify('Confidence low', 'warning');
        expect(iconNodes, 'a warning toast still takes the neutral icon').toEqual(['alert']);
        expect(host.children[0].className, 'notif warning matches no rule in the stylesheet')
            .toBe('notif warn');
    });

    it('the alias is not doing the work of the real type', () => {
        const { notify, host } = harness();
        notify('a', 'warn');
        expect(host.children[0].className).toBe('notif warn');
    });

    it('falls back to info for a type nobody defined', () => {
        const { notify, iconNodes } = harness();
        notify('done', 'whatever');
        expect(iconNodes).toEqual(['info']);
    });

    it('names icons that exist in the icon set', () => {
        for (const icon of ['checkCircle', 'x', 'info', 'alert']) {
            expect(ICONS, `icon "${icon}" is not in wealthflow-icons.js`).toContain(`${icon}:`);
        }
    });

    it('names the SAME icons the runtime already substituted for those emoji', () => {
        /* This is the fact that makes the swap invisible, and it is worth
         * pinning because it is easy to get wrong in both directions.
         *
         * WFIconStripEmoji's observer walks rendered text and replaces known
         * glyphs with icon nodes. Its table already sent the four toast emoji
         * to these four icons, so the shape drawn on screen does not change —
         * only when it is drawn (immediately, rather than after that observer's
         * 120ms debounce) and where it comes from.
         *
         * Measured on main at 2a69b32 by driving the real app: every toast
         * already rendered `wfi-checkCircle` / `wfi-x` / `wfi-info` /
         * `wfi-alert`, each with stroke rgb(226,232,240).
         *
         * If someone later re-points either table, the two disagree and the
         * toast starts drawing something the rest of the app does not. */
        const legacy = { '\u2705': 'checkCircle', '\u274C': 'x', '\u2139\uFE0F': 'info', '\u26A0\uFE0F': 'alert' };
        for (const [glyph, icon] of Object.entries(legacy)) {
            const pair = new RegExp(`'${glyph.replace(/[.*+?^\${}()|[\]\\]/g, '\\$&')}'\\s*:\\s*'${icon}'`);
            expect(pair.test(ICONS), `the legacy table no longer maps that glyph to "${icon}"`).toBe(true);
            expect(SRC, `notify() no longer names "${icon}"`).toContain(`'${icon}'`);
        }
    });

    it('carries no emoji, and does not fall back to one', () => {
        /* The owner's rule is icons, never emoji. The previous table was
         * ✅ ❌ ℹ️ ⚠️ with ℹ️ as the default — four glyphs on every screen in
         * the app. If the icon set has not loaded the toast goes out bare;
         * it does not reach for the character again. */
        const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/u;
        expect(EMOJI.test(SRC), `emoji in notify(): ${SRC.match(EMOJI)}`).toBe(false);
    });

    it('still renders the message when the icon set is missing', () => {
        const make = new Function(
            'document', 'window', '$', 'triggerHaptic', 'requestAnimationFrame', 'setTimeout',
            `let _wfLastNotifMsg = '', _wfLastNotifTs = 0; ${SRC}; return notify;`,
        );
        const children = [];
        const el = () => ({
            className: '', children: [], text: null, attrs: {},
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return this.attrs[k] ?? null; },
            appendChild(n) { this.children.push(n); return n; },
            classList: { add() {}, remove() {} }, style: {},
            set textContent(v) { this.text = String(v); },
            get textContent() { return this.text; },
            set innerHTML(v) { throw new Error('innerHTML: ' + v); },
        });
        const host = { children, appendChild(n) { children.push(n); } };
        const notify = make(
            { createElement: el }, {} /* no WFIconNode */, () => host,
            () => {}, () => {}, () => {},
        );
        expect(() => notify('Saved', 'success')).not.toThrow();
        /* One child, not two: no empty icon slot is left behind. A blank span
         * inside a flex row with `gap: 9px` is a visible notch of dead space
         * before the text — the reviewer on #160 read the fallback branch as
         * "the user sees a toast with no icon", and an orphan gap is the part
         * of that reading which was fair. */
        expect(children[0].children.length, 'an empty icon slot was left in the toast').toBe(1);
        expect(children[0].children[0].text).toBe('Saved');
    });

    it('is tinted to match its own left border, not left as body text', () => {
        /* The glyphs this replaced were coloured — a green tick, a red cross,
         * an amber triangle — and are named here rather than spelled, so that
         * a file arguing against emoji does not carry a row of them.
         * An inline SVG inherits `currentColor`, so dropping the emoji without
         * saying anything would have made a success and an error toast differ
         * by a 3px stripe and nothing else. Named per type, because a spot
         * check on two of the four is how a missing rule survives. */
        for (const [type, token] of [
            ['success', '--green'], ['error', '--red'],
            ['info', '--blue'], ['warn', '--accent'],
        ]) {
            const rule = new RegExp(`\\.notif\\.${type}\\s+\\.notif-ico\\s*\\{[^}]*var\\(${token}\\)`);
            expect(rule.test(HTML), `a ${type} toast's icon has no colour of its own`).toBe(true);
        }
    });

    it('keeps the class the toast stylesheet targets', () => {
        const { notify, host } = harness();
        notify('Saved', 'warn');
        expect(host.children[0].className).toBe('notif warn');
        expect(host.children[0].children[0].className).toBe('notif-ico');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. What the rewrite must not have broken
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the toast is announced, not only drawn', () => {
    /* Two hundred and seventy-seven toasts and not one of them was announced:
     * the element carried no role and no live region, so a screen reader said
     * nothing when a transfer saved or a scan failed. The icon and the border
     * are both purely visual; this is the channel that does not depend on
     * seeing the screen at all. */
    it('an error interrupts, everything else waits its turn', () => {
        const { notify, host } = harness();
        notify('Could not save', 'error');
        notify('Saved', 'success');
        notify('Heads up', 'warn');
        expect(host.children.map((t) => t.getAttribute('role')))
            .toEqual(['alert', 'status', 'status']);
        expect(host.children.map((t) => t.getAttribute('aria-live')))
            .toEqual(['assertive', 'polite', 'polite']);
    });

    it('announces the message itself, since the icon carries no text', () => {
        /* WFIconNode produces an aria-hidden SVG, so the span holding it
         * contributes nothing to the accessible name. Everything a listener
         * gets comes from the message node. */
        const { notify, host } = harness();
        notify('Transfer saved', 'success');
        expect(host.children[0].children[1].text).toBe('Transfer saved');
    });
});

describe('the flood guard', () => {
    it('still drops an identical toast repeated inside the window', () => {
        const { notify, host } = harness();
        notify('Saved', 'success');
        notify('Saved', 'success');
        expect(host.children.length, 'the de-dupe was lost in the rewrite').toBe(1);
    });

    it('does not drop a different message', () => {
        const { notify, host } = harness();
        notify('Saved', 'success');
        notify('Deleted', 'success');
        expect(host.children.length).toBe(2);
    });
});

describe('no call site was passing markup that this change would now show raw', () => {
    /* The rewrite is only safe because every caller passes plain text. This
     * proves it rather than assuming it: if someone later writes
     * notify(`<b>${n}</b> saved`), their tag would appear literally on screen,
     * and they should find out here instead of there. */
    it('no notify(...) literal contains a tag', () => {
        const calls = HTML.match(/notify\(\s*(`[^`]*`|'[^']*'|"[^"]*")/g) || [];
        expect(calls.length, 'the call-site scan found nothing — it is not testing anything')
            .toBeGreaterThan(100);
        const withTags = calls.filter((c) => /<\/?[a-zA-Z][a-zA-Z0-9]*[\s/>]/.test(c));
        expect(withTags, `these call sites pass markup: ${withTags.join(' | ')}`).toEqual([]);
    });
});
