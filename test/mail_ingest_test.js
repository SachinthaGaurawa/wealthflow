/* =============================================================================
 * test/mail_ingest_test.js
 * -----------------------------------------------------------------------------
 * wealthflow-mail-ingest.mjs is the server half: given a Gmail message, decide
 * whether it is a bank statement, which attachment to take, and how to store
 * it. It never decrypts and never holds a password.
 *
 * THE PROPERTY THAT MATTERS IS THAT A FROM HEADER IS NOT EVIDENCE.
 *
 * The obvious rule — "from @hnb.lk with a PDF attached" — is an open door.
 * A From header is a string the sender chooses. Anyone can write
 * `statements@hnb.lk` in it, attach a PDF of invented transactions, and have
 * those numbers routed into someone's ledger; the parser would read them and
 * the router would file them, both working exactly as designed.
 *
 * So the tests below are mostly attacks. Each one is a message that LOOKS like
 * a bank statement and must not be taken:
 *
 *   the right From, no signature at all
 *   the right From, a signature that failed
 *   the right From, a valid signature by somebody else
 *   a failed result for the real domain next to a passing one for the attacker
 *   a domain that merely starts with the bank's name
 *
 * The last two are the ones a looser implementation gets wrong: a header
 * carrying several dkim= results, and a suffix match that is not anchored to a
 * label boundary.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import G, {
    BANKS, REJECT, REJECT_TEXT, SINGLE_MAX, CHUNK_SIZE, MAX_BASE64, MAX_ATTACHMENTS,
    domainOf, isUnder, dkimPassedFor, identifyBank, selectAttachments,
    itemKey, planWrite, planMessage, isWorthTelling,
} from '../wealthflow-mail-ingest.mjs';

const hdrs = (o) => Object.entries(o).map(([name, value]) => ({ name, value }));
const pdf = (filename, size, attachmentId) => ({
    filename, mimeType: 'application/pdf', body: { attachmentId, size },
});
const message = (from, auth, parts, extra = {}) => ({
    id: 'MSG1', internalDate: '1787820000000',
    payload: {
        headers: hdrs({ From: from, 'Authentication-Results': auth, Subject: 'Your e-Statement', ...extra }),
        parts,
    },
});
const GOOD_AUTH = 'mx.google.com; dkim=pass header.i=@hnb.lk; spf=pass; dmarc=pass';

/* ═══════════════════════════════════════════════════════════════════════════
 * READING THE FROM HEADER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the sender domain', () => {
    it.each([
        ['HNB Statements <statements@hnb.lk>', 'hnb.lk'],
        ['statements@hnb.lk', 'hnb.lk'],
        ['"Bank, The" <no-reply@E.AMEX.COM>', 'e.amex.com'],
        ['  <a@b.co>  ', 'b.co'],
        ['weird@@double.com', 'double.com'],
        ['no-at-sign', ''],
        ['', ''],
    ])('reads %s as %s', (from, want) => {
        expect(domainOf(from)).toBe(want);
    });

    it('anchors a suffix match to a label boundary', () => {
        // The whole point: `hnb.lk.attacker.net` ends with neither `.hnb.lk`
        // nor equals it, and a naive `endsWith('hnb.lk')` would accept
        // `nothnb.lk` too.
        expect(isUnder('hnb.lk', 'hnb.lk')).toBe(true);
        expect(isUnder('mail.hnb.lk', 'hnb.lk')).toBe(true);
        expect(isUnder('hnb.lk.attacker.net', 'hnb.lk')).toBe(false);
        expect(isUnder('nothnb.lk', 'hnb.lk')).toBe(false);
        expect(isUnder('', 'hnb.lk')).toBe(false);
        expect(isUnder('hnb.lk', '')).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * READING GOOGLE'S VERDICT, NOT THE SENDER'S CLAIM
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the DKIM result', () => {
    it('collects the domain of each PASS', () => {
        expect([...dkimPassedFor('mx.google.com; dkim=pass header.i=@hnb.lk; spf=pass')]).toEqual(['hnb.lk']);
    });

    it('ignores a FAIL, however the domain is spelled next to it', () => {
        expect([...dkimPassedFor('dkim=fail header.i=@hnb.lk')]).toEqual([]);
        expect([...dkimPassedFor('dkim=neutral header.d=hnb.lk')]).toEqual([]);
        expect([...dkimPassedFor('dkim=temperror header.i=@hnb.lk')]).toEqual([]);
    });

    it('pairs each result with ITS OWN identity, not with any in the line', () => {
        /* THE CASE A LOOSER PARSER GETS WRONG.
         *
         * "dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net" contains
         * both the word `pass` and the domain `hnb.lk`. An implementation that
         * asks "is there a pass?" and separately "is the domain mentioned?"
         * reads this as hnb.lk passing. It did not. */
        const got = dkimPassedFor('mx.google.com; dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net');
        expect(got.has('hnb.lk')).toBe(false);
        expect(got.has('evil.net')).toBe(true);
    });

    it('handles several passes and an empty header', () => {
        expect([...dkimPassedFor('dkim=pass header.i=@a.com; dkim=pass header.d=b.com')].sort())
            .toEqual(['a.com', 'b.com']);
        expect([...dkimPassedFor('')]).toEqual([]);
        expect([...dkimPassedFor(undefined)]).toEqual([]);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ATTACKS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('a message that merely claims to be from a bank is refused', () => {
    it('accepts a genuine one', () => {
        const r = identifyBank({ from: '<statements@hnb.lk>', 'authentication-results': GOOD_AUTH });
        expect(r).toMatchObject({ ok: true, bank: 'HNB', domain: 'hnb.lk' });
    });

    it('accepts a subdomain the bank actually sends from', () => {
        expect(identifyBank({
            from: '<no-reply@e.amex.com>',
            'authentication-results': 'dkim=pass header.i=@amex.com',
        })).toMatchObject({ ok: true, bank: 'American Express' });
    });

    it.each([
        ['no signature at all', '<statements@hnb.lk>', 'mx.google.com; spf=fail', REJECT.DKIM_FAILED],
        ['a signature that failed', '<statements@hnb.lk>', 'dkim=fail header.i=@hnb.lk', REJECT.DKIM_FAILED],
        ['a valid signature by somebody else', '<statements@hnb.lk>', 'dkim=pass header.i=@evil.net', REJECT.DKIM_DOMAIN_MISMATCH],
        ['a fail for the bank beside a pass for the attacker', '<statements@hnb.lk>',
            'dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net', REJECT.DKIM_DOMAIN_MISMATCH],
        ['a domain that only starts with the bank name', '<x@hnb.lk.attacker.net>',
            'dkim=pass header.i=@hnb.lk.attacker.net', REJECT.NOT_A_BANK],
        ['an ordinary sender', '<friend@gmail.com>', 'dkim=pass header.i=@gmail.com', REJECT.NOT_A_BANK],
        ['a missing From', '', GOOD_AUTH, REJECT.NOT_A_BANK],
    ])('refuses %s', (_why, from, auth, reason) => {
        const r = identifyBank({ from, 'authentication-results': auth });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(reason);
    });

    it('reads headers whatever case Gmail sends them in', () => {
        expect(identifyBank({ From: '<s@hnb.lk>', 'Authentication-Results': GOOD_AUTH }).ok).toBe(true);
    });

    it('the allowlist is an allowlist: only these domains, and each has a name', () => {
        // A denylist wearing the name is a defect this repository has shipped
        // before, so the shape is asserted rather than assumed.
        expect(BANKS.length).toBeGreaterThan(0);
        for (const b of BANKS) {
            expect(b.domain).toMatch(/^[a-z0-9.-]+$/);
            expect(b.name.length).toBeGreaterThan(1);
        }
        expect(identifyBank({ from: '<a@anything-not-listed.com>', 'authentication-results': 'dkim=pass header.i=@anything-not-listed.com' }).ok)
            .toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHOOSING THE ATTACHMENT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('which attachment to take', () => {
    it('finds a PDF nested arbitrarily deep', () => {
        const r = selectAttachments({ parts: [{ mimeType: 'multipart/mixed', parts: [{ parts: [pdf('deep.pdf', 100, 'A')] }] }] });
        expect(r.ok).toBe(true);
        expect(r.take.map((t) => t.filename)).toEqual(['deep.pdf']);
    });

    it('takes a .pdf sent as octet-stream, which banks do', () => {
        const r = selectAttachments({ parts: [{ filename: 'stmt.PDF', mimeType: 'application/octet-stream', body: { attachmentId: 'A', size: 10 } }] });
        expect(r.ok).toBe(true);
    });

    it('ignores a part with no attachmentId, even when it is a named PDF', () => {
        /* The first version of this test used a part with no FILENAME, so it
         * never reached the attachmentId clause it was named for — a mutation
         * deleting that clause survived it. This is the case that matters: a
         * part Gmail describes with a filename but no fetchable id. Selecting
         * it sends `attachmentId: undefined` to the fetch. */
        const r = selectAttachments({ parts: [{ filename: 'inline.pdf', mimeType: 'application/pdf', body: { size: 10 } }] });
        expect(r.ok, 'a part with no attachmentId cannot be fetched').toBe(false);
        expect(r.reason).toBe(REJECT.NO_ATTACHMENT);
    });

    it('and ignores an unnamed part too', () => {
        const r = selectAttachments({ parts: [{ mimeType: 'application/pdf', body: { size: 10 } }] });
        expect(r.ok).toBe(false);
    });

    it('never selects an item without an attachmentId to fetch', () => {
        // The property behind both: whatever is taken must be fetchable.
        const r = selectAttachments({ parts: [
            { filename: 'inline.pdf', mimeType: 'application/pdf', body: { size: 10 } },
            pdf('real.pdf', 100, 'A'),
        ] });
        expect(r.ok).toBe(true);
        for (const t of r.take) expect(t.attachmentId, JSON.stringify(t)).toBeTruthy();
        expect(r.take).toHaveLength(1);
    });

    it.each([
        ['no attachments', { parts: [{ mimeType: 'text/html', body: { size: 5 } }] }, REJECT.NO_ATTACHMENT],
        ['nothing at all', {}, REJECT.NO_ATTACHMENT],
        ['null', null, REJECT.NO_ATTACHMENT],
    ])('refuses %s', (_w, payload, reason) => {
        expect(selectAttachments(payload).reason).toBe(reason);
    });

    it('refuses a message carrying more attachments than a statement would', () => {
        const parts = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => pdf(`s${i}.pdf`, 10, `A${i}`));
        expect(selectAttachments({ parts }).reason).toBe(REJECT.TOO_MANY);
    });

    it('skips one that cannot be stored, and says so rather than truncating it', () => {
        const parts = [pdf('big.pdf', 20 * 1024 * 1024, 'BIG'), pdf('ok.pdf', 1000, 'OK')];
        const r = selectAttachments({ parts });
        expect(r.ok).toBe(true);
        expect(r.take.map((t) => t.filename)).toEqual(['ok.pdf']);
        expect(r.skipped[0]).toMatchObject({ filename: 'big.pdf', reason: REJECT.TOO_LARGE });
    });

    it('refuses outright when every attachment is too large', () => {
        expect(selectAttachments({ parts: [pdf('big.pdf', 20 * 1024 * 1024, 'BIG')] }).reason)
            .toBe(REJECT.TOO_LARGE);
    });

    it('measures the size in the units it will be STORED in, not the raw bytes', () => {
        /* base64 is 4 chars per 3 bytes, so a payload 3/4 of the ceiling in raw
         * bytes is exactly at it once encoded. Comparing raw bytes to a base64
         * ceiling would accept a payload the store cannot hold, and the failure
         * would land after the download rather than before it. */
        const justUnder = Math.floor(MAX_BASE64 * 3 / 4) - 16;
        const justOver = Math.floor(MAX_BASE64 * 3 / 4) + 16;
        expect(selectAttachments({ parts: [pdf('a.pdf', justUnder, 'A')] }).ok).toBe(true);
        expect(selectAttachments({ parts: [pdf('a.pdf', justOver, 'A')] }).ok).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * STORING IT
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the write plan', () => {
    it('keeps a small payload in the manifest itself', () => {
        const r = planWrite('x'.repeat(1000), { bank: 'HNB' });
        expect(r).toMatchObject({ ok: true, chunked: false });
        expect(r.parts).toEqual([]);
        expect(r.manifest).toMatchObject({ bank: 'HNB', parts: 0 });
        expect(r.manifest.d).toHaveLength(1000);
    });

    it('splits at the boundary, not one character early or late', () => {
        expect(planWrite('x'.repeat(SINGLE_MAX)).chunked).toBe(false);
        expect(planWrite('x'.repeat(SINGLE_MAX + 1)).chunked).toBe(true);
    });

    it('numbers every part and records the count that proves completeness', () => {
        const r = planWrite('x'.repeat(CHUNK_SIZE * 2 + 5));
        expect(r.parts.map((p) => p.i)).toEqual([0, 1, 2]);
        expect(r.manifest.parts).toBe(3);
        expect(r.parts.reduce((n, p) => n + p.d.length, 0)).toBe(CHUNK_SIZE * 2 + 5);
    });

    it('never puts the payload in the manifest when chunked', () => {
        // The manifest is written LAST and its presence means "all parts
        // landed". A manifest that also carried data would be a fourth part
        // whose own arrival nothing vouches for.
        const r = planWrite('x'.repeat(CHUNK_SIZE + 1));
        expect(r.manifest.d).toBeUndefined();
    });

    it('refuses a payload past the ceiling instead of dropping the tail', () => {
        expect(planWrite('x'.repeat(MAX_BASE64 + 1)).reason).toBe(REJECT.TOO_LARGE);
    });

    it('refuses an empty payload', () => {
        expect(planWrite('').ok).toBe(false);
        expect(planWrite(null).ok).toBe(false);
    });
});

describe('redelivery writes the same document', () => {
    it('is stable for the same message and attachment', () => {
        // Pub/Sub is at-least-once by design; a redelivery is the normal case.
        expect(itemKey('MSG1', 'ATT1')).toBe(itemKey('MSG1', 'ATT1'));
    });

    it('separates two attachments on one message', () => {
        expect(itemKey('MSG1', 'ATT1')).not.toBe(itemKey('MSG1', 'ATT2'));
    });

    it('separates the same attachment id on two messages', () => {
        expect(itemKey('MSG1', 'ATT1')).not.toBe(itemKey('MSG2', 'ATT1'));
    });

    it('produces a name Firestore accepts', () => {
        expect(itemKey('MSG/1', 'ATT..2')).toMatch(/^[A-Za-z0-9_.-]+$/);
    });

    it('refuses to key on a missing id rather than inventing one', () => {
        expect(itemKey('', 'ATT')).toBe(null);
        expect(itemKey('MSG', '')).toBe(null);
        expect(itemKey(null, null)).toBe(null);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WHOLE DECISION
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('planMessage', () => {
    it('settles identity BEFORE it looks at any attachment', () => {
        /* Order is the point: a message from an unrecognised sender must never
         * reach the code that would download from it. A spoofed message with a
         * perfectly good PDF is rejected on the signature, not on the PDF. */
        const r = planMessage(message('<s@hnb.lk>', 'dkim=pass header.i=@evil.net', [pdf('a.pdf', 1000, 'A')]));
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.DKIM_DOMAIN_MISMATCH);
        expect(r.items, 'an attachment was selected from a message that failed identity').toBeUndefined();
    });

    it('carries the bank, the message and the arrival time onto every item', () => {
        const r = planMessage(message('<s@hnb.lk>', GOOD_AUTH, [{ mimeType: 'text/html', body: { size: 9 } }, pdf('stmt.pdf', 250000, 'ATT1')]));
        expect(r.ok).toBe(true);
        expect(r.items).toHaveLength(1);
        expect(r.items[0]).toMatchObject({
            key: itemKey('MSG1', 'ATT1'), bank: 'HNB', filename: 'stmt.pdf',
            messageId: 'MSG1', receivedMs: 1787820000000, subject: 'Your e-Statement',
        });
    });

    it('names the bank even on a refusal, so the message can say which', () => {
        const r = planMessage(message('<s@hnb.lk>', GOOD_AUTH, [{ mimeType: 'text/html', body: { size: 9 } }]));
        expect(r.ok).toBe(false);
        expect(r.bank).toBe('HNB');
    });

    it('survives a message with no payload at all', () => {
        expect(planMessage({ id: 'X' }).ok).toBe(false);
        expect(planMessage(null).ok).toBe(false);
        expect(planMessage({}).ok).toBe(false);
    });
});

describe('what is worth telling the user about', () => {
    it('says nothing about ordinary mail', () => {
        // Most of a mailbox is not a statement. Reporting that would make the
        // pipeline unusable.
        expect(isWorthTelling({ ok: false, reason: REJECT.NOT_A_BANK })).toBe(false);
        expect(isWorthTelling({ ok: false, reason: REJECT.NO_ATTACHMENT })).toBe(false);
    });

    it('speaks up when a real bank’s statement could not be taken', () => {
        for (const r of [REJECT.TOO_LARGE, REJECT.TOO_MANY, REJECT.DKIM_FAILED, REJECT.DKIM_DOMAIN_MISMATCH]) {
            expect(isWorthTelling({ ok: false, reason: r }), `${r} would pass silently`).toBe(true);
        }
    });

    it('never speaks up about a success', () => {
        expect(isWorthTelling({ ok: true })).toBe(false);
        expect(isWorthTelling(null)).toBe(false);
    });

    it('every reason has a sentence, and every sentence a reason', () => {
        expect(Object.keys(REJECT_TEXT).sort()).toEqual(Object.values(REJECT).sort());
    });
});

describe('the module surface', () => {
    it('decides and plans — it never decrypts', () => {
        for (const k of Object.keys(G)) {
            expect(k, `${k} reads like it opens the PDF`).not.toMatch(/^(decrypt|unlock|open|parse)/i);
        }
    });
});
