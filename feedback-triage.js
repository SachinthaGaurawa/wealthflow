/*  feedback-triage.js  →  POST /api/feedback-triage   (Blueprint Phase 1)
 *
 *  Turns raw user feedback into a structured, actionable GitHub Issue automatically,
 *  so the autonomous pipeline can pick it up. Flow:
 *    user feedback text → EdenAI NLP classify (bug | ui | feature | other) + severity
 *                       → open a well-formatted GitHub Issue (labelled) via the
 *                         GitHub API, with a stable fingerprint to avoid duplicates.
 *
 *  ENV:
 *    EDENAI_API_KEY                 EdenAI (free tier) for classification
 *    GH_PAT / GITHUB_TOKEN /        token with `issues:write` on the repo
 *      GITHUB_MODELS_TOKEN          (any one)
 *    GITHUB_REPO or                 e.g. "SachinthaGaurawa/wealthflow"
 *      GITHUB_REPOSITORY
 *
 *  NOTE ON WHY THIS FILE MATTERED BUT DID NOTHING:
 *    This endpoint has existed all along and is the ONLY path by which user
 *    feedback becomes something the autonomous pipeline can act on — but no
 *    client code ever called it. Feedback went to Firestore plus an optional
 *    email and stopped there. wealthflow-update-system.js now POSTs here on
 *    every submission, and remembers the returned issue number so the app can
 *    report back when the work is finished (see /api/feedback-status).
 *
 *  Safety: input is length-capped and the model output is strictly parsed/validated
 *  (never trusted as code). If EdenAI is unavailable it falls back to a local
 *  keyword classifier so a feedback item is NEVER lost.
 */

import { createHash } from 'node:crypto';
import { resolveRepo, resolveToken, isValidRepo } from './github-repo.js';

const MAX_LEN = 2000;

const LABELS = { bug: 'bug', crash: 'bug', ui: 'ui/ux', feature: 'enhancement', security: 'security', other: 'triage' };

/** What the user actually picked in the Send Feedback dropdown. */
const DECLARED = { bug: 'bug', crash: 'crash', ui: 'ui', feature: 'feature', security: 'security', other: null };

