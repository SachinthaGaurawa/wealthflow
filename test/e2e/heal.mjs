/* SELF-HEALING LOCATORS for the browser tests: when the UI is reshaped, a test finds the same control another way, says so, and
 * tells the maintainer the selector to use. It never makes a failing check pass.
 *
 * WHY (and what this is not)
 * A browser test that says `#wfUpdatePill` breaks the day the pill gets another id, although the person still sees the same
 * pill. That is a stale test, not a broken app, and a night's red build over it teaches people to ignore red.
 *
 * "Self-healing" tools that let an AI rewrite a test until it goes green are worse than the problem: a test that adapts to
 * anything proves nothing. So the rules here are narrow and mechanical:
 *
 *   1. A control is described by ORDERED ways to find it (css, testid, role+name, label, text). The first is the primary.
 *   2. A fallback is tried only after the primary found nothing for a grace period (a control that is merely late is not stale).
 *   3. A fallback must match exactly ONE VISIBLE element. Two matches is "ambiguous" and refused: guessing which one to click
 *      is how a test ends up pressing the wrong button and passing.
 *   4. An optional `check(handle)` can veto a healed match (e.g. the text must say "Update").
 *   5. Every heal is logged and recorded with the selector that would have worked (`suggest`), so the primary gets fixed.
 *   6. When nothing matches, it THROWS and lists every way it looked. An absent control is a failing check, never a skip.
 *
 * It does not decide that an app change is fine. It only keeps a renamed id from hiding what the test was really asking:
 * "can a person see and use this?".
 *
 *   const h = healer(page);
 *   await h.click('update pill', { css: '#wfUpdatePill', text: /Update available/i });
 *   h.summary();
 */
import fs from 'node:fs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The strategies for one control, in the order they are trusted. The first one is the primary. */
export function strategiesOf(page, spec) {
    const s = spec || {};
    const out = [];
    if (s.css) out.push({ kind: 'css', value: s.css, loc: () => page.locator(s.css) });
    if (s.testid) out.push({ kind: 'testid', value: s.testid, loc: () => page.getByTestId(s.testid) });
    if (s.role) out.push({ kind: 'role', value: s.role + (s.name ? ' ' + String(s.name) : ''), loc: () => page.getByRole(s.role, s.name ? { name: s.name } : {}) });
    if (s.label) out.push({ kind: 'label', value: String(s.label), loc: () => page.getByLabel(s.label) });
    if (s.text) out.push({ kind: 'text', value: String(s.text), loc: () => page.getByText(s.text) });
    return out;
}

/** In the page: the shortest selector that names this element alone, or null when nothing stable does. */
const SUGGEST = (el) => {
    const unique = (sel) => { try { return document.querySelectorAll(sel).length === 1; } catch (_) { return false; } };
    if (el.id && unique('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    for (const a of ['data-testid', 'data-test', 'aria-label', 'name']) {
        const v = el.getAttribute(a);
        if (!v) continue;
        const sel = el.tagName.toLowerCase() + '[' + a + '="' + v.replace(/"/g, '\\"') + '"]';
        if (unique(sel)) return sel;
    }
    return null;
};

async function visibleMatches(loc) {
    const handles = await loc.elementHandles();
    const seen = [];
    for (const h of handles) {
        let vis = false;
        try { vis = await h.isVisible(); } catch (_) { vis = false; }
        if (vis) seen.push(h); else await h.dispose().catch(() => {});
    }
    return { visible: seen, total: handles.length };
}

export function healer(page, { log = console.log, strict = process.env.WF_HEAL_STRICT === '1' } = {}) {
    const heals = [];

    async function find(label, spec, { timeout = 8000, graceMs, check } = {}) {
        const strategies = strategiesOf(page, spec);
        if (!strategies.length) throw new Error(`heal: "${label}" was given no way to find it`);
        const grace = graceMs == null ? Math.min(1500, Math.floor(timeout / 3)) : graceMs;
        const t0 = Date.now();
        let lastSeen = [];
        for (;;) {
            const seen = [];
            for (let i = 0; i < strategies.length; i++) {
                const st = strategies[i];
                if (i > 0 && Date.now() - t0 < grace) { seen.push({ kind: st.kind, value: st.value, note: 'not tried yet (waiting for the primary)' }); continue; }
                const { visible, total } = await visibleMatches(st.loc());
                const entry = { kind: st.kind, value: st.value, visible: visible.length, total };
                seen.push(entry);
                if (visible.length === 1) {
                    if (i === 0) return visible[0];
                    if (check && !(await check(visible[0]))) { entry.note = 'refused by the check'; await visible[0].dispose().catch(() => {}); continue; }
                    if (strict) { await visible[0].dispose().catch(() => {}); throw new Error(`heal (strict): "${label}" is not where the test says: ${strategies[0].kind} ${strategies[0].value} found nothing, ${st.kind} ${st.value} found one`); }
                    const suggest = await visible[0].evaluate(SUGGEST).catch(() => null);
                    const rec = { label, primary: { kind: strategies[0].kind, value: strategies[0].value }, healedBy: { kind: st.kind, value: st.value }, suggest, afterMs: Date.now() - t0 };
                    heals.push(rec);
                    log(`[heal] "${label}": ${rec.primary.kind} ${rec.primary.value} found nothing; found it by ${rec.healedBy.kind} ${rec.healedBy.value}` + (suggest ? ` → use ${suggest}` : ' → no stable selector on it, add a data-testid'));
                    return visible[0];
                }
                if (visible.length > 1) { entry.note = 'ambiguous, refused'; for (const h of visible) await h.dispose().catch(() => {}); }
            }
            lastSeen = seen;
            if (Date.now() - t0 >= timeout) break;
            await sleep(100);
        }
        const tried = lastSeen.map((e) => `${e.kind} ${e.value} → ${e.note && e.visible == null ? e.note : e.visible + ' visible' + (e.total > e.visible ? ' of ' + e.total : '') + (e.note ? ' (' + e.note + ')' : '')}`).join('; ');
        throw new Error(`could not find "${label}" in ${timeout} ms. Tried: ${tried}. A control that is not there is a failing check, not something to work around.`);
    }

    return {
        find,
        async click(label, spec, opts) { const el = await find(label, spec, opts); try { await el.click(); } finally { await el.dispose().catch(() => {}); } },
        async text(label, spec, opts) { const el = await find(label, spec, opts); try { return await el.evaluate((e) => (e.textContent || '').replace(/\s+/g, ' ').trim()); } finally { await el.dispose().catch(() => {}); } },
        report: () => heals.slice(),
        summary() {
            if (!heals.length) { log('[heal] 0 selectors needed healing'); return heals; }
            log(`[heal] ${heals.length} selector(s) were healed; update them so the test stops leaning on a fallback:`);
            for (const h of heals) log(`  - "${h.label}": ${h.primary.kind} ${h.primary.value}  →  ${h.suggest || h.healedBy.kind + ' ' + h.healedBy.value}`);
            const out = process.env.WF_HEAL_OUT;
            if (out) { try { fs.appendFileSync(out, JSON.stringify(heals) + '\n'); } catch (_) { /* the log above is the record */ } }
            return heals;
        },
    };
}
