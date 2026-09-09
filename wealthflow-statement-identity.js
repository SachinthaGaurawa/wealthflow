/* =============================================================================
 * wealthflow-statement-identity.js — is this document a bank statement?
 * -----------------------------------------------------------------------------
 * THE COMPLAINT, AND WHY EVERY PREVIOUS ANSWER MISSED IT
 *
 * The owner reported invoices and receipts filling a screen meant for bank
 * statements, repeatedly, and adding sender addresses did not stop it. They were
 * right, and the reason is one line in planMessage:
 *
 *     if (who.known === false) { ...looksLikeStatement... }
 *
 * The only check on WHAT a document is ran when the SENDER was unrecognised.
 * Approve a sender and every PDF that sender ever mails is filed unread —
 * invoices, receipts, order confirmations, payslips. The fetch is widened to the
 * whole domain on purpose (a bank's second address must be discoverable), so an
 * approved supplier domain that also invoices you sends its invoices straight
 * into the review queue. Their screenshot is exactly that: Invoice-NCQIAKMS-0008,
 * Receipt-2402-5154-7274, invoice-113674, beside one real DFCC statement.
 *
 * APPROVING A SENDER MEANS "THIS SENDER MAY SEND ME STATEMENTS". It has never
 * meant "everything this sender sends is a statement", and the code read it the
 * second way. That is the whole bug.
 *
 * TWO LAYERS, AND THE SPLIT IS THE DESIGN
 *
 * Layer 1 — nameVerdict(). Subject and filenames, no download, runs on the
 * server before a single byte of attachment is fetched. It may only reject on
 * POSITIVE evidence of being something else: a file called Invoice-0008.pdf
 * announces itself. It must never reject for merely failing to say "statement",
 * because real statements arrive as 5996631318_455.pdf — one is in the owner's
 * own screenshot, and it parsed two transactions correctly. A filename-must-
 * say-statement rule would have thrown that away.
 *
 * Layer 2 — textVerdict(). The extracted text, on the device, after unlocking.
 * This is the authoritative one, because it can see what the document actually
 * contains: a statement period, an opening and closing balance, an account
 * identifier, a table of dated movements. An invoice has a total and line items
 * and no running balance; a statement has a balance that moves.
 *
 * UNSURE ACCEPTS. Losing a real statement is far worse than showing one invoice,
 * so the middle verdict lets the document through and says it is unverified.
 * Only clear evidence of being something else rejects — and a rejection is
 * COUNTED AND NAMED, never silent, because the owner's earlier instruction
 * stands: do not silently drop what you cannot read. An invoice correctly
 * rejected and a statement wrongly rejected must be told apart by looking, and
 * that requires the rejection to be visible.
 *
 * Pure: no network, no clock, no DOM. Both layers are exercised directly by
 * test/statement_identity_test.js rather than through a mock of a caller.
 * ===========================================================================*/

export const VERDICT = {
    /** Proven a statement. File it. */
    STATEMENT: 'statement',
    /** Proven something else. Refuse it, and say so where the owner can see. */
    NOT_STATEMENT: 'not-statement',
    /** Neither proven. Let it through, flagged — a lost statement is worse. */
    UNSURE: 'unsure',
};

const lower = (s) => String(s == null ? '' : s).toLowerCase();

/* Collapse the punctuation a filename uses as spaces, so "Invoice-NCQIAKMS-0008"
 * and "invoice no 0008" are the same haystack to a word test. Digits are kept:
 * "xxxx4321" is evidence, and so is a 16-digit card number. */
