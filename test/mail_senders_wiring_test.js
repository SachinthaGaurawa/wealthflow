/* =============================================================================
 * test/mail_senders_wiring_test.js
 * -----------------------------------------------------------------------------
 * A policy nothing consults is a policy that does not exist. This repository
 * has shipped that exact thing repeatedly — an engine with no caller, a field
 * computed and read by nothing — and the sender list is the most tempting
 * candidate yet, because it looks like it is working the moment the screen
 * renders rows.
 *
 * The worst version already happened here and is what this change repairs:
 * planMessage computed `known` and a comment claimed the write path held those
 * for review. planWrite's manifest had no place for it, so nothing could.
 *
 * So this file asserts the WIRING, not the rules — that both server entry
 * points read the list, build the policy from the same function, pass it in,
 * record what they saw, and store the answer.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const html = read('index.html');
const hook = read('gmail-hook.js');
const scan = read('gmail-scan.js');
const scanPlan = read('gmail-scan.mjs');
const link = read('gmail-link.js');
const ingest = read('wealthflow-mail-ingest.mjs');

function fn(name) {
    const decl = new RegExp(`^[ \\t]*(?:async )?function ${name}\\s*\\(`, 'm');
    const m = decl.exec(html);
    if (!m) return '';
    const after = html.slice(m.index + m[0].length);
    const next = after.search(/^ {8}(?:async )?function \w+\s*\(/m);
    return next < 0 ? html.slice(m.index) : html.slice(m.index, m.index + m[0].length + next);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE PAIR THAT KEEPS DRIFTING
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the push hook and the scan endpoint apply ONE policy', () => {
    it.each([['gmail-hook.js', hook], ['gmail-scan.js', scan]])(
        '%s reads the list from the sealed document', (_name, src) => {
            expect(src).toContain('sendersOf(state)');
            expect(src).toContain('policyFrom(');
        });

    it.each([['gmail-hook.js', hook], ['gmail-scan.js', scan]])(
        '%s passes the policy to planMessage', (_name, src) => {
            expect(src).toContain('planMessage(msg, policy)');
        });

    it.each([['gmail-hook.js', hook], ['gmail-scan.js', scan]])(
        '%s records what it saw, so senders can be offered', (_name, src) => {
            expect(src).toContain('recordSighting(seen,');
        });

    it.each([['gmail-hook.js', hook], ['gmail-scan.js', scan]])(
        '%s writes the sightings back', (_name, src) => {
            expect(src).toContain('[SENDERS_FIELD]: seen');
        });

    it.each([['gmail-hook.js', hook], ['gmail-scan.js', scan]])(
        '%s finally puts `known` in the manifest', (_name, src) => {
            /* The field was computed from the first day and stored by nothing,
             * so a verified stranger was filed exactly like a confirmed bank. */
            expect(src).toContain('known: item.known !== false');
        });

    it('neither builds its own policy by hand', () => {
        /* Two hand-rolled copies of the matching rules is how the pair drifts.
         * They must share policyFrom or they are not one policy. */
        for (const src of [hook, scan]) {
            expect(src).not.toContain('matchSender(');
            expect(src).not.toMatch(/status === 'approved'/);
        }
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE QUERY IS THE FILTER
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('an unapproved sender is never asked for', () => {
    it('windowFor takes the owner’s senders', () => {
        expect(scanPlan).toContain('senders = null');
        /* The window is built from the list, and from the list only. `discover`
         * became a parameter when a run had to be able to widen the QUESTION
         * without widening what is stored — so the flag is read here rather
         * than derived, and `chosen` is still what the query is made of. */
        expect(scanPlan).toContain('senders: chosen,');
        /* `discover` is read from the request and passed through, never
         * derived: an ordinary scan must not become a discovery run by
         * accident, because a discovery run reads headers only and imports
         * nothing. `includeTerms` carries the separate uncurated case. */
        expect(scanPlan).toContain('discover: discover === true,');
        expect(scanPlan).toContain('includeTerms: !owns,');
        expect(scanPlan).toContain('const chosen = Array.isArray(senders) && senders.length ? senders : scanSenders();');
    });

    it('the handler reads the state BEFORE it builds the window', () => {
        /* The window's query is now made of the owner's approved senders, which
         * live in that document. Building it first would ask Gmail the old
         * broad question — every PDF whose subject carries a common word. */
        const stateAt = scan.indexOf('sendersOf(state)');
        const windowAt = scan.indexOf('windowFor({');
        expect(stateAt).toBeGreaterThan(-1);
        expect(windowAt).toBeGreaterThan(stateAt);
    });

    it('the senders passed in come from the document, never from the request', () => {
        /* This endpoint holds a credential that can read a whole mailbox. A
         * caller-shaped query would make it a general mail-search proxy, which
         * is the reason the window is derived at all. */
        const call = scan.slice(scan.indexOf('windowFor({'), scan.indexOf('windowFor({') + 260);
        expect(call).toContain('approvedClauses(senderList)');
        expect(call).not.toMatch(/body\.senders|body\.query|body\.from/);
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE ENDPOINT THE SCREEN TALKS TO
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the list is read and written through the identity boundary', () => {
    it('is served under the same verified-identity document as the token', () => {
        expect(link).toContain('senders=1');
        expect(link).toContain('db.collection(MAIL_ROOT).doc(who.userKey)');
    });

    it('every mutation goes through the policy module, not through hand-rolled parsing', () => {
        /* A second copy of the normalisation rules is a second set of answers,
         * and the two would drift. The handler routes; it does not decide. */
        for (const f of ['addSender(', 'setStatus(', 'removeSender(', 'normalizeList(']) {
            expect(link).toContain(f);
        }
        expect(link, 'the endpoint is parsing an address itself').not.toMatch(/lastIndexOf\('@'\)/);
    });

    it('refuses an unknown action rather than guessing', () => {
        expect(link).toContain("error: 'action must be add, status or remove'");
    });

    it('an invalid address comes back as a sentence, not as "invalid"', () => {
        expect(link).toContain('REASON_TEXT[result.reason]');
    });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SCREEN
 * ═══════════════════════════════════════════════════════════════════════════*/
describe('the owner can actually reach it', () => {
    it('there is a button on the card that opens it', () => {
        /* An engine reachable only from the console is the same as an unwired
         * one — the complaint that produced the last one of these was
         * "WHERE IS IT?". */
        const body = fn('renderMailSync');
        expect(body).toContain('_ms_senders');
        expect(body).toContain('openSenderList()');
    });

    it('the three things the owner asked for are all wired', () => {
        const body = fn('renderSenderList') + fn('openSenderList');
        expect(body, 'no way to approve a gathered sender').toContain("'approve'");
        expect(body, 'no way to delete a wrong one').toContain("'remove'");
        expect(body, 'no way to type one in').toContain("_sendersDo('add'");
    });

    it('redraws from the server’s answer instead of patching a local copy', () => {
        /* A local patch is a second implementation of the merge rules; the two
         * drift and the screen then shows a list nobody has. */
        expect(fn('_sendersDo')).toContain('_sendersApply(r)');
        expect(fn('_sendersApply')).toContain('r.body.approved');
    });

    it('THE CARD READS `known` — storing it and not reading it is the same defect', () => {
        /* The original bug in one line: planMessage computed this field, a
         * comment claimed the write path acted on it, and no manifest carried
         * it. Now both call sites store it. A screen that ignored it would be
         * that defect one step further along, in the change that names it.
         *
         * The read moved into _mailKnownNow when the verdict started being
         * recomputed against the owner's current list — the stored flag is now
         * the FALLBACK for a document too old to have one, rather than the only
         * answer. Retargeted, not relaxed: the flag must still be read, and the
         * loop must still get its answer from the function that reads it. */
        expect(fn('_mailKnownNow')).toContain('d.manifest.known === false');
        const body = fn('runMailSync');
        expect(body).toContain('_mailKnownNow(d,');
        expect(body).toContain('d.manifest.from');
    });

    it('an unrecognised row says who sent it and offers the decision inline', () => {
        const body = fn('renderMailSync');
        expect(body).toContain('not on your sender list');
        expect(body).toContain('data-msadd');
        expect(body).toContain("_sendersDo('add', it.from");
    });

    it('a document written before the field existed is not treated as suspect', () => {
        /* `known: undefined` must read as known. Written as `!== false` for
         * exactly that reason — a truthiness test would turn every statement
         * stored before this change into an accusation. */
        const body = fn('_mailKnownNow');
        expect(body).not.toMatch(/return\s*!!\s*\(?d/);
        expect(body).toContain('return !(d && d.manifest && d.manifest.known === false)');
    });

    it('the sender shown is the address, not a display name the sender chose', () => {
        /* RUN, not read. The rule is no longer one regex: a display name may be
         * a quoted string carrying angle brackets around something shaped like
         * an address, and the first angled group is then the sender's own text
         * — printed on a row that offers to approve or delete them. Asserting
         * on the source would pass on any pattern at all. */
        const label = new Function('return ' + fn('_mailFromLabel').trim())();
        expect(label('HNB <statements@hnb.lk>')).toBe('statements@hnb.lk');
        expect(label('statements@hnb.lk')).toBe('statements@hnb.lk');
        expect(label('"Your Bank <first@display.example>" <real@hnb.lk>')).toBe('real@hnb.lk');
    });

    it('the empty state names the cause instead of looking like a bug', () => {
        const body = fn('renderMailSync');
        expect(body).toContain('does not know which senders are your banks yet');
    });

    it('escapes every value it renders — this list is written from mail', () => {
        /* ids, names and last subjects all come from message headers. An
         * unescaped one is an injection sink fed by anyone who can send mail. */
        const body = fn('_senderRow') + fn('_senderBtn');
        expect(body).not.toMatch(/\$\{(?!_wfEsc)[^}]*\b(?:e\.name|e\.id|e\.lastSubject)\b/);
        for (const v of ['e.name || e.id', 'e.id', 'e.lastSubject']) {
            expect(body).toContain('_wfEsc(' + v + ')');
        }
    });
});

describe('the ingest keeps the list at arm’s length', () => {
    it('takes the decision injected, so the two modules do not import each other', () => {
        expect(ingest).toContain('policy.decide');
        expect(ingest, 'a cycle: the ingest now imports the module that imports it')
            .not.toContain("from './wealthflow-mail-senders.mjs'");
    });

    it('a block is checked before the sender is even identified', () => {
        const f = ingest.slice(ingest.indexOf('export function identifyBank'));
        expect(f.indexOf('SENDER_BLOCKED')).toBeLessThan(f.indexOf('dkimPassedFor'));
    });

    it('but approval is checked AFTER the signature', () => {
        /* Approval means "this is one of mine", never "trust this". A list that
         * could wave DKIM through would make a phishing domain trusted by the
         * addition of one row. */
        const f = ingest.slice(ingest.indexOf('export function identifyBank'));
        expect(f.indexOf('dkimPassedFor')).toBeLessThan(f.indexOf("said.verdict === 'approved'"));
    });
});
