import { describe, it, expect } from 'vitest';
import { planMessage, REJECT, isStatementAttachment, selectAttachments, pickAuthHeader, authSummary, securityOf, refusalOf, bodyTextOf, isSecurityRefusal } from '../wealthflow-mail-ingest.mjs';
import { policyFrom, normalizeList } from '../wealthflow-mail-senders.mjs';
import { intentVerdict, sniffKind } from '../wealthflow-statement-identity.js';
import { mergeSecurity } from '../gmail-link.mjs';

/* =============================================================================
 * THE OWNER'S RULE ENGINE, run against thousands of hostile and ordinary messages.
 *
 *   Layer 1  Who sent it, proven: a From line is a claim. SPF, DKIM and DMARC are what Google found out. Only Google's
 *            own Authentication-Results header counts (the sender can write one too). Evidence of forgery is dropped,
 *            logged as a security event, and is never one tap from being taken.
 *   Layer 2  What it is: a PDF or HTML attachment whose NAME, TYPE and BYTES agree; a subject, file names and body that
 *            do not say invoice / receipt / order confirmed / payment due / subscription instead of statement.
 *   Layer 3  Every combination of the above, against an oracle written separately from the code: each value below is
 *            hand-labelled with what it must do, and the expected verdict is computed from the labels by the documented
 *            precedence — not by calling the code under test.
 * ===========================================================================*/

const approved = [{ id: 'statements@hnb.lk', kind: 'address', status: 'approved', name: 'HNB', domain: 'hnb.lk' }];
const policy = policyFrom(normalizeList(approved));
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64url');

/* ── the dimensions, each value labelled with what it MUST do ─────────────────────────────────────────────────────── */

const GOOGLE = 'mx.google.com; ';
const AUTHS = {
    'all pass':                 { h: [GOOGLE + 'dkim=pass header.i=@hnb.lk; spf=pass smtp.mailfrom=hnb.lk; dmarc=pass (p=REJECT) header.from=hnb.lk'], out: 'pass' },
    'dkim pass only':           { h: [GOOGLE + 'dkim=pass header.i=@hnb.lk'], out: 'pass' },
    'dkim on a sub-domain':     { h: [GOOGLE + 'dkim=pass header.i=@mail.hnb.lk'], out: 'pass' },   // signer is UNDER the claimed domain? no — see below
    'dkim pass, spf fail (forwarded)': { h: [GOOGLE + 'dkim=pass header.i=@hnb.lk; spf=fail; dmarc=pass header.from=hnb.lk'], out: 'pass' },
    'dkim pass, dmarc FAIL':    { h: [GOOGLE + 'dkim=pass header.i=@hnb.lk; dmarc=fail header.from=hnb.lk'], out: AUTH_FAILED() },
    'dkim pass, dmarc for another domain': { h: [GOOGLE + 'dkim=pass header.i=@hnb.lk; dmarc=pass header.from=evil.net'], out: AUTH_FAILED() },
    'unsigned, spf pass':       { h: [GOOGLE + 'spf=pass'], out: 'unsigned' },
    'unsigned, spf FAIL':       { h: [GOOGLE + 'spf=fail'], out: AUTH_FAILED() },
    'unsigned, spf softfail':   { h: [GOOGLE + 'spf=softfail'], out: AUTH_FAILED() },
    'dkim FAIL':                { h: [GOOGLE + 'dkim=fail header.i=@hnb.lk'], out: 'dkim-failed' },
    'signed by somebody else':  { h: [GOOGLE + 'dkim=pass header.i=@evil.net'], out: 'mismatch' },
    'fail for bank, pass for attacker': { h: [GOOGLE + 'dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net'], out: 'mismatch' },
    'no header at all':         { h: [], out: 'unsigned' },
    // DMARC pass for the From domain IS Google's verdict that the From is authentic (aligned DKIM or aligned SPF)
    'no signature, spf + dmarc pass for the From domain': { h: [GOOGLE + 'spf=pass smtp.mailfrom=hnb.lk; dmarc=pass (p=REJECT) header.from=hnb.lk'], out: 'pass' },
    'mailer signature only, dmarc pass through aligned spf': { h: [GOOGLE + 'dkim=pass header.i=@sendgrid.net; spf=pass smtp.mailfrom=hnb.lk; dmarc=pass header.from=hnb.lk'], out: 'pass' },
    'dkim FAIL even though spf carries dmarc': { h: [GOOGLE + 'dkim=fail header.i=@hnb.lk; spf=pass smtp.mailfrom=hnb.lk; dmarc=pass header.from=hnb.lk'], out: 'dkim-failed' },
    'dmarc pass that names no domain': { h: [GOOGLE + 'dmarc=pass'], out: 'unsigned' },
    // the sender writes an Authentication-Results header into the mail they send; Google's own is ABOVE it and says no
    'forged header below Google\'s': { h: [GOOGLE + 'dkim=none; spf=pass', GOOGLE + 'dkim=pass header.i=@hnb.lk'], out: 'unsigned' },
    'forged header naming another authserv-id above Google\'s': { h: ['attacker.example; dkim=pass header.i=@hnb.lk', GOOGLE + 'dkim=fail header.i=@hnb.lk'], out: 'dkim-failed' },
};
// a signer that is the CLAIMED domain or a parent of it is aligned; `mail.hnb.lk` signing for hnb.lk is a signer UNDER the domain.
AUTHS['dkim on a sub-domain'].out = 'pass';

