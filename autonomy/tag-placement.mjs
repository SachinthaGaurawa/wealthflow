/**
 * WHERE THE NEW TAG GOES   (#635, PR 647: "NEW TAG FAILED: nothing that already existed may be tagged NEW, found 1")
 *
 * The build lane's module draws a sheet that stays hidden until the person taps a row. Its author mounted a plain wrapper in <body>, put the sheet
 * inside it, and the NEW tag landed on the WRAPPER. The wrapper shows nothing, so the label sat on an empty box on every page from the first second, and the
 * browser check (test/e2e/new-badge.mjs) correctly refused it. The week must start when the person first SEES the thing: the tag belongs on the element
 * that appears (the hidden sheet), which the NEW label code leaves alone until it is on screen.
 *
 * This file measures that by running the module (shared loader, real DOM, books stub) and, when the tag is on something that shows nothing, MOVES the tag
 * in the source to the hidden element that holds the content. No model is asked: a program found it and a program fixes it. When it cannot be moved
 * safely the problem is returned in words, and the author gets it back like any other refusal.
 *
 * Pure parts (isHiddenSelf, shownText, moveTag) are exported for tests; `placeTag` does the run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const hidden = (el) => !!(el && (el.hidden === true || (el.hasAttribute && el.hasAttribute('hidden')) || (el.style && el.style.display === 'none')));

/** The element hides itself (display:none or the hidden attribute). */
export const isHiddenSelf = hidden;

/** The text a person would read inside `el`, leaving out anything hidden. */
export function shownText(el) {
    if (!el || hidden(el)) return '';
    let t = '';
    for (const n of el.childNodes || []) {
        if (n.nodeType === 3) t += n.textContent || '';
        else if (n.nodeType === 1) t += shownText(n);
    }
    return t.trim();
}

/** Constant strings declared as `var NAME = 'value'` (so `x.id = NAME` can be resolved). */
function constants(src) {
    const out = {};
    for (const m of src.matchAll(/\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=\s*(['"])([^'"\n]{1,80})\2\s*[;,]/g)) out[m[1]] = m[3];
    return out;
}

/** Which source variable gets the element id `wantId`: `sheet.id = SHEET_ID` -> { name:'sheet', end:<index after that line> }. */
export function variableForId(src, wantId) {
    const k = constants(src);
    const re = /^([ \t]*)([A-Za-z_$][\w$]*)\.id\s*=\s*(?:(['"])([\w-]+)\3|([A-Za-z_$][\w$]*))\s*;[ \t]*$/gm;
    let m;
    while ((m = re.exec(src))) {
        const id = m[4] !== undefined ? m[4] : k[m[5]];
        if (id === wantId) return { name: m[2], indent: m[1], end: m.index + m[0].length };
    }
    const re2 = /^([ \t]*)([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]id['"]\s*,\s*(?:(['"])([\w-]+)\3|([A-Za-z_$][\w$]*))\s*\)\s*;[ \t]*$/gm;
    while ((m = re2.exec(src))) {
        const id = m[4] !== undefined ? m[4] : k[m[5]];
        if (id === wantId) return { name: m[2], indent: m[1], end: m.index + m[0].length };
    }
    return null;
}

/** Take the tag line off `fromName` and put it on `toName`'s id line. Returns the new source, or null when the lines cannot be found. */
export function moveTag(src, today, fromName, to) {
    const own = new RegExp(`^[ \\t]*${fromName.replace(/[$]/g, '\\$')}\\.setAttribute\\(\\s*['"]data-wf-new['"][^\\n]*\\)\\s*;?[ \\t]*\\n`, 'm');
    if (!own.test(src)) return null;
    const without = src.replace(own, '');
    const spot = variableForId(without, to.id);
    if (!spot) return null;
    return `${without.slice(0, spot.end)}\n${spot.indent}${spot.name}.setAttribute('data-wf-new', '${today}');${without.slice(spot.end)}`;
}

/**
 * Run the module and look at where the NEW tag sits.
 * @returns {Promise<{ code:string, problems:string[], moved?:string }>}  problems is empty when the tag is where a person will see it, or nothing could be measured.
 */
export async function placeTag({ file, api, code, page = '', today, repoDir = process.cwd() } = {}) {
    try {
        const loaderPath = path.join(repoDir, 'test', 'helpers', 'load-browser-module.js');
        if (!fs.existsSync(loaderPath)) return { code, problems: [] };
        const { loadBrowserModule } = await import(pathToFileURL(loaderPath).href);
        const { window, document } = loadBrowserModule(file, { source: code, html: page, timeoutMs: 3000, globals: { DB: { get: () => [], getObj: (k, d) => d } } });
        const mod = window[api];
        if (mod && typeof mod.mount === 'function') { try { await mod.mount(); } catch { /* a module that cannot mount here is judged by its tests */ } }
        const tagged = [...document.querySelectorAll('[data-wf-new]')];
        const empty = tagged.filter((el) => !hidden(el) && shownText(el) === '');
        if (!empty.length) return { code, problems: [] };
        const wrapper = empty[0];
        const inner = [...wrapper.querySelectorAll('[id]')].find((el) => hidden(el) && String(el.textContent || '').trim());
        const fromVar = (/(?:^|[\s;{(])([A-Za-z_$][\w$]*)\.setAttribute\(\s*['"]data-wf-new['"]/.exec(code) || [])[1];
        if (inner && fromVar) {
            const moved = moveTag(code, today, fromVar, { id: inner.id });
            if (moved) return { code: moved, problems: [], moved: `the NEW tag moved from the empty wrapper${wrapper.id ? ' #' + wrapper.id : ''} to the hidden sheet #${inner.id}` };
        }
        return { code, problems: [`the NEW tag sits on ${wrapper.id ? '#' + wrapper.id : 'an element'}, which shows nothing by itself, so a label would hang on an empty box on every page${inner ? `: put the tag on #${inner.id} (the sheet that stays hidden until it is opened) and take it off the wrapper` : ': put it on the element the person actually sees (a sheet that starts hidden is tagged on the sheet, never on a wrapper)'}`] };
    } catch { return { code, problems: [] }; }
}
