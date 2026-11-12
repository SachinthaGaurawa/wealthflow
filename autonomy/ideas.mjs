/* =============================================================================
 * autonomy/ideas.mjs — the system thinks of its own improvements, and decides which are worth building   (owner, 2026-11-07)
 * -----------------------------------------------------------------------------
 * WHY (owner, 17:24Z): "The system must be able to think for itself ... introduce new ideas, features and options by itself ... nothing may need my hand."
 *
 * Until now propose.mjs could only OPEN AN ISSUE and wait for the owner to add `approved-feature`. That kept the owner's taste in charge, and it also meant
 * nothing moved unless the owner read an inbox. The owner has now said the machine must carry the whole loop. Taste cannot be proven by a test, so it is replaced by
 * four things a machine CAN check, all in this file and all pure (testable without a network):
 *
 *   1. GROUNDING   An idea must cite the evidence it came from: a line of the measured roadmap, a measured gap, real feedback, or an earlier outcome.
 *                  The prompt numbers every signal (S1, G2, F1 ...); an idea whose `evidence` names none of them is not grounded and is dropped.
 *   2. REASONING   An idea must give its "if X, then Y" chain, and score itself on ease of use, value, smallness and risk. The scores are used (see `scoresOk`),
 *                  not just shown: user-friendliness comes first, so an idea that is hard to use is refused however clever it is.
 *   3. SAFETY      `guardIdea` refuses, with no model involved, anything touching sign-in, encryption, money arithmetic, paid services, new dependencies,
 *                  sending the owner's data somewhere new, or destructive actions. Those paths change only with a human driving (the charter says so).
 *   4. AGREEMENT   Different AI providers vote on it (concept-board.mjs). The owner is not in the loop, so ONE objection is enough to stop it.
 *
 * It also LEARNS from what happened to earlier ideas (`outcomesOf`): ideas that were built, declined or are still being built are shown to the model, and a
 * near-copy of any earlier idea (open or closed) is refused (`isRepeat`), so a declined idea does not come back the next night under another name.
 *
 * What this does NOT claim: that an idea passing all four is the best one, or one the owner will love. It claims the idea is grounded, reasoned, safe by rule
 * and not objected to by independent models. The owner can still stop any idea by closing its issue (an issue closed before its pull request merges is not built), and
 * everything it builds ships as a normal pull request through the same gates (tests, review, policy gate) with the NEW label and the usual rollback.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

/** Labels the loop writes. `approved-feature` is what work-queue.isWorkable() looks for. */
export const IDEA_LABELS = Object.freeze({
    auto: 'auto-approved',        // the system approved it (board + rules), not a person
    declined: 'idea-declined',    // refused by a rule or by the board; kept closed so it is remembered
});

/** At most this many ideas may be in the pipeline (waiting or being built) at once. Quality over volume. */
export const MAX_IN_FLIGHT = 2;

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

// ── what the system studies ──────────────────────────────────────────────────────────────────────

/**
 * The ranked ideas in docs/superior-system-research.md section 4 (a markdown table whose rows start with a rank number).
 * Rows marked "Built in this change" are done; rows marked as the owner's decision are not the machine's to start.
 */
export function parseRoadmap(markdown) {
    const rows = [];
    for (const line of String(markdown || '').split('\n')) {
        const m = /^\|\s*(\d{1,2})\s*\|(.+?)\|?\s*$/.exec(line);   // the closing pipe is optional: a row without one still counts
        if (!m) continue;
        const cells = m[2].split('|').map((c) => c.trim());
        if (cells.length < 3) continue;
        const text = cells.join(' ');
        rows.push({
            rank: Number(m[1]),
            idea: clip(cells[0].replace(/\*\*/g, ''), 220),
            ifThen: clip(cells[1], 260),
            checkFirst: clip(cells[2].replace(/\*\*/g, ''), 220),
            done: /built in this change|already (built|done)|fixed in/i.test(text),
            ownerOnly: /owner'?s decision|go\/no-go/i.test(text),
        });
    }
    return rows;
}

