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
    addressOf, domainOf, isUnder, dkimPassedFor, identifyBank, selectAttachments,
    itemKey, stableItemKey, planWrite, planMessage, isWorthTelling, looksLikeStatement,
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

    /* ── A DISPLAY NAME IS NOT AN ADDRESS ────────────────────────────────
     *
     * The header is `display-name <addr-spec>`, and the display name may be a
     * quoted string holding anything at all — including something shaped
     * exactly like an address in angle brackets. Every reader here took the
     * FIRST angled group, which is the one the sender wrote inside the quotes.
     *
     * Downstream that meant a signature checked against a domain the message
     * never claimed — a real statement refused — and, on the mailbox card, a
     * row attributed to somebody who never sent it: a row the owner can
     * approve, block or delete by mistake. */
    it.each([
        ['HNB <statements@hnb.lk>', 'statements@hnb.lk'],
        ['statements@hnb.lk', 'statements@hnb.lk'],
        ['<statements@hnb.lk>', 'statements@hnb.lk'],
        ['mailto:statements@hnb.lk', 'statements@hnb.lk'],
        ['  HNB  <STATEMENTS@HNB.LK> ,', 'statements@hnb.lk'],
        /* The quoted display name names one address; the real one is last. */
        ['"Statements <first@display.example>" <real@hnb.lk>', 'real@hnb.lk'],
        /* An escaped quote does not end the display name early. */
        ['"a\\" <first@display.example>" <real@hnb.lk>', 'real@hnb.lk'],
        /* An unterminated quote matches nothing, so the brackets still decide
         * rather than the whole header being swallowed. */
        ['"unterminated <real@hnb.lk>', 'real@hnb.lk'],
        ['', ''],
    ])('takes the address out of %s', (from, want) => {
        expect(addressOf(from)).toBe(want);
    });

    it('the domain follows the address, so the two cannot name different people', () => {
        const from = '"Statements <first@display.example>" <real@hnb.lk>';
        expect(domainOf(from)).toBe('hnb.lk');
        expect(addressOf(from).endsWith('@' + domainOf(from))).toBe(true);
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
        /* An unlisted sender is no longer REJECTED — it is accepted as unknown
         * and held for review. See the block below for why that is not a
         * loosening of the check that matters. */
        const unlisted = identifyBank({
            from: '<a@anything-not-listed.com>',
            'authentication-results': 'dkim=pass header.i=@anything-not-listed.com',
        });
        expect(unlisted.ok).toBe(true);
        expect(unlisted.known).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A BANK NOBODY LISTED IS STILL A BANK
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * BANKS names four institutions. The owner banks with more than ten, and
 * index.html's own dropdown lists fifteen, so eleven banks' statements were
 * dropped here with `sender-not-on-allowlist`.
 *
 * The allowlist was doing two jobs and only one was security. Naming the bank
 * is useful; GATING on it never was. The control is DKIM — the message must
 * carry a passing signature from the domain it claims to be from — and that
 * works for any domain. An unlisted sender that clears it is exactly as
 * verified as HNB, merely unrecognised, so it is held for review rather than
 * dropped or auto-filed.
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('an unlisted but verified sender is held, not dropped', () => {
    const auth = (d) => `spf=pass; dkim=pass header.i=@${d}; dmarc=pass`;

    it.each([
        ['sampathbank.lk', 'Sampathbank'],
        ['combank.lk', 'Combank'],
        ['boc.lk', 'Boc'],
        ['seylan.lk', 'Seylan'],
        ['ndbbank.com', 'Ndbbank'],
    ])('%s is accepted as unknown, named %s', (domain, name) => {
        const r = identifyBank({ from: `<estatement@${domain}>`, 'authentication-results': auth(domain) });
        expect(r.ok, `${domain} was rejected — this is the bug`).toBe(true);
        expect(r.known).toBe(false);
        expect(r.bank).toBe(name);
        expect(r.domain).toBe(domain);
    });

    it('a listed bank is still marked known, so it is filed rather than held', () => {
        const r = identifyBank({ from: '<statements@hnb.lk>', 'authentication-results': auth('hnb.lk') });
        expect(r.ok).toBe(true);
        expect(r.known).toBe(true);
        expect(r.bank).toBe('HNB');
    });

    it('an unlisted sender with NO valid signature is still refused', () => {
        /* The widening is in what gets FETCHED and QUEUED, never in what gets
         * trusted. */
        for (const auths of ['dkim=fail header.i=@sampathbank.lk', '', 'spf=pass']) {
            const r = identifyBank({ from: '<x@sampathbank.lk>', 'authentication-results': auths });
            expect(r.ok, `accepted with auth "${auths}"`).toBe(false);
            expect(r.reason).toBe(REJECT.DKIM_FAILED);
        }
    });

    it('an unlisted sender signed by SOMEONE ELSE is still refused', () => {
        const r = identifyBank({
            from: '<x@sampathbank.lk>',
            'authentication-results': 'dkim=pass header.i=@mailchimp-bulk.net',
        });
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.DKIM_DOMAIN_MISMATCH);
    });

    it('a LOOKALIKE of a listed bank is refused, signature or not', () => {
        /* hnb.lk.attacker.net holds a valid signature for itself. It is not an
         * unrecognised bank; it is an attempt to be mistaken for a listed one,
         * and it must not reach a queue where it sits beside the real HNB. */
        for (const d of ['hnb.lk.attacker.net', 'dfcc.lk.evil.com', 'my-amex.com.phish.io']) {
            const r = identifyBank({ from: `<a@${d}>`, 'authentication-results': auth(d) });
            expect(r.ok, `${d} was accepted`).toBe(false);
            expect(r.reason).toBe(REJECT.NOT_A_BANK);
        }
    });

    it('a personal mailbox is refused even though its signature is genuine', () => {
        /* Anyone with a Gmail account gets a passing gmail.com signature, so
         * here a signature is the default rather than evidence. */
        for (const d of ['gmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'proton.me']) {
            const r = identifyBank({ from: `<friend@${d}>`, 'authentication-results': auth(d) });
            expect(r.ok, `${d} was accepted`).toBe(false);
            expect(r.reason).toBe(REJECT.NOT_A_BANK);
        }
    });

    it('an unrecognised sender that says nothing about a statement is refused', () => {
        /* The other half of the trade. Widening the allowlist without this
         * would swap eleven dropped banks for a review queue full of shop
         * receipts, and a queue nobody can face is the same as no queue. */
        const flyer = {
            id: 'j1',
            internalDate: '1700000000000',
            payload: {
                headers: [
                    { name: 'From', value: 'Deals <offers@shopping.example>' },
                    { name: 'Subject', value: 'SALE' },
                    { name: 'Authentication-Results', value: auth('shopping.example') },
                ],
                parts: [{ filename: 'flyer.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a9', size: 100 } }],
            },
        };
        const r = planMessage(flyer);
        expect(r.ok).toBe(false);
        expect(r.reason).toBe(REJECT.NOT_A_STATEMENT);
    });

    it('the FILENAME alone is enough to call it a statement', () => {
        /* Plenty of banks send Statement_Aug2026.pdf under a subject that says
         * nothing, which is why the gate runs after the attachments are
         * selected rather than on the headers alone. */
        const msg = {
            id: 'f1',
            internalDate: '1700000000000',
            payload: {
                headers: [
                    { name: 'From', value: '<no-reply@sampathbank.lk>' },
                    { name: 'Subject', value: 'Your monthly document' },
                    { name: 'Authentication-Results', value: auth('sampathbank.lk') },
                ],
                parts: [{ filename: 'Statement_Aug2026.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }],
            },
        };
        const r = planMessage(msg);
        expect(r.ok, r.reason).toBe(true);
        expect(r.items[0].known).toBe(false);
    });

    it('a KNOWN bank skips the statement-shape gate entirely', () => {
        /* HNB may title its statement whatever it likes. */
        const msg = {
            id: 'k1',
            internalDate: '1700000000000',
            payload: {
                headers: [
                    { name: 'From', value: '<x@hnb.lk>' },
                    { name: 'Subject', value: 'hello' },
                    { name: 'Authentication-Results', value: auth('hnb.lk') },
                ],
                parts: [{ filename: 'doc.pdf', mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 100 } }],
            },
        };
        expect(planMessage(msg).ok).toBe(true);
    });

    it('looksLikeStatement reads the subject and the filenames, case-blind', () => {
        expect(looksLikeStatement({ subject: 'Your E-Statement is ready' })).toBe(true);
        expect(looksLikeStatement({ subject: 'x', filenames: ['AUG-STATEMENT.PDF'] })).toBe(true);
        expect(looksLikeStatement({ subject: 'Credit Advice' })).toBe(true);
        expect(looksLikeStatement({ subject: 'SALE', filenames: ['flyer.pdf'] })).toBe(false);
        expect(looksLikeStatement({})).toBe(false);
    });

    it('planMessage carries the known flag onto every item it plans', () => {
        /* The flag is what the write path routes on. If it stopped being
         * carried, every unknown bank would file itself silently. */
        const msg = (fromDomain) => ({
            id: 'm1',
            internalDate: '1700000000000',
            payload: {
                headers: [
                    { name: 'From', value: `<s@${fromDomain}>` },
                    { name: 'Authentication-Results', value: auth(fromDomain) },
                    { name: 'Subject', value: 'Your e-statement' },
                ],
                parts: [{ filename: 's.pdf', mimeType: 'application/pdf', body: { attachmentId: 'A1', size: 1000 } }],
            },
        });
        expect(planMessage(msg('hnb.lk')).items[0].known).toBe(true);
        expect(planMessage(msg('sampathbank.lk')).items[0].known).toBe(false);
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
            /* The key is built from the MIME part, not from Gmail's
             * attachmentId — see stableItemKey. The legacy name is carried
             * alongside so the write path can recognise what it already has. */
            key: stableItemKey('MSG1', { filename: 'stmt.pdf', size: 250000 }),
            legacyKey: itemKey('MSG1', 'ATT1'),
            bank: 'HNB', filename: 'stmt.pdf',
            messageId: 'MSG1', receivedMs: 1787820000000, subject: 'Your e-Statement',
        });
    });

    it('THE DUPLICATE BUG: the same attachment refetched keys the same', () => {
        /* Gmail's attachmentId is an opaque token minted for
         * messages.attachments.get, not a content identifier, and it is not
         * contracted to survive between messages.get calls. When it changed,
         * the item key changed, the "already have it" lookup in gmail-hook.js
         * and gmail-scan.js found nothing, and the statement was downloaded
         * and written a SECOND time. The owner's report is exactly that:
         * press check a few times, or reload, and the same statements appear
         * again beside themselves.
         *
         * messageId is stable; within one message the filename and size are
         * properties of the MIME part rather than per-request tokens. */
        const first = planMessage(message('<s@hnb.lk>', GOOD_AUTH, [pdf('stmt.pdf', 250000, 'ATT-FIRST')]));
        const again = planMessage(message('<s@hnb.lk>', GOOD_AUTH, [pdf('stmt.pdf', 250000, 'ATT-REMINTED')]));

        expect(first.items[0].key).toBe(again.items[0].key);
        expect(first.items[0].key, 'the key still contains the volatile token')
            .not.toContain('ATT-FIRST');
        /* And the OLD key would have differed — which is the bug, stated. */
        expect(first.items[0].legacyKey).not.toBe(again.items[0].legacyKey);
    });

    it('two different attachments on one message still key apart', () => {
        /* The fix must not over-merge: a message carrying two statements is
         * two documents, not one. */
        const r = planMessage(message('<s@hnb.lk>', GOOD_AUTH, [
            pdf('january.pdf', 1000, 'A1'),
            pdf('february.pdf', 2000, 'A2'),
        ]));
        expect(r.items).toHaveLength(2);
        expect(r.items[0].key).not.toBe(r.items[1].key);
    });

    it('same filename, different size, keys apart', () => {
        /* Banks reuse `statement.pdf` every month. Size is what separates
         * them when the message is the same. */
        const a = stableItemKey('M', { filename: 'statement.pdf', size: 1000 });
        const b = stableItemKey('M', { filename: 'statement.pdf', size: 2000 });
        expect(a).not.toBe(b);
    });

    it('falls back to the attachment id when a part has no filename', () => {
        /* Some banks attach an unnamed part. Keeping SOME key is better than
         * dropping the statement, and it is no worse than what this replaces. */
        const k = stableItemKey('M', { filename: '', size: 10, attachmentId: 'A9' });
        expect(k).toBe('M.A9');
        expect(stableItemKey('M', { filename: '', size: 10 })).toBeNull();
        expect(stableItemKey('', { filename: 'x.pdf', size: 1 })).toBeNull();
    });

    it('produces a name Firestore accepts', () => {
        const k = stableItemKey('m/1', { filename: 'Aug 2026 · statement.pdf', size: 42 });
        expect(k).not.toContain('/');
        expect(k).toMatch(/^[A-Za-z0-9_.-]+$/);
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
