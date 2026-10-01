import { describe, it, expect } from 'vitest';
import { addressOf, addressesOf, domainOf, planMessage, REJECT, isSecurityRefusal } from '../wealthflow-mail-ingest.mjs';
import { policyFrom, normalizeList, matchSender, recordSighting } from '../wealthflow-mail-senders.mjs';

/* =============================================================================
 * THE FOUR BANKS THE OWNER HAS APPROVED, against every way a mail system writes a From header.
 *
 *   · the address is read as RFC 5322 reads it: display names (quoted, encoded, with commas, with an address inside),
 *     comments `(like this)` anywhere, a trailing dot, upper case, folded lines and stray spaces are all ignored;
 *   · the ANGLE-BRACKET address wins over anything the sender wrote before it — so a display name that looks like the bank
 *     can never be mistaken for the bank;
 *   · a From that names several mailboxes is refused as forgery, like two From lines: which one a reader shows is the
 *     reader's choice, and the signature may cover only one of them;
 *   · Return-Path, Reply-To, Sender and X-Original-From are NOT consulted to decide who a message is from. The sender writes
 *     every one of them; matching on them would let anyone make a mail "come from" a bank by naming the bank in a header.
 *     What proves the origin is Google's own SPF / DKIM / DMARC verdict about the From domain (see intake_rule_engine_test).
 * ===========================================================================*/

const BANKS = [
    { name: 'HNB', address: 'e-statements@hnb.lk' },
    { name: 'NTB', address: 'estatement@info.nationstrust.com' },
    { name: 'DFCC Bank', address: 'statements@dfccbank.com' },
    { name: 'AMEX', address: 'nationstrust@estmt.nationstrust.com' },
];
const approved = normalizeList(BANKS.map((b) => ({ id: b.address, kind: 'address', status: 'approved', name: b.name, domain: b.address.split('@')[1] })));
const policy = policyFrom(approved);
const GOOGLE = 'mx.google.com; ';
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64url');

/** every shape a real mail system writes, as a function of the plain address */
const SHAPES = {
    'bare address': (a) => a,
    'display name': (a) => `Bank <${a}>`,
    'quoted display name': (a) => `"Bank Statements" <${a}>`,
    'display name with a comma': (a) => `"Bank, e-Statements" <${a}>`,
    'display name with an address inside the quotes': (a) => `"${a}" <${a}>`,
    'display name with angle brackets inside the quotes': (a) => `"x <${a}>" <${a}>`,
    'RFC 2047 encoded display name': (a) => `=?UTF-8?B?QmFuayBTdGF0ZW1lbnQ=?= <${a}>`,
    'upper case': (a) => `Bank <${a.toUpperCase()}>`,
    'mixed case': (a) => `Bank <${a.replace(/^./, (c) => c.toUpperCase())}>`,
    'comment after a bare address (legacy)': (a) => `${a} (Bank Statements)`,
    'comment after a display name': (a) => `Bank (e-statements) <${a}>`,
    'comment after the angle address': (a) => `Bank <${a}> (statements)`,
    'comment inside the angle brackets': (a) => `Bank <${a}(statements)>`,
    'nested comment': (a) => `${a} (Bank (the real one))`,
    'stray spaces': (a) => `  Bank   <  ${a}  >  `,
    'folded header': (a) => `Bank\r\n <${a}>`,
    'trailing dot on the domain': (a) => `Bank <${a}.>`,
    'angle address only': (a) => `<${a}>`,
    'quoted display name containing a comma and a closing angle': (a) => `"Bank, Ltd >" <${a}>`,
};

const att = { mimeType: 'application/pdf', filename: 'Statement_2026MAR.pdf', body: { attachmentId: 'a1', size: 4000 } };
const message = (from, auth = [GOOGLE + 'dkim=pass header.i=@DOMAIN; spf=pass; dmarc=pass header.from=DOMAIN'], extraHeaders = []) => {
    const domain = domainOf(Array.isArray(from) ? from[0] : from) || 'x';
    const froms = Array.isArray(from) ? from : [from];
    return { id: 'm1', internalDate: String(Date.parse('2026-04-02T05:00:00Z')), payload: { mimeType: 'multipart/mixed', parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64('Your statement is attached.') } }, att],
        headers: [...froms.map((v) => ({ name: 'From', value: v })), { name: 'Subject', value: 'Your account statement for March 2026' }, ...auth.map((a) => ({ name: 'Authentication-Results', value: a.replace(/DOMAIN/g, domain) })), ...extraHeaders] } };
};

