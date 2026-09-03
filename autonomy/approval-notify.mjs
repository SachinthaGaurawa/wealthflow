/* =============================================================================
 * autonomy/approval-notify.mjs — tell the owner a pull request is waiting
 * -----------------------------------------------------------------------------
 * The other half of api/telegram-approve.js. That file receives a button press;
 * this one sends the message the button is on. A receiver with nobody talking to
 * it is the defect this repository keeps producing, so the two arrived together.
 *
 * Run from the Risk gate the moment it decides a change needs approval, with the
 * pull request number, its head SHA and the guarded files in the diff. It builds
 * the message through wealthflow-approval-bot.mjs — the same module the webhook
 * parses the press with, so the button it draws and the button it accepts cannot
 * describe different things.
 *
 * SILENT AND SUCCESSFUL WHEN UNCONFIGURED. A repository without a bot token has
 * not opted in, and a CI step that fails because an optional notifier is not set
 * up would make the gate itself look broken. It says so on stdout and exits 0.
 *
 * NEVER FAILS THE BUILD. Telegram being down does not change whether a change is
 * safe to merge; the gate has already decided that, and its own error message is
 * what blocks the merge. This only makes the decision reachable from a phone.
 * ===========================================================================*/

import { approvalMessage } from '../wealthflow-approval-bot.mjs';

/** What the runner tells us, normalised. Missing pieces are absent, not faked. */
export function inputsFrom(env = {}) {
    const pr = Number(env.PR_NUMBER);
    return {
        token: env.TELEGRAM_BOT_TOKEN || '',
        chatId: env.TELEGRAM_OWNER_ID || '',
        repo: env.APPROVAL_REPO || env.GITHUB_REPOSITORY || '',
        pr: Number.isInteger(pr) && pr > 0 ? pr : 0,
        title: env.PR_TITLE || '',
        sha: env.PR_HEAD_SHA || '',
        /* Newline-separated, because that is how a shell hands over a file list
         * and a path may legitimately contain a comma. */
        paths: String(env.GUARDED_PATHS || '').split('\n').map((s) => s.trim()).filter(Boolean),
        url: env.PR_URL || '',
    };
}

/** Configured, and with enough to say something true. */
export function shouldSend(i) {
    if (!i.token || !i.chatId) return { send: false, why: 'no bot configured' };
    if (!i.pr) return { send: false, why: 'no pull request number' };
    if (!i.repo) return { send: false, why: 'no repository' };
    return { send: true, why: '' };
}

export function buildPayload(i) {
    const msg = approvalMessage({
        repo: i.repo, pr: i.pr, title: i.title, sha: i.sha, paths: i.paths, url: i.url,
    });
    if (!msg) return null;
    return {
        chat_id: i.chatId,
        text: msg.text,
        parse_mode: msg.parse_mode,
        reply_markup: msg.reply_markup,
        disable_web_page_preview: true,
    };
}

export async function notify(env = process.env, fetchImpl = fetch) {
    const i = inputsFrom(env);
    const gate = shouldSend(i);
    if (!gate.send) return { sent: false, reason: gate.why };

    const payload = buildPayload(i);
    if (!payload) return { sent: false, reason: 'message could not be built' };

    try {
        const r = await fetchImpl('https://api.telegram.org/bot' + i.token + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
        });
        /* The status only. Telegram's error bodies echo the request, and the
         * request URL carries the bot token. */
        return r.ok ? { sent: true, reason: '' } : { sent: false, reason: 'telegram replied ' + r.status };
    } catch (_) {
        return { sent: false, reason: 'telegram unreachable' };
    }
}

/* Run directly from the workflow. Exit 0 whatever happens — see the header. */
if (process.argv[1] && process.argv[1].endsWith('approval-notify.mjs')) {
    const out = await notify();
    console.log(out.sent ? 'approval request sent' : 'not sent: ' + out.reason);
    process.exit(0);
}
