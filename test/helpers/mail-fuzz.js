/* =============================================================================
 * test/helpers/mail-fuzz.js — a seeded generator of enterprise bank mail, genuine and hostile, with the truth attached.
 *
 * Every message it makes carries a LABEL written by the generator, not computed from the code under test:
 *     genuine   — from one of the four approved addresses (in any benign shape a mail system writes), with an authentication
 *                 verdict that vouches for it, a real statement document and no purchase wording: it MUST be taken;
 *     forged    — anything that is not that: a stranger dressed as a bank, a bank address with a failing or missing verdict, a
 *                 header built to confuse the reader, a document that is not a statement: it MUST NOT be taken.
 * Same seed, same mail, always.
 * ===========================================================================*/

export function rng(seed) { let s = (Math.imul(seed | 0, 2654435761) >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

export const BANKS = [
    { name: 'HNB', address: 'e-statements@hnb.lk', domain: 'hnb.lk', display: ['HNB', 'Hatton National Bank', 'HNB e-Statements'] },
    { name: 'NTB', address: 'estatement@info.nationstrust.com', domain: 'info.nationstrust.com', display: ['NTB', 'Nations Trust Bank', 'NTB eStatement'] },
    { name: 'DFCC Bank', address: 'statements@dfccbank.com', domain: 'dfccbank.com', display: ['DFCC Bank', 'DFCC', 'DFCC Statements'] },
    { name: 'AMEX', address: 'nationstrust@estmt.nationstrust.com', domain: 'estmt.nationstrust.com', display: ['American Express', 'AMEX', 'Nations Trust AMEX'] },
];
const GOOGLE = 'mx.google.com; ';
/** The registrable part (last two labels) of a domain, and what is in front of it. Only changing the former makes a look-alike; a sub-domain of the bank's own organisation is the bank's. */
const split = (domain) => { const labels = domain.split('.'); return { front: labels.slice(0, -2).join('.'), org: labels.slice(-2).join('.') }; };
const withOrg = (domain, change) => { const { front, org } = split(domain); return (front ? front + '.' : '') + change(org); };
const pick = (r, list) => list[Math.floor(r() * list.length)];
const b64 = (t) => Buffer.from(t, 'utf8').toString('base64url');

/** Benign shapes of a genuine address: what real mail systems write. */
const BENIGN = [
    (a) => a, (a) => `Bank <${a}>`, (a) => `"Bank Statements" <${a}>`, (a) => `"Bank, e-Statements" <${a}>`, (a) => `"${a}" <${a}>`, (a) => `<${a}>`,
    (a) => `Bank <${a.toUpperCase()}>`, (a) => `${a} (Bank Statements)`, (a) => `Bank (statements) <${a}>`, (a) => `  Bank   <  ${a}  >  `, (a) => `Bank\r\n <${a}>`, (a) => `Bank <${a}> (statements)`,
    (a) => `=?UTF-8?B?${Buffer.from('Bank Statement').toString('base64')}?= <${a}>`, (a) => `Bank <${a}.>`, (a) => `"Bank <${a}>" <${a}>`,
];
/** Authentication Google could report that VOUCHES for the From domain. */
const GOOD_AUTH = [
    (d) => GOOGLE + `dkim=pass header.i=@${d}; spf=pass smtp.mailfrom=${d}; dmarc=pass header.from=${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@${d}; spf=fail; dmarc=pass header.from=${d}`,
    (d) => GOOGLE + `spf=pass smtp.mailfrom=${d}; dmarc=pass (p=REJECT) header.from=${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@mail.${d}; spf=pass smtp.mailfrom=bounce.sendgrid.net; dmarc=pass header.from=${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@${d.split('.').slice(-2).join('.')}; dmarc=pass header.from=${d}`,
];
/** Authentication that must NOT vouch for a bank address. */
const BAD_AUTH = [
    (d) => GOOGLE + `dkim=pass header.i=@${d}; dmarc=fail (p=NONE) header.from=${d}`,
    (d) => GOOGLE + `dkim=fail header.i=@${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@evil.example; spf=pass; dmarc=fail header.from=${d}`,
    (d) => GOOGLE + `dkim=pass header.i=@evil.example; dmarc=pass header.from=evil.example`,
    (d) => GOOGLE + `spf=fail`, (d) => GOOGLE + `spf=softfail; dmarc=fail header.from=${d}`,
    (d) => GOOGLE + `dkim=none; spf=none`, (d) => null,                                                // nothing at all
    (d) => 'attacker.example; dkim=pass header.i=@' + d + '; dmarc=pass header.from=' + d,            // not Google's header
];
const GENUINE_DOC = [
    { filename: 'Statement_2026MAR.pdf', mimeType: 'application/pdf' }, { filename: 'eStatement_2026FEB.html', mimeType: 'text/html' }, { filename: 'DFCC_Statement_202601.pdf', mimeType: 'application/pdf' },
    { filename: 'Consolidated_eStatement_2026MAR_458290.html', mimeType: 'text/html' }, { filename: 'Account Statement 01.12.2025.pdf', mimeType: 'application/pdf' },
];
const BAD_DOC = [
    { filename: 'Invoice_10442.pdf', mimeType: 'application/pdf' }, { filename: 'Receipt-2402-5154-7274.pdf', mimeType: 'application/pdf' }, { filename: 'statement.pdf.exe', mimeType: 'application/octet-stream' },
    { filename: 'statement.exe.pdf', mimeType: 'application/octet-stream' }, { filename: 'archive.zip', mimeType: 'application/zip' }, { filename: 'logo.png', mimeType: 'image/png' }, { filename: 'run.js', mimeType: 'application/javascript' },
];
const GOOD_SUBJECTS = ['Your account statement for March 2026', 'e-Statement', 'DFCC Bank Statement', 'Your HNB Account Statement for 074-02-XXXXX-88', 'Monthly Smart Statement', 'ඔබගේ ගිණුම් ප්‍රකාශය Statement'];
const BAD_SUBJECTS = ['Your order confirmed - receipt', 'Invoice #10442 payment due', 'Subscription renewed: receipt attached', 'Payment due: your order'];

/** Hostile ways of writing the From line, each with a stranger (or nobody) behind it. */
const HOSTILE_FROM = [
    (b, r) => `"${b.address}" <billing@evil.example>`, (b) => `"${b.display[0]} <${b.address}>" <x@evil.example>`, (b) => `${b.address} <mallory@evil.example>`,
    (b) => `${b.display[0]} <${b.address}>, Other <x@evil.example>`, (b) => `Other <x@evil.example>, ${b.display[0]} <${b.address}>`, (b) => `${b.address}, x@evil.example`,
    (b) => `${b.display[0]} <${b.address}.evil.example>`, (b) => `${b.display[0]} <${b.address.split('@')[0]}@${withOrg(b.domain, (o) => 'mail-' + o)}>`, (b) => `${b.display[0]} <${b.address.split('@')[0]}@${b.domain.replace(/\./g, '-')}.com>`,
    (b) => `${b.display[0]} <${b.address.split('@')[0]}@${withOrg(b.domain, (o) => o.replace(/[aeokl]/, (c) => ({ a: '\u0430', e: '\u0435', o: '\u043e', k: '\u043a', l: '\u04cf' })[c]))}>`,                // a Cyrillic look-alike letter in the registrable domain
    (b) => `${b.display[0]} <${b.address}@evil.example>`, (b) => `${b.display[0]} <${b.address.split('@')[0]}@gmail.com>`, (b) => `${b.display[0]} <>`, (b) => `${b.display[0]}`, (b) => '', (b) => `<${b.address.split('@')[0]}>`,
    (b) => `"unterminated <${b.address}>`, (b) => `${b.display[0]} (open comment <${b.address}>`, (b) => `${'A'.repeat(5000)} <x@evil.example>`, (b) => `${b.display[0]} <${b.address}>\u0000<x@evil.example>`,
    (b) => `${b.display[0]} <x@evil.example>\r\nFrom: ${b.address}`, (b) => `=?UTF-8?B?!!!not-base64!!!?= <x@evil.example>`, ];

const part = (doc, n) => ({ mimeType: doc.mimeType, filename: doc.filename, body: { attachmentId: 'att-' + n, size: 4000 } });
const text = (t) => ({ mimeType: 'text/plain', filename: '', body: { data: b64(t) } });

/**
 * @returns {{ id, label: 'genuine'|'forged'|'sibling', why: string, message: object }}
 */
export function makeMail(seed) {
    const r = rng(seed * 7919 + 13);
    const bank = pick(r, BANKS);
    const kind = r();
    let label = 'genuine', why = 'approved address, vouched for, real statement';
    let from = pick(r, BENIGN)(bank.address), auth = pick(r, GOOD_AUTH)(bank.domain), doc = pick(r, GENUINE_DOC), subject = pick(r, GOOD_SUBJECTS), body = 'Your statement is attached.';
    const headers = [];
    const forged = (reason) => { label = 'forged'; why = reason; };
    if (kind < 0.55) { /* genuine as chosen */ }
    else if (kind < 0.72) { from = pick(r, HOSTILE_FROM)(bank, r); forged('hostile From line'); }
    else if (kind < 0.76) { from = `${pick(r, bank.display)} <${pick(r, ['statement', 'estatements', 'noreply', 'a'.repeat(120)])}@${bank.domain}>`; label = 'sibling'; why = 'another mailbox at the approved bank domain, vouched for'; }
    else if (kind < 0.86) { auth = pick(r, BAD_AUTH)(bank.domain); forged('authentication that does not vouch'); }
    else if (kind < 0.93) { doc = pick(r, BAD_DOC); forged('not a statement document'); }
    else if (kind < 0.97) { subject = pick(r, BAD_SUBJECTS); doc = { filename: 'Invoice_10442.pdf', mimeType: 'application/pdf' }; body = 'Thank you for your order. Receipt and invoice attached.'; forged('a purchase receipt'); }
    else { from = `Mallory <mallory@evil.example>`; auth = GOOD_AUTH[0]('evil.example'); headers.push({ name: ['Return-Path', 'Reply-To', 'Sender', 'X-Original-From'][Math.floor(r() * 4)], value: `<${bank.address}>` }); forged('a stranger naming the bank in a header only the sender writes'); }
    // header noise that never changes who the mail is from
    if (r() < 0.25) headers.push({ name: 'X-Mailer', value: 'enterprise-mailer ' + Math.floor(r() * 1000) });
    if (r() < 0.15) headers.push({ name: 'Received', value: 'from mail.example by mx.google.com' });
    if (r() < 0.1) headers.push({ name: 'Subject', value: subject });                                       // a duplicated Subject
    const parts = [text(body), part(doc, seed)];
    if (r() < 0.2) parts.push(text('<html><body>footer</body></html>'));
    // Google ALWAYS writes its own header, above whatever the sender wrote: when the sender's mail carries no vouching verdict,
    // Google's says so ("none"), and anything the sender wrote about itself sits below it.
    const authHeaders = [];
    if (auth && auth.startsWith(GOOGLE)) authHeaders.push({ name: 'Authentication-Results', value: auth });
    else authHeaders.push({ name: 'Authentication-Results', value: GOOGLE + 'dkim=none; spf=none; dmarc=none' }, ...(auth ? [{ name: 'Authentication-Results', value: auth }] : []));
    // a forged Authentication-Results written by the sender, BELOW Google's own, claiming a pass
    if (r() < 0.25) authHeaders.push({ name: 'Authentication-Results', value: GOOGLE + `dkim=pass header.i=@${bank.domain}; dmarc=pass header.from=${bank.domain}` });
    const fromHeaders = from === '' ? [] : [{ name: 'From', value: from }];
    if (!fromHeaders.length) forged('no From at all');
    return { id: 'fuzz-' + seed, label, why, bank, message: { id: 'fuzz-' + seed, internalDate: String(Date.parse('2026-04-02T05:00:00Z')),
        payload: { mimeType: 'multipart/mixed', headers: [...fromHeaders, { name: 'Subject', value: subject }, ...authHeaders, ...headers], parts } } };
}
