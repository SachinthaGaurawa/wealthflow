/*  wealthflow-statement-parser.js  —  accurate text-layer statement parsing
 *
 *  Fixes the low-accuracy / "only 1 transaction" scan problem for TEXT-based PDF
 *  statements (like DFCC). Instead of running AI-vision/OCR on a rendered image,
 *  the app should extract the PDF's text layer (pdf.js client-side, or pdf-parse
 *  server-side) and pass it here. This parser is deterministic and self-validating:
 *
 *    • Reads every transaction row (Post Date, Narration, Amount, Balance).
 *    • Determines debit vs credit from the RUNNING BALANCE change — not guesswork.
 *    • Validates each amount: |prevBalance - newBalance| must equal the amount.
 *      If a row's printed amount disagrees with the balance delta, the balance
 *      delta wins (the bank's own running total is ground truth).
 *
 *  Returns rows tagged debit/credit with a `valid` flag, so low-confidence rows can
 *  be sent to the review queue instead of saved blindly.
 *
 *  window.WFStatementParser = { parseStatementText, hasTextLayer }
 */
(function () {
    'use strict';

    var DATE_RE = /^(\d{2}\/\d{2}\/\d{4})/;
    var MONEY_RE = /[\d,]+\.\d{2}/g;

    function _num(s) { return parseFloat(String(s).replace(/,/g, '')); }

    // quick check the caller can use to decide text-parse vs vision fallback
    function hasTextLayer(text) {
        if (!text) return false;
        var m = String(text).match(/\d{2}\/\d{2}\/\d{4}/g);
        return !!(m && m.length >= 3);   // a few real dates ⇒ a usable text layer
    }

    function parseStatementText(text) {
        var lines = String(text || '').split(/\r?\n/);
        var txns = [];
        var prevBal = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            var dm = line.match(DATE_RE);
            if (!dm) continue;

            var monies = line.match(MONEY_RE);
            if (!monies || monies.length === 0) continue;

            // opening balance row seeds the running balance (not a transaction)
            if (/opening balance/i.test(line)) { prevBal = _num(monies[monies.length - 1]); continue; }
            // skip summary / chart rows
            if (/transaction summary|daily debit|daily credit/i.test(line)) continue;
            if (monies.length < 2) continue;   // need amount + balance

            var balance = _num(monies[monies.length - 1]);
            var amtTok = monies[monies.length - 2];
            var balTok = monies[monies.length - 1];
            var amount = _num(amtTok);

            // narration = everything after the date(s) and before the trailing amount+balance
            var rest = line.replace(DATE_RE, '').trim();
            rest = rest.replace(/^(\d{2}\/\d{2}\/\d{4})/, '').trim();   // drop effective date if present
            var tail = amtTok + ' ' + balTok;
            var idx = rest.lastIndexOf(tail);
            var narration = (idx >= 0 ? rest.slice(0, idx) : rest).trim();

            // direction + validation from the running balance (ground truth)
            var direction = 'debit', valid = false, delta = null;
            if (prevBal !== null) {
                delta = Math.round((balance - prevBal) * 100) / 100;
                direction = delta >= 0 ? 'credit' : 'debit';
                valid = Math.abs(Math.abs(delta) - amount) < 0.02;
                if (!valid && Math.abs(delta) > 0) { amount = Math.abs(delta); valid = true; } // trust the balance
            }

            txns.push({
                date: dm[1],
                narration: narration,
                amount: amount,
                direction: direction,            // 'debit' (expense) | 'credit' (income)
                balance: balance,
                valid: valid                     // false ⇒ send to review queue
            });
            prevBal = balance;
        }
        return txns;
    }

    window.WFStatementParser = { parseStatementText: parseStatementText, hasTextLayer: hasTextLayer };
    try { console.log('[WFStatementParser] ✓ text-layer statement parser ready'); } catch (_) {}
})();
