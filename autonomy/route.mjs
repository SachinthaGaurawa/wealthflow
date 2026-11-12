/* =============================================================================
 * autonomy/route.mjs — who filed this, and what did the earlier tries already rule out
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS (measured, 2026-11-12)
 *   Issue #559 was filed by the statement reader about a card statement whose payments do not add up. One sentence
 *   in it says "The layout convention was closed for that statement". The lane routers read WORDS, the word
 *   "layout" is a layout word, so the report went to the CSS lane, which measured every page at seven widths,
 *   found no overlap (there was none to find), and stopped. The next run did exactly the same, and the third, and
 *   then the agent stood down with `ai-stuck`. Three tries, one mistake, made three times.
 *
 *   Two separate faults:
 *     1. WORDS WERE READ WHERE A LABEL ALREADY SAID THE ANSWER. A report a PROGRAM filed says what it is with a label
 *        or a marker (`statement-reading`, `<!-- wf-layout-screen: … -->`, `feature-proposal`). Its sentences were
 *        written by a template, for a reader, and were never meant to be a routing signal. Words are for people.
 *     2. A TRY THAT COULD NOT DIFFER FROM THE LAST ONE WAS STILL MADE. Nothing told the second try what the first had
 *        ruled out, so it ruled it out again.
 *
 * WHAT IS HERE (pure functions, no imports, no network)
 *   isSystemFiled  the report came from a program, not from a person
 *   systemRole     the role a program-filed report belongs to, from its labels and markers only
 *   fromStranger   a comment by somebody who is neither the agent nor a maintainer (it is not evidence)
 *   attemptTrail   what each earlier try did: its lane, where it stopped and why (read from the agent's own comments)
 *   laneRuledOut   an earlier try already showed this lane has nothing to work on
 *   attemptBrief   the earlier tries, written for the author of the next one
 * ===========================================================================*/

const names = (issue) => (issue?.labels || []).map((l) => String(l?.name || l).toLowerCase());

/** The marker a layout finding carries when the system MEASURED it (autonomy/discover.mjs layoutFindings). */
export const LAYOUT_MARKER = /<!--\s*wf-layout-screen:\s*([a-z0-9-]+)\s*(?:width=(\d+))?\s*-->/i;

/**
 * Did a program file this? A person's report comes through the feedback form (label `user-feedback`, a
 * "### User feedback" section) or is typed on GitHub by hand (no `autonomous` label). Everything else that carries
 * `autonomous`, and every idea the system thought of, is the system talking to itself.
 */
