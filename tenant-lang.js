/* =============================================================================
 * tenant-lang.js — the statement page in English and Sinhala
 * -----------------------------------------------------------------------------
 * The page's words are written once, in English, and looked up here by their exact text: a sentence with no
 * Sinhala entry is simply shown in English, so a new sentence can never leave a hole or a blank. The server's
 * own fixed sentences (tenant-portal.mjs MSG) are in the table too, which is how a refusal reads in the
 * person's language without the server ever knowing which one they chose.
 *
 *   t('This code expires in {t}.', { t: '2:41' })
 *
 * Nothing is stored: the language is chosen from the browser's own list the first time and changed with one
 * button; it is not kept anywhere, because this page keeps nothing. Dates and month names stay as they are
 * on the statement (English month abbreviations and Western digits), the form a Sri Lankan statement uses.
 * The PDF is in the same two languages: the person's choice on the page is sent with the download, and the file is
 * set in an embedded Sinhala font (tenant-pdf.mjs), using the words below. The spreadsheet is English only; the calendar reminder is in the page's language.
 *
 * Plain ES module, no DOM.
 * ===========================================================================*/

export const LANGS = Object.freeze(['en', 'si']);

/** What the person's browser prefers: Sinhala if it is anywhere in their list, else English. */
export function detectLang(nav) {
    const n = nav && typeof nav === 'object' ? nav : {};
    const list = Array.isArray(n.languages) && n.languages.length ? n.languages : [n.language];
    return list.some((l) => /^si(?:[-_]|$)/i.test(String(l || ''))) ? 'si' : 'en';
}

