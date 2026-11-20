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

  function money(cents) {
    var neg = cents < 0;
    var abs = Math.abs(cents);
    var whole = Math.floor(abs / 100);
    var frac = abs % 100;
    var s;
    try {
      s = whole.toLocaleString('en-LK', { maximumFractionDigits: 0 });
    } catch (e) {
      s = String(whole);
    }
    return (neg ? '-' : '') + 'LKR ' + s + '.' + (frac < 10 ? '0' + frac : String(frac));
  }

  function safeStr(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    return '';
  }

  function parseDate(v) {
    if (!v) return null;
    var d = new Date(v);
    if (isNaN(d.getTime())) return null;
    return d;
  }

  function monthsBetween(from, to) {
    if (!from || !to) return null;
    var m = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (to.getDate() < from.getDate()) m -= 1;
    return m;
  }

  function addMonths(d, n) {
    var y = d.getFullYear();
    var mo = d.getMonth() + n;
    var day = d.getDate();
    var out = new Date(y, mo, 1);
    var last = new Date(out.getFullYear(), out.getMonth() + 1, 0).getDate();
    out.setDate(Math.min(day, last));
    return out;
  }

  function fmtDate(d) {
    if (!d) return '';
    var y = d.getFullYear();
    var m = d.getMonth() + 1;
    var day = d.getDate();
    return y + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
  }

  function endOfPlan(rec) {
    var start = parseDate(rec && rec.date);
    var dur = rec && typeof rec.duration === 'number' && isFinite(rec.duration) ? Math.floor(rec.duration) : 0;
    if (!start || dur <= 0) return null;
    return addMonths(start, dur);
  }

  function isDone(rec, now) {
    if (!rec) return false;
    if (rec.completed) return true;
    var end = endOfPlan(rec);
    if (!end) return false;
    return end <= (now || new Date());
  }

  /* Pure: record in, lines out. Each line is {label, value, kind}. */
  function compute(rec, now) {
    if (!rec || typeof rec !== 'object') return [];
    var lines = [];
    var product = safeStr(rec.product) || 'Instalment plan';
    lines.push({ label: 'Product', value: product, kind: 'title' });

    if (rec.notes) lines.push({ label: 'Notes', value: safeStr(rec.notes), kind: 'text' });
    lines.push({ label: 'Card', value: safeStr(rec.bank) || 'Not stated', kind: 'text' });
    lines.push({ label: 'Buyer', value: safeStr(rec.buyer) || 'Self', kind: 'text' });

    var monthlyC = toCents(rec.monthly);
    lines.push({ label: 'Monthly', value: money(monthlyC), kind: 'money' });

    var totalC = toCents(rec.total);
    var totalLabel = 'Total';
    if (rec.totalEstimated) totalLabel = 'Total (estimate)';
    else if (rec.durationUnknown) totalLabel = 'Total (months seen so far)';
    lines.push({ label: totalLabel, value: money(totalC), kind: 'money' });

    if (rec.outstanding !== null && rec.outstanding !== undefined && !isDone(rec, now)) {
      lines.push({ label: 'Bank says still owed', value: money(toCents(rec.outstanding)), kind: 'money' });
    }

    var rate = typeof rec.rate === 'number' && isFinite(rec.rate) ? rec.rate : 0;
    var rateText;
    if (rate > 0) rateText = rate + '%';
    else if (rec.rateUnknown) rateText = 'Not stated';
    else rateText = '0% Free';
    lines.push({ label: 'Rate', value: rateText, kind: 'text' });

    var dur = typeof rec.duration === 'number' && isFinite(rec.duration) ? Math.floor(rec.duration) : 0;
    var durText = dur > 0 ? (rec.durationUnknown ? dur + 'M+' : dur + 'M') : 'Not stated';
    lines.push({ label: 'Length', value: durText, kind: 'text' });

    var start = parseDate(rec.date);
    lines.push({ label: 'Started', value: start ? fmtDate(start) : 'Not stated', kind: 'text' });

    var end = endOfPlan(rec);
    if (end) lines.push({ label: 'Last month', value: fmtDate(end), kind: 'text' });

    var skipped = Array.isArray(rec.skipped) ? rec.skipped.length : 0;
    if (skipped > 0) lines.push({ label: 'Skipped months', value: String(skipped), kind: 'text' });

    /* remaining months: from now to the last month, never negative */
    var remaining = null;
    if (end) {
      var ref = now || new Date();
      var r = monthsBetween(ref, end);
      if (r !== null) remaining = r < 0 ? 0 : r;
    }
    if (remaining !== null) {
      lines.push({ label: 'Months remaining', value: String(remaining), kind: 'text' });
    }

    /* progress: paid months / total months, in whole numbers */
    var paid = 0;
    if (start && dur > 0) {
      var ref2 = now || new Date();
      var elapsed = monthsBetween(start, ref2);
      if (elapsed !== null) {
        paid = elapsed < 0 ? 0 : (elapsed > dur ? dur : elapsed);
      }
    }
    if (dur > 0) {
      var pct = Math.round((paid / dur) * 100);
      if (pct < 0) pct = 0;
      if (pct > 100) pct = 100;
      lines.push({ label: 'Progress', value: paid + '/' + dur + ' (' + pct + '%)', kind: 'text' });
    }

    lines.push({ label: 'Status', value: isDone(rec, now) ? 'Done' : 'Active', kind: 'status' });
    return lines;
  }

  /* ---------- DOM part ---------- */

  var mounted = false;
  var host = null;
  var sheet = null;
  var lastFocus = null;

  function prefersReducedMotion() {
    try {
      return !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
    } catch (e) {
      return false;
    }
  }

  function readBooks() {
    try {
      if (!root.DB || typeof root.DB.get !== 'function') return [];
      var arr = root.DB.get(BOOK_KEY);
      return Array.isArray(arr) ? arr : [];
    } catch (e) {
      return [];
    }
  }

  function findRecord(id) {
    if (!id) return null;
    var arr = readBooks();
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (r && safeStr(r.id) === safeStr(id)) return r;
    }
    return null;
  }

  /* Find the record the person tapped by matching the product text in the row. */
  function findRecordByProduct(productText) {
    if (!productText) return null;
    var arr = readBooks();
    var want = safeStr(productText).trim();
    if (!want) return null;
    var exact = null;
    for (var i = 0; i < arr.length; i++) {
      var r = arr[i];
      if (!r || r.mergedInto) continue;
      if (safeStr(r.product).trim() === want) { exact = r; break; }
    }
    return exact;
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }

  function buildSheet() {
    var wrap = el('div', 'wf-cci-detail-backdrop');
    wrap.id = SHEET_ID;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');
    wrap.setAttribute('aria-label', 'Instalment plan details');
    wrap.style.position = 'fixed';
    wrap.style.inset = '0';
    wrap.style.background = 'rgba(0,0,0,0.55)';
    wrap.style.zIndex = '9999';
    wrap.style.display = 'none';
    wrap.style.alignItems = 'flex-end';
    wrap.style.justifyContent = 'center';
    wrap.style.padding = '0';

    var panel = el('div', 'wf-cci-detail-panel');
    panel.style.background = 'var(--card, #fff)';
    panel.style.color = 'var(--text, #111)';
    panel.style.width = '100%';
    panel.style.maxWidth = '560px';
    panel.style.maxHeight = '85vh';
    panel.style.overflowY = 'auto';
    panel.style.borderRadius = '16px 16px 0 0';
    panel.style.padding = '16px 16px 24px';
    panel.style.boxSizing = 'border-box';
    panel.style.boxShadow = '0 -8px 24px rgba(0,0,0,0.25)';
    if (!prefersReducedMotion()) {
      panel.style.transition = 'transform 180ms ease-out';
    }

    var head = el('div', 'wf-cci-detail-head');
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.justifyContent = 'space-between';
    head.style.gap = '8px';
    head.style.marginBottom = '12px';

    var title = el('div', 'wf-cci-detail-title', 'Plan details');
    title.style.fontWeight = '700';
    title.style.fontSize = '16px';
    title.style.flex = '1';

    var close = el('button', 'wf-cci-detail-close', 'Close');
    close.type = 'button';
    close.setAttribute('aria-label', 'Close plan details');
    close.style.minWidth = '44px';
    close.style.minHeight = '44px';
    close.style.padding = '0 12px';
    close.style.border = '1px solid var(--border, #ccc)';
    close.style.background = 'transparent';
    close.style.color = 'inherit';
    close.style.borderRadius = '10px';
    close.style.fontSize = '14px';
    close.style.cursor = 'pointer';

    head.appendChild(title);
    head.appendChild(close);

    var body = el('div', 'wf-cci-detail-body');
    body.id = 'wfCciDetailBody';
    body.style.display = 'flex';
    body.style.flexDirection = 'column';
    body.style.gap = '8px';

    panel.appendChild(head);
    panel.appendChild(body);
    wrap.appendChild(panel);

    close.addEventListener('click', function () { closeSheet(); });
    wrap.addEventListener('click', function (ev) {
      if (ev.target === wrap) closeSheet();
    });

    return wrap;
  }

  function renderLines(lines) {
    var body = document.getElementById('wfCciDetailBody');
    if (!body) return;
    while (body.firstChild) body.removeChild(body.firstChild);
    if (!lines || !lines.length) {
      body.appendChild(el('div', 'wf-cci-detail-empty', 'No details to show.'));
      return;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var row = el('div', 'wf-cci-detail-row');
      row.style.display = 'flex';
      row.style.justifyContent = 'space-between';
      row.style.alignItems = 'baseline';
      row.style.gap = '12px';
      row.style.padding = '6px 0';
      row.style.borderBottom = '1px solid var(--border, #eee)';

      var lab = el('div', 'wf-cci-detail-label', line.label);
      lab.style.color = 'var(--text3, #666)';
      lab.style.fontSize = '12px';
      lab.style.flex = '0 0 auto';

      var val = el('div', 'wf-cci-detail-value', line.value);
      val.style.fontSize = line.kind === 'title' ? '15px' : '14px';
      val.style.fontWeight = line.kind === 'title' || line.kind === 'money' ? '600' : '400';
      val.style.textAlign = 'right';
      val.style.wordBreak = 'break-word';
      val.style.flex = '1 1 auto';

      row.appendChild(lab);
      row.appendChild(val);
      body.appendChild(row);
    }
  }

  function openSheet(rec) {
    if (!sheet) return;
    var lines = compute(rec, new Date());
    renderLines(lines);
    lastFocus = document.activeElement;
    sheet.style.display = 'flex';
    var closeBtn = sheet.querySelector('.wf-cci-detail-close');
    if (closeBtn && typeof closeBtn.focus === 'function') {
      try { closeBtn.focus(); } catch (e) { /* ignore */ }
    }
  }

  function closeSheet() {
    if (!sheet) return;
    sheet.style.display = 'none';
    if (lastFocus && typeof lastFocus.focus === 'function') {
      try { lastFocus.focus(); } catch (e) { /* ignore */ }
    }
    lastFocus = null;
  }

  /* Delegated listener on the table body the page fills. */
  function onTableClick(ev) {
    var target = ev.target;
    if (!target || !target.closest) return;
    /* Ignore taps on the action buttons: they have their own handlers. */
    if (target.closest('.act-btns')) return;
    var tr = target.closest('tr');
    if (!tr) return;
    var tbody = tr.parentNode;
    if (!tbody || tbody.id !== 'cciBody') return;
    /* The product name is the first cell's first div. */
    var firstCell = tr.querySelector('td');
    if (!firstCell) return;
    var productEl = firstCell.querySelector('div');
    var productText = productEl ? productEl.textContent : '';
    var rec = findRecordByProduct(productText);
    if (!rec) return;
    openSheet(rec);
  }

  function onKeyDown(ev) {
    if (ev.key === 'Escape' || ev.key === 'Esc') {
      if (sheet && sheet.style.display !== 'none') {
        ev.preventDefault();
        closeSheet();
      }
    }
  }

  function mount() {
    if (mounted) return;
    if (typeof document === 'undefined' || !document.body) return;
    mounted = true;

    host = document.createElement('div');
    host.id = CONTAINER_ID;
    host.setAttribute('data-wf-new', '2026-11-20');
    host.style.position = 'relative';
    host.style.zIndex = '0';

    sheet = buildSheet();
    host.appendChild(sheet);
    document.body.appendChild(host);

    var tbody = document.getElementById('cciBody');
    if (tbody) tbody.addEventListener('click', onTableClick);
    document.addEventListener('keydown', onKeyDown);
  }

  function unmount() {
    if (!mounted) return;
    mounted = false;
    var tbody = document.getElementById('cciBody');
    if (tbody) tbody.removeEventListener('click', onTableClick);
    document.removeEventListener('keydown', onKeyDown);
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = null;
    sheet = null;
  }

  /* ---------- public API ---------- */

  var api = {
    compute: compute,
    money: money,
    toCents: toCents,
    mount: mount,
    unmount: unmount,
    open: function (id) {
      var rec = findRecord(id);
      if (!rec) return false;
      if (!mounted) mount();
      openSheet(rec);
      return true;
    },
    close: closeSheet,
    findRecord: findRecord,
    findRecordByProduct: findRecordByProduct,
    CONTAINER_ID: CONTAINER_ID,
    SHEET_ID: SHEET_ID,
    BOOK_KEY: BOOK_KEY
  };

  root.WFCCInstalmentDetail = api;

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', mount);
    } else {
      mount();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);

/* TEST RECIPE
   books: {"ccinstall": [{"id":"p1","product":"iPhone 15","bank":"HNB Credit Card","buyer":"Self","monthly":15000,"total":180000,"rate":0,"duration":12,"date":"2025-01-15","completed":false,"notes":"","skipped":[]}]}
   page: <table><tbody id="cciBody"><tr><td><div>iPhone 15</div></td><td>Self</td><td><span class="badge bg-b">HNB Credit Card</span></td><td class="td-a">LKR 180,000.00</td><td class="td-mono">0% Free</td><td class="td-r">LKR 15,000.00</td><td class="td-mono">12M</td><td class="td-m td-date">2025-01-15</td><td></td><td><span class="badge bg-g">Active</span></td><td><div class="act-btns"></div></td></tr></tbody></table>
   steps: WFCCInstalmentDetail.mount(); WFCCInstalmentDetail.open("p1")
   expect: #wfCciDetailBody holds text "iPhone 15" and "LKR 15,000.00"
*/