/** Words that mean "this is not low priority", whoever wrote them. */
const URGENT_RE = /\b(critical|urgent|urgently|asap|immediately|emergency|severe|blocker|blocking|unusable|data loss|lost my|can'?t use)\b/i;

const SEV_RANK = { low: 0, medium: 1, high: 2, critical: 3 };

/**
 * Reconcile what the user DECLARED with what the text suggests.
 *
 * The dropdown value was sent by the client on every submission and read by
 * nothing. A real report — type "Bug report", body "…please fix that. Urgently
 * fix that issue. Critical issue." — was filed as [LOW] feature, because
 * localClassify tests the feature pattern (add|please|…) and the word "please"
 * matched before anything else was considered. The words "critical" and
 * "urgently" appeared nowhere in the classifier at all.
 *
 * So: a declared type beats a guessed one, because the person filing knows what
 * they meant; and explicit urgency raises severity whatever the type, because
 * someone writing "critical" is not filing a low-priority idea.
 */
function reconcile(cls, body) {
    const out = { type: cls.type, severity: cls.severity, summary: cls.summary };
    const declared = DECLARED[String((body && body.type) || '').toLowerCase().replace(/\s*report$/, '')];
    if (declared) { out.type = declared; out.declared = true; }

    const text = String((body && (body.text || body.feedback)) || '');
    if (URGENT_RE.test(text)) {
        out.urgentWords = true;
    }

    // EVERY PIECE OF USER FEEDBACK IS CRITICAL. Owner's directive, and it is
    // correct for this app rather than a blanket-priority mistake: WealthFlow
    // has exactly one user. A severity scale exists to decide whose report waits
    // while someone else's is handled first, and there is nobody to wait behind.
    // Everything the previous banding achieved was to let the owner's own
    // reports be quietly deprioritised — #66 sat five days at [LOW], #70 and #74
    // at [LOW] while one of them was a broken avatar the owner could see, and
    // #71 needed the literal words "very critical" to reach [HIGH].
    //
    // The TYPE is deliberately untouched. It still routes the work to the right
    // agent role (bug / ui / feature / security / crash) and still appears in
    // the issue. Only the priority floor moves, so nothing can be triaged
    // below the top band again.
    out.severity = 'critical';
    return out;
}

// local fallback classifier (used if EdenAI is unreachable) — keeps feedback flowing
function localClassify(text) {
    const t = (text || '').toLowerCase();
    if (/(leak|password|hack|breach|exposed|other user|privacy)/.test(t)) return { type: 'security', severity: 'critical' };
    if (/(crash|freeze|froze|white screen|black screen|stuck|won'?t open|broke)/.test(t)) return { type: 'crash', severity: 'critical' };
    if (/(bug|error|wrong|incorrect|fail|doesn'?t work|not working)/.test(t)) return { type: 'bug', severity: 'high' };
    if (/(slow|lag|ugly|confusing|hard to|unprofessional|kid|design|layout|color|font)/.test(t)) return { type: 'ui', severity: 'medium' };
    if (/(add|please|wish|would be|feature|option|support for|can you)/.test(t)) return { type: 'feature', severity: 'low' };
    return { type: 'other', severity: 'low' };
}

async function edenClassify(text) {
    const key = process.env.EDENAI_API_KEY;
    if (!key) return null;
    const prompt = [
        'Classify this app user feedback. Reply ONLY with compact JSON:',
        '{"type":"bug|crash|ui|feature|security|other","severity":"critical|high|medium|low","summary":"<=12 words"}',
        'Feedback: ' + text
    ].join('\n');
    try {
        const r = await fetch('https://api.edenai.run/v2/text/chat', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ providers: 'openai', text: prompt, temperature: 0, max_tokens: 120 })
        });
        if (!r.ok) return null;
        const data = await r.json();
        const out = data && (data.openai || Object.values(data)[0]);
        const raw = out && (out.generated_text || out.message || '');
        const m = String(raw).match(/\{[\s\S]*\}/);
        if (!m) return null;
        const parsed = JSON.parse(m[0]);
        // strict validation — never trust the model blindly
        const types = ['bug', 'crash', 'ui', 'feature', 'security', 'other'];
        const sevs = ['critical', 'high', 'medium', 'low'];
        if (!types.includes(parsed.type) || !sevs.includes(parsed.severity)) return null;
        return { type: parsed.type, severity: parsed.severity, summary: String(parsed.summary || '').slice(0, 120) };
    } catch (_) { return null; }
}

/**
 * Words that carry no information about WHICH report this is. Keeping them made
 * the fingerprint mostly stopwords: "the please fix that issue" is the opening
 * of half the reports anyone writes, so two genuinely different complaints
 * collided and the second was silently folded into the first's issue — and the
 * user was told it had been filed.
 */
const STOP = new Set(['the', 'and', 'that', 'this', 'you', 'your', 'for', 'with', 'not', 'but', 'are', 'was',
    'can', 'has', 'have', 'its', 'from', 'they', 'them', 'please', 'fix', 'issue', 'now', 'when', 'what',
    'why', 'how', 'all', 'any', 'app', 'very', 'really', 'just', 'need', 'want', 'should', 'would', 'could']);

/**
 * GitHub refuses a label name longer than this with 422 Validation Failed, and
 * it refuses the WHOLE issue along with it. Verified against the live API:
 *   50 chars -> HTTP 201
 *   51 chars -> HTTP 422
 *              {"resource":"Label","field":"name",
 *               "message":"name is too long (maximum is 50 characters)"}
 */
export const LABEL_MAX = 50;

/**
 * What GitHub actually objected to.
 *
 * This used to be `created.message` alone, which for a 422 is the single word
 * pair "Validation Failed" — true, and useless. GitHub puts the reason in an
 * `errors[]` array, and throwing it away is why the owner's screenshot said
 * only "GitHub refused to create the issue (HTTP 422): Validation Failed" while
 * the response itself was carrying
 *   {"field":"name","message":"name is too long (maximum is 50 characters)"}
 *
 * A failure that cannot say what it objected to is the same silent-failure
 * class this pipeline keeps producing, one layer down: the diagnosis was
 * available, transmitted, and discarded before anyone could read it.
 */
export function githubDetail(body) {
    const msg = (body && body.message) || '';
    const errs = (body && Array.isArray(body.errors)) ? body.errors : [];
    if (!errs.length) return msg;
    const parts = errs.slice(0, 4).map((e) => {
        if (!e || typeof e !== 'object') return String(e);
        const where = [e.resource, e.field].filter(Boolean).join('.');
        const why = e.message || e.code || '';
        return where ? `${where}: ${why}` : why;
    }).filter(Boolean);
    return parts.length ? `${msg} — ${parts.join('; ')}` : msg;
}

/** GitHub's issue-title ceiling; above it the whole issue is refused with 422. */
export const TITLE_MAX = 256;

/** Keep a title inside GitHub's limit without cutting mid-word where avoidable. */
export function clampTitle(s) {
    const t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    if (t.length <= TITLE_MAX) return t;
    const cut = t.slice(0, TITLE_MAX - 1);
    const sp = cut.lastIndexOf(' ');
    return (sp > TITLE_MAX - 40 ? cut.slice(0, sp) : cut) + '…';
}

/** Short, stable digest — enough to keep two truncated fingerprints apart. */
function digest(text) {
    return createHash('sha1').update(String(text || '')).digest('hex').slice(0, 8);
}

/**
 * A stable label that identifies a report, so repeats deduplicate.
 *
 * THE BUG THIS SHAPE FIXES
 * This used to be `'fb-' + words.join('-').slice(0, 60)` — the cap was applied
 * to the joined words and the `fb-` prefix added AFTERWARDS, so the label could
 * reach 63 characters, and it was measured against 60 rather than GitHub's real
 * limit of 50. Any report whose first eight significant words joined to more
 * than 47 characters produced an over-long label, GitHub rejected the entire
 * issue with 422, and the owner's feedback was saved but never became a work
 * item. Two earlier reports survived only because they happened to be short
 * (38 and 12 characters).
 *
 * Truncating alone would be a different bug: two unrelated long reports would
 * collide on the same prefix and the second would be silently deduplicated
 * away. So when truncation is needed, a digest of the FULL text is appended —
 * the label stays inside the limit and still tells the reports apart.
 */
function fingerprint(text) {   // exported in the list at the foot of this file
    // `(text || '')` kept a truthy NON-STRING as-is, so a payload of
    // {"text": 123} reached .toLowerCase() and threw, taking the whole triage
    // request down with it. Found by the junk-input case in
    // test/feedback_intake_limits_test.js, not in production — but it was
    // reachable from any client that got the field type wrong.
    const words = String(text == null ? '' : text).toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/)
        .filter(w => w.length > 2 && !STOP.has(w))
        .slice(0, 8);
    // Too little left to identify anything. Deduplicating on two generic words
    // would merge unrelated reports, and losing a distinct report is far worse
    // than filing a duplicate — so this one deliberately never matches.
    if (words.length < 3) return 'fb-x' + Math.random().toString(36).slice(2, 10);

    const full = 'fb-' + words.join('-');
    if (full.length <= LABEL_MAX) return full;

    const d = digest(text);
    return full.slice(0, LABEL_MAX - d.length - 1).replace(/-+$/, '') + '-' + d;
}

async function githubGet(repo, token, path) {
    const r = await fetch('https://api.github.com/repos/' + repo + path, {
        headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'wealthflow-triage' }
    });
    return r.ok ? r.json() : null;
}

