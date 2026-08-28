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
            className: '', children: [], text: null,
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
        expect(children[0].children[1].text).toBe('Saved');
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
