/* =============================================================================
 * wealthflow-payaccounts.js — the owner's bank accounts, as the people who owe them money see them
 * -----------------------------------------------------------------------------
 * A debtor who wants to repay, or an investor who wants to add capital, needs somewhere to send it.
 * The owner keeps those account details in ONE place (Saved people → Payment details) and the
 * statement page shows them, after the NIC and the one-time code, and the downloadable PDF repeats them.
 *
 *   - `payAccounts[]` is a record array like every ledger here: it merges per record across devices,
 *     and a delete is a tombstone, not a resurrection.
 *   - Each account says WHO sees it: everybody, only debtors, or only investors. A person sees only
 *     the accounts meant for the kind of record they are on.
 *   - An account can be switched off without deleting it (a closed account, a holiday).
 *   - What leaves the owner's books is a WHITELIST (publicAccounts): bank, holder, number, branch,
 *     SWIFT/IBAN, note (and the note in Sinhala, when the owner wrote one). Not the id, not the audience, not a timestamp.
 *
 * Shared by the page (the editor) and the server (the statement and the PDF), so there is one
 * definition of what a valid account is and one of what leaves. Pure. ESM.
 * ===========================================================================*/

export const PAY_KEY = 'payAccounts';
export const SHOW = Object.freeze({ BOTH: 'both', DEBTORS: 'debtors', INVESTORS: 'investors' });
export const LIMITS = Object.freeze({ bank: 60, holder: 80, number: 40, branch: 60, swift: 34, note: 200, noteSi: 400, accounts: 10 });

export const SHOW_TEXT = Object.freeze({
    both: 'Debtors and investors',
    debtors: 'Debtors only',
    investors: 'Investors only',
});

const str = (v) => String(v == null ? '' : v);
/** Collapses whitespace and drops control characters: details pasted from a bank's email or a chat are not trusted to be tidy. */
const squash = (v) => str(v).replace(/[\u0000-\u001F\u007F]+/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * Validate what the editor says and produce the record's fields.
 *   input: { bank, holder, number, branch, swift, note, showTo, active }
 * @returns {{ok:boolean, fields:object, errors:object}}
 */
export function cleanAccount(input) {
    const i = input && typeof input === 'object' ? input : {};
    const errors = {};
    const bank = squash(i.bank).slice(0, LIMITS.bank);
    if (!bank) errors.bank = 'Enter the bank name.';
    const holder = squash(i.holder).slice(0, LIMITS.holder);
    if (!holder) errors.holder = 'Enter the name on the account.';

    let number = squash(i.number).slice(0, LIMITS.number);
    if (!number) errors.number = 'Enter the account number.';
    else if (/[^A-Za-z0-9 .\-/]/.test(number)) errors.number = 'An account number can only contain letters, digits, spaces and - . /';
    else if ((number.match(/[A-Za-z0-9]/g) || []).length < 4) errors.number = 'That account number is too short.';

    let swift = squash(i.swift).slice(0, LIMITS.swift).toUpperCase();
    if (swift && /[^A-Z0-9 ]/.test(swift)) { errors.swift = 'A SWIFT code or IBAN can only contain letters, digits and spaces.'; swift = ''; }

    const showTo = Object.values(SHOW).includes(i.showTo) ? i.showTo : SHOW.BOTH;
    const fields = {
        bank, holder, number: errors.number ? '' : number,
        branch: squash(i.branch).slice(0, LIMITS.branch),
        swift,
        note: squash(i.note).slice(0, LIMITS.note),
        showTo,
        active: i.active === false || i.active === 'false' || i.active === 0 ? false : true,
    };
    // The same note in Sinhala, for the statement page and PDF when the customer reads them in Sinhala. Present only when the owner wrote one.
    const noteSi = squash(i.noteSi).slice(0, LIMITS.noteSi);
    if (noteSi) fields.noteSi = noteSi;
    return { ok: Object.keys(errors).length === 0, fields, errors };
}

/** The accounts as an array of well-formed records (a damaged entry is skipped, never thrown on), oldest first. */
export function listAccounts(raw) {
    return (Array.isArray(raw) ? raw : [])
        .filter((a) => a && typeof a === 'object' && str(a.id) && squash(a.bank) && squash(a.number))
        .slice()
        .sort((a, b) => str(a.createdAt).localeCompare(str(b.createdAt)) || str(a.id).localeCompare(str(b.id)));
}

/** Is this account meant for somebody on this kind of record? `layer` 'A' is an investment (the investor), 'B' a loan (the debtor). */
export function visibleTo(account, layer) {
    const a = account || {};
    if (a.active === false) return false;
    const to = Object.values(SHOW).includes(a.showTo) ? a.showTo : SHOW.BOTH;
    if (to === SHOW.BOTH) return true;
    return layer === 'B' ? to === SHOW.DEBTORS : layer === 'A' ? to === SHOW.INVESTORS : false;
}

/**
 * What leaves the books: the accounts one person may see, as plain fields and nothing else.
 *   layers: the kinds of record they are on, e.g. ['B'] or ['A','B']
 */
export function publicAccounts(raw, layers = ['A', 'B']) {
    const want = (Array.isArray(layers) ? layers : [layers]).filter((l) => l === 'A' || l === 'B');
    if (!want.length) return [];
    const out = [];
    for (const a of listAccounts(raw)) {
        if (!want.some((l) => visibleTo(a, l))) continue;
        const clean = cleanAccount(a);
        if (!clean.ok) continue;                                    // a record that would not pass the editor does not go out
        const { bank, holder, number, branch, swift, note, noteSi } = clean.fields;
        out.push(noteSi ? { bank, holder, number, branch, swift, note, noteSi } : { bank, holder, number, branch, swift, note });
        if (out.length >= LIMITS.accounts) break;
    }
    return out;
}

/** An account as lines of text, for a copy button or a plain-text export. */
export function accountText(a) {
    const x = a || {};
    return [
        'Bank: ' + str(x.bank),
        'Account name: ' + str(x.holder),
        'Account number: ' + str(x.number),
        x.branch ? 'Branch: ' + str(x.branch) : '',
        x.swift ? 'SWIFT / IBAN: ' + str(x.swift) : '',
        x.note ? 'Note: ' + str(x.note) : '',
    ].filter(Boolean).join('\n');
}

export default { PAY_KEY, SHOW, SHOW_TEXT, LIMITS, cleanAccount, listAccounts, visibleTo, publicAccounts, accountText };
