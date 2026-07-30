/* =============================================================================
 * autonomy/provider-budget.mjs — keep the critical path from being starved
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   Running every model in parallel is only powerful if there is still a model
 *   available when it matters. Every provider here is on a free tier, and the
 *   quota is shared between work of very different importance:
 *
 *     CRITICAL   — the consensus board on a pull request, a security review.
 *                  If no provider answers, a merge is blocked or, worse, a
 *                  security review silently does not happen.
 *     BACKGROUND — analytics, sweeps, proposal drafting, idle exploration.
 *                  If it does not run today, nothing is lost.
 *
 *   Without a reservation, background work fans out across every provider,
 *   exhausts the generous ones first, and the next pull request at 3am finds
 *   nothing left. The pipeline then reports "no reviewer could be reached" and
 *   fails closed — correct behaviour, triggered by an entirely avoidable cause.
 *
 * THE DESIGN DECISION WORTH ARGUING WITH
 *   This module does NOT hardcode per-provider quotas. I do not have
 *   authoritative free-tier limits for fifteen providers, they change without
 *   notice, and a table of confident-looking invented numbers would be worse than
 *   no table: every decision downstream would inherit the fabrication while
 *   looking precise. So the ledger OBSERVES instead.
 *
 *     • It counts what was actually spent, per provider, per UTC day.
 *     • It learns a provider is exhausted the only reliable way — that provider
 *       said so (429), and it honours the Retry-After the provider itself sent.
 *     • It reserves the TOP-RANKED providers for critical work, so background
 *       work cannot spend the capacity the critical path reaches for first.
 *
 *   The reservation is what makes fan-out safe, and it needs no quota numbers to
 *   be correct.
 *
 * BACKGROUND WORK YIELDS TO ZERO
 *   If the reservation leaves a background task with no provider, it gets an
 *   empty list and must skip. It does NOT fall back to a reserved provider. A
 *   background sweep that quietly borrows the security reviewer's last engine is
 *   precisely the failure this module exists to prevent, and the failure would
 *   only be discovered later, on a pull request, looking like an outage.
 *
 * ZERO dependencies. The pure functions take `now` and a ledger object so every
 * decision is testable without a clock or a filesystem.
 * ===========================================================================*/

import fs from 'node:fs';
import path from 'node:path';

export const LANES = { CRITICAL: 'critical', BACKGROUND: 'background' };

/**
 * How many top-ranked providers background work may never touch.
 *
 * Two, not one: the consensus board needs a DIFFERENT provider per reviewer to
 * stay independent, so leaving a single provider free would still collapse the
 * board onto one model — the exact problem assignProviders() exists to avoid.
 */
export const RESERVE_FOR_CRITICAL = 2;

/** Fallback cooldown when a provider rate-limits without saying for how long. */
export const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/** Days of history kept. Enough to see a pattern, small enough to stay in git. */
export const KEEP_DAYS = 14;

export const LEDGER_PATH = 'autonomy/state/provider-budget.json';

export function emptyLedger() { return { version: 1, days: {}, cooldowns: {} }; }

function dayKey(at) { return new Date(at).toISOString().slice(0, 10); }

/**
 * Load the ledger, returning an EMPTY one on any problem.
 *
 * Deliberately never throws. A corrupt or missing ledger must not be able to
 * stop the pipeline: the worst case of an empty ledger is that reservations are
 * computed from no history, which is exactly the first-run state and is safe.
 * Throwing here would let a bad JSON file block every review in the repo.
 */
export function loadLedger(file = LEDGER_PATH) {
    try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!raw || typeof raw !== 'object' || typeof raw.days !== 'object') return emptyLedger();
        return { version: 1, days: raw.days || {}, cooldowns: raw.cooldowns || {} };
    } catch { return emptyLedger(); }
}

export function saveLedger(ledger, file = LEDGER_PATH) {
    try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(prune(ledger, Date.now()), null, 1) + '\n');
        return true;
    } catch { return false; }
}

/** Drop history and expired cooldowns so the file cannot grow without bound. */
export function prune(ledger, now = Date.now()) {
    const out = { version: 1, days: {}, cooldowns: {} };
    const cutoff = dayKey(now - KEEP_DAYS * 86400000);
    for (const [d, v] of Object.entries((ledger && ledger.days) || {})) {
        if (d >= cutoff) out.days[d] = v;
    }
    for (const [p, until] of Object.entries((ledger && ledger.cooldowns) || {})) {
        if (Number(until) > now) out.cooldowns[p] = Number(until);
    }
    return out;
}

