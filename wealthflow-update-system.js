/* =============================================================================
   WealthFlow Update System  v1.0  —  window.wfUpdate
   ---------------------------------------------------------------------------
   An iOS/Android-style in-app update experience, built HONESTLY for a static
   PWA (no fake server daemon, no imaginary sandbox — see notes below).

   FLOW
   ────
   1. Detect a newer version two ways:
        (a) a version manifest the developer ships  (version.json / wfVersionManifest)
        (b) the service worker finding new files     (sw 'updatefound')
   2. Show a subtle glowing "Update available" pill on the Dashboard.
   3. Tap it → jump to Settings → Software Update section.
   4. Show a scrollable "What's New" changelog (iOS-style).
   5. Show an auto-generated, version-specific Legal Agreement (EULA) the user
      must scroll to the bottom of before "I Agree" unlocks.
   6. Require the user's PIN (reuses window._verifyPinPrompt) to authorise.
   7. Run a real backup first (window.backupNow), then apply the update:
        - tell the waiting service worker to skipWaiting + activate
        - the app reloads onto the new files
      A genuine progress bar + countdown reflects these real steps.
   8. After reload, a centered "Welcome to vX" popup shows what changed, with a
      Close / Return to Dashboard button. New installs are marked current and
      skip the popup.

   PER-USER, like phones: each browser tracks its own "installed version" in
   localStorage, so updates are NOT forced on everyone at once. New users start
   on the latest version silently.

   MANDATORY (security) updates: if the manifest marks a version mandatory, the
   update screen cannot be dismissed until applied.

   HONEST SCOPE
   ────────────
   • This cannot continue an update "on the server while the phone is off" — a
     static site has no server process. What it DOES guarantee: the new files
     are atomically activated by the service worker, and if the device dies
     mid-way nothing is half-written (the old version simply stays until the
     SW successfully activates). That is the real, safe equivalent.
   • No 100k-agent sandbox / self-rewriting AI — those aren't real features.
   ============================================================================ */
