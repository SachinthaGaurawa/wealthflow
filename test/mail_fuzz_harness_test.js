import { describe, it, expect } from 'vitest';
import { planMessage } from '../wealthflow-mail-ingest.mjs';
import { policyFrom, normalizeList } from '../wealthflow-mail-senders.mjs';
import { makeMail, BANKS } from './helpers/mail-fuzz.js';

/* =============================================================================
 * THE MAIL FUZZ HARNESS.
 *
 * Seeded enterprise mail for the four approved senders — genuine in every benign shape, and hostile in every shape we can think of
 * (display-name spoofs, several mailboxes, lookalike and homoglyph domains, null bytes, CRLF injection, unterminated quotes, a
 * 5,000-character display name, forged Authentication-Results below Google's, a bank named in Return-Path / Reply-To, purchase
 * receipts, executables named like statements). Each message carries the label its generator gave it:
 *
 *     genuine ⇒ taken        forged ⇒ never taken        sibling (another mailbox at the approved bank's own domain, vouched for) ⇒
 *     taken only as a sibling that must prove itself from its contents        and never: an exception, a different answer twice, nonsense.
 *
 * WF_FUZZ_SEEDS scales it (CI runs more). A failing seed is a reproduction: makeMail(seed) is the message.
 * ===========================================================================*/

const senders = BANKS.map((b) => ({ id: b.address, kind: 'address', status: 'approved', name: b.name, domain: b.address.split('@')[1] }));
const policy = policyFrom(normalizeList(senders));
const N = Number(process.env.WF_FUZZ_SEEDS) || 4000;

describe(`${N} seeded messages`, () => {
    it('genuine mail is taken, forged mail never is, nothing throws, and the answer is stable', () => {
        const failures = [];
        const tally = { genuine: 0, forged: 0, sibling: 0, takenGenuine: 0, takenForged: 0, why: {} };
        for (let seed = 1; seed <= N; seed++) {
            const mail = makeMail(seed);
            let plan, again;
            try { plan = planMessage(mail.message, policy); again = planMessage(mail.message, policy); }
            catch (error) { failures.push(`seed ${seed} THREW ${error && error.message} (${mail.why})`); continue; }
            tally[mail.label]++;
            if (JSON.stringify(plan) !== JSON.stringify(again)) failures.push(`seed ${seed} answered differently twice`);
            if (typeof plan.ok !== 'boolean') failures.push(`seed ${seed}: ok is not a boolean`);
            if (!plan.ok && typeof plan.reason !== 'string') failures.push(`seed ${seed}: a refusal with no reason`);
            if (plan.ok) {
                if (!Array.isArray(plan.items) || !plan.items.length || plan.items.length > 12) failures.push(`seed ${seed}: taken with ${plan.items && plan.items.length} items`);
                if (!BANKS.some((b) => b.name === plan.bank)) failures.push(`seed ${seed}: taken as "${plan.bank}", which is not one of the four`);
            }
            if (mail.label === 'forged' && plan.ok) { tally.takenForged++; failures.push(`seed ${seed}: FORGED MAIL TAKEN (${mail.why}) from ${JSON.stringify(mail.message.payload.headers[0])}`); }
            if (mail.label === 'sibling' && plan.ok && !(plan.via === 'sibling' && plan.intent === 'suspect')) failures.push(`seed ${seed}: a sibling taken as ${plan.via}/${plan.intent}, not as a sibling that must prove itself`);
            if (mail.label === 'genuine') { if (plan.ok) tally.takenGenuine++; else failures.push(`seed ${seed}: genuine mail refused as ${plan.reason} (${mail.why}) from ${JSON.stringify(mail.message.payload.headers[0])}`); }
            tally.why[mail.why] = (tally.why[mail.why] || 0) + 1;
        }
        expect(failures.slice(0, 20), `${failures.length} failures of ${N}; ${JSON.stringify(tally)}`).toEqual([]);
        // the harness really did exercise both sides
        expect(tally.genuine).toBeGreaterThan(N * 0.4); expect(tally.forged).toBeGreaterThan(N * 0.3);
        expect(tally.takenGenuine).toBe(tally.genuine); expect(tally.takenForged).toBe(0);
    });

    it('is reproducible: the same seed is the same message', () => {
        for (const seed of [1, 7, 99, 1234]) expect(JSON.stringify(makeMail(seed))).toBe(JSON.stringify(makeMail(seed)));
        expect(JSON.stringify(makeMail(1))).not.toBe(JSON.stringify(makeMail(2)));
    });

    it('covers every kind of hostility it claims to', () => {
        const seen = new Set();
        for (let seed = 1; seed <= 600; seed++) seen.add(makeMail(seed).why);
        for (const kind of ['hostile From line', 'authentication that does not vouch', 'not a statement document', 'a purchase receipt', 'a stranger naming the bank in a header only the sender writes', 'approved address, vouched for, real statement', 'another mailbox at the approved bank domain, vouched for']) expect(seen.has(kind), kind).toBe(true);
    });
});
