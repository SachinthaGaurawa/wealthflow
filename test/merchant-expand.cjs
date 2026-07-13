#!/usr/bin/env node
/* =============================================================================
 * WealthFlow - Autonomous Merchant Verification Engine (registry side)
 * ============================================================================= */
const fs = require('fs');
const path = require('path');

// Find merchants.json no matter where this script sits.
const FILE = (function () {
  const cands = [
    process.env.MERCHANTS_FILE,
    path.join(process.cwd(), 'merchants.json'),
    path.join(__dirname, 'merchants.json'),
    path.join(__dirname, '..', 'merchants.json')
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (_) {}
  }
  return path.join(process.cwd(), 'merchants.json');
})();

const GATE = 0.95;

const VALID_CATS = {
  Telecom: 1,
  Insurance: 1,
  Streaming: 1,
  Software: 1,
  Internet: 1,
  Utilities: 1,
  Groceries: 1,
  Dining: 1,
  Health: 1,
  Transport: 1,
  Fuel: 1,
  Education: 1,
  Government: 1,
  Shopping: 1,
  Gold: 1,
  'Gym/Fitness': 1,
  Leasing: 1,
  'Bank Charges': 1,
  'Cash Withdrawal': 1,
  Other: 1
};

const SUB = { Telecom: 1, Insurance: 1, Streaming: 1, Internet: 1, Utilities: 1, Software: 1, 'Gym/Fitness': 1, Leasing: 1 };
const SECTORS = ['Telecom','Insurance','Groceries','Dining','Health','Transport','Fuel','Education','Government','Shopping','Utilities','Software','Streaming','Gold','Gym/Fitness','Leasing','Internet'];

const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const validEntry = e => !!(e && typeof e.key === 'string' && norm(e.key).length >= 2 && e.category && VALID_CATS[e.category]);
const validEntry2 = e => !!(e && typeof e.key === 'string' && norm(e.key).length >= 2 && e.category && VALID_CATS[e.category]);

const goesToFor = e => {
  const g = e.goesTo;
  return (g === 'subscription' || g === 'expenses' || g === 'income') ? g : (SUB[e.category] ? 'subscription' : 'expenses');
};

const load = () => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch (_) {
    return { schema: 'wealthflow.merchants/v2', version: 0, merchants: [] };
  }
};

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
  'Return only JSON, no prose and no markdown fences, in exactly this shape:',
  '{"merchants":[{"key":"...","vendor":"...","category":"...","destination":"subscription|expenses","confidence":0.00}]}'
].join('\n');

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ask(sector, existing) {
  const APP = (process.env.APP_URL || '').replace(/\/+$/, '');
  const want = Math.max(8, Math.min(25, +(process.env.MERCHANT_BATCH || 18)));
  const user = [
    'Sector to cover: ' + sector + '.',
    'Allowed category values: ' + Object.keys(VALID_CATS).join(', ') + '.',
    'Already known - do NOT repeat any of these: ' + existing.slice(0, 300).join('; ') + '.',
    'List up to ' + want + ' REAL merchants in that sector that are missing.'
  ].join('\n');

  const prompt = SYSTEM + '\n\n' + user;

  if (APP) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const ctl = new AbortController();
        const kill = setTimeout(() => ctl.abort(), 80000);
        const r = await fetch(APP + '/api/ai', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ prompt, mode: 'consensus', temperature: 0, maxTokens: 1400 }),
          signal: ctl.signal
        });
        clearTimeout(kill);

        if (r.ok) {
          const j = await r.json();
          const replyText = j.reply || j.text || j.consensusText || (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
          const out = parse(replyText);
          out.engines = +(j.consensusOf || 1);
          out.note = 'consensusOf=' + out.engines + (attempt > 1 ? ' (attempt ' + attempt + ')' : '');
          return out;
        }
        if (r.status >= 500 && attempt < 3) {
          await sleep(5000 * attempt);
          continue;
        }
        return { list: [], engines: 0, note: '/api/ai HTTP ' + r.status };
      } catch (e) {
        if (attempt < 3) {
          await sleep(5000 * attempt);
          continue;
        }
        return { list: [], engines: 0, note: 'network: ' + ((e && e.message) || e) };
      }
    }
  }

  const KEY = process.env.ANTHROPIC_API_KEY;
  if (!KEY) return { list: [], engines: 0, note: 'set the APP_URL repo variable (e.g. https://your-app.vercel.app) to enable growth' };

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-3-5-sonnet-20241022', max_tokens: 2000, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: user }] })
    });
    if (!r.ok) return { list: [], engines: 0, note: 'anthropic HTTP ' + r.status };
    const j = await r.json();
    const out = parse((j.content || []).filter(x => x.type === 'text').map(x => x.text).join(''));
    out.engines = 3;
    return out;
  } catch (e) { return { list: [], engines: 0, note: 'anthropic error: ' + ((e && e.message) || e) }; }
}