function ghHeaders(token) {
    return {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'wealthflow-triage'
    };
}

/* Both return null rather than throwing. Recording a recurrence is strictly a
 * bonus on top of "the report was received": a GitHub hiccup here must never
 * turn a successful dedup into an error the user sees. */
async function githubPost(repo, token, path, body) {
    try {
        const r = await fetch('https://api.github.com/repos/' + repo + path,
            { method: 'POST', headers: ghHeaders(token), body: JSON.stringify(body) });
        return r.ok ? r.json() : null;
    } catch (_) { return null; }
}

async function githubPatch(repo, token, path, body) {
    try {
        const r = await fetch('https://api.github.com/repos/' + repo + path,
            { method: 'PATCH', headers: ghHeaders(token), body: JSON.stringify(body) });
        return r.ok ? r.json() : null;
    } catch (_) { return null; }
}

export default async function handler(req, res) {
    const out = { ok: true };
    let body = req && req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const text = String(body.text || body.feedback || '').trim().slice(0, MAX_LEN);
    const diagnostics = body.diagnostics && typeof body.diagnostics === 'object' ? body.diagnostics : null;
    // The client has always sent this; nothing here ever read it, so every
    // screenshot a user attached was transmitted and then thrown away.
    const image = typeof body.image === 'string' ? body.image : '';
    const repo = resolveRepo();
    const { token, source: tokenSource } = resolveToken();

    // Booleans only — never a value, never a prefix, never a length. Enough to tell
    // "the deployment has no token" apart from "the token is wrong" from a browser,
    // without turning a diagnostic into a credential leak.
    //
    // Computed BEFORE the empty-text check on purpose: a POST with no text now
    // files nothing, creates nothing, and answers the one question that otherwise
    // needs a real bug report to ask — is this deployment able to file at all?
    // A zero-side-effect health check for the whole pipeline.
    // `repoName` and `tokenSource` are diagnostics, not credentials: one is the
    // repository slug (already public in the deployment's git metadata) and the
    // other is a VARIABLE NAME. Neither is a value, a prefix, or a length. They
    // are here because "HTTP 404: Not Found" on its own is unactionable — it
    // cannot distinguish a malformed repo string from a token that is not
    // authorised, and guessing between the two is what cost several rounds.
    out.configured = {
        repo: !!repo, token: !!token,
        repoName: repo || null,
        repoLooksValid: repo ? isValidRepo(repo) : null,
        tokenSource: tokenSource,
    };

    // Every non-2xx this endpoint returns carries a `reason` the app can show the
    // user verbatim. This one was the exception, which meant an empty report was
    // rejected in a shape the client had nothing to display.
    if (!text) {
        out.ok = false;
        out.error = 'no_text';
        out.reason = 'the report arrived with no text in it.';
        return send(res, out, 400);
    }

    // classify (EdenAI, with safe local fallback)
    const cls = reconcile((await edenClassify(text)) || localClassify(text), body);
    out.classification = cls;

    if (!repo || !token) {
        // THE SILENT DROP THIS ENDPOINT USED TO PERFORM.
        //
        // It returned HTTP 200 with ok:true and a `note` nobody read, so the app
        // showed a success confirmation for a request that created nothing. A
        // user's bug report was accepted, classified, and dropped — and every
        // signal available said it worked.
        //
        // Reporting success for work not done is the failure this project keeps
        // finding in itself: a test job that ran no tests and exited 0, an
        // auto-merge gate keyed to a label nothing applied, a schedule six times
        // over its allowance. Machinery present, signal absent, everything green.
        //
        // 503 is deliberate: the request was valid and the server is simply not
        // configured to fulfil it. That is a server-side gap the caller can neither
        // cause nor fix by retrying, and it must never read as success.
        out.ok = false;
        out.error = 'not_configured';
        const missing = [];
        if (!repo) missing.push('GITHUB_REPO');
        if (!token) missing.push('a GitHub token');
        out.reason = 'This deployment cannot file issues: ' + missing.join(' and ')
            + ' is missing from the server environment. Your feedback was saved locally and will be retried.';
        return send(res, out, 503);
    }

    // de-dup: if an issue with the same fingerprint label exists, comment instead of duplicating
    const fp = fingerprint(text);
    // WHY state=all AND NOT state=open
    // This asked for OPEN issues only. So a problem reported again AFTER its
    // issue was closed found nothing, and filed a brand-new issue — losing the
    // link to the history of the first one, and hiding the single most valuable
    // signal user feedback can carry: THE FIX DID NOT HOLD. The recurrence read
    // as an unrelated first report.
    //
    // Closed issues are not all the same, though, and this is why the fix is not
    // simply `state=all` with the existing dedup:
    //   · closed as `completed`  -> we claimed to fix it and it came back.
    //                               Reopen. That is a regression, not a new bug.
    //   · closed as `not_planned`-> we declined it deliberately. Record the
    //                               recurrence, but do NOT reopen: resurrecting
    //                               a decision every time someone re-reports is
    //                               exactly the churn this pipeline exists to
    //                               eliminate.
    const existing = await githubGet(repo, token, '/issues?state=all&labels=' + encodeURIComponent(fp));
    if (Array.isArray(existing) && existing.length) {
        // Prefer an open issue when one exists; otherwise take the newest closed.
        const open = existing.filter(function (i) { return i.state === 'open'; });
        const hit = open.length ? open[0] : existing[0];
        out.deduped = hit.number;

        if (hit.state === 'open') {
            // NOT a drop: this feedback is already tracked by an open issue, so
            // the user's report is represented. Named explicitly so it can never
            // be confused with the not-configured case above.
            out.reason = 'Already tracked by issue #' + hit.number + '.';
            return send(res, out, 200);
        }

        const regressed = hit.state_reason !== 'not_planned';
        out.recurrence = true;
        out.reopened = false;

        const noted = await githubPost(repo, token, '/issues/' + hit.number + '/comments', {
            body: '### Reported again\n\n'
                + 'This was closed as `' + (hit.state_reason || 'completed') + '` and has been reported again '
                + 'through the in-app feedback form.\n\n'
                + (regressed
                    ? '_Reopened automatically: a fix that was shipped has not held._'
                    : '_Left closed: this was declined deliberately. Recording the recurrence only._')
        });
        out.recurrenceNoted = !!noted;

        if (regressed) {
            const r = await githubPatch(repo, token, '/issues/' + hit.number, { state: 'open', state_reason: 'reopened' });
            out.reopened = !!r;
        }

        // THE REASON MUST DESCRIBE WHAT ACTUALLY HAPPENED.
        // The first draft said "was reopened" whenever `regressed` was true —
        // computed from the issue's state_reason, NOT from whether the PATCH
        // succeeded. githubPatch swallows its errors and returns null, so a
        // failed reopen still reported success to the user, and `out.reopened`
        // sat next to it saying false. Caught by the consensus board's security
        // reviewer flagging silent failure in these helpers.
        //
        // That is this repository's signature defect — an action reported as
        // done because the code MEANT to do it — and it is not allowed in the
        // one endpoint whose whole job is telling the owner the truth about
        // their feedback.
        out.reason = !regressed
            ? 'Already decided on issue #' + hit.number
                + (out.recurrenceNoted ? '; the recurrence has been recorded.' : '. Recording the recurrence failed — it is still tracked there.')
            : out.reopened
                ? 'Issue #' + hit.number + ' was reopened — this problem came back.'
                : 'Issue #' + hit.number + ' tracks this and it has come back, but reopening it failed. It needs a human.';
        return send(res, out, 200);
    }

    const labelType = LABELS[cls.type] || 'triage';
    // GitHub caps an issue title at 256 characters and answers 422 above it,
    // refusing the whole issue exactly as an over-long label does. cls.summary
    // comes from the classifier and is not length-bounded at the source, so it
    // is bounded here — the same defect class as the label, found while
    // auditing the rest of this payload rather than after it bit.
    const title = clampTitle('[' + String(cls.severity || 'low').toUpperCase() + '] ' + (cls.summary || text.slice(0, 60)));
    const issueBody = [
        '## Autonomous feedback issue',
        '',
        '**Type:** ' + cls.type + '  ·  **Severity:** ' + cls.severity +
            (body.version ? '  ·  **App version:** ' + String(body.version).slice(0, 20) : ''),
        '',
        '### User feedback',
        '> ' + text.replace(/\n/g, '\n> '),
        '',
        // The "send system diagnosis" tick used to attach only the user-agent and
        // screen size. It now sends the recorded errors, stack traces and health
        // snapshot, and they are rendered here so the fix agent can read them —
        // otherwise the diagnostics would be collected and then discarded.
        diagnosticsSection(diagnostics),
        // A screenshot shows what the user was actually looking at, which is
        // often the whole report. It goes after the diagnosis so the readable
        // parts come first and the base64 is last.
        imageSection(image),
        '_Filed automatically by the feedback triage agent. The autonomous pipeline picks this up ' +
        'on the `issues: opened` trigger, so work starts within minutes._'
    ].filter(Boolean).join('\n');

    try {
        const r = await fetch('https://api.github.com/repos/' + repo + '/issues', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'wealthflow-triage' },
            body: JSON.stringify({ title: title, body: issueBody, labels: [labelType, fp, 'autonomous', 'user-feedback'] })
        });
        const created = await r.json();
        if (r.ok) {
            out.issue = created.number;
            out.reason = 'Filed as issue #' + created.number + '.';
        } else {
            out.ok = false;
            out.error = 'github_create_failed';
            out.status = r.status;
            out.detail = githubDetail(created);
            if (r.status === 401 || r.status === 403) {
                // The token exists but cannot write here — a different problem
                // from a missing token, and one `configured` alone cannot show.
                out.reason = 'The GitHub token is present but not authorised to create issues on ' + repo + '.';
            } else if (r.status === 404) {
                out.reason = await explain404(repo, token, tokenSource, out);
            } else {
                out.reason = 'GitHub refused to create the issue (HTTP ' + r.status + '): ' + String(out.detail).slice(0, 160);
            }
        }
    } catch (e) {
        out.ok = false;
        out.error = 'network';
        out.reason = 'Could not reach GitHub: ' + String(e.message).slice(0, 160);
    }

    return send(res, out, out.ok ? 200 : 502);
}


