/* =============================================================================
 * wealthflow-people-ui.js — the screens of the saved-people book and the payment details
 * -----------------------------------------------------------------------------
 * What the owner sees (the rules live in wealthflow-people.js and wealthflow-payaccounts.js; this file is
 * the glue that draws them, and holds no authority of its own):
 *
 *   CONTACT FIELDS   on a loan and on an investment: mobile number (Sri Lankan only) (typed, or taken from the phone's own
 *                    contacts), NIC or passport/ID, a live line saying exactly which number the texts will go to,
 *                    and "Save to my people list".
 *   SAVED PEOPLE     a picker at the top of those forms ("Nimal Perera · +94 77 123 4567") that fills everything in.
 *                    Picking is how a second loan to the same person takes ten seconds.
 *   THE BOOK         Saved people → People: add, edit, delete, search, import from the phone's contacts or a contacts
 *                    file, file everybody the ledgers already name.
 *   PAYMENT DETAILS  Saved people → Payment details: the bank accounts the statement page and the PDF show to
 *                    debtors and investors, each for debtors, investors or both, each switchable off.
 *   MESSAGES         the text-message log, as the third tab.
 *
 * DEVICE CONTACTS. Only Chrome on Android lets a web page open the address book (navigator.contacts); no other browser on any
 * system does, whatever the device. So every "Contacts" button opens one sheet with every way that works: the phone's own
 * picker where there is one, a contacts file (vCard from any phone, Mac, Google or iCloud; CSV from Google or Outlook), a file
 * dropped on the sheet, or text copied from a contacts app (a number, "Name: number", a whole card) pasted or read from the
 * clipboard. The sheet tells each kind of device (Android, iPhone, Mac, Windows, other) the exact steps. Nothing leaves the
 * device: the contacts are read in the page and only what the owner taps is used.
 *
 * Nothing here throws into the app: if this file fails to load, the forms keep working without it. ESM; window.WFPeople.
 * ===========================================================================*/

import { regionByIso, DEFAULT_REGION, formatPhone } from './wealthflow-phone.js';
import { displayIdentity } from './wealthflow-nic.js';
import * as People from './wealthflow-people.js';
import * as Pay from './wealthflow-payaccounts.js';

const s = (v) => String(v == null ? '' : v);
const esc = (v) => s(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' }[c]));
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many);

/* ── 1. the pieces every form shares ─────────────────────────────────────── */

/**
 * There is no country to choose: the gateway delivers inside Sri Lanka only, so every number is a Sri Lankan mobile number (wealthflow-phone.js).
 * The forms still carry the region as one hidden field, which is always Sri Lanka, so the code that reads a form keeps one shape.
 */
export function countrySelectHtml(id, _selected, attrs = '') {
    return '<input type="hidden" id="' + esc(id) + '" value="' + DEFAULT_REGION + '" ' + attrs + '>';
}

/** How a stored number is shown: "+94 77 123 4567" when it is one, what was typed when it is not. */
export const showPhone = (v) => formatPhone(s(v).trim());

/** What the line under a mobile number says: { cls, text }. `commit` is true once the person has finished typing (leaving the box). */
export function phoneNote(raw, iso, commit = true) {
    const r = People.resolvePhone(raw, iso);
    if (r.empty) return { cls: '', text: '' };
    if (r.ok) return { cls: 'ok', text: r.text };
    return commit ? { cls: 'warn', text: r.text } : { cls: '', text: '' };
}

/**
 * The line under the second number: a number that can be texted says so, the same number as the first says it is the same, and anything
 * that is not a mobile number (a landline) says it is kept and not texted. `firstRaw` is what the first box holds.
 */
export function phone2Note(raw, firstRaw, iso, commit = true) {
    const r = People.resolvePhone(raw, iso);
    if (r.empty) return { cls: '', text: '' };
    if (r.ok) {
        const first = People.resolvePhone(firstRaw, iso);
        if (first.ok && first.e164 === r.e164) return commit ? { cls: 'warn', text: 'This is the same as the first number. Leave it empty or enter a different one.' } : { cls: '', text: '' };
        return { cls: 'ok', text: r.text + ' · texts go here as well' };
    }
    return commit ? { cls: 'warn', text: r.text + ' It is kept as typed and no texts go to it.' } : { cls: '', text: '' };
}

/** The line under an ID box. */
export function idNote(raw, kind, commit = true) {
    const t = s(raw).trim();
    if (!t) return { cls: '', text: '' };
    const r = People.storedId(t, kind);
    if (r.ok) return { cls: 'ok', text: (kind === 'other' ? 'ID ' : 'NIC ') + displayIdentity(r.stored) };
    return commit ? { cls: 'warn', text: r.text } : { cls: '', text: '' };
}

const ID_LABEL = { nic: 'NIC number', other: 'Passport or ID number' };
const ID_HINT = { nic: '853400937V or 198534000937', other: 'Passport or national ID number' };
const ID_HELP = 'With an NIC or ID number the person can open their own private statement page (a one-time code is texted to the mobile number first).';

/**
 * The contact fields of a form. Every id starts with `prefix`:
 *   _cc country · _phone mobile · _pv its live line · _phone2 second mobile (optional) · _pv2 its live line · _idk kind of ID · _nic the ID · _idv its live line · _pid hidden person id ·
 *   _remember "Save to my people list" · _linked "Saved person" note
 * opts: { kind:'debtor'|'investment'|'person', record, people, nameId, defaultCountry, remember:boolean, errors:{phone?,nic?}, phoneHelp:string }
 *   `nameId` is the form's own name box, which a picked person or a picked contact fills.
 */
export function contactHtml(prefix, { kind = 'debtor', record = null, people = [], nameId = '', defaultCountry = DEFAULT_REGION, remember = true, errors = {}, phoneHelp = '' } = {}) {
    const p = esc(prefix);
    const r = record && typeof record === 'object' ? record : {};
    const person = People.personById(people, r.personId);
    const fallback = regionByIso(person && person.country) ? person.country : (regionByIso(defaultCountry) ? s(defaultCountry).toUpperCase() : DEFAULT_REGION);
    // a record linked to a saved person that holds no number or ID of its own (it was filed from the ledger, or edited elsewhere) shows the
    // person's: saving the form must not read an empty box as "this person has no number" and clear it for everybody
    const phoneRaw = s(r.phone).trim() || (person ? s(person.phone).trim() : '');
    const info = phoneRaw ? People.resolvePhone(phoneRaw, fallback) : null;
    const iso = info && info.ok ? info.iso : fallback;
    const idStored = s(r.nic).trim() || (person ? s(person.nic).trim() : '');
    const idKind = idStored ? People.idKindOf(idStored) : (iso === DEFAULT_REGION ? 'nic' : 'other');
    const fullRaw = s(r.fullName).trim() || (person ? s(person.fullName).trim() : '');
    const phone2Raw = s(r.phone2).trim() || (person ? s(person.phone2).trim() : '');
    const info2 = phone2Raw ? People.resolvePhone(phone2Raw, iso) : null;
    const pv = errors && errors.phone ? { cls: 'bad', text: errors.phone } : phoneNote(phoneRaw, iso, true);
    const pv2 = errors && errors.phone2 ? { cls: 'bad', text: errors.phone2 } : phone2Note(phone2Raw, phoneRaw, iso, true);
    const iv = errors && errors.nic ? { cls: 'bad', text: errors.nic } : idNote(displayIdentity(idStored), idKind, true);
    const common = ' data-p="' + p + '" data-name="' + esc(nameId) + '"';
    return '<div class="wfp-contact" data-p="' + p + '" data-kind="' + esc(kind) + '">'
        + '<input type="hidden" id="' + p + '_pid" value="' + esc(person ? person.id : '') + '">'
        + '<div class="fg"><label class="fl" for="' + p + '_full">Full name <span class="wfp-opt">(shown to the customer)</span></label>'
        + '<input class="fi" id="' + p + '_full" maxlength="' + People.LIMITS.fullName + '" autocomplete="off" data-wfp="full"' + common + ' placeholder="The customer\'s own name, as on their NIC" value="' + esc(fullRaw) + '">'
        + '<div class="wfp-help">The name above is your own nickname for this person, the one you see in WealthFlow. The customer\'s statement page and PDF show this full name and their NIC instead.</div></div>'
        + countrySelectHtml(prefix + '_cc', iso, 'data-wfp="cc"' + common)
        + '<div class="fg"><label class="fl" for="' + p + '_phone">Mobile number</label>'
        + '<div class="wfp-row"><input class="fi" id="' + p + '_phone" type="tel" inputmode="tel" autocomplete="off" maxlength="40" data-wfp="phone"' + common
        + ' placeholder="077 123 4567" value="' + esc(info && info.ok ? info.pretty : phoneRaw) + '">'
        + '<button type="button" class="btn btn-secondary btn-sm wfp-btn" data-wfp="contacts"' + common + ' title="Take the number from your contacts, a contacts file, or text you copied">Contacts</button></div>'
        + '<div class="wfp-pv ' + pv.cls + '" id="' + p + '_pv" role="status" aria-live="polite">' + esc(pv.text) + '</div>'
        + (phoneHelp ? '<div class="wfp-help">' + esc(phoneHelp) + '</div>' : '') + '</div>'
        + '<div class="fg"><label class="fl" for="' + p + '_phone2">Second mobile number <span class="wfp-opt">(optional)</span></label>'
        + '<div class="wfp-row"><input class="fi" id="' + p + '_phone2" type="tel" inputmode="tel" autocomplete="off" maxlength="' + People.LIMITS.phone2 + '" data-wfp="phone2"' + common
        + ' placeholder="Optional. Every text goes to this number too" value="' + esc(info2 && info2.ok ? info2.pretty : phone2Raw) + '">'
        + '<button type="button" class="btn btn-secondary btn-sm wfp-btn" data-wfp="contacts2"' + common + ' title="Take the second number from your contacts, a contacts file, or text you copied">Contacts</button></div>'
        + '<div class="wfp-pv ' + pv2.cls + '" id="' + p + '_pv2" role="status" aria-live="polite">' + esc(pv2.text) + '</div>'
        + '<div class="wfp-help">Sri Lankan mobile numbers only (07X XXX XXXX): the text service delivers inside Sri Lanka.</div></div>'
        + '<div class="fg"><label class="fl" for="' + p + '_nic" id="' + p + '_nic_l">' + ID_LABEL[idKind] + '</label>'
        + '<div class="wfp-row"><select class="fs wfp-idk" id="' + p + '_idk" data-wfp="idk"' + common + ' aria-label="Kind of ID">'
        + '<option value="nic"' + (idKind === 'nic' ? ' selected' : '') + '>NIC</option><option value="other"' + (idKind === 'other' ? ' selected' : '') + '>Passport / ID</option></select>'
        + '<input class="fi" id="' + p + '_nic" autocomplete="off" autocapitalize="characters" maxlength="24" data-wfp="nic"' + common
        + ' placeholder="' + esc(ID_HINT[idKind]) + '" value="' + esc(displayIdentity(idStored)) + '"></div>'
        + '<div class="wfp-pv ' + iv.cls + '" id="' + p + '_idv" role="status" aria-live="polite">' + esc(iv.text) + '</div>'
        + '<div class="wfp-help">' + esc(ID_HELP) + '</div></div>'
        + (remember === false ? '' : (
            '<label class="wfp-check" id="' + p + '_remember_row"' + (person ? ' style="display:none"' : '') + '><input type="checkbox" id="' + p + '_remember" checked> Save to my people list'
            + '<span class="wfp-help">Next time, pick them from the saved list instead of typing it all again.</span></label>'
            + '<div class="wfp-linked" id="' + p + '_linked"' + (person ? '' : ' style="display:none"') + '>' + linkedText(person) + '</div>'))
        + '</div>';
}

