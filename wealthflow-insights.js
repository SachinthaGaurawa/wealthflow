/* =============================================================================
 *  WealthFlow — Intelligence Layer  v1.0   ·   window.WFInsights
 *
 *  Your screens showed you WHAT HAPPENED. They never told you WHAT TO DO.
 *
 *    · Cards        — you entered a statement day and a due day, and NOTHING in the
 *                     app ever read them. Every "dueDay" in the codebase belonged to
 *                     Subscriptions. Your AMEX bill could go overdue in silence.
 *    · Subscriptions— every price rise you have ever paid is already stored in
 *                     monthOverrides. Nothing has ever looked at it.
 *    · Dashboard    — six widgets of history, zero decisions.
 *
 *  This reads what is already there and turns it into ranked, dated actions.
 *  Read-only: it never writes to your data.
 * ============================================================================= */
(function () {
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_INSIGHTS === '1.1') return;
    W.WF_INSIGHTS = '1.1';

    var SEV = { critical: 0, high: 1, medium: 2, low: 3 };
    var DEFAULT_APR = 28;          // typical Sri Lankan credit-card APR — an ESTIMATE, always labelled

    function DB() { return W.DB; }
    function arr(k) { try { var a = DB() && DB().get(k); return Array.isArray(a) ? a : []; } catch (_) { return []; } }
    function reg() { try { return (W.wfCardRegistry && W.wfCardRegistry.get && W.wfCardRegistry.get()) || {}; } catch (_) { return {}; } }
    function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }
    function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }
    function daysInMonth(y, m) { return new Date(y, m + 1, 0).getDate(); }

    /* Next calendar occurrence of a day-of-month, clamped to short months. */
    function nextOn(day, from) {
        day = Math.max(1, Math.min(31, Math.round(num(day))));
        var t = from ? new Date(from) : new Date(); t.setHours(0, 0, 0, 0);
        var y = t.getFullYear(), m = t.getMonth();
        var d = new Date(y, m, Math.min(day, daysInMonth(y, m)));
        if (d < t) { m += 1; if (m > 11) { m = 0; y += 1; } d = new Date(y, m, Math.min(day, daysInMonth(y, m))); }
        return d;
    }
    function daysBetween(a, b) { return Math.round((b - a) / 86400000); }
    function money(n) { try { return 'LKR ' + Math.round(num(n)).toLocaleString('en-LK'); } catch (_) { return 'LKR ' + Math.round(num(n)); } }

    /* Attribute a charge/payment to a card. Mirrors the Cards screen exactly, including
       the legacy rescue: rows imported before v7.62.0 carry no last-4, so a bank match
       is used — but ONLY when that bank maps to exactly one card, never double-counting. */
    function mine(rows, last4, card, bankUnique) {
        return (rows || []).filter(function (r) {
            var rl = String((r && (r.card_last4 || r.last4)) || '');
            if (rl) return rl === String(last4);
            if (!bankUnique || !card || !card.bank) return false;
            var rb = String((r && r.bank) || '').toLowerCase().trim();
            return !!rb && rb === String(card.bank).toLowerCase().trim();
        });
    }

    /* ── CARDS ─────────────────────────────────────────────────────────────── */
    function cards() {
        var R = reg(), keys = Object.keys(R), out = [];
        if (!keys.length) return out;
        var bankN = {};
        keys.forEach(function (k) { var b = String((R[k] && R[k].bank) || '').toLowerCase().trim(); if (b) bankN[b] = (bankN[b] || 0) + 1; });
        var uniq = function (k) { var b = String((R[k] && R[k].bank) || '').toLowerCase().trim(); return !!b && bankN[b] === 1; };

        var charges = arr('cconetime'), pays = arr('ccPayments');
        var today = new Date(); today.setHours(0, 0, 0, 0);

        keys.forEach(function (k) {
            var c = R[k];
            if (!c || c.type !== 'credit_card') return;
            var u = uniq(k);
            var mineC = mine(charges, k, c, u);
            var outstanding = mineC.filter(function (x) { return !x.paid; })
                                   .reduce(function (s, x) { return s + num(x.combinedTotal || x.amount); }, 0);
            var label = (c.name || c.bank || 'Card') + ' ••••' + k;

            // 1) payment due — the thing the app has NEVER told you
            if (c.dueDay && outstanding > 0) {
                var due = nextOn(c.dueDay);
                var d = daysBetween(today, due);
                // if the due day already passed this month and money is still owed, it is late
                var lastDue = new Date(due); lastDue.setMonth(lastDue.getMonth() - 1);
                var overdueDays = daysBetween(lastDue, today);
                if (d > 20 && overdueDays > 0 && overdueDays <= 25) {
                    out.push({ sev: 'critical', kind: 'card_overdue', card: k, title: label + ' is OVERDUE',
                        body: money(outstanding) + ' was due on the ' + c.dueDay + ' — ' + overdueDays + ' day(s) ago.',
                        action: 'Pay it now', amount: outstanding });
                } else if (d <= 5) {
                    out.push({ sev: d <= 2 ? 'critical' : 'high', kind: 'card_due', card: k,
                        title: label + ' due in ' + d + ' day' + (d === 1 ? '' : 's'),
                        body: money(outstanding) + ' outstanding · due on the ' + c.dueDay + '.',
                        action: 'Pay before ' + due.toDateString().slice(4, 10), amount: outstanding });
                } else if (d <= 10) {
                    out.push({ sev: 'medium', kind: 'card_due_soon', card: k,
                        title: label + ' due in ' + d + ' days',
                        body: money(outstanding) + ' outstanding.', amount: outstanding });
                }
            }

            // 2) statement closing — spend after it and you get a month's free float
            if (c.statementDay) {
                var st = nextOn(c.statementDay), sd = daysBetween(today, st);
                if (sd <= 3) {
                    out.push({ sev: 'low', kind: 'card_statement', card: k,
                        title: label + ' statement closes in ' + sd + ' day' + (sd === 1 ? '' : 's'),
                        body: 'Anything you buy after the ' + c.statementDay + ' lands on next month\u2019s bill.' });
                }
            }

            // 3) utilization — what actually moves a credit score
            var lim = num(c.creditLimit);
            if (lim > 0 && outstanding > 0) {
                var util = outstanding / lim;
                if (util >= 0.7) {
                    out.push({ sev: 'high', kind: 'card_util', card: k,
                        title: label + ' is ' + Math.round(util * 100) + '% used',
                        body: money(outstanding) + ' of ' + money(lim) + '. Above 70% weighs on your credit score — CRIB sees it.',
                        amount: outstanding - lim * 0.3 });
                } else if (util >= 0.3) {
                    out.push({ sev: 'low', kind: 'card_util', card: k,
                        title: label + ' is ' + Math.round(util * 100) + '% used',
                        body: 'Bringing it under 30% (' + money(lim * 0.3) + ') is the cheapest way to lift your score.' });
                }
            }

            // 4) the cost of carrying it — factual, with the assumption stated
            if (outstanding > 0) {
                var apr = num(c.apr) > 0 ? num(c.apr) : DEFAULT_APR;
                var monthly = outstanding * (apr / 100) / 12;
                if (monthly >= 250) {
                    out.push({ sev: 'medium', kind: 'card_interest', card: k,
                        title: 'Carrying ' + label + ' costs about ' + money(monthly) + ' a month',
                        body: 'At ' + apr + '% APR' + (num(c.apr) > 0 ? '' : ' (assumed — set it on the card to be exact)') +
                              ', that is ' + money(monthly * 12) + ' a year in interest alone.', amount: monthly });
                }
            }
        });
        return out;
    }

    /* ── SUBSCRIPTIONS ─────────────────────────────────────────────────────── */
    var CYCLE_PER_YEAR = { monthly: 12, quarterly: 4, yearly: 1, annual: 1, weekly: 52 };
    function perYear(s) { return CYCLE_PER_YEAR[String(s.cycle || 'monthly').toLowerCase()] || 12; }

    /* monthOverrides is a { "YYYY-MM": amount } map the app has always written and never read. */
    function priceSeries(s) {
        var mo = s.monthOverrides || {};
        return Object.keys(mo).filter(function (k) { return /^\d{4}-\d{2}$/.test(k); }).sort()
            .map(function (k) { return { month: k, amount: num(mo[k]) }; })
            .filter(function (p) { return p.amount > 0; });
    }

    function subs() {
        var list = arr('subscriptions'), out = [];
        if (!list.length) return out;
        var today = new Date(); today.setHours(0, 0, 0, 0);

        // annual cost — nobody has ever added this up for you
        var yearly = list.reduce(function (t, s) { return t + num(s.amount) * perYear(s); }, 0);
        if (yearly > 0) {
            var biggest = list.slice().sort(function (a, b) { return num(b.amount) * perYear(b) - num(a.amount) * perYear(a); })[0];
            out.push({ sev: 'low', kind: 'sub_total',
                title: list.length + ' subscription' + (list.length === 1 ? '' : 's') + ' cost you ' + money(yearly) + ' a year',
                body: biggest ? ('The biggest is ' + biggest.name + ' at ' + money(num(biggest.amount) * perYear(biggest)) + ' a year.') : '',
                amount: yearly });
        }

        list.forEach(function (s) {
            var ser = priceSeries(s);

            // 1) PRICE RISE — the data was always there
            if (ser.length >= 2) {
                var last = ser[ser.length - 1], prev = ser[ser.length - 2];
                if (prev.amount > 0 && last.amount > prev.amount * 1.03) {
                    var up = last.amount - prev.amount, pct = Math.round((up / prev.amount) * 100);
                    out.push({ sev: pct >= 20 ? 'high' : 'medium', kind: 'sub_price_up', sub: s.id,
                        title: s.name + ' went up ' + money(up) + ' (+' + pct + '%)',
                        body: money(prev.amount) + ' \u2192 ' + money(last.amount) + ' in ' + last.month +
                              '. That is ' + money(up * perYear(s)) + ' more a year.', amount: up * perYear(s) });
                }
            }

            // 2) DORMANT — you are still tracking it but nothing has been charged
            var lastMonth = ser.length ? ser[ser.length - 1].month : null;
            if (lastMonth) {
                var parts = lastMonth.split('-');
                var lastDate = new Date(+parts[0], +parts[1] - 1, 28);
                var gap = daysBetween(lastDate, today);
                if (gap > 60) {
                    out.push({ sev: 'medium', kind: 'sub_dormant', sub: s.id,
                        title: s.name + ' has not been charged since ' + lastMonth,
                        body: 'That is ' + Math.round(gap / 30) + ' months. If you cancelled it, remove it \u2014 it is inflating your forecast by ' +
                              money(num(s.amount) * perYear(s)) + ' a year.', amount: num(s.amount) * perYear(s) });
                }
            }

            // 3) RENEWAL — due within a week
            if (s.dueDay) {
                var due = nextOn(s.dueDay), d = daysBetween(today, due);
                if (d <= 3) {
                    out.push({ sev: d <= 1 ? 'high' : 'low', kind: 'sub_renew', sub: s.id,
                        title: s.name + ' renews in ' + d + ' day' + (d === 1 ? '' : 's'),
                        body: money(s.amount) + ' on the ' + s.dueDay + '.', amount: num(s.amount) });
                }
            }
        });

        // 4) DUPLICATES — the old import named a subscription after the RAW bank line, so
        //    two statements spelling the same merchant slightly differently made TWO of it.
        //    Group by the CLEAN merchant name, not the messy stored one.
        var groups = findDuplicateSubs();
        groups.forEach(function (g) {
            var nm = (W.WFMerchants && W.WFMerchants.cleanName) ? W.WFMerchants.cleanName(g[0].name) : g[0].name;
            var waste = g.slice(1).reduce(function (t, s) { return t + num(s.amount) * perYear(s); }, 0);
            out.push({ sev: 'high', kind: 'sub_dupe', sub: g[0].id, fix: 'mergeSubs',
                title: g.length + ' duplicate subscriptions for ' + nm,
                body: 'They were named after the raw bank line, so the same merchant was created ' + g.length +
                      ' times. Your forecast is overstated by ' + money(waste) + ' a year.',
                action: 'Merge them', amount: waste });
        });
        return out;
    }

    /* ── repair the duplicates the old naming already created ────────────────── */
    function subKey(s) {
        try {
            if (W.WFMerchants && W.WFMerchants.cleanName && s && s.name) return norm(W.WFMerchants.cleanName(s.name));
        } catch (_) {}
        // strip the auto-numbering the old code appended on a name collision ("… - 1")
        return norm(String((s && s.name) || '').replace(/\s*-\s*\d+\s*$/, ''));
    }
    function findDuplicateSubs() {
        var by = {};
        arr('subscriptions').forEach(function (s) {
            var k = subKey(s); if (!k) return;
            (by[k] = by[k] || []).push(s);
        });
        return Object.keys(by).filter(function (k) { return by[k].length > 1; }).map(function (k) { return by[k]; });
    }
    // Keep the richest record, fold the others' history into it, delete them. Never loses data.
    function mergeDuplicateSubs() {
        var groups = findDuplicateSubs();
        if (!groups.length) return { groups: 0, removed: 0 };
        var list = arr('subscriptions').slice(), kill = {}, removed = 0;
        groups.forEach(function (g) {
            var score = function (s) { return Object.keys(s.monthOverrides || {}).length * 10 + (s.history || []).length; };
            g.sort(function (a, b) { return score(b) - score(a); });
            var keep = g[0];
            keep.monthOverrides = Object.assign({}, keep.monthOverrides || {});
            keep.history = (keep.history || []).slice();
            keep.merchantKeys = (keep.merchantKeys || []).slice();
            g.slice(1).forEach(function (d) {
                Object.keys(d.monthOverrides || {}).forEach(function (m) {
                    if (keep.monthOverrides[m] == null) keep.monthOverrides[m] = d.monthOverrides[m];
                });
                (d.history || []).forEach(function (h) { keep.history.push(h); });
                (d.merchantKeys || []).forEach(function (k) { if (keep.merchantKeys.indexOf(k) < 0) keep.merchantKeys.push(k); });
                kill[d.id] = 1; removed++;
            });
            if (W.WFMerchants && W.WFMerchants.cleanName) { try { keep.name = W.WFMerchants.cleanName(keep.name); } catch (_) {} }
            keep._ut = Date.now();
        });
        var next = list.filter(function (s) { return !kill[s.id]; });
        // Also clean the LONE survivors. A subscription with no twin still kept the ugly
        // name the old import gave it — "Kaushi's Insuarance - 1" keeps that auto-numbered
        // "- 1" forever, and "Pos Transaction …" keeps the bank's prefix.
        var renamed = 0;
        next.forEach(function (s) {
            var clean = subDisplayName(s);
            if (clean && clean !== s.name) { s.name = clean; s._ut = Date.now(); renamed++; }
        });
        try { DB().set('subscriptions', next); } catch (_) { return { groups: 0, removed: 0, renamed: 0 }; }
        return { groups: groups.length, removed: removed, renamed: renamed };
    }

    // The name a subscription SHOULD have: the clean brand, with the old auto-numbering
    // ("- 1") and the bank's prefix stripped.
    function subDisplayName(s) {
        var raw = String((s && s.name) || '').replace(/\s*-\s*\d+\s*$/, '').trim();
        if (!raw) return '';
        try {
            if (W.WFMerchants && W.WFMerchants.cleanName) {
                var c = W.WFMerchants.cleanName(raw);
                if (c && c.length >= 3 && !/^(Other|Subscription)$/i.test(c)) return c;
            }
        } catch (_) {}
        return raw;
    }

    /* ── INCOME ───────────────────────────────────────────────────────────────── */
    // The dashboard shows LKR 0.00 income beside millions in expenses and a huge negative
    // net saving. That number is HONEST — Year Income reads `incomeRecv` (money actually
    // received), and the Investments store is deliberately excluded so the same money is
    // not counted twice. But shown with no explanation it just looks broken. Say it plainly.
    function income() {
        var out = [], recv = arr('incomeRecv'), src = arr('income'), exp = arr('expenses');
        var y = new Date().getFullYear();
        var got = recv.filter(function (r) { return String(r && (r.date || r.month) || '').slice(0, 4) === String(y); })
                      .reduce(function (t, r) { return t + num(r.amount); }, 0);
        var spent = exp.filter(function (r) { return String(r && r.date || '').slice(0, 4) === String(y); })
                       .reduce(function (t, r) { return t + num(r.combinedTotal || r.amount); }, 0);
        if (got === 0 && spent > 0) {
            out.push({ sev: 'high', kind: 'income_zero',
                title: 'Year income reads zero, against ' + money(spent) + ' of spending',
                body: src.length
                    ? ('That is not a glitch. It counts money actually RECEIVED, and you have none recorded this year — your ' +
                       src.length + ' entries live on the Investments page, which is excluded on purpose so the same money is not counted twice. ' +
                       'Import a statement with your salary or credits, or add them on the Income page.')
                    : 'It counts money actually RECEIVED. Import a statement containing your credits, or add them on the Income page.',
                action: 'Add your income', amount: spent });
        }
        return out;
    }

    /* ── EXPENSES ─────────────────────────────────────────────────────────────
       74 records, LKR 4.49M, and the app never once told you anything about them.
       Everything below is read from data you already have.                        */
    // Group by the BRAND the classifier recognised, not the raw line. "Cargills Food City
    // Kuliyapitiya" and "Cargills 01" are the SAME shop — counting them as two different
    // merchants hides where your money actually goes.
    var _mkCache = {};
    function _mkey(d) {
        var raw = String(d || '');
        if (_mkCache[raw] !== undefined) return _mkCache[raw];
        var k = '';
        try {
            if (W.WFMerchants && W.WFMerchants.classify) {
                var c = W.WFMerchants.classify(raw, 'debit');
                if (c && c.matched && !/^(fee|card):/.test(c.matched)) k = String(c.matched).replace(/^[a-z]+:/, '').trim();
            }
            if (!k && W.WFMerchants && W.WFMerchants.merchantKey) k = W.WFMerchants.merchantKey(raw) || '';
        } catch (_) {}
        if (!k) k = norm(raw).slice(0, 24);
        _mkCache[raw] = k;
        return k;
    }
    function _amt(e) { return num(e && (e.combinedTotal || e.amount)); }
    function _ym(e) { return String((e && e.date) || '').slice(0, 7); }

    // A BANK FEE is supposed to repeat — three LKR 25 CEFT charges on one day is not a
    // double charge, it is three transfers. And a TRANSFER is not a merchant: telling you
    // "73% of your spending goes to Cutivation Proje" when that is money you moved, not
    // money you spent, is worse than saying nothing. Both are excluded from the merchant
    // analytics, and transfers get their own insight instead.
    var RE_NOT_MERCHANT = /\b(transfer|ceft|cash|withdrawal|deposit|atm|crm|cheque|chq|slips|standing order)\b/i;
    function isFeeRow(e) {
        var c = String((e && (e.category || e.type)) || '');
        if (/bank charge|charges/i.test(c)) return true;
        return /\b(fee|fees|charges?|levy|commission|stamp duty|vat)\b/i.test(String((e && (e.desc || e.name)) || ''));
    }
    function isMerchantRow(e) {
        if (isFeeRow(e)) return false;
        var c = String((e && (e.category || e.type)) || '');
        if (/^(transfer|cash withdrawal|bank charges|other)$/i.test(c)) return false;
        return !RE_NOT_MERCHANT.test(String((e && (e.desc || e.name)) || ''));
    }

    function expenses() {
        var all = arr('expenses'), out = [];
        if (all.length < 3) return out;
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var thisYM = today.toISOString().slice(0, 7);

        // ── 1) DOUBLE CHARGES — the same merchant, the same amount, the same day.
        //     This is REAL MONEY you can get back, and nothing has ever looked for it.
        var byDay = {};
        all.filter(isMerchantRow).forEach(function (e) {
            var k = String(e.date || '') + '|' + _mkey(e.desc || e.name) + '|' + Math.round(_amt(e));
            (byDay[k] = byDay[k] || []).push(e);
        });
        var dbl = Object.keys(byDay).filter(function (k) { return byDay[k].length > 1; }).map(function (k) { return byDay[k]; });
        if (dbl.length) {
            var lost = dbl.reduce(function (t, g) { return t + _amt(g[0]) * (g.length - 1); }, 0);
            out.push({ sev: 'critical', kind: 'exp_double',
                title: dbl.length + ' possible double charge' + (dbl.length === 1 ? '' : 's') + ' — ' + money(lost) + ' at stake',
                body: 'The same merchant billed you the same amount on the same day. ' +
                      'Top: ' + _clean(dbl[0][0].desc || dbl[0][0].name) + ' \u00d7' + dbl[0].length +
                      ' at ' + money(_amt(dbl[0][0])) + '. If it was not intentional, your bank will refund it.',
                amount: lost });
        }

        // ── 2) BANK FEES — 47 of the 208 rows in your statements were fees. Nobody added them up.
        var fees = all.filter(isFeeRow);
        var feeYear = fees.filter(function (e) { return String(e.date || '').slice(0, 4) === String(today.getFullYear()); })
                          .reduce(function (t, e) { return t + _amt(e); }, 0);
        if (feeYear > 0) {
            out.push({ sev: feeYear > 10000 ? 'high' : 'medium', kind: 'exp_fees',
                title: 'You paid ' + money(feeYear) + ' in bank fees this year',
                body: fees.length + ' charges. Fees are the easiest money in your whole budget to get rid of — most are avoidable by changing HOW you pay, not WHAT you pay.',
                amount: feeYear });
        }

        // ── 3) ANOMALY — a single charge far above your normal for that merchant.
        var byM = {};
        all.filter(isMerchantRow).forEach(function (e) { var k = _mkey(e.desc || e.name); if (k) (byM[k] = byM[k] || []).push(e); });
        Object.keys(byM).forEach(function (k) {
            var g = byM[k]; if (g.length < 3) return;
            var amts = g.map(_amt).filter(function (a) { return a > 0; });
            if (amts.length < 3) return;
            var sorted = amts.slice().sort(function (a, b) { return a - b; });
            var med = sorted[Math.floor(sorted.length / 2)];
            if (med <= 0) return;
            var recent = g.slice().sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); })[0];
            var r = _amt(recent);
            if (r > med * 3 && r - med > 3000) {
                var nm = _clean(recent.desc || recent.name);
                out.push({ sev: 'high', kind: 'exp_anomaly',
                    title: money(r) + ' at ' + nm + ' — ' + (r / med).toFixed(1) + '\u00d7 your normal',
                    body: 'You usually pay about ' + money(med) + ' there (' + g.length + ' visits). This one is ' + money(r - med) + ' more. Worth a look.',
                    amount: r - med });
            }
        });

        // ── 4) WHERE YOUR MONEY ACTUALLY GOES — concentration.
        var totals = {}, grand = 0;
        all.filter(isMerchantRow).filter(function (e) { return String(e.date || '').slice(0, 4) === String(today.getFullYear()); })
           .forEach(function (e) { var k = _mkey(e.desc || e.name); if (!k) return; totals[k] = (totals[k] || 0) + _amt(e); grand += _amt(e); });
        var top = Object.keys(totals).sort(function (a, b) { return totals[b] - totals[a]; }).slice(0, 3);
        if (grand > 0 && top.length === 3) {
            var share = top.reduce(function (t, k) { return t + totals[k]; }, 0) / grand;
            if (share >= 0.35) {
                out.push({ sev: 'low', kind: 'exp_concentration',
                    title: Math.round(share * 100) + '% of your spending goes to just 3 places',
                    body: top.map(function (k) { return _title2(k) + ' ' + money(totals[k]); }).join(' \u00b7 ') +
                          '. Cutting 10% from these three saves you more than cutting 50% from everything else.',
                    amount: grand * share * 0.1 });
            }
        }

        // ── 5) A RECURRING BILL YOU ARE NOT TRACKING.
        var subs = arr('subscriptions'), known = {};
        subs.forEach(function (x) { known[_mkey(x.name)] = 1; });
        Object.keys(byM).forEach(function (k) {
            if (known[k]) return;
            var g = byM[k];
            var months = {}; g.forEach(function (e) { var m = _ym(e); if (m) months[m] = 1; });
            var mc = Object.keys(months).length;
            if (mc < 3) return;                                  // in 3+ separate months
            var amts = g.map(_amt);
            var avg = amts.reduce(function (a, b) { return a + b; }, 0) / amts.length;
            var spread = Math.max.apply(null, amts) - Math.min.apply(null, amts);
            if (avg > 500 && spread <= avg * 0.25) {             // and a steady amount
                out.push({ sev: 'medium', kind: 'exp_recurring',
                    title: _title2(k) + ' looks like a bill you are not tracking',
                    body: 'Charged in ' + mc + ' different months at about ' + money(avg) +
                          ' each. That is ' + money(avg * 12) + ' a year sitting outside your Subscriptions.',
                    amount: avg * 12 });
            }
        });

        // ── 5b) A TRANSFER THAT DWARFS EVERYTHING ELSE. It is not shopping — but if one
        //      movement is most of your outflow, you should still see it named.
        var moves = all.filter(function (e) { return !isMerchantRow(e) && !isFeeRow(e); });
        var moveTot = moves.reduce(function (t, e) { return t + _amt(e); }, 0);
        var spendTot = all.reduce(function (t, e) { return t + _amt(e); }, 0);
        if (spendTot > 0 && moveTot / spendTot > 0.5 && moves.length) {
            var big = moves.slice().sort(function (a, b) { return _amt(b) - _amt(a); })[0];
            out.push({ sev: 'low', kind: 'exp_transfers',
                title: money(moveTot) + ' of your outflow was moved, not spent',
                body: Math.round(moveTot / spendTot * 100) + '% of what left your account was transfers, cash and cheques \u2014 not purchases. ' +
                      'The largest was ' + money(_amt(big)) + ' (' + _clean(big.desc || big.name) + '). ' +
                      'Your real spending is ' + money(spendTot - moveTot) + '.',
                amount: moveTot });
        }

        // ── 6) THIS MONTH vs YOUR NORMAL.
        var byMonth = {};
        all.forEach(function (e) { var m = _ym(e); if (m) byMonth[m] = (byMonth[m] || 0) + _amt(e); });
        var months = Object.keys(byMonth).filter(function (m) { return m < thisYM; }).sort();
        if (months.length >= 2 && byMonth[thisYM]) {
            var hist = months.slice(-3).map(function (m) { return byMonth[m]; });
            var mean = hist.reduce(function (a, b) { return a + b; }, 0) / hist.length;
            var now = byMonth[thisYM];
            var day = today.getDate(), dim = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
            var pace = now / Math.max(1, day) * dim;             // where this month is heading
            if (mean > 0 && pace > mean * 1.25) {
                out.push({ sev: 'high', kind: 'exp_pace',
                    title: 'This month is heading for ' + money(pace) + ' — ' + Math.round((pace / mean - 1) * 100) + '% above normal',
                    body: money(now) + ' spent in ' + day + ' days. Your last ' + hist.length + ' months averaged ' + money(mean) + '.',
                    amount: pace - mean });
            }
        }
        return out;
    }
    function _title2(x) { return String(x || '').replace(/\b[a-z]/g, function (c) { return c.toUpperCase(); }); }
    // Never show the raw bank line to a human.
    function _clean(d) {
        try { if (W.WFMerchants && W.WFMerchants.cleanName) { var c = W.WFMerchants.cleanName(d); if (c && c.length >= 3) return c.slice(0, 30); } } catch (_) {}
        return String(d || '').slice(0, 30);
    }

    /* ── INCOME (beyond the zero-income notice) ───────────────────────────────── */
    function incomeIntel() {
        var recv = arr('incomeRecv'), out = [];
        if (recv.length < 2) return out;
        var today = new Date(); today.setHours(0, 0, 0, 0);
        var thisYM = today.toISOString().slice(0, 7);

        var byMonth = {};
        recv.forEach(function (r) {
            var m = r.month || String(r.date || '').slice(0, 7);
            if (m) byMonth[m] = (byMonth[m] || 0) + num(r.amount);
        });
        var ms = Object.keys(byMonth).sort();

        // income DROP — the single most important thing a finance app can tell you
        if (ms.length >= 3) {
            var prev = ms.filter(function (m) { return m < thisYM; }).slice(-3);
            var mean = prev.reduce(function (t, m) { return t + byMonth[m]; }, 0) / Math.max(1, prev.length);
            var now = byMonth[thisYM] || 0;
            if (mean > 0 && now > 0 && now < mean * 0.7) {
                out.push({ sev: 'high', kind: 'inc_drop',
                    title: 'Income is down ' + Math.round((1 - now / mean) * 100) + '% this month',
                    body: money(now) + ' so far, against a ' + money(mean) + ' average. At your current spending you have a ' + money(mean - now) + ' hole to cover.',
                    amount: mean - now });
            }
        }
        // CONCENTRATION RISK — one source paying for everything
        var bySrc = {}, tot = 0;
        recv.filter(function (r) { return String(r.date || r.month || '').slice(0, 4) === String(today.getFullYear()); })
            .forEach(function (r) { var k = norm(r.name || r.type || 'other'); bySrc[k] = (bySrc[k] || 0) + num(r.amount); tot += num(r.amount); });
        var srcs = Object.keys(bySrc);
        if (tot > 0 && srcs.length > 1) {
            var biggest = srcs.sort(function (a, b) { return bySrc[b] - bySrc[a]; })[0];
            var sh = bySrc[biggest] / tot;
            if (sh >= 0.85) {
                out.push({ sev: 'medium', kind: 'inc_concentration',
                    title: Math.round(sh * 100) + '% of your income comes from one source',
                    body: 'If ' + _title2(biggest) + ' stopped tomorrow you would lose ' + money(bySrc[biggest]) + ' a year. That is the single biggest risk in your finances.',
                    amount: bySrc[biggest] });
            }
        }
        return out;
    }

    /* ── THE BRIEF — one ranked list for the Dashboard ─────────────────────── */
    function brief(limit) {
        var all = [];
        try { all = all.concat(cards()); } catch (_) {}
        try { all = all.concat(subs()); } catch (_) {}
        try { all = all.concat(income()); } catch (_) {}
        try { all = all.concat(expenses()); } catch (_) {}
        try { all = all.concat(incomeIntel()); } catch (_) {}
        all.sort(function (a, b) {
            var s = SEV[a.sev] - SEV[b.sev];
            return s !== 0 ? s : (num(b.amount) - num(a.amount));   // then by money at stake
        });
        return all.slice(0, Math.max(1, limit || 5));
    }

    /* ── the strip you actually see ─────────────────────────────────────────── */
    var TONE = {
        critical: ['#ff5c5c', 'rgba(255,92,92,.13)', 'rgba(255,92,92,.28)'],
        high:     ['#f0b34e', 'rgba(245,158,11,.11)', 'rgba(245,158,11,.24)'],
        medium:   ['#7fb2ff', 'rgba(127,178,255,.09)', 'rgba(127,178,255,.2)'],
        low:      ['#8d99ad', 'rgba(255,255,255,.035)', 'rgba(255,255,255,.08)']
    };
    var GLYPH = {
        card_overdue: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
        card_due: 'M3 10h18M7 3v4M17 3v4M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z',
        card_due_soon: 'M3 10h18M7 3v4M17 3v4M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z',
        card_statement: 'M3 10h18M5 21h14a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2z',
        card_util: 'M12 20V10M18 20V4M6 20v-4',
        card_interest: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
        sub_price_up: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
        sub_dormant: 'M12 6v6l4 2M12 22a10 10 0 1 1 0-20 10 10 0 0 1 0 20z',
        sub_dupe: 'M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
        sub_renew: 'M23 4v6h-6M1 20v-6h6M20.5 9A9 9 0 0 0 5.6 5.6L1 10m22 4l-4.6 4.4A9 9 0 0 1 3.5 15',
        sub_total: 'M3 3v18h18M18.7 8L13 13.7l-3-3L6 15',
        income_zero: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
        exp_double: 'M20 9H11a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2zM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1',
        exp_fees: 'M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
        exp_anomaly: 'M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
        exp_concentration: 'M21.2 15.9A10 10 0 1 1 8.1 2.8M22 12A10 10 0 0 0 12 2v10z',
        exp_recurring: 'M23 4v6h-6M1 20v-6h6M20.5 9A9 9 0 0 0 5.6 5.6L1 10m22 4l-4.6 4.4A9 9 0 0 1 3.5 15',
        exp_pace: 'M23 6l-9.5 9.5-5-5L1 18M17 6h6v6',
        exp_transfers: 'M17 1l4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3',
        inc_drop: 'M23 18l-9.5-9.5-5 5L1 6M17 18h6v-6',
        inc_concentration: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z'
    };
    function esc(x) { return String(x == null ? '' : x).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

    function styleOnce() {
        if (document.getElementById('wfx-css')) return;
        var st = document.createElement('style'); st.id = 'wfx-css';
        st.textContent = [
            '.wfx-wrap{display:flex;flex-direction:column;gap:8px}',
            '.wfx-hdr{display:flex;align-items:center;gap:8px;margin:0 2px 4px;font-size:11px;font-weight:800;letter-spacing:.7px;text-transform:uppercase;color:var(--muted,#8d99ad)}',
            '.wfx-hdr span{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:700;font-size:11px;color:var(--muted,#8d99ad)}',
            '.wfx{display:flex;gap:11px;align-items:flex-start;padding:11px 12px;border-radius:13px;border:1px solid;line-height:1.42}',
            '.wfx-ic{flex:0 0 auto;width:30px;height:30px;border-radius:9px;display:grid;place-items:center;background:rgba(255,255,255,.05)}',
            '.wfx-t{font-size:13px;font-weight:750;color:var(--text,#eef2f8);margin-bottom:2px}',
            '.wfx-b{font-size:11.5px;color:var(--muted,#8d99ad)}',
            '.wfx-a{display:inline-block;margin-top:6px;font-size:11px;font-weight:750;padding:3px 9px;border-radius:999px;background:rgba(255,255,255,.06)}',
            '.wfx-ok{display:flex;gap:9px;align-items:center;padding:13px;border-radius:13px;border:1px solid rgba(52,211,153,.22);background:rgba(52,211,153,.07);color:#34d399;font-size:12.5px;font-weight:650}'
        ].join('');
        document.head.appendChild(st);
    }

    function tile(it) {
        var t = TONE[it.sev] || TONE.low;
        var path = GLYPH[it.kind] || GLYPH.card_util;
        return '<div class="wfx" style="border-color:' + t[2] + ';background:' + t[1] + '">' +
            '<div class="wfx-ic" style="color:' + t[0] + '"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="' + path + '"/></svg></div>' +
            '<div style="min-width:0"><div class="wfx-t">' + esc(it.title) + '</div>' +
            (it.body ? '<div class="wfx-b">' + esc(it.body) + '</div>' : '') +
            (it.action ? (it.fix
                ? '<button type="button" class="wfx-a wfx-fix" data-fix="' + esc(it.fix) + '" style="color:' + t[0] + ';border:1px solid ' + t[2] + ';cursor:pointer;background:rgba(255,255,255,.06)">' + esc(it.action) + '</button>'
                : '<div class="wfx-a" style="color:' + t[0] + '">' + esc(it.action) + '</div>') : '') +
            '</div></div>';
    }

    /* Paint a list of insights into an element. Silent (renders nothing) when all is well
       on a sub-panel; the dashboard shows an explicit all-clear instead. */
    function renderInto(el, items, opts) {
        if (typeof el === 'string') el = document.getElementById(el);
        if (!el) return 0;
        styleOnce();
        items = items || [];
        opts = opts || {};
        if (!items.length) {
            el.innerHTML = opts.allClear
                ? '<div class="wfx-ok"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>Nothing needs you right now.</div>'
                : '';
            el.style.display = opts.allClear ? '' : 'none';
            return 0;
        }
        el.style.display = '';
        el.innerHTML = '<div class="wfx-wrap">' +
            (opts.title ? '<div class="wfx-hdr">' + esc(opts.title) + '<span>' + items.length + '</span></div>' : '') +
            items.map(tile).join('') + '</div>';
        // wire the one-tap repairs
        try {
            el.querySelectorAll('.wfx-fix').forEach(function (b) {
                b.onclick = function () {
                    var f = b.getAttribute('data-fix');
                    if (f === 'mergeSubs') {
                        var r = mergeDuplicateSubs();
                        try { W.notify && W.notify(r.removed ? ('Merged ' + r.groups + ' duplicate subscription(s) — ' + r.removed + ' removed, no history lost.') : 'Nothing to merge.', r.removed ? 'success' : 'info'); } catch (_) {}
                        try { if (typeof W.renderSubscriptions === 'function') W.renderSubscriptions(); } catch (_) {}
                        try { if (typeof W.renderDashboard === 'function') W.renderDashboard(); } catch (_) {}
                        renderInto(el, opts.source === 'subs' ? subs() : brief(opts.limit || 5), opts);
                    }
                };
            });
        } catch (_) {}
        return items.length;
    }

    W.WFInsights = { cards: cards, subs: subs, income: income, expenses: expenses, incomeIntel: incomeIntel, brief: brief, nextOn: nextOn, renderInto: renderInto,
        findDuplicateSubs: findDuplicateSubs, mergeDuplicateSubs: mergeDuplicateSubs, subDisplayName: subDisplayName, _mine: mine, VERSION: '1.1' };
    try { console.log('[WFInsights] Intelligence layer v1.0 loaded'); } catch (_) {}
})();
