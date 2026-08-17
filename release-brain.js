/* =============================================================================
   /api/release-brain.js  —  Autonomous Release & Feedback Brain (Vercel Cron)
   ---------------------------------------------------------------------------
   Runs on a schedule with NO human in the loop. On each run it:

     1. Reads EVERY feedback report from Firestore.
     2. Classifies + clusters them and scores priority:
            Priority = (frequency boost + severity*0.6) + securityWeight
     3. Writes the ranked result to  system/feedbackPriority  (the in-app board
        reads this, so prioritisation is server-computed across ALL users).
     4. Auto-generates release notes from the top clusters and writes them to
        system/pendingRelease  (the publish script / GitHub Action reads this to
        fill the changelog with zero typing).
     5. PROPOSES urgency. If any CRITICAL security/crash cluster exists it sets
        `urgent: true` on system/pendingRelease, behind
        `approval: { required: true, approved: false }`.

   IT DOES NOT ANNOUNCE ANYTHING TO USERS. It used to: whenever a critical
   cluster existed it wrote `mandatory` straight into system/manifest, which
   every client reads, so a machine could declare a REQUIRED SECURITY UPDATE to
   the whole user base with no human involved. On v7.69.24 that produced two
   contradictory statements about one version — release.cjs derived "1 internal
   change — nothing user-facing" from the real diff while the brain marked the
   same version a mandatory security release from the FEEDBACK. The urgency was
   real; the release it was pinned to did not address it.

   approve-release.js, authenticated against RELEASE_ADMIN_UID, is now the only
   writer that may promote a proposal into system/manifest or set `mandatory`.
   The brain still keeps `manifest.latest` equal to the DEPLOYED version and
   prunes stale `mandatory` entries — that is bookkeeping about a fact, and the
   client prefers `manifest.latest` over version.json outright, so letting it
   go stale would silently suppress real update prompts. See section 5 below.

   HONEST LIMITATION: this brain prioritises and proposes with no human. It does
   NOT write application code, deploy, or announce a release by itself.

   AUTHENTICATION: the HTTP endpoint accepts `Authorization: Bearer` carrying
   either CRON_SECRET (what Vercel sends for a Cron Job) or an owner Firebase ID
   token matching RELEASE_ADMIN_UID. With neither configured it refuses every
   request. See the AUTHENTICATION block below.

   SETUP:
     • FIREBASE_SERVICE_ACCOUNT  = service-account JSON (string) for Admin SDK  [required]
     • CRON_SECRET               = shared secret Vercel Cron presents           [required for the cron]
     • RELEASE_ADMIN_UID         = the owner's Firebase uid                     [required for owner calls]
     • RELEASE_BRAIN_ENABLED     = "1" to allow the manifest bookkeeping write
   Schedule is defined in vercel.json → crons.
   (`fs` is imported for version.json — see "WHICH VERSION IS CURRENT" below.)
   ============================================================================ */

import fs from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';

/* =============================================================================
   AUTHENTICATION  —  this endpoint was completely open
   ---------------------------------------------------------------------------
   /api/release-brain is routed by api/router.js with NO guard of any kind. Any
   unauthenticated caller on the internet could make it:

     · read every document in the `feedback` collection
     · overwrite system/feedbackPriority (the in-app priority board)
     · overwrite system/pendingRelease  (the owner's approval queue)
     · DELETE feedback older than 14 days, via the archival pass

   That last one is the sharp edge: `archiveOldFeedback` copies to
   `feedbackArchive` and then deletes from `feedback`, up to 5,000 documents per
   run, and it can be driven by anyone who knows the URL.

   Two accepted credentials, and nothing else:

     1. `Authorization: Bearer <CRON_SECRET>` — what Vercel sends on a Cron Job
        invocation once CRON_SECRET is set in the project's environment. This is
        the scheduled path.
     2. A Firebase ID token whose uid equals RELEASE_ADMIN_UID — the owner, and
        the same identity approve-release.js already requires to ship anything.

   FAILING CLOSED IS THE POINT. If NEITHER credential is configured the endpoint
   refuses every request rather than allowing every request: an unconfigured
   guard that lets traffic through is not a guard, and this repository has
   already produced that defect more than once.

   The CLI (`node release-brain.js`, run by auto-release.yml) does not go
   through HTTP and must not be blocked. It identifies itself with a Symbol,
   which no HTTP request can carry — a request body or header can set `mode` or
   `idToken`, but it cannot put a private Symbol key on the req object.
   ========================================================================== */

const LOCAL_INVOCATION = Symbol('release-brain.local');

/** Build the request object the in-process CLI passes to `handler`. */
export function localRequest(query = {}) {
    return { query, [LOCAL_INVOCATION]: true };
}

export function isLocalInvocation(req) {
    return !!(req && req[LOCAL_INVOCATION] === true);
}

/** Constant-time compare that also hides the length of either input. */
function secretEquals(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const ha = createHash('sha256').update(a).digest();
    const hb = createHash('sha256').update(b).digest();
    return timingSafeEqual(ha, hb);
}

