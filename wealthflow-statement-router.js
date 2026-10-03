import { sameBank } from './wealthflow-institutions.js';

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
  ['Bank Charges', /\b(ceft\w*\s+charges?|slips?\s+charges?|bank\s+charges?|atm\s+(?:withdrawal\s+)?(?:fee|charge)|withdrawal\s+(?:fee|charge)|service\s+(?:fee|charge)|stamp\s+duty|debit\s+tax|annual\s+fee|late\s+(?:payment\s+)?fee|finance\s+charge|sms\s+(?:alert|charge)|maintenance\s+fee|ledger\s+fee|(?:pos\s+transaction|lpopp)\s+(?:fee|charges?))\b/i],
  ['Cash Withdrawal', /\b(atm\s+(?:withdrawal|wtd|cash)|cash\s+(?:withdrawal|withdraw|wd))\b/i],
  ['Groceries', /\b(keells?|cargills|food\s*city|arpico|glomark|laugfs\s+super|sathosa|spar|super\s*market|supermarket|grocery|mini\s*mart|provision)\b/i],
  ['Dining', /\b(restaurant|cafe|coffee|bakery|pizza|burger|kfc|mc\s*donalds?|dominos?|dinemore|barista|spicy\s+food|food\s+court|canteen|grill|ice\s+cream|uber\s*eats|food\s*panda|pick\s*me\s+food|taco\s+bell|subway|java\s+lounge|kottu)\b/i],
  ['Telecom', /\b(dialog(?:\s+axiata)?|mobitel|slt(?:\s+mobitel)?|hutch|airtel|lanka\s*bell|reload|recharge|airtime|phone\s+bill)\b/i],
  ['Utilities', /\b(ceb|leco|ceylon\s+electricity|electricity|water\s+board|nwsdb|water\s+bill|litro|laugfs\s+gas|gas\s+bill)\b/i],
  ['Fuel', /\b(fuel|petrol|diesel|filling\s+station|ceypetco|lanka\s+ioc|sinopec|petroleum)\b/i],
  ['Transport', /\b(uber|pick\s*me|taxi|railway|parking|toll|expressway|interchange|\brda\b|highway|car\s+wash|vehicle\s+service|transport)\b/i],
  ['Health', /\b(pharmacy|hospital|medical|clinic|channelling|doc990|nawaloka|asiri|hemas|durdans|healthguard|dental|laboratory)\b/i],
  ['Education', /\b(school|tuition|university|campus|course|institute|academy|college|book\s*(?:shop|store)|sarasavi|vijitha\s+yapa)\b/i],
  ['Insurance', /\b(insur\w*|assurance|takaful|policy\s+premium|aia|ceylinco|allianz|janashakthi|fairfirst)\b/i],
  ['Government', /\b(inland\s+revenue|motor\s+traffic|immigration|passport|municipal\s+council|government|license\s+fee)\b/i],
  ['Shopping', /\b(daraz|amazon|aliexpress|odel|nolimit|fashion|clothing|textiles?|tex|singer|abans|softlogic|damro|electronics|furniture|hardware|gift\s+shop)\b/i],
  ['Subscriptions', /\b(github|openai|chatgpt|adobe|microsoft\s*365|office\s*365|notion|canva|dropbox|vercel|cloudflare)\b/i],
  ['Entertainment', /\b(cinema|movie|netflix|spotify|youtube\s+premium|playstation|xbox|concert|bowling)\b/i],
];

/* THE SERVER HANDS THE ROUTER ITS MERCHANT LIST. statement-merchants.mjs (server-only; reads merchants.json) calls this when it is imported: the router, which the page also
 * loads, never imports the list, and a page that never loads it behaves exactly as before. */
let merchantClassifier = null;
export function setMerchantClassifier(classify, categories = []) {
  merchantClassifier = typeof classify === 'function' ? classify : null;
  for (const category of categories) if (!CLASSIFY_CATEGORIES.includes(category)) CLASSIFY_CATEGORIES.splice(CLASSIFY_CATEGORIES.indexOf('Card Payment'), 0, category);
}

