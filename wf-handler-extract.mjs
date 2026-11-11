/* =============================================================================
 * wf-handler-extract.mjs — find every inline event handler a page ships
 * -----------------------------------------------------------------------------
 * Used by build.mjs (to make the page CSP-ready) and by the tests. For a piece of page text
 * (the HTML, or a script that builds HTML) it returns each `onclick="…"`-style attribute as
 * { type, code } with `code` as the browser would see it at run time:
 *
 *   - quotes the script had to escape are plain quotes again (`\'` -> `'`)
 *   - HTML entities are decoded (`&quot;`)
 *   - a template hole `${…}` becomes a placeholder literal ('X' inside quotes, 0 outside), because
 *     the value is data at run time and only the SHAPE of the call matters
 *   - the one concatenation form the page uses, `\'' + expr + '\'`, becomes `'X'`
 *
 * Only attribute NAMES in markup are found. `el.onclick = fn`, `{ onclick: fn }` and a name
 * inside a string like 'onclick' are not handlers in markup and are left alone.
 *
 * Pure and dependency-free. Never imports autonomy/ (it is .vercelignored).
 * ===========================================================================*/

export const HANDLER_EVENTS = ['click', 'change', 'input', 'submit', 'keydown', 'keyup', 'keypress', 'blur', 'focus', 'error', 'load', 'scroll', 'pointerdown', 'pointerup', 'contextmenu', 'dblclick', 'paste', 'touchstart', 'touchend', 'mouseover', 'mouseout', 'mouseenter', 'mouseleave', 'drop', 'dragover', 'toggle', 'wheel', 'resize'];

const ATTR = new RegExp('(\\son)(' + HANDLER_EVENTS.join('|') + ')(\\s*=\\s*)(\\\\?)(["\'])', 'g');

const decode = (s) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** The handler text as the browser sees it, from the text as written in the source. */
export function normalizeHandler(raw) {
    let v = decode(raw).replace(/\\'' \+ [^+]+? \+ '\\'/g, "'X'");
    let out = ''; let q = null; let i = 0;
    while (i < v.length) {
        const c = v[i];
        if (c === '\\' && (v[i + 1] === "'" || v[i + 1] === '"')) {
            out += v[i + 1];
            if (q === v[i + 1]) q = null; else if (!q) q = v[i + 1];
            i += 2; continue;
        }
        if (c === '$' && v[i + 1] === '{') {
            let d = 1; let j = i + 2;
            while (j < v.length && d) { if (v[j] === '{') d += 1; else if (v[j] === '}') d -= 1; j += 1; }
            out += q ? 'X' : '0'; i = j; continue;
        }
        if (c === "'" || c === '"') { if (q === c) q = null; else if (!q) q = c; }
        out += c; i += 1;
    }
    return out;
}

/** Every handler attribute in `text`: [{ type, code, raw, index }]. */
export function extractHandlers(text) {
    const out = [];
    const src = String(text);
    ATTR.lastIndex = 0;
    let m;
    while ((m = ATTR.exec(src))) {
        const quote = m[5]; const escaped = m[4] === '\\';
        let j = ATTR.lastIndex; let raw = '';
        while (j < src.length && raw.length <= 4000) {
            if (escaped ? (src[j] === '\\' && src[j + 1] === quote) : src[j] === quote) break;
            raw += src[j]; j += 1;
        }
        out.push({ type: m[2], raw, code: normalizeHandler(raw), index: m.index });
    }
    return out;
}

/**
 * Rename the handler attributes in `text` so the browser no longer treats them as code:
 * `onclick=` -> `data-wf-on-click=`. Also the two calls that name the attribute as a string
 * (`getAttribute('onclick')`, `setAttribute('onclick', …)`), which the page uses to read and
 * write a handler. Returns { text, renamed }.
 */
export function renameHandlerAttributes(text) {
    let renamed = 0;
    let out = String(text).replace(ATTR, (all, on, type, eq, esc, q) => { renamed += 1; return ' data-wf-on-' + type + eq + esc + q; });
    const names = new RegExp('((?:get|set|has|remove)Attribute\\(\\s*)([\'"])on(' + HANDLER_EVENTS.join('|') + ')\\2', 'g');
    out = out.replace(names, (all, call, q, type) => { renamed += 1; return call + q + 'data-wf-on-' + type + q; });
    return { text: out, renamed };
}
