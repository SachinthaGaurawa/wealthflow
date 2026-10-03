/* =============================================================================
 * wealthflow-scan-progress.js — the upload overlay's bar says what was actually done
 * -----------------------------------------------------------------------------
 * THE DEFECT. The "Reading statement text…" overlay was driven by hand-typed numbers: 20 when the file was opened, 35 when the AI was called, 90 when the review was about
 * to open. The bar sat at 20% for the whole of opening the PDF, reading its pages, naming the bank and asking the registry (two network calls), under a label that said only
 * "reading", and it jumped to the next typed number whether or not the work had moved. It could not tell the owner which of those things was slow.
 *
 * THE RULE HERE. A bar position comes from work that was counted, never from a number somebody chose for a stage:
 *   - A stage whose work has a unit (pages read of N, pages the AI has answered of N, bytes downloaded of the file's size) moves the bar through that stage's slice as the units
 *     finish, and says which unit it is on.
 *   - A stage with no unit (a network call, one AI answer, an unlock) HOLDS the bar where the finished work left it and says in words what it is doing. It shows the seconds it
 *     has been waiting, so a held bar still proves the page is alive, and it never shows a percentage it did not earn.
 *   - The bar never moves backwards inside a run, never reaches 100 before the run ends (the cap is 99; `end()` closes the overlay), and a stage that was skipped is simply
 *     passed over. A plan can be redrawn when a fallback starts (a PDF without a text layer is read as pictures): the remaining stages share the headroom that is left.
 *   - The weights of a plan only decide how the bar's length is shared between stages (a slow stage gets a longer slice). They are not a claim about progress inside a stage.
 *
 * ONE RUN AT A TIME. `begin()` replaces whatever run is current: the old run's calls become no-ops, so a slow first upload can never close or move the overlay of the second.
 * `end()` closes only the run that is still current, and a run that goes silent for three minutes hides the overlay (the next call shows it again) so a hung step cannot
 * leave the screen covered. `handoff()` keeps the overlay up for the run that starts next (a Drive download is followed by the scan of the same file) so the bar carries on from
 * where the download left it instead of closing and restarting from zero.
 *
 * The overlay itself is drawn by window._showScanOverlay(stage, detail, pct, icon) (wealthflow-ai-v4.js); this file owns only the numbers. Pure and testable: every clock and
 * every timer comes in through `env`. ESM; window.WFScanProgress.
 * ===========================================================================*/

/** The most the bar shows before the run ends. 100 is reserved for "the work is finished", which is when the overlay closes. */
export const CAP = 99;
/** Seconds a stage must wait with nothing finishing before the overlay starts counting them aloud. */
export const IDLE_SHOW_S = 3;
/** A run that touches nothing for this long hides the overlay (and shows it again if work resumes). */
export const WATCHDOG_MS = 180000;
/** How long a handed-off overlay waits for the next run before it closes. */
export const HANDOFF_MS = 5000;

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

function browserEnv() {
    const w = typeof window !== 'undefined' ? window : null;
    return {
        show: (stage, detail, pct, icon) => { if (w && typeof w._showScanOverlay === 'function') w._showScanOverlay(stage, detail, pct, icon); },
        hide: () => { if (w && typeof w._hideScanOverlay === 'function') w._hideScanOverlay(); },
        now: () => Date.now(),
        setTimeout: (f, ms) => setTimeout(f, ms),
        clearTimeout: (t) => clearTimeout(t),
        setInterval: (f, ms) => setInterval(f, ms),
        clearInterval: (t) => clearInterval(t),
    };
}

/** A run that does nothing, for uploads that never show the overlay. Same surface, so callers never branch. */
export const NOOP = Object.freeze({
    active: false, pct: 0, stageId: '',
    plan() { return NOOP; }, stage() { return NOOP; }, step() { return NOOP; }, say() { return NOOP; }, handoff() { return NOOP; }, end() { return NOOP; },
});

