/* =============================================================================
 * autonomy/work-queue.mjs — the autonomous system's work queue (GitHub Issues)
 * ---------------------------------------------------------------------------
 * WHY THIS REPLACES THE OLD FIRESTORE QUEUE
 *   The previous agent's ONLY source of work was Firestore `system/pendingRelease`,
 *   read via:
 *       JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
 *   FIREBASE_SERVICE_ACCOUNT was never set, so every scheduled run died in ~40ms
 *   with `Unexpected end of JSON input`, exited 78, and the workflow reported ✅.
 *   Verified in the Actions log for run 30200095048: the "Run the fix agent" step
 *   starts and completes on the same second, every two hours, forever.
 *
 *   GitHub Issues are strictly better here: free, always available inside Actions
 *   via the built-in GITHUB_TOKEN, durable, human-inspectable, and already the
 *   native input format for both Sentry Seer and claude-code-action.
 *
 *   Firestore is still supported as an OPTIONAL enrichment source — if the
 *   service account happens to be configured, its proposals are folded in. It is
 *   never required, and its absence can never again stall the pipeline.
 *
 * ENV
 *   GITHUB_TOKEN / GH_TOKEN / GITHUB_MODELS_TOKEN / GH_PAT   (any one)
 *   GITHUB_REPOSITORY  e.g. "SachinthaGaurawa/wealthflow"  (set by Actions)
 * ===========================================================================*/

const API = 'https://api.github.com';

/** Labels the pipeline uses to drive itself. */
export const LABELS = {
    autonomous: 'autonomous',      // filed by the pipeline
    inProgress: 'ai-working',      // claimed by an agent this run
    fixed: 'ai-fixed',             // a fix has been merged/shipped
    stuck: 'ai-stuck',             // agent gave up; needs a human
    feedback: 'user-feedback',     // came from the in-app feedback form
    security: 'security',
    bug: 'bug',
    ui: 'ui/ux',
    feature: 'enhancement',
};

/** Priority order the agent works in. Security and crashes first, always. */
const PRIORITY = ['critical', 'high', 'medium', 'low'];

export function tokenFrom(env = process.env) {
    return env.GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_MODELS_TOKEN || env.GH_PAT || null;
}

export function repoFrom(env = process.env) {
    return env.GITHUB_REPOSITORY || env.GITHUB_REPO || null;
}

