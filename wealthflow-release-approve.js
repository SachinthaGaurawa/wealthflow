/*  wealthflow-release-approve.js  —  Settings > Software release
 *
 *  Releases are published automatically: auto-release.yml makes one when real
 *  changes have been merged, the full test suite passes on that exact commit and
 *  the live app is healthy, then confirms the new version is being served
 *  (/api/version, /version.json, /app). Nothing waits for a tap.
 *
 *  This card used to say "Review and approve the release ... Only the owner can
 *  approve". That was the manual gate that stopped releases for weeks (the tap
 *  never came), and it kept inviting an approval that no longer decides anything.
 *  The card now shows what is true: the version and build that are live, what
 *  that version changed, and how a release happens.
 *
 *  Public API:  window.wfReleaseApprove.showPanel()   (name kept: index.html
 *               calls _inject() when Settings re-renders)
 */
// ── deadline for outbound calls ──────────────────────────────────────────────
// `fetch` has no default timeout: an upstream that accepts the connection and
// then goes quiet never settles, so the caller waits forever and the UI keeps a
// spinner up with no way to recover. Defined as a guarded global so whichever of
// these scripts loads first supplies it and the rest share one implementation —
// no load-order dependency, and no eighth copy to drift.
window._wfFetchT = window._wfFetchT || function (url, init, ms) {
    var ctl = new AbortController();
    var t = setTimeout(function () { ctl.abort(); }, ms || 15000);
    var opts = {};
    for (var k in (init || {})) opts[k] = init[k];
    opts.signal = ctl.signal;
    return fetch(url, opts).finally(function () { clearTimeout(t); });
};

