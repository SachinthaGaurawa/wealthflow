/* =============================================================================
 * autonomy/ships.mjs — which changed files ever reach the person's device
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured, 2026-11-12, pull request #605)
 *   #605 changed CI workflows, agent scripts, tests and documents. No file of the app. On six of its nine review rounds
 *   the board's user-impact seat failed it with:
 *     "The user will see a new update notice..."     evidence: a row of an ideas table in a document
 *     "The user will see a new screen, "Pacemaker"..." evidence: the `name:` line of a GitHub workflow
 *   Both cited a real added line, so every existing check let the objection stand. Neither line can put anything in
 *   front of anyone: the files they are in are on `.vercelignore` and are never served.
 *
 *   The seat was not careless, it was cornered. Its first rule says "name what the user will see", and a denial is
 *   forbidden because five earlier changes that DID alter the screen were waved through as "no user-facing change".
 *   Given a change with nothing to see and no permission to say so, a weaker model invents a screen.
 *
 * WHAT IS HERE (pure functions; the caller reads `.vercelignore` and passes its text in)
 *   parseIgnore        the deploy ignore list as patterns
 *   shipsToUser        is this path served to the device (anything not ignored: pages, scripts, styles, api handlers)
 *   changedFilesOf     every file a diff touches (from its headers, and from the manifest of a trimmed diff)
 *   splitByShipping    { shipped, unshipped, unknown } for a diff; unknown = the ignore list itself is being edited
 *   shippedPartOf      the hunks of the diff that belong to files the person receives
 *   userFactsBlock     the computed facts the user-impact seat is told before it answers
 *   claimsSight        the reason says the person will SEE something
 *   seesWhatNeverShips the reason says so about a line that is never served: why, or null
 * ===========================================================================*/

