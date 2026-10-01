/* =============================================================================
 * wealthflow-mail-ingest.mjs — deciding what, from a mailbox, is a statement
 * -----------------------------------------------------------------------------
 * The server half of the mail pipeline. Gmail hands it a message; this decides
 * whether the message is a bank statement, which attachment to take, and how to
 * store it. It never decrypts anything and never sees a statement password —
 * the ciphertext goes to the device, and wealthflow-mail-intake.js opens it
 * there with the local vault.
 *
 * Pure and injectable, for the same reason the rest of this pipeline is: the
 * decisions worth testing are here, and they are testable without a mailbox,
 * a Google Cloud project, or a network.
 *
 * ── WHY THE SENDER IS NOT ENOUGH ────────────────────────────────────────────
 *
 * The obvious rule is "if it is from @hnb.lk and has a PDF, ingest it". A From
 * header is a string the sender chooses. Anyone can put `statements@hnb.lk` in
 * it, attach a PDF of invented transactions, and — under that rule — have those
 * transactions routed into someone's ledger. Nothing downstream would catch it:
 * the parser would read it, the router would classify it, and the numbers would
 * be as wrong as the attacker liked.
 *
 * So the domain has to be one Google VERIFIED, not one the sender asserted.
 * Gmail adds an `Authentication-Results` header describing DKIM, SPF and DMARC
 * as it evaluated them on receipt, and that header — read back through the API
 * for a message in the user's own mailbox — is Google's statement, not the
 * sender's. `dkim=pass header.i=@hnb.lk` means the message really was signed by
 * a key published in hnb.lk's DNS.
 *
 * The rule is therefore: the From domain must be on the allowlist AND DKIM must
 * pass FOR THAT SAME DOMAIN. A message signed by a domain other than the one it
 * claims to be from is exactly the shape of the attack, so the two are compared
 * rather than checked separately.
 *
 * ── AN ALLOWLIST, NOT A DENYLIST ────────────────────────────────────────────
 *
 * This repository has already shipped one "allowlist" that was a denylist
 * wearing the name — autonomy/classify-index-diff.mjs judged functions by their
 * names and pronounced 442 of 735 declarations safe, including the sign-in flow.
 * The rule here is the inverse by construction: nothing is ingested unless its
 * domain is named below. An unrecognised sender is not a threat to be detected,
 * it is simply not a bank, and the correct response is to do nothing.
 *
 * ── AT-LEAST-ONCE DELIVERY IS THE NORMAL CASE ───────────────────────────────
 *
 * Pub/Sub redelivers. A push that times out, a 500, a duplicate publish, and a
 * history replay after a restart all deliver the same message again — this is
 * documented behaviour, not an error condition. Everything here is keyed on
 * (messageId, attachmentId), which Gmail assigns and which is stable across
 * redeliveries, so the second arrival writes the same document and changes
 * nothing rather than filing the statement twice.
 * ===========================================================================*/

/* ── the allowlist ────────────────────────────────────────────────────────── */

/**
 * Domains whose mail may become a statement, and the name shown to the user.
 *
 * Adding one is a deliberate act: it grants a domain the ability to put
 * transactions in front of the ledger. Subdomains are matched, so `@e.amex.com`
 * satisfies `amex.com`, but only downward — `amex.com.attacker.net` does not,
 * because the match is anchored to a label boundary at the end.
 */
import { BANK_DOMAINS } from './wealthflow-institutions.js';
import { nameVerdict, intentVerdict, VERDICT as ID_VERDICT } from './wealthflow-statement-identity.js';
import { STATEMENT_TERMS } from './wealthflow-backfill.js';

/* DERIVED, NOT DECLARED. This used to be a hand-written list of four
 * institutions while index.html's picker offered fourteen, and nothing compared
 * them — so an owner banking with Sampath or Seylan or BOC had accounts this
 * pipeline had never heard of, and the only symptom was statements that never
 * arrived. Both now come from wealthflow-institutions.js, which is the single
 * place a bank is described. Two copies of a classifier is one more than can be
 * kept in step, and this file is where that cost was paid. */
export const BANKS = BANK_DOMAINS.map((b) => ({ domain: b.domain, name: b.name }));

/* Mailboxes people own, rather than institutions that send statements.
 *
 * Anyone with a Gmail account gets a valid DKIM signature for gmail.com, so
 * "signed by the domain it claims" is not evidence of anything here — it is
 * the default. A statement does not arrive from a personal mailbox, and
 * letting these through would put every friend's PDF invoice in the review
 * queue and hand a stranger a way to put one there too. */
export const CONSUMER_MAIL = new Set([
    'gmail.com', 'googlemail.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com',
    'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
    'icloud.com', 'me.com', 'mac.com',
    'proton.me', 'protonmail.com', 'pm.me',
    'aol.com', 'zoho.com', 'gmx.com', 'mail.com', 'yandex.com',
]);

export const REJECT = {
    NOT_A_BANK: 'sender-not-on-allowlist',
    /* The owner said no to this sender by name. Distinct from every other
     * refusal here because it is the only one that is not a judgement: it is an
     * instruction, and it is obeyed before anything else is considered. */
    SENDER_BLOCKED: 'you-blocked-this-sender',
    /* The owner has curated a list and this sender is not on it. Kept apart
     * from NOT_A_STATEMENT so the review screen can say which of the two
     * happened: "you have not decided about this one yet" is an invitation,
     * "nothing about it says statement" is a verdict. */
    NOT_ON_YOUR_LIST: 'sender-not-on-your-list',
    /* A NEW ADDRESS AT A BANK THEY ALREADY APPROVED. Distinct from
     * NOT_ON_YOUR_LIST because it is a different question to put to the owner:
     * "is this Sampath too?" rather than "who is this?". It is still a refusal
     * — approving one address is not approving a domain — but the mail is HELD
     * rather than dropped, so one tap releases it. */
    SENDER_SIBLING: 'a-new-address-at-a-bank-you-approved',
    NOT_A_STATEMENT: 'unrecognised-sender-and-nothing-says-statement',
    /* THE DOCUMENT ANNOUNCED ITSELF AS SOMETHING ELSE — an invoice, a receipt,
     * a payslip — whoever sent it. Kept apart from NOT_A_STATEMENT above, which
     * is the weaker "nobody vouches for this sender AND nothing says statement";
     * this one holds even for a bank the owner approved by name, because
     * approving a sender means they MAY send statements, not that everything
     * they send is one. That conflation is the bug the owner reported four
     * times. See wealthflow-statement-identity.js. */
    NOT_A_STATEMENT_DOC: 'the-attachment-is-not-a-bank-statement',
    DKIM_FAILED: 'dkim-did-not-pass',
    DKIM_DOMAIN_MISMATCH: 'signed-by-a-different-domain',
    /* SPF or DMARC said the message is NOT from the domain it claims — or the header that says so cannot be trusted
     * (two From lines). Evidence of forgery, not absence of a signature: dropped, logged as a security anomaly, and
     * never one tap from being taken. */
    AUTH_FAILED: 'spf-or-dmarc-failed',
    NO_ATTACHMENT: 'no-pdf-attachment',
    TOO_LARGE: 'attachment-over-the-size-ceiling',
    TOO_MANY: 'more-attachments-than-a-statement-should-have',
};

/* Mirrors statement-store.js, which already solved this: a Firestore document
 * is capped near 1 MiB counting name and index overhead, so a base64 payload
 * above the threshold is split and a manifest naming the part count is written
 * LAST — its existence is the proof every part landed. */
export const SINGLE_MAX = 700 * 1024;
export const CHUNK_SIZE = 700 * 1024;
export const MAX_PARTS = 16;
/** 16 x 700 KiB of base64 is about 8.4 MB of PDF. */
export const MAX_BASE64 = CHUNK_SIZE * MAX_PARTS;
/** A statement email carries a statement — or one per card or account. Twelve is the
 * most a real bank sends in one message; a message with more is not a statement, and
 * refusing it is told to the owner. It used to be four, which refused a bank that
 * sent one statement per card in a single email — a whole month lost in one refusal. */
export const MAX_ATTACHMENTS = 12;

const lower = (s) => String(s == null ? '' : s).toLowerCase().trim();

/* ── 1. who sent it ───────────────────────────────────────────────────────── */

