/* =============================================================================
 * test/approval_bot_test.js — a gate is only as strong as the path around it
 * -----------------------------------------------------------------------------
 * The Risk gate holds every change touching a guarded path until the owner adds
 * the `human-approved` label. That gate stays exactly as it is. What this bot
 * changes is only WHERE the owner presses the button — a phone instead of a
 * laptop — and that means the security of the gate now depends on this path
 * being airtight.
 *
 * So these tests are not about features. Each one is a way the path could be
 * walked around, written down and closed:
 *
 *   · no secret configured        -> refuse (the commonest real-world fail-open
 *                                    is an env var missing in production)
 *   · wrong secret                -> refuse, in constant time
 *   · right secret, wrong person  -> refuse
 *   · a crafted callback payload  -> cannot name another label, another repo,
 *                                    another action, or a huge PR number
 *   · a pull-request title        -> is escaped; it is written by whoever opened
 *                                    the PR, and it lands in an HTML message the
 *                                    owner is deciding on
 *   · a pressed button            -> is removed, so it cannot be pressed again
 *                                    against a commit that has moved on
 *
 * And one product rule, because it is what makes the approval mean anything:
 * the message must name the commit. The Risk gate voids a label when a guarded
 * file changes after it was applied — that happened for real, three commits
 * after an approval — so an owner who cannot see WHICH commit they are
 * approving is being asked to sign a blank page.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import fc from 'fast-check';
import { runs } from './fuzz-config.js';
import {
    APPROVAL_LABEL, ACTION, REFUSE,
    encodeAction, parseAction, secretMatches, authorise, readPress,
    approvalMessage, outcomeMessage, toastFor, githubRequest, esc,
} from '../wealthflow-approval-bot.mjs';

const OK = { method: 'POST', secretHeader: 's3cret-value', expectedSecret: 's3cret-value',
             fromId: 12345, ownerId: '12345' };

describe('the module actually loaded', () => {
    it('exposes what the endpoint uses (guards against a vacuous pass)', () => {
        for (const f of [encodeAction, parseAction, secretMatches, authorise, readPress,
            approvalMessage, outcomeMessage, toastFor, githubRequest, esc]) {
            expect(typeof f).toBe('function');
        }
        expect(APPROVAL_LABEL).toBe('human-approved');
    });
});

describe('who may act', () => {
    it('the happy path is authorised', () => {
        expect(authorise(OK)).toEqual({ ok: true, reason: null });
    });

    it('AN UNCONFIGURED DEPLOYMENT APPROVES NOTHING', () => {
        // The commonest way a gate like this fails open.
        expect(authorise({ ...OK, expectedSecret: '' }).reason).toBe(REFUSE.NO_SECRET_CONFIGURED);
        expect(authorise({ ...OK, expectedSecret: undefined }).reason).toBe(REFUSE.NO_SECRET_CONFIGURED);
        expect(authorise({ ...OK, ownerId: '' }).reason).toBe(REFUSE.NO_OWNER_CONFIGURED);
        expect(authorise({}).ok).toBe(false);
    });

    it('a wrong or absent secret is refused', () => {
        expect(authorise({ ...OK, secretHeader: 'nope' }).reason).toBe(REFUSE.BAD_SECRET);
        expect(authorise({ ...OK, secretHeader: '' }).reason).toBe(REFUSE.BAD_SECRET);
        expect(authorise({ ...OK, secretHeader: undefined }).reason).toBe(REFUSE.BAD_SECRET);
        // a prefix of the real secret must not pass
        expect(authorise({ ...OK, secretHeader: 's3cret-valu' }).reason).toBe(REFUSE.BAD_SECRET);
    });

    it('the right secret with the wrong person is refused', () => {
        expect(authorise({ ...OK, fromId: 999 }).reason).toBe(REFUSE.NOT_OWNER);
        expect(authorise({ ...OK, fromId: null }).reason).toBe(REFUSE.NOT_OWNER);
    });

    it('AN ID IS AN IDENTIFIER, NOT A QUANTITY', () => {
        /* Some Telegram ids exceed what a double holds exactly, and
         * 12345678901234567 == 12345678901234568 is TRUE in JavaScript. Compared
         * numerically, two different accounts would be the same owner. */
        expect(12345678901234567 === 12345678901234568).toBe(true);   // the hazard
        expect(authorise({ ...OK, ownerId: '12345678901234567', fromId: '12345678901234568' }).reason)
            .toBe(REFUSE.NOT_OWNER);
        expect(authorise({ ...OK, ownerId: '12345678901234567', fromId: '12345678901234567' }).ok).toBe(true);
    });

    it('only POST', () => {
        for (const m of ['GET', 'PUT', 'DELETE', 'HEAD', '', undefined]) {
            expect(authorise({ ...OK, method: m }).reason).toBe(REFUSE.NOT_POST);
        }
    });

    it('secretMatches does not short-circuit on the first differing byte', () => {
        const src = secretMatches.toString();
        expect(src).toContain('^');          // xor-accumulate
        expect(src).not.toMatch(/return\s+a\s*===\s*b/);
        expect(secretMatches('', '')).toBe(false);       // empty is never a match
        expect(secretMatches('abc', 'abc')).toBe(true);
        expect(secretMatches('abc', 'abd')).toBe(false);
        expect(secretMatches('abc', 'abcd')).toBe(false);
    });
});

