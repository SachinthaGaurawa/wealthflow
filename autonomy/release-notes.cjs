/* =============================================================================
 * autonomy/release-notes.cjs — say what actually shipped
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *
 * v7.69.18 shipped a service worker that had never had a fetch handler, an
 * update progress bar that had been animating over setTimeout, and a release
 * gate that had been counting CI work as a user update. The changelog it wrote
 * for all of that was:
 *
 *     ## v7.69.18 — 2026-08-02
 *
 *     Improvements and fixes in this release.
 *
 * The owner read that, compared it with the release commit — which by design
 * contains nothing but version strings — and concluded the update was fake. He
 * was wrong about the gate and right about the experience: a release that will
 * not say what it did is indistinguishable from one that did nothing.
 *
 * That is this codebase's recurring defect in its purest form. The information
 * existed the whole time, in the commit subjects sitting in the range being
 * released. Nothing read them.
 *
 * WHAT THIS DOES NOT DO
 * It does not invent descriptions. The notes are exactly as good as the commit
 * subjects they are built from — if a commit says "fix stuff", the release says
 * "fix stuff", and that is a true signal about the commit rather than a
 * flattering one about the release. Generating prose that sounds better than
 * the underlying history would recreate the original problem with extra steps.
 *
 * It also refuses to pad. A range with nothing describable produces a line
 * saying so, not a sentence manufactured to fill the space.
 *
 * Zero dependencies. CommonJS so release.cjs can require it.
 * ===========================================================================*/
'use strict';

const { execSync } = require('child_process');
const { isMetaFile, isInfraFile } = require('./substantive.cjs');

/**
 * Commits that are bookkeeping rather than change. Releasing a list that says
 * "release: v7.69.17" back to the owner would be circular, and the hourly
 * merchant-data chore is the exact noise that caused the original fake-release
 * bug — neither belongs in notes describing what the app now does.
 */
const SKIP_SUBJECT = /^(release:|chore\(merchants\)|Merge (branch|pull request)|Revert ")/i;

/** Conventional-commit prefix, e.g. "fix(update): " or "feat: ". */
const CC = /^(\w+)(?:\(([^)]*)\))?!?:\s*/;

/** Human-facing bucket for a conventional-commit type. */
const BUCKETS = {
    fix: 'Fixed', feat: 'New', perf: 'Faster', revert: 'Reverted',
    refactor: 'Internal', chore: 'Internal', test: 'Internal',
    docs: 'Internal', build: 'Internal', ci: 'Internal', style: 'Internal',
};

