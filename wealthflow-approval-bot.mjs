/* =============================================================================
 * wealthflow-approval-bot.mjs — approving a pull request from a phone
 * -----------------------------------------------------------------------------
 * WHAT THIS IS FOR
 *
 * Every change touching a guarded path — index.html, .github/, policy/, the
 * statement store — is held by the Risk gate until the owner puts the
 * `human-approved` label on the pull request. That is deliberate and it stays.
 * What it costs today is a laptop: the owner has to open GitHub, find the PR,
 * and add a label. This turns that into one tap on a phone.
 *
 * IT DOES NOT WEAKEN THE GATE, AND THAT IS THE WHOLE DESIGN CONSTRAINT.
 *
 * The gate asks for a human decision. This does not decide anything — it carries
 * the owner's decision from Telegram to GitHub. So the security of the gate
 * becomes the security of THIS path, and it is stated plainly rather than
 * assumed:
 *
 *   1. Telegram signs every webhook delivery with a secret token the bot owner
 *      chose. A request without it, or with a wrong one, is refused before
 *      anything is parsed. Compared in constant time — a byte-at-a-time compare
 *      leaks the secret to anyone patient enough to measure.
 *   2. The pressing user's numeric Telegram id must equal the configured owner.
 *      A chat id is not a secret; it is the second factor, not the first.
 *   3. The callback payload is matched against a closed grammar. It can express
 *      exactly two verbs and a pull-request number, so a crafted payload cannot
 *      name a different label, a different repository, or a different action.
 *   4. Missing configuration REFUSES. There is no default that allows.
 *
 * WHAT IT SHOWS THE OWNER, AND WHY THE SHA IS ON THE BUTTON
 *
 * The Risk gate re-checks freshness: if a guarded file changes AFTER the label
 * was applied, the label is void, because it covers code the approver never saw.
 * That happened for real — three commits landed after an approval and the gate
 * correctly went red. So the message names the exact head SHA being approved,
 * and the confirmation repeats it. An approval you cannot attribute to a commit
 * is not an approval.
 *
 * WHATSAPP
 *
 * Not here, and not an oversight. WhatsApp has no free programmatic send: it
 * requires the Meta Cloud API, a verified Business account, and per-conversation
 * pricing. This project runs on free tiers by explicit instruction, so the
 * honest answer is Telegram now — whose Bot API is free and needs no business
 * verification — and WhatsApp only if the owner decides to pay for it. Half of
 * a WhatsApp integration that cannot send is worse than none.
 *
 * Pure and injectable: no network, no clock, no secrets read from here. The
 * serverless handler in api/telegram-approve.js supplies all of it, so these
 * rules are tested rather than a mock of them.
 * ===========================================================================*/

/** The label the Risk gate reads. Nothing here may name any other. */
export const APPROVAL_LABEL = 'human-approved';

/** What a button may ask for. A closed set, checked by identity. */
export const ACTION = { APPROVE: 'approve', REVOKE: 'revoke' };

/** Why a request was refused. Never shown to a stranger; logged for the owner. */
export const REFUSE = {
    NOT_POST: 'not-a-post',
    NO_SECRET_CONFIGURED: 'no-webhook-secret-configured',
    NO_OWNER_CONFIGURED: 'no-owner-configured',
    BAD_SECRET: 'wrong-webhook-secret',
    NOT_OWNER: 'not-the-owner',
    NO_CALLBACK: 'not-a-button-press',
    BAD_ACTION: 'unrecognised-button',
};

/* Telegram's own limits: callback_data is capped at 64 bytes, and a PR number
 * is a positive integer. Both are enforced rather than assumed, because the
 * payload arrives from the network and "it came from Telegram" is a claim, not
 * a fact, until the secret has been checked. */
const MAX_CALLBACK_BYTES = 64;
const MAX_PR = 999999;

