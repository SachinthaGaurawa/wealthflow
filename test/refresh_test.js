/* =============================================================================
 * test/refresh_test.js — the Refresh button, and what it actually did
 * -----------------------------------------------------------------------------
 * REPORTED: "the icon rotates 360 degrees, but the system does NOT deeply
 * refresh. It looks like it refreshes."
 *
 * Driven in Chromium against a stubbed Firestore that answers a force-pull
 * after a deliberate 1.5s — a slow connection. What that measured:
 *
 *   the pull       ONE server read, resolved at 1501ms, the new record merged
 *                  and on screen. The fetch was never the broken part.
 *   the spin       class added at 1ms, and the CSS was a 0.7s ONE-SHOT. The
 *                  icon stopped turning 800ms BEFORE the data arrived — and on
 *                  a five-second sync it stops in the first second. That is the
 *                  "phantom": an animation connected to nothing.
 *   the repaint    renderPage(active) plus two badges. The sidebar counts, the
 *                  date, the balances, the DSCR figures and the whole dashboard
 *                  (when standing on another page) kept whatever they had.
 *                  Correct data in appData, stale data on screen — which is
 *                  indistinguishable from a refresh that never fetched.
 *
 * After the fix, same harness: spin on at 1ms, off at 1513ms against a fetch
 * that resolved at 1501ms; sixteen surfaces repainted; and TWO clicks 600ms
 * apart caused exactly ONE server read.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function fn(name) {
    const at = HTML.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let i = HTML.indexOf('(', at);
    let depth = 0;
    for (; i < HTML.length; i += 1) {
        if (HTML[i] === '(') depth += 1;
        else if (HTML[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    depth = 0;
    for (let j = HTML.indexOf('{', i); j < HTML.length; j += 1) {
        if (HTML[j] === '{') depth += 1;
        else if (HTML[j] === '}') { depth -= 1; if (depth === 0) return HTML.slice(at, j + 1); }
    }
    return HTML.slice(at);
}

describe('the animation is the work, not a gesture', () => {
    it('THE SPINNER RUNS UNTIL THE WORK STOPS, not for a fixed 0.7 seconds', () => {
        /* The one-shot is the bug in one line. A `0.7s` animation on a pull
         * that takes 1.5s — or five — finishes while nothing has happened yet,
         * and the owner is told the refresh is over before it began. */
        expect(HTML).toMatch(/\.is-refreshing svg \{[^}]*animation:[^;]*infinite/);
        expect(HTML, 'the fixed one-shot came back').not.toMatch(/\.spin-once svg \{/);
    });

    it('the class goes on before the work and comes off in a finally', () => {
        /* A failure must not leave the icon turning forever — that is the same
         * lie in the other direction. */
        const body = fn('refreshApp');
        expect(body).toContain("classList.add('is-refreshing')");
        expect(body).toMatch(/finally \{[\s\S]*classList\.remove\('is-refreshing'\)/);
    });

    it('a fast refresh still shows one full turn, and never delays the data', () => {
        /* 40ms of spinner is a flash that reads as "nothing happened". The
         * floor holds the ANIMATION only: the render has already run by then. */
        const body = fn('refreshApp');
        expect(HTML).toMatch(/const REFRESH_MIN_SPIN_MS = \d+;/);
        expect(body).toContain('REFRESH_MIN_SPIN_MS');
        const paint = body.indexOf('refreshAllSurfaces()');
        const floor = body.indexOf('REFRESH_MIN_SPIN_MS');
        expect(paint).toBeGreaterThan(-1);
        expect(floor).toBeGreaterThan(paint);
    });
});

