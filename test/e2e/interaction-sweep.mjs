// =============================================================================
// Interaction sweep — CLICK every control, don't just check that it exists
// =============================================================================
// ui-sweep.mjs proves each control's handler NAMES a function that exists. That
// catches a whole class of breakage (a renamed function leaving 6 dead buttons)
// but it cannot catch a handler that exists and then throws, opens a dialog with
// no way out, or does nothing at all. Those are the failures a person actually
// hits, and no static check can see them.
//
// So this sweep clicks things. For each visible, enabled control it records:
//
//   • THREW      — the click produced an uncaught error or a console error.
//                  A real defect, always reported.
//   • TRAPPED    — the click opened a modal that would not close via its own
//                  close control or Escape. Worse than a crash: the user is
//                  stuck with no way back and no error to explain why.
//   • INERT      — no error, but nothing observably changed: no DOM mutation, no
//                  navigation, no dialog. Reported as ADVISORY, never as a
//                  defect, because plenty of controls legitimately do something
//                  invisible (copy to clipboard, persist a preference). Turning
//                  a guess into a finding is how a scanner earns its way into
//                  being ignored.
//
// WHY IT IS SAFE TO CLICK EVERYTHING
//   Firebase is stubbed (test/e2e/firebase-stub.mjs), the server is a local
//   read-only static server, and the profile is a throwaway. There is no real
//   account and no real data to destroy. Two things still need handling, because
//   they break the SWEEP rather than the app:
//     • sign-out ends the session — detected, and the sweep re-authenticates;
//     • external navigation leaves the app — blocked at the request layer.
//   File inputs are skipped: clicking one opens a native OS dialog that would
//   hang the run, which tells us nothing about the app.
//
// This is a diagnostic tool, run on demand and by the discovery scanner. It is
// deliberately NOT part of `npm test`: it needs a browser, and a unit-test suite
// that sometimes needs Chromium is a suite people stop trusting.
// =============================================================================

import { bootApp, completeOnboarding } from './harness.mjs';
import { isMissingVendorGlobal } from './ui-sweep.mjs';

const MAX_CONTROLS = Number(process.env.WF_SWEEP_MAX || 260);
const SETTLE_MS = 220;

// Controls that end the session or wipe state. Clicking them is not dangerous
// here, but it destroys the sweep's own context, so they are visited LAST and
// the sweep re-authenticates afterwards rather than reporting every subsequent
// control as broken.
const SESSION_ENDING = /sign\s*out|log\s*out|logout|lock\s*(now|app)?|delete\s+account|reset\s+everything|erase\s+all|factory\s+reset/i;

// Transport failures from a sandbox with no egress. Note what is NOT in here:
// "Chart is not defined". Hardcoding that string would also swallow a real bug
// the day the app genuinely misuses Chart. Missing vendor globals are excused by
// isMissingVendorGlobal(), which only forgives `X is not defined` when a remote
// script whose URL mentions X actually failed to load.
const ENV_NOISE = /ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_REFUSED|net::ERR_FAILED|Failed to load resource/i;

// Visibility, correctly.
//
// The first version used `el.offsetParent !== null`, which is WRONG for
// `position: fixed` — the spec returns null for fixed elements, and that is how
// virtually every modal in this app is positioned. The trapped-dialog detector
// therefore counted zero open dialogs no matter what was on screen, and its
// "0 dialogs with no way out" result was meaningless. Caught by the detector
// self-check, which is the only reason it did not ship looking healthy.
const VISIBLE_FN = `(el) => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
}`;

// An OPEN DIALOG is a different question from a visible control, and conflating
// them broke this detector twice.
//
// This app's `.mo` overlay class starts at `opacity: 0` and animates open, so
// judging dialogs with the control predicate above found ZERO open dialogs even
// with a full-viewport overlay covering the app. Opacity is an animation state;
// an overlay that is laid out at viewport size still blocks everything under it
// whether it has finished fading in or not. So opacity is deliberately ignored
// here, while a fully transparent BUTTON is still treated as unclickable.
const DIALOG_OPEN_FN = `(el) => {
    if (!el || !el.isConnected) return false;
    const s = getComputedStyle(el);
    if (s.display === 'none' || s.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 2 && r.height > 2;
}`;

