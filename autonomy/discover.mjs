#!/usr/bin/env node
/* =============================================================================
 * autonomy/discover.mjs — the agent goes LOOKING for work
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 *   The fix pipeline was proven to work end-to-end (issue #3 → autonomous fix →
 *   consensus review → auto-merge). But it is REACTIVE: it only moves when a
 *   human files an issue. Nobody files issues. So the queue sat empty, every
 *   scheduled run exited "success" having done nothing, and the only thing
 *   landing on main was merchant-sync data and version bumps.
 *
 *   That is the honest reason the repo looked like "only version numbers going
 *   up". The engine was alive and idling, not broken — but an autonomous system
 *   that waits to be told what to do is not autonomous.
 *
 *   Meanwhile REAL work was sitting in the repo the whole time. The first run of
 *   this scanner found a HIGH-severity SMTP-injection + TLS-validation CVE chain
 *   in `nodemailer`, a PRODUCTION dependency used by send-otp.js — the live OTP
 *   login path. Nothing had ever looked.
 *
 * THE RULE THAT KEEPS THIS HONEST
 *   Every detector here is DETERMINISTIC and carries EVIDENCE. No model is asked
 *   "what's wrong with this code?" — that produces confident nonsense, floods the
 *   queue, and burns the fix pipeline on imaginary bugs. A finding is only filed
 *   when a machine can prove it, and the issue body always shows the command or
 *   the exact source line that proves it. The LLM swarm is for FIXING, not for
 *   deciding what is broken.
 *
 *   This is also why the scanner resolves web-absolute asset paths before
 *   claiming a file is missing: the first draft reported `/manifest.json` as a
 *   404 when `manifest.json` was sitting in the repo root. A false positive is
 *   worse than silence — it teaches you to ignore the system.
 *
 * USAGE
 *   node autonomy/discover.mjs            scan, print findings
 *   node autonomy/discover.mjs --json     machine-readable
 *   node autonomy/discover.mjs --file     file the findings as GitHub issues
 * ===========================================================================*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import * as Q from './work-queue.mjs';
import { loadLedger, quarantinedKinds, stampDetector, formatLedger } from './accuracy.mjs';

/** Cap per run. A scanner that opens 40 issues at once is a denial-of-service
 *  on your own attention, and the queue is ranked anyway. */
export const MAX_PER_RUN = 4;

/** Marker that makes a discovered issue recognisable + dedupable, forever. */
export const FINGERPRINT_TAG = 'wf-discover';

/** Stable id for a finding, so re-scanning never files the same thing twice. */
export function fingerprint(kind, key) {
    return crypto.createHash('sha256').update(`${kind}\u0000${key}`).digest('hex').slice(0, 16);
}

/** Embed/extract the fingerprint in an issue body (HTML comment — invisible). */
export function stampBody(body, fp) {
    return `${body}\n\n<!-- ${FINGERPRINT_TAG}:${fp} -->\n`;
}
export function fingerprintsIn(issues) {
    const out = new Set();
    const re = new RegExp(`<!--\\s*${FINGERPRINT_TAG}:([a-f0-9]{16})\\s*-->`);
    for (const i of issues || []) {
        const m = re.exec(String(i?.body || ''));
        if (m) out.add(m[1]);
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 1 — vulnerable dependencies  (the "monthly security update" the
// blueprint asked for, implemented as something that actually runs)
// ─────────────────────────────────────────────────────────────────────────────
const SEV_RANK = { critical: 0, high: 1, moderate: 2, low: 3, info: 4 };

/** Parse `npm audit --json`. Pure, so it is testable without a network. */
export function parseAudit(json, prodDeps = new Set()) {
    let d;
    try { d = typeof json === 'string' ? JSON.parse(json) : json; } catch { return []; }
    const vulns = (d && d.vulnerabilities) || {};
    const out = [];
    for (const [name, v] of Object.entries(vulns)) {
        const severity = String(v?.severity || 'info').toLowerCase();
        if (SEV_RANK[severity] > SEV_RANK.high) continue;      // only high + critical
        const isProd = prodDeps.has(name);
        const titles = [];
        for (const via of v?.via || []) {
            if (via && typeof via === 'object' && via.title) titles.push(String(via.title));
        }
        out.push({
            kind: 'dep-vuln',
            key: name,
            severity: isProd ? 'critical' : severity,   // a prod hole outranks a dev one
            production: isProd,
            package: name,
            advisories: titles,
            range: String(v?.range || ''),
            fixAvailable: v?.fixAvailable ?? false,
        });
    }
    // production first, then by real severity
    return out.sort((a, b) =>
        (Number(b.production) - Number(a.production))
        || (SEV_RANK[a.severity] - SEV_RANK[b.severity]));
}

export function productionDeps(repoDir = process.cwd()) {
    try {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, 'package.json'), 'utf8'));
        return new Set(Object.keys(pkg.dependencies || {}));
    } catch { return new Set(); }
}