describe('the click owns the whole cycle', () => {
    it('IT AWAITS THE PULL — the one word that was missing', () => {
        const body = fn('refreshApp');
        expect(body).toMatch(/^\s*async function refreshApp/);
        expect(body).toContain('await forceSyncFromCloud()');
    });

    it('two taps do not start two server reads', () => {
        /* The old button gave no sign it was busy, so tapping again was the
         * natural thing to do — and three taps on a slow line started three
         * merges racing each other. Measured after the fix: two clicks 600ms
         * apart, one read. */
        const body = fn('refreshApp');
        expect(HTML).toContain('let _refreshInFlight = false;');
        expect(body).toMatch(/if \(_refreshInFlight\) return;/);
        expect(body).toContain('_refreshInFlight = true');
        expect(body).toMatch(/finally \{[\s\S]*_refreshInFlight = false/);
        /* And the button itself is disabled while it runs, so the answer is
         * visible rather than merely internal. */
        expect(body).toContain('btn.disabled = true');
        expect(body).toContain("setAttribute('aria-busy'");
    });

    it('it repaints even when the cloud had nothing new', () => {
        /* A refresh that only repaints on a difference does nothing on the day
         * the owner most wants to see that the screen is current. */
        const body = fn('refreshApp');
        const paint = body.indexOf('refreshAllSurfaces()');
        expect(paint).toBeGreaterThan(body.indexOf('await forceSyncFromCloud()'));
        expect(body).not.toMatch(/if \([^)]*pulled[^)]*\)\s*refreshAllSurfaces/);
    });

    it('offline says so and still repaints from what is on the device', () => {
        const body = fn('refreshApp');
        expect(body).toContain('navigator.onLine');
        expect(body).toMatch(/Offline[^']*/);
    });
});

describe('what a deep refresh actually repaints', () => {
    const body = fn('refreshAllSurfaces');

    it.each([
        ['_applyDisplaySettings', 'the document-level display settings'],
        ['updateDateTime', 'the date in the sidebar'],
        ['updateCCOTBadge', 'the card badge'],
        ['updateChequeBadge', 'the cheque badge'],
        ['updatePWAStatusBadge', 'the install badge'],
        ['renderBalance', 'the balance figures'],
        ['renderDSCR', 'the DSCR numbers'],
        ['renderDash', 'the dashboard'],
        ['renderPage', 'the page in front of you'],
    ])('calls %s — %s', (name) => {
        expect(body, `${name} is not repainted by a refresh`).toContain(name + '(');
    });

    it('AND EVERY ONE OF THOSE EXISTS', () => {
        /* This repository's most repeated defect is a call to something that
         * is not there, inside a try/catch that swallows the ReferenceError.
         * Each name is checked against the file rather than assumed. */
        for (const name of ['_applyDisplaySettings', 'updateDateTime', 'updateCCOTBadge',
            'updateChequeBadge', 'updatePWAStatusBadge', 'renderBalance', 'renderDSCR',
            'renderDash', 'renderPage']) {
            expect(fn(name), `${name} is called by refreshAllSurfaces and does not exist`).toBeTruthy();
        }
    });

    it('one bad record cannot stop the other surfaces repainting', () => {
        /* This file has already been burnt once by a render error being
         * reported as a lost connection. Every step is guarded on its own. */
        expect(body).toMatch(/const step = \([^)]*\) => \{[\s\S]{0,200}try \{[\s\S]{0,120}catch/);
        expect((body.match(/step\('/g) || []).length).toBeGreaterThanOrEqual(8);
    });

    it('the dashboard is not drawn twice when it is the page in front', () => {
        expect(body).toMatch(/activeId !== 'dashboard'/);
    });
});

describe('the pull itself', () => {
    const body = fn('forceSyncFromCloud');

    it('reads from the SERVER, not the local cache', () => {
        /* `{ source: 'server' }` is what makes this a refresh rather than a
         * repaint of what Firestore already had offline. */
        expect(body).toContain("get({ source: 'server' })");
    });

    it('one document IS every collection', () => {
        /* income, expenses, loans, cards, cheques, targets, subscriptions and
         * settings are fields of one Firestore document, so one server read is
         * a complete re-read of all of them. Pinned so that a future "fetch
         * each collection" rewrite has to justify the extra round trips. */
        expect(body).toMatch(/userDocRef\.get/);
        expect(body).toContain('_wfApplyCloudData(cloudData)');
    });

    it('it no longer paints — one owner for that', () => {
        /* Painting in both places made "everything on screen is current"
         * depend on which of the two somebody remembered to extend. */
        expect(body).not.toContain('renderPage(');
        expect(body).not.toContain('updateCCOTBadge()');
    });

    it('NO CLOUD DOCUMENT STILL ENDS THE CYCLE', () => {
        /* A brand-new account has no document yet. The old code fell out of
         * the `if` with the badge left on "Syncing…" for the rest of the
         * session, with nothing ever coming. */
        expect(body).toMatch(/\} else \{[\s\S]{0,600}setSyncStatus\(navigator\.onLine \? 'online' : 'offline'\)/);
    });

    it('it reports what happened instead of returning nothing', () => {
        expect(body).toMatch(/return \{ ok: true, pulled \}/);
        expect(body).toMatch(/return \{ ok: false, pulled: false \}/);
    });
});

describe('the button', () => {
    it('is on the toolbar and calls refreshApp with itself', () => {
        expect(HTML).toMatch(/id="topRefreshBtn"[^>]*onclick="refreshApp\(this\)"/);
    });
});