const linkedText = (person) => person
    ? 'Saved person: <b>' + esc(person.name) + '</b>. If you change their name, number or ID here you will be asked whether to update their saved details too.'
    : '';

/** The "Saved people" picker for the top of a form; empty markup while the book is empty (there is nothing to pick). */
export function pickerHtml(prefix, { people = [], record = null, nameId = '' } = {}) {
    const list = People.searchPeople(people, '');
    if (!list.length) return '';
    const r = record && typeof record === 'object' ? record : {};
    const chosen = People.personById(list, r.personId);
    const p = esc(prefix);
    return '<div class="fg wfp-pick"><label class="fl" for="' + p + '_pick">Saved people</label>'
        + '<div class="wfp-row"><select class="fs" id="' + p + '_pick" data-wfp="pick" data-p="' + p + '" data-name="' + esc(nameId) + '">'
        + '<option value="">New person (type the details below)</option>'
        + list.map((x) => '<option value="' + esc(x.id) + '"' + (chosen && chosen.id === x.id ? ' selected' : '') + '>' + esc(x.name + (x.phone ? ' · ' + showPhone(x.phone) : '')) + '</option>').join('')
        + '</select><button type="button" class="btn btn-ghost btn-sm wfp-btn" data-wfp="manage">Manage</button></div></div>';
}

/** What a form says about the person, or null when the form has no contact fields. */
export function readContact(root, prefix) {
    if (!root || typeof root.querySelector !== 'function') return null;
    const q = (suffix) => root.querySelector('#' + prefix + '_' + suffix);
    const phone = q('phone');
    if (!phone) return null;
    const cc = q('cc'); const idk = q('idk'); const nic = q('nic'); const pid = q('pid'); const rem = q('remember'); const phone2 = q('phone2'); const full = q('full');
    return {
        personId: pid ? s(pid.value) : '',
        fullName: full ? s(full.value).replace(/\s+/g, ' ').trim() : '',
        hasFullName: !!full,
        country: cc ? s(cc.value) : DEFAULT_REGION,
        phone: s(phone.value).trim(),
        phone2: phone2 ? s(phone2.value).trim() : '',
        hasPhone2: !!phone2,
        idKind: idk && idk.value === 'other' ? 'other' : 'nic',
        nic: nic ? s(nic.value).trim() : '',
        remember: rem ? !!rem.checked : false,
    };
}

/**
 * Check what was read and decide what the record stores.
 *   -> { ok, errors:{phone?, phone2?, nic?}, phone, phone2, nic, country, idKind, personId, remember }
 * The ID must be right whenever one is given (a typo here is a statement that never opens). The number must be a mobile number that can be
 * texted only when texts are on; with them off it is kept as typed, because it may be a landline the owner rings.
 */
export function collectContact(c, { smsOn = false } = {}) {
    const x = c || { personId: '', country: DEFAULT_REGION, phone: '', idKind: 'nic', nic: '', remember: false };
    const errors = {};
    const phone = People.resolvePhone(x.phone, x.country);
    if (!phone.empty && !phone.ok && smsOn) errors.phone = phone.text;
    if (phone.empty && smsOn) errors.phone = People.phoneProblem('empty');
    // The second number is optional. Given, it must be a mobile number that can be texted when texts are on (with them off it is kept as typed, like the
    // first), and it must not be the first number again: that would send every text twice to one phone.
    const phone2 = People.resolvePhone(x.phone2, x.country);
    if (!phone2.empty) {
        if (phone2.ok && phone.ok && phone2.e164 === phone.e164) errors.phone2 = 'The second number is the same as the first. Leave it empty or enter a different number.';
        else if (!phone2.ok && smsOn) errors.phone2 = 'Second number: ' + phone2.text;
    }
    const id = People.storedId(x.nic, x.idKind);
    if (!id.ok) errors.nic = id.text;
    return {
        ok: Object.keys(errors).length === 0, errors,
        phone2: phone2.ok ? phone2.e164 : s(x.phone2).trim(),
        phone: phone.ok ? phone.e164 : s(x.phone).trim(),
        nic: id.ok ? id.stored : '',
        fullName: s(x.fullName).replace(/\s+/g, ' ').trim().slice(0, People.LIMITS.fullName),
        country: phone.ok ? phone.iso : x.country,
        idKind: x.idKind, personId: x.personId, remember: !!x.remember,
    };
}

/* ── bringing a contact in: the sheet, and what it says on each kind of device ── */

/**
 * What is true on each device, said once: which of the ways in work there and how to get a contact to them. No web page can read an address
 * book except through Chrome on Android, so on every other device the way in is a file the device can export, or text the person copies.
 */
export function contactTips(platform, picker = false) {
    const share = {
        android: 'On Android, Chrome opens your contacts directly. In another browser, open the Contacts app, touch the person, choose Share or Copy, then paste it into the box below.',
        ios: 'iPhone and iPad: Safari cannot open your Contacts. Open the Contacts app, touch the person, touch and hold their number and choose Copy, then paste it into the box below. To bring a whole contact: Contacts, touch the person, Share Contact, Save to Files, then choose that file here.',
        mac: 'Mac: browsers cannot open your Contacts. In the Contacts app select the person (or several), choose File, Export, Export vCard, then choose or drop that file here. Or select a person, press Command-C, and paste into the box below.',
        windows: 'Windows: browsers cannot open your contacts. In Outlook or the People app export your contacts (vCard or CSV) and choose that file here, or copy a number and paste it into the box below.',
        linux: 'Browsers cannot open the contacts on this device. Export them as vCard or CSV and choose that file here, or copy a number and paste it into the box below.',
        other: 'Browsers cannot open the contacts on this device. Export them as vCard or CSV and choose that file here, or copy a number and paste it into the box below.',
    };
    const lines = [share[platform] || share.other];
    lines.push('Google or iCloud contacts: on contacts.google.com or icloud.com choose Export (vCard or CSV), then choose that file here.');
    if (!picker && platform === 'android') lines.unshift('This browser has no contact picker, so use one of these instead.');
    return lines;
}

/** The sheet that brings a contact in: the phone's picker where there is one, a file, a dropped file, or pasted text. Every dynamic value is escaped. */
export function contactSourceHtml({ platform = 'other', picker = false, clipboard = false, multiple = false, status = '' } = {}) {
    const tips = contactTips(platform, picker);
    return '<div class="md wfp-src"><div class="md-hdr"><div class="md-title">' + (multiple ? 'Import contacts' : 'Bring in a contact') + '</div>' + xButtonHtml + '</div>'
        + (picker ? '<button type="button" class="btn btn-primary wfp-wide" data-c="device">Choose from this device’s contacts</button><div class="wfp-or">or</div>' : '')
        + '<button type="button" class="btn ' + (picker ? 'btn-secondary' : 'btn-primary') + ' wfp-wide" data-c="file">Choose a contacts file</button>'
        + '<div class="wfp-help wfp-center">vCard (.vcf) or spreadsheet (.csv) exported from your phone, Google, iCloud or Outlook. You can also drop the file here.</div>'
        + '<input type="file" data-c="fileinput" accept=".vcf,.vcard,.csv,.txt,text/vcard,text/x-vcard,text/directory,text/csv,text/plain" ' + (multiple ? 'multiple ' : '') + 'hidden aria-label="Contacts file">'
        + '<div class="wfp-or">or</div>'
        + '<label class="fl" for="wfp_paste">Paste a number or a contact</label>'
        + '<textarea class="fi wfp-paste" id="wfp_paste" data-c="paste" rows="3" maxlength="200000" autocomplete="off" spellcheck="false" placeholder="+94 77 123 4567, or Nimal Perera 077 123 4567, or a whole contact card"></textarea>'
        + '<div class="wfp-actions" style="margin-top:6px;">'
        + (clipboard ? '<button type="button" class="btn btn-secondary btn-sm" data-c="clip">Paste from clipboard</button>' : '')
        + '<button type="button" class="btn btn-primary btn-sm" data-c="use" disabled>Use this</button></div>'
        + '<div class="wfp-pv" data-c="status" role="status" aria-live="polite">' + esc(status) + '</div>'
        + '<details class="wfp-det wfp-tips"' + (picker ? '' : ' open') + '><summary>How do I get my contact in here?</summary>'
        + tips.map((t) => '<p class="wfp-help" style="margin:0 0 8px;">' + esc(t) + '</p>').join('') + '</details>'
        + '</div>';
}
const xButtonHtml = '<button class="md-x" aria-label="Close" data-c="close"><i data-wfi="x"></i></button>';

/* ── 2. the book's screens, as strings ───────────────────────────────────── */

export function personRowHtml(person, use) {
    const phone = person.phone ? showPhone(person.phone) : '';
    const bits = [];
    if (phone) bits.push(phone);
    if (person.phone2) bits.push(showPhone(person.phone2));
    const id = s(person.nic).trim();
    const used = [];
    if (use.loans) used.push(plural(use.loans, 'loan', 'loans'));
    if (use.investments) used.push(plural(use.investments, 'investment', 'investments'));
    if (use.smsOn) used.push('texts on');
    return '<div class="wfp-card" data-h="edit" data-id="' + esc(person.id) + '" role="button" tabindex="0">'
        + '<div class="wfp-av" aria-hidden="true">' + esc(s(person.name).trim().charAt(0).toUpperCase() || '?') + '</div>'
        + '<div class="wfp-main"><div class="wfp-name">' + esc(person.name) + '</div>'
        + (bits.length ? '<div class="wfp-sub">' + esc(bits.join(' · ')) + '</div>' : '<div class="wfp-sub wfp-dim">No number saved</div>')
        + (id ? '<div class="wfp-sub">' + esc((People.idKindOf(id) === 'other' ? 'ID ' : 'NIC ') + displayIdentity(id)) + '</div>' : '')
        + (used.length ? '<div class="wfp-sub wfp-dim">' + esc(used.join(' · ')) + '</div>' : '')
        + '</div></div>';
}

