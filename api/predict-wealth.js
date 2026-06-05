// =============================================================================
// WealthFlow Predictive Wealth AI v1.0
//
// Analyses historical expense/income/loan data and returns:
//   • 6-12 month cashflow forecast (P5 / P50 / P95 via lightweight Monte Carlo)
//   • detected recurring subscriptions the user hasn't logged yet
//   • spending anomalies (Z-score > 2 against category baseline)
//   • autonomous financial advice (3-5 actionable insights)
//
// Pure Edge function. No DB calls — caller posts the data, function returns
// the analysis. Means it works offline-after-sync for the user's own data.
// =============================================================================

export const config = { runtime: 'edge' };

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function monthKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}
function lastNMonths(n) {
    const out = []; const d = new Date(); d.setDate(1);
    for (let i = 0; i < n; i++) { out.unshift(monthKey(d)); d.setMonth(d.getMonth() - 1); }
    return out;
}
function mean(arr) { return arr.length ? arr.reduce((a,b)=>a+b,0) / arr.length : 0; }
function stdev(arr) {
    if (arr.length < 2) return 0;
    const m = mean(arr);
    return Math.sqrt(arr.reduce((s, x) => s + (x - m)**2, 0) / arr.length);
}
function randn() {
    // Box-Muller
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}
function percentile(arr, p) {
    const a = arr.slice().sort((x, y) => x - y);
    const idx = Math.floor((a.length - 1) * p);
    return a[idx];
}

// ─────────────────────────────────────────────────────────────────────────────
// Recurring subscription detector — finds same-amount, same-merchant pairs
// at ~monthly cadence that aren't already in the user's subscription list
// ─────────────────────────────────────────────────────────────────────────────
function detectRecurring(expenses, knownSubs) {
    const knownNames = new Set((knownSubs || []).map(s => (s.name || '').toLowerCase().trim()));
    // Group expenses by (description, rounded amount)
    const groups = {};
    for (const e of expenses) {
        const key = (e.desc || '').toLowerCase().trim() + '|' + Math.round(Number(e.amount || 0));
        if (!groups[key]) groups[key] = [];
        groups[key].push(e);
    }
    const detected = [];
    for (const key of Object.keys(groups)) {
        const items = groups[key].sort((a, b) => (a.date_ms || 0) - (b.date_ms || 0));
        if (items.length < 3) continue;            // need at least 3 to call it recurring
        const gaps = [];
        for (let i = 1; i < items.length; i++) {
            gaps.push((items[i].date_ms - items[i-1].date_ms) / (1000*60*60*24));
        }
        const avgGap = mean(gaps);
        if (avgGap > 25 && avgGap < 35) {           // monthly cadence
            const name = items[0].desc;
            if (knownNames.has(name.toLowerCase().trim())) continue;
            detected.push({
                name,
                category: items[0].cat || 'Other',
                amount: items[items.length-1].amount,
                avg_days_between: Math.round(avgGap),
                last_seen: items[items.length-1].date_ms,
                occurrences: items.length,
                confidence: items.length >= 6 ? 0.95 : 0.75
            });
        }
    }
    return detected;
}

// ─────────────────────────────────────────────────────────────────────────────
// Anomaly detection — category-level Z-score over the last 6 months
// ─────────────────────────────────────────────────────────────────────────────
function detectAnomalies(expenses) {
    const byCatMonth = {};
    for (const e of expenses) {
        if (!e.date_ms || !e.amount) continue;
        const mk = monthKey(e.date_ms);
        const cat = e.cat || 'Other';
        byCatMonth[cat] = byCatMonth[cat] || {};
        byCatMonth[cat][mk] = (byCatMonth[cat][mk] || 0) + Number(e.amount);
    }
    const recent = lastNMonths(6);
    const anomalies = [];
    for (const cat of Object.keys(byCatMonth)) {
        const series = recent.map(mk => byCatMonth[cat][mk] || 0).filter(v => v > 0);
        if (series.length < 4) continue;
        const m = mean(series), sd = stdev(series);
        if (sd < 0.01) continue;
        const latest = series[series.length - 1];
        const z = (latest - m) / sd;
        if (Math.abs(z) > 2) {
            anomalies.push({
                category: cat,
                month: recent[recent.length - 1],
                amount: Math.round(latest),
                baseline_avg: Math.round(m),
                z_score: Number(z.toFixed(2)),
                direction: z > 0 ? 'spike' : 'drop',
                severity: Math.abs(z) > 3 ? 'high' : 'medium'
            });
        }
    }
    return anomalies;
}

