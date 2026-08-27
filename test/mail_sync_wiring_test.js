/* =============================================================================
 * test/mail_sync_wiring_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-mail-intake.js has 141 passing tests and, until this change, was
 * loaded by nothing. wealthflow-statement-router.js was imported only by its own
 * tests. wealthflow-intelligence.js's vault modal had been defined, exported and
 * reachable from zero callers since v7.7.0 — which is why password-locked
 * statements were never opened: there was no way to put a password in.
 *
 * Every one of those is invisible to a unit test, because in every case the
 * MODULE was fine. So this file reads index.html and pins the wiring.
 *
 * TWO BUGS IT EXISTS BECAUSE OF, BOTH FOUND BY RUNNING THE PAGE
 *
 * 1. `parse` was wired to WFStatementParser.parseStatementText, which returns
 *    `parseStatement(text).rows` — a BARE ARRAY. intakeStatement reads
 *    `parsed.rows`, so it saw undefined, then zero rows, then quarantined every
 *    statement as unparseable. It failed as a plausible "needs review" rather
 *    than as an error, so nothing looked broken.
 *
 * 2. The boot render was placed next to the sweeper renders and landed inside
 *    wfSweepRecord() — a function that runs only when somebody records a sweep.
 *    The card never appeared on load: the exact "I don't see ANYTHING" defect
 *    this change exists to fix, reproduced inside the fix.
 *
 * Neither is visible in a diff. Both are one assertion here.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';

const html = await (async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    return fs.readFileSync(path.resolve(import.meta.dirname, '../index.html'), 'utf8');
})();

/* Comments stripped before any NEGATIVE assertion. A check for "this string is
 * absent" otherwise matches the comment explaining why it must be absent — which
 * is exactly what happened on the first run of this file, and on the DB.set
 * check in test/vault_test.js. Positive assertions run against the raw text, so
 * a call cannot be faked by a comment mentioning it. */
