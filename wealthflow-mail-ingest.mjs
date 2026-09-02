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
import { STATEMENT_TERMS } from './wealthflow-backfill.js';

export const BANKS = [
    { domain: 'hnb.lk', name: 'HNB' },
    { domain: 'dfcc.lk', name: 'DFCC' },
    { domain: 'nationstrust.com', name: 'Nations Trust' },
    { domain: 'americanexpress.com', name: 'American Express' },
    { domain: 'amex.com', name: 'American Express' },
];

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
    NOT_A_STATEMENT: 'unrecognised-sender-and-nothing-says-statement',
    DKIM_FAILED: 'dkim-did-not-pass',
    DKIM_DOMAIN_MISMATCH: 'signed-by-a-different-domain',
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
/** A statement email carries one statement. Ten is not a statement. */
export const MAX_ATTACHMENTS = 4;

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
export function addressOf(from) {
    const s = lower(from);
    /* Backslash escapes honoured, so a quoted string containing \" does not end
     * where it appears to. An unterminated quote matches nothing and leaves the
     * header exactly as it was — the angle brackets below still decide. */
    const bare = s.replace(/"(?:[^"\\]|\\.)*"/g, ' ');
    let addr = '';
    const re = /<([^<>]*)>/g;
    let m;
    while ((m = re.exec(bare)) !== null) addr = m[1];
    if (!addr) addr = bare;
    return addr.replace(/^mailto:/, '').replace(/[<>\s,;]+$/, '').trim();
}

/** The domain out of a From header, whatever shape the display name takes. */
export function domainOf(from) {
    const addr = addressOf(from);
    const at = addr.lastIndexOf('@');
    if (at < 0) return '';
    return addr.slice(at + 1).replace(/[>\s,;]+$/, '').trim();
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

    const passed = dkimPassedFor(h['authentication-results']);
    if (!passed.size) {
        return { ok: false, reason: REJECT.DKIM_FAILED, detail: { from, claimed: hit ? hit.name : from } };
    }
    /* The signing domain must cover the domain the message claims to be from.
     * A valid signature by some other domain is the attack, not a pass. */
    const signedByClaimed = [...passed].some((d) => isUnder(from, d) || (hit && isUnder(d, hit.domain)));
    if (!signedByClaimed) {
        return {
            ok: false,
            reason: REJECT.DKIM_DOMAIN_MISMATCH,
            detail: { from, signedBy: [...passed].slice(0, 4) },
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
        };
    }

    if (hit) return { ok: true, bank: hit.name, domain: hit.domain, known: true };
    return { ok: true, bank: nameFromDomain(from), domain: from, known: false };
}

/* ── 2. what to take ──────────────────────────────────────────────────────── */

const isPdf = (part) => {
    const mime = lower(part && part.mimeType);
    const name = lower(part && part.filename);
    return mime === 'application/pdf' || (mime === 'application/octet-stream' && name.endsWith('.pdf'));
};

