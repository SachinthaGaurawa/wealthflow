/* =============================================================================
 * autonomy/swarm-patch.mjs — find the right file, and edit it WITHOUT rewriting it
 * -----------------------------------------------------------------------------
 * WHAT THE LIVE RUN OF 2026-11-03 SHOWED (issue #492, a real report filed through
 * the production feedback endpoint):
 *   attempt 1  the model was asked to pick a file from a bare list of NAMES and
 *              chose `version.js`; it then said CANNOT_FIX_SAFELY because the
 *              Settings card it needed lives elsewhere.
 *   attempt 2  it chose `pwa-updater.js` (a module nothing loads) and its test
 *              did not prove anything.
 *   The Settings > Software update card is in wealthflow-update-system.js —
 *   about 115 KB, far past the 32 KB the swarm could rewrite whole, so it was
 *   never even offered.
 * Two defects, both fixed here without touching the safety gates:
 *   1. SELECTION BY FILENAME ALONE. Now the issue's own words are searched for in
 *      the code, and the model is shown the best matches WITH the matching lines.
 *   2. WHOLE-FILE REWRITES. A 115 KB file cannot be reproduced by a free model
 *      without dropping lines. Now the model sees the relevant windows and
 *      returns exact SEARCH/REPLACE blocks; every SEARCH must occur exactly once
 *      in the real file or the edit is refused. Nothing outside the blocks can
 *      change, so the structural/syntax/security/test gates still judge the
 *      real diff.
 * Everything here is pure (no network, no model), so it is all unit-tested.
 * ===========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const STOP = new Set(('the a an and or of to in on for with from that this these those is are was were be been it its as at by not no ' +
    'but if so we you i my me our your please fix make add show when what which have has had can could should would will just also than then ' +
    'there their them they into out up down over under about after before app apps wealthflow feedback issue bug test small one line more some ' +
    'any all each both next here where how why who whom whose only own same such too very')
    .split(' '));

/** Words worth searching for: identifiers, UI words, file-like names. Longest/rarest first. */
export function keywordsFrom(text) {
    const raw = String(text || '');
    const out = new Map();
    const bump = (w, n = 1) => { const k = w.toLowerCase(); out.set(k, (out.get(k) || 0) + n); };
    // `code`-quoted and file-like tokens are the strongest signal.
    for (const m of raw.matchAll(/`([^`]{2,60})`/g)) bump(m[1].trim(), 6);
    for (const m of raw.matchAll(/\b[\w-]+\.(?:js|mjs|cjs|html|css|json)\b/gi)) bump(m[0], 6);
    for (const m of raw.matchAll(/\b[a-z]+(?:[A-Z][a-z0-9]+)+\b/g)) bump(m[0], 4);          // camelCase
    for (const m of raw.matchAll(/\b[A-Za-z][A-Za-z0-9]{3,}\b/g)) {
        const w = m[0];
        if (STOP.has(w.toLowerCase())) continue;
        bump(w, 1);
        // split camelCase into its words too (setAutoSecurity -> auto, security)
        for (const p of w.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(' ')) {
            if (p.length >= 4 && !STOP.has(p.toLowerCase())) bump(p, 0.5);
        }
    }
    return [...out.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w).slice(0, 24);
}

/**
 * Rank files by how well they match the report.
 * @returns {{file:string, score:number, snippets:string[], bytes:number}[]}
 */
export function rankFiles(issueText, files, { repoDir = process.cwd(), k = 8, readFile = (f) => fs.readFileSync(path.join(repoDir, f), 'utf8') } = {}) {
    const kws = keywordsFrom(issueText);
    if (!kws.length) return [];
    const weight = new Map(kws.map((w, i) => [w, 1 + (kws.length - i) / kws.length]));   // earlier = heavier
    const scored = [];
    for (const f of files) {
        let src = '';
        try { src = readFile(f); } catch { continue; }
        const lower = src.toLowerCase();
        const name = f.toLowerCase();
        let score = 0;
        const hits = [];
        for (const w of kws) {
            if (name.includes(w)) score += 12 * weight.get(w);
            let n = 0, at = -1;
            while (n < 40 && (at = lower.indexOf(w, at + 1)) !== -1) n++;
            if (n) { score += Math.min(n, 12) * weight.get(w); hits.push([w, n]); }
        }
        if (score > 0) scored.push({ file: f, score, bytes: src.length, src, hits });
    }
    scored.sort((a, b) => b.score - a.score || a.bytes - b.bytes);
    return scored.slice(0, k).map((s) => {
        const top = s.hits.sort((a, b) => weight.get(b[0]) - weight.get(a[0])).slice(0, 3).map(([w]) => w);
        const lines = s.src.split('\n');
        const snippets = [];
        for (const w of top) {
            const i = lines.findIndex((l) => l.toLowerCase().includes(w));
            if (i >= 0) snippets.push(`L${i + 1}: ${lines[i].trim().slice(0, 140)}`);
        }
        return { file: s.file, score: Math.round(s.score * 10) / 10, snippets, bytes: s.bytes };
    });
}

export function selectPromptRanked(issue, ranked) {
    return [
        'A user of a vanilla-JS personal-finance PWA reported the following.',
        '',
        'REPORT:',
        String(issue).slice(0, 1500),
        '',
        'Files that mention the report\'s own words (best match first), with the matching lines.',
        'Choose the one that OWNS the behaviour — the code that renders or decides it.',
        'A server endpoint is rarely the right place for a screen change, and a file that nothing',
        'loads in the app is never the right place for anything.',
        '',
        ranked.map((r) => `- ${r.file} (${Math.round(r.bytes / 1024)} KB)\n${r.snippets.map((s) => '    ' + s).join('\n')}`).join('\n'),
        '',
        'Reply with ONLY the single filename from that list. If none can plausibly address the report, reply NONE.',
        'No explanation, no punctuation, just the filename or NONE.',
    ].join('\n');
}

/**
 * Build the windows of a large file the model needs to see.
 * Lines matching the issue's keywords are expanded by `ctx` lines either side,
 * overlapping windows are merged, and the total is capped at `maxChars`.
 */
export function excerptFor(content, keywords, { ctx = 25, maxChars = 18_000 } = {}) {
    const lines = String(content).split('\n');
    const kws = (keywords || []).map((k) => k.toLowerCase());
    const hit = [];
    lines.forEach((l, i) => {
        const low = l.toLowerCase();
        let s = 0;
        kws.forEach((k, ki) => { if (low.includes(k)) s += 1 + (kws.length - ki) / kws.length; });
        if (s > 0) hit.push([i, s]);
    });
    // densest regions first: score every line by the sum of nearby hits
    const regionScore = new Map();
    for (const [i, s] of hit) for (let j = Math.max(0, i - ctx); j <= Math.min(lines.length - 1, i + ctx); j += 5) regionScore.set(j, (regionScore.get(j) || 0) + s);
    const seeds = [...regionScore.entries()].sort((a, b) => b[1] - a[1]).map(([j]) => j);
    const picked = [];
    let total = 0;
    for (const c of seeds) {
        const a = Math.max(0, c - ctx), b = Math.min(lines.length - 1, c + ctx);
        if (picked.some(([x, y]) => a <= y && b >= x && (Math.min(b, y) - Math.max(a, x)) > ctx)) continue;   // mostly covered
        const size = lines.slice(a, b + 1).join('\n').length;
        if (total + size > maxChars) continue;
        picked.push([a, b]); total += size;
        if (total >= maxChars) break;
    }
    // merge overlaps
    picked.sort((x, y) => x[0] - y[0]);
    const merged = [];
    for (const w of picked) {
        const last = merged[merged.length - 1];
        if (last && w[0] <= last[1] + 1) last[1] = Math.max(last[1], w[1]); else merged.push([...w]);
    }
    if (!merged.length) merged.push([0, Math.min(lines.length - 1, 80)]);
    return {
        windows: merged,
        text: merged.map(([a, b]) => `// ----- lines ${a + 1}-${b + 1} -----\n${lines.slice(a, b + 1).join('\n')}`).join('\n\n'),
    };
}

