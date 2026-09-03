/* =============================================================================
 * api/telegram-approve.js — the Telegram webhook that carries an approval
 * -----------------------------------------------------------------------------
 * Thin ON PURPOSE. Every rule about who may act, what a button may say, and
 * which GitHub call an action is permitted to make lives in
 * wealthflow-approval-bot.mjs, where a test exercises the rules themselves
 * rather than a mock of them. This file does the three things a test cannot:
 * read the environment, talk to GitHub, and talk to Telegram.
 *
 * CONFIGURATION (Vercel project env; never in this repository, which is public)
 *
 *   TELEGRAM_BOT_TOKEN        from @BotFather
 *   TELEGRAM_WEBHOOK_SECRET   a long random string; the SAME value is passed to
 *                             setWebhook as `secret_token`, and Telegram then
 *                             sends it back on every delivery
 *   TELEGRAM_OWNER_ID         the owner's numeric Telegram user id — the only
 *                             account whose button presses are honoured
 *   APPROVAL_GITHUB_TOKEN     a token with `issues: write` on this repository
 *                             and nothing else it does not need
 *   APPROVAL_REPO             "owner/repo"
 *
 * WITH ANY OF THESE MISSING THE ENDPOINT REFUSES. There is no default that
 * allows, because the commonest way a gate like this fails open is an
 * environment variable that is simply absent in production.
 *
 * WHAT IT ANSWERS TO A STRANGER
 *
 * 401 and nothing else. Not which check failed, not whether the secret was
 * close, not whether that pull request exists. A refusal that explains itself is
 * a probe that succeeds.
 * ===========================================================================*/

import {
    ACTION, authorise, readPress, approvalMessage, outcomeMessage, toastFor, githubRequest,
} from '../wealthflow-approval-bot.mjs';
/* Every outbound call from a serverless endpoint carries a deadline — see
 * test/fetch_timeout_test.js. An upstream that stalls otherwise consumes the
 * whole maxDuration and the caller gets FUNCTION_INVOCATION_TIMEOUT with no
 * record of which upstream did it. Telegram and GitHub are both upstreams. */
import { fetchWithTimeout } from '../fetch-timeout.mjs';

export const config = { runtime: 'nodejs' };

const TG = 'https://api.telegram.org/bot';

async function telegram(token, method, payload) {
    const r = await fetchWithTimeout(TG + token + '/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    /* Never rethrow with the body attached: Telegram echoes the request, and the
     * request contains the bot token in the URL on some error shapes. */
    return r.ok;
}

async function github(token, repo, req) {
    const r = await fetchWithTimeout('https://api.github.com' + req.path, {
        method: req.method,
        headers: {
            Authorization: 'Bearer ' + token,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'wealthflow-approval-bot',
        },
        body: req.body ? JSON.stringify(req.body) : undefined,
    });
    /* Removing a label that is not there is a 404, and it is the state the owner
     * asked for. Treated as success so "Not yet" is idempotent. */
    if (req.method === 'DELETE' && r.status === 404) return { ok: true, status: 404 };
    return { ok: r.ok, status: r.status };
}

/** Read the JSON body whether or not the platform already parsed it. */
async function readBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    try {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const raw = Buffer.concat(chunks).toString('utf8');
        return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
}

export default async function handler(req, res) {
    const {
        TELEGRAM_BOT_TOKEN: BOT,
        TELEGRAM_WEBHOOK_SECRET: SECRET,
        TELEGRAM_OWNER_ID: OWNER,
        APPROVAL_GITHUB_TOKEN: GH,
        APPROVAL_REPO: REPO,
    } = process.env;

    const deny = (why) => {
        /* Logged for the owner, never sent. The status is the whole reply. */
        try { console.warn('[approval-bot] refused:', why); } catch (_) {}
        res.status(401).json({ ok: false });
    };

    const auth = authorise({
        method: req.method,
        secretHeader: req.headers && req.headers['x-telegram-bot-api-secret-token'],
        expectedSecret: SECRET,
        fromId: null,          // checked below, once the body has been read
        ownerId: OWNER,
    });
    /* The owner check needs the body, so it is the ONLY branch allowed through
     * here — everything else, including a missing secret, stops now. */
    if (!auth.ok && auth.reason !== 'not-the-owner') return deny(auth.reason);

    const update = await readBody(req);
    const press = readPress(update);
    if (!press.ok) return deny(press.reason);

    const full = authorise({
        method: req.method,
        secretHeader: req.headers && req.headers['x-telegram-bot-api-secret-token'],
        expectedSecret: SECRET,
        fromId: press.fromId,
        ownerId: OWNER,
    });
    if (!full.ok) return deny(full.reason);

    if (!GH || !REPO || !BOT) return deny('incomplete-configuration');
    const [owner, repo] = String(REPO).split('/');
    const request = githubRequest({ owner, repo, pr: press.action.pr, kind: press.action.kind });
    if (!request) return deny('unbuildable-request');

    let result = { ok: false, status: 0 };
    try { result = await github(GH, REPO, request); } catch (_) { result = { ok: false, status: 0 }; }

    /* The keyboard is removed either way. A message that still offers "Approve"
     * after the press is an invitation to press it again against a commit that
     * has since moved on — Telegram keeps old buttons live indefinitely. */
    /* press.action.sha comes from the callback data the button was built with,
     * so the confirmation names the commit the owner was actually looking at.
     * The first version of this file read a `sha` nothing ever set — a facility
     * wired to nothing, which is the defect this repository keeps producing. */
    const out = outcomeMessage({
        repo: REPO, pr: press.action.pr, kind: press.action.kind,
        sha: press.action.sha, at: Date.now(), ok: result.ok,
        detail: result.ok ? '' : 'GitHub replied ' + result.status,
    });

    await telegram(BOT, 'answerCallbackQuery', {
        callback_query_id: press.callbackId,
        text: toastFor(press.action.kind, result.ok),
    }).catch(() => false);

    if (press.chatId && press.messageId) {
        await telegram(BOT, 'editMessageText', {
            chat_id: press.chatId, message_id: press.messageId,
            text: out.text, parse_mode: out.parse_mode, reply_markup: out.reply_markup,
        }).catch(() => false);
    }

    /* 200 regardless of the GitHub outcome: a non-2xx here makes Telegram retry
     * the delivery, and a retried approval is a second write for a decision the
     * owner made once. The owner is told what happened in the message above. */
    res.status(200).json({ ok: true });
}

/** Exported for the test that proves the endpoint can only touch one label. */
export const _internals = { ACTION, approvalMessage, githubRequest };
