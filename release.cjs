#!/usr/bin/env node
/* =============================================================================
   release.js  —  One-command WealthFlow release  (run locally or in CI)
   ---------------------------------------------------------------------------
   Bumps every version stamp, writes the changelog + manifest, then (optionally)
   commits and pushes. Because your repo auto-deploys to Vercel on push, ONE
   command ships a release end-to-end.

   USAGE
     node release.cjs <type> "Headline"          # type = full | minor | security
     node release.cjs minor "Faster charts"
     node release.cjs security "June patch" --push
     node release.cjs --from-brain --push        # use notes the brain wrote to Firestore

   FLAGS
     --push          git add/commit/push after editing (triggers auto-deploy)
     --mandatory     mark this version mandatory (forces the update for users)
     --from-brain    read suggestedVersion + notes from system/pendingRelease
                     (needs FIREBASE_SERVICE_ACCOUNT for firebase-admin)
     --version X.Y.Z explicit version instead of auto-bumping

   It edits: package.json, sw.js (CACHE_NAME), wealthflow-update-system.js
   (CURRENT_VERSION), version.json (latest + notes + mandatory), CHANGELOG.md.
   ============================================================================ */
const fs = require('fs');
const { execSync } = require('child_process');
const path = require('path');

const ROOT = __dirname;
const r = (p) => path.join(ROOT, p);
const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };

function readJSON(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function writeJSON(p, o) { fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); }
function bump(v, type) {
    const p = String(v).split('.').map(Number);
    if (type === 'full') { p[1] = (p[1] || 0) + 1; p[2] = 0; }      // minor-semver bump = "full" UX update
    else { p[2] = (p[2] || 0) + 1; }                                 // minor/security = patch
    return p.join('.');
}

(async () => {
    let type = args[0] && !args[0].startsWith('--') ? args[0] : 'minor';
    let headline = args[1] && !args[1].startsWith('--') ? args[1] : '';
    let notes = null;
    let mandatory = flag('--mandatory');

    const pkg = readJSON(r('package.json'));
    const current = pkg.version;
    let next = val('--version') || bump(current, type);

    // Optionally pull the brain's suggestion + auto-written notes from Firestore
    if (flag('--from-brain')) {
        try {
            const admin = require('firebase-admin');
            if (!admin.apps.length) {
                const cred = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
                admin.initializeApp({ credential: admin.credential.cert(cred) });
            }
            const doc = await admin.firestore().collection('system').doc('pendingRelease').get();
            if (doc.exists) {
                const d = doc.data();
                next = val('--version') || d.suggestedVersion || next;
                notes = d.notes || null;
                type = (notes && notes.type) || type;
                if (d.urgent) mandatory = true;
                headline = headline || (notes && notes.headline) || '';
                console.log('• Pulled release notes from brain (pendingRelease):', next, d.urgent ? '[URGENT]' : '');
            } else {
                console.log('• No pendingRelease doc found — using CLI args.');
            }
        } catch (e) {
            console.log('• --from-brain unavailable (' + e.message + ') — using CLI args.');
        }
    }

    if (!notes) {
        notes = {
            date: new Date().toISOString().slice(0, 10),
            type,
            headline: headline || (type === 'security' ? 'Security update' : type === 'full' ? 'Major update' : 'Improvements & fixes'),
            sections: [
                type === 'security'
                    ? { title: 'Security', security: true, items: [headline || 'Security hardening.'] }
                    : { title: 'Improved', items: [headline || 'Performance and reliability improvements.'] }
            ]
        };
    }

    console.log(`\nReleasing ${current} → ${next}  (type: ${type}${mandatory ? ', mandatory' : ''})`);

    // 1. package.json
    pkg.version = next; writeJSON(r('package.json'), pkg);

    // 2. sw.js CACHE_NAME
    let sw = fs.readFileSync(r('sw.js'), 'utf8');
    sw = sw.replace(/const CACHE_NAME = 'wealthflow-v[^']+';/, `const CACHE_NAME = 'wealthflow-v${next}';`);
    fs.writeFileSync(r('sw.js'), sw);

    // 3. wealthflow-update-system.js CURRENT_VERSION
    let us = fs.readFileSync(r('wealthflow-update-system.js'), 'utf8');
    us = us.replace(/const CURRENT_VERSION = '[^']+';/, `const CURRENT_VERSION = '${next}';`);
    fs.writeFileSync(r('wealthflow-update-system.js'), us);

    // 4. version.json
    const man = readJSON(r('version.json'));
    man.latest = next;
    man.notes = man.notes || {};
    man.notes[next] = notes;
    if (mandatory) man.mandatory = Array.from(new Set([...(man.mandatory || []), next]));
    writeJSON(r('version.json'), man);

    // 5. CHANGELOG.md (prepend)
    const cl = fs.readFileSync(r('CHANGELOG.md'), 'utf8');
    const entry = `\n## [${next}] — ${notes.date} — "${notes.headline}"\n\n` +
        notes.sections.map(s => `### ${s.title}\n` + s.items.map(i => `- ${i}`).join('\n')).join('\n\n') + '\n';
    const marker = '---\n';
    const idx = cl.indexOf(marker);
    const updated = idx >= 0 ? cl.slice(0, idx + marker.length) + entry + '\n' + cl.slice(idx + marker.length) : cl + entry;
    fs.writeFileSync(r('CHANGELOG.md'), updated);

    console.log('✓ Stamped version across package.json, sw.js, update-system, version.json, CHANGELOG.md');

    // mark pendingRelease consumed (best-effort)
    if (flag('--from-brain')) {
        try {
            const admin = require('firebase-admin');
            await admin.firestore().collection('system').doc('pendingRelease').set({ consumed: true, consumedVersion: next, consumedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        } catch (_) {}
    }

    // 6. push → triggers Vercel auto-deploy
    if (flag('--push')) {
        try {
            execSync('git add -A', { cwd: ROOT, stdio: 'inherit' });
            execSync(`git commit -m "release v${next}: ${notes.headline}"`, { cwd: ROOT, stdio: 'inherit' });
            execSync('git push', { cwd: ROOT, stdio: 'inherit' });
            console.log(`\n🚀 Pushed v${next} — Vercel will auto-deploy. Users on older versions will see the update.`);
        } catch (e) {
            console.error('git push failed:', e.message);
            process.exit(1);
        }
    } else {
        console.log('\nNext: review changes, then `git add -A && git commit -m "release v' + next + '" && git push` (auto-deploys).');
    }
})();