/**
 * Every control a person could click, with a stable way to find it again.
 *
 * Runs in the page. Identity is an INDEX INTO THIS SAME QUERY, recomputed on
 * every click, because this app builds its UI at runtime — a selector captured
 * before a re-render can point at a different element or nothing at all.
 */
function collectControls(VIS) {
    const SEL = 'button, [role="button"], a[onclick], a[href^="#"], input[type="button"], input[type="submit"], [onclick]:not(script)';
    const isVisible = eval(VIS);
    const seen = new Set();
    const out = [];
    document.querySelectorAll(SEL).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (el.disabled) return;
        if (el.tagName === 'INPUT' && /file/i.test(el.type)) return; // native dialog
        if (!isVisible(el)) return;
        const label = (el.getAttribute('aria-label') || el.title || el.textContent || el.value || '')
            .replace(/\s+/g, ' ').trim().slice(0, 46);
        out.push({
            label: label || '(no label)',
            id: el.id || '',
            tag: el.tagName.toLowerCase(),
            handler: (el.getAttribute('onclick') || '').slice(0, 80),
        });
    });
    return out;
}

/**
 * Click a control, by unique selector when one exists and by index otherwise.
 *
 * Index identity is inherently racy — this app renders at runtime, so anything
 * that mutates the DOM shifts every later index. That is tolerable for the broad
 * sweep (a moved control is reported as skipped, not as a defect) but NOT for the
 * detector self-check: the first injected probe throws, the app's crash reporter
 * renders in response, and the indices for the remaining probes shift by one — so
 * the trap probe clicked an unrelated element and the self-check reported the
 * trap detector as broken when it was the addressing that was broken.
 */
function clickNth({ n, sel, VIS }) {
    if (sel) {
        const target = document.querySelector(sel);
        if (!target) return { clicked: false };
        target.click();
        return { clicked: true };
    }
    const SEL = 'button, [role="button"], a[onclick], a[href^="#"], input[type="button"], input[type="submit"], [onclick]:not(script)';
    const isVisible = eval(VIS);
    const seen = new Set();
    const list = [];
    document.querySelectorAll(SEL).forEach((el) => {
        if (seen.has(el)) return;
        seen.add(el);
        if (el.disabled) return;
        if (el.tagName === 'INPUT' && /file/i.test(el.type)) return;
        if (!isVisible(el)) return;
        list.push(el);
    });
    const el = list[n];
    if (!el) return { clicked: false };
    el.click();
    return { clicked: true };
}

/** A cheap fingerprint of "what the user can see right now". */
function viewState({ VIS, DLG }) {
    const isVisible = eval(VIS);
    const isOpen = eval(DLG);
    const open = [...document.querySelectorAll('.mo, .modal, [role="dialog"]')]
        .filter(isOpen).length;
    return {
        openDialogs: open,
        mutations: (window.__wfMutations || 0),
        elements: document.querySelectorAll('*').length,
        // The active page id, which is how this app tracks navigation.
        page: (document.querySelector('[id^="page-"]:not([style*="display: none"])') || {}).id || '',
        text: (document.body.innerText || '').length,
        signedOut: !!document.querySelector('#authLogin, #loginPad'),
    };
}

/**
 * Try, in order, everything a real user would do to get out of a dialog:
 * its own close control, the Escape key, then clicking outside it.
 *
 * The first version stopped at step one, and that produced FALSE POSITIVES. It
 * looked for `button[onclick*="close"]` inside the dialog, which in the
 * notifications panel matches a PER-NOTIFICATION dismiss button. Clicking that
 * does not close the panel, but it counted as "tried the close control", so
 * Escape and click-outside were never attempted and a perfectly closable panel
 * was reported as a dialog with no way out.
 *
 * Every escape route is now attempted independently, with a re-check after each,
 * so "trapped" means all three genuinely failed. Click-outside matters here
 * specifically: the notifications panel listens for `mousedown` outside its
 * wrapper, which no keyboard or button press would ever trigger.
 */
