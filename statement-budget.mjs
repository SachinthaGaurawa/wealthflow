/* =============================================================================
 * statement-budget.mjs — maintenance steps that stop when the time is up and carry on from where they stopped
 * -----------------------------------------------------------------------------
 * Production, 2026-10-11 and 10-12: the daily statement run ended in the platform's 60 second limit (a timeout, then a `[WF-SLOW]`). The cause was the pairing of the owner's own
 * transfers (statement-legs.mjs, fixed there); but it showed the shape of the risk. The housekeeping at the end of a run is a list of independent steps, each reading and rewriting the
 * owner's whole document. They were gated once, at the start of the list, and stamped "done" afterwards: a run that began them with ten seconds to spare could not stop between two of
 * them, and a step that never got to run was never run until the next full pass, thirty minutes later at the earliest.
 *
 * `runSteps` is checked BEFORE each step: when the time is up it stops, and says which step is next. The caller keeps that number on the mailbox; the next run starts there, so no step is
 * skipped forever and none is repeated while the others wait. A step that throws does not stop the others (it was always so); it is named in the answer, and is tried again in the next pass.
 *
 * Pure but for the clock it is given: no storage, no network.
 * ===========================================================================*/

/**
 * @param {object} o
 * @param {{name:string, run:()=>Promise<any>}[]} o.steps in the order they are run
 * @param {number} o.from index of the step to start with (what the last pass stopped at); anything that is not a step number starts at the first
 * @param {number} o.until epoch ms after which no new step is started
 * @param {()=>number} [o.now]
 * @returns {Promise<{done:boolean, next:number, ran:string[], failed:string[], skipped:string[], ms:Object<string,number>}>} `done`: the pass reached the end (so `next` is 0); `skipped`: the steps left for the next run
 */
export async function runSteps({ steps, from = 0, until, now = Date.now }) {
    const first = Number.isInteger(from) && from >= 0 && from < steps.length ? from : 0;
    const ran = [], failed = [], ms = {};
    for (let index = first; index < steps.length; index++) {
        if (!(now() < until)) return { done: false, next: index, ran, failed, skipped: steps.slice(index).map(step => step.name), ms };
        const { name, run } = steps[index], began = now();
        try { await run(); ran.push(name); } catch (_) { failed.push(name); }
        ms[name] = Math.max(0, now() - began);
    }
    return { done: true, next: 0, ran, failed, skipped: [], ms };
}

export default { runSteps };