/**
 * `approve:1234:bd96f38` — the only shape a button may carry.
 *
 * THE SHA IS IN THE BUTTON, not just in the message text, and that is the point
 * rather than a decoration. The Risk gate voids an approval when a guarded file
 * changes after it was given, so an approval means "this commit". Carrying the
 * short SHA in the callback data makes the press attributable to exactly what
 * the owner was looking at, and lets the confirmation name it — a button that
 * cannot say what it approved is a button whose record is hearsay.
 *
 * It fits easily: 'approve:999999:abcdef0' is 22 of Telegram's 64 bytes.
 */
export function encodeAction(kind, pr, sha) {
    const n = Number(pr);
    if (kind !== ACTION.APPROVE && kind !== ACTION.REVOKE) return null;
    if (!Number.isInteger(n) || n < 1 || n > MAX_PR) return null;
    const short = String(sha == null ? '' : sha).toLowerCase().slice(0, 7);
    if (short && !/^[0-9a-f]{7}$/.test(short)) return null;
    const out = kind + ':' + n + (short ? ':' + short : '');
    return Buffer.byteLength(out, 'utf8') <= MAX_CALLBACK_BYTES ? out : null;
}

/**
 * Read a button press back, or null.
 *
 * Anchored, and the number is bounded and free of leading zeros. A permissive
 * parse here is the difference between "approve PR 12" and a payload that reads
 * as something else entirely three functions later.
 */
export function parseAction(data) {
    const m = /^(approve|revoke):([1-9]\d{0,5})(?::([0-9a-f]{7}))?$/
        .exec(String(data == null ? '' : data));
    if (!m) return null;
    const pr = Number(m[2]);
    if (pr > MAX_PR) return null;
    return { kind: m[1], pr, sha: m[3] || '' };
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * `a === b` on strings stops at the first differing byte, so an attacker who can
 * time the response learns the secret one character at a time. Length is
 * compared first and separately — that much is unavoidable and is not the part
 * worth protecting.
 */
export function secretMatches(given, expected) {
    const a = String(given == null ? '' : given);
    const b = String(expected == null ? '' : expected);
    if (a.length !== b.length || b.length === 0) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return diff === 0;
}

/**
 * May this request act?
 *
 * Every branch returns a reason, and the DEFAULT IS REFUSAL — an unconfigured
 * deployment must not approve anything. The commonest way a gate like this
 * fails open is an env var that is simply absent in production.
 */
export function authorise({ method, secretHeader, expectedSecret, fromId, ownerId } = {}) {
    if (String(method || '').toUpperCase() !== 'POST') return { ok: false, reason: REFUSE.NOT_POST };
    if (!expectedSecret) return { ok: false, reason: REFUSE.NO_SECRET_CONFIGURED };
    if (!ownerId) return { ok: false, reason: REFUSE.NO_OWNER_CONFIGURED };
    if (!secretMatches(secretHeader, expectedSecret)) return { ok: false, reason: REFUSE.BAD_SECRET };
    /* String comparison, not numeric: Telegram ids exceed what a double holds
     * exactly for some accounts, and `12345678901234567 == 12345678901234568`
     * is true in JavaScript. An id is an identifier, not a quantity. */
    if (String(fromId || '') !== String(ownerId)) return { ok: false, reason: REFUSE.NOT_OWNER };
    return { ok: true, reason: null };
}

/** The button press inside an update, or a reason it is not one. */
export function readPress(update) {
    const cq = update && update.callback_query;
    if (!cq || typeof cq !== 'object') return { ok: false, reason: REFUSE.NO_CALLBACK };
    const action = parseAction(cq.data);
    if (!action) return { ok: false, reason: REFUSE.BAD_ACTION };
    return {
        ok: true,
        reason: null,
        action,
        fromId: cq.from && cq.from.id,
        callbackId: cq.id,
        chatId: cq.message && cq.message.chat && cq.message.chat.id,
        messageId: cq.message && cq.message.message_id,
    };
}

const clip = (s, n) => {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '…' : t;
};

/* Telegram renders a subset of HTML. Anything interpolated into it — a pull
 * request title is written by whoever opened the pull request — is escaped, or
 * a title containing a tag rewrites the message the owner is deciding on. */
export function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The message the owner sees, and the two buttons under it.
 *
 * The head SHA is in the body ON PURPOSE. The Risk gate voids a label when a
 * guarded file changes after it was applied, so an approval is only meaningful
 * against a specific commit — and an owner who cannot see which commit they are
 * approving is being asked to sign a blank page.
 */
export function approvalMessage({ repo, pr, title, sha, paths, url } = {}) {
    const n = Number(pr);
    if (!Number.isInteger(n) || n < 1) return null;
    const head = String(sha || '').slice(0, 7);
    const files = Array.isArray(paths) ? paths.slice(0, 6) : [];

    const lines = [
        '<b>Approval needed</b>',
        esc(clip(repo, 60)) + ' #' + n,
        '',
        esc(clip(title, 120)),
    ];
    if (head) lines.push('', 'Commit: <code>' + esc(head) + '</code>');
    if (files.length) {
        lines.push('', 'Guarded files in this change:');
        for (const f of files) lines.push('  · <code>' + esc(clip(f, 60)) + '</code>');
        if (Array.isArray(paths) && paths.length > files.length) {
            lines.push('  · and ' + (paths.length - files.length) + ' more');
        }
    }
    lines.push('', 'Approving adds the <code>' + APPROVAL_LABEL + '</code> label to this commit.',
        'Any later change to a guarded file voids it, and it must be given again.');

    const approve = encodeAction(ACTION.APPROVE, n, head);
    const revoke = encodeAction(ACTION.REVOKE, n, head);
    if (!approve || !revoke) return null;

    const row = [
        { text: 'Approve', callback_data: approve },
        { text: 'Not yet', callback_data: revoke },
    ];
    if (url) row.push({ text: 'Open', url: String(url) });

    return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: [row] } };
}

