/* =============================================================================
 * statement-document-kind.mjs — a document that NAMES ITSELF something other than a statement
 * -----------------------------------------------------------------------------
 * A bank mails a mandate, an application, a consent form, an agreement or a tariff with the same sender, often in the same mail as the month's statement, so the mail's own
 * words ("statement") speak for every attachment in it. The worker holds a document the mail did not vouch for to its own contents (identity, structure); one the mail DID vouch for
 * was never held to anything but its arithmetic, and a direct-debit mandate (NTB, "Mandate.pdf" — a date, an amount, a signature line) sat in front of the owner as "rows could not
 * be proven to add up" and, when the owner tapped "Map statement layout", as "WealthFlow still cannot read the NTB statement… none of them lined up with any transaction amount".
 *
 * The test is deliberately narrow, because a lost statement is worse than a shown form: the document must announce the form by its FILE NAME or by its TITLE (the first lines),
 * must not say "statement" in either place, and the caller applies it only to a document whose rows the reader could not prove. A statement titled "Credit Card Statement" is
 * never touched, and neither is any document whose rows reconcile.
 *
 * Pure: no network, no clock, no storage.
 * ===========================================================================*/

const lower = (v) => String(v == null ? '' : v).toLowerCase();
const words = (v) => ' ' + lower(v).replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim() + ' ';

/** What a form calls itself. Phrases a statement does not use as its own title. */
export const FORM_TITLES = [
    'mandate', 'direct debit mandate', 'standing instruction', 'standing order form', 'application form', 'account opening form',
    'consent form', 'declaration form', 'authorization form', 'authorisation form', 'indemnity', 'nomination form',
    'terms and conditions', 'terms conditions', 'tariff', 'fee schedule', 'schedule of fees', 'privacy notice', 'welcome letter', 'key fact sheet',
];
const STATEMENT_WORDS = [' statement ', ' statements ', ' estatement ', ' e statement ', ' stmt ', ' estmt '];
const TITLE_LINES = 12;

const sayStatement = (h) => STATEMENT_WORDS.some((w) => h.includes(w));
const formIn = (h) => FORM_TITLES.find((t) => h.includes(' ' + t + ' ')) || '';

/**
 * Does this document call itself a form? `where` says by which evidence: the file name, or the title block.
 * @returns {{form:string, where:'file'|'title'}|null}
 */
export function formKind({ text = '', filename = '' } = {}) {
    const file = words(String(filename || '').replace(/\.[a-z0-9]{2,5}$/i, ''));
    if (formIn(file) && !sayStatement(file)) return { form: formIn(file), where: 'file' };
    const head = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(0, TITLE_LINES);
    const title = words(head.join(' \n '));
    if (head.length && formIn(title) && !sayStatement(title)) return { form: formIn(title), where: 'title' };
    return null;
}

export default { FORM_TITLES, formKind };
