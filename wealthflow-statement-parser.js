/*  wealthflow-statement-parser.js  —  accurate text-layer statement parsing
 *
 *  Reads the TEXT LAYER of a bank / credit-card statement (extracted by pdf.js in
 *  the browser or pdf-parse on the server) and returns transaction rows. It is
 *  deterministic and self-validating — no AI, no network, no guessing that isn't
 *  labelled as a guess.
 *
 *  WHY THIS WAS REWRITTEN (measured, not assumed)
 *  ---------------------------------------------------------------------------
 *  The previous version was built around ONE statement shape — "date at the start
 *  of the line, then amount, then a running balance" — and silently dropped every
 *  row that didn't match it. A probe over seven real-world layouts found:
 *
 *    • Credit-card statements parsed ZERO rows. They have no balance column, so
 *      each row carries a single money token, and `if (monies.length < 2) continue`
 *      threw the whole statement away.
 *    • Statements whose rows begin with a transaction/reference code ("TXN001
 *      02/07/2026 …") parsed ZERO rows, because the date regex was anchored with ^.
 *    • Two-column (Debit | Credit | Balance) statements with no opening-balance
 *      line recorded their first transaction with **amount 0.00** — the code took
 *      the second-to-last money token, which is the empty debit/credit column, and
 *      the balance-delta correction that normally repairs it cannot run on the
 *      first row because there is no previous balance yet.
 *    • Parenthesised negatives — "(1,500.00)" — leaked the bracket into the
 *      narration ("REFUND ADJUSTMENT (") and their sign was ignored.
 *
 *  Returning zero rows is the most damaging of these, because the caller
 *  (wealthflow-ai-v4.js) treats an empty result as "this PDF has no text layer"
 *  and falls through to the AI vision cascade. So the statements that failed here
 *  were exactly the ones that came back inaccurate: a perfectly machine-readable
 *  PDF was being handed to fuzzy image OCR.
 *
 *  HOW IT WORKS NOW
 *  ---------------------------------------------------------------------------
 *  1. TOKENISE every line: find the row date (allowing a leading reference code),
 *     and every money token with its position, sign and CR/DR marker.
 *  2. DETECT THE LAYOUT instead of assuming it. The parser tests the hypothesis
 *     "the last money column is a running balance" against the statement's own
 *     arithmetic: for each pair of consecutive rows, does the change in the last
 *     column equal one of the other money tokens on that row? A statement that
 *     agrees is a balance statement; one that doesn't (or that only ever has one
 *     money token per row) is a credit-card-style statement whose last column is
 *     the amount. This is what makes both shapes parse without a per-bank rule.
 *  3. EMIT rows, taking direction from the strongest evidence available, in order:
 *       balance delta  >  explicit CR/DR marker  >  which column held the amount
 *       >  a parenthesised/negative sign  >  refund/reversal wording  >  assumed.
 *     Every row reports which of those was used, so nothing silently pretends to
 *     be verified when it was inferred.
 *  4. RECONCILE the statement as a whole: opening + credits − debits = closing.
 *     A row-level check cannot catch a row that was missed entirely; this can.
 *
 *  Recognised dates: DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, DD MMM YYYY, YYYY-MM-DD.
 *  DD/MM vs MM/DD is decided from the whole statement (a day > 12 anywhere settles
 *  it) rather than assumed per row. Output is always YYYY-MM-DD.
 *
 *  window.WFStatementParser = {
 *      parseStatementText,   // (text) -> rows[]            (unchanged contract)
 *      parseStatement,       // (text) -> { rows, layout, reconciliation }
 *      hasTextLayer, normDate, detectDateOrder
 *  }
 */
