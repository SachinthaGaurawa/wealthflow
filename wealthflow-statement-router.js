// =============================================================================
// WealthFlow — Statement Router  (drop-in classifier)
//
// WHY THIS EXISTS
// Today every uploaded statement row is funnelled through _showCCReviewModal()
// in index.html, whose Save button literally pushes 100% of rows into the
// `cconetime` array ("Save selected to CC One-Time"). That is the entire reason
// every upload lands in CC One-Time. This module is the missing piece: a single
// pure function that looks at each row and decides which of your 6 tabs it
// belongs in, with a confidence score and a "needs review" flag for the
// Quarantine Zone.
//
// It is dependency-free and runs in the browser AND in Node (for tests).
// It does NOT call any external API. Web-search enrichment (Tavily) and the
// EODHD market lookups are deliberately kept as OPTIONAL async hooks you layer
// on top — see `enrich` in classifyStatement(). Routing must work offline first.
//
// Modules it can return:
//   income | expenses | subscriptions | cconetime | ccinstall | loans
//   cc_payment  (a payment INTO a credit card → should trigger FIFO reconcile)
//   goal_alloc  (matched one of the user's savings targets by name)
// =============================================================================

// ── detection vocab (Sri Lanka–aware) ──────────────────────────────────────
const RE = {
  installment: /\b(instal+ment|easy\s*payment|flexi[\s-]*pay|e[\s-]?z\s*cash|emi|monthly\s*plan|0%\s*plan|\d{1,2}\s*(?:\/|of)\s*\d{1,2})\b/i,
  subscription:/\b(netflix|spotify|youtube|prime|disney|hbo|icloud|google\s*(one|storage)|microsoft|office\s*365|adobe|dialog|mobitel|hutch|airtel|slt|peo\s*tv|chatgpt|openai|notion|canva|dropbox)\b/i,
  ccPayment:  /\b(payment\s*[-–]?\s*thank\s*you|payment\s*received|thank\s*you\s*for\s*your\s*payment|online\s*payment|card\s*payment|settlement)\b/i,
  fee:        /\b(annual\s*fee|late\s*(payment\s*)?fee|over\s*limit|finance\s*charge|interest|service\s*charge|joining\s*fee|stamp\s*duty|vat)\b/i,
  cashAdvance:/\b(cash\s*advance|atm|withdrawal|cash\s*w\/?d)\b/i,
  fuel:       /\b(ceypetco|cargills\s*petroleum|lanka\s*ioc|\bioc\b|filling\s*station|fuel|petrol|diesel)\b/i,
  refund:     /\b(refund|reversal|reimburs|chargeback|cashback)\b/i,
  salary:     /\b(salary|payroll|wages|stipend|pension|dividend|interest\s*credit|profit)\b/i,
};