describe('what a button may say', () => {
    it('round-trips the two verbs and a number', () => {
        for (const k of [ACTION.APPROVE, ACTION.REVOKE]) {
            expect(parseAction(encodeAction(k, 183))).toEqual({ kind: k, pr: 183, sha: '' });
            expect(parseAction(encodeAction(k, 183, 'BD96F3801659104f')))
                .toEqual({ kind: k, pr: 183, sha: 'bd96f38' });
        }
    });

    it('refuses anything that is not one of them', () => {
        for (const bad of [
            'merge:1', 'approve:0', 'approve:-1', 'approve:01', 'approve:', 'approve',
            'approve:1x', ' approve:1', 'approve:1 ', 'approve:1\n', 'APPROVE:1',
            'approve:1;rm -rf', 'approve:1000000', 'approve:99999999',
            'approve:1:BD96F38', 'approve:1:zzzzzzz', 'approve:1:bd96f3', 'approve:1:bd96f380',
            'approve:1:', 'approve:1:bd96f38:extra',
            '', null, undefined, {}, [], 0, 'revoke:1a',
        ]) {
            expect(parseAction(bad), String(bad) + ' was accepted').toBe(null);
        }
    });

    it('a payload can never be built for another verb or an impossible number', () => {
        for (const k of ['merge', 'close', 'label', '', null, 'Approve']) {
            expect(encodeAction(k, 1)).toBe(null);
        }
        for (const n of [0, -1, 1.5, NaN, Infinity, 1e9, '12; drop', null]) {
            expect(encodeAction(ACTION.APPROVE, n)).toBe(null);
        }
    });

    it('stays inside Telegram\u2019s 64-byte callback limit', () => {
        expect(Buffer.byteLength(encodeAction(ACTION.APPROVE, 999999, 'abcdef0'))).toBeLessThanOrEqual(64);
    });

    it('never throws or accepts on arbitrary input', () => {
        fc.assert(fc.property(fc.string({ maxLength: 90 }), (s) => {
            const got = parseAction(s);
            if (got === null) return true;
            // anything it DOES accept must be exactly what encodeAction produces
            return encodeAction(got.kind, got.pr, got.sha) === s;
        }), { numRuns: runs(200) });
    });
});

describe('the one GitHub call an action is allowed to make', () => {
    it('adds exactly one label to exactly one pull request', () => {
        expect(githubRequest({ owner: 'o', repo: 'r', pr: 183, kind: ACTION.APPROVE }))
            .toEqual({ method: 'POST', path: '/repos/o/r/issues/183/labels', body: { labels: ['human-approved'] } });
    });

    it('removes exactly that label, and nothing else', () => {
        expect(githubRequest({ owner: 'o', repo: 'r', pr: 183, kind: ACTION.REVOKE }))
            .toEqual({ method: 'DELETE', path: '/repos/o/r/issues/183/labels/human-approved', body: null });
    });

    it('CANNOT BE STEERED SOMEWHERE ELSE by anything on the wire', () => {
        /* The only caller-supplied value is a bounded integer from parseAction.
         * Owner and repo come from the environment. Even so, they are encoded —
         * a path built by concatenation is how one repository's approval writes
         * into another. */
        const r = githubRequest({ owner: '../../evil', repo: 'x/y', pr: 1, kind: ACTION.APPROVE });
        expect(r.path).toBe('/repos/..%2F..%2Fevil/x%2Fy/issues/1/labels');
        expect(r.path).not.toContain('../');
        expect(r.body.labels).toEqual(['human-approved']);
    });

    it('builds nothing at all from an unusable request', () => {
        for (const bad of [
            {}, { owner: 'o', repo: 'r', pr: 0, kind: ACTION.APPROVE },
            { owner: '', repo: 'r', pr: 1, kind: ACTION.APPROVE },
            { owner: 'o', repo: 'r', pr: 1, kind: 'merge' },
            { owner: 'o', repo: 'r', pr: '1; DROP', kind: ACTION.APPROVE },
        ]) expect(githubRequest(bad)).toBe(null);
    });
});