/** The category the fixed rules alone give a narration, or null — with no merchant list. (The lint in test/merchant_triage_test.js holds the list to these rules.) */
export function expenseRuleCategory(row) {
  const desc = String(descOf(row)).replace(/[*_/]+|(?<=[a-z])-(?=[a-z])/gi, ' ');
  const hit = EXPENSE_CATEGORY_RULES.find(([, pattern]) => pattern.test(desc));
  return hit ? hit[0] : null;
}

export function expenseCategoryFor(row) {
  const desc = String(descOf(row)).replace(/[*_/]+|(?<=[a-z])-(?=[a-z])/gi, ' ');   // a gateway's "*", "-" and "/" separate words
  const listed = merchantClassifier ? merchantClassifier(desc) : null;
  /* A SPECIFIC NAME BEATS A BRAND WORD. The rules below know "amazon" as Shopping; the merchant list knows "amazon prime" as Streaming. When the list names a business in
   * two words or more and the rules say something else, the longer name is the better evidence ("AMAZON PRIME" was being filed as Shopping). */
  const byRule = EXPENSE_CATEGORY_RULES.find(([, pattern]) => pattern.test(desc));
  if (listed && listed.category && listed.basis === 'registry' && listed.words >= 2 && (!byRule || byRule[0] !== listed.category) && !(byRule && byRule[0] === 'Bank Charges')) return listed.category;
  if (listed && listed.ambiguous) return 'Other';   // two known merchants (or two kinds of business) on one line: not picked between, whatever one brand word in the rules says
  if (byRule) return byRule[0];
  /* What the rules do not name, the merchant list the app already carries (merchants.json, 950 businesses) and the words for what a business sells may: the same words, the
   * same answer in the app and on the server. A name that fits two kinds of business equally well is NOT picked between: it stays "Other" and is put to the owner
   * (statement-merchants.mjs). */
  return listed && listed.category ? listed.category : 'Other';
}

const INCOME_CATEGORY_RULES = [
  ['Salary', /\b(salary|payroll|wages|emolument|stipend|net\s+pay)\b/i],
  ['Interest', /\b(interest|int\s+cr|fd\s+interest|savings\s+interest)\b/i],
  ['Dividend', /\b(dividend|div\s+cr)\b/i],
  ['Rent', /\b(rent|rental|lease\s+income)\b/i],
  ['Business', /\b(invoice|sales|business|merchant\s+settlement|freelance|consultancy|professional\s+fee|royalty)\b/i],
  ['Pension', /\b(pension|epf|etf|gratuity)\b/i],
  ['Gift', /\b(gift|donation|present)\b/i],
  ['Refund', /\b(refund|reversal|chargeback|cashback|reimburse)\b/i],
];

export function incomeCategoryFor(row) {
  const desc = descOf(row);
  for (const [category, pattern] of INCOME_CATEGORY_RULES) if (pattern.test(desc)) return category;
  return 'Other';
}

// The fixed vocabulary classifySlice's AI board is constrained to. Deriving
// it from the same rule tables the deterministic router uses keeps the two
// layers speaking one taxonomy, so an AI-driven category can never invent a
// spelling the deterministic path would not also produce.
export const CLASSIFY_CATEGORIES = [
  ...EXPENSE_CATEGORY_RULES.map(([category]) => category),
  ...INCOME_CATEGORY_RULES.map(([category]) => category),
  'Card Payment', 'Card Purchase', 'Card Fee', 'Cash Advance', 'Needs Review', 'Other',
];

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
  // The parser's own conclusion (from the running balance) outranks any wording match below.
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

