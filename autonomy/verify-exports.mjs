/* =============================================================================
 * autonomy/verify-exports.mjs — the stripped module is the same module
 * -----------------------------------------------------------------------------
 * The strongest check available without a browser: import a module before and
 * after build.mjs stripped it, and compare the names it exports. A file that no
 * longer parses cannot be imported at all; one whose shape changed reports a
 * different set of names.
 *
 * IT RUNS IN ITS OWN PROCESS ON PURPOSE. Importing a module EXECUTES it, and
 * half of this app's modules touch `window` or `localStorage` the moment they
 * load — one of them from a setTimeout that fires after the import already
 * resolved. Inside a test runner that stray timer is an unrelated failure with a
 * confusing message; inside a deploy it would be a dead build. Here it is
 * contained: the verdict is printed and process.exit() is called immediately,
 * which takes every pending timer with it.
 *
 * A module that throws WHILE LOADING is not a failure. It got far enough to
 * execute, so it parsed, and running it outside a browser was never going to
 * work. What is compared is the pair: if the original threw, the stripped one
 * must throw too, and if the original imported, the stripped one must import
 * with the same exported names.
 *
 *   node autonomy/verify-exports.mjs <original-dir> <built-dir>
 *
 * Prints one JSON line and exits 0 when every module agrees, 1 otherwise.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MODULE_RE = /^wealthflow-[a-zA-Z0-9-]+\.(?:js|mjs)$/;
const HASHED_RE = /^wealthflow-([a-zA-Z0-9-]+)-[0-9a-f]{8}\.(js|mjs)$/;

/** Import it, and report what happened rather than throwing. */
async function shapeOf(file) {
    try {
        const m = await import(pathToFileURL(file).href);
        return { ok: true, keys: Object.keys(m).sort() };
    } catch (e) {
        const msg = String((e && e.message) || e);
        const syntax = /Unexpected|Invalid or unexpected token|missing \) after|Unterminated|Unexpected end of input/i.test(msg);
        return { ok: false, syntax, msg: msg.slice(0, 200) };
    }
}

export async function compare(originalDir, builtDir) {
    const originals = fs.readdirSync(originalDir).filter((f) => MODULE_RE.test(f)).sort();
    const built = fs.readdirSync(builtDir).filter((f) => /^wealthflow-.*\.(js|mjs)$/.test(f));
    /* The built tree's names carry a hash, so the pairing is by stem. */
    const byStem = new Map();
    for (const b of built) {
        const m = HASHED_RE.exec(b);
        byStem.set(m ? m[1] + '.' + m[2] : b.replace(/\.(js|mjs)$/, '.$1'), b);
    }

    const problems = [];
    let checked = 0;
    for (const f of originals) {
        const stem = f.replace(/^wealthflow-/, '').replace(/\.(js|mjs)$/, '.$1');
        const target = byStem.get(stem) || f;
        if (!fs.existsSync(path.join(builtDir, target))) {
            problems.push(f + ': no built counterpart (looked for ' + target + ')');
            continue;
        }
        const a = await shapeOf(path.join(originalDir, f));
        const b = await shapeOf(path.join(builtDir, target));
        checked += 1;

        if (b.syntax) { problems.push(target + ': does not parse — ' + b.msg); continue; }
        if (a.ok !== b.ok) {
            problems.push(target + ': import ' + (a.ok ? 'worked before and fails now: ' + b.msg
                : 'failed before and works now'));
            continue;
        }
        if (a.ok && a.keys.join(',') !== b.keys.join(',')) {
            problems.push(target + ': exports changed — [' + a.keys + '] -> [' + b.keys + ']');
        }
    }
    return { checked, total: originals.length, problems };
}

if (process.argv[1] && process.argv[1].endsWith('verify-exports.mjs')) {
    const [, , originalDir, builtDir] = process.argv;
    if (!originalDir || !builtDir) {
        console.log(JSON.stringify({ problems: ['usage: verify-exports.mjs <original-dir> <built-dir>'] }));
        process.exit(1);
    }
    const out = await compare(originalDir, builtDir);
    console.log(JSON.stringify(out));
    /* Immediately, so a module's stray timer cannot fire after the verdict and
     * turn a pass into a crash. */
    process.exit(out.problems.length ? 1 : 0);
}
