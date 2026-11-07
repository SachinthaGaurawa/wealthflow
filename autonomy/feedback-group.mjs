/* =============================================================================
 * autonomy/feedback-group.mjs — how many updates do N pieces of feedback make?
 * -----------------------------------------------------------------------------
 * THE OWNER'S RULE (2026-11-07, twice, in his own words):
 *   - one piece of feedback  -> that one gets its own update, at once;
 *   - several pieces on the same day -> ONE update that fixes all of them, not one each;
 *   - and never "collect changes for weeks": a problem is fixed and shipped now.
 *
 * Two things follow, and both are pure rules kept here so they can be tested:
 *   1. WHO GOES TOGETHER   siblingsOf(): feedback filed on the same calendar day (the owner's, Asia/Colombo) as the first
 *                          one, capped so one run stays inside its time. A security or crash report is still worked first
 *                          and a sibling that cannot be fixed is simply left for its own update: it never holds the others.
 *   2. WHEN TO START       quietWaitSeconds(): a person sending feedback sends it in a burst while using the app. The run
 *                          waits until no new feedback has arrived for QUIET minutes (each new report restarts the wait),
 *                          but never longer than MAX minutes after the oldest waiting report, so a long sitting cannot
 *                          delay a fix indefinitely.
 *
 * This is NOT batching for a release window. The release job still cuts a version right after every merge.
 * ===========================================================================*/

export const GROUP_TZ = 'Asia/Colombo';
export const QUIET_MS = 15 * 60_000;
export const MAX_WAIT_MS = 45 * 60_000;
export const MAX_GROUP = 5;

/** 'YYYY-MM-DD' of an instant on the owner's calendar. null for anything that is not a date. */
export function dayKey(iso, tz = GROUP_TZ) {
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return null;
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
}

/** Filed by the in-app feedback form (feedback-triage.js puts this label on every issue it files). */
export function isFeedback(issue) {
    return (issue?.labels || []).some((l) => String(l?.name ?? l).toLowerCase() === 'user-feedback');
}

/**
 * The other reports that ride in the same update as `first`. Order is the queue's own order (severity first), so if the cap
 * cuts anyone it cuts the least severe, who get their own update next.
 */
export function siblingsOf(first, candidates, { max = MAX_GROUP, tz = GROUP_TZ } = {}) {
    if (!first || !isFeedback(first)) return [];
    const day = dayKey(first.created_at, tz);
    if (!day) return [];
    return (candidates || [])
        .filter((c) => c && c.number !== first.number && isFeedback(c) && dayKey(c.created_at, tz) === day)
        .slice(0, Math.max(0, max - 1));
}

/**
 * Seconds to wait before starting. Zero when nothing is waiting, when the newest report is already quiet, or when the
 * oldest has waited the maximum.
 * @param {{now:number,newestAt:number|null,oldestAt:number|null,quietMs?:number,maxMs?:number}} a  epoch ms
 */
export function quietWaitSeconds({ now, newestAt, oldestAt, quietMs = QUIET_MS, maxMs = MAX_WAIT_MS }) {
    if (!Number.isFinite(newestAt)) return 0;
    const until = Math.min(newestAt + quietMs, Number.isFinite(oldestAt) ? oldestAt + maxMs : Infinity);
    return Math.max(0, Math.ceil((until - now) / 1000));
}

/** Title for the one pull request (and so the one release note) that covers several reports. */
export function groupTitle(items) {
    const clean = (t) => String(t || '').replace(/^\[(critical|high|medium|low)\]\s*/i, '').replace(/^fix:\s*/i, '').trim();
    if (!items?.length) return 'fix: automated patch';
    if (items.length === 1) return `fix: ${clean(items[0].title).slice(0, 68)}`;
    const first = clean(items[0].title).slice(0, 44);
    return `fix: ${items.length} reports in one update (${first} and ${items.length - 1} more)`;
}