function AUTH_FAILED() { return 'auth-failed'; }

const FROMS = {
    'the approved address':   { v: 'HNB Statements <statements@hnb.lk>', out: 'approved' },
    'a sibling address':      { v: 'HNB <estatements@hnb.lk>', out: 'held' },
    'a lookalike domain':     { v: 'HNB <statements@hnb.lk.attacker.net>', out: 'lookalike' },
    'a hyphenated lookalike': { v: 'HNB <statements@hnb.lk-secure.com>', out: 'lookalike' },
    'a personal mailbox':     { v: 'HNB <statements@gmail.com>', out: 'consumer' },
    'display-name spoof':     { v: '"statements@hnb.lk" <billing@attacker.example>', out: 'stranger' },
    'two From lines':         { v: ['HNB <statements@hnb.lk>', 'Attacker <x@attacker.example>'], out: 'two-from' },
};

const pdf = (name, extra = {}) => ({ mimeType: 'application/pdf', filename: name, body: { attachmentId: 'a-' + name, size: 4000 }, ...extra });
const ATTACHMENTS = {
    'a statement PDF':          { parts: [pdf('Statement_2026JAN.pdf')], out: 'ok' },
    'an upper-case .PDF':       { parts: [pdf('STATEMENT.PDF')], out: 'ok' },
    'a statement HTML':         { parts: [{ mimeType: 'text/html', filename: 'Consolidated_eStatement_2026JAN.html', body: { attachmentId: 'a-h', size: 9000 } }], out: 'ok' },
    'an HTML sent as octet-stream': { parts: [{ mimeType: 'application/octet-stream', filename: 'Smart_Statement.html', body: { attachmentId: 'a-h2', size: 9000 } }], out: 'ok' },
    'a number-named PDF':       { parts: [pdf('5996631318_455.pdf')], out: 'ok-numeric' },
    'a PDF with no extension':  { parts: [pdf('5996631318_455')], out: 'ok-numeric' },
    'a PDF named with a date':  { parts: [pdf('Statement 01.12.2025')], out: 'ok' },
    'nothing attached (body only)': { parts: [], out: 'none' },
    'an executable named .pdf.exe': { parts: [pdf('Statement.pdf.exe')], out: 'none' },
    'an executable hidden as .exe.pdf': { parts: [pdf('Statement.exe.pdf')], out: 'none' },
    'a zip':                    { parts: [{ mimeType: 'application/zip', filename: 'statements.zip', body: { attachmentId: 'z', size: 100 } }], out: 'none' },
    'a zip declared as PDF':    { parts: [pdf('statements.zip')], out: 'none' },
    'a script':                 { parts: [{ mimeType: 'application/octet-stream', filename: 'statement.js', body: { attachmentId: 's', size: 10 } }], out: 'none' },
    'a tracking-pixel image':   { parts: [{ mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'i', size: 100 } }], out: 'none' },
    'an svg':                   { parts: [{ mimeType: 'image/svg+xml', filename: 'statement.svg', body: { attachmentId: 'v', size: 100 } }], out: 'none' },
    'thirteen PDFs':            { parts: Array.from({ length: 13 }, (_, i) => pdf(`Statement_${i}.pdf`)), out: 'too-many' },
};

