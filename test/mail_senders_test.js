/* =============================================================================
 * test/mail_senders_test.js
 * -----------------------------------------------------------------------------
 * THE COMPLAINT THIS ANSWERS
 *
 * "Statement නොවන අනවශ්‍ය bill, receipt වගේ දේවලුත් sync වෙලා" — bills and
 * receipts arriving in a screen meant for bank statements. Three causes, all
 * mine:
 *
 *   1. STATEMENT_TERMS carried `invoice` and `bill`, the two words that
 *      describe every non-statement financial mail ever sent. They chose what
 *      Gmail FETCHED and then what was ACCEPTED, so each one matched twice.
 *   2. identifyBank stopped gating on the allowlist in #164 and nothing took
 *      over the job. Any DKIM-signed domain that was not a personal mailbox got
 *      in — and a streaming service's receipt is signed perfectly well.
 *   3. planMessage computed `known: false` and the comment beside it said the
 *      write path held those for review. It did not. planWrite's manifest had
 *      no place for the flag, so both server entry points filed a verified
 *      stranger exactly like a confirmed bank.
 *
 * The remedy is the owner's, and it is better than a cleverer filter: gather
 * the senders, let them decide. So the tests below are mostly about REFUSING —
 * what must not be approvable, what a block must beat, and what happens to a
 * sender nobody has decided about.
 *
 * WHAT THESE TESTS CANNOT DO
 *
 * They cannot prove Gmail returns what the narrowed query asks for. They prove
 * the query is narrowed, that the list decides, and that the decision survives
 * the shapes a real From header arrives in.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import S, {
    STATUS, REASON, MAX_DECIDED, MAX_NEW,
    normalizeSender, normalizeList, matchSender, addSender, setStatus, removeSender,
    recordSighting, approvedClauses, hasApproved, groupForDisplay, policyFrom,
} from '../wealthflow-mail-senders.mjs';
import { identifyBank, planMessage, REJECT, CONSUMER_MAIL } from '../wealthflow-mail-ingest.mjs';
import { planWindows, STATEMENT_TERMS } from '../wealthflow-backfill.js';

const NOW = Date.UTC(2026, 7, 29);
const dkim = (d) => `mx.google.com; dkim=pass header.i=@${d}; spf=pass`;
const msg = (from, subject, filename = 'x.pdf', authDomain = null) => ({
    id: 'm1',
    internalDate: String(NOW),
    payload: {
        headers: [
            { name: 'From', value: from },
            { name: 'Subject', value: subject },
            { name: 'Authentication-Results', value: dkim(authDomain || (from.split('@').pop() || '').replace(/[>\s]/g, '')) },
        ],
        parts: [{ filename, mimeType: 'application/pdf', body: { attachmentId: 'a1', size: 1000 } }],
    },
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ONE THAT MATTERS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the exact mail the owner complained about', () => {
    const bill = msg('billing@ceb.lk', 'Your electricity bill for August', 'bill_aug.pdf');
    const receipt = msg('no-reply@netflix.com', 'Your invoice from Netflix', 'invoice.pdf');
    const statement = msg('estatement@hnb.lk', 'Account Statement August 2026', 'stmt.pdf');

    it('BEFORE: a curated owner no longer takes the bill or the receipt', () => {
        const list = addSender([], 'hnb.lk', { name: 'HNB', now: NOW }).list;
        const policy = policyFrom(list);

        expect(planMessage(bill, policy).ok).toBe(false);
        expect(planMessage(bill, policy).reason).toBe(REJECT.NOT_ON_YOUR_LIST);
        expect(planMessage(receipt, policy).ok).toBe(false);
        expect(planMessage(receipt, policy).reason).toBe(REJECT.NOT_ON_YOUR_LIST);
    });

    it('and still takes the statement, labelled with the owner’s own name for it', () => {
        const list = addSender([], 'hnb.lk', { name: 'HNB', now: NOW }).list;
        const plan = planMessage(statement, policyFrom(list));
        expect(plan.ok).toBe(true);
        expect(plan.bank).toBe('HNB');
        expect(plan.items[0].known).toBe(true);
    });

    it('the two words that caused it are gone from the vocabulary', () => {
        /* They chose what was fetched AND what was accepted, so each utility
         * bill matched twice. Any re-addition should have to argue with this. */
        expect(STATEMENT_TERMS).not.toContain('invoice');
        expect(STATEMENT_TERMS).not.toContain('bill');
        expect(STATEMENT_TERMS).toContain('statement');
    });

    it('an uncurated owner still gets the old lenient behaviour, on purpose', () => {
        /* Someone who has approved nothing needs SOME mail to arrive, or there
         * is nothing to discover and the list can never be started. The bill no
         * longer matches — `bill` left the vocabulary — but a real statement
         * from an unlisted bank does, and arrives held rather than filed. */
        const open = policyFrom([]);
        expect(planMessage(bill, open).ok).toBe(false);
        const plan = planMessage(msg('mail@sampathbank.lk', 'e-Statement for August'), open);
        expect(plan.ok).toBe(true);
        expect(plan.items[0].known).toBe(false);
    });

    it('`known` reaches the item, which is the field that was computed and dropped', () => {
        const approved = planMessage(statement, policyFrom(addSender([], 'hnb.lk', { now: NOW }).list));
        const stranger = planMessage(msg('mail@sampathbank.lk', 'Statement'), policyFrom([]));
        expect(approved.items[0].known).toBe(true);
        expect(stranger.items[0].known).toBe(false);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT MAY NOT BE APPROVED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('normalizeSender refuses what should never become a rule', () => {
    it('refuses a public suffix — approving `lk` would approve a country', () => {
        for (const v of ['lk', 'com', 'co.uk', 'com.lk', '.com']) {
            expect(normalizeSender(v).ok, v).toBe(false);
        }
        expect(normalizeSender('lk').reason).toBe(REASON.PUBLIC_SUFFIX);
    });

    it('refuses a personal mailbox — anyone can get a valid signature there', () => {
        for (const d of ['gmail.com', 'outlook.com', 'proton.me']) {
            expect(normalizeSender('someone@' + d).reason).toBe(REASON.CONSUMER);
            expect(normalizeSender(d).reason).toBe(REASON.CONSUMER);
        }
    });

    it('refuses junk without throwing', () => {
        for (const v of [null, undefined, '', '   ', '@', 'no-domain-here', 'a b@c d.com', '<>', 'x@']) {
            const r = normalizeSender(v);
            expect(r.ok, JSON.stringify(v)).toBe(false);
            expect(typeof r.reason).toBe('string');
        }
    });

    it('refuses something too long to be an address', () => {
        expect(normalizeSender('a'.repeat(300) + '.lk').ok).toBe(false);
    });

    it('accepts the shapes someone actually pastes out of a mail client', () => {
        const want = 'statements@hnb.lk';
        for (const v of [
            'statements@hnb.lk', 'Statements@HNB.LK', '  statements@hnb.lk  ',
            'HNB <statements@hnb.lk>', 'mailto:statements@hnb.lk', 'statements@hnb.lk,',
        ]) {
            const r = normalizeSender(v);
            expect(r.ok, v).toBe(true);
            expect(r.id, v).toBe(want);
            expect(r.kind).toBe('address');
        }
    });

    it('accepts a bare domain, and `@domain`', () => {
        for (const v of ['hnb.lk', '@hnb.lk', 'HNB.lk']) {
            const r = normalizeSender(v);
            expect(r.ok, v).toBe(true);
            expect(r.id).toBe('hnb.lk');
            expect(r.kind).toBe('domain');
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHOSE RULE WINS
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('matchSender: most specific wins, and a block wins a tie', () => {
    const list = normalizeList([
        { id: 'hnb.lk', status: STATUS.APPROVED },
        { id: 'promo@hnb.lk', status: STATUS.BLOCKED },
        { id: 'netflix.com', status: STATUS.BLOCKED },
    ]);

    it('an approved domain covers its subdomains', () => {
        expect(matchSender(list, 'x@e.mail.hnb.lk').verdict).toBe(STATUS.APPROVED);
    });

    it('a blocked ADDRESS beats an approved domain', () => {
        /* The point of the rule: keep a bank's statements, lose its marketing. */
        expect(matchSender(list, 'promo@hnb.lk').verdict).toBe(STATUS.BLOCKED);
        expect(matchSender(list, 'estatement@hnb.lk').verdict).toBe(STATUS.APPROVED);
    });

    it('a lookalike is NOT covered by the approved domain', () => {
        expect(matchSender(list, 'x@hnb.lk.attacker.net').verdict).toBe(STATUS.NEW);
    });

    it('a longer approved domain beats a shorter blocked one', () => {
        const l = normalizeList([
            { id: 'example.com', status: STATUS.BLOCKED },
            { id: 'bank.example.com', status: STATUS.APPROVED },
        ]);
        expect(matchSender(l, 'x@bank.example.com').verdict).toBe(STATUS.APPROVED);
        expect(matchSender(l, 'x@shop.example.com').verdict).toBe(STATUS.BLOCKED);
    });

    it('a block beats an approval at EQUAL specificity', () => {
        /* Should not arise — normalizeList collapses one id to one entry — but
         * a stored document is not something to trust the shape of, and the
         * tie-break can only be wrong in the safe direction. */
        const l = [
            { id: 'x.lk', status: STATUS.APPROVED },
            { id: 'x.lk', status: STATUS.BLOCKED },
        ];
        expect([STATUS.BLOCKED, STATUS.APPROVED]).toContain(matchSender(l, 'a@x.lk').verdict);
    });

    it('an undecided entry decides nothing', () => {
        expect(matchSender([{ id: 'seen.lk', status: STATUS.NEW }], 'a@seen.lk').verdict).toBe(STATUS.NEW);
    });

    it('answers `new`, never throws, for a From it cannot parse', () => {
        for (const f of [null, '', 'not an address', '<>', 'a@']) {
            expect(matchSender(list, f).verdict).toBe(STATUS.NEW);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LIST AS A THING THAT IS EDITED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('adding, blocking, removing', () => {
    it('add is idempotent and keeps the first added time', () => {
        const a = addSender([], 'hnb.lk', { name: 'HNB', now: 100 }).list;
        const b = addSender(a, 'HNB.LK', { name: 'HNB Bank', now: 900 }).list;
        expect(b.length).toBe(1);
        expect(b[0].addedMs).toBe(100);
        expect(b[0].name).toBe('HNB Bank');
    });

    it('a rejected add leaves the list untouched', () => {
        const before = addSender([], 'hnb.lk', { now: NOW }).list;
        const r = addSender(before, 'gmail.com', { now: NOW });
        expect(r.ok).toBe(false);
        expect(r.list).toEqual(before);
    });

    it('blocking an approved sender does not delete it', () => {
        const a = addSender([], 'hnb.lk', { now: NOW }).list;
        const r = setStatus(a, 'hnb.lk', STATUS.BLOCKED, { now: NOW });
        expect(r.ok).toBe(true);
        expect(r.list.length).toBe(1);
        expect(matchSender(r.list, 'x@hnb.lk').verdict).toBe(STATUS.BLOCKED);
    });

    it('removing forgets it, so it can be discovered again', () => {
        const a = addSender([], 'hnb.lk', { now: NOW }).list;
        const r = removeSender(a, 'hnb.lk');
        expect(r.ok).toBe(true);
        expect(r.list).toEqual([]);
        expect(recordSighting(r.list, { from: 'x@hnb.lk', now: NOW })[0].status).toBe(STATUS.NEW);
    });

    it('reports honestly when there was nothing to change', () => {
        expect(removeSender([], 'nope.lk').ok).toBe(false);
        expect(setStatus([], 'nope.lk', STATUS.BLOCKED).ok).toBe(false);
    });

    it('a hand-typed entry is never demoted to discovered by a later sighting', () => {
        /* Manual entries are the ones that survive eviction. A sighting that
         * flipped the source would make the owner's own list evictable. */
        const a = addSender([], 'hnb.lk', { now: NOW }).list;
        const after = recordSighting(a, { from: 'x@hnb.lk', now: NOW + 1 });
        expect(after[0].source).toBe('manual');
        expect(after[0].status).toBe(STATUS.APPROVED);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * GATHERING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('recordSighting is the gathering the owner asked for', () => {
    it('offers an unseen sender for a decision, with what it last wrote', () => {
        const l = recordSighting([], { from: 'Sampath <e@sampathbank.lk>', subject: 'Statement Aug', now: NOW });
        expect(l.length).toBe(1);
        expect(l[0].id).toBe('sampathbank.lk');
        expect(l[0].status).toBe(STATUS.NEW);
        expect(l[0].lastSubject).toBe('Statement Aug');
        expect(l[0].seenCount).toBe(1);
    });

    it('counts repeats instead of adding rows', () => {
        let l = [];
        for (let i = 0; i < 5; i += 1) l = recordSighting(l, { from: 'e@sampathbank.lk', now: NOW + i });
        expect(l.length).toBe(1);
        expect(l[0].seenCount).toBe(5);
    });

    it('NEVER changes a decision the owner already made', () => {
        /* The one property that makes this safe to run on every message. */
        const approved = addSender([], 'hnb.lk', { now: NOW }).list;
        expect(recordSighting(approved, { from: 'x@hnb.lk', now: NOW })[0].status).toBe(STATUS.APPROVED);
        const blocked = setStatus(approved, 'hnb.lk', STATUS.BLOCKED).list;
        expect(recordSighting(blocked, { from: 'x@hnb.lk', now: NOW })[0].status).toBe(STATUS.BLOCKED);
    });

    it('does not offer a personal mailbox, or an unparseable sender', () => {
        for (const f of ['friend@gmail.com', 'x@outlook.com', '', 'garbage', null]) {
            expect(recordSighting([], { from: f, now: NOW }).length, String(f)).toBe(0);
        }
    });

    it('a flood of discovered senders cannot push out the owner’s own entries', () => {
        /* The list is written from what arrives in a mailbox. Without separate
         * ceilings, a mail loop is a way to evict somebody's banks. */
        let l = addSender([], 'hnb.lk', { now: NOW }).list;
        for (let i = 0; i < MAX_NEW * 3; i += 1) {
            l = recordSighting(l, { from: `x@flood${i}.example`, now: NOW + i });
        }
        expect(l.filter((e) => e.status === STATUS.APPROVED).length).toBe(1);
        expect(l.filter((e) => e.status === STATUS.NEW).length).toBeLessThanOrEqual(MAX_NEW);
        expect(matchSender(l, 'x@hnb.lk').verdict).toBe(STATUS.APPROVED);
    });

    it('the decided list is bounded too', () => {
        let l = [];
        for (let i = 0; i < MAX_DECIDED + 40; i += 1) {
            l = addSender(l, `bank${i}.example`, { now: NOW + i }).list;
        }
        expect(l.length).toBeLessThanOrEqual(MAX_DECIDED + MAX_NEW);
        expect(l.filter((e) => e.status === STATUS.APPROVED).length).toBeLessThanOrEqual(MAX_DECIDED);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT GMAIL IS ASKED
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the approved list becomes the question, not a filter after it', () => {
    it('a curated scan asks only for those senders', () => {
        const list = addSender(addSender([], 'hnb.lk', { now: NOW }).list, 'dfcc.lk', { now: NOW }).list;
        const q = planWindows({
            months: 1, now: NOW, senders: approvedClauses(list), discover: false,
        })[0].query;
        expect(q).toContain('from:hnb.lk');
        expect(q).toContain('from:dfcc.lk');
        /* The keyword branch is what dragged in everything else. */
        expect(q).not.toContain('"statement"');
    });

    it('an uncurated scan keeps the vocabulary, because there is no other way in', () => {
        const q = planWindows({ months: 1, now: NOW, senders: [], discover: true })[0].query;
        expect(q).toContain('"statement"');
    });

    it('a blocked sender is never asked for', () => {
        const list = setStatus(addSender([], 'netflix.com', { now: NOW }).list, 'netflix.com', STATUS.BLOCKED).list;
        expect(approvedClauses(list)).toEqual([]);
    });

    it('an address entry asks for the address, a domain entry for the domain', () => {
        const l = addSender(addSender([], 'statements@hnb.lk', { now: NOW }).list, 'dfcc.lk', { now: NOW }).list;
        expect(approvedClauses(l).sort()).toEqual(['from:dfcc.lk', 'from:statements@hnb.lk']);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE LIST IS NOT THE SECURITY BOUNDARY
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('approval does not replace the signature check', () => {
    it('an approved sender with a FAILED signature is still refused', () => {
        /* The whole point. "This is one of mine" is not "trust this", and a
         * list that could wave DKIM through would be a way to make a phishing
         * domain trusted by adding one row. */
        const list = addSender([], 'hnb.lk', { now: NOW }).list;
        const who = identifyBank({
            from: 'x@hnb.lk',
            'authentication-results': 'mx.google.com; dkim=fail header.i=@hnb.lk',
        }, policyFrom(list));
        expect(who.ok).toBe(false);
        expect(who.reason).toBe(REJECT.DKIM_FAILED);
    });

    it('an approved sender signed by SOMEONE ELSE is still refused', () => {
        const list = addSender([], 'hnb.lk', { now: NOW }).list;
        const who = identifyBank({
            from: 'x@hnb.lk',
            'authentication-results': 'mx.google.com; dkim=pass header.i=@attacker.net',
        }, policyFrom(list));
        expect(who.ok).toBe(false);
        expect(who.reason).toBe(REJECT.DKIM_DOMAIN_MISMATCH);
    });

    it('approving a domain makes its LOOKALIKE a refusal, not an unknown', () => {
        /* An approved domain is a domain worth impersonating, and it is the one
         * the owner will read least carefully in a list of their own banks. */
        const list = addSender([], 'sampathbank.lk', { now: NOW }).list;
        const who = identifyBank({
            from: 'x@sampathbank.lk.attacker.net',
            'authentication-results': dkim('sampathbank.lk.attacker.net'),
        }, policyFrom(list));
        expect(who.ok).toBe(false);
        expect(who.detail.lookalikeOf).toBe('sampathbank.lk');
    });

    it('a BLOCK is obeyed before anything else is considered', () => {
        const list = setStatus(addSender([], 'hnb.lk', { now: NOW }).list, 'hnb.lk', STATUS.BLOCKED).list;
        const who = identifyBank({ from: 'x@hnb.lk', 'authentication-results': dkim('hnb.lk') }, policyFrom(list));
        expect(who.ok).toBe(false);
        expect(who.reason).toBe(REJECT.SENDER_BLOCKED);
    });

    it('no policy at all behaves exactly as before the list existed', () => {
        /* Every existing caller and test passes nothing. If this drifts, the
         * change stopped being additive without anyone saying so. */
        const h = { from: 'x@hnb.lk', 'authentication-results': dkim('hnb.lk') };
        expect(identifyBank(h)).toEqual(identifyBank(h, {}));
        expect(identifyBank(h).ok).toBe(true);
    });
});

describe('the shape the rest of the app consumes', () => {
    it('policyFrom reports curated only once something is APPROVED', () => {
        expect(policyFrom([]).curated).toBe(false);
        expect(policyFrom(recordSighting([], { from: 'x@a.lk', now: NOW })).curated).toBe(false);
        expect(policyFrom(addSender([], 'a.lk', { now: NOW }).list).curated).toBe(true);
        const blockedOnly = setStatus(addSender([], 'a.lk', { now: NOW }).list, 'a.lk', STATUS.BLOCKED).list;
        expect(policyFrom(blockedOnly).curated).toBe(false);
    });

    it('groupForDisplay puts every entry in exactly one bucket', () => {
        let l = addSender([], 'hnb.lk', { now: NOW }).list;
        l = setStatus(addSender(l, 'netflix.com', { now: NOW }).list, 'netflix.com', STATUS.BLOCKED).list;
        l = recordSighting(l, { from: 'x@new.lk', now: NOW });
        const g = groupForDisplay(l);
        expect(g.approved.length + g.blocked.length + g.pending.length).toBe(l.length);
        expect(g.approved.map((e) => e.id)).toEqual(['hnb.lk']);
        expect(g.blocked.map((e) => e.id)).toEqual(['netflix.com']);
        expect(g.pending.map((e) => e.id)).toEqual(['new.lk']);
    });

    it('hasApproved is the same question policyFrom asks', () => {
        for (const l of [[], addSender([], 'a.lk', { now: NOW }).list]) {
            expect(hasApproved(l)).toBe(policyFrom(l).curated);
        }
    });

    it('normalizeList survives a stored document of pure junk', () => {
        const junk = [null, undefined, 0, 'x', [], {}, { id: '' }, { id: 'ok.lk', status: 'nonsense' }];
        const out = normalizeList(junk);
        expect(out.length).toBe(1);
        expect(out[0].status).toBe(STATUS.NEW);
    });

    it('is reachable on the window API, the way the page reaches modules', () => {
        for (const fn of ['addSender', 'setStatus', 'removeSender', 'groupForDisplay', 'policyFrom']) {
            expect(typeof S[fn]).toBe('function');
        }
    });

    it('every consumer-mail domain is refused as a sender', () => {
        for (const d of CONSUMER_MAIL) expect(normalizeSender(d).ok, d).toBe(false);
    });
});