/**
 * Turn GitHub's most ambiguous status into a specific instruction.
 *
 * WHY A 404 HERE MEANS FOUR DIFFERENT THINGS
 *   GitHub deliberately answers 404 — never 403 — when a token is not authorised
 *   for a repository, so that private repository names cannot be probed by
 *   watching status codes. The consequence is that ONE status covers:
 *
 *     a) the repo string is malformed, so the URL points nowhere;
 *     b) the repository genuinely does not exist;
 *     c) the token is valid but has no access to THIS repository
 *        (the usual cause: a fine-grained PAT whose "Repository access" list
 *        does not include it, or GITHUB_MODELS_TOKEN, which is issued for model
 *        inference and carries no repository permission at all);
 *     d) the repository exists and is readable, but Issues are disabled.
 *
 *   "GitHub refused to create the issue (HTTP 404): Not Found" is true and
 *   useless. One extra GET separates (c) from (d) and names the fix, and the
 *   shape of the repo string separates (a) before any request is made.
 *
 * Never throws: a diagnosis that fails must not replace a real error with a
 * crash, so every path still returns a usable sentence.
 */
export async function explain404(repo, token, tokenSource, out) {
    const where = 'https://github.com/settings/personal-access-tokens';
    if (!isValidRepo(repo)) {
        return 'the repository is configured as "' + String(repo).slice(0, 80)
            + '", which is not a valid owner/name pair, so the GitHub URL points nowhere.';
    }
    let probe = null;
    try {
        probe = await fetch('https://api.github.com/repos/' + repo, {
            headers: { 'Authorization': 'Bearer ' + token, 'Accept': 'application/vnd.github+json', 'User-Agent': 'wealthflow-triage' },
        });
    } catch (_) { /* fall through to the generic answer below */ }

    if (probe && probe.ok) {
        let meta = null;
        try { meta = await probe.json(); } catch (_) {}
        if (meta && meta.has_issues === false) {
            if (out) out.diagnosis = 'issues_disabled';
            return 'Issues are turned off for ' + repo
                + '. Enable them in the repository\'s Settings → General → Features → Issues.';
        }
        if (out) out.diagnosis = 'token_cannot_write_issues';
        return 'the token can read ' + repo + ' but may not create issues on it. Grant it the '
            + '"Issues: Read and write" permission (fine-grained PAT) or the `repo` scope (classic), at ' + where + '.';
    }

    if (probe && (probe.status === 404 || probe.status === 401 || probe.status === 403)) {
        if (out) out.diagnosis = 'token_cannot_see_repo';
        return 'the token cannot see ' + repo + ' at all — GitHub answers 404 rather than 403 for an '
            + 'unauthorised repository. The token in use came from ' + (tokenSource || 'an unknown variable')
            + (tokenSource === 'GITHUB_MODELS_TOKEN'
                ? ', which is a GitHub Models inference token and carries NO repository permission — set GH_PAT instead.'
                : '. Check that this token lists ' + repo + ' under Repository access and grants "Issues: Read and write", at ' + where + '.');
    }

    if (out) out.diagnosis = 'unknown_404';
    return 'GitHub returned 404 for ' + repo + ' and the follow-up check was inconclusive. '
        + 'The token came from ' + (tokenSource || 'an unknown variable')
        + '; verify it lists that repository under Repository access with "Issues: Read and write".';
}

