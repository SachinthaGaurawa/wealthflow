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
export const BANKS = [
    // Sri Lanka Licensed Commercial & Specialized Banks
    { domain: 'hnb.lk', name: 'HNB' },
    { domain: 'dfcc.lk', name: 'DFCC' },
    { domain: 'nationstrust.com', name: 'Nations Trust' },
    { domain: 'ntb.lk', name: 'Nations Trust' },
    { domain: 'combank.net', name: 'Commercial Bank' },
    { domain: 'combank.lk', name: 'Commercial Bank' },
    { domain: 'commercialbank.lk', name: 'Commercial Bank' },
    { domain: 'sampath.lk', name: 'Sampath Bank' },
    { domain: 'boc.lk', name: 'Bank of Ceylon' },
    { domain: 'seylan.lk', name: 'Seylan Bank' },
    { domain: 'sc.com', name: 'Standard Chartered' },
    { domain: 'standardchartered.com', name: 'Standard Chartered' },
    { domain: 'hsbc.lk', name: 'HSBC' },
    { domain: 'hsbc.com', name: 'HSBC' },
    { domain: 'ndbbank.com', name: 'NDB Bank' },
    { domain: 'pabcbank.com', name: 'Pan Asia Bank' },
    { domain: 'unionb.com', name: 'Union Bank' },
    { domain: 'cargillsbank.com', name: 'Cargills Bank' },
    { domain: 'amanabank.lk', name: 'Amana Bank' },
    { domain: 'sdb.lk', name: 'SDB Bank' },
    { domain: 'nsb.lk', name: 'NSB' },
    { domain: 'rdb.lk', name: 'RDB' },
    { domain: 'peoplesbank.lk', name: "People's Bank" },
    // Sri Lanka Major Financial Institutions & Cards
    { domain: 'lolc.com', name: 'LOLC Finance' },
    { domain: 'singerfinance.com', name: 'Singer Finance' },
    { domain: 'cdb.lk', name: 'CDB' },
    { domain: 'lbfinance.com', name: 'LB Finance' },
    { domain: 'vallibelfinance.com', name: 'Vallibel Finance' },
    { domain: 'centralfinance.com', name: 'Central Finance' },
    // Global Banks, Cards & Fintechs
    { domain: 'americanexpress.com', name: 'American Express' },
    { domain: 'amex.com', name: 'American Express' },
    { domain: 'wise.com', name: 'Wise' },
    { domain: 'transferwise.com', name: 'Wise' },
    { domain: 'revolut.com', name: 'Revolut' },
    { domain: 'payoneer.com', name: 'Payoneer' },
    { domain: 'paypal.com', name: 'PayPal' },
    { domain: 'chase.com', name: 'Chase' },
    { domain: 'citi.com', name: 'Citi' },
    { domain: 'citibank.com', name: 'Citibank' },
    { domain: 'barclays.co.uk', name: 'Barclays' },
    { domain: 'barclays.com', name: 'Barclays' },
    { domain: 'capitalone.com', name: 'Capital One' },
    { domain: 'wellsfargo.com', name: 'Wells Fargo' },
    { domain: 'bankofamerica.com', name: 'Bank of America' },
    { domain: 'bofa.com', name: 'Bank of America' },
    { domain: 'emiratesnbd.com', name: 'Emirates NBD' },
    { domain: 'mashreq.com', name: 'Mashreq' },
    { domain: 'dbs.com', name: 'DBS' },
    { domain: 'ocbc.com', name: 'OCBC' },
    { domain: 'uobgroup.com', name: 'UOB' },
];

export const FINANCIAL_KEYWORD_RE = /\b(e[-_ ]?statement|statement|e[-_ ]?advice|advice|bill|invoice|account|credit[-_ ]?card|creditcard|transaction|card[-_ ]?statement|epassbook|finacle|e[-_ ]?slip|banking)\b/i;
export const BANK_DOMAIN_RE = /(^|\.)(bank|finance|financial|credit|wealth|fund|fintech|epassbook)($|\.)/i;

