/* =============================================================================
 * wf-screenshot-reader.mjs — let the fix agent SEE the user's screenshot
 * ---------------------------------------------------------------------------
 * THE DEFECT THIS CLOSES (seen on issue #514, 2026-11-04)
 *   The app attaches a screenshot to a report and feedback-triage.js writes it
 *   into the GitHub issue between `<!-- wf-feedback-image -->` and a code fence.
 *   Nothing ever read that block. The comment said "the fix agent looks for
 *   this marker"; no code did. So an overlap bug that only a picture shows was
 *   handed to a text-only model as a sentence, and the 40,000 characters of
 *   base64 went into every prompt as noise.
 *
 * WHAT THIS DOES
 *   1. finds the screenshot in the issue body and takes it OUT of the text the
 *      other agents read (it is not text);
 *   2. asks the first vision-capable provider that has a key to describe what
 *      is visible: which screen, what looks wrong, the exact words nearby;
 *   3. puts that description back into the issue text, labelled as a machine
 *      reading, so the author knows where to look and does not trust it blindly.
 *
 * HONESTY
 *   A vision model can misread an image. The block it adds says so, and says
 *   which provider read it. If no provider can read the image, the block says
 *   that instead of pretending the screenshot was seen.
 *
 * Zero dependencies (global fetch). The caller may inject `fetchImpl`.
 * ===========================================================================*/

import { PROVIDERS, keyFor } from './wf-llm-router.mjs';
import { choose, loadModels, isModelGone } from './ai-models.mjs';
import nodeFs from 'node:fs';

export const IMAGE_MARKER = 'wf-feedback-image';
/** Written into the issue when the screenshot was already read at filing time (feedback-triage.js). */
export const READING_MARKER = 'wf-screenshot-reading';
export const MAX_READING_IMAGES = 3;
/** One reading image, as a data URL. A phone screenshot at 1568px is ~300-900 KB. */
export const MAX_READING_CHARS = 1_100_000;

const MARKER_BLOCK = new RegExp(
    '<!--\\s*' + IMAGE_MARKER + '\\s*-->\\s*<details>[\\s\\S]*?</details>', 'i');
const DATA_URL = /data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}/;

const VISION_TIMEOUT_MS = 45_000;
const MAX_DESCRIPTION = 3200;

/** Vision-capable models per provider, tried in order. Overridable by env. */
export function visionModels(providerId, env = process.env) {
    const pick = (v, list) => [v, ...list].filter(Boolean);
    if (providerId === 'groq') return pick(env.GROQ_VISION_MODEL, ['meta-llama/llama-4-scout-17b-16e-instruct', 'llama-3.2-90b-vision-preview']);
    if (providerId === 'mistral') return pick(env.MISTRAL_VISION_MODEL, ['mistral-small-latest', 'pixtral-large-latest']);
    if (providerId === 'openrouter') return pick(env.OPENROUTER_VISION_MODEL, ['meta-llama/llama-3.2-11b-vision-instruct:free']);
    // GitHub Models reads images with no key of the owner's: inside GitHub Actions the run's own GITHUB_TOKEN works when the workflow
    // grants `models: read`. It is the one vision route that does not depend on a free-tier quota the owner has to keep alive.
    if (providerId === 'github-models') return pick(env.GITHUB_MODELS_VISION_MODEL, ['openai/gpt-4.1', 'openai/gpt-4o', 'meta/Llama-3.2-90B-Vision-Instruct', 'openai/gpt-4o-mini']);
    if (providerId === 'together') return pick(env.TOGETHER_VISION_MODEL, ['meta-llama/Llama-Vision-Free']);
    if (providerId === 'nvidia') return pick(env.NVIDIA_VISION_MODEL, ['meta/llama-3.2-90b-vision-instruct', 'meta/llama-3.2-11b-vision-instruct']);
    return [];
}