/** Walk the MIME tree; Gmail nests parts arbitrarily deep under multipart/*. */
function walk(part, out) {
    if (!part) return out;
    if (Array.isArray(part.parts)) for (const p of part.parts) walk(p, out);
    if (part.filename && part.body && part.body.attachmentId) out.push(part);
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
    const pdfs = all.filter(isPdf);
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
        take.push({ attachmentId: p.body.attachmentId, filename: p.filename, size: Number(p.body.size) || 0 });
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

export function planMessage(message, policy = {}) {
    const headers = {};
    for (const h of (message && message.payload && message.payload.headers) || []) {
        if (h && h.name) headers[lower(h.name)] = h.value;
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

    /* An unrecognised sender has to LOOK like a statement as well as be
     * verified. A valid signature says the sender is who it claims; it says
     * nothing about whether a shop's PDF flyer belongs in a financial review
     * queue. Without this, widening the allowlist would trade eleven dropped
     * banks for a queue full of receipts, and a queue nobody can face is the
     * same as no queue.
     *
     * Checked AFTER the attachments are selected so the filenames can vote:
     * plenty of banks send `Statement_Aug2026.pdf` under a subject that says
     * nothing. A KNOWN bank skips this entirely — HNB may title its statement
     * whatever it likes. */
    if (who.known === false) {
        /* ONCE THE OWNER HAS A LIST, THE LIST DECIDES.
         *
         * The keyword test below is a guess, and a guess is what put utility
         * bills and shop receipts in a screen meant for bank statements: it
         * searched for the words `invoice` and `bill`, which describe every
         * non-statement financial mail ever sent. Those two words are gone from
         * the vocabulary now, but the deeper problem was that a guess was
         * deciding at all.
         *
         * So an owner who has approved even one sender gets the strict rule: a
         * sender they have not decided on is REFUSED, and offered to them
         * instead. Nothing is lost — the refusal names the sender, one tap
         * approves it, and the next scan brings its statements in.
         *
         * The guess survives only for someone who has not curated anything yet,
         * where refusing everything would mean an empty screen and no way to
         * discover what to approve. */
        if (policy.curated) {
            return {
                ok: false,
                reason: REJECT.NOT_ON_YOUR_LIST,
                bank: who.bank,
                detail: { from: who.domain },
                from: seenFrom,
                subject: headers.subject || '',
            };
        }
        const named = looksLikeStatement({
            subject: headers.subject || '',
            filenames: what.take.map((a) => a && a.filename).filter(Boolean),
        });
        if (!named) {
            return {
                ok: false,
                reason: REJECT.NOT_A_STATEMENT,
                bank: who.bank,
                detail: { from: who.domain },
                from: seenFrom,
                subject: headers.subject || '',
            };
        }
    }

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
            filename: a.filename,
            size: a.size,
            bank: who.bank,
            /* False for a sender no one has confirmed.
             *
             * THIS FIELD WAS COMPUTED AND READ BY NOTHING. The comment that
             * used to sit here said the write path held these for review. It
             * did not: planWrite's manifest had no place for the flag, so
             * neither gmail-hook.js nor gmail-scan.js could act on it, and a
             * verified-but-unrecognised sender was filed exactly like a
             * confirmed bank. Both call sites now put it in the manifest, and
             * the mailbox card reads it back. */
            known: who.known !== false,
            approved: who.approved === true,
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
        ok: true, bank: who.bank, domain: who.domain, items, skipped: what.skipped,
        from: seenFrom, subject: headers.subject || '', known: who.known !== false,
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
export function isWorthTelling(plan) {
    if (!plan || plan.ok) return false;
    return plan.reason === REJECT.TOO_LARGE
        || plan.reason === REJECT.TOO_MANY
        || plan.reason === REJECT.DKIM_FAILED
        || plan.reason === REJECT.DKIM_DOMAIN_MISMATCH;
}

export const REJECT_TEXT = {
    [REJECT.NOT_A_BANK]: 'the sender is not one of your banks',
    [REJECT.SENDER_BLOCKED]: 'you blocked this sender',
    [REJECT.NOT_ON_YOUR_LIST]: 'the sender is not on your statement-sender list',
    [REJECT.NOT_A_STATEMENT]: 'the sender is not a bank you have confirmed, and nothing about the mail says statement',
    [REJECT.DKIM_FAILED]: 'it claims to be from your bank but carries no valid signature',
    [REJECT.DKIM_DOMAIN_MISMATCH]: 'it is signed by a domain other than the one it claims to be from',
    [REJECT.NO_ATTACHMENT]: 'there is no PDF attached',
    [REJECT.TOO_LARGE]: 'the attachment is larger than the store can hold',
    [REJECT.TOO_MANY]: 'it carries more attachments than a statement should',
};

const API = {
    BANKS, REJECT, REJECT_TEXT,
    SINGLE_MAX, CHUNK_SIZE, MAX_PARTS, MAX_BASE64, MAX_ATTACHMENTS,
    addressOf, domainOf, isUnder, dkimPassedFor, identifyBank, selectAttachments,
    itemKey, stableItemKey, planWrite, planMessage, isWorthTelling, looksLikeStatement, nameFromDomain,
    dedupeStored, betterCopy,
};

export default API;