/** Marker the fix agent looks for to find an attached screenshot. */
export const IMAGE_MARKER = 'wf-feedback-image';

/**
 * Characters of the 65,536-byte issue body reserved for an attached screenshot.
 *
 * GitHub REJECTS a body over 65,536 characters outright, so an oversized image
 * would not merely fail to attach — it would lose the entire report, text and
 * diagnostics included. The budget leaves ample room for the feedback, the
 * diagnosis table and the stack traces.
 */
export const IMAGE_BUDGET = 44000;

/**
 * Render an attached screenshot so the fix agent can actually see it.
 *
 * THE BUG THIS FIXES
 *   The client has always captured a screenshot, downscaled it to 900px, and
 *   sent it as `image` in the payload — the attach button, the preview and the
 *   remove control are all there and all work. This endpoint simply never read
 *   the field. The image was transmitted on every report and discarded on
 *   arrival, so the AI genuinely never saw a single screenshot: the one piece of
 *   evidence that shows what the user was actually looking at.
 *
 * WHY THE IMAGE IS EMBEDDED AS A DATA URL RATHER THAN A MARKDOWN IMAGE
 *   GitHub does not render `data:` URIs in markdown, so `![](data:image/…)`
 *   would display nothing however well-formed. The purpose here is machine
 *   consumption: the fix agent reads the issue BODY as text, extracts this
 *   block, and can pass it to the vision endpoint. It stays inside <details> so
 *   a human reading the issue is not scrolled past 40,000 characters of base64,
 *   and the note explains how to view it.
 */