/** The screenshot's data URL from an issue body, or ''. */
export function extractScreenshot(body) {
    const block = String(body || '').match(MARKER_BLOCK);
    if (!block) return '';
    const m = block[0].match(DATA_URL);
    return m ? m[0] : '';
}

/** The issue text with the base64 block removed (it is not text and floods prompts). */
export function withoutScreenshot(body) {
    return String(body || '').replace(MARKER_BLOCK, '_(Screenshot data removed from this text; see "What the screenshot shows" below.)_');
}

export function visionPrompt({ title = '', text = '', viewport = '' } = {}) {
    return [
        'You are the eyes of an autonomous developer. A user attached this screenshot to a bug report about a personal-finance web app (WealthFlow).',
        'Report title: ' + String(title).slice(0, 200),
        'The user wrote: ' + String(text).slice(0, 800),
        viewport ? 'The device that sent it: ' + viewport : '',
        '',
        'Work in this order and write every section. Describe ONLY what is visible; never invent code, text or numbers you cannot read.',
        'TRANSCRIPT: every piece of readable text and number, top to bottom, one per line, spelled exactly as drawn (including cut-off words, marked with "…").',
        'SCREEN: which page or section this is (use the words on screen), and whether it is a phone or a desktop layout.',
        'LAYOUT: what is where. Name each box or row and say what sits left, right, above and below it; say which element is the widest and which is squeezed.',
        'PROBLEM: what looks wrong, concretely. Say which elements collide, are clipped, wrap one word per line, or are missing, and by how much (a few pixels, a third of the width). If nothing looks wrong, say so.',
        'LIKELY CAUSE: in layout terms only (a narrow column, a value that cannot shrink, text that cannot wrap, a fixed width). One or two sentences, marked as a guess.',
        'CONFIDENCE: high, medium or low, and one sentence why. If the image is blank, unreadable or unrelated, say so plainly.',
        'Keep it under 350 words.',
    ].filter((x) => x !== '').join('\n');
}

/** A second reader checks the first one's reading against the same picture. */
export function verifyPrompt({ reading = '', title = '', text = '' } = {}) {
    return [
        'You are a careful second reader. Below is a reading of the attached screenshot written by another model. It can be wrong.',
        'Report title: ' + String(title).slice(0, 200),
        'The user wrote: ' + String(text).slice(0, 500),
        '',
        '--- READING ---',
        String(reading).slice(0, 2600),
        '--- END READING ---',
        '',
        'Look at the picture again and check every claim in the reading against it: each word and number in TRANSCRIPT, the SCREEN, who is next to whom in LAYOUT, and the PROBLEM.',
        'Answer in exactly one of two forms.',
        'If every claim is right and nothing important is missing, answer one line: CONFIRMED.',
        'Otherwise answer CORRECTIONS: followed by short bullets: what is wrong or missing, and what the picture really shows. Do not repeat what is right.',
    ].join('\n');
}

async function postJson(fetchImpl, url, headers, body) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), VISION_TIMEOUT_MS);
    if (typeof t.unref === 'function') t.unref();
    try {
        const r = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctl.signal });
        let data = null;
        let raw = '';
        if (typeof r.text === 'function') { try { raw = await r.text(); data = JSON.parse(raw); } catch { /* not json: `raw` still says what came back */ } }
        else { try { data = await r.json(); } catch { /* not json */ } }
        return { ok: r.ok, status: r.status, data, raw: String(raw || '').replace(/\s+/g, ' ').slice(0, 100) };
    } finally { clearTimeout(t); }
}

