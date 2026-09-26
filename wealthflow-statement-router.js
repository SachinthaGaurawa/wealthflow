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

// Deterministic categories: unknown merchants remain Other.
const EXPENSE_CATEGORY_RULES = [
  ['Bank Charges', /\b(ceft\w*\s+charges?|slips?\s+charges?|bank\s+charges?|atm\s+(?:withdrawal\s+)?(?:fee|charge)|withdrawal\s+(?:fee|charge)|service\s+(?:fee|charge)|stamp\s+duty|debit\s+tax|annual\s+fee|late\s+(?:payment\s+)?fee|finance\s+charge|sms\s+(?:alert|charge)|maintenance\s+fee|ledger\s+fee)\b/i],
  ['Cash Withdrawal', /\b(atm\s+(?:withdrawal|wtd|cash)|cash\s+(?:withdrawal|withdraw|wd))\b/i],
  ['Groceries', /\b(keells?|cargills|food\s*city|arpico|glomark|laugfs\s+super|sathosa|spar|super\s*market|supermarket|grocery|mini\s*mart|provision)\b/i],
  ['Dining', /\b(restaurant|cafe|coffee|bakery|pizza|burger|kfc|mcdonald|dominos|dinemore|barista|spicy\s+food|food\s+court|canteen|grill|ice\s+cream)\b/i],
  ['Telecom', /\b(dialog(?:\s+axiata)?|mobitel|slt(?:\s+mobitel)?|hutch|airtel|lanka\s*bell|reload|recharge|airtime|phone\s+bill)\b/i],
  ['Utilities', /\b(ceb|leco|ceylon\s+electricity|electricity|water\s+board|nwsdb|water\s+bill|litro|laugfs\s+gas|gas\s+bill)\b/i],
  ['Fuel', /\b(fuel|petrol|diesel|filling\s+station|ceypetco|lanka\s+ioc|sinopec|petroleum)\b/i],
  ['Transport', /\b(uber|pick\s*me|taxi|railway|parking|toll|expressway|interchange|\brda\b|highway|car\s+wash|vehicle\s+service|transport)\b/i],
  ['Health', /\b(pharmacy|hospital|medical|clinic|channelling|doc990|nawaloka|asiri|hemas|durdans|healthguard|dental|laboratory)\b/i],
  ['Education', /\b(school|tuition|university|campus|course|institute|academy|college|book\s*(?:shop|store)|sarasavi|vijitha\s+yapa)\b/i],
  ['Insurance', /\b(insurance|assurance|takaful|policy\s+premium|aia|ceylinco|allianz|janashakthi|fairfirst)\b/i],
  ['Government', /\b(inland\s+revenue|motor\s+traffic|immigration|passport|municipal\s+council|government|license\s+fee)\b/i],
  ['Shopping', /\b(daraz|amazon|aliexpress|odel|nolimit|fashion|clothing|textiles?|tex|singer|abans|softlogic|damro|electronics|furniture|hardware|gift\s+shop)\b/i],
  ['Subscriptions', /\b(github|openai|chatgpt|adobe|microsoft\s*365|office\s*365|notion|canva|dropbox|vercel|cloudflare)\b/i],
  ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube\s+premium|playstation|xbox|concert|bowling)\b/i],
];

export function expenseCategoryFor(row) {
  const desc = descOf(row);
  for (const [category, pattern] of EXPENSE_CATEGORY_RULES) if (pattern.test(desc)) return category;
  return 'Other';
}