/** The list under the search box. */
export function peopleListHtml({ people = [], books = {}, q = '' } = {}) {
    const list = People.searchPeople(people, q);
    if (!people.length) return '<div class="wfp-empty">Nobody is saved yet. Add a person here, or tick “Save to my people list” on a loan or an investment and they appear automatically.</div>';
    if (!list.length) return '<div class="wfp-empty">Nobody matches “' + esc(q) + '”.</div>';
    return list.slice(0, 200).map((p) => personRowHtml(p, People.usageOf(p, books))).join('')
        + (list.length > 200 ? '<div class="wfp-empty">Showing 200 of ' + list.length + '. Type to narrow the list.</div>' : '');
}

export function peopleTabHtml({ people = [], books = {}, q = '', unfiled = 0, picker = false } = {}) {
    return '<div class="wfp-bar"><input class="fi" type="search" id="wfp_q" data-h="search" placeholder="Search name, number, NIC" autocomplete="off" value="' + esc(q) + '" aria-label="Search saved people">'
        + '<button type="button" class="btn btn-primary btn-sm wfp-btn" data-h="add">Add person</button></div>'
        + '<div class="wfp-tools"><button type="button" class="btn btn-secondary btn-sm" data-h="import">' + (picker ? 'Import from contacts' : 'Import contacts file') + '</button></div>'
        + (unfiled > 0
            ? '<div class="wfp-note"><div><b>' + plural(unfiled, 'loan or investment names', 'loans and investments name') + ' somebody who is not in this list yet.</b> Add them in one tap; nothing else on those records changes.</div>'
              + '<button type="button" class="btn btn-secondary btn-sm" data-h="harvest">Add them to the list</button></div>'
            : '')
        + '<div id="wfp_list">' + peopleListHtml({ people, books, q }) + '</div>';
}

const fieldError = (errors, key) => (errors && errors[key] ? '<div class="wfp-pv bad" role="alert">' + esc(errors[key]) + '</div>' : '');

/** The add / edit form for one person. `draft` is what the form held when it last failed, `confirm` is the "this also updates" step. */
export function personFormHtml({ person = null, draft = null, errors = {}, people = [], use = null, confirm = null, askDelete = false } = {}) {
    const d = draft || (person ? { name: person.name, fullName: person.fullName, phone: person.phone, nic: person.nic, country: person.country, phone2: person.phone2, email: person.email, address: person.address, note: person.note } : {});
    const nameIn = '<div class="fg"><label class="fl" for="_pp_name">Name</label><input class="fi" id="_pp_name" maxlength="' + People.LIMITS.name + '" autocomplete="off" value="' + esc(d.name) + '">' + fieldError(errors, 'name') + '</div>';
    const contact = contactHtml('_pp', { kind: 'person', record: { fullName: d.fullName, phone: d.phone, phone2: d.phone2, nic: d.nic }, people, nameId: '_pp_name', defaultCountry: d.country || DEFAULT_REGION, remember: false, errors });
    const more = '<div class="fg"><label class="fl" for="_pp_email">Email</label><input class="fi" id="_pp_email" type="email" maxlength="' + People.LIMITS.email + '" autocomplete="off" value="' + esc(d.email) + '">' + fieldError(errors, 'email') + '</div>'
        + '<div class="fg"><label class="fl" for="_pp_address">Address</label><input class="fi" id="_pp_address" maxlength="' + People.LIMITS.address + '" autocomplete="off" value="' + esc(d.address) + '"></div>'
        + '<div class="fg"><label class="fl" for="_pp_note">Note</label><input class="fi" id="_pp_note" maxlength="' + People.LIMITS.note + '" autocomplete="off" placeholder="Anything worth remembering" value="' + esc(d.note) + '"></div>';
    let banner = '';
    if (confirm) {
        banner = '<div class="wfp-note wfp-warn"><div><b>This also updates ' + esc([confirm.loans ? plural(confirm.loans, 'loan', 'loans') : '', confirm.investments ? plural(confirm.investments, 'investment', 'investments') : ''].filter(Boolean).join(' and ')) + '.</b> '
            + 'They will use the new name, full name, number or ID' + (confirm.smsOn ? ', and the texts on ' + plural(confirm.smsOn, 'of them', 'of them') + ' will go to the new number' : '') + '.</div>'
            + '<div class="wfp-actions"><button type="button" class="btn btn-primary btn-sm" data-h="savego">Save and update them</button><button type="button" class="btn btn-ghost btn-sm" data-h="savenot">Back</button></div></div>';
    }
    if (askDelete && person) {
        const bits = [use && use.loans ? plural(use.loans, 'loan', 'loans') : '', use && use.investments ? plural(use.investments, 'investment', 'investments') : ''].filter(Boolean);
        banner = '<div class="wfp-note wfp-warn"><div><b>Delete ' + esc(person.name) + ' from your saved list?</b> '
            + (bits.length ? esc(bits.join(' and ')) + ' stay exactly as they are; only the saved entry is removed.' : 'Nothing else is changed.') + '</div>'
            + '<div class="wfp-actions"><button type="button" class="btn btn-danger btn-sm" data-h="delgo" data-id="' + esc(person.id) + '">Delete</button><button type="button" class="btn btn-ghost btn-sm" data-h="savenot">Keep</button></div></div>';
    }
    return '<div class="wfp-formhead"><button type="button" class="btn btn-ghost btn-sm" data-h="back">‹ Back</button><div class="wfp-title">' + (person ? 'Edit ' + esc(person.name) : 'Add a person') + '</div></div>'
        + banner + nameIn + contact + more
        + '<div class="md-ftr wfp-ftr"><button type="button" class="btn btn-primary" data-h="save">' + (person ? 'Save changes' : 'Add to list') + '</button>'
        + (person ? '<button type="button" class="btn btn-ghost wfp-red" data-h="del" data-id="' + esc(person.id) + '">Delete</button>' : '') + '</div>';
}

/** The result list of a contacts import. `rows` are { name, numbers[], others[], on, pick } (see the glue). */
export function importHtml({ rows = [], q = '', shown = 0, total = 0, busy = false, source = '' } = {}) {
    const on = rows.filter((r) => r.on).length;
    const list = rows.map((r) => {
        const usable = r.numbers.length > 0;
        const number = usable
            ? (r.numbers.length > 1
                ? '<select class="fs wfp-num" data-h="impnum" data-i="' + r.i + '" aria-label="Number for ' + esc(r.name) + '">' + r.numbers.map((n, k) => '<option value="' + k + '"' + (k === r.pick ? ' selected' : '') + '>' + esc(n.pretty) + '</option>').join('') + '</select>'
                : '<span class="wfp-sub">' + esc(r.numbers[0].pretty) + '</span>')
            : '<span class="wfp-sub wfp-dim">' + (r.others.length ? esc('Not a number that can be texted: ' + r.others[0].raw) : 'No number') + '</span>';
        return '<label class="wfp-imp' + (usable ? '' : ' wfp-off') + '"><input type="checkbox" data-h="imptick" data-i="' + r.i + '"' + (r.on ? ' checked' : '') + (usable ? '' : ' disabled') + '>'
            + '<span class="wfp-main"><span class="wfp-name">' + esc(r.name || '(no name)') + '</span>' + number + '</span></label>';
    }).join('');
    return '<div class="wfp-formhead"><button type="button" class="btn btn-ghost btn-sm" data-h="back">‹ Back</button><div class="wfp-title">Import from ' + esc(source || 'contacts') + '</div></div>'
        + (busy ? '<div class="wfp-empty">Reading…</div>' : (
            '<div class="wfp-bar"><input class="fi" type="search" id="wfp_iq" data-h="impsearch" placeholder="Search these contacts" autocomplete="off" value="' + esc(q) + '" aria-label="Search the contacts"></div>'
            + '<div class="wfp-tools"><button type="button" class="btn btn-ghost btn-sm" data-h="impall">Tick everyone shown</button><button type="button" class="btn btn-ghost btn-sm" data-h="impnone">Clear</button></div>'
            + '<div class="wfp-implist">' + (list || '<div class="wfp-empty">No contacts match.</div>') + '</div>'
            + (total > shown ? '<div class="wfp-help">Showing ' + shown + ' of ' + total + '. Type to narrow the list.</div>' : '')
            + '<div class="md-ftr wfp-ftr"><button type="button" class="btn btn-primary" data-h="impgo"' + (on ? '' : ' disabled') + '>' + (on ? 'Add ' + plural(on, 'person', 'people') : 'Tick the people to add') + '</button></div>'));
}

const PAY_HELP = 'These are the accounts your debtors and investors see on their private statement page, and in the PDF they can download. They appear only after the person has entered their NIC or ID and the one-time code.';

/** A bank account as the person on the other side will see it. */
export function accountCardHtml(a) {
    const lines = [['Bank', a.bank], ['Account name', a.holder], ['Account number', a.number], ['Branch', a.branch], ['SWIFT / IBAN', a.swift]].filter(([, v]) => s(v).trim());
    return '<div class="wfp-acct">' + lines.map(([k, v]) => '<div class="wfp-kv"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>').join('')
        + (a.note ? '<div class="wfp-sub">' + esc(a.note) + '</div>' : '') + '</div>';
}

export function accountsTabHtml({ accounts = [] } = {}) {
    const rows = accounts.map((a) => '<div class="wfp-card' + (a.active === false ? ' wfp-off' : '') + '">'
        + '<div class="wfp-main" data-h="acc-edit" data-id="' + esc(a.id) + '" role="button" tabindex="0">'
        + '<div class="wfp-name">' + esc(a.bank) + (a.active === false ? ' <span class="wfp-chip">Switched off</span>' : '') + '</div>'
        + '<div class="wfp-sub">' + esc(a.holder + ' · ' + a.number) + '</div>'
        + '<div class="wfp-sub wfp-dim">' + esc(Pay.SHOW_TEXT[a.showTo] || Pay.SHOW_TEXT.both) + '</div></div>'
        + '<div class="wfp-side"><label class="wfp-switch"><input type="checkbox" data-h="acc-toggle" data-id="' + esc(a.id) + '"' + (a.active === false ? '' : ' checked') + '> On</label></div></div>').join('');
    return '<div class="wfp-help" style="margin:0 0 10px;">' + esc(PAY_HELP) + '</div>'
        + '<div class="wfp-tools"><button type="button" class="btn btn-primary btn-sm" data-h="acc-add"' + (accounts.length >= Pay.LIMITS.accounts ? ' disabled' : '') + '>Add a bank account</button></div>'
        + (rows || '<div class="wfp-empty">No account yet. Add the account you want repayments and new capital sent to; it appears on every statement page for the people you choose.</div>');
}