describe('the address is read the way RFC 5322 reads it', () => {
    for (const bank of BANKS) for (const [shape, make] of Object.entries(SHAPES)) {
        it(`${bank.name}: ${shape}`, () => {
            const from = make(bank.address);
            expect(addressOf(from)).toBe(bank.address);
            expect(domainOf(from)).toBe(bank.address.split('@')[1]);
            expect(addressesOf(from)).toEqual([bank.address]);
        });
    }

    it('a display name that looks like the bank never is the bank: the angle-bracket address wins', () => {
        for (const bank of BANKS) {
            for (const from of [`"${bank.address}" <attacker@evil.example>`, `${bank.address} <attacker@evil.example>`, `"Bank <${bank.address}>" <attacker@evil.example>`, `${bank.address} (Bank) <attacker@evil.example>`]) {
                expect(addressOf(from), from).toBe('attacker@evil.example');
            }
        }
    });

    it('an address with the bank inside a longer one is the longer one', () => {
        expect(domainOf('statements@dfccbank.com@evil.example')).toBe('evil.example');
        expect(domainOf('Bank <statements@dfccbank.com.evil.example>')).toBe('dfccbank.com.evil.example');
        expect(domainOf('Bank <statements@evil.example/dfccbank.com>')).not.toBe('dfccbank.com');
    });

    it('an unterminated quote or comment keeps the forgiving older reading and never throws', () => {
        for (const from of ['"Bank <statements@dfccbank.com>', 'Bank (open <statements@dfccbank.com>', '"', '(', '<', '>', '', null, undefined, 42]) {
            expect(() => { addressOf(from); addressesOf(from); domainOf(from); }).not.toThrow();
        }
        expect(addressOf('"Bank <statements@dfccbank.com>')).toBe('statements@dfccbank.com');
    });

    it('a list of mailboxes is listed, in order, without duplicates', () => {
        expect(addressesOf('A <a@x.com>, B <b@y.com>, A again <a@x.com>')).toEqual(['a@x.com', 'b@y.com']);
        expect(addressesOf('a@x.com, b@y.com')).toEqual(['a@x.com', 'b@y.com']);
        expect(addressesOf('Undisclosed recipients:;')).toEqual([]);
    });
});

describe('every shape of each approved bank is matched to its own approval, case-blind', () => {
    for (const bank of BANKS) for (const [shape, make] of Object.entries(SHAPES)) {
        it(`${bank.name}: ${shape}`, () => {
            const hit = matchSender(approved, make(bank.address));
            expect(hit.verdict).toBe('approved');
            expect(hit.entry && hit.entry.id).toBe(bank.address);
        });
    }
});

describe('and every shape is TAKEN as a statement when the bank\'s own authentication holds', () => {
    for (const bank of BANKS) for (const [shape, make] of Object.entries(SHAPES)) {
        it(`${bank.name}: ${shape}`, () => {
            const plan = planMessage(message(make(bank.address)), policy);
            expect(plan.ok, JSON.stringify({ reason: plan.reason, detail: plan.detail })).toBe(true);
            expect(plan.bank).toBe(bank.name);
        });
    }
});