function bearerOf(req) {
    try {
        const h = (req && req.headers) || {};
        const raw = h.authorization || h.Authorization || '';
        const m = /^Bearer\s+(.+)$/i.exec(String(raw).trim());
        return m ? m[1].trim() : '';
    } catch (_) { return ''; }
}

/**
 * Decide whether this request may run the brain.
 *
 * `verifyIdToken` is injected so the owner path can be tested without the
 * Firebase Admin SDK or a network. Returns a named outcome rather than a
 * boolean, so a 401 can say WHICH mechanism refused without revealing a secret.
 */
export async function authorize(req, { env = process.env, verifyIdToken = null } = {}) {
    if (isLocalInvocation(req)) return { ok: true, via: 'local' };

    const cronSecret = String(env.CRON_SECRET || '').trim();
    const adminUid = String(env.RELEASE_ADMIN_UID || '').trim();
    if (!cronSecret && !adminUid) {
        return {
            ok: false, status: 503, via: 'none',
            reason: 'this endpoint has no credentials configured (set CRON_SECRET and/or RELEASE_ADMIN_UID). '
                + 'Refusing every request rather than allowing every request.',
        };
    }

    const token = bearerOf(req);
    if (!token) {
        return { ok: false, status: 401, via: 'none', reason: 'no Authorization: Bearer credential was presented.' };
    }

    if (cronSecret && secretEquals(token, cronSecret)) return { ok: true, via: 'cron' };

    if (adminUid && typeof verifyIdToken === 'function') {
        try {
            const decoded = await verifyIdToken(token);
            const uid = decoded && decoded.uid;
            if (uid && uid === adminUid) return { ok: true, via: 'owner' };
            return { ok: false, status: 403, via: 'owner', reason: 'authenticated, but this uid may not run the release brain.' };
        } catch (_) {
            // Fall through: not a valid ID token either.
        }
    }

    return {
        ok: false, status: 401, via: 'none',
        reason: 'the bearer token is neither the configured cron secret nor a valid owner ID token.',
    };
}

/* THIS FUNCTION COULD NEVER SUCCEED, AND SAID SO IN THE WRONG WORDS.
 *
 * It was `const admin = require('firebase-admin')` inside a module that is ESM
 * — package.json declares `"type": "module"` and this file's only export is
 * `export default`. `require` is simply not defined in ESM scope, so the very
 * first statement threw `ReferenceError: require is not defined`, the blanket
 * `catch (e) { return null; }` ate it, and `handler` announced:
 *
 *     "FIREBASE_SERVICE_ACCOUNT not configured — brain idle."
 *
 * That message is FALSE. The credential was configured. What failed was the
 * module loader, and the report named the one thing that was fine. Every call
 * to /api/release-brain — the Vercel cron and the `?mode=rerank` ping that
 * wealthflow-feedback-ai.js fires when the feedback board opens — returned
 * HTTP 200 with that sentence. It is why redeploying to "fix the missing env
 * var" changed nothing: there was nothing wrong with the env var.
 *
 * Two changes, and the second matters as much as the first:
 *   1. dynamic `import()`, the ESM equivalent — the same form
 *      autonomy/work-queue.mjs already uses successfully against Firestore.
 *   2. NAMED failure states instead of null-for-everything, so "not
 *      configured", "not valid JSON", "could not load the SDK" and "could not
 *      initialise" can never again be reported as one another.
 */

/* A JSON.parse message must NEVER be passed through. V8 embeds the first ~10
 * bytes of the input in it:
 *
 *     JSON.parse('FIREBASE_SERVICE_ACCOUNT={"private_key":"-----BEGIN…')
 *     → `Unexpected token 'F', "FIREBASE_S"... is not valid JSON`
 *
 * The reason string reaches two places that must never carry credential bytes:
 * the GitHub Actions log, and — because /api/release-brain has no auth guard —
 * an HTTP 200 body served to any unauthenticated caller. If the secret is ever
 * misconfigured as a raw key, a path or a base64 blob rather than JSON, that
 * echoed prefix is credential material.
 *
 * The offset is diagnostic and content-free, so it is all that survives.
 * (firebase-admin's own cert() errors were checked against a credential whose
 * every field was a marker string; they echo nothing, so those pass through.) */
function jsonFault(e) {
    const at = String((e && e.message) || '').match(/at position (\d+)/);
    return at ? 'malformed at position ' + at[1] : 'malformed';
}

