/* =============================================================================
 * autonomy/reach.mjs — which files the fix agent may open, said in ONE place, and said to the reader when a report names one it may not
 * -----------------------------------------------------------------------------
 * WHAT WAS MEASURED (2026-11-12). Two reports the system files about itself could never be acted on by its own agent:
 *   · #559 (the statement reader's printed Total Payment check): three attempts, each on a file that does not hold the check. The check
 *     is `printedPaymentsCheck` in `statement-direction.mjs`.
 *   · #609 (the AI board below its floor): the report says "read `ai-models.mjs`, `ai-chat.mjs`, `api/ai.js`". Two attempts, and the author
 *     model itself answered that the failures live in those three files, "none of which is the only file I am permitted to edit".
 * The reason is one line: the agent's rule for an editable file was "ends in .js, at the top of the repository". The statement reader and
 * the AI board are .mjs modules (97 of them), and `api/ai.js` is in a folder. So the watchers filed work the agent was not allowed to
 * touch, the agent spent three attempts each on the nearest file it WAS allowed to touch, and the issues ended `ai-stuck`.
 *
 * WHAT THIS FILE DECIDES.
 *   1. `.mjs` modules stay closed unless they are named here, each with the reason it was opened. The ones opened are the ones a watcher's
 *      report names as the owner of what it found. Opening all 97 would hand the agent the Gmail tokens, the SMS sender, the tenant portal
 *      and its own router in one line; a list is the smallest change that makes the reports actionable.
 *   2. A file a report NAMES goes first. Nothing is chosen by a model when the report already says where the code is.
 *   3. When a report says where the code is and the agent may open none of it, that is said at once, with the reason per file, and no
 *      model is asked: three attempts on the wrong file cost provider quota and end in the same place.
 *   4. A module with `export` is tested by importing it. The proving-test instructions said every file "is a browser IIFE with no export";
 *      for a module that has exports that sentence is false and sent the test author to a loader that cannot load it.
 *
 * Pure: no network, and the filesystem only through the functions it is given.
 * ===========================================================================*/

/** `.mjs` modules the agent may edit, and why each was opened. Lower-case names; the top of the repository only. */
export const MJS_REACH = new Map([
    ['statement-direction.mjs', 'the reader\'s direction rules and its printed Total Payment check: the owner of the self-reports printed-total-differs, credit-wording-on-debit and direction-guessed'],
    ['statement-merchants.mjs', 'the merchant list of the email reader: an owner of the self-report category-gap'],
    ['statement-merchant-name.mjs', 'the merchant in a bank narration: an owner of the self-report category-gap'],
    ['ai-models.mjs', 'which model each AI provider is asked for: named by the AI board watch'],
    ['ai-chat.mjs', 'how one AI provider is asked and asked again: named by the AI board watch'],
]);

/** The heading under which a program-filed report says which files own what it found. */
export const OWNERS_HEADING = 'Where the code is';

const FILE_NAME = /(?<![\w./-])((?:[\w.-]+\/)*[\w.-]+\.(?:mjs|cjs|json|js|css|html))(?![\w-])/g;

/**
 * File names a text mentions that really exist, in the order they appear.
 * @param {string} text
 * @param {{ exists:(file:string)=>boolean, max?:number }} o
 */