(function () {
    'use strict';
    if (window.wfReleaseApprove) return;

    var MAX_ITEMS = 6;
    var _open = false;
    var _returnFocus = null;

    function _esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }

    /* ── what is live ───────────────────────────────────────────────────────
     * { ok, version, sha } from /api/version, the same answer a device uses to
     * learn about an update. `ok: false` means "could not read it" and is shown
     * as such, never as an empty or healthy state. */
    async function _getLive() {
        try {
            var r = await _wfFetchT('/api/version?_=' + Date.now(), { cache: 'no-store' }, 6000);
            if (!r.ok) return { ok: false, reason: 'WealthFlow answered with an error (HTTP ' + r.status + ').' };
            var b = await r.json();
            if (!b || !b.version) return { ok: false, reason: 'The live version was missing from the answer.' };
            return { ok: true, version: String(b.version), sha: b.sha ? String(b.sha).slice(0, 7) : '' };
        } catch (_) { return { ok: false, reason: 'Could not reach WealthFlow to read the live version.' }; }
    }

    /* The notes release.cjs wrote for this version. A string is one item; the
     * structured form is flattened. `total` counts everything so the panel can
     * say how many more there are than it shows. */
    function _flatten(n) {
        if (!n) return [];
        if (typeof n === 'string') return n.trim() ? [n.trim()] : [];
        var out = [];
        if (Array.isArray(n.sections)) n.sections.forEach(function (s) { (s.items || []).forEach(function (it) { if (typeof it === 'string' && it.trim()) out.push(it.trim()); }); });
        else ['summary', 'body', 'note', 'text'].forEach(function (k) { if (typeof n[k] === 'string' && n[k].trim()) out.push(n[k].trim()); });
        return out;
    }
    async function _getNotes(version) {
        try {
            var r = await _wfFetchT('/version.json?_=' + Date.now(), { cache: 'no-store' }, 8000);
            if (!r.ok) return { ok: false };
            var j = await r.json();
            var items = _flatten(j && j.notes && j.notes[version]);
            return { ok: true, items: items };
        } catch (_) { return { ok: false }; }
    }

    function _css() {
        if (document.getElementById('wfrlStyle')) return;
        var st = document.createElement('style');
        st.id = 'wfrlStyle';
        st.textContent =
            '.wfrl-sheet{width:100%;max-width:460px;max-height:86vh;display:flex;flex-direction:column;background:var(--card,#0f1729);border:1px solid var(--border2,#223054);border-radius:18px;overflow:hidden;box-shadow:0 24px 60px rgba(4,6,12,.55),inset 0 1px 0 rgba(255,255,255,.05);}' +
            '.wfrl-row{display:flex;justify-content:space-between;align-items:baseline;gap:16px;padding:12px 0;border-top:1px solid var(--border,#1f2638);}' +
            '.wfrl-k{font-size:12.5px;color:var(--text2,#aab3c5);}' +
            '.wfrl-v{font:600 15px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-variant-numeric:tabular-nums;color:var(--text,#e6e7eb);}' +
            '.wfrl-h{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--text2,#aab3c5);margin:22px 0 8px;}' +
            '.wfrl-item{padding:6px 0 6px 12px;margin-bottom:5px;border-left:2px solid var(--border2,#2a3350);font-size:13px;line-height:1.5;color:var(--text2,#c7cdd9);overflow-wrap:anywhere;}' +
            '.wfrl-more{font-size:12px;color:var(--text2,#aab3c5);padding:4px 0 0 14px;}' +
            '.wfrl-step{display:grid;grid-template-columns:22px 1fr;gap:8px;padding:6px 0;font-size:13px;line-height:1.5;color:var(--text2,#c7cdd9);}' +
            '.wfrl-num{font:600 12px/1.9 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:var(--accent,#f5a623);}' +
            '.wfrl-note{margin-top:14px;font-size:12.5px;line-height:1.5;color:var(--text2,#aab3c5);}' +
            '.wfrl-btn{padding:11px 16px;border-radius:10px;border:1px solid var(--border,#1f2638);background:transparent;color:var(--text2,#c7cdd9);font-weight:700;cursor:pointer;transition:transform .16s cubic-bezier(.16,1,.3,1),background-color .16s;}' +
            '.wfrl-btn:hover{background:rgba(255,255,255,.04);}' +
            '.wfrl-btn:active{transform:scale(.98);}' +
            '.wfrl-btn:focus-visible,#wfReleaseOpenBtn:focus-visible{outline:2px solid var(--accent,#f5a623);outline-offset:2px;}' +
            '#wfReleaseOpenBtn{transition:transform .16s cubic-bezier(.16,1,.3,1);}' +
            '#wfReleaseOpenBtn:active{transform:scale(.98);}' +
            '.wfrl-skel{height:14px;border-radius:6px;background:var(--border,#1f2638);margin-bottom:10px;animation:wfrlPulse 1.4s ease-in-out infinite;}' +
            '@keyframes wfrlPulse{50%{opacity:.45;}}' +
            '@media (prefers-reduced-motion:reduce){.wfrl-skel{animation:none;}.wfrl-btn,#wfReleaseOpenBtn{transition:none;}}';
        (document.head || document.documentElement).appendChild(st);
    }

    function _skeleton() {
        return '<div aria-busy="true" aria-label="Loading">' +
            '<div class="wfrl-skel" style="width:38%;"></div><div class="wfrl-skel" style="width:100%;"></div>' +
            '<div class="wfrl-skel" style="width:92%;margin-top:22px;"></div><div class="wfrl-skel" style="width:84%;"></div><div class="wfrl-skel" style="width:70%;"></div></div>';
    }

    var STEPS = [
        'Real changes are merged to the main branch.',
        'The full test suite runs on that exact commit, and the live app is checked for health.',
        'The release is published, then confirmed live before it counts as done.'
    ];

    function _render(live, notes) {
        var body = document.getElementById('wfRaBody'); if (!body) return;
        if (!live || !live.ok) {
            body.innerHTML =
                '<div role="alert" style="padding:6px 0 4px;">' +
                    '<div style="font-size:14px;font-weight:700;color:#fbbf24;">Could not read the live version.</div>' +
                    '<div style="font-size:13px;line-height:1.5;color:var(--text2,#aab3c5);margin-top:6px;">' + _esc((live && live.reason) || 'Try again in a moment.') + ' This does not mean a release failed.</div>' +
                    '<div style="margin-top:14px;"><button id="wfRaRetry" class="wfrl-btn" type="button">Try Again</button></div>' +
                '</div>';
            var retry = document.getElementById('wfRaRetry');
            if (retry) retry.onclick = function () { _load(); };
            return;
        }
        var items = (notes && notes.ok) ? notes.items : null;
        var changes;
        if (items === null) changes = '<div class="wfrl-note" style="margin-top:0;">The notes for this version could not be loaded just now.</div>';
        else if (!items.length) changes = '<div class="wfrl-note" style="margin-top:0;">No notes were published for this version.</div>';
        else {
            changes = items.slice(0, MAX_ITEMS).map(function (t) { return '<div class="wfrl-item">' + _esc(t) + '</div>'; }).join('');
            if (items.length > MAX_ITEMS) changes += '<div class="wfrl-more">and ' + (items.length - MAX_ITEMS) + ' more, listed in the changelog.</div>';
        }
        body.innerHTML =
            '<div class="wfrl-h" style="margin-top:0;">Live now</div>' +
            '<div class="wfrl-row"><span class="wfrl-k">Version</span><span class="wfrl-v">' + _esc(live.version) + '</span></div>' +
            (live.sha ? '<div class="wfrl-row"><span class="wfrl-k">Build</span><span class="wfrl-v">' + _esc(live.sha) + '</span></div>' : '') +
            '<div class="wfrl-h">How a release happens</div>' +
            STEPS.map(function (t, i) { return '<div class="wfrl-step"><span class="wfrl-num">' + (i + 1) + '</span><span>' + _esc(t) + '</span></div>'; }).join('') +
            '<div class="wfrl-note">A release that fails any step stops and raises an issue instead of publishing. No approval from you is needed.</div>' +
            '<div class="wfrl-h">What this version changed</div>' + changes;
    }

    async function _load() {
        var body = document.getElementById('wfRaBody');
        if (body) body.innerHTML = _skeleton();
        var live = await _getLive();
        var notes = live.ok ? await _getNotes(live.version) : null;
        _render(live, notes);
    }

    function _close() {
        _open = false;
        document.removeEventListener('keydown', _onKey, true);
        var ov = document.getElementById('wfRaOverlay');
        if (ov) { ov.style.opacity = '0'; setTimeout(function () { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 200); }
        try { if (_returnFocus && _returnFocus.focus) _returnFocus.focus(); } catch (_) {}
    }
    function _onKey(e) { if (e.key === 'Escape') { e.stopPropagation(); _close(); } }

    async function showPanel() {
        if (_open) return; _open = true;
        _css();
        _returnFocus = document.activeElement || null;
        var ov = document.createElement('div');
        ov.id = 'wfRaOverlay';
        ov.setAttribute('role', 'dialog'); ov.setAttribute('aria-modal', 'true'); ov.setAttribute('aria-labelledby', 'wfRaTitle');
        ov.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(3,6,14,0.72);backdrop-filter:blur(6px);display:flex;align-items:center;justify-content:center;opacity:0;transition:opacity .2s;padding:18px;';
        ov.innerHTML =
            '<div class="wfrl-sheet">' +
                '<div style="padding:18px 20px 14px;">' +
                    '<div id="wfRaTitle" style="font-size:18px;font-weight:800;letter-spacing:-.01em;color:var(--text,#fff);">Software release</div>' +
                    '<div style="font-size:12.5px;color:var(--text2,#aab3c5);margin-top:3px;">Published automatically once the tests pass.</div>' +
                '</div>' +
                '<div id="wfRaBody" style="padding:4px 20px 18px;overflow-y:auto;flex:1;"></div>' +
                '<div style="padding:12px 20px 16px;border-top:1px solid var(--border,#1f2638);"><button id="wfRaClose" class="wfrl-btn" type="button" style="width:100%;">Close</button></div>' +
            '</div>';
        document.body.appendChild(ov);
        requestAnimationFrame(function () { ov.style.opacity = '1'; });
        document.getElementById('wfRaClose').onclick = _close;
        ov.addEventListener('click', function (e) { if (e.target === ov) _close(); });
        document.addEventListener('keydown', _onKey, true);
        try { document.getElementById('wfRaClose').focus(); } catch (_) {}
        await _load();
    }

    // ── self-inject a matching card into Settings (mirrors wealthflow-intel-panel) ──
    function _inject() {
        if (document.getElementById('wfReleasePanel')) return true;
        // Only inject while the Settings PAGE is actually active — otherwise the
        // card used to attach to whatever ".settings-section" happened to be in
        // the DOM and appeared to "move around" between pages/renders.
        var settingsPage = document.getElementById('page-settings');
        if (!settingsPage || !settingsPage.classList.contains('active')) return false;
        // Stable anchor, set by the owner: the card sits between "Software Update"
        // and "App and installation". Both are part of the Settings template, so
        // the spot survives every rebuild. Fall back to just after the Software
        // Update card, then the AI card, then the last section — never anywhere else.
        var host = null;
        var before = settingsPage.querySelector('#wfPwaSection');
        if (before && !before.parentNode) before = null;
        if (!before) {
            host = settingsPage.querySelector('#wfUpdateCard');
            if (!host) {
                var intel = settingsPage.querySelector('#wfIntelPanel');
                if (intel && intel.closest) host = intel.closest('.settings-section') || intel;
            }
            if (!host) {
                var secs = settingsPage.querySelectorAll('.settings-section');
                if (secs.length) host = secs[secs.length - 1];
            }
            if (!host || !host.parentNode) return false;
        }
        _css();
        var card = document.createElement('div');
        card.className = 'settings-section';
        card.id = 'wfReleasePanel';
        card.style.cssText = 'background:linear-gradient(145deg,rgba(245,166,35,0.05),var(--card));border:1px solid var(--border2);';
        card.innerHTML =
            '<div class="settings-title" style="color:#f5a623;">Software release</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info">' +
                    '<div class="setting-label">Releases publish automatically</div>' +
                    '<div class="setting-desc">WealthFlow publishes a release by itself once real changes are merged, the tests pass and the live app is healthy. No approval from you is needed.</div>' +
                '</div>' +
                '<button id="wfReleaseOpenBtn" type="button" style="padding:9px 16px;border-radius:10px;border:none;background:var(--accent,#f5a623);color:#1a1300;font-weight:800;cursor:pointer;white-space:nowrap;">Details</button>' +
            '</div>';
        if (before) before.parentNode.insertBefore(card, before);
        else host.parentNode.insertBefore(card, host.nextSibling);
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
    // SETTINGS PAGE IS ACTIVE — and _inject() itself refuses to attach anywhere
    // else, so the card stays in ONE fixed spot and never wanders.
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

    window.wfReleaseApprove = {
        showPanel: showPanel, _close: _close, _getLive: _getLive, _getNotes: _getNotes,
        _render: _render, _inject: _inject,
    };
    console.log('[wfReleaseApprove] Software release panel loaded: releases publish automatically, this card shows what is live');
})();
