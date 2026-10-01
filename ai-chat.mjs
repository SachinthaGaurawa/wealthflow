/* =============================================================================
 * ai-chat.mjs — an OpenAI-shaped provider that answers, instead of one that "returned empty"
 * -----------------------------------------------------------------------------
 * The production log of 2026-10-01 (10:11–10:17 UTC) showed what was left after the retired-model problem was healed: 79 of 101
 * AI calls refused (HTTP 422) because the financial board needs five independent providers to answer and only two or three did.
 * The rest of the roster failed in four ways, none of them an outage:
 *
 *   · "Groq returned empty", "Ollama returned empty", "Fireworks returned empty", "OpenRouter{Finance,Qwen,Nemotron} returned empty"
 *     — six providers. They serve REASONING models (gpt-oss, qwen3, nemotron): the model spends the completion budget thinking and
 *     the answer, which shares that budget, is cut to nothing. The reply has `message.content === ''` and the thinking sits beside it.
 *     The fix is the one the providers document: ask for little reasoning (`reasoning_effort: low`, OpenRouter's `reasoning.effort`,
 *     Ollama's `think: low`), give the answer room when the budget was the problem, and — if a model still answers nothing —
 *     stop asking THAT model for this role and ask the provider's next one.
 *   · "NVIDIA status 410 … end of life" and "Cerebras status 404" every call, although a replacement is looked up: the dead default
 *     was asked first on every call, the preferred replacement was itself retired, and only ONE replacement was ever tried.
 *     Now a bad default is never asked again, up to three replacements are tried in one call, and what each one said is written
 *     into the error so the next log shows exactly where a provider stops.
 *   · "GitHubModels: Unexpected token 'O', "OK" is not valid JSON" — an HTTP 200 whose body is not JSON. Said plainly (with the
 *     first words of the body), and the provider is left alone for half an hour instead of fifteen seconds.
 *
 * Pure but for the injected `send` (the provider's own door) and the model book.
 * ===========================================================================*/

import { isModelGone } from './ai-models.mjs';

/** Models that think before they answer: their completion budget is shared between the two. */
export const REASONING_ID = /gpt-oss|qwen-?3|qwq|nemotron|deepseek-?r1|-r1\b|reason|think|\bo[134](?:-|$)|kimi|magistral|glm-?4\.[5-9]|ling.*(?:think|reason)/i;

/** (provider:model) a provider has refused a reasoning setting for — a 400 once, not every call. */
const refused = new Set();
export function resetReasoningLearning() { refused.clear(); }

/**
 * The reasoning setting to send for this provider and model — as little as the provider lets us ask for — or null.
 * `kind` is what the body is for: 'openai' (chat/completions) or 'ollama' (/api/chat).
 */
export function reasoningFor(provider, model, kind = 'openai') {
    const id = String(model || '').toLowerCase();
    if (refused.has(`${provider}:${id}`)) return null;
    if (kind === 'ollama') return /gpt-oss/.test(id) ? { think: 'low' } : null;
    if (/^OpenRouter/.test(provider)) return { reasoning: { effort: 'low' } };
    if (provider === 'Groq' || provider === 'Cerebras' || provider === 'Together') return /gpt-oss/.test(id) ? { reasoning_effort: 'low' } : null;
    if (provider === 'Fireworks') return REASONING_ID.test(id) ? { reasoning_effort: 'low' } : null;
    return null;
}

/** What a chat reply says, whatever shape the provider chose: { text, finish, reasoningChars }. Never throws. */
export function readChat(data) {
    const choice = (data && Array.isArray(data.choices) && data.choices[0]) || null;
    const message = (choice && choice.message) || (data && data.message) || {};
    let text = message.content;
    if (Array.isArray(text)) text = text.map((p) => (p && (p.text || p.content)) || '').join('');
    const reasoning = message.reasoning_content || message.reasoning || message.thinking || '';
    return {
        text: typeof text === 'string' ? text : '',
        finish: String((choice && (choice.finish_reason || choice.finishReason)) || (data && data.done_reason) || ''),
        reasoningChars: typeof reasoning === 'string' ? reasoning.length : Array.isArray(reasoning) ? reasoning.length : 0,
    };
}

const MAX_CANDIDATES = 3;
const EMPTY_BAD_MS = 30 * 60 * 1000;

/**
 * Ask one provider, and make it answer.
 *
 * @param {object} o
 * @param {string} o.name           provider name (the roster's)
 * @param {string} o.slot           the book's slot for this provider and role
 * @param {object} o.book           a model book (ai-models.mjs)
 * @param {string} o.defaultModel   asked first, until the book remembers better
 * @param {number} o.tokens         the completion budget the caller asked for (capped by `cap`)
 * @param {number} [o.cap=4096]     the most this provider takes
 * @param {'openai'|'ollama'} [o.kind]
 * @param {(model:string, extra:object, tokens:number)=>Promise<{ok:boolean,status?:number,text?:string,data?:object,nonJson?:string}>} o.send
 * @param {()=>Promise<object[]>} [o.load]   the provider's own model list; absent = the provider cannot be healed
 * @param {string} [o.listKey]
 * @param {boolean} [o.vision]
 * @param {(line:string)=>void} [o.log]   told once when the provider needed more than its first try
 * @returns {Promise<{ text:string, model:string, trace:object[] }>}
 */