let _admin = null;
async function getAdmin() {
    if (_admin) return { admin: _admin, reason: null };

    let admin;
    try {
        admin = (await import('firebase-admin')).default;
    } catch (e) {
        return { admin: null, reason: 'firebase-admin could not be loaded: ' + ((e && e.message) || e) };
    }
    if (!admin || !admin.apps) {
        return { admin: null, reason: 'firebase-admin loaded but exposes no app registry — wrong module shape.' };
    }

    if (!admin.apps.length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (!raw || !String(raw).trim()) {
            return { admin: null, reason: 'FIREBASE_SERVICE_ACCOUNT is not set — brain idle.' };
        }
        let cred;
        try {
            cred = JSON.parse(raw);
        } catch (e) {
            return { admin: null, reason: 'FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON (' + jsonFault(e) + ').' };
        }
        try {
            admin.initializeApp({ credential: admin.credential.cert(cred) });
        } catch (e) {
            return { admin: null, reason: 'firebase-admin rejected that credential: ' + ((e && e.message) || e) };
        }
    }
    _admin = admin;
    return { admin, reason: null };
}

// ── scoring (mirrors the client engine, kept in sync) ─────────────────────────
const SIGNALS = {
    security:    { w: 1.00, kw: ['hack','breach','leak','exploit','vulnerab','stolen','fraud','unauthor','phishing','password','2fa','otp','encrypt','privacy','security'] },
    crash:       { w: 0.92, kw: ['crash','freeze','frozen','froze','stuck','hang','white screen','black screen','wont open','won\'t open','cant open','cannot open','not loading','wont load','not starting','splash','broken','data lost','lost my data','disappear','unresponsive'] },
    bug:         { w: 0.70, kw: ['bug','error','wrong','incorrect','glitch','fail','not working','issue','problem','duplicate','miscategor'] },
    performance: { w: 0.55, kw: ['slow','lag','laggy','delay','takes long','loading','spinner','battery','heat'] },
    ui:          { w: 0.40, kw: ['ui','ux','design','layout','color','colour','font','button','hard to read','confusing','cluttered','dark mode','theme'] },
    idea:        { w: 0.30, kw: ['add','feature','please add','would be nice','suggestion','suggest','idea','wish','request','support for'] }
};
function classify(text) {
    const t = (text || '').toLowerCase();
    let best = 'idea', bestHits = 0, bestW = SIGNALS.idea.w;
    for (const [cat, def] of Object.entries(SIGNALS)) {
        let hits = 0; for (const kw of def.kw) if (t.indexOf(kw) >= 0) hits++;
        if (hits > 0 && (hits * def.w) > (bestHits * bestW)) { best = cat; bestHits = hits; bestW = def.w; }
    }
    return { category: best, weight: SIGNALS[best].w };
}
function tokens(s) { return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(w => w.length > 2); }
// Semantic concept expansion — mirrors the client engine so server-side
// prioritisation matches what users see. Same-meaning reports cluster even
// without shared words.
const CONCEPTS = {
    crash: ['crash','crashed','crashing','freeze','frozen','froze','hang','hung','stuck','unresponsive','dead','died'],
    launch: ['open','opening','opens','launch','start','startup','boot','splash','load','loading','loads'],
    data: ['data','records','transactions','history','entries','backup','sync','synced','lost','missing','gone','disappeared','deleted','vanished'],
    login: ['login','signin','passcode','pin','password','auth','authenticate','locked','google','biometric','faceid','fingerprint'],
    slow: ['slow','laggy','lag','delay','delayed','sluggish','wait','waiting','spinner','spinning','hangs'],
    category: ['category','categorise','categorize','categorisation','classified','classify','wrong','incorrect','miscategorised','misfiled','tag','tagged'],
    ui: ['ui','ux','design','layout','screen','button','color','colour','font','text','dark','light','theme','cluttered','confusing','readable'],
    sms: ['sms','message','text','paste','bank','statement','pdf','scan','ocr','receipt'],
    security: ['security','hack','hacked','breach','breached','leak','leaked','stolen','fraud','unauthorised','unauthorized','phishing','exposed','vulnerable','vulnerability'],
    money: ['amount','balance','total','currency','lkr','rupee','money','sum','calculation','rounding'],
    notif: ['notification','notify','alert','reminder','badge','push'],
    add: ['add','feature','option','support','request','suggestion','wish','want','need','please','could','would']
};
const _ci = (() => { const m = {}; for (const c in CONCEPTS) for (const w of CONCEPTS[c]) m[w] = c; return m; })();
function concepts(s) { const set = new Set(); for (const w of tokens(s)) { if (_ci[w]) set.add('@' + _ci[w]); else if (w.length > 3) set.add(w); } return set; }
function sim(a, b) {
    const A = concepts(a), B = concepts(b); if (!A.size || !B.size) return 0;
    let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
    let cw = 0; A.forEach(x => { if (x[0] === '@' && B.has(x)) cw++; });
    const j = inter / (A.size + B.size - inter);
    return Math.min(1, j + (cw > 0 ? Math.min(0.35, cw * 0.18) : 0));
}
function analyse(items) {
    const clusters = [];
    for (const it of items) {
        const text = it.text || it.message || ''; if (!text.trim()) continue;
        let placed = false;
        for (const c of clusters) {
            if (sim(c.sample, text) >= 0.28 || (classify(c.sample).category === classify(text).category && sim(c.sample, text) >= 0.18)) { c.items.push(it); c.count++; placed = true; break; }
        }
        if (!placed) clusters.push({ sample: text, items: [it], count: 1 });
    }
    const total = Math.max(1, items.length);
    for (const c of clusters) {
        const cls = classify(c.sample);
        c.category = cls.category;
        const securityWeight = cls.category === 'security' ? 0.30 : (cls.category === 'crash' ? 0.15 : 0);
        const freqBoost = Math.min(0.5, Math.log2(1 + c.count) * 0.18);
        c.score = Math.min(1, (freqBoost + cls.weight * 0.6) + securityWeight);
        c.priority = c.score >= 0.85 ? 'critical' : c.score >= 0.6 ? 'high' : c.score >= 0.4 ? 'medium' : 'low';
        c.sample = c.sample.slice(0, 240);
        delete c.items; // don't store raw reports in the public board doc
    }
    clusters.sort((a, b) => b.score - a.score || b.count - a.count);
    return clusters;
}

