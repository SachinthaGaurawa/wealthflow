#!/usr/bin/env node
/* =============================================================================
 * release.cjs — WealthFlow autonomous release engine  (Node, CommonJS, zero-dep)
 *
 * The single source of truth for cutting a release. Enforces the 7-location
 * version law atomically, writes the changelog + version.json notes, optionally
 * consumes the brain's Firestore proposal, and (with --push) commits to the repo
 * so Vercel auto-deploys and the app's update system announces the new version.
 *
 * USAGE
 *   node release.cjs [--patch|--minor|--major] [--version X.Y.Z]
 *                    [--from-brain] [--urgent] [--note "text"]
 *                    [--push] [--dry] [--force] [--repo DIR]
 *
 *   --patch|--minor|--major  bump kind (default: patch)
 *   --version X.Y.Z          set an explicit version (must be > current unless --force)
 *   --from-brain             read system/pendingRelease from Firestore for the
 *                            version/urgency/notes (needs FIREBASE_SERVICE_ACCOUNT;
 *                            degrades to a patch bump if unavailable)
 *   --urgent                 mark this a security release (adds it to mandatory[])
 *   --note "text"            changelog/what's-new text for this version
 *   --push                   git add/commit/push the changed files (Vercel deploys)
 *   --dry                    print what WOULD change; write nothing
 *   --force                  allow a non-increasing version (rare; guarded off by default)
 *   --repo DIR               repo directory (default: cwd)
 *
 * EXIT: 0 ok · 2 nothing-to-do (skipped) · 1 hard error
 * ===========================================================================*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ── args ────────────────────────────────────────────────────────────────────
const A = process.argv.slice(2);
const has = f => A.includes(f);
const val = (f, d) => { const i = A.indexOf(f); return i >= 0 && A[i + 1] ? A[i + 1] : d; };
const REPO = path.resolve(val('--repo', process.cwd()));
const DRY = has('--dry');
const PUSH = has('--push');
const FORCE = has('--force');
let URGENT = has('--urgent');
const FROM_BRAIN = has('--from-brain');
const KIND = has('--major') ? 'major' : has('--minor') ? 'minor' : 'patch';
let NOTE = val('--note', '');
const EXPLICIT = val('--version', '');

const R = p => path.join(REPO, p);
const read = p => fs.readFileSync(R(p), 'utf8');
const exists = p => { try { fs.accessSync(R(p)); return true; } catch (_) { return false; } };
function log(...m) { console.log('[release]', ...m); }
function die(m) { console.error('[release] ✗ ' + m); process.exit(1); }

// ── semver ──────────────────────────────────────────────────────────────────
function parse(v) { const p = String(v || '').trim().split('.').map(n => parseInt(n, 10)); return [p[0] || 0, p[1] || 0, p[2] || 0]; }
function cmp(a, b) { const x = parse(a), y = parse(b); for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i] - y[i]; } return 0; }
function bump(v, kind) { const p = parse(v); if (kind === 'major') return `${p[0] + 1}.0.0`; if (kind === 'minor') return `${p[0]}.${p[1] + 1}.0`; return `${p[0]}.${p[1]}.${p[2] + 1}`; }

// ── current version = version.json.latest (authoritative) ────────────────────
if (!exists('version.json')) die('version.json not found in ' + REPO);
let vj;
try { vj = JSON.parse(read('version.json')); } catch (e) { die('version.json is not valid JSON: ' + e.message); }
const CURRENT = vj.latest || '0.0.0';
log('current version:', CURRENT, '· repo:', REPO);

// ── optional: brain proposal from Firestore ─────────────────────────────────
let brain = null;
async function loadBrain() {
    if (!FROM_BRAIN) return null;
    if (!process.env.FIREBASE_SERVICE_ACCOUNT) { log('--from-brain but no FIREBASE_SERVICE_ACCOUNT — falling back to a', KIND, 'bump'); return null; }
    let admin;
    try { admin = require('firebase-admin'); } catch (_) { log('firebase-admin not installed — falling back to a', KIND, 'bump'); return null; }
    try {
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
        const doc = await admin.firestore().collection('system').doc('pendingRelease').get();
        if (!doc.exists) { log('no pendingRelease doc — falling back to a', KIND, 'bump'); return null; }
        const d = doc.data() || {};
        return { admin, data: d };
    } catch (e) { log('brain read failed (' + e.message + ') — falling back to a', KIND, 'bump'); return null; }
}

// ── decide next version ──────────────────────────────────────────────────────
function decideNext(brainData) {
    if (EXPLICIT) return EXPLICIT;
    if (brainData && brainData.suggestedVersion) return brainData.suggestedVersion;
    return bump(CURRENT, KIND);
}

// ── the 7-location writer (enforces version law) ─────────────────────────────
function applyVersion(next) {
    const changed = [];
    const rx = (label, file, re, rep, expect) => {
        const s = read(file); const m = s.match(re);
        const count = (s.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')) || []).length;
        if (count !== (expect == null ? 1 : expect)) die(`[${label}] expected ${expect == null ? 1 : expect} match in ${file}, found ${count}`);
        const out = s.replace(re, rep);
        if (out === s) die(`[${label}] replacement made no change in ${file}`);
        if (!DRY) fs.writeFileSync(R(file), out);
        changed.push(file); log('  ✓', label, '→', next);
    };
    // 1) version.json — latest + notes + (mandatory if urgent)
    vj.latest = next;
    vj.notes = vj.notes || {};
    vj.notes[next] = NOTE;
    if (URGENT) { vj.mandatory = Array.from(new Set([...(vj.mandatory || []), next])); }
    if (!DRY) fs.writeFileSync(R('version.json'), JSON.stringify(vj, null, 2) + '\n');
    changed.push('version.json'); log('  ✓ version.json latest + notes' + (URGENT ? ' + mandatory' : ''), '→', next);
    // 2) package.json
    if (exists('package.json')) {
        const pj = JSON.parse(read('package.json')); pj.version = next;
        if (!DRY) fs.writeFileSync(R('package.json'), JSON.stringify(pj, null, 2) + '\n');
        changed.push('package.json'); log('  ✓ package.json version →', next);
    }
    // 3) sw.js CACHE_NAME
    if (exists('sw.js')) rx('sw.js CACHE_NAME', 'sw.js', /(CACHE_NAME\s*=\s*'wealthflow-v)\d+\.\d+\.\d+(')/, `$1${next}$2`);
    // 4) wealthflow-update-system.js CURRENT_VERSION
    if (exists('wealthflow-update-system.js')) rx('update-system CURRENT_VERSION', 'wealthflow-update-system.js', /(CURRENT_VERSION\s*=\s*')\d+\.\d+\.\d+(')/, `$1${next}$2`);
    // 5-7) index.html (WF_APP_VERSION + wfVerText + wfVerPill)
    if (exists('index.html')) {
        rx('index WF_APP_VERSION', 'index.html', /(WF_APP_VERSION\s*=\s*')\d+\.\d+\.\d+(')/, `$1${next}$2`);
        rx('index wfVerText', 'index.html', /(id="wfVerText">v)\d+\.\d+\.\d+/, `$1${next}`);
        rx('index wfVerPill', 'index.html', /(id="wfVerPill"[^>]*>v)\d+\.\d+\.\d+/, `$1${next}`);
    }
    return Array.from(new Set(changed));
}

function writeChangelog(next, reason) {
    const head = `## v${next} — ${new Date().toISOString().slice(0, 10)}${URGENT ? ' (security)' : ''}\n\n${NOTE || reason || 'Maintenance release.'}\n\n`;
    let prev = ''; try { prev = read('CHANGELOG.md'); } catch (_) {}
    const body = prev.startsWith('# WealthFlow') ? prev.replace(/^# WealthFlow[^\n]*\n/, '') : ('\n' + prev);
    if (!DRY) fs.writeFileSync(R('CHANGELOG.md'), '# WealthFlow — CHANGELOG\n\n' + head + body.replace(/^\n+/, ''));
    log('  ✓ CHANGELOG.md prepended');
}

function gitPush(next, reason) {
    const run = c => { log('  $ ' + c); if (!DRY) execSync(c, { cwd: REPO, stdio: 'inherit' }); };
    const files = ['version.json', 'package.json', 'sw.js', 'wealthflow-update-system.js', 'index.html', 'CHANGELOG.md'].filter(exists);
    run(`git add ${files.map(f => JSON.stringify(f)).join(' ')}`);
    // commit may be a no-op if nothing changed (dry runs / re-runs) — tolerate it
    try { run(`git commit -m ${JSON.stringify('release: v' + next + ' — ' + (reason || 'maintenance'))}`); }
    catch (_) { log('  (nothing to commit)'); }
    run('git push origin HEAD');
}

(async () => {
    const b = await loadBrain();
    const bd = b && b.data;
    if (FROM_BRAIN && bd) {
        if (!bd.shouldRelease) { log('brain says a release is NOT due (reason: ' + (bd.reason || 'none') + ') — skipping.'); process.exit(2); }
        if (bd.consumed && !FORCE) { log('brain proposal already consumed — skipping (use --force to re-release).'); process.exit(2); }
        if (bd.approval && bd.approval.required && !bd.approval.approved && !FORCE) {
            log('brain proposal awaits approval (approval.approved=false) — skipping. Approve via /api/approve-release or run with --force.'); process.exit(2);
        }
        if (bd.urgent) URGENT = true;
        if (!NOTE && bd.notes) NOTE = typeof bd.notes === 'string' ? bd.notes : (bd.notes.summary || JSON.stringify(bd.notes));
    }

    let next = decideNext(bd);
    if (cmp(next, CURRENT) <= 0) {
        if (FORCE) { log('version', next, 'is not greater than', CURRENT, '(allowed by --force)'); }
        else { log('computed version', next, 'is not greater than current', CURRENT, '— bumping patch instead.'); next = bump(CURRENT, 'patch'); }
    }
    const reason = (bd && bd.reason) || (URGENT ? 'security' : KIND);
    if (!NOTE) NOTE = URGENT ? 'Security & stability update.' : 'Improvements and fixes in this release.';

    log((DRY ? '[DRY] ' : '') + 'releasing v' + CURRENT + ' → v' + next + (URGENT ? ' (security/mandatory)' : '') + ' · ' + reason);
    const changed = applyVersion(next);
    writeChangelog(next, reason);

    // mirror to Firestore + consume the proposal (best-effort)
    if (b && b.admin && !DRY) {
        try {
            const db = b.admin.firestore();
            await db.collection('system').doc('pendingRelease').set({ consumed: true, releasedVersion: next, releasedAt: b.admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            const manRef = db.collection('system').doc('manifest');
            const cur = await manRef.get(); const man = cur.exists ? cur.data() : { latest: CURRENT, mandatory: [], notes: {} };
            man.latest = next; man.notes = man.notes || {}; man.notes[next] = NOTE;
            if (URGENT) man.mandatory = Array.from(new Set([...(man.mandatory || []), next]));
            await manRef.set(man, { merge: true });
            log('  ✓ Firestore manifest updated + proposal consumed');
        } catch (e) { log('  (Firestore mirror skipped: ' + e.message + ')'); }
    }

    if (PUSH) gitPush(next, reason); else log('  (no --push: files updated locally only)');
    log((DRY ? '[DRY] ' : '') + '✅ release complete: v' + next);
    log('   changed files: ' + changed.join(', '));
    process.exit(0);
})().catch(e => die(e && e.stack || String(e)));
