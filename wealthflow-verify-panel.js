/* =============================================================================
 *  WealthFlow — Merchant Review  v1.0   ·   window.WFVerifyPanel
 *
 *  The system now REFUSES to guess. When it cannot verify a merchant beyond 0.95
 *  it writes nothing and holds it — which is correct, but useless unless you can
 *  see it. This is that screen.
 *
 *  For every held merchant it shows you: the raw line from your statement, what
 *  the web actually found, the sources it found them in (tap to read them), how
 *  confident it was, and in plain words WHY it refused. One tap sets the category
 *  and it is learned forever.
 *
 *  Read-only against your data until you press Confirm. No emojis; inline SVG only.
 * ============================================================================= */
(function () {
    var W = (typeof window !== 'undefined') ? window : (typeof globalThis !== 'undefined' ? globalThis : {});
    if (W.WF_VERIFY_PANEL === '1.0') return;
    W.WF_VERIFY_PANEL = '1.0';

    var CATS = ['Telecom', 'Insurance', 'Streaming', 'Software', 'Internet', 'Utilities', 'Groceries', 'Dining', 'Health', 'Transport', 'Fuel', 'Education', 'Government', 'Shopping', 'Gold', 'Gym/Fitness', 'Leasing'];
    var ICON = {
        shield: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
        x: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6L6 18M6 6l12 12"/></svg>',
        link: '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>',
        check: '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>',
        none: '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="9"/></svg>'
    };
    var CSS = [
        '.wfv-ov{position:fixed;inset:0;z-index:99996;background:rgba(4,7,14,.86);display:flex;align-items:flex-end;justify-content:center}',
        '.wfv-sh{width:100%;max-width:640px;max-height:92vh;display:flex;flex-direction:column;background:var(--card,#0d1220);border:1px solid var(--border,rgba(255,255,255,.09));border-radius:22px 22px 0 0;box-shadow:0 -18px 60px rgba(0,0,0,.6);overflow:hidden}',
        '@media(min-width:700px){.wfv-ov{align-items:center}.wfv-sh{border-radius:22px}}',
        '.wfv-hd{display:flex;align-items:center;gap:11px;padding:17px 18px;border-bottom:1px solid var(--border,rgba(255,255,255,.08))}',
        '.wfv-hd h3{margin:0;font-size:15.5px;font-weight:800;color:var(--text,#eef2f8);letter-spacing:.1px}',
        '.wfv-hd p{margin:2px 0 0;font-size:11.5px;color:var(--muted,#8d99ad)}',
        '.wfv-ic{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;background:linear-gradient(135deg,rgba(212,175,55,.18),rgba(212,175,55,.05));color:#d4af37;flex:0 0 auto}',
        '.wfv-x{margin-left:auto;width:32px;height:32px;border-radius:9px;border:1px solid var(--border,rgba(255,255,255,.1));background:transparent;color:var(--muted,#8d99ad);display:grid;place-items:center;cursor:pointer}',
        '.wfv-x:hover{color:var(--text,#fff)}',
        '.wfv-bd{overflow-y:auto;padding:12px 14px 18px;-webkit-overflow-scrolling:touch}',
        '.wfv-card{border:1px solid var(--border,rgba(255,255,255,.08));border-radius:15px;padding:13px 13px 11px;margin-bottom:11px;background:rgba(255,255,255,.022)}',
        '.wfv-raw{font-size:11px;color:var(--muted,#8d99ad);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;line-height:1.45}',
        '.wfv-name{font-size:14.5px;font-weight:750;color:var(--text,#eef2f8);margin:5px 0 2px;line-height:1.3}',
        '.wfv-ind{font-size:11.5px;color:var(--muted,#8d99ad)}',
        '.wfv-why{margin-top:9px;padding:8px 10px;border-radius:9px;background:rgba(245,158,11,.09);border:1px solid rgba(245,158,11,.2);font-size:11.5px;color:#f0b34e;line-height:1.45}',
        '.wfv-src{display:flex;flex-wrap:wrap;gap:6px;margin-top:9px}',
        '.wfv-src a{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;color:#7fb2ff;text-decoration:none;border:1px solid rgba(127,178,255,.25);background:rgba(127,178,255,.07);padding:4px 8px;border-radius:999px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
        '.wfv-row{display:flex;gap:8px;margin-top:11px;align-items:center}',
        '.wfv-sel{flex:1;min-width:0;padding:9px 10px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.12));background:var(--bg,#070b14);color:var(--text,#eef2f8);font-size:12.5px;font-weight:600}',
        '.wfv-ok{flex:0 0 auto;display:inline-flex;align-items:center;gap:6px;padding:9px 14px;border-radius:10px;border:1px solid rgba(16,185,129,.35);background:linear-gradient(135deg,rgba(16,185,129,.2),rgba(16,185,129,.08));color:#34d399;font-size:12.5px;font-weight:750;cursor:pointer}',
        '.wfv-ok:active{transform:scale(.97)}',
        '.wfv-sk{flex:0 0 auto;padding:9px 11px;border-radius:10px;border:1px solid var(--border,rgba(255,255,255,.1));background:transparent;color:var(--muted,#8d99ad);font-size:12.5px;font-weight:600;cursor:pointer}',
        '.wfv-empty{text-align:center;padding:40px 20px;color:var(--muted,#8d99ad)}',
        '.wfv-empty svg{color:#34d399;margin-bottom:10px}',
        '.wfv-empty b{display:block;color:var(--text,#eef2f8);font-size:14px;margin-bottom:5px}',
        '.wfv-conf{display:inline-block;font-size:10px;font-weight:750;padding:2px 7px;border-radius:999px;background:rgba(255,255,255,.06);color:var(--muted,#8d99ad);margin-left:6px;vertical-align:middle}'
    ].join('');

    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    function host(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return String(u).slice(0, 28); } }
    // Defence in depth: only ever render an http(s) link. /api/verify already restricts
    // evidence_urls to URLs that literally came back from the search, but a "javascript:"
    // href must never be renderable here under any circumstance.
    function safeUrl(u) {
        try { var x = new URL(String(u)); return (x.protocol === 'http:' || x.protocol === 'https:') ? x.href : null; }
        catch (_) { return null; }
    }
    function M() { return W.WFMerchants; }
    function pending() { try { return (M() && M().pending && M().pending()) || []; } catch (_) { return []; } }
    function count() { return pending().length; }

    function styleOnce() {
        if (document.getElementById('wfv-css')) return;
        var st = document.createElement('style'); st.id = 'wfv-css'; st.textContent = CSS;
        document.head.appendChild(st);
    }

    function tile(p) {
        var conf = (+p.confidence || 0);
        var srcs = (p.evidence || []).map(safeUrl).filter(Boolean).slice(0, 3).map(function (u) {
            return '<a href="' + esc(u) + '" target="_blank" rel="noopener noreferrer">' + ICON.link + esc(host(u)) + '</a>';
        }).join('');
        var opts = CATS.map(function (c) {
            return '<option value="' + esc(c) + '"' + (c === p.type ? ' selected' : '') + '>' + esc(c) + '</option>';
        }).join('');
        return '<div class="wfv-card" data-k="' + esc(p.key) + '">' +
            '<div class="wfv-raw">' + esc(String(p.raw || '').slice(0, 120)) + '</div>' +
            '<div class="wfv-name">' + esc(p.merchant || p.key) +
              (conf > 0 ? '<span class="wfv-conf">' + Math.round(conf * 100) + '% sure</span>' : '') + '</div>' +
            (p.industry ? '<div class="wfv-ind">' + esc(p.industry) + '</div>' : '') +
            (p.reason ? '<div class="wfv-why">Held: ' + esc(p.reason) + '</div>' : '') +
            (srcs ? '<div class="wfv-src">' + srcs + '</div>' : '') +
            '<div class="wfv-row">' +
              '<select class="wfv-sel">' + (p.type ? '' : '<option value="">Choose a category…</option>') + opts + '</select>' +
              '<button class="wfv-ok" type="button">' + ICON.check + 'Confirm</button>' +
              '<button class="wfv-sk" type="button">Skip</button>' +
            '</div></div>';
    }

    function render(body) {
        var list = pending();
        if (!list.length) {
            body.innerHTML = '<div class="wfv-empty">' + ICON.none +
                '<b>Nothing to review</b>Every merchant in your statements was identified with proof. ' +
                'Anything the system cannot verify will appear here rather than being guessed.</div>';
            return;
        }
        body.innerHTML = list.map(tile).join('');
        body.querySelectorAll('.wfv-card').forEach(function (card) {
            var key = card.getAttribute('data-k');
            card.querySelector('.wfv-ok').onclick = function () {
                var cat = card.querySelector('.wfv-sel').value;
                if (!cat) { try { W.notify && W.notify('Choose a category first.', 'warning'); } catch (_) {} return; }
                var done = false;
                try { done = M().confirm(key, cat); } catch (_) {}
                if (!done) { try { W.notify && W.notify('Could not save that.', 'error'); } catch (_) {} return; }
                try { W.notify && W.notify('Learned: ' + cat + '. It will be filed there from now on.', 'success'); } catch (_) {}
                try { if (typeof W._routeAll === 'function') W._routeAll(); } catch (_) {}
                render(body);
                badge();
            };
            card.querySelector('.wfv-sk').onclick = function () { card.remove(); if (!body.querySelector('.wfv-card')) render(body); };
        });
    }

    function open() {
        styleOnce();
        close();
        var ov = document.createElement('div');
        ov.className = 'wfv-ov'; ov.id = 'wfvOverlay';
        ov.innerHTML =
            '<div class="wfv-sh" role="dialog" aria-modal="true">' +
              '<div class="wfv-hd">' +
                '<div class="wfv-ic">' + ICON.shield + '</div>' +
                '<div><h3>Merchant review</h3><p>Verified against the web. Nothing was guessed.</p></div>' +
                '<button class="wfv-x" type="button" aria-label="Close">' + ICON.x + '</button>' +
              '</div><div class="wfv-bd" id="wfvBody"></div></div>';
        document.body.appendChild(ov);
        ov.querySelector('.wfv-x').onclick = close;
        ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
        render(ov.querySelector('#wfvBody'));
    }
    function close() { var o = document.getElementById('wfvOverlay'); if (o) o.remove(); }

    // Put a live count on any element that carries data-wfv-badge.
    function badge() {
        var n = count();
        document.querySelectorAll('[data-wfv-badge]').forEach(function (el) {
            el.textContent = n ? String(n) : '';
            el.style.display = n ? '' : 'none';
        });
        return n;
    }

    W.WFVerifyPanel = { open: open, close: close, count: count, badge: badge, render: render };
    W.wfOpenMerchantReview = open;   // callable straight from an onclick
    try { console.log('[WFVerifyPanel] Merchant review v1.0 loaded'); } catch (_) {}
})();
