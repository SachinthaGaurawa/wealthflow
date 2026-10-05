/* =============================================================================
 * sms-access.mjs — who may spend the SMS balance
 * -----------------------------------------------------------------------------
 * The Text.lk account is ONE account with ONE balance, and WealthFlow can have many
 * people signed in. A signed-in user who turns the toggle on for a record whose phone
 * number is somebody else's would otherwise spend the owner's units, from the owner's
 * approved sender id, on a text with the owner's brand and a link in it: a spam and
 * phishing relay with a free sign-up. So sending is OFF for everybody until the
 * owner names who may use it:
 *
 *   SMS_ALLOWED_EMAILS   comma-separated, matched without regard to case, verified
 *                        Google/Firebase email addresses only (identify() refuses an
 *                        unverified one before this is asked)
 *
 * or a Firebase Auth custom claim `admin: true` (the same claim firestore.rules calls
 * isAdmin()). Unset and no claim: nobody. An unconfigured guard refuses everything.
 * ===========================================================================*/

const s = (v) => String(v == null ? '' : v);

export function allowedEmails(env = process.env) {
    return new Set(s(env && env.SMS_ALLOWED_EMAILS).split(/[\s,;]+/).map((e) => e.trim().toLowerCase()).filter(Boolean));
}

/** @returns {{ok:boolean, via?:string, reason?:string}} */
export function smsAllowed({ email, claims } = {}, env = process.env) {
    if (claims && claims.admin === true) return { ok: true, via: 'admin-claim' };
    const list = allowedEmails(env);
    if (!list.size) return { ok: false, reason: 'SMS notifications are not enabled on this deployment (no SMS_ALLOWED_EMAILS and no admin claim)' };
    return list.has(s(email).trim().toLowerCase()) ? { ok: true, via: 'allow-list' } : { ok: false, reason: 'SMS notifications are not enabled for this account' };
}

export default { allowedEmails, smsAllowed };
