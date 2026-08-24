/* =============================================================================
 * test/estatement_render_test.js — a Smart Statement has to be RUN, not read
 * -----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * #122 and #123 taught the parser more layouts and then reported the shape it
 * actually saw when it still found nothing. The real Nations Trust / AmEx file
 * answered:
 *
 *     tables 2 / rows 3 / cells 17 / date-cells 0 / money-cells 0 /
 *     scripts 14 / script-rows 0 / chars 3104263
 *
 * Three million characters, fourteen scripts, three table rows between them, and
 * not one cell holding a date or an amount. That is not a layout the parser has
 * yet to learn — it is a document that has not been rendered. A Smart Statement
 * is an application: the rows are drawn by its own JavaScript on load, and
 * DOMParser does not execute scripts. Every static layer was reading the shell.
 *
 * THE FIX, AND WHY IT NEEDS ITS OWN TEST FILE
 *
 * The statement is now executed in a sandboxed iframe and the RENDERED DOM is
 * parsed. That means running code that arrived as an email attachment, so the
 * containment is not a detail of the fix — it IS the fix, and it is what these
 * tests hold:
 *
 *   • sandbox="allow-scripts" and nothing else. Without allow-same-origin the
 *     frame has an opaque origin and cannot reach this page's DOM, storage or
 *     signed-in session. A future edit that adds allow-same-origin "to read the
 *     frame directly" would hand a stranger's script the user's whole account
 *     and would still pass every parsing test, so it is asserted on here.
 *   • An injected CSP of default-src 'none' — no fetch, XHR, WebSocket, beacon
 *     or remote image. The statement is the user's financial data; it must not
 *     be able to send it anywhere.
 *   • The parent never touches the frame. It accepts one postMessage carrying a
 *     per-run nonce and reads the string it was given.
 *
 * The environment below is a fake document/window injected through the opts seam,
 * so the frame's lifecycle, the nonce check and the source check are exercised
 * for real rather than asserted about by reading the source.
 * ===========================================================================*/

import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');

/* The same shim the layout suite uses: enough DOM for the table layer, and it
 * can tell 'td,th' from 'td' so a bug there cannot hide behind it. */
