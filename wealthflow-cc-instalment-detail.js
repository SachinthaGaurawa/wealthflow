(function (root) {
  'use strict';

  var NEW_DATE = '2026-11-20';
  var CONTAINER_ID = 'wfCciDetailHost';
  var SHEET_ID = 'wfCciDetailSheet';
  var BOOK_KEY = 'ccinstall';

  /* ---------- pure helpers ---------- */

  function toCents(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return 0;
    return Math.round(n * 100);
  }

  function fmtMoney(cents) {
    var n = (typeof cents === 'number' && isFinite(cents)) ? cents / 100 : 0;
    try {
      return 'LKR ' + n.toLocaleString('en-LK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    } catch (e) {
      return 'LKR ' + n.toFixed(2);
    }
  }

  function safeStr(v) {
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function parseDate(v) {
    if (!v) return null;
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function monthsBetween(from, to) {
    if (!from || !to) return 0;
    var m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (to.getDate() < from.getDate()) m -= 1;
    return m < 0 ? 0 : m;
  }

  /* The page's own rule for "done": completed flag, or the last month has passed.
     Mirrors _cciDone in renderCCI so the sheet and the table never disagree. */
  function endOf(rec) {
    var start = parseDate(rec && rec.date);
    var dur = (rec && typeof rec.duration === 'number' && isFinite(rec.duration) && rec.duration > 0) ? Math.floor(rec.duration) : 0;
    if (!start || !dur) return null;
    return new Date(start.getFullYear(), start.getMonth() + dur, start.getDate());
  }

  function isDone(rec, now) {
    if (!rec) return false;
    if (rec.completed) return true;
    var end = endOf(rec);
    if (!end) return false;
    var nowD = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();
    return end <= nowD;
  }

  /* Build the read-only lines for one plan record. Pure: no DOM, no DB. */
  function compute(rec, now) {
    var out = { title: 'Instalment plan', lines: [], schedule: [], ok: false, status: 'Active' };
    if (!rec || typeof rec !== 'object') return out;
    out.ok = true;

    var product = safeStr(rec.product) || 'Instalment plan';
    out.title = product;

    var totalC = toCents(rec.total);
    var monthlyC = toCents(rec.monthly);
    var duration = (typeof rec.duration === 'number' && isFinite(rec.duration) && rec.duration > 0) ? Math.floor(rec.duration) : 0;
    var start = parseDate(rec.date);
    var nowD = now instanceof Date && !isNaN(now.getTime()) ? now : new Date();

    var skipped = Array.isArray(rec.skipped) ? rec.skipped.length : 0;
    var finished = isDone(rec, nowD);
    out.status = finished ? 'Done' : 'Active';

    var elapsed = start ? monthsBetween(start, nowD) : 0;
    if (elapsed > duration) elapsed = duration;
    var paidMonths = elapsed - skipped;
    if (paidMonths < 0) paidMonths = 0;
    if (paidMonths > duration) paidMonths = duration;
    var remaining = duration - paidMonths;
    if (remaining < 0) remaining = 0;
    if (finished) remaining = 0;

    var paidC = monthlyC * paidMonths;
    if (paidC > totalC && totalC > 0) paidC = totalC;
    var remainingC = totalC - paidC;
    if (remainingC < 0) remainingC = 0;

    out.lines.push({ label: 'Product', value: product });
    if (rec.buyer) out.lines.push({ label: 'Buyer', value: safeStr(rec.buyer) });
    if (rec.bank) out.lines.push({ label: 'Card', value: safeStr(rec.bank) });
    out.lines.push({ label: 'Monthly', value: fmtMoney(monthlyC) });
    out.lines.push({ label: 'Total', value: fmtMoney(totalC) + (rec.totalEstimated ? ' (estimate)' : '') });
    if (rec.rate !== undefined && rec.rate !== null) {
      var rate = typeof rec.rate === 'number' ? rec.rate : parseFloat(rec.rate);
      if (isFinite(rate)) {
        out.lines.push({ label: 'Rate', value: rate > 0 ? rate + '%' : (rec.rateUnknown ? 'not stated' : '0% Free') });
      }
    }
    if (duration > 0) {
      out.lines.push({ label: 'Length', value: duration + 'M' + (rec.durationUnknown ? '+' : '') });
    }
    if (start) {
      out.lines.push({ label: 'Started', value: safeStr(rec.date) });
    }
    out.lines.push({ label: 'Paid so far', value: fmtMoney(paidC) + ' (' + paidMonths + '/' + duration + ')' });
    out.lines.push({ label: 'Remaining', value: fmtMoney(remainingC) + ' (' + remaining + ' months)' });
    if (skipped > 0) out.lines.push({ label: 'Skipped', value: skipped + ' month' + (skipped === 1 ? '' : 's') });
    if (rec.outstanding !== undefined && rec.outstanding !== null && !finished) {
      out.lines.push({ label: 'Bank says owed', value: fmtMoney(toCents(rec.outstanding)) });
    }
    if (rec.notes) out.lines.push({ label: 'Notes', value: safeStr(rec.notes) });
    out.lines.push({ label: 'Status', value: out.status });

    /* schedule: one row per month from start */
    if (start && duration > 0) {
      var cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());
      for (var i = 0; i < duration; i++) {
        var isPast = cursor <= nowD;
        var isSkipped = false;
        if (Array.isArray(rec.skipped)) {
          for (var k = 0; k < rec.skipped.length; k++) {
            var sd = parseDate(rec.skipped[k]);
            if (sd && sd.getFullYear() === cursor.getFullYear() && sd.getMonth() === cursor.getMonth()) { isSkipped = true; break; }
          }
        }
        var label = cursor.getFullYear() + '-' + ('0' + (cursor.getMonth() + 1)).slice(-2);
        out.schedule.push({
          month: label,
          amount: fmtMoney(monthlyC),
          state: isSkipped ? 'skipped' : (isPast ? 'paid' : 'due')
        });
        cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, cursor.getDate());
      }
    }
    return out;
  }

  /* ---------- DOM ---------- */

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) { return false; }
  }

  function ensureContainer() {
    if (typeof document === 'undefined' || !document.body) return null;
    var existing = document.getElementById(CONTAINER_ID);
    if (existing) return existing;
    var host = el('div');
    host.id = CONTAINER_ID;
    host.style.position = 'fixed';
    host.style.inset = '0';
    host.style.zIndex = '9999';
    host.style.display = 'none';
    host.style.background = 'rgba(0,0,0,0.55)';
    host.style.overflowY = 'auto';
    host.style.webkitOverflowScrolling = 'touch';
    host.style.padding = '12px';
    host.style.boxSizing = 'border-box';
    document.body.appendChild(host);
    return host;
  }

  function closeSheet() {
    var host = document.getElementById(CONTAINER_ID);
    if (host) { host.style.display = 'none'; host.textContent = ''; }
  }

  function renderSheet(rec) {
    var host = ensureContainer();
    if (!host) return;
    host.textContent = '';

    var data = compute(rec, new Date());

    var sheet = el('div');
    sheet.id = SHEET_ID;
    sheet.setAttribute('data-wf-new', '2026-11-20');
    sheet.setAttribute('role', 'dialog');
    sheet.setAttribute('aria-modal', 'true');
    sheet.setAttribute('aria-label', 'Instalment plan details');
    sheet.style.background = 'var(--bg, #fff)';
    sheet.style.color = 'var(--text, #111)';
    sheet.style.margin = '0 auto';
    sheet.style.maxWidth = '560px';
    sheet.style.width = '100%';
    sheet.style.borderRadius = '12px';
    sheet.style.padding = '16px';
    sheet.style.boxSizing = 'border-box';
    sheet.style.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';
    /* the sheet itself never clips: the host scrolls, and the schedule
       gets its own bounded scroll box so the last rows stay reachable */
    sheet.style.maxHeight = 'calc(100vh - 24px)';
    sheet.style.display = 'flex';
    sheet.style.flexDirection = 'column';
    sheet.style.overflow = 'hidden';
    if (!prefersReducedMotion()) {
      sheet.style.transition = 'opacity 120ms ease-out';
    }

    var head = el('div');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.gap = '8px';
    head.style.marginBottom = '12px';
    head.style.flex = '0 0 auto';

    var title = el('div', null, data.title);
    title.id = 'wfCciDetailTitle';
    title.style.fontWeight = '700';
    title.style.fontSize = '16px';
    title.style.flex = '1';
    title.style.minWidth = '0';
    title.style.wordBreak = 'break-word';
    head.appendChild(title);

    var closeBtn = el('button', null, 'Close');
    closeBtn.type = 'button';
    closeBtn.id = 'wfCciDetailClose';
    closeBtn.setAttribute('aria-label', 'Close detail');
    closeBtn.style.minWidth = '44px';
    closeBtn.style.minHeight = '44px';
    closeBtn.style.padding = '8px 12px';
    closeBtn.style.border = '1px solid var(--border, #ccc)';
    closeBtn.style.background = 'transparent';
    closeBtn.style.color = 'inherit';
    closeBtn.style.borderRadius = '8px';
    closeBtn.style.cursor = 'pointer';
    closeBtn.style.flex = '0 0 auto';
    closeBtn.addEventListener('click', closeSheet);
    head.appendChild(closeBtn);
    sheet.appendChild(head);

    /* scrollable body: everything below the header lives here */
    var body = el('div');
    body.id = 'wfCciDetailBody';
    body.style.flex = '1 1 auto';
    body.style.minHeight = '0';
    body.style.overflowY = 'auto';
    body.style.webkitOverflowScrolling = 'touch';
    body.style.paddingRight = '2px';
    /* bottom padding so the last schedule row is never flush against the
       sheet edge (and never under anything the app floats there) */
    body.style.paddingBottom = '24px';

    var list = el('div');
    list.id = 'wfCciDetailLines';
    for (var i = 0; i < data.lines.length; i++) {
      var row = el('div');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.gap = '12px';
      row.style.padding = '6px 0';
      row.style.borderBottom = '1px solid var(--border, #eee)';
      var lab = el('span', null, data.lines[i].label);
      lab.style.color = 'var(--text3, #666)';
      lab.style.fontSize = '13px';
      var val = el('span', null, data.lines[i].value);
      val.style.fontWeight = '600';
      val.style.textAlign = 'right';
      val.style.wordBreak = 'break-word';
      row.appendChild(lab);
      row.appendChild(val);
      list.appendChild(row);
    }
    body.appendChild(list);

    if (data.schedule.length) {
      var schedHead = el('div', null, 'Schedule');
      schedHead.style.marginTop = '14px';
      schedHead.style.marginBottom = '6px';
      schedHead.style.fontWeight = '700';
      schedHead.style.fontSize = '14px';
      body.appendChild(schedHead);

      /* bounded scroll box with a visible edge so the person can tell
         there are more rows below */
      var sched = el('div');
      sched.id = 'wfCciDetailSchedule';
      sched.style.maxHeight = '40vh';
      sched.style.overflowY = 'auto';
      sched.style.webkitOverflowScrolling = 'touch';
      sched.style.border = '1px solid var(--border, #eee)';
      sched.style.borderRadius = '8px';
      sched.style.padding = '4px 8px';
      sched.style.boxSizing = 'border-box';
      sched.setAttribute('tabindex', '0');
      sched.setAttribute('aria-label', 'Payment schedule, scrollable');
      for (var j = 0; j < data.schedule.length; j++) {
        var s = data.schedule[j];
        var srow = el('div');
        srow.style.display = 'flex';
        srow.style.justifyContent = 'space-between';
        srow.style.padding = '4px 0';
        srow.style.fontSize = '13px';
        var sm = el('span', null, s.month);
        var sa = el('span', null, s.amount + ' · ' + s.state);
        if (s.state === 'paid') sa.style.color = 'var(--text3, #666)';
        else if (s.state === 'skipped') sa.style.color = 'var(--accent, #c60)';
        srow.appendChild(sm);
        srow.appendChild(sa);
        sched.appendChild(srow);
      }
      body.appendChild(sched);
    }

    sheet.appendChild(body);
    host.appendChild(sheet);
    host.style.display = 'block';
  }

  /* ---------- data access ---------- */

  function readBooks() {
    try {
      if (!root.DB || typeof root.DB.get !== 'function') return [];
      var v = root.DB.get(BOOK_KEY);
      return Array.isArray(v) ? v : [];
    } catch (e) { return []; }
  }

  function findRecord(id) {
    if (!id) return null;
    var arr = readBooks();
    for (var i = 0; i < arr.length; i++) {
      if (arr[i] && String(arr[i].id) === String(id)) return arr[i];
    }
    return null;
  }

  function open(id) {
    var rec = findRecord(id);
    if (!rec) return false;
    renderSheet(rec);
    return true;
  }

  /* ---------- delegated click on the table ---------- */

  function findRowRecord(tr) {
    if (!tr) return null;
    var btns = tr.querySelectorAll('button[onclick]');
    for (var i = 0; i < btns.length; i++) {
      var oc = btns[i].getAttribute('onclick') || '';
      var m = oc.match(/(?:editCCI|markCCIDone|deleteCCI)\(\s*'([^']+)'/);
      if (m) return findRecord(m[1]);
    }
    return null;
  }

  function onTableClick(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    /* ignore clicks on the action buttons themselves */
    if (t.closest('button')) return;
    var tr = t.closest('tr');
    if (!tr) return;
    var tbody = tr.parentNode;
    if (!tbody || tbody.id !== 'cciBody') return;
    var rec = findRowRecord(tr);
    if (rec) renderSheet(rec);
  }

  function wire() {
    if (typeof document === 'undefined') return;
    var tbody = document.getElementById('cciBody');
    if (tbody && !tbody.__wfCciDetailWired) {
      tbody.addEventListener('click', onTableClick);
      tbody.__wfCciDetailWired = true;
    }
  }

  function mount() {
    if (typeof document === 'undefined') return;
    ensureContainer();
    wire();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
    /* re-wire after the table is redrawn */
    var mo = null;
    if (typeof MutationObserver !== 'undefined' && document.body) {
      mo = new MutationObserver(function () { wire(); });
      try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    }
  }

  root.WFCCInstalmentDetail = {
    mount: mount,
    open: open,
    close: closeSheet,
    compute: compute,
    isDone: isDone,
    _fmtMoney: fmtMoney,
    _toCents: toCents
  };
})(typeof window !== 'undefined' ? window : globalThis);

/* TEST RECIPE
   books: {"ccinstall": [{"id":"p1","product":"iPhone 15","buyer":"Self","bank":"HNB","total":314254,"monthly":20968.68,"duration":15,"rate":0,"date":"2025-06-15","completed":false,"skipped":[],"notes":"3-year plan"}]}
   page: <table><tbody id="cciBody"><tr><td>iPhone 15</td><td><button onclick="editCCI('p1')">edit</button></td></tr></tbody></table>
   steps: WFCCInstalmentDetail.mount(); WFCCInstalmentDetail.open("p1")
   expect: #wfCciDetailTitle holds "iPhone 15"
*/