/**
 * What the message becomes once the button has been pressed.
 *
 * The keyboard is REMOVED, not disabled: Telegram keeps old buttons live
 * forever, and a message that still offers "Approve" after being approved is an
 * invitation to press it again against a commit that has since moved on.
 */
export function outcomeMessage({ repo, pr, kind, sha, at, ok, detail } = {}) {
    const head = String(sha || '').slice(0, 7);
    const when = at ? new Date(at) : null;
    const stamp = when && isFinite(when.getTime()) ? when.toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : '';
    const what = kind === ACTION.APPROVE ? 'Approved' : 'Not approved';
    const lines = [
        ok ? '<b>' + what + '</b>' : '<b>Could not be recorded</b>',
        esc(clip(repo, 60)) + ' #' + Number(pr),
    ];
    if (head) lines.push('Commit: <code>' + esc(head) + '</code>');
    if (stamp) lines.push(stamp);
    if (!ok && detail) lines.push('', esc(clip(detail, 160)));
    if (ok && kind === ACTION.APPROVE) {
        lines.push('', 'The Risk gate re-runs on the label. If anything guarded changes after '
            + 'this commit, approval is needed again.');
    }
    // No inline_keyboard: the decision is made.
    return { text: lines.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: [] } };
}

/** The short toast Telegram shows on the button itself. */
export function toastFor(kind, ok) {
    if (!ok) return 'Could not record that — nothing changed.';
    return kind === ACTION.APPROVE ? 'Approved.' : 'Left unapproved.';
}

/**
 * The single GitHub call an action is allowed to make.
 *
 * Returned as a description rather than performed, so the one thing that must
 * never drift — that this can add or remove exactly ONE label on exactly ONE
 * pull request, and touch nothing else — is a value a test can read.
 */
export function githubRequest({ owner, repo, pr, kind } = {}) {
    const n = Number(pr);
    if (!owner || !repo || !Number.isInteger(n) || n < 1) return null;
    if (kind !== ACTION.APPROVE && kind !== ACTION.REVOKE) return null;
    const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${n}/labels`;
    return kind === ACTION.APPROVE
        ? { method: 'POST', path: base, body: { labels: [APPROVAL_LABEL] } }
        : { method: 'DELETE', path: `${base}/${encodeURIComponent(APPROVAL_LABEL)}`, body: null };
}
