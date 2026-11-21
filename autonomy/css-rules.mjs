/* =============================================================================
 * autonomy/css-rules.mjs — the layout lane's strict CSS reader, with NO dependencies
 * -----------------------------------------------------------------------------
 * Split out of css-lane.mjs (2026-11-21) so a job that must not install anything (the PR recovery workflow runs `node` on a bare checkout)
 * can apply EXACTLY the same rules the lane applied before it opened a pull request, instead of a copy that could drift.
 * css-lane.mjs imports and re-exports everything here, so existing imports keep working.
 * ===========================================================================*/

export const LANE_FILE = 'wf-agent-fixes.css';
export const MAX_CSS_CHARS = 3000;
export const MAX_DECLARATIONS = 40;
export const MAX_ROUNDS = 3;

/** Layout properties the author may set. Colours, content, fonts, URLs and animation are not here on purpose. */
export const ALLOWED_PROPERTIES = new Set([
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'clear',
    'flex', 'flex-direction', 'flex-wrap', 'flex-grow', 'flex-shrink', 'flex-basis', 'order',
    'grid', 'grid-template-columns', 'grid-template-rows', 'grid-template-areas', 'grid-column', 'grid-row', 'grid-area', 'grid-auto-flow', 'grid-auto-columns', 'grid-auto-rows',
    'gap', 'row-gap', 'column-gap',
    'align-items', 'align-content', 'align-self', 'justify-content', 'justify-items', 'justify-self', 'place-items', 'place-content',
    'width', 'min-width', 'max-width', 'height', 'min-height', 'max-height', 'box-sizing',
    'margin', 'margin-top', 'margin-right', 'margin-bottom', 'margin-left',
    'padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
    'overflow', 'overflow-x', 'overflow-y', 'white-space', 'word-break', 'overflow-wrap', 'hyphens',
    'text-align', 'vertical-align', 'line-height', 'font-size',
    'table-layout', 'border-collapse', 'border-spacing',
    'box-shadow', 'background', 'background-color',
    '-webkit-overflow-scrolling', 'overscroll-behavior-x',
]);

/** The last compound of a selector is a table row, cell or heading: it must stay a table part. */
const TABLE_PART = /^(tr|td|th|thead|tbody|tfoot)(?![\w-])/i;
const TABLE_SAFE = new Set(['padding', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'position', 'min-width', 'max-width', 'width', 'white-space', 'word-break', 'overflow-wrap', 'hyphens', 'text-align', 'vertical-align', 'line-height', 'font-size', 'box-sizing', 'left', 'right', 'top', 'bottom', 'z-index', 'box-shadow', 'background', 'background-color']);

const SOMETHING_THAT_HIDES = [
    ['display', /^none\b/i], ['visibility', /^(hidden|collapse)\b/i], ['opacity', /^0(\.0+)?$/],
    ['font-size', /^0(px|em|rem|%)?$/i], ['width', /^0(px|em|rem|%)?$/i], ['height', /^0(px|em|rem|%)?$/i],
    ['max-width', /^0(px|em|rem|%)?$/i], ['max-height', /^0(px|em|rem|%)?$/i],
];

