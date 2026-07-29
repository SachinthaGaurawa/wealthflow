/* =============================================================================
 * test/e2e/harness.mjs — serve the app, sign in, and land on the dashboard
 * ---------------------------------------------------------------------------
 * The runtime sweep exists because STATIC analysis of this UI does not work.
 * The first static pass produced 21 findings of which ~17 were false, all from
 * two patterns the app uses constantly:
 *
 *   • ids created at runtime — `el.id = 'wfDriveBrowser'` — look "missing"
 *   • mutually exclusive template branches — two `id="ot_fee_override"` inputs
 *     with a literal `} else {` between them — look like duplicate ids
 *
 * A scanner cannot tell which branch rendered. A browser does not have to
 * guess: it reports the DOM that actually exists. That is the whole argument
 * for driving a real Chromium instead of grepping harder.
 *
 * ONBOARDING IS DRIVEN THROUGH THE REAL UI, NOT AROUND IT
 *   The PIN and security-question gates are cleared by clicking the app's own
 *   keypad and filling its own inputs — not by writing directly to localStorage
 *   or calling internals. Two reasons: the real path is what users take (so the
 *   sweep exercises it and would notice if it broke), and a fixture that forges
 *   the end state would silently keep passing after the real flow rotted.
 *
 *   The only thing faked is Firebase itself, and that is faked in the harness —
 *   see firebase-stub.mjs for why a "test mode" flag inside index.html would be
 *   a production auth bypass on a personal-finance app.
 * ===========================================================================*/

import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { installFirebaseStub } from './firebase-stub.mjs';

/**
 * The pre-installed Chromium. Pinned by path on purpose: this environment ships
 * browser build 1194, the installed Playwright expects a newer one, and
 * `playwright install` is not available. Resolving the binary beats failing.
 */
export const CHROME = process.env.WF_CHROME
    || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.png': 'image/png',
    '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
    '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2',
};