/** The "Still failing" and "Not measured at all" paragraphs: gaps somebody measured and wrote down, not guessed. */
export function parseGaps(markdown) {
    const gaps = [];
    for (const line of String(markdown || '').split('\n')) {
        const m = /^\*\*(Still failing|Not measured at all)[^*]*\*\*\s*(.+)$/i.exec(line.trim());
        if (m) gaps.push({ kind: /still failing/i.test(m[1]) ? 'measured failure' : 'not yet measured', text: clip(m[2], 520) });
    }
    return gaps;
}

export function readResearch(repoDir = process.cwd()) {
    let md = '';
    try { md = fs.readFileSync(path.join(repoDir, 'docs', 'superior-system-research.md'), 'utf8'); } catch { /* no research doc yet */ }
    return { roadmap: parseRoadmap(md), gaps: parseGaps(md) };
}

const hasLabel = (issue, name) => (issue?.labels || []).some((l) => String(l?.name || l).toLowerCase() === name);

/**
 * What became of the ideas filed so far. built = closed as completed, declined = closed otherwise, building = open and approved, waiting = open, not approved.
 * Pure: takes the issue list, returns the facts the model is shown and the count that limits new ideas.
 */
export function outcomesOf(issues) {
    const out = [];
    for (const i of issues || []) {
        if (i.pull_request || !hasLabel(i, 'feature-proposal')) continue;
        const title = clip(String(i.title || '').replace(/^\[PROPOSAL\]\s*/i, ''), 140);
        let state;
        if (i.state === 'closed') state = i.state_reason === 'completed' ? 'built' : 'declined';
        else state = hasLabel(i, 'approved-feature') ? 'building' : 'waiting';
        out.push({ number: i.number, title, state, created: i.created_at || null });
    }
    return out;
}

/**
 * Ideas in the pipeline: the cap that stops the system flooding the repository. An idea that nobody picked up does not hold the cap for ever.
 * Found on the first real run (2026-11-11): two ideas filed by the OLD weekly engine had waited 3 and 4 weeks for an owner label that
 * the owner said he will never give by hand, and they blocked every new idea. A waiting idea counts for 3 days (a human who has switched
 * the gate back on still has time to look); an approved idea counts for 14 days (a build that long stuck is the pull-request watchers' job).
 */
export const WAITING_DAYS = 3, BUILDING_DAYS = 14;
export function inFlight(outcomes, now = Date.now()) {
    const young = (o, days) => { const t = Date.parse(o.created); return !Number.isFinite(t) || now - t < days * 86400000; };
    return (outcomes || []).filter((o) => (o.state === 'building' && young(o, BUILDING_DAYS)) || (o.state === 'waiting' && young(o, WAITING_DAYS))).length;
}

// ── one numbered list of evidence the model must cite ──────────────────────────────────────────

/** Every signal gets an id the model must quote back. Order is stable so a test can name them. */
export function signalList({ roadmap = [], gaps = [], feedback = [], outcomes = [], shipped = [], app = {} } = {}) {
    const sig = [];
    roadmap.filter((r) => !r.done && !r.ownerOnly).slice(0, 8).forEach((r, i) => sig.push({ id: `R${i + 1}`, kind: 'roadmap', text: `rank ${r.rank}: ${r.idea} — if/then: ${r.ifThen} — check first: ${r.checkFirst}` }));
    gaps.slice(0, 4).forEach((g, i) => sig.push({ id: `G${i + 1}`, kind: g.kind, text: g.text }));
    feedback.slice(0, 6).forEach((f, i) => sig.push({ id: `F${i + 1}`, kind: 'owner feedback', text: `#${f.number} [${f.state}] ${f.title}` }));
    outcomes.slice(0, 14).forEach((o, i) => sig.push({ id: `H${i + 1}`, kind: `earlier idea, ${o.state}`, text: `#${o.number} ${o.title}` }));
    shipped.slice(0, 12).forEach((t, i) => sig.push({ id: `P${i + 1}`, kind: 'already shipped', text: clip(t, 140) }));
    if (app.sections && app.sections.length) sig.push({ id: 'A1', kind: 'screens that exist', text: app.sections.join(', ') });
    if (app.modules && app.modules.length) sig.push({ id: 'A2', kind: 'modules that exist', text: app.modules.join(', ') });
    return sig;
}

