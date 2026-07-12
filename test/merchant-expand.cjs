#!/usr/bin/env node
/* =============================================================================
 * WealthFlow — Autonomous Merchant Verification Engine  (registry side)
 * Run by .github/workflows/merchant-sync.yml.
 *
 * WHY THE OLD ONE NEVER UPDATED: it needed an ANTHROPIC_API_KEY GitHub Secret.
 * If that was not set it returned nothing, so merchants.json never grew — and
 * even with it, it asked a model to BRAINSTORM merchant names, which is guessing.
 *
 * NOW:
 *   • It calls YOUR OWN deployed /api/ai (which already holds every AI key in
 *     Vercel). Set the repo variable APP_URL and it works with NO new secret.
 *   • EVERY candidate must be confirmed by TWO independent passes that AGREE,
 *     and both must score >= 0.95. A single model's word is never trusted.
 *   • EVERY run re-verifies + de-duplicates the whole registry and runs a
 *     self-correction AUDIT that finds ambiguous keys (a short key that collides
 *     with a longer one in a DIFFERENT category — the "Softlogic" vs
 *     "Softlogic Life" trap).
 *   • Writes only when something really changed. Never hard-fails the Action.
 * ============================================================================= */
const fs = require('fs');
const path = require('path');

const FILE = process.env.MERCHANTS_FILE || path.join(__dirname, '..', 'merchants.json');
const GATE = 0.95;

const VALID_CATS = { Telecom:1, Insurance:1, Streaming:1, Software:1, Internet:1, Utilities:1, Groceries:1, Dining:1, Health:1, Transport:1, Fuel:1, Education:1, Government:1, Shopping:1, Gold:1, 'Gym/Fitness':1, Leasing:1, 'Bank Charges':1, 'Cash Withdrawal':1, Other:1 };
const SUB = { Telecom:1, Insurance:1, Streaming:1, Internet:1, Utilities:1, Software:1, 'Gym/Fitness':1, Leasing:1 };
const SECTORS = ['Telecom','Insurance','Groceries','Dining','Health','Transport','Fuel','Education','Government','Shopping','Utilities','Software','Streaming','Gold','Gym/Fitness','Leasing','Internet'];

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const validEntry = e => !!(e && typeof e.key === 'string' && norm(e.key).length >= 2 && e.category && VALID_CATS[e.category]);
const goesToFor = e => { const g = e.goesTo; return (g === 'subscription' || g === 'expenses' || g === 'income') ? g : (SUB[e.category] ? 'subscription' : 'expenses'); };
const load = () => { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { schema:'wealthflow.merchants/v2', version:0, merchants:[] }; } };

const SYSTEM = [
'You are the WealthFlow Autonomous Merchant Verification Engine for the Sri Lankan market.',
'List REAL, currently-operating merchants and billers that Sri Lankans actually pay. Never invent a company.',
'Rules:',
'- Telecom = Dialog, Mobitel, Hutch, Airtel, SLT, Lanka Bell (goes_to "subscription").',
'- Insurance = life/general insurers such as Softlogic Life, AIA, Ceylinco, Allianz, Union Assurance, Fairfirst, Janashakthi (goes_to "subscription").',
'- Utilities = CEB, LECO, NWSDB/Water Board, Litro/Laugfs gas.',
'- Supermarkets = Groceries. Restaurants/food = Dining. Pharmacies/hospitals = Health. Fuel sheds = Fuel. Expressway/RDA/ride-hailing = Transport.',
'- Bank charges and fees are NOT merchants. Never propose one.',
'- "key" = a lowercase distinctive signal that really appears in a bank narration (the brand only; no city; no POS id).',
'- confidence 0.00-1.00. Use >= 0.95 ONLY when the company unmistakably exists and the category is beyond doubt.',
'  A low score is CORRECT and safe. A confident wrong answer is a system failure.',
'Reply with ONLY a JSON array, no prose, no markdown fences:',
'[{"key":"...","category":"...","goes_to":"subscription|expenses","confidence":0.00}]'
].join('\n');