const esc = (s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** One ignore line as a matcher. Covers what this repository's list uses: names, `*.ext`, `dir/`, `/anchored/`, `!keep`. */
function compile(raw) {
    let p = raw.trim();
    if (!p || p.startsWith('#')) return null;
    const negate = p.startsWith('!');
    if (negate) p = p.slice(1);
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const anchored = p.startsWith('/') || p.includes('/');     // a slash anywhere but the end ties it to the root
    if (p.startsWith('/')) p = p.slice(1);
    if (!p) return null;
    const body = p.split('/').map((seg) => seg.split('**').map((part) => part.split('*').map(esc).join('[^/]*')).join('.*')).join('/');
    // Matches the path itself or anything under it; an unanchored pattern may start at any folder.
    const re = new RegExp(`${anchored ? '^' : '(?:^|/)'}${body}${dirOnly ? '/' : '(?:/|$)'}`);
    return { negate, re };
}

export function parseIgnore(text) {
    return String(text || '').split('\n').map(compile).filter(Boolean);
}

/** Is this path served to the person's device? Unknown list (empty) means "yes": never assume a file is harmless. */
export function shipsToUser(file, patterns) {
    const f = String(file || '').replace(/^\.?\//, '');
    if (!f) return true;
    let ignored = false;
    for (const p of patterns || []) if (p.re.test(f)) ignored = !p.negate;
    return !ignored;
}

const HEADER = /^diff --git a\/(.+?) b\/(.+)$/;
const MANIFEST = /^#\s{3}(\S.*?)\s{2}\+\d+ -\d+(?:\s{2}\[[^\]]+\])?$/;

/** Every file a diff touches. A trimmed diff lists files it could not show in its manifest; those count too. */
export function changedFilesOf(diff) {
    const out = new Set();
    for (const line of String(diff || '').split('\n')) {
        const h = HEADER.exec(line);
        if (h) { out.add(h[2]); continue; }
        const m = MANIFEST.exec(line);
        if (m) out.add(m[1]);
    }
    return [...out];
}

/** The deploy list is itself being edited: what ships is then part of the question, so nothing is concluded from it. */
const editsTheList = (files) => files.some((f) => /(^|\/)\.vercelignore$/.test(f));

export function splitByShipping(diff, patterns) {
    const files = changedFilesOf(diff);
    if (!files.length || !(patterns || []).length || editsTheList(files)) return { shipped: [], unshipped: [], unknown: true, files };
    const shipped = files.filter((f) => shipsToUser(f, patterns));
    return { shipped, unshipped: files.filter((f) => !shipped.includes(f)), unknown: false, files };
}

/** The hunks that belong to files the person receives. With an unknown split the whole diff is returned. */
export function shippedPartOf(diff, patterns) {
    const text = String(diff || '');
    if (splitByShipping(text, patterns).unknown) return text;
    return text.split(/(?=^diff --git )/m).filter((chunk) => {
        const h = HEADER.exec(chunk.split('\n', 1)[0] || '');
        return h ? shipsToUser(h[2], patterns) : false;       // the manifest and any preamble are not the product
    }).join('');
}

const kindOf = (f) => (/^\.github\//.test(f) ? 'CI workflow'
    : /(^|\/)(test|tests|Test)\//.test(f) || /\.test\.js$/.test(f) ? 'test'
        : /\.md$/.test(f) ? 'document'
            : /^autonomy\//.test(f) || /^(autonomous-fix-agent|consensus-review)\./.test(f) ? 'agent script' : 'tooling');

/**
 * What the user-impact seat is told before it answers. Facts only, each one computed. Empty when nothing can be
 * established (no ignore list, or the list is being edited), so the seat is never handed a guess.
 */
export function userFactsBlock(diff, patterns) {
    const s = splitByShipping(diff, patterns);
    if (s.unknown) return '';
    const list = (xs, n) => xs.slice(0, n).map((f) => `\`${f}\``).join(', ') + (xs.length > n ? ` and ${xs.length - n} more` : '');
    const kinds = [...new Set(s.unshipped.map(kindOf))].join(', ');
    const lines = [
        'FACTS ABOUT THIS CHANGE (computed from the repository\'s deploy list; not an opinion, and not yours to dispute):',
        s.shipped.length
            ? `  - Files served to the person's device: ${list(s.shipped, 12)}. Only these can change what is on their screen.`
            : `  - Files served to the person's device: NONE of the ${s.files.length} files in this change.`,
    ];
    if (s.unshipped.length) lines.push(`  - Files that never reach the device (${kinds}): ${list(s.unshipped, 8)}.`);
    lines.push('  - The name of a workflow, a string in a test, a row in a document or a log line is not a screen, a button or a notice. The person never sees it.');
    if (!s.shipped.length) {
        lines.push(
            '  - So nothing in this change can put anything new in front of the person. The rule that asks you to name what they will see does NOT ask you to invent it.',
            '  - Here the honest review says that nothing on their screen changes, and then names what they may notice INDIRECTLY, if anything (for example: updates arriving less often, a fix arriving later, a job running more reliably). Judge that indirect effect.',
        );
    }
    return lines.join('\n');
}

/** The reason says the person will see something: a direct claim about their screen. */
const SIGHT = /\b(?:will|would|may|might|could|can)\s+(?:now\s+)?see\b|\bsees?\s+a\s+new\b|\bnew\s+(?:screen|page|button|notice|notification|banner|card|dialog|pop-?up|message|label|icon|toast|setting|menu|tab)\b|\b(?:appears?|shown|displayed|visible)\s+(?:on|in)\s+(?:the\s+|their\s+)?(?:screen|app|interface|ui)\b/i;

export function claimsSight(reason) {
    return SIGHT.test(String(reason || ''));
}

const norm = (s) => String(s || '').replace(/^[+\-]\s?/, '').replace(/\s+/g, ' ').trim();

/** The files whose ADDED lines contain this evidence. Same matching rule as the board's own evidence check. */
export function filesOfAddedLine(diff, evidence) {
    const ev = norm(evidence);
    if (!ev) return [];
    const out = new Set();
    for (const chunk of String(diff || '').split(/(?=^diff --git )/m)) {
        const h = HEADER.exec(chunk.split('\n', 1)[0] || '');
        if (!h) continue;
        for (const raw of chunk.split('\n')) {
            if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
            const l = norm(raw);
            if (!l) continue;
            if (l === ev || (ev.length >= 12 && l.includes(ev)) || (l.length >= 12 && ev.includes(l))) { out.add(h[2]); break; }
        }
    }
    return [...out];
}

/**
 * A user-impact objection that says the person will SEE something, about a line that is never served to them.
 * Returns the sentence the board prints, or null when the objection is not of that kind.
 *
 * Deliberately narrow, so a real concern is never thrown out:
 *   - only a claim of SIGHT. "A fix may arrive two hours later" cites a workflow line too, is an indirect effect, and stands.
 *   - with cited evidence: every file that line was added to must be off the deploy list.
 *   - with no evidence that can be placed: only when NO file in the whole change is served.
 *   - never when the deploy list is being edited by the same change, or cannot be read.
 */
export function seesWhatNeverShips(reason, evidence, diff, patterns) {
    if (!claimsSight(reason)) return null;
    const s = splitByShipping(diff, patterns);
    if (s.unknown) return null;
    const at = filesOfAddedLine(diff, evidence);
    if (at.length) {
        if (at.some((f) => shipsToUser(f, patterns))) return null;
        return `the reason says the person will see it, but the cited line is in \`${at[0]}\` (${kindOf(at[0])}), which is never served to their device`;
    }
    if (s.shipped.length) return null;
    return `the reason says the person will see something new, but none of the ${s.files.length} files in this change is served to their device`;
}