export function isSystemFiled(issue) {
    const l = names(issue);
    const body = String(issue?.body || '');
    if (l.includes('user-feedback') || /^### User feedback\s*$/m.test(body)) return false;
    return l.includes('autonomous') || l.includes('feature-proposal') || l.includes('statement-reading') || LAYOUT_MARKER.test(body);
}

/**
 * The role for a report a program filed, from labels and markers ONLY. Returns null for a person's report, whose words
 * are read by work-queue.mjs::roleFor as before.
 */
export function systemRole(issue) {
    if (!isSystemFiled(issue)) return null;
    const l = names(issue);
    if (l.includes('feature-proposal')) return 'feature';
    if (l.includes('security')) return 'security';
    if (l.includes('statement-reading')) return 'bug';          // a reading that is wrong is a defect in the reader's rules
    if (LAYOUT_MARKER.test(String(issue?.body || '')) || l.includes('ui/ux')) return 'ui';
    if (l.includes('enhancement')) return 'feature';
    return 'bug';
}

/** May the layout lane take it? A program-filed report only with the marker that names the screen it measured. */
export function layoutAllowed(issue) {
    if (!isSystemFiled(issue)) return { ok: true, why: '' };
    if (LAYOUT_MARKER.test(String(issue?.body || ''))) return { ok: true, why: '' };
    return { ok: false, why: 'the report was filed by a program and carries no layout marker, so its wording does not decide the lane' };
}

const ATTEMPT = /<!--\s*wf-agent-attempt\s*-->/;
const TRUSTED = /^(OWNER|MEMBER|COLLABORATOR)$/;
const AGENT_LOGIN = 'github-actions[bot]';

/**
 * Is this comment from somebody who has no say here? The repository is public, so anyone may comment on an issue and
 * anyone may type the agent's marker. A comment that says who wrote it, and that writer is neither the agent's own
 * account nor a maintainer, is not the agent's trail: it must not count as a try, rule a lane out, or put its words
 * in front of the author model. (A comment with no author at all only exists in tests; GitHub always sends one.)
 */
export function fromStranger(c) {
    const login = String((c && c.user && c.user.login) || '');
    if (!login) return false;
    if (login === AGENT_LOGIN) return false;
    return !TRUSTED.test(String((c && c.author_association) || ''));
}
const RESET = /<!--\s*wf-agent-reset\s*-->/;
const field = (body, name) => ((body.match(new RegExp('\\*\\*' + name + ':\\*\\*\\s*`?([^`\\n]+?)`?\\s*(?:\\n|$)')) || [])[1] || '').trim();

/**
 * What each earlier try did. Reads the agent's own comments (the same ones attemptsFrom counts). A maintainer's
 * `<!-- wf-agent-reset -->` starts the trail again, exactly as it restarts the count.
 * Comments written before 2026-11-12 carry no "Lane:" line; the only lane that stops at `measure` is the layout lane.
 */
export function attemptTrail(comments) {
    let trail = [];
    for (const c of comments || []) {
        const body = String((c && c.body) || '');
        if (RESET.test(body) && TRUSTED.test(String((c && c.author_association) || ''))) { trail = []; continue; }
        if (!ATTEMPT.test(body) || fromStranger(c)) continue;
        const stage = field(body, 'Stopped at');
        const drafted = /Fix drafted/.test(body);
        const lane = (field(body, 'Lane') || (stage === 'measure' ? 'layout' : '')).toLowerCase();
        trail.push({
            n: trail.length + 1,
            lane,
            stage: drafted ? 'drafted' : stage,
            why: drafted ? 'a fix was drafted and opened as a pull request; it did not close the report, so CI or review refused it' : field(body, 'Why').slice(0, 320),
            file: field(body, 'File considered') || field(body, 'File'),
        });
    }
    return trail;
}

/** The layout lane said there was nothing on any screen to prove a change against. */
export function nothingToMeasure(result) {
    return !!result && result.ok === false && result.stage === 'measure'
        && /nothing to prove|No overlap, overflow or cut-off text was found|none of the pages shows/i.test(String(result.reason || ''));
}

/**
 * An earlier try already showed this lane has nothing to work on, so taking it again cannot end differently.
 * Only the layout lane can be ruled out this way: its first step is a measurement, and a measurement that found
 * nothing is evidence. (A code lane that failed may well succeed with a different file or approach.)
 */
export function laneRuledOut(trail, lane) {
    if (lane !== 'layout') return false;
    return (trail || []).some((t) => t.lane === 'layout' && nothingToMeasure({ ok: false, stage: t.stage, reason: t.why }));
}

/** The earlier tries, for the author of the next one. Empty when there were none. */
export function attemptBrief(trail) {
    const rows = (trail || []).filter((t) => t.stage);
    if (!rows.length) return '';
    return [
        '',
        '',
        '### Earlier tries on this report (do NOT repeat them)',
        ...rows.map((t) => `- Try ${t.n}${t.lane ? ` (${t.lane} lane)` : ''} stopped at \`${t.stage}\`${t.file ? ` on \`${t.file}\`` : ''}: ${t.why || 'no reason recorded'}`),
        'Choose a different file or a different approach from every try above. If the same obstacle would stop you again, say CANNOT_FIX_SAFELY and name what is missing.',
        '',
    ].join('\n');
}
