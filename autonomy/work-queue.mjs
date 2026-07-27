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
    const issues = await gh(`/issues?state=open&per_page=${Math.min(100, limit)}&sort=created&direction=asc`, { env });
    const list = (issues || []).filter((i) => {
        if (i.pull_request) return false;                 // PRs come back from this endpoint too
        const labels = (i.labels || []).map((l) => String(l.name || l).toLowerCase());
        if (labels.includes(LABELS.stuck)) return false;
        if (labels.includes('auto-rollback')) return false;  // needs a human, by design
        if (labels.includes('wontfix')) return false;
        return true;
    });
    return rankIssues(list);
}

/** Attempt count, read from the agent's own trail of comments. */
export function attemptsFrom(comments) {
    return (comments || []).filter((c) => /<!--\s*wf-agent-attempt\s*-->/.test(String(c.body || ''))).length;
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
 * OPTIONAL Firestore enrichment. Never throws, never required — the exact
 * opposite of the old behaviour, where its absence killed the whole run.
 */
export async function firestoreProposals({ env = process.env } = {}) {
    const raw = env.FIREBASE_SERVICE_ACCOUNT;
    if (!raw || !String(raw).trim()) return [];
    let creds;
    try { creds = JSON.parse(raw); } catch {
        console.warn('[work-queue] FIREBASE_SERVICE_ACCOUNT is set but not valid JSON — ignoring.');
        return [];
    }
    try {
        const admin = (await import('firebase-admin')).default;
        if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
        const doc = await admin.firestore().collection('system').doc('pendingRelease').get();
        const d = doc.exists ? doc.data() : null;
        const changes = Array.isArray(d?.proposedChanges) ? d.proposedChanges : [];
        return changes.map((c, i) => ({
            source: 'firestore',
            number: null,
            title: String(c.action || c.issue || `proposal ${i + 1}`).slice(0, 120),
            body: String(c.detail || c.action || c.issue || ''),
            labels: [],
            created_at: new Date().toISOString(),
            _priority: c.priority,
        }));
    } catch (e) {
        console.warn('[work-queue] Firestore enrichment unavailable (non-fatal):', e.message);
        return [];
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