// ─────────────────────────────────────────────────────────────────────────────
// Cashflow forecast — Monte Carlo against historical net flow
// ─────────────────────────────────────────────────────────────────────────────
function forecast(expenses, income, horizonMonths) {
    const exp = {}, inc = {};
    for (const e of expenses) { if (e.date_ms && e.amount) { const k = monthKey(e.date_ms); exp[k] = (exp[k]||0) + Number(e.amount); } }
    for (const i of income)   { if (i.date_ms && i.amount) { const k = monthKey(i.date_ms); inc[k] = (inc[k]||0) + Number(i.amount); } }
    const months = lastNMonths(12);
    const netFlows = months.map(mk => (inc[mk] || 0) - (exp[mk] || 0)).filter((_, i) => (inc[months[i]] || exp[months[i]]));
    if (netFlows.length < 3) {
        return { ok: false, reason: 'Not enough history (need 3+ months of data)' };
    }
    const muN = mean(netFlows);
    const sdN = stdev(netFlows) || Math.abs(muN) * 0.2 || 5000;

    const N_SIMS = 800;
    const paths = [];
    for (let s = 0; s < N_SIMS; s++) {
        const path = []; let cum = 0;
        for (let m = 0; m < horizonMonths; m++) {
            const sample = muN + sdN * randn();
            cum += sample;
            path.push(cum);
        }
        paths.push(path);
    }

    const future = [];
    const futD = new Date(); futD.setDate(1); futD.setMonth(futD.getMonth() + 1);
    for (let m = 0; m < horizonMonths; m++) {
        const col = paths.map(p => p[m]);
        future.push({
            month: monthKey(futD),
            p5:  Math.round(percentile(col, 0.05)),
            p25: Math.round(percentile(col, 0.25)),
            p50: Math.round(percentile(col, 0.50)),
            p75: Math.round(percentile(col, 0.75)),
            p95: Math.round(percentile(col, 0.95))
        });
        futD.setMonth(futD.getMonth() + 1);
    }
    return {
        ok: true,
        history_months: netFlows.length,
        mu_net: Math.round(muN),
        sd_net: Math.round(sdN),
        horizon_months: horizonMonths,
        future,
        prob_negative_in_12mo: paths.filter(p => p[Math.min(11, horizonMonths-1)] < 0).length / N_SIMS
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// Insight generator — deterministic rule-based observations
// ─────────────────────────────────────────────────────────────────────────────
function generateInsights({ forecast: f, recurring, anomalies, expenses, income }) {
    const out = [];

    if (f && f.ok) {
        if (f.prob_negative_in_12mo > 0.30) {
            out.push({
                kind: 'warning', severity: 'high',
                icon: '⚠️',
                title: 'Cashflow risk detected',
                body: `Based on the last ${f.history_months} months, there's a ${Math.round(f.prob_negative_in_12mo*100)}% probability that your net wealth will be negative within 12 months. Consider trimming discretionary spending.`
            });
        } else if (f.mu_net > 0) {
            out.push({
                kind: 'positive', severity: 'low',
                icon: '📈',
                title: 'Healthy cashflow',
                body: `You average a net positive of LKR ${f.mu_net.toLocaleString()} per month. At this rate, your 12-month median wealth gain is LKR ${(f.future[Math.min(11, f.future.length-1)].p50).toLocaleString()}.`
            });
        }
    }

    if (recurring.length) {
        out.push({
            kind: 'suggestion', severity: 'medium',
            icon: '🔁',
            title: `${recurring.length} undocumented recurring charge${recurring.length>1?'s':''} found`,
            body: `Charges like "${recurring[0].name}" (LKR ${recurring[0].amount.toLocaleString()}/mo) appear monthly but aren't in your Subscriptions tab. Adding them gives you better forecasting accuracy.`,
            payload: recurring
        });
    }

    for (const a of anomalies.slice(0, 3)) {
        out.push({
            kind: 'anomaly', severity: a.severity,
            icon: a.direction === 'spike' ? '🚨' : '🌡️',
            title: `${a.direction === 'spike' ? 'Spike' : 'Drop'} in ${a.category}`,
            body: `This month's ${a.category} spend is LKR ${a.amount.toLocaleString()}, which is ${Math.abs(a.z_score).toFixed(1)}σ ${a.direction === 'spike' ? 'above' : 'below'} your ${a.baseline_avg.toLocaleString()} baseline.`,
            payload: a
        });
    }

    return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────
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

    const expenses  = Array.isArray(body.expenses)      ? body.expenses      : [];
    const income    = Array.isArray(body.income)        ? body.income        : [];
    const subs      = Array.isArray(body.subscriptions) ? body.subscriptions : [];
    const horizon   = Math.min(24, Math.max(3, Number(body.horizon_months) || 12));

    // Normalise dates → date_ms (some records have ISO strings)
    const norm = arr => arr.map(x => {
        if (x.date_ms) return x;
        const ts = x.date ? new Date(x.date).getTime() : (x.timestamp || x.createdAt || 0);
        return { ...x, date_ms: ts };
    });
    const E = norm(expenses), I = norm(income);

    const recurring = detectRecurring(E, subs);
    const anomalies = detectAnomalies(E);
    const fc        = forecast(E, I, horizon);
    const insights  = generateInsights({ forecast: fc, recurring, anomalies, expenses: E, income: I });

    return new Response(JSON.stringify({
        ok: true,
        generated_at: new Date().toISOString(),
        horizon_months: horizon,
        forecast: fc,
        recurring,
        anomalies,
        insights
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}