describe('the message the owner decides on', () => {
    const msg = () => approvalMessage({
        repo: 'SachinthaGaurawa/wealthflow', pr: 183, title: 'Fix the thing',
        sha: 'bd96f3801659104fa552797d857231929e1a714e',
        paths: ['index.html', '.github/workflows/wealthflow-ci.yml'],
        url: 'https://github.com/x/y/pull/183',
    });

    it('THE BUTTON ITSELF carries the commit, so the press is attributable', () => {
        /* Not only the message text. A confirmation that cannot say what was
         * approved is hearsay — and the endpoint reading `press.action.sha`
         * when nothing put one there is a facility wired to nothing, which is
         * exactly how this happened the first time it was written. */
        const kb = msg().reply_markup.inline_keyboard[0];
        for (const b of kb.filter((x) => x.callback_data)) {
            expect(parseAction(b.callback_data).sha).toBe('bd96f38');
        }
    });

    it('NAMES THE COMMIT, because the gate approves a commit and not a PR', () => {
        /* This happened for real: the label was applied, three commits then
         * touched index.html, and the gate correctly voided it. An owner who
         * cannot see which commit they are approving is signing a blank page. */
        expect(msg().text).toContain('bd96f38');
        expect(msg().text).toMatch(/voids it|given again/i);
    });

    it('says what approving actually does', () => {
        expect(msg().text).toContain('human-approved');
        expect(msg().text).toContain('index.html');
    });

    it('offers exactly two decisions', () => {
        const kb = msg().reply_markup.inline_keyboard[0];
        const data = kb.filter((b) => b.callback_data).map((b) => b.callback_data);
        expect(data).toEqual(['approve:183:bd96f38', 'revoke:183:bd96f38']);
    });

    it('A PULL REQUEST TITLE IS WRITTEN BY WHOEVER OPENED IT', () => {
        // It lands in an HTML message. Unescaped, a title rewrites the very
        // question the owner is answering.
        const m = approvalMessage({
            repo: 'o/r', pr: 1, sha: 'abc1234',
            title: '</b>Approved already<b> <a href="http://evil">click</a>',
        });
        expect(m.text).not.toContain('<a href');
        expect(m.text).toContain('&lt;/b&gt;');
        expect(esc('<&>')).toBe('&lt;&amp;&gt;');
    });

    it('refuses to build a message it cannot make buttons for', () => {
        expect(approvalMessage({ repo: 'o/r', pr: 0 })).toBe(null);
        expect(approvalMessage({ repo: 'o/r', pr: 'x' })).toBe(null);
        expect(approvalMessage({})).toBe(null);
    });

    it('THE PRESSED BUTTON IS REMOVED, not merely re-labelled', () => {
        /* Telegram keeps old buttons live indefinitely. A message still offering
         * "Approve" after the press invites a second approval against a commit
         * that has since moved on. */
        const out = outcomeMessage({ repo: 'o/r', pr: 183, kind: ACTION.APPROVE,
            sha: 'bd96f38', at: Date.parse('2026-09-03T07:08:34Z'), ok: true });
        expect(out.reply_markup.inline_keyboard).toEqual([]);
        expect(out.text).toContain('Approved');
        expect(out.text).toContain('bd96f38');
        expect(out.text).toContain('2026-09-03 07:08 UTC');
    });

    it('a failure says so rather than claiming an approval that did not land', () => {
        const out = outcomeMessage({ repo: 'o/r', pr: 1, kind: ACTION.APPROVE, ok: false,
            detail: 'GitHub replied 403' });
        expect(out.text).toContain('Could not be recorded');
        expect(out.text).toContain('403');
        expect(toastFor(ACTION.APPROVE, false)).toMatch(/nothing changed/i);
    });
});

