/**
 * THE PROVING TEST, WRITTEN BY A PROGRAM FROM THE MODULE'S OWN TEST RECIPE
 *
 * WHY THIS EXISTS (#635, runs 44639062978 and 44640763964, evidence logged by #644)
 * The author of a new browser module ends the file with a "TEST RECIPE": the books key and one real record, the page markup, the calls that
 * make the sheet appear, and the element that then holds the text. A DIFFERENT model writes the proving test, and it read that recipe and
 * still ignored it: it used a record with no `id` and called `open()` with no argument (the recipe says `open("p1")`), put the fixture in the
 * wrong shape, and asserted text inside a container the recipe never named. Three rounds, the same wrong test, the same
 * `expected '' to contain ...`. A free-tier model cannot be made to follow a recipe by asking harder.
 *
 * So nothing is asked: the recipe is data, and the test is generated from it. Same books, same page, same calls, same element, through the
 * shared loader. The test fails when the module is absent (red) and passes only when the module really draws what its author said it would
 * (green). If the module does not, that is a finding about the MODULE, and the author gets the failure and one revision.
 *
 * Everything here is pure: text in, text out. A recipe it cannot read returns { ok:false, why } and the lane falls back to the model-written test.
 */

const RECIPE_RE = /\/\*\s*TEST RECIPE([\s\S]*?)\*\//;
const FIELD_RE = /^\s*(books|page|steps|expect)\s*:\s*/i;

/** The recipe text as { books, page, steps, expect } (raw strings), or null. Fields may continue on following lines. */
export function readRecipe(code) {
    const m = RECIPE_RE.exec(String(code || ''));
    if (!m) return null;
    const out = {};
    let key = null;
    for (const line of m[1].split('\n')) {
        const f = FIELD_RE.exec(line);
        if (f) { key = f[1].toLowerCase(); out[key] = line.slice(f[0].length).trim(); }
        else if (key && line.trim()) out[key] += ' ' + line.trim();
    }
    return out;
}