/* subject → what the subject/file-name layer alone concludes: stated | block | neutral */
const SUBJECTS = {
    'Your Monthly Statement': 'stated',
    'E-Statement for January': 'stated',
    'Smart Statement is ready': 'stated',
    'Account Ledger': 'stated',
    'Credit Card e-Statement — payment due 25th': 'stated',   // the statement word outranks a bill word beside it
    'Invoice #1234': 'block',
    'Your payment receipt': 'block',
    'Order Confirmed': 'block',
    'Payment Due': 'block',
    'Your subscription renews': 'block',
    'Hello': 'neutral',
    '': 'neutral',
};
/* attachment file name → what it says by itself (only matters when it names itself) */
const FILE_SAYS = { 'Invoice-0008.pdf': 'block', 'Receipt-2402.pdf': 'block' };
/* body → what the body adds */
const BODIES = {
    'no body': { text: '', adds: 'nothing' },
    'says statement': { text: 'Dear customer, your statement is attached.', adds: 'stated' },
    'purchase wording': { text: 'Thank you for your purchase. Your order is confirmed. Keep this receipt.', adds: 'suspect' },
    'footer subscription link': { text: 'Manage your subscription preferences at any time.', adds: 'suspect' },
    'statement and payment due': { text: 'Your statement is attached. The minimum payment due is shown on page 1.', adds: 'stated' },
};

/* ── the oracle: expected verdict from the labels, by the documented precedence ─────────────────────────────────── */

function expected(from, auth, att, subject, body) {
    const f = FROMS[from], a = AUTHS[auth], t = ATTACHMENTS[att], s = SUBJECTS[subject], b = BODIES[body];
    if (f.out === 'two-from') return { ok: false, reason: REJECT.AUTH_FAILED, security: true };
    if (f.out === 'lookalike') return { ok: false, reason: REJECT.NOT_A_BANK, security: true };
    // a stranger's or a personal mailbox's mail is never accepted; which refusal comes first depends on how its own
    // authentication reads (the strings here describe hnb.lk), so only "refused" is asserted for them
    if (f.out === 'consumer' || f.out === 'stranger') return { ok: false, any: true };
    // auth is judged for every sender that got this far
    const authOut = a.out;
    if (authOut === 'auth-failed') return { ok: false, reason: REJECT.AUTH_FAILED, security: f.out === 'approved' || f.out === 'held' };   // a listed bank's domain, claimed
    if (authOut === 'unsigned') return { ok: false, reason: REJECT.DKIM_FAILED, security: false };
    if (authOut === 'dkim-failed') return { ok: false, reason: REJECT.DKIM_FAILED, security: f.out === 'approved' || f.out === 'held' };
    if (authOut === 'mismatch') return { ok: false, reason: REJECT.DKIM_DOMAIN_MISMATCH, security: f.out === 'approved' || f.out === 'held' };
    // the claimed signer is the bank; sender state decides next, after attachments
    if (t.out === 'none') return { ok: false, reason: REJECT.NO_ATTACHMENT, security: false };
    if (t.out === 'too-many') return { ok: false, reason: REJECT.TOO_MANY, security: false };
    // what do the subject and the file names say it is?
    const namedStatement = (att === 'a statement PDF' || att === 'an upper-case .PDF' || att === 'a statement HTML' || att === 'an HTML sent as octet-stream' || att === 'a PDF named with a date')
        && /statement/i.test(ATTACHMENTS[att].parts[0].filename);
    const metaSays = s === 'stated' || namedStatement ? 'stated' : s === 'block' ? 'block' : 'neutral';
    // another address at the approved bank (authenticated, above): taken on that evidence whatever the subject says — only as a document that
    // must prove itself — except an invoice, a receipt, an order or a payment notice, which is refused as not a statement (never held for a tap)
    if (f.out === 'held') return metaSays === 'block' ? { ok: false, reason: REJECT.NOT_A_STATEMENT_DOC, security: false } : { ok: true, intent: 'suspect' };
    if (metaSays === 'block') return { ok: false, reason: REJECT.NOT_A_STATEMENT_DOC, security: false };
    const intent = metaSays === 'stated' ? 'stated' : b.adds === 'stated' ? 'stated' : b.adds === 'suspect' ? 'suspect' : 'unproven';
    return { ok: true, intent };
}