function runAudit(repoDir) {
    try {
        return execFileSync('npm', ['audit', '--json'], {
            cwd: repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'],
        });
    } catch (e) {
        // npm audit exits NONZERO when it finds vulnerabilities — that is the
        // normal path, and stdout still holds the report.
        return e?.stdout || '';
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 2 — assets the app references but that do not exist (hard 404s)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a URL as written in HTML to a repo-relative path, or null if it is
 * not a local file we can check.
 *
 * The leading-slash case is the one that produced this scanner's first false
 * positive: `/manifest.json` is web-absolute and lives at `manifest.json` on
 * disk. Reporting it as missing was wrong, and a wrong alarm is worse than none.
 */
export function resolveLocalAsset(url) {
    const u = String(url || '').trim();
    if (!u) return null;
    if (/^(https?:)?\/\//i.test(u)) return null;      // remote
    if (/^(data|blob|mailto|javascript):/i.test(u)) return null;
    if (u.startsWith('#')) return null;               // in-page anchor
    if (u.includes('${') || u.includes('{{')) return null;  // template expression
    return u.replace(/[?#].*$/, '').replace(/^\/+/, '');    // strip query/hash + web root
}

export function findBrokenAssets(html, repoDir = process.cwd()) {
    const out = [];
    const seen = new Set();
    const re = /(?:src|href)\s*=\s*"([^"]+\.(?:js|mjs|css|json|webmanifest|png|jpg|jpeg|svg|webp|ico|woff2?))"/gi;
    let m;
    while ((m = re.exec(String(html || ''))) !== null) {
        const rel = resolveLocalAsset(m[1]);
        if (!rel || seen.has(rel)) continue;
        seen.add(rel);
        if (!fs.existsSync(path.join(repoDir, rel))) {
            out.push({ kind: 'broken-asset', key: rel, severity: 'high', asset: rel, asWritten: m[1] });
        }
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 3 — unguarded JSON.parse on external data (the exact bug class that
// killed the previous agent: JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))
// ─────────────────────────────────────────────────────────────────────────────

/** Sources whose contents are outside our control, so parsing them can throw. */
const EXTERNAL = /JSON\.parse\s*\(\s*(process\.env\.|localStorage\.|sessionStorage\.|await\s|.*\.text\(\)|.*response|.*body|.*raw)/i;

/**
 * Blank out comment bodies while PRESERVING line numbering, so a detector can
 * never fire on prose.
 *
 * This is not hypothetical tidiness. The first run of this scanner reported
 * `autonomous-fix-agent.js:10` and `work-queue.mjs:7` as unguarded parses — both
 * were block comments *documenting* the historical
 * `JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)` crash. A scanner that files
 * bugs against its own changelog is worse than no scanner: it trains you to
 * ignore it. Code is evidence; comments are not.
 */
/**
 * Cut a trailing `//` comment from ONE line, leaving quoted text alone.
 *
 * Quote state is tracked within the line and thrown away at the end of it. That
 * single constraint is what makes this safe: the file-wide tokeniser this
 * replaced could be knocked out of sync by one odd regex literal and stayed
 * wrong for every line that followed. Here a confused line can only ever damage
 * itself, and the next line starts clean.
 *
 * Naively cutting at the first `//` was the first attempt and it truncated
 * `"https://api.groq.com/v1"` — caught by an existing test, which is exactly
 * what those tests are for.
 */
function stripLineComment(line) {
    let quote = null;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (quote) {
            if (c === '\\') { i += 1; continue; }
            if (c === quote) quote = null;
            continue;
        }
        if (c === "'" || c === '"' || c === '`') { quote = c; continue; }
        if (c === '/' && line[i + 1] === '/') return line.slice(0, i);
    }
    return line;
}

export function stripComments(source) {
    // WHY THIS IS LINE-ORIENTED AND NOT A TOKENISER
    //   The first version walked the file character by character tracking string
    //   state, and it DESYNCED on this very file. The culprit:
    //
    //     const re = /(?:src|href)\s*=\s*"([^"]+\.(?:js|mjs))"/gi;
    //
    //   a regex literal holding an ODD number of double quotes. The tokeniser
    //   read the first `"` as a string opener and never recovered, so every
    //   later `//` looked like string content — and the scanner went straight
    //   back to reporting its own documentation as unguarded JSON.parse calls.
    //   The property test missed it because random strings essentially never
    //   contain a regex literal with unbalanced quotes.
    //
    //   Telling a regex literal from a division operator needs real parsing, and
    //   a detector is not worth a JS parser. Scanning line by line cannot desync
    //   across the file, and when it is wrong it OVER-strips — which loses a
    //   finding rather than inventing one. For a tool whose credibility depends
    //   on never crying wolf, that is the right direction to fail in.
    const lines = String(source || '').split('\n');
    const out = [];
    let inBlock = false;
    for (const line of lines) {
        if (inBlock) {
            const end = line.indexOf('*/');
            if (end === -1) { out.push(''); continue; }
            inBlock = false;
            out.push(' '.repeat(end + 2) + line.slice(end + 2));
            continue;
        }
        const t = line.trimStart();
        if (t.startsWith('//') || t.startsWith('*')) { out.push(''); continue; }   // comment or JSDoc body
        const open = line.indexOf('/*');
        if (open !== -1) {
            const close = line.indexOf('*/', open + 2);
            if (close === -1) { inBlock = true; out.push(line.slice(0, open)); continue; }
            out.push(line.slice(0, open) + ' '.repeat(close + 2 - open) + line.slice(close + 2));
            continue;
        }
        out.push(stripLineComment(line));
    }
    return out.join('\n');
}

export function findUnguardedJsonParse(source, file) {
    const lines = stripComments(source).split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!EXTERNAL.test(line)) continue;
        // Guarded if a try appears in the preceding window and the line itself
        // is not already defended by a catch-expression or optional fallback.
        const before = lines.slice(Math.max(0, i - 12), i).join('\n');
        const guarded = /\btry\s*\{/.test(before) || /\bcatch\b/.test(line);
        if (guarded) continue;
        out.push({
            kind: 'unguarded-json-parse',
            key: `${file}:${i + 1}`,
            severity: 'high',
            file,
            line: i + 1,
            snippet: line.trim().slice(0, 160),
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// DETECTOR 4 — images with no alt text (user-friendliness is the top priority)
// ─────────────────────────────────────────────────────────────────────────────
export function findImagesMissingAlt(html, file = 'index.html') {
    const out = [];
    const seen = new Set();

    // SCAN MARKUP, NOT SCRIPT.
    //
    // index.html is 1.5 MB and is mostly inline <script>. Running an HTML regex
    // over the whole file matched `<img` inside JavaScript string literals,
    // template literals and REGEX SOURCE — findings like
    //   `<img|<div)/i.test(text) || /style="[^"]*object-fit:cover/i…`
    // which is a regex, not an image. Those were filed as real accessibility
    // defects.
    //
    // This is the same lesson this project already learned once: a static pass
    // over index.html produced 21 UI findings of which ~17 were false, which is
    // why the runtime sweep exists. Script and style blocks are removed first so
    // the regex only ever sees markup.
    const markup = String(html || '')
        .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');

    const re = /<img\b[^>]*>/gi;
    let m;
    while ((m = re.exec(markup)) !== null) {
        const tag = m[0];
        if (/\balt\s*=/i.test(tag)) continue;
        if (/\baria-hidden\s*=\s*"true"/i.test(tag)) continue;   // decorative, correctly hidden

        // IDENTITY, NOT POSITION.
        //
        // The key was `${file}#${n}` where n counted un-alt'd images in document
        // order. That is a position in a sequence that CHANGES: add an alt to one
        // image and every image after it shifts down, gets a new fingerprint, and
        // is re-filed as a brand-new finding. It produced issues #21, #22, #33,
        // #34, #35 and #36 — six open issues for a handful of images, from a
        // detector whose whole job is to make real problems visible.
        //
        // A scanner that manufactures duplicates is worse than one that stays
        // quiet: it buries its own true findings, and the reader learns to skip
        // the label. The src is what a person would use to identify the image, so
        // it is what the fingerprint uses too.
        const src = (/\bsrc\s*=\s*["']([^"']+)["']/i.exec(tag) || [, ''])[1];
        const ident = (src || tag.replace(/\s+/g, ' ').trim()).slice(0, 120);

        // Two identical images missing alt are ONE fix, not two issues.
        if (seen.has(ident)) continue;
        seen.add(ident);

        out.push({
            kind: 'img-missing-alt',
            key: `${file}#${ident}`,
            severity: 'medium',
            file,
            snippet: tag.slice(0, 160),
        });
    }
    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Scan
// ─────────────────────────────────────────────────────────────────────────────
const CODE_EXT = /\.(js|mjs|cjs)$/i;

function trackedCode(repoDir) {
    try {
        return execFileSync('git', ['ls-files'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
            .split('\n').filter(Boolean)
            .filter((f) => CODE_EXT.test(f))
            .filter((f) => !f.startsWith('node_modules/') && !f.startsWith('test/'));
    } catch { return []; }
}

/**
 * Findings from the live browser sweep (test/e2e/ui-sweep.mjs).
 *
 * The static `img-missing-alt` detector below is a fair test of markup, but it
 * cannot see the UI that ACTUALLY renders — a static pass over index.html
 * produced 21 findings of which ~17 were false, because the app builds ids at
 * runtime (`el.id = …`) and switches between mutually exclusive template
 * branches. The browser has no such problem: it reports the DOM that exists.
 *
 * Kept OPTIONAL on purpose. The sweep needs Playwright plus a Chromium binary;
 * where that is unavailable the rest of discovery must still run, so a failure
 * here degrades to "no UI findings" rather than taking the whole scan down.
 */
export async function uiFindings(repoDir = process.cwd()) {
    let runSweep;
    try {
        ({ runSweep } = await import('../test/e2e/ui-sweep.mjs'));
    } catch {
        return [];                      // harness absent — not an error
    }
    let r;
    try {
        r = await runSweep({ repoDir });
    } catch (e) {
        // A sweep that cannot sign in is itself worth knowing about, but it is a
        // harness problem, not an application defect, so it is not filed as one.
        console.warn(`[discover] UI sweep unavailable: ${e.message}`);
        return [];
    }

    const out = [];
    for (const h of r.brokenHandlers || []) {
        out.push({
            kind: 'broken-handler', key: `${h.fn}|${h.element}`,
            severity: h.visible ? 'critical' : 'high',
            fn: h.fn, element: h.element, attr: h.attr, snippet: h.snippet, visible: h.visible,
        });
    }
    for (const d of r.duplicateIds || []) {
        if (!d.anyVisible) continue;    // an offscreen clash cannot be hit
        out.push({ kind: 'duplicate-id', key: d.id, severity: 'high', id: d.id, count: d.count, elements: d.elements });
    }
    for (const a of r.deadAnchors || []) {
        out.push({ kind: 'dead-anchor', key: `${a.href}|${a.element}`, severity: 'medium', href: a.href, element: a.element });
    }
    for (const e of r.pageErrors || []) {
        out.push({ kind: 'runtime-error', key: e.slice(0, 80), severity: 'critical', message: e });
    }
    // ── performance: structural facts only ──────────────────────────────────
    // Wall-clock timings are NOT turned into findings. They swung 2295ms ->
    // 4210ms between two runs on identical code in this sandbox, because every
    // CDN request times out here. Reporting that would describe the CI machine,
    // not the app. What follows is true regardless of where the sweep runs.
    const perf = r.perf || {};
    if ((perf.renderBlockingExternal || []).length) {
        out.push({
            kind: 'render-blocking-external',
            key: perf.renderBlockingExternal.slice().sort().join('|'),
            severity: 'medium',
            scripts: perf.renderBlockingExternal,
            total: (perf.renderBlocking || []).length,
        });
    }
    if ((perf.domElements || 0) > 1500) {
        out.push({
            kind: 'large-dom',
            key: 'dom-element-count',
            severity: 'low',
            count: perf.domElements,
            depth: perf.maxDomDepth,
        });
    }

    // Accessibility findings are grouped: 31 separate issues for 31 unlabelled
    // buttons would bury the queue for one fix that touches them together.
    if ((r.unlabelledControls || []).length) {
        out.push({
            kind: 'unlabelled-controls', key: 'visible-controls-without-accessible-name',
            severity: 'medium',
            count: r.unlabelledControls.length,
            examples: r.unlabelledControls.slice(0, 8).map((c) => c.element),
            sections: (r.sections || []).length,
        });
    }
    return out;
}

export function scan(repoDir = process.cwd()) {
    const findings = [];

    findings.push(...parseAudit(runAudit(repoDir), productionDeps(repoDir)));

    const indexPath = path.join(repoDir, 'index.html');
    if (fs.existsSync(indexPath)) {
        const html = fs.readFileSync(indexPath, 'utf8');
        findings.push(...findBrokenAssets(html, repoDir));
        findings.push(...findImagesMissingAlt(html));
    }

    for (const f of trackedCode(repoDir)) {
        let src;
        try { src = fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { continue; }
        findings.push(...findUnguardedJsonParse(src, f));
    }

    for (const f of findings) f.fingerprint = fingerprint(f.kind, f.key);
    return findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering a finding as an actionable issue the fix swarm can work
// ─────────────────────────────────────────────────────────────────────────────
const FOOTER = '\n\n---\n_Generated by [Claude Code](https://claude.ai/code)_';

export function renderIssue(f) {
    const sev = String(f.severity).toUpperCase();
    if (f.kind === 'dep-vuln') {
        const where = f.production ? '**PRODUCTION dependency** — ships in the deployed app' : 'dev dependency (build/test only)';
        return {
            title: `[${sev}] Vulnerable dependency: ${f.package}`,
            labels: ['security', 'autonomous'],
            body: [
                `## Vulnerable dependency\n`,
                `\`${f.package}\` (${where}) has known advisories affecting \`${f.range || 'the installed range'}\`.\n`,
                f.advisories.length ? `### Advisories\n${f.advisories.map((t) => `- ${t}`).join('\n')}\n` : '',
                `### Evidence (reproduce locally)\n\`\`\`bash\nnpm audit\n\`\`\`\n`,
                `### Fix\n`,
                f.fixAvailable
                    ? 'A fix is available. Bump the package to a patched version and run the full test suite.\n'
                    : 'No automatic fix is published yet — bump to the newest release and re-audit.\n',
                f.production
                    ? '\n> This one is user-facing: it is reachable from the deployed serverless code, so treat it as a real security update, not housekeeping.\n'
                    : '',
            ].join(''),
        };
    }
    if (f.kind === 'broken-asset') {
        return {
            title: `[${sev}] Missing asset: ${f.asset} is referenced but does not exist`,
            labels: ['bug', 'autonomous'],
            body: `## Missing asset\n\n\`index.html\` references \`${f.asWritten}\`, which resolves to \`${f.asset}\` — and that file is not in the repository, so it 404s on load.\n\n### Evidence\n\`\`\`bash\ngrep -n '${f.asWritten}' index.html\nls ${f.asset}   # no such file\n\`\`\`\n\n### Fix\nEither add the file, or remove/repoint the reference.\n`,
        };
    }
    if (f.kind === 'unguarded-json-parse') {
        return {
            title: `[${sev}] Unguarded JSON.parse of external data in ${f.file}`,
            labels: ['bug', 'autonomous'],
            body: `## Crash risk\n\n\`${f.file}:${f.line}\` parses data from outside the program without a guard. If that value is empty or malformed, \`JSON.parse\` throws and takes the surrounding operation down with it.\n\n\`\`\`js\n${f.snippet}\n\`\`\`\n\n> This is the exact bug class that silently killed the previous autonomous agent for months: \`JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)\` threw on an unset variable, and the failure was swallowed.\n\n### Fix\nWrap it in \`try/catch\` and fall back to a safe default, or validate before parsing.\n`,
        };
    }
    if (f.kind === 'broken-handler') {
        return {
            title: `[${sev}] Broken control: ${f.element} calls undefined ${f.fn}()`,
            labels: ['bug', 'ui/ux', 'autonomous'],
            body: `## A control that throws when used\n\n\`${f.element}\`${f.visible ? ' **is visible on screen** and' : ''} has \`${f.attr}\` calling \`${f.fn}()\`, which is not defined in the page's global scope. Using it throws a \`ReferenceError\` and the action silently does nothing.\n\n\`\`\`html\n${f.snippet}\n\`\`\`\n\n### Evidence\nFound by the runtime sweep against the live, signed-in DOM — not by parsing the source:\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs\n\`\`\`\nThe check resolves the name the way an inline handler does (global lexical scope), so a helper declared as a top-level \`const\` is correctly treated as defined.\n\n### Fix\nDefine \`${f.fn}\`, correct the name, or remove the handler.\n`,
        };
    }
    if (f.kind === 'duplicate-id') {
        return {
            title: `[${sev}] Duplicate id #${f.id} rendered ${f.count}× at once`,
            labels: ['bug', 'autonomous'],
            body: `## Duplicate id in the live DOM\n\n\`#${f.id}\` exists ${f.count} times simultaneously, so \`document.getElementById('${f.id}')\` silently returns only the first. Any code that reads or writes it may be targeting the wrong element.\n\n${f.elements.map((e) => `- \`${e}\``).join('\n')}\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs\n\`\`\`\nThis is a *runtime* duplicate: both elements are present together, unlike mutually exclusive template branches, which the sweep does not flag.\n\n### Fix\nMake the ids unique, or scope the lookup with \`querySelector\` inside the container.\n`,
        };
    }
    if (f.kind === 'dead-anchor') {
        return {
            title: `[${sev}] Dead in-page link ${f.href}`,
            labels: ['bug', 'ui/ux', 'autonomous'],
            body: `## Link goes nowhere\n\n\`${f.element}\` points at \`${f.href}\`, and no element with that id or name exists in the rendered page. Clicking it does nothing.\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs\n\`\`\`\n\n### Fix\nPoint it at a real target, or remove the link.\n`,
        };
    }
    if (f.kind === 'runtime-error') {
        return {
            title: `[${sev}] Uncaught error while using the app: ${f.message.slice(0, 70)}`,
            labels: ['bug', 'autonomous'],
            body: `## Uncaught exception\n\nThe app threw while the sweep signed in and walked the sections:\n\n\`\`\`\n${f.message}\n\`\`\`\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs\n\`\`\`\nErrors caused by third-party scripts failing to load in the offline CI sandbox are filtered out, so this one originates in application code.\n\n### Fix\nReproduce with the command above and guard or correct the failing path.\n`,
        };
    }
    if (f.kind === 'render-blocking-external') {
        return {
            title: `[${sev}] ${f.scripts.length} third-party scripts block first paint`,
            labels: ['ui/ux', 'autonomous'],
            body: `## Render-blocking third-party scripts\n\n${f.scripts.length} of the ${f.total} parser-blocking scripts are loaded from other people's servers. The browser cannot paint anything until each one is fetched and executed, so page load is gated on hosts outside your control.\n\n${f.scripts.map((s) => `- \`${s}\``).join('\n')}\n\nThis is a resilience problem as well as a speed one: if one of these hosts is slow, blocked by an ad blocker, or unreachable on a corporate or national network, the app stalls or throws. That is not hypothetical — \`Chart is not defined\` is exactly what happens when cdnjs cannot be reached.\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs --json    # perf.renderBlockingExternal\n\`\`\`\nMeasured on the live signed-in page, not inferred from markup.\n\n### Fix\nAdd \`defer\` where execution order allows, or self-host the libraries so a third-party outage cannot block your app. Firebase in particular is needed early, so \`defer\` plus an ordered init is usually the safer of the two.\\n`,
        };
    }
    if (f.kind === 'large-dom') {
        return {
            title: `[${sev}] ${f.count} DOM elements on the dashboard`,
            labels: ['ui/ux', 'autonomous'],
            body: `## Large DOM\n\nThe signed-in dashboard renders **${f.count} elements** (max nesting depth ${f.depth}). Lighthouse warns above 1,500: every element costs memory, and style recalculation scales with the size of the tree, so interactions get measurably slower on low-end phones.\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs --json    # perf.domElements\n\`\`\`\n\n### Fix\nRender sections on demand rather than building every modal and panel up front. Low priority on a fast desktop; it is felt on a budget phone.\\n`,
        };
    }
    if (f.kind === 'unlabelled-controls') {
        return {
            title: `[${sev}] ${f.count} visible controls have no accessible name`,
            labels: ['ui/ux', 'autonomous'],
            body: `## Screen readers announce nothing for these controls\n\nAcross ${f.sections} sections, **${f.count} visible controls** have no text, \`aria-label\`, or \`title\`. A screen reader reads them as an unnamed button, so they cannot be identified or used non-visually. Most are icon-only buttons.\n\n${f.examples.map((e) => `- \`${e}\``).join('\n')}\n\n### Evidence\n\`\`\`bash\nnode test/e2e/ui-sweep.mjs\n\`\`\`\nOnly *visible* controls are counted — hidden template markup is ignored.\n\n### Fix\nAdd \`aria-label\` describing the action, e.g. \`<button class="md-x" aria-label="Close">\`. Grouped into one issue because a single pass fixes them together.\n`,
        };
    }
    if (f.kind === 'img-missing-alt') {
        return {
            title: `[${sev}] Image without alt text in ${f.file}`,
            labels: ['ui/ux', 'autonomous'],
            body: `## Accessibility defect\n\nAn \`<img>\` in \`${f.file}\` has no \`alt\` attribute, so screen readers announce nothing (or read the URL).\n\n\`\`\`html\n${f.snippet}\n\`\`\`\n\n### Fix\nAdd a short \`alt\` describing the image, or \`alt=""\` plus \`aria-hidden="true"\` if it is purely decorative.\n`,
        };
    }
    return { title: `[${sev}] ${f.kind}`, labels: ['autonomous'], body: JSON.stringify(f, null, 2) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Filing
// ─────────────────────────────────────────────────────────────────────────────
export async function fileFindings(findings, { env = process.env, max = MAX_PER_RUN } = {}) {
    // Dedup against everything the scanner has ever filed — open OR closed. A
    // closed issue means it was handled (or declined); re-filing it would put the
    // pipeline in a loop, which is exactly the "churn" failure mode.
    //
    // FAIL CLOSED. If the dedup lookup errors we file NOTHING, because the
    // alternative is re-filing every finding on every run until the queue is
    // unusable. Silence for one cycle is recoverable; a self-spamming bot is the
    // thing that makes you stop trusting the system.
    let known;
    try {
        known = fingerprintsIn(await Q.allIssues({ env }));
    } catch (e) {
        return { filed: [], skipped: findings.length, error: `dedup lookup failed: ${e.message}` };
    }

    const fresh = findings.filter((f) => !known.has(f.fingerprint));
    if (!fresh.length) return { filed: [], skipped: findings.length };

    // Detectors whose findings humans keep rejecting stop filing. They still run
    // and still report locally — the goal is to protect the queue's credibility,
    // not to go blind. See accuracy.mjs for why this is graded on issue outcomes
    // rather than on the scanner's own confidence.
    const ledger = await loadLedger({ env });
    const barred = quarantinedKinds(ledger);
    const allowed = fresh.filter((f) => !barred.has(f.kind));
    const quarantined = fresh.length - allowed.length;

    const filed = [];
    for (const f of allowed.slice(0, max)) {
        const { title, body, labels } = renderIssue(f);
        for (const l of labels) await Q.ensureLabel(l, 'ededed', '', { env }).catch(() => {});
        const issue = await Q.createIssue({
            title,
            // Two stamps: the fingerprint dedupes this exact finding, the
            // detector name lets the ledger grade the check that produced it.
            body: stampDetector(stampBody(body + FOOTER, f.fingerprint), f.kind),
            labels,
            env,
        });
        filed.push({ number: issue?.number, title, kind: f.kind });
    }
    return {
        filed,
        skipped: allowed.length - filed.length,
        quarantined,
        ledger,
    };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const invokedDirectly = (process.argv[1] || '').endsWith('discover.mjs');

if (invokedDirectly) {
    const findings = scan();

    // The browser sweep is additive and optional: --no-ui skips it, and a
    // missing Chromium degrades to "no UI findings" rather than a failed scan.
    if (!process.argv.includes('--no-ui')) {
        findings.push(...await uiFindings());
        findings.sort((a, b) => SEV_RANK[a.severity] - SEV_RANK[b.severity]);
        for (const f of findings) if (!f.fingerprint) f.fingerprint = fingerprint(f.kind, f.key);
    }

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ count: findings.length, findings }, null, 2));
    } else {
        if (!findings.length) {
            console.log('✅ discover: nothing actionable found. The queue stays empty on purpose.');
        } else {
            console.log(`🔎 discover: ${findings.length} verified finding(s)\n`);
            for (const f of findings) {
                console.log(`   [${String(f.severity).toUpperCase().padEnd(8)}] ${f.kind.padEnd(22)} ${f.key}`);
            }
        }
    }

    if (process.argv.includes('--file')) {
        const res = await fileFindings(findings);
        for (const x of res.filed) console.log(`   filed #${x.number}: ${x.title}`);
        console.log(`\n   ${res.filed.length} filed, ${res.skipped} skipped (already known or over the per-run cap).`);
        if (res.quarantined) console.log(`   ${res.quarantined} withheld from quarantined detector(s).`);
        console.log(`\n📊 Detector accuracy\n${formatLedger(res.ledger || [])}`);
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        const md = findings.length
            ? `### 🔎 Autonomous discovery — ${findings.length} verified finding(s)\n\n`
              + '| Severity | Kind | Where |\n|---|---|---|\n'
              + findings.map((f) => `| ${f.severity} | ${f.kind} | \`${f.key}\` |`).join('\n') + '\n'
            : '### ✅ Autonomous discovery — nothing actionable\n\nEvery detector ran and found nothing to file.\n';
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* ignore */ }
    }
}