export function incomeCategoryFor(row) {
  const desc = descOf(row);
  const rules = [
    ['Salary', /\b(salary|payroll|wages|emolument|stipend|net\s+pay)\b/i],
    ['Interest', /\b(interest|int\s+cr|fd\s+interest|savings\s+interest)\b/i],
    ['Dividend', /\b(dividend|div\s+cr)\b/i],
    ['Rent', /\b(rent|rental|lease\s+income)\b/i],
    ['Business', /\b(invoice|sales|business|merchant\s+settlement|freelance|consultancy|professional\s+fee|royalty)\b/i],
    ['Pension', /\b(pension|epf|etf|gratuity)\b/i],
    ['Gift', /\b(gift|donation|present)\b/i],
    ['Refund', /\b(refund|reversal|chargeback|cashback|reimburse)\b/i],
  ];
  for (const [category, pattern] of rules) if (pattern.test(desc)) return category;
  return 'Other';
}

// ── helpers ─────────────────────────────────────────────────────────────────
function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim(); }

function toNumber(a) {
  if (typeof a === 'number') return a;
  const n = parseFloat(String(a || '').replace(/[^0-9.\-]/g, ''));
  return isNaN(n) ? 0 : n;
}

function descOf(row) {
  if (!row) return '';
  return row.description != null && row.description !== '' ? row.description : (row.narration || '');
}

// credit (money in) vs debit (money out)
function direction(row) {
  // The parser's own conclusion comes first: it is derived from the statement's
  // running balance (opening + amount = closing), which is stronger evidence than
  // any wording match below. Ignoring it — as this function did — threw away the
  // one signal that is actually verified and fell through to `row.type`, which
  // the parser does not emit, so every row defaulted to 'debit'. A salary credit
  // would have been filed as an expense.
  if (row.direction) return /^cr/i.test(row.direction) ? 'credit' : 'debit';
  if (row.drcr) return /cr/i.test(row.drcr) ? 'credit' : 'debit';
  if (typeof row.amount === 'number' && row.amount < 0) return 'credit'; // some statements sign CR negative
  const d = norm(descOf(row));
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
  const statementType = norm(ctx.statementType).replace(/\s+/g, '_');
  if (statementType === 'credit_card') return true;
  if (statementType === 'bank_account' || statementType === 'savings') return false;
  const last4 = row.card_last4 || ctx.card_last4;
  const entry = last4 && ctx.cardRegistry ? ctx.cardRegistry[last4] : null;
  return entry ? entry.type === 'credit_card' : false;
}

