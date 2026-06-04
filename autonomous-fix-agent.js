/*  autonomous-fix-agent.js  —  Phase 2 of the autonomous update system
 *
 *  WHAT IT DOES (run by .github/workflows/autonomous-fix.yml on a schedule):
 *    1. Reads the brain's proposal from Firestore (system/pendingRelease).
 *    2. Asks the FREE Gemini API which existing module file is most relevant.
 *    3. Asks Gemini to produce the corrected full contents of that ONE file.
 *    4. Hard safety gates: never touches sensitive files; the rewritten file must
 *       still parse as valid JS; size is bounded.
 *    5. Writes the file + a PR title/body. The workflow opens a PULL REQUEST labelled
 *       'ai-fix' (NEVER auto-merge) so your CI tests it and YOU review before it ships.
 *
 *  HONEST LIMITS (by design, not by accident):
 *    • It only edits small module .js files — never index.html, money, auth, crypto,
 *      rules, the service worker, deps, or the pipeline itself.
 *    • Free-model fixes are best on simple issues; CI + your review catch the rest.
 *    • It opens at most ONE PR per run.
 *
 *  ENV: FIREBASE_SERVICE_ACCOUNT, GEMINI_API_KEY, optional GEMINI_MODEL, REPO_DIR.
 *  Exit codes: 0 = a fix was written (open a PR); 78 = nothing to do (neutral).
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ── sensitive-path gate (mirrors CODEOWNERS / CI risk-gate) ──────────────────
const SENSITIVE = [
    /^index\.html$/i, /\.rules$/i, /^firebase\.json$/i, /^vercel\.json$/i,
    /^package(-lock)?\.json$/i, /^sw\.js$/i,
    /auth/i, /crypto/i, /fifo-reconcile/i, /allocator/i, /approve-release/i,
    /release-brain/i, /send-otp/i, /verify-otp/i, /predict-wealth/i, /market-data/i, /fx-rate/i,
    /^\.github\//i
];
export function isSensitive(p) {
    const f = String(p || '').trim();
    if (!f) return true;
    return SENSITIVE.some(re => re.test(f));
}

// candidate files the agent MAY edit: small, non-sensitive .js modules at repo root
export function candidateFiles(allFiles) {
    return (allFiles || []).filter(f =>
        /\.js$/i.test(f) && !isSensitive(f) && !f.includes('/') && !/\.test\.js$/i.test(f)
    );
}

export function pickPrompt(issue, files) {
    return [
        'You are a senior engineer triaging a bug in a vanilla-JS web app.',
        'ISSUE (from user feedback): ' + issue,
        'Here are the editable source files:',
        files.map(f => '- ' + f).join('\n'),
        'Reply with ONLY the single filename from the list above that most likely needs editing to address the issue.',
        'If none clearly apply, reply with exactly: NONE',
        'No explanation. Just the filename or NONE.'
    ].join('\n');
}

export function fixPrompt(issue, filename, content) {
    return [
        'You are a senior engineer fixing a bug in a vanilla-JS web app. Make the SMALLEST safe change.',
        'ISSUE (from user feedback): ' + issue,
        'FILE: ' + filename,
        'CURRENT CONTENTS:',
        '```javascript',
        content,
        '```',
        'Return ONLY the COMPLETE corrected contents of this file — valid JavaScript, no markdown fences, no commentary.',
        'Do not add or remove unrelated functionality. Keep the existing style. If you cannot safely fix it, return the file UNCHANGED.'
    ].join('\n');
}

// strip accidental ```fences / language tags the model may add
export function cleanCode(text) {
    let t = String(text || '').trim();
    t = t.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '');
    return t.trim();
}

// validate the model's file pick is real, in-list, and not sensitive
export function resolvePickedFile(modelText, files) {
    const pick = String(modelText || '').trim().split(/\s+/)[0].replace(/[`"']/g, '');
    if (!pick || /^none$/i.test(pick)) return null;
    if (!files.includes(pick)) return null;
    if (isSensitive(pick)) return null;
    return pick;
}

// ── Gemini (free tier) ───────────────────────────────────────────────────────
async function gemini(prompt) {
    const key = process.env.GEMINI_API_KEY;
    if (!key) throw new Error('GEMINI_API_KEY not set');
    const model = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key;
    const r = await fetch(url, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
    });
    if (!r.ok) throw new Error('Gemini HTTP ' + r.status);
    const data = await r.json();
    return (((data.candidates || [])[0] || {}).content || {}).parts?.[0]?.text || '';
}

// JS syntax gate — reject the AI's output if it doesn't parse
export function isValidJs(code, tmpDir) {
    const tmp = path.join(tmpDir || '/tmp', '_ai_candidate_' + Date.now() + '.mjs');
    try {
        fs.writeFileSync(tmp, code);
        execSync('node --check ' + JSON.stringify(tmp), { stdio: 'pipe' });
        return true;
    } catch (_) { return false; }
    finally { try { fs.unlinkSync(tmp); } catch (_) {} }
}

async function getProposal() {
    const admin = (await import('firebase-admin')).default;
    if (!admin.apps.length) {
        admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
    }
    const doc = await admin.firestore().collection('system').doc('pendingRelease').get();
    return doc.exists ? doc.data() : null;
}

async function main() {
    const repoDir = process.env.REPO_DIR || process.cwd();
    const proposal = await getProposal();
    if (!proposal || !Array.isArray(proposal.proposedChanges) || !proposal.proposedChanges.length) {
        console.log('No pending proposal with changes. Nothing to do.');
        process.exit(78);
    }
    // pick the top change that is NOT a sensitive-only concern
    const change = proposal.proposedChanges[0];
    const issue = (change.action || change.issue || '').slice(0, 600);
    console.log('Top proposed change:', issue);

    const allFiles = fs.readdirSync(repoDir);
    const files = candidateFiles(allFiles);
    if (!files.length) { console.log('No editable module files found.'); process.exit(78); }

    const pickedRaw = await gemini(pickPrompt(issue, files));
    const target = resolvePickedFile(pickedRaw, files);
    if (!target) {
        console.log('Model selected no safe editable file (or chose a sensitive one). Leaving for human.');
        process.exit(78);
    }
    console.log('Target file:', target);

    const full = path.join(repoDir, target);
    const before = fs.readFileSync(full, 'utf8');
    if (before.length > 60000) { console.log('File too large for a safe free-tier rewrite. Skipping.'); process.exit(78); }

    const after = cleanCode(await gemini(fixPrompt(issue, target, before)));
    if (!after || after === before.trim()) { console.log('Model returned no change.'); process.exit(78); }
    if (!isValidJs(after)) { console.log('AI output failed JS syntax check — rejected.'); process.exit(78); }

    fs.writeFileSync(full, after.endsWith('\n') ? after : after + '\n');
    const pr = {
        title: 'AI fix: ' + issue.slice(0, 60),
        body: [
            '## Autonomous fix (Phase 2) — needs your review',
            '',
            'The autonomous system drafted this fix from user feedback.',
            '',
            '**Issue:** ' + issue,
            '**File changed:** `' + target + '`',
            '**Priority:** ' + (change.priority || 'n/a') + ' · **Reports:** ' + (change.reports || 1),
            '',
            '> Drafted by the free Gemini tier. CI has tested it. Please review before merging — ' +
            'this PR is intentionally NOT auto-merged.'
        ].join('\n'),
        file: target
    };
    fs.writeFileSync(path.join(repoDir, 'ai-fix-pr.json'), JSON.stringify(pr, null, 2));
    console.log('Wrote fix to', target, '+ ai-fix-pr.json. Exit 0 → open PR.');
    process.exit(0);
}

// only run main when executed directly (so tests can import the helpers safely)
const isMain = (() => { try { return path.resolve(process.argv[1] || '') === path.resolve(new URL(import.meta.url).pathname); } catch (_) { return false; } })();
if (isMain) { main().catch(e => { console.error('agent error:', e.message); process.exit(78); }); }
