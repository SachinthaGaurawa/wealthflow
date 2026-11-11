/* =============================================================================
 * wf-redact.mjs — what of a user's own words may be shown to the public
 * -----------------------------------------------------------------------------
 * firestore.rules makes system/* readable by everybody (the app reads the update pill and
 * the feedback board from it without signing in). release-brain.js writes the first 240
 * characters of a real user's feedback into system/feedbackPriority (`sample`) and into
 * system/pendingRelease (`notes`, `proposedChanges`). Anyone could read them with the public
 * web key and no sign-in. People paste account numbers, phone numbers and e-mail addresses
 * into a bug report.
 *
 * This removes what identifies a person or an account and leaves the sentence readable,
 * so the board and the release notes still say what the problem is. The `key` fingerprint
 * of a cluster is computed from the ORIGINAL text before this runs and is not changed
 * (clients match a decision to an issue by that key).
 *
 * Pure and dependency-free: imported by release-brain.js (a Vercel function).
 * ===========================================================================*/

const RULES = [
    [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[email]'],
    [/\b(?:https?:\/\/|www\.)\S+/gi, '[link]'],
    // a long run of letters and digits is a key or token, whatever it is made of (before the digit rules split it)
    [/\b[A-Za-z0-9_-]{28,}\b/g, '[token]'],
    // a phone or account number written with spaces, dashes, dots or a leading +
    [/\+?\d[\d\s().-]{6,}\d/g, '[number]'],
    // any run of four or more digits (card, account, reference, OTP); amounts under 1,000 stay readable
    [/\d{4,}/g, '[number]'],
];

/** `text` with e-mail addresses, links, long numbers and long tokens replaced by a tag. */
export function redactText(text) {
    let s = String(text == null ? '' : text);
    // keep "Rs. 15,000" / "1,250,000.50": a comma-grouped amount reads as money and identifies nobody
    const amounts = [];
    s = s.replace(/\b\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?\b/g, (m) => { amounts.push(m); return '\u0001' + (amounts.length - 1) + '\u0002'; });
    for (const [re, tag] of RULES) s = s.replace(re, tag);
    return s.replace(/\u0001(\d+)\u0002/g, (_, i) => amounts[Number(i)]);
}

/** The clusters as the public may see them: the same objects, with `sample` redacted. */
export function publicClusters(clusters) {
    return (clusters || []).map((c) => (c && typeof c === 'object' ? { ...c, sample: redactText(c.sample) } : c));
}
