#!/usr/bin/env node
/* =============================================================================
 * WealthFlow — merchant list auto-expander + verifier
 * Run by .github/workflows/merchant-sync.yml on a schedule.
 *
 *  EVERY run (no key needed): verifies + dedupes + normalises + sorts the list.
 *  IF ANTHROPIC_API_KEY is set: asks Claude for NEW real Sri-Lankan/global
 *    merchants, VERIFIES each proposed entry against the taxonomy, merges only
 *    the valid, non-duplicate ones.
 *  Writes merchants.json ONLY when something actually changed (no noisy commits).
 *  Zero npm deps (Node 20 global fetch). Never hard-fails the Action.
 * ============================================================================= */
const fs = require('fs');
const path = require('path');

const FILE = process.env.MERCHANTS_FILE || path.join(__dirname, '..', 'merchants.json');

// the ONLY categories a stored/AI entry may claim (self-verification gate)
const VALID_CATS = { Telecom:1, Insurance:1, Streaming:1, Software:1, Internet:1, Utilities:1, Groceries:1, Dining:1, Health:1, Transport:1, Fuel:1, Education:1, Government:1, Shopping:1, Gold:1, 'Gym/Fitness':1, Leasing:1, 'Bank Charges':1, 'Cash Withdrawal':1, Other:1 };
const SUB = { Telecom:1, Insurance:1, Streaming:1, Internet:1, Utilities:1, Software:1, 'Gym/Fitness':1, Leasing:1 };

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const validEntry = e => !!(e && typeof e.key === 'string' && norm(e.key).length >= 2 && e.category && VALID_CATS[e.category]);
const goesToFor = e => { const g = e.goesTo; return (g === 'subscription' || g === 'expenses' || g === 'income') ? g : (SUB[e.category] ? 'subscription' : 'expenses'); };

function load() { try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (_) { return { schema: 'wealthflow.merchants/v1', version: 0, merchants: [] }; } }

const SYSTEM = [
'You are the WealthFlow Master Merchant Analyst for the Sri Lankan market.',
'Propose REAL, currently-operating merchants/billers that Sri Lankans pay, for a transaction-classification database.',
'Rules:',
'- Sri Lankan merchants are the priority; also include global services Sri Lankans commonly pay (streaming, software, cloud).',
'- Telecom (Dialog, Mobitel, Hutch, Airtel, SLT, or mobile prefixes 077/071/070/078/076/075/074) => category "Telecom", goesTo "subscription".',
'- Life/general insurers (Softlogic Life, AIA, Ceylinco, Allianz, Union Assurance, Fairfirst, Janashakthi...) => "Insurance", "subscription".',
'- Utilities (CEB, LECO, Water Board/NWSDB, Litro/Laugfs gas) => "Utilities", "expenses".',
'- Supermarkets => "Groceries"; restaurants/food => "Dining"; pharmacies/hospitals => "Health"; fuel sheds => "Fuel"; expressway/RDA/ride-hailing => "Transport".',
'- Bank charges/fees are NOT merchants — never propose them.',
'- Use EXACTLY one category from the list you are given. Never invent a category.',
'- "key" must be a lowercase, distinctive merchant signal that appears in a bank narration (brand name; no city; no POS id); 2+ chars.',
'Output ONLY a strict JSON array. No prose, no markdown fences.'
].join('\n');

async function aiExpand(existingKeys) {
  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { added: [], note: 'no ANTHROPIC_API_KEY — verification-only run' };
  if (typeof fetch !== 'function') return { added: [], note: 'no global fetch (need Node 18+)' };
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5';
  const wanted = Math.max(10, Math.min(60, +(process.env.MERCHANT_BATCH || 40)));
  const sample = existingKeys.slice(0, 500);
  const user = [
    'Categories (choose EXACTLY one per merchant): ' + Object.keys(VALID_CATS).join(', ') + '.',
    'Subscription categories (these get goesTo="subscription"): ' + Object.keys(SUB).join(', ') + '.',
    'Do NOT repeat any of these existing keys (partial list of ' + existingKeys.length + '): ' + sample.join('; ') + '.',
    'Return a STRICT JSON array of ' + wanted + ' NEW merchants not already listed, each exactly {"key":"...","category":"...","goesTo":"subscription"|"expenses"}.'
  ].join('\n');
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 2500, system: SYSTEM, messages: [{ role: 'user', content: user }] })
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); return { added: [], note: 'AI HTTP ' + r.status + ': ' + t.slice(0, 180) }; }
    const j = await r.json();
    const text = (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const m = text.match(/\[[\s\S]*\]/);
    let arr = []; try { arr = m ? JSON.parse(m[0]) : []; } catch (e) { return { added: [], note: 'AI JSON parse failed' }; }
    return { added: Array.isArray(arr) ? arr : [], note: 'AI proposed ' + (Array.isArray(arr) ? arr.length : 0) + ' (model ' + model + ')' };
  } catch (e) { return { added: [], note: 'AI error: ' + (e && e.message || e) }; }
}

async function run() {
  const doc = load();
  const before = (doc.merchants || []).length;
  // self-verification: keep only valid, unique (normalised) entries
  const map = new Map();
  (doc.merchants || []).forEach(e => { if (!validEntry(e)) return; const k = norm(e.key); if (map.has(k)) return; map.set(k, { key: k, category: e.category, goesTo: goesToFor(e) }); });
  const removed = before - map.size;
  // AI expansion — each proposed entry re-verified before it is trusted
  let added = 0;
  const res = await aiExpand([...map.keys()]);
  (res.added || []).forEach(e => { if (!validEntry(e)) return; const k = norm(e.key); if (map.has(k)) return; map.set(k, { key: k, category: e.category, goesTo: goesToFor(e) }); added++; });
  // write ONLY if something actually changed
  const merchants = [...map.values()].sort((a, b) => a.category.localeCompare(b.category) || a.key.localeCompare(b.key));
  const changed = (merchants.length !== before) || removed > 0 || added > 0;
  if (changed) {
    doc.schema = doc.schema || 'wealthflow.merchants/v1';
    doc.version = (doc.version || 0) + 1;
    doc.updated = new Date().toISOString().slice(0, 10);
    doc.source = 'wealthflow-auto';
    doc.count = merchants.length;
    doc.merchants = merchants;
    fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
  }
  console.log('[merchant-expand] before=%d removed=%d added=%d after=%d changed=%s | %s', before, removed, added, merchants.length, changed, res.note);
  return { before, removed, added, after: merchants.length, changed, note: res.note };
}

module.exports = { validEntry, goesToFor, norm, aiExpand, run, VALID_CATS, SUB };
if (require.main === module) { run().catch(e => { console.error('[merchant-expand] fatal:', e && e.message || e); process.exit(0); }); }