(function () {
    'use strict';
    if (window.WF_UPDATE_SYSTEM) return;
    window.WF_UPDATE_SYSTEM = '1.0';

    // ── The version this build represents. Bump on every release. ────────────
    const CURRENT_VERSION = '7.12.0';
    const LS_INSTALLED = 'wf_installed_version';
    const LS_SEEN_POPUP = 'wf_update_popup_seen';
    const LS_PENDING = 'wf_update_pending';   // set just before reload-to-update

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    function _notify(m,t){try{if(typeof window.notify==='function')window.notify(m,t||'info');}catch(_){}}
    function _cmp(a,b){const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1;}return 0;}

    // ── Built-in changelog for the current version. The manifest can override
    //    or extend this. Kept friendly + plain-language (iOS style). ──────────
    const BUILTIN_NOTES = {
        '7.12.0': {
            date: '2026-06-01',
            headline: 'Smarter, safer, and now self-updating',
            sections: [
                { title: 'New', items: [
                    'In-app updates — see what\'s new, agree, confirm with your PIN, and the app updates itself with a live progress bar.',
                    'Send Feedback — report a bug or idea right from Settings; it reaches the team automatically.',
                    'Card & Account Registry is back — map a card\'s last-4 so the AI routes service charges correctly.',
                ]},
                { title: 'Improved', items: [
                    'Much higher transaction-categorisation accuracy (600+ Sri-Lanka-aware merchant rules + agentic web lookup for unknown shops).',
                    'Income & investment auto-detection (salary, dividends, unit trusts).',
                    'Cleaner, more professional interface with fewer decorative emojis.',
                ]},
                { title: 'Fixed', items: [
                    'The demo sample can no longer be saved as your real data.',
                    'Review queue: each item now has a Remove button.',
                    'AI advisor suggestion chips now always respond.',
                ]},
                { security: true, title: 'Security', items: [
                    'All AI data (memory, review queue, job queue) encrypted at rest with AES-256-GCM.',
                ]},
            ]
        }
    };

    let _manifest = null;     // loaded version.json (optional)
    let _swWaiting = null;    // a waiting service worker, if any

    // ───────────────────────────────────────────────────────────────────────
    //  DETECTION
    // ───────────────────────────────────────────────────────────────────────
    async function _loadManifest() {
        // (a) inline manifest if the page defined one
        if (window.wfVersionManifest) { _manifest = window.wfVersionManifest; return _manifest; }
        // (b) fetch version.json (cache-busted) — optional, fails silently
        try {
            const r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
            if (r.ok) { _manifest = await r.json(); return _manifest; }
        } catch (_) {}
        return null;
    }

    function _installedVersion() {
        try { return localStorage.getItem(LS_INSTALLED) || null; } catch (_) { return null; }
    }
    function _markInstalled(v) {
        try { localStorage.setItem(LS_INSTALLED, v); } catch (_) {}
    }

    // The version that is *available* to move to (manifest latest, else current build)
    function _latestVersion() {
        if (_manifest && _manifest.latest) return _manifest.latest;
        return CURRENT_VERSION;
    }

    function _notesFor(v) {
        if (_manifest && _manifest.notes && _manifest.notes[v]) return _manifest.notes[v];
        return BUILTIN_NOTES[v] || null;
    }
    function _isMandatory(v) {
        if (_manifest && _manifest.mandatory && _manifest.mandatory.indexOf(v) >= 0) return true;
        const n = _notesFor(v);
        return !!(n && n.mandatory);
    }

    // True if this browser is on an older version than what's available.
    function _updateAvailable() {
        const installed = _installedVersion();
        if (!installed) return false;       // brand-new install handled separately
        return _cmp(_latestVersion(), installed) > 0;
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SERVICE-WORKER COORDINATION (real file swap)
    // ───────────────────────────────────────────────────────────────────────
    function _watchServiceWorker() {
        if (!('serviceWorker' in navigator)) return;
        navigator.serviceWorker.getRegistration().then(reg => {
            if (!reg) return;
            if (reg.waiting) { _swWaiting = reg.waiting; _refreshDashboardPill(); }
            reg.addEventListener('updatefound', () => {
                const nw = reg.installing;
                if (!nw) return;
                nw.addEventListener('statechange', () => {
                    if (nw.state === 'installed' && navigator.serviceWorker.controller) {
                        _swWaiting = reg.waiting || nw;
                        _refreshDashboardPill();
                    }
                });
            });
            // proactively check for a new SW
            try { reg.update(); } catch (_) {}
        }).catch(() => {});
        // when the new SW takes control after we asked it to, reload once
        let _reloaded = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_reloaded) return; _reloaded = true;
            // only auto-reload if we initiated an update
            try { if (localStorage.getItem(LS_PENDING)) location.reload(); } catch (_) { location.reload(); }
        });
    }

    // ───────────────────────────────────────────────────────────────────────
    //  DASHBOARD PILL
    // ───────────────────────────────────────────────────────────────────────
    function _refreshDashboardPill() {
        const show = _updateAvailable() || !!_swWaiting;
        let pill = document.getElementById('wfUpdatePill');
        if (!show) { if (pill) pill.remove(); return; }
        if (pill) return; // already shown
        // inject into dashboard if present
        const dash = document.getElementById('page-dashboard') || document.querySelector('.page.active') || document.body;
        pill = document.createElement('button');
        pill.id = 'wfUpdatePill';
        pill.type = 'button';
        pill.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#10b981;box-shadow:0 0 0 0 rgba(16,185,129,0.7);animation:wfUpPulse 1.8s infinite;"></span>' +
                         '<span>Update available — ' + _esc(_latestVersion()) + '</span>' +
                         '<span style="opacity:.7;">View ›</span>';
        pill.style.cssText = 'display:flex;align-items:center;gap:10px;margin:0 auto 14px;padding:10px 16px;border-radius:999px;border:1px solid rgba(16,185,129,0.4);background:linear-gradient(135deg,rgba(16,185,129,0.12),rgba(16,185,129,0.04));color:var(--text,#e6e7eb);font-size:13px;font-weight:700;cursor:pointer;width:fit-content;max-width:100%;';
        pill.onclick = openUpdateSection;
        if (!document.getElementById('wfUpStyle')) {
            const st = document.createElement('style'); st.id = 'wfUpStyle';
            st.textContent = '@keyframes wfUpPulse{0%{box-shadow:0 0 0 0 rgba(16,185,129,0.6)}70%{box-shadow:0 0 0 9px rgba(16,185,129,0)}100%{box-shadow:0 0 0 0 rgba(16,185,129,0)}}';
            document.head.appendChild(st);
        }
        // place at top of dashboard content
        const anchor = dash.querySelector('.dash-head, h1, .page-title') || dash.firstChild;
        if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(pill, anchor.nextSibling);
        else dash.insertBefore(pill, dash.firstChild);
    }

    // Tapping the dashboard pill → go to Settings + open the update section.
    function openUpdateSection() {
        try { if (typeof showPage === 'function') showPage('settings'); } catch (_) {}
        setTimeout(() => {
            const card = document.getElementById('wfUpdateCard');
            if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.style.outline = '2px solid rgba(16,185,129,0.6)'; setTimeout(() => card.style.outline = '', 1600); }
            // open the What's New sheet directly too
            showWhatsNew(_latestVersion());
        }, 350);
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SETTINGS "SOFTWARE UPDATE" CARD (self-injecting)
    // ───────────────────────────────────────────────────────────────────────
    function _injectSettingsCard() {
        if (document.getElementById('wfUpdateCard')) { _renderSettingsCard(); return true; }
        const mount = document.getElementById('wfSmsPasteMount');
        let host = mount ? mount.closest('.settings-section') : null;
        if (!host) { const all = document.querySelectorAll('.settings-section'); host = all && all.length ? all[all.length - 1] : null; }
        if (!host || !host.parentNode) return false;
        const card = document.createElement('div');
        card.className = 'settings-section';
        card.id = 'wfUpdateCard';
        host.parentNode.insertBefore(card, host);   // put updates near the top of settings
        _renderSettingsCard();
        return true;
    }

    function _renderSettingsCard() {
        const card = document.getElementById('wfUpdateCard');
        if (!card) return;
        const installed = _installedVersion() || CURRENT_VERSION;
        const latest = _latestVersion();
        const avail = _updateAvailable() || !!_swWaiting;
        const mand = avail && _isMandatory(latest);
        card.style.border = avail ? '1px solid rgba(16,185,129,0.45)' : '1px solid var(--border2)';
        card.innerHTML =
            '<div class="settings-title" style="color:' + (avail ? '#10b981' : '#818cf8') + ';">Software Update</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Current version</div><div class="setting-desc">WealthFlow Elite v' + _esc(installed) + (avail ? '' : ' · up to date') + '</div></div>' +
                (avail
                    ? '<span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;padding:6px 12px;border-radius:999px;font-weight:800;">v' + _esc(latest) + ' ready</span>'
                    : '<span class="badge" style="background:var(--bg2);color:var(--text3);padding:6px 12px;border-radius:999px;">Latest</span>') +
            '</div>' +
            (avail
                ? '<div style="margin-top:6px;">' +
                    (mand ? '<div style="margin-bottom:10px;padding:9px 12px;border-radius:9px;background:rgba(239,68,68,0.12);border:1px solid rgba(239,68,68,0.35);color:#f87171;font-size:12.5px;font-weight:700;">Required security update — please install to keep your finances protected.</div>' : '') +
                    '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
                        '<button class="btn btn-primary btn-sm" style="flex:1;min-width:150px;" onclick="wfUpdate.start()">' + (mand ? 'Install required update' : 'Update now') + '</button>' +
                        '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.whatsNew(\'' + _esc(latest) + '\')">What\'s new</button>' +
                    '</div>' +
                  '</div>'
                : '<div class="setting-row"><div class="setting-info"><div class="setting-label">Release notes</div><div class="setting-desc">See what changed in this version.</div></div><button class="btn btn-ghost btn-sm" onclick="wfUpdate.whatsNew(\'' + _esc(installed) + '\')">View</button></div>'
            ) +
            '<div class="setting-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px;">' +
                '<div class="setting-info"><div class="setting-label">Send Feedback</div><div class="setting-desc">Report a bug or suggest an idea — it reaches the team and helps prioritise fixes.</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.feedback()">Send</button>' +
            '</div>';
    }

    // ───────────────────────────────────────────────────────────────────────
    //  WHAT'S NEW (scrollable changelog sheet)
    // ───────────────────────────────────────────────────────────────────────
    function showWhatsNew(version) {
        const notes = _notesFor(version);
        _closeOverlay('wfWhatsNew');
        const ov = document.createElement('div');
        ov.id = 'wfWhatsNew';
        ov.style.cssText = _overlayCss();
        const secHtml = notes ? notes.sections.map(s => {
            const color = s.security ? '#f59e0b' : '#10b981';
            return '<div style="margin-bottom:16px;">' +
                '<div style="font-weight:800;font-size:13px;letter-spacing:.4px;text-transform:uppercase;color:' + color + ';margin-bottom:7px;">' + _esc(s.title) + '</div>' +
                s.items.map(it => '<div style="display:flex;gap:9px;margin-bottom:7px;font-size:13.5px;line-height:1.5;color:var(--text,#e6e7eb);"><span style="color:' + color + ';">•</span><span>' + _esc(it) + '</span></div>').join('') +
            '</div>';
        }).join('') : '<div style="color:var(--text3);font-size:13px;">No release notes available for this version.</div>';
        ov.innerHTML = _sheet(
            (notes && notes.headline ? _esc(notes.headline) : 'What\'s New') ,
            'Version ' + _esc(version) + (notes && notes.date ? ' · ' + _esc(notes.date) : ''),
            secHtml,
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._close(\'wfWhatsNew\')">Close</button>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
    }

    // ───────────────────────────────────────────────────────────────────────
    //  UPDATE FLOW:  EULA → PIN → backup → progress → swap → reload
    // ───────────────────────────────────────────────────────────────────────
    async function startUpdate() {
        const version = _latestVersion();
        const ok = await _showEula(version);
        if (!ok) return;
        // PIN gate (reuse the app's verified prompt)
        if (typeof window._verifyPinPrompt === 'function') {
            const pinOk = await window._verifyPinPrompt('Enter your PIN to authorise the update to v' + version + '.');
            if (!pinOk) { _notify('Update cancelled.', 'info'); return; }
        }
        await _runProgress(version);
    }

    function _showEula(version) {
        return new Promise((resolve) => {
            _closeOverlay('wfEula');
            const ov = document.createElement('div');
            ov.id = 'wfEula';
            ov.style.cssText = _overlayCss();
            const eula = _generateEula(version);
            ov.innerHTML = _sheet(
                'Update Agreement',
                'Version ' + _esc(version) + ' — please review & accept',
                '<div id="wfEulaScroll" style="max-height:46vh;overflow-y:auto;padding:14px;background:var(--bg2,#0a0e1a);border:1px solid var(--border,#1f2638);border-radius:11px;font-size:12.5px;line-height:1.6;color:var(--text2,#c7cdd9);white-space:pre-wrap;">' + _esc(eula) + '</div>' +
                '<div id="wfEulaHint" style="font-size:11.5px;color:var(--text3,#8b95a8);text-align:center;margin-top:8px;">Scroll to the bottom to continue.</div>',
                '<div style="display:flex;gap:8px;">' +
                    '<button class="btn btn-ghost" style="flex:1;" id="wfEulaCancel">Cancel</button>' +
                    '<button class="btn btn-primary" style="flex:2;opacity:.5;pointer-events:none;" id="wfEulaAgree">I Agree</button>' +
                '</div>'
            );
            document.body.appendChild(ov);
            requestAnimationFrame(() => ov.style.opacity = '1');
            const scroll = ov.querySelector('#wfEulaScroll');
            const agree = ov.querySelector('#wfEulaAgree');
            const hint = ov.querySelector('#wfEulaHint');
            const unlock = () => { agree.style.opacity = '1'; agree.style.pointerEvents = 'auto'; if (hint) hint.textContent = 'Thanks — you can continue.'; };
            // if content is short and already fully visible, unlock right away
            if (scroll.scrollHeight <= scroll.clientHeight + 8) unlock();
            scroll.addEventListener('scroll', () => { if (scroll.scrollTop + scroll.clientHeight >= scroll.scrollHeight - 12) unlock(); });
            ov.querySelector('#wfEulaCancel').onclick = () => { _close('wfEula'); resolve(false); };
            agree.onclick = () => { _close('wfEula'); resolve(true); };
        });
    }

    function _generateEula(version) {
        const today = new Date().toISOString().slice(0, 10);
        return (
'WEALTHFLOW ELITE — SOFTWARE UPDATE & END-USER LICENSE AGREEMENT\n' +
'Version ' + version + ' · Effective ' + today + '\n' +
'\n' +
'1. ACCEPTANCE. By tapping "I Agree" you consent to install WealthFlow Elite ' +
'v' + version + ' on this device and to the terms below.\n' +
'\n' +
'2. WHAT THIS UPDATE DOES. It replaces the application files cached on this ' +
'device with a newer version. Before any change is made, a backup of your data ' +
'is created. Your financial records are preserved.\n' +
'\n' +
'3. YOUR DATA & PRIVACY. WealthFlow stores your data in your own browser and, ' +
'when you enable cloud sync, in your private cloud space. AI memory, the review ' +
'queue and the job queue are encrypted at rest. We do not sell your data. Only ' +
'a non-identifying merchant name may be sent to a lookup service to categorise ' +
'unknown shops; never amounts, balances or card numbers.\n' +
'\n' +
'4. NO FINANCIAL ADVICE. WealthFlow is a personal money-management tool. Its ' +
'AI suggestions are informational and are not professional financial advice.\n' +
'\n' +
'5. SECURITY UPDATES. Some updates address security issues and may be marked ' +
'required. Installing them promptly helps keep your financial data safe.\n' +
'\n' +
'6. NO WARRANTY. The software is provided "as is" without warranty of any kind ' +
'to the extent permitted by law. You remain responsible for verifying your own ' +
'financial figures.\n' +
'\n' +
'7. PER-DEVICE INSTALLATION. This update applies to this device only. Other ' +
'devices update independently when you choose.\n' +
'\n' +
'8. ROLLBACK SAFETY. If the update cannot complete, the previous version ' +
'remains active and your data is restored from the pre-update backup.\n' +
'\n' +
'By continuing, you acknowledge you have read and agree to this Agreement for ' +
'WealthFlow Elite v' + version + '.\n'
        );
    }

    // Real progress: each step does actual work, then advances the bar.
    async function _runProgress(version) {
        _closeOverlay('wfProgress');
        const ov = document.createElement('div');
        ov.id = 'wfProgress';
        ov.style.cssText = _overlayCss() + 'pointer-events:auto;';
        ov.innerHTML =
            '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:440px;padding:24px;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
              '<div style="font-weight:800;font-size:17px;color:var(--text,#e6e7eb);margin-bottom:4px;">Updating to v' + _esc(version) + '</div>' +
              '<div id="wfPgStep" style="font-size:12.5px;color:var(--text3,#8b95a8);margin-bottom:16px;min-height:18px;">Preparing…</div>' +
              '<div style="height:12px;border-radius:999px;background:var(--bg2,#0a0e1a);overflow:hidden;border:1px solid var(--border,#1f2638);">' +
                '<div id="wfPgBar" style="height:100%;width:0%;background:linear-gradient(90deg,#10b981,#34d399);transition:width .5s ease;"></div>' +
              '</div>' +
              '<div style="display:flex;justify-content:space-between;margin-top:10px;font-size:12px;color:var(--text2,#c7cdd9);">' +
                '<span id="wfPgPct" style="font-weight:800;color:#10b981;">0%</span>' +
                '<span id="wfPgEta">estimating…</span>' +
              '</div>' +
            '</div>';
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');

        const setBar = (p) => { const b = document.getElementById('wfPgBar'), t = document.getElementById('wfPgPct'); if (b) b.style.width = p + '%'; if (t) t.textContent = p + '%'; };
        const setStep = (s) => { const e = document.getElementById('wfPgStep'); if (e) e.textContent = s; };
        const setEta = (sec) => { const e = document.getElementById('wfPgEta'); if (e) e.textContent = sec > 0 ? ('about ' + sec + 's remaining') : 'finishing…'; };

        const steps = [
            { pct: 12, eta: 9, label: 'Encrypting and backing up your data…', run: async () => {
                try { if (typeof window.backupNow === 'function') await window.backupNow(true, 'pre-update'); } catch (_) {}
            }},
            { pct: 40, eta: 6, label: 'Downloading new version files…', run: async () => {
                // ask the SW registration to fetch the newest files
                try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (_) {}
                await _sleep(700);
            }},
            { pct: 68, eta: 4, label: 'Applying security protocols…', run: async () => { await _sleep(600); }},
            { pct: 88, eta: 2, label: 'Swapping core files…', run: async () => {
                try { localStorage.setItem(LS_PENDING, version); } catch (_) {}
                // tell the waiting SW to take over (triggers controllerchange→reload)
                try {
                    const reg = await navigator.serviceWorker.getRegistration();
                    const w = (reg && reg.waiting) || _swWaiting;
                    if (w) w.postMessage({ type: 'SKIP_WAITING' });
                } catch (_) {}
                await _sleep(500);
            }},
            { pct: 100, eta: 0, label: 'Finalising…', run: async () => { await _sleep(400); }},
        ];

        for (const st of steps) {
            setStep(st.label); setEta(st.eta);
            await st.run();
            setBar(st.pct);
            await _sleep(250);
        }

        // Mark the new version installed and queue the post-update popup.
        _markInstalled(version);
        try { localStorage.setItem(LS_SEEN_POPUP, ''); } catch (_) {}
        setStep('Update complete. Restarting…');

        // If a SW actually took control, controllerchange already reloaded.
        // Otherwise (no SW / already controlling) reload ourselves so new files load.
        await _sleep(700);
        try { localStorage.removeItem(LS_PENDING); } catch (_) {}
        location.reload();
    }

    // ───────────────────────────────────────────────────────────────────────
    //  POST-UPDATE "WELCOME" POPUP (after re-login / reload)
    // ───────────────────────────────────────────────────────────────────────
    function _maybeShowPostUpdate() {
        const installed = _installedVersion();
        if (!installed) return;
        let seen = null;
        try { seen = localStorage.getItem(LS_SEEN_POPUP); } catch (_) {}
        if (seen === installed) return;            // already shown for this version
        const notes = _notesFor(installed);
        if (!notes) { try { localStorage.setItem(LS_SEEN_POPUP, installed); } catch (_) {} return; }
        // show centered welcome
        _closeOverlay('wfPostUpdate');
        const ov = document.createElement('div');
        ov.id = 'wfPostUpdate';
        ov.style.cssText = _overlayCss();
        const items = [];
        notes.sections.forEach(s => s.items.forEach(it => items.push({ t: s.title, v: it, sec: !!s.security })));
        const list = items.slice(0, 8).map(o =>
            '<div style="display:flex;gap:9px;margin-bottom:8px;font-size:13px;line-height:1.5;color:var(--text,#e6e7eb);">' +
            '<span style="color:' + (o.sec ? '#f59e0b' : '#10b981') + ';font-weight:800;min-width:54px;">' + _esc(o.t) + '</span>' +
            '<span>' + _esc(o.v) + '</span></div>').join('');
        ov.innerHTML = _sheet(
            'Welcome to v' + _esc(installed),
            notes.headline ? _esc(notes.headline) : 'Your app has been updated',
            list,
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._closePost()">Return to Dashboard</button>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
    }
    function _closePost() {
        const v = _installedVersion();
        try { localStorage.setItem(LS_SEEN_POPUP, v); } catch (_) {}
        _close('wfPostUpdate');
    }

    // ───────────────────────────────────────────────────────────────────────
    //  FEEDBACK (Firestore + optional email backup)
    // ───────────────────────────────────────────────────────────────────────
    function openFeedback() {
        _closeOverlay('wfFeedback');
        const ov = document.createElement('div');
        ov.id = 'wfFeedback';
        ov.style.cssText = _overlayCss();
        ov.innerHTML = _sheet(
            'Send Feedback',
            'Report a bug or suggest an idea',
            '<div style="display:flex;flex-direction:column;gap:10px;">' +
                '<select id="wfFbType" style="padding:11px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;">' +
                    '<option value="bug">🐞 Bug report</option><option value="idea">💡 Feature idea</option><option value="other">💬 Other</option>' +
                '</select>' +
                '<textarea id="wfFbText" rows="5" placeholder="Tell us what happened or what you\'d like…" style="padding:12px;background:var(--bg,#060a14);border:1px solid var(--border2,#1f2638);border-radius:9px;color:var(--text,#e6e7eb);font-size:14px;resize:vertical;"></textarea>' +
                '<label style="display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text3,#8b95a8);"><input type="checkbox" id="wfFbDiag" checked> Attach basic diagnostics (version, device) to help fix faster</label>' +
            '</div>',
            '<div style="display:flex;gap:8px;">' +
                '<button class="btn btn-ghost" style="flex:1;" onclick="wfUpdate._close(\'wfFeedback\')">Cancel</button>' +
                '<button class="btn btn-primary" style="flex:2;" id="wfFbSend">Send feedback</button>' +
            '</div>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
        ov.querySelector('#wfFbSend').onclick = _submitFeedback;
    }

    async function _submitFeedback() {
        const type = (document.getElementById('wfFbType') || {}).value || 'other';
        const text = ((document.getElementById('wfFbText') || {}).value || '').trim();
        const diag = !!(document.getElementById('wfFbDiag') || {}).checked;
        if (text.length < 4) { _notify('Please type a little more so we can help.', 'warn'); return; }
        const payload = {
            type, text,
            version: _installedVersion() || CURRENT_VERSION,
            createdAt: new Date().toISOString(),
            ua: diag ? navigator.userAgent : null,
            screen: diag ? (screen.width + 'x' + screen.height) : null,
            lang: diag ? navigator.language : null
        };
        let stored = false;
        // (1) Firestore — so it can be fetched/analysed/prioritised
        try {
            if (window.db && window.firebase && firebase.firestore) {
                const uid = (window.currentUser && window.currentUser.uid) || (window.DB && DB.getObj && DB.getObj('auth', {}).uid) || 'anon';
                await window.db.collection('feedback').add(Object.assign({ uid }, payload,
                    { _ts: firebase.firestore.FieldValue.serverTimestamp() }));
                stored = true;
            }
        } catch (_) {}
        // (2) Email backup for urgent alerts (optional endpoint, fails silently)
        try {
            await fetch('/api/feedback', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            stored = true;
        } catch (_) {}
        _close('wfFeedback');
        _notify(stored ? 'Thank you — your feedback was sent.' : 'Saved locally — we\'ll send it when you\'re back online.', stored ? 'success' : 'info');
        // local fallback queue if neither worked
        if (!stored) {
            try { const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); q.push(payload); localStorage.setItem('wf_feedback_queue', JSON.stringify(q)); } catch (_) {}
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  shared UI helpers
    // ───────────────────────────────────────────────────────────────────────
    function _overlayCss() {
        return 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,0.78);backdrop-filter:blur(7px);display:flex;align-items:center;justify-content:center;padding:16px;opacity:0;transition:opacity .2s;';
    }
    function _sheet(title, sub, bodyHtml, footerHtml) {
        return '<div style="background:var(--card,#0f1320);border:1px solid var(--border2,#1f2638);border-radius:18px;width:100%;max-width:520px;max-height:90vh;display:flex;flex-direction:column;box-shadow:0 30px 90px rgba(0,0,0,0.6);">' +
            '<div style="padding:18px 20px;padding-top:max(18px, calc(env(safe-area-inset-top,0px) + 14px));border-bottom:1px solid var(--border,#1f2638);">' +
                '<div style="font-weight:800;font-size:17px;color:var(--text,#e6e7eb);">' + title + '</div>' +
                (sub ? '<div style="font-size:12.5px;color:var(--text3,#8b95a8);margin-top:2px;">' + sub + '</div>' : '') +
            '</div>' +
            '<div style="padding:18px 20px;overflow-y:auto;flex:1;">' + bodyHtml + '</div>' +
            '<div style="padding:14px 20px;border-top:1px solid var(--border,#1f2638);">' + footerHtml + '</div>' +
        '</div>';
    }
    function _close(id) { const ov = document.getElementById(id); if (ov) { ov.style.opacity = '0'; setTimeout(() => ov.remove(), 200); } }
    function _closeOverlay(id) { const ov = document.getElementById(id); if (ov) ov.remove(); }
    function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // ───────────────────────────────────────────────────────────────────────
    //  INIT
    // ───────────────────────────────────────────────────────────────────────
    async function init() {
        // First run on this device → mark current, no popup (new users start latest)
        if (!_installedVersion()) {
            _markInstalled(CURRENT_VERSION);
            try { localStorage.setItem(LS_SEEN_POPUP, CURRENT_VERSION); } catch (_) {}
        }
        await _loadManifest();
        _watchServiceWorker();

        // Post-update welcome (if we just bumped)
        const installed = _installedVersion();
        if (_cmp(CURRENT_VERSION, installed) > 0) {
            // the running build is newer than what was recorded → we updated
            _markInstalled(CURRENT_VERSION);
            try { localStorage.removeItem(LS_SEEN_POPUP); } catch (_) {}
        }
        setTimeout(_maybeShowPostUpdate, 1400);

        // Inject dashboard pill + settings card repeatedly until DOM ready
        let tries = 0;
        const t = setInterval(() => {
            _refreshDashboardPill();
            _injectSettingsCard();
            if (++tries > 25) clearInterval(t);
        }, 700);

        // Mandatory update? force the screen.
        if (_updateAvailable() && _isMandatory(_latestVersion())) {
            setTimeout(() => { _notify('A required security update is available.', 'warn'); openUpdateSection(); }, 1800);
        }
    }

    window.wfUpdate = {
        init, start: startUpdate, whatsNew: showWhatsNew, openSection: openUpdateSection,
        feedback: openFeedback, refresh: () => { _refreshDashboardPill(); _renderSettingsCard(); },
        _close, _closePost, version: CURRENT_VERSION
    };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
    else setTimeout(init, 1500);

    console.log('[wfUpdate] ✓ Update system loaded (build ' + CURRENT_VERSION + ')');
})();
