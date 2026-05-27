// =============================================================================
// WealthFlow FIFO Reconciliation Engine v1.0
//
// When a "credit to credit-card" event arrives (user paid their CC bill),
// this stateless function returns the FIFO clearance plan:
//   1. Caller sends { card_last4, payment_amount, payment_ts, debits: [...] }
//      where `debits` is the full list of outstanding CC transactions for
//      that card (cconetime + ccinstall) sorted oldest→newest in the
//      caller's app state.
//   2. Engine walks oldest→newest, marks each as settled until the
//      payment amount is exhausted. Partial settlement on the last
//      transaction is supported (remaining balance reduced, not deleted).
//   3. Returns { settled: [...ids], partial: {id, paid, remaining} | null,
//                unused: number } — caller applies these flags in Firestore.
//
// The engine is pure: no I/O, fully deterministic, sub-10 ms.
// =============================================================================

export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ ok: false, error: 'POST required' }), {
            status: 405, headers: { 'Content-Type': 'application/json' }
        });
    }
    let body;
    try { body = await req.json(); } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: 'Invalid JSON' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    const cardLast4 = String(body.card_last4 || '').trim();
    const payment   = Number(body.payment_amount || 0);
    const paymentTs = Number(body.payment_ts || Date.now());
    const debits    = Array.isArray(body.debits) ? body.debits : [];

    if (!cardLast4 || payment <= 0) {
        return new Response(JSON.stringify({
            ok: false, error: 'card_last4 and positive payment_amount required'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }

    // Filter to this card's unsettled debits (defensive — caller should pre-filter)
    const candidates = debits
        .filter(d => d
                  && String(d.card_last4 || '').trim() === cardLast4
                  && !d.settled
                  && !d.completed
                  && Number(d.amount) > 0
                  && Number(d.timestamp || d.date_ms || 0) <= paymentTs)
        .sort((a, b) => Number(a.timestamp || a.date_ms || 0)
                       - Number(b.timestamp || b.date_ms || 0));

    let remaining = payment;
    const settled = [];
    let partial = null;

    for (const d of candidates) {
        const owed = Number(d.amount);
        if (remaining >= owed - 0.005) {
            settled.push({
                id: d.id,
                module: d.module,
                amount: owed,
                settled_at: paymentTs,
                settled_by_payment: true
            });
            remaining -= owed;
        } else if (remaining > 0.005) {
            partial = {
                id: d.id,
                module: d.module,
                original_amount: owed,
                paid_portion: Number(remaining.toFixed(2)),
                remaining: Number((owed - remaining).toFixed(2)),
                partial_at: paymentTs
            };
            remaining = 0;
            break;
        } else {
            break;
        }
    }

    return new Response(JSON.stringify({
        ok: true,
        card_last4: cardLast4,
        payment_amount: payment,
        payment_ts: paymentTs,
        settled,
        partial,
        unused: Number(remaining.toFixed(2)),
        candidates_considered: candidates.length
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
