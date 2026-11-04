/* =============================================================================
 * autonomy/concept-board.mjs — the AIs talk a new idea through before it is built   (owner, 2026-11-04 18:41Z)
 * -----------------------------------------------------------------------------
 * WHY (owner): "If I send new features and concepts as feedback, consider that and discuss with all the AIs ... User
 * friendly is the most important." Until now a feature report went straight to an author model that saw only the
 * report: nobody asked how to make it easy to use, what it could break, or what the smallest good first version is.
 *
 * WHAT IT DOES: up to three DIFFERENT providers answer the same five questions about the idea, user-friendliness
 * first. Their answers are merged into (1) a short brief that goes to the author as part of the request, and (2) one
 * comment on the issue so the owner can read the discussion.
 *
 * WHAT IT DOES NOT DO: it never vetoes. The owner is WealthFlow's only user, so the owner's request is the decision;
 * the board's job is to make the first version better and to name real danger to money, data or security. If a
 * majority say something essential is missing, that is written in the comment as a question for the owner; the work
 * still goes ahead on the safest reading, because a stalled idea is worse than a reversible first version.
 * ===========================================================================*/

import { chatMany, extractJson } from './llm-router.mjs';

export const BOARD_MARKER = '<!-- wf-concept-board -->';
export const MAX_VOTERS = 3;

/** A report asks for something new (not a defect, not a layout complaint). */
export function conceptBoardFor(issue, kind) {
    const t = `${issue?.title || ''}\n${issue?.body || ''}`.toLowerCase();
    if (kind === 'feature') return true;
    return /\b(new (feature|idea|concept|option|page|screen|tool|section)|add an? |integrat\w*|i want|i would like|it would be (good|nice)|can you (add|make|build)|idea)\b/.test(t)
        && !/\b(crash|overlap|white screen|wrong total|not working|error)\b/.test(t);
}

export function boardPrompt(issueText) {
    return [
        'You are one member of a board of AIs that advises the sole owner of WealthFlow, a personal-finance PWA used on a phone in Sri Lanka (LKR).',
        'The owner sent this idea. The owner decides; you make the first version better. The most important quality is that it is EASY to use.',
        '', 'IDEA:', String(issueText).slice(0, 1800), '',
        'Reply with ONE JSON object and nothing else:',
        '{"clear":true|false,',
        ' "easy":"how to make it simplest for a non-technical person on a small phone screen: at most 3 short steps, no jargon",',
        ' "risks":["real risks to money, data, security or speed; at most 3, each under 20 words; [] if none"],',
        ' "first_version":"the smallest version that is useful and safe, one sentence",',
        ' "missing":"a fact only the owner knows that is essential, or empty",',
        ' "verdict":"BUILD" | "BUILD_SMALLER" | "ASK_OWNER"}',
        'BUILD_SMALLER means build only the first version. ASK_OWNER only when building the wrong thing would waste the owner\'s money or data.',
    ].join('\n');
}

const clip = (s, n) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, n);

export function parseVote(text, provider = '?') {
    const j = extractJson(String(text || ''));
    if (!j || typeof j !== 'object') return null;
    const verdict = ['BUILD', 'BUILD_SMALLER', 'ASK_OWNER'].includes(String(j.verdict).toUpperCase()) ? String(j.verdict).toUpperCase() : null;
    if (!verdict) return null;
    return {
        provider, verdict, clear: j.clear !== false,
        easy: clip(j.easy, 320), first: clip(j.first_version, 240), missing: clip(j.missing, 240),
        risks: (Array.isArray(j.risks) ? j.risks : []).map((r) => clip(r, 160)).filter(Boolean).slice(0, 3),
    };
}

