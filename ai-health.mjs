/* =============================================================================
 * ai-health.mjs — the AI roster, asked on demand, with nothing to infer
 * -----------------------------------------------------------------------------
 * Every earlier look at the AI board was a reading of production logs after the fact: scattered warnings, one per failing provider, from
 * which the board's outcome had to be reconstructed — and from which, on 2026-10-01, a count of log LINES was briefly mistaken for a count
 * of calls (101 lines were 19 calls). This makes the answer a thing that can be asked for:
 *
 *   GET /api/ai?canary=1   runs ONE synthetic financial decision — ten rows, asked in exactly the words, with the same vocabulary, token room and deadline a statement's
 *                          board gets (statement-board.mjs proposalPrompt) — through the real engine code, every configured provider, cooldowns
 *                          ignored — and answers with what each provider did: answered or not, how long it took, the model that answered,
 *                          the first words of its reply, or the (redacted) reason it did not. Rate-limited: a report younger than
 *                          CANARY_GAP_MS is served from the store and no provider is called, so the address cannot be used to burn quota.
 *   GET /api/ai?health=1   the last report, and its age. Never calls a provider.
 *
 * WHY TEN ROWS. The first canary asked ONE row and said nine of fourteen providers were fine; real boards of ten rows saw five to seven valid voters, because two of those nine
 * (NVIDIA and OpenRouter's Nemotron, thinking models) are valid on a one-line answer and not on a long one. A health check that asks an easier question than the work is optimistic by
 * construction. The rows have one clearly right answer each, so the report can also say how many each provider got right, and how many rows EVERY voter agreed on (the unit the
 * statement board now releases, api/ai-matrix.mjs itemwiseReading). Why an answer was refused (cut off, prose around it, broken syntax) is named, not just counted.
 *
 * The prompt is fixed and carries nothing of the owner's. Provider errors are redacted before they leave (keys, bearer tokens, long
 * hex/base64 runs). Pure but for the injected store.
 * ===========================================================================*/

import { boardAnswer, boardReading, whyInvalid } from './api/ai-matrix.mjs';
import { proposalPrompt, PROPOSAL } from './statement-board.mjs';

export const CANARY_GAP_MS = 90 * 1000;
/** The room and the time a statement's board gives its providers (statement-sync.js askBoard): the canary asks with the same, or it measures an easier question than the work. */
export const CANARY_MAX_TOKENS = 3500;
export const CANARY_DEADLINE_MS = 13000;
export const DOC = { collection: 'wf-ai', id: 'canary' };

/** Ten rows, each with ONE clearly right answer in the board's own vocabulary. Nothing of the owner's: invented merchants, invented amounts. */
export const CANARY_ROWS = Object.freeze([
    { description: 'POS KEELLS SUPER NUGEGODA', merchant: 'KEELLS SUPER', amount: 4820.5, direction: 'debit', module: 'expenses', category: 'Groceries' },
    { description: 'DIALOG AXIATA RELOAD 0777123456', merchant: 'DIALOG AXIATA', amount: 1000, direction: 'debit', module: 'expenses', category: 'Telecom' },
    { description: 'CEYPETCO FILLING STATION KIRIBATHGODA', merchant: 'CEYPETCO', amount: 9000, direction: 'debit', module: 'expenses', category: 'Fuel' },
    { description: 'UBER TRIP COLOMBO', merchant: 'UBER', amount: 1350, direction: 'debit', module: 'expenses', category: 'Transport' },
    { description: 'NAWALOKA HOSPITAL PHARMACY', merchant: 'NAWALOKA HOSPITAL', amount: 3475, direction: 'debit', module: 'expenses', category: 'Health' },
    { description: 'SALARY ACME HOLDINGS PVT LTD', merchant: 'ACME HOLDINGS', amount: 185000, direction: 'credit', module: 'incomeRecv', category: 'Salary' },
    { description: 'AIA INSURANCE PREMIUM', merchant: 'AIA INSURANCE', amount: 6200, direction: 'debit', module: 'expenses', category: 'Insurance' },
    { description: 'ODEL FASHION STORE COLOMBO', merchant: 'ODEL', amount: 7990, direction: 'debit', module: 'expenses', category: 'Shopping' },
    { description: 'UNIVERSITY OF COLOMBO TUITION FEE', merchant: 'UNIVERSITY OF COLOMBO', amount: 45000, direction: 'debit', module: 'expenses', category: 'Education' },   // not a bookshop: a bookshop is Shopping to a careful reader (Ollama and NVIDIA said so on 2026-10-03) and a canary row must have one right answer
    { description: 'PIZZA HUT KOLLUPITIYA', merchant: 'PIZZA HUT', amount: 3890, direction: 'debit', module: 'expenses', category: 'Dining' },
]);

