/* =============================================================================
 * statement-bank-evidence.mjs — what the owner's mailbox already knows about the bank of a statement uploaded by hand
 * -----------------------------------------------------------------------------
 * The manual upload no longer asks "which bank?" (wealthflow-bank-detect.js reads it from the statement). When the statement alone does not settle it — a bank
 * that prints only a logo, a scan — the email sync's own history does: the same file filed under a bank, the same card tail filed under a bank, the same
 * file-name series ("074-02-XXXXX-88.pdf" every month), and the banks the owner approved a sender of. This answers those four questions and nothing else.
 *
 * LABELS AND COUNTS ONLY. No amount, no row, no file name leaves this module: the answer is the bank labels the sync wrote and how many statements carry each.
 * The labels matter beyond naming: the email worker files under exactly them, and the registry lock is built from the label (statement-coverage.mjs bankIdentity),
 * so a statement taken by hand under the same label lands on the same lock.
 *
 * Bounded: two single-field queries and one capped scan (400 items), the same shapes the sync itself reads. Every failure is "no evidence" — the caller
 * reads the statement without it; it never turns into a refusal.
 * ===========================================================================*/

import { sendersOf } from './gmail-link.mjs';
import { filenameStem } from './wealthflow-mail-ingest.mjs';
import { ownerBanks } from './statement-evidence.mjs';

const HASH = /^[a-f\d]{64}$/;
const SCAN = 400;

const isFiled = (item) => item.filed === true || item.status === 'filed';
const labelOf = (item) => String(item.bank || '').trim().slice(0, 80);
const tally = (map, label) => { if (label) map[label] = (map[label] || 0) + 1; };

/**
 * @param {{ mailRef:object, uid:string, sha?:string, tails?:string[], filename?:string }} args
 * @returns {Promise<{ approved:string[], sha:{bank:string}|null, last4:Object<string,Object<string,number>>, series:{bank:string,count:number}|null }>}
 */
export async function bankHistory({ mailRef, uid, sha = '', tails = [], filename = '' }) {
    const out = { approved: [], sha: null, last4: {}, series: null };
    const mine = (data) => !data.uid || data.uid === uid;
    const items = mailRef.collection('items');
    const safely = async (work) => { try { return await work(); } catch (_) { return null; } };

    const [mail, byFile, byTail, scan] = await Promise.all([
        safely(() => mailRef.get()),
        HASH.test(String(sha)) ? safely(() => items.where('contentSha256', '==', sha).limit(8).get()) : null,
        Promise.all(tails.map((tail) => safely(() => items.where('last4', '==', tail).limit(40).get()))),
        String(filename || '') ? safely(() => { let q = items; if (typeof q.select === 'function') q = q.select('bank', 'filename', 'filed', 'status', 'uid'); return (typeof q.limit === 'function' ? q.limit(SCAN) : q).get(); }) : null,
    ]);

    if (mail && mail.exists) out.approved = [...new Set(ownerBanks(sendersOf(mail.data() || {})).map((b) => String(b.name || '').trim()).filter(Boolean))].slice(0, 20);

    for (const doc of (byFile && byFile.docs) || []) {
        const data = doc.data() || {};
        if (mine(data) && labelOf(data)) { out.sha = { bank: labelOf(data) }; break; }
    }

    tails.forEach((tail, i) => {
        const counts = {};
        for (const doc of (byTail[i] && byTail[i].docs) || []) { const data = doc.data() || {}; if (mine(data) && isFiled(data)) tally(counts, labelOf(data)); }
        if (Object.keys(counts).length) out.last4[tail] = counts;
    });

    const stem = filenameStem(filename);
    if (scan && stem.replace(/[#_.]/g, '').length >= 6) {
        const counts = {};
        for (const doc of scan.docs || []) { const data = doc.data() || {}; if (mine(data) && isFiled(data) && filenameStem(data.filename || '') === stem) tally(counts, labelOf(data)); }
        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        if (best) out.series = { bank: best[0], count: best[1] };
    }
    return out;
}

export default { bankHistory };
