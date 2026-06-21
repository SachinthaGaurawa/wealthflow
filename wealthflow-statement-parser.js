/*  wealthflow-statement-parser.js  —  accurate text-layer statement parsing
 *
 *  Fixes the low-accuracy / "only 1 transaction" scan problem for TEXT-based PDF
 *  statements (DFCC, HNB, Nations Trust, etc.). Instead of running AI-vision/OCR on
 *  a rendered image, the app extracts the PDF's text layer (pdf.js client-side, or
 *  pdf-parse server-side) and passes it here. This parser is deterministic and
 *  self-validating:
 *
 *    • Reads every transaction row (Post Date, Narration, Amount, Balance).
 *    • Determines debit vs credit from the RUNNING BALANCE change — not guesswork.
 *      Works for single-amount-column statements AND two-column (Debit | Credit)
 *      statements where the unused column is 0.00 or blank.
 *    • Validates each amount: |prevBalance - newBalance| must equal the amount.
 *      If a row's printed amount disagrees with the balance delta, the balance
 *      delta wins (the bank's own running total is ground truth) and BOTH the
 *      amount and the direction are corrected from it.
 *    • When there is no running balance yet (first row of a statement that prints
 *      no opening / brought-forward line), direction is left EMPTY so the caller
 *      decides it from the description — never a blind "debit" guess.
 *
 *  Recognised date formats: DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, DD MMM YYYY
 *  (and a leading YYYY-MM-DD). All dates are normalised to YYYY-MM-DD on output.
 *
 *  Returns rows tagged debit/credit with a `valid` flag, so low-confidence rows can
 *  be sent to the review queue instead of saved blindly.
 *
 *  window.WFStatementParser = { parseStatementText, hasTextLayer }
 */
