/*  consensus-review.mjs  —  Automated Review Board (Blueprint Phase 3)
 *
 *  Replaces the human code review with a multi-model consensus. Independent frontier
 *  models each review the PR diff and vote PASS/FAIL. The PR may only merge if EVERY
 *  configured reviewer votes PASS (Byzantine-style unanimity). Strictly isolated from
 *  ANTHROPIC_API_KEY so the generator never reviews its own code.
 *
 *  Reviewers (each optional; all CONFIGURED ones must pass):
 *    • Architecture : WealthFlow_API_Key (Gemini)
 *    • Security     : DEEPSEEK_API_KEY or XAI_API_KEY
 *  Fails CLOSED: if no reviewer is configured, the merge is blocked (never auto-pass
 *  without review). Run by consensus-review.yml as a required status check.
 *
 *  Exit 0 = unanimous pass (merge allowed) · Exit 1 = blocked.
 */

import { execSync } from 'node:child_process';

export function parseVote(text) {
    const t = String(text || '').trim().toUpperCase();
    // look at the first 200 chars for a clear verdict
    const head = t.slice(0, 200);
    if (/\bFAIL\b/.test(head) && !/\bPASS\b/.test(head)) return 'fail';
    if (/\bPASS\b/.test(head) && !/\bFAIL\b/.test(head)) return 'pass';
    if (/^PASS/.test(t)) return 'pass';
    if (/^FAIL/.test(t)) return 'fail';
    return 'unclear';
}

// merge only if at least one reviewer voted AND all votes are 'pass'
export function tally(votes) {
    const cast = votes.filter(v => v.vote === 'pass' || v.vote === 'fail' || v.vote === 'unclear');
    if (cast.length === 0) return { merge: false, reason: 'no reviewers configured — fail closed' };
    const bad = cast.filter(v => v.vote !== 'pass');
    if (bad.length) return { merge: false, reason: bad.map(b => b.name + ':' + b.vote).join(', ') };
    return { merge: true, reason: 'unanimous pass (' + cast.map(c => c.name).join(', ') + ')' };
}

function getDiff() {
    try {
        const base = process.env.BASE_REF || 'main';
        execSync('git fetch origin ' + base + ' --depth=1', { stdio: 'pipe' });
        return execSync('git diff origin/' + base + '...HEAD', { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 }).slice(0, 60000);
    } catch (_) {
        try { return execSync('git diff HEAD~1...HEAD', { encoding: 'utf8' }).slice(0, 60000); } catch (_) { return ''; }
    }
}

function reviewPrompt(role, diff) {
    return [
        'You are a strict senior ' + role + ' reviewer for a personal-finance app.',
        'Review this pull request diff. Reply with EXACTLY one word on the first line: PASS or FAIL.',
        'Then one short sentence why. FAIL if you see security issues, data-leak risk, money-math',
        'errors, missing tests for new logic, or anything that could harm users.',
        '',
        'DIFF:',
        diff || '(empty diff)'
    ].join('\n');
}

async function gemini(key, prompt) {
    const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=' + key;
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (!r.ok) throw new Error('gemini ' + r.status);
    const d = await r.json();
    return d?.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

async function openaiCompatible(base, key, model, prompt) {
    const r = await fetch(base, { method: 'POST', headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], temperature: 0 }) });
    if (!r.ok) throw new Error('review ' + r.status);
    const d = await r.json();
    return d?.choices?.[0]?.message?.content || '';
}

async function main() {
    const diff = getDiff();
    if (!diff.trim()) { console.log('Empty diff — nothing to review, blocking by default.'); process.exit(1); }
    const votes = [];

    // Architecture reviewer — Gemini
    if (process.env.WealthFlow_API_Key) {
        try { votes.push({ name: 'gemini-arch', vote: parseVote(await gemini(process.env.WealthFlow_API_Key, reviewPrompt('software architecture', diff))) }); }
        catch (e) { votes.push({ name: 'gemini-arch', vote: 'unclear' }); console.error(e.message); }
    }
    // Security reviewer — DeepSeek, else xAI
    if (process.env.DEEPSEEK_API_KEY) {
        try { votes.push({ name: 'deepseek-sec', vote: parseVote(await openaiCompatible('https://api.deepseek.com/chat/completions', process.env.DEEPSEEK_API_KEY, 'deepseek-chat', reviewPrompt('application security', diff))) }); }
        catch (e) { votes.push({ name: 'deepseek-sec', vote: 'unclear' }); console.error(e.message); }
    } else if (process.env.XAI_API_KEY) {
        try { votes.push({ name: 'xai-sec', vote: parseVote(await openaiCompatible('https://api.x.ai/v1/chat/completions', process.env.XAI_API_KEY, 'grok-2-latest', reviewPrompt('application security', diff))) }); }
        catch (e) { votes.push({ name: 'xai-sec', vote: 'unclear' }); console.error(e.message); }
    }

    const result = tally(votes);
    console.log('Votes:', JSON.stringify(votes));
    console.log('Decision:', result.merge ? 'PASS' : 'BLOCK', '—', result.reason);
    process.exit(result.merge ? 0 : 1);
}

const isMain = (() => { try { return import.meta.url.endsWith(process.argv[1].split('/').pop()); } catch (_) { return false; } })();
if (isMain) main().catch(e => { console.error('consensus error:', e.message); process.exit(1); });