export function createTracker(overrides) {
    const env = Object.assign(browserEnv(), overrides || {});
    let current = null;

    function makeRun(startAt) {
        let floor = clamp(Number(startAt) || 0, 0, CAP);
        let slices = {};
        let stageId = '', label = '', detail = '', icon = '';
        let measured = false;
        let dead = false;
        let handedOffAt = 0;
        let changedAt = env.now();
        let ticker = null, watchdog = null, handoffTimer = null;
        let lastText = '';

        const run = {
            get active() { return !dead && current === run; },
            get pct() { return floor; },
            get stageId() { return stageId; },
            get handedOffAt() { return handedOffAt; },
            plan, stage, step, say, handoff, end, kill,
        };

        function stopTimers() {
            if (ticker !== null) { env.clearInterval(ticker); ticker = null; }
            if (watchdog !== null) { env.clearTimeout(watchdog); watchdog = null; }
            if (handoffTimer !== null) { env.clearTimeout(handoffTimer); handoffTimer = null; }
        }

        function render(force) {
            if (dead) return;
            const idle = Math.floor((env.now() - changedAt) / 1000);
            let text = detail;
            if (measured) text += (text ? ' · ' : '') + Math.floor(floor) + '%';
            if (idle >= IDLE_SHOW_S) text += (text ? ' · ' : '') + idle + ' s';
            if (!force && text === lastText) return;
            lastText = text;
            env.show(label, text, Math.round(floor * 10) / 10, icon);
        }

        /* Something changed: the clock for "seconds waiting" restarts, and so does the watchdog. */
        function touch() {
            changedAt = env.now();
            if (watchdog !== null) env.clearTimeout(watchdog);
            watchdog = env.setTimeout(() => {
                watchdog = null;
                if (ticker !== null) { env.clearInterval(ticker); ticker = null; }   // no more repaints: the next touch() brings the overlay and the clock back
                lastText = '';
                if (!dead && current === run) env.hide();
            }, WATCHDOG_MS);
            if (ticker === null) ticker = env.setInterval(() => render(false), 1000);
            render(true);
        }

        /** Share the bar between stages. Slices run from where the bar is now to `opts.to` (default: the cap), longest weight longest. */
        function plan(stages, opts) {
            if (dead) return run;
            const to = clamp(opts && opts.to != null ? Number(opts.to) : CAP, floor, CAP);
            const list = (Array.isArray(stages) ? stages : []).filter((s) => s && s.id);
            const total = list.reduce((sum, s) => sum + (s.weight > 0 ? s.weight : 0), 0);
            slices = {};
            let acc = 0;
            for (const s of list) {
                const w = s.weight > 0 ? s.weight : 0;
                slices[s.id] = total > 0
                    ? { from: floor + (to - floor) * (acc / total), to: floor + (to - floor) * ((acc + w) / total) }
                    : { from: floor, to: floor };
                acc += w;
            }
            return run;
        }

        /** Enter a stage: everything planned before it is finished or was skipped, so the bar moves to where this one starts and holds there until a unit completes. */
        function stage(id, newLabel, newDetail, newIcon) {
            if (dead) return run;
            stageId = String(id || '');
            if (slices[stageId]) floor = Math.max(floor, slices[stageId].from);
            measured = false;
            if (newLabel != null) label = String(newLabel);
            detail = newDetail == null ? '' : String(newDetail);
            if (newIcon != null) icon = String(newIcon);
            touch();
            return run;
        }

        /** `done` of `total` units of the current stage are finished. Without a usable total (or a planned slice) nothing moves: only the words change. */
        function step(done, total, newDetail) {
            if (dead) return run;
            const t = Number(total), d = Number(done);
            const slice = slices[stageId];
            if (slice && t > 0 && Number.isFinite(d)) {
                floor = Math.max(floor, slice.from + (slice.to - slice.from) * clamp(d / t, 0, 1));
                measured = true;
            } else measured = false;
            if (newDetail != null) detail = String(newDetail);
            touch();
            return run;
        }

        /** Change the words (and optionally the icon) without entering a stage or moving the bar: a retry, a fallback, "waiting for the password". */
        function say(newLabel, newDetail, newIcon) {
            if (dead) return run;
            if (newLabel != null) label = String(newLabel);
            if (newDetail != null) detail = String(newDetail);
            if (newIcon != null) icon = String(newIcon);
            measured = false;
            touch();
            return run;
        }

        /** Keep the overlay up for the run that starts next (see begin({ resume })). If none starts, the overlay closes. */
        function handoff() {
            if (dead || current !== run) return run;
            handedOffAt = env.now();
            if (ticker !== null) { env.clearInterval(ticker); ticker = null; }
            if (watchdog !== null) { env.clearTimeout(watchdog); watchdog = null; }
            handoffTimer = env.setTimeout(() => { handoffTimer = null; if (current === run) run.end(); }, HANDOFF_MS);
            return run;
        }

        /** Stop this run without touching the overlay: a newer run owns it now. */
        function kill() { dead = true; stopTimers(); }

        /** Close the overlay if this run still owns it. Safe to call twice, and safe after a newer run has started. */
        function end() {
            const owns = !dead && current === run;
            dead = true;
            stopTimers();
            if (owns) { current = null; env.hide(); }
            return run;
        }

        return run;
    }

    /**
     * Start a run and show the overlay at its first position.
     * @param {{label?:string, detail?:string, icon?:string, resume?:boolean}} [opts] `resume` continues from the bar of a run that has just been handed off.
     */
    function begin(opts) {
        const o = opts || {};
        const prev = current;
        let startAt = 0;
        if (prev) {
            if (o.resume && prev.handedOffAt && env.now() - prev.handedOffAt <= HANDOFF_MS) startAt = prev.pct;
            prev.kill();
        }
        const run = makeRun(startAt);
        current = run;
        run.say(o.label || 'Working…', o.detail || '', o.icon || '');
        return run;
    }

    return { begin, get current() { return current; } };
}

/**
 * Read a fetch Response to a Blob while reporting how many bytes have arrived. `onBytes(got, total)` — `total` is 0 when neither the
 * Content-Length header nor `sizeHint` says. A browser without streaming bodies still gets the file, with one report at the end.
 */
export async function readBlob(resp, sizeHint, onBytes) {
    const report = (got, total) => { try { if (typeof onBytes === 'function') onBytes(got, total); } catch (_) { /* a progress display never fails a download */ } };
    const header = Number(resp && resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('content-length') : 0);
    const total = header > 0 ? header : (Number(sizeHint) > 0 ? Number(sizeHint) : 0);
    const reader = resp && resp.body && typeof resp.body.getReader === 'function' ? resp.body.getReader() : null;
    if (!reader) {
        const whole = await resp.blob();
        report(whole.size, whole.size);
        return whole;
    }
    const chunks = [];
    let got = 0;
    report(0, total);
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        report(got, total);
    }
    const type = resp.headers && typeof resp.headers.get === 'function' ? (resp.headers.get('content-type') || '') : '';
    return new Blob(chunks, type ? { type } : undefined);
}

const tracker = createTracker();
export const begin = tracker.begin;

const API = { begin, createTracker, readBlob, NOOP, CAP, IDLE_SHOW_S, WATCHDOG_MS, HANDOFF_MS };

if (typeof window !== 'undefined') window.WFScanProgress = API;

export default API;