export function imageSection(image) {
    const src = typeof image === 'string' ? image.trim() : '';
    if (!src) return '';

    // Only real, self-contained raster data. Anything else — a remote URL, an
    // SVG (which can carry script), a malformed prefix — is refused rather than
    // pasted into an issue body that an autonomous agent will later read.
    if (!/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(src)) {
        return ['### Screenshot', '', '_An attachment was sent but was not a valid inline PNG/JPEG/WebP, so it was not attached._', ''].join('\n');
    }

    const approxKb = Math.round((src.length * 3) / 4 / 1024);
    if (src.length > IMAGE_BUDGET) {
        // Refusing beats truncating: half a base64 string is not an image, and
        // silently attaching a corrupt one wastes a vision call to learn that.
        return [
            '### Screenshot',
            '',
            `_A screenshot was attached (~${approxKb} KB) but exceeds the ${Math.round(IMAGE_BUDGET / 1024)} KB that fits in a GitHub issue body alongside the report, so it was not embedded. The full copy is in the Firestore \`feedback\` document._`,
            '',
        ].join('\n');
    }

    return [
        '### Screenshot',
        '',
        `_Attached by the user (~${approxKb} KB). Paste the data URL below into a browser address bar to view it._`,
        '',
        `<!-- ${IMAGE_MARKER} -->`,
        '<details><summary>Screenshot data URL (for the fix agent\'s vision pass)</summary>',
        '',
        '```',
        src,
        '```',
        '',
        '</details>',
        '',
    ].join('\n');
}

