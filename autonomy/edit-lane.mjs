/* =============================================================================
 * autonomy/edit-lane.mjs — the lane that may EDIT a screen that already exists, with a phone run as the proof   (owner, 2026-11-21)
 * -----------------------------------------------------------------------------
 * WHY. Issue #635 ("I cannot tap a row to see which products") was about a page drawn by renderCCI() inside index.html. No lane may edit index.html:
 * the swarm only rewrites one small root module, the layout lane only APPENDS validated CSS to wf-agent-fixes.css, and the build lane only ADDS a new
 * module. So the agent could add something beside the page but never change the page itself, and the report ended `ai-stuck` although the faults were
 * real and found by running the app (PR #655 had to be written by hand: a summary line and a Details button inside renderCCI(), and a few rules in
 * wf-ui.css). The owner's words: the system must really fix what is reported, not pretend. This lane does that part, and only that part.
 *
 * WHAT IT MAY DO (everything is enforced by code below, never by the prompt):
 *   · change the TEXT AND MARKUP that ONE render function draws: the template literals inside the function the screen lookup found (renderCCI), and
 *     nothing else in index.html (every byte outside that function is compared and must be identical);
 *   · change the LOOK of that screen in wf-ui.css: rules whose selector names the screen (#page-…, a .wf- class), layout and look properties only.
 *   An edit is a FIND-AND-REPLACE: the text to find must occur exactly once in the file, so the change is as small as the model can make it, and the
 *   reviewer and the owner can read it. Never a rewrite of a 2.4 MB file.
 *
 * WHAT IT MAY NOT DO:
 *   · touch any code outside the template literals of that function: no new statement, no changed condition, no arithmetic, no DB call. A money
 *     calculation lives in code, and code outside the templates must be byte-for-byte the same, so no money rule can change here. A new `${expression}`
 *     in a template may only use names the function already uses, may call only functions the function already calls, has no arithmetic and no
 *     assignment, and puts a raw record field on the page only through the page's own escaper (an XSS sink is refused);
 *   · add a script, iframe, form, link, external address, url(), hidden text, or an event handler that is not already in the function (a new one may call
 *     only a method a wealthflow module really exposes);
 *   · edit CSS outside the screen's own selectors, or use a property that hides, clips or restyles something it does not own.
 * Money, books, sync, auth, rules and every other function stay out of reach. Code logic is the swarm's job, with its own review.
 *
 * PROOF BEFORE A PULL REQUEST EXISTS: the edited page is served from memory (nothing is written to the repository), run in real Chromium at the owner's
 * phone size by a script a model wrote from the report, and judged by two models on different providers who must quote the screen (autonomy/acceptance.mjs).
 * Only `passed` goes on. Problems go back to the author twice. An independent reviewer on a different provider reads the whole change and holds a veto.
 * The pull request still touches a guarded path (index.html), so CI, the board and `human-approved` apply exactly as for a human's change.
 * `WF_EDIT_LANE=0` switches the lane off.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { chat, extractJson } from './llm-router.mjs';
import { fenceUntrusted } from './untrusted-text.mjs';
import { ROLES, isValidJs, parseVerdict, reviewPrompt, reviewSeesWholeChange } from './agent-swarm.mjs';
import { ALLOWED_PROPERTIES, readBlocks, stripComments, splitTop } from './css-lane.mjs';
import { findingsBrief, acceptanceSummary } from './acceptance.mjs';

export const HTML_FILE = 'index.html';
export const CSS_FILE = 'wf-ui.css';
export const MAX_EDITS = 8;
export const MAX_FIND_CHARS = 3000;
export const MAX_REPLACE_CHARS = 4000;
export const MAX_TOTAL_REPLACE = 9000;
export const MAX_FN_CHARS = 60_000;
export const MAX_ACCEPT_REVISIONS = 2;
const RENDER_FN = /^render[A-Z0-9][A-Za-z0-9_]{0,40}$/;
const SCRIPT_ANCHOR = '<script src="wealthflow-update-system.js" defer></script>';

/* ------------------------------------------------------------------ a small, strict JavaScript scanner (strings, comments, regex, nested templates) */

const REGEX_AFTER = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORD = /(?:^|[^\w$.])(?:return|typeof|case|do|else|in|of|void|delete|throw|new|yield|await)$/;

/**
 * Split JavaScript source into code and template literals. A template literal is `{k:'tpl', parts:[{s}|{e, segs}]}`: static text, or a `${…}`
 * expression that is itself scanned (so a template inside an expression is found too). Comments are dropped. Throws when the source is not
 * well-formed to this scanner (an unterminated string or template, braces that do not close): the caller then REFUSES, never guesses.
 * @returns {{segs:object[], end:number}} `end` is the index of the closing `}` when `stopAtBrace`, else the end of the source.
 */
export function scanSource(src, from = 0, stopAtBrace = false) {
    const segs = [];
    let buf = '', i = from, depth = 0, afterTemplate = false;
    const flush = () => { if (buf) { segs.push({ k: 'code', t: buf }); buf = ''; } };
    while (i < src.length) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { while (i < src.length && src[i] !== '\n') i++; buf += '\n'; continue; }
        if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); if (e < 0) throw new Error('unterminated comment'); i = e + 2; buf += ' '; continue; }
        if (c === '"' || c === "'") {
            let j = i + 1;
            while (j < src.length && src[j] !== c) { if (src[j] === '\n') throw new Error('unterminated string'); if (src[j] === '\\') j++; j++; }
            if (j >= src.length) throw new Error('unterminated string');
            buf += src.slice(i, j + 1); i = j + 1; afterTemplate = false; continue;
        }
        if (c === '`') {
            flush();
            const t = scanTemplate(src, i);
            segs.push(t.seg); i = t.end; afterTemplate = true; continue;
        }
        if (c === '/') {
            const tail = buf.replace(/\s+$/, '');
            const ch = tail.slice(-1);
            const regexOk = afterTemplate ? false : (ch === '' || REGEX_AFTER.has(ch) || REGEX_KEYWORD.test(tail));
            if (regexOk) {
                let j = i + 1, inClass = false;
                while (j < src.length) {
                    const x = src[j];
                    if (x === '\n') throw new Error('unterminated regular expression');
                    if (x === '\\') { j += 2; continue; }
                    if (x === '[') inClass = true; else if (x === ']') inClass = false;
                    else if (x === '/' && !inClass) break;
                    j++;
                }
                if (j >= src.length) throw new Error('unterminated regular expression');
                j++;
                while (j < src.length && /[a-z]/i.test(src[j])) j++;
                buf += src.slice(i, j); i = j; afterTemplate = false; continue;
            }
        }
        if (c === '{') depth++;
        else if (c === '}') {
            if (stopAtBrace && depth === 0) { flush(); return { segs, end: i }; }
            depth--;
            if (depth < 0 && !stopAtBrace) throw new Error('a closing brace with no opening one');
        }
        buf += c;
        if (!/\s/.test(c)) afterTemplate = false;
        i++;
    }
    if (stopAtBrace) throw new Error('braces do not close');
    flush();
    return { segs, end: i };
}

