/* =============================================================================
 * api/ai-matrix.mjs — the Parallel AI Matrix: who answers, and who checks them
 * -----------------------------------------------------------------------------
 * api/ai.js already fires every configured engine SIMULTANEOUSLY. That part was
 * never the problem. What it did with the answers was:
 *
 *   mode=fastest    the first valid reply wins, and is returned. Nothing else
 *                   is read. This is the default for every prose and chat call.
 *   mode=consensus  all replies are gathered. For JSON, a real field-by-field
 *                   majority vote. For PROSE, "the longest substantive answer",
 *                   which is a length heuristic wearing a consensus label.
 *
 * So the honest description of the old behaviour is: sixteen engines run in
 * parallel, and on the most common path exactly one of them is read. That is a
 * silo — a fast one, with fifteen witnesses whose testimony is discarded.
 *
 * WHAT THIS MODULE DOES
 *
 * It is the decision half, extracted from the I/O half so it can be tested
 * without a network. api/ai.js still owns the fetching; this owns the reading.
 *
 *   1. CORROBORATION REPLACES THE RACE. Instead of the first valid reply,
 *      `decide()` waits for a quorum and returns the answer the quorum agrees
 *      on. One engine is only ever the answer when one engine is all there was,
 *      and that case is LABELLED `solo` rather than presented as agreement.
 *
 *   2. DELEGATION WITHOUT SILOS. `orderFor()` is the CEO half: a task is led by
 *      the engines suited to it. But the lead only ever breaks a TIE. It cannot
 *      overrule a majority, and its answer is corroborated like anyone's. A
 *      specialist who cannot be contradicted is not a specialist, it is a
 *      single point of failure with a title.
 *
 *   3. DISAGREEMENT IS REPORTED, NOT SMOOTHED. Every decision carries how many
 *      engines agreed, out of how many answered, who dissented, and — for a
 *      financial app, the one that matters — whether the engines that agreed in
 *      WORDING disagreed on the NUMBERS. Two models can phrase the same
 *      sentence and name different amounts, and a system that reports "3 of 4
 *      agreed" while they disagree on the figure is worse than one that says
 *      nothing.
 *
 * WHAT THE ORDERING TABLE IS, AND IS NOT
 *
 * SPECIALISTS below is POLICY, not a measurement. Which engine is "best at
 * Sinhala" is not something this file can prove, and pretending otherwise would
 * be the same mistake as a scanner reporting clean on a shape it was never
 * taught. What IS factual is capability — a text-only engine cannot read an
 * image — and that is enforced separately, by which engines api/ai.js puts in
 * the vision list at all. The order here breaks ties and nothing else, so a
 * wrong guess costs a tie-break, never an answer.
 *
 * NO I/O. No fetch, no clock, no environment. Every function is a function of
 * its arguments, which is why test/ai_matrix_test.js can hold the whole matrix
 * still and ask it hard questions.
 * ===========================================================================*/

/** Task kinds the router understands. */
export const TASK = {
    VISION: 'vision',          // a receipt, a statement, anything with an image
    EXTRACTION: 'extraction',  // structured JSON out of text
    PROSE: 'prose',            // explanation, chat, advice
    CLASSIFY: 'classify',      // short label answers
};

/**
 * Preference order per task. POLICY, not measurement — see the header.
 * An engine absent from a list is not excluded; it simply has no tie-break
 * priority for that task. Unknown engines sort last, in the order given.
 */
export const SPECIALISTS = {
    [TASK.VISION]: ['Gemini', 'Anthropic', 'GitHubModels', 'xAI', 'Groq', 'Mistral', 'Together', 'NVIDIA'],
    [TASK.EXTRACTION]: ['Anthropic', 'Gemini', 'DeepSeek', 'Mistral', 'Groq', 'xAI', 'Cerebras'],
    [TASK.PROSE]: ['Anthropic', 'Gemini', 'DeepSeek', 'Cohere', 'Mistral', 'Groq', 'xAI'],
    [TASK.CLASSIFY]: ['Groq', 'Cerebras', 'Gemini', 'Mistral', 'DeepSeek'],
};

