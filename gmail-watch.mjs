/* =============================================================================
 * gmail-watch.mjs — the decisions behind asking Gmail to notify us
 * -----------------------------------------------------------------------------
 * THE HALF THAT WAS NEVER BUILT
 *
 * gmail-hook.js verifies a Pub/Sub push, reads the history, downloads the
 * attachments and files them. It is complete. But Google does not push to a
 * topic because a topic exists — it pushes because a mailbox has an active
 * WATCH on it, registered by calling users.watch with an access token minted
 * from that mailbox's own refresh token.
 *
 * Nothing in this repository has ever called it. PUB_SUB_TOPIC was set as an
 * environment variable and read by nobody. So the endpoint that receives pushes
 * had never received one, and the owner would have connected a mailbox, been
 * told "Mailbox connected", and waited forever.
 *
 * ── AND IT EXPIRES ──────────────────────────────────────────────────────────
 *
 * A Gmail watch lasts SEVEN DAYS. Registering it once is not "done"; it is a
 * pipeline with a week-long fuse. Renewal is therefore not an enhancement to
 * add later — a feature that stops working on day eight was never finished.
 *
 * The renewal is driven from the page (see index.html), which needs no new
 * secret and no scheduled runner. The cost is that it renews when the owner
 * opens the app: fine at a six-day margin for an app opened weekly, and NOT
 * something to be quiet about — statusOf() reports the expiry so a lapse shows
 * on the card instead of being discovered as silence.
 * ===========================================================================*/

/** Where the watch state is recorded: the same document as the token. */
export const MAIL_ROOT = 'wf-mail';

export const WATCH = {
    /** Google's own maximum. Stated here so the renewal margin can be read
     *  against it rather than against a number nobody can place. */
    MAX_LIFETIME_DAYS: 7,
    /** Renew with this much left. Six days of a seven-day watch means an app
     *  opened once a week never lapses, and one opened daily renews once a
     *  week rather than once a day. */
    RENEW_WITH_DAYS_LEFT: 6,
    /** Below this, say so plainly rather than showing a comfortable date. */
    WARN_WITH_DAYS_LEFT: 2,
};

const DAY_MS = 86400000;

/**
 * The fully-qualified Pub/Sub topic, or null.
 *
 * PUB_SUB_TOPIC is accepted in either spelling, because both are what a person
 * actually copies out of the Google Cloud console: the bare topic id, and the
 * full `projects/x/topics/y` resource name. Requiring one and silently failing
 * on the other is a configuration trap, and the failure would surface days
 * later as "no statements ever arrived".
 */
export function topicNameFrom(env) {
    const raw = String((env && env.PUB_SUB_TOPIC) || '').trim();
    if (!raw) return null;
    if (raw.startsWith('projects/')) {
        return /^projects\/[^/]+\/topics\/[^/]+$/.test(raw) ? raw : null;
    }
    const project = String((env && env.GCP_PROJECT_ID) || '').trim();
    if (!project || !/^[\w.-]+$/.test(project)) return null;
    if (!/^[\w.~+%-]+$/.test(raw)) return null;
    return `projects/${project}/topics/${raw}`;
}

/** Which variables the watch needs and does not have. */
export function missingWatchConfig(env) {
    const e = env || {};
    const out = [];
    if (!String(e.GOOGLE_OAUTH_CLIENT_ID || '').trim()) out.push('GOOGLE_OAUTH_CLIENT_ID');
    if (!String(e.GOOGLE_OAUTH_CLIENT_SECRET || '').trim()) out.push('GOOGLE_OAUTH_CLIENT_SECRET');
    if (!String(e.PUB_SUB_TOPIC || '').trim()) out.push('PUB_SUB_TOPIC');
    // Only needed to BUILD the resource name; a full resource name supplies it.
    if (!topicNameFrom(e) && !String(e.GCP_PROJECT_ID || '').trim()) out.push('GCP_PROJECT_ID');
    return out;
}

/**
 * The users.watch request body.
 *
 * INBOX only, deliberately. Without a label filter Gmail notifies on every
 * change in the mailbox — drafts, label edits, reads — and each one costs a
 * function invocation and a history query that finds nothing. The statements
 * this pipeline exists for arrive in the inbox.
 */
export function watchBody(topicName) {
    return {
        topicName: String(topicName),
        labelIds: ['INBOX'],
        labelFilterBehavior: 'INCLUDE',
    };
}

/**
 * What to store after a successful users.watch.
 *
 * `historyId` IS RECORDED HERE, and that is a deliberate reversal of the rule
 * in gmail-link.mjs, which leaves it unset so a first push starts from the
 * beginning. The difference is what each one knows. At link time nothing has
 * been ingested and the whole mailbox is unread history worth having. By the
 * time a watch is RENEWED the pipeline has been running, and Gmail's own
 * response carries the current point — writing it keeps the next push's history
 * query bounded instead of asking for a week of changes that were all handled.
 *
 * So it is written only when there was already a bookmark to advance. A first
 * registration leaves the field alone, and the first push still starts from
 * the beginning exactly as gmail-link.mjs intends.
 */
export function watchRecord(response, topicName, { hadHistoryId = false, now = Date.now() } = {}) {
    const expiration = Number((response && response.expiration) || 0);
    const rec = {
        watchTopic: String(topicName),
        watchedAt: now,
        watchExpiry: Number.isFinite(expiration) && expiration > 0 ? expiration : now + WATCH.MAX_LIFETIME_DAYS * DAY_MS,
    };
    const hid = response && response.historyId;
    if (hadHistoryId && hid) rec.historyId = String(hid);
    return rec;
}

/** Days remaining on the watch, or null when there is not one. */
export function daysLeft(record, now = Date.now()) {
    const exp = Number((record && record.watchExpiry) || 0);
    if (!Number.isFinite(exp) || exp <= 0) return null;
    return (exp - now) / DAY_MS;
}

/**
 * Should the watch be re-registered?
 *
 * True when there is no watch at all, when it has expired, and when it is
 * inside the renewal margin. users.watch is idempotent — calling it again
 * simply extends the same watch — so renewing early is cheap and lapsing is
 * not.
 */
export function needsRenewal(record, now = Date.now()) {
    if (!record || !record.refresh_token) return false;   // nothing to watch with
    const left = daysLeft(record, now);
    if (left === null) return true;                        // never registered
    return left <= WATCH.RENEW_WITH_DAYS_LEFT;
}

/**
 * What the page may know about the watch.
 *
 * A number of days AND the date, because "expires in 2 days" is what prompts
 * action and the date is what makes it checkable. Never the topic's project —
 * that is deployment configuration, not something a client needs.
 */
export function watchStatusOf(record, now = Date.now()) {
    const left = daysLeft(record, now);
    if (left === null) {
        return { watching: false, expiresAt: null, daysLeft: null, expiring: false, expired: false };
    }
    return {
        watching: left > 0,
        expiresAt: Number(record.watchExpiry),
        daysLeft: Math.max(0, Math.round(left * 10) / 10),
        expiring: left > 0 && left <= WATCH.WARN_WITH_DAYS_LEFT,
        expired: left <= 0,
    };
}
