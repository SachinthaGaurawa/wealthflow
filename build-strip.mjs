/* =============================================================================
 * build-strip.mjs — take the reasons out of the shipped copy
 * -----------------------------------------------------------------------------
 * This repository is written with the reasoning in the source. Comments here are
 * not decoration: they are the record of which bug a line exists to prevent, and
 * removing them from the REPOSITORY would delete the only thing standing between
 * a future edit and the same bug happening again.
 *
 * The owner's phone does not need any of it. index.html ships at nearly 2 MB and
 * a large part of that is prose nobody will ever read in a browser, downloaded
 * again on every version change.
 *
 * So: the repository keeps every word, and the DEPLOYED copy is stripped. Same
 * behaviour, a fraction of the bytes, and nothing about the source changes.
 *
 * ── WHY THIS IS A SCANNER AND NOT A REGULAR EXPRESSION ──────────────────────
 *
 * `s.replace(/\/\*[\s\S]*?\*\//g, '')` is the obvious version and it silently
 * corrupts code. Every one of these shapes is real in this repository:
 *
 *     const url = 'https://api...'        // "//" inside a string
 *     const re = /[^\/]*\/\/x/;           // "//" inside a regex literal
 *     `a ${b ? '/*' : ''} c`              // "/*" inside a template
 *     const half = a / b / c;             // slashes that are division
 *
 * A financial app whose deployed copy differs from its tested copy is worse than
 * a big download. So this walks the text one character at a time, tracking which
 * state it is in, and removes comment characters and nothing else. Every other
 * byte — including all whitespace inside strings — is copied through untouched.
 *
 * ── HOW THE OUTPUT IS PROVED, NOT ASSUMED ──────────────────────────────────
 *
 * Three independent checks, because "it looked right" is not a standard for a
 * transformation applied to money code:
 *
 *   1. test/strip_comments_test.js drives the scanner over every shape above,
 *      and over every real module in this repository, asserting that stripping
 *      is idempotent and that a second pass finds nothing left to remove.
 *   2. autonomy/verify-exports.mjs imports each stripped module and compares
 *      its exported names with the original's — a module that no longer parses
 *      cannot be imported at all. (That one is a TEST tool and stays in
 *      autonomy/; this file is a BUILD tool and must survive .vercelignore,
 *      which removes autonomy/ from the deploy entirely. Putting it there was
 *      the first version, and the preview deployment failed on exactly that.)
 *   3. build.mjs parses every written module with `node --check`, and the
 *      stripped index.html is booted in a real browser.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DO ────────────────────────────────────────
 *
 * Rename anything, shorten anything, reorder anything, or remove whitespace
 * outside a comment. It is not a minifier. Every transformation a minifier makes
 * is another chance for the deployed app to behave differently from the tested
 * one, and the comments are where the bytes actually are.
 * ===========================================================================*/

/* A `/` here starts a REGEX rather than being division. Decided by the previous
 * significant token, which is how every JS tokeniser resolves it. */
const REGEX_OK_AFTER_CHAR = new Set([
    '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*',
    '%', '~', '^', '<', '>', '\n',
]);
const REGEX_OK_AFTER_WORD = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
    'case', 'do', 'else', 'yield', 'await', 'throw',
]);

function startsRegex(kept) {
    /* Walk back over horizontal whitespace to the last thing that mattered. */
    let i = kept.length - 1;
    while (i >= 0 && (kept[i] === ' ' || kept[i] === '\t')) i -= 1;
    if (i < 0) return true;                       // start of file
    const ch = kept[i];
    if (REGEX_OK_AFTER_CHAR.has(ch)) return true;
    if (/[A-Za-z0-9_$]/.test(ch)) {
        let j = i;
        while (j >= 0 && /[A-Za-z0-9_$]/.test(kept[j])) j -= 1;
        return REGEX_OK_AFTER_WORD.has(kept.slice(j + 1, i + 1));
    }
    /* After `)` or `]` a slash is division — `(a+b) / 2`, `xs[i] / 2` — and so
     * it is after a closing quote. */
    return false;
}

/**
 * Remove JavaScript comments and nothing else.
 *
 * @returns {{ text: string, removed: number, comments: number }}
 */