/** Turn "fix(update): make it honest (#60)" into readable parts. */
function parseSubject(subject) {
    const raw = String(subject || '').trim();
    const m = CC.exec(raw);
    const type = m ? m[1].toLowerCase() : '';
    let text = m ? raw.slice(m[0].length) : raw;
    // The PR number is useful, but trailing " (#60)" reads better moved out.
    let pr = null;
    const p = /\s*\(#(\d+)\)\s*$/.exec(text);
    if (p) { pr = Number(p[1]); text = text.slice(0, p.index); }
    text = text.trim();
    if (text) text = text[0].toUpperCase() + text.slice(1);
    return { type, bucket: BUCKETS[type] || 'Changed', text, pr, raw };
}

/**
 * Read the commits in (from, to], with the files each one touched.
 *
 * Uses a record separator rather than parsing line-by-line, because commit
 * subjects legitimately contain every character a naive delimiter would use.
 */
function commitsInRange(from, to = 'HEAD', { repoDir = process.cwd(), exec = execSync } = {}) {
    let out = '';
    try {
        out = exec(
            `git log --no-merges --name-only --format=%x00%H%x1f%s ${from}..${to}`,
            { cwd: repoDir, maxBuffer: 1 << 28, encoding: 'utf8' },
        );
    } catch { return []; }

    const commits = [];
    for (const chunk of String(out).split('\0')) {
        if (!chunk.trim()) continue;
        const nl = chunk.indexOf('\n');
        const header = nl === -1 ? chunk : chunk.slice(0, nl);
        const [sha, subject] = header.split('\x1f');
        const files = (nl === -1 ? '' : chunk.slice(nl + 1))
            .split('\n').map((s) => s.trim()).filter(Boolean);
        commits.push({ sha: (sha || '').trim(), subject: subject || '', files });
    }
    return commits;
}

/**
 * Does this commit change something the owner's browser or API actually runs?
 * Reuses the same classification the release gate uses, so the notes and the
 * decision to release can never disagree about what "user-facing" means.
 */
function touchesUserFacing(files) {
    return (files || []).some((f) => !isMetaFile(f) && !isInfraFile(f));
}

/**
 * Build the release notes for a set of commits.
 *
 * @returns {{markdown:string, summary:string, userFacing:number, internal:number}}
 */
function describeRelease(commits, { version = null } = {}) {
    const kept = (commits || []).filter((c) => !SKIP_SUBJECT.test(String(c.subject || '').trim()));

    const user = [];
    const internal = [];
    for (const c of kept) {
        const p = parseSubject(c.subject);
        if (!p.text) continue;
        (touchesUserFacing(c.files) ? user : internal).push(p);
    }

    // Nothing describable. Say that rather than inventing a sentence — an
    // honest blank is what let the owner catch the fake releases in the first
    // place, and padding here would take that signal away again.
    if (!user.length && !internal.length) {
        return {
            markdown: 'No described changes in this release. '
                + '(If you are seeing this, the release contained only data or version updates.)',
            summary: 'No described changes.',
            structured: null,            // nothing to show beats a hollow sheet
            userFacing: 0, internal: 0,
        };
    }

    const line = (p) => `- ${p.text}${p.pr ? ` (#${p.pr})` : ''}`;
    const parts = [];

    if (user.length) {
        parts.push('**What changed for you**', '');
        for (const p of user) parts.push(line(p));
        parts.push('');
    }
    if (internal.length) {
        // Kept, but clearly separated. The owner asked more than once to know
        // which changes he would actually notice; folding pipeline work in with
        // app work is how "Update available" stopped meaning anything.
        parts.push(user.length ? '**Under the hood**' : '**Internal changes only**', '');
        for (const p of internal) parts.push(line(p));
        parts.push('');
    }

    const summary = user.length
        ? `${user.length} change${user.length === 1 ? '' : 's'} you may notice`
          + (internal.length ? `, ${internal.length} internal` : '')
        : `${internal.length} internal change${internal.length === 1 ? '' : 's'} — nothing user-facing`;

    // The shape wealthflow-update-system.js::_normNotes already understands:
    // { headline, sections: [{ title, items: [] }] }. That renderer has existed
    // the whole time and has only ever been handed the single string
    // "Improvements and fixes in this release." — a sectioned What's New sheet
    // the app could always have drawn, fed one sentence that said nothing.
    // It escapes its text, so markdown must NOT be sent here; it gets plain
    // items and does its own layout.
    const sections = [];
    if (user.length) {
        sections.push({
            title: 'What changed for you',
            items: user.map((p) => p.text + (p.pr ? ` (#${p.pr})` : '')),
        });
    }
    if (internal.length) {
        sections.push({
            title: user.length ? 'Under the hood' : 'Internal changes only',
            items: internal.map((p) => p.text + (p.pr ? ` (#${p.pr})` : '')),
        });
    }

    return {
        markdown: parts.join('\n').trim(),
        summary,
        structured: {
            headline: version ? `What's new in v${version}` : "What's New",
            date: new Date().toISOString().slice(0, 10),
            sections,
        },
        userFacing: user.length,
        internal: internal.length,
    };
}

/**
 * The one-call path release.cjs uses: find the previous tag, read the range,
 * describe it. Degrades to null (never to a lie) if git cannot answer.
 */
function notesForRelease({ repoDir = process.cwd(), from = null, to = 'HEAD', exec = execSync } = {}) {
    let base = from;
    if (!base) {
        try {
            base = exec('git describe --tags --abbrev=0', { cwd: repoDir, encoding: 'utf8' }).trim();
        } catch { return null; }          // no tag yet — caller keeps its default
    }
    if (!base) return null;
    const commits = commitsInRange(base, to, { repoDir, exec });
    if (!commits.length) return null;
    return { base, ...describeRelease(commits) };
}

module.exports = {
    SKIP_SUBJECT, BUCKETS,
    parseSubject, commitsInRange, touchesUserFacing, describeRelease, notesForRelease,
};

// ── CLI: preview what the next release would say ─────────────────────────────
if (require.main === module) {
    const from = process.argv[2] || null;
    const to = process.argv[3] || 'HEAD';
    const r = notesForRelease({ from, to });
    if (!r) { console.log('(no commits to describe)'); process.exit(0); }
    console.log(`\n── notes for ${r.base}..${to} ──\n`);
    console.log(r.markdown);
    console.log(`\nsummary: ${r.summary}\n`);
}