/** The question a statement's board is asked (statement-board.mjs proposalPrompt), put about the ten rows above. */
export const CANARY_PROMPT = proposalPrompt({
    accountType: 'BANK_OR_DEBIT_ACCOUNT',
    allocations: { statementType: 'bank_account', bank: 'Canary Bank', card_last4: '', subscriptions: [], loans: [], targets: [] },
    evidence: CANARY_ROWS.map((row, index) => ({ index, date: '2026-09-1' + (index % 9 + 1), amount: row.amount, description: row.description, merchant: row.merchant, direction: row.direction, directionSource: 'column', needsReview: false })),
});

/** What a provider's reply got right against the rows' known answers: { right, wrong:[{index, said}], missing } — or null when the reply is not a board answer at all. */
export function scoreRows(reply, rows = CANARY_ROWS) {
    const value = boardAnswer(reply);
    const list = value && Array.isArray(value[PROPOSAL.path]) ? value[PROPOSAL.path] : null;
    if (!list) return null;
    const said = new Map();
    for (const item of list) if (item && typeof item === 'object' && Number.isSafeInteger(item[PROPOSAL.id]) && !said.has(item[PROPOSAL.id])) said.set(item[PROPOSAL.id], item);
    let right = 0, missing = 0; const wrong = [];
    rows.forEach((row, index) => {
        const item = said.get(index);
        if (!item) { missing += 1; return; }
        if (item.module === row.module && item.category === row.category && item.allocationId === '') right += 1;
        else wrong.push({ index, said: redact(`${item.module}/${item.category}`, 40) });
    });
    return { right, wrong, missing };
}