/** Split `a(1); b("x;y")` on semicolons that are not inside quotes or brackets. */
function splitCalls(text) {
    const out = [];
    let depth = 0, quote = '', cur = '';
    for (const ch of String(text)) {
        if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
        if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
        if ('([{'.includes(ch)) depth++;
        if (')]}'.includes(ch)) depth--;
        if (ch === ';' && depth <= 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; continue; }
        cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
}

/** `WFName.open("p1", 2)` -> { fn:'open', args:['p1', 2] }; anything that is not a plain call of the module's own API with literal arguments -> null. */
export function parseCall(text, api) {
    const m = /^(?:window\.)?(WF[A-Za-z0-9]+)\.([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/.exec(String(text).trim());
    if (!m || m[1] !== api) return null;
    const raw = m[3].trim();
    if (!raw) return { fn: m[2], args: [] };
    try { return { fn: m[2], args: JSON.parse('[' + raw + ']') }; } catch { /* maybe single quotes */ }
    try { return { fn: m[2], args: JSON.parse('[' + raw.replace(/'([^'\\]*)'/g, (_, s) => JSON.stringify(s)) + ']') }; } catch { return null; }
}

/** Which element, and which text, the recipe says to look for. */
export function parseExpect(text) {
    const s = String(text || '');
    const sel = /\bclass(?:Name)?\s*[:=]?\s*["'`]?\.?([A-Za-z][\w-]*)/i.exec(s) || null;
    const byClass = sel && /\bclass/i.test(sel[0]) ? sel[1] : null;
    const idm = !byClass && (/\bid\s*[:=]?\s*["'`]?#?([A-Za-z][\w-]*)/i.exec(s) || /#([A-Za-z][\w-]+)/.exec(s));
    const clsm = !byClass && !idm && /\.([A-Za-z][\w-]+)/.exec(s);
    const selector = byClass ? '.' + byClass : idm ? '#' + idm[1] : clsm ? '.' + clsm[1] : null;
    if (!selector) return null;
    const quoted = [...s.matchAll(/["“]([^"”]{1,80})["”]/g)].map((x) => x[1]).filter((q) => q !== (byClass || (idm && idm[1]) || ''));
    return { selector, text: quoted.length ? quoted[quoted.length - 1] : '' };
}

/** The books object: the first {...} in the recipe, parsed. */
export function parseBooks(text) {
    const s = String(text || '');
    const i = s.indexOf('{');
    if (i < 0) return null;
    for (let j = s.lastIndexOf('}'); j > i; j = s.lastIndexOf('}', j - 1)) {
        try { const v = JSON.parse(s.slice(i, j + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* a shorter slice may parse */ }
    }
    return null;
}

/**
 * The generated Vitest file, or { ok:false, why }.
 * @param {{name:string, api:string}} plan  the module file name and the window global
 */
export function testFromRecipe(plan, code) {
    const rec = readRecipe(code);
    if (!rec) return { ok: false, why: 'the module has no TEST RECIPE' };
    const books = parseBooks(rec.books);
    if (!books) return { ok: false, why: 'the recipe books are not readable JSON' };
    const calls = splitCalls(rec.steps || '').map((c) => parseCall(c, plan.api));
    if (!calls.length || calls.some((c) => !c)) return { ok: false, why: 'the recipe steps are not plain calls of window.' + plan.api + ' with literal arguments' };
    const exp = parseExpect(rec.expect);
    if (!exp) return { ok: false, why: 'the recipe does not name the element that holds the text' };
    const page = String(rec.page || '').replace(/^["'`]|["'`]$/g, '');
    const firstText = exp.text || '';
    const L = (v) => JSON.stringify(v);
    const src = [
        'import { describe, it, expect } from "vitest";',
        'import { loadBrowserModule } from "./helpers/load-browser-module.js";',
        '',
        `// Generated from the TEST RECIPE at the end of ${plan.name} (autonomy/recipe-test.mjs): same books, same page, same calls, same element.`,
        `const BOOKS = ${JSON.stringify(books, null, 2)};`,
        '',
        `describe(${L(plan.name + ' draws what its author said it draws')}, () => {`,
        `    it(${L('after ' + calls.map((c) => c.fn + '()').join(', ') + ' the element ' + exp.selector + ' shows ' + (firstText ? L(firstText) : 'text'))}, async () => {`,
        `        const { window, document } = loadBrowserModule(${L(plan.name)}, {`,
        `            html: ${L(page)},`,
        '            globals: { DB: { get: (key) => BOOKS[key] || [], getObj: (key, dflt) => (BOOKS[key] !== undefined ? BOOKS[key] : dflt) } },',
        '        });',
        `        const api = window.${plan.api};`,
        `        expect(typeof api).toBe("object");`,
        ...calls.flatMap((c) => [
            `        expect(typeof api.${c.fn}).toBe("function");`,
            `        await api.${c.fn}(${c.args.map(L).join(', ')});`,
        ]),
        '        await new Promise((resolve) => setTimeout(resolve, 20));',
        `        const el = document.querySelector(${L(exp.selector)});`,
        `        expect(el, "the element the recipe names was never drawn").toBeTruthy();`,
        `        const said = String(el.textContent || "");`,
        ...(firstText
            ? [`        expect(said).toContain(${L(firstText)});`]
            : ['        expect(said.trim().length).toBeGreaterThan(0);']),
        '    });',
        '',
        `    it(${L('an empty book does not throw')}, async () => {`,
        `        const { window } = loadBrowserModule(${L(plan.name)}, {`,
        `            html: ${L(page)},`,
        '            globals: { DB: { get: () => [], getObj: (key, dflt) => dflt } },',
        '        });',
        ...calls.map((c) => `        await Promise.resolve(window.${plan.api}.${c.fn}(${c.args.map(L).join(', ')})).catch(() => {});`),
        '    });',
        '});',
        '',
    ].join('\n');
    return { ok: true, source: src, recipe: { books, page, calls, expect: exp } };
}