export function accountFormHtml({ account = null, draft = null, errors = {}, askDelete = false } = {}) {
    const d = draft || account || { showTo: 'both', active: true };
    const f = (id, label, value, extra = '', max = 60) => '<div class="fg"><label class="fl" for="_pa_' + id + '">' + label + '</label><input class="fi" id="_pa_' + id + '" maxlength="' + max + '" autocomplete="off"' + extra + ' value="' + esc(value) + '">' + fieldError(errors, id) + '</div>';
    const del = askDelete && account
        ? '<div class="wfp-note wfp-warn"><div><b>Delete this account?</b> It disappears from every statement page and PDF straight away.</div><div class="wfp-actions"><button type="button" class="btn btn-danger btn-sm" data-h="acc-delgo" data-id="' + esc(account.id) + '">Delete</button><button type="button" class="btn btn-ghost btn-sm" data-h="acc-cancel">Keep</button></div></div>'
        : '';
    return '<div class="wfp-formhead"><button type="button" class="btn btn-ghost btn-sm" data-h="acc-cancel">‹ Back</button><div class="wfp-title">' + (account ? 'Edit bank account' : 'Add a bank account') + '</div></div>'
        + del
        + '<div class="wfp-help wfp-pdfhelp">Shown to your debtors and investors on their statement page and in the PDF they download. The PDF shows English and Sinhala; any other script prints as ?, so write the details in English or Sinhala.</div>'
        + f('bank', 'Bank', d.bank, ' placeholder="Commercial Bank of Ceylon"', Pay.LIMITS.bank)
        + f('holder', 'Name on the account', d.holder, ' placeholder="Your name or your company’s"', Pay.LIMITS.holder)
        + f('number', 'Account number', d.number, ' inputmode="text" placeholder="8001234567"', Pay.LIMITS.number)
        + f('branch', 'Branch (optional)', d.branch, ' placeholder="Colombo 03"', Pay.LIMITS.branch)
        + f('swift', 'SWIFT code or IBAN (optional, for payments from abroad)', d.swift, ' autocapitalize="characters" placeholder="CCEYLKLX"', Pay.LIMITS.swift)
        + f('note', 'Note (optional)', d.note, ' placeholder="Please write your NIC in the payment reference"', Pay.LIMITS.note)
        + f('noteSi', 'Note in Sinhala (optional)', d.noteSi, ' placeholder="කරුණාකර ගෙවීමේදී ඔබේ NIC අංකය යොමුවේ ලියන්න"', Pay.LIMITS.noteSi)
        + '<div class="wfp-help">Customers who switch their statement page or PDF to Sinhala see this note. If you leave it empty, the common notes (such as writing the NIC in the payment reference) are translated for you; any other note is shown as you typed it.</div>'
        + '<div class="fg"><label class="fl" for="_pa_show">Who sees it</label><select class="fs" id="_pa_show">'
        + Object.entries(Pay.SHOW_TEXT).map(([k, v]) => '<option value="' + k + '"' + (d.showTo === k ? ' selected' : '') + '>' + esc(v) + '</option>').join('') + '</select></div>'
        + '<label class="wfp-check"><input type="checkbox" id="_pa_active"' + (d.active === false ? '' : ' checked') + '> Show this account on statements</label>'
        + '<div class="md-ftr wfp-ftr"><button type="button" class="btn btn-primary" data-h="acc-save">' + (account ? 'Save changes' : 'Add account') + '</button>'
        + (account ? '<button type="button" class="btn btn-ghost wfp-red" data-h="acc-del" data-id="' + esc(account.id) + '">Delete</button>' : '') + '</div>';
}

const STYLE = `
.wfp-row{display:flex;gap:8px;align-items:stretch}.wfp-row>.fi,.wfp-row>.fs{flex:1;min-width:0}.wfp-row>.wfp-idk{flex:0 0 134px}.wfp-btn{flex:none;white-space:nowrap;min-height:40px}
.wfp-pv{font-size:12px;min-height:16px;margin-top:4px;line-height:1.45}.wfp-pv.ok{color:var(--green,#30a46c)}.wfp-pv.warn{color:var(--amber,#b7791f)}.wfp-pv.bad{color:var(--red,#e5484d)}
.wfp-help{display:block;font-size:11px;color:var(--text3);margin-top:3px;line-height:1.5}
.wfp-opt{font-weight:400;color:var(--text3);font-size:11px}
.wfp-check{display:block;cursor:pointer;font-weight:600;margin:6px 0 10px}.wfp-check input{width:18px;height:18px;vertical-align:-3px;margin-right:8px}
.wfp-linked{font-size:12px;line-height:1.5;margin:6px 0 10px;padding:8px 10px;border-radius:10px;background:rgba(48,164,108,.10)}
.wfp-tabs{display:flex;gap:6px;margin:0 0 12px}.wfp-tab{flex:1;min-height:40px;padding:8px 10px;border-radius:10px;border:1px solid var(--border,rgba(128,128,128,.3));background:transparent;color:var(--text);font-weight:600;cursor:pointer;font-size:13px}
.wfp-tab[aria-selected=true]{background:var(--accent,#4f8cff);color:#fff;border-color:transparent}
.wfp-body{max-height:68vh;overflow:auto;-webkit-overflow-scrolling:touch}
.wfp-bar{display:flex;gap:8px;margin:0 0 8px}.wfp-bar .fi{flex:1;min-width:0}.wfp-tools{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 10px}
.wfp-card{display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--border,rgba(128,128,128,.2));cursor:pointer}.wfp-card.wfp-off{opacity:.6}
.wfp-av{width:38px;height:38px;border-radius:50%;background:var(--accent,#4f8cff);color:#fff;display:flex;align-items:center;justify-content:center;font-weight:700;flex:none}
.wfp-main{flex:1;min-width:0;display:block}.wfp-name{font-weight:700;font-size:14px;word-break:break-word}.wfp-sub{display:block;font-size:12px;color:var(--text2,inherit);margin-top:2px;word-break:break-word}.wfp-dim{color:var(--text3)}
.wfp-side{flex:none;font-size:12px}.wfp-switch{cursor:pointer;display:flex;gap:6px;align-items:center}.wfp-switch input{width:18px;height:18px}
.wfp-chip{font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:99px;background:rgba(128,128,128,.2);vertical-align:1px}
.wfp-empty{padding:18px 4px;text-align:center;color:var(--text3);font-size:13px;line-height:1.6}
.wfp-note{display:flex;gap:10px;justify-content:space-between;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:10px;background:rgba(79,140,255,.10);font-size:12.5px;line-height:1.55;margin:0 0 10px}.wfp-note.wfp-warn{background:rgba(245,166,35,.14)}
.wfp-actions{display:flex;gap:8px;flex-wrap:wrap}.wfp-formhead{display:flex;align-items:center;gap:8px;margin:0 0 10px}.wfp-title{font-weight:800;font-size:15px}
.wfp-ftr{display:flex;gap:8px;margin-top:6px}.wfp-ftr .btn-primary{flex:1}.wfp-red{color:var(--red,#e5484d)}
.wfp-imp{display:flex;gap:10px;align-items:center;padding:9px 0;border-top:1px solid var(--border,rgba(128,128,128,.2));cursor:pointer}.wfp-imp input[type=checkbox]{width:20px;height:20px;flex:none}.wfp-imp.wfp-off{opacity:.55;cursor:default}
.wfp-num{margin-top:4px;min-height:36px}.wfp-implist{margin:0 0 10px}
.wfp-acct{border:1px solid var(--border,rgba(128,128,128,.25));border-radius:12px;padding:10px 12px;margin:8px 0}.wfp-kv{display:flex;justify-content:space-between;gap:12px;font-size:13px;padding:3px 0}.wfp-kv span{color:var(--text3)}.wfp-kv b{text-align:right;word-break:break-word}
.wfp-chooser .md{max-width:460px}.wfp-wide{width:100%;min-height:46px;margin:0 0 6px}.wfp-or{text-align:center;color:var(--text3);font-size:12px;margin:8px 0}.wfp-center{text-align:center;margin:0 0 4px}.wfp-paste{width:100%;min-height:64px;resize:vertical;font-family:inherit}.wfp-src.wfp-drop{outline:2px dashed var(--accent,#4f8cff);outline-offset:-6px}.wfp-tips{margin-top:12px}.wfp-pick{margin-bottom:10px}.wfp-home{margin:16px 0 4px;padding-top:12px;border-top:1px solid var(--border,rgba(128,128,128,.2))}
.wfp-det{border:1px solid var(--border,rgba(128,128,128,.25));border-radius:12px;padding:0 12px;margin:0 0 10px}.wfp-det>summary{cursor:pointer;font-weight:700;padding:12px 0;min-height:24px}.wfp-det[open]>summary{border-bottom:1px solid var(--border,rgba(128,128,128,.2));margin-bottom:10px}.wfp-det>summary span{font-weight:500;color:var(--text3)}
`;

/* ── 3. the page's side ──────────────────────────────────────────────────── */

const storeOf = (win) => ({
    get: (k) => { try { const v = win.DB.get(k, []); return Array.isArray(v) ? v : []; } catch (_) { return []; } },
    set: (k, v) => win.DB.set(k, v),
});