async function askOpenAiStyle(provider, key, model, dataUrl, prompt, fetchImpl) {
    // GitHub's endpoint wants its own Accept and API-version headers (api/ai.js sends them); without them the probe on 2026-11-07
    // got HTTP 200 and no answer from all four models.
    const extra = provider.id === 'github-models' ? { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } : {};
    const r = await postJson(fetchImpl, provider.url, { Authorization: 'Bearer ' + key, ...extra }, {
        model, temperature: 0.2, max_tokens: 900,
        messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    });
    const text = r.data && r.data.choices && r.data.choices[0] && r.data.choices[0].message && r.data.choices[0].message.content;
    const has = typeof text === 'string' && text.trim().length > 0;
    // A 200 that carries no answer must say what it carried, or "HTTP 200" reads like success in the log.
    const err = r.ok ? (has ? '' : `no answer in the body: ${r.raw || '(empty)'}`)
        : String((r.data && (r.data.error && (r.data.error.message || r.data.error) || r.data.message)) || '').slice(0, 200);
    return { ok: r.ok && has, status: r.status, text: String(text || '').trim(), err };
}

async function askGemini(key, dataUrl, prompt, fetchImpl, env, forModel = '') {
    const m = dataUrl.match(/^data:(image\/[a-z+.-]+);base64,(.*)$/i);
    const model = forModel || env.GEMINI_VISION_MODEL || env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await postJson(fetchImpl,
        'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent?key=' + encodeURIComponent(key), {},
        { contents: [{ role: 'user', parts: [{ text: prompt }, { inline_data: { mime_type: m[1], data: m[2] } }] }], generationConfig: { temperature: 0.2, maxOutputTokens: 900 } });
    const parts = r.data && r.data.candidates && r.data.candidates[0] && r.data.candidates[0].content && r.data.candidates[0].content.parts;
    const text = Array.isArray(parts) ? parts.map((p) => p.text || '').join('').trim() : '';
    return { ok: r.ok && text.length > 0, status: r.status, text, model };
}

/**
 * Ask each provider that has a key and a vision model, in order, until one reads the image.
 * @returns {{ ok:boolean, text?:string, provider?:string, model?:string, tried:string[] }}
 */
const HEAL_NAME = { groq: 'Groq', mistral: 'Mistral', openrouter: 'OpenRouter', together: 'Together', nvidia: 'NVIDIA', gemini: 'Gemini', 'github-models': 'GitHubModels' };

/** A provider's credential for READING a picture. Inside GitHub Actions the run's own token is a GitHub Models credential when the workflow grants `models: read`. */
export function visionKey(id, provider, env = process.env) {
    const k = provider && keyFor(provider, env);
    if (k) return k;
    if (id === 'github-models' && env.GITHUB_ACTIONS === 'true' && env.GITHUB_TOKEN && String(env.GITHUB_TOKEN).trim()) return { name: 'GITHUB_TOKEN', value: String(env.GITHUB_TOKEN).trim() };
    return null;
}

/**
 * A provider that retires a vision model is not a provider that cannot read a picture. On #524 every vision model named here was gone
 * (Groq 404 and 400, OpenRouter 404) and the screenshot was never read, so the fix agent worked blind. Ask the provider what it serves
 * NOW (its own /models list, same key), choose a vision model by rule, and try it once. Never throws.
 */
async function liveVisionModel(id, provider, key, fetchImpl, exclude) {
    try {
        const kind = id === 'gemini' ? 'gemini' : 'openai';
        const url = id === 'gemini' ? 'https://generativelanguage.googleapis.com/v1beta/models' : String(provider.url || '').replace(/\/chat\/completions$/, '/models');
        if (!url) return '';
        const fetcher = (u, init, ms) => fetchImpl(u, { ...init, signal: AbortSignal.timeout(ms) });
        const models = await loadModels({ kind, url, key, fetcher });
        return choose({ provider: HEAL_NAME[id] || id, vision: true, models, exclude });
    } catch (_) { return ''; }
}

const VISION_ORDER = ['github-models', 'gemini', 'mistral', 'groq', 'nvidia', 'openrouter', 'together'];

/**
 * Ask each provider that has a key and a vision model, in order, until one answers `prompt` about the image.
 * @returns {{ ok:boolean, text?:string, provider?:string, model?:string, tried:string[] }}
 */