/**
 * The address out of a From header, whatever shape the display name takes.
 *
 * A DISPLAY NAME IS NOT AN ADDRESS, AND IT CAN BE MADE TO LOOK LIKE ONE. The
 * header is `display-name <addr-spec>`, and the display name may be a quoted
 * string carrying anything at all — including angle brackets around something
 * shaped exactly like an address:
 *
 *     From: "Statements <statements@hnb.lk>" <someone@elsewhere.example>
 *
 * Every reader here took the FIRST angled group, which is the one inside the
 * quotes: the sender's own text decided who the message was from. Downstream
 * that was a signature check against the wrong domain — so a real statement was
 * refused — and, on the mailbox card, a row attributed to a sender that never
 * sent it, which is a row the owner could approve or sweep by mistake.
 *
 * Quoted strings are removed first, then the LAST angled group is taken, which
 * is the addr-spec in every shape a mail client produces.
 */
/**
 * RFC 5322 reading of an address header: quoted strings AND comments are removed, wherever they are, before anything is
 * looked for. `statements@dfccbank.com (DFCC Bank)` — an address with a trailing comment, which older mail systems write
 * — used to come out as the "address" `statements@dfccbank.com (dfcc bank)` with the "domain" `dfccbank.com (dfcc bank)`,
 * which matches no approved sender: every statement from such a bank was a stranger. Returns null when a quote or a
 * comment is never closed, so the caller keeps the older, forgiving reading.
 */
function skeletonOf(s) {
    let out = '', inQuote = false, depth = 0;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inQuote) { if (c === '\\') i++; else if (c === '"') { inQuote = false; out += ' '; } continue; }
        if (depth > 0) { if (c === '\\') i++; else if (c === '(') depth++; else if (c === ')') { depth--; if (!depth) out += ' '; } continue; }
        if (c === '"') { inQuote = true; continue; }
        if (c === '(') { depth = 1; continue; }
        out += c;
    }
    return inQuote || depth > 0 ? null : out;
}
const tidyAddress = (a) => String(a).replace(/^mailto:/, '').replace(/[<>\s,;]+$/, '').trim().replace(/\.+$/, '');

export function addressOf(from) {
    const s = lower(from);
    /* Backslash escapes honoured, so a quoted string containing \" does not end
     * where it appears to. An unterminated quote matches nothing and leaves the
     * header exactly as it was — the angle brackets below still decide. */
    const bare = skeletonOf(s) ?? s.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    let addr = '';
    const re = /<([^<>]*)>/g;
    let m;
    while ((m = re.exec(bare)) !== null) addr = m[1];
    if (!addr) addr = bare;
    return tidyAddress(addr);
}

/**
 * Is this a From line a mail system could have written? Bank statements come from machines, and a machine writes a clean header.
 * Refused outright — never guessed at — are: a control character (a NUL, a bare CR or LF, an escape: the shapes of header
 * injection), an unterminated quote or comment, angle brackets that do not pair up, and a line longer than any mail program
 * writes. A CRLF followed by a space or tab is a fold and is fine. When two readers could disagree about who a message is from,
 * the intake does not pick one: it refuses (and logs it as a security event).
 */
export function wellFormedFrom(value) {
    const s = String(value == null ? '' : value);
    if (!s.trim() || s.length > 2000) return false;
    const unfolded = s.replace(/\r\n[ \t]/g, ' ');
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\r\n]/.test(unfolded)) return false;
    const skeleton = skeletonOf(unfolded);
    if (skeleton === null) return false;
    let open = 0;
    for (const c of skeleton) { if (c === '<') { if (open) return false; open++; } else if (c === '>') { if (!open) return false; open--; } }
    return open === 0;
}

/**
 * EVERY mailbox a From header names, lower-cased, de-duplicated, in order. One for a normal message. More than one is
 * not something a bank's statement mailer writes, and which of them a reader shows is the reader's choice — so the
 * intake treats it exactly like two From lines (see planCore).
 */
export function addressesOf(from) {
    const s = lower(from);
    const bare = skeletonOf(s) ?? s.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    const out = [];
    const angled = [...bare.matchAll(/<([^<>]*)>/g)].map((m) => tidyAddress(m[1])).filter((a) => a.includes('@'));
    // a bare mailbox list ("a@x.com, b@y.com") has no angle brackets; with them, the angled part is the mailbox
    const found = angled.length ? angled : bare.split(/[,;]/).map(tidyAddress).filter((a) => a.includes('@'));
    for (const a of found) if (!out.includes(a)) out.push(a);
    return out;
}

/** The domain out of a From header, whatever shape the display name takes. */
export function domainOf(from) {
    const addr = addressOf(from);
    const at = addr.lastIndexOf('@');
    if (at < 0) return '';
    return addr.slice(at + 1).replace(/[>\s,;]+$/, '').replace(/\.+$/, '').trim();
}

/** `a.b.example.com` is under `example.com`; `example.com.evil.net` is not. */
export function isUnder(domain, parent) {
    const d = lower(domain);
    const p = lower(parent);
    if (!d || !p) return false;
    return d === p || d.endsWith('.' + p);
}

/**
 * Every domain Google reported a DKIM PASS for on this message.
 *
 * The header looks like:
 *   mx.google.com; dkim=pass header.i=@hnb.lk; spf=pass ...; dmarc=pass ...
 *
 * Only `dkim=pass` counts, and only the domain attached to THAT result. A
 * header carrying `dkim=fail header.i=@hnb.lk; dkim=pass header.i=@evil.net`
 * must not be read as "hnb.lk passed", so each result is paired with the
 * identity that follows it rather than collecting all identities in the line.
 */
export function dkimPassedFor(authResults) {
    const out = new Set();
    for (const line of (Array.isArray(authResults) ? authResults : [authResults])) {
        const s = lower(line);
        if (!s) continue;
        const re = /dkim=(\w+)([^;]*)/g;
        let m;
        while ((m = re.exec(s))) {
            if (m[1] !== 'pass') continue;
            const id = /header\.(?:i|d)=@?([a-z0-9.-]+)/.exec(m[2]);
            if (id && id[1]) out.add(id[1].replace(/^\.+|\.+$/g, ''));
        }
    }
    return out;
}

/**
 * WHICH `Authentication-Results` HEADER IS GOOGLE'S.
 *
 * A message can carry several, and all but one are the sender's own text: anyone can write
 * `Authentication-Results: mx.google.com; dkim=pass header.i=@hnb.lk` into the mail they send. Google adds its own at
 * the TOP when it receives the message. The old reader kept whichever header came LAST — the bottom-most, the one
 * the sender controls. So: only a header whose authserv-id is a google.com host counts, and of those the first, which is
 * the newest; with none, the topmost one (another provider's, or a test's).
 */
export function pickAuthHeader(values) {
    const list = (Array.isArray(values) ? values : [values]).map((v) => String(v == null ? '' : v)).filter((v) => v.trim());
    const idOf = (v) => lower(v).split(';')[0].trim().split(/\s+/)[0];
    const google = list.filter((v) => /(^|\.)google\.com$/.test(idOf(v)));
    const value = google.length ? google[0] : (list[0] || '');
    return { value, count: list.length, google: google.length };
}

/**
 * Everything Google said about the message, as data: each DKIM result with its signing domain, SPF and DMARC.
 * `spf` and `dmarc` are the worst result seen (an explicit fail is never outvoted by a pass elsewhere in the line).
 */
export function authSummary(authResults) {
    const out = { dkimPass: new Set(), dkimFail: new Set(), spf: '', dmarc: '', dmarcFrom: '' };
    const rank = { fail: 4, hardfail: 4, permerror: 3, softfail: 3, temperror: 2, neutral: 1, none: 1, pass: 0 };
    const worse = (a, b) => (!a || (rank[b] || 0) > (rank[a] || 0) ? b : a);
    for (const line of (Array.isArray(authResults) ? authResults : [authResults])) {
        const s = lower(line);
        if (!s) continue;
        for (const part of s.split(';')) {
            const m = /^\s*(dkim|spf|dmarc)\s*=\s*([a-z]+)\b([\s\S]*)$/.exec(part);
            if (!m) continue;
            const [, what, result, rest] = m;
            if (what === 'dkim') {
                const id = /header\.(?:i|d)=@?([a-z0-9.-]+)/.exec(rest);
                const dom = id && id[1] ? id[1].replace(/^\.+|\.+$/g, '') : '';
                if (result === 'pass') { if (dom) out.dkimPass.add(dom); } else if (result === 'fail' || result === 'permerror') out.dkimFail.add(dom || '?');
            } else if (what === 'spf') out.spf = worse(out.spf, result);
            else {
                out.dmarc = worse(out.dmarc, result);
                const hf = /header\.from=@?([a-z0-9.-]+)/.exec(rest);
                if (hf) out.dmarcFrom = hf[1];
            }
        }
    }
    return out;
}

