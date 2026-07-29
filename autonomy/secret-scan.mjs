#!/usr/bin/env node
/* =============================================================================
 * autonomy/secret-scan.mjs — no provider credential ever enters this repo again
 * ---------------------------------------------------------------------------
 * WHY
 *   Four live provider credentials were committed to this repository and served
 *   to every visitor's browser:
 *     • 2 Gemini keys + 1 Groq key in wealthflow-ai-v4.js (loaded by index.html)
 *     • 1 Alpha Vantage key in market-data.js
 *   They sat in git history for months. Nothing in CI looked for them, so
 *   nothing objected.
 *
 *   This scanner is the objection. It runs as a required check, so a key can
 *   never be reintroduced by a human or by the autonomous agent.
 *
 * WHAT IT DOES NOT DO
 *   It does not scan git history — the keys already committed cannot be
 *   un-published by any tool and must be ROTATED at the provider. This prevents
 *   the next one.
 *
 * USAGE
 *   node autonomy/secret-scan.mjs            scan tracked files, exit 1 on a find
 *   node autonomy/secret-scan.mjs --json     machine-readable
 * ===========================================================================*/

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Patterns for credentials that are ALWAYS secret. Deliberately anchored on
 * provider-specific prefixes plus a length floor, so ordinary code and prose
 * cannot trip them.
 */
export const SECRET_PATTERNS = [
    { id: 'groq', label: 'Groq API key', re: /\bgsk_[A-Za-z0-9]{40,}\b/g },
    { id: 'openai', label: 'OpenAI-style key', re: /\bsk-[A-Za-z0-9]{32,}\b/g },
    { id: 'openai-proj', label: 'OpenAI project key', re: /\bsk-proj-[A-Za-z0-9_-]{20,}\b/g },
    { id: 'anthropic', label: 'Anthropic API key', re: /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g },
    { id: 'openrouter', label: 'OpenRouter key', re: /\bsk-or-v1-[a-f0-9]{48,}\b/g },
    { id: 'google', label: 'Google API key', re: /\bAIzaSy[A-Za-z0-9_-]{30,}\b/g },
    { id: 'huggingface', label: 'Hugging Face token', re: /\bhf_[A-Za-z0-9]{30,}\b/g },
    { id: 'together', label: 'Together AI key', re: /\btgp_v1_[A-Za-z0-9_-]{30,}\b/g },
    { id: 'cohere', label: 'Cohere key', re: /\bcohere_[A-Za-z0-9]{30,}\b/g },
    { id: 'nvidia', label: 'NVIDIA NIM key', re: /\bnvapi-[A-Za-z0-9_-]{50,}\b/g },
    { id: 'cerebras', label: 'Cerebras key', re: /\bcsk-[a-z0-9]{40,}\b/g },
    { id: 'tavily', label: 'Tavily key', re: /\btvly-(dev-)?[A-Za-z0-9-]{20,}\b/g },
    { id: 'mindsdb', label: 'MindsDB key', re: /\bmdb_[A-Za-z0-9]{8}\.[A-Za-z0-9]{20,}\b/g },
    { id: 'aws', label: 'AWS access key id', re: /\bAKIA[0-9A-Z]{16}\b/g },
    { id: 'slack', label: 'Slack token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g },
    { id: 'private-key', label: 'Private key block', re: /-----BEGIN (RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/g },
];

/**
 * The single documented exception.
 *
 * A Firebase Web `apiKey` is NOT a secret — it is an public project identifier
 * that the browser SDK requires, and Google documents it as safe to expose.
 * Access is controlled by Firestore/Storage security rules and App Check, not
 * by hiding this string.
 *
 * IMPORTANT: it is only safe while it is restricted. This exact key was also
 * being used against generativelanguage.googleapis.com by the old client vision
 * code, which made a public identifier into a billable credential. That code is
 * gone; keep the key restricted in Google Cloud Console (API restrictions →
 * Firebase services only, and do NOT enable the Generative Language API on it).
 */
export const ALLOWLIST = [
    {
        file: 'index.html',
        patternId: 'google',
        // must appear as the firebaseConfig apiKey, not loose in the file
        requireContext: /apiKey\s*:\s*["'][^"']+["']/,
        reason: 'Firebase Web apiKey — public by design, required by the browser SDK. Restrict it in Google Cloud Console.',
    },
];

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'coverage', '.vercel']);
const SKIP_FILES = new Set(['package-lock.json', 'AUTONOMY.md']);
const SCAN_EXT = /\.(js|mjs|cjs|ts|jsx|tsx|html|json|yml|yaml|env|sh|md|rego)$/i;

