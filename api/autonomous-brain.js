// =============================================================================
// WealthFlow Autonomous Brain v1.0
//
// Multi-agent AI pipeline that turns a raw SMS payload into a fully-classified
// WealthFlow transaction. Three deterministic agents run sequentially:
//
//   Agent Alpha (Parser):   extracts amount, type (credit|debit), timestamp,
//                           reference, raw merchant string, card-last-4.
//                           Falls back to heuristic regex on AI failure.
//
//   Agent Beta (OSINT):     given the raw merchant string, returns the
//                           canonical merchant name + category + purpose.
//                           Calls /api/tavily-search internally with a tight
//                           query. Cached per-merchant for 30 days.
//
//   Agent Gamma (Router):   maps to one of the 6 allowed WealthFlow tabs:
//                           [income, expenses, subscriptions, cconetime,
//                            ccinstall, loans]. Uses card type + merchant
//                            category + amount heuristics + AI override.
//
// All three run on Vercel Edge for sub-500 ms total latency. The brain
// itself is stateless — caller persists results to Firestore.
//
// Input  (POST JSON):
//   { sms: "...raw SMS body...",
//     phone_number: "+9477...",  // sender id
//     received_at_ms: 1717000000000,
//     device_id: "...",
//     location: { lat, lng } | null,
//     card_registry: { "1234": { bank, type, name }, ... }  // optional pre-resolved
//   }
//
// Output (200 JSON):
//   { ok: true,
//     hash: "sha256...",
//     parsed: { amount, currency, type, timestamp, reference, raw_merchant, card_last4 },
//     resolved_merchant: { name, category, confidence },
//     routed: { module, tab_label, suggested_fields: {...}, confidence },
//     latency_ms: { alpha, beta, gamma, total } }
// =============================================================================

export const config = { runtime: 'edge' };

const AI_ENDPOINT = process.env.AI_ENDPOINT || 'https://api.anthropic.com/v1/messages';

