/* =============================================================================
 * wealthflow-handlers.js — event handlers without `unsafe-inline`
 * -----------------------------------------------------------------------------
 * WHY. index.html carries ~450 inline handlers (`onclick="closeModal('mdLoan')"`). A page may
 * only drop 'unsafe-inline' from its Content-Security-Policy `script-src` once none is left,
 * because the policy refuses every inline handler, and with it every injected one. That is
 * the one gap RedSentinel keeps naming.
 *
 * HOW. At build time the attribute NAME is renamed (`onclick=` -> `data-wf-on-click=`), which
 * the browser does not treat as code, and this module runs the VALUE itself. It does not use
 * eval or `new Function` (both are exactly what the policy forbids): the value is parsed by the
 * small parser below and walked. The grammar is the part of JavaScript handlers actually use:
 * calls, member access, `?.`, literals, `this`, `event`, `!`, `&&`, `||`, `?:`, comparisons,
 * `+`, assignment to a member, `if/else`, `return`, and arrow/function expressions.
 *
 * THE RULE THAT KEEPS THE POLICY MEANINGFUL. Running arbitrary text from an attribute would
 * hand an attacker who can inject markup the same power an inline handler gives. So a value
 * runs only when its SHAPE is one the build found in the shipped page: the same program with
 * every string and number literal replaced (`closeModal(S)`). Text an attacker writes
 * (`fetch(S+document.cookie)`) has no matching shape and is refused and logged. What remains
 * is the app's own calls with other literal arguments, which is far narrower than "any script".
 *
 * Pure apart from the installer: no clock, no network, no eval.
 * ===========================================================================*/

const PUNCT = ['===', '!==', '=>', '?.', '==', '!=', '<=', '>=', '&&', '||', '+=', '-=', '(', ')', '{', '}', '[', ']', ',', ';', '.', '?', ':', '=', '!', '<', '>', '+', '-', '*', '/', '%'];
const KEYWORDS = new Set(['if', 'else', 'return', 'typeof', 'function', 'new', 'true', 'false', 'null', 'undefined', 'this', 'void']);
const ESC = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };

class HandlerError extends Error {}
const bad = (m) => { throw new HandlerError(m); };

function tokenize(src) {
    const out = [];
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (/\s/.test(c)) { i += 1; continue; }
        if (c === '/' && src[i + 1] === '/') bad('comment');
        if (c === '/' && src[i + 1] === '*') bad('comment');
        if (c === '"' || c === "'") {
            let j = i + 1; let v = '';
            while (j < n && src[j] !== c) {
                if (src[j] === '\\') {
                    const e = src[j + 1];
                    if (e === 'x') { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 4), 16)); j += 4; continue; }
                    if (e === 'u') { v += String.fromCharCode(parseInt(src.slice(j + 2, j + 6), 16)); j += 6; continue; }
                    v += Object.prototype.hasOwnProperty.call(ESC, e) ? ESC[e] : e; j += 2; continue;
                }
                v += src[j]; j += 1;
            }
            if (j >= n) bad('unterminated string');
            out.push({ k: 'str', v }); i = j + 1; continue;
        }
        if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] || ''))) {
            const m = /^(?:0[xX][0-9a-fA-F]+|\d*\.?\d+(?:[eE][+-]?\d+)?)/.exec(src.slice(i));
            if (!m) bad('number');
            out.push({ k: 'num', v: Number(m[0]) }); i += m[0].length; continue;
        }
        if (/[A-Za-z_$]/.test(c)) {
            let j = i + 1;
            while (j < n && /[\w$]/.test(src[j])) j += 1;
            const w = src.slice(i, j);
            out.push(KEYWORDS.has(w) ? { k: 'kw', v: w } : { k: 'id', v: w }); i = j; continue;
        }
        const p = PUNCT.find((q) => src.startsWith(q, i));
        if (!p) bad('unexpected ' + c);
        // `?.` followed by a digit is a ternary and a decimal, not an optional chain
        if (p === '?.' && /[0-9]/.test(src[i + 2] || '')) { out.push({ k: 'p', v: '?' }); i += 1; continue; }
        out.push({ k: 'p', v: p }); i += p.length;
    }
    return out;
}