async function readWithProviders({ dataUrl, prompt, order, env, fetchImpl, log }) {
    const tried = [];
    const ask = (id, provider, k, model) => (id === 'gemini'
        ? askGemini(k.value, dataUrl, prompt, fetchImpl, env, model || '')
        : askOpenAiStyle(provider, k.value, model, dataUrl, prompt, fetchImpl));
    for (const id of order) {
        const provider = PROVIDERS.find((p) => p.id === id);
        const k = provider && visionKey(id, provider, env);
        if (!k) continue;
        const models = id === 'gemini' ? [null] : visionModels(id, env);
        const failedIds = [];
        let healable = false;      // a model of this provider was refused as gone, or its quota ran out on a model that has company
        for (const model of models) {
            try {
                const r = await ask(id, provider, k, model);
                const used = r.model || model || id;
                if (r.ok) return { ok: true, text: r.text.slice(0, MAX_DESCRIPTION), provider: id, model: used, tried };
                tried.push(`${id}/${used}: HTTP ${r.status}${r.err ? ' ' + r.err.slice(0, 60) : ''}`);
                failedIds.push(used);
                if (isModelGone(r.status, r.err)) { healable = true; continue; }
                if (id === 'gemini' && r.status === 429) { healable = true; break; }     // Gemini's quota is per model
                if (r.status === 401 || r.status === 403 || r.status === 429 || r.status === 402) break; // same key, same answer
            } catch (e) {
                tried.push(`${id}/${model || 'default'}: ${String((e && e.message) || e).slice(0, 80)}`);
                break;
            }
        }
        if (!healable) continue;
        const live = await liveVisionModel(id, provider, k.value, fetchImpl, failedIds);
        if (!live) continue;
        try {
            const r = await ask(id, provider, k, live);
            if (r.ok) { log(`[screenshot] ${id}: the named vision models were gone; read it with ${live} from the provider's own list`); return { ok: true, text: r.text.slice(0, MAX_DESCRIPTION), provider: id, model: r.model || live, tried }; }
            tried.push(`${id}/${live} (from its list): HTTP ${r.status}`);
        } catch (e) { tried.push(`${id}/${live}: ${String((e && e.message) || e).slice(0, 80)}`); }
    }
    return { ok: false, tried };
}

/**
 * Read the picture, then have a DIFFERENT provider check that reading against the same picture. One reader can be confidently
 * wrong (the accuracy complaint on #524); two that disagree say so in the text, and the fix agent is told what was corrected.
 * With only one reader available the reading stands alone and says it was not cross-checked.
 * @returns {{ ok:boolean, text?:string, provider?:string, model?:string, tried:string[], checked?:'confirmed'|'corrected'|'alone', checker?:string }}
 */
export async function describeScreenshot({ dataUrl, title, text, viewport = '', verify = true, env = process.env, fetchImpl = globalThis.fetch, log = () => {} } = {}) {
    if (!dataUrl) return { ok: false, tried: [] };
    const first = await readWithProviders({ dataUrl, prompt: visionPrompt({ title, text, viewport }), order: VISION_ORDER, env, fetchImpl, log });
    if (!first.ok) {
        log(`[screenshot] no provider read the image (${first.tried.join('; ') || 'no vision-capable key'})`);
        return first;
    }
    if (!verify) return { ...first, checked: 'alone' };
    const others = VISION_ORDER.filter((id) => id !== first.provider);
    const second = await readWithProviders({ dataUrl, prompt: verifyPrompt({ reading: first.text, title, text }), order: others, env, fetchImpl, log }).catch(() => ({ ok: false, tried: [] }));
    if (!second.ok) return { ...first, checked: 'alone', tried: [...first.tried, ...second.tried] };
    const answer = second.text.trim();
    const checker = `${second.provider}/${second.model}`;
    if (/^\W*confirmed\b/i.test(answer) && answer.length < 200) {
        return { ...first, checked: 'confirmed', checker, tried: first.tried };
    }
    const corrections = answer.replace(/^\W*corrections\s*:?/i, '').trim();
    return {
        ...first, checked: 'corrected', checker, tried: first.tried,
        text: (first.text + `\n\nSECOND READER (${checker}) CORRECTS THE READING ABOVE — where they differ, trust these corrections:\n` + corrections).slice(0, MAX_DESCRIPTION + 1400),
    };
}