function hay(parts) {
    return ' ' + lower((Array.isArray(parts) ? parts : [parts]).join(' \n '))
        .replace(/[_\-.,;:()[\]{}/\\|]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim() + ' ';
}

/* ── LAYER 1: the name ────────────────────────────────────────────────────── */

/**
 * Words that mean "this is not a statement", when the document names itself.
 *
 * Every one of these had to be checked against the opposite risk. `bill` is here
 * as `bill to` and `utility bill` only, never bare: a credit-card statement is
 * commonly called a bill, and an earlier version of this pipeline searched for
 * the bare words `invoice` and `bill` and threw away real card statements. That
 * is recorded in wealthflow-mail-ingest.mjs and is the reason this list is
 * phrases rather than words.
 */
export const NOT_STATEMENT_NAMES = [
    'invoice', 'tax invoice', 'proforma', 'pro forma',
    'receipt', 'cash receipt', 'payment receipt',
    'quotation', 'quote no', 'estimate',
    'purchase order', 'delivery note', 'delivery order', 'packing list',
    'bill to', 'utility bill', 'water bill', 'electricity bill', 'phone bill',
    'payslip', 'pay slip', 'salary slip',
    'ticket', 'boarding pass', 'itinerary',
    'certificate', 'policy schedule', 'insurance policy',
    'newsletter', 'brochure', 'flyer', 'promotion', 'offer letter',
    'agreement', 'contract',
];

/**
 * Words that mean "this IS a statement", and outrank the list above.
 *
 * A bank that titles its mail "Your e-Statement / Tax Invoice" exists, and the
 * statement word has to win there — the document is a statement that happens to
 * carry a tax line.
 */
export const STATEMENT_NAMES = [
    'statement', 'e statement', 'estatement', 'estmt', 'stmt',
    'account activity', 'account summary', 'transaction history',
    'passbook', 'account advice', 'credit card statement',
];

/**
 * Judge a message by its subject and attachment names, without downloading.
 *
 * REJECTS ONLY ON POSITIVE EVIDENCE OF BEING SOMETHING ELSE. Silence is not
 * evidence: `5996631318_455.pdf` says nothing at all and is a real statement in
 * the owner's own screenshot. Returning NOT_STATEMENT for it would have deleted
 * the two transactions it parsed correctly.
 */
export function nameVerdict(input) {
    /* `= {}` alone would still throw on an explicit null, and a caller that
     * hands us a header block it failed to read hands us exactly that. A
     * document identifier that throws would take the whole sync down. */
    const { subject = '', filenames = [] } = (input && typeof input === 'object') ? input : {};
    const names = (Array.isArray(filenames) ? filenames : []).filter(Boolean);
    const h = hay([subject, ...names]);
    if (h.trim() === '') return { verdict: VERDICT.UNSURE, reason: 'nothing to read', hits: [] };

    const positive = STATEMENT_NAMES.filter((t) => h.includes(' ' + t) || h.includes(t + ' '));
    const negative = NOT_STATEMENT_NAMES.filter((t) => h.includes(t));

    /* The statement word wins. A document titled "e-Statement / Tax Invoice" is
     * a statement; a document titled "Invoice" and nothing else is not. */
    if (positive.length) {
        return { verdict: VERDICT.STATEMENT, reason: 'the name says statement', hits: positive };
    }
    if (negative.length) {
        return {
            verdict: VERDICT.NOT_STATEMENT,
            reason: 'the name says ' + negative[0],
            hits: negative,
        };
    }
    return { verdict: VERDICT.UNSURE, reason: 'the name says neither', hits: [] };
}

/* ── LAYER 2: the document ────────────────────────────────────────────────── */

/* A statement is periodic, has an account, and has a balance that MOVES. Each
 * of these is a separate, independently checkable fact rather than one blob of
 * keywords, so a screen can say which ones were found. */
const PERIOD = [
    'statement period', 'statement date', 'statement from', 'period from',
    'for the period', 'from date', 'billing period', 'billing cycle',
    'statement of account', 'account statement',
];
const BALANCE = [
    'opening balance', 'closing balance', 'balance b/f', 'balance bf',
    'brought forward', 'carried forward', 'previous balance', 'closing bal',
    'opening bal', 'balance forward', 'available balance', 'running balance',
    'ledger balance', 'book balance',
];
const ACCOUNT = [
    'account no', 'account number', 'a/c no', 'ac no', 'acct no',
    'card number', 'card no', 'account name', 'iban', 'sort code',
];
const CARD_STATEMENT = [
    'credit limit', 'minimum payment', 'minimum amount due', 'payment due date',
    'statement balance', 'available credit', 'reward points', 'cash advance limit',
];
/* Strong evidence of an invoice or a till receipt: a document that itemises what
 * you bought rather than what moved through an account. */
const ITEMISED = [
    'invoice no', 'invoice number', 'invoice date', 'tax invoice',
    'bill to', 'ship to', 'sold to', 'purchase order', 'po number', 'po no',
    'unit price', 'qty', 'quantity', 'line total', 'item total',
    'sub total', 'subtotal', 'discount', 'vat no', 'gst no', 'vat reg',
    'cashier', 'till no', 'change due', 'tendered', 'thank you for shopping',
    'net pay', 'gross pay', 'basic salary', 'epf', 'etf',
];

/* A money token, and a date, on the same line — the shape of a movement. */
const MONEY = /\d{1,3}(?:,\d{3})+\.\d{2}(?!\d)|\d+\.\d{2}(?!\d)/;
const DATE = new RegExp(
    '\\d{1,2}[\\/\\-.](?:\\d{1,2}|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[\\/\\-.]\\d{2,4}'
    + '|\\d{4}[\\/\\-.]\\d{1,2}[\\/\\-.]\\d{1,2}'
    + '|\\d{1,2}\\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)', 'i');

/** How many lines carry a date AND money — a table of movements. */
export function movementLines(text) {
    let n = 0;
    for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        if (line.length > 400) continue;                 // a wall of text is not a table
        if (DATE.test(line) && MONEY.test(line)) n += 1;
    }
    return n;
}