/* ---- parser ---------------------------------------------------------------- */
function parse(src) {
    const toks = tokenize(String(src));
    let at = 0;
    const peek = () => toks[at];
    const isP = (v) => toks[at] && toks[at].k === 'p' && toks[at].v === v;
    const isKw = (v) => toks[at] && toks[at].k === 'kw' && toks[at].v === v;
    const eatP = (v) => { if (isP(v)) { at += 1; return true; } return false; };
    const needP = (v) => { if (!eatP(v)) bad('expected ' + v); };

    function program(end) {
        const body = [];
        while (at < toks.length && !(end && isP(end))) {
            if (eatP(';')) continue;
            body.push(statement());
        }
        return body;
    }
    function statement() {
        if (isKw('if')) {
            at += 1; needP('('); const test = expr(); needP(')');
            const yes = statement(); let no = null;
            if (isP(';') && toks[at + 1] && toks[at + 1].k === 'kw' && toks[at + 1].v === 'else') at += 1;
            if (isKw('else')) { at += 1; no = statement(); }
            return { t: 'if', test, yes, no };
        }
        if (isP('{')) { at += 1; const body = program('}'); needP('}'); return { t: 'blk', body }; }
        if (isKw('return')) {
            at += 1;
            const arg = (at >= toks.length || isP(';') || isP('}')) ? null : expr();
            return { t: 'ret', arg };
        }
        const e = expr();
        if (!(at >= toks.length || isP(';') || isP('}'))) bad('expected end of statement');
        return { t: 'expr', e };
    }
    function expr() { return assign(); }
    function assign() {
        const left = cond();
        for (const op of ['=', '+=', '-=']) {
            if (isP(op)) {
                if (left.t !== 'id' && left.t !== 'mem') bad('bad assignment target');
                at += 1; return { t: 'asg', op, tgt: left, v: assign() };
            }
        }
        return left;
    }
    function cond() {
        const test = bin(0);
        if (eatP('?')) { const a = assign(); needP(':'); const b = assign(); return { t: 'cond', test, a, b }; }
        return test;
    }
    const LEVELS = [['||'], ['&&'], ['===', '!==', '==', '!='], ['<', '>', '<=', '>='], ['+', '-'], ['*', '/', '%']];
    function bin(level) {
        if (level >= LEVELS.length) return unary();
        let l = bin(level + 1);
        for (;;) {
            const tk = peek();
            if (!tk || tk.k !== 'p' || !LEVELS[level].includes(tk.v)) return l;
            at += 1;
            const r = bin(level + 1);
            l = { t: level < 2 ? 'log' : 'bin', op: tk.v, l, r };
        }
    }
    function unary() {
        if (isP('!') || isP('-') || isKw('typeof') || isKw('void')) {
            const tk = peek(); at += 1; return { t: 'un', op: tk.v, e: unary() };
        }
        if (isKw('new')) {
            at += 1; const callee = memberOnly();
            let args = [];
            if (isP('(')) args = argList();
            return postfix({ t: 'new', c: callee, a: args });
        }
        return postfix(primary());
    }
    function memberOnly() {
        let e = primary();
        while (isP('.')) { at += 1; e = { t: 'mem', o: e, p: ident(), computed: false }; }
        return e;
    }
    function ident() {
        const tk = peek();
        if (!tk || (tk.k !== 'id' && tk.k !== 'kw')) bad('expected name');
        at += 1; return tk.v;
    }
    function argList() {
        needP('(');
        const a = [];
        while (!isP(')')) { a.push(assign()); if (!eatP(',')) break; }
        needP(')');
        return a;
    }
    function postfix(base) {
        let e = base; let optional = false;
        for (;;) {
            if (isP('.')) { at += 1; e = { t: 'mem', o: e, p: ident(), computed: false }; }
            else if (isP('?.')) {
                at += 1; optional = true;
                if (isP('(')) e = { t: 'call', c: e, a: argList(), opt: true };
                else if (isP('[')) { at += 1; const p = expr(); needP(']'); e = { t: 'mem', o: e, p, computed: true, opt: true }; }
                else e = { t: 'mem', o: e, p: ident(), computed: false, opt: true };
            }
            else if (isP('[')) { at += 1; const p = expr(); needP(']'); e = { t: 'mem', o: e, p, computed: true }; }
            else if (isP('(')) e = { t: 'call', c: e, a: argList() };
            else break;
        }
        return optional ? { t: 'chain', e } : e;
    }
    function fnBody() {
        if (isP('{')) { at += 1; const body = program('}'); needP('}'); return { body, expr: null }; }
        return { body: null, expr: assign() };
    }
    function primary() {
        const tk = peek();
        if (!tk) bad('unexpected end');
        if (tk.k === 'num') { at += 1; return { t: 'num', v: tk.v }; }
        if (tk.k === 'str') { at += 1; return { t: 'str', v: tk.v }; }
        if (tk.k === 'kw') {
            if (tk.v === 'true' || tk.v === 'false') { at += 1; return { t: 'lit', v: tk.v === 'true' }; }
            if (tk.v === 'null') { at += 1; return { t: 'lit', v: null }; }
            if (tk.v === 'undefined') { at += 1; return { t: 'lit', v: undefined }; }
            if (tk.v === 'this') { at += 1; return { t: 'this' }; }
            if (tk.v === 'function') {
                at += 1; needP('('); const params = [];
                while (!isP(')')) { const p = peek(); if (!p || p.k !== 'id') bad('param'); params.push(p.v); at += 1; if (!eatP(',')) break; }
                needP(')');
                if (!isP('{')) bad('function body');
                return { t: 'fn', params, arrow: false, ...fnBody() };
            }
            bad('unexpected ' + tk.v);
        }
        if (tk.k === 'id') {
            // arrow function: `r =>` or `(a, b) =>`
            if (toks[at + 1] && toks[at + 1].k === 'p' && toks[at + 1].v === '=>') {
                at += 2; return { t: 'fn', params: [tk.v], arrow: true, ...fnBody() };
            }
            at += 1; return { t: 'id', n: tk.v };
        }
        if (isP('(')) {
            // `(a, b) => ...` or a parenthesised expression
            let j = at + 1; const ps = [];
            while (toks[j] && toks[j].k === 'id') { ps.push(toks[j].v); j += 1; if (toks[j] && toks[j].k === 'p' && toks[j].v === ',') j += 1; else break; }
            if (toks[j] && toks[j].k === 'p' && toks[j].v === ')' && toks[j + 1] && toks[j + 1].k === 'p' && toks[j + 1].v === '=>') {
                at = j + 2; return { t: 'fn', params: ps, arrow: true, ...fnBody() };
            }
            at += 1; const e = expr(); needP(')'); return e;
        }
        return bad('unexpected ' + tk.v);
    }
    const body = program(null);
    if (!body.length) bad('empty');
    return { t: 'prog', body };
}