/** Nothing secret leaves in a provider's error: keys in query strings, bearer tokens, long opaque runs. */
export function redact(text, max = 140) {
    return String(text == null ? '' : text)
        .replace(/([?&](?:key|api_key|apikey|token|access_token)=)[^&\s"']+/gi, '$1[redacted]')
        .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
        .replace(/\b[A-Za-z0-9_-]{32,}\b/g, '[redacted]')
        .replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * Who answered the same thing as whom — read with the board's own rule (ai-matrix.mjs boardAnswer), so the report cannot disagree with the
 * decision. Largest group first; an answer that is not a usable JSON object is listed apart with its first words. The canary's question is
 * fixed and carries nothing of the owner's, so showing what a dissenter said is safe and is the point: "they disagree" is not a finding.
 */
export function agreementOf(probe = []) {
    const live = (Array.isArray(probe) ? probe : []).filter((p) => p && p.ok === true);
    const reading = boardReading(live.map((p) => ({ name: p.name, reply: p.reply })));
    const byName = new Map(live.map((p) => [String(p.name), p]));
    const groups = new Map();
    const invalid = live.filter((p) => boardAnswer(p.reply) === null).map((p) => ({ name: String(p.name), why: whyInvalid(p.reply) || 'unreadable', sample: redact(p.reply, 240) }));
    for (const a of reading.answers) {
        const group = groups.get(a.key) || { members: [], sample: redact(JSON.stringify(a.value), 300) };
        group.members.push(String(a.name)); groups.set(a.key, group);
    }
    const ordered = [...groups.values()].sort((x, y) => y.members.length - x.members.length);
    // without a clear majority every group but the largest is a dissent; with one, mangled answers are listed apart from real dissent
    const dissent = reading.clear ? reading.dissent : ordered.slice(1).flatMap((g) => g.members);
    const mangled = reading.mangled.map((name) => ({ name: String(name), sample: redact(byName.get(name) && byName.get(name).reply, 240) }));
    return { groups: ordered, invalid, mangled, dissent };
}

/** Is this row, as a voter filed it, the row's one right answer? */
const isRight = (item, row) => Boolean(item && row) && item.module === row.module && item.category === row.category && item.allocationId === '';

/**
 * The board's row-by-row reading (api/ai-matrix.mjs itemwiseReading, in the response body as `items`) set against the known answers: how many rows EVERY voter agreed on, and how many of
 * those agreed rows are also RIGHT. Agreement is not correctness: five voters can agree on a wrong row, and that is the case the statement board's peer review and closed vocabulary exist for.
 * `reason` is set instead when the rows were not read (too few valid voters, a misshapen answer).
 */
export function rowsOf(items, rows = CANARY_ROWS) {
    const of = rows.length;
    if (!items || typeof items !== 'object') return { of, reason: 'not_asked' };
    if (items.reason || !Array.isArray(items.agreed)) return { of, reason: String(items.reason || 'not_read'), voters: Array.isArray(items.voters) ? items.voters.length : 0 };
    const agreed = items.agreed.filter((a) => a && Number.isSafeInteger(a.id) && a.id >= 0 && a.id < of);
    return {
        of, agreed: agreed.length, correct: agreed.filter((a) => isRight(a.value, rows[a.id])).length,
        disputed: (Array.isArray(items.disputed) ? items.disputed : []).filter(Number.isSafeInteger).slice(0, of),
        voters: Array.isArray(items.voters) ? items.voters.length : 0,
    };
}

/**
 * The report a canary run makes, from what the endpoint's own decision and per-provider results were.
 * For each provider that answered: how many of the ten rows it got right (`rows`), and WHY its answer was refused when it was (`why`) — cut off, prose around the JSON, broken syntax.
 * @param {object} o
 * @param {object} o.decision   the board's response body
 * @param {object[]} o.probe    [{ name, ok, ms, provider, reply, error }]
 */
export function reportOf({ decision, probe = [], ms = 0, at = Date.now() }) {
    const detail = (p) => {
        if (!p.ok) return { error: redact(p.error) };
        const rows = scoreRows(p.reply);
        const why = whyInvalid(p.reply) || (rows ? null : 'not-a-list-of-decisions');
        return {
            model: redact(p.provider, 60), reply: redact(p.reply, 70),
            ...(rows ? { rows: { right: rows.right, wrong: rows.wrong.length, missing: rows.missing, ...(rows.wrong.length ? { said: rows.wrong.slice(0, 3) } : {}) } } : {}),
            ...(why ? { why } : {}),
        };
    };
    const providers = probe.map((p) => ({ name: String(p.name), ok: p.ok === true, ms: Number(p.ms) || 0, ...detail(p) }))
        .sort((a, b) => Number(b.ok) - Number(a.ok) || (b.rows ? b.rows.right : -1) - (a.rows ? a.rows.right : -1) || a.ms - b.ms);
    const answered = Array.isArray(decision && decision.answered) ? decision.answered : [];
    const invalidWhy = {}; for (const p of providers) if (p.why) invalidWhy[p.name] = p.why;
    return {
        at, ms,
        board: {
            unanimous: Boolean(decision && decision.unanimous), reason: (decision && decision.reason) || null,
            asked: providers.length, answered: answered.length, floor: (decision && decision.minimumProviders) || 5,
            invalid: Array.isArray(decision && decision.invalid) ? decision.invalid : [],
            reasked: Array.isArray(decision && decision.reasked) ? decision.reasked.map((r) => ({ name: String(r.name), agreed: r.agreed === true })) : [],
            rows: rowsOf(decision && decision.items),
        },
        providers,
        agreement: agreementOf(probe),
        summary: {
            working: providers.filter((p) => p.ok).map((p) => p.name),
            failing: providers.filter((p) => !p.ok).map((p) => `${p.name}: ${p.error}`),
            allRight: providers.filter((p) => p.rows && p.rows.right === CANARY_ROWS.length && !p.why).map((p) => p.name),
            invalidWhy,
        },
    };
}

/** How the report reads to a person: one line that says whether the AI is fine. */
export function verdictOf(report) {
    if (!report || !report.board) return 'no report yet';
    const b = report.board;
    const dissent = (report.agreement && report.agreement.dissent) || [];
    const mangled = ((report.agreement && report.agreement.mangled) || []).map((m) => m.name);
    const rows = b.rows && b.rows.agreed !== undefined ? `; rows every voter agreed on: ${b.rows.agreed} of ${b.rows.of}, ${b.rows.correct} of them right` : '';
    if (b.unanimous) return `GOOD — ${b.answered} of ${b.asked} providers answered and agreed (floor ${b.floor})${rows}${mangled.length ? `; not counted, answer was malformed: ${mangled.join(', ')}` : ''}`;
    if (b.answered >= b.floor) return `PROVIDERS FINE, BUT THEY DISAGREE — ${b.answered} answered; reason ${b.reason}${rows}${dissent.length ? `; a different answer from: ${dissent.join(', ')}` : ''}`;
    return `BELOW THE FLOOR — only ${b.answered} of ${b.asked} answered (need ${b.floor}); reason ${b.reason}${rows}`;
}

/** Read the last stored report, or null. The store is a Firestore doc; `getDb` is admin-db's getAdminDb. Never throws. */
export async function loadReport(getDb, withDeadline) {
    try {
        const { db } = await getDb();
        if (!db) return null;
        const snap = await withDeadline(db.collection(DOC.collection).doc(DOC.id).get(), 2000);
        const data = snap && snap.exists ? snap.data() : null;
        return data && data.report ? data.report : null;
    } catch (_) { return null; }
}
export async function saveReport(getDb, withDeadline, report) {
    try {
        const { db } = await getDb();
        if (!db) return false;
        await withDeadline(db.collection(DOC.collection).doc(DOC.id).set({ report, at: report.at }), 2000);
        return true;
    } catch (_) { return false; }
}

let memoryReport = null;
export function resetHealthMemory() { memoryReport = null; }

/**
 * The GET side of the endpoint. `run` is the endpoint's own POST handler: the canary is that handler, asked one fixed question with the probe
 * flag only this module can set (a property of the request object, not of the body a caller sends).
 */
export async function serveHealth(req, res, { run, getDb, withDeadline, now = Date.now, env = (typeof process !== 'undefined' && process.env) || {} }) {
    let params;
    try { params = new URL(req.url || '', 'http://local').searchParams; } catch (_) { params = new URLSearchParams(); }
    const query = req.query || {};
    const wantsCanary = params.has('canary') || query.canary !== undefined;
    if (!wantsCanary && !params.has('health') && query.health === undefined) { res.status(405); return res.json({ error: 'Method not allowed' }); }
    res.setHeader('Cache-Control', 'no-store');
    let report = (await loadReport(getDb, withDeadline)) || memoryReport;
    let cached = true;
    if (wantsCanary && (!report || now() - report.at >= CANARY_GAP_MS)) {
        cached = false;
        const captured = {};
        const quiet = { setHeader() {}, status(code) { captured.code = code; return this; }, json(body) { captured.body = body; return this; } };
        const started = now();
        await run({ method: 'POST', body: { prompt: CANARY_PROMPT, financialDecision: true, mode: 'unanimous', temperature: 0, maxTokens: CANARY_MAX_TOKENS, deadlineMs: Number(env.AI_CANARY_DEADLINE_MS) || CANARY_DEADLINE_MS, itemwise: { path: PROPOSAL.path, id: PROPOSAL.id } }, __probe: true }, quiet);
        report = reportOf({ decision: captured.body || {}, probe: (captured.body && captured.body.probe) || [], ms: now() - started, at: now() });
        memoryReport = report;
        await saveReport(getDb, withDeadline, report);
    }
    res.status(200);
    return res.json({ ok: true, cached, ageSec: report ? Math.round((now() - report.at) / 1000) : null, verdict: verdictOf(report), report: report || null });
}