/**
 * Render the client's diagnostics into readable markdown.
 * Everything is length-capped: an issue body over 65,536 characters is rejected
 * by GitHub, which would silently lose the whole report.
 */
export function diagnosticsSection(d) {
    if (!d || typeof d !== 'object') return '';
    const L = ['### System diagnosis', ''];

    const facts = [
        ['App page', d.activePage], ['Device', d.ua], ['Screen', d.screen],
        ['Viewport', d.viewport], ['DPR', d.dpr], ['Language', d.lang],
        ['Timezone', d.tz], ['Installed as app', d.standalone], ['Online', d.online],
        ['DOM nodes', d.domNodes],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    if (facts.length) {
        L.push('| | |', '|---|---|');
        for (const [k, v] of facts) L.push('| ' + k + ' | ' + String(v).slice(0, 200) + ' |');
        L.push('');
    }

    if (d.detectedIssues && d.detectedIssues.length) {
        L.push('**The app detected these problems itself:**', '');
        for (const i of d.detectedIssues.slice(0, 12)) {
            const sev = (i && i.severity) ? i.severity.toUpperCase() : 'INFO';
            const msg = (i && (i.message || i.msg || i.title)) || JSON.stringify(i);
            L.push('- `' + sev + '` ' + String(msg).slice(0, 300));
        }
        L.push('');
    }

    if (d.errorSummary) {
        const es = d.errorSummary;
        L.push('**Error log:** ' + (es.total || 0) + ' total, ' + (es.fromThisBuild || 0) + ' on this build.', '');
        if (es.uniqueMessages && es.uniqueMessages.length) {
            for (const m of es.uniqueMessages.slice(0, 10)) L.push('- ' + String(m).slice(0, 250));
            L.push('');
        }
    }

    if (d.errors && d.errors.length) {
        L.push('<details><summary>Recent errors with stack traces</summary>', '');
        for (const e of d.errors.slice(0, 6)) {
            L.push('```', String(e.msg || '').slice(0, 300), String(e.stack || '').slice(0, 800), '```');
            L.push('_page: ' + (e.page || '?') + ' · build: ' + (e.ver || '?') + '_', '');
        }
        L.push('</details>', '');
    }

    if (d.health) {
        let h = '';
        try { h = JSON.stringify(d.health, null, 1).slice(0, 4000); } catch (_) { h = '(unserialisable)'; }
        L.push('<details><summary>Health snapshot</summary>', '', '```json', h, '```', '</details>', '');
    }

    if (d._trimmed) L.push('_(diagnostics were trimmed on the device to keep the payload small)_', '');
    return L.join('\n');
}

// exported for tests
// STOP is exported so anything comparing against a STORED fingerprint label can
// re-filter it through the CURRENT word set. Labels filed before a word was
// added to STOP contain that word forever, and the function no longer produces
// it — see the canonicalKey() note in autonomy/proposal-intake.mjs.
export { localClassify, fingerprint, LABELS, reconcile, URGENT_RE, STOP };

function send(res, obj, code) {
    const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
    try { if (res && res.status) { res.setHeader && Object.entries(headers).forEach(([k, v]) => res.setHeader(k, v)); res.status(code).json(obj); return; } } catch (_) {}
    return new Response(JSON.stringify(obj), { status: code, headers });
}