function makeDom(html) {
    const strip = (s) => s.replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/\s+/g, ' ').trim();
    const tables = [...html.matchAll(/<table[\s\S]*?<\/table>/gi)].map((m) => m[0]);
    return {
        body: { get textContent() { return strip(html.replace(/<script[\s\S]*?<\/script>/gi, '')); } },
        querySelectorAll(sel) {
            if (sel !== 'table') return [];
            return tables.map((t) => ({
                querySelectorAll: (s2) => (s2 !== 'tr' ? [] : [...t.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((r) => ({
                    querySelectorAll: (s3) => {
                        const want = s3.split(',').map((x) => x.trim().toLowerCase());
                        const cells = [];
                        for (const c of r[0].matchAll(/<(td|th)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
                            if (want.includes(c[1].toLowerCase())) cells.push({ textContent: strip(c[2]) });
                        }
                        return cells;
                    },
                }))),
            }));
        },
    };
}

/** A document/window pair that records every frame and can deliver a message. */
function makeEnv() {
    const msgFns = [];
    const created = [];
    const body = {
        children: [],
        appendChild(n) { n.parentNode = body; body.children.push(n); return n; },
        removeChild(n) {
            const i = body.children.indexOf(n);
            if (i >= 0) body.children.splice(i, 1);
            n.parentNode = null;
            return n;
        },
    };
    const win = {
        addEventListener(t, fn) { if (t === 'message') msgFns.push(fn); },
        removeEventListener(t, fn) { const i = msgFns.indexOf(fn); if (i >= 0) msgFns.splice(i, 1); },
    };
    const doc = {
        body,
        createElement() {
            const el = {
                style: {}, attrs: {}, parentNode: null, srcdoc: '',
                contentWindow: { id: created.length },
                setAttribute(k, v) { el.attrs[k] = String(v); },
                getAttribute(k) { return Object.prototype.hasOwnProperty.call(el.attrs, k) ? el.attrs[k] : null; },
            };
            created.push(el);
            return el;
        },
    };
    return {
        win, doc, created, body,
        get listenerCount() { return msgFns.length; },
        /** Deliver a message exactly as the browser would. */
        deliver(data, source) { msgFns.slice().forEach((fn) => fn({ data, source })); },
        /** The frame's own answer: right nonce, right source. */
        answer(html, idx = 0) {
            const f = created[idx];
            const nonce = (f.srcdoc.match(/var N="([^"]+)"/) || [])[1];
            expect(nonce, 'the bootstrap does not carry a nonce').toBeTruthy();
            this.deliver({ __wfhs: nonce, html }, f.contentWindow);
            return nonce;
        },
    };
}

let W;
beforeAll(() => {
    const SRC = fs.readFileSync(path.join(ROOT, 'wealthflow-html-statement.js'), 'utf8');
    const DOMParserShim = function () {};
    DOMParserShim.prototype.parseFromString = (h) => makeDom(h);
    const win = {};
    new Function('window', 'document', 'DOMParser', 'console', SRC)(
        win, { createElement: () => ({ style: {} }), head: {}, body: {} }, DOMParserShim, { log() {} });
    W = win.WFHtmlStatement;
});

const KEELLS = { date: '2026-08-03', narration: 'KEELLS SUPER COLOMBO', amount: 4250, direction: 'debit' };
const PAYMENT = { date: '2026-08-05', narration: 'PAYMENT - THANK YOU', amount: 15000, direction: 'credit' };

/** What the real file looks like to a static parser: a shell plus scripts. */
const SHELL = `<div id="stmt"></div><script>
    function draw(){ var host=document.getElementById('stmt'); host.innerHTML=build(load()); }
    window.addEventListener('load', draw);
</script>`;

/** What that shell becomes once its own code has run. */
const RENDERED = `<html><body><div id="stmt"><table>
    <tr><th>Post Date</th><th>Description</th><th>Amount</th></tr>
    <tr><td>03-Aug-2026</td><td>KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr>
    <tr><td>05-Aug-2026</td><td>PAYMENT - THANK YOU</td><td>15,000.00 Cr</td></tr>
    </table></div></body></html>`;

describe('the module exposes the render path at all (guards a vacuous suite)', () => {
    it('loaded, with the new surface', () => {
        expect(W, 'WFHtmlStatement did not initialise').toBeTruthy();
        expect(typeof W.renderInSandbox).toBe('function');
        expect(typeof W.htmlToTransactionsAsync).toBe('function');
        expect(typeof W._buildSandboxDoc).toBe('function');
    });

    it('the shell fixture really is unreadable statically — otherwise nothing below is tested', () => {
        expect(W.htmlToTransactions(SHELL),
            'the shell now parses without a render, so these tests prove nothing')
            .toHaveLength(0);
    });
});

describe('the sandbox document', () => {
    const built = () => W._buildSandboxDoc('<p>STATEMENT-BODY</p>', 'NONCE-1', 4000);

    it('carries a deny-by-default CSP', () => {
        const csp = built().match(/http-equiv="Content-Security-Policy" content="([^"]+)"/);
        expect(csp, 'no CSP is injected — the statement could call home with the '
            + "user's transactions").toBeTruthy();
        expect(csp[1]).toContain("default-src 'none'");
    });

    it('grants the statement no way to reach the network', () => {
        const csp = built().match(/content="([^"]+)"/)[1];
        // Anything that would let it exfiltrate: connect/img/font/media must not
        // name a host, and default-src 'none' covers connect-src by fallback.
        expect(csp, 'a connect-src was added — the frame can now make requests')
            .not.toMatch(/connect-src[^;]*(https?:|\*)/);
        expect(csp).toMatch(/img-src\s+data:\s*;/);
        expect(csp).toContain("form-action 'none'");
        expect(csp).toContain("base-uri 'none'");
    });

    it('puts the CSP and the bootstrap ahead of the statement, or neither governs it', () => {
        const d = built();
        expect(d.indexOf('Content-Security-Policy')).toBeLessThan(d.indexOf('STATEMENT-BODY'));
        expect(d.indexOf('__wfhs')).toBeLessThan(d.indexOf('STATEMENT-BODY'));
    });

    it('keeps the statement itself intact', () => {
        expect(built()).toContain('<p>STATEMENT-BODY</p>');
    });

    it('does not cut its own bootstrap in half', () => {
        // A literal </script> anywhere in the emitted bootstrap would end the
        // element early and leave the rest of it as visible page text.
        const d = built();
        const open = d.indexOf('<script>');
        const close = d.indexOf('</script>', open);
        const boot = d.slice(open + '<script>'.length, close);
        expect(boot, 'the bootstrap was truncated by a literal </script>').toContain('postMessage');
        expect(boot).toContain('parent');
        expect(boot).toContain('"NONCE-1"');
    });

    it('the frame reports back rather than being read — the parent stays out', () => {
        expect(built()).toMatch(/parent\.postMessage/);
    });
});

