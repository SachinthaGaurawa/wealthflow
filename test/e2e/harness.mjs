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
import fsSync from 'node:fs';
import { installFirebaseStub } from './firebase-stub.mjs';

/** An explicit Chromium path, if the caller pinned one. Empty means "find it". */
export const CHROME = process.env.WF_CHROME || '';

/**
 * Launch Chromium wherever it actually lives.
 *
 * The first version hardcoded `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`,
 * which exists in THIS sandbox and nowhere else. On a GitHub runner the launch
 * would have thrown, the sweep's own error handling would have swallowed it, and
 * discovery would have reported "no UI findings" every single day — a feature
 * that looks alive and never runs. That is the exact failure this pipeline was
 * built to eliminate, so resolution is now attempted in order:
 *
 *   1. WF_CHROME, if the caller pinned one
 *   2. Playwright's own resolution — correct after `playwright install chromium`
 *   3. whatever `chromium*` build is actually present under the browsers path
 *
 * If all three fail the error is rethrown. A sweep that cannot open a browser
 * must say so, not quietly report a clean bill of health.
 */
export async function launchChromium(opts = {}) {
    const attempts = [];
    if (CHROME) attempts.push(CHROME);
    attempts.push(null);                       // let Playwright resolve it
    const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
    try {
        for (const d of fs.readdirSync(root)) {
            if (!/^chromium/.test(d)) continue;
            for (const rel of ['chrome-linux/chrome', 'chrome-linux/headless_shell', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
                const p = path.join(root, d, rel);
                if (fs.existsSync(p)) attempts.push(p);
            }
        }
    } catch { /* no browsers dir — options 1 and 2 may still work */ }

    let lastErr;
    for (const executablePath of attempts) {
        try {
            return await chromium.launch(executablePath ? { ...opts, executablePath } : opts);
        } catch (e) { lastErr = e; }
    }
    throw new Error(`could not launch Chromium (tried ${attempts.length} location(s)): ${lastErr && lastErr.message}`);
}

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
/**
 * Serve the real Chart.js in place of the CDN copy, when a local one exists.
 *
 * The sandbox cannot reach cdnjs (the egress proxy denies it), so every sweep used
 * to report `Chart is not defined` and every chart went unrendered. That noise had
 * to be excused by name, which is a filter — and a filter is always a small lie
 * about what was actually observed.
 *
 * npm IS reachable here, so `npm install chart.js@4.4.1` puts a byte-identical copy
 * of the library on disk and this route hands it to the page. The sweeps then
 * exercise the charting code for real rather than skipping past it.
 *
 * Optional by design: with no local copy the route is not installed and everything
 * behaves exactly as before, so the harness still runs on a machine that has not
 * installed it.
 */
export async function installChartJs(page, file = 'node_modules/chart.js/dist/chart.umd.js') {
    let body;
    try { body = fsSync.readFileSync(file, 'utf8'); } catch { return false; }
    await page.route('**/cdnjs.cloudflare.com/**/Chart.js/**', (route) =>
        route.fulfill({ status: 200, contentType: 'application/javascript', body }));
    return true;
}

export async function bootApp({ repoDir = process.cwd(), pin = '123456', headless = true } = {}) {
    const server = await serveRepo(repoDir);
    const browser = await launchChromium({ headless });
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
    const chartServed = await installChartJs(page);
    await page.goto(server.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    const gates = await completeOnboarding(page, { pin });

    return {
        page, browser, server, gates, pageErrors, consoleErrors, failedRequests, chartServed,
        text: await visibleText(page),
        close: async () => { await browser.close(); await server.close(); },
    };
}