// ── the core router for ONE row ─────────────────────────────────────────────
export function routeRow(row, ctx = {}) {
  const rawDesc = descOf(row);
  const desc = norm(rawDesc);
  const amount = Math.abs(toNumber(row.amount));
  const dir = direction(row);
  const onCard = isCreditCardRow(row, ctx);
  const targetHit = bestNameMatch(rawDesc, ctx.targets);
  const loanHit   = bestNameMatch(rawDesc, ctx.loans);

  let module, tabLabel, confidence, subtype = null, allocation = null, category = null;

  if (dir === 'credit') {
    // The account type is stronger evidence than narration. A card-side credit
    // (including an "interest credit") settles the card; it is not cash income.
    if (onCard || RE.ccPayment.test(desc)) {
      module = 'cc_payment'; tabLabel = 'CC Payment → FIFO reconcile'; confidence = 0.92;
    } else if (RE.salary.test(desc)) {
      module = 'income'; tabLabel = 'Income & Investments'; confidence = 0.9; category = incomeCategoryFor(row);
    } else if (loanHit) {
      module = 'loans'; tabLabel = 'Loan Repayment'; confidence = 0.6 + 0.35 * loanHit.score; allocation = loanHit;
    } else if (targetHit) {
      module = 'goal_alloc'; tabLabel = `Savings Target: ${targetHit.name}`; confidence = 0.6 + 0.35 * targetHit.score; allocation = targetHit;
    } else {
      module = 'income'; tabLabel = 'Income & Investments'; confidence = 0.7; category = incomeCategoryFor(row);
    }
  } else { // debit
    if (targetHit)      { module = 'goal_alloc'; tabLabel = `Savings Target: ${targetHit.name}`; confidence = 0.6 + 0.35 * targetHit.score; allocation = targetHit; }
    else if (loanHit)   { module = 'loans'; tabLabel = 'Loan Repayment'; confidence = 0.6 + 0.35 * loanHit.score; allocation = loanHit; }
    else if (RE.subscription.test(desc)) { module = 'subscriptions'; tabLabel = 'Subscriptions'; confidence = 0.9; category = expenseCategoryFor(row); }
    else if (onCard) {
      if (RE.installment.test(desc))      { module = 'ccinstall'; tabLabel = 'CC Installments'; confidence = 0.85; }
      else if (RE.cashAdvance.test(desc)) { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'cash_advance'; confidence = 0.85; }
      else if (RE.fuel.test(desc))        { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fuel'; confidence = 0.85; }
      else if (RE.fee.test(desc))         { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fee'; confidence = 0.8; }
      else                                { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'purchase'; confidence = 0.7; }
    } else {
      module = 'expenses'; tabLabel = 'Monthly Expenses'; confidence = 0.7; category = expenseCategoryFor(row);
    }
  }

  // unreadable vendor / tiny description → never trust it
  if (!desc || desc === 'unreadable vendor' || desc.length < 3) confidence = Math.min(confidence, 0.4);

  const threshold = typeof ctx.reviewThreshold === 'number' ? ctx.reviewThreshold : 0.75;
  // An upstream doubt must survive routing. The parser flags a row whose
  // direction it had to assume (a statement printing no running balance) or read
  // from wording; the router's own confidence is about the CATEGORY and knows
  // nothing of that, so without this an unverified row could route with 0.9.
  const upstreamDoubt = row.needsReview === true || (row.direction !== undefined && !row.direction);
  return {
    module, tabLabel, subtype, allocation, category,
    confidence: Math.round(confidence * 100) / 100,
    needsReview: confidence < threshold || upstreamDoubt,
    fields: { date: row.date, desc: rawDesc, amount, ref: row.ref || null, dir },
  };
}

// ── dedup hash (works in browser + Node 20) ─────────────────────────────────
export async function hashRow(row, ctx = {}) {
  const tuple = [
    String(row.date || '').slice(0, 10),
    Math.round(Math.abs(toNumber(row.amount)) * 100),
    row.card_last4 || ctx.card_last4 || 'n/a',
    String(row.ref || '').toUpperCase(),
    norm(descOf(row)).slice(0, 40),
  ].join('|');
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tuple));
    return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(tuple).digest('hex');
}

export function occurrenceKey(row) {
  const ref = String((row && row.ref) || '').trim().toUpperCase();
  if (ref) return 'R:' + ref;
  const raw = String((row && row.time) || (row && row.date) || '');
  const m = /(\d{2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  return m ? 'T:' + m[0] : null;
}

export async function classifyStatement({ rows = [], existingHashes = new Set(), enrich = null, ...ctx }) {
  const out = [];
  const stored = existingHashes instanceof Set ? existingHashes : new Set(existingHashes || []);
  const occurrences = new Map();          // hash -> Set of occurrence keys seen here
  for (const row of rows) {
    const hash = await hashRow(row, ctx);
    if (stored.has(hash)) { out.push({ hash, duplicate: true, duplicateOf: 'ledger', row }); continue; }

    const key = occurrenceKey(row);
    const seenKeys = occurrences.get(hash);
    if (seenKeys) {
      if (key && seenKeys.has(key)) {
        out.push({ hash, duplicate: true, duplicateOf: 'statement', row });
        continue;
      }
      seenKeys.add(key || `#${seenKeys.size}`);
    } else {
      occurrences.set(hash, new Set([key || '#0']));
    }

    let routed = routeRow(row, ctx);
    if (enrich && routed.needsReview) { try { routed = await enrich(row, routed) || routed; } catch (_) {} }
    out.push({ hash, duplicate: false, row, ...routed });
  }
  return out;
}

const API = { routeRow, hashRow, occurrenceKey, classifyStatement };

if (typeof window !== 'undefined') window.WFStatementRouter = API;

export default API;
