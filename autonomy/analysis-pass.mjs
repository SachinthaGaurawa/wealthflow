/* =============================================================================
 * autonomy/analysis-pass.mjs — an independent second mind names the cause, the alternatives and the ways the change can fail
 * -----------------------------------------------------------------------------
 * WHY (the owner's elite-expert prompt, parts 7, 9, 10, 14 and 23)
 *   The author model has just written a change. The prompt asks for what the author is worst placed to do about its own
 *   work: name the real cause and the strongest ALTERNATIVE causes (part 9), the assumptions it rests on (10), how it most
 *   likely FAILS and how that would be noticed and undone (14), and what stays unknown (23). So a model on a DIFFERENT provider
 *   is asked that, once, after the change passes the security review and before the proving test is written.
 *
 *   Three things make it more than a paragraph of opinion:
 *     1. It must QUOTE the code for its claim about the cause (part 7). A program searches the real file for the quote;
 *        a quote that is not there is dropped and the pull request says "citation not found". A made-up citation buys nothing.
 *     2. Its edge cases go to the QA seat as inputs the proving test should cover ("the edge cases the author forgot").
 *     3. It lands in the pull request, labelled as a model's OPINION, next to the evidence ledger, which says what a program
 *        actually verified. The two are never mixed.
 *
 *   It is advice, never a gate. If no provider answers, the run goes on and the ledger says "no independent analysis".
 *
 * `chatImpl` is injectable so the unit tests need no model.
 * ===========================================================================*/

import { chat, extractJson } from './llm-router.mjs';
import { withCharter } from '../wf-charter.mjs';
import { fenceUntrusted } from './untrusted-text.mjs';

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);
const list = (a, n, len) => (Array.isArray(a) ? a : []).map((x) => clip(typeof x === 'string' ? x : (x && (x.what || x.hypothesis || x.text)) || '', len)).filter(Boolean).slice(0, n);

export const ANALYST_SYSTEM = withCharter('You are an independent analyst of a code change to a vanilla-JS personal-finance PWA. You did not write the change. Reply with one JSON object and nothing else.', 'analyst');

const LIMITS = { standard: { failures: 2, edges: 3 }, deep: { failures: 3, edges: 4 }, comprehensive: { failures: 3, edges: 5 } };