function message(from, auth, att, subject, body) {
    const f = FROMS[from], a = AUTHS[auth], t = ATTACHMENTS[att], b = BODIES[body];
    const froms = Array.isArray(f.v) ? f.v : [f.v];
    const headers = [...froms.map((v) => ({ name: 'From', value: v })), { name: 'Subject', value: subject }, ...a.h.map((v) => ({ name: 'Authentication-Results', value: v }))];
    const parts = [];
    if (b.text) parts.push({ mimeType: 'text/plain', filename: '', body: { data: b64(b.text) } });
    parts.push(...t.parts);
    return { id: 'm-' + Math.random().toString(36).slice(2, 8), internalDate: String(Date.parse('2026-04-02T05:00:00Z')), payload: { headers, mimeType: 'multipart/mixed', parts } };
}

describe('every combination of sender, authentication, attachment, subject and body', () => {
    const froms = Object.keys(FROMS), auths = Object.keys(AUTHS), atts = Object.keys(ATTACHMENTS), subjects = Object.keys(SUBJECTS), bodies = Object.keys(BODIES);
    const total = froms.length * auths.length * atts.length * subjects.length * bodies.length;

    it(`agrees with the oracle on all ${total} of them`, () => {
        let checked = 0, accepted = 0;
        const wrong = [];
        for (const from of froms) for (const auth of auths) for (const att of atts) for (const subject of subjects) for (const body of bodies) {
            const want = expected(from, auth, att, subject, body);
            const msg = message(from, auth, att, subject, body);
            const plan = planMessage(msg, policy);
            checked++;
            const got = plan.ok ? { ok: true, intent: plan.intent } : { ok: false, reason: plan.reason, security: plan.security === true };
            const same = want.ok ? got.ok && got.intent === want.intent : want.any ? !got.ok : !got.ok && got.reason === want.reason && got.security === want.security;
            if (want.ok) accepted++;
            if (!same && wrong.length < 12) wrong.push({ from, auth, att, subject, body, want, got });
        }
        expect(checked).toBe(total);
        expect(wrong, JSON.stringify(wrong, null, 1)).toEqual([]);
        // and it is not vacuous: a healthy share of the space IS accepted, and most of it is not
        expect(accepted).toBeGreaterThan(total / 100);
        expect(accepted).toBeLessThan(total / 4);
    });

    it('accepts a message ONLY from the approved address, with authentication that holds, a real document and no purchase wording in the subject', () => {
        for (const from of froms) for (const auth of auths) for (const att of atts) for (const subject of subjects) {
            const plan = planMessage(message(from, auth, att, subject, 'no body'), policy);
            if (!plan.ok) continue;
            expect(['approved', 'held']).toContain(FROMS[from].out);
            if (FROMS[from].out === 'held') expect(plan.items.every((i) => i.intent === 'suspect' && i.via === 'sibling')).toBe(true);
            expect(AUTHS[auth].out).toBe('pass');
            expect(['ok', 'ok-numeric']).toContain(ATTACHMENTS[att].out);
            expect(SUBJECTS[subject] === 'block' && !/statement/i.test(ATTACHMENTS[att].parts[0].filename)).toBe(false);
            for (const item of plan.items) expect(['stated', 'unproven', 'suspect']).toContain(item.intent);
        }
    });

    it('never offers a forgery back: a security refusal is not a refusal the owner can take', () => {
        let security = 0;
        for (const from of froms) for (const auth of auths) {
            const msg = message(from, auth, 'a statement PDF', 'Your Monthly Statement', 'no body');
            const plan = planMessage(msg, policy);
            if (plan.ok) continue;
            if (plan.security) {
                security++;
                expect(refusalOf(plan, msg, policy), `${from} / ${auth} was offered back to the owner`).toBeNull();
                expect(securityOf(plan, msg)).toMatchObject({ messageId: msg.id, reason: plan.reason });
                expect(isSecurityRefusal(plan)).toBe(true);
            } else {
                expect(securityOf(plan, msg)).toBeNull();
            }
        }
        expect(security).toBeGreaterThan(10);
    });

    it('the owner\'s own "take it" lifts an UNSIGNED message and nothing that is evidence of forgery', () => {
        let lifted = 0;
        for (const auth of auths) {
            const msg = message('the approved address', auth, 'a statement PDF', 'Your Monthly Statement', 'no body');
            const plain = planMessage(msg, policy), forced = planMessage(msg, { ...policy, forced: true });
            if (AUTHS[auth].out === 'unsigned') { expect(plain.ok).toBe(false); expect(forced.ok, auth).toBe(true); lifted++; }
            else if (AUTHS[auth].out !== 'pass') expect(forced.ok, `${auth} was let in by the owner's tap`).toBe(false);
        }
        expect(lifted).toBeGreaterThan(0);
    });
});

