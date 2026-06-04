/*  approve-release.js  —  the human approval gate for the autonomous update system
 *
 *  WHAT THIS IS (and why it exists):
 *  The release brain (release-brain.js) autonomously ingests feedback, ranks it,
 *  drafts the fix proposal, and writes system/pendingRelease. This endpoint is the
 *  ONE human tap that turns that proposal into a live release. That single gate is
 *  deliberate: an AI silently deploying its own code into a money app is what gets
 *  a fintech banned — keeping a human "ship" button is what makes it award-credible.
 *  Everything before this tap is automatic; the tap itself can be one button.
 *
 *  FLOW:
 *    POST /api/approve-release  { idToken, action: "approve" | "reject", note? }
 *      • verifies the caller is the owner (Firebase ID token → uid must match
 *        RELEASE_ADMIN_UID), so no one else can ship.
 *      • approve → promote system/pendingRelease into system/manifest (this alone
 *        announces the update to every client via the existing update journey —
 *        no redeploy needed) AND, if DEPLOY_HOOK_URL is set, POST it to trigger the
 *        actual Vercel build of the new code.
 *      • reject → record the decision to system/releaseHistory (this is the data a
 *        future learning loop uses to calibrate prioritisation).
 *
 *  ENV:
 *    FIREBASE_SERVICE_ACCOUNT   service-account JSON string (Admin SDK)   [required]
 *    RELEASE_ADMIN_UID          your Firebase uid — the only approver      [required]
 *    DEPLOY_HOOK_URL            Vercel Deploy Hook URL                     [optional]
 */

let _admin = null;
function getAdmin() {
    if (_admin) return _admin;
    try {
        const admin = require('firebase-admin');
        if (!admin.apps.length) {
            const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
            if (!raw) return null;
            const cred = JSON.parse(raw);
            admin.initializeApp({ credential: admin.credential.cert(cred) });
        }
        _admin = admin;
        return admin;
    } catch (_) { return null; }
}

async function _readBody(req) {
    if (req && req.body) { try { return typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (_) { return {}; } }
    return await new Promise((resolve) => {
        try {
            let data = '';
            req.on('data', (c) => { data += c; });
            req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch (_) { resolve({}); } });
            req.on('error', () => resolve({}));
        } catch (_) { resolve({}); }
    });
}

export default async function handler(req, res) {
    const out = { ok: true, ran: new Date().toISOString() };
    const admin = getAdmin();
    if (!admin) { out.ok = false; out.error = 'service account not configured'; return _send(res, out, 500); }

    let db;
    try { db = admin.firestore(); } catch (_) { out.ok = false; out.error = 'firestore unavailable'; return _send(res, out, 500); }

    const body = await _readBody(req);
    const idToken = body.idToken || '';
    const action = body.action || 'approve';

    // ── owner authentication: only the configured uid may ship ──────────────
    let uid = null;
    try { const decoded = await admin.auth().verifyIdToken(idToken); uid = decoded && decoded.uid; }
    catch (_) { out.ok = false; out.error = 'invalid or missing auth token'; return _send(res, out, 401); }

    const adminUid = process.env.RELEASE_ADMIN_UID || '';
    if (!adminUid || uid !== adminUid) { out.ok = false; out.error = 'not authorised to approve releases'; return _send(res, out, 403); }

    // ── load the brain's pending proposal ───────────────────────────────────
    let pending = null;
    try { const p = await db.collection('system').doc('pendingRelease').get(); if (p.exists) pending = p.data(); }
    catch (_) {}
    if (!pending || !pending.suggestedVersion) { out.ok = false; out.error = 'no pending release to act on'; return _send(res, out, 404); }

    const version = pending.suggestedVersion;

    if (action === 'reject') {
        try {
            await db.collection('system').doc('pendingRelease').set(
                { approval: { required: true, approved: false, rejectedAt: admin.firestore.FieldValue.serverTimestamp(), rejectedBy: uid, note: String(body.note || '').slice(0, 500) } },
                { merge: true }
            );
            // record for the learning loop (approved/rejected history per category)
            await db.collection('system').doc('releaseHistory').set(
                { events: admin.firestore.FieldValue.arrayUnion({ version, decision: 'rejected', at: new Date().toISOString(), by: uid }) },
                { merge: true }
            );
        } catch (e) { out.note = 'reject recorded with warning: ' + e.message; }
        out.action = 'rejected'; out.version = version;
        return _send(res, out, 200);
    }

    // ── APPROVE: promote to manifest (announces to all clients) ─────────────
    try {
        const manRef = db.collection('system').doc('manifest');
        const cur = await manRef.get();
        const man = cur.exists ? cur.data() : { latest: pending.basedOn || version, mandatory: [], notes: {} };
        man.latest = version;
        if (pending.urgent) man.mandatory = Array.from(new Set([...(man.mandatory || []), version]));
        man.notes = man.notes || {};
        if (pending.notes) man.notes[version] = pending.notes;
        man.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await manRef.set(man);
        out.announced = version;
    } catch (e) { out.ok = false; out.error = 'failed to announce release: ' + e.message; return _send(res, out, 500); }

    // mark the proposal approved
    try {
        await db.collection('system').doc('pendingRelease').set(
            { approval: { required: true, approved: true, approvedAt: admin.firestore.FieldValue.serverTimestamp(), approvedBy: uid } },
            { merge: true }
        );
        await db.collection('system').doc('releaseHistory').set(
            { events: admin.firestore.FieldValue.arrayUnion({ version, decision: 'approved', at: new Date().toISOString(), by: uid }) },
            { merge: true }
        );
    } catch (_) {}

    // ── optional: trigger the actual Vercel build (true one-tap deploy) ─────
    const hook = process.env.DEPLOY_HOOK_URL || '';
    if (hook) {
        try {
            const r = await fetch(hook, { method: 'POST' });
            out.deployTriggered = true; out.deployStatus = r.status;
        } catch (e) { out.deployTriggered = false; out.deployError = e.message; }
    } else {
        out.deployTriggered = false;
        out.note = 'Release announced to clients. No DEPLOY_HOOK_URL set, so the code build was not auto-triggered — set it to make this true one-tap deploy.';
    }

    out.action = 'approved'; out.version = version;
    return _send(res, out, 200);
}

function _send(res, obj, code) {
    try { if (res && res.status) { res.status(code || 200).json(obj); return; } } catch (_) {}
    return new Response(JSON.stringify(obj), { status: code || 200, headers: { 'Content-Type': 'application/json' } });
}
