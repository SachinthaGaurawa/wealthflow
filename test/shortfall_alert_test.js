/* =============================================================================
 * test/shortfall_alert_test.js
 * -----------------------------------------------------------------------------
 * WHAT THIS FILE CAN AND CANNOT PROVE — READ THIS BEFORE TRUSTING IT
 *
 * The shortfall warning lives inside checkAndSendAIReminders() in index.html,
 * which needs a DOM, a Notification API, a service worker and a clock inside
 * 8am-9pm before it will do anything. None of that exists in vitest, so this
 * file does NOT execute the alert. It was verified by driving the real page in
 * Chromium with the clock advanced a day at a time: six simulated days, two
 * hourly checks each, twelve runs, ONE notification, key
 * `wf_notif_runway_2026-09-15`.
 *
 * That measurement is not repeatable here, so what follows is a structural
 * guard over the source: narrow, honest about being narrow, and aimed at the
 * one property a future edit is most likely to undo.
 *
 * THE PROPERTY
 *
 * The alert this replaced was keyed `wf_notif_lowbal_${curMonth}_${day}`.
 * checkAndSendAIReminders runs every hour, so that key produced ONE
 * NOTIFICATION PER DAY for as long as the condition held — twenty-one identical
 * "take action" messages over three weeks, naming no action. The new key
 * carries the RUNWAY DATE, so it fires once per distinct shortfall.
 *
 * A day-of-month back in that key is the regression that matters, and it is the
 * easy mistake to make while editing nearby.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/** The shortfall block, isolated so assertions cannot accidentally match
 *  the unrelated reminders that share this function. */
function shortfallBlock() {
    const start = HTML.indexOf('let shortfallHandled = false;');
    expect(start, 'the shortfall block was not found — retarget this test').toBeGreaterThan(-1);
    const end = HTML.indexOf('function scheduleAINotifications', start);
    return HTML.slice(start, end);
}

describe('the shortfall alert', () => {
    const block = shortfallBlock();

    it('keys its notification on the runway date', () => {
        expect(block).toMatch(/wf_notif_runway_\$\{s\.runwayDate\}/);
    });

    it('does NOT key it on the current day, which is what repeated daily', () => {
        const key = /`wf_notif_runway_[^`]*`/.exec(block);
        expect(key, 'no runway key found').not.toBe(null);
        expect(key[0]).not.toMatch(/\bday\b|getDate|curMonth/);
    });

    it('checks the key before sending and writes it after, in BOTH branches', () => {
        /* Either half missing turns "once per shortfall" back into "every hour".
         *
         * COUNTED, not merely matched. The engine branch and the fallback branch
         * contain the identical line, so `expect(block).toMatch(...)` passed
         * with the engine branch's check replaced by `if (true)` — the fallback's
         * copy satisfied the regex. An assertion that cannot tell two identical
         * lines apart is not testing either of them. */
        const guards = block.match(/if \(!localStorage\.getItem\(notifKey\)\)/g) || [];
        const writes = block.match(/_persistRaw\(notifKey, '1'\)/g) || [];
        expect(guards.length, 'one guard per branch').toBe(2);
        expect(writes.length, 'one write per branch').toBe(2);
    });

    it('guards the ENGINE branch specifically, not just the fallback', () => {
        // Scoped to the text before the fallback begins, so the fallback's copy
        // cannot stand in for it.
        const engineOnly = block.slice(0, block.indexOf('!shortfallHandled'));
        expect(engineOnly).toMatch(/if \(!localStorage\.getItem\(notifKey\)\)/);
        expect(engineOnly).toMatch(/_persistRaw\(notifKey, '1'\)/);
    });

    it('names the cause, because a warning without one is not actionable', () => {
        expect(block).toMatch(/runwayCauses/);
        expect(block).toMatch(/cause\.label/);
    });

    it('only runs when the engine is present, and survives it throwing', () => {
        expect(block).toMatch(/if \(window\.WFCashflow\)/);
        expect(block).toMatch(/catch \(e\)/);
    });

    it('keeps the old proxy as a fallback rather than deleting it', () => {
        // Removing the engine must never leave the user with NO warning at all.
        expect(block).toMatch(/!shortfallHandled/);
        expect(block).toMatch(/ctx\.monthlyLoanPayments \* 1\.5/);
        expect(block).toMatch(/wf_notif_lowbal_/);
    });

    it('sets shortfallHandled only AFTER the engine has actually answered', () => {
        /* If the flag were set before summarise() ran, a throw inside it would
         * suppress the fallback as well and the user would get no warning from
         * either path.
         *
         * The ordering has to be measured against the summarise CALL, not
         * against the `if (window.WFCashflow)` guard. Checking it sat between
         * the guard and the catch passed with the assignment hoisted above
         * summarise — which is exactly the bug. */
        const idxCall = block.indexOf('WFCashflow.summarise(');
        const idxSet = block.indexOf('shortfallHandled = true');
        expect(idxCall, 'summarise call not found').toBeGreaterThan(-1);
        expect(idxSet, 'shortfallHandled is set before the engine answers')
            .toBeGreaterThan(idxCall);
    });

    it('does not escape the notification body, and says why', () => {
        // Notification `body` is plain text. _wfEsc here would render a payee
        // as &amp; instead of &. Everywhere this data reaches the DOM it IS
        // escaped; this is the one deliberate exception and it is documented.
        expect(block).not.toMatch(/_wfEsc\(cause\.label\)/);
        expect(HTML).toMatch(/Notification `body` is plain text/);
    });
});