/* ---- shape: the program with its string and number literals blanked --------- */
function shapeOf(n) {
    if (n == null) return '';
    switch (n.t) {
        case 'prog': return n.body.map(shapeOf).join(';');
        case 'blk': return '{' + n.body.map(shapeOf).join(';') + '}';
        case 'if': return 'if(' + shapeOf(n.test) + ')' + shapeOf(n.yes) + (n.no ? ' else ' + shapeOf(n.no) : '');
        case 'ret': return 'return ' + shapeOf(n.arg);
        case 'expr': return shapeOf(n.e);
        case 'num': return 'N';
        case 'str': return 'S';
        case 'lit': return String(n.v);
        case 'this': return 'this';
        case 'id': return n.n;
        case 'chain': return shapeOf(n.e);
        case 'mem': return shapeOf(n.o) + (n.opt ? '?.' : '') + (n.computed ? '[' + shapeOf(n.p) + ']' : (n.opt ? '' : '.') + n.p);
        case 'call': return shapeOf(n.c) + (n.opt ? '?.' : '') + '(' + n.a.map(shapeOf).join(',') + ')';
        case 'new': return 'new ' + shapeOf(n.c) + '(' + n.a.map(shapeOf).join(',') + ')';
        case 'un': return n.op + (n.op === '!' || n.op === '-' ? '' : ' ') + shapeOf(n.e);
        case 'bin': case 'log': return '(' + shapeOf(n.l) + n.op + shapeOf(n.r) + ')';
        case 'cond': return '(' + shapeOf(n.test) + '?' + shapeOf(n.a) + ':' + shapeOf(n.b) + ')';
        case 'asg': return shapeOf(n.tgt) + n.op + shapeOf(n.v);
        case 'fn': return (n.arrow ? '' : 'function') + '(' + n.params.join(',') + ')' + (n.arrow ? '=>' : '') + (n.body ? '{' + n.body.map(shapeOf).join(';') + '}' : shapeOf(n.expr));
        default: return bad('shape ' + n.t);
    }
}

/* ---- evaluator -------------------------------------------------------------- */
const RETURN = Symbol('return');
const SHORT = Symbol('short');
const BLOCKED_NAMES = new Set(['constructor', '__proto__', 'prototype']);