export function renderSignals(sig) {
    return sig.length ? sig.map((s) => `${s.id} [${s.kind}] ${s.text}`).join('\n') : '(no signals could be read)';
}

// ── repeats ─────────────────────────────────────────────────────────────────────────────────────

const STOP = new Set(('a an and are as at be by for from has have in into is it its of on or that the their this to up use with your you add show make let allow when can new option feature page screen button more better easier simple one all each').split(' '));
export function words(text) {
    return [...new Set(String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, '')))];
}
/** How alike two titles are: the larger of Jaccard and containment of the shorter, 0..1. */
export function likeness(a, b) {
    const A = words(a), B = words(b);
    if (!A.length || !B.length) return 0;
    const inter = A.filter((w) => B.includes(w)).length;
    return Math.max(inter / new Set([...A, ...B]).size, inter / Math.min(A.length, B.length) * (Math.min(A.length, B.length) >= 3 ? 1 : 0.6));
}
/** A near-copy of any earlier idea, open or closed. Returns that earlier idea or null. */
export function isRepeat(title, outcomes, threshold = 0.6) {
    let best = null, top = 0;
    for (const o of outcomes || []) { const s = likeness(title, o.title); if (s >= threshold && s > top) { best = o; top = s; } }
    return best;
}

// ── safety by rule ──────────────────────────────────────────────────────────────────────────────

const RULES = [
    ['sign-in or security', /\b(log-?in|sign-?in|sign-?out|passcode|password|pin code|otp|two-?factor|2fa|session token|authenticat\w*|authoriz\w*|biometric)\b/i],
    ['encryption', /\b(encrypt\w*|decrypt\w*|cipher|aes-?gcm|vault|key derivation|private key)\b/i],
    ['money arithmetic', /\b(rounding|round(s|ed)? (to|the) (nearest|cent|rupee)|currency conversion|exchange rate|interest (calculation|formula)|(change|alter|adjust|modify|rework|tweak|fix) how (the |your |each |every )?(amounts?|totals?|balances?|sums?|figures?) (is|are)? ?(added|summed|calculated|computed|stored|rounded|worked out|converted))\b/i],
    ['a paid service', /\b(paid (plan|tier|api|service)|subscription fee|stripe|paypal|billing|payment gateway|premium plan|monthly (fee|bill|cost)|credit card required)\b/i],
    ['a new dependency', /\b(npm install|new (npm |third-party |external )?(library|package|dependency|sdk|framework)|add(ing)? (a )?(library|package|dependency|sdk|framework))\b/i],
    ['sending data somewhere new', /\b(send|upload|share|post|export|sync)\w* (the )?(your |their |user'?s? )?(money |financial |transaction |account )?(data|records|transactions|balances|statements) (to|with|via) (a |an |the )?(new |external |third|cloud|server|service|api|website|email)/i],
    ['a destructive action', /\b(delete all|wipe|erase (all|every)|purge|factory reset|reset all data)\b/i],
];
const FORBIDDEN_FILES = /(^|[\s,/])(wealthflow-(auth|crypto|vault|passcode|login)[a-z-]*\.js|firestore\.rules|vercel\.json|package(-lock)?\.json|\.github\/|api\/|autonomy\/)/i;

/**
 * Everything the fix agent will be given to build from: title, problem, prompt, proposal, scope and why-now (the issue body carries all of
 * them, so a harmful instruction hidden in any one is read). Never the "risks" text, which names dangers on purpose.
 */
export function guardIdea(p) {
    const what = [p?.title, p?.problem, p?.prompt, p?.proposal, p?.scope, p?.whyNow].map((x) => String(x || '')).join('\n');
    const reasons = [];
    for (const [name, re] of RULES) if (re.test(what)) reasons.push(name);
    if (FORBIDDEN_FILES.test(String(p?.scope || ''))) reasons.push('a file that only a human may change');
    return { ok: reasons.length === 0, reasons };
}

// ── the scope is checked against the files that exist ──────────────────────────────────────────────────────────

/**
 * MEASURED 2026-11-12, idea #607 (the first one this engine approved): its "Likely scope" named
 * `src/screens/settings/software-update.js` and `src/i18n/en.json`. Neither exists; this app has no `src/` folder. The fix agent
 * ranks files by the words of the issue, so two invented paths are noise at the top of its search, and a "small" score given
 * to an idea whose files were imagined was never measured against anything.
 *
 * So a program reads the scope: a file that exists is kept (a bare name is completed to its real path), a file that does not is
 * named as such, and for each missing one the real files with the same words in their name are offered. No model is asked.
 * A file only a human may change is never offered. Text with no file name in it is returned as it was.
 */
const FILE_TOKEN = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:js|mjs|cjs|ts|tsx|jsx|html|css|json|md|yml|yaml)\b/g;
const NAME_NOISE = new Set(['index', 'main', 'screen', 'screens', 'page', 'pages', 'view', 'views', 'component', 'components', 'util', 'utils', 'helper', 'helpers', 'wealthflow', 'test', 'tests', 'json', 'src', 'app', 'lib', 'module', 'modules']);
const NOT_APP = /^(test|tests|autonomy|docs|policy|native|node_modules|\.github)\//;
// the words of the whole invented path: `src/screens/settings/software-update.js` says "settings" as well as "update"
const wordsOfName = (f) => [...new Set(String(f).replace(/\.[a-z]+$/i, '').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !NAME_NOISE.has(w)))];