const READING_URL = /^data:image\/(?:png|jpe?g|webp);base64,[A-Za-z0-9+/]+={0,2}$/;

/** Only real raster data URLs, at most three, none over the size cap. */
export function validReadingImages(list) {
    if (!Array.isArray(list)) return [];
    return list.filter((x) => typeof x === 'string' && x.length <= MAX_READING_CHARS && READING_URL.test(x)).slice(0, MAX_READING_IMAGES);
}

/**
 * Read every reading image (a tall screenshot arrives as up to three tiles) and write one section for the issue.
 * WHY HERE AND NOT ONLY IN THE AGENT: the issue body holds ~44 KB of image, so the agent only ever saw a thumbnail.
 * The server receives the full-quality rendition when the report is filed, reads that, and puts WORDS in the issue.
 * @returns {Promise<{ status:'none'|'read'|'unreadable', section:string, provider?:string }>}
 */
export async function readAttachments({ images, title = '', text = '', env = process.env, fetchImpl = globalThis.fetch, describeImpl = describeScreenshot, log = () => {} } = {}) {
    const list = validReadingImages(images);
    if (!list.length) return { status: 'none', section: '' };
    const parts = await Promise.all(list.map((dataUrl, i) => describeImpl({
        dataUrl, title, env, fetchImpl, log, verify: false,
        text: (list.length > 1 ? `[This is part ${i + 1} of ${list.length} of ONE tall or wide screenshot, cut top to bottom (or left to right) with a small overlap.] ` : '') + String(text).slice(0, 1000),
    }).catch((e) => ({ ok: false, tried: [String((e && e.message) || e).slice(0, 80)] }))));
    const read = parts.map((p, i) => ({ p, i })).filter((x) => x.p && x.p.ok);
    if (!read.length) {
        const tried = [...new Set(parts.flatMap((p) => (p && p.tried) || []))].slice(0, 4);
        return { status: 'unreadable', section: '' , tried };
    }
    const who = [...new Set(read.map((x) => `${x.p.provider}/${x.p.model}`))].join(', ');
    const body = read.map(({ p, i }) => (list.length > 1 ? `**Part ${i + 1} of ${list.length}**\n` : '') + p.text).join('\n\n');
    const missing = list.length - read.length;
    return {
        status: 'read', provider: read[0].p.provider,
        section: [
            '### What the AI saw in the screenshot', '',
            `<!-- ${READING_MARKER} -->`,
            `_Read from the full-quality screenshot when the report was filed, by a vision model (${who}). It is a machine reading and can be wrong: use it to decide where to look, and trust the code over it._` +
                (missing ? ` _(${missing} of ${list.length} parts could not be read.)_` : ''),
            '', body.slice(0, 7000), '',
        ].join('\n'),
    };
}

/** The device facts the app wrote into the report's "System diagnosis" table, as one line a reader can use to judge what it sees. */
export function viewportOf(body) {
    const row = (name) => { const m = String(body || '').match(new RegExp('\\|\\s*' + name + '\\s*\\|\\s*([^|\\n]+?)\\s*\\|')); return m ? m[1].trim() : ''; };
    const vp = row('Viewport'), dpr = row('DPR'), ua = row('Device');
    if (!vp && !ua) return '';
    const kind = /iPhone|Android.*Mobile|Mobile/i.test(ua) ? 'a phone' : /iPad|Tablet/i.test(ua) ? 'a tablet' : ua ? 'a computer' : 'a device';
    return `${kind}${vp ? ', screen ' + vp + ' CSS pixels' : ''}${dpr ? ' at ' + dpr + 'x' : ''}. The screenshot may be a crop of that screen.`;
}

