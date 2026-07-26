/* =============================================================================
 * autonomy/substantive.cjs — "did anything REAL change?" detector
 * ---------------------------------------------------------------------------
 * THE FIX FOR THE #1 REPORTED BUG: "the version number goes up but nothing in
 * the app actually changes."
 *
 * ROOT CAUSE (verified in the git log): merchant-sync.yml pushes a
 * `chore(merchants)` commit every hour. auto-release.yml then asked only
 * "are there commits since the last release tag?" — which was always YES — so
 * it cut v7.69.10 → .11 → .12 with ZERO functional change. Users were shown an
 * "update available" prompt, downloaded an identical app, and correctly
 * concluded the update system was lying to them.
 *
 * THE RULE IMPLEMENTED HERE
 *   A release is substantive only if the diff since the last release contains a
 *   change that is NOT one of:
 *     (a) a metadata/data file that cannot alter behaviour (merchants.json,
 *         CHANGELOG.md, *.md, *.pdf, version.json, package.json, lockfiles,
 *         autonomy/state/*), or
 *     (b) a pure version-string rewrite (`'7.69.11'` → `'7.69.12'`).
 *
 *   (b) is detected generically rather than by a hard-coded file list: every
 *   changed line is normalised by replacing semvers with a placeholder. If the
 *   normalised added lines are a permutation of the normalised removed lines,
 *   the only thing that changed was the version number itself — the exact
 *   signature of a fake release.
 *
 * Zero dependencies, pure functions, CommonJS so release.cjs can require it.
 * CLI:  node autonomy/substantive.cjs <lastRef> [headRef]   → exit 0 substantive,
 *                                                             exit 3 not
 * ===========================================================================*/
'use strict';

/** Files that can never change app behaviour on their own. */
const META_PATTERNS = [
    /^merchants\.json$/i,          // grown hourly by merchant-sync — data, not behaviour
    /^version\.json$/i,            // the release manifest itself
    /^package(-lock)?\.json$/i,
    /^CHANGELOG\.md$/i,
    /\.md$/i,
    /\.pdf$/i,
    /^ai-fix-pr\.json$/i,          // the agent's own scratch output
    /^autonomy\/state\//i,         // pipeline bookkeeping
    /^\.gitignore$/i,
    /^\.vercelignore$/i,
];

function isMetaFile(file) {
    const f = String(file || '').trim().replace(/^\.\//, '');
    if (!f) return true;
    return META_PATTERNS.some((re) => re.test(f));
}

/**
 * Normalise a source line so that two lines differing only by a semver compare
 * equal. Also collapses whitespace so re-indentation alone is not "substantive".
 */
function normaliseLine(line) {
    // String(x) can THROW: `String({ toString: {} })` raises "Cannot convert
    // object to primitive value". The property suite caught this the first time it
    // was ever actually run. This function decides whether a release ships, so it
    // must never itself be the thing that throws.
    if (line == null) return '';
    let s;
    if (typeof line === 'string') s = line;
    else { try { s = String(line); } catch (_) { return ''; } }
    return s
        .replace(/\d+\.\d+\.\d+/g, ' <SEMVER> ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Are the added lines merely a permutation of the removed ones (post-normalise)? */
function isVersionOnlyChange(added, removed) {
    const a = (added || []).map(normaliseLine).filter(Boolean).sort();
    const r = (removed || []).map(normaliseLine).filter(Boolean).sort();
    if (a.length !== r.length) return false;
    if (a.length === 0) return false;              // no content change at all
    return a.every((line, i) => line === r[i]);
}

/**
 * Parse a unified diff into { file: { added: [], removed: [] } }.
 * Tolerant of `diff --git`, `+++ b/path`, renames and /dev/null.
 */
function parseUnifiedDiff(diffText) {
    const out = {};
    const lines = String(diffText || '').split('\n');
    let current = null;
    for (const raw of lines) {
        if (raw.startsWith('diff --git ')) {
            // "diff --git a/x b/x" — prefer the b-side path
            const m = raw.match(/ b\/(.+)$/);
            current = m ? m[1] : null;
            if (current && !out[current]) out[current] = { added: [], removed: [] };
            continue;
        }
        if (raw.startsWith('+++ ')) {
            const p = raw.slice(4).trim();
            if (p !== '/dev/null') {
                current = p.replace(/^b\//, '');
                if (!out[current]) out[current] = { added: [], removed: [] };
            }
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('@@') || raw.startsWith('index ')) continue;
        if (!current) continue;
        if (raw.startsWith('+')) out[current].added.push(raw.slice(1));
        else if (raw.startsWith('-')) out[current].removed.push(raw.slice(1));
    }
    return out;
}

/**
 * Decide whether a diff represents a real, shippable change.
 * @returns {{substantive:boolean, substantiveFiles:string[], ignored:string[],
 *            versionOnly:string[], reason:string}}
 */
function classifyDiff(diffText) {
    const byFile = parseUnifiedDiff(diffText);
    const substantiveFiles = [];
    const ignored = [];
    const versionOnly = [];

    for (const [file, hunks] of Object.entries(byFile)) {
        if (isMetaFile(file)) { ignored.push(file); continue; }
        if (isVersionOnlyChange(hunks.added, hunks.removed)) { versionOnly.push(file); continue; }
        if (!hunks.added.length && !hunks.removed.length) { ignored.push(file); continue; }
        substantiveFiles.push(file);
    }

    const substantive = substantiveFiles.length > 0;
    const reason = substantive
        ? `real changes in ${substantiveFiles.length} file(s): ${substantiveFiles.slice(0, 8).join(', ')}`
        : `no functional change — ${ignored.length} data/meta file(s), ${versionOnly.length} version-string-only file(s). ` +
          'Releasing here would be a FAKE update (the exact bug this gate exists to stop).';

    return { substantive, substantiveFiles, ignored, versionOnly, reason };
}

module.exports = {
    isMetaFile,
    normaliseLine,
    isVersionOnlyChange,
    parseUnifiedDiff,
    classifyDiff,
    META_PATTERNS,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
    const { execSync } = require('child_process');
    const from = process.argv[2];
    const to = process.argv[3] || 'HEAD';
    if (!from) {
        console.error('usage: node autonomy/substantive.cjs <fromRef> [toRef]');
        process.exit(1);
    }
    let diff = '';
    try {
        // -U0 keeps the payload small: we only need the +/- lines, never context.
        diff = execSync(`git diff -U0 ${JSON.stringify(from)}..${JSON.stringify(to)}`, {
            encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
        });
    } catch (e) {
        console.error('[substantive] git diff failed:', e.message);
        process.exit(1);   // fail loud — never silently claim "nothing to ship"
    }
    const r = classifyDiff(diff);
    console.log('[substantive] ' + (r.substantive ? 'SUBSTANTIVE' : 'NOT substantive'));
    console.log('[substantive] ' + r.reason);
    if (r.versionOnly.length) console.log('[substantive] version-string-only: ' + r.versionOnly.join(', '));
    if (r.ignored.length) console.log('[substantive] data/meta ignored: ' + r.ignored.join(', '));
    if (process.env.GITHUB_OUTPUT) {
        require('fs').appendFileSync(process.env.GITHUB_OUTPUT,
            `substantive=${r.substantive ? 'yes' : 'no'}\n` +
            `reason=${r.reason.replace(/\n/g, ' ').slice(0, 900)}\n` +
            `files=${r.substantiveFiles.slice(0, 20).join(',')}\n`);
    }
    process.exit(r.substantive ? 0 : 3);
}