(function () {
    'use strict';

    var MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
    // A date at the very start of a row: DD/MM/YYYY, DD-MM-YYYY, DD-MMM-YYYY, DD MMM YYYY.
    var DATE_CORE = '(?:\\d{1,2}[\\/\\-](?:\\d{1,2}|' + MON + ')[\\/\\-]\\d{2,4}|\\d{1,2}\\s+(?:' + MON + ')\\s+\\d{2,4}|\\d{4}[\\/\\-]\\d{1,2}[\\/\\-]\\d{1,2})';
    var DATE_RE = new RegExp('^(' + DATE_CORE + ')', 'i');
    var DATE_ANY = new RegExp(DATE_CORE, 'ig');
    var MONEY_RE = /[\d,]+\.\d{2}/g;
    // Opening / brought-forward rows seed the running balance (not transactions).
    var OPENING_RE = /\b(opening balance|balance b\/f|b\/f balance|brought forward|balance forward|forward balance|previous balance|carried forward|c\/f balance|bal b\/f|b\/fwd)\b/i;
    // Summary / chart rows that look like transactions but are not.
    var SUMMARY_RE = /\b(transaction summary|daily debit|daily credit|total debits?|total credits?|closing balance|statement summary)\b/i;
    var MONTHS = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

    function _num(s) { return parseFloat(String(s).replace(/,/g, '')); }
    function _p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    function _y4(y) { y = String(y); return y.length === 2 ? ('20' + y) : y; }

    // Normalise any recognised date string to YYYY-MM-DD (leaves it unchanged if unknown).
    function normDate(s) {
        s = String(s || '').trim();
        var m;
        if ((m = s.match(/^(\d{4})[\/\-.](\d{1,2})[\/\-.](\d{1,2})$/))) return m[1] + '-' + _p2(m[2]) + '-' + _p2(m[3]);
        if ((m = s.match(/^(\d{1,2})[\/\-.\s]+([A-Za-z]{3,})[\/\-.\s]+(\d{2,4})$/))) { var mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; if (mo) return _y4(m[3]) + '-' + mo + '-' + _p2(m[1]); }
        if ((m = s.match(/^(\d{1,2})[\/\-.\s]+(\d{1,2})[\/\-.\s]+(\d{2,4})$/))) return _y4(m[3]) + '-' + _p2(m[2]) + '-' + _p2(m[1]);
        return s;
    }

    // Strip a leading or trailing bank reference token (e.g. "S624892", "SD1931885",
    // "DC103248") so it doesn't pollute the narration. Conservative: needs >=5 digits,
    // so real words ("KULIYAPITIYA", "CARGILLS") are never removed.
    function cleanNarration(n) {
        n = String(n || '').trim();
        n = n.replace(/^[A-Za-z]{1,4}\d{5,}[A-Za-z]?\s+/, '');   // leading ref (HNB)
        n = n.replace(/\s+[A-Za-z]{0,4}\d{5,}[A-Za-z]?\s*$/, ''); // trailing ref (NTB)
        n = n.replace(/[\s|,;]+$/, '').trim();
        return n;
    }

    // quick check the caller can use to decide text-parse vs vision fallback
    function hasTextLayer(text) {
        if (!text) return false;
        var m = String(text).match(DATE_ANY);
        return !!(m && m.length >= 3);   // a few real dates ⇒ a usable text layer
    }

    function parseStatementText(text) {
        var lines = String(text || '').split(/\r?\n/);
        var txns = [];
        var prevBal = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!DATE_RE.test(line)) continue;

            var monies = line.match(MONEY_RE);
            if (!monies || monies.length === 0) continue;

            // seed the running balance from an opening / brought-forward row
            if (OPENING_RE.test(line)) { prevBal = _num(monies[monies.length - 1]); continue; }
            if (SUMMARY_RE.test(line)) continue;
            if (monies.length < 2) continue;   // need at least amount + balance

            // strip the leading post date and an optional value/effective date
            var rest = line.replace(DATE_RE, '').trim();
            rest = rest.replace(DATE_RE, '').trim();

            // money tokens (with positions) in the row body — the trailing block is
            // [amount, balance] (single-column) or [debit, credit, balance] (two-column)
            var positions = [], mm; MONEY_RE.lastIndex = 0;
            while ((mm = MONEY_RE.exec(rest)) !== null) positions.push({ v: mm[0], i: mm.index });
            if (positions.length < 2) continue;

            var balance = _num(positions[positions.length - 1].v);
            var amount = _num(positions[positions.length - 2].v);   // 2nd-last; balance delta below fixes the 0.00 two-column case
            var narration = cleanNarration(rest.slice(0, positions[0].i));

            // direction + validation from the running balance (ground truth)
            var direction = '', valid = false, delta = null;
            if (prevBal !== null) {
                delta = Math.round((balance - prevBal) * 100) / 100;
                
                // 🚨 CRITICAL FIX: Credit Card Liability Math Inversion 🚨
                // Auto-detect if this statement belongs to a Credit Card
                var isCC = /credit\s?card|amex|mastercard|visa|card\s?no|minimum\s?due|statement\s?balance/i.test(text || '');
                
                if (isCC) {
                    // Credit Card: Balance is DEBT. 
                    // Balance UP (+ delta) = Borrowed more (DEBIT / Purchase)
                    // Balance DOWN (- delta) = Paid it off (CREDIT / Repayment)
                    direction = delta >= 0 ? 'debit' : 'credit';
                } else {
                    // Normal Bank Account: Balance is ASSET.
                    // Balance UP (+ delta) = Received money (CREDIT / Income)
                    // Balance DOWN (- delta) = Spent money (DEBIT / Expense)
                    direction = delta >= 0 ? 'credit' : 'debit';
                }
                
                valid = Math.abs(Math.abs(delta) - amount) < 0.02;
                if (!valid && Math.abs(delta) > 0) { amount = Math.abs(delta); valid = true; } // trust the balance
            }

            
            // when prevBal is null (no opening balance), leave direction EMPTY so the
            // caller resolves it from the description instead of guessing "debit".

            txns.push({
                date: normDate(dateOf(line)),
                narration: narration,
                amount: amount,
                direction: direction,            // 'credit' (income) | 'debit' (expense) | '' (caller decides)
                balance: balance,
                valid: valid                     // false ⇒ send to review queue
            });
            prevBal = balance;
        }
        return txns;
    }

    function dateOf(line) { var m = String(line).match(DATE_RE); return m ? m[1] : ''; }

    window.WFStatementParser = { parseStatementText: parseStatementText, hasTextLayer: hasTextLayer, normDate: normDate };
    try { console.log('[WFStatementParser] ✓ text-layer statement parser ready'); } catch (_) {}
})();