async function ask(sector, existing, pass) {
  const APP = (process.env.APP_URL || '').replace(/\/+$/, '');
  const user = [
    'Sector to cover: ' + sector + '.',
    'Allowed category values: ' + Object.keys(VALID_CATS).join(', ') + '.',
    'Already known — do NOT repeat any of these: ' + existing.slice(0, 400).join('; ') + '.',
    'List up to ' + (+process.env.MERCHANT_BATCH || 30) + ' REAL merchants in that sector that are missing.'
  ].join('\n');

  // 1) preferred: the user's OWN deployed endpoint — no new secret required
  if (APP) {
    try {
      const r = await fetch(APP + '/api/ai', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: SYSTEM + '\n\n' + user, temperature: 0, maxTokens: 1800, preferredProvider: pass === 2 ? 'groq' : '' })
      });
      if (r.ok) { const j = await r.json(); return parse(j.reply || j.text || ''); }
      return { list: [], note: 'APP_URL /api/ai HTTP ' + r.status };
    } catch (e) { return { list: [], note: 'APP_URL unreachable: ' + (e && e.message) }; }
  }
  // 2) fallback: a direct Anthropic key, if one happens to be configured
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { list: [], note: 'set the APP_URL repo variable (e.g. https://your-app.vercel.app) to enable growth' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5', max_tokens: 2000, temperature: pass === 2 ? 0.3 : 0, system: SYSTEM, messages: [{ role:'user', content: user }] })
    });
    if (!r.ok) return { list: [], note: 'anthropic HTTP ' + r.status };
    const j = await r.json();
    return parse((j.content || []).filter(b => b.type === 'text').map(b => b.text).join(''));
  } catch (e) { return { list: [], note: 'anthropic error: ' + (e && e.message) }; }
}
function parse(text) {
  const m = String(text || '').match(/\[[\s\S]*\]/);
  if (!m) return { list: [], note: 'no JSON in reply' };
  try { const a = JSON.parse(m[0]); return { list: Array.isArray(a) ? a : [], note: 'ok' }; }
  catch (_) { return { list: [], note: 'JSON parse failed' }; }
}

// SELF-CORRECTION AUDIT: a short key that is contained in a LONGER key of a
// DIFFERENT category is a trap ("softlogic"/Shopping would swallow "Softlogic Life").
function audit(list) {
  const amb = [];
  for (const a of list) for (const b of list) {
    if (a === b || a.category === b.category) continue;
    if (b.key.length > a.key.length && b.key.indexOf(a.key) >= 0) { amb.push({ key: a.key, category: a.category, collidesWith: b.key, other: b.category }); break; }
  }
  return amb;
}

async function run() {
  const doc = load();
  const before = (doc.merchants || []).length;

  // verify + de-duplicate every stored entry
  const map = new Map();
  (doc.merchants || []).forEach(e => { if (!validEntry(e)) return; const k = norm(e.key); if (map.has(k)) return; map.set(k, { key:k, category:e.category, goesTo:goesToFor(e), confidence:(e.confidence != null ? +e.confidence : 1), source:e.source || 'seed' }); });
  const removed = before - map.size;

  // grow — TWO passes must agree, both >= 0.95
  const sector = SECTORS[Math.floor(Date.now() / 36e5) % SECTORS.length];   // rotate hourly
  const keys = [...map.keys()];
  const [a, b] = await Promise.all([ask(sector, keys, 1), ask(sector, keys, 2)]);
  const B = new Map((b.list || []).filter(validEntry2).map(e => [norm(e.key), e]));
  let added = 0, held = 0;
  (a.list || []).forEach(e => {
    if (!validEntry2(e)) return;
    const k = norm(e.key);
    if (map.has(k)) return;
    const peer = B.get(k);
    const conf = Math.min(+e.confidence || 0, peer ? (+peer.confidence || 0) : 0);
    if (!peer || peer.category !== e.category || conf < GATE) { held++; return; }   // no consensus / below gate → NOT written
    map.set(k, { key:k, category:e.category, goesTo:goesToFor({ goesTo: e.goes_to, category: e.category }), confidence:+conf.toFixed(2), source:'ai-consensus' });
    added++;
  });
  function validEntry2(e) { return !!(e && typeof e.key === 'string' && norm(e.key).length >= 2 && e.category && VALID_CATS[e.category]); }

  const merchants = [...map.values()].sort((x, y) => x.category.localeCompare(y.category) || x.key.localeCompare(y.key));
  const amb = audit(merchants);
  const changed = merchants.length !== before || removed > 0 || added > 0;
  if (changed) {
    doc.schema = 'wealthflow.merchants/v2';
    doc.version = (doc.version || 0) + 1;
    doc.updated = new Date().toISOString().slice(0, 10);
    doc.source = 'wealthflow-auto';
    doc.gate = GATE;
    doc.count = merchants.length;
    doc.ambiguous = amb.length;
    doc.merchants = merchants;
    fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
  }
  console.log('[merchant-expand] sector=%s before=%d removed=%d added=%d held=%d ambiguous=%d after=%d changed=%s | %s / %s',
    sector, before, removed, added, held, amb.length, merchants.length, changed, a.note, b.note);
  if (amb.length) amb.slice(0, 5).forEach(x => console.log('  [audit] ambiguous key "%s" (%s) is swallowed by "%s" (%s)', x.key, x.category, x.collidesWith, x.other));
  return { before, removed, added, held, ambiguous: amb.length, after: merchants.length, changed };
}

module.exports = { validEntry, goesToFor, norm, ask, audit, run, VALID_CATS, SUB, GATE };
if (require.main === module) { run().catch(e => { console.error('[merchant-expand] fatal:', e && e.message || e); process.exit(0); }); }
