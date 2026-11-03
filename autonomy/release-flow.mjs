#!/usr/bin/env node
/* =============================================================================
 * autonomy/release-flow.mjs — is a real change actually REACHING the app?
 * -----------------------------------------------------------------------------
 * The self-check asks "could a bug get fixed?". It never asked the question the
 * owner kept asking from the other side: "I merged real work — why does my phone
 * still say the same version?" For weeks the answer was a human approval tap
 * nobody gave, while every dashboard stayed green. This file asks that question
 * of the REAL world, not of the config:
 *
 *   1. STALL       a substantive commit has been waiting longer than the release
 *                  loop's own cadence (6h) plus slack
 *   2. NOT LIVE    version.json in the repo is ahead of what production serves
 *   3. DRIFT       the version is written in several places a device reads
 *                  (/api/version, /version.json, the app shell, the service
 *                  worker's cache name); they must all agree — "some places show
 *                  another version" is a reported bug
 *   4. WRONG BUILD production serves a commit that is not in the recent history
 *
 * `evaluateReleaseFlow` is pure so every branch is unit-tested; `gatherFacts`
 * does the I/O; the CLI exits 1 when anything is BROKEN (3 when production could
 * not be read at all) and writes a markdown report for the liveness workflow to
 * file as an issue.
 *
 *   node autonomy/release-flow.mjs [--json] [--base https://www.wealthflow.lk]
 * ===========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

export const OK = 'ok', WARN = 'warn', BROKEN = 'broken';
/** The release loop runs every 6h and after each merge; past this a wait is a stall. */
export const STALL_HOURS = 8;
/** Vercel needs a few minutes after a release commit; do not cry wolf inside it. */
export const DEPLOY_GRACE_MIN = 45;

const hours = (ms) => Math.round(ms / 36e5 * 10) / 10;

/**
 * @param {object} f facts
 * @param {number} f.now                       epoch ms
 * @param {string|null} f.lastTag              e.g. "v7.69.35"
 * @param {{sha:string,at:number,subject:string}|null} f.oldestUnreleased  oldest substantive commit after the tag
 * @param {number} f.unreleasedCount           substantive commits after the tag
 * @param {string} f.repoVersion               version.json latest on the checked-out commit
 * @param {number|null} f.repoVersionAt        epoch ms of the commit that last changed version.json
 * @param {{version?:string,manifest?:string,shell?:string,sw?:string,sha?:string}|null} f.deployed
 * @param {string[]} f.recentShas              short shas of recent main commits
 * @param {{shell?:string,sw?:string,update?:string,pkg?:string}} f.local  versions written in the repo files
 */
