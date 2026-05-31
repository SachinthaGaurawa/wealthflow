/* =============================================================================
   WealthFlow Card & Account Registry UI  v1.0  —  window.wfOpenCardRegistry
   ---------------------------------------------------------------------------
   Re-adds the Card & Account Registry modal (the backend wfCardRegistry was
   never removed — only this UI was). Mapping a card/account last-4 to a TYPE
   lets the brain route correctly:

     • debit on a CREDIT CARD   → CC One-Time (service charge is in the SMS)
     • debit on a BANK ACCOUNT  → Expenses
     • credit on a CREDIT CARD  → FIFO reconciliation (bill payment)

   Self-contained: builds its own overlay, reads/writes via window.wfCardRegistry
   (get/upsert/delete). No dependency on any removed inline function.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_CARD_REGISTRY_UI) return;
    window.WF_CARD_REGISTRY_UI = '1.0';

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function _notify(m,t){try{if(typeof window.notify==='function')window.notify(m,t||'info');}catch(_){}}

    const BANKS = ['Commercial Bank','HNB','Sampath Bank','Nations Trust Bank','Seylan Bank','DFCC Bank','NDB Bank','Bank of Ceylon',"People's Bank",'Pan Asia Bank','Union Bank','Standard Chartered','HSBC','American Express (AMEX)','NSB','Citibank','Other'];
    const TYPES = [['credit_card','💳 Credit Card'],['bank_account','🏦 Bank / Debit Account']];

    function _reg() {
        try { return (window.wfCardRegistry && window.wfCardRegistry.get && window.wfCardRegistry.get()) || {}; } catch (_) { return {}; }
    }

    function open() {
        close();
        const ov = document.createElement('div');
        ov.id = 'wfCardRegOverlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:99997;background:rgba(0,0,0,0.78);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;padding:16px;';
        ov.innerHTML =
            '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:560px;max-height:92vh;overflow-y:auto;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top,0px) + 14px));border-bottom:1px solid var(--border,#1f2638);">' +
                '<div style="font-weight:800;font-size:16px;color:var(--text,#e6e7eb);">Card &amp; Account Registry</div>' +
                '<button id="wfCardRegClose" style="background:transparent;border:none;color:#8b95a8;font-size:26px;cursor:pointer;padding:4px 10px;">&times;</button>' +
              '</div>' +
              '<div style="padding:16px 20px;">' +
                '<div style="font-size:12.5px;color:var(--text3,#8b95a8);line-height:1.55;margin-bottom:14px;">Tell the AI which last-4 belongs to a credit card vs a bank account. A debit on a <b>credit card</b> routes to CC One-Time (its service charge is already in the SMS); a debit on a <b>bank account</b> routes to Expenses.</div>' +
                '<div id="wfCardRegList"></div>' +
                '<div style="margin-top:16px;padding-top:14px;border-top:1px solid var(--border,#1f2638);">' +
                  '<div style="font-weight:800;font-size:14px;color:var(--text,#e6e7eb);margin-bottom:10px;">Add / Update Card</div>' +
                  '<div style="display:grid;grid-template-columns:1fr 1fr;gap:9px;">' +
                    '<input id="wfCardReg_last4" inputmode="numeric" maxlength="4" placeholder="Last 4 digits" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;">' +
                    '<input id="wfCardReg_name" placeholder="Nickname (e.g. DFCC Salary)" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;">' +
                    '<select id="wfCardReg_bank" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;"><option value="">— Bank —</option>' + BANKS.map(b=>'<option value="'+_esc(b)+'">'+_esc(b)+'</option>').join('') + '</select>' +
                    '<select id="wfCardReg_type" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;"><option value="">— Type —</option>' + TYPES.map(t=>'<option value="'+t[0]+'">'+_esc(t[1])+'</option>').join('') + '</select>' +
                  '</div>' +
                  '<div style="display:flex;gap:9px;margin-top:11px;">' +
                    '<button id="wfCardReg_save" style="flex:1;background:linear-gradient(135deg,#d4af37,#caa233);color:#1a1205;border:none;border-radius:9px;padding:11px;font-weight:800;font-size:14px;cursor:pointer;">Save Card</button>' +
                    '<button id="wfCardReg_cancel" style="background:transparent;border:1px solid var(--border2,#1f2638);color:#8b95a8;border-radius:9px;padding:11px 18px;font-weight:700;font-size:14px;cursor:pointer;">Cancel</button>' +
                  '</div>' +
                '</div>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);
        ov.addEventListener('click', (e) => { if (e.target === ov) close(); });
        document.getElementById('wfCardRegClose').onclick = close;
        document.getElementById('wfCardReg_cancel').onclick = close;
        document.getElementById('wfCardReg_save').onclick = _save;
        _renderList();
    }

    function _renderList() {
        const host = document.getElementById('wfCardRegList');
        if (!host) return;
        const reg = _reg();
        const keys = Object.keys(reg);
        if (!keys.length) {
            host.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text3,#8b95a8);font-size:13px;background:var(--bg2,#0a0e1a);border-radius:10px;">No cards mapped yet — add one below.</div>';
            return;
        }
        host.innerHTML = keys.map(k => {
            const c = reg[k] || {};
            const typeLabel = c.type === 'credit_card' ? 'credit card' : 'bank account';
            return '<div style="display:flex;align-items:center;gap:12px;padding:12px;background:var(--bg2,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:11px;margin-bottom:8px;">' +
                '<div style="font-weight:900;font-size:15px;color:#d4af37;white-space:nowrap;">••• ' + _esc(k) + '</div>' +
                '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13.5px;color:var(--text,#e6e7eb);">' + _esc(c.name || c.bank || 'Card') + '</div>' +
                '<div style="font-size:11px;color:var(--text3,#8b95a8);">' + _esc(c.bank || '') + ' · ' + typeLabel + '</div></div>' +
                '<button data-del="' + _esc(k) + '" style="background:transparent;border:1px solid rgba(239,68,68,0.4);color:#ef4444;border-radius:8px;padding:7px 11px;font-size:12px;font-weight:700;cursor:pointer;">Delete</button>' +
                '</div>';
        }).join('');
        host.querySelectorAll('[data-del]').forEach(b => b.onclick = () => {
            const k = b.getAttribute('data-del');
            if (typeof confirm === 'function' && !confirm('Remove the mapping for card ending ' + k + '?')) return;
            try { if (window.wfCardRegistry && window.wfCardRegistry.delete) window.wfCardRegistry.delete(k); } catch (_) {}
            _renderList();
            _notify('Card mapping removed.', 'info');
        });
    }

    function _save() {
        const last4 = (document.getElementById('wfCardReg_last4').value || '').replace(/\D/g, '').slice(0, 4);
        const name = (document.getElementById('wfCardReg_name').value || '').trim();
        const bank = document.getElementById('wfCardReg_bank').value;
        const type = document.getElementById('wfCardReg_type').value;
        if (last4.length !== 4) { _notify('Enter the last 4 digits.', 'warn'); return; }
        if (!type) { _notify('Pick a card type (credit card or bank account).', 'warn'); return; }
        try {
            if (window.wfCardRegistry && window.wfCardRegistry.upsert) {
                window.wfCardRegistry.upsert(last4, { bank: bank || 'Other', type, name: name || (bank || 'Card') });
            }
        } catch (_) {}
        document.getElementById('wfCardReg_last4').value = '';
        document.getElementById('wfCardReg_name').value = '';
        _renderList();
        _notify('Card saved — the AI will route ' + last4 + ' correctly now.', 'success');
        try { if (window.wfIntelPanel && window.wfIntelPanel.refresh) window.wfIntelPanel.refresh(); } catch (_) {}
    }

    function close() { const ov = document.getElementById('wfCardRegOverlay'); if (ov) ov.remove(); }

    window.wfOpenCardRegistry = open;
    console.log('[wfCardRegistry UI] ✓ Card & Account Registry modal loaded');
})();
