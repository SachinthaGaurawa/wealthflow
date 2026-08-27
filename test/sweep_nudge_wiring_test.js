/* =============================================================================
 * test/sweep_nudge_wiring_test.js
 * -----------------------------------------------------------------------------
 * shouldNudge() is tested thoroughly in test/sweep_nudge_test.js, and that file
 * would keep passing if nothing ever called it. That is not a hypothetical
 * worry here: the entire reason this change exists is that WFSweeper has been
 * complete and correct for several releases while never reaching anybody,
 * because the only caller was a panel you had to open on purpose.
 *
 * So this file reads index.html and pins the wiring itself. It is the same
 * instrument that caught the notification-button defect in #146, applied before
 * the gap rather than after it.
 *
 * THE ONE THAT WOULD HURT MOST, AND IT IS AN ABSENCE
 *
 * Every other actionable banner passes a `confirm` payload, which produces a
 * lock-screen button reading "Yes — 127,000" and RECORDS that figure when
 * tapped. Correct for a loan instalment, which is a past fact. Catastrophic for
 * a sweep, which is a proposal: the money moves at a bank, by a person, and a
 * button that booked the transfer would file a movement that never happened.
 * The projection would then plan around cash still sitting in the current
 * account, and sweep-ledger's audit would be checking a promise about money
 * that never left.
 *
 * An absence cannot be seen by reading the diff later — a `confirm:` added to
 * this call site in six months would look exactly like the two above it, which
 * are correct. So the absence is asserted.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { NUDGE_RULES } from '../wealthflow-wealth-sweeper.js';

const html = await (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
})();

/* Located from the CALL, never from the icon. Searching for an emoji lands on
 * the first of several unrelated elements that happen to use it, and every
 * assertion then runs against the wrong span of the file — which is how the
 * first version of the #146 test produced four confident failures about code
 * that was already correct. */
function callSite(needle) {
    let from = 0;
    for (;;) {
        const call = html.indexOf('showActionableBanner({', from);
        if (call < 0) return '';
        const body = html.slice(call, call + 2200);
        if (body.includes(needle)) return body;
        from = call + 1;
    }
}

const sweepBanner = callSite("id: 'sweep_'") || callSite('Idle cash');

describe('the plan actually reaches the owner', () => {
    it('is called from the reminder sweep at all', () => {
        expect(html).toContain('checkSweepNudge();');
        expect(html).toContain('window.WFSweeper.shouldNudge(');
    });

    it('runs AFTER the income and loan reminders, never before them', () => {
        /* Those two are time-critical: a salary confirmation missed today cannot
         * be recovered from anything the app knows tomorrow. Idle cash can wait
         * a day. Ordering is the only thing that decides which is sacrificed if
         * the new code ever throws. */
        const incomeAt = html.indexOf("title: '💰 Income Day — '");
        const loanAt = html.indexOf("title: '🏦 Loan Installment — '");
        const nudgeAt = html.indexOf('checkSweepNudge();');
        expect(incomeAt).toBeGreaterThan(0);
        expect(loanAt).toBeGreaterThan(0);
        expect(nudgeAt, 'the sweep nudge runs before the payment reminders').toBeGreaterThan(loanAt);
        expect(nudgeAt).toBeGreaterThan(incomeAt);
    });

    it('is wrapped, so it cannot take the payment reminders down with it', () => {
        const at = html.indexOf('checkSweepNudge();');
        const around = html.slice(at - 200, at + 120);
        expect(around, 'an unwrapped call would strand the reminders above it on any throw')
            .toContain('try { checkSweepNudge(); }');
    });

    it('asks the same question every other projection asks', () => {
        /* Four call sites assembling their own options is this repository's most
         * repeated defect: one gets fixed, the others keep answering the old way,
         * and two screens disagree about the same money without either looking
         * wrong. _wfCashOpts also carries the legs of sweeps already recorded. */
        const at = html.indexOf('window.WFSweeper.shouldNudge(');
        const fn = html.slice(at - 900, at + 500);
        expect(fn).toContain('_wfCashOpts({');
        expect(fn, 'the nudge would ignore sweeps already recorded').toContain('WFSweepLedger.read(appData).sweeps');
    });
});