export function namedFiles(text, { exists, max = 8 } = {}) {
    const out = [];
    for (const m of String(text || '').matchAll(FILE_NAME)) {
        const f = m[1].replace(/^\.\//, '');
        if (f.includes('..') || f.length > 120 || out.includes(f)) continue;
        let real = false;
        try { real = !!(exists && exists(f)); } catch { real = false; }
        if (real) out.push(f);
        if (out.length >= max) break;
    }
    return out;
}

/** The files listed under the report's own "Where the code is" heading (up to the next heading). */
export function ownerFiles(text, { exists, max = 8 } = {}) {
    const lines = String(text || '').split('\n');
    const at = lines.findIndex((l) => new RegExp('^#{2,4}\\s*' + OWNERS_HEADING + '\\b', 'i').test(l.trim()));
    if (at < 0) return [];
    const rest = lines.slice(at + 1);
    const end = rest.findIndex((l) => /^#{1,4}\s/.test(l.trim()));
    return namedFiles((end < 0 ? rest : rest.slice(0, end)).join('\n'), { exists, max });
}

/**
 * May the agent edit this file, and if not, why not (one sentence a person can act on).
 * @param {string} file
 * @param {{ isSensitive:(f:string)=>boolean, opened?:Map<string,string>, size?:number|null, maxBytes?:number }} o
 * @returns {{ ok:boolean, why:string }}
 */
export function reachOf(file, { isSensitive, opened = MJS_REACH, size = null, maxBytes = Infinity } = {}) {
    const f = String(file || '').trim().replace(/^\.\//, '');
    if (!f) return { ok: false, why: 'no file is named' };
    if (f.includes('/')) return { ok: false, why: `it is inside ${f.split('/')[0]}/, and the agent edits only modules at the top of the repository` };
    if (/\.test\.js$/i.test(f)) return { ok: false, why: 'it is a test' };
    if (!/\.m?js$/i.test(f)) return { ok: false, why: 'it is not a script module' };
    if (typeof isSensitive === 'function' && isSensitive(f)) return { ok: false, why: 'it is on the protected list (money allocation, sign-in, keys, the service worker, or the update system itself)' };
    if (/\.mjs$/i.test(f) && !opened.has(f.toLowerCase())) return { ok: false, why: 'it is a .mjs module that has not been opened to the agent (autonomy/reach.mjs lists the ones that are, each with its reason)' };
    if (size != null && Number(size) > maxBytes) return { ok: false, why: `it is ${Math.round(Number(size) / 1024)} KB, more than the agent can patch` };
    return { ok: true, why: '' };
}

/** The sentence posted when a report names its owners and the agent may open none of them. */
export function outOfReachReason(files) {
    const list = (files || []).map((x) => `\`${x.file}\` (${x.why})`).join('; ');
    return `this report says where the code is, and the agent may not edit any of it: ${list}. No model was asked and no attempt was spent. `
        + 'Either the file is opened to the agent (autonomy/reach.mjs, by a person, with the reason) or the change is made by a person.';
}

/**
 * Is this source an ES module, and what does it export? A file with `export` is tested by importing it.
 * @returns {{ esm:boolean, exports:string[], hasDefault:boolean }}
 */
export function moduleShape(source) {
    const src = String(source || '');
    const names = [];
    const add = (n) => { const s = String(n || '').trim(); if (/^[A-Za-z_$][\w$]*$/.test(s) && !names.includes(s)) names.push(s); };
    for (const m of src.matchAll(/^[ \t]*export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) add(m[1]);
    for (const m of src.matchAll(/^[ \t]*export\s+(?:const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm)) add(m[1]);
    for (const m of src.matchAll(/^[ \t]*export\s*\{([^}]*)\}/gm)) for (const part of m[1].split(',')) add(part.split(/\s+as\s+/).pop());
    const esm = names.length > 0 || /^[ \t]*export\s+default\b/m.test(src) || /^[ \t]*import\s[^'"\n]*from\s*['"]/m.test(src);
    return { esm, exports: names.slice(0, 40), hasDefault: /^[ \t]*export\s+default\b/m.test(src) };
}

/** What the proving-test author is told about a module that has exports (in place of the browser-script instructions). */
export function esmTestGuide(filename, shape) {
    const names = (shape && shape.exports) || [];
    return [
        `  · ${filename} is an ES MODULE. It is not a browser script: there is no \`window\` global to read`,
        '    and the shared loader cannot load it. Import what you test straight from the file.',
        names.length ? `  · Its named exports: ${names.join(', ')}.` : (shape && shape.hasDefault) ? '  · It has a default export and no named ones.' : '  · Read its exports from the code below.',
        // (built with `+` so the repository's import scan does not read these instruction lines as imports of this file)
        '      import ' + (names.length ? '{ ' + names[0] + ' }' : (shape && shape.hasDefault) ? 'theModule' : '{ theFunction }') + ' from ' + JSON.stringify('../' + filename) + ';'
            + (names.length || (shape && shape.hasDefault) ? '' : '   // replace theFunction with a name the code really exports'),
        '    Your test file lives in test/, so the path is exactly the one shown above.',
        '  · It runs in Node. There is no `document` and none is needed: call the exported function with',
        '    an input you INVENT and assert on what it returns.',
        '  · Other modules it imports resolve by themselves. Do not mock them unless the change is about them.',
        '  · This repository is public. NEVER copy a real statement line, amount, date, card number, name or',
        '    merchant into the test. Invent every value.',
        '  · The assertions must be meaningful, never tautological.',
    ];
}