async function dismiss(page, baseline = 0) {
    // Compare against the count BEFORE the click, not against zero.
    //
    // Asking "is any dialog open?" was wrong once opacity stopped being treated as
    // hidden: this app keeps overlay containers in the layout permanently at
    // opacity 0, so "any open" is true forever and EVERY control that opened a
    // dialog was reported as trapping the user. The question that matters is
    // whether the view returned to where it started.
    const openCount = () => page.evaluate((DLG) => {
        const isOpen = eval(DLG);
        return [...document.querySelectorAll('.mo, .modal, [role="dialog"]')].filter(isOpen).length;
    }, DIALOG_OPEN_FN);
    const stillOpen = async () => (await openCount()) > baseline;

    if (!await stillOpen()) return true;

    // 1) the dialog's own close control
    for (let i = 0; i < 3; i++) {
        const clicked = await page.evaluate((DLG) => {
            const isOpen = eval(DLG);
            const dialogs = [...document.querySelectorAll('.mo, .modal, [role="dialog"]')].filter(isOpen);
            if (!dialogs.length) return false;
            const top = dialogs[dialogs.length - 1];
            const x = top.querySelector('.md-x, [aria-label="Close"], button[onclick*="close"], button[onclick*="hide"]');
            if (!x) return false;
            x.click();
            return true;
        }, DIALOG_OPEN_FN);
        if (!clicked) break;
        await page.waitForTimeout(140);
        if (!await stillOpen()) return true;
    }

    // 2) Escape
    for (let i = 0; i < 2; i++) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(140);
        if (!await stillOpen()) return true;
    }

    // 3) mousedown outside — dropdown panels close on this and nothing else.
    try {
        await page.mouse.click(4, 4);
        await page.waitForTimeout(160);
        if (!await stillOpen()) return true;
    } catch { /* fall through to the verdict */ }

    return false;
}

/**
 * Count every DOM mutation, so "did this control do anything?" is answered by
 * observation rather than by comparing element counts.
 *
 * Element counts were the first approach and they are not reliable: a toast that
 * appears and disappears leaves the count identical, and a toast from the
 * PREVIOUS control settling inside this control's window changes it. Mutations
 * catch both — and pairing them with a quiet period before the click stops one
 * control's late render being blamed on the next one.
 */
async function installMutationCounter(page) {
    await page.evaluate(() => {
        if (window.__wfMo) return;
        window.__wfMutations = 0;
        window.__wfMo = new MutationObserver((recs) => { window.__wfMutations += recs.length; });
        window.__wfMo.observe(document.documentElement, {
            childList: true, subtree: true, attributes: true, characterData: true,
        });
    });
}

/** Wait until the page stops mutating, so the next click starts from a still frame. */
async function quiesce(page, { quietMs = 150, capMs = 900 } = {}) {
    const start = Date.now();
    let last = -1;
    while (Date.now() - start < capMs) {
        const n = await page.evaluate(() => window.__wfMutations || 0);
        if (n === last) return true;
        last = n;
        await page.waitForTimeout(quietMs);
    }
    return false;
}

/**
 * Click ONE control and classify what happened.
 *
 * Extracted so the classification can be exercised against deliberately broken
 * controls (see verifyDetectors). A sweep that reports "0 defects" is only worth
 * anything if it has been shown capable of reporting one — otherwise it is
 * indistinguishable from a sweep that examines nothing, which is the exact
 * failure this project keeps finding in its own tooling.
 *
 * @returns {'ok'|'threw'|'trapped'|'inert'|'moved'} with detail on the result object
 */
