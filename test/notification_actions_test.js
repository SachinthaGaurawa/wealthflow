/* =============================================================================
 * test/notification_actions_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-confirm.js proves that a notification it BUILDS carries a button
 * whose label equals the amount it writes. That test is real and it passes, and
 * for one release it protected nothing, because index.html never called it —
 * `_showOSNotification` hand-built `yes_<id>` / `no_<id>` labelled "Yes" while
 * the handler wrote `l.monthly`.
 *
 * A unit test cannot see that gap. It tests the module in isolation, and the
 * module was never the problem. So this file reads index.html itself and pins
 * the wiring: that the builder delegates, that both callers hand it the
 * figures, and — the one that matters — that the amount put on the button is
 * the SAME EXPRESSION as the amount printed in the question.
 *
 * WHY EXPRESSION-LEVEL AND NOT VALUE-LEVEL
 *
 * Asserting both are "correct" is what the previous arrangement would have
 * passed. `fmt(src.monthly)` in the message and `amount: src.monthly` on the
 * button are the same number BECAUSE they are the same source. Someone editing
 * one to `src.expected` and not the other reintroduces exactly the original
 * defect — a question quoting one figure and a button recording another — and
 * only a check on the expressions catches it.
 *
 * WHAT THIS CANNOT DO
 *
 * Render a notification. Actions on a Notification need a real service worker
 * registration and a platform that supports them, and neither exists here. The
 * page is also driven in Chromium separately, which proves the modules resolve
 * and the builder runs; what this file adds is the part a browser cannot show
 * you, which is that two numbers in different places have one origin.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { ACTION_ID, ANSWER } from '../wealthflow-confirm.js';

const html = await (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
})();

/* The text of one showActionableBanner({...}) call, found by the icon it uses.
 *
 * Located from the CALL, not from the icon: searching for `icon: '💰'` on its
 * own lands on the first of several unrelated UI elements that happen to use
 * the same emoji, and every assertion then runs against the wrong 1,800
 * characters — which is how the first version of this file produced four
 * confident failures about code that was already correct. */
function callSite(icon) {
    let from = 0;
    for (;;) {
        const call = html.indexOf('showActionableBanner({', from);
        if (call < 0) return '';
        const body = html.slice(call, call + 2200);
        if (body.includes(`icon: '${icon}'`)) return body;
        from = call + 1;
    }
}

describe('the lock-screen buttons are built by the module that owns them', () => {
    it('delegates to WFConfirm instead of hand-building actions', () => {
        expect(html, 'the builder still writes its own actions')
            .toContain('window.WFConfirm.notificationFor(confirm)');
    });

    it('keeps the two-button shape only for prompts that have no figures', () => {
        /* A caller with nothing to offer must not grow a fake amount. The old
         * shape survives as the else-branch, guarded on `built` being null. */
        expect(html).toContain("actions: built ? built.actions : [");
        expect(html).toContain("{ action: 'yes_' + id, title: '✅ ' + primary },");
    });

    it('takes the title and body from the built notification too', () => {
        // Otherwise the question could quote one figure and the button another.
        expect(html).toContain('built ? built.title : title');
        expect(html).toContain('built ? built.body : message');
    });
});

describe('the figure on the button has the same origin as the figure in the question', () => {
    it.each([
        ['income', '💰', 'src.monthly', "kind: 'income'"],
        ['a loan', '🏦', 'l.monthly', "kind: 'loan'"],
    ])('for %s', (_why, icon, amountExpr, kind) => {
        /* THE TEST THIS FILE EXISTS FOR. Both readings must come from the same
         * expression — not merely be equal today. */
        const site = callSite(icon);
        expect(site, `no ${icon} call site found`).toBeTruthy();
        expect(site, 'the caller stopped handing the figures over').toContain(kind);
        expect(site).toContain(`amount: ${amountExpr}`);
        expect(site, 'the message quotes a different expression than the button records')
            .toContain(`fmt(${amountExpr})`);
    });

    it.each([
        ['income', '💰', 'src.id', 'curMonthStr'],
        ['a loan', '🏦', 'l.id', 'curMonthStr'],
    ])('identifies which item and which month, for %s', (_why, icon, idExpr, monthExpr) => {
        const site = callSite(icon);
        expect(site).toContain(`id: ${idExpr}`);
        expect(site).toContain(`month: ${monthExpr}`);
    });

    it('passes the payload on to the OS notification rather than dropping it', () => {
        expect(html).toContain('_showOSNotification({ id, title, message, primary, secondary, confirm });');
    });
});

describe('what happens when each action comes back', () => {
    it('opens the app for "Different amount", and only for that one', () => {
        /* The amount is precisely what is unknown there, so the app must ask.
         * The action id is read from the module, so renaming it there cannot
         * silently orphan this branch. */
        expect(ACTION_ID[ANSWER.DIFFERENT]).toBe('yes_different');
        expect(html).toContain('window.WFConfirm.ACTION_ID[window.WFConfirm.ANSWER.DIFFERENT]');
        const at = html.indexOf('window.WFConfirm.ACTION_ID[window.WFConfirm.ANSWER.DIFFERENT]');
        const branch = html.slice(at, at + 700);
        expect(branch).toContain('toggleLoanInstallment');
        expect(branch).toContain('confirmIncomeReceived');
    });

    it('sends a recognised answer to the drain, never to the legacy writer', () => {
        /* The legacy branch writes l.monthly. A new-style action reaching it
         * would rebuild the exact defect this change removes, so the guard sits
         * ABOVE it and returns. */
        const drainAt = html.indexOf("_drainAnswerOutbox('page-action')");
        const legacyAt = html.indexOf("if (action.startsWith('yes_')) {");
        expect(drainAt, 'the drain guard is missing').toBeGreaterThan(0);
        expect(legacyAt).toBeGreaterThan(0);
        expect(drainAt, 'a new-style action would fall through to the scheduled-amount write')
            .toBeLessThan(legacyAt);
    });

    it('keeps the legacy branch, because old notifications outlive the deploy', () => {
        /* A notification created before this change can still be sitting on a
         * lock screen with `yes_<id>` actions. Deleting this would make those
         * taps do nothing. It is the tail of the previous version, not dead. */
        expect(html).toContain("if (action.startsWith('yes_')) {");
        expect(html).toContain('_silentConfirmLoan');
        expect(html).toContain('_silentConfirmIncome');
    });

    it('still drains on boot and on a worker message', () => {
        expect(html).toContain("_drainAnswerOutbox('boot')");
        expect(html).toContain("_drainAnswerOutbox('sw-message')");
    });
});