export function closestFiles(missing, files, k = 3) {
    const want = wordsOfName(missing);
    if (!want.length) return [];
    const scored = [];
    for (const f of files || []) {
        if (NOT_APP.test(f) || FORBIDDEN_FILES.test(f) || /\.(md|json|ya?ml|map)$/i.test(f)) continue;
        const name = f.split('/').pop().toLowerCase();
        const hit = want.filter((w) => name.includes(w)).length;
        if (hit) scored.push({ f, hit });
    }
    return scored.sort((a, b) => b.hit - a.hit || a.f.length - b.f.length || a.f.localeCompare(b.f)).slice(0, k).map((x) => x.f);
}

export function groundScope(scope, files) {
    const text = String(scope || '').trim();
    const all = [...new Set(files || [])];
    const named = [...new Set(text.match(FILE_TOKEN) || [])];
    if (!text || !all.length || !named.length) return { text, real: [], missing: [], closest: [], changed: false };
    const real = [], missing = [];
    for (const n of named) {
        const clean = n.replace(/^\.?\//, '');
        if (all.includes(clean)) { real.push(clean); continue; }
        const base = clean.split('/').pop();
        const same = all.filter((f) => f.split('/').pop() === base && !NOT_APP.test(f));
        if (same.length === 1) real.push(same[0]); else missing.push(n);
    }
    const uniq = (xs) => [...new Set(xs)];
    const closest = uniq(missing.flatMap((m) => closestFiles(m, all))).filter((f) => !real.includes(f)).slice(0, 4);
    if (!missing.length) return { text, real: uniq(real), missing, closest: [], changed: false };
    const tick = (xs) => xs.map((f) => `\`${f}\``).join(', ');
    const lines = [];
    if (real.length) lines.push(`Files that exist: ${tick(uniq(real))}.`);
    lines.push(`Named by the idea but NOT in this repository (checked by a program; do not look for ${missing.length === 1 ? 'it' : 'them'}): ${tick(missing)}.`);
    lines.push(closest.length
        ? `Real files with the same words in their name, where the work most likely belongs: ${tick(closest)}.`
        : 'No real file has those words in its name, so the place for this work has to be found from what the proposal says, not from a file name.');
    return { text: lines.join('\n'), real: uniq(real), missing, closest, changed: true };
}

// ── what the model must give back ──────────────────────────────────────────────────────────────

const score = (v) => { const n = Number(v); return Number.isFinite(n) ? Math.max(1, Math.min(5, Math.round(n))) : null; };

/** Reads the model's self-assessment. Missing or garbled scores come back null, which `scoresOk` treats as "not good enough". */
export function readScores(j) {
    const s = j && typeof j === 'object' ? (j.scores || j) : {};
    return { ease: score(s.ease), value: score(s.value), small: score(s.small), risk: score(s.risk) };
}
export function readIfThen(j) {
    const raw = Array.isArray(j?.ifThen) ? j.ifThen : (j?.ifThen ? [j.ifThen] : []);
    return raw.map((x) => clip(x, 220)).filter((x) => x.length >= 12).slice(0, 5);
}
export function readEvidence(j) {
    const raw = Array.isArray(j?.evidence) ? j.evidence : String(j?.evidence || '').split(/[\s,;]+/);
    return [...new Set(raw.map((x) => String(x).trim().toUpperCase()).filter((x) => /^[A-Z]\d{1,2}$/.test(x)))].slice(0, 8);
}

/**
 * User-friendliness comes first (owner): an idea that is not easy to use is refused however valuable it claims to be.
 * Thresholds: ease >= 4, value >= 3, small >= 3, risk <= 2. Priority orders ideas that all pass.
 */
export function scoresOk(s) {
    if (!s || [s.ease, s.value, s.small, s.risk].some((v) => v == null)) return { ok: false, why: 'the idea did not score itself' };
    if (s.ease < 4) return { ok: false, why: `not easy enough to use (ease ${s.ease}/5)` };
    if (s.value < 3) return { ok: false, why: `not valuable enough (value ${s.value}/5)` };
    if (s.small < 3) return { ok: false, why: `too big for one focused change (smallness ${s.small}/5)` };
    if (s.risk > 2) return { ok: false, why: `too risky (risk ${s.risk}/5)` };
    return { ok: true, why: '', priority: s.ease * 3 + s.value * 2 + s.small - s.risk * 2 };
}

/** The idea cites at least one id that was really in the prompt (so it is grounded in something that exists). */
export function groundedIn(evidence, signals) {
    const have = new Set((signals || []).map((s) => s.id));
    return (evidence || []).filter((e) => have.has(e));
}

// ── the board's judgement of a self-made idea ───────────────────────────────────────────────────

/** The text the board reads. It says plainly that no owner asked for this, so ASK_OWNER means "do not build it on your own". */
export function boardTextFor(p, owner = 'the owner') {
    return [
        `SYSTEM-GENERATED IDEA. Nobody asked for this: WealthFlow's own AI system thought of it. ${owner} is not in the loop, so you decide whether it is built.`,
        'Answer ASK_OWNER if you are not confident the owner would want it, or if it carries ANY real risk to money, data, security or speed, or if it is not easy to use. One ASK_OWNER from any member stops it.',
        'Answer BUILD or BUILD_SMALLER only if you would be glad to see it in the app.',
        '',
        `Title: ${p.title}`,
        `Problem: ${p.problem}`,
        `If/then reasoning: ${(p.ifThen || []).join(' | ')}`,
        `Proposal: ${p.proposal}`,
        `Scope: ${p.scope}`,
        `Risks named by the author: ${p.risks}`,
    ].join('\n');
}

/**
 * Whether the board lets it through. The owner is not asked, so ONE objection stops it, and fewer than two voters is not a board
 * (it is "try again next run", not a yes). `board` is the object concept-board.synthesize returns.
 */
export function boardAllows(board) {
    if (!board || !board.voters || board.voters < 2) return { ok: false, retry: true, why: 'fewer than two independent AIs could be reached' };
    const asked = (board.votes || []).filter((v) => v.verdict === 'ASK_OWNER').length;
    if (asked > 0) return { ok: false, retry: false, why: `${asked} of ${board.voters} AIs were not confident enough to build it without the owner` };
    return { ok: true, retry: false, why: `${board.voters} AIs from different providers raised no objection` };
}

/** The whole decision, in one place so a test can walk every branch. */
export function decide({ idea, signals, outcomes, board }) {
    const repeat = isRepeat(idea.title, outcomes);
    if (repeat) return { act: 'skip', why: `a near-copy of #${repeat.number} (${repeat.state}): ${repeat.title}` };
    if (!groundedIn(idea.evidence, signals).length) return { act: 'decline', why: 'it cites none of the evidence it was given (not grounded)' };
    if (!idea.ifThen || idea.ifThen.length < 2) return { act: 'decline', why: 'it gave no if/then reasoning' };
    const g = guardIdea(idea);
    if (!g.ok) return { act: 'decline', why: `it touches ${g.reasons.join(', ')}, which only a human may change` };
    const sc = scoresOk(idea.scores);
    if (!sc.ok) return { act: 'decline', why: sc.why };
    if (!board) return { act: 'ask-board', priority: sc.priority };
    const b = boardAllows(board);
    if (b.retry) return { act: 'retry', why: b.why };
    return b.ok ? { act: 'approve', why: b.why, priority: sc.priority } : { act: 'decline', why: b.why };
}

// ── every AI proposes; a program chooses ────────────────────────────────────────────────────────
//
// WHY (measured, 2026-11-11/12): one model was asked for one idea a day. Both live runs ended the same way: that one
// idea broke a rule ("too risky (risk 4/5)", then "touches sign-in or security, a new dependency") and the day
// produced nothing. The owner (2026-11-12): every AI must contribute, and the thinking must be strong.
//
// HOW, and why this shape: the published comparisons of multi-model methods agree on one thing, that independent
// answers from DIFFERENT models are worth more than models talking each other round, and that what decides the
// result is how the winner is chosen. So each available AI proposes on its own (none sees another's idea), a
// PROGRAM applies the rules to every proposal, two AIs landing on the same idea independently counts in its favour,
// and only then does the cross-provider board vote on the best survivor. If none survives, the AIs are shown why
// each idea was refused and asked once more.

/** How many different AIs are asked for an idea in one run, and how many survivors the board may be asked about. */
export const MAX_PROPOSERS = 4, MAX_BOARDS = 2;

/** Two AIs proposing the same thing independently is evidence it is a real need: worth this much priority each. */
export const AGREEMENT_BONUS = 3;

/**
 * Judge every proposal by the rules (no board yet) and order the survivors.
 * @param {{idea:object, by:string}[]} candidates
 * @returns {{ passed: {idea, by, priority, agree:string[]}[], refused: {idea, by, act, why}[] }}
 */
export function rankCandidates(candidates, { signals, outcomes }) {
    const judged = (candidates || []).filter((c) => c && c.idea).map((c) => ({ ...c, verdict: decide({ idea: c.idea, signals, outcomes, board: null }) }));
    const passed = [];
    for (const j of judged.filter((x) => x.verdict.act === 'ask-board')) {
        const agree = [...new Set(judged.filter((o) => o !== j && o.by !== j.by && likeness(o.idea.title, j.idea.title) >= 0.6).map((o) => o.by))];
        passed.push({ idea: j.idea, by: j.by, agree, priority: j.verdict.priority + AGREEMENT_BONUS * agree.length });
    }
    passed.sort((a, b) => b.priority - a.priority);
    // Two survivors that are the same idea are one idea: keep the stronger, so the board is not asked twice about it.
    const unique = [];
    for (const p of passed) if (!unique.some((u) => likeness(u.idea.title, p.idea.title) >= 0.6)) unique.push(p);
    const refused = judged.filter((x) => x.verdict.act !== 'ask-board').map((x) => ({ idea: x.idea, by: x.by, act: x.verdict.act, why: x.verdict.why }));
    return { passed: unique, refused };
}

/** What the AIs are shown before the second round: each refused idea and the rule that refused it. */
export function refusalBrief(refused) {
    const rows = (refused || []).slice(0, 6);
    if (!rows.length) return '';
    return [
        '',
        '',
        'THESE IDEAS WERE JUST PROPOSED AND REFUSED BY THE RULES. Do not propose them again, and do not propose anything refused for the same reason:',
        ...rows.map((r) => `- "${clip(r.idea.title, 90)}": refused because ${r.why}`),
        'Propose a DIFFERENT idea that passes every hard rule: easy to use (ease 4 or 5), low risk (risk 1 or 2), small, grounded in the evidence ids, and nowhere near sign-in, encryption, money arithmetic, paid services, new dependencies or sending data anywhere new.',
    ].join('\n');
}

/**
 * An idea was already filed in the last `hours` hours. The pacemaker may start the idea engine for a slot GitHub
 * skipped and GitHub may then run the late slot as well; the second run must not think of a second idea that day.
 */
export const THINK_AGAIN_HOURS = 18;
export function thoughtRecently(outcomes, now = Date.now(), hours = THINK_AGAIN_HOURS) {
    return (outcomes || []).find((o) => { const t = Date.parse(o.created); return Number.isFinite(t) && now - t >= 0 && now - t < hours * 3600000; }) || null;
}
