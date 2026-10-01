/* =============================================================================
 * statement-llm-router.mjs — a model answer from the strongest provider that is up, then the next, never a crash
 * -----------------------------------------------------------------------------
 * Asking every configured provider at once for one answer spends every provider's quota on every call, and when most are down it
 * still waits out the slowest. A statement reader needs ONE answer (it believes nothing until the document agrees with it), so
 * it asks in TIERS: the strongest few first; only if none of them gives a usable answer, the next tier; and so on down the whole
 * roster. A provider that rate-limits, errors, times out, answers with something that is not the JSON asked for, or is simply
 * cooling down, costs the time it takes to say so and the call moves on. When every tier has failed it says so — once, with what
 * was tried — and the caller falls back to reading the document by rules (statement-adaptive.mjs, proposeFromLines), which
 * needs no model at all. Nothing here ever throws anything but that one error.
 *
 * Pure: `call(prompt, { engines, deadlineMs })` is the only door to a provider.
 * ===========================================================================*/

/** The roster of api/ai.js, in the order they are asked. Every provider appears exactly once. */
export const TIERS = Object.freeze([
    Object.freeze(['Groq', 'Gemini', 'DeepSeek']),
    Object.freeze(['Mistral', 'Together', 'OpenRouterQwen', 'Cerebras']),
    Object.freeze(['Fireworks', 'NVIDIA', 'GitHubModels', 'OpenRouterFinance', 'OpenRouterNemotron']),
    Object.freeze(['Cohere', 'HF', 'CloudflareAI', 'Ollama']),
]);

/* How long each tier may take, strongest first. The first tier holds the providers that read a long statement best, and a thinking-capable
 * model needs more than nine seconds for a page of table; a tier that has been given up on early is the answer from a fast, weaker
 * provider instead of the right one. Later tiers are fallbacks and get less. A tier ends the moment one member gives a usable reply. */
export const TIER_MS = Object.freeze([16000, 12000, 10000, 8000]);
export const MIN_ROOM_MS = 3000;

/**
 * @param {object} o
 * @param {(prompt:string, opts:{engines:string[], deadlineMs:number})=>Promise<string>} o.call
 * @param {(reply:string)=>boolean} [o.accept]     is this reply usable? (default: any non-empty string)
 * @param {number} [o.deadlineAt]                  epoch ms after which no new tier is started
 * @param {(trace:object[])=>void} [o.onTrace]
 * @returns {(prompt:string)=>Promise<string>}
 */
export function tieredAsk({ call, accept = (reply) => typeof reply === 'string' && reply.trim().length > 0, tiers = TIERS, now = Date.now, deadlineAt = Infinity, tierMs = TIER_MS, minRoomMs = MIN_ROOM_MS, onTrace } = {}) {
    return async function ask(prompt) {
        const trace = [];
        const finish = () => { try { if (onTrace) onTrace(trace); } catch (_) { /* a log is advice */ } };
        for (let n = 0; n < tiers.length; n++) {
            const room = deadlineAt - now();
            if (room < minRoomMs) { trace.push({ tier: n, skipped: 'no-time' }); break; }
            try {
                const reply = await call(prompt, { engines: [...tiers[n]], deadlineMs: Math.max(2000, Math.min(Array.isArray(tierMs) ? tierMs[Math.min(n, tierMs.length - 1)] : tierMs, room - 500)) });
                if (accept(reply)) { trace.push({ tier: n, ok: true }); finish(); return reply; }
                trace.push({ tier: n, ok: false, why: 'unusable-reply' });
            } catch (error) {
                trace.push({ tier: n, ok: false, why: String((error && error.message) || error).slice(0, 60) });
            }
        }
        finish();
        const failure = new Error('ai-extractor-unavailable');
        failure.tried = trace;
        throw failure;
    };
}