export const SI = Object.freeze({
    /* the first screen */
    'View your statement': 'ඔබේ ගිණුම් ප්‍රකාශය බලන්න',
    'Your NIC or passport / ID number': 'ඔබේ ජාතික හැඳුනුම්පත් අංකය, හෝ ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකය',
    'Enter your NIC, or your passport / ID number if you have no Sri Lankan NIC. We will text a 6-digit code to the mobile number your lender has on file for you.':
        'ඔබේ ජාතික හැඳුනුම්පත් අංකය ඇතුළත් කරන්න (ශ්‍රී ලාංකික හැඳුනුම්පතක් නොමැති නම් ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකය). ඔබේ ණය දෙන්නා සතුව ඇති ඔබේ ජංගම දුරකථන අංකයට ඉලක්කම් 6ක කේතයක් කෙටි පණිවිඩයෙන් එවනු ඇත.',
    'Send me a code': 'කේතයක් එවන්න',
    'Sending...': 'එවමින්...',
    'Your statement is shown only after you enter the code. Nobody else can see it from this link.':
        'කේතය ඇතුළත් කළ පසු පමණක් ඔබේ ප්‍රකාශය පෙන්වයි. මෙම සබැඳියෙන් වෙනත් කිසිවකුට එය බැලිය නොහැක.',

    /* the code screen */
    'Enter your code': 'ඔබේ කේතය ඇතුළත් කරන්න',
    'Code from the text message': 'කෙටි පණිවිඩයේ ඇති කේතය',
    '6-digit code': 'ඉලක්කම් 6ක කේතය',
    'View my statement': 'මගේ ප්‍රකාශය බලන්න',
    'Checking...': 'පරීක්ෂා කරමින්...',
    'Use different details': 'වෙනත් විස්තර භාවිතා කරන්න',
    'Send a new code': 'නව කේතයක් එවන්න',
    'Send a new code ({n}s)': 'නව කේතයක් එවන්න (තත්පර {n})',
    'This code expires in {t}.': 'මෙම කේතය {t} කින් කල් ඉකුත් වේ.',
    'That code has expired. Request a new one.': 'එම කේතය කල් ඉකුත් වී ඇත. නව එකක් ඉල්ලන්න.',
    'No text after a minute? Your lender may have no mobile number for you, or messaging may be unavailable. Try again later or contact your lender.':
        'මිනිත්තුවකට පසුත් පණිවිඩයක් නොලැබුණාද? ඔබේ ණය දෙන්නා සතුව ඔබේ ජංගම දුරකථන අංකයක් නොතිබිය හැක, නැතහොත් පණිවිඩ යැවීම තාවකාලිකව අක්‍රිය විය හැක. පසුව නැවත උත්සාහ කරන්න, නැතහොත් ඔබේ ණය දෙන්නා අමතන්න.',
    'A new code is on its way if the details match. The old one no longer works.': 'විස්තර ගැළපේ නම් නව කේතයක් එවනු ලැබේ. පැරණි කේතය තවදුරටත් ක්‍රියා නොකරයි.',

    /* the statement */
    'Your statement': 'ඔබේ ප්‍රකාශය',
    'Sign out': 'පිටවන්න',
    'As at {when}': '{when} වන විට',
    'Sri Lanka time': 'ශ්‍රී ලංකා වේලාව',
    'For your privacy this closes in {t}.': 'ඔබේ පෞද්ගලිකත්වය සඳහා මෙය {t} කින් වැසේ.',
    'Download PDF': 'PDF බාගන්න',
    'Preparing...': 'සූදානම් කරමින්...',
    'Print': 'මුද්‍රණය කරන්න',
    'Your PDF is ready. Check your downloads.': 'ඔබේ PDF සූදානම්. ඔබේ බාගැනීම් බලන්න.',
    'Invested': 'ආයෝජනය',
    'Interest received': 'ලැබුණු පොලිය',
    'Loan outstanding': 'ඉතිරි ණය මුදල',
    'Investment': 'ආයෝජනය',
    'Loan': 'ණය',
    'Capital': 'ප්‍රාග්ධනය',
    'Rate': 'පොලී අනුපාතය',
    '{n}% a year': 'වසරකට {n}%',
    'Interest paid': 'පොලිය ගෙවන්නේ',
    'Monthly': 'මාසිකව',
    'Every 3 months': 'මාස 3කට වරක්',
    'Yearly': 'වාර්ෂිකව',
    'Interest each time': 'වරකට පොලිය',
    'Started': 'ආරම්භය',
    'Ends': 'අවසානය',
    'Next interest due': 'ඊළඟ පොලිය ලැබිය යුත්තේ',
    'Payments received, in {cur}': 'ලැබුණු ගෙවීම්, {cur} වලින්',
    'For': 'මාසය',
    'Received on': 'ලැබුණු දිනය',
    'Amount': 'මුදල',
    'No payments recorded yet.': 'තවමත් ගෙවීම් සටහන් කර නැත.',
    'Paid out': 'ලබා දුන් මුදල',
    'Repaid': 'ආපසු ගෙවූ මුදල',
    'Outstanding': 'ඉතිරි මුදල',
    'Expected back by': 'ආපසු ගෙවිය යුත්තේ',
    '{n} days ago': 'දින {n}කට පෙර',
    '1 day ago': 'දිනකට පෙර',
    'Movements, in {cur}': 'ගනුදෙනු, {cur} වලින්',
    'Date': 'දිනය',
    'Balance': 'ශේෂය',
    'Loan paid out': 'ණය මුදල ලබා දීම',
    'Further advance': 'අමතර ණය මුදලක්',
    'Repayment': 'ආපසු ගෙවීම',
    'Nothing recorded yet.': 'තවමත් කිසිවක් සටහන් කර නැත.',
    'Settled': 'සම්පූර්ණයෙන් ගෙවා ඇත',
    'Closed': 'වසා ඇත',
    'Open': 'විවෘතයි',
    'Lender {n}': 'ණය දෙන්නා {n}',
    'There is nothing to show yet. When your lender records something for you, it will appear here.':
        'තවමත් පෙන්වීමට කිසිවක් නැත. ඔබේ ණය දෙන්නා ඔබ වෙනුවෙන් යමක් සටහන් කළ විට එය මෙහි පෙන්වයි.',
    'This statement is long, so only the first part is shown.': 'මෙම ප්‍රකාශය දිගු බැවින් පළමු කොටස පමණක් පෙන්වයි.',
    'Figures are as recorded by your lender. If something looks wrong, please contact your lender.':
        'සංඛ්‍යා ඔබේ ණය දෙන්නා සටහන් කර ඇති ආකාරයටම ය. යමක් වැරදි බවක් පෙනේ නම් කරුණාකර ඔබේ ණය දෙන්නා අමතන්න.',

    /* the PDF's own words (the page does not show these) */
    'Every investment and loan your lender records for you is listed here under a reference code. Quote the code when you contact your lender or make a payment.':
        'ඔබේ ණය දෙන්නා ඔබ වෙනුවෙන් සටහන් කරන සෑම ආයෝජනයක් සහ ණයක්ම යොමු කේතයක් යටතේ මෙහි ලැයිස්තුගත කර ඇත. ඔබේ ණය දෙන්නා අමතන විට හෝ ගෙවීමක් කරන විට එම කේතය සඳහන් කරන්න.',
    'Summary': 'සාරාංශය',
    'Figures are as recorded by your lender from the payments they have confirmed. This statement is for your own records and is not a substitute for your lender\'s own account. If something looks wrong, please contact your lender.':
        'සංඛ්‍යා ඔබේ ණය දෙන්නා තහවුරු කළ ගෙවීම් අනුව සටහන් කර ඇති ආකාරයටම ය. මෙම ප්‍රකාශය ඔබේ පෞද්ගලික වාර්තා සඳහා පමණි; එය ඔබේ ණය දෙන්නාගේ ගිණුමට විකල්පයක් නොවේ. යමක් වැරදි බවක් පෙනේ නම් කරුණාකර ඔබේ ණය දෙන්නා අමතන්න.',
    'Account Statement': 'ගිණුම් ප්‍රකාශය',
    'Your investments and loans with your lender': 'ඔබේ ණය දෙන්නා සමඟ ඔබට ඇති ආයෝජන සහ ණය',
    'Statement No': 'ප්‍රකාශ අංකය',
    'As at': 'දිනය සහ වේලාව',
    'Time zone': 'වේලා කලාපය',
    '1 day': 'දින 1',
    '{n} days': 'දින {n}',
    'Investment details': 'ආයෝජන විස්තර',
    'Reference': 'යොමු කේතය',
    'Account status': 'ගිණුමේ තත්ත්වය',
    'Payments received': 'ලැබුණු ගෙවීම්',
    'Next interest amount': 'ඊළඟ පොලී මුදල',
    'Interest received ({n})': 'ලැබුණු පොලිය ({n})',
    'Amount ({cur})': 'මුදල ({cur})',
    'Total received ({n})': 'මුළු ලැබීම ({n})',
    'Loan details': 'ණය විස්තර',
    'Repaid so far': 'මෙතෙක් ආපසු ගෙවූ මුදල',
    'Status': 'තත්ත්වය',
    'Overdue': 'ප්‍රමාද දින',
    'Account movements ({n})': 'ගිණුම් ගනුදෙනු ({n})',
    'Transaction': 'ගනුදෙනුව',
    'Balance ({cur})': 'ශේෂය ({cur})',
    'Type': 'වර්ගය',
    'Total repaid ({n})': 'මුළු ආපසු ගෙවීම ({n})',
    'money lent': 'ණයට දුන් මුදල',
    'money paid back': 'ආපසු ලැබුණු මුදල',
    'Legend': 'සටහන්',
    'Advance': 'අතිරේක මුදල',
    'Interest received so far': 'මෙතෙක් ලැබුණු පොලිය',
    'SWIFT / IBAN': 'SWIFT / IBAN',
    'and {n} more': 'සහ තවත් {n}ක්',
    'WealthFlow statement': 'WealthFlow ප්‍රකාශය',
    'Generated {when}': 'සකස් කළේ {when}',
    'Page {i} of {total}': 'පිටුව {i} / {total}',

    /* where to pay */
    'How to pay': 'ගෙවන ආකාරය',
    'Pay by bank transfer to the account below and put the reference of the record in the transfer. If the account details here look different from what your lender told you, check with your lender before sending money.':
        'පහත ගිණුමට බැංකු හුවමාරුවෙන් ගෙවා, හුවමාරුවේ සටහනේ අදාළ වාර්තාවේ යොමු කේතය (reference) සඳහන් කරන්න. මෙහි ඇති ගිණුම් විස්තර ඔබේ ණය දෙන්නා ඔබට කී ඒවාට වඩා වෙනස් නම්, මුදල් යැවීමට පෙර ඔබේ ණය දෙන්නාගෙන් තහවුරු කරගන්න.',
    'References: {refs}': 'යොමු කේත: {refs}',
    'Bank': 'බැංකුව',
    'Account name': 'ගිණුමේ නම',
    'Account holder': 'ගිණුම් හිමියා',
    'NIC / ID': 'ජා.හැ.අංකය / හැඳුනුම්පත',
    'Note': 'සටහන',
    'Account number': 'ගිණුම් අංකය',
    'Branch': 'ශාඛාව',
    'Copy': 'පිටපත් කරන්න',
    'Copied': 'පිටපත් විය',
    'Copy all details': 'සියලු විස්තර පිටපත් කරන්න',
    'Copied to the clipboard.': 'පිටපත් කරන ලදි.',
    'Could not copy. Please select the text and copy it yourself.': 'පිටපත් කළ නොහැකි විය. කරුණාකර පෙළ තෝරා ඔබම පිටපත් කරන්න.',

    /* what the person can do with the statement */
    'Coming up': 'ඉදිරියේදී',
    'Pay your loan': 'ඔබේ ණය ගෙවන්න',
    'Interest expected': 'බලාපොරොත්තු වන පොලිය',
    'Due today': 'අද නියමිතයි',
    'Due tomorrow': 'හෙට නියමිතයි',
    'In {n} days': 'දින {n}කින්',
    '1 day overdue': 'දවසක් ප්‍රමාදයි',
    '{n} days overdue': 'දින {n}ක් ප්‍රමාදයි',
    'Add to calendar': 'දින දර්ශනයට එක් කරන්න',
    '{n}% repaid': '{n}%ක් ආපසු ගෙවා ඇත',
    'Term: {n}% complete': 'කාලසීමාවෙන් {n}%ක් ගත වී ඇත',
    'Copy reference': 'යොමු අංකය පිටපත් කරන්න',
    'Show all {n}': 'සියල්ල පෙන්වන්න ({n})',
    'Show fewer': 'අඩුවෙන් පෙන්වන්න',
    'Share PDF': 'PDF බෙදාගන්න',
    'Download CSV': 'CSV බාගන්න',
    'Refresh': 'යාවත්කාලීන කරන්න',
    'Shared.': 'බෙදාගන්නා ලදි.',
    'Your file is ready. Check your downloads.': 'ඔබේ ගොනුව සූදානම්. බාගැනීම් බලන්න.',
    'Updated just now.': 'දැන් යාවත්කාලීන කළා.',
    'Sharing is not available here, so the file was saved instead.': 'මෙහි බෙදාගැනීම නොමැති නිසා ගොනුව සුරැකිණි.',
    'Pay {amount} to your lender ({ref})': 'ඔබේ ණයදෙන්නාට {amount} ගෙවන්න ({ref})',
    'Interest of {amount} expected ({ref})': '{amount} ක පොලියක් බලාපොරොත්තු වේ ({ref})',
    'Reminder from your WealthFlow statement. Quote the reference {ref} when you pay.': 'ඔබේ WealthFlow ප්‍රකාශයෙන් සිහිකැඳවීමකි. ගෙවන විට යොමු අංකය {ref} සඳහන් කරන්න.',

    /* titles and the small screens */
    'Your WealthFlow statement': 'ඔබේ WealthFlow ප්‍රකාශය',
    'Link not valid': 'සබැඳිය වලංගු නැත',
    'This link is not valid': 'මෙම සබැඳිය වලංගු නැත',
    'One moment': 'මොහොතක් රැඳී සිටින්න',
    'Checking for a session on this device...': 'මෙම උපාංගයේ සැසියක් තිබේදැයි පරීක්ෂා කරමින්...',

    /* what goes wrong (the page's own sentences, then the server's) */
    'Enter your NIC as 9 digits followed by V or X, or as 12 digits. If you have no Sri Lankan NIC, enter your passport or ID number.':
        'ඔබේ ජාතික හැඳුනුම්පත් අංකය ඉලක්කම් 9ක් සහ V හෝ X, නැතහොත් ඉලක්කම් 12ක් ලෙස ඇතුළත් කරන්න. ශ්‍රී ලාංකික හැඳුනුම්පතක් නොමැති නම් ගමන් බලපත්‍ර හෝ හැඳුනුම්පත් අංකය ඇතුළත් කරන්න.',
    'Enter the 6-digit code from the text message.': 'කෙටි පණිවිඩයේ ඇති ඉලක්කම් 6ක කේතය ඇතුළත් කරන්න.',
    'Could not reach the server. Check your connection and try again.': 'සේවාදායකයට සම්බන්ධ විය නොහැකි විය. ඔබේ සම්බන්ධතාව පරීක්ෂා කර නැවත උත්සාහ කරන්න.',
    'Something went wrong. Please try again.': 'යම් දෝෂයක් සිදු විය. කරුණාකර නැවත උත්සාහ කරන්න.',
    'Could not prepare the PDF. Please try again.': 'PDF එක සූදානම් කළ නොහැකි විය. කරුණාකර නැවත උත්සාහ කරන්න.',
    'This link is not valid. Please use the link in your text message.': 'මෙම සබැඳිය වලංගු නැත. කරුණාකර ඔබේ කෙටි පණිවිඩයේ ඇති සබැඳිය භාවිතා කරන්න.',
    'Your session has ended. Please sign in again.': 'ඔබේ සැසිය අවසන් වී ඇත. කරුණාකර නැවත පිවිසෙන්න.',
    'You have been signed out.': 'ඔබ පිටවී ඇත.',
    'If those details match our records, a 6-digit code is on its way to the mobile number we hold. It expires in 3 minutes.':
        'එම විස්තර අපගේ වාර්තාවලට ගැළපේ නම්, අප සතුව ඇති ජංගම දුරකථන අංකයට ඉලක්කම් 6ක කේතයක් එවනු ලැබේ. එය මිනිත්තු 3කින් කල් ඉකුත් වේ.',
    'The details or the code are not valid, or the code has expired. Request a new code and try again.':
        'විස්තර හෝ කේතය වලංගු නැත, නැතහොත් කේතය කල් ඉකුත් වී ඇත. නව කේතයක් ඉල්ලා නැවත උත්සාහ කරන්න.',
    'Too many attempts. Please wait a while and try again.': 'උත්සාහ කිරීම් ඕනෑවට වඩා වැඩියි. කරුණාකර මද වේලාවක් රැඳී සිට නැවත උත්සාහ කරන්න.',
    'Too many codes have been requested. Please try again later.': 'කේත ඉල්ලීම් ඕනෑවට වඩා වැඩියි. කරුණාකර පසුව නැවත උත්සාහ කරන්න.',
    'Codes are temporarily unavailable. Please try again later.': 'කේත යැවීම තාවකාලිකව නොමැත. කරුණාකර පසුව නැවත උත්සාහ කරන්න.',
    'This service is temporarily unavailable. Please try again later.': 'මෙම සේවාව තාවකාලිකව නොමැත. කරුණාකර පසුව නැවත උත්සාහ කරන්න.',
    'Try again in about {n} minutes.': 'මිනිත්තු {n}කින් පමණ නැවත උත්සාහ කරන්න.',
    'Try again in {n} seconds.': 'තත්පර {n}කින් නැවත උත්සාහ කරන්න.',

    /* the redesigned page: the section bar, the balance card, the sign-in promises */
    'Overview': 'සාරාංශය',
    'Records': 'වාර්තා',
    'Sections': 'කොටස්',
    'Quick actions': 'ඉක්මන් ක්‍රියා',
    'Hide amounts': 'මුදල් සඟවන්න',
    'Show amounts': 'මුදල් පෙන්වන්න',
    'Code sent by text message': 'කේතය කෙටි පණිවිඩයෙන් එවයි',
    'Closes by itself after 20 minutes': 'මිනිත්තු 20කට පසු ස්වයංක්‍රීයව වැසේ',
    'Nothing is saved on your device': 'ඔබේ උපාංගයේ කිසිවක් සුරකින්නේ නැත',
});

/** The text that goes on the language button: the language you would switch TO, in its own letters. */
export const LANG_BUTTON = Object.freeze({ en: 'සිංහල', si: 'English' });

/** Fills {name} places. A missing value leaves the place as it is, never "undefined". */
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));

/** A translator for one language. English text is the key, so English needs no table. */
export function makeT(lang) {
    const table = lang === 'si' ? SI : null;
    return (text, vars) => fill(table && Object.prototype.hasOwnProperty.call(table, text) ? table[text] : text, vars);
}

export default { LANGS, SI, LANG_BUTTON, detectLang, makeT, fill };