const SECTION_END = '(?:\\n\\s*\\**\\s*(?:SCREEN|LAYOUT|PROBLEM|LIKELY CAUSE|CONFIDENCE|TEXT|TRANSCRIPT)\\b|$)';

/** The words the reader says it saw: one per line of its TRANSCRIPT (or the older TEXT) section. */
export function transcriptPhrases(reading) {
    const t = String(reading || '');
    const m = t.match(new RegExp('\\**\\s*TRANSCRIPT\\s*\\**\\s*:?\\**([\\s\\S]*?)' + SECTION_END, 'i')) || t.match(new RegExp('\\**\\s*TEXT\\s*\\**\\s*:?\\**([\\s\\S]*?)' + SECTION_END, 'i'));
    if (!m) return [];
    const out = [];
    for (const raw of m[1].split(/\n|\s\|\s|;/)) {
        const line = raw.replace(/^[\s\-*•·\d.)]+/, '').replace(/^["'“‘`]+|["'”’`]+$/g, '').replace(/\s+/g, ' ').trim();
        if (line.length < 6 || line.length > 70 || !/[A-Za-z඀-෿]{3}/.test(line)) continue;
        if (line.replace(/\b(?:LKR|Rs|USD)\b\.?/gi, '').replace(/[\d.,\s%+\-/:]/g, '').length < 3) continue;     // an amount or a date names no screen
        if (!out.some((x) => x.toLowerCase() === line.toLowerCase())) out.push(line);
        if (out.length >= 14) break;
    }
    return out;
}

/**
 * Check what the reader says it saw against the app's own text. A program does this, not a model: a phrase that is in index.html
 * (or a client script) names the screen and the line to edit; a phrase that is nowhere was misread, is a number or was cut off.
 */
export function groundReading(reading, repoDir, { fs = null } = {}) {
    const phrases = transcriptPhrases(reading);
    if (!phrases.length) return { found: [], missing: [], section: '' };
    let files = [];
    try {
        const f = fs || nodeFs;
        files = f.readdirSync(repoDir).filter((n) => n === 'index.html' || /^(wealthflow|wf)-[\w.-]+\.js$/.test(n)).map((n) => {
            try { const txt = f.readFileSync(repoDir + '/' + n, 'utf8'); return txt.length < 4_000_000 ? { n, txt, low: txt.toLowerCase() } : null; } catch { return null; }
        }).filter(Boolean);
    } catch { return { found: [], missing: phrases, section: '' }; }
    const found = [], missing = [];
    for (const ph of phrases) {
        const needle = ph.toLowerCase();
        let where = '';
        for (const f of files) {
            const at = f.low.indexOf(needle);
            if (at >= 0) { where = `${f.n}:${f.txt.slice(0, at).split('\n').length}`; break; }
        }
        (where ? found : missing).push(where ? { phrase: ph, where } : ph);
    }
    const lines = [];
    if (found.length) lines.push('### Where the words in the screenshot appear in the code', '', '_Looked up by a program in the repository, not by a model: these lines draw the text the screenshot shows._', '', ...found.map((x) => `- "${x.phrase}" → \`${x.where}\``));
    if (missing.length) lines.push('', `_Not found in the code (misread, a number, cut off in the picture or built at run time): ${missing.map((x) => '"' + x + '"').join(', ')}._`);
    return { found, missing, section: lines.length ? '\n\n' + lines.join('\n') + '\n' : '' };
}

/** The reading section a report already carries (read at filing time), or ''. */
function readingInBody(body) {
    const m = String(body || '').match(/### What the AI saw in the screenshot[\s\S]*?(?=\n### |\n_Filed automatically|$)/);
    return m ? m[0] : '';
}

/**
 * The one call the agent makes. Returns the issue body to give the other agents
 * and a one-line `note` for the attempt comment.
 * @returns {Promise<{ body:string, status:'none'|'read'|'unreadable'|'oversize', note:string, provider?:string }>}
 */
export async function screenshotContext({ issue, env = process.env, fetchImpl, repoDir = process.cwd(), log = () => {} } = {}) {
    const body = String((issue && issue.body) || '');
    const dataUrl = extractScreenshot(body);
    const hasReading = new RegExp('<!--\\s*' + READING_MARKER + '\\s*-->').test(body);
    const viewport = viewportOf(body);
    const ground = (text) => { try { return groundReading(text, repoDir).section; } catch { return ''; } };
    if (!dataUrl && hasReading) return { body: body + ground(readingInBody(body)), status: 'read', provider: 'filing', note: 'The screenshot was already read when the report was filed (see "What the AI saw in the screenshot").' };
    if (!dataUrl) {
        const oversize = /A screenshot was attached \(~\d+ KB\) but exceeds/.test(body);
        return {
            body, status: oversize ? 'oversize' : 'none',
            note: oversize ? 'A screenshot was attached but was too large to embed in the issue, so it could not be read.' : '',
        };
    }
    const stripped = withoutScreenshot(body);
    // Already read at filing time from the full-quality image: that reading is better than a second one of the thumbnail.
    // It was written by ONE reader, so a second one checks it against the thumbnail here, where there is no deadline.
    if (hasReading) {
        const reading = readingInBody(stripped);
        let extra = '';
        let note = 'The screenshot was already read when the report was filed (see "What the AI saw in the screenshot").';
        try {
            const v = await readWithProviders({ dataUrl, prompt: verifyPrompt({ reading, title: issue && issue.title, text: stripped.slice(0, 500) }), order: VISION_ORDER, env, fetchImpl: fetchImpl || globalThis.fetch, log });
            if (v.ok) {
                const answer = v.text.trim();
                if (/^\W*confirmed\b/i.test(answer) && answer.length < 200) note += ` Cross-checked by ${v.provider}/${v.model}: confirmed.`;
                else { extra = `\n\n### Second reader's corrections to the reading above\n_${v.provider}/${v.model} checked the reading against the screenshot and disagrees; where they differ, trust these._\n\n` + answer.replace(/^\W*corrections\s*:?/i, '').trim().slice(0, 2400) + '\n'; note += ` Cross-checked by ${v.provider}/${v.model}: corrected.`; }
            }
        } catch (_) { /* the filing reading stands */ }
        return { body: stripped + extra + ground(reading + extra), status: 'read', provider: 'filing', note };
    }
    const r = await describeScreenshot({ dataUrl, title: issue && issue.title, text: stripped.slice(0, 1200), viewport, env, fetchImpl, log });
    if (r.ok) {
        const how = r.checked === 'confirmed' ? ` Cross-checked by ${r.checker}: confirmed.` : r.checked === 'corrected' ? ` Cross-checked by ${r.checker}, which corrected it.` : ' Not cross-checked (only one vision reader was available).';
        return {
            body: stripped + '\n\n### What the screenshot shows\n' +
                `_Read from the user's screenshot by a vision model (${r.provider}/${r.model}).${how} It is a machine reading and can be wrong: use it to decide where to look, and trust the code over it._\n\n` + r.text + '\n' + ground(r.text),
            status: 'read', provider: r.provider,
            // Readers that were asked first and failed: the only way to tell a quiet provider (no key, quota) from a broken one.
            note: `Screenshot read by ${r.provider}/${r.model}.${how}` + (r.tried && r.tried.length ? ` Tried first and failed: ${r.tried.slice(0, 4).join('; ')}.` : ''),
        };
    }
    return {
        body: stripped + '\n\n### What the screenshot shows\n_A screenshot is attached but no vision model could read it' +
            (r.tried.length ? ` (tried ${r.tried.join('; ')})` : ' (no vision-capable provider key is configured)') + '. Work from the written report only._\n',
        status: 'unreadable',
        note: 'A screenshot is attached but no vision model could read it' + (r.tried.length ? ` (${r.tried.join('; ')})` : ' (no vision-capable key configured)') + '.',
    };
}