export const REJECT = {
    NOT_A_BANK: 'sender-not-on-allowlist',
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

/** The domain out of a From header, whatever shape the display name takes. */
export function domainOf(from) {
    const s = lower(from);
    const angled = /<([^>]*)>/.exec(s);
    const addr = angled ? angled[1] : s;
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

/** Derive clean bank name from From display name or domain */
export function deriveBankName(fromHeader, domain) {
    const raw = String(fromHeader || '').trim();
    const match = /^["']?([^<"@]+?)["']?\s*<.+@.+>$/.exec(raw);
    if (match && match[1] && match[1].trim().length > 1) {
        const clean = match[1].replace(/e[-_ ]?statement|statement|notifications?|alerts?|no[-_ ]?reply/gi, '').trim();
        if (clean.length > 1) return clean;
    }
    const parts = (domain || '').split('.').filter(p => !['com', 'lk', 'net', 'org', 'co', 'gov', 'edu', 'io', 'app'].includes(p));
    const main = parts[parts.length - 1] || parts[0] || domain || 'Bank';
    return main.charAt(0).toUpperCase() + main.slice(1) + (main.toLowerCase().includes('bank') ? '' : ' Bank');
}

/**
 * Which bank sent this, if any — and only if Google says the signature holds.
 *
 * @param headers  { from, 'authentication-results' } (case-insensitive keys)
 * @returns {{ok:true, bank:string, domain:string} | {ok:false, reason:string, detail:object}}
 */
export function identifyBank(headers) {
    const h = {};
    for (const [k, v] of Object.entries(headers || {})) h[lower(k)] = v;

    const from = domainOf(h.from);
    if (!from) return { ok: false, reason: REJECT.NOT_A_BANK, detail: { from: '(none)' } };

    let hit = BANKS.find((b) => isUnder(from, b.domain));
    if (!hit) {
        const subject = lower(h.subject || '');
        const fromRaw = lower(h.from || '');
        const isFinancialMail = FINANCIAL_KEYWORD_RE.test(subject) || FINANCIAL_KEYWORD_RE.test(fromRaw) || BANK_DOMAIN_RE.test(from);
        if (isFinancialMail) {
            const derivedName = deriveBankName(h.from, from);
            hit = { domain: from, name: derivedName, dynamic: true };
        }
    }
    if (!hit) return { ok: false, reason: REJECT.NOT_A_BANK, detail: { from: from || '(none)' } };

    const passed = dkimPassedFor(h['authentication-results']);
    if (!passed.size) {
        return { ok: false, reason: REJECT.DKIM_FAILED, detail: { from, claimed: hit.name } };
    }
    /* The signing domain must cover the domain the message claims to be from.
     * A valid signature by some other domain is the attack, not a pass. */
    const signedByClaimed = [...passed].some((d) => isUnder(from, d) || isUnder(d, hit.domain) || isUnder(d, from));
    if (!signedByClaimed) {
        return {
            ok: false,
            reason: REJECT.DKIM_DOMAIN_MISMATCH,
            detail: { from, signedBy: [...passed].slice(0, 4) },
        };
    }
    return { ok: true, bank: hit.name, domain: hit.domain };
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
export function planMessage(message) {
    const headers = {};
    for (const h of (message && message.payload && message.payload.headers) || []) {
        if (h && h.name) headers[lower(h.name)] = h.value;
    }

    const who = identifyBank(headers);
    if (!who.ok) return { ok: false, ...who };

    const what = selectAttachments(message && message.payload);
    if (!what.ok) return { ok: false, ...what, bank: who.bank };

    const items = [];
    for (const a of what.take) {
        const key = itemKey(message.id, a.attachmentId);
        if (!key) continue;
        items.push({
            key,
            attachmentId: a.attachmentId,
            filename: a.filename,
            size: a.size,
            bank: who.bank,
            messageId: message.id,
            receivedMs: Number(message.internalDate) || null,
            subject: headers.subject || '',
        });
    }
    if (!items.length) return { ok: false, reason: REJECT.NO_ATTACHMENT, bank: who.bank, detail: {} };
    return { ok: true, bank: who.bank, domain: who.domain, items, skipped: what.skipped };
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
    [REJECT.DKIM_FAILED]: 'it claims to be from your bank but carries no valid signature',
    [REJECT.DKIM_DOMAIN_MISMATCH]: 'it is signed by a domain other than the one it claims to be from',
    [REJECT.NO_ATTACHMENT]: 'there is no PDF attached',
    [REJECT.TOO_LARGE]: 'the attachment is larger than the store can hold',
    [REJECT.TOO_MANY]: 'it carries more attachments than a statement should',
};

const API = {
    BANKS, REJECT, REJECT_TEXT, FINANCIAL_KEYWORD_RE, BANK_DOMAIN_RE, deriveBankName,
    SINGLE_MAX, CHUNK_SIZE, MAX_PARTS, MAX_BASE64, MAX_ATTACHMENTS,
    domainOf, isUnder, dkimPassedFor, identifyBank, selectAttachments,
    itemKey, planWrite, planMessage, isWorthTelling,
};

export default API;