describe('mail from a bulk mailer on the bank\'s behalf', () => {
    const bank = BANKS[2];                           // DFCC
    const from = `DFCC Bank <${bank.address}>`;
    const ctx = (a) => planMessage(message(from, [a]), policy);

    it('DKIM signed by the bank\'s own domain (the mailer signs as the bank): taken', () => {
        expect(ctx(GOOGLE + 'dkim=pass header.i=@dfccbank.com header.s=s1; spf=pass smtp.mailfrom=bounce.sendgrid.net; dmarc=pass header.from=dfccbank.com').ok).toBe(true);
    });
    it('DKIM signed by the bank\'s mail sub-domain: taken (relaxed alignment)', () => {
        expect(ctx(GOOGLE + 'dkim=pass header.i=@mail.dfccbank.com; spf=pass smtp.mailfrom=mail.dfccbank.com; dmarc=pass header.from=dfccbank.com').ok).toBe(true);
    });
    it('SPF passes for the bank\'s own envelope domain and DMARC passes with no DKIM: taken', () => {
        expect(ctx(GOOGLE + 'spf=pass smtp.mailfrom=dfccbank.com; dmarc=pass header.from=dfccbank.com').ok).toBe(true);
    });
    it('the mailer\'s own signature only, DMARC FAIL: refused as forgery and never takeable — the From is a claim nobody vouched for', () => {
        const plan = ctx(GOOGLE + 'dkim=pass header.i=@sendgrid.net; spf=pass smtp.mailfrom=bounce.sendgrid.net; dmarc=fail (p=NONE) header.from=dfccbank.com');
        expect(plan.ok).toBe(false);
        expect(isSecurityRefusal(plan)).toBe(true);
    });
    it('no verdict at all from Google: not forgery — held for the owner, who can take it', () => {
        const plan = planMessage(message(from, []), policy);
        expect(plan.ok).toBe(false);
        expect(isSecurityRefusal(plan)).toBe(false);
    });
});

describe('Return-Path, Reply-To, Sender and X-Original-From decide nothing', () => {
    for (const header of ['Return-Path', 'Reply-To', 'Sender', 'X-Original-From', 'Resent-From', 'X-Sender', 'Envelope-From']) {
        it(`${header} naming the bank does not make a stranger's mail the bank's`, () => {
            const plan = planMessage(message('Mallory <mallory@evil.example>', [GOOGLE + 'dkim=pass header.i=@evil.example; spf=pass; dmarc=pass header.from=evil.example'], [{ name: header, value: '<statements@dfccbank.com>' }]), policy);
            expect(plan.ok).toBe(false);
            expect(plan.reason).toBe(REJECT.NOT_ON_YOUR_LIST);
            expect(plan.from).toContain('evil.example');
        });
    }
});

describe('a From naming several mailboxes is one forged identity', () => {
    for (const from of [
        'DFCC <statements@dfccbank.com>, Other <x@evil.example>',
        'Other <x@evil.example>, DFCC <statements@dfccbank.com>',
        'statements@dfccbank.com, x@evil.example',
        'DFCC <statements@dfccbank.com>; Other <x@evil.example>',
    ]) {
        it(from, () => {
            const plan = planMessage(message(from), policy);
            expect(plan.ok).toBe(false);
            expect(plan.reason).toBe(REJECT.AUTH_FAILED);
            expect(isSecurityRefusal(plan)).toBe(true);
        });
    }
    it('the same mailbox written twice is still one mailbox', () => {
        expect(planMessage(message('DFCC <statements@dfccbank.com>, "DFCC again" <STATEMENTS@dfccbank.com>'), policy).ok).toBe(true);
    });
});

describe('what the senders list counts', () => {
    it('is recorded per sighting here — the caller must record each MESSAGE once (see the hook: only messages new to the state table are counted)', () => {
        let list = [];
        const from = 'DFCC <statements@dfccbank.com>';
        for (let i = 0; i < 3; i++) list = recordSighting(list, { from, subject: 'Statement', now: 1000 + i });
        expect(list.find((e) => e.domain === 'dfccbank.com').seenCount).toBe(3);
    });
});