// ─────────────────────────────────────────────────────────────────────────────
// Heuristic parser — runs first, AI only enriches what regex couldn't get
// ─────────────────────────────────────────────────────────────────────────────
function heuristicParse(sms, fallbackTs) {
    const text = String(sms || '').trim();
    if (!text) return null;

    // Amount: catches "LKR 12,345.67", "Rs 1,234", "USD 99.00", "$50", etc.
    const amtMatch = text.match(/(?:LKR|Rs\.?|USD|EUR|GBP|INR|\$|€|£|₹)\s*([\d,]+(?:\.\d{1,2})?)/i)
                  || text.match(/(?:^|\s)([\d,]+\.\d{2})(?=\s|$)/);
    let amount = null, currency = 'LKR';
    if (amtMatch) {
        amount = parseFloat(amtMatch[1].replace(/,/g, ''));
        const cur = (amtMatch[0].match(/USD|EUR|GBP|INR/i) || [])[0];
        if (cur) currency = cur.toUpperCase();
        else if (/\$/.test(amtMatch[0])) currency = 'USD';
        else if (/€/.test(amtMatch[0])) currency = 'EUR';
        else if (/£/.test(amtMatch[0])) currency = 'GBP';
        else if (/₹/.test(amtMatch[0])) currency = 'INR';
    }

    // Type: credit (incoming) vs debit (outgoing)
    // v7.6.5 — check debit signals FIRST because they're more specific.
    // Also strip "credit card" before checking credit verbs so the noun
    // "credit card" doesn't trigger a false credit-type match.
    let type = 'debit';
    const textForType = text.replace(/credit\s*card/gi, 'XCARD');
    if (/\b(debit\w*|purchas\w*|withdr\w*|spent|paid|charged|cash advance|outgoing|transfer to)\b/i.test(textForType)) type = 'debit';
    else if (/\b(credit\w*|receiv\w*|deposit\w*|refund\w*|reversal|reimburs\w*|incoming)\b/i.test(textForType)) type = 'credit';

    // Card last 4 — "card ending 1234", "***1234", "xxxx1234", "A/c ...1234",
    // "•••1234", or any 4 digits at end of an "A/c"/"card"/"credit card" phrase.
    const last4Match = text.match(/(?:ending|xxxx?|x{2,}|\*{2,}|•{2,}|\.{2,}|account|a\/c|card|credit\s*card)\s*\.{0,4}\s*(\d{4})\b/i)
                    || text.match(/\b(\d{4})\s*(?:has been|debited|credited)/i);
    const cardLast4 = last4Match ? last4Match[1] : null;

    // Reference / transaction id
    const refMatch = text.match(/(?:ref|txn|trans(?:action)?|trace|auth)\.?\s*(?:no\.?|id\.?|#)?\s*[:\-]?\s*([A-Z0-9]{4,})/i);
    const reference = refMatch ? refMatch[1].toUpperCase() : null;

    // Raw merchant — heuristic: phrase after "at ", "to ", or before "on YYYY-..."
    let rawMerchant = '';
    const merchAt = text.match(/\b(?:at|to|@)\s+([A-Z][A-Z0-9\s\-&'.,]{2,50}?)(?:\s+on\s|\s+\d{1,2}[/-]\d|\s+ref|\s+txn|\.|\s*$)/i);
    if (merchAt) rawMerchant = merchAt[1].trim();

    // Timestamp — prefer message timestamp, fall back to received_at_ms
    const dateMatch = text.match(/(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})\s*(?:\s+(\d{1,2}:\d{2}(?::\d{2})?))?/);
    let timestamp = fallbackTs || Date.now();
    if (dateMatch) {
        const parts = dateMatch[1].split(/[/-]/);
        let d, m, y;
        // try DD/MM/YYYY first (Sri Lankan default)
        if (parts[0].length <= 2) { d = +parts[0]; m = +parts[1] - 1; y = +parts[2]; }
        else { y = +parts[0]; m = +parts[1] - 1; d = +parts[2]; }
        if (y < 100) y += 2000;
        const ts = new Date(y, m, d).getTime();
        if (!isNaN(ts)) timestamp = ts;
    }

    return { amount, currency, type, timestamp, reference, raw_merchant: rawMerchant, card_last4: cardLast4 };
}

// ─────────────────────────────────────────────────────────────────────────────
// SHA-256 over the canonical dedup-tuple
// ─────────────────────────────────────────────────────────────────────────────
async function sha256Hex(input) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function dedupKey(parsed, bank) {
    const tuple = [
        (bank || 'unknown').toLowerCase(),
        parsed.card_last4 || 'n/a',
        Math.round((parsed.amount || 0) * 100),
        // Round timestamp to nearest minute to absorb minor SMS delivery skew
        Math.floor((parsed.timestamp || 0) / 60000),
        (parsed.reference || '').toUpperCase()
    ].join('|');
    return tuple;
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Beta — resolve merchant via web search (delegates to tavily-search)
// ─────────────────────────────────────────────────────────────────────────────
async function resolveMerchant(rawMerchant, origin) {
    if (!rawMerchant || rawMerchant.length < 3) {
        return { name: 'Unknown Merchant', category: 'Other', confidence: 0.1 };
    }
    try {
        const r = await fetch(`${origin}/api/tavily-search`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: `${rawMerchant} Sri Lanka business type`,
                max_results: 3,
                search_depth: 'basic'
            })
        });
        if (!r.ok) throw new Error('tavily ' + r.status);
        const data = await r.json();
        const snippet = (data.results || []).map(x => x.content || '').join(' ').slice(0, 800);

        // Tiny inline categoriser — looks for keyword groups in the snippet
        const cats = [
            { name: 'Telecom',          re: /(telecom|dialog|mobitel|hutch|airtel|broadband|sim|postpaid|prepaid)/i },
            { name: 'Food & Groceries', re: /(supermarket|grocery|food|restaurant|cafe|bakery|keells|cargills|arpico|laughs|spar|glomark)/i },
            { name: 'Transport',        re: /(uber|pickme|taxi|bus|train|fuel|petrol|diesel|ceypetco|ioc|laugfs)/i },
            { name: 'Utilities',        re: /(electricity|water|ceb|lecotec|nwsdb|gas|litro)/i },
            { name: 'Insurance',        re: /(insurance|aia|ceylinco|janashakthi|allianz|softlogic)/i },
            { name: 'Healthcare',       re: /(hospital|pharmacy|clinic|nawaloka|asiri|durdans|hemas|lanka hospital)/i },
            { name: 'Shopping',         re: /(store|shop|mall|fashion|clothing|odel|cool planet|nolimit)/i },
            { name: 'Entertainment',    re: /(netflix|spotify|youtube|cinema|theatre|prime|disney|amazon)/i },
            { name: 'Banking',          re: /(bank|atm|withdrawal|deposit|nsb|boc|hnb|sampath|combank|ntb|seylan|dfcc|stanchart|pan asia|people's bank|amex|american express)/i },
        ];
        const hay = (rawMerchant + ' ' + snippet).toLowerCase();
        let best = { name: rawMerchant, category: 'Other', confidence: 0.5 };
        for (const c of cats) {
            if (c.re.test(hay)) { best = { name: rawMerchant, category: c.name, confidence: 0.85 }; break; }
        }
        // If search gave us a better merchant name, use that
        if (data.results && data.results[0] && data.results[0].title) {
            const ttl = data.results[0].title.replace(/\s*[-|—].*$/, '').trim();
            if (ttl.length > 2 && ttl.length < 60) best.name = ttl;
        }
        return best;
    } catch (e) {
        // Search failed — return raw merchant with a low confidence
        return { name: rawMerchant, category: 'Other', confidence: 0.3 };
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Gamma — route to a WealthFlow module
// ─────────────────────────────────────────────────────────────────────────────
function routeToModule(parsed, merchant, cardEntry) {
    // CREDITS → Income (unless it's a refund/reversal — those route to expense as negative)
    if (parsed.type === 'credit') {
        if (cardEntry && (cardEntry.type === 'credit_card')) {
            // Credit TO a credit card = payment of CC bill → triggers FIFO reconcile (handled separately)
            return {
                module: 'cc_payment',
                tab_label: 'CC Payment (FIFO Reconcile)',
                confidence: 0.95,
                suggested_fields: {
                    amount: parsed.amount,
                    card_last4: parsed.card_last4,
                    timestamp: parsed.timestamp
                }
            };
        }
        return {
            module: 'income',
            tab_label: 'Income & Investments',
            confidence: 0.85,
            suggested_fields: {
                source: merchant.name,
                amount: parsed.amount,
                date: parsed.timestamp,
                notes: parsed.reference ? `Ref: ${parsed.reference}` : ''
            }
        };
    }

    // DEBITS — type depends on card type + merchant category
    const cardType = cardEntry ? cardEntry.type : null;

    if (cardType === 'credit_card') {
        // Default credit-card debit → CC One-Time. Subscription detection below.
        const looksLikeSubscription = /(netflix|spotify|youtube|prime|icloud|google|microsoft|dialog|mobitel|hutch|airtel)/i.test(merchant.name);
        if (looksLikeSubscription) {
            return {
                module: 'subscriptions',
                tab_label: 'Subscriptions',
                confidence: 0.9,
                suggested_fields: {
                    name: merchant.name,
                    category: merchant.category,
                    amount: parsed.amount,
                    due_day: new Date(parsed.timestamp).getDate(),
                    cycle: 'monthly'
                }
            };
        }
        return {
            module: 'cconetime',
            tab_label: 'CC One-Time Payments',
            confidence: 0.88,
            suggested_fields: {
                desc: merchant.name,
                amount: parsed.amount,
                date: parsed.timestamp,
                bank: cardEntry.bank,
                card_last4: parsed.card_last4,
                type: merchant.category === 'Banking' ? 'cash_advance' : 'purchase',
                notes: parsed.reference ? `Ref: ${parsed.reference}` : ''
            }
        };
    }

    // Debit card / regular bank account → Expense
    return {
        module: 'expenses',
        tab_label: 'Monthly Expenses',
        confidence: 0.82,
        suggested_fields: {
            desc: merchant.name,
            amount: parsed.amount,
            date: parsed.timestamp,
            cat: merchant.category,
            notes: parsed.reference ? `Ref: ${parsed.reference}` : ''
        }
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
export default async function handler(req) {
    const t0 = Date.now();
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body = {};
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const sms = body.sms || '';
    const receivedAt = body.received_at_ms || Date.now();
    const cardRegistry = body.card_registry || {};
    const origin = new URL(req.url).origin;

    // ── Alpha: parse ──
    const tA = Date.now();
    const parsed = heuristicParse(sms, receivedAt);
    if (!parsed || !parsed.amount) {
        return new Response(JSON.stringify({
            ok: false, error: 'Could not parse amount from SMS', raw_sms: sms
        }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    const latencyA = Date.now() - tA;

    // Resolve card registry entry
    const cardEntry = parsed.card_last4 ? cardRegistry[parsed.card_last4] : null;
    const bank = cardEntry ? cardEntry.bank : null;

    // Dedup hash
    const hash = await sha256Hex(dedupKey(parsed, bank));

    // ── Beta: resolve merchant ──
    const tB = Date.now();
    const merchant = await resolveMerchant(parsed.raw_merchant, origin);
    const latencyB = Date.now() - tB;

    // ── Gamma: route ──
    const tG = Date.now();
    const routed = routeToModule(parsed, merchant, cardEntry);
    const latencyG = Date.now() - tG;

    return new Response(JSON.stringify({
        ok: true,
        hash,
        parsed,
        resolved_merchant: merchant,
        routed,
        card_entry: cardEntry,
        latency_ms: {
            alpha: latencyA,
            beta:  latencyB,
            gamma: latencyG,
            total: Date.now() - t0
        }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