/** A local static server for the repo. Returns { url, close }. */
export async function serveRepo(repoDir = process.cwd()) {
    const server = http.createServer((req, res) => {
        let p = decodeURIComponent((req.url || '/').split('?')[0]);
        if (p === '/') p = '/index.html';
        // Never serve outside the repo, even if the app requests `../`.
        const f = path.resolve(repoDir, p.replace(/^\/+/, ''));
        if (!f.startsWith(path.resolve(repoDir))) { res.writeHead(403); return res.end('forbidden'); }
        fs.readFile(f, (err, buf) => {
            if (err) { res.writeHead(404); return res.end('not found'); }
            res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' });
            res.end(buf);
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    return {
        url: `http://127.0.0.1:${port}/`,
        close: () => new Promise((r) => server.close(r)),
    };
}

/** Click one PIN key on a numeric pad, through the app's own button. */
async function tapPin(page, padId, digit) {
    await page.evaluate(([pad, d]) => {
        const el = document.getElementById(pad);
        if (!el) return;
        const btn = [...el.querySelectorAll('[onclick*="pinDigit"]')]
            .find((b) => (b.getAttribute('onclick') || '').includes(`'${d}'`));
        if (btn) btn.click();
    }, [padId, digit]);
    await page.waitForTimeout(70);
}

/** Enter a 6-digit PIN on the given pad. */
async function enterPin(page, padId, pin = '123456') {
    for (const d of pin) await tapPin(page, padId, d);
    await page.waitForTimeout(700);
}

function visibleText(page) {
    return page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').trim());
}

/**
 * Take a freshly loaded page from the welcome screen to the dashboard.
 * Returns the list of gates actually cleared, so a caller (and a test) can
 * assert the flow rather than trust it.
 */
export async function completeOnboarding(page, { pin = '123456', budgetMs = 45000 } = {}) {
    const cleared = [];
    const seen = async (id) => page.evaluate((x) => {
        const el = document.getElementById(x);
        return !!(el && getComputedStyle(el).display !== 'none' && el.offsetParent !== null);
    }, id);

    /**
     * Wait for a screen to actually appear instead of sleeping and hoping.
     *
     * The first version used fixed `waitForTimeout` calls between gates and was
     * FLAKY: one run cleared all five gates, the next cleared only the first and
     * swept the login screen while reporting success. A sweep that silently
     * inspects the wrong page is worse than one that fails, so every gate now
     * waits on observable state and the whole sequence is bounded.
     */
    const until = Date.now() + budgetMs;
    const waitFor = async (ids, timeout = 15000) => {
        const list = Array.isArray(ids) ? ids : [ids];
        const deadline = Math.min(Date.now() + timeout, until);
        while (Date.now() < deadline) {
            for (const id of list) if (await seen(id)) return id;
            await page.waitForTimeout(150);
        }
        return null;
    };

    // Gate 1 — Google sign-in, cleared by the stub before navigation. Wait for
    // the app to move ON from it rather than assuming a duration.
    const first = await waitFor(['authSetup', 'authLogin', 'authSecQ', 'authRecovShow', 'app'], 20000);
    if (first && first !== 'authGoogle') cleared.push('google-auth');

    // Gate 2 — create a PIN, then confirm it. Two passes over the same pad.
    if (await seen('authSetup')) {
        await enterPin(page, 'setupPad', pin);          // create
        await waitFor(['authSetup', 'authSecQ'], 5000);
        await enterPin(page, 'setupPad', pin);          // confirm
        await waitFor(['authSecQ', 'authRecovShow', 'authLogin', 'app'], 10000);
        cleared.push('pin-setup');
    }

    // Gate 3 — recovery question.
    if (await seen('authSecQ')) {
        await page.evaluate(() => {
            const sel = document.getElementById('secQSelect');
            if (sel) {
                // index 1 = the first real question; 0 is the "Choose…" placeholder.
                sel.selectedIndex = 1;
                sel.dispatchEvent(new Event('change', { bubbles: true }));
            }
            const ans = document.getElementById('secAns');
            if (ans) {
                ans.value = 'e2e-sweep-answer';
                ans.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const btn = [...document.querySelectorAll('[onclick*="saveSecQ"]')][0];
            if (btn) btn.click();
        });
        await waitFor(['authRecovShow', 'authLogin', 'app'], 10000);
        cleared.push('security-question');
    }

    // Gate 4 — the one-time recovery code. The app shows it exactly once and
    // waits for an explicit acknowledgement, so the sweep must click through it
    // rather than reload past it.
    if (await seen('authRecovShow')) {
        await page.evaluate(() => {
            const btn = [...document.querySelectorAll('[onclick*="confirmRecovSaved"]')][0];
            if (btn) btn.click();
        });
        await waitFor(['authLogin', 'app'], 10000);
        cleared.push('recovery-code');
    }

    // Gate 5 — the unlock screen. After setup the app returns to a normal
    // login ("Welcome Back …, enter your 6-digit PIN"), so the sweep has to
    // sign in with the PIN it just created, exactly as a returning user does.
    if (await seen('authLogin')) {
        await enterPin(page, 'loginPad', pin);
        await waitFor(['app'], 12000);
        cleared.push('pin-unlock');
    }

    // Settle: the dashboard renders its widgets after the gate clears.
    await page.waitForTimeout(1200);
    return cleared;
}

/**
 * Full setup: server + browser + stubbed auth + onboarding.
 * Returns everything the sweep needs, plus the console/page errors observed —
 * an uncaught exception during boot is itself a finding.
 */
export async function bootApp({ repoDir = process.cwd(), pin = '123456', headless = true } = {}) {
    const server = await serveRepo(repoDir);
    const browser = await chromium.launch({ executablePath: CHROME, headless });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    const pageErrors = [];
    const consoleErrors = [];
    // Which remote scripts never arrived. Needed to tell a real bug
    // (`fooBar is not defined`) from an offline sandbox dropping a CDN
    // (`Chart is not defined` because cdnjs is unreachable here).
    const failedRequests = [];
    page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 300)); });
    page.on('requestfailed', (r) => { try { failedRequests.push(r.url()); } catch { /* ignore */ } });

    await installFirebaseStub(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const gates = await completeOnboarding(page, { pin });

    return {
        page, browser, server, gates, pageErrors, consoleErrors, failedRequests,
        text: await visibleText(page),
        close: async () => { await browser.close(); await server.close(); },
    };
}