/** SPF said the sending host is not allowed to send for the domain. `neutral`, `none` and a DNS hiccup are not evidence. */
export const SPF_BAD = new Set(['fail', 'hardfail', 'softfail', 'permerror']);

/**
 * Which bank sent this, if any — and only if Google says the signature holds.
 *
 * @param headers  { from, 'authentication-results' } (case-insensitive keys)
 * @returns {{ok:true, bank:string, domain:string} | {ok:false, reason:string, detail:object}}
 */
/**
 * A display name for a bank nobody listed. `sampathbank.lk` -> `Sampathbank`.
 * Deliberately dumb: this label is shown beside the message in the review
 * queue, where the owner can see the real domain and correct it. Guessing
 * harder than this would only produce confident nonsense.
 */
export function nameFromDomain(domain) {
    const first = String(domain || '').split('.')[0] || '';
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

/**
 * Which bank sent this, if any — and only if Google says the signature holds.
 *
 * WHY THIS NO LONGER REQUIRES THE ALLOWLIST.
 *
 * It used to reject anything not in BANKS, which names four institutions. The
 * owner banks with more than ten, and index.html's own dropdown lists fifteen,
 * so eleven banks' statements were dropped here with `sender-not-on-allowlist`
 * even on the rare occasion the old query fetched one at all.
 *
 * The allowlist was doing two different jobs and only one of them was security.
 * Naming the bank is useful. GATING on it was never the control — the control
 * is the DKIM check below, and that works for any domain in the world: the
 * message must carry a passing signature from the domain it claims to be from.
 * An unlisted sender that clears it is not less verified than HNB; it is
 * exactly as verified, and merely unrecognised.
 *
 * So an unlisted sender is now returned with `known: false`, which routes it to
 * the review queue rather than into the ledger. Nothing is auto-filed on the
 * strength of a domain nobody has confirmed, and nothing is silently dropped.
 *
 * Three things are still refused outright, because for these a signature
 * proves nothing:
 *   - no From domain at all;
 *   - a personal mailbox (see CONSUMER_MAIL) — anyone can sign as gmail.com;
 *   - a LOOKALIKE of a listed bank, such as hnb.lk.attacker.net, which is a
 *     deliberate attempt to be mistaken for one and must not reach a queue
 *     where it is displayed next to the real thing.
 *
 * @param headers  { from, 'authentication-results' } (case-insensitive keys)
 * @returns {{ok:true, bank:string, domain:string, known:boolean}
 *          | {ok:false, reason:string, detail:object}}
 */
export function identifyBank(headers, policy = {}) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[lower(k)] = v;

    const from = domainOf(h.from);
    if (!from) return { ok: false, reason: REJECT.NOT_A_BANK, detail: { from: '(none)' } };

    /* THE OWNER'S OWN ANSWER, ASKED FIRST.
     *
     * `policy.decide` is injected rather than imported so this module keeps no
     * dependency on the one that stores the list — they would otherwise import
     * each other. Absent, it answers `new` for everything, which is exactly the
     * behaviour this function had before the list existed, so every existing
     * caller and test is unaffected.
     *
     * A BLOCK IS OBEYED BEFORE ANYTHING ELSE IS CONSIDERED. It is the one
     * decision here that cannot be wrong in a dangerous direction: refusing
     * more mail than strictly necessary loses a statement the owner can fetch
     * by hand, while accepting mail they told us to refuse is the complaint
     * that produced this file. */
    const decide = typeof policy.decide === 'function' ? policy.decide : null;
    const said = decide ? (decide(h.from) || {}) : {};
    if (said.verdict === 'blocked') {
        return { ok: false, reason: REJECT.SENDER_BLOCKED, detail: { from } };
    }

    const hit = BANKS.find((b) => isUnder(from, b.domain));

    if (!hit) {
        /* `hnb.lk.attacker.net` contains a listed domain without being under
         * it. That is not an unrecognised bank, it is an impersonation.
         *
         * The owner's approved domains are checked HERE as well as the built-in
         * list, and they matter more: a domain someone has explicitly approved
         * is a domain worth impersonating, and it is the one they will read
         * least carefully in a list of their own banks. */
        const guarded = [...BANKS.map((b) => b.domain), ...(Array.isArray(policy.domains) ? policy.domains : [])];
        const lookalike = guarded.find((d) => d && from !== lower(d) && from.includes(lower(d)) && !isUnder(from, lower(d)));
        if (lookalike) {
            return { ok: false, reason: REJECT.NOT_A_BANK, detail: { from, lookalikeOf: lower(lookalike) } };
        }
        if (CONSUMER_MAIL.has(from)) {
            return { ok: false, reason: REJECT.NOT_A_BANK, detail: { from, personalMailbox: true } };
        }
    }

    const authHeader = h['authentication-results'];
    const passed = dkimPassedFor(authHeader);
    const auth = authSummary(authHeader);
    const claimedName = hit ? hit.name : from;
    const authSeen = { spf: auth.spf || 'none', dmarc: auth.dmarc || 'none', dkim: [...passed].slice(0, 3), dkimFailed: [...auth.dkimFail].slice(0, 3) };
    /* The signing domain must cover the domain the message claims to be from.
     * A valid signature by some other domain is the attack, not a pass. */
    const signedByClaimed = [...passed].some((d) => isUnder(from, d) || (hit && isUnder(d, hit.domain)));
    /* DMARC IS THE RECEIVER'S OWN VERDICT THAT THE FROM DOMAIN IS AUTHENTIC. `dmarc=pass header.from=<this domain>` means
     * Google found a DKIM signature or an SPF result that is ALIGNED with the From domain — "aligned" meaning the same
     * organisation, so a signature by mail.bank.com or by a sibling sub-domain of the From's own organisation counts, and
     * so does an SPF pass with no signature at all. Judging only "is the signer the From domain or its parent" refused
     * exactly these: a bank that signs from a sub-domain, or relays through its own SPF-authorised servers, looked like a
     * stranger. A pass for ANOTHER domain than the From line is not this (dmarcForOther, below) and an explicit DKIM
     * failure is still evidence (dkimBroken, below). */
    const dmarcVouches = auth.dmarc === 'pass' && !!auth.dmarcFrom && (isUnder(from, auth.dmarcFrom) || isUnder(auth.dmarcFrom, from));

    /* ── EVIDENCE OF FORGERY IS NEVER LIFTED ─────────────────────────────────
     *
     * DMARC is the receiver's own verdict that the message is, or is not, from the domain in its From line, and a
     * `fail` is decisive even next to a passing signature. SPF says which hosts may send for the domain; a failing SPF
     * is only evidence when nothing else vouches for the domain — a signature by the claimed domain, or a DMARC pass —
     * because forwarding breaks SPF and leaves the signature intact, and dropping that mail would lose real statements
     * to stop forgeries that cannot happen (nobody can forge the signature). A DMARC pass for a DIFFERENT domain than
     * the From line is no pass at all.
     *
     * None of these can be waved through by the owner's "take it": that tap answers "is this MINE?", which an attacker
     * answers "yes" to as well as anyone. */
    const dmarcFailed = auth.dmarc === 'fail' || auth.dmarc === 'hardfail';
    const spfFailed = SPF_BAD.has(auth.spf) && auth.dmarc !== 'pass' && !signedByClaimed;
    const dmarcForOther = auth.dmarc === 'pass' && !!auth.dmarcFrom && !isUnder(from, auth.dmarcFrom) && !isUnder(auth.dmarcFrom, from);
    if (dmarcFailed || spfFailed || dmarcForOther) {
        return { ok: false, reason: REJECT.AUTH_FAILED, detail: { from, claimed: claimedName, ...authSeen, why: dmarcFailed ? 'dmarc-fail' : dmarcForOther ? 'dmarc-for-another-domain' : 'spf-fail' } };
    }
    /* `policy.forced` is the OWNER's own tap on ONE refused message ("take this one") — never produced by the sender
     * list, which still cannot wave a signature through. Honoured only for an address they approved, and only for a
     * message that merely carries NO signature: a signature that FAILED is evidence, not absence, and stays refused.
     * The statement is still read and must still reconcile to the cent before it is filed. */
    const dkimBroken = auth.dkimFail.size > 0 && !signedByClaimed;
    const forced = policy.forced === true && said.verdict === 'approved' && !dkimBroken;
    const vouched = signedByClaimed || (dmarcVouches && !dkimBroken);
    if (!forced && !vouched && !passed.size) {
        return { ok: false, reason: REJECT.DKIM_FAILED, detail: { from, claimed: claimedName, ...authSeen, explicit: dkimBroken } };
    }
    if (passed.size && !vouched) {
        return {
            ok: false,
            reason: REJECT.DKIM_DOMAIN_MISMATCH,
            detail: { from, signedBy: [...passed].slice(0, 4), ...authSeen },
        };
    }

    /* APPROVED BY THE OWNER — after the signature check, never instead of it.
     * "This is one of mine" is not "trust this": the message still had to carry
     * a passing signature from the domain it claims, and it did, above. What
     * approval buys is that the statement is FILED rather than held, and that
     * it is labelled with the name the owner gave it rather than one guessed
     * from the domain. */
    if (said.verdict === 'approved') {
        return {
            ok: true,
            bank: (said.entry && said.entry.name) || (hit && hit.name) || nameFromDomain(from),
            domain: from,
            known: true,
            approved: true,
            builtIn: !!hit,
            ...(forced ? { forced: true } : {}),
        };
    }

    /* ── A BUILT-IN NAME IS A GUESS ABOUT WHO, NOT A GRANT OF TRUST ──────────
     *
     * THE BUG: this used to return `known: true` for a hit, unconditionally.
     * `known: true` skipped BOTH the content check AND — until the owner had
     * curated anything — the sender-approval gate too, because that gate used
     * to be keyed off `policy.curated`, which nothing not yet approved could
     * set. So mail from these five domains was filed sight-unseen from the
     * moment the mailbox was linked, whether or not the owner had put that
     * address anywhere in their own senders list — the exact "senders you
     * never approved keep syncing anyway" report this rewrite exists to
     * close. planMessage now holds anything not explicitly approved
     * unconditionally, curated or not, so this is no longer the only place
     * that mattered — but `known` still has to tell the truth on its own,
     * because the mailbox card reads it directly.
     *
     * A hit still buys the nicer NAME below (`hit.name` instead of a guess
     * from the domain) — that was never the security question. `builtIn`
     * carries that recognition forward for planMessage's "this IS one of
     * your banks, you just have not said so" hint on a hold, which needs the
     * fact a domain matched without it granting anything. Trust is
     * `known: true`, and the only thing that may grant it is the owner's own
     * decision, three lines up. */
    if (hit) return { ok: true, bank: hit.name, domain: hit.domain, known: false, builtIn: true };
    return { ok: true, bank: nameFromDomain(from), domain: from, known: false, builtIn: false };
}

