/*  autonomy/mutation-check.mjs
 *  ---------------------------------------------------------------------------
 *  Does the agent's proving test notice when the fix is broken a little?
 *
 *  WHY (2026 agentic-testing research, "misguidance effect"): a model asked to test its own change tends to
 *  write assertions that merely describe what the change does. Such a test goes red→green and still catches
 *  nothing. `verifyTestProves` already demands red on the old file and green on the new one; this adds the
 *  second half: break the NEW lines on purpose (flip a comparison, swap +/-, negate a boolean) and require the
 *  test to fail. A test that stays green while the fixed lines are sabotaged is decoration.
 *
 *  Scope is deliberately small and honest: only lines the agent changed, at most MAX_MUTANTS mutants, only
 *  mechanical operator swaps that keep the file syntactically valid. It is not StrykerJS; it needs no new
 *  dependency and costs a handful of single-file Vitest runs. Mutants that do not parse are discarded and do
 *  not count either way. The caller decides what a weak score means; this module only measures.
 */

import fs from 'node:fs';
import path from 'node:path';

export const MAX_MUTANTS = 6;
export const MIN_MUTANTS_TO_JUDGE = 3;
export const KILL_RATIO_FLOOR = 0.5;

/** Line numbers (1-based, in `after`) that differ from `before`. Order-independent multiset compare, cheap and good enough. */
export function changedLines(before, after) {
    const pool = new Map();
    for (const l of String(before || '').split('\n')) pool.set(l, (pool.get(l) || 0) + 1);
    const out = [];
    String(after || '').split('\n').forEach((line, i) => {
        const left = pool.get(line) || 0;
        if (left > 0) pool.set(line, left - 1);
        else if (line.trim()) out.push(i + 1);
    });
    return out;
}

// One swap per rule; the first match on a line is used. Comments and strings are skipped by a crude strip.
const RULES = [
    { name: '>= to >', re: />=/, to: '>' },
    { name: '<= to <', re: /<=/, to: '<' },
    { name: '=== to !==', re: /===/, to: '!==' },
    { name: '!== to ===', re: /!==/, to: '===' },
    { name: '&& to ||', re: /&&/, to: '||' },
    { name: '|| to &&', re: /\|\|/, to: '&&' },
    { name: 'true to false', re: /\btrue\b/, to: 'false' },
    { name: 'false to true', re: /\bfalse\b/, to: 'true' },
    { name: '+ to -', re: /(?<=[\w)\]]\s)\+(?=\s[\w(])/, to: '-' },
    { name: '> to <=', re: /(?<![=<>-])>(?![=>])/, to: '<=' },
    { name: '< to >=', re: /(?<![=<>!])<(?![=<])/, to: '>=' },
];

function codePart(line) {
    return line.replace(/\/\/.*$/, '').replace(/(['"`])(?:\\.|(?!\1).)*\1/g, (m) => ' '.repeat(m.length));
}

/** Up to `max` mutants of `source`, on `lines` only: [{line, rule, source}] with the mutated whole file. */
export function makeMutants(source, lines, max = MAX_MUTANTS) {
    const rows = String(source || '').split('\n');
    const out = [];
    for (const n of lines) {
        const raw = rows[n - 1];
        if (raw === undefined) continue;
        const code = codePart(raw);
        if (/^\s*(\*|\/\*|import\b|export\s+\{)/.test(code)) continue;
        for (const rule of RULES) {
            const m = rule.re.exec(code);
            if (!m) continue;
            const mutatedLine = raw.slice(0, m.index) + rule.to + raw.slice(m.index + m[0].length);
            if (mutatedLine === raw) continue;
            const copy = rows.slice();
            copy[n - 1] = mutatedLine;
            out.push({ line: n, rule: rule.name, source: copy.join('\n') });
            break; // one mutant per line keeps the run short and the report readable
        }
    }
    // spread across the file instead of taking only the first lines
    if (out.length <= max) return out;
    const step = out.length / max;
    return Array.from({ length: max }, (_, i) => out[Math.floor(i * step)]);
}

/**
 * Run the test against each mutant of the fixed file. `run(testFile,{repoDir})` -> {passed}. `isValid(src)` is
 * optional (a syntax check); a mutant that does not parse is dropped. Always restores `after`.
 * @returns {{skipped:boolean, reason?:string, total:number, killed:number, survived:{line:number,rule:string}[], weak:boolean}}
 */
export function mutationCheck({
    repoDir = process.cwd(), targetFile, before, after, testFile, testSource, run, isValid = () => true, log = () => {},
    max = MAX_MUTANTS,
} = {}) {
    const none = (reason) => ({ skipped: true, reason, total: 0, killed: 0, survived: [], weak: false });
    if (!targetFile || !testFile || typeof run !== 'function') return none('nothing to mutate');
    const mutants = makeMutants(after, changedLines(before, after), max).filter((m) => isValid(m.source));
    if (mutants.length === 0) return none('no mechanical mutation possible on the changed lines');
    const target = path.join(repoDir, targetFile);
    const tPath = path.join(repoDir, testFile);
    let wroteTest = false;
    let killed = 0;
    const survived = [];
    try {
        // The verifier removes the test file when it is done; without it every mutant would 'fail' for the wrong reason.
        if (testSource) { fs.mkdirSync(path.dirname(tPath), { recursive: true }); fs.writeFileSync(tPath, testSource); wroteTest = true; }
        for (const m of mutants) {
            fs.writeFileSync(target, m.source);
            const r = run(testFile, { repoDir });
            if (r && r.passed) survived.push({ line: m.line, rule: m.rule });
            else killed += 1;
        }
    } finally {
        try { fs.writeFileSync(target, after); } catch { /* the caller restores `before` itself */ }
        if (wroteTest) { try { fs.unlinkSync(tPath); } catch { /* ditto */ } }
    }
    const total = mutants.length;
    const weak = total >= MIN_MUTANTS_TO_JUDGE && killed / total < KILL_RATIO_FLOOR;
    log(`[swarm] mutation check: ${killed}/${total} sabotaged versions of the fix were caught${weak ? ' (weak)' : ''}`);
    return { skipped: false, total, killed, survived, weak };
}

/** The sentence given back to the test author when the check was weak. */
export function weakTestReason(res) {
    const where = (res.survived || []).slice(0, 4).map((s) => `line ${s.line} (${s.rule})`).join(', ');
    return `the test only caught ${res.killed} of ${res.total} deliberately broken versions of the fix; it kept passing when ${where} was changed. Assert the exact observable result of those lines (a value, a text, a call), not only that the code runs`;
}
