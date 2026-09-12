import { getAdminDb, withDeadline } from './admin-db.mjs';
import { identify, userKeyFor } from './gmail-link.mjs';
import { cloudConfig, sealCloud, VAULT_ROOT } from './statement-cloud-vault.mjs';

const json = (res, code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); };

export default async function handler(req, res) {
    if (!['GET', 'PUT', 'DELETE'].includes(req.method)) return json(res, 405, { ok: false, reason: 'method-not-allowed' });
    const { db, admin } = await getAdminDb();
    const who = await identify(req, { verifyIdToken: admin ? token => admin.auth().verifyIdToken(token, true) : null });
    if (!who.ok) return json(res, who.status || 401, { ok: false, reason: who.reason });
    let config;
    try { config = cloudConfig(); } catch (_) { return json(res, 503, { ok: false, reason: 'statement-cloud-not-configured' }); }
    if (!who.uid || who.uid !== config.ownerUid) return json(res, 403, { ok: false, reason: 'owner-required' });
    const ref = db.collection(VAULT_ROOT).doc(who.uid);
    try {
        if (req.method === 'GET') {
            const doc = await withDeadline(ref.get());
            const data = doc.exists ? doc.data() : {};
            return json(res, 200, { ok: true, configured: true, saved: doc.exists, count: data.count || 0, savedAt: data.savedAt || null });
        }
        if (req.method === 'DELETE') {
            await db.runTransaction(async tx => {
                tx.delete(ref);
                tx.set(db.collection('wf-mail').doc(userKeyFor(who.email)), { autonomous: false }, { merge: true });
            });
            return json(res, 200, { ok: true, saved: false });
        }
        let body;
        try { body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; } catch (_) { return json(res, 400, { ok: false, reason: 'invalid-body' }); }
        let sealed;
        try { sealed = await sealCloud(who.uid, body && body.entries); }
        catch (e) { return json(res, /^invalid-|too-large/.test(e.message) ? 400 : 503, { ok: false, reason: e.message }); }
        await db.runTransaction(async tx => {
            const mailRef = db.collection('wf-mail').doc(userKeyFor(who.email));
            const mail = await tx.get(mailRef);
            const previousVault = await tx.get(ref);
            if (mail.exists && mail.data().email && mail.data().email !== who.email) throw new Error('mailbox-owner-mismatch');
            sealed.savedAt = Math.max(sealed.savedAt, (Number(previousVault.data()?.savedAt) || 0) + 1);
            tx.set(ref, sealed);
            tx.set(mailRef, { uid: who.uid, email: who.email, autonomous: true }, { merge: true });
        });
        let queued = false;
        try {
            const { enqueueStatementSync } = await import('./statement-cloud-queue.mjs');
            await enqueueStatementSync();
            queued = true;
        } catch (_) { /* The scheduler can pick up durable vault/mailbox state. */ }
        return json(res, 200, { ok: true, saved: true, count: sealed.count, savedAt: sealed.savedAt, queued });
    } catch (_) { return json(res, 503, { ok: false, reason: 'vault-storage-unavailable' }); }
}
