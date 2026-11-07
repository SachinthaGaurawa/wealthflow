/* =============================================================================
 * autonomy/task-card.mjs — the task and its parameters, filled in by a program for every piece of work
 * -----------------------------------------------------------------------------
 * WHY (the owner's elite-expert prompt, parts 3, 4, 20 and 25)
 *   The original ends with "USER TASK" and eight optional parameters: desired outcome, research depth, time horizon,
 *   scope, evidence requirements, output format, constraints, evaluation criteria. In this system nobody types those. A
 *   program fills them in from the report, the lane and the file the work touches, and puts the card at the top of the
 *   request every model sees AND in the pull request, so the owner and the reviewers can see what the work was held to.
 *
 *   The one parameter that changes what happens is DEPTH (part 4). It is chosen by rules written below, from what the
 *   change touches, and it has two real effects: the analysis pass asks for more failure modes, and the evidence ledger
 *   will not call a COMPREHENSIVE change HIGH confidence unless the proof was strong (autonomy/evidence-ledger.mjs).
 *   It is a heuristic, and the card says so. It never opens or closes a gate: the gates still decide.
 *
 * Pure: no I/O.
 * ===========================================================================*/

export const DEPTHS = Object.freeze(['standard', 'deep', 'comprehensive']);

// Files whose names say they handle money, saved data, sync or sign-in. A name match is a cheap, honest signal, not a proof.
const MONEY_FILE = /(statement|ledger|cheque|check-?book|card|bank|account|balance|loan|instal|budget|invoice|payment|rent|tenant|portal|sms|gmail|backup|sync|crypto|vault|migration|reconcil|transfer|interest|tax|fifo|allocator|firestore|inbox|restore)/i;
const MONEY_WORDS = /\b(total|balance|amount|duplicate|double.?count|lost|missing rows?|deleted?|wrong (total|amount|balance)|lkr|rs\.?|statement|cheque|instal(?:l)?ments?|interest|backup|sync|ledger|debit|credit)\b/gi;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * How hard to look. Returns the depth and the reasons, so the card can show them.
 * @param {{ role?:string, lane?:string, file?:string, text?:string, guarded?:boolean }} o
 */
export function effortFor({ role = 'bug', lane = 'swarm', file = '', text = '', guarded = false } = {}) {
    const why = [];
    const words = new Set(((String(text).match(MONEY_WORDS)) || []).map((w) => w.toLowerCase()));
    if (guarded) why.push('the work touches a guarded path');
    if (MONEY_FILE.test(String(file))) why.push(`the file name (${clip(file, 60)}) points at money, saved data, sync or sign-in`);
    if (words.size >= 2) why.push(`the report talks about money or saved data (${[...words].slice(0, 4).join(', ')})`);
    if (guarded) return { depth: 'comprehensive', why };
    if (lane === 'layout') return { depth: 'standard', why: ['a CSS-only layout change, measured in a real browser before and after'] };
    if (why.length) return { depth: 'comprehensive', why };

    if (lane === 'build') return { depth: 'deep', why: ['a whole new module is being added'] };
    if (role === 'feature' || role === 'bug') return { depth: 'deep', why: [role === 'feature' ? 'a feature changes behaviour' : 'a bug fix must find the real cause'] };
    return { depth: 'standard', why: ['a screen or wording change with no money or saved data in it'] };
}

/** Operating modes (part 20) by lane. */
export const MODES_BY_LANE = Object.freeze({
    bug: ['deep analysis', 'coding and engineering', 'audit'],
    feature: ['creative discovery', 'decision', 'coding and engineering'],
    ui: ['coding and engineering', 'fact-checking'],
    layout: ['fact-checking', 'coding and engineering'],
    build: ['creative discovery', 'decision', 'coding and engineering'],
    board: ['research', 'decision', 'creative discovery'],
});

const HORIZON = {
    bug: 'Now: the behaviour in the report. Also data saved by older versions, and what the owner\'s phone shows once the update card has been accepted.',
    feature: 'Near-term: the first version must work now and on data saved by older versions; it must not make later changes harder to undo.',
    ui: 'Now, on the smallest phone width, and after the update reaches the phone.',
    layout: 'Now, at the phone widths named in the report; every column that was visible must stay visible.',
    build: 'Near-term: a new module that only reads the books, plus how it will be wired in and removed.',
};

function evidenceFor(lane, depth) {
    const out = [];
    if (lane === 'layout') {
        out.push('a measurement in real Chromium before and after, at the named widths, that shows the problem found and then gone or reduced');
        out.push('an independent security review by a model on a different provider');
    } else if (lane === 'build') {
        out.push('the machine check that the new module cannot write to the books, call Firebase, use eval or inject scripts');
        out.push('an independent security review by a model on a different provider');
    } else {
        out.push('a proving test that fails on the original file and passes on the changed one (a program runs both)');
        out.push('the sabotage check: the test must notice deliberately broken versions of the fix');
        out.push('an independent security review by a model on a different provider');
        if (depth !== 'standard') out.push('an independent analysis of the cause, the alternatives and the ways the change could fail (a program checks its quotes)');
    }
    out.push('the full test suite and the multi-model board in CI');
    if (depth === 'comprehensive') out.push('and, because this touches money or saved data, a check by the owner on a real phone before the figures are trusted (no run here can do that)');
    return out;
}