const found = (h, list) => list.filter((t) => h.includes(t));

/**
 * Judge the document by what it contains.
 *
 * THE AUTHORITATIVE LAYER, and the one the owner asked for: "it must strictly
 * validate if a PDF is an actual bank statement (via metadata, deep text
 * inspection, or specific financial keywords) before throwing it into the
 * queue."
 *
 * Evidence, not a score with a magic threshold — each fact is reported by name
 * so a wrong answer can be argued with rather than merely disagreed with.
 */
export function textVerdict(text) {
    const raw = String(text == null ? '' : text);
    const trimmed = raw.replace(/\s+/g, ' ').trim();
    if (trimmed.length < 40) {
        /* An image-only PDF. NOT a rejection: OCR's job, and
         * wealthflow-statement-parser.js already reports 'no-text' for it. */
        return {
            verdict: VERDICT.UNSURE, confidence: 0,
            reason: 'there is no text to inspect — it may be a scan',
            evidence: [], against: [],
        };
    }

    const h = hay([raw]);
    const period = found(h, PERIOD);
    const balance = found(h, BALANCE);
    const account = found(h, ACCOUNT);
    const card = found(h, CARD_STATEMENT);
    const itemised = found(h, ITEMISED);
    const rows = movementLines(raw);

    const evidence = [];
    if (period.length) evidence.push({ what: 'period', hits: period.slice(0, 3) });
    if (balance.length) evidence.push({ what: 'balance', hits: balance.slice(0, 3) });
    if (account.length) evidence.push({ what: 'account', hits: account.slice(0, 3) });
    if (card.length) evidence.push({ what: 'card-statement', hits: card.slice(0, 3) });
    if (rows >= 3) evidence.push({ what: 'movements', hits: [rows + ' dated money rows'] });

    const against = itemised.length ? [{ what: 'itemised', hits: itemised.slice(0, 4) }] : [];

    /* WHAT MAKES IT A STATEMENT. Two independent facts, or a real table of
     * movements plus one. A single keyword is not enough: "available balance"
     * appears at the foot of plenty of receipts. */
    const strong = (period.length ? 1 : 0) + (balance.length ? 1 : 0)
        + (card.length ? 1 : 0) + (rows >= 3 ? 1 : 0);
    const statementish = strong >= 2 || (strong >= 1 && account.length > 0);

    /* WHAT MAKES IT AN INVOICE. Itemisation is the tell — a document that lists
     * quantities and unit prices is describing a purchase, not an account. Two
     * or more of those phrases, with no statement evidence, is decisive. */
    const itemisedish = itemised.length >= 2;

    if (statementish && !itemisedish) {
        return {
            verdict: VERDICT.STATEMENT,
            confidence: Math.min(1, 0.55 + 0.15 * strong),
            reason: 'it has ' + evidence.map((e) => e.what).join(' and '),
            evidence, against,
        };
    }
    if (itemisedish && !statementish) {
        return {
            verdict: VERDICT.NOT_STATEMENT,
            confidence: Math.min(1, 0.55 + 0.1 * itemised.length),
            reason: 'it reads as an itemised ' + (itemised.includes('net pay') ? 'payslip' : 'invoice or receipt')
                + ' — ' + itemised.slice(0, 3).join(', '),
            evidence, against,
        };
    }
    /* BOTH, OR NEITHER. A bank's statement that carries a tax invoice line, or a
     * document too plain to call. It goes through, flagged — because the cost of
     * being wrong here is asymmetric and the owner said so first: do not
     * silently drop what you cannot read. */
    return {
        verdict: VERDICT.UNSURE,
        confidence: 0.4,
        reason: statementish
            ? 'it looks like a statement but also itemises purchases'
            : 'nothing in it proves either way',
        evidence, against,
    };
}

/**
 * The two layers, as one answer.
 *
 * The NAME may only veto before a download; once the TEXT is available it is
 * the authority — a bank that titles its mail "Invoice" and attaches a genuine
 * statement must not lose it to its own subject line.
 */
export function identify(input) {
    const { subject = '', filenames = [], text = null } = (input && typeof input === 'object') ? input : {};
    const byName = nameVerdict({ subject, filenames });
    if (text == null) return { ...byName, layer: 'name' };

    const byText = textVerdict(text);
    if (byText.verdict !== VERDICT.UNSURE) return { ...byText, layer: 'text' };
    /* The text could not decide. Fall back to the name, which at least saw the
     * document announce itself — but never let a name promote an UNSURE text to
     * a proven statement, because the text is what would have proved it. */
    if (byName.verdict === VERDICT.NOT_STATEMENT) return { ...byName, layer: 'name' };
    return { ...byText, layer: 'text' };
}

/** True when this document may enter the review queue. */
export function admits(v) {
    return !!v && v.verdict !== VERDICT.NOT_STATEMENT;
}