describe('the frame is contained', () => {
    it('is sandboxed with allow-scripts and NOTHING else', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox('<p>x</p>', { document: env.doc, window: env.win, timeoutMs: 30 });
        const sandbox = env.created[0].getAttribute('sandbox');
        expect(sandbox, 'the frame is not sandboxed at all').toBeTruthy();
        expect(sandbox.split(/\s+/).filter(Boolean).sort(),
            'the sandbox token list changed — allow-same-origin would give the '
            + "statement this page's origin, storage and signed-in session")
            .toEqual(['allow-scripts']);
        env.answer('<p>y</p>');
        await p;
    });

    it('sends no referrer and is out of the tab order', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox('<p>x</p>', { document: env.doc, window: env.win, timeoutMs: 30 });
        expect(env.created[0].getAttribute('referrerpolicy')).toBe('no-referrer');
        expect(env.created[0].getAttribute('tabindex')).toBe('-1');
        env.answer('<p>y</p>');
        await p;
    });
});

describe('the frame answers, or it is torn down', () => {
    it('resolves with what the frame rendered', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        env.answer(RENDERED);
        expect(await p).toBe(RENDERED);
    });

    it('removes the frame and its listener once it has the answer', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        expect(env.body.children).toHaveLength(1);
        env.answer(RENDERED);
        await p;
        expect(env.body.children, 'the frame was left in the page').toHaveLength(0);
        expect(env.listenerCount, 'the message listener was left attached').toBe(0);
    });

    it('ignores a message that does not carry this run’s nonce', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox(SHELL, { document: env.doc, window: env.win, timeoutMs: 30 });
        env.deliver({ __wfhs: 'not-the-nonce', html: RENDERED }, env.created[0].contentWindow);
        env.deliver({ html: RENDERED }, env.created[0].contentWindow);
        env.deliver('a bare string', env.created[0].contentWindow);
        expect(await p, 'a message from elsewhere was accepted as the statement')
            .toBe('');
    });

    it('ignores the right nonce arriving from the wrong window', async () => {
        const env = makeEnv();
        const p = W.renderInSandbox(SHELL, { document: env.doc, window: env.win, timeoutMs: 30 });
        const nonce = (env.created[0].srcdoc.match(/var N="([^"]+)"/) || [])[1];
        env.deliver({ __wfhs: nonce, html: RENDERED }, { id: 'someone else' });
        expect(await p).toBe('');
    });

    it('gives up rather than hanging when the frame never answers', async () => {
        const env = makeEnv();
        const out = await W.renderInSandbox(SHELL, { document: env.doc, window: env.win, timeoutMs: 30 });
        expect(out).toBe('');
        expect(env.body.children, 'a frame was left behind after the timeout').toHaveLength(0);
        expect(env.listenerCount).toBe(0);
    });

    it('does nothing at all without a document to build in', async () => {
        expect(await W.renderInSandbox(SHELL, { document: null, window: null })).toBe('');
    });
});