function parse(text) {
  const t = String(text || '');
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj) {
    try {
      const j = JSON.parse(obj[0]);
      if (Array.isArray(j.merchants)) return { list: j.merchants, note: 'ok' };
    } catch (_) {}
  }
  const arr = t.match(/\[[\s\S]*\]/);
  if (arr) {
    try {
      const a = JSON.parse(arr[0]);
      if (Array.isArray(a)) return { list: a, note: 'ok' };
    } catch (_) {}
  }
  return { list: [], note: 'no parseable JSON in reply' };
}

function audit(list) {
  const seen = new Map(), conflicts = [];
  list.forEach(e => {
    const prev = seen.get(e.key);
    if (prev && prev !== e.category) conflicts.push({ key: e.key, a: prev, b: e.category });
    seen.set(e.key, e.category);
  });
  return conflicts;
}

async function run() {
  const doc = load();
  const before = (doc.merchants || []).length;
  const map = new Map();

  (doc.merchants || []).forEach(e => {
    if (!validEntry(e)) return;
    const k = norm(e.key);
    if (map.has(k)) return;
    map.set(k, { key:k, category:e.category, goesTo:goesToFor(e), confidence:(e.confidence != null ? +e.confidence : 1), source:e.source || 'seed' });
  });
  const removed = before - map.size;

  const sector = SECTORS[Math.floor(Date.now() / 36e5) % SECTORS.length];
  const keys = [...map.keys()];
  const res = await ask(sector, keys);
  const engines = res.engines || 0;
  let added = 0, held = 0;

  (res.list || []).forEach(e => {
    if (!validEntry2(e)) { held++; return; }
    const k = norm(e.key);
    if (map.has(k)) return;
    const conf = +e.confidence || 0;
    
    if (engines < 1) { held++; return; }
    if (conf < GATE) { held++; return; }
    map.set(k, { key: k, category: e.category, goesTo: goesToFor({ goesTo: e.destination || e.goes_to, category: e.category }), confidence: +conf.toFixed(2), source: 'ai-consensus' });
    added++;
  });

  const merchants = [...map.values()].sort((x, y) => x.category.localeCompare(y.category) || x.key.localeCompare(y.key));
  const conflicts = audit(merchants);
  const changed = merchants.length !== before || removed > 0 || added > 0;

  if (changed) {
    doc.schema = 'wealthflow.merchants/v2';
    doc.version = (doc.version || 0) + 1;
    doc.updated = new Date().toISOString().slice(0, 10);
    doc.source = 'wealthflow-auto';
    doc.gate = GATE;
    doc.count = merchants.length;
    doc.conflicts = conflicts.length;
    doc.merchants = merchants;
    fs.writeFileSync(FILE, JSON.stringify(doc, null, 2) + '\n');
  }

  console.log('[merchant-expand] sector=%s engines=%d before=%d removed=%d added=%d held=%d conflicts=%d after=%d changed=%s | %s',
    sector, engines, before, removed, added, held, conflicts.length, merchants.length, changed, res.note);
  if (conflicts.length) conflicts.slice(0, 5).forEach(x => console.log('  [audit] CONFLICT: "%s" is listed as both %s and %s', x.key, x.a, x.b));

  return { before, removed, added, held, engines, conflicts: conflicts.length, after: merchants.length, changed };
}

module.exports = { validEntry, goesToFor, norm, ask, audit, run, VALID_CATS, SUB, GATE };
if (require.main === module) { run().catch(e => { console.error('[merchant-expand] fatal:', e && e.message || e); process.exit(1); }); }