async function probeControl(app, control, results) {
    const errBefore = app.pageErrors.length;
    const conBefore = app.consoleErrors.length;

    // Start from a still frame, so a previous control's late render is not
    // attributed to this one.
    await quiesce(app.page);

    let before;
    try { before = await app.page.evaluate(viewState, { VIS: VISIBLE_FN, DLG: DIALOG_OPEN_FN }); } catch { return 'moved'; }

    let clicked;
    try {
        clicked = await app.page.evaluate(clickNth, { n: control.i, sel: control.sel || '', VIS: VISIBLE_FN });
    } catch (e) {
        // A click that rejects outright is itself a defect worth reporting.
        results.threw.push({ ...control, error: String(e.message).slice(0, 160) });
        return 'threw';
    }
    if (!clicked || !clicked.clicked) {
        results.skipped.push({ ...control, why: 're-render moved it' });
        return 'moved';
    }
    results.clicked++;

    await app.page.waitForTimeout(SETTLE_MS);

    const failed = app.failedRequests || [];
    const rawNew = app.pageErrors.slice(errBefore);
    const newErrors = rawNew.filter((e) => !isMissingVendorGlobal(e, failed));
    const newConsole = app.consoleErrors.slice(conBefore)
        .filter((e) => !ENV_NOISE.test(e) && !isMissingVendorGlobal(e, failed));
    results.offlineVendor += rawNew.length - newErrors.length;

    let after;
    try { after = await app.page.evaluate(viewState, { VIS: VISIBLE_FN, DLG: DIALOG_OPEN_FN }); } catch { after = before; }

    let verdict = 'ok';
    if (newErrors.length || newConsole.length) {
        results.threw.push({ ...control, error: (newErrors[0] || newConsole[0] || '').slice(0, 200) });
        verdict = 'threw';
    }

    if (after.openDialogs > before.openDialogs) {
        const ok = await dismiss(app.page, before.openDialogs);
        // A dialog the user cannot close is worse than a crash: there is no error
        // to explain it and no way back.
        if (!ok) { results.trapped.push({ ...control }); verdict = 'trapped'; }
    } else if (
        verdict === 'ok'
        && after.mutations === before.mutations   // the DOM never moved
        && after.page === before.page
        && after.openDialogs === before.openDialogs
    ) {
        results.inert.push({ ...control });
        verdict = 'inert';
    }

    if (after.signedOut && !before.signedOut) {
        // Expected for the session-enders. Get back in so the run can finish.
        try { await completeOnboarding(app.page); results.reauths++; } catch { /* caller stops */ }
    }
    return verdict;
}

/**
 * Prove the detectors can actually fire, against the real running app.
 *
 * Injects three controls with known defects and checks each is classified
 * correctly. If this ever reports a miss, every "0 defects" result from this
 * sweep is worthless and should be treated as such.
 */
export async function verifyDetectors(app) {
    const results = { threw: [], trapped: [], inert: [], clicked: 0, skipped: [], reauths: 0, offlineVendor: 0 };
    await app.page.evaluate(() => {
        const host = document.createElement('div');
        host.id = '__wf_probe_host';
        // 1) throws when clicked
        const bad = document.createElement('button');
        bad.id = '__probe_throws';
        bad.textContent = 'PROBE throws';
        bad.addEventListener('click', () => { throw new Error('PROBE deliberate failure'); });
        // 2) opens a dialog with no close control and no Escape handler
        const trap = document.createElement('button');
        trap.id = '__probe_trap';
        trap.textContent = 'PROBE trap';
        trap.addEventListener('click', () => {
            const d = document.createElement('div');
            d.className = 'mo';
            d.setAttribute('data-probe-trap', '1');
            d.style.cssText = 'position:fixed;inset:0;background:#0008;z-index:99999';
            d.textContent = 'no way out';
            document.body.appendChild(d);
        });
        // 3) does nothing at all
        const inert = document.createElement('button');
        inert.id = '__probe_inert';
        inert.textContent = 'PROBE inert';
        inert.addEventListener('click', () => { /* intentionally nothing */ });
        host.append(bad, trap, inert);
        document.body.appendChild(host);
    });

    const all = await app.page.evaluate(collectControls, VISIBLE_FN);
    // Addressed by id, not index: the throws probe makes the app's crash reporter
    // render, which shifts every index after it.
    const found = all.map((c, i) => ({ ...c, i })).filter((c) => /^PROBE /.test(c.label))
        .map((c) => ({ ...c, sel: '#' + c.id }));
    const verdicts = {};
    for (const c of found) verdicts[c.label] = await probeControl(app, c, results);

    // Clean up, including a trap dialog that by definition would not close.
    await app.page.evaluate(() => {
        document.getElementById('__wf_probe_host')?.remove();
        document.querySelectorAll('[data-probe-trap]').forEach((el) => el.remove());
    });

    return {
        injected: found.length,
        verdicts,
        ok: found.length === 3
            && verdicts['PROBE throws'] === 'threw'
            && verdicts['PROBE trap'] === 'trapped'
            && verdicts['PROBE inert'] === 'inert',
    };
}