describe('rendering is what finally reads the statement', () => {
    it('reads the rows out of the rendered DOM', async () => {
        const env = makeEnv();
        const p = W.htmlToTransactionsAsync(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        env.answer(RENDERED);
        const r = await p;
        expect(r.rendered).toBe(true);
        expect(r.transactions, 'the statement rendered and still imported nothing')
            .toEqual([KEELLS, PAYMENT]);
    });

    it('does NOT build a frame when the static layers already answered', async () => {
        const env = makeEnv();
        const table = `<table>
            <tr><td>03-Aug-2026</td><td>KEELLS SUPER COLOMBO</td><td>4,250.00 Dr</td></tr>
            <tr><td>05-Aug-2026</td><td>PAYMENT - THANK YOU</td><td>15,000.00 Cr</td></tr>
            </table>`;
        const r = await W.htmlToTransactionsAsync(table, { document: env.doc, window: env.win, timeoutMs: 30 });
        expect(r.transactions).toEqual([KEELLS, PAYMENT]);
        expect(r.rendered).toBe(false);
        expect(env.created, 'a plain HTML table paid for a render it did not need')
            .toHaveLength(0);
    });

    it('does not build a frame for a document with no scripts to run', async () => {
        const env = makeEnv();
        const r = await W.htmlToTransactionsAsync('<div>Statement balance</div>',
            { document: env.doc, window: env.win, timeoutMs: 30 });
        expect(r.transactions).toHaveLength(0);
        expect(env.created).toHaveLength(0);
    });

    it('survives a frame that answers with nothing', async () => {
        const env = makeEnv();
        const p = W.htmlToTransactionsAsync(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        env.answer('');
        const r = await p;
        expect(r.transactions).toHaveLength(0);
        expect(r.rendered).toBe(false);
    });
});

describe('the script layer reads shapes it used to walk past', () => {
    it('positional rows — an array of arrays', () => {
        const html = `<script>var d=[
            ["03-Aug-2026","KEELLS SUPER COLOMBO","LKR","4,250.00","Dr"],
            ["05-Aug-2026","PAYMENT - THANK YOU","LKR","15,000.00","Cr"]];</script>`;
        expect(W._layerScripts(html),
            'an array of arrays was rejected before it was even parsed, because the '
            + "span scan required a '{'").toEqual([KEELLS, PAYMENT]);
    });

    it('an array that sits after a bracket the scanner cannot balance', () => {
        /* The '[' inside this string never closes as far as the scanner is
         * concerned, and its quote desyncs the string tracking for everything
         * after it. Abandoning the whole block there — which is what it did —
         * hides every array below, and in minified code there is always one. */
        const html = `<script>var label="totals[";
            var rows=[{"postDate":"03-Aug-2026","description":"KEELLS SUPER COLOMBO","amount":"4,250.00","drCr":"Dr"},
            {"postDate":"05-Aug-2026","description":"PAYMENT - THANK YOU","amount":"15,000.00","drCr":"Cr"}];</script>`;
        expect(W._layerScripts(html),
            'one unbalanceable bracket still hides every array after it')
            .toEqual([KEELLS, PAYMENT]);
    });

    /* Right to left, the same rule the table layer settled on. A card statement
     * puts the settled LKR figure last — after the currency and the foreign
     * amount — and that is the one being imported. (A bank ACCOUNT statement
     * ending in a running balance would be read wrongly by this; those do not
     * come through this path, and one rule the two layers share beats two rules
     * that disagree.) */
    it('takes the settled LKR column, not the first amount in the row', () => {
        const html = '<script>var d=[["03-Aug-2026","02-Aug-2026",'
            + '"KEELLS SUPER COLOMBO","USD","25.00","8,430.50"]];</script>';
        const rows = W._layerScripts(html);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount, 'the foreign-currency amount was imported instead of '
            + 'what the card was actually charged').toBe(8430.5);
        expect(rows[0].narration).toBe('KEELLS SUPER COLOMBO');
    });

    it('does not mistake a quantity inside the description for the amount', () => {
        const html = '<script>var d=[["03-Aug-2026","FUEL 20.00 LTR AT LAUGFS","8,430.50","Dr"]];</script>';
        const rows = W._layerScripts(html);
        expect(rows).toHaveLength(1);
        expect(rows[0].amount).toBe(8430.5);
    });

    it('a wall of brackets is bounded work, not a frozen phone', () => {
        const t0 = Date.now();
        const rows = W._layerScripts('<script>' + '['.repeat(120000) + '</script>');
        expect(rows).toHaveLength(0);
        expect(Date.now() - t0,
            'scanning is quadratic again — this is a 3 MB file on a phone')
            .toBeLessThan(4000);
    });
});

describe('the diagnostic says what is inside the scripts', () => {
    it('reports the biggest scripts by size and kind', () => {
        const html = '<script>' + 'A'.repeat(900) + '</script>'
            + '<script>var x=1;function f(){}</script>'
            + '<script>document.write(atob(z));</script>';
        const d = W.diagnose(html);
        expect(d.scripts).toBe(3);
        expect(d.topScripts, 'the diagnostic no longer describes the scripts, which is '
            + 'the only place the data can be').toHaveLength(3);
        expect(d.topScripts[0].k, 'a second-stage base64 payload is not identified')
            .toMatch(/^b64-\d+$/);
        expect(d.topScripts.map((s) => s.k)).toContain('doc-write');
        expect(d.topScripts[0].n).toBeGreaterThan(d.topScripts[1].n);
    });

    it('reports whether a render happened and what it produced', () => {
        const d = W.diagnose('<div></div>', { rendered: true, renderedChars: 4096, renderedRows: 7 });
        expect(d.rendered).toBe(true);
        expect(d.renderedChars).toBe(4096);
        expect(d.renderedRows).toBe(7);
        const line = W.diagLine(d);
        expect(line).toContain('rendered yes');
        expect(line).toContain('4096');
    });

    it('still masks every digit in the samples it shows', () => {
        const d = W.diagnose('<table><tr><td>03-Aug-2026 KEELLS SUPER COLOMBO 4,250.00</td></tr></table>');
        d.samples.forEach((s) => {
            expect(s, 'a real figure from the statement leaked into the diagnostic')
                .not.toMatch(/\d/);
        });
    });
});

/* =============================================================================
 * THE BOOTSTRAP, ACTUALLY RUN
 * -----------------------------------------------------------------------------
 * The code that runs inside the frame is built as a string, so nothing above
 * executes a line of it — and a snapshot loop that never fires, or a CSP report
 * that quietly carries a URL's query string, would pass every test so far. It is
 * plain JavaScript, so it can simply be run against a fake frame with a fake
 * clock, which is what follows.
 * ===========================================================================*/

/** Pull the bootstrap out of a built sandbox document. */
function bootstrapOf(nonce = 'N1', budget = 5000) {
    const d = W._buildSandboxDoc('<p>ignored</p>', nonce, budget);
    const open = d.indexOf('<script>');
    return d.slice(open + '<script>'.length, d.indexOf('</script>', open));
}

/** A frame the bootstrap can run in: fake clock, fake parent, recorded posts. */
function makeFrame({ body = '<p>hello</p>', onTick = null } = {}) {
    const posted = [];
    const timers = [];
    const listeners = {};
    let now = 1000;
    let ticks = 0;

    const win = { addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); } };
    const doc = {
        addEventListener(t, fn) { (listeners[t] = listeners[t] || []).push(fn); },
        body: { innerHTML: body },
    };
    Object.defineProperty(doc, 'documentElement', {
        get: () => ({
            outerHTML: '<html><head><script>var lib=[1,2,3];</script></head><body>'
                + doc.body.innerHTML + '</body></html>',
        }),
    });
    const parent = { postMessage(o) { posted.push(o); } };
    const fakeSetTimeout = (fn, ms) => { timers.push({ at: now + (ms || 0), fn }); };
    const fakeDate = { now: () => now };

    new Function('window', 'document', 'parent', 'setTimeout', 'Date', bootstrapOf())(
        win, doc, parent, fakeSetTimeout, fakeDate);

    return {
        posted, win, doc, listeners,
        /** Run queued timers in order until they run out or the cap is hit. */
        pump(max = 200) {
            while (timers.length && max-- > 0) {
                timers.sort((a, b) => a.at - b.at);
                const t = timers.shift();
                now = t.at;
                ticks++;
                if (onTick) onTick(doc, ticks);
                t.fn();
            }
            return this;
        },
        fire(type, ev) { (listeners[type] || []).forEach((fn) => fn(ev)); },
    };
}