// ── helpers ─────────────────────────────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function toNumber(a) {
  if (typeof a === 'number') return a;
  const n = parseFloat(String(a || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

// credit (money in) vs debit (money out)
function direction(row) {
  if (row.drcr) return /cr/i.test(row.drcr) ? 'credit' : 'debit';
  if (typeof row.amount === 'number' && row.amount < 0) return 'credit'; // some statements sign CR negative
  const d = norm(row.description);
  if (RE.refund.test(d) || RE.salary.test(d)) return 'credit';
  return row.type === 'credit' ? 'credit' : 'debit';
}

// Semantic match against the user's saved targets / loans by name overlap.
// Returns the best match {id,name,score} or null. Score 0..1.
function bestNameMatch(desc, list) {
  const d = norm(desc);
  if (!d || !Array.isArray(list)) return null;
  const dTok = new Set(d.split(' ').filter(w => w.length > 2));
  let best = null;
  for (const item of list) {
    const name = norm(item.name);
    if (!name) continue;
    if (d.includes(name) && name.length > 2) { return { id: item.id, name: item.name, score: 1 }; }
    const nTok = name.split(' ').filter(w => w.length > 2);
    if (!nTok.length) continue;
    const hits = nTok.filter(w => dTok.has(w)).length;
    const score = hits / nTok.length;
    if (score >= 0.5 && (!best || score > best.score)) best = { id: item.id, name: item.name, score };
  }
  return best;
}

function isCreditCardRow(row, ctx) {
  if (ctx.statementType === 'credit_card') return true;
  if (ctx.statementType === 'bank_account' || ctx.statementType === 'savings') return false;
  const last4 = row.card_last4 || ctx.card_last4;
  const entry = last4 && ctx.cardRegistry ? ctx.cardRegistry[last4] : null;
  return entry ? entry.type === 'credit_card' : false;
}

// ── the core router for ONE row ─────────────────────────────────────────────
export function routeRow(row, ctx = {}) {
  const desc = norm(row.description);
  const amount = Math.abs(toNumber(row.amount));
  const dir = direction(row);
  const onCard = isCreditCardRow(row, ctx);
  const targetHit = bestNameMatch(row.description, ctx.targets);
  const loanHit   = bestNameMatch(row.description, ctx.loans);

  let module, tabLabel, confidence, subtype = null, allocation = null;

  if (dir === 'credit') {
    if (RE.salary.test(desc)) {
      module = 'income'; tabLabel = 'Income & Investments'; confidence = 0.9;
    } else if (onCard || RE.ccPayment.test(desc)) {
      module = 'cc_payment'; tabLabel = 'CC Payment → FIFO reconcile'; confidence = 0.92;
    } else if (loanHit) {
      module = 'loans'; tabLabel = 'Loan Repayment'; confidence = 0.6 + 0.35 * loanHit.score; allocation = loanHit;
    } else if (targetHit) {
      module = 'goal_alloc'; tabLabel = `Savings Target: ${targetHit.name}`; confidence = 0.6 + 0.35 * targetHit.score; allocation = targetHit;
    } else {
      module = 'income'; tabLabel = 'Income & Investments'; confidence = 0.7;
    }
  } else { // debit
    if (targetHit)      { module = 'goal_alloc'; tabLabel = `Savings Target: ${targetHit.name}`; confidence = 0.6 + 0.35 * targetHit.score; allocation = targetHit; }
    else if (loanHit)   { module = 'loans'; tabLabel = 'Loan Repayment'; confidence = 0.6 + 0.35 * loanHit.score; allocation = loanHit; }
    else if (RE.subscription.test(desc)) { module = 'subscriptions'; tabLabel = 'Subscriptions'; confidence = 0.9; }
    else if (onCard) {
      if (RE.installment.test(desc))      { module = 'ccinstall'; tabLabel = 'CC Installments'; confidence = 0.85; }
      else if (RE.cashAdvance.test(desc)) { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'cash_advance'; confidence = 0.85; }
      else if (RE.fuel.test(desc))        { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fuel'; confidence = 0.85; }
      else if (RE.fee.test(desc))         { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fee'; confidence = 0.8; }
      else                                { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'purchase'; confidence = 0.7; }
    } else {
      module = 'expenses'; tabLabel = 'Monthly Expenses'; confidence = 0.7;
    }
  }

  // unreadable vendor / tiny description → never trust it
  if (!desc || desc === 'unreadable vendor' || desc.length < 3) confidence = Math.min(confidence, 0.4);

  const threshold = typeof ctx.reviewThreshold === 'number' ? ctx.reviewThreshold : 0.75;
  return {
    module, tabLabel, subtype, allocation,
    confidence: Math.round(confidence * 100) / 100,
    needsReview: confidence < threshold,
    fields: { date: row.date, desc: row.description, amount, ref: row.ref || null, dir },
  };
}

// ── dedup hash (works in browser + Node 20) ─────────────────────────────────
export async function hashRow(row, ctx = {}) {
  const tuple = [
    String(row.date || '').slice(0, 10),
    Math.round(Math.abs(toNumber(row.amount)) * 100),
    row.card_last4 || ctx.card_last4 || 'n/a',
    String(row.ref || '').toUpperCase(),
    norm(row.description).slice(0, 40),
  ].join('|');
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tuple));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(tuple).digest('hex');
}

// ── classify a whole statement + dedup against what's already stored ────────
//   existingHashes: Set<string> of hashes already in the DB (manual + email)
//   enrich:        optional async (row, routed) => routed  // e.g. Tavily lookup
export async function classifyStatement({ rows = [], existingHashes = new Set(), enrich = null, ...ctx }) {
  const out = [];
  const seen = new Set(existingHashes);
  for (const row of rows) {
    const hash = await hashRow(row, ctx);
    if (seen.has(hash)) { out.push({ hash, duplicate: true, row }); continue; }
    seen.add(hash);
    let routed = routeRow(row, ctx);
    if (enrich && routed.needsReview) { try { routed = await enrich(row, routed) || routed; } catch (_) {} }
    out.push({ hash, duplicate: false, row, ...routed });
  }
  return out;
}

export default { routeRow, hashRow, classifyStatement };