describe('the safety property, which is an absence', () => {
    it('found the sweep banner to check', () => {
        expect(sweepBanner, 'no sweep call site found — the rest of this block would pass vacuously')
            .toBeTruthy();
    });

    it('NEVER passes a confirm payload', () => {
        /* THE ONE THAT WOULD HURT MOST. A `confirm` here builds a lock-screen
         * button carrying an amount, and tapping it records that amount as
         * money that moved. No sweep has moved until a person moves it at a
         * bank. */
        expect(sweepBanner).not.toContain('confirm:');
    });

    it('and says out loud why, so the absence reads as a decision', () => {
        // An absence with no reason beside it is indistinguishable from an
        // oversight, and gets "fixed" by the next person to notice it.
        expect(sweepBanner).toMatch(/No `confirm`/);
    });

    it('offers to open the plan rather than to confirm anything', () => {
        expect(sweepBanner).toContain("primary: 'Review the plan'");
        expect(sweepBanner).toContain("showPage('targets')");
    });
});

describe('the body that reaches the lock screen', () => {
    it('is stripped of the banner markup', () => {
        /* An OS notification body is plain text; the platform renders no markup.
         * Every caller before this one passed `confirm` and got WFConfirm's
         * already-plain body, so the fallback branch was never taken and nobody
         * had seen what it did. The first caller without figures — this one —
         * put a literal "<b>" on the lock screen, which a browser showed and a
         * reading of the source did not. */
        expect(html).toContain('const plainBody = ');
        expect(html).toContain('body: built ? built.body : plainBody,');
    });

    it('strips it the same way the device mirror already does', () => {
        // Two expressions for "plain" in one function is a disagreement waiting
        // to happen; this is the one showActionableBanner already uses.
        const uses = html.match(/String\(message[^)]*\)[\s\S]{0,40}?\.replace\(\/<\[\^>\]\+>\/g, ''\)/g) || [];
        expect(uses.length, 'the two strip expressions have drifted apart').toBeGreaterThanOrEqual(2);
    });
});

describe('what happens when the notification comes back', () => {
    it('handles a sweep action above the legacy branch, and returns', () => {
        /* Below it, `no_<id>` re-queues the notification for 8pm tonight. For an
         * instalment that is right. For idle cash — an unchanging fact — it is
         * the daily repetition the cooldown exists to prevent. */
        /* The legacy branch is located by `const parts = id.split('_');`, which
         * appears exactly once. The obvious anchor — `action.startsWith('yes_')`
         * — appears TWICE, because the sweep branch tests the same prefix, and
         * using it finds the sweep branch's own line and compares it against
         * itself. That produced a green ordering assertion that proved nothing
         * on the first run of this file. */
        const sweepAt = html.indexOf("if (String(id || '').split('_')[0] === 'sweep') {");
        const legacyAt = html.indexOf("const parts = id.split('_');");
        expect(sweepAt, 'no sweep branch in the action handler').toBeGreaterThan(0);
        expect(legacyAt, 'the legacy branch anchor moved').toBeGreaterThan(0);
        expect(sweepAt, 'a sweep tap would be re-queued for tonight').toBeLessThan(legacyAt);
        expect(html.slice(sweepAt, legacyAt)).toContain('return;');
    });

    it('writes nothing to the ledger on either tap', () => {
        const sweepAt = html.indexOf("if (String(id || '').split('_')[0] === 'sweep') {");
        const branch = html.slice(sweepAt, html.indexOf("const parts = id.split('_');"));
        for (const writer of ['_silentConfirmLoan', '_silentConfirmIncome', 'wfSweepRecord', 'DB.set']) {
            expect(branch, `the sweep branch reached ${writer}`).not.toContain(writer);
        }
    });
});

describe('the cooldown is actually persisted', () => {
    it('records that it was shown, on showing', () => {
        expect(html).toContain('window.WFSweeper.nudgeShown(');
        expect(html).toContain('_WF_SWEEP_NUDGE_KEY');
    });

    it('reads that state back into the decision', () => {
        const at = html.indexOf('window.WFSweeper.shouldNudge(');
        expect(html.slice(at, at + 400)).toContain('state: _wfSweepNudgeState()');
    });

    it('keeps the thresholds in the module, not spelled out in the page', () => {
        /* A number copied into index.html is a second source of truth for the
         * one rule that decides how often the owner is interrupted. */
        for (const n of [NUDGE_RULES.COOLDOWN_DAYS, NUDGE_RULES.GROWTH_MULTIPLE, NUDGE_RULES.MIN_RESERVE_MULTIPLE]) {
            expect(html).not.toContain(`COOLDOWN_DAYS = ${n}`);
        }
        const at = html.indexOf('function checkSweepNudge()');
        const fn = html.slice(at, at + 3000);
        expect(fn).not.toMatch(/\b14\b\s*\*\s*24|GROWTH_MULTIPLE\s*=/);
    });
});