function makeScope(parent, vars) { return { parent, vars: vars || new Map() }; }
function lookup(scope, name, root) {
    for (let s = scope; s; s = s.parent) if (s.vars.has(name)) return { found: true, scope: s };
    return Object.prototype.hasOwnProperty.call(root, name) || name in root ? { found: true, scope: null } : { found: false };
}

function evaluate(node, ctx) {
    const { scope, self, root } = ctx;
    switch (node.t) {
        case 'num': case 'str': return node.v;
        case 'lit': return node.v;
        case 'this': return self;
        case 'id': {
            const r = lookup(scope, node.n, root);
            if (!r.found) throw new ReferenceError(node.n + ' is not defined');
            return r.scope ? r.scope.vars.get(node.n) : root[node.n];
        }
        case 'chain': {
            try { return evaluate(node.e, ctx); } catch (e) { if (e === SHORT) return undefined; throw e; }
        }
        case 'mem': {
            const o = evaluate(node.o, ctx);
            if (node.opt && (o == null)) throw SHORT;
            const k = node.computed ? evaluate(node.p, ctx) : node.p;
            if (BLOCKED_NAMES.has(String(k))) throw new HandlerError('blocked member ' + k);
            return o[k];
        }
        case 'call': {
            let fn; let thisArg;
            if (node.c.t === 'mem' || (node.c.t === 'chain' && node.c.e.t === 'mem')) {
                const m = node.c.t === 'chain' ? node.c.e : node.c;
                thisArg = evaluate(m.o, ctx);
                if (m.opt && thisArg == null) throw SHORT;
                const k = m.computed ? evaluate(m.p, ctx) : m.p;
                if (BLOCKED_NAMES.has(String(k))) throw new HandlerError('blocked member ' + k);
                fn = thisArg[k];
            } else fn = evaluate(node.c, ctx);
            if (node.opt && fn == null) throw SHORT;
            if (typeof fn !== 'function') throw new TypeError('not a function');
            return fn.apply(thisArg, node.a.map((a) => evaluate(a, ctx)));
        }
        case 'new': {
            const C = evaluate(node.c, ctx);
            return new C(...node.a.map((a) => evaluate(a, ctx)));
        }
        case 'un': {
            if (node.op === 'typeof' && node.e.t === 'id' && !lookup(scope, node.e.n, root).found) return 'undefined';
            const v = evaluate(node.e, ctx);
            if (node.op === '!') return !v;
            if (node.op === '-') return -v;
            if (node.op === 'typeof') return typeof v;
            return undefined;
        }
        case 'log': {
            const l = evaluate(node.l, ctx);
            return node.op === '&&' ? (l ? evaluate(node.r, ctx) : l) : (l ? l : evaluate(node.r, ctx));
        }
        case 'bin': {
            const l = evaluate(node.l, ctx); const r = evaluate(node.r, ctx);
            switch (node.op) {
                case '===': return l === r; case '!==': return l !== r;
                case '==': return l == r; case '!=': return l != r; // eslint-disable-line eqeqeq
                case '<': return l < r; case '>': return l > r; case '<=': return l <= r; case '>=': return l >= r;
                case '+': return l + r; case '-': return l - r; case '*': return l * r; case '/': return l / r; default: return l % r;
            }
        }
        case 'cond': return evaluate(node.test, ctx) ? evaluate(node.a, ctx) : evaluate(node.b, ctx);
        case 'asg': {
            let v = evaluate(node.v, ctx);
            const t = node.tgt;
            if (t.t === 'id') {
                const r = lookup(scope, t.n, root);
                const cur = r.found ? (r.scope ? r.scope.vars.get(t.n) : root[t.n]) : undefined;
                if (node.op === '+=') v = cur + v; else if (node.op === '-=') v = cur - v;
                if (r.found && r.scope) r.scope.vars.set(t.n, v); else root[t.n] = v;
                return v;
            }
            const o = evaluate(t.o, ctx);
            const k = t.computed ? evaluate(t.p, ctx) : t.p;
            if (BLOCKED_NAMES.has(String(k))) throw new HandlerError('blocked member ' + k);
            if (node.op === '+=') v = o[k] + v; else if (node.op === '-=') v = o[k] - v;
            o[k] = v; return v;
        }
        case 'fn': {
            const home = ctx;
            return function wfHandlerFn(...args) {
                const vars = new Map();
                node.params.forEach((p, i) => vars.set(p, args[i]));
                const inner = { scope: makeScope(home.scope, vars), self: node.arrow ? home.self : this, root: home.root };
                if (node.expr) return evaluate(node.expr, inner);
                const r = runBody(node.body, inner);
                return r === RETURN_NONE ? undefined : r.value;
            };
        }
        default: throw new HandlerError('cannot evaluate ' + node.t);
    }
}