describe('the code that runs inside the frame', () => {
    it('sends exactly one snapshot once the page stops changing', () => {
        const f = makeFrame().pump();
        expect(f.posted, 'the frame never reported back — the render would always time out')
            .toHaveLength(1);
        expect(f.posted[0].html).toContain('<p>hello</p>');
    });

    it('stamps the snapshot with this run’s nonce', () => {
        const f = makeFrame().pump();
        expect(f.posted[0].__wfhs).toBe('N1');
    });

    it('strips script bodies out of what it sends back', () => {
        const f = makeFrame().pump();
        expect(f.posted[0].html, 'megabytes of library source were posted across the '
            + 'boundary for no reason').not.toContain('var lib=');
    });

    it('still reports when the page never settles, rather than never reporting', () => {
        // innerHTML changes on every tick, so the quiet check can never trip.
        const f = makeFrame({ onTick: (doc, n) => { doc.body.innerHTML = '<p>' + 'x'.repeat(n) + '</p>'; } });
        f.pump();
        expect(f.posted, 'an animated statement would hang until the parent timed out')
            .toHaveLength(1);
    });

    it('records a blocked request as directive + origin, never the path or query', () => {
        const f = makeFrame();
        f.fire('securitypolicyviolation', {
            violatedDirective: 'connect-src',
            blockedURI: 'https://track.example.com/collect?card=4111111111111111&amt=8430.50',
        });
        f.pump();
        const b = f.posted[0].blocked;
        expect(b, 'a refused request is not reported — the likeliest way this fix '
            + 'fails would be invisible').toEqual(['connect-src https://track.example.com']);
        expect(b[0], "the blocked URL's query reached the report").not.toContain('card=');
    });

    it('does not double-count the same violation seen on window and on document', () => {
        const f = makeFrame();
        const ev = { violatedDirective: 'script-src', blockedURI: 'https://cdn.example/x.js' };
        f.fire('securitypolicyviolation', ev);
        f.pump();
        expect(f.posted[0].blocked).toEqual(['script-src https://cdn.example']);
    });

    it('counts the statement’s own errors and masks the digits in the first one', () => {
        const f = makeFrame();
        f.win.onerror('ReferenceError: acct 4111 is not defined at line 42');
        f.win.onerror('TypeError: later one');
        f.pump();
        expect(f.posted[0].errs).toBe(2);
        expect(f.posted[0].err1, 'an error message carried digits out of the statement')
            .not.toMatch(/\d/);
        expect(f.posted[0].err1).toContain('ReferenceError');
    });

    it('swallows the error rather than letting one throw stop the snapshot', () => {
        const f = makeFrame();
        expect(f.win.onerror('boom')).toBe(true);
        f.pump();
        expect(f.posted).toHaveLength(1);
    });
});

