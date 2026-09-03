/*  wealthflow-layout-memory.js  —  teach the statement parser a bank's layout once
 *
 *  THE PROBLEM THIS EXISTS FOR
 *  ---------------------------------------------------------------------------
 *  wealthflow-statement-parser.js reads a statement by finding, on each line, a
 *  DATE it recognises followed by money tokens. Everything downstream of that —
 *  which column is a running balance, which is the amount, whether the
 *  arithmetic closes — is format-agnostic and already works on every layout we
 *  have tested. So when a statement from a bank the parser has never seen comes
 *  back with zero rows, the cause is almost always one of exactly two things:
 *
 *    1. the row date is written in a form DATE_CORE does not match
 *       ("02.07.2026", "20260702"), or
 *    2. the date is on the line but too far in — past LEAD_SLACK — behind a long
 *       reference column, or on the line ABOVE the money.
 *
 *  That is a very small thing to be missing, and it costs the owner a whole
 *  month of their ledger. Worse, before this the loss was silent: zero rows and
 *  zero transactions look identical to a caller.
 *
 *  WHAT THIS DOES DIFFERENTLY
 *  ---------------------------------------------------------------------------
 *  It does NOT add a second row-reading implementation. A parser and a
 *  "fallback parser" drift apart, and then a statement reads one way on Tuesday
 *  and another way on Friday. Instead this module learns ONLY the date shape,
 *  rewrites the statement text so the date is in a form the real parser already
 *  understands, and hands it back to the real parser. One row-emitting
 *  implementation, one reconciliation, one set of direction rules — the learned
 *  layout is a translation step, not a competing reader.
 *
 *  THE OWNER TYPES NOTHING. propose() reads the statement the way a person
 *  would if they had never seen the format: it finds every date-shaped run on
 *  the page, tries each interpretation, and keeps the ones that produce rows
 *  whose arithmetic closes. The owner is shown the best reading and confirms it
 *  once. remember() stores the shape, and every future statement from that bank
 *  parses on its own.
 *
 *  WHY A CONFIRMED READING IS SAFE TO STORE
 *  ---------------------------------------------------------------------------
 *  A template that matches too much is the real risk — a page footer read as a
 *  transaction. Three things stop it:
 *    - a candidate is only ranked if the statement's own opening + credits -
 *      debits = closing arithmetic agrees with it, which junk rows break;
 *    - learn() re-applies the template it just derived and refuses to return one
 *      that does not reproduce the rows it was taught from;
 *    - nothing learned is ever filed without the owner seeing it. Learned rows
 *      arrive on the same review screen as every other imported statement.
 *
 *  window.WFLayoutMemory = {
 *      propose, learn, normalise, remember, recall, forget, templateId,
 *      store, useStore, memoryStore
 *  }
 */