const RETURN_NONE = { none: true };
function runStatement(s, ctx) {
    switch (s.t) {
        case 'expr': evaluate(s.e, ctx); return RETURN_NONE;
        case 'ret': return { [RETURN]: true, value: s.arg ? evaluate(s.arg, ctx) : undefined };
        case 'blk': return runBody(s.body, ctx);
        case 'if': {
            if (evaluate(s.test, ctx)) return runStatement(s.yes, ctx);
            return s.no ? runStatement(s.no, ctx) : RETURN_NONE;
        }
        default: throw new HandlerError('cannot run ' + s.t);
    }
}
function runBody(body, ctx) {
    for (const s of body) {
        const r = runStatement(s, ctx);
        if (r !== RETURN_NONE) return r;
    }
    return RETURN_NONE;
}

/** Run an already parsed handler. `event` is a name in scope, as in an inline handler. Returns what `return` returned. */
export function runProgram(ast, { self, event, root = globalThis } = {}) {
    const ctx = { scope: makeScope(null, new Map([['event', event]])), self, root };
    const r = runBody(ast.body, ctx);
    return r === RETURN_NONE ? undefined : r.value;
}

export const parseHandler = parse;
export const handlerShape = (srcOrAst) => shapeOf(typeof srcOrAst === 'string' ? parse(srcOrAst) : srcOrAst);
export { HandlerError };

/* ---- the installer ----------------------------------------------------------- */
const EVENTS = ['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'keypress', 'blur', 'focus', 'error', 'load', 'scroll', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'paste', 'touchstart', 'touchend', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'drop', 'dragover', 'toggle', 'wheel', 'resize'];
// these do not bubble, so they are caught on the way down
const CAPTURE = new Set(['blur', 'focus', 'error', 'load', 'scroll', 'mouseenter', 'mouseleave', 'toggle']);
const cache = new Map();

/**
 * Run the handler an element carries for this event, if its shape was shipped. Returns
 * 'ran', 'refused' (shape not allowed) or 'failed' (it threw; the error goes to console.error, as an inline one would).
 */
export function runAttribute(el, type, event, allowed, root = globalThis) {
    const code = el.getAttribute('data-wf-on-' + type);
    if (code == null) return 'none';
    let ast = cache.get(code);
    try {
        if (!ast) {
            ast = parse(code);
            ast.shape = shapeOf(ast);
            if (cache.size > 2000) cache.clear();
            cache.set(code, ast);
        }
        if (!allowed || !allowed.has(ast.shape)) {
            try { console.warn('[WF-HANDLER] refused ' + type + ' handler (shape not shipped)'); } catch (_) { /* no console */ }
            return 'refused';
        }
        const out = runProgram(ast, { self: el, event, root });
        if (out === false && event && typeof event.preventDefault === 'function') event.preventDefault();
        return 'ran';
    } catch (e) {
        try { console.error(e); } catch (_) { /* no console */ }
        return 'failed';
    }
}

/** Listen once at the document; walk from the target up like bubbling does, honouring stopPropagation. */
export function installHandlers(doc, allowed, root = globalThis) {
    const listeners = [];
    for (const type of EVENTS) {
        const fn = (event) => {
            let el = event.target && event.target.nodeType === 1 ? event.target : (event.target && event.target.parentElement);
            if (CAPTURE.has(type)) {
                if (el && el.hasAttribute && el.hasAttribute('data-wf-on-' + type)) runAttribute(el, type, event, allowed, root);
                return;
            }
            while (el && el !== doc) {
                if (el.hasAttribute && el.hasAttribute('data-wf-on-' + type)) {
                    runAttribute(el, type, event, allowed, root);
                    if (event.cancelBubble) return;
                }
                el = el.parentElement;
            }
        };
        doc.addEventListener(type, fn, CAPTURE.has(type));
        listeners.push([type, fn]);
    }
    return () => { for (const [t, f] of listeners) doc.removeEventListener(t, f, CAPTURE.has(t)); };
}

export default { parseHandler, handlerShape, runProgram, runAttribute, installHandlers, HandlerError };
