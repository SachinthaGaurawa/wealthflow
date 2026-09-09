/* =============================================================================
 * wealthflow-password-shapes.js — what a statement password is actually made of
 * -----------------------------------------------------------------------------
 * THE OWNER'S QUESTION, WHICH IS A FAIR ONE:
 *
 *   "Why didn't you anticipate that a user's password might be a Date of Birth
 *    with slashes (DD/MM/YYYY)?"
 *
 * Because the derivation only ever produced digits. wealthflow-intelligence.js
 * generated DDMMYYYY, YYYYMMDD, DDMMYY, YYMMDD, MMDDYYYY, DDMM and YYYYDDMM —
 * seven forms of the same date and not one of them with a separator in it. A
 * bank that prints "your password is your date of birth, e.g. 07/07/1993" was
 * therefore never going to be opened, and the failure looked like a broken
 * parser rather than a missing candidate.
 *
 * The deeper problem is that the vault only ever asked for a STRING. A password
 * typed as an opaque string can only ever be tried exactly as typed; the app
 * cannot know it is a birthday, so it cannot try the same birthday the eleven
 * other ways a bank might have written it. So the vault now asks what KIND of
 * thing the password is, and this module turns that answer into every plausible
 * spelling of it.
 *
 * FIVE KINDS, BECAUSE THOSE ARE THE FIVE BANKS ACTUALLY USE:
 *
 *   NIC       the national identity number — with and without the trailing V,
 *             upper and lower, the birth-encoded prefix, the last four
 *   BIRTHDAY  a date, in eleven written forms, separators included
 *   ACCOUNT   an account number — whole, last four, last six, without the
 *             grouping dashes a person types out of habit
 *   MOBILE    with and without the leading 0, with 94, the last nine, last four
 *   OTHER     exactly what was typed and NOTHING else
 *
 * OTHER DERIVES NOTHING, and that is deliberate. A password the bank simply
 * chose has no structure to exploit, and inventing variations of it would put
 * wrong guesses ahead of the right answer in the candidate list.
 *
 * THE DECLARED FORM COMES FIRST. If the owner says the bank writes it
 * DD/MM/YYYY, that exact string is candidate one; the other ten follow, because
 * an owner who is guessing is better served by ten wrong tries and an open
 * statement than by one right answer they were not sure of. A wrong candidate
 * costs one local key derivation — pdf.js, on a file already on the device,
 * with nothing sent anywhere and no lockout to trip.
 *
 * NOTHING HERE STORES, LOGS OR TRANSMITS ANYTHING. It is a pure function from a
 * declared shape to a list of strings, and the strings never leave the caller.
 * ===========================================================================*/

export const PW_KIND = {
    NIC: 'nic',
    BIRTHDAY: 'birthday',
    ACCOUNT: 'account',
    MOBILE: 'mobile',
    OTHER: 'other',
};

/** What the vault's dropdown offers, in the order it offers it. */
export const KIND_OPTIONS = Object.freeze([
    { id: PW_KIND.OTHER, label: 'A password the bank gave me', hint: 'Used exactly as typed' },
    { id: PW_KIND.BIRTHDAY, label: 'My date of birth', hint: 'Tried in every written form' },
    { id: PW_KIND.NIC, label: 'My NIC number', hint: 'With and without the trailing V' },
    { id: PW_KIND.ACCOUNT, label: 'My account number', hint: 'Whole, and the last few digits' },
    { id: PW_KIND.MOBILE, label: 'My mobile number', hint: 'With and without the leading 0' },
]);

const pad = (n) => String(n).padStart(2, '0');

/**
 * Every written form of a date, most conventional first.
 *
 * `render` takes {Y, M, D, yy} as already-padded strings, so a format cannot
 * accidentally produce a one-digit month on one path and two on another.
 */