(function () {
    'use strict';

    var MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
    var DATE_CORE = '(?:\\d{1,2}[\\/\\-](?:\\d{1,2}|' + MON + ')[\\/\\-]\\d{2,4}'
        + '|\\d{1,2}\\s+(?:' + MON + ')\\s+\\d{2,4}'
        + '|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';
    var DATE_ANY = new RegExp(DATE_CORE, 'ig');

    // How far into a line the row date may start. Covers a leading reference or
    // transaction code ("TXN001 ", "0012 ") without letting a date buried in a
    // narration or a page footer be mistaken for the row's own date.
    var LEAD_SLACK = 24;

    // Money: 1,234.56 or 1234.56. Grouped thousands must be well formed, and a
    // token may not be the truncated head of a longer number ("1234.5678").
    var NUM_RE = /\d{1,3}(?:,\d{3})+\.\d{2}(?!\d)|\d+\.\d{2}(?!\d)/g;

    // Rows that seed / close the running balance. Not transactions themselves.
    var OPENING_RE = /\b(opening balance|balance b\/f|b\/f balance|brought forward|balance forward|forward balance|previous balance|bal b\/f|b\/fwd|opening bal)\b/i;
    var CLOSING_RE = /\b(closing balance|closing bal|balance c\/f|c\/f balance|carried forward|ending balance|final balance)\b/i;

    // Lines that look like transactions but are summaries, totals or header facts.
    // This list matters more now than it used to: the row filter is deliberately
    // looser (a single money token is enough), so the noise filter is what keeps
    // "Credit Limit 500,000.00" from being imported as a purchase.
    var NOISE_RE = new RegExp('\\b(' + [
        'transaction summary', 'statement summary', 'summary of', 'daily debit', 'daily credit',
        'total debits?', 'total credits?', 'total transactions?', 'no\\.? of transactions?',
        'credit limit', 'available (?:credit|balance|limit)', 'cash (?:advance )?limit',
        'minimum (?:amount )?due', 'minimum payment', 'total (?:amount )?due', 'amount due',
        'payment due', 'due date', 'statement date', 'statement period', 'statement balance',
        'interest rate', 'annual percentage', 'apr', 'page \\d+ of', 'amount in words',
        'previous statement', 'sub total', 'subtotal', 'grand total', 'balance summary',
        'unbilled', 'reward points?', 'points earned', 'points balance'
    ].join('|') + ')\\b', 'i');

    // Wording that reliably means money coming back IN, used only as a late
    // fallback when the statement gives no arithmetic and no CR/DR marker.
    var INBOUND_RE = /\b(refund|reversal|reversed|chargeback|charge back|cash ?back|credit adjustment|payment (?:received|thank ?you)|thank you for your payment|deposit|salary|payroll|wages|dividend|interest credit)\b/i;

    var MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

    var EPS = 0.02;              // cents-level tolerance for money comparisons
    var MAX_BLOCK = 4;           // most trailing money columns a row may have

    function _num(s) { var n = parseFloat(String(s).replace(/,/g, '')); return isFinite(n) ? n : 0; }
    function _p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    function _y4(y) { y = String(y); return y.length === 2 ? ('20' + y) : y; }
    function _r2(n) { return Math.round(n * 100) / 100; }
    function _eq(a, b) { return Math.abs(a - b) < EPS; }

    // ── dates ────────────────────────────────────────────────────────────────
    // Which way round a numeric date is written, decided from the whole document.
    // A single "25/07/2026" proves day-first for every row in the file, which is
    // more reliable than assuming a convention and silently transposing months.
    function detectDateOrder(text) {
        var re = /(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/g, m, dmy = 0, mdy = 0;
        while ((m = re.exec(String(text || ''))) !== null) {
            var a = +m[1], b = +m[2];
            if (a > 12 && b <= 12) dmy++;
            else if (b > 12 && a <= 12) mdy++;
        }
        return mdy > dmy ? 'mdy' : 'dmy';
    }

    function normDate(s, order) {
        s = String(s || '').trim();
        var m;
        if ((m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/))) return m[1] + '-' + _p2(m[2]) + '-' + _p2(m[3]);
        if ((m = s.match(/^(\d{1,2})[\/\-.\s]+([A-Za-z]{3,})[\/\-.\s]+(\d{2,4})$/))) {
            var mo = MONTHS[m[2].toLowerCase().slice(0, 3)];
            if (mo) return _y4(m[3]) + '-' + mo + '-' + _p2(m[1]);
        }
        if ((m = s.match(/^(\d{1,2})[\/\-.\s]+(\d{1,2})[\/\-.\s]+(\d{2,4})$/))) {
            var d = m[1], mth = m[2];
            // An out-of-range field settles it regardless of the document-wide guess.
            if (+mth > 12 && +d <= 12) { var t = d; d = mth; mth = t; }
            else if (order === 'mdy' && +d <= 12) { var t2 = d; d = mth; mth = t2; }
            return _y4(m[3]) + '-' + _p2(mth) + '-' + _p2(d);
        }
        return s;
    }

    // The row's own date: the first date token starting within LEAD_SLACK
    // characters, so "TXN001 02/07/2026 …" is read rather than discarded.
    function dateAt(line) {
        DATE_ANY.lastIndex = 0;
        var m = DATE_ANY.exec(line);
        if (!m || m.index > LEAD_SLACK) return null;
        return { text: m[0], start: m.index, end: m.index + m[0].length };
    }

    // ── narration ────────────────────────────────────────────────────────────
    // Bank reference tokens are stripped conservatively (>=5 digits) so real
    // words like "KULIYAPITIYA" survive. Trailing brackets and currency codes are
    // removed because the money token they belonged to has already been taken out.
    function cleanNarration(n) {
        n = String(n || '').trim();
        n = n.replace(/^[A-Za-z]{1,4}\d{5,}[A-Za-z]?\s+/, '');
        n = n.replace(/\s+[A-Za-z]{0,4}\d{5,}[A-Za-z]?\s*$/, '');
        n = n.replace(/\b(?:LKR|USD|EUR|GBP|AUD|INR|SGD|Rs\.?)\s*$/i, '');
        n = n.replace(/[\s|,;:.\-(]+$/, '');
        n = n.replace(/^[\s|,;:.\-)]+/, '');
        return n.replace(/\s{2,}/g, ' ').trim();
    }

    function hasTextLayer(text) {
        if (!text) return false;
        var m = String(text).match(DATE_ANY);
        return !!(m && m.length >= 3);
    }

    // ── tokenising ───────────────────────────────────────────────────────────
    // Every money token on a line, with the sign and CR/DR marker printed around
    // it. Both are evidence about direction that the old parser threw away.
    function moneyTokens(text) {
        var out = [], m;
        NUM_RE.lastIndex = 0;
        while ((m = NUM_RE.exec(text)) !== null) {
            var start = m.index, end = start + m[0].length;
            var before = text.slice(0, start), after = text.slice(end);
            // A digit/comma immediately before means we matched mid-number.
            if (/[\d,]$/.test(before)) continue;
            var lead = (before.match(/[\s(\-]*(?:LKR|USD|EUR|GBP|AUD|INR|SGD|Rs\.?)?[\s(\-]*$/i) || [''])[0];
            var mk = (after.match(/^\s*\)?\s*(CR|DR)\b/i) || [])[1] || '';
            out.push({
                v: _num(m[0]),
                raw: m[0],
                start: start,
                end: end,
                // "(1,500.00)" and "-1,500.00" both mean a negative movement.
                neg: /\(/.test(lead) || /-\s*$/.test(lead) || /^\s*\)/.test(after),
                marker: mk ? mk.toUpperCase() : ''
            });
        }
        return out;
    }

    // The trailing money block: the run of columns at the end of the row,
    // separated from each other by nothing but spaces, brackets and CR/DR.
    // Anything before that run is narration — including numbers inside it, which
    // is what stops "FUEL 20.00 LTR AT LAUGFS 3,000.00 47,000.00" from being
    // truncated to "FUEL" and losing the merchant name the categoriser needs.
    function trailingBlock(tokens, text) {
        if (!tokens.length) return [];
        var block = [tokens[tokens.length - 1]];
        for (var k = tokens.length - 2; k >= 0 && block.length < MAX_BLOCK; k--) {
            var gap = text.slice(tokens[k].end, block[0].start);
            if (!/^[\s()|,;:]*(?:(?:CR|DR)\b)?[\s()|,;:]*$/i.test(gap)) break;
            block.unshift(tokens[k]);
        }
        return block;
    }

    // ── layout detection ─────────────────────────────────────────────────────
    // Does the last money column behave like a running balance? Decided from the
    // statement itself rather than a per-bank template — but deliberately NOT from
    // the arithmetic alone.
    //
    // The arithmetic test ("does the change in the last column equal one of the
    // other tokens?") is circular if it is the only signal: a MISREAD amount makes
    // the test fail, the parser concludes there is no balance column, and then
    // reports the balance itself as the amount — a 4,250 purchase becoming 95,750.
    // That is worse than the bug it replaced, so the amount-independent evidence
    // is weighed first:
    //
    //   • the statement prints an opening / closing balance line   (it has one)
    //   • a column header names Balance alongside Debit/Credit     (it has one)
    //   • the row arithmetic agrees                                 (it has one)
    //
    // …each requiring that rows actually carry two or more money columns, because
    // credit-card statements print "Previous Balance" too and their rows do not
    // carry a running total. Sustained disagreement can still veto: three or more
    // testable rows that almost never add up mean the last column is something
    // else (a foreign-currency amount, say), whatever the header claims.
    var HDR_BALANCE_RE = /\bbalance\b/i;
    var HDR_COMPANION_RE = /\b(debit|credit|amount|withdrawal|deposit|particulars|narration|description)\b/i;

    function detectLayout(cands, lines) {
        var testable = 0, agree = 0, maxCols = 0, prev = null;
        for (var i = 0; i < cands.length; i++) {
            var c = cands[i];
            maxCols = Math.max(maxCols, c.block.length);
            if (c.opening || c.closing) { prev = c.block.length ? c.block[c.block.length - 1].v : prev; continue; }
            var last = c.block.length ? c.block[c.block.length - 1].v : null;
            if (prev !== null && last !== null && c.block.length >= 2) {
                testable++;
                var delta = Math.abs(_r2(last - prev));
                for (var j = 0; j < c.block.length - 1; j++) {
                    if (c.block[j].v > 0 && _eq(c.block[j].v, delta)) { agree++; break; }
                }
            }
            if (last !== null) prev = last;
        }

        var hasBalanceLine = false;
        for (var b = 0; b < cands.length; b++) if (cands[b].opening || cands[b].closing) { hasBalanceLine = true; break; }

        var headerSaysBalance = false;
        for (var h = 0; h < lines.length; h++) {
            var l = lines[h];
            if (HDR_BALANCE_RE.test(l) && HDR_COMPANION_RE.test(l) && !moneyTokens(l).length) { headerSaysBalance = true; break; }
        }

        var ratio = testable >= 1 ? (agree / testable) : null;
        var veto = testable >= 3 && ratio < 0.34;
        var balanceColumn = !veto && maxCols >= 2
            && (hasBalanceLine || headerSaysBalance || (ratio !== null && ratio >= 0.6));

        return {
            balanceColumn: balanceColumn,
            testable: testable,
            agree: agree,
            maxColumns: maxCols,
            evidence: { balanceLine: hasBalanceLine, header: headerSaysBalance, arithmetic: ratio, veto: veto }
        };
    }

    // ── the parser ───────────────────────────────────────────────────────────
    function parseStatement(text) {
        var src = String(text || '');
        var order = detectDateOrder(src);
        var lines = src.split(/\r?\n/);
        var cands = [];

        // pass 1 — tokenise candidate rows
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var d = dateAt(line);
            if (!d) continue;

            var isOpening = OPENING_RE.test(line);
            var isClosing = CLOSING_RE.test(line);
            if (!isOpening && !isClosing && NOISE_RE.test(line)) continue;

            // Drop the post date and an immediately following value/effective date.
            var rest = line.slice(d.end);
            var second = dateAt(rest);
            if (second && second.start <= 2) rest = rest.slice(second.end);

            var tokens = moneyTokens(rest);
            if (!tokens.length) continue;

            cands.push({
                line: line,
                date: normDate(d.text, order),
                rest: rest,
                block: trailingBlock(tokens, rest),
                opening: isOpening,
                closing: isClosing
            });
        }

        var layout = detectLayout(cands, lines);

        // pass 2 — emit rows
        var rows = [], prevBal = null, opening = null, closing = null;
        var credits = 0, debits = 0;

        for (var n = 0; n < cands.length; n++) {
            var c = cands[n];
            var block = c.block;
            var lastTok = block[block.length - 1];

            if (c.opening) { prevBal = lastTok.v; if (opening === null) opening = lastTok.v; continue; }
            if (c.closing) { closing = lastTok.v; continue; }

            var balance = layout.balanceColumn ? lastTok.v : null;
            var amountToks = layout.balanceColumn ? block.slice(0, -1) : block.slice();

            // Which money column is the amount, and what that column implies.
            var amount = 0, colDir = '';
            if (amountToks.length >= 2) {
                // Debit | Credit pair: the filled column is the amount and, on its
                // own, tells us the direction — which is how a first row on a
                // statement with no opening balance still gets a direction.
                var nonZero = [];
                for (var a = 0; a < amountToks.length; a++) if (amountToks[a].v > 0) nonZero.push(a);
                if (nonZero.length === 1) {
                    amount = amountToks[nonZero[0]].v;
                    colDir = nonZero[0] === 0 ? 'debit' : 'credit';
                } else if (nonZero.length === 0) {
                    amount = 0;
                } else {
                    amount = amountToks[nonZero[nonZero.length - 1]].v;
                }
            } else if (amountToks.length === 1) {
                amount = amountToks[0].v;
            } else if (balance !== null && prevBal !== null) {
                // Only a balance was printed — recover the amount from the change.
                amount = Math.abs(_r2(balance - prevBal));
            }

            var amtTok = null;
            for (var b = 0; b < amountToks.length; b++) if (amountToks[b].v === amount) { amtTok = amountToks[b]; break; }

            // narration = everything before the trailing money block
            var narration = cleanNarration(c.rest.slice(0, block[0].start));

            // ── direction, strongest evidence first ──────────────────────────
            var direction = '', source = '', balanceVerified = false, delta = null;

            if (balance !== null && prevBal !== null) {
                delta = _r2(balance - prevBal);
                if (Math.abs(delta) >= EPS) {
                    direction = delta > 0 ? 'credit' : 'debit';
                    source = 'balance';
                    if (_eq(Math.abs(delta), amount)) balanceVerified = true;
                    else { amount = Math.abs(delta); balanceVerified = true; } // the bank's own running total wins
                }
            }
            if (!direction) {
                var marker = (amtTok && amtTok.marker) || (lastTok && lastTok.marker) || '';
                if (marker) { direction = marker === 'CR' ? 'credit' : 'debit'; source = 'marker'; }
            }
            if (!direction && colDir) { direction = colDir; source = 'column'; }
            if (!direction && amtTok && amtTok.neg) { direction = 'credit'; source = 'sign'; }
            if (!direction && INBOUND_RE.test(narration)) { direction = 'credit'; source = 'keyword'; }
            if (!direction && !layout.balanceColumn) {
                // On a statement with no running balance almost every row is a
                // purchase. Assumed, and labelled as assumed — not passed off as
                // verified the way a silent default would be.
                direction = 'debit'; source = 'assumed';
            }

            // A zero amount is never a usable transaction.
            if (amount === 0 && delta !== null && Math.abs(delta) >= EPS) amount = Math.abs(delta);
            var amountKnown = amount > 0;

            rows.push({
                date: c.date,
                narration: narration,
                amount: _r2(amount),
                direction: direction,          // 'credit' | 'debit' | '' (caller decides)
                balance: balance,
                // Three separate facts, because collapsing them is how the old
                // version ended up calling an unresolved row "valid":
                //   valid           — amount AND direction are both resolved
                //   balanceVerified — the bank's own running total confirms it
                //   needsReview     — direction rests on wording or an assumption
                valid: amountKnown && !!direction,
                balanceVerified: balanceVerified,
                directionSource: source,       // balance | marker | column | sign | keyword | assumed | ''
                needsReview: !amountKnown || !direction || source === 'keyword' || source === 'assumed'
            });

            if (direction === 'credit') credits += amount;
            else if (direction === 'debit') debits += amount;
            if (balance !== null) prevBal = balance;
        }

        // ── whole-statement cross-validation ────────────────────────────────
        // A per-row balance check cannot notice a row that was never parsed.
        // opening + credits − debits = closing can.
        if (closing === null && layout.balanceColumn && rows.length) {
            var lastWithBal = null;
            for (var z = rows.length - 1; z >= 0; z--) if (rows[z].balance !== null) { lastWithBal = rows[z].balance; break; }
            closing = lastWithBal;
        }
        var reconciliation = { opening: opening, closing: closing, credits: _r2(credits), debits: _r2(debits), expected: null, difference: null, ok: null };
        if (opening !== null && closing !== null) {
            reconciliation.expected = _r2(opening + credits - debits);
            reconciliation.difference = _r2(closing - reconciliation.expected);
            reconciliation.ok = Math.abs(reconciliation.difference) < EPS;
        }

        return { rows: rows, layout: layout, reconciliation: reconciliation, dateOrder: order };
    }

    // Unchanged contract for existing callers.
    function parseStatementText(text) { return parseStatement(text).rows; }

    window.WFStatementParser = {
        parseStatementText: parseStatementText,
        parseStatement: parseStatement,
        hasTextLayer: hasTextLayer,
        normDate: normDate,
        detectDateOrder: detectDateOrder
    };
    try { console.log('[WFStatementParser] ✓ text-layer statement parser ready'); } catch (_) {}
})();