export async function runInteractionSweep({ repoDir = process.cwd(), selfTest = false } = {}) {
    const app = await bootApp({ repoDir });
    const results = { threw: [], trapped: [], inert: [], clicked: 0, skipped: [], reauths: 0, offlineVendor: 0 };

    try {
        // Block navigation off-origin: an external link would take the sweep out of
        // the app entirely and every later control would look broken.
        await app.page.route('**/*', (route) => {
            const u = route.request().url();
            const sameOrigin = u.startsWith(app.server.url) || u.startsWith('data:') || u.startsWith('blob:');
            return sameOrigin ? route.continue() : route.abort();
        });

        await installMutationCounter(app.page);
        const all = await app.page.evaluate(collectControls, VISIBLE_FN);
        // Session-enders last, so one sign-out button cannot invalidate the rest.
        const ordered = [
            ...all.map((c, i) => ({ ...c, i })).filter((c) => !SESSION_ENDING.test(c.label)),
            ...all.map((c, i) => ({ ...c, i })).filter((c) => SESSION_ENDING.test(c.label)),
        ].slice(0, MAX_CONTROLS);

        for (const control of ordered) {
            await probeControl(app, control, results);
        }

        results.totalControls = all.length;
        // Run the detector self-check LAST, so the injected controls can never be
        // confused with the app's own and cannot perturb the real sweep.
        if (selfTest) results.selfTest = await verifyDetectors(app);
        return results;
    } finally {
        await app.close();
    }
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if ((process.argv[1] || '').endsWith('interaction-sweep.mjs')) {
    const r = await runInteractionSweep({ selfTest: !process.argv.includes('--no-selftest') });
    if (process.argv.includes('--json')) {
        console.log(JSON.stringify(r, null, 2));
    } else {
        console.log(`\n🖱️  Interaction sweep — clicked ${r.clicked} of ${r.totalControls} visible controls`
            + `${r.reauths ? ` (re-authenticated ${r.reauths}×)` : ''}`);
        console.log(`   offline-CDN globals excused (not app defects): ${r.offlineVendor}\n`);
        const show = (icon, title, rows, fmt) => {
            console.log(`${rows.length ? icon : '✅'} ${title}: ${rows.length}`);
            rows.slice(0, 15).forEach((x) => console.log('     ' + fmt(x)));
        };
        show('❌', 'controls that threw when clicked', r.threw, (x) => `"${x.label}"${x.id ? ` #${x.id}` : ''} → ${x.error}`);
        show('❌', 'dialogs with no way out', r.trapped, (x) => `"${x.label}"${x.id ? ` #${x.id}` : ''}`);
        console.log(`⚪ no observable effect (advisory, not a defect): ${r.inert.length}`);
        r.inert.slice(0, 12).forEach((x) => console.log('     ' + `"${x.label}"${x.id ? ` #${x.id}` : ''}`));
        if (r.skipped.length) console.log(`⚪ skipped after a re-render moved them: ${r.skipped.length}`);
        if (r.selfTest) {
            // A sweep reporting zero defects is only meaningful if it has been shown
            // capable of reporting one.
            console.log(`\n${r.selfTest.ok ? '✅' : '❌'} detector self-check: injected 3 known-broken controls → `
                + Object.entries(r.selfTest.verdicts).map(([k, v]) => `${k.replace('PROBE ', '')}=${v}`).join(', '));
            if (!r.selfTest.ok) console.log('     ⚠ THE DETECTORS DID NOT FIRE — treat "0 defects" above as unverified.');
        }
    }
    process.exit(0);
}