export const DATE_FORMATS = Object.freeze([
    { id: 'DD/MM/YYYY', label: 'DD/MM/YYYY', example: '07/07/1993', render: (p) => `${p.D}/${p.M}/${p.Y}` },
    { id: 'DDMMYYYY', label: 'DDMMYYYY', example: '07071993', render: (p) => `${p.D}${p.M}${p.Y}` },
    { id: 'DD-MM-YYYY', label: 'DD-MM-YYYY', example: '07-07-1993', render: (p) => `${p.D}-${p.M}-${p.Y}` },
    { id: 'DD.MM.YYYY', label: 'DD.MM.YYYY', example: '07.07.1993', render: (p) => `${p.D}.${p.M}.${p.Y}` },
    { id: 'YYYY-MM-DD', label: 'YYYY-MM-DD', example: '1993-07-07', render: (p) => `${p.Y}-${p.M}-${p.D}` },
    { id: 'YYYYMMDD', label: 'YYYYMMDD', example: '19930707', render: (p) => `${p.Y}${p.M}${p.D}` },
    { id: 'YYYY/MM/DD', label: 'YYYY/MM/DD', example: '1993/07/07', render: (p) => `${p.Y}/${p.M}/${p.D}` },
    { id: 'DD/MM/YY', label: 'DD/MM/YY', example: '07/07/93', render: (p) => `${p.D}/${p.M}/${p.yy}` },
    { id: 'DDMMYY', label: 'DDMMYY', example: '070793', render: (p) => `${p.D}${p.M}${p.yy}` },
    { id: 'YYMMDD', label: 'YYMMDD', example: '930707', render: (p) => `${p.yy}${p.M}${p.D}` },
    { id: 'MM/DD/YYYY', label: 'MM/DD/YYYY', example: '07/07/1993', render: (p) => `${p.M}/${p.D}/${p.Y}` },
    { id: 'MMDDYYYY', label: 'MMDDYYYY', example: '07071993', render: (p) => `${p.M}${p.D}${p.Y}` },
    { id: 'DDMM', label: 'DDMM', example: '0707', render: (p) => `${p.D}${p.M}` },
]);

/** The default the dropdown opens on — what a Sri Lankan bank prints most often. */
export const DEFAULT_DATE_FORMAT = 'DD/MM/YYYY';

/**
 * The parts of a date, from anything a person or a date input might hand over.
 *
 * Accepts 1993-07-07, 07/07/1993, 07.07.1993, 19930707 and 07071993. Returns
 * null rather than a guess when it cannot tell — a wrong date silently produces
 * eleven wrong candidates that all look plausible.
 */
export function dateParts(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;

    /* EVERY READING IS TRIED AND THE FIRST VALID ONE WINS, which the first
     * draft got wrong: it took the first reading whose SHAPE matched and gave
     * up if that reading was not a real date. "07071993" matched the
     * year-first pattern as 0707-19-93, failed validation, and was reported as
     * unreadable — while the very next pattern would have read it correctly.
     * Shape is a hypothesis; only the calendar decides. */
    const readings = [];
    let m = /^(\d{4})\D?(\d{1,2})\D?(\d{1,2})$/.exec(raw);      // 1993-07-07, 19930707
    if (m) readings.push([m[1], m[2], m[3]]);
    m = /^(\d{1,2})\D(\d{1,2})\D(\d{4})$/.exec(raw);            // 07/07/1993
    if (m) readings.push([m[3], m[2], m[1]]);
    m = /^(\d{2})(\d{2})(\d{4})$/.exec(raw);                     // 07071993
    if (m) readings.push([m[3], m[2], m[1]]);

    for (const [Y, M, D] of readings) {
        const y = Number(Y), mo = Number(M), d = Number(D);
        /* A real date, not merely a well-shaped one. 31/02 renders eleven ways
         * and every one of them is wrong. */
        if (!(y >= 1900 && y <= 2200) || !(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) continue;
        const probe = new Date(Date.UTC(y, mo - 1, d));
        if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) continue;
        return { Y: String(y), M: pad(mo), D: pad(d), yy: String(y).slice(2) };
    }
    return null;
}

/** One date, written the way a given format writes it. '' when it cannot. */
export function renderDate(value, formatId) {
    const p = dateParts(value);
    if (!p) return '';
    const f = DATE_FORMATS.find((x) => x.id === formatId) || DATE_FORMATS[0];
    return f.render(p);
}

const digitsOf = (v) => String(v == null ? '' : v).replace(/\D/g, '');