describe('reading a press out of an update', () => {
    it('takes the action, the presser and the message to edit', () => {
        const p = readPress({ callback_query: { id: 'cb1', data: 'approve:7',
            from: { id: 42 }, message: { message_id: 9, chat: { id: 5 } } } });
        expect(p).toMatchObject({ ok: true, fromId: 42, callbackId: 'cb1', chatId: 5, messageId: 9 });
        expect(p.action).toEqual({ kind: 'approve', pr: 7, sha: '' });
    });

    it('anything that is not a button press is refused', () => {
        expect(readPress({}).reason).toBe(REFUSE.NO_CALLBACK);
        expect(readPress({ message: { text: 'hello' } }).reason).toBe(REFUSE.NO_CALLBACK);
        expect(readPress(null).reason).toBe(REFUSE.NO_CALLBACK);
        expect(readPress({ callback_query: { data: 'merge:1' } }).reason).toBe(REFUSE.BAD_ACTION);
    });

    it('never throws, whatever the update contains', () => {
        fc.assert(fc.property(fc.anything(), (u) => {
            expect(() => readPress(u)).not.toThrow();
        }), { numRuns: runs(120) });
    });
});

describe('the endpoint keeps its rules in the module, and its secrets out of the repo', () => {
    const api = fs.readFileSync('api/telegram-approve.js', 'utf8');

    it('imports the rules rather than restating them', () => {
        expect(api).toContain("from '../wealthflow-approval-bot.mjs'");
        expect(api).toContain('authorise(');
        expect(api).toContain('githubRequest(');
        // it must not build a label or a path of its own
        expect(api).not.toMatch(/['"]human-approved['"]/);
        expect(api).not.toMatch(/\/repos\/\$\{/);
    });

    it('NO SECRET IS IN THIS REPOSITORY — it is public', () => {
        for (const name of ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET',
            'TELEGRAM_OWNER_ID', 'APPROVAL_GITHUB_TOKEN', 'APPROVAL_REPO']) {
            expect(api).toContain(name);                       // named
            expect(api).toMatch(new RegExp(name + '(?![^\\n]*=\\s*[\'"][^\'"]{6,})'));  // never assigned a literal
        }
        expect(api).toContain('process.env');
    });

    it('answers a stranger with a status and nothing else', () => {
        /* A refusal that explains itself is a probe that succeeds. */
        expect(api).toContain('res.status(401).json({ ok: false })');
        const denies = api.match(/res\.status\(401\)[^\n]*/g) || [];
        for (const d of denies) expect(d).not.toContain('reason');
    });

    it('returns 200 even when GitHub refuses, so Telegram does not retry a decision', () => {
        expect(api).toContain('res.status(200).json({ ok: true })');
        expect(api).toMatch(/Telegram retry|retried approval/i);
    });

    it('checks the secret before it parses anything', () => {
        const authAt = api.indexOf('authorise({');
        const bodyAt = api.indexOf('await readBody(');
        expect(authAt).toBeGreaterThan(-1);
        expect(bodyAt).toBeGreaterThan(-1);
        expect(authAt).toBeLessThan(bodyAt);
    });
});

describe('the other half: something actually sends the message', () => {
    /* A receiver with nobody talking to it is this repository's signature
     * defect, so the notifier and the webhook arrived together — and this block
     * is what stops one of them being deleted while the other looks fine. */
    const notify = fs.readFileSync('autonomy/approval-notify.mjs', 'utf8');
    const ci = fs.readFileSync('.github/workflows/wealthflow-ci.yml', 'utf8');

    it('the sender builds its message with the SAME module the webhook parses', () => {
        // Otherwise the button drawn and the button accepted can describe
        // different things, and nothing would ever say so.
        expect(notify).toContain("from '../wealthflow-approval-bot.mjs'");
        expect(notify).toContain('approvalMessage(');
    });

    it('THE RISK GATE CALLS IT — on failure, which is when the owner is needed', () => {
        expect(ci).toContain('node autonomy/approval-notify.mjs');
        const at = ci.indexOf('Offer the approval on Telegram');
        expect(at).toBeGreaterThan(-1);
        const step = ci.slice(at, at + 1200);
        expect(step).toContain('failure()');
        // and it carries the commit, or the message cannot name what it approves
        expect(step).toContain('PR_HEAD_SHA: ${{ github.event.pull_request.head.sha }}');
        expect(step).toContain('PR_NUMBER: ${{ github.event.pull_request.number }}');
    });

    it('IT CANNOT TURN THE GATE GREEN, or change its result at all', () => {
        const at = ci.indexOf('Offer the approval on Telegram');
        const step = ci.slice(at, at + 1200);
        expect(step).toContain('continue-on-error: true');
        // it runs a script; it does not write an output, a status or a label
        expect(step).not.toMatch(/GITHUB_OUTPUT|gh api|labels/);
    });

    it('an unconfigured repository sends nothing and does not fail', async () => {
        const { notify: run, shouldSend, inputsFrom } = await import('../autonomy/approval-notify.mjs');
        expect(shouldSend(inputsFrom({})).send).toBe(false);
        const r = await run({}, () => { throw new Error('must not be called'); });
        expect(r).toEqual({ sent: false, reason: 'no bot configured' });
    });

    it('refuses to send half a message', async () => {
        const { shouldSend, inputsFrom } = await import('../autonomy/approval-notify.mjs');
        const base = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1', APPROVAL_REPO: 'o/r', PR_NUMBER: '5' };
        expect(shouldSend(inputsFrom(base)).send).toBe(true);
        expect(shouldSend(inputsFrom({ ...base, PR_NUMBER: '0' })).send).toBe(false);
        expect(shouldSend(inputsFrom({ ...base, PR_NUMBER: 'abc' })).send).toBe(false);
        expect(shouldSend(inputsFrom({ ...base, APPROVAL_REPO: '', GITHUB_REPOSITORY: '' })).send).toBe(false);
    });

    it('sends the buttons the webhook will accept, against the right commit', async () => {
        const { buildPayload, inputsFrom } = await import('../autonomy/approval-notify.mjs');
        const p = buildPayload(inputsFrom({
            TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '42', APPROVAL_REPO: 'o/r',
            PR_NUMBER: '183', PR_TITLE: 'A change', PR_HEAD_SHA: 'bd96f3801659104f',
            GUARDED_PATHS: 'index.html\n.github/workflows/wealthflow-ci.yml\n',
        }));
        expect(p.chat_id).toBe('42');
        const data = p.reply_markup.inline_keyboard[0]
            .filter((b) => b.callback_data).map((b) => b.callback_data);
        expect(data).toEqual(['approve:183:bd96f38', 'revoke:183:bd96f38']);
        for (const d of data) expect(parseAction(d)).not.toBe(null);   // the webhook will take them
        expect(p.text).toContain('index.html');
    });

    it('a dead Telegram is reported, never thrown', async () => {
        const { notify: run } = await import('../autonomy/approval-notify.mjs');
        const env = { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_OWNER_ID: '1',
            APPROVAL_REPO: 'o/r', PR_NUMBER: '1', PR_HEAD_SHA: 'abcdef0' };
        await expect(run(env, async () => { throw new Error('ECONNREFUSED'); }))
            .resolves.toEqual({ sent: false, reason: 'telegram unreachable' });
        await expect(run(env, async () => ({ ok: false, status: 429 })))
            .resolves.toEqual({ sent: false, reason: 'telegram replied 429' });
        await expect(run(env, async () => ({ ok: true, status: 200 })))
            .resolves.toEqual({ sent: true, reason: '' });
    });

    it('never puts the bot token in an error it returns', async () => {
        const { notify: run } = await import('../autonomy/approval-notify.mjs');
        const r = await run({ TELEGRAM_BOT_TOKEN: 'SECRET-TOKEN-VALUE', TELEGRAM_OWNER_ID: '1',
            APPROVAL_REPO: 'o/r', PR_NUMBER: '1' }, async () => ({ ok: false, status: 401 }));
        expect(JSON.stringify(r)).not.toContain('SECRET-TOKEN-VALUE');
    });
});
