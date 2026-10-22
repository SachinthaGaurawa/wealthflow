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
    'Verify your identity': 'ඔබේ අනන්‍යතාව තහවුරු කරන්න',
    'NIC or passport / ID number': 'ජාතික හැඳුනුම්පත් අංකය, හෝ ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකය',
    'We will send a 6-digit verification code by text message to the mobile number your lender holds for you.':
        'ඔබේ ණය දෙන්නා සතුව ඇති ඔබේ ජංගම දුරකථන අංකයට ඉලක්කම් 6ක තහවුරු කිරීමේ කේතයක් කෙටි පණිවිඩයෙන් එවනු ඇත.',
    'If you do not have a Sri Lankan NIC, enter your passport or ID number.': 'ඔබට ශ්‍රී ලාංකික ජාතික හැඳුනුම්පතක් නොමැති නම්, ගමන් බලපත්‍ර හෝ හැඳුනුම්පත් අංකය ඇතුළත් කරන්න.',
    'Verify and continue': 'තහවුරු කර ඉදිරියට යන්න',
    'Verifying details...': 'විස්තර තහවුරු කරමින්...',
    'Your statement is displayed only after the verification code is entered. The link alone does not give access to any information.':
        'තහවුරු කිරීමේ කේතය ඇතුළත් කළ පසු පමණක් ඔබේ ප්‍රකාශය පෙන්වයි. සබැඳිය පමණක් භාවිතයෙන් කිසිදු තොරතුරකට ප්‍රවේශ විය නොහැක.',

    /* the code screen */
    'Enter verification code': 'තහවුරු කිරීමේ කේතය ඇතුළත් කරන්න',
    'Verification code': 'තහවුරු කිරීමේ කේතය',
    '6-digit verification code': 'ඉලක්කම් 6ක තහවුරු කිරීමේ කේතය',
    'Verify code': 'කේතය තහවුරු කරන්න',
    'Verifying code...': 'කේතය තහවුරු කරමින්...',
    'Change details': 'විස්තර වෙනස් කරන්න',
    'Resend code': 'කේතය නැවත එවන්න',
    'Resend code in {n}s': 'තත්පර {n}කින් කේතය නැවත එවන්න',
    'This code expires in {t}.': 'මෙම කේතය {t} කින් කල් ඉකුත් වේ.',
    'This code has expired. Please request a new one.': 'මෙම කේතය කල් ඉකුත් වී ඇත. කරුණාකර නව කේතයක් ඉල්ලන්න.',
    'No message after a minute? Check that the number above is still yours. If it is not, ask your lender to update it. Otherwise, resend the code.':
        'මිනිත්තුවකට පසුත් පණිවිඩයක් නොලැබුණාද? ඉහත අංකය තවමත් ඔබේ එකක්දැයි පරීක්ෂා කරන්න. එසේ නොවේ නම් එය යාවත්කාලීන කරන ලෙස ඔබේ ණය දෙන්නාගෙන් ඉල්ලන්න. එසේ නැතිනම් කේතය නැවත එවන්න.',
    'No message after a minute? Resend the code. If it still does not arrive, please contact your lender.':
        'මිනිත්තුවකට පසුත් පණිවිඩයක් නොලැබුණාද? කේතය නැවත එවන්න. එය තවමත් නොලැබෙන්නේ නම්, කරුණාකර ඔබේ ණය දෙන්නා අමතන්න.',
    'A new verification code has been sent. The previous code is no longer valid.': 'නව තහවුරු කිරීමේ කේතයක් යවා ඇත. පෙර කේතය තවදුරටත් වලංගු නොවේ.',

    /* sign-in answers (the details were wrong, the code went out) */
    'We sent a 6-digit code by text message to': 'ඉලක්කම් 6ක කේතයක් කෙටි පණිවිඩයෙන් යවා ඇත්තේ',
    'your mobile number ending in {digits}': 'අවසන් ඉලක්කම් {digits} වන ඔබේ ජංගම දුරකථන අංකයටයි',
    'We could not verify these details. Please check your NIC or passport / ID number, or contact the person who sent you this link.':
        'ඔබේ විස්තර තහවුරු කළ නොහැකි විය. කරුණාකර ඔබේ ජාතික හැඳුනුම්පත් හෝ ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකය පරීක්ෂා කරන්න, නැතහොත් මෙම සබැඳිය එවූ පුද්ගලයා අමතන්න.',
    'We cannot send a code for this link right now. Please contact the person who sent it to you.':
        'මෙම සබැඳිය සඳහා දැන් කේතයක් යැවිය නොහැක. කරුණාකර එය ඔබ වෙත එවූ පුද්ගලයා අමතන්න.',
    'Still not matching? Please use the same NIC or passport / ID number you gave the person who sent you this link. Several more incorrect attempts will pause this link for a while.':
        'තවමත් නොගැළපේද? මෙම සබැඳිය එවූ පුද්ගලයාට ඔබ ලබා දුන් ජාතික හැඳුනුම්පත් හෝ ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකයම භාවිතා කරන්න. තවත් වැරදි උත්සාහ කිහිපයකින් මෙම සබැඳිය මද වේලාවකට අවහිර වේ.',
    'Loan amount': 'ණය මුදල',
    'Disbursed': 'නිකුත් කළ මුදල',
    'Amount repaid': 'ආපසු ගෙවූ මුදල',

    /* the statement */
    'Your statement': 'ඔබේ ප්‍රකාශය',
    'Sign out': 'පිටවන්න',
    'As at {when}': '{when} වන විට',
    'Sri Lanka time': 'ශ්‍රී ලංකා වේලාව',
    'For your security, this session ends in {t}.': 'ඔබේ ආරක්ෂාව සඳහා මෙම සැසිය {t} කින් අවසන් වේ.',
    '{n} min': 'මිනිත්තු {n}',
    'Download PDF': 'PDF බාගන්න',
    'Preparing...': 'සූදානම් කරමින්...',
    'Print': 'මුද්‍රණය කරන්න',
    'Your PDF is ready. Please check your downloads.': 'ඔබේ PDF සූදානම්. කරුණාකර ඔබේ බාගැනීම් පරීක්ෂා කරන්න.',
    'Invested': 'ආයෝජනය',
    'Interest received': 'ලැබුණු පොලිය',
    'Loan outstanding': 'ඉතිරි ණය මුදල',
    'Investment': 'ආයෝජනය',
    'Loan': 'ණය',
    'Capital': 'ප්‍රාග්ධනය',
    'Interest rate': 'පොලී අනුපාතය',
    '{n}% per year': 'වසරකට {n}%',
    'Interest frequency': 'පොලී ගෙවීමේ වාර ගණන',
    'Monthly': 'මාසිකව',
    'Every 3 months': 'මාස 3කට වරක්',
    'Yearly': 'වාර්ෂිකව',
    'Interest per payment': 'ගෙවීමකට පොලිය',
    'Start date': 'ආරම්භක දිනය',
    'End date': 'අවසාන දිනය',
    'Next interest payment': 'ඊළඟ පොලී ගෙවීම',
    'Payments received, in {cur}': 'ලැබුණු ගෙවීම්, {cur} වලින්',
    'Month': 'මාසය',
    'Received on': 'ලැබුණු දිනය',
    'Amount': 'මුදල',
    'No payments have been recorded yet.': 'තවමත් ගෙවීම් සටහන් කර නැත.',
    'Repaid': 'ආපසු ගෙවූ මුදල',
    'Outstanding balance': 'ඉතිරි ශේෂය',
    'Repayment due by': 'ආපසු ගෙවිය යුතු දිනය',
    '{n} days ago': 'දින {n}කට පෙර',
    '1 day ago': 'දිනකට පෙර',
    'Transactions, in {cur}': 'ගනුදෙනු, {cur} වලින්',
    'Date': 'දිනය',
    'Balance': 'ශේෂය',
    'Loan disbursed': 'ණය මුදල නිකුත් කිරීම',
    'Additional advance': 'අමතර ණය මුදලක්',
    'Repayment': 'ආපසු ගෙවීම',
    'No transactions have been recorded yet.': 'තවමත් ගනුදෙනු සටහන් කර නැත.',
    'Settled': 'සම්පූර්ණයෙන් ගෙවා ඇත',
    'Closed': 'වසා ඇත',
    'Active': 'සක්‍රියයි',
    'Lender {n}': 'ණය දෙන්නා {n}',
    'There is nothing to display yet. Records added by your lender will appear here.':
        'තවමත් පෙන්වීමට කිසිවක් නැත. ඔබේ ණය දෙන්නා විසින් එක් කරන වාර්තා මෙහි පෙන්වයි.',
    'This statement is long, so only the first part is shown.': 'මෙම ප්‍රකාශය දිගු බැවින් පළමු කොටස පමණක් පෙන්වයි.',
    'Figures are as recorded by your lender. If anything appears incorrect, please contact your lender.':
        'සංඛ්‍යා ඔබේ ණය දෙන්නා සටහන් කර ඇති ආකාරයටම ය. යමක් වැරදි බවක් පෙනේ නම් කරුණාකර ඔබේ ණය දෙන්නා අමතන්න.',

    /* the PDF's own words (the page does not show these) */
    'Every investment and loan recorded for you by your lender is listed here under a reference code. Please quote the code when you contact your lender or make a payment.':
        'ඔබේ ණය දෙන්නා ඔබ වෙනුවෙන් සටහන් කර ඇති සෑම ආයෝජනයක් සහ ණයක්ම යොමු කේතයක් යටතේ මෙහි ලැයිස්තුගත කර ඇත. ඔබේ ණය දෙන්නා අමතන විට හෝ ගෙවීමක් කරන විට කරුණාකර එම කේතය සඳහන් කරන්න.',
    'Summary': 'සාරාංශය',
    'Figures are as recorded by your lender from the payments they have confirmed. This statement is for your own records and is not a substitute for your lender\'s own account. If anything appears incorrect, please contact your lender.':
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
    'Overdue by': 'ප්‍රමාද වී ඇති කාලය',
    'Account transactions ({n})': 'ගිණුම් ගනුදෙනු ({n})',
    'Transaction': 'ගනුදෙනුව',
    'Balance ({cur})': 'ශේෂය ({cur})',
    'Type': 'වර්ගය',
    'Total repaid ({n})': 'මුළු ආපසු ගෙවීම ({n})',
    'amount lent': 'ණයට දුන් මුදල',
    'amount repaid': 'ආපසු ලැබුණු මුදල',
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
    'Please pay by bank transfer to the account below and quote the reference of the record in the transfer. If these account details differ from what your lender told you, confirm with your lender before sending any money.':
        'කරුණාකර පහත ගිණුමට බැංකු හුවමාරුවෙන් ගෙවා, හුවමාරුවේ අදාළ වාර්තාවේ යොමු කේතය සඳහන් කරන්න. මෙහි ඇති ගිණුම් විස්තර ඔබේ ණය දෙන්නා ඔබට කී ඒවාට වඩා වෙනස් නම්, මුදල් යැවීමට පෙර ඔබේ ණය දෙන්නාගෙන් තහවුරු කරගන්න.',
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
    'Copying was not possible. Please select the text and copy it manually.': 'පිටපත් කිරීමට නොහැකි විය. කරුණාකර පෙළ තෝරා අතින් පිටපත් කරන්න.',

    /* what the person can do with the statement */
    'Upcoming': 'ඉදිරියේදී',
    'Loan repayment due': 'ණය ආපසු ගෙවීම නියමිතයි',
    'Interest payment due': 'පොලී ගෙවීම නියමිතයි',
    'Due today': 'අද නියමිතයි',
    'Due tomorrow': 'හෙට නියමිතයි',
    'In {n} days': 'දින {n}කින්',
    '1 day overdue': 'දවසක් ප්‍රමාදයි',
    '{n} days overdue': 'දින {n}ක් ප්‍රමාදයි',
    'Add to calendar': 'දින දර්ශනයට එක් කරන්න',
    'Balance over time': 'ශේෂය කාලයත් සමඟ',
    'Balance went from {from} to {to}': 'ශේෂය {from} සිට {to} දක්වා වෙනස් විය',
    'Repayment planner': 'ආපසු ගෙවීම් සැලසුම',
    'Payment frequency': 'ගෙවීමේ වාර ගණන',
    'Weekly': 'සතිපතා',
    'Fortnightly': 'සති 2කට වරක්',
    'Amount per payment': 'ගෙවීමකට මුදල',
    'Settle by the due date: {amount} per payment': 'නියමිත දිනට සම්පූර්ණයෙන් ගෙවීමට: ගෙවීමකට {amount}',
    'Enter an amount to see when the loan would be fully repaid.': 'ණය සම්පූර්ණයෙන් ආපසු ගෙවන දිනය බැලීමට මුදලක් ඇතුළත් කරන්න.',
    'That amount would need too many payments. Please try a larger amount.': 'එම මුදලට ගෙවීම් ඉතා වැඩි ගණනක් අවශ්‍ය වේ. කරුණාකර විශාල මුදලක් උත්සාහ කරන්න.',
    'Number of payments': 'ගෙවීම් ගණන',
    'First payment': 'පළමු ගෙවීම',
    'Fully repaid by': 'සම්පූර්ණයෙන් ආපසු ගෙවන දිනය',
    'Last payment': 'අවසන් ගෙවීම',
    'This plan completes by the due date.': 'මෙම සැලැස්ම නියමිත දිනට පෙර සම්පූර්ණ වේ.',
    'This plan completes after the due date. Increase the amount per payment to finish on time.': 'මෙම සැලැස්ම නියමිත දිනයෙන් පසුව සම්පූර්ණ වේ. නියමිත වේලාවට අවසන් කිරීමට ගෙවීමකට මුදල වැඩි කරන්න.',
    'Add plan to calendar': 'සැලැස්ම දින දර්ශනයට එක් කරන්න',
    '{n}% repaid': '{n}%ක් ආපසු ගෙවා ඇත',
    'Term: {n}% complete': 'කාලසීමාවෙන් {n}%ක් ගත වී ඇත',
    'Copy reference': 'යොමු අංකය පිටපත් කරන්න',
    'Show all {n}': 'සියල්ල පෙන්වන්න ({n})',
    'Show fewer': 'අඩුවෙන් පෙන්වන්න',
    'Share PDF': 'PDF බෙදාගන්න',
    'Download CSV': 'CSV බාගන්න',
    'Refresh': 'යාවත්කාලීන කරන්න',
    'PDF shared.': 'PDF බෙදාගන්නා ලදි.',
    'Your file is ready. Please check your downloads.': 'ඔබේ ගොනුව සූදානම්. කරුණාකර ඔබේ බාගැනීම් පරීක්ෂා කරන්න.',
    'Statement refreshed.': 'ප්‍රකාශය යාවත්කාලීන කරන ලදි.',
    'Sharing is not available on this device, so the file was saved instead.': 'මෙම උපාංගයේ බෙදාගැනීම නොමැති බැවින් ගොනුව සුරැකිණි.',
    'Payment of {amount} due to your lender ({ref})': 'ඔබේ ණය දෙන්නාට ගෙවිය යුතු {amount} ({ref})',
    'Interest payment of {amount} due ({ref})': '{amount} ක පොලී ගෙවීමක් නියමිතයි ({ref})',
    'Reminder from your WealthFlow statement. Please quote reference {ref} when you pay.': 'ඔබේ WealthFlow ප්‍රකාශයෙන් සිහිකැඳවීමකි. ගෙවන විට කරුණාකර යොමු අංකය {ref} සඳහන් කරන්න.',

    /* titles and the small screens */
    'Your WealthFlow statement': 'ඔබේ WealthFlow ප්‍රකාශය',
    'Link not valid': 'සබැඳිය වලංගු නැත',
    'This link is not valid': 'මෙම සබැඳිය වලංගු නැත',
    'Preparing your secure page': 'ඔබේ ආරක්ෂිත පිටුව සූදානම් කරමින්',
    'This is taking longer than usual. Thank you for your patience.': 'සාමාන්‍යයට වඩා වැඩි කාලයක් ගත වෙමින් පවතී. ඔබගේ ඉවසීමට ස්තූතියි.',

    /* what goes wrong (the page's own sentences, then the server's) */
    'Please enter a valid NIC (9 digits followed by V or X, or 12 digits), or your passport / ID number.':
        'කරුණාකර වලංගු ජාතික හැඳුනුම්පත් අංකයක් (ඉලක්කම් 9ක් සහ V හෝ X, නැතහොත් ඉලක්කම් 12ක්), නැතහොත් ඔබේ ගමන් බලපත්‍ර / හැඳුනුම්පත් අංකය ඇතුළත් කරන්න.',
    'Please enter the 6-digit verification code from your text message.': 'කරුණාකර ඔබේ කෙටි පණිවිඩයේ ඇති ඉලක්කම් 6ක තහවුරු කිරීමේ කේතය ඇතුළත් කරන්න.',
    'We could not connect to the server. Please check your internet connection and try again.': 'සේවාදායකයට සම්බන්ධ විය නොහැකි විය. කරුණාකර ඔබේ අන්තර්ජාල සම්බන්ධතාව පරීක්ෂා කර නැවත උත්සාහ කරන්න.',
    'Something went wrong. Please try again in a moment.': 'යම් දෝෂයක් සිදු විය. කරුණාකර මොහොතකින් නැවත උත්සාහ කරන්න.',
    'We could not prepare your PDF. Please try again.': 'ඔබේ PDF එක සූදානම් කළ නොහැකි විය. කරුණාකර නැවත උත්සාහ කරන්න.',
    'This link is not valid. Please use the link from your text message.': 'මෙම සබැඳිය වලංගු නැත. කරුණාකර ඔබේ කෙටි පණිවිඩයේ ඇති සබැඳිය භාවිතා කරන්න.',
    'Your session has ended. Please verify your identity again to continue.': 'ඔබේ සැසිය අවසන් වී ඇත. කරුණාකර දිගටම යාමට ඔබේ අනන්‍යතාව නැවත තහවුරු කරන්න.',
    'You have been signed out.': 'ඔබ පිටවී ඇත.',
    'A 6-digit verification code has been sent to the mobile number we hold for you. It expires in 3 minutes.':
        'ඉලක්කම් 6ක තහවුරු කිරීමේ කේතයක් අප සතුව ඇති ඔබේ ජංගම දුරකථන අංකයට යවා ඇත. එය මිනිත්තු 3කින් කල් ඉකුත් වේ.',
    'We could not verify that code. It may be incorrect or expired. Please check it, or request a new one.':
        'එම කේතය තහවුරු කළ නොහැකි විය. එය වැරදි හෝ කල් ඉකුත් වී තිබිය හැක. කරුණාකර එය පරීක්ෂා කරන්න, නැතහොත් නව කේතයක් ඉල්ලන්න.',
    'Too many attempts. For your security, please wait before trying again.': 'උත්සාහ කිරීම් ඕනෑවට වඩා වැඩියි. ඔබේ ආරක්ෂාව සඳහා කරුණාකර මද වේලාවක් රැඳී සිට නැවත උත්සාහ කරන්න.',
    'The limit for verification codes has been reached. Please try again later.': 'තහවුරු කිරීමේ කේත සඳහා සීමාව ළඟා වී ඇත. කරුණාකර පසුව නැවත උත්සාහ කරන්න.',
    'Verification codes are temporarily unavailable. Please try again later.': 'තහවුරු කිරීමේ කේත තාවකාලිකව නොමැත. කරුණාකර පසුව නැවත උත්සාහ කරන්න.',
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
    /* the colour theme button */
    'Light': 'ආලෝක',
    'Dark': 'අඳුරු',
    'Colour theme': 'වර්ණ තේමාව',
    'Verification code sent by text message': 'තහවුරු කිරීමේ කේතය කෙටි පණිවිඩයෙන් එවයි',
    'Session ends automatically after 20 minutes': 'මිනිත්තු 20කට පසු සැසිය ස්වයංක්‍රීයව අවසන් වේ',
    'Nothing is stored on your device': 'ඔබේ උපාංගයේ කිසිවක් ගබඩා නොකරයි',
});