function codeOnly(src) {
    return String(src)
        .replace(/\/\*[\s\S]*?\*\//g, ' ')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The body of a top-level `function NAME(` in the page, to its closing brace. */
function functionBody(name) {
    const at = html.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let i = html.indexOf('{', at);
    let depth = 0;
    for (let j = i; j < html.length; j += 1) {
        if (html[j] === '{') depth += 1;
        else if (html[j] === '}') { depth -= 1; if (depth === 0) return html.slice(at, j + 1); }
    }
    return html.slice(at);
}

describe('the dormant modules are actually loaded', () => {
    it.each([
        ['wealthflow-mail-intake.js', 'the device half of the mail pipeline'],
        ['wealthflow-statement-router.js', 'row hashing, routing and ledger dedup'],
        ['wealthflow-vault.js', 'the bank password vault'],
    ])('loads %s as a module', (file) => {
        expect(html).toContain(`<script type="module" src="${file}"></script>`);
    });

    it('exposes the router on window, since the page reaches modules that way', async () => {
        const fs = await import('node:fs');
        const path = await import('node:path');
        const src = fs.readFileSync(path.resolve(import.meta.dirname, '../wealthflow-statement-router.js'), 'utf8');
        expect(src).toContain('window.WFStatementRouter = API');
    });
});

describe('the pipeline is handed the right functions', () => {
    it('THE ONE THAT SILENTLY FILED NOTHING: parse must return {rows}, not an array', () => {
        /* parseStatementText === `parseStatement(text).rows`. Wiring it here
         * makes intakeStatement read `.rows` off an array, get undefined, and
         * quarantine every statement as unparseable — a believable-looking
         * "needs review" on a pipeline that is in fact completely broken. */
        const fn = functionBody('runMailSync');
        expect(fn, 'runMailSync not found').toBeTruthy();
        expect(fn).toContain('WFStatementParser.parseStatement(text)');
        expect(codeOnly(fn), 'parse is wired to the bare-array shorthand again')
            .not.toContain('parseStatementText');
    });

    it('passes the four functions intakeStatement requires', () => {
        // It throws a TypeError if any is missing, so a gap here is a hard
        // failure at runtime rather than a degraded result.
        const fn = functionBody('runMailSync');
        for (const dep of ['openPdf:', 'extractText:', 'parse:', 'route:']) {
            expect(fn, `missing dep ${dep}`).toContain(dep);
        }
    });

    it('finally passes existingHashes, which nothing ever had', () => {
        /* classifyStatement has accepted `existingHashes` since it was written
         * and no caller had ever supplied one, so every import was deduplicated
         * against itself only and a statement re-imported next month would land
         * a second time. */
        const fn = functionBody('runMailSync');
        expect(fn).toContain('existingHashes: ledgerHashes');
        expect(fn).toContain('WFBackfill.ledgerHashes(appData)');
    });

    it('builds the ledger hash set once per run, not once per statement', () => {
        // It scans every record the app holds; doing it per statement makes a
        // ten-statement sync ten full passes over the ledger.
        const fn = functionBody('runMailSync');
        const hashAt = fn.indexOf('WFBackfill.ledgerHashes(appData)');
        const loopAt = fn.indexOf('for (let i = 0; i < docs.length');
        expect(hashAt).toBeGreaterThan(0);
        expect(loopAt).toBeGreaterThan(0);
        expect(hashAt, 'the ledger is rescanned for every statement').toBeLessThan(loopAt);
    });

    it('takes its passwords from the vault rather than a literal', () => {
        const fn = functionBody('runMailSync');
        expect(fn).toContain('wfVaultPdfPasswords');
    });
});

describe('the card is actually drawn', () => {
    it('THE OTHER ONE: renders from renderDash, not from an unrelated function', () => {
        /* The first version of this call landed inside wfSweepRecord(), so the
         * card only ever appeared after somebody recorded a sweep. Asserting the
         * call exists is not enough — it existed then too. It has to be in the
         * function that draws the dashboard. */
        const dash = functionBody('renderDash');
        expect(dash, 'renderDash not found').toBeTruthy();
        expect(dash, 'the sync card is not drawn when the dashboard draws')
            .toContain('renderMailSync();');

        /* UNCONDITIONALLY, and this needed a second assertion: deleting the
         * plain call still left the one inside the _mailConnected() callback, so
         * the first version of this test passed on a dashboard that drew nothing
         * until an async probe resolved — and drew nothing at all if it never
         * did. The first render must come BEFORE the probe. */
        const drawAt = dash.indexOf('renderMailSync();');
        const probeAt = dash.indexOf('_mailConnected()');
        expect(probeAt, 'the connection probe is gone').toBeGreaterThan(0);
        expect(drawAt, 'the card is only drawn after an async probe resolves')
            .toBeLessThan(probeAt);

        const sweepRecord = codeOnly(functionBody('wfSweepRecord'));
        expect(sweepRecord).not.toContain('renderMailSync();');
    });

    it('has a host element on the dashboard page', () => {
        expect(html).toContain('id="wfMailSync"');
    });

    it('is never hidden, unlike every other conditional card', () => {
        /* A card that disappears when nothing is connected is indistinguishable
         * from a feature that was never built — which is precisely how this
         * pipeline came to be described as live while no part of it ran. The
         * other dashboard cards start `display:none`; this one must not. */
        const at = html.indexOf('id="wfMailSync"');
        const tag = html.slice(at, at + 200);
        expect(tag).not.toContain('display:none');
    });

    it('says what is missing when nothing is connected', () => {
        const fn = functionBody('renderMailSync');
        expect(fn).toContain('Mailbox not connected');
    });
});

describe('the vault has a way in', () => {
    it('the ID vault modal, unreachable since v7.7.0, now has a caller', () => {
        expect(html).toContain('onclick="openIdVault()"');
        expect(html).toContain('window.wfVault.openModal()');
    });

    it('the bank password vault has a settings row', () => {
        expect(html).toContain('onclick="openBankVault()"');
    });

    it('warns that a forgotten PIN cannot be recovered, before anything is saved', () => {
        // A password store with no recovery has to say so at the moment of
        // creation, not in a support answer afterwards.
        const fn = functionBody('openBankVault');
        expect(fn).toContain('There is no recovery');
    });

    it('never puts a password into markup', () => {
        /* Passwords are assigned with `.value =` on an already-built input. A
         * password can contain quotes and angle brackets — that is what a good
         * password looks like — and interpolating one into an attribute is both
         * an escaping bug and a way for the secret to land in a DOM dump. */
        const fn = functionBody('openBankVault');
        expect(fn).toContain("._bv_pw').value = row.password");
        expect(codeOnly(fn), 'a password was interpolated into markup')
            .not.toMatch(/value="\$\{[^}]*password/);
    });

    it('does not log anything from the vault screen', () => {
        const fn = codeOnly(functionBody('openBankVault'));
        expect(fn).not.toMatch(/console\.(log|warn|error)/);
    });
});