describe('what the frame reported reaches the diagnostic', () => {
    /** Answer as the frame would, with an arbitrary payload. */
    function answerWith(env, payload, idx = 0) {
        const f = env.created[idx];
        const nonce = (f.srcdoc.match(/var N="([^"]+)"/) || [])[1];
        env.deliver(Object.assign({ __wfhs: nonce }, payload), f.contentWindow);
    }

    it('a CSP refusal shows up on the line the user can copy', async () => {
        const env = makeEnv();
        const p = W.htmlToTransactionsAsync(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        answerWith(env, { html: '<div></div>', blocked: ['script-src https://cdn.example'], errs: 0, err1: '' });
        const r = await p;
        const line = W.diagLine(W.diagnose(SHELL, {
            rendered: r.rendered, renderedChars: 0, renderedRows: 0, report: r.report,
        }));
        expect(line, 'the statement was refused a resource and the diagnostic said nothing')
            .toContain('blocked script-src https://cdn.example');
    });

    /* The frame masks, the parent masks what the frame sent, and diagnose masks
     * again before it reaches the panel. That is deliberate — the panel is
     * presented to the user as safe to share, and the document being examined is
     * the one thing in the chain that cannot be trusted to have masked anything.
     *
     * Each layer is asserted WHERE IT LIVES. Testing them through one call passed
     * with either layer deleted, which is a guard reporting on bytes it was not
     * reading: the exact failure this whole suite exists for. */
    it('the message handler masks what the frame posted', async () => {
        const env = makeEnv();
        let report = null;
        const p = W.renderInSandbox(SHELL, {
            document: env.doc, window: env.win, timeoutMs: 200,
            onReport: (x) => { report = x; },
        });
        answerWith(env, { html: '<div></div>', blocked: [], errs: 1, err1: 'card 4111111111111111 failed' });
        await p;
        expect(report, 'no report was handed on at all').toBeTruthy();
        expect(report.err1, 'the frame’s own message was taken on trust')
            .not.toMatch(/\d/);
        expect(report.err1).toContain('card');
    });

    it('diagnose masks a report handed to it unmasked', () => {
        const d = W.diagnose('<div></div>', {
            rendered: true,
            report: { blocked: [], errs: 1, err1: 'card 4111111111111111 failed' },
        });
        expect(d.err1, 'diagnose relayed digits straight into the copyable panel')
            .not.toMatch(/\d/);
        expect(W.diagLine(d)).toContain('errors 1');
    });

    it('caps how much a frame can push into the report', async () => {
        const env = makeEnv();
        const p = W.htmlToTransactionsAsync(SHELL, { document: env.doc, window: env.win, timeoutMs: 200 });
        answerWith(env, { html: '<div></div>', blocked: new Array(50).fill('x'), errs: 0, err1: 'y'.repeat(500) });
        const r = await p;
        const d = W.diagnose(SHELL, { rendered: true, renderedChars: 0, renderedRows: 0, report: r.report });
        expect(d.blocked.length).toBeLessThanOrEqual(6);
        expect(d.err1.length).toBeLessThanOrEqual(90);
    });
});
