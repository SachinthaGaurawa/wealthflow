/* =============================================================================
 * autonomy/client-files.cjs — which files does the owner's PHONE actually load?
 * -----------------------------------------------------------------------------
 * WHY THIS EXISTS (owner, 2026-11-06): "only the version numbers go up, one by one, and it says update."
 *   v7.69.52 changed feedback-triage.js and three wf-*.mjs files. Those are server functions: Vercel deploys them the moment they
 *   are merged, and nothing on the phone changes. The release gate counted them as "user-facing" (they are not infrastructure and not
 *   data), so the phone was told "Update available" for an app that was byte-for-byte the same. Same symptom as the fake releases
 *   substantive.cjs was written to stop, different cause.
 *
 * THE RULE
 *   A root-level script is SERVER-ONLY when nothing the browser loads can reach it: it is not mentioned (by file name, or by its
 *   stem) in any HTML page, the service worker, the manifest, or any file those pull in, transitively. Everything else counts as
 *   delivered to the phone. The answer errs toward telling the owner: a file this scan cannot place (a sub-folder, an image, a
 *   stylesheet, a script whose name is built at run time and never written out) is treated as part of the app.
 *
 * Zero dependencies, CommonJS, pure but for reading the working tree it is pointed at.
 * ===========================================================================*/
'use strict';

const fs = require('fs');
const path = require('path');

const ENTRY = /^(?:[^/]+\.html|sw\.js|service-worker\.js|manifest\.json)$/i;
const TOKEN = /[A-Za-z0-9_\-./]+\.(?:m?js|cjs|css|json|html|webmanifest|woff2?|ttf|png|jpe?g|svg|webp|ico|wasm)\b/g;
const READABLE = /\.(?:m?js|cjs|css|html|json|webmanifest)$/i;
// release notes and changelogs are prose about files, not references to them
const PROSE = /^(?:version|package(?:-lock)?|release-notes?|changelog)\.json$/i;
const MAX_BYTES = 6 * 1024 * 1024;

function rootFiles(repoDir) {
    try { return fs.readdirSync(repoDir).filter((f) => { try { return fs.statSync(path.join(repoDir, f)).isFile(); } catch { return false; } }); }
    catch { return []; }
}

function stemOf(f) { return f.replace(/\.[^.]+$/, ''); }

/**
 * Every root-level file reachable from what the browser opens first.
 * @returns {Set<string>} file names (root level only)
 */
function clientReachable(repoDir = process.cwd()) {
    const files = rootFiles(repoDir);
    const byName = new Set(files);
    const reached = new Set(files.filter((f) => ENTRY.test(f)));
    const texts = new Map();
    const read = (f) => {
        if (texts.has(f)) return texts.get(f);
        let t = '';
        try { const p = path.join(repoDir, f); if (READABLE.test(f) && !PROSE.test(f) && fs.statSync(p).size <= MAX_BYTES) t = fs.readFileSync(p, 'utf8'); } catch { /* unreadable: nothing to follow */ }
        // a file name inside a comment is the author talking, not the browser loading
        if (/\.(?:m?js|cjs|css)$/i.test(f)) t = t.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
        texts.set(f, t);
        return t;
    };
    // stems long enough to be a name, not a word ("index", "app"): a script whose path is assembled at run time still names its stem
    const stems = files.filter((f) => /\.(?:m?js|cjs)$/i.test(f) && stemOf(f).length >= 8 && /[-_]/.test(stemOf(f))).map((f) => [f, stemOf(f)]);
    let grew = true;
    while (grew) {
        grew = false;
        for (const f of [...reached]) {
            // '/api/feedback-triage' names a server URL, not a file the phone downloads: leave those paths out before looking for names
            const t = read(f).replace(/\bapi\/[A-Za-z0-9_-]+(?:\.m?js)?/g, ' ');
            if (!t) continue;
            for (const tok of t.match(TOKEN) || []) {
                const base = tok.split('/').pop();
                if (byName.has(base) && !reached.has(base)) { reached.add(base); grew = true; }
            }
            for (const [name, stem] of stems) {
                if (!reached.has(name) && t.includes(stem)) { reached.add(name); grew = true; }
            }
        }
    }
    return reached;
}

/**
 * Is this changed path code that only a SERVER runs? api/ functions always; a root-level script nothing the browser loads can reach.
 * False for anything unknown (a folder, a style, an image, an HTML page): it is treated as part of the app.
 * @param {string} file       repo-relative path
 * @param {Set<string>} reach result of clientReachable()
 */
function isServerOnlyFile(file, reach) {
    const f = String(file || '').trim().replace(/^\.\//, '');
    if (!f) return false;
    if (/^api\/[^/]+\.(?:m?js|cjs)$/i.test(f)) return true;
    if (f.includes('/')) return false;
    if (!/\.(?:m?js|cjs)$/i.test(f)) return false;
    return !(reach && reach.has(f));
}

module.exports = { clientReachable, isServerOnlyFile };

if (require.main === module) {
    const reach = clientReachable(process.argv[2] || process.cwd());
    const root = rootFiles(process.argv[2] || process.cwd()).filter((f) => /\.(?:m?js|cjs)$/i.test(f));
    const only = root.filter((f) => !reach.has(f));
    console.log(`${reach.size} root files reach the phone; ${only.length} root scripts are server-only:\n` + only.join('\n'));
}
