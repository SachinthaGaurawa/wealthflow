/* =============================================================================
 * wf-inline-extract.mjs — move a page's inline <script> blocks into files
 * -----------------------------------------------------------------------------
 * Used by build.mjs so the shipped pages carry no inline script and `script-src` can drop
 * 'unsafe-inline'. Pure and dependency-free (the caller supplies the hash and writes the files).
 *
 * A classic inline script and a classic external script behave the same where it matters here:
 * both run synchronously, in document order, in the global scope (top-level `function`, `var`,
 * `let` and `const` land in the same places). So the tag is replaced IN PLACE by
 * `<script src="/name.js"></script>` and the order of everything is unchanged.
 *
 * Left alone, on purpose: a script with `src` (already external), a `type` that is not JavaScript
 * (JSON-LD, importmap, speculation rules: data, not run as script), `type="module"`, and an empty
 * body. `defer` and `async` are dropped, because an inline script ignores them and an external
 * one would honour them and change the order.
 *
 * The `src` is absolute (`/wealthflow-inline-…`) because some pages are served for paths of any
 * depth (404.html, the app's catch-all).
 * ===========================================================================*/

const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const JS_TYPES = new Set(['', 'text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript']);

function attr(attrs, name) {
    const m = new RegExp('(?:^|\\s)' + name + '\\s*(?:=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+)))?', 'i').exec(attrs);
    if (!m) return null;
    return m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : '';
}

/**
 * @param {string} html
 * @param {{ page: string, hashOf: (text: string) => string }} opts  `page` names the file in the output name
 * @returns {{ html: string, files: Array<{ name: string, text: string }>, kept: number }}
 */
export function extractInlineScripts(html, { page, hashOf }) {
    const files = new Map();
    let n = 0; let kept = 0;
    const out = String(html).replace(SCRIPT, (all, attrs, body) => {
        if (attr(attrs, 'src') !== null) return all;
        const type = (attr(attrs, 'type') || '').trim().toLowerCase();
        if (!JS_TYPES.has(type)) { kept += 1; return all; }
        if (!body.trim()) return all;
        n += 1;
        // `<\/script>` inside a string stays valid JavaScript when it moves into a file, so the text is kept byte for byte
        const text = body.replace(/^\n/, '');
        const name = 'wealthflow-inline-' + String(page).replace(/\.html$/, '').replace(/[^a-zA-Z0-9]+/g, '-') + '-' + n + '-' + hashOf(text) + '.js';
        files.set(name, text);
        return '<script src="/' + name + '"></script>';
    });
    return { html: out, files: [...files].map(([name, text]) => ({ name, text })), kept };
}

/** Inline `<script>` blocks that still run as script in `html`: [] when the page is clean. */
export function inlineScriptsLeft(html) {
    const left = [];
    String(html).replace(SCRIPT, (all, attrs, body) => {
        if (attr(attrs, 'src') !== null) return all;
        const type = (attr(attrs, 'type') || '').trim().toLowerCase();
        if (JS_TYPES.has(type) && body.trim()) left.push(body.trim().slice(0, 60));
        return all;
    });
    return left;
}