export function stripJs(source) {
    const src = String(source == null ? '' : source);
    let out = '';
    let i = 0;
    let comments = 0;
    /* Template-literal nesting: `a ${ `b ${c}` }` is legal, and each `${` opens
     * a code context that can itself contain a template. A boolean cannot
     * represent that; a stack can. */
    const stack = [];          // 'tmpl' | 'expr'
    const inTemplate = () => stack.length > 0 && stack[stack.length - 1] === 'tmpl';

    while (i < src.length) {
        const c = src[i];
        const n = src[i + 1];

        if (inTemplate()) {
            if (c === '\\') { out += c + (n === undefined ? '' : n); i += 2; continue; }
            if (c === '`') { stack.pop(); out += c; i += 1; continue; }
            if (c === '$' && n === '{') { stack.push('expr'); out += '${'; i += 2; continue; }
            out += c; i += 1; continue;
        }

        if (c === '`') { stack.push('tmpl'); out += c; i += 1; continue; }
        if (c === '}' && stack.length > 0 && stack[stack.length - 1] === 'expr') {
            stack.pop(); out += c; i += 1; continue;
        }

        if (c === '"' || c === "'") {
            const q = c;
            out += c; i += 1;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] === undefined ? '' : src[i + 1]); i += 2; continue; }
                out += src[i];
                if (src[i] === q) { i += 1; break; }
                /* A newline cannot appear in a single- or double-quoted string,
                 * so reaching one means the input is not valid JavaScript. Stop
                 * treating it as a string rather than swallowing the rest of the
                 * file into one. */
                if (src[i] === '\n') { i += 1; break; }
                i += 1;
            }
            continue;
        }

        if (c === '/' && n === '/') {
            comments += 1;
            while (i < src.length && src[i] !== '\n') i += 1;
            continue;                             // the newline itself is kept
        }

        if (c === '/' && n === '*') {
            comments += 1;
            i += 2;
            let sawNewline = false;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
                if (src[i] === '\n') sawNewline = true;
                i += 1;
            }
            i += 2;
            /* A block comment spanning lines leaves ONE newline behind. Removing
             * it outright would join the line before to the line after, and if
             * the line after ends in a `//` comment the joined line is then
             * commented out entirely — a silent deletion of real code. */
            if (sawNewline) out += '\n';
            continue;
        }

        if (c === '/' && startsRegex(out)) {
            out += c; i += 1;
            let inClass = false;
            while (i < src.length) {
                const r = src[i];
                if (r === '\\') { out += r + (src[i + 1] === undefined ? '' : src[i + 1]); i += 2; continue; }
                if (r === '\n') break;            // not a regex after all; bail cleanly
                out += r; i += 1;
                if (r === '[') inClass = true;
                else if (r === ']') inClass = false;
                else if (r === '/' && !inClass) break;
            }
            continue;
        }

        out += c; i += 1;
    }
    return { text: out, removed: src.length - out.length, comments };
}

/** Remove CSS comments. CSS has one comment form and two string forms. */
export function stripCss(source) {
    const src = String(source == null ? '' : source);
    let out = '';
    let i = 0;
    let comments = 0;
    while (i < src.length) {
        const c = src[i];
        if (c === '"' || c === "'") {
            const q = c;
            out += c; i += 1;
            while (i < src.length) {
                if (src[i] === '\\') { out += src[i] + (src[i + 1] === undefined ? '' : src[i + 1]); i += 2; continue; }
                out += src[i];
                if (src[i] === q) { i += 1; break; }
                i += 1;
            }
            continue;
        }
        if (c === '/' && src[i + 1] === '*') {
            comments += 1;
            i += 2;
            while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
            i += 2;
            continue;
        }
        out += c; i += 1;
    }
    return { text: out, removed: src.length - out.length, comments };
}

/** Collapse the blank lines a strip leaves behind. Never touches indentation. */
export function tidy(text) {
    return String(text == null ? '' : text)
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n');
}

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const STYLE_RE = /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/gi;

/** True for a <script> whose body is data rather than code. */
function isDataScript(attrs) {
    const m = /type\s*=\s*["']([^"']+)["']/i.exec(attrs || '');
    if (!m) return false;
    const t = m[1].toLowerCase();
    return t !== 'module' && t !== 'text/javascript' && t !== 'application/javascript';
}

/* The placeholder a held-out block is replaced by while the HTML passes run.
 *
 * NUL-delimited, and the first version was not — it used a space on either
 * side. tidy() strips trailing whitespace per line, so a placeholder that
 * happened to end a line lost its closing space, the restore pattern stopped
 * matching it, and the <script> it stood for was DROPPED from the page. One tag
 * out of seventy-three, silently, and only test/strip_comments_test.js counting
 * them before and after caught it. A delimiter that no pass here can alter and
 * that cannot occur in HTML source is the only safe kind. */
const HOLD = (n) => '\u0000H' + n + '\u0000';

/**
 * Strip an HTML document: JS comments inside <script>, CSS comments inside
 * <style>, and HTML comments everywhere else.
 *
 * Script and style bodies are cut out FIRST and put back afterwards, so the
 * HTML-comment pass can never see `<!--` inside a JavaScript string, and the
 * JavaScript pass can never see markup.
 */
export function stripHtml(source) {
    const src = String(source == null ? '' : source);
    const held = [];
    let comments = 0;

    let work = src.replace(SCRIPT_RE, (whole, attrs, body) => {
        if (isDataScript(attrs)) { held.push(whole); return HOLD(held.length - 1); }
        const r = stripJs(body);
        comments += r.comments;
        held.push('<script' + attrs + '>' + tidy(r.text) + '</script>');
        return HOLD(held.length - 1);
    });

    work = work.replace(STYLE_RE, (whole, attrs, body) => {
        const r = stripCss(body);
        comments += r.comments;
        held.push('<style' + attrs + '>' + tidy(r.text) + '</style>');
        return HOLD(held.length - 1);
    });

    /* `<!--[if ...]>` is a conditional comment that some engines act on, so it
     * is left alone rather than reasoned about. */
    work = work.replace(/<!--([\s\S]*?)-->/g, (whole, body) => {
        if (/^\s*\[if/i.test(body)) return whole;
        comments += 1;
        return '';
    });

    work = tidy(work);
    const text = work.replace(/\u0000H(\d+)\u0000/g, (_m, k) => held[Number(k)]);
    /* Nothing may be left holding a place. A surviving placeholder is a script
     * or a stylesheet that never made it back into the page, which is a broken
     * deploy — so it throws here rather than shipping. */
    if (text.indexOf('\u0000') !== -1) {
        throw new Error('strip-comments: a held-out block was not restored');
    }
    return { text, removed: src.length - text.length, comments };
}

export default { stripJs, stripCss, stripHtml, tidy };