// ── a small, strict CSS reader (no dependency; refuses what it does not understand) ──────────────
export function stripComments(css) { return String(css || '').replace(/\/\*[\s\S]*?\*\//g, ''); }

export function splitTop(s, sep) {
    const out = []; let depth = 0, cur = '';
    for (const ch of s) {
        if (ch === '(' || ch === '[') depth++;
        else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1);
        if (ch === sep && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim()).filter(Boolean);
}

export function readBlocks(css, problems, nested = false) {
    const rules = [];
    let i = 0;
    while (i < css.length) {
        while (i < css.length && /\s/.test(css[i])) i++;
        if (i >= css.length) break;
        const open = css.indexOf('{', i);
        if (open < 0) { problems.push('text outside any rule: "' + css.slice(i, i + 30).trim() + '"'); break; }
        const prelude = css.slice(i, open).trim();
        let depth = 1, j = open + 1;
        while (j < css.length && depth > 0) { if (css[j] === '{') depth++; else if (css[j] === '}') depth--; j++; }
        if (depth !== 0) { problems.push('unbalanced braces'); break; }
        const inner = css.slice(open + 1, j - 1);
        i = j;
        if (prelude.startsWith('@')) {
            if (!/^@media\s/i.test(prelude) || nested) { problems.push('only one level of @media is allowed, not "' + prelude.slice(0, 30) + '"'); continue; }
            if (/[^\w\s():,.\-><=%/]/.test(prelude.slice(6))) problems.push('the @media condition has characters that are not allowed');
            rules.push(...readBlocks(inner, problems, true).map((r) => ({ ...r, media: prelude })));
        } else {
            if (inner.includes('{')) { problems.push('nested rules are not allowed'); continue; }
            rules.push({ selector: prelude, body: inner, media: '' });
        }
    }
    return rules;
}

/**
 * Is this CSS something the lane may append? Pure; returns every problem, not just the first.
 * @param {string} css
 * @param {{ scope:string }} opt  the screen's own id selector, e.g. "#page-ccinstall"
 */
export function validateCss(css, { scope, allowShred = false } = {}) {
    const problems = [];
    const text = stripComments(css).trim();
    if (!text) return { ok: false, problems: ['no CSS'], rules: 0, declarations: 0 };
    if (text.length > MAX_CSS_CHARS) problems.push(`too long (${text.length} characters; the limit is ${MAX_CSS_CHARS})`);
    if (!scope || !/^#[\w-]+$/.test(scope)) problems.push('no screen scope was given');
    if (/["'`\\<]|@import|@font-face|@charset|\burl\s*\(|expression\s*\(|javascript:|behavior\s*:|-moz-binding/i.test(text)) {
        problems.push('quotes, backslashes, url(), @import, @font-face, expression() and script-like text are not allowed');
    }
    const rules = readBlocks(text, problems);
    let declarations = 0;
    if (!rules.length && !problems.length) problems.push('no rules found');
    for (const r of rules) {
        const sels = splitTop(r.selector, ',');
        if (!sels.length) problems.push('a rule has no selector');
        for (const s of sels) {
            if (scope && !s.includes(scope)) problems.push(`selector "${s.slice(0, 60)}" does not name ${scope}`);
            if (/[{};]/.test(s)) problems.push('a selector contains a brace or semicolon');
        }
        const tableParts = sels.some((x) => TABLE_PART.test(x.replace(/\[[^\]]*\]|\([^)]*\)/g, '').split(/[\s>+~]+/).pop() || ''));
        for (const d of r.body.split(';').map((x) => x.trim()).filter(Boolean)) {
            declarations++;
            const k = d.indexOf(':');
            if (k < 1) { problems.push(`not a declaration: "${d.slice(0, 40)}"`); continue; }
            const prop = d.slice(0, k).trim().toLowerCase();
            const value = d.slice(k + 1).replace(/!important\s*$/i, '').trim();
            if (!ALLOWED_PROPERTIES.has(prop)) { problems.push(`property "${prop}" is not a layout property the lane may set`); continue; }
            if (!value) { problems.push(`"${prop}" has no value`); continue; }
            // The shortcut that silences an overlap by shredding the text (#531: one letter per line in a 24px grid track). Fix the box, not the words.
            if (!allowShred && (((prop === 'overflow-wrap' || prop === 'word-wrap') && /\banywhere\b/i.test(value)) || (prop === 'word-break' && /\b(break-all|break-word)\b/i.test(value)))) {
                problems.push(`"${prop}: ${value}" breaks words into pieces; widen or restack the box that squeezes the text instead (change grid-template-columns or the flex/grid layout)`);
            }
            if (/^overflow(-x|-y)?$/.test(prop) && /\b(hidden|clip)\b/i.test(value)) problems.push(`"${prop}: ${value}" would cut content off; use auto or scroll so the person can still reach it`);
            if (tableParts && !TABLE_SAFE.has(prop)) problems.push(`"${prop}" may not be set on a table row, cell or heading: changing how table parts are laid out breaks the columns (a figure ends up under the wrong title)`);
            if (tableParts && prop === 'position' && !/^(static|relative)\b/i.test(value)) problems.push('a table cell may only be position: static or relative (use static to un-stick a column)');
            for (const [p, re] of SOMETHING_THAT_HIDES) {
                if (prop === p && re.test(value)) problems.push(`"${prop}: ${value}" would hide content instead of laying it out`);
            }
        }
    }
    if (declarations > MAX_DECLARATIONS) problems.push(`${declarations} declarations; the limit is ${MAX_DECLARATIONS}`);
    return { ok: problems.length === 0, problems: [...new Set(problems)].slice(0, 12), rules: rules.length, declarations };
}

/** The whole lane file must pass on every CI run, however it was edited. Blocks are `/* #N … *​/` headed. */
export function validateLaneFile(content) {
    const problems = [];
    const blocks = String(content || '').split(/(?=\/\*\s*lane-block:)/).filter((b) => /^\/\*\s*lane-block:/.test(b));
    for (const b of blocks) {
        const head = b.match(/^\/\*\s*lane-block:\s*(\S+)\s+scope=(#[\w-]+)/);
        if (!head) { problems.push('a block has no "lane-block: <issue> scope=#id" header'); continue; }
        // allowShred: blocks already merged (514 breaks long words in table cells, measured fine) stay valid; only NEW blocks are held to it
        const v = validateCss(b.replace(/^\/\*[\s\S]*?\*\//, ''), { scope: head[2], allowShred: true });
        if (!v.ok) problems.push(`block ${head[1]}: ${v.problems.join('; ')}`);
    }
    const text = String(content || '');
    const first = text.search(/\/\*\s*lane-block:/);
    const before = (first < 0 ? text : text.slice(0, first)).replace(/\/\*[\s\S]*?\*\//g, '').trim();
    if (before) problems.push('there is CSS before the first headed block');
    return { ok: problems.length === 0, problems, blocks: blocks.length };
}

/** The file after this fix is appended: a header the validator can read, then the CSS. */
export function appendFix(existing, css, { issue, scope, title = '' } = {}) {
    const base = String(existing || '').replace(/\s+$/, '');
    const head = `/* lane-block: ${issue} scope=${scope} — ${String(title).replace(/[*/\n]/g, ' ').slice(0, 70)} */`;
    return `${base}\n\n${head}\n${stripComments(css).trim()}\n`;
}