const CONSTRAINTS = [
    'edit exactly one file; vanilla JavaScript for the browser with no build step, no imports and no new dependency',
    'no guarded file (auth, crypto, rules, service worker, workflows, test harness) and no weakening of any check',
    'free-tier model providers only; keep the change small enough to be reviewed in full',
    'everything reversible; live financial data changes only after a backup or as a soft delete',
    'this repository is public: nothing private in code, comments, tests, issues or logs',
];

const CRITERIA = {
    swarm: [
        'the proving test fails on the original and passes on the change (measured, not claimed)',
        'the sabotage check catches at least half of the broken versions of the fix',
        'the full suite is green and the board votes PASS with every reviewer, release score at or above the floor',
        'after release the canary\'s six checks pass on the live app',
    ],
    layout: [
        'the layout measurement reports the overlap fixed or reduced, with no column hidden',
        'the full suite is green and the board votes PASS',
        'after release the canary\'s six checks pass on the live app',
    ],
    build: [
        'the machine check passes and the module is wired in with a way to remove it',
        'the full suite is green and the board votes PASS',
        'after release the canary\'s six checks pass on the live app',
    ],
};

/**
 * @param {{ issue?:{title?:string,number?:number}, role?:string, lane?:string, file?:string, text?:string, guarded?:boolean, depth?:string }} o
 */
export function taskCard({ issue = {}, role = 'bug', lane = 'swarm', file = '', text = '', guarded = false, depth = '' } = {}) {
    const eff = DEPTHS.includes(depth) ? { depth, why: ['set by the caller'] } : effortFor({ role, lane, file, text: text || issue.title || '', guarded });
    const key = lane === 'layout' || lane === 'build' ? lane : role;
    const modes = MODES_BY_LANE[key] || MODES_BY_LANE.bug;
    return {
        outcome: clip(issue.title, 200) || '(no title)',
        number: issue.number == null ? null : Number(issue.number),
        depth: eff.depth,
        depthWhy: eff.why,
        horizon: HORIZON[key] || HORIZON.bug,
        scope: `lane: ${lane}${role && lane === 'swarm' ? `, role: ${role}` : ''}${file ? `, file: ${clip(file, 80)}` : ''}`,
        evidence: evidenceFor(lane, eff.depth),
        format: lane === 'layout' ? 'CSS only (FORMAT FIRST)' : lane === 'build' ? 'one new module file (FORMAT FIRST)' : 'as each request names it: a whole file, SEARCH/REPLACE blocks, one JSON object or a verdict word (FORMAT FIRST)',
        constraints: CONSTRAINTS,
        criteria: CRITERIA[lane === 'layout' || lane === 'build' ? lane : 'swarm'],
        modes,
    };
}

/** The card as the models see it: short, plain, and clearly written by a program. */
export function cardPrompt(card) {
    if (!card) return '';
    return [
        'TASK CARD (written by a program from the report and the lane; the owner\'s words stay the decision)',
        `Desired outcome: ${card.outcome}`,
        `Depth: ${card.depth.toUpperCase()} - ${card.depthWhy.join('; ')}`,
        `Time horizon: ${card.horizon}`,
        `Scope: ${card.scope}`,
        `Modes: ${card.modes.join(', ')}`,
        `Evidence required before this counts as done: ${card.evidence.join('; ')}`,
        `Output format: ${card.format}`,
        `Constraints: ${card.constraints.join('; ')}`,
        `Success is measured by: ${card.criteria.join('; ')}`,
    ].join('\n');
}

/** The card for the pull request. */
export function cardMarkdown(card) {
    if (!card) return '';
    return [
        '### Task card',
        '_Written by a program from the report and the lane (docs/update-charter.md, part 25). Depth is a heuristic from what the change touches; it never opens or closes a gate._',
        '',
        `- **Desired outcome (the owner's words):** ${card.outcome}`,
        `- **Depth:** ${card.depth} - ${card.depthWhy.join('; ')}`,
        `- **Time horizon:** ${card.horizon}`,
        `- **Scope:** ${card.scope}`,
        `- **Modes:** ${card.modes.join(', ')}`,
        `- **Evidence required:** ${card.evidence.join('; ')}`,
        `- **Constraints:** ${card.constraints.join('; ')}`,
        `- **Success is measured by:** ${card.criteria.join('; ')}`,
    ].join('\n');
}