export async function askChat({ name, slot, book, defaultModel, tokens, cap = 4096, kind = 'openai', send, load, listKey = name, vision = false, log = () => {} }) {
    const trace = [];
    const budget = Math.max(64, Math.min(Number(tokens) || 2500, cap));
    // a provider that cannot be healed has one model: it is asked whatever the book thinks of it; one that can is moved off a bad default
    let model = book.current(slot) || (load && book.isBad(slot, defaultModel) ? '' : defaultModel);
    let last = null;                                                  // the failure the provider itself gave, for the caller

    const tryModel = async (id) => {
        let extra = reasoningFor(name, id, kind) || {};
        let room = budget;
        let grew = false, retried = false;
        for (let step = 0; step < 4; step++) {
            const out = await send(id, extra, room);
            if (!out.ok) {
                // a 400 that names the reasoning setting is about the request: send it again without, once, and remember
                if (out.status === 400 && Object.keys(extra).length && /reason|effort|think/i.test(String(out.text || '')) && !retried) { refused.add(`${name}:${String(id).toLowerCase()}`); extra = {}; retried = true; continue; }
                return { fail: out };
            }
            if (out.nonJson !== undefined) return { fail: { status: 200, text: '', nonJson: out.nonJson, meta: out.meta } };
            const read = readChat(out.data);
            if (read.text.trim()) return { text: read.text, grew };
            // answered nothing. If the budget was the problem (it ran out, or it thought a lot), ask again with room — once
            const spentOnThinking = read.finish === 'length' || read.finish === 'max_tokens' || read.reasoningChars > 0;
            if (spentOnThinking && !grew) { grew = true; room = Math.min(cap, Math.max(room * 2, 2048)); if (room > budget) continue; }
            return { empty: { finish: read.finish || '?', reasoningChars: read.reasoningChars } };
        }
        return { empty: { finish: '?', reasoningChars: 0 } };
    };

    for (let candidate = 0; candidate < MAX_CANDIDATES + 1; candidate++) {
        if (!model) {
            if (!load || candidate === 0 && !book.isBad(slot, defaultModel)) break;
            model = await book.replacement({ slot, provider: name, listKey, vision, failed: trace.length ? trace[trace.length - 1].model : defaultModel, load });
            if (!model) break;
        }
        const result = await tryModel(model);
        if (result.text) {
            book.remember(slot, model);
            // one line when a provider needed more than its first try, so production says which provider healed how
            if (trace.length || result.grew) { try { log(JSON.stringify({ evt: 'ai-chat', provider: name, model, ...(result.grew ? { grew: true } : {}), ...(trace.length ? { tried: trace } : {}) })); } catch (_) { /* advice */ } }
            return { text: result.text, model, trace };
        }
        if (result.empty) {
            // it answers nothing in this role (thinking models that think too much): not this model, for a while — the next one
            trace.push({ model, empty: result.empty.finish, thinking: result.empty.reasoningChars });
            last = last || { status: 200, empty: result.empty };
            book.markBad(slot, model, EMPTY_BAD_MS);
            model = ''; continue;
        }
        const fail = result.fail;
        if (fail.nonJson !== undefined) { trace.push({ model, nonJson: String(fail.nonJson).slice(0, 40) }); last = last || fail; break; }
        trace.push({ model, status: fail.status });
        last = last && last.status !== 200 ? last : fail;
        if (load && isModelGone(fail.status, fail.text)) { book.markBad(slot, model); model = ''; continue; }
        break;                                                         // a quota, a key, an outage: not a retired model, nothing to heal
    }
    const error = new Error('');
    error.trace = trace;
    error.last = last;
    error.noModel = !last;              // every model of this provider is set aside right now: nothing was asked
    throw error;
}

/** The error a caller throws for a failed askChat, in the shapes the rest of the endpoint reads (cooldown regexes, logs, tests). */
export function chatError(name, error, firstFail) {
    // a failure that is not askChat's own (the network, an abort, a deadline) is passed on as it is: its message is what the cooldown reads
    if (!error || (error.trace === undefined && error.last === undefined)) return error instanceof Error ? error : new Error(String(error));
    if (error.noModel) return new Error(`${name} has no usable model right now (every model it lists is set aside)`);
    const trace = (error && error.trace) || [];
    const last = (error && error.last) || firstFail || {};
    const words = (v) => String(v).replace(/\s+/g, ' ').trim().slice(0, 40);
    const steps = trace.length > 1
        ? ` [tried ${trace.map((t) => `${t.model}→${t.nonJson !== undefined ? `non-JSON "${words(t.nonJson)}"` : t.empty !== undefined ? `empty(${t.empty}${t.thinking ? `,thought ${t.thinking}` : ''})` : t.status}`).join(', ')}]` : '';
    if (last.nonJson !== undefined) return new Error(`${name} returned non-JSON (HTTP 200): "${words(last.nonJson)}"${last.meta ? ` {${last.meta}}` : ''}${steps}`);
    if (last.empty) return new Error(`${name} returned empty (finish ${last.empty.finish}${last.empty.reasoningChars ? `, it thought ${last.empty.reasoningChars} chars` : ''})${steps}`);
    return new Error(`${name} status ${last.status}: ${String(last.text || '').substring(0, 160)}${steps}`);
}
