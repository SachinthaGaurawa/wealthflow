/* =============================================================================
 * autonomy/vision-probe.mjs — does the screenshot reader really read a picture?
 * -----------------------------------------------------------------------------
 * WHY: "GitHub Models reads images for the run token" was claimed in #535 and never proven. The first run of this probe showed
 * it was false: GitHub retired GitHub Models on 2026-07-30 and its endpoint answers HTTP 200 "OK" to everything. This renders a picture of INVENTED words in a real browser, gives it to the same reader the fix
 * agent uses, and checks that the invented words come back. Invented words cannot be guessed from the issue text or
 * the code, so a pass means the picture was actually read.
 *
 * Run by .github/workflows/vision-probe.yml with the same provider keys as the fix agent, so it measures what the agent can
 * really do: the summary names the provider and model that read the picture. Exit 0 = read, 1 = not read (the reasons, HTTP
 * status per model, are printed).
 * ===========================================================================*/

import { describeScreenshot } from '../wf-screenshot-reader.mjs';

/** Invented, never present in the repository or in any issue. */
export const PROBE_WORDS = ['Quartz Harbor', 'LKR 48,271.50', 'Ledger 7Q'];

/** HTML of the picture: large plain text on a light card, like a real phone screenshot of a card line. */
export function probeHtml(words = PROBE_WORDS) {
    return '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#f4f6f8;font:600 40px/1.5 Arial,sans-serif;color:#10222e">' +
        '<div style="padding:36px 44px;width:860px;height:300px;box-sizing:border-box">' +
        `<div style="font-size:30px;color:#5b6b76">Card line</div><div>${words[0]}</div><div style="color:#0a7a4b">${words[1]}</div><div style="font-size:30px;color:#5b6b76">${words[2]}</div>` +
        '</div></body>';
}

/** Which of the invented words the reading contains (whitespace and case do not matter, thousands commas may be dropped). */
export function wordsFound(reading, words = PROBE_WORDS) {
    const norm = (s) => String(s || '').toLowerCase().replace(/[\s,]+/g, '');
    const hay = norm(reading);
    return words.filter((w) => hay.includes(norm(w)));
}

/**
 * Decide from a describeScreenshot result. Two of three invented words must come back: one could be luck in a
 * garbled reading, and a model may miss one small line, but a reader that returns none has not read the picture.
 */
export function probeVerdict(result, words = PROBE_WORDS) {
    if (!result || !result.ok) {
        return { ok: false, found: [], reason: `no provider read the picture (${((result && result.tried) || []).join('; ') || 'no vision-capable credential'})` };
    }
    const found = wordsFound(result.text, words);
    const need = Math.min(2, words.length);
    if (found.length >= need) return { ok: true, found, provider: result.provider, model: result.model, reason: `${result.provider}/${result.model} returned ${found.length} of ${words.length} invented words` };
    return { ok: false, found, provider: result.provider, model: result.model, reason: `${result.provider}/${result.model} answered but returned ${found.length} of ${words.length} invented words: it did not read the picture` };
}

/** Render the picture to a PNG data URL in a real browser. */
export async function renderProbeImage({ launch, words = PROBE_WORDS } = {}) {
    const mod = launch ? { launchChromium: launch } : await import('../test/e2e/harness.mjs');
    const browser = await mod.launchChromium();
    try {
        const page = await browser.newPage({ viewport: { width: 860, height: 300 } });
        await page.setContent(probeHtml(words));
        const png = await page.screenshot({ type: 'png' });
        return `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    } finally { await browser.close(); }
}

/**
 * Diagnosis kept from the GitHub Models investigation (its endpoint answered "OK" to the catalogue and to a text question, so the
 * whole service was gone, not just images). Only used when a GitHub token is the sole credential; status and the first 100
 * characters of each body only.
 */
export async function diagnose({ env = process.env, fetchImpl = globalThis.fetch } = {}) {
    const token = String(env.GITHUB_TOKEN || '').trim();
    const head = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    const show = async (label, url, init) => {
        try {
            const r = await fetchImpl(url, { ...init, headers: { ...head, ...(init && init.headers) }, signal: AbortSignal.timeout(20000) });
            const body = String(await r.text()).replace(/\s+/g, ' ').slice(0, 100);
            return `${label}: HTTP ${r.status} ${body || '(empty)'}`;
        } catch (e) { return `${label}: ${String((e && e.message) || e).slice(0, 80)}`; }
    };
    return [
        await show('catalogue', 'https://models.github.ai/catalog/models'),
        await show('text-only', 'https://models.github.ai/inference/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: 'openai/gpt-4o-mini', max_tokens: 8, messages: [{ role: 'user', content: 'Reply with the single word PONG.' }] }),
        }),
    ];
}

export async function run({ env = process.env, log = console.log, describeImpl = describeScreenshot, renderImpl = renderProbeImage, diagnoseImpl = diagnose } = {}) {
    const dataUrl = await renderImpl();
    // verify:false, one reader: this asks "can it read", not "do two readers agree".
    const result = await describeImpl({ dataUrl, title: 'Probe', text: '', verify: false, env, log });
    const v = probeVerdict(result);
    log(`[vision-probe] ${v.ok ? 'READ' : 'NOT READ'}: ${v.reason}`);
    if (!v.ok) {
        try { for (const line of await diagnoseImpl({ env })) log(`[vision-probe] diagnosis ${line}`); } catch (_) { /* the verdict stands */ }
    }
    return v;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    run().then((v) => {
        const line = v.ok ? `The picture was read: ${v.reason}` : `The picture was NOT read: ${v.reason}`;
        if (process.env.GITHUB_STEP_SUMMARY) {
            import('node:fs').then((fs) => fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Vision probe\n\n${line}\n`));
        }
        process.exit(v.ok ? 0 : 1);
    }).catch((e) => { console.error(`[vision-probe] ${e.message}`); process.exit(1); });
}