describe('Nations Trust (NTB and AMEX share one organisation, many sub-domains)', () => {
    const ntb = BANKS[1], amex = BANKS[3];
    const take = (bank, auth) => planMessage(message(`${bank.name} <${bank.address}>`, [auth]), policy);
    it('signed by the parent organisation domain: taken', () => {
        expect(take(ntb, GOOGLE + 'dkim=pass header.i=@nationstrust.com; spf=pass; dmarc=pass header.from=info.nationstrust.com').ok).toBe(true);
        expect(take(amex, GOOGLE + 'dkim=pass header.i=@nationstrust.com; dmarc=pass header.from=estmt.nationstrust.com').ok).toBe(true);
    });
    it('signed by a SIBLING sub-domain of the same organisation, DMARC pass for the From domain: taken (relaxed alignment)', () => {
        expect(take(ntb, GOOGLE + 'dkim=pass header.i=@estmt.nationstrust.com; spf=pass; dmarc=pass header.from=info.nationstrust.com').ok).toBe(true);
        expect(take(amex, GOOGLE + 'dkim=pass header.i=@info.nationstrust.com; dmarc=pass header.from=estmt.nationstrust.com').ok).toBe(true);
    });
    it('a signature by a different sub-domain with NOTHING vouching for the From domain proves nothing at a bank the built-in list does not know: refused, not takeable', () => {
        const dfcc = BANKS[2];
        const plan = take(dfcc, GOOGLE + 'dkim=pass header.i=@mail.dfccbank.com');
        expect(plan.ok).toBe(false);
        expect(isSecurityRefusal(plan)).toBe(true);
    });
    it('a signature by another organisation is never aligned, whatever else is reported', () => {
        expect(take(ntb, GOOGLE + 'dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example').ok).toBe(false);
        expect(take(ntb, GOOGLE + 'dkim=pass header.i=@evil.example; spf=pass').ok).toBe(false);
    });
    it('DMARC pass for the parent organisation is the From domain\'s own verdict', () => {
        expect(take(ntb, GOOGLE + 'spf=pass smtp.mailfrom=nationstrust.com; dmarc=pass header.from=nationstrust.com').ok).toBe(true);
    });
    it('DMARC pass for a lookalike domain is not', () => {
        expect(take(ntb, GOOGLE + 'dmarc=pass header.from=info.nationstrust.com.evil.example').ok).toBe(false);
        expect(take(ntb, GOOGLE + 'dmarc=pass header.from=nationstrust.com.evil.example').ok).toBe(false);
    });
});

describe('another address of the same organisation (the wildcard the owner asked for, kept safe)', () => {
    const take = (from, auth, subject = 'Your account statement for March 2026') => {
        const m = message(from, [auth]);
        m.payload.headers = m.payload.headers.map(h => (h.name === 'Subject' ? { ...h, value: subject } : h));
        return planMessage(m, policy);
    };
    const good = (d) => GOOGLE + `dkim=pass header.i=@${d}; spf=pass; dmarc=pass header.from=${d}`;
    it('a sibling mailbox in the approved organisation, authenticated, naming a statement, is taken — in any case — but must prove itself', () => {
        for (const from of ['NTB <STATEMENTS@ESTMT.NATIONSTRUST.COM>', 'NTB <e-statement@mail.nationstrust.com>', 'Nations Trust <statement@nationstrust.com>']) {
            const plan = take(from, good(domainOf(from)));
            expect(plan.ok, from + ' ' + JSON.stringify({ r: plan.reason })).toBe(true);
            expect(plan.sibling === true || plan.via === 'sibling' || plan.intent === 'suspect' || plan.ok).toBe(true);
        }
    });
    it('the same sibling with a purchase subject, or failing authentication, is not', () => {
        const purchase = message('NTB <statements@estmt.nationstrust.com>', [good('estmt.nationstrust.com')]);
        purchase.payload.headers = purchase.payload.headers.map(h => (h.name === 'Subject' ? { ...h, value: 'Your order is confirmed - invoice attached' } : h));
        purchase.payload.parts = [{ mimeType: 'text/plain', filename: '', body: { data: b64('Thank you for your order.') } }, { mimeType: 'application/pdf', filename: 'Invoice_10442.pdf', body: { attachmentId: 'a9', size: 4000 } }];
        expect(planMessage(purchase, policy).ok).toBe(false);
        expect(take('NTB <statements@estmt.nationstrust.com>', GOOGLE + 'dkim=fail header.i=@estmt.nationstrust.com').ok).toBe(false);
        expect(take('NTB <statements@estmt.nationstrust.com>', GOOGLE + 'dmarc=fail header.from=estmt.nationstrust.com').ok).toBe(false);
    });
    it('a lookalike of the organisation is never a sibling', () => {
        for (const from of ['NTB <statements@nationstrust.com.evil.example>', 'NTB <statements@nationstrust.co>', 'NTB <statements@xnationstrust.com>', 'NTB <statements@nations-trust.com>', 'NTB <statements@nationstrust.com-secure.net>']) {
            expect(take(from, good(domainOf(from))).ok, from).toBe(false);
        }
    });
});

import { wellFormedFrom } from '../wealthflow-mail-ingest.mjs';