/* ── Layer 1, one attack at a time ────────────────────────────────────────────────────────────────────────────────── */

describe('Layer 1 — a From line is a claim, not a fact', () => {
    it('only Google\'s Authentication-Results counts, and of those the newest (topmost)', () => {
        expect(pickAuthHeader(['x.example; dkim=pass header.i=@hnb.lk', 'mx.google.com; dkim=fail']).value).toBe('mx.google.com; dkim=fail');
        expect(pickAuthHeader(['mx.google.com; dkim=none', 'mx.google.com; dkim=pass header.i=@hnb.lk']).value).toBe('mx.google.com; dkim=none');
        expect(pickAuthHeader(['mx.google.com; a', 'b.example; c']).count).toBe(2);
        expect(pickAuthHeader([]).value).toBe('');
        expect(pickAuthHeader(undefined).value).toBe('');
    });
    it('reads SPF, DMARC and every DKIM result, each paired with its own identity', () => {
        const a = authSummary('mx.google.com; dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net; spf=softfail (x); dmarc=fail (p=REJECT) header.from=hnb.lk');
        expect([...a.dkimPass]).toEqual(['evil.net']);
        expect([...a.dkimFail]).toEqual(['hnb.lk']);
        expect(a.spf).toBe('softfail');
        expect(a.dmarc).toBe('fail');
        expect(a.dmarcFrom).toBe('hnb.lk');
        expect(authSummary('').spf).toBe('');
        expect(authSummary(null).dmarc).toBe('');
    });
    it('a pass and a fail for SPF in one header: the failure is never outvoted', () => {
        expect(authSummary(['mx.google.com; spf=pass', 'mx.google.com; spf=fail']).spf).toBe('fail');
    });
    it('a forged header written into the mail cannot be what says it passed', () => {
        const msg = {
            id: 'forge1', internalDate: '1',
            payload: { headers: [{ name: 'From', value: 'statements@hnb.lk' }, { name: 'Subject', value: 'Statement' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=none; spf=pass' },
                { name: 'Authentication-Results', value: 'mx.google.com; dkim=pass header.i=@hnb.lk' }],
            mimeType: 'multipart/mixed', parts: [pdf('Statement.pdf')] },
        };
        const plan = planMessage(msg, policy);
        expect(plan.ok).toBe(false);
        expect(plan.reason).toBe(REJECT.DKIM_FAILED);
    });
    it('two From lines is a forgery, whatever else is true of the message', () => {
        const plan = planMessage(message('two From lines', 'all pass', 'a statement PDF', 'Statement', 'no body'), policy);
        expect(plan).toMatchObject({ ok: false, reason: REJECT.AUTH_FAILED, security: true });
        expect(plan.detail.why).toBe('multiple-from-headers');
    });
    it('a spam message failing SPF that never claimed to be a bank is not a security event', () => {
        const msg = { id: 's1', internalDate: '1', payload: { headers: [{ name: 'From', value: 'Deals <deals@shop.example>' }, { name: 'Subject', value: 'Sale' }, { name: 'Authentication-Results', value: 'mx.google.com; spf=fail; dmarc=fail header.from=shop.example' }], mimeType: 'multipart/mixed', parts: [pdf('catalogue.pdf')] } };
        const plan = planMessage(msg, policy);
        expect(plan.ok).toBe(false);
        expect(plan.security).not.toBe(true);
        expect(securityOf(plan, msg)).toBeNull();
    });
    it('the security log is bounded, newest first, one entry per message', () => {
        const rows = Array.from({ length: 150 }, (_, i) => ({ messageId: 'm' + (i % 120), reason: REJECT.AUTH_FAILED, at: i + 1 }));
        const merged = mergeSecurity([], rows);
        expect(merged).toHaveLength(100);
        expect(new Set(merged.map((r) => r.messageId)).size).toBe(100);
        expect(mergeSecurity(merged, merged)).toEqual(merged);
    });
});

/* ── Layer 2, the parts ───────────────────────────────────────────────────────────────────────────────────────────── */

describe('Layer 2 — the attachment', () => {
    it.each([
        ['application/pdf', 'Statement.pdf', true],
        ['application/pdf', 'Statement', true],
        ['application/pdf', '', true],
        ['application/pdf', 'Statement 01.12.2025', true],
        ['application/octet-stream', 'Statement.pdf', true],
        ['application/octet-stream', 'Statement', false],
        ['text/html', 'Smart_Statement.html', true],
        ['text/html', 'Smart_Statement.htm', true],
        ['text/html', '', true],
        ['application/pdf', 'Statement.pdf.exe', false],
        ['application/pdf', 'Statement.exe.pdf', false],
        ['application/pdf', 'Statement.scr', false],
        ['application/pdf', 'statement.html', false],
        ['text/html', 'statement.pdf', false],
        ['application/zip', 'statement.zip', false],
        ['application/pdf', 'statement.zip', false],
        ['application/vnd.ms-excel.sheet.macroenabled.12', 'statement.xlsm', false],
        ['image/png', 'statement.png', false],
        ['text/csv', 'statement.csv', false],
        ['application/octet-stream', 'x.js', false],
    ])('%s named "%s" is taken: %s', (mimeType, filename, want) => {
        expect(isStatementAttachment({ mimeType, filename })).toBe(want);
    });
    it('says which files it refused when that leaves nothing to take', () => {
        expect(selectAttachments({ parts: [pdf('x.pdf.exe')] })).toMatchObject({ ok: false, reason: REJECT.NO_ATTACHMENT });
    });
    it('the bytes have the last word: a program renamed statement.pdf is not a PDF', () => {
        expect(sniffKind(Buffer.from('%PDF-1.7\n%âãÏÓ'))).toBe('pdf');
        expect(sniffKind(Buffer.concat([Buffer.from('\n\n  '), Buffer.from('%PDF-1.4')]))).toBe('pdf');
        expect(sniffKind(Buffer.from('<!DOCTYPE html><html><body>x'))).toBe('html');
        expect(sniffKind(Buffer.from('﻿<html><body>x'))).toBe('html');
        expect(sniffKind(Buffer.from('MZ\x90\x00\x03\x00\x00\x00'))).toBe('other');
        expect(sniffKind(Buffer.from('PK\x03\x04 a zip'))).toBe('other');
        expect(sniffKind(Buffer.from('#!/bin/sh\nrm -rf /'))).toBe('other');
        expect(sniffKind(Buffer.from('plain text, not markup'))).toBe('other');
        expect(sniffKind(Buffer.alloc(0))).toBe('other');
        expect(sniffKind(null)).toBe('other');
    });
    it('reads the body, plain or HTML, without its markup or scripts', () => {
        const html = '<html><style>p{color:red}</style><script>alert(1)</script><p>Your <b>statement</b> is ready&nbsp;now</p></html>';
        expect(bodyTextOf({ parts: [{ mimeType: 'text/html', filename: '', body: { data: b64(html) } }] })).toBe('Your statement is ready now');
        expect(bodyTextOf({ parts: [{ mimeType: 'text/plain', filename: '', body: { data: b64('plain wins') } }, { mimeType: 'text/html', filename: '', body: { data: b64('<p>html</p>') } }] })).toBe('plain wins');
        expect(bodyTextOf({ parts: [pdf('x.pdf')] })).toBe('');
        expect(bodyTextOf(null)).toBe('');
    });
});

describe('Layer 2 — what the mail says it is', () => {
    const cases = [
        ['Monthly Statement', ['5996.pdf'], '', 'stated'],
        ['Invoice', ['5996.pdf'], '', 'block'],
        ['Receipt for your purchase', ['statement.pdf'], '', 'stated'],        // the statement word in the file name outranks
        ['Hello', ['Invoice-0008.pdf'], 'Your statement is attached', 'block'], // a body cannot rescue a file that calls itself an invoice
        ['Hello', ['5996.pdf'], 'Your statement is attached', 'stated'],
        ['Hello', ['5996.pdf'], 'Order confirmed. Thank you for your purchase.', 'suspect'],
        ['Hello', ['5996.pdf'], 'Order confirmed. Your statement is attached.', 'suspect'],
        ['Hello', ['5996.pdf'], 'You can manage your subscription here', 'suspect'],
        ['Hello', ['5996.pdf'], 'The minimum payment due is on page one', 'unproven'],   // a bill word in the body alone is not evidence against a card statement
        ['Hello', ['5996.pdf'], '', 'unproven'],
        ['', [], '', 'unproven'],
        ['Order Confirmed', ['5996.pdf'], 'Your statement is attached', 'block'],
        ['Payment Due', ['5996.pdf'], '', 'block'],
        ['Your subscription', ['5996.pdf'], '', 'block'],
    ];
    it.each(cases)('subject "%s", files %j, body "%s" → %s', (subject, filenames, body, want) => {
        expect(intentVerdict({ subject, filenames, body }).intent).toBe(want);
    });
    it('does not throw on anything', () => {
        for (const v of [undefined, null, 0, '', {}, { subject: null, filenames: null, body: null }, { filenames: 'x' }]) expect(() => intentVerdict(v)).not.toThrow();
    });
});

/* ── Layer 3, the named ambushes from the owner's brief ───────────────────────────────────────────────────────────── */

describe('Layer 3 — deceptive scenarios', () => {
    const build = (over) => {
        const base = { from: 'HNB Statements <statements@hnb.lk>', auth: [GOOGLE + 'dkim=pass header.i=@hnb.lk; spf=pass; dmarc=pass header.from=hnb.lk'], subject: 'Your Monthly Statement', parts: [pdf('Statement_2026JAN.pdf')] };
        const m = { ...base, ...over };
        return { id: 'x1', internalDate: '1', payload: { headers: [{ name: 'From', value: m.from }, { name: 'Subject', value: m.subject }, ...m.auth.map((v) => ({ name: 'Authentication-Results', value: v }))], mimeType: 'multipart/mixed', parts: [...(m.body ? [{ mimeType: 'text/plain', filename: '', body: { data: b64(m.body) } }] : []), ...m.parts] } };
    };
    it('the genuine message is accepted, stated, with its attachment', () => {
        const plan = planMessage(build({}), policy);
        expect(plan.ok).toBe(true);
        expect(plan.intent).toBe('stated');
        expect(plan.items).toHaveLength(1);
    });
    it('a marketing mail with a brochure PDF from the approved address is refused', () => {
        expect(planMessage(build({ subject: 'New offers for you', parts: [pdf('Brochure-2026.pdf')], body: 'Special promotion on subscription plans' }), policy)).toMatchObject({ ok: false, reason: REJECT.NOT_A_STATEMENT_DOC });
    });
    it('an inline bill or receipt with no attachment is refused', () => {
        expect(planMessage(build({ subject: 'Your receipt', parts: [], body: 'Receipt: LKR 4,200.00 paid' }), policy)).toMatchObject({ ok: false, reason: REJECT.NO_ATTACHMENT });
    });
    it('a receipt PDF from the approved address is refused', () => {
        expect(planMessage(build({ subject: 'Payment receipt', parts: [pdf('Receipt-2402-5154.pdf')] }), policy)).toMatchObject({ ok: false, reason: REJECT.NOT_A_STATEMENT_DOC });
    });
    it('a sub-domain of the bank that is NOT the approved address is taken only on evidence — and only as a document that must prove itself (a brochure is retired by its contents, never filed)', () => {
        const plan = planMessage(build({ from: 'Promo <offers@news.hnb.lk>', subject: 'New offers for you', parts: [pdf('Rewards.pdf')], auth: [GOOGLE + 'dkim=pass header.i=@news.hnb.lk'] }), policy);
        expect(plan.ok).toBe(true);
        expect(plan.items[0]).toMatchObject({ via: 'sibling', intent: 'suspect' });
        // with no signature that holds it is not taken at all
        const unsigned = planMessage(build({ from: 'Promo <offers@news.hnb.lk>', subject: 'New offers for you', parts: [pdf('Rewards.pdf')], auth: [GOOGLE + 'dkim=none'] }), policy);
        expect(unsigned.ok).toBe(false);
    });
    it('the same sub-domain sending something that says statement is taken — as a document that must prove itself', () => {
        const plan = planMessage(build({ from: 'Statements <estmt@news.hnb.lk>', auth: [GOOGLE + 'dkim=pass header.i=@news.hnb.lk'] }), policy);
        expect(plan.ok).toBe(true);
        expect(plan.items[0]).toMatchObject({ via: 'sibling', intent: 'suspect' });
    });
    it('a forged bank domain signed by the attacker\'s own valid key is a security event', () => {
        const plan = planMessage(build({ from: 'HNB <statements@hnb.lk.evil.net>', auth: [GOOGLE + 'dkim=pass header.i=@hnb.lk.evil.net'] }), policy);
        expect(plan).toMatchObject({ ok: false, reason: REJECT.NOT_A_BANK, security: true });
    });
    it('a malicious link disguised as a statement (body only, no attachment) is refused', () => {
        expect(planMessage(build({ parts: [], body: 'Your statement: http://hnb-secure.example/login' }), policy)).toMatchObject({ ok: false, reason: REJECT.NO_ATTACHMENT });
    });
    it('a mixed marketing/statement mail whose SUBJECT says statement is judged by its document, not thrown away', () => {
        const plan = planMessage(build({ subject: 'Your statement + new offers', body: 'Enjoy our subscription offers', parts: [pdf('Statement_2026JAN.pdf')] }), policy);
        expect(plan.ok).toBe(true);
        expect(plan.intent).toBe('stated');
    });
    it('a message the owner has approved but whose document names itself an invoice is refused, and logged as refused rather than as forgery', () => {
        const msg = build({ subject: 'Hello', parts: [pdf('Invoice-0008.pdf')] });
        const plan = planMessage(msg, policy);
        expect(plan).toMatchObject({ ok: false, reason: REJECT.NOT_A_STATEMENT_DOC });
        expect(plan.security).not.toBe(true);
        expect(refusalOf(plan, msg, policy)).toMatchObject({ reason: REJECT.NOT_A_STATEMENT_DOC });
    });
    it('the owner\'s tap lifts a refused invoice-name only to "suspect": the document must then prove itself', () => {
        const plan = planMessage(build({ subject: 'Hello', parts: [pdf('Invoice-0008.pdf')] }), { ...policy, forced: true });
        expect(plan.ok).toBe(true);
        expect(plan.items[0].intent).toBe('suspect');
    });
});

/* ── determinism ──────────────────────────────────────────────────────────────────────────────────────────────────── */

describe('the engine is deterministic and does not mutate what it is given', () => {
    it('the same message judged twice, and after a deep freeze, gives the same answer', () => {
        const msg = message('the approved address', 'all pass', 'a statement PDF', 'Your Monthly Statement', 'says statement');
        const a = JSON.stringify(planMessage(msg, policy));
        const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };
        deepFreeze(msg);
        expect(JSON.stringify(planMessage(msg, policy))).toBe(a);
    });
    it('survives malformed messages without throwing', () => {
        for (const m of [null, undefined, {}, { payload: null }, { payload: { headers: null } }, { payload: { headers: [null, {}, { name: 'From' }] } }, { id: 1, payload: { headers: [{ name: 'From', value: 5 }] } }]) {
            expect(() => planMessage(m, policy)).not.toThrow();
            expect(planMessage(m, policy).ok).toBe(false);
        }
    });
});