export function evaluateReleaseFlow(f) {
    const checks = [];
    const add = (id, status, summary, detail = '') => checks.push({ id, status, summary, detail });

    // 1. stall
    if (!f.lastTag) {
        add('release-stall', WARN, 'No release tag is reachable, so release age cannot be measured.',
            'Fetch tags (fetch-tags: true) in the workflow that runs this check.');
    } else if (f.oldestUnreleased && f.unreleasedCount > 0) {
        const waited = f.now - f.oldestUnreleased.at;
        const stalled = waited > STALL_HOURS * 36e5;
        add('release-stall', stalled ? BROKEN : OK,
            stalled
                ? `${f.unreleasedCount} real change(s) have waited ${hours(waited)}h for a release since ${f.lastTag} (oldest: "${f.oldestUnreleased.subject}").`
                : `${f.unreleasedCount} real change(s) since ${f.lastTag}, newest wait ${hours(waited)}h — inside the release cadence.`,
            stalled ? 'The release loop is not shipping. Look at the latest "Auto Release" run: a red gate, an approval wait, or a decline. This is the check that would have caught 86 commits waiting weeks.' : '');
    } else {
        add('release-stall', OK, `Nothing real is waiting since ${f.lastTag}.`);
    }

    // 2. not live
    if (f.deployed) {
        const dv = f.deployed.version || null;
        const behind = dv && f.repoVersion && dv !== f.repoVersion;
        const age = f.repoVersionAt ? f.now - f.repoVersionAt : Infinity;
        if (behind && age > DEPLOY_GRACE_MIN * 60e3) {
            add('release-live', BROKEN, `The repo says v${f.repoVersion} but production serves v${dv} (${Math.round(age / 60e3)} min after the version commit).`,
                'The release was committed but not deployed, or the deployment failed. Check the Vercel deployment for the release commit.');
        } else if (behind) {
            add('release-live', WARN, `Production serves v${dv}, repo is at v${f.repoVersion} — inside the ${DEPLOY_GRACE_MIN}-minute deploy window.`);
        } else {
            add('release-live', OK, `Production serves v${dv}, matching the repo.`);
        }

        // 2b. a probe that does not answer is a finding, not a gap to ignore: the live-update
        //     client relies on /api/version, the install relies on the shell and sw.js. (If
        //     NOTHING answers, `deployed` is null above and the check says "unreachable".)
        const required = { '/api/version': f.deployed.version, '/version.json': f.deployed.manifest, 'app shell (/app)': f.deployed.shell, 'service worker (/sw.js)': f.deployed.sw };
        const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
        if (missing.length) {
            add('live-probes', BROKEN, `Production did not return a version from: ${missing.join(', ')}.`,
                'Something answers but not everything: a half-applied deploy, an endpoint that now errors, or a response that no longer carries its version. Devices cannot be told about an update they cannot read.');
        } else {
            add('live-probes', OK, 'All four production version probes answered.');
        }

        // 3. drift between the places a device reads
        const seen = { '/api/version': f.deployed.version, '/version.json': f.deployed.manifest, 'app shell': f.deployed.shell, 'service worker': f.deployed.sw };
        const vals = Object.entries(seen).filter(([, v]) => v);
        const distinct = new Set(vals.map(([, v]) => v));
        if (distinct.size > 1 && !(behind && age <= DEPLOY_GRACE_MIN * 60e3)) {
            add('version-drift', BROKEN, 'Production shows different versions in different places: ' + vals.map(([k, v]) => `${k}=${v}`).join(', ') + '.',
                'A device can only be told the truth if every place agrees. release.cjs rewrites all of them atomically; something wrote one by hand or a deploy is half-applied.');
        } else {
            add('version-drift', OK, vals.length ? `All ${vals.length} places a device reads agree (v${[...distinct][0]}).` : 'No deployed version could be read.');
        }

        // 4. wrong build
        if (f.deployed.sha && f.recentShas && f.recentShas.length &&
            !f.recentShas.some((s) => s.startsWith(f.deployed.sha.slice(0, 7)) || f.deployed.sha.startsWith(s.slice(0, 7)))) {
            add('deployed-build', WARN, `Production serves commit ${f.deployed.sha}, which is not among the last ${f.recentShas.length} commits on main.`,
                'A preview, an old rollback, or a manual deploy is live.');
        } else if (f.deployed.sha) {
            add('deployed-build', OK, `Production serves commit ${f.deployed.sha} from main.`);
        }
    } else {
        add('release-live', WARN, 'Production could not be reached from here, so "is it live?" was not verified.');
    }

    // local files agree (the 7-location law, observed rather than assumed)
    const loc = { 'version.json': f.repoVersion, 'index.html': f.local?.shell, 'sw.js': f.local?.sw, 'update-system': f.local?.update, 'package.json': f.local?.pkg };
    const lv = Object.entries(loc).filter(([, v]) => v);
    if (new Set(lv.map(([, v]) => v)).size > 1) {
        add('local-version-law', BROKEN, 'The repository writes different versions in different files: ' + lv.map(([k, v]) => `${k}=${v}`).join(', ') + '.',
            'Run `node release.cjs --version X.Y.Z --force` on a branch, or fix the file that drifted.');
    } else {
        add('local-version-law', OK, `Every version location in the repo says v${lv[0] ? lv[0][1] : '?'}.`);
    }

    const broken = checks.filter((c) => c.status === BROKEN);
    const warn = checks.filter((c) => c.status === WARN);
    return {
        overall: broken.length ? BROKEN : warn.length ? 'degraded' : 'healthy',
        // production was never read at all, so "is it live?" is unanswered — not "fine"
        unverified: !f.deployed,
        checks,
        verdict: broken.length
            ? `BROKEN — a real change is not reaching the app: ${broken.map((b) => b.id).join(', ')}.`
            : warn.length ? `DEGRADED — ${warn.map((w) => w.id).join(', ')}.` : 'HEALTHY — real changes are released and served consistently.',
    };
}