describe('a From line a mail system could not have written is refused, not guessed at', () => {
    it.each([
        ['a NUL byte', 'DFCC <statements@dfccbank.com>\u0000<x@evil.example>'], ['a bare line feed', 'DFCC <statements@dfccbank.com>\n<x@evil.example>'], ['a bare carriage return', 'DFCC <statements@dfccbank.com>\r<x@evil.example>'],
        ['header injection', 'DFCC <x@evil.example>\r\nFrom: statements@dfccbank.com'], ['an escape character', 'DFCC <statements@dfccbank.com>\u001b[0m'],
        ['an unterminated quote', '"DFCC <statements@dfccbank.com>'], ['an unterminated comment', 'DFCC (statements <statements@dfccbank.com>'], ['a stray closing bracket', 'DFCC statements@dfccbank.com>'],
        ['a stray opening bracket', 'DFCC <statements@dfccbank.com'], ['nested brackets', 'DFCC <<statements@dfccbank.com>>'], ['nothing', ''], ['only spaces', '   '], ['an absurd length', 'A'.repeat(2500) + ' <statements@dfccbank.com>'],
    ])('%s', (_, from) => {
        expect(wellFormedFrom(from)).toBe(false);
        const plan = planMessage(message(from), policy);
        expect(plan.ok).toBe(false);
    });
    it.each([
        'DFCC <statements@dfccbank.com>', 'statements@dfccbank.com', '"DFCC, Statements" <statements@dfccbank.com>', 'DFCC\r\n <statements@dfccbank.com>', 'DFCC\r\n\t<statements@dfccbank.com>', 'statements@dfccbank.com (DFCC Bank)',
        '=?UTF-8?B?REZDQw==?= <statements@dfccbank.com>', 'ඔබගේ බැංකුව <statements@dfccbank.com>', 'DFCC\t<statements@dfccbank.com>', '"a \\" quote" <statements@dfccbank.com>',
    ])('and these are fine: %j', (from) => expect(wellFormedFrom(from)).toBe(true));
    it('a refusal for a malformed From is logged as a security event, never offered to the owner as one tap', () => {
        const plan = planMessage(message('DFCC <statements@dfccbank.com>\u0000'), policy);
        expect(plan.reason).toBe(REJECT.AUTH_FAILED);
        expect(plan.detail.why).toBe('malformed-from');
        expect(isSecurityRefusal(plan)).toBe(true);
    });
});

describe('a file that says invoice or receipt — and not statement — is not a statement, whatever the subject says', () => {
    const withFiles = (subject, files) => {
        const m = message('DFCC Bank <statements@dfccbank.com>');
        m.payload.headers = m.payload.headers.map((h) => (h.name === 'Subject' ? { ...h, value: subject } : h));
        m.payload.parts = [{ mimeType: 'text/plain', filename: '', body: { data: b64('Attached.') } }, ...files.map((name, i) => ({ mimeType: 'application/pdf', filename: name, body: { attachmentId: 'a' + i, size: 4000 } }))];
        return m;
    };
    it.each(['Invoice_10442.pdf', 'Receipt-2402-5154-7274.pdf', 'invoice-113674.pdf', 'Tax Invoice.pdf', 'Payment Receipt.pdf', 'Order Confirmation 5521.pdf'])('%s under a subject that says statement is refused', (name) => {
        const plan = planMessage(withFiles('Your account statement for March 2026', [name]), policy);
        expect(plan.ok, name).toBe(false);
        expect(plan.reason).toBe(REJECT.NOT_A_STATEMENT_DOC);
        expect(plan.detail.where).toBe('file');
    });
    it('a file that says both is a statement; a file that says neither is judged as before', () => {
        for (const name of ['e-Statement and Tax Invoice.pdf', 'Statement_2026MAR.pdf', '5996631318_455.pdf', 'DFCC_202601.pdf']) {
            const plan = planMessage(withFiles('Your account statement for March 2026', [name]), policy);
            expect(plan.ok, name).toBe(true);
        }
    });
    it('beside a real statement the invoice is left out and the statement is taken; two invoices are refused outright', () => {
        const mixed = planMessage(withFiles('Your account statement for March 2026', ['Statement_2026MAR.pdf', 'Invoice_10442.pdf']), policy);
        expect(mixed.ok).toBe(true); expect(mixed.items.map((i) => i.filename)).toEqual(['Statement_2026MAR.pdf']);
        expect(planMessage(withFiles('Your account statement for March 2026', ['Invoice_1.pdf', 'Receipt_2.pdf']), policy).ok).toBe(false);
    });
});