/** Files git tracks — never scan build output or dependencies. */
export function trackedFiles(repoDir = process.cwd()) {
    try {
        return execFileSync('git', ['ls-files'], { cwd: repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
            .split('\n')
            .filter(Boolean)
            .filter((f) => SCAN_EXT.test(f))
            .filter((f) => !SKIP_FILES.has(path.basename(f)))
            .filter((f) => !f.split('/').some((seg) => SKIP_DIRS.has(seg)));
    } catch {
        return [];
    }
}

/** Is this finding covered by the documented allowlist? */
export function isAllowed(file, patternId, line) {
    return ALLOWLIST.some((a) =>
        a.file === file
        && a.patternId === patternId
        && (!a.requireContext || a.requireContext.test(line)));
}

/** Mask a secret for safe display — never print the whole thing. */
export function mask(secret) {
    // `String(x)` THROWS on an object with a non-callable toString, e.g.
    // `String({ toString: {} })` → "Cannot convert object to primitive value".
    // The property suite caught this via fc.anything(); it is the same class of
    // crash the fuzz gate found in substantive.cjs::normaliseLine. A display
    // helper must never be the thing that throws.
    let s;
    if (secret == null) s = '';
    else if (typeof secret === 'string') s = secret;
    else { try { s = String(secret); } catch (_) { return '***'; } }
    if (s.length <= 12) return '*'.repeat(s.length);
    return `${s.slice(0, 8)}…${'*'.repeat(6)}… (${s.length} chars)`;
}

/** Scan one file's text. Returns findings. */
export function scanText(file, text) {
    const findings = [];
    const lines = String(text || '').split('\n');
    for (const { id, label, re } of SECRET_PATTERNS) {
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(line)) !== null) {
                if (isAllowed(file, id, line)) continue;
                findings.push({ file, line: i + 1, patternId: id, label, masked: mask(m[0]) });
            }
        }
    }
    return findings;
}

export function scanRepo(repoDir = process.cwd()) {
    const findings = [];
    for (const f of trackedFiles(repoDir)) {
        let text;
        try { text = fs.readFileSync(path.join(repoDir, f), 'utf8'); } catch { continue; }
        findings.push(...scanText(f, text));
    }
    return findings;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
const invokedDirectly = (() => {
    try { return (process.argv[1] || '').endsWith('secret-scan.mjs'); } catch { return false; }
})();

if (invokedDirectly) {
    const findings = scanRepo();

    if (process.argv.includes('--json')) {
        console.log(JSON.stringify({ ok: findings.length === 0, findings }, null, 2));
    } else if (findings.length === 0) {
        console.log('✅ secret-scan: no provider credentials found in tracked files.');
        console.log(`   (${ALLOWLIST.length} documented exception: the public Firebase Web apiKey.)`);
    } else {
        console.error(`❌ secret-scan: ${findings.length} credential(s) found in tracked files.\n`);
        for (const f of findings) {
            console.error(`   ${f.file}:${f.line}  ${f.label}  ${f.masked}`);
        }
        console.error('\n   Move each one to an environment variable.');
        console.error('   A committed key is in git history forever — ROTATE it at the provider;');
        console.error('   deleting the line is not enough.');
    }

    if (process.env.GITHUB_STEP_SUMMARY) {
        const md = findings.length
            ? `### ❌ Secret scan — ${findings.length} credential(s) committed\n\n`
              + '| File | Line | Kind | Value |\n|---|---|---|---|\n'
              + findings.map((f) => `| \`${f.file}\` | ${f.line} | ${f.label} | \`${f.masked}\` |`).join('\n')
              + '\n\nMove each to an environment variable, and **rotate it** — a committed key is in git history forever.\n'
            : '### ✅ Secret scan — clean\n\nNo provider credentials in tracked files.\n';
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n'); } catch { /* ignore */ }
    }

    process.exit(findings.length ? 1 : 0);
}