// Stable fingerprint of an issue's text — MUST stay byte-identical to the same
// function in wealthflow-feedback-ai.js so the client can match the server's
// decision to the issue the user is looking at.
function _fingerprint(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        .split(' ').filter(function (w) { return w.length > 2; }).slice(0, 8).join(' ');
}
// Attach the SERVER's explicit decision to every cluster. The client never
// guesses "considering" — it reads these fields. `considering` is true only when
// the autonomous brain has actually ranked the issue critical or high.
function enrichClusters(clusters) {
    return (clusters || []).map(function (c) {
        var considering = (c.priority === 'critical' || c.priority === 'high');
        return Object.assign({}, c, {
            key: _fingerprint(c.sample),
            considering: considering,
            status: c.priority === 'critical' ? 'considering'
                  : c.priority === 'high' ? 'queued'
                  : 'monitoring'
        });
    });
}

function bumpPatch(v) { const p = String(v || '7.13.0').split('.').map(Number); p[2] = (p[2] || 0) + 1; return p.join('.'); }

/* =============================================================================
   WHICH VERSION IS "CURRENT"
   ---------------------------------------------------------------------------
   THIS ANNOUNCED v7.13.1 AS A MANDATORY SECURITY UPDATE WHILE THE APP WAS ON
   v7.69.23, on the brain's very first successful run.

   The old code was:

       let curVersion = '7.13.0';
       try { const m = await db.collection('system').doc('manifest').get();
             if (m.exists && m.data().latest) curVersion = m.data().latest; } catch (_) {}
       const nextVersion = bumpPatch(curVersion);

   system/manifest had never been written — because the brain had never run (see
   the getAdmin comment above) — so the read found nothing and `curVersion` kept
   a constant that was stale by 56 patch releases. The urgent branch then wrote
   `latest: '7.13.1'` and pushed it onto `mandatory`.

   Clients read that document. wealthflow-update-system.js gates the update
   prompt on `_cmp(latest, installed) > 0`, so 7.13.1 < 7.69.23 correctly
   suppressed it — but `_renderCard` uses `avail = _updateAvailable() ||
   _swWaiting`, and a browser with a service-worker update waiting satisfies the
   second clause. Those users saw a red "Required security update" banner
   labelled v7.13.1.

   The bug was latent for as long as the brain was broken and fired the moment
   it worked. Two guards, because one was clearly not enough:

     1. version.json is the SOURCE OF TRUTH — release.cjs enforces it across
        seven files. Read it first; the manifest is a cache, not the record.
     2. Take the MAXIMUM of the two and never bump from anything lower, so a
        stale or corrupted manifest can only ever be corrected upward.
   ========================================================================== */

/** Numeric semver compare. Returns >0 if a is newer than b. */
export function cmpVer(a, b) {
    const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
    for (let i = 0; i < 3; i++) {
        if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
    }
    return 0;
}

/**
 * The version this code actually IS, from version.json beside this file.
 * Returns null when it cannot be read — on Vercel the file may not be bundled,
 * and guessing is what caused the incident above.
 */
export function shippedVersion() {
    try {
        const raw = fs.readFileSync(new URL('./version.json', import.meta.url), 'utf8');
        const v = JSON.parse(raw).latest;
        return (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v)) ? v : null;
    } catch (_) { return null; }
}

/** Pick the newest of the two known versions. Never returns something older. */
export function resolveCurrentVersion(shipped, fromManifest) {
    const valid = (v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v);
    const a = valid(shipped) ? shipped : null;
    const b = valid(fromManifest) ? fromManifest : null;
    if (a && b) return cmpVer(a, b) >= 0 ? a : b;
    return a || b || '7.13.0';
}

/** The current version, reconciled across version.json and system/manifest. */
async function currentVersion(db) {
    let fromManifest = null;
    try {
        const m = await db.collection('system').doc('manifest').get();
        if (m.exists && m.data().latest) fromManifest = String(m.data().latest);
    } catch (_) {}
    return resolveCurrentVersion(shippedVersion(), fromManifest);
}

