/** Browser regression for statement cards and sender settings. No real account,
 * mailbox, or bank credentials are used. Run from the repository root:
 * node test/e2e/statement-responsive.mjs
 * WF_RESPONSIVE_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-responsive).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';

const widths = [320, 360, 390, 520, 768, 1024, 1440, 1920, 3840];
const artifacts = process.env.WF_RESPONSIVE_ARTIFACTS || '/tmp/wealthflow-responsive';
const longAddress = 'monthly.creditcard.smart.statement.notifications@statements.example-bank.invalid';
const senderFixture = {
    ok: true,
    approved: [{ id: longAddress, name: 'Nations Trust Bank American Express Statement Service' },
        { id: 'legacy-statement-domain.example.invalid', name: 'Inactive legacy domain approval with explanatory note' }],
    pending: [{ id: 'statements@second-bank.invalid', name: 'Second Bank Monthly Statement Service',
        lastSubject: 'Your September credit card statement is available for secure review', seenCount: 12 }],
    blocked: [{ id: 'receipts@unwanted.invalid', name: 'Unwanted receipts and promotional notifications' }],
    knownBanks: [],
    legacyApproved: [],
};

function measureLayout({ sender, mobile }) {
    const root = sender ? document.querySelector('#_sl_body').closest('.md') : document.querySelector('#wfMailSync');
    const shown = el => !!el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
    const rect = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
    const issue = [];
    if (document.documentElement.scrollWidth > innerWidth + 1) issue.push(`page horizontal overflow ${document.documentElement.scrollWidth}/${innerWidth}`);
    if (root.scrollWidth > root.clientWidth + 1) issue.push(`view horizontal overflow ${root.scrollWidth}/${root.clientWidth}`);
    const textNodes = sender
        ? [...root.querySelectorAll('.wf-sender-id, .wf-sender-find-txt, .wf-hunt-bank')]
        : [...root.querySelectorAll('.card-hdr-main, .wf-sync-item-main')];
    for (const el of textNodes.filter(shown)) {
        const r = rect(el);
        if (r.width < 120) issue.push(`text crushed to ${r.width.toFixed(1)}px: ${el.textContent.trim().slice(0, 55)}`);
        // A paragraph must never intersect an action, including wrapping rows.
        const row = el.closest('.wf-sender-row, .wf-sender-find, .wf-hunt-row, .card-hdr-row, .wf-sync-item');
        for (const button of row ? [...row.querySelectorAll('button')].filter(shown) : []) {
            const b = rect(button);
            if (Math.min(r.right, b.right) - Math.max(r.x, b.x) > 1 && Math.min(r.bottom, b.bottom) - Math.max(r.y, b.y) > 1)
                issue.push(`text/action overlap: ${button.textContent.trim()}`);
        }
    }
    if (mobile) for (const el of [...root.querySelectorAll('button, input, select')].filter(shown)) {
        const r = rect(el);
        if (r.width < 43.5 || r.height < 43.5) issue.push(`small touch target ${r.width.toFixed(1)}x${r.height.toFixed(1)}: ${el.id || el.textContent.trim()}`);
    }
    return { issue, textWidths: textNodes.filter(shown).map(el => +rect(el).width.toFixed(1)) };
}

const app = await bootApp();
const results = [];
const failures = [];
try {
    assert.ok(await app.page.locator('#app').isVisible(), 'onboarding must reach the real application');
    await app.page.route('**/api/**', route => {
        const url = route.request().url();
        const body = url.includes('senders=1') ? senderFixture : { ok: true, connected: true, senderCount: 1, watching: true, configured: false };
        return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await app.page.evaluate(({ longAddress }) => {
        showPage('dashboard');
        _mailWatch = { watching: true };
        _mailStatus = { senderCount: 1 };
        _mailSyncState = { stage: 'idle', connected: true, decided: true, lastRun: Date.now(), filed: 2, locked: 0, sweeping: false, items: [
            { bank: 'Nations Trust Bank American Express', filename: 'eStatement_long_account_identifier_2026SEP.html',
                note: 'Statement received and held safely while the secure parser checks every transaction and its category.',
                from: longAddress, known: false, verdict: 'unknown', stage: 'waiting' },
            { bank: 'Second Bank', filename: 'monthly-credit-card-statement.pdf', note: 'Processing complete. Transactions are up to date.', known: true, stage: 'filed' },
        ] };
        renderMailSync();
    }, { longAddress });
    const cdp = await app.page.context().newCDPSession(app.page);
    for (const width of widths) {
        const mobile = width <= 768;
        await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: mobile, maxTouchPoints: mobile ? 5 : 1 });
        await app.page.setViewportSize({ width, height: width < 768 ? 900 : 1100 });
        await app.page.waitForTimeout(150);
        if (mobile) assert.ok(await app.page.evaluate(() => matchMedia('(pointer: coarse)').matches), 'mobile cases must simulate a coarse pointer');
        const card = await app.page.evaluate(measureLayout, { sender: false, mobile });
        let nestedCard = null;
        if (width >= 1024) {
            await app.page.evaluate(() => { document.querySelector('#wfMailSync').style.maxWidth = '320px'; });
            nestedCard = await app.page.evaluate(measureLayout, { sender: false, mobile: false });
            await app.page.evaluate(() => { document.querySelector('#wfMailSync').style.maxWidth = ''; });
        }
        await app.page.locator('#_ms_senders').click();
        await app.page.waitForFunction(() => document.querySelector('#_sl_body .wf-sender-row'));
        await app.page.waitForTimeout(300);
        const senders = await app.page.evaluate(measureLayout, { sender: true, mobile });
        results.push({ width, card, nestedCard, senders });
        if (nestedCard) failures.push(...nestedCard.issue.map(message => `${width}px narrow desktop card: ${message}`));
        failures.push(...card.issue.map(message => `${width}px card: ${message}`), ...senders.issue.map(message => `${width}px senders: ${message}`));
        if ([320, 768].includes(width)) {
            await fs.mkdir(artifacts, { recursive: true });
            await app.page.screenshot({ path: path.join(artifacts, `senders-${width}.png`), fullPage: false });
        }
        await app.page.locator('#_sl_x').click();
        await app.page.waitForFunction(() => !document.querySelector('#_sl_body'));
        if ([320, 768].includes(width)) {
            await app.page.locator('#wfMailSync').scrollIntoViewIfNeeded();
            await app.page.screenshot({ path: path.join(artifacts, `statement-sync-${width}.png`), fullPage: false });
        }
    }
    assert.equal(app.pageErrors.length, 0, `uncaught browser errors: ${app.pageErrors.join('; ')}`);
    console.log(JSON.stringify({ widths, results, failures }, null, 2));
    assert.deepEqual(failures, [], 'statement and sender views must remain readable, separated, and contained');
} finally {
    await app.close();
}
