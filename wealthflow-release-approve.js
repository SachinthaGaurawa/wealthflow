/*  wealthflow-release-approve.js  —  the one-tap human gate, in the UI
 *
 *  The autonomous brain (release-brain.js) ranks feedback, drafts the fix list,
 *  and writes system/pendingRelease. This panel shows that proposal to the OWNER
 *  and turns it into a live release with one tap, by calling /api/approve-release
 *  (which is owner-authenticated server-side — a non-owner simply gets "not
 *  authorised"). This is the single deliberate human step in the pipeline.
 *
 *  Public API:  window.wfReleaseApprove.showPanel()
 *  Wire it to any owner-only button, e.g. onclick="wfReleaseApprove.showPanel()".
 */
(function () {
    'use strict';
    if (window.wfReleaseApprove) return;

    function _fbRef() { return window.firebase || (typeof firebase !== 'undefined' ? firebase : null); }
    function _dbRef() { var fb = _fbRef(); return window.db || (fb && fb.firestore ? fb.firestore() : null); }
    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
    function _withTimeout(p, ms, fb) { return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(fb); }, ms); })]); }

    var _open = false;

    async function _getPending() {
        try {
            var db = _dbRef(); if (!db) return null;
            var doc = await _withTimeout(db.collection('system').doc('pendingRelease').get(), 3500, null);
            if (doc && doc.exists) return doc.data();
        } catch (_) {}
        return null;
    }

    async function _idToken() {
        try { var fb = _fbRef(); var u = fb && fb.auth ? fb.auth().currentUser : null; if (u && u.getIdToken) return await u.getIdToken(); } catch (_) {}
        return null;
    }

    // POST the owner's decision. Returns { ok, status, body }.
    async function _act(action, note) {
        var token = await _idToken();
        if (!token) return { ok: false, status: 0, body: { error: 'Please sign in first.' } };
        try {
            var r = await fetch('/api/approve-release', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ idToken: token, action: action, note: note || '' })
            });
            var body = {}; try { body = await r.json(); } catch (_) {}
            return { ok: r.ok, status: r.status, body: body };
        } catch (e) {
            return { ok: false, status: 0, body: { error: e.message } };
        }
    }

    function _msg(html, color) {
        var m = document.getElementById('wfRaMsg');
        if (m) { m.style.display = 'block'; m.style.color = color || 'var(--text2,#c7cdd9)'; m.innerHTML = html; }
    }

    async function _onDecision(action) {
        var btnA = document.getElementById('wfRaApprove'), btnR = document.getElementById('wfRaReject');
        if (btnA) btnA.disabled = true; if (btnR) btnR.disabled = true;
        _msg(action === 'approve' ? 'Approving and announcing to all clients…' : 'Recording rejection…', 'var(--accent,#f5a623)');
        var note = (document.getElementById('wfRaNote') || {}).value || '';
        var res = await _act(action, note);
        if (res.ok && action === 'approve') {
            var v = _esc(res.body.version || '');
            var deployed = res.body.deployTriggered ? 'A new build was triggered.' : 'Announced to clients. (No deploy hook set, so the code build was not auto-triggered.)';
            _msg('✓ Release ' + v + ' approved. ' + _esc(deployed), '#34d399');
        } else if (res.ok && action === 'reject') {
            _msg('✓ Proposal rejected. The live version is unchanged.', '#34d399');
        } else if (res.status === 403) {
            _msg('You are not authorised to approve releases on this account.', '#ef4444');
            if (btnA) btnA.disabled = false; if (btnR) btnR.disabled = false;
        } else if (res.status === 404) {
            _msg('There is no pending release to act on right now.', '#fbbf24');
        } else {
            _msg('Could not complete: ' + _esc((res.body && (res.body.error || res.body.note)) || ('HTTP ' + res.status)), '#ef4444');
            if (btnA) btnA.disabled = false; if (btnR) btnR.disabled = false;
        }
    }

    function _render(p) {
        var body = document.getElementById('wfRaBody'); if (!body) return;
        if (!p || !p.suggestedVersion) {
            body.innerHTML = '<div style="text-align:center;color:var(--text3,#8b95a8);font-size:13px;padding:24px;">No pending release. The system proposes one automatically when user feedback warrants it.</div>';
            return;
        }
        var changes = Array.isArray(p.proposedChanges) ? p.proposedChanges : [];
        var rows = changes.map(function (c) {
            var pc = c.priority === 'critical' ? '#ef4444' : (c.priority === 'high' ? '#f59e0b' : '#818cf8');
            return '<div style="padding:9px 11px;border:1px solid var(--border,#1f2638);border-left:3px solid ' + pc + ';border-radius:9px;margin-bottom:7px;background:var(--bg2,#0a0e1a);">' +
                '<div style="font-size:10.5px;font-weight:800;color:' + pc + ';text-transform:uppercase;margin-bottom:3px;">' + _esc(c.priority || '') + ' · ' + _esc(c.category || '') + ((c.reports || 1) > 1 ? ' · ' + c.reports + ' reports' : '') + '</div>' +
                '<div style="font-size:12.5px;color:var(--text,#e6e7eb);line-height:1.45;">' + _esc(c.action || c.issue || '') + '</div></div>';
        }).join('');
        var head = (p.notes && p.notes.headline) ? _esc(p.notes.headline) : 'Proposed release';
        body.innerHTML =
            '<div style="margin-bottom:12px;">' +
                '<div style="font-size:16px;font-weight:800;color:var(--text,#fff);">' + head + '</div>' +
                '<div style="font-size:12px;color:var(--text3,#8b95a8);margin-top:2px;">Version ' + _esc(p.suggestedVersion) + ' · from ' + _esc(p.basedOn || '?') + (p.urgent ? ' · <span style="color:#ef4444;font-weight:700;">URGENT</span>' : '') + '</div>' +
            '</div>' +
            (rows ? ('<div style="font-size:11px;font-weight:700;color:var(--text3,#8b95a8);text-transform:uppercase;margin-bottom:6px;">Proposed changes (drafted by System AI)</div>' + rows) :
                '<div style="color:var(--text3,#8b95a8);font-size:12.5px;margin-bottom:8px;">Routine maintenance release.</div>') +
            '<textarea id="wfRaNote" placeholder="Optional note (e.g. why you are rejecting)…" style="width:100%;margin-top:10px;min-height:54px;background:var(--bg2,#0a0e1a);color:var(--text,#e6e7eb);border:1px solid var(--border,#1f2638);border-radius:9px;padding:9px;font-size:12.5px;resize:vertical;"></textarea>' +
            '<div id="wfRaMsg" style="display:none;margin-top:10px;font-size:12.5px;font-weight:600;"></div>';
    }

    async function showPanel() {
        if (_open) return; _open = true;
        var ov = document.createElement('div');
        ov.id = 'wfRaOverlay';
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,6,14,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;padding:18px;';
        ov.innerHTML =
            '<div style="width:100%;max-width:460px;max-height:86vh;display:flex;flex-direction:column;background:var(--bg,#070b16);border:1px solid var(--border,#1f2638);border-radius:18px;overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.6);">' +
                '<div style="padding:18px 20px;border-bottom:1px solid var(--border,#1f2638);">' +
                    '<div style="font-size:18px;font-weight:800;color:var(--text,#fff);">Review &amp; Approve Release</div>' +
                    '<div style="font-size:12px;color:var(--text3,#8b95a8);margin-top:2px;">The autonomous system proposes; you approve. One tap ships it.</div>' +
                '</div>' +
                '<div id="wfRaBody" style="padding:18px 20px;overflow-y:auto;flex:1;"><div style="text-align:center;color:var(--text3,#8b95a8);font-size:13px;">Loading proposal…</div></div>' +
                '<div style="padding:14px 20px;border-top:1px solid var(--border,#1f2638);display:flex;gap:10px;">' +
                    '<button id="wfRaReject" style="flex:1;padding:11px;border-radius:10px;border:1px solid var(--border,#1f2638);background:transparent;color:var(--text2,#c7cdd9);font-weight:700;cursor:pointer;">Reject</button>' +
                    '<button id="wfRaApprove" style="flex:2;padding:11px;border-radius:10px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;">Approve &amp; Deploy</button>' +
                '</div>' +
                '<div style="padding:0 20px 14px;"><button id="wfRaClose" style="width:100%;padding:9px;border-radius:10px;border:none;background:transparent;color:var(--text3,#8b95a8);font-size:12px;cursor:pointer;">Close</button></div>' +
            '</div>';
        document.body.appendChild(ov);
        requestAnimationFrame(function () { ov.style.opacity = '1'; });

        document.getElementById('wfRaClose').onclick = _close;
        document.getElementById('wfRaApprove').onclick = function () { _onDecision('approve'); };
        document.getElementById('wfRaReject').onclick = function () { _onDecision('reject'); };

        var p = await _getPending();
        _render(p);
    }

    function _close() {
        _open = false;
        var ov = document.getElementById('wfRaOverlay');
        if (ov) { ov.style.opacity = '0'; setTimeout(function () { ov.remove(); }, 200); }
    }

    // ── self-inject a matching card into Settings (mirrors wealthflow-intel-panel) ──
    function _inject() {
        if (document.getElementById('wfReleasePanel')) return true;
        // Only inject while the Settings PAGE is actually active — otherwise the
        // card used to attach to whatever ".settings-section" happened to be in
        // the DOM and appeared to "move around" between pages/renders.
        var settingsPage = document.getElementById('page-settings');
        if (!settingsPage || !settingsPage.classList.contains('active')) return false;
        // Stable anchor: always sit immediately AFTER the AI engine / intel card
        // inside Settings. Fall back to the Settings content container's END only
        // if that anchor isn't present — never to a random last section elsewhere.
        var host = null;
        var intel = settingsPage.querySelector('#wfIntelPanel');
        if (intel && intel.closest) host = intel.closest('.settings-section') || intel;
        if (!host) {
            var secs = settingsPage.querySelectorAll('.settings-section');
            if (secs.length) host = secs[secs.length - 1];
        }
        if (!host || !host.parentNode) return false;
        var card = document.createElement('div');
        card.className = 'settings-section';
        card.id = 'wfReleasePanel';
        card.style.cssText = 'background:linear-gradient(145deg,rgba(245,166,35,0.05),var(--card));border:1px solid var(--border2);';
        card.innerHTML =
            '<div class="settings-title" style="color:#f5a623;">Autonomous Release</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info">' +
                    '<div class="setting-label">Review &amp; approve release</div>' +
                    '<div class="setting-desc">The system proposes the next release from user feedback and drafts the fix list. Tap to review the proposal and ship it with one approval. Only the owner can approve.</div>' +
                '</div>' +
                '<button id="wfReleaseOpenBtn" style="padding:9px 16px;border-radius:10px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;white-space:nowrap;">Review</button>' +
            '</div>';
        host.parentNode.insertBefore(card, host.nextSibling);
        var btn = document.getElementById('wfReleaseOpenBtn');
        if (btn) btn.onclick = function () { showPanel(); };
        return true;
    }
    function _tryInjectRepeatedly() {
        var tries = 0;
        var t = setInterval(function () { if (_inject() || ++tries > 30) clearInterval(t); }, 600);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { setTimeout(_tryInjectRepeatedly, 2600); });
    else setTimeout(_tryInjectRepeatedly, 1200);
    window.addEventListener('hashchange', function () { setTimeout(_inject, 250); });

    // PERSISTENCE FIX: the card used to vanish when the Settings screen re-rendered.
    // A debounced MutationObserver re-injects it whenever it goes missing WHILE THE
    // SETTINGS PAGE IS ACTIVE — and _inject() itself now refuses to attach anywhere
    // else, so "Autonomous Release" stays in ONE fixed spot and never wanders.
    try {
        var _reinjectScheduled = false;
        var _obs = new MutationObserver(function () {
            if (_reinjectScheduled) return;
            if (document.getElementById('wfReleasePanel')) return;          // already there
            var sp = document.getElementById('page-settings');
            if (!sp || !sp.classList.contains('active')) return;            // Settings not active
            _reinjectScheduled = true;
            setTimeout(function () { _reinjectScheduled = false; _inject(); }, 300);
        });
        if (document.body) _obs.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}

    window.wfReleaseApprove = { showPanel: showPanel, _close: _close, _act: _act, _getPending: _getPending, _inject: _inject };
    console.log('[wfReleaseApprove] ✓ Release approval panel loaded — autonomous proposal, one-tap owner approval');
})();