function scanTemplate(src, start) {
    const parts = [];
    let s = '', i = start + 1;
    while (i < src.length) {
        const c = src[i];
        if (c === '\\') { s += c + (src[i + 1] || ''); i += 2; continue; }
        if (c === '`') { parts.push({ s }); return { seg: { k: 'tpl', parts }, end: i + 1 }; }
        if (c === '$' && src[i + 1] === '{') {
            parts.push({ s }); s = '';
            const r = scanSource(src, i + 2, true);
            parts.push({ e: src.slice(i + 2, r.end), segs: r.segs });
            i = r.end + 1; continue;
        }
        s += c; i++;
    }
    throw new Error('unterminated template literal');
}

/** The code of a scanned function with every template literal replaced by one marker: what must stay identical. */
export function skeletonOf(segs) {
    return segs.map((s) => (s.k === 'code' ? s.t : '\u0001')).join('').replace(/\s+/g, ' ').trim();
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();
const STR_RE = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;

/** Every template literal, every `${}` expression and every string inside an expression, at any depth. */
export function gatherDeep(segs) {
    const out = { tpls: [], exprs: [], strs: [] };
    const walk = (list) => {
        for (const s of list) {
            if (s.k !== 'tpl') continue;
            out.tpls.push(s);
            for (const p of s.parts) {
                if (p.e === undefined) continue;
                out.exprs.push(p);
                for (const q of p.segs) if (q.k === 'code') for (const m of q.t.match(STR_RE) || []) out.strs.push(m.slice(1, -1));
                walk(p.segs);
            }
        }
    };
    walk(segs);
    return out;
}

/** All the code of a scan (template expressions included, template text and comments left out): the names a function really uses. */
export function codeText(segs) {
    return segs.map((s) => (s.k === 'code' ? s.t : s.parts.map((p) => (p.e !== undefined ? ` ${codeText(p.segs)} ` : ' ')).join(''))).join('');
}

const flatten = (tpl) => tpl.parts.map((p) => (p.s !== undefined ? p.s : '\u0002')).join('');
export const markupOf = (deep) => [...deep.tpls.map(flatten), ...deep.strs].join('\n');

/* ------------------------------------------------------------------ finding the one function */

/**
 * The function `name` in an HTML page: where it starts and ends, its source and its scan. It must occur exactly once.
 * @returns {{ok:true, start:number, end:number, src:string, segs:object[]}|{ok:false, why:string}}
 */
export function functionRange(html, name) {
    if (!RENDER_FN.test(String(name || ''))) return { ok: false, why: `${name} is not a render function (render + a capital letter)` };
    const re = new RegExp(`(?:^|[\\s;}])(?:async\\s+)?function\\s+${name}\\s*\\(`, 'g');
    const hits = [...html.matchAll(re)];
    if (hits.length !== 1) return { ok: false, why: `function ${name}() occurs ${hits.length} times in the page (it must be exactly once)` };
    const m = hits[0];
    const start = m.index + m[0].search(/(?:async\s+)?function/);
    let i = html.indexOf('(', start), depth = 0;
    for (; i < html.length; i++) { if (html[i] === '(') depth++; else if (html[i] === ')' && --depth === 0) break; }
    let j = i + 1;
    while (j < html.length && /\s/.test(html[j])) j++;
    if (html[j] !== '{') return { ok: false, why: `${name}() has no body the scanner can read` };
    try {
        const r = scanSource(html, j + 1, true);
        const end = r.end + 1;
        if (end - start > MAX_FN_CHARS) return { ok: false, why: `${name}() is longer than ${MAX_FN_CHARS} characters` };
        return { ok: true, start, end, src: html.slice(start, end), segs: r.segs };
    } catch (e) { return { ok: false, why: `the scanner could not read ${name}(): ${e.message}` }; }
}

/* ------------------------------------------------------------------ the markup guard */

const BANNED_NAMES = new Set(['new', 'function', 'eval', 'constructor', '__proto__', 'prototype', 'innerHTML', 'outerHTML', 'document', 'window', 'localStorage', 'sessionStorage', 'indexedDB', 'DB', 'fetch', 'XMLHttpRequest', 'Function', 'import', 'require', 'delete', 'void', 'class', 'async', 'await', 'yield', 'with', 'globalThis', 'self', 'top', 'parent', 'setTimeout', 'setInterval', 'Reflect', 'Proxy', 'arguments', 'this']);
const LITERALS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity']);
/** Methods that read or reshape a value and write nothing. */
const SAFE_METHODS = new Set(['map', 'filter', 'join', 'slice', 'length', 'toFixed', 'toLocaleString', 'trim', 'toUpperCase', 'toLowerCase', 'includes', 'indexOf', 'some', 'every', 'find', 'concat', 'reverse', 'size', 'padStart']);
/** What a raw field may sit inside without being a way to put markup on the page. */
const ESCAPERS = /^(?:_wfEsc|_wfJsAttr|esc\w*|escape\w*|fmt|fmt[A-Z]\w*|fmtDate\w*|Number|min|max|round|floor|ceil|abs|toFixed|toLocaleString)$/;
/** Properties that hold a number or a yes/no: showing them bare cannot carry markup. */
const NUMERIC_PROP = /^(?:paid|total|pct|percent\w*|count|length|remaining|left|done|months?|index|n|num\w*|monthly|amount|owed|outstanding|size)$/;

/**
 * Why a NEW `${expression}` may not go on the page, or an empty list. The expression is checked on its code only (nested template literals are
 * checked as their own expressions, with the arrow parameters of the ones around them in scope).
 */
export function exprProblems(e, ctx, inherited = new Set()) {
    const problems = [];
    const text = e.segs.map((s) => (s.k === 'code' ? s.t : 'T')).join('');
    const params = new Set(inherited);
    for (const m of text.matchAll(/(?:\(([\w$\s,]*)\)|\b([A-Za-z_$][\w$]*))\s*=>/g)) for (const n of (m[1] || m[2] || '').split(',').map((x) => x.trim()).filter(Boolean)) params.add(n);
    const toks = [];
    const re = /\s+|(\.\.\.)|([A-Za-z_$][\w$]*)|(\d[\d_.]*)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*')|(=>|===|!==|==|!=|<=|>=|&&|\|\||\?\?|\?\.|[().,[\]?:!<>])|([\s\S])/gy;
    let m;
    while (re.lastIndex < text.length && (m = re.exec(text))) {
        if (m[1]) problems.push('spread is not allowed');
        else if (m[2]) toks.push({ t: 'id', v: m[2] });
        else if (m[3]) toks.push({ t: 'num', v: m[3] });
        else if (m[4]) toks.push({ t: 'str', v: m[4] });
        else if (m[5]) toks.push({ t: 'op', v: m[5] });
        else if (m[6]) problems.push(`"${m[6]}" is not allowed in a new expression (no arithmetic, assignment, braces or statements)`);
    }
    for (let k = 0; k < toks.length; k++) {
        const tk = toks[k], prev = toks[k - 1], next = toks[k + 1];
        if (tk.t === 'op') continue;
        if (tk.t !== 'id') continue;
        if (tk.v === 'T') continue;
        const afterDot = prev && prev.t === 'op' && (prev.v === '.' || prev.v === '?.');
        if (BANNED_NAMES.has(tk.v)) { problems.push(`"${tk.v}" may not appear in a new expression`); continue; }
        if (LITERALS.has(tk.v)) continue;
        const isCall = next && next.t === 'op' && next.v === '(';
        if (afterDot) {
            if (!(ctx.ids.has(tk.v) || SAFE_METHODS.has(tk.v))) problems.push(`".${tk.v}" is not used anywhere in this function`);
            if (isCall && !(ctx.called.has(tk.v) || SAFE_METHODS.has(tk.v))) problems.push(`the method ${tk.v}() is not called anywhere in this function`);
        } else {
            if (!(ctx.ids.has(tk.v) || params.has(tk.v))) { problems.push(`"${tk.v}" is not a name this function uses`); continue; }
            if (isCall && !(ctx.called.has(tk.v) || params.has(tk.v))) problems.push(`${tk.v}() is not called anywhere in this function`);
        }
    }
    // a raw record field on the page is an XSS sink unless something escapes it, or it is a number/yes-no, or only a condition reads it
    const calls = [];
    for (let k = 0; k < toks.length; k++) {
        const tk = toks[k];
        if (tk.t === 'op' && tk.v === '(') calls.push(toks[k - 1] && toks[k - 1].t === 'id' ? toks[k - 1].v : '');
        else if (tk.t === 'op' && tk.v === ')') calls.pop();
        if (tk.t !== 'id' || BANNED_NAMES.has(tk.v) || LITERALS.has(tk.v) || tk.v === 'T') continue;
        const before = toks[k - 1];
        if (before && before.t === 'op' && (before.v === '.' || before.v === '?.')) continue;   // only the head of a chain starts one
        const head = k;
        let last = k;
        while (toks[last + 1] && toks[last + 1].t === 'op' && (toks[last + 1].v === '.' || toks[last + 1].v === '?.') && toks[last + 2] && toks[last + 2].t === 'id') last += 2;
        k = last;
        if (last === head) continue;                                                              // a bare name, not a field of a record
        const nextTok = toks[last + 1];
        if (nextTok && nextTok.t === 'op' && nextTok.v === '(') continue;                         // a method call: its result is checked as a call
        const finalProp = toks[last].v;
        // `(item.tags || []).map(…)`: the field is the thing a method works on, not what is printed
        let q = last + 1;
        if (toks[q] && toks[q].t === 'op' && (toks[q].v === '||' || toks[q].v === '??')) { q++; if (toks[q] && toks[q].t === 'op' && toks[q].v === '[') q += 2; else q++; }
        if (toks[q] && toks[q].t === 'op' && toks[q].v === ')') q++;
        const transformed = q > last + 1 && toks[q] && toks[q].t === 'op' && toks[q].v === '.' || (toks[last + 1] && toks[last + 1].t === 'op' && toks[last + 1].v === '.');
        const guarded = transformed || ESCAPERS.test(calls[calls.length - 1] || '');
        const asCondition = (before && before.t === 'op' && before.v === '!') || (nextTok && nextTok.t === 'op' && ['?', '&&', '===', '!==', '==', '!=', '<', '>', '<=', '>='].includes(nextTok.v));
        if (guarded || asCondition || NUMERIC_PROP.test(finalProp) || ctx.bareProps.has(finalProp)) continue;
        problems.push(`"${toks.slice(head, last + 1).map((x) => x.v).join('')}" would put a raw field on the page; wrap it as _wfEsc(…) like the other text fields`);
    }
    for (const s of e.segs) if (s.k === 'tpl') for (const p of s.parts) if (p.e !== undefined && !ctx.verbatim.has(norm(p.e))) problems.push(...exprProblems(p, ctx, params));
    return [...new Set(problems)];
}

const FORBIDDEN_MARKUP = [
    [/<\s*script\b/gi, 'a <script> element'],
    [/<\s*(?:iframe|object|embed|link|meta|base|form|style|frame|frameset|applet)\b/gi, 'an iframe, object, embed, link, meta, base, form or style element'],
    [/javascript\s*:/gi, 'a javascript: address'],
    [/\bsrcdoc\s*=/gi, 'srcdoc'],
    [/data\s*:\s*text\/html/gi, 'a data:text/html address'],
    [/\b(?:src|href|action|formaction|poster|xlink:href)\s*=\s*["']?\s*(?:https?:)?\/\//gi, 'an external address'],
    [/\burl\s*\(/gi, 'url()'],
    [/@import/gi, '@import'],
    [/display\s*:\s*none/gi, 'display:none (hiding something)'],
    [/visibility\s*:\s*hidden/gi, 'visibility:hidden (hiding something)'],
    [/font-size\s*:\s*0(?:px|em|rem|%)?\s*(?:[;"']|$)/gi, 'font-size:0 (hiding text)'],
    [/opacity\s*:\s*0(?:\.0*)?\s*(?:[;"']|$)/gi, 'opacity:0 (hiding something)'],
    [/expression\s*\(/gi, 'expression()'],
];
const HANDLER_RE = /\bon[a-z]{3,}\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const countRe = (re, text) => (String(text).match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
const normHandler = (v) => norm(String(v).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'"));

/** Does a window.WFName method exist in a wealthflow module on disk? */
export function apiMethodExists(api, method, repoDir = process.cwd()) {
    try {
        for (const f of fs.readdirSync(repoDir)) {
            if (!/^wealthflow-[a-z0-9-]+\.js$/.test(f)) continue;
            const src = fs.readFileSync(path.join(repoDir, f), 'utf8');
            if (new RegExp(`(?:root|window|self|globalThis)\\.${api}\\s*=|\\b${api}\\s*=\\s*(?:\\{|\\(|function)`).test(src) && new RegExp(`\\b${method}\\b`).test(src)) return true;
        }
    } catch (_) { /* nothing readable */ }
    return false;
}

function handlerOk(value, repoDir, exists) {
    const v = normHandler(value);
    const guarded = v.match(/^(?:window\.)?(WF[A-Za-z0-9]{2,40})\s*&&\s*(?:window\.)?(WF[A-Za-z0-9]{2,40})\.([A-Za-z_]\w{0,40})\(([^()<>;{}`]*)\)$/);
    if (guarded && guarded[1] === guarded[2]) return exists(guarded[1], guarded[3], repoDir);
    const plain = v.match(/^(?:window\.)?(WF[A-Za-z0-9]{2,40})\.([A-Za-z_]\w{0,40})\(([^()<>;{}`]*)\)$/);
    return Boolean(plain && exists(plain[1], plain[2], repoDir));
}

/**
 * Is the function after the edit still the same function with different words on the screen? Pure; returns every problem.
 * @param {string} before @param {string} after  the whole index.html text before and after
 */
export function checkMarkup({ before, after, fn, repoDir = process.cwd(), exists = apiMethodExists } = {}) {
    const problems = [];
    const a = functionRange(before, fn), b = functionRange(after, fn);
    if (!a.ok) return { ok: false, problems: [a.why] };
    if (!b.ok) return { ok: false, problems: [`after the edit: ${b.why}`] };
    if (before.slice(0, a.start) !== after.slice(0, b.start)) problems.push(`something before ${fn}() in index.html changed`);
    if (before.slice(a.end) !== after.slice(b.end)) problems.push(`something after ${fn}() in index.html changed`);
    if (skeletonOf(a.segs) !== skeletonOf(b.segs)) problems.push(`code outside the template literals of ${fn}() changed (only the text and markup inside \`…\` may change; a condition, a statement, a name or a number outside them may not)`);
    if (!isValidJs(b.src)) problems.push(`${fn}() after the edit is not valid JavaScript`);
    const da = gatherDeep(a.segs), db = gatherDeep(b.segs);
    const codeA = codeText(a.segs);
    const ids = new Set(codeA.match(/[A-Za-z_$][\w$]*/g) || []);
    const called = new Set([...codeA.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((x) => x[1]));
    const verbatim = new Set(da.exprs.map((x) => norm(x.e)));
    // properties the function already prints bare (a number or a flag the original author trusted)
    const bareProps = new Set();
    for (const x of da.exprs) { const m = norm(x.e).match(/^[A-Za-z_$][\w$]*(?:\??\.[A-Za-z_$][\w$]*)*\.([A-Za-z_$][\w$]*)$/); if (m) bareProps.add(m[1]); }
    const ctx = { ids, called, verbatim, bareProps };
    for (const e of db.exprs) {
        if (verbatim.has(norm(e.e))) continue;
        // an expression nested inside a new one is judged with the rest of it, not alone (its arrow parameters belong to the outer one)
        const nested = db.exprs.some((o) => o !== e && o.segs.some((s) => s.k === 'tpl' && s.parts.includes(e)));
        if (nested) continue;
        for (const p of exprProblems(e, ctx)) problems.push(`new expression \${${norm(e.e).slice(0, 70)}}: ${p}`);
    }
    const ma = markupOf(da), mb = markupOf(db);
    for (const [re, label] of FORBIDDEN_MARKUP) if (countRe(re, mb) > countRe(re, ma)) problems.push(`the edit adds ${label}`);
    const known = new Set([...ma.matchAll(HANDLER_RE)].map((x) => normHandler(x[1] ?? x[2])));
    for (const x of mb.matchAll(HANDLER_RE)) {
        const v = x[1] ?? x[2];
        if (known.has(normHandler(v))) continue;
        if (!handlerOk(v, repoDir, exists)) problems.push(`a new event handler (${normHandler(v).slice(0, 80)}) may only call window.WFName.method(…) of a module that exposes it`);
    }
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12), before: a, after: b };
}

/* ------------------------------------------------------------------ the CSS guard */

const LOOK_PROPERTIES = new Set(['color', 'border', 'border-top', 'border-right', 'border-bottom', 'border-left', 'border-color', 'border-width', 'border-style', 'border-radius', 'outline', 'outline-offset', 'font-weight', 'font-style', 'letter-spacing', 'text-transform', 'text-decoration', 'cursor', 'opacity', 'transition', '-webkit-tap-highlight-color', 'text-overflow', '-webkit-line-clamp', '-webkit-box-orient', 'min-inline-size', 'inline-size', 'scroll-snap-type', 'scroll-snap-align', 'scroll-padding', 'touch-action', 'accent-color', 'font', 'font-variant-numeric', 'line-clamp', 'transform']);
const HIDING = [['display', /^none\b/i], ['visibility', /^(hidden|collapse)\b/i], ['opacity', /^0?\.[0-4]\d*$|^0$/], ['font-size', /^0(px|em|rem|%)?$/i], ['width', /^0(px|em|rem|%)?$/i], ['height', /^0(px|em|rem|%)?$/i], ['max-width', /^0(px|em|rem|%)?$/i], ['max-height', /^0(px|em|rem|%)?$/i], ['color', /^transparent$/i]];
const SCREEN_SELECTOR = /(?:^|[\s>+~,(])(?:#page-[\w-]+|#wf[\w-]+|\.wf-[\w-]+)/;

/** Every rule of a style sheet as `{path, selector, body}`, at-rules of any depth included, so a change inside @supports is seen too. */
export function ruleList(css) {
    const text = stripComments(css);
    const out = [];
    const walk = (s, pathIn) => {
        let i = 0;
        while (i < s.length) {
            while (i < s.length && /\s/.test(s[i])) i++;
            if (i >= s.length) break;
            const semi = s.indexOf(';', i), open = s.indexOf('{', i);
            if (open < 0 || (semi >= 0 && semi < open)) { out.push({ path: pathIn.join(' | '), selector: s.slice(i, semi < 0 ? s.length : semi).trim(), body: '' }); i = semi < 0 ? s.length : semi + 1; continue; }
            const prelude = s.slice(i, open).trim();
            let depth = 1, j = open + 1;
            while (j < s.length && depth > 0) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++; }
            const inner = s.slice(open + 1, j - 1);
            i = j;
            if (prelude.startsWith('@') && inner.includes('{')) walk(inner, [...pathIn, norm(prelude)]);
            else out.push({ path: pathIn.join(' | '), selector: norm(prelude), body: norm(inner).replace(/\s*;\s*$/, '') });
        }
    };
    walk(text, []);
    return out;
}
const ruleKey = (r) => `${r.path}\u0001${r.selector}\u0001${r.body.split(';').map((d) => norm(d)).filter(Boolean).sort().join(';')}`;

/**
 * Is the CSS after the edit the CSS before it plus changes the lane may make? Added or changed rules are checked; a rule that disappears must
 * come back changed (same selector), never simply vanish.
 */
export function checkCss({ before, after, ownClasses = new Set() } = {}) {
    const problems = [];
    const A = ruleList(before), B = ruleList(after);
    const count = (list) => { const m = new Map(); for (const r of list) m.set(ruleKey(r), [...(m.get(ruleKey(r)) || []), r]); return m; };
    const ma = count(A), mb = count(B);
    const added = [], removed = [];
    for (const [k, rs] of mb) { const n = (ma.get(k) || []).length; for (const r of rs.slice(n)) added.push(r); }
    for (const [k, rs] of ma) { const n = (mb.get(k) || []).length; for (const r of rs.slice(n)) removed.push(r); }
    if (added.length > 14) problems.push(`${added.length} CSS rules added or changed; the limit is 14`);
    let declarations = 0;
    for (const r of added) {
        if (r.path && !/^@media [\w\s():,.\-><=%/]+$/i.test(r.path)) problems.push(`a rule inside "${r.path.slice(0, 50)}" (only @media may wrap an edited rule)`);
        if (r.selector.startsWith('@')) { problems.push(`an at-rule (${r.selector.slice(0, 30)}) may not be added`); continue; }
        const sels = splitTop(r.selector, ',');
        if (!sels.length) problems.push('a rule has no selector');
        for (const s of sels) {
            if (!SCREEN_SELECTOR.test(s)) problems.push(`selector "${s.slice(0, 60)}" does not name the screen (#page-… or a .wf- class)`);
            if (/[{};]/.test(s) || (/\*/.test(s) && !(/#page-[\w-]+/.test(s) && /\s>\s\*$/.test(s)))) problems.push(`selector "${s.slice(0, 60)}" uses a brace, or * other than as the last child (#page-… … > *)`);
        }
        const tablePart = sels.some((x) => /^(tr|td|th|thead|tbody|tfoot)(?![\w-])/i.test(x.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/[\s>+~]+/).pop() || ''));
        const lastClass = (x) => ((x.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/[\s>+~]+/).pop() || '').match(/\.wf-[\w-]+/g) || []).map((c) => c.slice(1));
        const clamps = /(?:^|;)\s*(?:-webkit-)?line-clamp\s*:|(?:^|;)\s*text-overflow\s*:/i.test(r.body);
        const ownOnly = sels.every((x) => lastClass(x).length > 0 && lastClass(x).every((c) => ownClasses.has(c)));
        const ownWf = sels.every((x) => lastClass(x).length > 0);
        for (const d of r.body.split(';').map((x) => x.trim()).filter(Boolean)) {
            declarations++;
            const k = d.indexOf(':');
            if (k < 1) { problems.push(`not a declaration: "${d.slice(0, 40)}"`); continue; }
            const prop = d.slice(0, k).trim().toLowerCase();
            const value = d.slice(k + 1).replace(/!important\s*$/i, '').trim();
            if (!ALLOWED_PROPERTIES.has(prop) && !LOOK_PROPERTIES.has(prop)) { problems.push(`property "${prop}" may not be set by this lane`); continue; }
            if (!value) { problems.push(`"${prop}" has no value`); continue; }
            if (/["'`\\<]|\burl\s*\(|@import|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(value)) problems.push(`"${prop}: ${value.slice(0, 40)}" holds a quote, url(), backslash or script-like text`);
            // a thing this very edit introduced may be switched off at a screen size (the Details button's summary line on a desktop); nothing else may
            for (const [p, re] of HIDING) if (prop === p && re.test(value) && !(prop === 'display' && /^none\b/i.test(value) && r.path && ownOnly)) problems.push(`"${prop}: ${value}" would hide content instead of laying it out`);
            // overflow:hidden is a clamp (an ellipsis or a line-clamp says so), never a silent cut
            if (/^overflow(-x|-y)?$/.test(prop) && /\b(hidden|clip)\b/i.test(value) && !clamps) problems.push(`"${prop}: ${value}" would cut content off (a clamp needs text-overflow or line-clamp beside it)`);
            if (prop === 'word-break' && /\b(break-all|break-word)\b/i.test(value)) problems.push(`"${prop}: ${value}" shreds words; fix the box instead`);
            if (prop === 'overflow-wrap' && /\banywhere\b/i.test(value) && !ownWf) problems.push(`"${prop}: ${value}" shreds words in a box this edit does not own; fix the box instead`);
            if (prop === 'transform' && !/^(?:(?:translate[XYZ]?|scale[XY]?)\([\w\s.,%-]*\)\s*)+$|^none$/i.test(value)) problems.push(`"transform: ${value.slice(0, 40)}" may only translate or scale`);
            if (tablePart && !/^(padding(-top|-right|-bottom|-left)?|position|min-width|max-width|width|white-space|word-break|overflow-wrap|hyphens|text-align|vertical-align|line-height|font-size|box-sizing|left|right|top|bottom|z-index|box-shadow|background|background-color|color|font-weight|border-bottom|border-top)$/.test(prop)) problems.push(`"${prop}" may not be set on a table row, cell or heading`);
        }
    }
    if (declarations > 80) problems.push(`${declarations} declarations; the limit is 80`);
    for (const r of removed) {
        const returns = added.some((x) => x.path === r.path && x.selector === r.selector);
        if (!returns) problems.push(`the rule "${r.selector.slice(0, 60)}" was deleted (a rule may be changed, never removed)`);
    }
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12), added, removed };
}

/* ------------------------------------------------------------------ the edits themselves */

/**
 * The author's reply as a list of find-and-replace edits, or why it is not one.
 * @returns {{ok:true, edits:{file:string, find:string, replace:string}[], why:string}|{ok:false, reason:string}}
 */
export function parseEdits(raw) {
    const j = raw && typeof raw === 'object' ? raw : null;
    if (!j) return { ok: false, reason: 'the author returned no JSON' };
    if (j.feasible === false) return { ok: false, reason: `the author says this cannot be done inside the screen's template: ${String(j.why_not || j.why || 'no reason given').slice(0, 240)}` };
    const list = Array.isArray(j.edits) ? j.edits : [];
    if (!list.length) return { ok: false, reason: 'the author returned no edits' };
    if (list.length > MAX_EDITS) return { ok: false, reason: `${list.length} edits; the limit is ${MAX_EDITS}` };
    const edits = [];
    let total = 0;
    for (const e of list) {
        const file = String(e && e.file || '').trim();
        if (file !== HTML_FILE && file !== CSS_FILE) return { ok: false, reason: `an edit names "${file.slice(0, 40)}"; only ${HTML_FILE} and ${CSS_FILE} may be edited` };
        if (typeof e.find !== 'string' || !e.find.length || e.find.length > MAX_FIND_CHARS) return { ok: false, reason: `an edit has no "find" text, or one over ${MAX_FIND_CHARS} characters` };
        if (typeof e.replace !== 'string' || e.replace.length > MAX_REPLACE_CHARS) return { ok: false, reason: `an edit has no "replace" text, or one over ${MAX_REPLACE_CHARS} characters` };
        if (e.find === e.replace) return { ok: false, reason: 'an edit replaces text with the same text' };
        total += e.replace.length;
        edits.push({ file, find: e.find, replace: e.replace });
    }
    if (total > MAX_TOTAL_REPLACE) return { ok: false, reason: `the replacements add up to ${total} characters; the limit is ${MAX_TOTAL_REPLACE}` };
    return { ok: true, edits, why: String(j.why || j.summary || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
}

/**
 * Apply the edits to files held in memory. Every `find` must occur EXACTLY ONCE in the ORIGINAL file, and edits to one file may not overlap.
 * @param {{[file:string]:string}} files
 * @returns {{ok:true, files:{[file:string]:string}}|{ok:false, problems:string[]}}
 */
export function applyEdits(files, edits, { fnRangeOf = null } = {}) {
    const problems = [];
    const byFile = {};
    for (const e of edits) {
        const text = files[e.file];
        if (typeof text !== 'string') { problems.push(`${e.file} is not available`); continue; }
        const at = text.indexOf(e.find);
        if (at < 0) { problems.push(`the text to find in ${e.file} is not there: "${norm(e.find).slice(0, 70)}"`); continue; }
        if (text.indexOf(e.find, at + 1) >= 0) { problems.push(`the text to find in ${e.file} occurs more than once: "${norm(e.find).slice(0, 70)}" (add more of the line around it so it is unique)`); continue; }
        if (e.file === HTML_FILE && fnRangeOf && (at < fnRangeOf.start || at + e.find.length > fnRangeOf.end)) { problems.push(`the text to find in ${e.file} is outside the function ${fnRangeOf.name}(): "${norm(e.find).slice(0, 70)}"`); continue; }
        (byFile[e.file] = byFile[e.file] || []).push({ at, end: at + e.find.length, replace: e.replace });
    }
    if (problems.length) return { ok: false, problems };
    const out = { ...files };
    for (const [f, list] of Object.entries(byFile)) {
        list.sort((x, y) => x.at - y.at);
        for (let k = 1; k < list.length; k++) if (list[k].at < list[k - 1].end) { problems.push(`two edits in ${f} overlap`); }
        if (problems.length) return { ok: false, problems };
        let t = files[f];
        for (const x of [...list].reverse()) t = t.slice(0, x.at) + x.replace + t.slice(x.end);
        out[f] = t;
    }
    return { ok: true, files: out };
}

/** The same ceiling rule the build lane uses: the byte ceiling keeps 0.25% headroom, the change and the reason are written beside it. */
export function raiseHtmlCeiling({ repoDir = process.cwd(), htmlBytes, issue = '', now = new Date() } = {}) {
    const budgetPath = path.join(repoDir, 'autonomy', 'perf-budget.mjs');
    let src;
    try { src = fs.readFileSync(budgetPath, 'utf8'); } catch (_) { return { ok: false, reason: 'perf-budget.mjs is not readable' }; }
    const re = /(^\s*htmlBytes:\s*)([0-9_]+)(,)([^\n]*)$/m;
    const m = src.match(re);
    if (!m) return { ok: false, reason: 'could not find htmlBytes in perf-budget.mjs' };
    const limit = Number(m[2].replace(/_/g, ''));
    if (htmlBytes <= limit) return { ok: true, changed: false };
    const to = Math.ceil(htmlBytes * 1.0025 / 500) * 500;
    const stamp = now.toISOString().slice(0, 10);
    const next = src.replace(re, (_, a, _n, c, rest) => `${a}${String(to).replace(/\B(?=(\d{3})+(?!\d))/g, '_')}${c} // ${stamp}: raised from ${limit} for an edit to a screen (edit lane${issue ? `, #${issue}` : ''}); measured ${htmlBytes}.${rest.replace(/^\s*\/\/\s?/, ' // ')}`);
    return { ok: true, changed: true, to, from: limit, text: next };
}

/* ------------------------------------------------------------------ what the author is shown, and told */

/** The wf-ui.css rules that style this screen or the classes its function prints (capped), so the author edits real rules instead of inventing a parallel set. */
export function cssContextFor({ css, fnSrc, scope = '', max = 5000 } = {}) {
    const classes = new Set([...String(fnSrc).matchAll(/class\s*=\s*\\?["']([^"'`$]*)/g)].flatMap((m) => m[1].split(/\s+/)).filter((c) => /^[\w-]+$/.test(c)));
    const hasClass = (sel, c) => new RegExp(`\\.${c.replace(/-/g, '\\-')}(?![\\w-])`).test(sel);
    const scored = ruleList(css).filter((r) => r.selector && !r.selector.startsWith('@')).map((r) => ({ r, score: (scope && r.selector.includes(scope) ? 3 : 0) + ([...classes].some((c) => c.startsWith('wf-') && hasClass(r.selector, c)) ? 2 : 0) + ([...classes].some((c) => hasClass(r.selector, c)) ? 1 : 0) })).filter((x) => x.score > 0);
    scored.sort((x, y) => y.score - x.score);
    let out = '';
    for (const { r } of scored) {
        const line = `${r.path ? `${r.path} { ` : ''}${r.selector} { ${r.body} }${r.path ? ' }' : ''}\n`;
        if (out.length + line.length > max) continue;
        out += line;
    }
    return out;
}

export function editPrompt({ issueText, fn, fnSrc, cssText, scope, problems = '', previous = '' }) {
    return [
        `You are changing ONE existing screen of WealthFlow, a personal-finance PWA, so that what the OWNER reported is fixed. You edit by FIND-AND-REPLACE, in two files only.`,
        '',
        "THE OWNER'S REPORT:", fenceUntrusted('report', issueText, 3200), '',
        `THE FUNCTION THAT DRAWS THE SCREEN (${HTML_FILE}, ${fn}()), exactly as it is now:`,
        '```js', String(fnSrc).replace(/`{3,}/g, "'''").slice(0, 26_000), '```', '',
        ...(cssText ? [`THE RULES IN ${CSS_FILE} THAT STYLE IT (the screen's own id is ${scope || '(unknown)'}):`, '```css', cssText, '```', ''] : []),
        'WHAT YOU MAY CHANGE (a program checks every one of these, your edit is thrown away if it breaks one):',
        `  1. In ${HTML_FILE}: ONLY text and markup INSIDE the template literals (\`…\`) of ${fn}(), and only that function. Every character outside its template literals stays identical: no new statement, no changed condition, no new variable, no changed name or number.`,
        '  2. A new ${expression} inside a template may use ONLY names the function already uses and call ONLY functions it already calls, and may not use arithmetic (+ - * / %), assignment, braces or statements. A raw record field (item.notes) must be wrapped in the page\'s own escaper, _wfEsc(item.notes), exactly like the neighbouring fields; numbers such as prog.paid may stand alone. If you need a number that is not already computed in the function, say so: you cannot add one.',
        `  3. No <script>, <iframe>, <form>, <link>, <style>, external address, url(), display:none, or hidden text. A new onclick may only call window.WFName.method(…) of a wealthflow module that really exposes it (the way the existing buttons do, guarded as: window.WFName && window.WFName.method(…)).`,
        `  4. In ${CSS_FILE}: new or changed rules whose selector names the screen (${scope || '#page-…'} or a .wf- class), layout and look properties only (spacing, size, flex/grid, wrapping, colour, border, radius), never anything that hides, clips or shreds text, no url(), no quotes. A rule may be changed, never deleted.`,
        '  5. NEVER touch how money is calculated, saved or synced. You cannot: those are code, and code outside the templates is compared byte by byte. Do not try to fix a wrong NUMBER here; fix what is MISSING or UNREADABLE on the screen.',
        '',
        'HOW TO EDIT: each edit is {"file","find","replace"}. "find" is text copied EXACTLY from the code or CSS above and must occur EXACTLY ONCE in that file (include enough of the line around it to be unique). Make the smallest edits that fully fix what the owner reported; do not reformat or rewrite. Think about a PHONE 430px wide: the text must wrap, the buttons must be at least 44px tall, nothing may be cut off, and a row the owner should be able to tap must look tappable (a visible button or an obvious label).',
        '',
        ...(previous ? ['YOUR PREVIOUS EDITS (they were refused or the phone run found problems; change only what is needed):', '```json', previous.slice(0, 7000), '```', ''] : []),
        ...(problems ? ['WHAT WAS WRONG WITH THEM:', problems.slice(0, 3500), ''] : []),
        'Reply with ONE JSON object and nothing else:',
        '{"feasible":true,"why":"two sentences: what was wrong on the phone and what you changed","edits":[{"file":"index.html","find":"…","replace":"…"},{"file":"wf-ui.css","find":"…","replace":"…"}]}',
        'If the report cannot be fixed by changing the words, markup and look of this one screen (it needs new logic or new data), reply {"feasible":false,"why_not":"one sentence"} and change nothing.',
    ].join('\n');
}

/**
 * The id of the page (section) a render function draws into: the ids it fetches with $('…') or getElementById('…'), looked up in the page, and the
 * nearest `id="page-…"` above the first one found. '' when it cannot tell (the author is then shown the rules by class only).
 */
export function pageScopeOf(html, fnSrc) {
    const ids = [...String(fnSrc).matchAll(/(?:\$|getElementById)\(\s*['"]([\w-]+)['"]\s*\)/g)].map((m) => m[1]);
    const counts = new Map();
    for (const id of ids) {
        const at = html.indexOf(`id="${id}"`);
        if (at < 0) continue;
        const head = html.slice(Math.max(0, at - 60_000), at);
        const all = [...head.matchAll(/\bid="(page-[\w-]+)"/g)];
        const m = all[all.length - 1];
        if (m) counts.set(m[1], (counts.get(m[1]) || 0) + 1);
    }
    const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? `#${best[0]}` : '';
}

/* ------------------------------------------------------------------ the lane */

/** Does the lane apply to this report and screen? Pure. */
export function editLaneFor({ home, kind = '', env = process.env } = {}) {
    if (env.WF_EDIT_LANE === '0') return { applies: false, why: 'WF_EDIT_LANE=0' };
    if (!home || !home.found) return { applies: false, why: 'no screen was found for the report' };
    if (home.file !== HTML_FILE) return { applies: false, why: `the screen is drawn in ${home.file}, not ${HTML_FILE}` };
    if (!RENDER_FN.test(String(home.fn || ''))) return { applies: false, why: `${home.fn}() is not a render function` };
    if (!['bug', 'ui'].includes(kind)) return { applies: false, why: `a "${kind}" report is not about how a screen reads or looks` };
    return { applies: true, why: `${home.fn}() in ${HTML_FILE} may be edited by this lane (text, markup and look only)` };
}

const stripIntegrity = (html) => html.replace(/\s+integrity="sha(?:256|384|512)-[^"]*"/g, '');

/**
 * @param {object} o
 * @param {{number?:number, title?:string, body?:string}} o.issue
 * @param {{fn:string, code?:string, hits?:string[]}} o.home  from symptomHome (the render function that draws the words the owner saw)
 * @param {Function|null} o.accept  runAcceptance (autonomy/acceptance.mjs). Required: no phone run, no pull request.
 * @returns {Promise<object>} { ok:true, stage:'ready', lane:'edit', file, code, files, … } or { ok:false, stage, reason }
 */
export async function runEditLane({ issue, home, repoDir = process.cwd(), env = process.env, log = console.log, accept = null, deps = {} } = {}) {
    const ask = deps.chat || chat;
    const issueText = `${issue?.title || ''}\n\n${issue?.body || ''}`.trim();
    if (!issueText) return { ok: false, stage: 'input', reason: 'empty issue' };
    const fn = home && home.fn;
    const providers = {};
    const htmlPath = path.join(repoDir, HTML_FILE), cssPath = path.join(repoDir, CSS_FILE);
    let html, css;
    try { html = fs.readFileSync(htmlPath, 'utf8'); css = fs.readFileSync(cssPath, 'utf8'); } catch (e) { return { ok: false, stage: 'input', reason: `cannot read ${HTML_FILE} / ${CSS_FILE}: ${e.message}` }; }
    const range = functionRange(html, fn);
    if (!range.ok) return { ok: false, stage: 'input', reason: range.why };
    if (!isValidJs(range.src)) return { ok: false, stage: 'input', reason: `${fn}() does not parse on its own, so edits to it cannot be checked` };
    const scopeId = (`${issue?.title || ''}\n${issue?.body || ''}`.match(/#page-[\w-]+/) || [])[0];
    const scope = scopeId || pageScopeOf(html, range.src);
    const cssText = cssContextFor({ css, fnSrc: range.src, scope });
    const role = ROLES.ui;
    const original = { [HTML_FILE]: html, [CSS_FILE]: css };

    /** One try of the author: the edits, parsed, applied in memory and checked by the guards. */
    const author = async (problems, previous) => {
        const a = await ask({ system: role.system, prompt: editPrompt({ issueText, fn, fnSrc: range.src, cssText, scope, problems, previous }), prefer: role.prefer, maxTokens: 6000, temperature: previous ? 0.15 : 0.1, env })
            .catch((e) => ({ text: '', provider: 'none', _error: e.message }));
        providers.author = a.provider;
        let json = null; try { json = a.text ? extractJson(a.text) : null; } catch (_) { json = null; }
        const parsed = parseEdits(json);
        if (!parsed.ok) return { ok: false, reason: parsed.reason, infeasible: Boolean(json && json.feasible === false), provider: a.provider, raw: json };
        const applied = applyEdits(original, parsed.edits, { fnRangeOf: { start: range.start, end: range.end, name: fn } });
        if (!applied.ok) return { ok: false, reason: applied.problems.join('; '), provider: a.provider, raw: json };
        const files = applied.files;
        const bad = [];
        if (files[HTML_FILE] !== html) { const m = checkMarkup({ before: html, after: files[HTML_FILE], fn, repoDir, exists: deps.exists || apiMethodExists }); if (!m.ok) bad.push(...m.problems); }
        if (files[CSS_FILE] !== css) { const c = checkCss({ before: css, after: files[CSS_FILE] }); if (!c.ok) bad.push(...c.problems); }
        if (files[HTML_FILE] === html && files[CSS_FILE] === css) bad.push('the edits change nothing');
        if (bad.length) return { ok: false, reason: bad.join('; '), provider: a.provider, raw: json };
        return { ok: true, edits: parsed.edits, why: parsed.why, files, provider: a.provider, raw: json };
    };

    // 1. the author, with the guards sending it back up to twice
    let attempt = null, why = '', prev = '';
    for (let k = 0; k < 3; k++) {
        attempt = await author(why, prev);
        if (attempt.ok) break;
        log(`[edit] attempt ${k + 1} refused: ${String(attempt.reason).slice(0, 240)}`);
        if (attempt.infeasible) return { ok: false, stage: 'author', file: HTML_FILE, providers, reason: attempt.reason };
        why = attempt.reason; prev = JSON.stringify(attempt.raw || {}, null, 1);
    }
    if (!attempt.ok) return { ok: false, stage: 'author', file: HTML_FILE, providers, reason: `no acceptable edit after 3 tries: ${String(attempt.reason).slice(0, 400)}` };
    log(`[edit] edits accepted by the guards (${attempt.edits.length} edits, via ${attempt.provider}): ${attempt.why}`);

    // 2. THE PHONE RUN. The edited page is served from memory, run at the owner's phone size, and judged by two models who must quote the screen.
    if (typeof accept !== 'function') return { ok: false, stage: 'acceptance', file: HTML_FILE, providers, reason: 'the acceptance run is switched off (WF_ACCEPTANCE=0): this lane never opens a pull request without a run on a phone' };
    const overlayOf = (files) => ({ [HTML_FILE]: stripIntegrity(files[HTML_FILE]), [CSS_FILE]: files[CSS_FILE] });
    const factsOf = (att) => [
        `THE CHANGE UNDER TEST: ${att.why || 'edits to the screen'}.`,
        `The screen is drawn by ${fn}() in ${HTML_FILE}${scope ? ` and its page is ${scope}` : ''}. It reads these books: ${(home.books || []).map((b) => `DB.get('${b}')`).join(', ') || 'see the code'}.`,
        'Edited text and markup (after the change):',
        ...att.edits.filter((e) => e.file === HTML_FILE).map((e) => `  ${norm(e.replace).slice(0, 700)}`),
        ...att.edits.filter((e) => e.file === CSS_FILE).map((e) => `  CSS: ${norm(e.replace).slice(0, 400)}`),
    ].join('\n');
    let acceptance = null;
    const runIt = async (att) => {
        try {
            const after = functionRange(att.files[HTML_FILE], fn);
            return await accept({ issue: { title: issue?.title, body: issue?.body }, module: { name: HTML_FILE, api: '', code: after.ok ? after.src : fn, overlay: overlayOf(att.files) }, facts: factsOf(att), surface: [], repoDir, env, log: (m) => log(m) });
        } catch (e) { log(`[edit] the acceptance run could not start: ${String(e && e.message || e).slice(0, 160)}`); return null; }
    };
    const rounds = [];
    for (let round = 0; ; round++) {
        acceptance = await runIt(attempt);
        log(`[edit] phone run: ${acceptance ? acceptance.status : 'did not start'}${acceptance && acceptance.blocking && acceptance.blocking.length ? ` (${acceptance.blocking.length} blocking)` : ''}${acceptance && acceptance.reason ? ` — ${acceptance.reason}` : ''}`);
        if (!acceptance || acceptance.status !== 'problems') break;
        rounds.push({ round: round + 1, blocking: acceptance.blocking.length, kinds: [...new Set(acceptance.blocking.map((f) => f.kind))] });
        if (round >= MAX_ACCEPT_REVISIONS) break;
        log(`[edit] the phone run found ${acceptance.blocking.length} problem(s): the author gets them (revision ${round + 1}/${MAX_ACCEPT_REVISIONS})`);
        let next = null, again = `THE EDITED PAGE WAS RUN ON A PHONE AND JUDGED AGAINST THE OWNER'S REPORT. PROBLEMS FOUND (each quotes what was on the screen):\n${findingsBrief(acceptance.findings)}\nReturn the COMPLETE new set of edits (against the ORIGINAL code above, not against your previous edits).`;
        for (let k = 0; k < 2 && !next; k++) {
            const cand = await author(again, JSON.stringify(attempt.raw || {}, null, 1));
            if (cand.ok) next = cand; else { log(`[edit] the revision was refused by the guards: ${String(cand.reason).slice(0, 200)}`); again += `\nTHE LAST TRY WAS REFUSED: ${cand.reason}`; }
        }
        if (!next) break;
        attempt = next;
    }
    if (!acceptance) return { ok: false, stage: 'acceptance', file: HTML_FILE, providers, reason: 'the phone run could not start' };
    if (acceptance.status !== 'passed') {
        const detail = acceptance.status === 'problems' ? `problems remain after ${rounds.length} run(s): ${findingsBrief(acceptance.findings).slice(0, 500)}` : `${acceptance.status}${acceptance.reason ? ` — ${acceptance.reason}` : ''}`;
        return { ok: false, stage: 'acceptance', file: HTML_FILE, providers, acceptance, reason: `the edited screen did not pass the phone run (${detail})` };
    }

    // 3. an independent reviewer on a different provider reads the whole change
    const { files } = attempt;
    const afterRange = functionRange(files[HTML_FILE], fn);
    const cssCheck = checkCss({ before: css, after: files[CSS_FILE] });
    const cssText2 = (list) => list.map((r) => `${r.path ? `${r.path} { ` : ''}${r.selector} { ${r.body} }${r.path ? ' }' : ''}`).join('\n');
    const beforeText = `/* ${HTML_FILE} ${fn}() */\n${range.src}\n\n/* ${CSS_FILE}: rules before the change */\n${cssText2(cssCheck.removed)}`;
    const afterText = `/* ${HTML_FILE} ${fn}() */\n${afterRange.src}\n\n/* ${CSS_FILE}: rules added or changed */\n${cssText2(cssCheck.added)}`;
    if (!reviewSeesWholeChange(beforeText, afterText)) return { ok: false, stage: 'review_too_large', file: HTML_FILE, providers, reason: 'the change is larger than the independent review can read in full' };
    const r = await ask({ system: ROLES.security.system, prompt: reviewPrompt(issueText, `${HTML_FILE} (${fn}) + ${CSS_FILE}`, beforeText, afterText), prefer: ROLES.security.prefer, exclude: [attempt.provider], maxTokens: 1500, temperature: 0, env })
        .catch((e) => ({ text: '', provider: 'none', _error: e.message }));
    providers.security = r.provider;
    if (!r.text) return { ok: false, stage: 'security_unavailable', file: HTML_FILE, providers, reason: 'no independent security reviewer was available' };
    const review = parseVerdict(r.text);
    if (review.verdict === 'FAIL') return { ok: false, stage: 'security', file: HTML_FILE, providers, review, acceptance, reason: `Agent 5 veto (${review.severity}): ${review.reason}` };
    log(`[edit] Agent 5 verdict: PASS (via ${r.provider})`);

    // 4. the result: the page file first (it is what the owner sees), the style sheet beside it
    const changedHtml = files[HTML_FILE] !== html, changedCss = files[CSS_FILE] !== css;
    const primary = changedHtml ? HTML_FILE : CSS_FILE;
    const others = {};
    if (changedHtml && changedCss) others[CSS_FILE] = files[CSS_FILE];
    let budget = { ok: true, changed: false };
    if (changedHtml) budget = raiseHtmlCeiling({ repoDir, htmlBytes: Buffer.byteLength(files[HTML_FILE]), issue: issue?.number || '' });
    if (!budget.ok) return { ok: false, stage: 'wiring', file: primary, providers, reason: budget.reason };
    if (budget.changed) others['autonomy/perf-budget.mjs'] = budget.text;
    return {
        ok: true, stage: 'ready', lane: 'edit', role: 'ui', file: primary, code: files[primary], files: others,
        test: null, testFile: null, testProof: null, verified: true, review, providers,
        change: `${fn}() in ${HTML_FILE}${changedCss ? ` and ${cssCheck.added.length} rule(s) in ${CSS_FILE}` : ''}: ${attempt.why}`, observation: '',
        edit: { fn, scope, edits: attempt.edits.length, htmlChanged: changedHtml, cssRules: cssCheck.added.length, budgetRaised: budget.changed ? `${budget.from} -> ${budget.to}` : '' },
        acceptance: { ...acceptance, rounds, summary: acceptanceSummary(acceptance) },
    };
}