/** Merge the votes: majority verdict, every distinct risk once, each member's easy-to-use idea attributed. */
export function synthesize(votes) {
    const v = (votes || []).filter(Boolean);
    if (!v.length) return { voters: 0, verdict: 'BUILD', easy: [], risks: [], first: '', question: '' };
    const count = (x) => v.filter((a) => a.verdict === x).length;
    const ask = count('ASK_OWNER'), small = count('BUILD_SMALLER');
    const verdict = v.length >= 2 && ask * 2 > v.length ? 'ASK_OWNER' : (small * 2 >= v.length && small > 0) || ask > 0 ? 'BUILD_SMALLER' : 'BUILD';
    const seen = new Set(), risks = [];
    for (const a of v) for (const r of a.risks) { const k = r.toLowerCase().slice(0, 40); if (!seen.has(k)) { seen.add(k); risks.push(r); } }
    return {
        voters: v.length, verdict,
        easy: v.filter((a) => a.easy).map((a) => ({ provider: a.provider, text: a.easy })),
        risks: risks.slice(0, 6),
        first: (v.find((a) => a.verdict !== 'ASK_OWNER' && a.first) || v.find((a) => a.first) || {}).first || '',
        question: verdict === 'ASK_OWNER' ? (v.find((a) => a.missing) || {}).missing || '' : '',
        votes: v.map((a) => ({ provider: a.provider, verdict: a.verdict })),
    };
}

/** What the author model is told, appended to the owner's request. Kept short and plain. */
export function briefFor(s) {
    if (!s || !s.voters) return '';
    return [
        '', 'BOARD BRIEF (the AIs discussed this idea; the owner\'s words above stay the decision):',
        '- Being EASY TO USE comes first: ' + (s.easy.map((e) => e.text).join(' | ') || 'keep it to as few taps as possible').slice(0, 700),
        s.first ? `- Build this first version: ${s.first}` : '',
        s.risks.length ? `- Take care of: ${s.risks.join('; ')}` : '',
    ].filter(Boolean).join('\n');
}

export function renderComment(s) {
    if (!s || !s.voters) return '';
    const L = [BOARD_MARKER, '### [AI] Board discussion of this idea', '',
        `${s.voters} AI model(s) from different providers read the idea. Verdict: **${s.verdict === 'BUILD' ? 'build it' : s.verdict === 'BUILD_SMALLER' ? 'build a smaller first version' : 'one question for the owner'}**. The owner decides; this only shapes the first version.`, ''];
    if (s.easy.length) { L.push('**Making it easy to use**'); for (const e of s.easy) L.push(`- ${e.text} _(${e.provider})_`); L.push(''); }
    if (s.first) L.push(`**First version:** ${s.first}`, '');
    if (s.risks.length) { L.push('**Take care of**'); for (const r of s.risks) L.push(`- ${r}`); L.push(''); }
    if (s.question) L.push(`**Question for the owner:** ${s.question}`, '_Work continues on the safest reading in the meantime; answer here and the next attempt uses it._', '');
    L.push(`<!-- wf-board-json:${encodeURIComponent(JSON.stringify(s))} -->`);
    L.push('\n---\n_Generated by [Claude Code](https://claude.ai/code)_');
    return L.join('\n');
}

/** Read a board back from its own comment, so one idea is discussed once and not on every attempt. */
export function parseStoredBoard(body) {
    const m = /<!-- wf-board-json:([^ ]+) -->/.exec(String(body || ''));
    if (!m) return null;
    try {
        const s = JSON.parse(decodeURIComponent(m[1]));
        return s && typeof s === 'object' && Number.isFinite(s.voters) ? s : null;
    } catch { return null; }
}

export async function runConceptBoard({ issueText, env = process.env, ask = chatMany, log = () => {} } = {}) {
    try {
        const rs = await ask({ prompt: boardPrompt(issueText), maxTokens: 700, temperature: 0.3, env, prefer: ['reasoning', 'general'] }, MAX_VOTERS);
        const votes = (rs || []).map((r) => parseVote(r.text, r.provider)).filter(Boolean);
        const s = synthesize(votes);
        log(`[board] ${s.voters} voter(s): ${s.verdict}`);
        return s;
    } catch (e) {
        log(`[board] skipped: ${e?.message || e}`);
        return synthesize([]);
    }
}