export function analysisPrompt({ issueText, file, changeText, depth = 'deep' }) {
    const lim = LIMITS[depth] || LIMITS.deep;
    return [
        'An AI author wrote the change below for the report below. Analyse it independently. You are not the author and you are not a gate.',
        '',
        fenceUntrusted('report', String(issueText).slice(0, 1500), 1500),
        '',
        `FILE: ${file}`,
        'THE CHANGE (unified diff with context; this is the only code you may quote):',
        String(changeText).slice(0, 3500),
        '',
        'Reply with ONE JSON object and nothing else:',
        '{"cause":{"statement":"the real cause of the problem in the report, one sentence","quote":"an EXACT line copied from the code above that shows it, or empty"},',
        ` "alternatives":[{"hypothesis":"another credible cause","tell":"the one observation that would tell it apart"}],   (at most 3, only credible ones)`,
        ` "failure_modes":[{"what":"how this change most likely goes wrong","noticed_by":"test|measurement|canary|log|owner","undo":"revert|restore point|none"}],   (at most ${lim.failures})`,
        ' "assumptions":["assumptions the change rests on that could be false"],   (at most 3)',
        ' "unknowns":["what cannot be known from this code and this report"],   (at most 3)',
        ` "edge_cases":["concrete inputs a test should try, such as an empty list, a negative amount, a Sinhala name, data saved by an older version"]}   (at most ${lim.edges})`,
        'Rules: copy the quote character for character from the diff; if no line shows it, leave quote empty. Do not invent files, functions or numbers. If you cannot tell the cause, say so in the statement.',
    ].join('\n');
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Parse the analyst's reply. Returns null when it is not the JSON asked for. */
export function parseAnalysis(text) {
    const j = extractJson(String(text || ''));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    const c = j.cause && typeof j.cause === 'object' ? j.cause : {};
    const statement = clip(c.statement, 300);
    if (!statement) return null;
    return {
        cause: { statement, quote: clip(c.quote, 240), citation: 'none' },
        alternatives: (Array.isArray(j.alternatives) ? j.alternatives : []).slice(0, 3)
            .map((a) => ({ hypothesis: clip(a && a.hypothesis, 200), tell: clip(a && a.tell, 200) })).filter((a) => a.hypothesis),
        failures: (Array.isArray(j.failure_modes) ? j.failure_modes : []).slice(0, 3)
            .map((f) => ({ what: clip(f && f.what, 220), noticedBy: clip(f && f.noticed_by, 30), undo: clip(f && f.undo, 30) })).filter((f) => f.what),
        assumptions: list(j.assumptions, 3, 200),
        unknowns: list(j.unknowns, 3, 200),
        edgeCases: list(j.edge_cases, 5, 160),
    };
}

/**
 * Check the quote against the real code. 'found' when it appears (whitespace-insensitively) in any of `sources`, 'not-found'
 * when one was given and appears nowhere, 'none' when no quote was given. A quote that is not found is removed.
 */
export function verifyCitations(analysis, sources) {
    if (!analysis) return analysis;
    const q = norm(analysis.cause.quote);
    if (!q) { analysis.cause.citation = 'none'; return analysis; }
    const found = (sources || []).some((s) => norm(s).includes(q));
    analysis.cause.citation = found ? 'found' : 'not-found';
    if (!found) analysis.cause.quote = '';
    return analysis;
}

/**
 * Ask a model that is NOT the author. Fails open: { status:'unavailable' } never stops the run.
 * @returns {Promise<null | { status:'ok'|'unavailable', provider?:string, independent?:boolean, reason?:string, ...parsed }>}
 */
export async function runAnalysis({ issueText, file, before, code, changeText, depth = 'deep', authorProvider = '', env = process.env, chatImpl = chat, log = () => {} } = {}) {
    const prompt = analysisPrompt({ issueText, file, changeText, depth });
    const ask = async (exclude) => chatImpl({ system: ANALYST_SYSTEM, prompt, prefer: ['reasoning'], exclude, maxTokens: 1100, temperature: 0.1, env, timeoutMs: 60000 });
    let r = null, independent = true;
    try {
        r = await ask(authorProvider ? [authorProvider] : []);
    } catch (e1) {
        try { r = await ask([]); independent = false; } catch (e2) {
            log(`[analysis] unavailable: ${e2 && e2.message ? String(e2.message).split('\n')[0] : e2}`);
            return { status: 'unavailable', reason: 'no provider answered' };
        }
    }
    const parsed = parseAnalysis(r && r.text);
    if (!parsed) { log('[analysis] the reply was not the JSON asked for'); return { status: 'unavailable', provider: r && r.provider, reason: 'the reply was not the JSON asked for' }; }
    verifyCitations(parsed, [before, code, changeText]);
    if (r.provider === authorProvider) independent = false;
    log(`[analysis] by ${r.provider}${independent ? '' : ' (same provider as the author)'}: cause citation ${parsed.cause.citation}`);
    return { status: 'ok', provider: r.provider, independent, ...parsed };
}

/** Edge cases and failure modes, as the QA seat should see them. Empty when there is nothing to say. */
export function qaHints(a) {
    if (!a || a.status !== 'ok') return '';
    const items = [...a.edgeCases, ...a.failures.map((f) => f.what)].filter(Boolean).slice(0, 6);
    if (!items.length) return '';
    return ['', 'AN INDEPENDENT ANALYST NAMED THESE WAYS THE CHANGE COULD FAIL (cover the ones this module can show; ignore any that do not apply; do not change the test format):',
        ...items.map((x) => `- ${x}`)].join('\n');
}

/** The pull-request section. Always states that it is a model's opinion. */
export function analysisMarkdown(a) {
    if (!a) return '';
    if (a.status !== 'ok') {
        return ['### Independent analysis', `_No independent analysis was recorded (${a.reason || 'unavailable'})._`].join('\n');
    }
    const L = ['### Independent analysis',
        `_A model's OPINION, by \`${a.provider}\`${a.independent ? ' (not the author\'s provider)' : ' (SAME provider as the author, so not independent)'}. The evidence ledger below says what a program verified; the two are not the same thing._`, ''];
    const cite = a.cause.citation === 'found' ? `quote found in the code: \`${a.cause.quote.replace(/`/g, "'")}\``
        : a.cause.citation === 'not-found' ? 'it quoted a line, but the line was **not found** in the code, so the quote was removed and the claim is unverified'
        : 'it quoted no line, so the claim is unverified';
    L.push(`- **Cause (hypothesis):** ${a.cause.statement} _(${cite})_`);
    for (const x of a.alternatives) L.push(`- **Other credible cause:** ${x.hypothesis}${x.tell ? ` _(tell: ${x.tell})_` : ''}`);
    for (const f of a.failures) L.push(`- **Could fail by:** ${f.what}${f.noticedBy ? ` _(noticed by: ${f.noticedBy}${f.undo ? `; undone by: ${f.undo}` : ''})_` : ''}`);
    for (const x of a.assumptions) L.push(`- **Assumes:** ${x}`);
    for (const x of a.unknowns) L.push(`- **Unknown:** ${x}`);
    return L.join('\n');
}