/** The text that goes on the language button: the language you would switch TO, in its own letters. */
export const LANG_BUTTON = Object.freeze({ en: 'සිංහල', si: 'English' });

/** Fills {name} places. A missing value leaves the place as it is, never "undefined". */
export const fill = (text, vars) => String(text).replace(/\{(\w+)\}/g, (m, k) => (vars && Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));

/* The lender's note on a bank account is free text the owner typed, so it is not in the table above. In Sinhala the page shows, in this order:
 * the Sinhala note the owner wrote for the account, then a translation of the notes lenders write most (below), then the note as written. */
const NOTE_RULES = [
    [(n) => /\bnic\b|\bnational identity\b/.test(n) && /\breferences?\b|\bref\b/.test(n), 'කරුණාකර ගෙවීමේදී ඔබේ ජාතික හැඳුනුම්පත් අංකය ගෙවීමේ යොමුවේ ලියන්න.'],
    [(n) => /\b(slip|receipt)\b/.test(n) && /\b(send|share|forward|whatsapp|email|mail)\b/.test(n), 'කරුණාකර ගෙවීමෙන් පසු ගෙවුම් රිසිට්පත එවන්න.'],
    [(n) => /\b(call|phone|inform|notify|tell)\b/.test(n) && /\b(after|once|when)\b/.test(n) && /\b(pay|paid|payment|transfer)\b/.test(n), 'කරුණාකර ගෙවීම කළ පසු අපට දැනුම් දෙන්න.'],
];

/** The note on an account in the customer's language (see above). `account` is { note, noteSi? }. */
export function noteText(account, lang) {
    const a = account || {};
    const en = String(a.note == null ? '' : a.note);
    if (lang !== 'si') return en;
    if (a.noteSi) return String(a.noteSi);
    const n = en.toLowerCase().replace(/\bn\.\s*i\.\s*c\b\.?/g, 'nic').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
    if (n) for (const [test, si] of NOTE_RULES) if (test(n)) return si;
    return en;
}

/** A translator for one language. English text is the key, so English needs no table. */
export function makeT(lang) {
    const table = lang === 'si' ? SI : null;
    const t = (text, vars) => fill(table && Object.prototype.hasOwnProperty.call(table, text) ? table[text] : text, vars);
    t.lang = lang === 'si' ? 'si' : 'en';                     // lets a caller that only holds the translator (the page, the PDF) pick the right free-text variant
    return t;
}

export default { LANGS, SI, LANG_BUTTON, detectLang, makeT, fill, noteText };