/**
 * Drop mandatory entries at or below the version now shipping. They can never
 * be a pending update again, and one of them is the bogus 7.13.1 this bug
 * wrote into production.
 */
export function pruneMandatory(list, current) {
    return Array.from(new Set(list || []))
        .filter((v) => typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v))
        .filter((v) => cmpVer(v, current) > 0);
}

// Turn the top critical/high clusters into a concrete, ordered fix list — the
// autonomous system's PROPOSAL for what the next release should change. This is
// always available (deterministic). An optional AI step can elaborate each into
// a code diff for review (see draftFixWithAI / approve-release.js), but the
// human still approves before anything ships to the live money app.
function proposedChangesFrom(clusters) {
    const verbs = { security: 'Harden', crash: 'Fix crash in', bug: 'Fix', performance: 'Optimise', ui: 'Improve UI for', idea: 'Add' };
    return (clusters || [])
        .filter(c => c.priority === 'critical' || c.priority === 'high')
        .slice(0, 8)
        .map((c, i) => ({
            order: i + 1,
            priority: c.priority,
            category: c.category,
            issue: (c.sample || '').slice(0, 200),
            action: (verbs[c.category] || 'Address') + ': ' + (c.sample || '').slice(0, 120),
            reports: c.count || 1
        }));
}


function buildNotes(version, clusters, isUrgent) {
    const top = clusters.slice(0, 6);
    const fixed = top.filter(c => ['bug', 'crash', 'performance'].includes(c.category)).map(c => 'Addressed: ' + c.sample);
    const ui = top.filter(c => c.category === 'ui').map(c => 'UI: ' + c.sample);
    const ideas = top.filter(c => c.category === 'idea').map(c => 'Considering: ' + c.sample);
    const sections = [];
    sections.push({ title: 'Security', security: true, items: [isUrgent ? 'Urgent security hardening based on user reports.' : 'Monthly security maintenance.'] });
    if (fixed.length) sections.push({ title: 'Fixed', items: fixed });
    if (ui.length) sections.push({ title: 'Improved', items: ui });
    if (ideas.length) sections.push({ title: 'Exploring', items: ideas });
    return {
        date: new Date().toISOString().slice(0, 10),
        type: isUrgent ? 'security' : 'minor',
        headline: isUrgent ? 'Urgent security update' : 'Monthly security & improvements',
        sections
    };
}

