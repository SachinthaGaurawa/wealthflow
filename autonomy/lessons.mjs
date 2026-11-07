/* =============================================================================
 * autonomy/lessons.mjs — standing rules the agent has already paid for
 * -----------------------------------------------------------------------------
 * WHY (2026 agentic-governance practice: "turn a repeated failure into a constraint")
 *   Each rule below is a mistake that really happened in this repository and cost a red PR, a wrong merge or a
 *   rejected fix. A model that only sees today's issue repeats them. This ledger is plain data, reviewed like code;
 *   the fix agent is shown the rules that MATCH its task (and the ones that match why its last try failed), so the
 *   author starts from what was already learned.
 *
 *   It is advice to the author, never a gate: the gates (tests, probe, mutation check, reviewer, risk label) still
 *   decide. A rule that no longer applies is deleted here in a normal PR.
 *
 * Pure: `lessonsFor` and `classifyFailure` have no I/O.
 * ===========================================================================*/

/**
 * @typedef {{ id:string, when:RegExp, area:string, rule:string, evidence:string }} Lesson
 * `when` is tested against the report text (and the CI failure digest on a retry). `area` is a short tag for logs.
 */

/** @type {Lesson[]} */
export const LESSONS = [
    {
        id: 'layout-no-hidden-columns',
        area: 'layout',
        when: /\b(overlap|cut.?off|clipped|squeez|overflow|truncat|phone|mobile|\d{3}\s*px|width|wrap)\b/i,
        rule: 'Never fix a squeezed row by pushing a column out of view behind a sideways scroll, and never use overflow-wrap:anywhere or word-break. Every column that was visible must still be visible and readable at 320px.',
        evidence: 'PR #551 passed the old probe while hiding the % column of the Dashboard legend; it was rendered, rejected and the probe was taught to see it (#553).',
    },
    {
        id: 'layout-measure-then-fix',
        area: 'layout',
        when: /\b(overlap|cut.?off|clipped|squeez|spill|layout)\b/i,
        rule: 'Fix the element the measurement names. Do not restyle neighbouring screens, and do not undo an earlier lane-block: rules that the measurement does not ask for are removed.',
        evidence: '#524: a block that re-declared table rules vetoed the whole fix (#530).',
    },
    {
        id: 'no-autonomy-in-functions',
        area: 'serverless',
        when: /\b(api\/|serverless|vercel|function|endpoint|triage)\b/i,
        rule: 'A Vercel function must not import anything under autonomy/ (it is in .vercelignore). Put shared code in a root wf-*.mjs file.',
        evidence: '#523: feedback-triage silently lost any-language and screenshot reading in production.',
    },
    {
        id: 'no-regex-lookbehind-in-browser',
        area: 'browser',
        when: /\b(index\.html|browser|client|safari|iphone|ios|wealthflow-[\w-]+\.js)\b/i,
        rule: 'Do not use regex lookbehind in code that runs in the browser (older Safari throws a SyntaxError and the whole module fails). Node-only files may use it.',
        evidence: '#490 email statement lookup.',
    },
    {
        id: 'size-ceilings',
        area: 'build',
        when: /\b(perf.?budget|ceiling|bundle|size|kb)\b/i,
        rule: 'Client and HTML size ceilings live in autonomy/perf-budget.mjs; a change that grows a file must stay under them or the PR is red. Run npx vitest run test/perf_budget_test.js before opening it.',
        evidence: 'Ceilings conflicted between parallel PRs more than once.',
    },
    {
        id: 'money-reversible',
        area: 'data',
        when: /\b(delete|remove|merge|dedup|duplicate|restore|balance|statement|transaction|ledger|cheque|instal)/i,
        rule: 'Changes to the owner\'s live financial data must be reversible (backup or soft-delete first) and a statement is never counted twice. If a fix cannot guarantee that, narrow it.',
        evidence: 'Statement lock and duplicate-upload work (#336-#372, #440).',
    },
    {
        id: 'tests-assert-values',
        area: 'tests',
        when: /./,
        rule: 'The proving test must assert the exact observable result (a value, a text, a call), not only that the code runs. The sabotage check breaks the changed lines on purpose and a test that stays green is thin evidence.',
        evidence: 'autonomy/mutation-check.mjs (#553).',
    },
    {
        id: 'fix-the-cause-not-the-symptom',
        area: 'general',
        when: /\b(wrong|incorrect|mismatch|missing|not (?:showing|working|updating)|error|fails?|crash)\b/i,
        rule: 'Find why the value is wrong before editing the display of it. A change that only hides the symptom (a try/catch that swallows, a default that masks) is rejected by the reviewer.',
        evidence: 'First fix agent runs that changed labels instead of the calculation.',
    },
];

/**
 * The rules that apply to this text, most specific first (the catch-all `./` rule goes last), capped.
 * @param {string} text report text, plus the CI failure digest on a retry
 * @param {{ max?:number, lessons?:Lesson[] }} [opts]
 * @returns {Lesson[]}
 */
export function lessonsFor(text, { max = 5, lessons = LESSONS } = {}) {
    const t = String(text || '');
    if (!t.trim()) return [];
    const hit = lessons.filter((l) => l.when.test(t));
    const specific = hit.filter((l) => l.when.source !== '.');
    const general = hit.filter((l) => l.when.source === '.');
    return [...specific, ...general].slice(0, max);
}

/** The section appended to what the author reads. Empty when nothing matches. */
export function lessonsBrief(text, opts) {
    const found = lessonsFor(text, opts);
    if (!found.length) return '';
    return '\n\n### Standing rules from earlier failures in this repository (follow these)\n' +
        found.map((l) => `- ${l.rule}`).join('\n') + '\n';
}

/** Coarse class of a failed check, for the log and for counting repeats. */
export function classifyFailure(checkName) {
    const n = String(checkName || '').toLowerCase();
    if (/test|vitest|fuzz|conftest/.test(n)) return 'tests';
    if (/shell|index\.html|html|client/.test(n)) return 'shell';
    if (/budget|size|perf/.test(n)) return 'size';
    if (/lint|format|syntax/.test(n)) return 'lint';
    if (/secret|credential/.test(n)) return 'secrets';
    if (/build|deploy|vercel/.test(n)) return 'build';
    return 'other';
}