export function isCreditCardRow(row, ctx) {
  const statementType = norm(ctx.statementType).replace(/\s+/g, '_');
  if (statementType === 'credit_card') return true;
  if (statementType === 'bank_account' || statementType === 'savings') return false;
  const last4 = row.card_last4 || ctx.card_last4;
  const entry = last4 && ctx.cardRegistry ? ctx.cardRegistry[last4] : null;
  if (!entry) return false;
  // Last-4 alone is not unique across the owner's banks: when both banks are known they must agree.
  if (entry.bank && ctx.bank && !sameBank(entry.bank, ctx.bank) && norm(entry.bank) !== norm(ctx.bank)) return false;
  return entry.type === 'credit_card';
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
    else if (onCard) {
      if (RE.installment.test(desc))      { module = 'ccinstall'; tabLabel = 'CC Installments'; confidence = 0.85; }
      else if (RE.subscription.test(desc)){ module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'subscription'; confidence = 0.9; category = 'Subscriptions'; }
      else if (RE.cashAdvance.test(desc)) { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'cash_advance'; confidence = 0.85; }
      else if (RE.fuel.test(desc))        { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fuel'; confidence = 0.85; }
      else if (RE.fee.test(desc))         { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'fee'; confidence = 0.8; }
      else                                { module = 'cconetime'; tabLabel = 'CC One-Time'; subtype = 'purchase'; confidence = 0.7; category = expenseCategoryFor(row); }
    } else {
      if (RE.subscription.test(desc)) { module = 'subscriptions'; tabLabel = 'Subscriptions'; confidence = 0.9; category = expenseCategoryFor(row); }
      else { module = 'expenses'; tabLabel = 'Monthly Expenses'; confidence = 0.7; category = expenseCategoryFor(row); }
    }
  }

  // unreadable vendor / tiny description → never trust it
  if (!desc || desc === 'unreadable vendor' || desc.length < 3) confidence = Math.min(confidence, 0.4);

  const threshold = typeof ctx.reviewThreshold === 'number' ? ctx.reviewThreshold : 0.75;
  // An upstream doubt (a direction the parser assumed or read from wording) must survive routing.
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

/* THE NAME A CATEGORY IS STORED UNDER IS THE NAME THE EXPENSE DROPDOWN HAS.
 * The classifiers (this file's rules, the AI board, the merchant list) say "Groceries", "Health", "Bank Charges"; the owner's own expenses are filed under the dropdown's names
 * ("Food & Groceries", "Healthcare", "Banking" — EXPENSE_CATEGORIES in index.html). A statement row filed under the classifier's word was a separate slice on the dashboard, missed the
 * owner's "Food" budget, and — because the page's editor sets the dropdown to the stored word — left the Category blank when the row was edited and saved. Every name here is the
 * classifier's word for something the dropdown names differently; a word the dropdown already has (or has no counterpart for: "Cash Withdrawal") is left as it is.
 * The registry names (Streaming, Software, Internet, Gym/Fitness) are the merchant list's own words for what the server already files as Entertainment, Subscriptions, Telecom and
 * Personal Care (statement-merchants.mjs); they reach the page through its own classifier and are mapped the same way. Pinned in test/category_entry_name_test.js. */
export const EXPENSE_ENTRY_NAME = Object.freeze({
  Groceries: 'Food & Groceries', Health: 'Healthcare', 'Bank Charges': 'Banking',
  Streaming: 'Entertainment', Software: 'Subscriptions', Internet: 'Telecom', 'Gym/Fitness': 'Personal Care',
});
/** The classifier's word for the dropdown's, where the two mean exactly the same (the way back is only for these: "Banking" is wider than "Bank Charges"). */
export const CLASSIFIER_NAME = Object.freeze({ 'Food & Groceries': 'Groceries', Healthcare: 'Health' });
const named = (table, name) => (typeof name === 'string' && Object.prototype.hasOwnProperty.call(table, name) ? table[name] : name);
export const expenseEntryName = (name) => named(EXPENSE_ENTRY_NAME, name);
export const classifierName = (name) => named(CLASSIFIER_NAME, name);

const API = { routeRow, hashRow, occurrenceKey, classifyStatement, expenseEntryName, classifierName };

if (typeof window !== 'undefined') window.WFStatementRouter = API;

export default API;
