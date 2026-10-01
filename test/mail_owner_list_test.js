/* =============================================================================
 * test/mail_owner_list_test.js — the owner's list is the authority
 * -----------------------------------------------------------------------------
 * TWO REPORTS, ONE SCREEN, AND THEY LOOK LIKE OPPOSITES:
 *
 *   "I added the emails. It should take ONLY from those. But unwanted receipts
 *    and bills keep arriving."
 *
 *   "A bank statement came yesterday. That address IS added to WealthFlow. The
 *    statement did not sync."
 *
 * Too much arriving and too little arriving, at the same time. Both are the
 * same defect from different sides: the owner's list was not actually in
 * charge of anything.
 *
 * ── WHY TOO MUCH ARRIVED ────────────────────────────────────────────────────
 *
 * planMessage gated the curated rule on `who.known === false`. `known` is true
 * for the five domains in the BUILT-IN bank list, so a message from any of them
 * skipped the owner's list ENTIRELY — and skipped looksLikeStatement with it,
 * on the reasoning that a known bank may title its statement whatever it likes.
 * Every PDF those domains ever sent was filed: marketing, card bills, insurance
 * offers, promotional inserts. The owner's list had no power over them at all.
 *
 * ── WHY TOO LITTLE ARRIVED ──────────────────────────────────────────────────
 *
 * matchSender is address-exact for an address entry, which is correct —
 * approving `estatement@sampath.lk` is not approving all of sampath.lk. But
 * banks write from more than one desk. The next statement comes from
 * `noreply@sampath.lk`, scores as an unknown sender, is refused, and — this is
 * the part that made it unrecoverable — the message was DROPPED. The sighting
 * was recorded so the sender appeared in the pending list, but approving it
 * afterwards brought back nothing.
 *
 * These tests pin all three halves of the fix: the list decides for everyone,
 * a sibling address is named as one, and a refusal holds the message instead of
 * losing it.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    planMessage, planHold, releasedBy, REJECT, HOLDABLE, MAX_HELD,
} from '../wealthflow-mail-ingest.mjs';
import { policyFrom, relatedApproval } from '../wealthflow-mail-senders.mjs';
import { mergeHeld, heldOf, HELD_FIELD } from '../gmail-link.mjs';
import fs from 'node:fs';
import path from 'node:path';

const pdf = (name) => ({ mimeType: 'application/pdf', filename: name, body: { size: 120000, attachmentId: 'ATT1' } });

const message = (from, signedBy, subject = 'Your monthly note', id = 'MSG1') => ({
    id,
    internalDate: '1787000000000',
    payload: {
        headers: [
            { name: 'From', value: from },
            { name: 'Subject', value: subject },
            { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.d=${signedBy}` },
        ],
        parts: [{ mimeType: 'text/html', body: { size: 40 } }, pdf('doc.pdf')],
    },
});

const CURATED = () => policyFrom([
    { id: 'estatement@sampath.lk', kind: 'address', domain: 'sampath.lk', name: 'Sampath Bank', status: 'approved', source: 'manual', addedMs: 1 },
]);
const UNCURATED = () => policyFrom([]);

/* ═══════════════════════════════════════════════════════════════════════════
 * "IT SHOULD TAKE ONLY FROM THE EMAILS I ADDED"
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a curated list decides for EVERYONE, built-in banks included', () => {
    it('THE BUG: a promotional PDF from a built-in bank used to be filed', () => {
        // hnb.lk is in the built-in list, so `known` was true, so the curated
        // check never ran and neither did the statement-vocabulary check. One
        // PDF from that domain was one item in the queue, whatever it was.
        const r = planMessage(message('promotions@hnb.lk', 'hnb.lk', 'Win a holiday - see attached'), CURATED());
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.NOT_ON_YOUR_LIST);
    });

    it('and it says the sender WAS a bank it recognises, so the tap is obvious', () => {
        // Refusing is right; refusing anonymously is not. The owner needs to
        // see "this is HNB, which you have not listed" rather than a stranger.
        const r = planMessage(message('statements@hnb.lk', 'hnb.lk'), CURATED());
        expect(r.detail.knownBank).toBe(true);
        expect(r.detail.from).toBe('hnb.lk');
    });

    it('the address the owner DID add still gets straight in', () => {
        const r = planMessage(message('estatement@sampath.lk', 'sampath.lk'), CURATED());
        expect(r.ok).toBe(true);
        expect(r.items).toHaveLength(1);
    });

    it('legacy domain approval admits no mailbox as an approved address — it says WHICH bank, and the mail is judged on its document', () => {
        const byDomain = policyFrom([
            { id: 'sampath.lk', kind: 'domain', domain: 'sampath.lk', name: 'Sampath Bank', status: 'approved', source: 'manual', addedMs: 1 },
        ]);
        expect(byDomain.decide('noreply@sampath.lk').verdict).not.toBe('approved');
        for (const from of ['noreply@sampath.lk', 'estatement@sampath.lk']) {
            const plan = planMessage(message(from, 'sampath.lk'), byDomain);
            expect(plan.ok, from).toBe(true);
            expect(plan.items[0], from).toMatchObject({ via: 'sibling', intent: 'suspect' });      // never as an approved address: the document must prove itself
        }
    });

    it('AN OWNER WHO HAS APPROVED NOTHING IS HELD, NOT FILED', () => {
        /* REVERSED ON PURPOSE, and this is the second layer of the same bug.
         * This test used to pin the opposite: an uncurated owner "gets the
         * old lenient behaviour" — a keyword guess admits anything that
         * sounds like a statement, from anyone, before the owner has
         * approved a single sender. That is not a curation gap being worked
         * around, it is the owner's senders list having no power over the
         * mailbox until it has already been used once — precisely the
         * report: mail from addresses never added kept arriving regardless
         * of what Senders said.
         *
         * Nothing is lost by refusing it instead: NOT_ON_YOUR_LIST is
         * HOLDABLE (see HOLDABLE below and mail_ingest_test.js), so the
         * sender still surfaces — name, subject, nothing downloaded — for a
         * one-tap approval. That tap, not a keyword match, is now the only
         * thing that ever files a first statement. */
        const r = planMessage(message('statements@hnb.lk', 'hnb.lk'), UNCURATED());
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.NOT_ON_YOUR_LIST);
        expect(HOLDABLE.has(r.reason), 'an uncurated refusal must still be discoverable, not dropped').toBe(true);
    });

    it('a non-bank sender is held the same way while uncurated — never filed on a keyword guess', () => {
        /* The domain does not even have to be a recognised bank for this to
         * matter: `known: false` used to fall through to `looksLikeStatement`
         * for ANY sender while uncurated, so a subject or filename that
         * merely sounded right was enough to file it, from an address the
         * owner had never heard of. */
        const r = planMessage(
            { ...message('estatement@some-random-domain.example', 'some-random-domain.example', 'Your e-Statement is ready'), id: 'MSGX' },
            UNCURATED(),
        );
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.NOT_ON_YOUR_LIST);
    });

    it('a blocked sender is still refused before anything else is considered', () => {
        const blocked = policyFrom([
            { id: 'hnb.lk', kind: 'domain', domain: 'hnb.lk', status: 'blocked', source: 'manual', addedMs: 1 },
            { id: 'estatement@sampath.lk', kind: 'address', domain: 'sampath.lk', status: 'approved', source: 'manual', addedMs: 1 },
        ]);
        expect(planMessage(message('x@hnb.lk', 'hnb.lk'), blocked).reason).toBe(REJECT.SENDER_BLOCKED);
    });

    it('a sender blocked by ONE address, from before the domain-level fix, still refuses its siblings', () => {
        /* THE SECOND ROUND OF THE SAME REPORT. The mailbox card's Block button
         * used to store the exact From address rather than the domain — fixed
         * for blocks made from here on, but every sender blocked before that
         * fix shipped is still sitting in the list as an address-kind entry,
         * exact-matched. Without this, a message from a different address at
         * that same domain would sail straight through: "I blocked it and it
         * came back anyway," reported a second time, about a sender already
         * on the blocked list. */
        const blocked = policyFrom([
            { id: 'noreply@dialog.lk', kind: 'address', domain: 'dialog.lk', status: 'blocked', source: 'manual', addedMs: 1 },
        ]);
        expect(planMessage(message('noreply@dialog.lk', 'dialog.lk'), blocked).reason).toBe(REJECT.SENDER_BLOCKED);
        expect(planMessage(message('billing-alerts@dialog.lk', 'dialog.lk'), blocked).reason).toBe(REJECT.SENDER_BLOCKED);
    });

    it('a failed signature still beats an approval', () => {
        // Approval says "this is one of mine". It has never meant "trust this".
        const bad = { ...message('estatement@sampath.lk', 'sampath.lk') };
        bad.payload.headers[2] = { name: 'Authentication-Results', value: 'mx.google.com; dkim=fail header.d=sampath.lk' };
        expect(planMessage(bad, CURATED()).reason).toBe(REJECT.DKIM_FAILED);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * "I ADDED THE ADDRESS AND THE STATEMENT STILL DID NOT ARRIVE"
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a new desk at a bank they already approved', () => {
    it('is named as a sibling, not as a stranger — and taken on evidence, with no question to the owner', () => {
        const r = planMessage(message('noreply@sampath.lk', 'sampath.lk'), CURATED());
        expect(r.ok).toBe(true);
        expect(r.via).toBe('sibling');
        expect(r.bank).toBe('Sampath Bank');
        expect(r.items[0]).toMatchObject({ via: 'sibling', intent: 'suspect', from: 'noreply@sampath.lk' });
    });

    it('is taken only as a document that must prove itself — the address is still not approved', () => {
        // Who sent it is settled by the evidence (Google's verdict that it is from that domain, the same organisation as an address the
        // owner approved, no lookalike); what it IS is for the document to show. The owner's list is unchanged by it.
        const policy = CURATED();
        expect(policy.decide('noreply@sampath.lk').verdict).not.toBe('approved');
        expect(planMessage(message('noreply@sampath.lk', 'sampath.lk'), policy).items[0].intent).toBe('suspect');
    });

    it('an invoice or a receipt from another desk of the bank is refused as not a statement — not held for a decision', () => {
        for (const subject of ['Your receipt', 'Invoice 4410']) {
            const r = planMessage(message('noreply@sampath.lk', 'sampath.lk', subject), CURATED());
            expect(r.ok, subject).toBe(false);
            expect(r.reason, subject).toBe(REJECT.NOT_A_STATEMENT_DOC);
            expect(HOLDABLE.has(r.reason), subject).toBe(false);
        }
    });

    it('a signature that does not hold still beats the sibling rule', () => {
        const bad = message('noreply@sampath.lk', 'evil.example');
        const r = planMessage(bad, CURATED());
        expect(r.ok).toBe(false);
        expect([REJECT.DKIM_DOMAIN_MISMATCH, REJECT.AUTH_FAILED, REJECT.DKIM_FAILED]).toContain(r.reason);
    });

    it('a different bank entirely is NOT a sibling', () => {
        const r = planMessage(message('noreply@seylan.lk', 'seylan.lk'), CURATED());
        expect(r.reason).toBe(REJECT.NOT_ON_YOUR_LIST);
    });

    it('a legacy DOMAIN approval is recognised as "your bank" for another address there — it authorises nothing by itself', () => {
        const list = [{ id: 'sampath.lk', kind: 'domain', domain: 'sampath.lk', status: 'approved', source: 'manual', addedMs: 1 }];
        expect(relatedApproval(list, 'noreply@sampath.lk')).toMatchObject({ approvedAddress: '', legacyDomain: 'sampath.lk' });
        // and it still does not approve the mailbox: the verdict for the address itself is unchanged
        expect(policyFrom(list).decide('noreply@sampath.lk').verdict).not.toBe('approved');
        // a different bank is not claimed
        expect(relatedApproval(list, 'statements@otherbank.lk')).toBeNull();
    });
    it('another mail host of the same bank is a sibling (info.* and estmt.* are one bank), a different bank is not', () => {
        const list = [{ id: 'estatement@info.nationstrust.com', kind: 'address', domain: 'info.nationstrust.com', status: 'approved', source: 'manual', addedMs: 1 }];
        expect(relatedApproval(list, 'nationstrust@estmt.nationstrust.com')).toMatchObject({ approvedAddress: 'estatement@info.nationstrust.com' });
        expect(relatedApproval(list, 'x@nationstrust.com.evil.net')).toBeNull();
        expect(relatedApproval(list, 'x@othertrust.com')).toBeNull();
    });
    it('and never on a blocked or undecided entry', () => {
        for (const status of ['blocked', 'new']) {
            const list = [{ id: 'estatement@sampath.lk', kind: 'address', domain: 'sampath.lk', status, source: 'manual', addedMs: 1 }];
            expect(relatedApproval(list, 'noreply@sampath.lk')).toBeNull();
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * NOTHING IS DROPPED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a refusal holds the message instead of losing it', () => {
    it('holds an unlisted sender (a sibling of an approved bank is taken instead — nothing to hold)', () => {
        const from = 'noreply@seylan.lk';
        const msg = message(from, 'seylan.lk');
        const held = planHold(planMessage(msg, CURATED()), msg);
        expect(held, from).toBeTruthy();
        expect(held.messageId).toBe('MSG1');
        expect(HOLDABLE.has(held.reason)).toBe(true);
        const sibling = message('noreply@sampath.lk', 'sampath.lk');
        expect(planHold(planMessage(sibling, CURATED()), sibling)).toBeNull();
    });

    it('holds the REFERENCE only — no attachment is fetched on a refusal', () => {
        const msg = message('noreply@seylan.lk', 'seylan.lk');
        const held = planHold(planMessage(msg, CURATED()), msg);
        const json = JSON.stringify(held);
        expect(json).not.toContain('attachmentId');
        expect(json).not.toContain('ATT1');
        expect(held.messageId).toBeTruthy();     // enough to fetch it later
    });

    it('does NOT hold a refusal that approving a sender cannot fix', () => {
        // A failed signature is not a question about who the owner trusts, and
        // holding it would put unverifiable mail in a queue that implies it is
        // one tap from being filed.
        const bad = { ...message('estatement@sampath.lk', 'sampath.lk') };
        bad.payload.headers[2] = { name: 'Authentication-Results', value: 'mx.google.com; dkim=fail header.d=sampath.lk' };
        expect(planHold(planMessage(bad, CURATED()), bad)).toBeNull();
    });

    it('does not hold a message that was accepted', () => {
        const msg = message('estatement@sampath.lk', 'sampath.lk');
        expect(planHold(planMessage(msg, CURATED()), msg)).toBeNull();
    });

    it('APPROVING THE SENDER RELEASES IT — the half that was missing', () => {
        const msg = message('noreply@seylan.lk', 'seylan.lk');
        const held = planHold(planMessage(msg, CURATED()), msg);
        expect(releasedBy(held, CURATED().decide)).toBe(false);

        const after = policyFrom([
            { id: 'noreply@seylan.lk', kind: 'address', domain: 'seylan.lk', status: 'approved', source: 'manual', addedMs: 1 },
        ]);
        expect(releasedBy(held, after.decide)).toBe(true);
    });

    it('approving a DIFFERENT sender releases nothing', () => {
        const msg = message('noreply@seylan.lk', 'seylan.lk');
        const held = planHold(planMessage(msg, CURATED()), msg);
        const other = policyFrom([{ id: 'othernew.lk', kind: 'domain', domain: 'othernew.lk', status: 'approved', source: 'manual', addedMs: 1 }]);
        expect(releasedBy(held, other.decide)).toBe(false);
    });

    it('never throws on a held record read back from storage', () => {
        for (const junk of [null, undefined, {}, { from: 5 }]) {
            expect(() => releasedBy(junk, CURATED().decide)).not.toThrow();
        }
        expect(releasedBy({ from: 'x@y.lk' }, null)).toBe(false);
    });
});

describe('the held list is bounded, de-duplicated and honestly timestamped', () => {
    it('redelivery does not turn one refused statement into fifty rows', () => {
        // A push and a scan see the same message. Redelivery is normal.
        let list = mergeHeld(null, [{ messageId: 'M1', from: 'a@b.lk' }], 1000);
        for (let i = 0; i < 20; i++) list = mergeHeld(list, [{ messageId: 'M1', from: 'a@b.lk' }], 2000 + i);
        expect(list).toHaveLength(1);
    });

    it('keeps the FIRST refusal time, not the most recent redelivery', () => {
        // "Held since the 3rd" is the sentence that tells the owner how long
        // they have been missing a statement. Overwriting the stamp made every
        // held message look like it arrived today.
        const first = mergeHeld(null, [{ messageId: 'M1' }], 1000);
        const again = mergeHeld(first, [{ messageId: 'M1' }], 9000);
        expect(again[0].heldMs).toBe(1000);
    });

    it('stamps a new one, so no row is ever undated', () => {
        expect(mergeHeld(null, [{ messageId: 'M2' }], 4242)[0].heldMs).toBe(4242);
    });

    it('a junk mailbox cannot fill the database', () => {
        const many = Array.from({ length: 900 }, (_, i) => ({ messageId: `X${i}` }));
        expect(mergeHeld(null, many)).toHaveLength(MAX_HELD);
    });

    it('newest first — the incoming batch leads', () => {
        const out = mergeHeld([{ messageId: 'OLD' }], [{ messageId: 'NEW' }]);
        expect(out.map((h) => h.messageId)).toEqual(['NEW', 'OLD']);
    });

    it('drops rows with no message id rather than storing an unfetchable one', () => {
        expect(mergeHeld(null, [{ from: 'a@b.lk' }, null, 'x', 5, { messageId: '  ' }])).toEqual([]);
    });

    it('reads a stored document, and an absent field is an empty list', () => {
        expect(heldOf({ [HELD_FIELD]: [{ messageId: 'M1' }] })).toHaveLength(1);
        expect(heldOf({})).toEqual([]);
        expect(heldOf(null)).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * BOTH SERVER PATHS, NOT ONE
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the push hook and the scan endpoint both hold', () => {
    // A rule kept in one of this pair and not the other is this repository's
    // most repeated defect, and these two files have already drifted once.
    // ESM imports, not require(). test/esm_require_test.js bans `require` in
    // these files because it throws ReferenceError at runtime — and it caught
    // this one in CI while the local run passed, because that guard reads
    // `git ls-files` and the file was not staged yet when I ran the suite.
    const read = (f) => fs.readFileSync(path.resolve(import.meta.dirname, '..', f), 'utf8');

    it.each(['gmail-hook.js', 'gmail-scan.js'])('%s holds a refusal instead of dropping it', (file) => {
        const src = read(file);
        expect(src).toContain('planHold(plan, msg)');
        expect(src).toContain('held.push(hold)');
        expect(src).toContain('mergeHeld(');
    });

    it('approving a sender reports what it released', () => {
        const src = read('gmail-link.js');
        expect(src).toContain('releasedBy(h, decide)');
        expect(src).toContain('releasable:');
        expect(src).toContain('released:');
    });
});