// ── facts ────────────────────────────────────────────────────────────────────
function git(args, fallback = '', cwd = REPO) {
    try { return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
    catch { return fallback; }
}
const read = (p) => { try { return fs.readFileSync(path.join(REPO, p), 'utf8'); } catch { return ''; } };
const first = (re, s) => { const m = re.exec(s); return m ? m[1] : null; };

export function localVersions() {
    let latest = null, pkg = null;
    try { latest = JSON.parse(read('version.json')).latest; } catch { /* unreadable */ }
    try { pkg = JSON.parse(read('package.json')).version; } catch { /* unreadable */ }
    return {
        repoVersion: latest,
        local: {
            shell: first(/WF_APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/, read('index.html')),
            sw: first(/CACHE_NAME\s*=\s*'wealthflow-v(\d+\.\d+\.\d+)'/, read('sw.js')),
            update: first(/CURRENT_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/, read('wealthflow-update-system.js')),
            pkg,
        },
    };
}

export function gitFacts(now = Date.now(), repo = REPO) {
    const { classifyDiff } = require('./substantive.cjs');
    const lastTag = git(['describe', '--tags', '--abbrev=0'], '', repo) || null;
    let oldest = null, count = 0;
    if (lastTag) {
        const revs = git(['rev-list', '--reverse', '--first-parent', `${lastTag}..HEAD`], '', repo).split('\n').filter(Boolean).slice(-400);
        for (const sha of revs) {
            // `-m --first-parent`: a PR merged with a MERGE COMMIT has no patch of its own
            // (plain `git show` prints nothing for it), so its whole change would be skipped
            // and a stalled release would read as healthy. With these flags the merge is
            // diffed against its first parent, which is exactly what the PR brought in.
            const diff = git(['show', '-m', '--first-parent', '-U0', '--format=', sha], '', repo);
            if (!diff) continue;
            if (classifyDiff(diff).substantive) {
                count++;
                if (!oldest) {
                    const [ct, ...subj] = git(['show', '-s', '--format=%ct|%s', sha], '', repo).split('|');
                    oldest = { sha: sha.slice(0, 8), at: Number(ct) * 1000, subject: subj.join('|').slice(0, 100) };
                }
            }
        }
    }
    const vAt = Number(git(['log', '-1', '--format=%ct', '--', 'version.json'], '', repo)) * 1000 || null;
    return {
        now, lastTag, oldestUnreleased: oldest, unreleasedCount: count, repoVersionAt: vAt,
        recentShas: git(['log', '-60', '--format=%h'], '', repo).split('\n').filter(Boolean),
    };
}

async function getText(url, ms = 20_000, tries = 2) {
    // Two tries: one dropped packet must not file a "broken release" issue.
    for (let i = 0; i < tries; i++) {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), ms);
        try {
            const r = await fetch(url, { signal: ctl.signal, headers: { 'cache-control': 'no-cache' } });
            if (r.ok) return await r.text();
        } catch { /* try again */ } finally { clearTimeout(t); }
    }
    return null;
}

export async function deployedFacts(base) {
    const b = String(base).replace(/\/+$/, '');
    const q = `?_=${Date.now()}`;
    const [api, man, app, sw] = await Promise.all([
        getText(`${b}/api/version${q}`), getText(`${b}/version.json${q}`), getText(`${b}/app${q}`, 30_000), getText(`${b}/sw.js${q}`),
    ]);
    if (!api && !man && !app && !sw) return null;
    let a = {}, m = {};
    try { a = JSON.parse(api || '{}'); } catch { /* not json */ }
    try { m = JSON.parse(man || '{}'); } catch { /* not json */ }
    return {
        version: a.version || null, sha: a.sha || null, manifest: m.latest || null,
        shell: first(/WF_APP_VERSION\s*=\s*'(\d+\.\d+\.\d+)'/, app || ''),
        sw: first(/CACHE_NAME\s*=\s*'wealthflow-v(\d+\.\d+\.\d+)'/, sw || ''),
    };
}

export function markdown(r) {
    const icon = { ok: '[OK]', warn: '[WARN]', broken: '[BROKEN]' };
    return ['## Release flow: ' + r.overall.toUpperCase(), '', '**' + r.verdict + '**', '',
        '| | Check | Result |', '|---|---|---|',
        ...r.checks.map((c) => `| ${icon[c.status]} | \`${c.id}\` | ${c.summary} |`),
        ...r.checks.filter((c) => c.status !== OK && c.detail).flatMap((c) => ['', `- **${c.id}** — ${c.detail}`]), ''].join('\n');
}

/**
 * Exit codes the liveness workflow acts on:
 *   0  healthy (or degraded for a reason that does not hide a stall)
 *   1  BROKEN — a real change is not reaching the app
 *   3  UNVERIFIED — production could not be read at all, so recovery cannot be claimed:
 *      the run turns red, but an open release-flow issue stays open and no new
 *      "merged work is not reaching the app" claim is made without evidence.
 */
export const EXIT_UNVERIFIED = 3;
export function exitCodeFor(r) {
    if (r.overall === BROKEN) return 1;
    if (r.unverified) return EXIT_UNVERIFIED;
    return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    const bi = args.indexOf('--base');
    const base = bi >= 0 ? args[bi + 1] : (process.env.PUBLIC_BASE_URL || 'https://www.wealthflow.lk');
    const lv = localVersions();
    const facts = { ...gitFacts(), ...lv, deployed: await deployedFacts(base) };
    const r = evaluateReleaseFlow(facts);
    if (args.includes('--json')) console.log(JSON.stringify({ ...r, facts }, null, 2));
    else console.log(markdown(r));
    if (process.env.GITHUB_STEP_SUMMARY) { try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown(r)); } catch { /* summary is optional */ } }
    try { fs.writeFileSync('release-flow.json', JSON.stringify({ ...r, facts }, null, 2)); } catch { /* optional */ }
    process.exit(exitCodeFor(r));
}