export function patchPrompt(issue, filename, excerptText, totalLines) {
    return [
        'ISSUE TO FIX:',
        String(issue).slice(0, 2000),
        '',
        `FILE: ${filename} (${totalLines} lines; only the relevant windows are shown below)`,
        '--- BEGIN EXCERPTS ---',
        excerptText,
        '--- END EXCERPTS ---',
        '',
        'Reply with one or more edit blocks in EXACTLY this format and nothing else:',
        '',
        '<<<<<<< SEARCH',
        '(lines copied EXACTLY from the excerpts above, including indentation; enough lines that they occur ONCE in the file)',
        '=======',
        '(the replacement lines)',
        '>>>>>>> REPLACE',
        '',
        'Rules: every SEARCH must be copied verbatim from the excerpts. Keep each block small. Do not',
        'reproduce the rest of the file. Do not add imports. To INSERT code, SEARCH for one existing line',
        'next to the insertion point and repeat it in the REPLACE with your new lines beside it.',
        'If you cannot fix it safely within your constraints, reply exactly: CANNOT_FIX_SAFELY <reason>',
    ].join('\n');
}

/** Parse SEARCH/REPLACE blocks out of a model reply. */
export function parsePatchBlocks(text) {
    const s = String(text || '').replace(/\r\n/g, '\n');
    const blocks = [];
    const re = /<<<<<<<[ \t]*SEARCH[ \t]*\n([\s\S]*?)\n=======[ \t]*\n([\s\S]*?)\n?>>>>>>>[ \t]*REPLACE/g;
    let m;
    while ((m = re.exec(s)) !== null) blocks.push({ search: m[1], replace: m[2] });
    return blocks;
}

