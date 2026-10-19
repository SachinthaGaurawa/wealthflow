/**
 * publish-layout.mjs - turns the repository tree into the tree that is served.
 *
 * WHY THIS EXISTS
 * ---------------
 * The app has always been index.html, served at "/". Google's OAuth brand
 * verification (2026-10-19) rejected the site because the home page was the
 * login wall: a reviewer who opens https://www.wealthflow.lk/ must see a public
 * page that says what the app is and links to the privacy policy.
 *
 * Vercel serves a file that exists before it looks at a rewrite, so "/" cannot
 * be pointed at a different page while index.html is the app. And renaming the
 * 1.9 MB app file in the repository would touch every test, workflow and
 * comment that names it. So the repository keeps the app as index.html and the
 * public page as landing.html, and the DEPLOY swaps them:
 *
 *      index.html    (the app, already stamped by build.mjs)  ->  app.html
 *      landing.html  (the public home page)                   ->  index.html
 *
 * vercel.json then serves the app at /app (and for every other unknown path,
 * exactly as the old catch-all did), and "/" is the public page. The landing
 * page forwards signed-in users, installed-app launches and OAuth / magic-link
 * returns (anything carrying a query) on to /app with the query intact, so no
 * existing link, redirect URI or installed shortcut changes behaviour.
 *
 * It runs AFTER `node build.mjs --write` (which rewrites index.html and sw.js
 * in place), so app.html is the stamped app. It is idempotent-hostile on
 * purpose: running it twice would turn the landing page into app.html, so a
 * second run refuses. Any problem exits non-zero and fails the build, so a
 * broken layout can never be deployed: a deployed catch-all that points at a
 * missing app.html would be a site-wide 404.
 *
 *   node publish-layout.mjs            swap in place (what Vercel runs)
 *   node publish-layout.mjs --check    verify the inputs only, change nothing
 *
 * Never run it in your working tree: it rewrites index.html. CI tests it on a
 * temporary copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LANDING_MARKER = '<meta name="wf-landing" content="1">';
export const REQUIRED = ['index.html', 'landing.html', 'privacy.html', 'terms.html'];

/** Returns a list of problems (empty when the tree can be swapped). Pure but for reading the files. */
export function inspect(root) {
    const problems = [];
    const read = (f) => {
        try { return fs.readFileSync(path.join(root, f), 'utf8'); } catch (_) { return null; }
    };
    for (const f of REQUIRED) if (read(f) === null) problems.push(`${f} is missing`);
    if (problems.length) return problems;

    const app = read('index.html');
    const landing = read('landing.html');
    if (app.includes(LANDING_MARKER)) {
        problems.push('index.html is already the landing page (publish-layout.mjs has run on this tree)');
    }
    if (!landing.includes(LANDING_MARKER)) problems.push('landing.html lacks the wf-landing marker');
    if (!/firebaseConfig/.test(app)) problems.push('index.html does not look like the app (no firebaseConfig)');
    if (fs.existsSync(path.join(root, 'app.html'))) problems.push('app.html already exists');

    // The public pages must be reachable without the app: no script that sends everyone to the login wall.
    for (const f of ['landing.html', 'privacy.html', 'terms.html']) {
        const html = read(f);
        if (/<script[^>]*src=[^>]*(firebase|gstatic)|firebase\.(auth|initializeApp)|signInWith/i.test(html)) problems.push(`${f} must not load or call Firebase (it is public)`);
    }
    for (const f of ['landing.html', 'privacy.html', 'terms.html']) {
        const html = read(f);
        if (f !== 'privacy.html' && !html.includes('href="/privacy"')) problems.push(`${f} must link to /privacy`);
    }
    return problems;
}

export function publish(root) {
    const problems = inspect(root);
    if (problems.length) throw new Error('publish-layout: ' + problems.join('; '));
    fs.renameSync(path.join(root, 'index.html'), path.join(root, 'app.html'));
    fs.copyFileSync(path.join(root, 'landing.html'), path.join(root, 'index.html'));
    return { app: 'app.html', home: 'index.html' };
}

let invokedDirectly = false;
try {
    invokedDirectly = !!process.argv[1]
        && fs.realpathSync(fileURLToPath(import.meta.url)) === fs.realpathSync(path.resolve(process.argv[1]));
} catch (_) { /* imported */ }

if (invokedDirectly) {
    const root = path.dirname(fileURLToPath(import.meta.url));
    if (process.argv.includes('--check')) {
        const problems = inspect(root);
        if (problems.length) { console.error('publish-layout: ' + problems.join('; ')); process.exit(1); }
        console.log('publish-layout: inputs OK');
    } else {
        try {
            const r = publish(root);
            console.log(`publish-layout: ${r.app} is the app, ${r.home} is the public home page`);
        } catch (e) {
            console.error(String((e && e.message) || e));
            process.exit(1);
        }
    }
}