function nicShapes(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const up = raw.toUpperCase();
    const out = [up, up.toLowerCase()];
    if (/[VX]$/.test(up)) out.push(up.slice(0, -1));
    else out.push(up + 'V', up + 'v');
    const d = digitsOf(up);
    if (d.length >= 4) out.push(d.slice(-4));
    if (d.length >= 6) out.push(d.slice(0, 6));
    /* An old NIC's first five digits are the year and day-of-year; a new one is
     * a full date. Both are commonly the whole password on their own. */
    if (d.length >= 8) out.push(d.slice(0, 8));
    return out;
}

function accountShapes(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const d = digitsOf(raw);
    const out = [raw];
    if (d && d !== raw) out.push(d);                      // typed with dashes or spaces
    if (d.length > 4) out.push(d.slice(-4));
    if (d.length > 6) out.push(d.slice(-6));
    const trimmed = d.replace(/^0+/, '');
    if (trimmed && trimmed !== d) out.push(trimmed);
    return out;
}

function mobileShapes(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return [];
    const d = digitsOf(raw);
    const out = [raw];
    if (d && d !== raw) out.push(d);
    /* Sri Lanka: 0771234567 locally, 94771234567 internationally, and the
     * nine-digit subscriber number is what several banks actually ask for. */
    const local = d.startsWith('94') ? '0' + d.slice(2) : (d.startsWith('0') ? d : '0' + d);
    const nine = local.replace(/^0/, '');
    out.push(local, nine, '94' + nine, '+94' + nine);
    if (d.length >= 4) out.push(d.slice(-4));
    return out;
}

function birthdayShapes(value, formatId) {
    const p = dateParts(value);
    if (!p) {
        /* Not a date this module can read. The owner typed SOMETHING, so it is
         * offered as itself rather than discarded — losing a password the owner
         * saved is the worst outcome available here. */
        const raw = String(value == null ? '' : value).trim();
        return raw ? [raw] : [];
    }
    const first = DATE_FORMATS.find((f) => f.id === formatId);
    const rest = DATE_FORMATS.filter((f) => f !== first);
    return [...(first ? [first] : []), ...rest].map((f) => f.render(p));
}

/**
 * Every plausible spelling of one vault entry, most likely first.
 *
 * An entry is `{ password, kind, format }`. An entry with no kind — every entry
 * saved before this existed — is treated as OTHER, so an upgrade changes
 * nothing about passwords already in the vault.
 */
export function expand(entry) {
    const e = (entry && typeof entry === 'object') ? entry : {};
    const value = e.password == null ? '' : String(e.password);
    if (!value) return [];
    const kind = String(e.kind || PW_KIND.OTHER).toLowerCase();

    let derived;
    switch (kind) {
        case PW_KIND.BIRTHDAY: derived = birthdayShapes(value, e.format || DEFAULT_DATE_FORMAT); break;
        case PW_KIND.NIC: derived = nicShapes(value); break;
        case PW_KIND.ACCOUNT: derived = accountShapes(value); break;
        case PW_KIND.MOBILE: derived = mobileShapes(value); break;
        default: derived = [value]; break;
    }

    /* What the owner typed is ALWAYS in the list, whatever the kind said. A
     * mistyped kind must never be able to discard the one string they were
     * certain of. */
    const out = [];
    for (const x of [...derived, value]) {
        const v = x == null ? '' : String(x);
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

/** The same, over a whole vault, keeping order and dropping repeats. */
export function expandAll(entries) {
    const out = [];
    for (const e of Array.isArray(entries) ? entries : []) {
        for (const v of expand(e)) if (!out.includes(v)) out.push(v);
    }
    return out;
}

/** A short, honest sentence about what will be tried. Shown under the dropdown. */
export function describe(entry) {
    const n = expand(entry).length;
    if (!n) return '';
    const kind = String((entry && entry.kind) || PW_KIND.OTHER).toLowerCase();
    if (kind === PW_KIND.OTHER) return 'Tried exactly as typed.';
    return n === 1 ? 'Tried exactly as typed.' : `${n} forms of this will be tried, in order.`;
}

const API = {
    PW_KIND, KIND_OPTIONS, DATE_FORMATS, DEFAULT_DATE_FORMAT,
    dateParts, renderDate, expand, expandAll, describe,
};
if (typeof window !== 'undefined') window.WFPwShapes = API;
export default API;