/**
 * Apply blocks to the real file. Strict by design: a SEARCH that is missing or
 * ambiguous refuses the WHOLE patch, so a half-applied edit can never exist.
 * @returns {{ok:boolean, code?:string, problems:string[], applied:number}}
 */
export function applyPatchBlocks(before, blocks) {
    const problems = [];
    if (!blocks || !blocks.length) return { ok: false, problems: ['no edit blocks found in the reply'], applied: 0 };
    let code = String(before);
    let applied = 0;
    for (const [i, b] of blocks.entries()) {
        if (!b.search.trim()) { problems.push(`block ${i + 1}: empty SEARCH`); continue; }
        const first = code.indexOf(b.search);
        if (first === -1) { problems.push(`block ${i + 1}: SEARCH text not found in the file (copy it exactly)`); continue; }
        if (code.indexOf(b.search, first + 1) !== -1) { problems.push(`block ${i + 1}: SEARCH text occurs more than once (add surrounding lines)`); continue; }
        if (b.search === b.replace) { problems.push(`block ${i + 1}: replacement equals the original`); continue; }
        code = code.slice(0, first) + b.replace + code.slice(first + b.search.length);
        applied++;
    }
    if (problems.length) return { ok: false, problems, applied };
    if (code === before) return { ok: false, problems: ['the patch changes nothing'], applied };
    return { ok: true, code, problems: [], applied };
}

/**
 * The CHANGE, not the top of the file. The security reviewer and the test writer
 * used to receive `before.slice(0, 5000)` / `after.slice(0, 5000)`; for a 115 KB
 * module that is the first 5 KB — which a patch never touches — so a reviewer would
 * have been asked to veto a change it could not see. This returns the unified diff
 * (with context) so both see exactly what moved.
 */
export function changeExcerpt(before, after, opts = {}) {
    return changeView(before, after, opts).text;
}

/**
 * Same as `changeExcerpt`, but says whether the diff had to be cut. A reviewer that
 * is shown a cut diff has not seen the change, so anything that relies on a reviewer's
 * PASS must check `truncated` and fail closed (Codex review on #493: edits after the
 * cutoff would otherwise bypass the independent security review).
 * @returns {{text:string, truncated:boolean, length:number}}
 */
export function changeView(before, after, { ctx = 12, max = 6000 } = {}) {
    const b = String(before), a = String(after);
    let diff = '';
    try {
        const dir = fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || '/tmp', 'wf-diff-'));
        try {
            fs.writeFileSync(path.join(dir, 'before'), b);
            fs.writeFileSync(path.join(dir, 'after'), a);
            try {
                execFileSync('git', ['diff', '--no-index', `--unified=${ctx}`, '--no-color', 'before', 'after'], { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
            } catch (e) {
                diff = e && e.status === 1 && e.stdout ? String(e.stdout) : '';        // exit 1 = "files differ"
            }
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    } catch { diff = ''; }
    if (!diff) {
        // fallback: the region between the common prefix and suffix
        const bl = b.split('\n'), al = a.split('\n');
        let i = 0; while (i < bl.length && i < al.length && bl[i] === al[i]) i++;
        let j = 0; while (j < bl.length - i && j < al.length - i && bl[bl.length - 1 - j] === al[al.length - 1 - j]) j++;
        diff = `@@ changed lines ${i + 1}-${al.length - j} @@\n` + al.slice(Math.max(0, i - ctx), al.length - j + ctx).join('\n');
    }
    diff = diff.split('\n').filter((l) => !/^(diff --git|index |--- |\+\+\+ )/.test(l)).join('\n');
    const truncated = diff.length > max;
    return { text: truncated ? diff.slice(0, max) + '\n… (diff truncated)' : diff, truncated, length: diff.length };
}