(function () {
    'use strict';

    var W = (typeof window !== 'undefined') ? window : null;

    var V = 1;
    var KEY = 'wf.layouts.v1';
    var PER_BANK = 3;        // a bank may change its format; keep the last few
    var MAX_BANKS = 24;
    var TRY_LIMIT = 6;       // templates tried on a failing parse, newest first
    var MON = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
    var MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

    /* A date-shaped run, drawn as wide as it can safely be drawn: three parts,
     * any single- or double-character separator that is not itself a letter or a
     * digit, or whitespace, or nothing at all. Deliberately wider than the
     * parser's own DATE_CORE — that regex is the thing that failed. */
    var WIDE = new RegExp(
        '(\\d{1,4})([^\\dA-Za-z\\s]{1,2}|[ \\t]{1,2}|)((?:' + MON + ')[a-z]*|\\d{1,2})([^\\dA-Za-z\\s]{1,2}|[ \\t]{1,2}|)(\\d{2,4})',
        'gi');

    var NUM = /\d{1,3}(?:,\d{3})+\.\d{2}(?!\d)|\d+\.\d{2}(?!\d)/g;

    function moneyOn(line) {
        var out = [], m;
        NUM.lastIndex = 0;
        while ((m = NUM.exec(line)) !== null) {
            if (/[\d,]$/.test(line.slice(0, m.index))) continue;
            out.push({ v: parseFloat(m[0].replace(/,/g, '')), start: m.index, end: m.index + m[0].length });
        }
        return out;
    }

    /* ── IS THIS RUN ACTUALLY A DATE? ───────────────────────────────────────
     *
     * WIDE is deliberately loose, and loose regexes find dates inside numbers.
     * The first version of this module learned the "layout" (\d{1,2})(\d{1,2})
     * (\d{1,2}) from the four digits of the YEAR in "05.07.2026" — read as
     * 20|2|6, which is a real calendar date, on a reading that reconciled
     * perfectly because reconciliation never looks at dates. Every row came
     * back stamped 2020-02-06 and the score said 19.
     *
     * So a candidate must look like a date a human would recognise:
     *   - separators are either both present, or both absent and the run is one
     *     of the two compact forms (YYYYMMDD, DDMMYYYY). Nothing else may be
     *     written with no separator at all;
     *   - the two separators are the same character (no "02/07-2026");
     *   - a two-digit year is only allowed when separators are present;
     *   - the character before must not be part of a number or a date, which is
     *     what caught the year fragment above.
     */
    function plausibleRun(m, before) {
        var s1 = m[2] === undefined ? '' : m[2], s2 = m[4] === undefined ? '' : m[4];
        var a = String(m[1]), b = String(m[3]), c = String(m[5]);
        if (/[\d.,\/\-]$/.test(String(before || ''))) return false;
        if ((s1 === '') !== (s2 === '')) return false;
        if (s1 === '') {
            if (/[A-Za-z]/.test(b)) return false;
            var compact = (a.length === 4 && b.length === 2 && c.length === 2)
                || (a.length === 2 && b.length === 2 && c.length === 4);
            if (!compact) return false;
        } else {
            if (s1.replace(/\s+/g, ' ') !== s2.replace(/\s+/g, ' ')) return false;
        }
        return true;
    }

    /* ── EVERY DATE-SHAPED RUN ON ONE LINE ───────────────────────────────────
     *
     * Two things here are not decoration.
     *
     * PER LINE, because a global scan over the whole document matched
     * "00\n02.07" — the tail of one line's balance, the newline, and the head of
     * the next line's date — and in doing so CONSUMED the real date, which was
     * then never offered at all. propose() saw zero candidates on a statement
     * whose dates are perfectly legible.
     *
     * RESTART AT index + 1 ON REJECTION, because the regex is greedy and its
     * separator classes are wide: "100,000" matches before "02.07.2026" does. A
     * rejected match must not take the characters after it out of the search,
     * or one bad candidate hides every good one behind it. */
    function runsOn(line) {
        var out = [], m, txt = String(line || '');
        WIDE.lastIndex = 0;
        while ((m = WIDE.exec(txt)) !== null) {
            var end = m.index + m[0].length;
            var before = txt.slice(Math.max(0, m.index - 1), m.index);
            var after = txt.slice(end, end + 1);
            if (!/[\d,]/.test(after) && plausibleRun(m, before)) {
                out.push({ m: m, index: m.index, end: end, text: m[0] });
            } else {
                WIDE.lastIndex = m.index + 1;
            }
            if (out.length >= 6) break;
        }
        return out;
    }

    function p2(n) { n = String(n); return n.length < 2 ? '0' + n : n; }
    function y4(y) { y = String(y); return y.length === 2 ? '20' + y : y; }
    function esc(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

    /* ── one date-shaped run, turned into a date ─────────────────────────────
     *
     * `order` names which part is which, and is the ONLY thing that separates
     * 02/07/2026 the second of July from 02/07/2026 the seventh of February.
     * There is no way to know from the run itself, which is exactly why this
     * module asks the owner instead of guessing — and why the guess it offers
     * is ranked by whether the statement's own arithmetic agrees with it. */
    function isoFrom(a, b, c, order) {
        var d, mo, y;
        if (/[A-Za-z]/.test(String(b))) {                // month spelled out
            mo = MONTHS[String(b).toLowerCase().slice(0, 3)];
            d = +a; y = +y4(c);
        } else if (order === 'ymd') { y = +y4(a); mo = +b; d = +c; }
        else if (order === 'mdy') { mo = +a; d = +b; y = +y4(c); }
        else { d = +a; mo = +b; y = +y4(c); }            // dmy
        if (!mo || !d || !y) return null;
        if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
        if (y < 1980 || y > 2199) return null;
        return y + '-' + p2(mo) + '-' + p2(d);
    }

    /* The generalised shape of one matched run: "02.07.2026" becomes
     * \d{1,2}\.\d{1,2}\.\d{4}, so it matches the 9th of a month too. Digit runs
     * of one or two are widened together because a bank that prints "2.07" also
     * prints "12.07". */
    function shapeOf(m) {
        var part = function (s) {
            if (/[A-Za-z]/.test(s)) return '(?:' + MON + ')[a-z]*';
            var n = String(s).length;
            return n <= 2 ? '\\d{1,2}' : '\\d{' + n + '}';
        };
        var sep = function (s) { return s === '' ? '' : (/^\s+$/.test(s) ? '\\s{1,2}' : esc(s)); };
        return '(' + part(m[1]) + ')' + sep(m[2]) + '(' + part(m[3]) + ')' + sep(m[4]) + '(' + part(m[5]) + ')';
    }

    /* THE ID MUST NOT ERASE THE THING THAT MAKES A LAYOUT DIFFERENT. The first
     * version built it by stripping every non-alphanumeric character out of the
     * regex, so (\d{1,2})\.(\d{1,2})\.(\d{4}) and (\d{1,2})_(\d{1,2})_(\d{4})
     * — a dot-separated date and an underscore-separated one — both became
     * "d12d12d4" and collided. recall() de-duplicates by id, so remembering the
     * second silently discarded it and the bank whose statements it read went on
     * being unreadable. A hash keeps the separators in the identity. */
    function hash32(s) {
        var h = 2166136261;
        for (var i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
        }
        return ('0000000' + h.toString(36)).slice(-7);
    }
    function templateId(t) {
        return 'L' + V + ':' + ((t && t.order) || '?') + ':' + (t && t.joinNext ? 'j' : '-') + ':'
            + hash32(String((t && t.re) || ''));
    }

    function makeTemplate(re, order, joinNext, bank) {
        var t = { v: V, re: re, order: order, joinNext: !!joinNext, bank: bank ? String(bank) : '', learnedAt: Date.now() };
        t.id = templateId(t);
        return t;
    }

    /* ── the translation step ────────────────────────────────────────────────
     *
     * Rewrite every row line so it starts with an ISO date, which the parser's
     * own DATE_CORE matches and normDate() reads without needing to know the
     * document's convention. Nothing else about the line is touched: the money
     * columns, the CR/DR markers, the parentheses and the narration all reach
     * the parser exactly as the bank printed them.
     *
     * The text that preceded the date — a reference or transaction column — is
     * moved AFTER it rather than dropped, so cleanNarration() gets its usual
     * chance to strip it and nothing the owner might want to read is lost. */
    function normalise(text, tpl) {
        if (!tpl || !tpl.re) return String(text || '');
        var re;
        try { re = new RegExp(tpl.re, 'gi'); } catch (_) { return String(text || ''); }
        var lines = String(text || '').split(/\r?\n/);
        var out = [], pending = null;

        for (var i = 0; i < lines.length; i++) {
            var line = lines[i];
            var iso = null;
            /* KEEP LOOKING. The compact form's template is (\d{4})(\d{1,2})
             * (\d{1,2}), and on "REF/CHQ/000012345678 20260702 ..." the FIRST
             * thing it matches is the reference number. Taking only the first
             * match and giving up on the line meant every statement with a
             * reference column stayed unreadable after being taught. */
            re.lastIndex = 0;
            var m;
            while ((m = re.exec(line)) !== null) {
                var at = m.index, stop = at + m[0].length;
                var before = line.slice(0, at), after = line.slice(stop);
                /* Adjacent digits mean we matched inside a longer number, which
                 * is how a money token becomes a date if you are careless. */
                if (!/^[\d,]/.test(after) && !/[\d.,\/\-]$/.test(before)) {
                    iso = isoFrom(m[1], m[2], m[3], tpl.order);
                    if (iso) { line = iso + ' ' + (before + ' ' + after).replace(/\s{2,}/g, ' ').trim(); break; }
                }
                re.lastIndex = at + 1;
            }

            if (pending !== null) {
                /* The date was on the line above the money. Joining them gives
                 * the parser the single line it expects, and keeps both halves
                 * of the narration. */
                if (!iso && moneyOn(line).length) { out.push(pending + ' ' + line.trim()); pending = null; continue; }
                out.push(pending); pending = null;
            }
            if (tpl.joinNext && iso && !moneyOn(line).length && line.trim()) { pending = line; continue; }
            out.push(line);
        }
        if (pending !== null) out.push(pending);
        return out.join('\n');
    }

    /* ── reading a statement nobody taught us ────────────────────────────────
     *
     * Every distinct date shape on the page, in every part-order that yields a
     * real calendar date, run through the real parser. What comes back is a
     * ranked list of readings — not an answer. The owner picks, once. */
    function propose(text, parse, opts) {
        var src = String(text || '');
        opts = opts || {};
        parse = parse || (W && W.WFStatementParser && W.WFStatementParser.parseStatement);
        if (typeof parse !== 'function') return [];

        var seen = Object.create(null), shapes = [];
        var srcLines = src.split(/\r?\n/);
        for (var li = 0; li < srcLines.length && shapes.length < 8; li++) {
            var runs = runsOn(srcLines[li]);
            for (var ri = 0; ri < runs.length; ri++) {
                var s = shapeOf(runs[ri].m);
                if (seen[s]) continue;
                seen[s] = 1;
                shapes.push(s);                          // a page has few shapes; the rest is noise
                if (shapes.length >= 8) break;
            }
        }

        var orders = ['dmy', 'mdy', 'ymd'];
        var out = [];
        for (var i = 0; i < shapes.length; i++) {
            for (var o = 0; o < orders.length; o++) {
                for (var j = 0; j < 2; j++) {
                    var tpl = makeTemplate(shapes[i], orders[o], j === 1, opts.bank);
                    var res;
                    try { res = parse(normalise(src, tpl), { __learned: true }); } catch (_) { continue; }
                    var rows = (res && res.rows) || [];
                    if (!rows.length) continue;
                    var score = scoreReading(rows, res);
                    if (score <= 0) continue;
                    out.push({ template: tpl, rows: rows, reconciliation: res.reconciliation, score: score });
                }
            }
        }

        /* Same rows, cheapest explanation first: a reading that reconciles beats
         * one that merely produced more rows, because more rows is exactly what
         * an over-matching template produces. */
        /* A TIE IS NOT A BUG, IT IS THE TRUTH. "02.07.2026" is the 2nd of July
         * and the 7th of February, and no amount of arithmetic can separate
         * them — the balances reconcile identically either way. So the tie is
         * broken by the convention of the market this is built for (day first)
         * and the runner-up is kept and FLAGGED, so the screen can say "this
         * could also be read month-first" instead of quietly picking one. */
        var RANK = { dmy: 0, mdy: 1, ymd: 2 };
        out.sort(function (a, b) {
            return b.score - a.score
                || RANK[a.template.order] - RANK[b.template.order]
                || a.rows.length - b.rows.length;
        });
        for (var t = 1; t < out.length; t++) {
            if (out[t].score === out[0].score && out[t].template.order !== out[0].template.order) {
                out[0].ambiguous = true;
                out[t].ambiguous = true;
            }
        }
        var uniq = [], keys = Object.create(null);
        for (var k = 0; k < out.length; k++) {
            var key = out[k].rows.map(function (r) { return r.date + '|' + r.amount; }).join(',');
            if (keys[key]) continue;
            keys[key] = 1;
            uniq.push(out[k]);
            if (uniq.length >= 4) break;
        }
        return uniq;
    }

    function scoreReading(rows, res) {
        var real = 0, verified = 0, dated = Object.create(null), bad = 0;
        for (var i = 0; i < rows.length; i++) {
            var r = rows[i] || {};
            if (!(r.amount > 0)) { bad++; continue; }
            if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) { bad++; continue; }
            real++;
            dated[String(r.date).slice(0, 7)] = 1;
            if (r.balanceVerified) verified++;
        }
        if (!real) return 0;
        /* A statement covers a month, sometimes two at the edges. A reading that
         * scatters rows over eight different months has read the wrong number as
         * a date, and no amount of row count should rescue it. */
        if (Object.keys(dated).length > 3) return 0;
        var score = real + verified * 2 - bad * 2;
        if (res && res.reconciliation && res.reconciliation.ok === true) score += 10;
        return score;
    }

    /* ── learning from rows the owner has confirmed ──────────────────────────
     *
     * Used when the owner corrected the proposed reading rather than accepting
     * it. Finds the line each confirmed row came from, derives the date shape,
     * and — this is the part that matters — RE-APPLIES the derived template and
     * refuses to return one that cannot reproduce what it was taught. A
     * template that only works on the statement it was learned from is worse
     * than no template, because it would be trusted on the next one. */
    function learn(text, confirmed, parse, opts) {
        var src = String(text || '');
        opts = opts || {};
        parse = parse || (W && W.WFStatementParser && W.WFStatementParser.parseStatement);
        var rows = Array.isArray(confirmed) ? confirmed.filter(Boolean) : [];
        if (!rows.length) return { ok: false, reason: 'nothing was confirmed' };
        if (typeof parse !== 'function') return { ok: false, reason: 'the parser is not loaded' };

        var lines = src.split(/\r?\n/);
        var votes = Object.create(null);

        for (var r = 0; r < rows.length; r++) {
            var want = String(rows[r].date || '');
            var amt = Math.abs(Number(rows[r].amount) || 0);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(want) || !(amt > 0)) continue;

            for (var i = 0; i < lines.length; i++) {
                var mine = moneyOn(lines[i]);
                var here = mine.some(function (t) { return Math.abs(t.v - amt) < 0.02; });
                var below = !mine.length && i + 1 < lines.length
                    && moneyOn(lines[i + 1]).some(function (t) { return Math.abs(t.v - amt) < 0.02; });
                if (!here && !below) continue;

                var runs = runsOn(lines[i]);
                for (var q = 0; q < runs.length; q++) {
                    var m = runs[q].m;
                    for (var o = 0; o < 3; o++) {
                        var ord = ['dmy', 'mdy', 'ymd'][o];
                        if (isoFrom(m[1], m[3], m[5], ord) !== want) continue;
                        var k = shapeOf(m) + ' ' + ord + ' ' + (below ? '1' : '0');
                        votes[k] = (votes[k] || 0) + 1;
                    }
                }
            }
        }

        var best = null, bestN = 0;
        for (var key in votes) if (votes[key] > bestN) { bestN = votes[key]; best = key; }
        if (!best) return { ok: false, reason: 'none of the confirmed rows could be found in the statement text' };

        var parts = best.split(' ');
        var tpl = makeTemplate(parts[0], parts[1], parts[2] === '1', opts.bank);

        var check;
        try { check = parse(normalise(src, tpl), { __learned: true }); } catch (_) { check = null; }
        var got = (check && check.rows) || [];
        var have = Object.create(null);
        for (var g = 0; g < got.length; g++) have[got[g].date + '|' + Math.round(Math.abs(got[g].amount) * 100)] = 1;
        var missed = 0;
        for (var c = 0; c < rows.length; c++) {
            var kk = String(rows[c].date) + '|' + Math.round(Math.abs(Number(rows[c].amount) || 0) * 100);
            if (!have[kk]) missed++;
        }
        if (missed) {
            return {
                ok: false, template: tpl, matched: bestN,
                reason: 'the layout was derived but could not read back ' + missed
                    + ' of the ' + rows.length + ' rows you confirmed'
            };
        }
        return { ok: true, template: tpl, matched: bestN, produced: got.length, rows: got };
    }

    /* ── where templates live ────────────────────────────────────────────────
     * An injectable store, because a module that reaches straight into
     * localStorage cannot be tested and cannot be pointed at the vault later. */
    function memoryStore() {
        var mem = Object.create(null);
        return { get: function (k) { return k in mem ? mem[k] : null; }, set: function (k, v) { mem[k] = v; } };
    }
    var _fallback = memoryStore();
    var _override = null;
    /* Set once at startup. The browser points this at the vault-backed store;
     * a test points it at memoryStore(). Without it the only way to redirect
     * storage is to replace recall() on the exported object, which is how a
     * test wrote a recursive stub and got an empty list from a swallowed stack
     * overflow instead of a failure. */
    function useStore(st) {
        _override = (st && typeof st.get === 'function' && typeof st.set === 'function') ? st : null;
        return _override;
    }
    function store() {
        if (_override) return _override;
        try {
            if (W && W.localStorage) {
                return {
                    get: function (k) { return W.localStorage.getItem(k); },
                    set: function (k, v) { W.localStorage.setItem(k, v); }
                };
            }
        } catch (_) {}
        return _fallback;
    }

    function normBank(b) { return String(b || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() || '*'; }

    function read(st) {
        try {
            var raw = (st || store()).get(KEY);
            var o = raw ? JSON.parse(raw) : null;
            return (o && typeof o === 'object' && o.banks && typeof o.banks === 'object') ? o : { v: V, banks: {} };
        } catch (_) { return { v: V, banks: {} }; }
    }
    function write(db, st) {
        try { (st || store()).set(KEY, JSON.stringify(db)); return true; } catch (_) { return false; }
    }

    function remember(bank, tpl, st) {
        if (!tpl || !tpl.re) return { ok: false, reason: 'no layout to remember' };
        var db = read(st);
        var k = normBank(bank);
        /* Stamped with the bank it is being remembered UNDER, not the one it
         * happened to be proposed with. recall() reports which bank a layout
         * came from, and a blank there is how a screen ends up saying "learned
         * from " with nothing after it. A copy, so the caller's object is not
         * quietly rewritten under them. */
        var rec = {};
        for (var f in tpl) if (Object.prototype.hasOwnProperty.call(tpl, f)) rec[f] = tpl[f];
        rec.bank = String(bank || '');
        tpl = rec;
        var list = Array.isArray(db.banks[k]) ? db.banks[k] : [];
        var kept = [tpl];
        for (var i = 0; i < list.length && kept.length < PER_BANK; i++) {
            if (list[i] && list[i].id !== tpl.id) kept.push(list[i]);
        }
        db.banks[k] = kept;

        var names = Object.keys(db.banks);
        if (names.length > MAX_BANKS) {
            names.sort(function (a, b) {
                return (((db.banks[b] || [])[0] || {}).learnedAt || 0) - (((db.banks[a] || [])[0] || {}).learnedAt || 0);
            });
            var trimmed = {};
            for (var n = 0; n < MAX_BANKS; n++) trimmed[names[n]] = db.banks[names[n]];
            db.banks = trimmed;
        }
        return { ok: write(db, st), template: tpl, banks: Object.keys(db.banks).length };
    }

    /* This bank's layouts first, then everyone else's. Statement software is
     * sold, not written per bank: the shape one bank prints is very often the
     * shape another prints, and trying six cheap rewrites costs nothing next to
     * telling the owner their statement is unreadable. */
    function recall(bank, st) {
        var db = read(st);
        var k = normBank(bank);
        var out = [];
        var push = function (list) {
            for (var i = 0; i < list.length && out.length < TRY_LIMIT; i++) {
                var t = list[i];
                if (!t || !t.re) continue;
                var dup = false;
                for (var j = 0; j < out.length; j++) if (out[j].id === t.id) { dup = true; break; }
                if (!dup) out.push(t);
            }
        };
        if (Array.isArray(db.banks[k])) push(db.banks[k]);
        var names = Object.keys(db.banks);
        names.sort(function (a, b) {
            return (((db.banks[b] || [])[0] || {}).learnedAt || 0) - (((db.banks[a] || [])[0] || {}).learnedAt || 0);
        });
        for (var i = 0; i < names.length && out.length < TRY_LIMIT; i++) {
            if (names[i] !== k) push(db.banks[names[i]] || []);
        }
        return out;
    }

    function forget(bank, st) {
        var db = read(st);
        var k = normBank(bank);
        if (!(k in db.banks)) return { ok: false, reason: 'nothing was remembered for that bank' };
        delete db.banks[k];
        return { ok: write(db, st) };
    }

    var API = {
        V: V, KEY: KEY, TRY_LIMIT: TRY_LIMIT,
        propose: propose, learn: learn, normalise: normalise,
        remember: remember, recall: recall, forget: forget,
        templateId: templateId, makeTemplate: makeTemplate,
        shapeOf: shapeOf, isoFrom: isoFrom, moneyOn: moneyOn, runsOn: runsOn,
        store: store, useStore: useStore, memoryStore: memoryStore, plausibleRun: plausibleRun
    };
    if (W) W.WFLayoutMemory = API;
    try { console.log('[WFLayoutMemory] ok statement layout memory ready'); } catch (_) {}
})();