async function gh(path, { method = 'GET', body, env = process.env } = {}) {
    const token = tokenFrom(env);
    const repo = repoFrom(env);
    if (!token) throw new Error('work-queue: no GitHub token (GITHUB_TOKEN / GH_PAT)');
    if (!repo) throw new Error('work-queue: no GITHUB_REPOSITORY');
    const r = await fetch(`${API}/repos/${repo}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github+json',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'wealthflow-autonomy',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = await r.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { /* non-JSON */ }
    if (!r.ok) {
        const msg = (data && data.message) || raw.slice(0, 300);
        const err = new Error(`GitHub ${method} ${path} → ${r.status}: ${msg}`);
        err.status = r.status;
        throw err;
    }
    return data;
}

/** Severity parsed from the issue title `[CRITICAL] …` or from labels. */
export function severityOf(issue) {
    const t = String(issue?.title || '');
    const m = t.match(/^\[(critical|high|medium|low)\]/i);
    if (m) return m[1].toLowerCase();
    const labels = (issue?.labels || []).map((l) => String(l.name || l).toLowerCase());
    if (labels.includes('security') || labels.includes('critical')) return 'critical';
    if (labels.includes('bug')) return 'high';
    if (labels.includes('ui/ux')) return 'medium';
    return 'low';
}

/**
 * Which of the 5 swarm roles should own this issue.
 * Mirrors the agent taxonomy in the blueprint PDF.
 */
export function roleFor(issue) {
    const labels = (issue?.labels || []).map((l) => String(l.name || l).toLowerCase());
    const text = `${issue?.title || ''} ${issue?.body || ''}`.toLowerCase();

    // Order matters, and it is deliberately severity-first.
    //   1. Security beats everything.
    //   2. Then CRASHES — before UI. "white screen", "blank screen" and
    //      "black screen" all contain the word "screen", so a UI-first check
    //      mis-routed hard crashes to the cosmetics agent. A user reporting a
    //      white screen has a broken app, not a design preference.
    //   3. Then look-and-feel, then requests for new capability.
    if (labels.includes('security') || /vulnerab|exploit|inject|leak|breach|xss|csrf/.test(text)) return 'security';

    const CRASH = /\b(crash(e[sd])?|freeze|froze|frozen|hang|hangs|white screen|black screen|blank screen|stuck|exception|traceback|broken|breaks|not working|doesn'?t work|won'?t open|fails?|failed|error|wrong (number|amount|total|value)|incorrect)\b/;
    if (CRASH.test(text)) return 'bug';

    const UI = /\b(ui|ux|layout|colour|color|font|typeface|spacing|padding|margin|icon|button|theme|dark mode|light mode|design|confusing|cluttered|hard to read|hard to find|too small|too big|unreadable|ugly|alignment|animation)\b/;
    if (labels.includes('ui/ux') || UI.test(text)) return 'ui';

    if (labels.includes('enhancement') || /\b(add|feature|option|support for|would be nice|please add|can you make|i wish|export|import)\b/.test(text)) return 'feature';

    if (labels.includes('bug')) return 'bug';
    return 'bug';                       // default: treat an unknown report as a defect
}

/** Sort key: severity first, then age (oldest first — nothing rots in the queue). */
export function rankIssues(issues) {
    return [...(issues || [])].sort((a, b) => {
        const s = PRIORITY.indexOf(severityOf(a)) - PRIORITY.indexOf(severityOf(b));
        if (s !== 0) return s;
        return new Date(a.created_at || 0) - new Date(b.created_at || 0);
    });
}

/**
 * Open issues the agent is allowed to work on.
 * Excludes anything already marked stuck (a human owns it) or a rollback alert.
 */
export async function fetchOpenWork({ env = process.env, limit = 30 } = {}) {
    const [issues, claimed] = await Promise.all([
        gh(`/issues?state=open&per_page=${Math.min(100, limit)}&sort=created&direction=asc`, { env }),
        issuesWithOpenFixPr({ env }),
    ]);
    const list = (issues || []).filter((i) => isWorkable(i, claimed));
    return rankIssues(list);
}

/** Attempt count, read from the agent's own trail of comments. */
export function attemptsFrom(comments) {
    return (comments || []).filter((c) => /<!--\s*wf-agent-attempt\s*-->/.test(String(c.body || ''))).length;
}

/**
 * The issue number a pull request is already handling, or null.
 *
 * The agent names its branches `ai-fix/issue-<n>-<timestamp>`, so the issue
 * number is recoverable from the head ref alone — no body parsing, no guessing.
 * A closing keyword in the body (`Closes #12`) is the fallback for hand-named
 * branches. Pure and total: never throws, whatever shape `pr` is.
 */
export function claimedIssueOf(pr) {
    const ref = String(pr?.head?.ref || pr?.headRefName || '');
    const m = ref.match(/^ai-fix\/issue-(\d+)-/);
    if (m) return Number(m[1]);
    const body = String(pr?.body || '');
    const cm = body.match(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i);
    return cm ? Number(cm[1]) : null;
}

/**
 * Issue numbers that ALREADY have an open autonomous fix PR.
 *
 * WHY THIS EXISTS
 *   The first live run produced issue #3 → PR #4 AND PR #5, seconds apart. Two
 *   workflow runs (an `issues: opened` and an `issues: labeled` event on the
 *   same issue) were serialised by the concurrency group, but NOTHING stopped
 *   the second one from redoing the work and opening a duplicate PR — there was
 *   no check for an already-open PR. This set is that check.
 *
 * Never throws: a dedup lookup that failed would be a poor reason to stall the
 * whole queue, so on any API error it returns an empty set (fail-open here is
 * correct — the worst case is the pre-existing duplicate behaviour, not a hang).
 */
export async function issuesWithOpenFixPr({ env = process.env } = {}) {
    const claimed = new Set();
    let prs;
    try {
        prs = await gh('/pulls?state=open&per_page=100', { env });
    } catch {
        return claimed;
    }
    for (const pr of prs || []) {
        const n = claimedIssueOf(pr);
        if (n != null) claimed.add(n);
    }
    return claimed;
}

/**
 * Is this issue eligible for the agent to pick up? Pure, so the filter is
 * testable without touching the network. `claimed` is the set from
 * issuesWithOpenFixPr — an issue that already has an open fix PR is NOT
 * workable, or the agent opens a second PR for one issue.
 */
export function isWorkable(issue, claimed = new Set()) {
    if (!issue || issue.pull_request) return false;   // PRs come back from /issues too
    const labels = (issue.labels || []).map((l) => String(l.name || l).toLowerCase());
    if (labels.includes(LABELS.stuck)) return false;
    if (labels.includes('auto-rollback')) return false;   // needs a human, by design
    if (labels.includes('wontfix')) return false;
    if (claimed.has(issue.number)) return false;          // already has an open fix PR

    // A machine-authored feature proposal is an IDEA, not work. Building it
    // without the owner's approval would turn propose-then-approve into
    // propose-then-build-anyway, which is the entire thing the design exists to
    // prevent: every other detector answers a question with a right answer,
    // while "should this app have feature X?" is a judgement only the owner can
    // make. The `approved-feature` label is that judgement, and nothing else
    // substitutes for it.
    if (labels.includes('feature-proposal') && !labels.includes('approved-feature')) return false;

    return true;
}

export async function issueComments(number, { env = process.env } = {}) {
    return (await gh(`/issues/${number}/comments?per_page=100`, { env })) || [];
}

export async function comment(number, body, { env = process.env } = {}) {
    return gh(`/issues/${number}/comments`, { method: 'POST', body: { body }, env });
}

export async function addLabels(number, labels, { env = process.env } = {}) {
    if (!labels?.length) return null;
    return gh(`/issues/${number}/labels`, { method: 'POST', body: { labels }, env });
}

export async function removeLabel(number, label, { env = process.env } = {}) {
    try {
        return await gh(`/issues/${number}/labels/${encodeURIComponent(label)}`, { method: 'DELETE', env });
    } catch (e) {
        if (e.status === 404) return null;              // label wasn't there — fine
        throw e;
    }
}

export async function closeIssue(number, { env = process.env, reason = 'completed' } = {}) {
    return gh(`/issues/${number}`, { method: 'PATCH', body: { state: 'closed', state_reason: reason }, env });
}

export async function createIssue({ title, body, labels = [], env = process.env }) {
    return gh('/issues', { method: 'POST', body: { title, body, labels }, env });
}

/**
 * Every issue, OPEN AND CLOSED, for deduplication by the discovery scanner.
 *
 * Deliberately NOT the search API: `/search/issues` is served from an index that
 * lags writes by seconds-to-minutes, so a scanner running back-to-back would not
 * see what it just filed and would file it again. Listing is authoritative and
 * immediate. Closed issues count too — a closed finding was handled or declined,
 * and re-opening that decision every 6 hours is exactly the churn this pipeline
 * is supposed to eliminate.
 */
export async function allIssues({ env = process.env, pages = 5 } = {}) {
    const out = [];
    for (let p = 1; p <= pages; p++) {
        const batch = await gh(`/issues?state=all&per_page=100&page=${p}`, { env });
        if (!batch || !batch.length) break;
        out.push(...batch);
        if (batch.length < 100) break;
    }
    return out;
}

/**
 * Ensure a label exists before it is applied — GitHub 422s on unknown labels
 * when creating an issue, which is a silent-failure trap in the old code.
 */
export async function ensureLabel(name, color = 'ededed', description = '', { env = process.env } = {}) {
    try {
        await gh(`/labels/${encodeURIComponent(name)}`, { env });
        return true;
    } catch (e) {
        if (e.status !== 404) throw e;
        try {
            await gh('/labels', { method: 'POST', body: { name, color, description }, env });
            return true;
        } catch { return false; }
    }
}

export async function ensureCoreLabels({ env = process.env } = {}) {
    const spec = [
        [LABELS.autonomous, '5319E7', 'Filed or handled by the autonomous pipeline'],
        [LABELS.inProgress, 'FBCA04', 'An autonomous agent is working on this'],
        [LABELS.fixed, '0E8A16', 'Fixed and shipped by the autonomous pipeline'],
        [LABELS.stuck, 'D93F0B', 'Autonomous agent could not fix this — needs a human'],
        [LABELS.feedback, '1D76DB', 'Came from the in-app feedback form'],
        ['auto-safe', '0E8A16', 'Validated non-sensitive change — eligible for auto-merge'],
        ['fuzz-passed', '0E8A16', 'Passed the intensive fuzz gate'],
        ['human-approved', 'B60205', 'A human approved this sensitive change'],
    ];
    for (const [n, c, d] of spec) await ensureLabel(n, c, d, { env });
}

/**
 * Firestore Timestamp | Date | ISO string | null  ->  ISO string | null.
 *
 * Total: returns null rather than throwing or inventing a date, because the
 * caller's whole reason for existing is that a fabricated timestamp is worse
 * than an absent one.
 */
export function tsToIso(v) {
    if (!v) return null;
    try {
        if (typeof v.toDate === 'function') return v.toDate().toISOString();   // Firestore Timestamp
        if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
        if (typeof v === 'number') return new Date(v).toISOString();
        if (typeof v === 'string') { const d = new Date(v); return isNaN(d) ? null : d.toISOString(); }
        if (Number.isFinite(v._seconds)) return new Date(v._seconds * 1000).toISOString();
    } catch { /* fall through */ }
    return null;
}

/**
 * OPTIONAL Firestore enrichment. Never throws, never required — the exact
 * opposite of the old behaviour, where its absence killed the whole run.
 */
export async function firestoreProposals({ env = process.env } = {}) {
    return (await firestoreProposalsDetailed({ env })).proposals;
}

/**
 * The same read, but it SAYS WHY it came back empty.
 *
 * WHY THIS EXISTS
 * `firestoreProposals()` returned `[]` for four completely different situations,
 * and the intake could only print one sentence covering all of them:
 *
 *     "No Firestore proposals available (no credentials, or the document is empty)."
 *
 * On the first live scheduled run that sentence was the only output. It happened
 * to be a missing FIREBASE_SERVICE_ACCOUNT secret — but the run summary could not
 * say so, and the only reason anyone could tell was that the WORKFLOW log dumped
 * an empty env var next to it. Read the sentence alone and "the pipeline is
 * healthy and there was no work" is indistinguishable from "the pipeline has
 * never been able to authenticate".
 *
 * That is this repository's recurring defect in its purest form: an outage and a
 * clean result rendered identically. Every branch now names itself.
 *
 *   ok             read succeeded; `proposals` may still legitimately be empty
 *   no_credentials FIREBASE_SERVICE_ACCOUNT missing or blank
 *   bad_credentials  set, but not parseable JSON
 *   empty_document system/pendingRelease absent, or it carries no proposedChanges
 *   unreachable    the SDK or the query failed — auth rejected, network, quota
 *
 * Never throws: an enrichment source going down must not kill the run. It must
 * only stop pretending it was healthy.
 */
export async function firestoreProposalsDetailed({ env = process.env } = {}) {
    const none = (status, reason) => ({ status, reason, proposals: [] });

    const raw = env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw || !String(raw).trim()) {
        return none('no_credentials',
            'FIREBASE_SERVICE_ACCOUNT is not set in this environment, so Firestore was never contacted.');
    }
    let creds;
    try { creds = JSON.parse(raw); } catch (e) {
        console.warn('[work-queue] FIREBASE_SERVICE_ACCOUNT is set but not valid JSON — ignoring.');
        return none('bad_credentials',
            `FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON (${e.message}).`);
    }
    try {
        const admin = (await import('firebase-admin')).default;
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
        const doc = await admin.firestore().collection('system').doc('pendingRelease').get();
        const d = doc.exists ? doc.data() : null;
        if (!d) return none('empty_document', 'system/pendingRelease does not exist.');
        if (!Array.isArray(d.proposedChanges) || !d.proposedChanges.length) {
            return none('empty_document',
                'system/pendingRelease exists but carries no proposedChanges — release-brain found nothing critical to propose.');
        }
        const changes = d.proposedChanges;
        // The document's own timestamp, not the moment we happened to read it.
        // See `generatedAt` below.
        const generatedAt = tsToIso(d?.generatedAt);
        // `c || {}` is load-bearing. A null or non-object entry in the array
        // made `c.action` throw INSIDE the try, and the catch below labelled it
        // `unreachable` — "Firestore could not be read". Firestore was read
        // perfectly; one record was malformed. Mislabelling a data problem as an
        // outage is the same conflation this status enum exists to end, so a bad
        // entry degrades to an empty proposal instead of faking a read failure.
        const proposals = changes.map((raw, i) => { const c = (raw && typeof raw === 'object') ? raw : {}; return ({
            source: 'firestore',
            number: null,
            title: String(c.action || c.issue || `proposal ${i + 1}`).slice(0, 120),
            body: String(c.detail || c.action || c.issue || ''),
            labels: [],
            // WHY created_at IS GONE
            // It was `new Date().toISOString()` — stamped at READ time, so every
            // proposal always looked seconds old however long it had been sitting
            // in the document. Anything ranking or ageing on it was reading a
            // number this function had just invented. `generatedAt` is the real
            // one, and it is null when Firestore has not written it yet rather
            // than being back-filled with a plausible lie.
            generatedAt,
            // Carried through because the CLUSTER WEIGHT is the whole point of
            // these records: `reports` is how many separate users hit this. It
            // was being dropped on the floor here, one line before the only
            // place it could ever have been used.
            priority: c.priority || null,
            category: c.category || null,
            reports: Number.isFinite(c.reports) ? c.reports : null,
            sample: String(c.issue || ''),
            _priority: c.priority,
        }); });
        return { status: 'ok', reason: null, proposals };
    } catch (e) {
        console.warn('[work-queue] Firestore enrichment unavailable (non-fatal):', e.message);
        // Deliberately NOT folded into empty_document. "I could not look" and
        // "I looked and there was nothing" are different facts, and an auth
        // rejection surfaces here — which is precisely the state that must never
        // read as a healthy empty queue.
        return none('unreachable', `Firestore could not be read: ${e.message}`);
    }
}

/**
 * The queue the agent actually consumes: GitHub Issues (authoritative) plus any
 * optional Firestore proposals, ranked.
 */
export async function loadQueue({ env = process.env, limit = 30 } = {}) {
    const issues = await fetchOpenWork({ env, limit });
    let extra = [];
    try { extra = await firestoreProposals({ env }); } catch { /* never fatal */ }
    return { issues, proposals: extra, total: issues.length + extra.length };
}