/** How many corroborating answers a decision wants before it stops waiting. */
export const DEFAULT_QUORUM = 3;

/** Token overlap at or above this counts two prose answers as the same claim. */
export const SAME_CLAIM = 0.6;

/**
 * Order the available engines for a task: leads first, everyone else after.
 *
 * Everyone still RUNS — this is not a shortlist. It is the order in which ties
 * are broken, which is the only power a specialist gets here.
 */
export function orderFor(task, available) {
    const names = Array.isArray(available) ? available.filter(Boolean).map(String) : [];
    const pref = SPECIALISTS[task] || [];
    const rank = (n) => {
        const i = pref.indexOf(n);
        return i === -1 ? pref.length + names.indexOf(n) : i;
    };
    return names.slice().sort((a, b) => rank(a) - rank(b));
}

/* ── comparing two answers ────────────────────────────────────────────────── */

/**
 * Normalise for comparison: case-folded, punctuation stripped, whitespace
 * collapsed. Unicode-aware on purpose — this app answers in Sinhala as well as
 * English, and an ASCII-only word regex silently reduces a Sinhala reply to the
 * empty string, which would make every Sinhala answer look identical to every
 * other one and hand the quorum a unanimous agreement about nothing.
 */
export function normaliseReply(s) {
    return String(s == null ? '' : s)
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/** Content words of a reply, as a Set. */
export function tokensOf(s) {
    const n = normaliseReply(s);
    return new Set(n ? n.split(' ') : []);
}

/** Jaccard overlap of two replies: 0 (nothing shared) to 1 (same words). */
export function similarity(a, b) {
    const A = tokensOf(a), B = tokensOf(b);
    if (!A.size && !B.size) return 1;
    if (!A.size || !B.size) return 0;
    let shared = 0;
    for (const t of A) if (B.has(t)) shared++;
    return shared / (A.size + B.size - shared);
}

/**
 * Every number in a reply, normalised so 1,250.00 and 1250 are the same figure.
 *
 * THIS IS THE ONE THAT MATTERS IN A FINANCIAL APP. Two engines can produce
 * sentences that overlap almost completely and name different amounts — the
 * wording agrees, the money does not. Word similarity cannot see that, so the
 * numbers are compared separately and reported separately.
 */
export function numbersOf(s) {
    const out = new Set();
    const re = /-?\d[\d,\s]*(?:\.\d+)?/g;
    let m;
    while ((m = re.exec(String(s == null ? '' : s))) !== null) {
        const v = parseFloat(m[0].replace(/[,\s]/g, ''));
        if (Number.isFinite(v)) out.add(v);
    }
    return out;
}

/** Do two replies name the same set of figures? */
export function numbersAgree(a, b) {
    const A = numbersOf(a), B = numbersOf(b);
    if (A.size !== B.size) return false;
    for (const v of A) if (!B.has(v)) return false;
    return true;
}

/* ── the near-miss problem ────────────────────────────────────────────────
 *
 * WORD OVERLAP IS THE WRONG INSTRUMENT FOR THIS JOB, AND A TEST PROVED IT.
 *
 *     "The rent is due on the third."
 *     "The rent is due on the fifteenth."
 *
 * Those share five of seven words — a Jaccard overlap of 0.71. Two genuine
 * paraphrases of the SAME answer:
 *
 *     "You run out of money on 12 October."
 *     "Your balance goes negative on 12 October."
 *
 * share about 0.4. So the metric scores a pair that contradicts each other
 * HIGHER than a pair that agrees, and no threshold can separate them: the
 * ordering is inverted, not merely mis-tuned. Clustering on overlap alone made
 * the two rent answers corroborate each other, and the tie then went to
 * whichever engine the specialist table happened to rank first.
 *
 * That is the worst failure available to this module. An obvious disagreement
 * is safe — it shows up as a split and nobody acts on it. A NEAR MISS reads as
 * agreement while naming a different day, or a different amount.
 *
 * So corroboration needs two conditions, not one: the wording must overlap AND
 * the specifics must not contradict. `contradicts()` is deliberately narrow —
 * a specific class only counts when BOTH replies name one, so an answer that
 * simply gives less detail is not treated as disagreeing with a fuller one.
 *
 * SCOPE, STATED HONESTLY: numbers are language-neutral and catch the case that
 * matters most in a financial app. The ordinal and month words below are
 * ENGLISH ONLY. A Sinhala reply naming a date in words is not covered by them,
 * and is covered by the numeric path whenever the date carries a figure. This
 * is a floor, not a ceiling, and it is written down rather than implied.
 */
const ORDINAL_WORDS = new Set([
    'first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth',
    'eleventh', 'twelfth', 'thirteenth', 'fourteenth', 'fifteenth', 'sixteenth', 'seventeenth',
    'eighteenth', 'nineteenth', 'twentieth', 'thirtieth', 'thirty', 'last',
]);

const MONTH_WORDS = new Set([
    'january', 'february', 'march', 'april', 'may', 'june', 'july', 'august',
    'september', 'october', 'november', 'december',
    'jan', 'feb', 'mar', 'apr', 'jun', 'jul', 'aug', 'sep', 'sept', 'oct', 'nov', 'dec',
]);

const wordsIn = (s, vocab) => {
    const out = new Set();
    for (const t of tokensOf(s)) if (vocab.has(t)) out.add(t);
    return out;
};

/** Ordinal day-words named in a reply. English only — see the block above. */
export function ordinalsOf(s) { return wordsIn(s, ORDINAL_WORDS); }

/** Month names named in a reply. English only — see the block above. */
export function monthsOf(s) { return wordsIn(s, MONTH_WORDS); }

const sameSet = (A, B) => {
    if (A.size !== B.size) return false;
    for (const v of A) if (!B.has(v)) return false;
    return true;
};

/**
 * Do two replies CONTRADICT on a specific?
 *
 * Only when both name one of that class and the sets differ. One reply giving
 * a figure the other omits is less detail, not disagreement — treating it as
 * disagreement would split every cluster where one engine was terser.
 */
export function contradicts(a, b) {
    const pairs = [[numbersOf(a), numbersOf(b)], [ordinalsOf(a), ordinalsOf(b)], [monthsOf(a), monthsOf(b)]];
    for (const [A, B] of pairs) {
        if (A.size && B.size && !sameSet(A, B)) return true;
    }
    return false;
}

/** Two replies make the same claim: they read alike AND nothing contradicts. */
export function sameClaim(a, b, threshold = SAME_CLAIM) {
    return similarity(a, b) >= threshold && !contradicts(a, b);
}

/**
 * A NEAR MISS: reads like agreement, names something different.
 * The single most dangerous shape a financial answer can take.
 */
export function isNearMiss(a, b, threshold = SAME_CLAIM) {
    return similarity(a, b) >= threshold && contradicts(a, b);
}

/* ── JSON answers ─────────────────────────────────────────────────────────── */

/** Parse a reply that is meant to be JSON, tolerating a fenced code block. */
export function parseJson(s) {
    const txt = String(s == null ? '' : s).trim()
        .replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    try {
        const v = JSON.parse(txt);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
    } catch (_) {
        const i = txt.indexOf('{'), j = txt.lastIndexOf('}');
        if (i === -1 || j <= i) return null;
        try {
            const v = JSON.parse(txt.slice(i, j + 1));
            return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
        } catch (__) { return null; }
    }
}

/**
 * Field-by-field majority across parsed JSON answers.
 *
 * Returns `{ majority, agreement }` — the winning value per field, and the
 * share of answers that named it. A field only one engine mentioned has an
 * agreement of 1/n, which is exactly what it should look like: present, and
 * uncorroborated.
 */
export function fieldVote(objects) {
    const list = (Array.isArray(objects) ? objects : []).filter((o) => o && typeof o === 'object');
    const majority = {};
    const agreement = {};
    if (!list.length) return { majority, agreement };

    const keys = new Set();
    for (const o of list) for (const k of Object.keys(o)) keys.add(k);

    for (const k of keys) {
        const counts = new Map();
        for (const o of list) {
            if (!(k in o) || o[k] == null || o[k] === '') continue;
            // Compared by serialised value so 12 and "12" do not split a vote,
            // and so objects and arrays can be voted on at all.
            const key = typeof o[k] === 'object' ? JSON.stringify(o[k]) : String(o[k]).trim().toLowerCase();
            const cur = counts.get(key) || { n: 0, value: o[k] };
            cur.n++;
            counts.set(key, cur);
        }
        if (!counts.size) continue;
        let best = null;
        for (const c of counts.values()) if (!best || c.n > best.n) best = c;
        majority[k] = best.value;
        agreement[k] = best.n / list.length;
    }
    return { majority, agreement };
}

/* ── the decision ─────────────────────────────────────────────────────────── */

/**
 * Choose the answer, and say how well supported it is.
 *
 * `results` are `{ name, ok, reply, provider, ms }` as api/ai.js produces them.
 * Nothing here fetches; a result that never arrived is simply absent.
 *
 * THE RULE THAT MAKES "NO SILOS" CHECKABLE: when two or more engines answered,
 * the returned reply must belong to a cluster that at least two engines support,
 * unless no two engines agree at all — and in that case `mode` is `split` and
 * the dissent is listed, so a caller can decline to act on it. A single engine's
 * answer is returned as `solo` only when it was the only answer there was.
 */
export function decide(results, opts = {}) {
    const task = opts.task || TASK.PROSE;
    const wantJson = opts.json === true;
    const threshold = typeof opts.sameClaim === 'number' ? opts.sameClaim : SAME_CLAIM;

    const all = Array.isArray(results) ? results : [];
    const good = all.filter((r) => r && r.ok && typeof r.reply === 'string' && r.reply.trim().length > 1);
    const answered = good.map((r) => r.name);

    if (!good.length) {
        return {
            reply: null, provider: null, mode: 'none', task,
            corroboration: { agreed: 0, of: 0, score: 0, dissent: [], nearMisses: [], numericConflict: false },
            answered: [], failed: all.filter((r) => r && !r.ok).map((r) => r.name),
        };
    }

    const order = orderFor(task, answered);
    const lead = (name) => order.indexOf(name);

    if (good.length === 1) {
        const only = good[0];
        return {
            reply: only.reply, provider: only.provider, mode: 'solo', task,
            // Named, not implied. A caller that wants to refuse an
            // uncorroborated answer needs to be able to see that it is one.
            soloReason: 'only one engine answered',
            corroboration: { agreed: 1, of: 1, score: 1, dissent: [], nearMisses: [], numericConflict: false },
            answered, failed: all.filter((r) => r && !r.ok).map((r) => r.name),
        };
    }

    /* ── JSON: vote per field, then return the answer closest to the vote ── */
    if (wantJson) {
        const parsed = good.map((r) => ({ r, obj: parseJson(r.reply) }));
        const usable = parsed.filter((p) => p.obj);
        if (usable.length >= 2) {
            const { majority, agreement } = fieldVote(usable.map((p) => p.obj));
            const keys = Object.keys(majority);
            const scoreOf = (obj) => {
                if (!keys.length) return 0;
                let hit = 0;
                for (const k of keys) {
                    const a = obj[k], b = majority[k];
                    if (a == null || b == null) continue;
                    const av = typeof a === 'object' ? JSON.stringify(a) : String(a).trim().toLowerCase();
                    const bv = typeof b === 'object' ? JSON.stringify(b) : String(b).trim().toLowerCase();
                    if (av === bv) hit++;
                }
                return hit / keys.length;
            };
            let best = null;
            for (const p of usable) {
                const s = scoreOf(p.obj);
                if (!best || s > best.s || (s === best.s && lead(p.r.name) < lead(best.p.r.name))) best = { p, s };
            }
            const values = Object.values(agreement);
            const mean = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
            return {
                reply: best.p.r.reply, provider: best.p.r.provider, mode: 'consensus', task,
                fields: majority,
                fieldAgreement: agreement,
                corroboration: {
                    agreed: Math.round(mean * usable.length),
                    of: usable.length,
                    score: mean,
                    dissent: usable.filter((p) => p !== best.p && scoreOf(p.obj) < 1).map((p) => ({ name: p.r.name, score: scoreOf(p.obj) })),
                    nearMisses: [],
                    numericConflict: false,
                },
                answered, failed: all.filter((r) => r && !r.ok).map((r) => r.name),
            };
        }
        // Fewer than two parsed. Fall through to prose clustering rather than
        // returning an unparsed answer as though a vote had been held.
    }

    /* ── prose: cluster by claim, largest cluster wins ─────────────────── */
    const same = good.map((a) => good.map((b) => (a === b ? true : sameClaim(a.reply, b.reply, threshold))));
    const near = good.map((a) => good.map((b) => (a === b ? false : isNearMiss(a.reply, b.reply, threshold))));
    const support = good.map((_, i) => same[i].filter((v, j) => j !== i && v).length);

    let bi = 0;
    for (let i = 1; i < good.length; i++) {
        if (support[i] > support[bi]) { bi = i; continue; }
        if (support[i] === support[bi]) {
            const li = lead(good[i].name), lb = lead(good[bi].name);
            if (li < lb) bi = i;
            else if (li === lb && good[i].reply.length > good[bi].reply.length) bi = i;
        }
    }

    const cluster = good.filter((_, j) => j === bi || same[bi][j]);
    const dissent = good
        .map((r, j) => ({ r, j }))
        .filter(({ j }) => j !== bi && !same[bi][j] && !near[bi][j])
        .map(({ r, j }) => ({ name: r.name, score: similarity(good[bi].reply, r.reply) }));

    // Reads like the winner, names something else. Listed separately from plain
    // dissent because it is a different and worse problem: a reader skimming
    // two near-identical sentences will not notice which day they name.
    const nearMisses = good
        .map((r, j) => ({ r, j }))
        .filter(({ j }) => j !== bi && near[bi][j])
        .map(({ r, j }) => ({
            name: r.name,
            score: similarity(good[bi].reply, r.reply),
            numbers: [...numbersOf(r.reply)],
        }));

    const agreed = cluster.length;
    return {
        reply: good[bi].reply,
        provider: good[bi].provider,
        // `split` when nothing corroborated the winner: it is still the best
        // available answer, and the caller is told it stands alone.
        mode: agreed > 1 ? 'corroborated' : 'split',
        task,
        corroboration: {
            agreed,
            of: good.length,
            score: agreed / good.length,
            dissent,
            nearMisses,
            numericConflict: nearMisses.length > 0,
        },
        answered, failed: all.filter((r) => r && !r.ok).map((r) => r.name),
    };
}

/**
 * Is this decision safe to act on without a human reading it first?
 *
 * Deliberately strict, and deliberately here rather than in each caller: a rule
 * every surface has to re-implement is a rule some surface will get wrong.
 */
export function trustworthy(decision, opts = {}) {
    const min = typeof opts.minAgreed === 'number' ? opts.minAgreed : 2;
    if (!decision || !decision.reply) return false;
    if (decision.mode === 'solo' || decision.mode === 'split') return false;
    // A near miss is a refusal even when the cluster is large: an answer that
    // reads like the others and names a different figure must reach a person.
    if (decision.corroboration.numericConflict) return false;
    if ((decision.corroboration.nearMisses || []).length) return false;
    return decision.corroboration.agreed >= min;
}

export default {
    TASK, SPECIALISTS, DEFAULT_QUORUM, SAME_CLAIM, orderFor, normaliseReply, tokensOf, similarity,
    numbersOf, numbersAgree, ordinalsOf, monthsOf, contradicts, sameClaim, isNearMiss,
    parseJson, fieldVote, decide, trustworthy,
};