/** Wire the screens to the running app. Safe to call more than once; never throws. */
export function boot(win) {
    const doc = win.document;
    const store = () => storeOf(win);
    const toast = (text, tone = 'success') => { try { if (typeof win.notify === 'function') win.notify(text, tone); } catch (_) { /* a toast is a courtesy */ } };
    /* The country a number belongs to: Sri Lanka, the only one the gateway reaches. */
    const homeCountry = () => DEFAULT_REGION;
    const smsPanel = () => (win.WFSms && typeof win.WFSms.panelInto === 'function' ? win.WFSms : null);

    /* ── everybody the ledgers already name goes into the saved list by itself ──
     * An investor typed on the Investments tab, or a loan made before the book existed, is a person the owner will want to pick again. Once the
     * books are on screen (and again whenever the owner comes back to the app, or opens a form or the book) anybody named on a loan or an
     * investment who is not in the list is filed and the record linked to them. Records only gain their link and what they lacked of the
     * person; ids are derived from who the person is, so two devices doing this before they sync arrive at the same people. */
    const filed = { told: false };
    function autoFile() {
        try {
            if (win._isDecoyMode === true) return;                                  // the decoy books are not the owner's: never written
            if (!win.currentUser || !win.currentUser.uid || !win.appData) return;
            const sx = store();
            if (!People.unfiledRecords(sx, { orphans: false }).length) return;
            const r = People.harvestPeople(sx, { orphans: false });             // a person the owner deleted is not filed again behind their back
            if (r.linked && !filed.told) { filed.told = true; toast(r.added ? 'Saved ' + plural(r.added, 'person', 'people') + ' from your loans and investments to your people list' : 'Linked ' + plural(r.linked, 'loan or investment', 'loans and investments') + ' to people in your list', 'success'); }
        } catch (e) { console.warn('[WF-PEOPLE] filing the people already in the books failed (nothing was lost):', e && e.message); }
    }

    /** The record as the ledger holds it NOW: filing people just above may have linked it, and the form must open on the link. */
    function freshRecord(rec) {
        if (!rec || !rec.id) return rec;
        try { const sx = store(); return [...sx.get('income'), ...sx.get('debtors')].find((r) => r && r.id === rec.id) || rec; } catch (_) { return rec; }
    }

    function ensureStyle() {
        if (doc.getElementById('wfp-style')) return;
        const el = doc.createElement('style');
        el.id = 'wfp-style';
        el.textContent = STYLE;
        (doc.head || doc.documentElement).appendChild(el);
    }

    /* ── contact fields: what happens as the owner types ── */

    /* Every lookup is inside the form the event came from. Two forms can share ids for a moment (one is still fading out when the next opens),
     * and a number filled into the form that is leaving is a number lost. */
    const rootOf = (el) => (el && el.closest ? (el.closest('.md') || el.closest('.mo')) : null) || doc;
    const at = (root, id) => { try { return id ? root.querySelector('#' + id) : null; } catch (_) { return null; } };

    const setNote = (el, note) => { if (!el) return; el.className = 'wfp-pv ' + (note.cls || ''); el.textContent = note.text; };

    function refreshPhone(root, p, commit) {
        const box = at(root, p + '_phone'); const cc = at(root, p + '_cc');
        if (!box || !cc) return;
        const r = People.resolvePhone(box.value, cc.value);
        // an international number says which country it is; the box on top follows it, so what is shown is always what will be used
        if (r.ok && r.iso && r.iso !== cc.value && /^\s*(\+|00)/.test(box.value)) cc.value = r.iso;
        setNote(at(root, p + '_pv'), phoneNote(box.value, cc.value, commit));
        refreshPhone2(root, p, commit);                                          // the second number is judged against this one
    }

    function refreshPhone2(root, p, commit) {
        const box = at(root, p + '_phone2'); const first = at(root, p + '_phone'); const cc = at(root, p + '_cc');
        if (!box || !cc) return;
        setNote(at(root, p + '_pv2'), phone2Note(box.value, first ? first.value : '', cc.value, commit));
    }

    function refreshId(root, p, commit, kindChanged) {
        const idk = at(root, p + '_idk'); const box = at(root, p + '_nic');
        if (!idk || !box) return;
        // an NIC never starts with a letter: somebody typing a passport number into the NIC box means the other kind
        if (idk.value === 'nic' && /^[A-Za-z]/.test(box.value.trim())) { idk.value = 'other'; kindChanged = true; }
        if (kindChanged) {
            const label = at(root, p + '_nic_l'); if (label) label.textContent = ID_LABEL[idk.value];
            box.placeholder = ID_HINT[idk.value];
        }
        setNote(at(root, p + '_idv'), idNote(box.value, idk.value, commit));
    }

    function toggleLink(root, p, person) {
        const row = at(root, p + '_remember_row'); const note = at(root, p + '_linked');
        if (row) row.style.display = person ? 'none' : '';
        if (note) { note.style.display = person ? '' : 'none'; note.innerHTML = linkedText(person); }
    }

    function fillFromPerson(root, p, nameId, person) {
        const name = at(root, nameId);
        const set = (id, v) => { const el = at(root, id); if (el) el.value = v; };
        if (name) name.value = person ? person.name : '';
        const iso = regionByIso(person && person.country) ? person.country : homeCountry();
        set(p + '_cc', iso);
        set(p + '_full', person ? s(person.fullName) : '');
        set(p + '_phone', person && person.phone ? showPhone(person.phone) : '');
        set(p + '_phone2', person && person.phone2 ? showPhone(person.phone2) : '');
        const kind = person && person.nic ? People.idKindOf(person.nic) : (iso === DEFAULT_REGION ? 'nic' : 'other');
        set(p + '_idk', kind);
        set(p + '_nic', person ? displayIdentity(person.nic) : '');
        refreshPhone(root, p, true);
        refreshId(root, p, true, true);
    }

    /** A person who already gets texts on another loan or investment gets them on this one too: the box is ticked for the owner (it can be unticked). */
    function tickTextsFor(root, person, before) {
        if (!person || (before && before === person.id)) return;
        let on = false;
        try { on = People.usageOf(person, People.booksOf(store())).smsOn > 0; } catch (_) { on = false; }
        const box = root && root.querySelector ? root.querySelector('[data-wf-sms] input[type="checkbox"][id$="_on"]') : null;
        if (!on || !box || box.checked) return;
        box.checked = true;
        const wrap = box.closest ? box.closest('[data-wf-sms]') : null;
        if (wrap && !wrap.querySelector('.wfp-texts-note')) {
            const note = doc.createElement('div');
            note.className = 'wfp-texts-note';
            note.style.cssText = 'font-size:11.5px;color:var(--text3);margin-top:6px;';
            note.textContent = person.name + ' already gets texts and has a statement page, so this one is switched on too. Untick it if you do not want that.';
            wrap.appendChild(note);
        }
    }

    function pickPerson(root, p, id, nameId) {
        const hidden = at(root, p + '_pid');
        const before = hidden ? hidden.value : '';
        const person = People.personById(People.listPeople(store()), id);
        if (hidden) hidden.value = person ? person.id : '';
        if (person) fillFromPerson(root, p, nameId, person);
        else if (before) fillFromPerson(root, p, nameId, null);                  // "New person" after a pick: the picked person's details do not stay behind
        toggleLink(root, p, person);
        tickTextsFor(root, person, before);
        const section = person && hidden && hidden.closest ? hidden.closest('details') : null;
        if (section) section.open = true;                                        // the investment form folds the contact fields away; a pick shows what it filled
    }

    /* ── device contacts ── */

    /** `field` is which box the number goes in: the first number also sets the country and fills an empty name; the second only fills its own box. */
    function applyNumber(root, p, nameId, name, number, field = 'phone') {
        const box = at(root, p + '_' + field); const cc = at(root, p + '_cc');
        if (box) box.value = number.pretty;                                        // always written with its + and country code, so it reads the same whatever the country box says
        if (field === 'phone') {
            if (cc && number.iso) cc.value = number.iso;
            const nm = at(root, nameId);
            if (nm && !s(nm.value).trim() && name) nm.value = name;
            refreshPhone(root, p, true);
        } else refreshPhone2(root, p, true);
        toast((field === 'phone2' ? 'Second number taken from your contacts' : 'Number taken from your contacts') + (name ? ': ' + name : ''), 'success');
    }

    function useContact(root, p, nameId, contact, field = 'phone') {
        const iso = (at(root, p + '_cc') || {}).value || homeCountry();
        const draft = People.draftFromContact(contact, iso);
        if (draft.numbers.length === 1) return applyNumber(root, p, nameId, draft.name, draft.numbers[0], field);
        if (draft.numbers.length === 0) return toast(draft.others.length ? 'None of that contact’s numbers can receive texts (' + draft.others.map((o) => o.raw).join(', ') + ')' : 'That contact has no phone number', 'error');
        return openNumberChooser(draft, (n) => applyNumber(root, p, nameId, draft.name, n, field));
    }

    /**
     * The sheet every "Contacts" button opens. It reports the contacts it found through onCards(cards, source) and closes; it never decides what
     * to do with them (a form takes one number, the book imports many).
     */
    function openContactSource({ multiple = false, onCards }) {
        const platform = People.platformOf(win);
        const picker = People.contactPickerSupported(win);
        const clipboard = !!(win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.readText === 'function');
        const o = overlay(contactSourceHtml({ platform, picker, clipboard, multiple }), 'wfp-chooser');
        const q = (c) => o.el.querySelector('[data-c="' + c + '"]');
        const status = q('status'); const paste = q('paste'); const use = q('use'); const fileInput = q('fileinput');
        const say = (text, cls = '') => { if (status) { status.className = 'wfp-pv ' + cls; status.textContent = text; } };
        let found = null;
        const arrive = (cards, source) => {
            if (!cards.length) return false;
            o.close();
            try { onCards(cards.slice(0, People.LIMITS.vcfCards), source); } catch (e) { console.warn('[WF-PEOPLE] contacts:', e && e.message); }
            return true;
        };
        const read = (text, name, source) => {
            const r = People.parseContacts(text, name);
            if (!r.cards.length) { say(source === 'pasted text' ? 'No phone number found in that text yet.' : 'No contacts found in ' + (name || 'that file') + '. Export your contacts as vCard (.vcf) or CSV and choose that file.', 'warn'); return null; }
            return r.cards;
        };
        const sync = () => {
            const text = s(paste && paste.value);
            found = text.trim() ? People.parseContacts(text, '').cards : [];
            if (use) use.disabled = !found.length;
            if (!text.trim()) say('');
            else if (!found.length) say('No phone number found in that text yet.', 'warn');
            else say('Found ' + plural(found.length, 'contact', 'contacts') + ' with ' + plural(found.reduce((n, c) => n + c.tels.length, 0), 'number', 'numbers') + '.', 'ok');
        };
        const readFiles = async (files) => {
            const list = Array.from(files || []).slice(0, 5);
            if (!list.length) return;
            const texts = [];
            for (const f of list) {
                if (/\.(xlsx?|numbers|ods|zip|pdf)$/i.test(f.name)) { say(f.name + ' is a spreadsheet or archive. Save or export it as CSV or vCard first.', 'warn'); return; }
                if (f.size > People.LIMITS.vcfBytes) { say(f.name + ' is too large to be a contacts file.', 'warn'); return; }
                try { texts.push(await f.text()); } catch (_) { say('Could not read ' + f.name + '.', 'warn'); return; }
            }
            const cards = read(texts.join('\n'), list[0].name, list[0].name);
            if (cards) arrive(cards, list.length > 1 ? list.length + ' files' : list[0].name);
        };
        o.el.addEventListener('click', (e) => {
            const t = e.target.closest ? e.target.closest('[data-c]') : null; if (!t) return;
            const a = t.getAttribute('data-c');
            if (a === 'close') o.close();
            else if (a === 'file' && fileInput) fileInput.click();
            else if (a === 'device') {
                People.pickContacts(win, { multiple }).then((picked) => { if (picked.length) arrive(picked, 'your contacts'); else say('No contact was chosen.', ''); })
                    .catch((err) => say((err && err.userMessage) || 'Could not open your contacts. Try a file, or paste the number.', 'warn'));
            }
            else if (a === 'clip') {
                win.navigator.clipboard.readText().then((text) => { if (paste) { paste.value = s(text).slice(0, 200000); sync(); if (found && found.length === 1 && found[0].tels.length === 1) arrive(found, 'pasted text'); } })
                    .catch(() => say('The browser did not allow reading the clipboard. Long-press or press Ctrl/Command-V in the box instead.', 'warn'));
            }
            else if (a === 'use') { sync(); if (found && found.length) arrive(found, 'pasted text'); }
        });
        if (fileInput) fileInput.addEventListener('change', () => { readFiles(fileInput.files); fileInput.value = ''; });
        if (paste) {
            paste.addEventListener('input', sync);
            // one pasted number needs no second tap
            paste.addEventListener('paste', () => win.setTimeout(() => { sync(); if (found && found.length === 1 && found[0].tels.length === 1 && s(paste.value).length < 80) arrive(found, 'pasted text'); }, 0));
        }
        // a file dropped anywhere on the sheet
        const sheet = o.el.querySelector('.md');
        if (sheet) {
            sheet.addEventListener('dragover', (e) => { e.preventDefault(); sheet.classList.add('wfp-drop'); });
            sheet.addEventListener('dragleave', () => sheet.classList.remove('wfp-drop'));
            sheet.addEventListener('drop', (e) => {
                e.preventDefault(); sheet.classList.remove('wfp-drop');
                const dt = e.dataTransfer;
                if (dt && dt.files && dt.files.length) readFiles(dt.files);
                else if (dt) { const text = dt.getData('text/vcard') || dt.getData('text/x-vcard') || dt.getData('text/plain'); if (text && paste) { paste.value = text.slice(0, 200000); sync(); } }
            });
        }
        win.setTimeout(() => { try { (picker ? q('device') : q('file')).focus(); } catch (_) { /* focus is a courtesy */ } }, 60);
        return o;
    }

    /**
     * The "Contacts" button on a form. Where the browser has a contact picker (Chrome on Android) it opens at once, as one tap; if that fails
     * (permission refused, an embedded browser) or there is none, the sheet with every other way in opens instead.
     */
    function chooseContact(root, p, nameId, field = 'phone') {
        const iso = () => (at(root, p + '_cc') || {}).value || homeCountry();
        const onCards = (cards) => {
            if (cards.length === 1) return useContact(root, p, nameId, cards[0], field);
            return openContactChooser(cards, iso(), (name, number) => applyNumber(root, p, nameId, name, number, field));
        };
        if (People.contactPickerSupported(win)) {
            People.pickContacts(win, { multiple: false }).then((picked) => { if (picked.length) onCards(picked); })
                .catch((e) => { toast((e && e.userMessage) || 'Could not open your contacts. Choose a file or paste the number instead.', 'info'); openContactSource({ multiple: false, onCards }); });
            return;
        }
        openContactSource({ multiple: false, onCards });
    }

    /* ── overlays ── */

    function overlay(inner, cls = '') {
        ensureStyle();
        const el = doc.createElement('div');
        el.className = 'mo ' + cls;
        el.innerHTML = inner;
        doc.body.appendChild(el);
        win.requestAnimationFrame(() => el.classList.add('open'));
        const close = () => { el.classList.remove('open'); win.setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 230); };
        el.addEventListener('click', (e) => { if (e.target === el) close(); });
        el.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
        try { if (win.WFIcon && win.WFIcon.paint) win.WFIcon.paint(el); } catch (_) { /* icons are decoration */ }
        return { el, close };
    }

    const xButton = '<button class="md-x" aria-label="Close" data-c="close"><i data-wfi="x"></i></button>';

    /** One contact with several numbers: tap the one to use. */
    function openNumberChooser(draft, pick) {
        const o = overlay('<div class="md"><div class="md-hdr"><div class="md-title">' + esc(draft.name || 'Choose a number') + '</div>' + xButton + '</div>'
            + '<div class="wfp-help" style="margin:0 0 8px;">Which number should the texts go to?</div>'
            + draft.numbers.map((n, i) => '<button type="button" class="btn btn-secondary" style="width:100%;margin:0 0 8px;min-height:44px;" data-c="num" data-i="' + i + '">' + esc(n.pretty) + '</button>').join('')
            + (draft.others.length ? '<div class="wfp-help">Not used: ' + esc(draft.others.map((x) => x.raw).join(', ')) + ' (not a number that can be texted)</div>' : '') + '</div>', 'wfp-chooser');
        o.el.addEventListener('click', (e) => {
            const t = e.target.closest('[data-c]'); if (!t) return;
            if (t.getAttribute('data-c') === 'close') o.close();
            if (t.getAttribute('data-c') === 'num') { const n = draft.numbers[Number(t.getAttribute('data-i'))]; o.close(); if (n) pick(n); }
        });
    }

    /** A contacts file: search it, tap a number. */
    function openContactChooser(cards, iso, pick) {
        const drafts = cards.map((c) => People.draftFromContact(c, iso));
        const o = overlay('<div class="md"><div class="md-hdr"><div class="md-title">Choose from contacts</div>' + xButton + '</div>'
            + '<div class="wfp-bar"><input class="fi" type="search" data-c="q" placeholder="Search ' + drafts.length + ' contacts" autocomplete="off" aria-label="Search contacts"></div>'
            + '<div class="wfp-body" data-c="list"></div></div>', 'wfp-chooser');
        const list = o.el.querySelector('[data-c="list"]');
        const draw = (q) => {
            const t = s(q).trim().toLowerCase(); const digits = t.replace(/\D/g, '');
            const rows = drafts.map((d, i) => ({ d, i })).filter(({ d }) => !t || d.name.toLowerCase().includes(t) || (digits.length >= 3 && d.numbers.concat(d.others).some((n) => s(n.raw).replace(/\D/g, '').includes(digits))));
            list.innerHTML = rows.slice(0, 100).map(({ d, i }) => '<div class="wfp-imp"><span class="wfp-main"><span class="wfp-name">' + esc(d.name || '(no name)') + '</span>'
                + d.numbers.map((n, k) => '<button type="button" class="btn btn-secondary btn-sm" style="margin:4px 6px 0 0;min-height:38px;" data-c="num" data-i="' + i + '" data-k="' + k + '">' + esc(n.pretty) + '</button>').join('')
                + d.others.map((n) => '<span class="wfp-sub wfp-dim">' + esc(n.raw) + ' · cannot be texted</span>').join('') + '</span></div>').join('')
                + (rows.length > 100 ? '<div class="wfp-help">Showing 100 of ' + rows.length + '. Type to narrow the list.</div>' : '')
                || '<div class="wfp-empty">No contacts match.</div>';
        };
        draw('');
        o.el.addEventListener('input', (e) => { if (e.target.getAttribute && e.target.getAttribute('data-c') === 'q') draw(e.target.value); });
        o.el.addEventListener('click', (e) => {
            const t = e.target.closest('[data-c]'); if (!t) return;
            if (t.getAttribute('data-c') === 'close') o.close();
            if (t.getAttribute('data-c') === 'num') { const d = drafts[Number(t.getAttribute('data-i'))]; const n = d && d.numbers[Number(t.getAttribute('data-k'))]; o.close(); if (n) pick(d.name, n); }
        });
    }

    /** "Update everywhere / this record only / cancel": asked when a form changes a saved person's name, number or ID. */
    function askUpdate({ person, diff, others, kind }, done) {
        const what = diff.map((f) => ({ name: 'name', fullName: 'full name', phone: 'number', phone2: 'second number', nic: 'NIC / ID' }[f])).join(', ');
        const more = others.loans + others.investments;
        const where = [others.loans ? plural(others.loans, 'other loan', 'other loans') : '', others.investments ? plural(others.investments, 'other investment', 'other investments') : ''].filter(Boolean).join(' and ');
        const o = overlay('<div class="md" style="max-width:440px;"><div class="md-hdr"><div class="md-title">Update ' + esc(person.name) + '’s saved details?</div>' + xButton + '</div>'
            + '<div style="font-size:13px;line-height:1.6;margin:0 0 12px;">You changed their <b>' + esc(what) + '</b> on this form. '
            + (more ? esc(person.name) + ' is also on ' + esc(where) + (others.smsOn ? ' (' + plural(others.smsOn, 'with texts on', 'with texts on') + ')' : '') + '.' : 'They are in your saved list.') + '</div>'
            + '<button type="button" class="btn btn-primary" style="width:100%;margin:0 0 8px;min-height:44px;" data-c="update">' + (more ? 'Update everywhere' : 'Update the saved person') + '</button>'
            + '<button type="button" class="btn btn-secondary" style="width:100%;margin:0 0 8px;min-height:44px;" data-c="detach">This ' + (kind === 'debtor' ? 'loan' : 'investment') + ' only</button>'
            + '<button type="button" class="btn btn-ghost" style="width:100%;min-height:44px;" data-c="cancel">Cancel</button></div>', 'wfp-chooser');
        let answered = false;
        const answer = (v) => { if (answered) return; answered = true; o.close(); done(v); };
        o.el.addEventListener('click', (e) => {
            if (e.target === o.el) return answer('cancel');
            const t = e.target.closest('[data-c]'); if (!t) return;
            const a = t.getAttribute('data-c');
            answer(a === 'close' ? 'cancel' : a);
        });
        o.el.addEventListener('keydown', (e) => { if (e.key === 'Escape') answer('cancel'); });
    }

    /* ── the hub ── */

    function openHub(tab = 'people') {
        ensureStyle(); autoFile();
        const st = { tab: ['people', 'pay', 'messages'].includes(tab) ? tab : 'people', view: 'list', id: '', draft: null, errors: {}, confirm: null, askDelete: false, q: '', imp: null, stopMsgs: null };
        const o = overlay('<div class="md" style="max-width:540px;"><div class="md-hdr"><div class="md-title">Saved people &amp; payments</div><button class="md-x" aria-label="Close" data-h="close"><i data-wfi="x"></i></button></div>'
            + '<div class="wfp-tabs" role="tablist">'
            + ['people:People', 'pay:Payment details', 'messages:Messages'].map((x) => { const [k, l] = x.split(':'); return '<button type="button" class="wfp-tab" role="tab" data-h="tab" data-v="' + k + '">' + l + '</button>'; }).join('')
            + '</div><div class="wfp-body" id="wfp_body"></div></div>', 'wfp-hub');
        const body = o.el.querySelector('#wfp_body');
        const data = () => { const sx = store(); return { sx, people: People.listPeople(sx), books: People.booksOf(sx), accounts: Pay.listAccounts(sx.get(Pay.PAY_KEY)) }; };
        const leaveMessages = () => { if (st.stopMsgs) { try { st.stopMsgs(); } catch (_) { /* gone */ } st.stopMsgs = null; } };
        const close = () => { leaveMessages(); o.close(); };

        function read(id) { const el = body.querySelector('#' + id); return el ? s(el.value) : ''; }
        function readPerson() {
            const c = readContact(body, '_pp') || { phone: '', country: DEFAULT_REGION, nic: '', idKind: 'nic' };
            return { name: read('_pp_name'), fullName: c.fullName, phone: c.phone, country: c.country, nic: c.nic, idKind: c.idKind, phone2: read('_pp_phone2'), email: read('_pp_email'), address: read('_pp_address'), note: read('_pp_note') };
        }
        /** A form's contents as the form builder wants them back: the kind of ID rides on the prefix the stored form uses. */
        const asDraft = (f) => ({ ...f, nic: f.nic && f.idKind === 'other' && !/^ID:/i.test(f.nic) ? 'ID:' + f.nic : f.nic });

        function render() {
            leaveMessages();
            const { people, books, accounts } = data();
            o.el.querySelectorAll('.wfp-tab').forEach((b) => b.setAttribute('aria-selected', String(b.getAttribute('data-v') === st.tab)));
            if (st.tab === 'people') {
                if (st.view === 'person') {
                    const person = st.id ? People.personById(people, st.id) : null;
                    body.innerHTML = personFormHtml({ person, draft: st.draft, errors: st.errors, people, use: person ? People.usageOf(person, books) : null, confirm: st.confirm, askDelete: st.askDelete });
                } else if (st.view === 'import') {
                    body.innerHTML = importHtml(importModel());
                } else {
                    body.innerHTML = peopleTabHtml({ people, books, q: st.q, unfiled: People.unfiledRecords(data().sx).length, picker: People.contactPickerSupported(win) });
                }
            } else if (st.tab === 'pay') {
                if (st.view === 'account') {
                    const account = st.id ? accounts.find((a) => a.id === st.id) || null : null;
                    body.innerHTML = accountFormHtml({ account, draft: st.draft, errors: st.errors, askDelete: st.askDelete });
                } else {
                    body.innerHTML = accountsTabHtml({ accounts }) + previewHtml(accounts);
                }
            } else {
                body.innerHTML = '<div id="wfp_msgs"></div>';
                const host = body.querySelector('#wfp_msgs');
                const sms = smsPanel();
                if (sms) st.stopMsgs = sms.panelInto(host); else host.innerHTML = '<div class="wfp-empty">The text-message log is not available on this page.</div>';
            }
        }

        const previewHtml = (accounts) => {
            const shown = Pay.publicAccounts(accounts, ['A', 'B']);
            if (!shown.length) return '';
            return '<div class="wfp-help" style="margin:14px 0 2px;"><b>How it looks on a statement page</b> (everything shown to debtors and investors together)</div>' + shown.map(accountCardHtml).join('');
        };

        /* the import list's model: the rows the owner can tick, filtered by the search box */
        function importModel() {
            const imp = st.imp || { rows: [], q: '', busy: false, source: '' };
            const t = imp.q.trim().toLowerCase(); const digits = t.replace(/\D/g, '');
            const rows = imp.rows.filter((r) => !t || r.name.toLowerCase().includes(t) || (digits.length >= 3 && r.numbers.some((n) => n.e164.includes(digits))));
            return { rows: rows.slice(0, 150), q: imp.q, shown: Math.min(rows.length, 150), total: rows.length, busy: imp.busy, source: imp.source };
        }
        function startImport(cards, source) {
            const iso = homeCountry();
            const rows = cards.map((c, i) => { const d = People.draftFromContact(c, iso); return { i, name: d.name, numbers: d.numbers, others: d.others, pick: 0, on: false }; });
            st.imp = { rows, q: '', busy: false, source };
            st.view = 'import';
            render();
        }
        function runImport() {
            const picks = (st.imp ? st.imp.rows : []).filter((x) => x.on && x.numbers.length).map((r) => { const n = r.numbers[r.pick] || r.numbers[0]; return { name: r.name || n.pretty, phone: n.e164, country: n.iso }; });
            const { added, duplicates, failed } = People.addPeople(store(), picks, {});
            toast('Added ' + plural(added, 'person', 'people') + (duplicates ? ' (' + duplicates + ' already in your list)' : '') + (failed ? ', ' + failed + ' could not be added' : ''), added ? 'success' : 'info');
            st.view = 'list'; st.imp = null; render();
        }

        function savePerson(confirmed) {
            const f = readPerson();
            const { sx } = data();
            const clean = People.cleanPerson(f);
            if (!clean.ok) { st.draft = asDraft(f); st.errors = clean.errors; st.confirm = null; render(); toast(Object.values(clean.errors)[0], 'error'); return; }
            if (st.id) {
                const use = People.previewUpdate(sx, st.id, f);
                if ((use.loans + use.investments) > 0 && !confirmed) { st.draft = asDraft(f); st.errors = {}; st.confirm = use; render(); return; }
                const r = People.updatePerson(sx, st.id, f);
                if (!r.ok) { st.draft = asDraft(f); st.errors = r.errors; st.confirm = null; render(); toast(Object.values(r.errors)[0], 'error'); return; }
                const n = r.siblings.loans + r.siblings.investments;
                toast(clean.fields.name + ' saved' + (n ? ' and updated on ' + plural(n, 'loan or investment', 'loans and investments') : ''), 'success');
            } else {
                const r = People.addPerson(sx, f, {});
                if (!r.ok) { st.draft = asDraft(f); st.errors = r.errors; render(); toast(Object.values(r.errors)[0], 'error'); return; }
                toast(r.person.name + ' added to your list', 'success');
            }
            st.view = 'list'; st.id = ''; st.draft = null; st.errors = {}; st.confirm = null; st.askDelete = false;
            render();
        }

        function saveAccount() {
            const f = { bank: read('_pa_bank'), holder: read('_pa_holder'), number: read('_pa_number'), branch: read('_pa_branch'), swift: read('_pa_swift'), note: read('_pa_note'), noteSi: read('_pa_noteSi'), showTo: read('_pa_show'), active: !!(body.querySelector('#_pa_active') || {}).checked };
            const clean = Pay.cleanAccount(f);
            if (!clean.ok) { st.draft = f; st.errors = clean.errors; render(); toast(Object.values(clean.errors)[0], 'error'); return; }
            const sx = store();
            const list = Pay.listAccounts(sx.get(Pay.PAY_KEY));
            const stamp = new Date().toISOString();
            if (st.id) {
                const prev = list.find((a) => a.id === st.id);
                if (!prev) { toast('That account is no longer there', 'error'); st.view = 'list'; render(); return; }
                sx.set(Pay.PAY_KEY, list.map((a) => (a.id === st.id ? { ...a, ...clean.fields, noteSi: clean.fields.noteSi || '', updatedAt: stamp } : a)));
            } else {
                if (list.length >= Pay.LIMITS.accounts) { toast('You can keep up to ' + Pay.LIMITS.accounts + ' accounts', 'error'); return; }
                sx.set(Pay.PAY_KEY, [...list, { ...clean.fields, id: People.defaultId(), createdAt: stamp, updatedAt: stamp }]);
            }
            toast('Bank account saved', 'success');
            st.view = 'list'; st.id = ''; st.draft = null; st.errors = {}; st.askDelete = false;
            render();
        }

        o.el.addEventListener('click', (e) => {
            const t = e.target.closest('[data-h]');
            if (!t) { if (e.target === o.el) close(); return; }
            const a = t.getAttribute('data-h'); const id = t.getAttribute('data-id') || '';
            switch (a) {
                case 'close': close(); break;
                case 'tab': st.tab = t.getAttribute('data-v'); st.view = 'list'; st.id = ''; st.draft = null; st.errors = {}; st.confirm = null; st.askDelete = false; render(); break;
                case 'add': st.view = 'person'; st.id = ''; st.draft = null; st.errors = {}; st.confirm = null; render(); break;
                case 'edit': st.view = 'person'; st.id = id; st.draft = null; st.errors = {}; st.confirm = null; st.askDelete = false; render(); break;
                case 'back': st.view = 'list'; st.id = ''; st.draft = null; st.errors = {}; st.confirm = null; st.askDelete = false; st.imp = null; render(); break;
                case 'save': savePerson(false); break;
                case 'savego': savePerson(true); break;
                case 'savenot': st.confirm = null; st.askDelete = false; st.draft = st.draft || asDraft(readPerson()); render(); break;
                case 'del': st.draft = asDraft(readPerson()); st.askDelete = true; render(); break;
                case 'delgo': { const sx = store(); const person = People.personById(People.listPeople(sx), id); People.removePerson(sx, id); toast((person ? person.name : 'The person') + ' was removed from your list. Their loans and investments are unchanged.', 'success'); st.view = 'list'; st.id = ''; st.draft = null; st.askDelete = false; render(); break; }
                case 'harvest': { const r = People.harvestPeople(store(), {}); toast(r.linked ? 'Added ' + plural(r.added, 'person', 'people') + ' and linked ' + plural(r.linked, 'loan or investment', 'loans and investments') : 'Everybody is already in your list', 'success'); render(); break; }
                case 'import': {
                    const onCards = (cards, source) => startImport(cards, source || 'your contacts');
                    if (People.contactPickerSupported(win)) {
                        People.pickContacts(win, { multiple: true }).then((picked) => { if (picked.length) onCards(picked, 'your contacts'); else toast('No contacts were chosen', 'info'); })
                            .catch((err) => { toast((err && err.userMessage) || 'Could not open your contacts. Choose a file or paste them instead.', 'info'); openContactSource({ multiple: true, onCards }); });
                    } else openContactSource({ multiple: true, onCards });
                    break;
                }
                case 'impall': { const m = importModel(); const shown = new Set(m.rows.map((r) => r.i)); st.imp.rows.forEach((r) => { if (shown.has(r.i) && r.numbers.length) r.on = true; }); render(); break; }
                case 'impnone': st.imp.rows.forEach((r) => { r.on = false; }); render(); break;
                case 'impgo': runImport(); break;
                case 'acc-add': st.view = 'account'; st.id = ''; st.draft = null; st.errors = {}; st.askDelete = false; render(); break;
                case 'acc-edit': st.view = 'account'; st.id = id; st.draft = null; st.errors = {}; st.askDelete = false; render(); break;
                case 'acc-cancel': st.view = 'list'; st.id = ''; st.draft = null; st.errors = {}; st.askDelete = false; render(); break;
                case 'acc-save': saveAccount(); break;
                case 'acc-del': st.draft = { bank: read('_pa_bank'), holder: read('_pa_holder'), number: read('_pa_number'), branch: read('_pa_branch'), swift: read('_pa_swift'), note: read('_pa_note'), noteSi: read('_pa_noteSi'), showTo: read('_pa_show'), active: !!(body.querySelector('#_pa_active') || {}).checked }; st.askDelete = true; render(); break;
                case 'acc-delgo': { const sx = store(); sx.set(Pay.PAY_KEY, Pay.listAccounts(sx.get(Pay.PAY_KEY)).filter((x) => x.id !== id)); toast('Bank account deleted', 'success'); st.view = 'list'; st.id = ''; st.draft = null; st.askDelete = false; render(); break; }
                default: break;
            }
        });
        o.el.addEventListener('change', (e) => {
            const t = e.target; const a = t.getAttribute && t.getAttribute('data-h');
            if (a === 'acc-toggle') {
                const sx = store();
                sx.set(Pay.PAY_KEY, Pay.listAccounts(sx.get(Pay.PAY_KEY)).map((x) => (x.id === t.getAttribute('data-id') ? { ...x, active: !!t.checked, updatedAt: new Date().toISOString() } : x)));
                render();
            } else if (a === 'imptick' && st.imp) {
                const r = st.imp.rows[Number(t.getAttribute('data-i'))]; if (r) r.on = !!t.checked;
                const go = body.querySelector('[data-h="impgo"]'); const on = st.imp.rows.filter((x) => x.on).length;
                if (go) { go.disabled = !on; go.textContent = on ? 'Add ' + plural(on, 'person', 'people') : 'Tick the people to add'; }
            } else if (a === 'impnum' && st.imp) {
                const r = st.imp.rows[Number(t.getAttribute('data-i'))]; if (r) r.pick = Number(t.value) || 0;
            }
        });
        o.el.addEventListener('input', (e) => {
            const t = e.target; const a = t.getAttribute && t.getAttribute('data-h');
            if (a === 'search') {
                st.q = t.value;
                const host = body.querySelector('#wfp_list'); const d = data();
                if (host) host.innerHTML = peopleListHtml({ people: d.people, books: d.books, q: st.q });
            } else if (a === 'impsearch' && st.imp) {
                st.imp.q = t.value;
                const keep = t.selectionStart;
                render();
                const box = body.querySelector('#wfp_iq'); if (box) { box.focus(); try { box.setSelectionRange(keep, keep); } catch (_) { /* some inputs refuse */ } }
            }
        });
        o.el.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') { close(); return; }
            if ((e.key === 'Enter' || e.key === ' ') && e.target.getAttribute && /^(edit|acc-edit)$/.test(e.target.getAttribute('data-h') || '') && e.target.getAttribute('role') === 'button') { e.preventDefault(); e.target.click(); }
        });
        render();
        return o.el;
    }

    /* ── the API the forms use ── */

    const api = {
        ready: true,
        showPhone,
        /** Does this loan or investment match what was typed in a list's search box (name, nickname, full name, NIC, either number)? */
        recordMatches: (rec, query) => People.recordMatches(rec, query, rec && rec[People.LINK_FIELD] ? People.personById(People.listPeople(store()), rec[People.LINK_FIELD]) : null),
        /** The "Saved people" picker for the top of a form. `record` is the loan or investment being edited, or null. */
        pickerHtml(prefix, { record = null, nameId = '' } = {}) { ensureStyle(); autoFile(); return pickerHtml(prefix, { people: People.listPeople(store()), record: freshRecord(record), nameId }); },
        /** The country / number / ID fields. */
        contactHtml(prefix, { kind = 'debtor', record = null, nameId = '', remember = true, phoneHelp = '' } = {}) {
            ensureStyle(); autoFile();
            return contactHtml(prefix, { kind, record: freshRecord(record), people: People.listPeople(store()), nameId, defaultCountry: homeCountry(), remember, phoneHelp });
        },
        readContact,
        /** Validate and show the problems under the fields. -> collectContact's answer. */
        collect(root, prefix, { smsOn = false, kind = 'debtor' } = {}) {
            const c = collectContact(readContact(root, prefix), { smsOn });
            api.showErrors(root, prefix, c.errors);
            return c;
        },
        showErrors(root, prefix, errors) {
            const set = (suffix, key) => { const el = root && root.querySelector ? root.querySelector('#' + prefix + '_' + suffix) : null; if (el && errors && errors[key]) { el.className = 'wfp-pv bad'; el.textContent = errors[key]; } };
            set('pv', 'phone'); set('pv2', 'phone2'); set('idv', 'nic');
        },
        /**
         * The form has been checked and is about to be saved: file the person, link the record, keep everybody in step.
         *   { kind, rec, remember, country, onDone(result), onCancel }
         * Call it BEFORE the ledger is read for the write, because a changed name, number or ID is written to the person's other records here.
         * It may ask the owner one question (update everywhere, this record only, cancel), so `onDone` can run later.
         */
        saveLink({ kind, rec, remember = false, country = '', onDone = null, onCancel = null }) {
            let finished = false;
            const done = (res) => {
                if (finished) return; finished = true;
                try { announce(res, kind); } catch (_) { /* a toast is a courtesy */ }
                if (onDone) onDone(res);
            };
            try {
                const sx = store();
                const linked = People.personById(People.listPeople(sx), rec.personId);
                if (linked) {
                    const diff = People.sharedDiff(kind, rec, linked);
                    if (diff.length) {
                        const others = People.usageOf(linked, People.booksOf(sx), rec.id);
                        return askUpdate({ person: linked, diff, others, kind }, (choice) => {
                            if (choice === 'cancel') { if (onCancel) onCancel(); return; }
                            if (choice === 'detach') { delete rec.personId; return done({ detached: true, person: null }); }
                            return done(People.linkRecord({ store: sx, kind, rec, remember: true, country }));
                        });
                    }
                }
                return done(People.linkRecord({ store: sx, kind, rec, remember: !!remember, country }));
            } catch (e) {
                console.warn('[WF-PEOPLE] linking failed:', e && e.message);
                return done({ person: null, error: true });
            }
        },
        openHub,
        autoFile,
    };

    function announce(res, kind) {
        if (!res || !res.person) return;
        if (res.created) toast(res.person.name + ' saved to your people list', 'success');
        else if (res.updated) {
            const n = res.siblings.loans + res.siblings.investments;
            toast(res.person.name + '’s saved details updated' + (n ? ' and carried to ' + plural(n, 'other loan or investment', 'other loans and investments') : ''), 'success');
        } else if (res.matched) toast('Linked to ' + res.person.name + ' in your people list', 'success');
    }

    /* ── one set of listeners for every form on the page ── */

    if (!win.__wfpBound) {
        win.__wfpBound = true;
        const attr = (el, n) => (el && el.getAttribute ? el.getAttribute(n) : null);
        doc.addEventListener('input', (e) => {
            const a = attr(e.target, 'data-wfp'); if (!a) return;
            const p = attr(e.target, 'data-p'); const root = rootOf(e.target);
            if (a === 'phone') refreshPhone(root, p, false);
            else if (a === 'phone2') refreshPhone2(root, p, false);
            else if (a === 'nic') refreshId(root, p, false, false);
        });
        doc.addEventListener('change', (e) => {
            const a = attr(e.target, 'data-wfp'); if (!a) return;
            const p = attr(e.target, 'data-p'); const root = rootOf(e.target);
            if (a === 'pick') pickPerson(root, p, e.target.value, attr(e.target, 'data-name'));
            else if (a === 'cc') {
                refreshPhone(root, p, true);
                const nic = at(root, p + '_nic'); const idk = at(root, p + '_idk');
                if (nic && idk && !nic.value.trim()) { idk.value = e.target.value === DEFAULT_REGION ? 'nic' : 'other'; refreshId(root, p, true, true); }
            }
            else if (a === 'phone') refreshPhone(root, p, true);
            else if (a === 'phone2') refreshPhone2(root, p, true);
            else if (a === 'idk') refreshId(root, p, true, true);
            else if (a === 'nic') refreshId(root, p, true, false);
        });
        doc.addEventListener('click', (e) => {
            const b = e.target && e.target.closest ? e.target.closest('[data-wfp]') : null;
            if (!b) return;
            const a = b.getAttribute('data-wfp');
            if (a === 'contacts') { e.preventDefault(); chooseContact(rootOf(b), b.getAttribute('data-p'), b.getAttribute('data-name')); }
            else if (a === 'contacts2') { e.preventDefault(); chooseContact(rootOf(b), b.getAttribute('data-p'), b.getAttribute('data-name'), 'phone2'); }
            else if (a === 'manage') { e.preventDefault(); openHub('people'); }
        });
    }
    // once signed in and the books are in, file whoever is not filed yet; and again each time the owner comes back to the app
    if (!win.__wfpFiling) {
        win.__wfpFiling = true;
        let waited = 0;
        const timer = win.setInterval(() => {
            waited += 4000;
            if (win.currentUser && win.currentUser.uid && win.appData) { win.clearInterval(timer); win.setTimeout(autoFile, 6000); }
            else if (waited > 10 * 60000) win.clearInterval(timer);
        }, 4000);
        win.document.addEventListener('visibilitychange', () => { if (win.document.visibilityState === 'visible') win.setTimeout(autoFile, 1500); });
    }
    return api;
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__WF_PEOPLE_NO_BOOT) {
    try { window.WFPeople = boot(window); } catch (e) { console.warn('[WF-PEOPLE] the people screens did not start:', e && e.message); }
}

export default { countrySelectHtml, phone2Note, contactTips, contactSourceHtml, contactHtml, pickerHtml, readContact, collectContact, phoneNote, idNote, showPhone, personRowHtml, peopleListHtml, peopleTabHtml, personFormHtml, importHtml, accountsTabHtml, accountFormHtml, accountCardHtml, boot };