/* ── 1b. what to HOLD ─────────────────────────────────────────────────────── */

/* The shape of a statement's file name with the month and every run of digits taken out, so
 * "Consolidated_eStatement_2026JAN_458290.html" and "…2026MAR_458290.html" are one series.
 * Lives HERE, in a built module, because the build copies only wealthflow-* files: a module
 * that imported a server-only helper for this would fail to load in the browser. */
const STEM_MONTHS = 'JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC';
const STEM_MONTH_RE = new RegExp(`(20\\d{2})[-_ .]?(${STEM_MONTHS})|(${STEM_MONTHS})[-_ .]?(20\\d{2})`, 'i');
export function filenameStem(filename) {
    return String(filename || '').toLowerCase().replace(STEM_MONTH_RE, '#').replace(/\d{2,}/g, '#').replace(/[^a-z#.]+/g, '_').replace(/_+/g, '_').replace(/(#_?)+/g, '#');
}

/** Refusals that are about WHO SENT IT, and are therefore one tap from being wrong. */
export const HOLDABLE = new Set([REJECT.NOT_ON_YOUR_LIST, REJECT.SENDER_SIBLING]);

/** At most this many held references. A junk mailbox must not fill a database. */
export const MAX_HELD = 200;

/**
 * A refused message, kept as a REFERENCE so approving the sender releases it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * A refused message was dropped. `if (!plan.ok) { … continue; }`, in both the
 * push hook and the scan endpoint. The sighting was recorded, so the sender
 * appeared in the pending list — but the STATEMENT was gone. Approving the
 * sender afterwards did not bring it back; only a backfill scan reaching that
 * month would, and only if the owner thought to run one.
 *
 * That is the second half of the report: "I added the address and yesterday's
 * statement still did not sync." Even once the sender is right, the message
 * that arrived while it was wrong is not recoverable by any tap.
 *
 * ── WHY A REFERENCE AND NOT THE ATTACHMENT ──────────────────────────────────
 *
 * Storing the PDF would undo the rule that mail from an unapproved sender is
 * refused before an attachment is fetched — the rule that stopped a review
 * queue filling with receipts. So this keeps only what Gmail already told us in
 * the headers: which message, from whom, when, and why it was refused. The
 * bytes are fetched if and when the owner approves the sender, from the message
 * id kept here. Nothing is downloaded on the strength of a refusal, and nothing
 * is lost by one.
 */
export function planHold(plan, message) {
    if (!plan || plan.ok !== false || !HOLDABLE.has(plan.reason)) return null;
    const id = String((message && message.id) || '').trim();
    if (!id) return null;
    const received = Number(message && message.internalDate);
    return {
        key: id,
        messageId: id,
        from: String(plan.from || '').slice(0, 160),
        subject: String(plan.subject || '').slice(0, 160),
        bank: plan.bank || null,
        reason: plan.reason,
        /* The detail the screen needs to ask the right question: which address
         * they already approved, and which one wrote this time. */
        detail: plan.detail || null,
        receivedMs: Number.isFinite(received) && received > 0 ? received : null,
        heldMs: null,
    };
}

/**
 * Does approving this sender release this held message?
 *
 * The comparison is the same matchSender the live path uses, handed in rather
 * than imported — wealthflow-mail-senders.mjs already imports this file, and
 * the pair importing each other is how a module graph stops loading at all.
 */
export function releasedBy(held, decide) {
    if (!held || typeof decide !== 'function') return false;
    const verdict = decide(held.from) || {};
    return verdict.verdict === 'approved';
}

/* ── 2. what to take ──────────────────────────────────────────────────────── */

/* A deterministic allowlist, not a pattern: the file must be a PDF or an HTML document, its NAME must agree with its
 * declared TYPE, and nothing executable may appear anywhere in the name. `statement.pdf.exe`, `statement.exe.pdf`
 * (an executable dressed as a PDF), a `.zip`, a `.docm` and a `.js` are refused here, before a byte is fetched.
 * A name with no extension at all is allowed when the TYPE says PDF — real banks attach `5996631318_455` — and the
 * bytes are checked again after download (see sniffKind), so a lying name or type reaches nothing. */
const DANGEROUS_PART = /\.(?:exe|scr|bat|cmd|com|pif|js|jse|vbs|vbe|wsf|wsh|msi|msp|jar|lnk|ps1|psm1|hta|dll|cpl|reg|docm|xlsm|pptm|iso|img|zip|rar|7z|gz|tar|apk|dmg|svg)(?:\.|$)/;
const extOf = (name) => { const m = /\.([a-z][a-z0-9]{0,4})$/.exec(name); return m ? m[1] : ''; };
export const isStatementAttachment = (part) => {
    const mime = lower(part && part.mimeType);
    const name = lower(part && part.filename);
    const ext = extOf(name);
    if (name && DANGEROUS_PART.test(name)) return false;
    if (ext && ext !== 'pdf' && ext !== 'htm' && ext !== 'html') return false;
    if (mime === 'application/pdf') return !ext || ext === 'pdf';
    if (mime === 'application/octet-stream') return ext === 'pdf' || ext === 'htm' || ext === 'html';
    if (mime === 'text/html') return !ext || ext === 'htm' || ext === 'html';
    return false;
};

/** The readable text of the mail itself (not its attachments): text/plain if there is any, else the HTML with its
 * markup stripped. Bounded — it is read for what it says, not stored. */
export function bodyTextOf(payload) {
    const found = [];
    const visit = (p) => {
        if (!p) return;
        if (Array.isArray(p.parts)) p.parts.forEach(visit);
        const mime = lower(p.mimeType);
        if (!p.filename && (mime === 'text/plain' || mime === 'text/html') && p.body && typeof p.body.data === 'string') found.push({ mime, data: p.body.data });
    };
    visit(payload);
    const decode = (d) => { try { return Buffer.from(String(d).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'); } catch (_) { return ''; } };
    const plain = found.filter((x) => x.mime === 'text/plain').map((x) => decode(x.data)).join('\n');
    const text = plain.trim() ? plain : found.filter((x) => x.mime === 'text/html').map((x) => decode(x.data)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&')).join('\n');
    return text.replace(/\s+/g, ' ').trim().slice(0, 40000);
}

/** Walk the MIME tree; Gmail nests parts arbitrarily deep under multipart/*. */
function walk(part, out) {
    if (!part) return out;
    if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, out);
    // Gmail may inline a small MIME part in body.data.
    // Unnamed PDFs are real attachments; unnamed HTML is the mail body.
    const namedOrPdf = !!part.filename || lower(part.mimeType) === 'application/pdf';
    if (namedOrPdf && part.body
        && (part.body.attachmentId || typeof part.body.data === 'string')) out.push(part);
    return out;
}

/**
 * The PDF attachments worth fetching, or the reason there are none.
 *
 * Size is checked against the CHUNK CEILING rather than some round number: a
 * payload this store cannot hold is not a payload to fetch, and finding that
 * out after downloading eight megabytes over a phone connection is worse than
 * finding it out from the metadata Gmail already gave us.
 */
export function selectAttachments(payload) {
    const all = walk(payload, []);
    const pdfs = all.filter(isStatementAttachment);
    if (!pdfs.length) return { ok: false, reason: REJECT.NO_ATTACHMENT, detail: { attachments: all.length } };
    if (pdfs.length > MAX_ATTACHMENTS) {
        return { ok: false, reason: REJECT.TOO_MANY, detail: { pdfs: pdfs.length, max: MAX_ATTACHMENTS } };
    }

    const take = [];
    const skipped = [];
    for (const p of pdfs) {
        // base64 is 4 characters per 3 bytes; compare in the units we store in.
        const b64 = Math.ceil((Number(p.body.size) || 0) / 3) * 4;
        if (b64 > MAX_BASE64) {
            skipped.push({ filename: p.filename, reason: REJECT.TOO_LARGE, bytes: Number(p.body.size) || 0 });
            continue;
        }
        take.push({
            attachmentId: p.body.attachmentId || '',
            inlineData: typeof p.body.data === 'string' ? p.body.data : '',
            filename: p.filename || '',
            size: Number(p.body.size) || 0,
        });
    }
    if (!take.length) return { ok: false, reason: REJECT.TOO_LARGE, detail: { skipped } };
    return { ok: true, take, skipped };
}

/* ── 3. how to store it ───────────────────────────────────────────────────── */

/**
 * Stable across redeliveries, and scoped so one message cannot address another.
 *
 * Gmail's ids are opaque and may contain characters Firestore rejects in a
 * document name, so they are reduced to a safe alphabet. That reduction could
 * in principle collide, which would silently overwrite one statement with
 * another, so the length is preserved and the two ids are joined with a
 * separator the alphabet excludes.
 */
/**
 * The document name for one attachment — stable across refetches.
 *
 * THE BUG THIS REPLACES. itemKey() below keys on Gmail's `attachmentId`, and
 * gmail-scan.js's own header states the assumption out loud: "A rescan is
 * free. The item key is (messageId, attachmentId), so a message re-read in a
 * later window writes the same document."
 *
 * That holds only while the attachment id holds. It is an opaque token Gmail
 * mints for `messages.attachments.get`, not a content identifier, and it is
 * not contracted to survive between `messages.get` calls. When it changes, the
 * key changes; the `existing.exists` check in gmail-hook.js and gmail-scan.js
 * finds nothing; the attachment is downloaded again and written to a SECOND
 * document. The owner reports exactly that: press check a few times, or
 * reload, and the same statements appear again beside themselves.
 *
 * `messageId` is stable, and within one message an attachment's FILENAME and
 * SIZE are properties of the MIME part rather than tokens minted per request.
 * Two different attachments on one message differ in at least one of them; the
 * same attachment fetched twice differs in neither.
 *
 * Not a hash of the bytes, which would be the strongest key and is what the
 * dedup ought to use one day — but the key has to be computable BEFORE the
 * download, because deciding "do we already have this?" without spending the
 * bytes is the whole point of checking it first.
 */
export function stableItemKey(messageId, part) {
    const safe = (v, n) => String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, n);
    const m = safe(messageId, 128);
    if (!m) return null;
    const name = safe((part && part.filename) || '', 80);
    const size = Number((part && part.size) || 0) || 0;
    /* No filename is a real case — some banks attach an unnamed part. Falling
     * back to the attachment id keeps SOME key rather than dropping the
     * statement, and it is no worse than what this replaces. */
    if (!name) {
        const a = safe((part && part.attachmentId) || '', 64);
        return a ? `${m}.${a}` : null;
    }
    return `${m}.${name}.${size}`;
}

export function itemKey(messageId, attachmentId) {
    const safe = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]/g, '_');
    const m = safe(messageId);
    const a = safe(attachmentId).slice(0, 64);
    if (!m || !a) return null;
    return `${m}.${a}`;
}

/**
 * Split a base64 payload the way statement-store.js does, manifest last.
 *
 * Returns the writes in the order they must happen. The caller must write every
 * `parts` entry, confirm they all succeeded, and only then write `manifest` —
 * the manifest's existence is what tells a reader the payload is complete, so
 * writing it first would let a half-finished upload be read as a whole PDF.
 */
export function planWrite(base64, meta = {}) {
    const b64 = String(base64 == null ? '' : base64);
    if (!b64) return { ok: false, reason: REJECT.NO_ATTACHMENT, detail: { chars: 0 } };
    if (b64.length > MAX_BASE64) {
        return { ok: false, reason: REJECT.TOO_LARGE, detail: { chars: b64.length, max: MAX_BASE64 } };
    }

    if (b64.length <= SINGLE_MAX) {
        return { ok: true, parts: [], manifest: { ...meta, d: b64, parts: 0 }, chunked: false };
    }
    const n = Math.ceil(b64.length / CHUNK_SIZE);
    const parts = [];
    for (let i = 0; i < n; i++) parts.push({ i, d: b64.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE) });
    return { ok: true, parts, manifest: { ...meta, parts: n }, chunked: true };
}

/** Fill absent legacy fields from mail that passed current DKIM/policy. */
export function repairManifest(manifest, item, { uid = '' } = {}) {
    const old = manifest && typeof manifest === 'object' ? manifest : {};
    const patch = {};
    const missing = key => old[key] == null || old[key] === '';
    const fill = (key, value) => {
        if (missing(key) && value !== undefined && value !== null && value !== '') patch[key] = value;
    };
    fill('from', item && item.from);
    fill('bank', item && item.bank);
    fill('messageId', item && item.messageId);
    fill('attachmentId', item && item.attachmentId);
    fill('filename', item && item.filename);
    fill('subject', item && item.subject);
    fill('receivedMs', item && item.receivedMs);
    if (missing('size') && Number.isFinite(Number(item && item.size))) patch.size = Number(item.size);
    fill('uid', uid);
    if (old.filed !== true && missing('status') && uid) {
        patch.status = 'pending';
        if (missing('cursor')) patch.cursor = 0;
    }
    return patch;
}

/* ── 4. the whole decision ────────────────────────────────────────────────── */

/**
 * Everything the endpoint needs to know about one message, decided without
 * touching the network.
 *
 * The order matters and is not arbitrary: identity is settled BEFORE any
 * attachment is considered, so a message from an unrecognised sender never
 * reaches the code that would download from it.
 */
/**
 * Does anything about this message call it a statement?
 *
 * Subject and attachment filenames, against the same vocabulary the Gmail
 * query searches with — one list, so what is fetched and what is accepted
 * cannot drift apart.
 */
export function looksLikeStatement({ subject = '', filenames = [] } = {}, terms = STATEMENT_TERMS) {
    const hay = lower([subject, ...(Array.isArray(filenames) ? filenames : [])].join(' \n '));
    if (!hay.trim()) return false;
    return (Array.isArray(terms) ? terms : []).some((t) => hay.includes(lower(t)));
}

/**
 * One entry per statement, from a list that may hold the same one several times.
 *
 * WHY THIS IS NEEDED ON TOP OF THE KEY FIX. stableItemKey stops NEW duplicates
 * being written. It removes none of the ones already stored — and those are
 * what the owner actually sees, because the mailbox card lists what is in the
 * store rather than fetching anything. A fix that only changes future writes
 * leaves the screen exactly as it was, which is what happened.
 *
 * Two documents are the same statement when they came from the same message
 * and carry the same attachment: same messageId, same filename, same size. The
 * old key put Gmail's remintable attachmentId in the document NAME, so the same
 * statement could be stored under many names — but never with a different
 * messageId or filename.
 *
 * COLLAPSED, NOT DELETED. This decides what to show; it removes nothing. A
 * reader that hides a row is reversible by reloading, a delete is not, and the
 * owner's statements are not something to gamble on a grouping rule. The
 * survivor is the most complete copy — most parts, then earliest stored, so
 * the answer does not move around between calls.
 */
export function dedupeStored(items) {
    const seen = new Map();
    for (const it of Array.isArray(items) ? items : []) {
        if (!it) continue;
        const m = it.manifest || {};
        const id = [
            m.messageId == null ? '' : String(m.messageId),
            m.filename == null ? '' : String(m.filename),
            m.size == null ? '' : String(m.size),
        ].join('\u0000');
        /* A record with no messageId AND no filename cannot be grouped without
         * guessing, so it is kept as itself rather than merged into a bucket it
         * may not belong to. */
        const key = (m.messageId || m.filename) ? id : `@unique:${it.id}`;
        const prev = seen.get(key);
        if (!prev) { seen.set(key, it); continue; }
        seen.set(key, betterCopy(prev, it));
    }
    return [...seen.values()];
}

/** Of two copies of one statement, the one worth showing. */
export function betterCopy(a, b) {
    const parts = (x) => (Array.isArray(x && x.parts) ? x.parts.length : 0);
    if (parts(b) !== parts(a)) return parts(b) > parts(a) ? b : a;
    const at = (x) => Number((x && x.manifest && x.manifest.storedMs) || 0) || 0;
    if (at(a) && at(b) && at(a) !== at(b)) return at(a) < at(b) ? a : b;
    /* Nothing separates them; keep the first so repeated calls agree. */
    return a;
}

function planCore(message, policy = {}) {
    const headers = {};
    const fromLines = [], authLines = [];
    for (const h of (message && message.payload && message.payload.headers) || []) {
        if (!h || !h.name) continue;
        const name = lower(h.name);
        if (name === 'from') fromLines.push(h.value);
        if (name === 'authentication-results') authLines.push(h.value);
        headers[name] = h.value;
    }
    /* Only Google's own verdict counts (see pickAuthHeader): the LAST such header used to win, and the last one is the
     * one the sender wrote. */
    if (authLines.length) headers['authentication-results'] = pickAuthHeader(authLines).value;
    /* Two From lines is not a message any mail program writes. Which one a reader shows depends on the reader, and the
     * signature may cover only one of them — the classic way to show the owner a bank and verify a stranger. */
    if (fromLines.length > 1) {
        return { ok: false, reason: REJECT.AUTH_FAILED, detail: { from: domainOf(fromLines[0]), froms: fromLines.map((v) => String(v == null ? '' : v).slice(0, 160)).slice(0, 4), why: 'multiple-from-headers', lines: fromLines.length }, from: String(fromLines[0] == null ? '' : fromLines[0]), subject: headers.subject || '' };
    }

    /* ONE From line naming several mailboxes is the same trick in one header: the reader shows one, the signature covers another. */
    const mailboxes = addressesOf(headers.from);
    if (mailboxes.length > 1) {
        return { ok: false, reason: REJECT.AUTH_FAILED, detail: { from: domainOf(headers.from), froms: mailboxes.slice(0, 4), why: 'multiple-from-addresses', lines: 1 }, from: String(headers.from == null ? '' : headers.from), subject: headers.subject || '' };
    }

    if (headers.from !== undefined && !wellFormedFrom(headers.from)) {
        return { ok: false, reason: REJECT.AUTH_FAILED, detail: { from: domainOf(headers.from), why: 'malformed-from', lines: 1 }, from: String(headers.from == null ? '' : headers.from).slice(0, 300), subject: headers.subject || '' };
    }

    /* Carried out on every plan, refused or not, so the caller can offer the
     * owner the senders it saw. The gathering the owner asked for depends on
     * this being reported for mail that did NOT get in — a sender nobody has
     * approved yet is exactly the one worth showing them. */
    const seenFrom = String(headers.from || '');

    const who = identifyBank(headers, policy);
    if (!who.ok) return { ok: false, ...who, from: seenFrom, subject: headers.subject || '' };

    const what = selectAttachments(message && message.payload);
    if (!what.ok) return { ok: false, ...what, bank: who.bank, from: seenFrom, subject: headers.subject || '' };
    /* A FILE THAT SAYS INVOICE OR RECEIPT, AND NOT STATEMENT, IS NOT A STATEMENT — whatever the subject says. The subject is written
     * by the sender: "Your account statement" over an attached Invoice_10442.pdf is the oldest way to carry a bill past a filter. A
     * file that says both ("e-Statement / Tax Invoice") is a statement; a file that says neither is judged by the mail and its
     * contents as before. Files like that beside a real statement are left out; if every file is one, the message is refused. */
    const vetoedFiles = what.take.filter((a) => nameVerdict({ subject: '', filenames: [a && a.filename] }).verdict === ID_VERDICT.NOT_STATEMENT);
    const everyFileVetoed = vetoedFiles.length > 0 && vetoedFiles.length === what.take.length;
    if (vetoedFiles.length && !everyFileVetoed) what.take = what.take.filter((a) => !vetoedFiles.includes(a));

    /* ── THE OWNER'S LIST IS THE ONLY AUTHORITY, CURATED OR NOT ───────────
     *
     * THE BUG, IN TWO LAYERS. First: this used to read `if (who.known ===
     * false)`, so the rule below applied only to senders the built-in BANKS
     * list did not recognise — a message from hnb.lk, dfcc.lk,
     * nationstrust.com, americanexpress.com or amex.com was `known: true` and
     * skipped it entirely, filed on the strength of a hardcoded domain list
     * the owner never saw, let alone approved. That is fixed above: `known`
     * now requires the owner's own approval, so a built-in hit buys nothing
     * here.
     *
     * Second, and the one that survived fixing the first: this was gated on
     * `policy.curated`, true only once the owner has approved something.
     * Before that first approval, EVERY sender — built-in or not — fell
     * through to a keyword guess a few lines below (`looksLikeStatement`),
     * which downloaded and filed anything whose subject or filename merely
     * sounded like a statement, from any address at all. That is not a
     * curation gap, it is the owner's own senders list having no power over
     * the mailbox until they had already used it once — exactly what "add
     * the emails I trust and use ONLY those" promises the list will never do,
     * and precisely what the report was: mail from addresses never added
     * kept arriving regardless.
     *
     * So the gate is unconditional now. Not approved is not filed — full
     * stop, curated or not — and NOTHING is lost by that: a refusal here is
     * HOLDABLE (see HOLDABLE below), so the sender still surfaces for a
     * one-tap approval and the next scan brings its statements in. That is
     * the same discovery path a first sender always needed; it no longer
     * runs through downloading and filing content nobody approved first. */
    /* A SIBLING ADDRESS THAT SENDS A STATEMENT THE OWNER ALREADY RECEIVES. The
     * bank wrote from another desk (the owner approved statements@, this came from
     * estatements@ — same domain, and it passed the signature check above), and
     * what it attached is named exactly like a statement that was filed from the
     * approved address. That is the same document series, not a new kind of mail,
     * so it is taken. It is still read, still has to reconcile before anything is
     * filed, and anything that is not a statement is rejected on its contents.
     * Without this rule the owner's approval covered ONE address while the bank
     * used two, and every statement from the second was held for ever. */
    const rel0 = typeof policy.related === 'function' ? policy.related(seenFrom) : null;
    const releasedBySeries = who.approved !== true && !!rel0 && policy.siblingSeries instanceof Set && policy.siblingSeries.size > 0
        && what.take.length > 0 && what.take.every((a) => policy.siblingSeries.has(filenameStem(a && a.filename)));
    /* A BANK WRITING FROM ANOTHER OF ITS OWN ADDRESSES, AND SAYING SO. The owner approved `e-statements@hnb.lk`; the
     * bank's account statements come from a second address, and 104 of them sat held because nothing named like a
     * statement had been filed from the approved one. The owner's approval already said WHICH BANK; the rest is
     * decided on the message itself — the signature held (above), the subject or a file name calls it a statement
     * (here), and the document must show the shape of one and reconcile before anything is filed (the worker). A
     * bank's marketing from that same address says no such thing and stays held. */
    const releasedBySibling = who.approved !== true && !releasedBySeries && !!rel0 && what.take.length > 0
        && intentVerdict({ subject: headers.subject || '', filenames: what.take.map((a) => a && a.filename).filter(Boolean), body: '' }).intent === 'stated';
    const ownerApproved = who.approved === true || releasedBySeries || releasedBySibling;
    const released = releasedBySeries || releasedBySibling;
    const releasedVia = releasedBySeries ? 'series' : 'sibling';
    // Filed under the name the owner gave the bank, not one guessed from the second address's domain.
    const bankName = released && rel0.name && !rel0.legacyDomain ? rel0.name : who.bank;
    if (!ownerApproved) {
        const rel = rel0;
        return {
            ok: false,
            reason: rel ? REJECT.SENDER_SIBLING : REJECT.NOT_ON_YOUR_LIST,
            bank: (rel && rel.name) || who.bank,
            detail: rel
                ? { from: who.domain, approvedAddress: rel.approvedAddress, sawAddress: rel.address }
                : { from: who.domain, knownBank: who.builtIn === true },
            from: seenFrom,
            subject: headers.subject || '',
        };
    }

    /* ── APPROVING A SENDER IS NOT APPROVING EVERYTHING THEY SEND ─────────
     *
     * THE BUG THE OWNER REPORTED FOUR TIMES. The only check on WHAT a document
     * is used to live inside `if (who.known === false)` just below — so it ran
     * for unrecognised senders and for nobody else. Approve a sender and every
     * PDF that sender ever mails was filed unread.
     *
     * That is not a corner case, it is the normal case: approvedClauses widens
     * the FETCH to the whole domain on purpose, so a bank's second address can
     * be discovered. An approved domain that also invoices you then sends its
     * invoices straight into a screen meant for bank statements. Their
     * screenshot is exactly that — Invoice-NCQIAKMS-0008.pdf,
     * Receipt-2402-5154-7274.pdf, invoice-113674.pdf, beside one real DFCC
     * statement.
     *
     * So the veto is UNIVERSAL now, and it runs before a byte is downloaded.
     *
     * PLACED BELOW THE SENDER RULE ON PURPOSE. Both refusals are true of a bill
     * from a stranger, and the sender one is the ACTIONABLE one: "you have not
     * decided about this sender yet" offers a tap that fixes it, while "this is
     * an invoice" ends the conversation. Above this line the question is WHO;
     * from here down it is WHAT, and what is left here is every sender the
     * owner has already accepted — which is exactly the population the old
     * code never checked.
     *
     * IT VETOES ONLY ON POSITIVE EVIDENCE OF BEING SOMETHING ELSE. Silence is
     * not evidence: a real statement in that same screenshot is called
     * `5996631318_455.pdf` and parsed two transactions correctly. A rule that
     * required the name to SAY "statement" would have deleted it. See
     * wealthflow-statement-identity.js. */
    /* WHAT THE MAIL SAYS IT IS — subject, file names AND body (see intentVerdict). A block is on the subject or a file
     * name only; the body can raise the bar (the attachment must prove itself) but never throws a message away alone. */
    const intent = intentVerdict({
        subject: headers.subject || '',
        filenames: what.take.map((a) => a && a.filename).filter(Boolean),
        body: bodyTextOf(message && message.payload),
    });
    const ownerTap = policy.forced === true && who.approved === true;   // an exact-address approval the owner tapped, never a release
    if ((intent.intent === 'block' || everyFileVetoed) && !ownerTap) {
        const fileSays = nameVerdict({ subject: '', filenames: [vetoedFiles[0] && vetoedFiles[0].filename] });
        return {
            ok: false,
            reason: REJECT.NOT_A_STATEMENT_DOC,
            bank: who.bank,
            detail: intent.intent === 'block' ? { from: who.domain, why: intent.reason, hits: intent.hits.slice(0, 4), where: intent.where } : { from: who.domain, why: 'the file name ' + fileSays.reason.replace(/^the name /, ''), hits: fileSays.hits.slice(0, 4), where: 'file' },
            from: seenFrom,
            subject: headers.subject || '',
        };
    }
    // A block the owner lifted is still only as trusted as its contents: the attachment has to prove itself.
    /* A sibling address is not the address the owner wrote down, so nothing is taken from it on the strength of the mail
     * alone: its document must prove itself a statement from its own contents, and reconcile, before anything is filed. */
    const intentKind = (intent.intent === 'block' || everyFileVetoed || releasedBySibling) ? 'suspect' : intent.intent;

    /* THE KEYWORD GUESS THAT USED TO LIVE HERE IS GONE.
     *
     * It ran for a sender not yet approved, on the reasoning that someone who
     * had approved nothing needed SOME way to discover what to approve. But a
     * guess that a message "looks like" a statement is not the owner's
     * consent, and downloading and filing content on the strength of a guess
     * is exactly what the unconditional gate above now refuses to do,
     * whatever `policy.curated` says. Discovery still works: the refusal a
     * few lines up is HOLDABLE, so the sender surfaces for a one-tap approval
     * with nothing of its content ever fetched first. `looksLikeStatement`
     * stays exported and tested — nothing else in this file calls it, but
     * removing a working, well-tested classifier because its one caller went
     * away is a separate decision from removing the caller. */
    const items = [];
    for (const a of what.take) {
        const key = stableItemKey(message.id, a);
        if (!key) continue;
        items.push({
            key,
            /* What this attachment WOULD have been called before the key
             * changed. The write path checks it too, so the first run after
             * this change recognises everything already stored instead of
             * writing a second copy of all of it — which would have made the
             * duplicate bug worse exactly once, on the way to fixing it. */
            legacyKey: itemKey(message.id, a.attachmentId),
            attachmentId: a.attachmentId,
            inlineData: a.inlineData,
            filename: a.filename,
            size: a.size,
            bank: bankName,
            /* False for a sender no one has confirmed.
             *
             * THIS FIELD WAS COMPUTED AND READ BY NOTHING. The comment that
             * used to sit here said the write path held these for review. It
             * did not: planWrite's manifest had no place for the flag, so
             * neither gmail-hook.js nor gmail-scan.js could act on it, and a
             * verified-but-unrecognised sender was filed exactly like a
             * confirmed bank. Both call sites now put it in the manifest, and
             * the mailbox card reads it back. */
            known: who.known !== false || released,
            approved: who.approved === true || released,
            ...(released ? { via: releasedVia } : {}),
            ...(who.forced ? { via: 'owner' } : {}),
            /* stated | unproven | suspect — what the worker must see in the DOCUMENT before it goes any further. */
            intent: intentKind,
            from: seenFrom,
            messageId: message.id,
            receivedMs: Number(message.internalDate) || null,
            subject: headers.subject || '',
        });
    }
    if (!items.length) {
        return { ok: false, reason: REJECT.NO_ATTACHMENT, bank: who.bank, detail: {}, from: seenFrom, subject: headers.subject || '' };
    }
    return {
        ok: true, bank: bankName, domain: who.domain, items, skipped: what.skipped, intent: intentKind,
        from: seenFrom, subject: headers.subject || '', known: who.known !== false || released,
        ...(released ? { via: releasedVia } : {}),
    };
}

/* ── 4b. forgery is a security event, not a missed statement ──────────────── */

/**
 * Refusals that are evidence of FORGERY rather than of a message that merely could not be read: SPF or DMARC saying the
 * message is not from its domain, a signature by a different domain, a signature that FAILED, two From lines, a
 * lookalike of a bank's domain. Kept apart from the refused list on purpose — that list offers "take it"; this one
 * does not, because a forger answers "yes, it is mine" as readily as anyone.
 *
 * An unsigned message is NOT in this class: no signature proves nothing either way, and the owner can still take it.
 */
export function isSecurityRefusal(plan) {
    if (!plan || plan.ok !== false) return false;
    if (plan.reason === REJECT.AUTH_FAILED || plan.reason === REJECT.DKIM_DOMAIN_MISMATCH) return true;
    if (plan.reason === REJECT.DKIM_FAILED) return !!(plan.detail && plan.detail.explicit === true);
    if (plan.reason === REJECT.NOT_A_BANK) return !!(plan.detail && plan.detail.lookalikeOf);
    return false;
}

/** Does this sender CLAIM to be somebody the owner (or the bank list) would trust? Random spam failing SPF is not news. */
function claimsToBeABank(plan, policy) {
    if (plan.reason === REJECT.NOT_A_BANK && plan.detail && plan.detail.lookalikeOf) return true;
    // a message with two From lines claims every one of them
    for (const line of [plan.from, ...((plan.detail && Array.isArray(plan.detail.froms)) ? plan.detail.froms : [])]) {
        const from = domainOf(line);
        if (BANKS.some((b) => isUnder(from, b.domain))) return true;
        if ((Array.isArray(policy.domains) ? policy.domains : []).some((d) => d && isUnder(from, lower(d)))) return true;
        const said = typeof policy.decide === 'function' ? (policy.decide(line) || {}) : {};
        if (said.verdict === 'approved') return true;
    }
    return false;
}

export function planMessage(message, policy = {}) {
    const plan = planCore(message, policy);
    if (!plan.ok && isSecurityRefusal(plan) && claimsToBeABank(plan, policy)) return { ...plan, security: true };
    return plan;
}

/** The record kept of a forged or unauthenticated message that was dropped — what it claimed, what the checks said. */
export function securityOf(plan, message) {
    if (!plan || plan.security !== true) return null;
    const id = String((message && message.id) || '').trim();
    if (!id) return null;
    const d = plan.detail || {};
    const received = Number(message && message.internalDate);
    return {
        messageId: id,
        reason: plan.reason,
        from: String(plan.from || '').slice(0, 160),
        subject: String(plan.subject || '').slice(0, 160),
        checks: {
            spf: String(d.spf || '').slice(0, 12), dmarc: String(d.dmarc || '').slice(0, 12),
            dkim: (Array.isArray(d.dkim) ? d.dkim : []).slice(0, 3).map(String), signedBy: (Array.isArray(d.signedBy) ? d.signedBy : []).slice(0, 3).map(String),
            why: String(d.why || (d.lookalikeOf ? 'lookalike-of-' + d.lookalikeOf : '')).slice(0, 60),
        },
        receivedMs: Number.isFinite(received) && received > 0 ? received : null,
        v: INTAKE_VERSION,
    };
}

/* ── 5. what the user hears about ─────────────────────────────────────────── */

/**
 * Which refusals deserve a notification, and which are simply not-a-statement.
 *
 * Most mail in a mailbox is not a bank statement, and saying so would make the
 * pipeline unusable. But a message that IS from a bank and could not be taken
 * is worth knowing about — a statement too large to store, or one whose
 * signature did not hold, is a statement that will silently never appear.
 */
/**
 * Could this message EVER become a statement? If not, recording its sender as
 * a "sighting" teaches the owner nothing but one more domain to go block.
 *
 * THE THIRD ROUND OF THE SAME REPORT. gmail-hook.js used to call
 * recordSighting() for every message the push received, unconditionally —
 * the Pub/Sub history feed it walks has no query, so that meant every
 * message added to the mailbox, statement-shaped or not. A job alert, a
 * welcome email, a receipt with no attachment: none of these can ever become
 * a filed statement, since planMessage() already refuses them below — but
 * every one still added a row to the owner's senders list, because nothing
 * gated the recording on what planMessage decided. "I added the emails I
 * want, why can't it be ONLY those" is that gap, from the owner's side.
 *
 * True for anything actually taken (`plan.ok`), and for anything held for a
 * reason a single tap fixes — HOLDABLE, which by construction only fires for
 * a DKIM-verified sender that attached something worth reviewing. False for
 * everything else: no attachment, a failed signature, a blocked sender, a
 * personal mailbox, a lookalike of a bank someone already trusts — none of
 * which can ever become a statement, however many times the owner approves
 * the sender.
 *
 * The explicit "find my banks" hunt (wealthflow-sender-discovery.js) is a
 * SEPARATE, opt-in feature with its own scoring and its own screen, and does
 * not call this — an owner who asks WealthFlow to comb the mailbox for
 * candidates should still see every candidate. This gate is only for the
 * passive path that runs on every message that simply arrives.
 */
export function worthSighting(plan) {
    return !!(plan && (plan.ok === true || HOLDABLE.has(plan.reason)));
}

/**
 * The intake rules' version. Bumping it makes every mailbox look back over its
 * whole history once, under the new rules — so an improvement to what is accepted
 * is applied to the statements the old rules turned away, and not only to mail
 * that arrives afterwards.
 *
 *   4  an address with an RFC 5322 comment is read as the address; DMARC pass for the From domain vouches for it (so mail
 *      with SPF + DMARC and no DKIM, or signed by a sub-domain of the same organisation, is no longer turned away); one
 *      From naming several mailboxes is forged. Every genuine statement the version-3 rules refused is judged again.
 */
export const INTAKE_VERSION = 4;

/**
 * Is this refusal one the owner would call a MISSED STATEMENT? Only mail from an
 * address they approved counts — a stranger's invoice refused is the system
 * working — and only the reasons that are about the message, not the sender
 * (sender refusals are held instead, see planHold). A message with no readable
 * attachment counts only when something says it was meant to be one.
 *
 * @returns a reference to keep, or null
 */
export function refusalOf(plan, message, policy = {}) {
    if (!plan || plan.ok !== false) return null;
    if (plan.security === true) return null;   // forgery is logged, never offered back (see isSecurityRefusal)
    const id = String((message && message.id) || '').trim();
    if (!id) return null;
    const reasons = [REJECT.DKIM_FAILED, REJECT.DKIM_DOMAIN_MISMATCH, REJECT.NOT_A_STATEMENT_DOC, REJECT.TOO_LARGE, REJECT.TOO_MANY, REJECT.NO_ATTACHMENT];
    if (!reasons.includes(plan.reason)) return null;
    const verdict = typeof policy.decide === 'function' ? (policy.decide(plan.from) || {}).verdict : '';
    if (verdict !== 'approved') return null;
    if (plan.reason === REJECT.NO_ATTACHMENT && !((plan.detail && plan.detail.attachments > 0) || looksLikeStatement({ subject: plan.subject }))) return null;
    const received = Number(message && message.internalDate);
    return {
        messageId: id,
        reason: plan.reason,
        from: String(plan.from || '').slice(0, 160),
        subject: String(plan.subject || '').slice(0, 160),
        bank: plan.bank || null,
        filename: String(walk(message && message.payload, []).map((p) => p && p.filename).find(Boolean) || '').slice(0, 120),
        receivedMs: Number.isFinite(received) && received > 0 ? received : null,
        v: INTAKE_VERSION,
    };
}

export function isWorthTelling(plan) {
    if (!plan || plan.ok) return false;
    return plan.reason === REJECT.TOO_LARGE
        || plan.reason === REJECT.TOO_MANY
        || plan.reason === REJECT.DKIM_FAILED
        || plan.reason === REJECT.DKIM_DOMAIN_MISMATCH
        || plan.reason === REJECT.AUTH_FAILED
        /* Counted and named. The owner's standing instruction is that nothing
         * is dropped in silence: an invoice correctly refused and a statement
         * wrongly refused have to be told apart by looking at the report, and
         * that needs the refusal to appear in it. */
        || plan.reason === REJECT.NOT_A_STATEMENT_DOC;
}

export const REJECT_TEXT = {
    [REJECT.NOT_A_BANK]: 'the sender is not one of your banks',
    [REJECT.SENDER_BLOCKED]: 'you blocked this sender',
    [REJECT.NOT_ON_YOUR_LIST]: 'the sender is not on your statement-sender list',
    [REJECT.SENDER_SIBLING]: 'a bank you approved wrote from a different address',
    [REJECT.NOT_A_STATEMENT]: 'the sender is not a bank you have confirmed, and nothing about the mail says statement',
    [REJECT.NOT_A_STATEMENT_DOC]: 'the attachment says it is an invoice, a receipt or a payslip — not a bank statement',
    [REJECT.DKIM_FAILED]: 'it claims to be from your bank but carries no valid signature',
    [REJECT.DKIM_DOMAIN_MISMATCH]: 'it is signed by a domain other than the one it claims to be from',
    [REJECT.AUTH_FAILED]: 'the sender checks (SPF / DMARC) say it is forged',
    [REJECT.NO_ATTACHMENT]: 'there is no PDF attached',
    [REJECT.TOO_LARGE]: 'the attachment is larger than the store can hold',
    [REJECT.TOO_MANY]: 'it carries more attachments than a statement should',
};

const API = {
    BANKS, REJECT, REJECT_TEXT,
    SINGLE_MAX, CHUNK_SIZE, MAX_PARTS, MAX_BASE64, MAX_ATTACHMENTS,
    addressOf, domainOf, isUnder, dkimPassedFor, pickAuthHeader, authSummary, identifyBank, selectAttachments, bodyTextOf, isSecurityRefusal, securityOf,
    itemKey, stableItemKey, planWrite, planMessage, isWorthTelling, worthSighting, looksLikeStatement, nameFromDomain, refusalOf, INTAKE_VERSION,
    dedupeStored, betterCopy,
};

export default API;