/**
 * Record one provider call.
 *
 * `outcome` is 'ok' | 'rate_limited' | 'error'. A rate limit also opens a
 * cooldown, honouring the provider's own Retry-After when it sent one — the
 * provider knows its quota window and we do not.
 */
export function record(ledger, { provider, lane = LANES.CRITICAL, outcome = 'ok', at = Date.now(), retryAfterSec = 0 } = {}) {
    const l = { version: 1, days: { ...((ledger && ledger.days) || {}) }, cooldowns: { ...((ledger && ledger.cooldowns) || {}) } };
    if (!provider) return l;

    const d = dayKey(at);
    const day = { ...(l.days[d] || {}) };
    const cur = { ok: 0, rate_limited: 0, error: 0, critical: 0, background: 0, ...(day[provider] || {}) };
    cur[outcome] = (cur[outcome] || 0) + 1;
    if (lane === LANES.BACKGROUND) cur.background += 1; else cur.critical += 1;
    day[provider] = cur;
    l.days[d] = day;

    if (outcome === 'rate_limited') {
        const ms = retryAfterSec > 0 ? retryAfterSec * 1000 : DEFAULT_COOLDOWN_MS;
        // Never shorten an existing cooldown — a second 429 inside a window means
        // the situation is worse, not better.
        l.cooldowns[provider] = Math.max(Number(l.cooldowns[provider] || 0), at + ms);
    }
    return l;
}

/** Epoch ms until which this provider should be left alone, or 0. */
export function cooldownUntil(ledger, provider, now = Date.now()) {
    const until = Number(((ledger && ledger.cooldowns) || {})[provider] || 0);
    return until > now ? until : 0;
}

/** Calls spent today, per provider (both lanes summed). */
export function spentToday(ledger, now = Date.now()) {
    const day = ((ledger && ledger.days) || {})[dayKey(now)] || {};
    const out = {};
    for (const [p, v] of Object.entries(day)) {
        out[p] = (v.ok || 0) + (v.rate_limited || 0) + (v.error || 0);
    }
    return out;
}

/**
 * Which providers this lane may use, from an ALREADY-RANKED list.
 *
 * `ranked` must be in the order the caller would otherwise try them (that is what
 * orderFor() returns), because the reservation is positional: the top
 * RESERVE_FOR_CRITICAL providers are the ones the critical path reaches for
 * first, so those are the ones background work must not spend.
 *
 * Returns ids, in order. Empty means "do not run" — for a background lane that is
 * a legitimate answer, not an error.
 */
export function availableFor({
    lane = LANES.CRITICAL,
    ranked = [],
    ledger = emptyLedger(),
    now = Date.now(),
    reserveForCritical = RESERVE_FOR_CRITICAL,
} = {}) {
    const ids = (ranked || []).map((p) => (typeof p === 'string' ? p : p && p.id)).filter(Boolean);

    // A provider in cooldown is unusable by ANY lane: it told us to go away, and
    // ignoring that earns a longer ban, not an answer.
    const live = ids.filter((id) => !cooldownUntil(ledger, id, now));

    if (lane !== LANES.BACKGROUND) return live;

    // Background gets what is left after the critical reservation. The reservation
    // is taken from the LIVE list, not the original: if the top provider is in
    // cooldown, the next one becomes what the critical path would reach for, so it
    // is the one that now needs protecting.
    return live.slice(reserveForCritical);
}

/** A short human-readable state, for CI summaries and the status endpoint. */
export function describeBudget(ledger, ranked = [], now = Date.now()) {
    const spent = spentToday(ledger, now);
    const cooling = Object.keys((ledger && ledger.cooldowns) || {})
        .filter((p) => cooldownUntil(ledger, p, now))
        .map((p) => ({ provider: p, minutes: Math.ceil((cooldownUntil(ledger, p, now) - now) / 60000) }));
    return {
        spentToday: spent,
        totalToday: Object.values(spent).reduce((s, n) => s + n, 0),
        cooling,
        reservedForCritical: availableFor({ lane: LANES.CRITICAL, ranked, ledger, now })
            .slice(0, RESERVE_FOR_CRITICAL),
        backgroundMayUse: availableFor({ lane: LANES.BACKGROUND, ranked, ledger, now }),
    };
}