export default async function handler(req, res) {
    const out = { ok: true, ran: new Date().toISOString(), wrote: [], note: '' };
    const { admin, reason } = await getAdmin();
    if (!admin) { out.ok = false; out.note = reason; return _send(res, out); }

    // AFTER getAdmin, because the owner path needs admin.auth() to verify a
    // token — but BEFORE any read, write or delete. Nothing below this line
    // runs for an unauthenticated caller.
    const auth = await authorize(req, {
        verifyIdToken: (t) => admin.auth().verifyIdToken(t),
    });
    if (!auth.ok) {
        out.ok = false;
        out.error = 'unauthorized';
        out.note = auth.reason;
        return _send(res, out, auth.status || 401);
    }
    out.authorizedVia = auth.via;

    let db;
    try { db = admin.firestore(); } catch (e) { out.ok = false; out.note = 'firestore unavailable'; return _send(res, out); }

    // Parse ?mode= robustly across Vercel Node + edge invocation styles.
    let mode = '';
    try {
        if (req && req.query && req.query.mode) mode = String(req.query.mode);
        else if (req && req.url) mode = (new URL(req.url, 'http://x')).searchParams.get('mode') || '';
    } catch (_) {}

    // FAST RE-RANK: called by the in-app feedback board the moment it opens, so a
    // critical report submitted seconds ago is ingested + flagged immediately
    // (instead of waiting for the daily cron). Read → analyse → write the enriched
    // priority doc → return. No release proposal, no manifest, no archive here.
    if (mode === 'rerank') {
        let ritems = [];
        try {
            const rsnap = await db.collection('feedback').orderBy('createdAt', 'desc').limit(500).get();
            rsnap.forEach(d => ritems.push(d.data()));
        } catch (e) { out.note += ' feedback read failed;'; }
        const rclusters = enrichClusters(analyse(ritems));
        const rcritical = rclusters.filter(c => c.priority === 'critical' && (c.category === 'security' || c.category === 'crash'));
        try {
            await db.collection('system').doc('feedbackPriority').set({
                clusters: rclusters, totalReports: ritems.length, critical: rcritical.length,
                updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
            out.wrote.push('feedbackPriority(rerank)');
        } catch (e) { out.note += ' priority write failed;'; }
        out.mode = 'rerank';
        out.summary = { reports: ritems.length, issues: rclusters.length, critical: rcritical.length };

        // If critical feedback is present, generate the release PROPOSAL right now
        // so the owner's "Review & Approve" panel populates immediately — the system
        // proposes the moment it detects a critical issue, not only on the daily run.
        // (A human still approves; this only drafts the proposal.)
        if (rcritical.length > 0) {
            try {
                const curV = await currentVersion(db);
                const nextV = bumpPatch(curV);
                await db.collection('system').doc('pendingRelease').set({
                    suggestedVersion: nextV, basedOn: curV, urgent: true,
                    shouldRelease: true, reason: 'critical-feedback',
                    notes: buildNotes(nextV, rclusters, true),
                    proposedChanges: proposedChangesFrom(rclusters),
                    approval: { required: true, approved: false },
                    generatedAt: admin.firestore.FieldValue.serverTimestamp()
                });
                out.wrote.push('pendingRelease(rerank)');
            } catch (e) { out.note += ' rerank proposal write failed;'; }
        }
        return _send(res, out);
    }

    // 1–2. read + analyse all feedback
    let items = [];
    try {
        const snap = await db.collection('feedback').orderBy('createdAt', 'desc').limit(500).get();
        snap.forEach(d => items.push(d.data()));
    } catch (e) { out.note += ' feedback read failed;'; }

    const clusters = analyse(items);
    const critical = clusters.filter(c => c.priority === 'critical' && (c.category === 'security' || c.category === 'crash'));
    const enriched = enrichClusters(clusters);

    // 3. write the ranked board (read by the in-app Prioritised Feedback view)
    try {
        await db.collection('system').doc('feedbackPriority').set({
            clusters: enriched, totalReports: items.length, critical: critical.length,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        out.wrote.push('feedbackPriority');
    } catch (e) { out.note += ' priority write failed;'; }

    // 3.5 RETENTION: archive feedback older than 14 days. The in-app board only
    //     DISPLAYS the last 2 weeks; this makes that real at the database level —
    //     old reports are copied to `feedbackArchive` (retained, never lost) and
    //     removed from the active `feedback` collection. Implements the PDF's
    //     "shown for exactly 2 weeks from the send date, then archived properly."
    try {
        const archived = await archiveOldFeedback(db, admin);
        if (archived) out.wrote.push('archived ' + archived + ' old feedback');
        out.archived = archived;
    } catch (e) { out.note += ' archive pass failed;'; out.archived = 0; }

    // 4. auto-write suggested release notes for the publish script / Action
    const isUrgent = critical.length > 0;
    const now = new Date();
    const isMonthlyWindow = now.getUTCDate() === 1;  // 1st of month → routine security release
    const shouldRelease = isUrgent || isMonthlyWindow;

    // current deployed version (read from manifest if present, else default)
    const curVersion = await currentVersion(db);
    const nextVersion = bumpPatch(curVersion);
    const notes = buildNotes(nextVersion, clusters, isUrgent);
    const proposedChanges = proposedChangesFrom(clusters);

    try {
        await db.collection('system').doc('pendingRelease').set({
            suggestedVersion: nextVersion, basedOn: curVersion, urgent: isUrgent,
            shouldRelease, reason: isUrgent ? 'critical-feedback' : (isMonthlyWindow ? 'monthly-security' : 'none'),
            notes, proposedChanges,
            // explicit human-approval gate. /api/approve-release flips approved:true
            // (owner-authenticated) which promotes this to system/manifest and, if a
            // deploy hook is configured, triggers the build. Until then it ships nothing.
            approval: { required: true, approved: false },
            generatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        out.wrote.push('pendingRelease');
    } catch (e) { out.note += ' pendingRelease write failed;'; }

    /* 5. THE BRAIN NO LONGER DECLARES A MANDATORY UPDATE. It proposes one.
     *
     * WHAT THIS USED TO DO, AND WHY IT WAS WRONG
     *
     * The block here wrote `system/manifest` directly whenever any critical
     * cluster existed: `latest = nextVersion`, and `nextVersion` appended to
     * `mandatory`. Clients read that document, so it announced a REQUIRED
     * SECURITY UPDATE to every user with no human in the loop — in a system
     * whose entire design premise is that a human approves what ships.
     *
     * It produced exactly that on v7.69.24: release.cjs derived the notes from
     * the real diff ("1 internal change — nothing user-facing") while this
     * block marked the same version a mandatory security release, because
     * three critical clusters existed in the FEEDBACK. Both statements were
     * about the same version and only one could be true. The urgency was real;
     * the release it was attached to did not address it. A truthful version
     * bump carrying a false reason is the fake-release anti-pattern wearing a
     * different hat.
     *
     * It also announced code that did not exist: `nextVersion` is
     * bumpPatch(current), so on the Vercel cron path — where nothing ships —
     * the manifest advertised a version that would never be deployed. The
     * file's own header says announcing undeployed code would be misleading,
     * and then this block did it.
     *
     * WHAT HAPPENS NOW
     *
     * The urgency proposal lives in system/pendingRelease and nowhere else. It
     * is already written above with `urgent`, `notes`, `proposedChanges` and
     * `approval: { required: true, approved: false }`. approve-release.js —
     * owner-authenticated against RELEASE_ADMIN_UID — is the ONLY writer that
     * may promote it into system/manifest and set `mandatory`.
     *
     * The one thing still written here is FACT, not judgement: `latest` is set
     * to the version that is actually deployed, and stale `mandatory` entries
     * are pruned. Both are needed for correctness rather than convenience —
     *
     *   · the client's `_latestVersion()` prefers `manifest.latest` over
     *     version.json outright, so a manifest frozen at an old version would
     *     silently SUPPRESS legitimate update prompts. Reporting what shipped
     *     is not an announcement, it is bookkeeping.
     *   · pruning can only ever remove an alarm, never raise one, and an entry
     *     at or below the shipped version cannot be a pending update by
     *     definition — including the `7.69.24` this bug left in production.
     *
     * If the deployed version cannot be determined (version.json is not
     * readable in this runtime) NOTHING is written. Guessing is what produced
     * the 7.13.1 incident.
     */
    const deployed = shippedVersion();
    if (process.env.RELEASE_BRAIN_ENABLED === '1') {
        if (!deployed) {
            out.note += ' manifest not updated: the deployed version could not be read;';
        } else {
            try {
                const manRef = db.collection('system').doc('manifest');
                const cur = await manRef.get();
                const man = cur.exists ? cur.data() : { latest: deployed, mandatory: [], notes: {} };
                const before = Array.isArray(man.mandatory) ? man.mandatory.length : 0;
                // Never move `latest` backwards, and never past what is deployed.
                man.latest = resolveCurrentVersion(deployed, null);
                man.mandatory = pruneMandatory(man.mandatory, deployed);
                man.notes = man.notes || {};
                man.securitySchedule = 'monthly';
                man.updatedAt = admin.firestore.FieldValue.serverTimestamp();
                await manRef.set(man);
                out.wrote.push('manifest(latest ' + man.latest + ', mandatory '
                    + before + '→' + man.mandatory.length + ')');
            } catch (e) { out.note += ' manifest write failed;'; }
        }
    }
    if (isUrgent) {
        // Recorded so the run is legible: the brain DID find urgent work, and
        // deliberately did not announce it.
        out.urgencyProposed = nextVersion;
    }

    out.summary = { reports: items.length, issues: clusters.length, critical: critical.length, urgent: isUrgent, monthlyWindow: isMonthlyWindow };
    return _send(res, out);
}

// ── 14-day feedback retention / archival ────────────────────────────────────
// Copies feedback older than 2 weeks into `feedbackArchive` (retained) and
// removes it from the active `feedback` collection. Runs on the Admin SDK, which
// bypasses Firestore rules. Batched (≤200/commit) and capped so it can never run
// away. `createdAt < cutoff` + `orderBy(createdAt)` needs no composite index.
async function archiveOldFeedback(db, admin) {
    const TWO_WEEKS_MS = 14 * 24 * 60 * 60 * 1000;
    const cutoff = admin.firestore.Timestamp.fromMillis(Date.now() - TWO_WEEKS_MS);
    let archived = 0;
    for (let iter = 0; iter < 25; iter++) {                 // hard cap: ≤5,000 docs/run
        let snap;
        try {
            snap = await db.collection('feedback')
                .where('createdAt', '<', cutoff)
                .orderBy('createdAt', 'asc')
                .limit(200)
                .get();
        } catch (e) {
            break;   // index/type issue — leave docs in place rather than risk wrong deletes
        }
        if (!snap || snap.empty) break;
        const batch = db.batch();
        snap.forEach(function (doc) {
            const data = doc.data() || {};
            batch.set(
                db.collection('feedbackArchive').doc(doc.id),
                Object.assign({}, data, {
                    archivedAt: admin.firestore.FieldValue.serverTimestamp(),
                    _archivedFrom: 'feedback'
                })
            );
            batch.delete(doc.ref);
        });
        await batch.commit();
        archived += snap.size;
        if (snap.size < 200) break;
    }
    return archived;
}

/* `status` used to be `obj.ok ? 200 : 200` — both branches 200, so a refusal
 * and a success were indistinguishable to any HTTP client. It stays 200 by
 * default (existing callers read `ok` from the body), but an explicit code can
 * now be passed, and the auth guard passes 401/403/503. */
function _send(res, obj, status = 200) {
    try {
        if (res && res.status) { res.status(status).json(obj); return; }
    } catch (_) {}
    return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

/* =============================================================================
   CLI ENTRY POINT  —  `node release-brain.js`
   ---------------------------------------------------------------------------
   THIS FILE DID NOTHING WHEN RUN DIRECTLY. THAT IS WHY THE PIPELINE WAS DRY.

   package.json declares `"type": "module"`, so `node release-brain.js` parsed
   this file as ESM, bound `handler` to the default export, reached the end of
   the module body and exited 0 — in milliseconds, having opened no Firestore
   connection and written nothing. The handler was never called. Verified by
   running it: exit 0, no output, no network.

   .github/workflows/auto-release.yml ran exactly that command on every single
   release, as `node release-brain.js || echo "brain step non-fatal"` under
   `continue-on-error: true`. It reported success in ~3 seconds every time.
   Downstream, autonomy/proposal-intake.mjs read the document that was never
   written and reported — accurately — `system/pendingRelease does not exist.`
   Green ticks all the way down a chain that had never once run.

   Running this file now RUNS THE BRAIN, and the exit code is the truth about
   whether it worked. Importing it (api/router.js) is completely unchanged:
   nothing below executes unless this module IS the process entry point.
   ========================================================================== */

/**
 * Is this module the process entry point?
 *
 * Pure, and takes both sides as arguments, so the decision is testable without
 * spawning a process. No `node:` imports: this file is bundled into the Vercel
 * function graph and its import list should not grow for a CLI concern.
 */
export function isEntryPoint(argv1, selfUrl) {
    try {
        if (!argv1 || !selfUrl) return false;
        const self = decodeURIComponent(new URL(selfUrl).pathname).replace(/\\/g, '/');
        const arg = String(argv1).replace(/\\/g, '/');
        if (self === arg) return true;
        // argv[1] is resolved but NOT realpath'd, so a symlinked checkout can
        // spell one file two ways and the exact compare misses. Basename
        // equality is sufficient here — the only file it can match is this one.
        return self.split('/').pop() === 'release-brain.js'
            && arg.split('/').pop() === 'release-brain.js';
    } catch (_) { return false; }
}

/**
 * The exit code the CLI must report for a finished handler result.
 *
 * `handler` folds every Firestore failure into `out.note` and still answers
 * `ok: true`. That is right for an HTTP endpoint — the caller gets a 200 and
 * can read the note. It is fatal for a scheduled job, where the note scrolls
 * past in a log nobody opens and the tick stays green. At the CLI boundary a
 * note IS a failure.
 */
export function brainExitCode(out) {
    if (!out || typeof out !== 'object') return 1;
    if (out.ok === false) return 1;
    if (String(out.note || '').trim()) return 1;
    // The default (non-rerank) pass writes system/pendingRelease unconditionally
    // — that write is the entire reason auto-release invokes this. Reporting
    // success without it is a no-op wearing the costume of a result, which is
    // the exact defect this whole block exists to remove.
    if (out.mode !== 'rerank' && !(out.wrote || []).some((w) => String(w).startsWith('pendingRelease'))) return 1;
    return 0;
}

/**
 * Run the brain once and report an honest exit code. `invoke` is injectable so
 * the reporting can be tested without credentials or a network.
 */
export async function runBrainCli({ log = console.log, logErr = console.error, invoke = handler } = {}) {
    let out;
    try {
        // A collector `res`: _send prefers res.status().json() when present, so
        // this captures the same object the HTTP caller would have received.
        const captured = {};
        const res = { status() { return res; }, json(o) { captured.body = o; return res; } };
        await invoke(localRequest(), res);
        out = captured.body;
    } catch (e) {
        logErr('::error::release-brain threw: ' + ((e && e.stack) || e));
        return 1;
    }
    if (!out || typeof out !== 'object') {
        logErr('::error::release-brain produced no result object — it did not run');
        return 1;
    }

    log(JSON.stringify(out, null, 2));
    const code = brainExitCode(out);
    if (code === 0) {
        log('release-brain wrote: ' + (out.wrote || []).join(', '));
    } else {
        logErr('::error::release-brain did not complete its work: '
            + (String(out.note || '').trim() || 'system/pendingRelease was not written')
            + ' (wrote: ' + ((out.wrote || []).join(', ') || 'nothing') + ')');
    }
    return code;
}

if (isEntryPoint(typeof process !== 'undefined' && process.argv && process.argv[1], import.meta.url)) {
    runBrainCli().then(async (code) => {
        process.exitCode = code;
        // firebase-admin holds a gRPC channel open, so the event loop can stay
        // alive long after the work is done. Close the app; if anything still
        // holds the loop 10s later, leave with the code already earned rather
        // than hanging until the job's 15-minute timeout. The timer is unref'd,
        // so it fires ONLY when something else is keeping us alive.
        try {
            // The CACHED app only — never getAdmin(), which would initialise a
            // brand new connection here just to close it.
            if (_admin && _admin.apps) await Promise.all(_admin.apps.filter(Boolean).map((a) => a.delete()));
        } catch (e) {
            console.error('note: could not close the firebase app cleanly: ' + ((e && e.message) || e));
        }
        setTimeout(() => process.exit(code), 10_000).unref();
    }).catch((e) => {
        // runBrainCli catches its own errors, so reaching here means the
        // reporting itself broke. Say so rather than dying as a bare unhandled
        // rejection whose exit code nobody can explain.
        console.error('::error::release-brain CLI failed while reporting: ' + ((e && e.stack) || e));
        process.exitCode = 1;
    });
}
