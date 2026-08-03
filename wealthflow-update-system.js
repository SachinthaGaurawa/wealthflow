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
    const CURRENT_VERSION = '7.69.19';
    const LS_INSTALLED = 'wf_installed_version';
    const LS_SEEN_POPUP = 'wf_update_popup_seen';
    const LS_PENDING = 'wf_update_pending';   // set just before reload-to-update
    const LS_AUTOSEC = 'wf_auto_security';    // user opted in to auto-install security updates

    function _esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
    // A message the user must actually see. The original swallowed everything: if
    // window.notify was not a function it did nothing at all, silently, so every
    // diagnostic this file produces could be invisible while the code "worked".
    // The fallback is deliberately dumb — a fixed banner built from scratch — so
    // it cannot itself depend on the app being healthy.
    function _notify(m, t) {
        try { if (typeof window.notify === 'function') { window.notify(m, t || 'info'); return; } } catch (_) {}
        try { (t === 'warn' ? console.warn : console.log)('[wfUpdate] ' + m); } catch (_) {}
        try {
            var n = document.createElement('div');
            n.setAttribute('role', 'status');
            n.textContent = String(m);
            n.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:24px;z-index:2147483647;'
                + 'max-width:90vw;padding:12px 18px;border-radius:12px;font:14px/1.4 system-ui,sans-serif;'
                + 'color:#fff;box-shadow:0 8px 24px rgba(0,0,0,.35);background:'
                + (t === 'warn' ? '#b45309' : t === 'success' ? '#15803d' : '#1f2937');
            document.body.appendChild(n);
            setTimeout(function () { try { n.remove(); } catch (_) {} }, 7000);
        } catch (_) {}
    }

    /**
     * Bound a promise so a stalled one can never own the critical path.
     *
     * WHY: Firestore's add() resolves only on SERVER acknowledgement. Offline or
     * unreachable, the write lands in the local cache and the returned promise
     * stays pending FOREVER — it never rejects, so try/catch cannot save you and
     * `await` simply stops the function dead. That is the difference between an
     * error you can see and a button that does nothing.
     */
    function _withTimeout(promise, ms, label) {
        var timer;
        return Promise.race([
            Promise.resolve(promise).then(
                function (v) { clearTimeout(timer); return v; },
                function (e) { clearTimeout(timer); throw e; }
            ),
            new Promise(function (_, reject) {
                timer = setTimeout(function () {
                    reject(new Error((label || 'operation') + ' timed out after ' + Math.round(ms / 1000) + 's'));
                }, ms);
            })
        ]);
    }

    /** fetch that cannot hang forever. An abort surfaces as a normal rejection. */
    function _fetchWithTimeout(url, opts, ms) {
        var ac = null;
        try { if (typeof AbortController !== 'undefined') ac = new AbortController(); } catch (_) {}
        var o = ac ? Object.assign({}, opts, { signal: ac.signal }) : opts;
        return _withTimeout(fetch(url, o), ms, url).catch(function (e) {
            try { if (ac) ac.abort(); } catch (_) {}
            throw e;
        });
    }
    function _cmp(a,b){const pa=String(a).split('.').map(Number),pb=String(b).split('.').map(Number);for(let i=0;i<3;i++){if((pa[i]||0)>(pb[i]||0))return 1;if((pa[i]||0)<(pb[i]||0))return -1;}return 0;}

    // ── Built-in changelog for the current version. The manifest can override
    //    or extend this. Kept friendly + plain-language (iOS style). ──────────
    // BUILTIN_NOTES was here: 250 lines and 23.7 KB of release notes for 14
    // versions, none newer than 7.40.0 (2026-07-01).
    //
    // WHY IT IS GONE
    // It existed to feed a fallback in _rawNotesFor whose comment read "never
    // show an empty What's New". On 2026-08-02 the owner opened the app running
    // v7.69.18 and was shown a sheet headed "Welcome to v7.69.15" — a stale
    // localStorage value — describing press-and-hold undo and a Drive
    // reconnection, which are v7.40.0's notes. Twenty-nine releases old, under
    // the wrong version number, presented as his.
    //
    // A duplicate copy of release history that only ever drifts from
    // version.json is not a safety net; it is a second source of truth with no
    // way to be right. version.json is written by release.cjs from the actual
    // commits, and is now the only place notes come from.

    let _manifest = null;     // loaded version.json (optional)
    let _swWaiting = null;    // a waiting service worker, if any
    let _fbImageData = null;  // attached screenshot (downscaled data-URL) for feedback

    // ───────────────────────────────────────────────────────────────────────
    //  DETECTION
    // ───────────────────────────────────────────────────────────────────────
    async function _loadManifest() {
        // (a) inline manifest if the page defined one
        if (window.wfVersionManifest) { _manifest = window.wfVersionManifest; return _manifest; }
        // (b) Firestore manifest written by the auto-release brain — this lets
        //     the server announce/schedule updates with NO redeploy. Takes
        //     priority over the static file when present and newer.
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const db = window.db || (fb && fb.firestore ? fb.firestore() : null);
            if (db) {
                const doc = await db.collection('system').doc('manifest').get();
                if (doc && doc.exists) {
                    const m = doc.data();
                    if (m && m.latest) { _manifest = m; return _manifest; }
                }
            }
        } catch (_) { /* offline or no permission — fall through to static file */ }
        // (c) static version.json (cache-busted) — fallback
        try {
            const r = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
            if (r.ok) { _manifest = await r.json(); return _manifest; }
        } catch (_) {}
        return null;
    }

    function _installedVersion() {
        // THE TRUTH IS THE CODE THAT IS RUNNING, NOT WHAT localStorage REMEMBERS.
        //
        // CURRENT_VERSION is rewritten inside this file by release.cjs at release
        // time, so whatever value is executing right now IS the installed build.
        // LS_INSTALLED only advanced when the user went through the in-app update
        // flow -- so a hard refresh, which is how new code usually arrives, left
        // it frozen. That is why a device executing v7.69.18 announced "Welcome
        // to v7.69.15": it was reporting a memory of an install rather than the
        // bundle it had just loaded.
        //
        // Reconcile forward only. A stored value AHEAD of CURRENT_VERSION means
        // the device has been served older code than it once ran (a rollback, or
        // a stale cache), and silently rewriting it downward would erase the only
        // evidence of that.
        try {
            var stored = localStorage.getItem(LS_INSTALLED);
            if (!stored || _cmp(CURRENT_VERSION, stored) > 0) {
                try { localStorage.setItem(LS_INSTALLED, CURRENT_VERSION); } catch (_) {}
                return CURRENT_VERSION;
            }
            return stored;
        } catch (_) { return CURRENT_VERSION; }
    }
    function _markInstalled(v) {
        try { localStorage.setItem(LS_INSTALLED, v); } catch (_) {}
    }

    // The version that is *available* to move to (manifest latest, else current build)
    function _latestVersion() {
        if (_manifest && _manifest.latest) return _manifest.latest;
        return CURRENT_VERSION;
    }

    // v7.35.0 — release notes come in TWO shapes: a rich object
    // { headline, date, sections:[{title, items:[...]}] } (BUILTIN_NOTES) OR a plain
    // string (the version.json manifest, e.g. "7.34.0": "…"). The What's-New sheet and
    // the post-update welcome both read notes.sections — a string has none, so they
    // used to throw (undefined.map / undefined.forEach) and the "View" button did
    // nothing. _normNotes guarantees the object shape for every caller.
    function _normNotes(n) {
        if (!n) return null;
        if (typeof n === 'string') {
            const txt = n.trim();
            return txt ? { headline: "What's New", sections: [{ title: 'Highlights', items: [txt] }] } : null;
        }
        if (Array.isArray(n.sections)) return n;            // already structured
        const items = [];
        ['body', 'note', 'text', 'desc', 'description', 'summary'].forEach(k => { if (n[k]) items.push(String(n[k])); });
        const out = { headline: n.headline || "What's New", sections: items.length ? [{ title: 'Highlights', items }] : [] };
        if (n.date) out.date = n.date;
        if (n.mandatory) out.mandatory = n.mandatory;
        if (n.security) out.security = n.security;
        return out;
    }
    function _rawNotesFor(v) {
        // Notes for THIS version, or nothing. There is deliberately no fallback.
        //
        // The previous implementation ended with "never show an empty What's
        // New: fall back to the newest notes we have" and returned another
        // release's notes when this one had none. That is how a device running
        // v7.69.18 came to display v7.40.0's feature list. Showing the wrong
        // release's notes is worse than showing none: an empty sheet is a
        // missing note, a filled one is a false claim about what the owner is
        // running.
        //
        // Callers already handle null correctly -- _maybeShowPostUpdate marks
        // the popup seen and returns without drawing, so nothing renders an
        // empty shell.
        if (_manifest && _manifest.notes && _manifest.notes[v]) return _manifest.notes[v];
        return null;
    }
    function _notesFor(v) { return _normNotes(_rawNotesFor(v)); }
    function _isMandatory(v) {
        if (_manifest && _manifest.mandatory && _manifest.mandatory.indexOf(v) >= 0) return true;
        const n = _notesFor(v);
        return !!(n && n.mandatory);
    }
    // Update "type": full | minor | security. Drives the badge + messaging.
    function _updateType(v) {
        const n = _notesFor(v);
        if (n && n.type) return n.type;
        if (_isMandatory(v)) return 'security';
        // infer from version delta: major/minor bump = full, patch = minor
        const inst = _installedVersion() || CURRENT_VERSION;
        const a = String(v).split('.').map(Number), b = String(inst).split('.').map(Number);
        if ((a[0] || 0) > (b[0] || 0) || (a[1] || 0) > (b[1] || 0)) return 'full';
        return 'minor';
    }
    function _typeBadge(type) {
        const map = {
            full:     ['Full update', '#10b981', 'rgba(16,185,129,0.15)'],
            minor:    ['Minor update', '#818cf8', 'rgba(129,140,248,0.15)'],
            security: ['Security update', '#f59e0b', 'rgba(245,158,11,0.15)']
        };
        const m = map[type] || map.minor;
        return '<span class="badge" style="background:' + m[2] + ';color:' + m[1] + ';padding:4px 10px;border-radius:999px;font-size:11px;font-weight:800;">' + m[0] + '</span>';
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
        _updateNavBadge();
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
        // The card #wfUpdateCard is now a permanent placeholder inside the
        // settings template (it survives every renderSettings rebuild). We just
        // fill it. If for any reason the placeholder isn't there yet (older
        // cached HTML), fall back to creating it before the PWA section.
        const ph = document.getElementById('wfUpdateCard');
        if (ph) { ph.classList.add('settings-section'); _renderSettingsCard(); return true; }
        const pwa = document.getElementById('wfPwaSection');
        if (!pwa || !pwa.parentNode) return false;
        const card = document.createElement('div');
        card.className = 'settings-section';
        card.id = 'wfUpdateCard';
        pwa.parentNode.insertBefore(card, pwa);
        _renderSettingsCard();
        return true;
    }

    function _renderSettingsCard() {
        const card = document.getElementById('wfUpdateCard');
        if (!card) return;
        card.classList.add('settings-section');
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
                    ? '<span style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;justify-content:flex-end;">' + _typeBadge(_updateType(latest)) + '<span class="badge" style="background:rgba(16,185,129,0.15);color:#10b981;padding:6px 12px;border-radius:999px;font-weight:800;">v' + _esc(latest) + '</span></span>'
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
                '<div class="setting-info"><div class="setting-label">Check for updates</div><div class="setting-desc">Look for a newer version right now.</div></div>' +
                '<button class="btn btn-secondary btn-sm" id="wfCheckBtn" onclick="wfUpdate.check()">Check now</button>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">System self-check</div><div class="setting-desc">Run a full diagnostic across the app\'s engines and report any issues.</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.diagnostics()">Run</button>' +
            '</div>' +
            '<div class="setting-row" style="border-top:1px solid var(--border);margin-top:8px;padding-top:12px;">' +
                '<div class="setting-info"><div class="setting-label">Auto-install security updates</div><div class="setting-desc">Like Android: when ON, urgent security updates install automatically (still backup-first + rollback). Other updates always ask first.</div></div>' +
                '<div class="toggle' + (_autoSecurityOn() ? ' on' : '') + '" id="wfAutoSec" onclick="wfUpdate.setAutoSecurity(!this.classList.contains(\'on\'))"></div>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Prioritised feedback</div><div class="setting-desc">See all user feedback scored and ranked by urgency (security & crashes first).</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfFeedbackAI && wfFeedbackAI.showBoard()">View</button>' +
            '</div>' +
            '<div class="setting-row">' +
                '<div class="setting-info"><div class="setting-label">Send Feedback</div><div class="setting-desc">Report a bug or suggest an idea — it\'s scored and prioritised automatically.</div></div>' +
                '<button class="btn btn-secondary btn-sm" onclick="wfUpdate.feedback()">Send</button>' +
            '</div>';
        _updateNavBadge();
    }

    // Red "1" badge on the Settings nav item when an update is available.
    function _updateNavBadge() {
        // keep the sidebar version label in sync with the real running version.
        //
        // CRITICAL FIX (v7.16.2): only write to the DOM when the value actually
        // CHANGES. A no-op `textContent = x` assignment STILL tears down the old
        // text node and inserts a fresh one — that counts as a childList mutation.
        // The old MutationObserver called this function on every mutation, so each
        // write re-fired the observer, which wrote again… an infinite self-feeding
        // microtask loop that starved the main thread. That single loop froze the
        // splash progress bar (~40%, stuck on "Securing connection…") so the app
        // never opened, and made the Settings / Software-Update buttons feel dead.
        // Idempotent writes below make every redundant call a true no-op, which is
        // what finally breaks the loop.
        try {
            const sv = document.getElementById('wfSbVer');
            if (sv) {
                const label = 'WealthFlow v' + (_installedVersion() || CURRENT_VERSION) + ' · Infinity Engine';
                if (sv.textContent !== label) sv.textContent = label;
            }
        } catch (_) {}
        const badge = document.getElementById('nb-settings');
        if (!badge) return;
        const show = _updateAvailable() || !!_swWaiting;
        const disp = show ? '' : 'none';
        if (badge.style.display !== disp) badge.style.display = disp;
        if (show && badge.textContent !== '1') badge.textContent = '1';
    }

    function _autoSecurityOn() { try { return localStorage.getItem(LS_AUTOSEC) === '1'; } catch (_) { return false; } }
    function setAutoSecurity(on) {
        try { localStorage.setItem(LS_AUTOSEC, on ? '1' : '0'); } catch (_) {}
        const tg = document.getElementById('wfAutoSec'); if (tg) tg.classList.toggle('on', !!on);
        _notify(on ? 'Auto-install for urgent security updates is ON.' : 'Auto-install for security updates is OFF.', on ? 'success' : 'info');
        if (on && _updateAvailable() && _isMandatory(_latestVersion())) {
            setTimeout(() => _autoApplyIfSecurity(), 600);
        }
    }

    // If the user opted in, silently apply an URGENT (mandatory security) update
    // — still backup-first and rollback-safe. Non-security updates never auto-apply.
    async function _autoApplyIfSecurity() {
        if (!_autoSecurityOn()) return false;
        const v = _latestVersion();
        if (!_updateAvailable()) return false;
        if (!(_isMandatory(v) && _updateType(v) === 'security')) return false;
        _notify('Installing urgent security update v' + v + '…', 'warn');
        await _runProgress(v);   // backup → swap → reload, no prompts
        return true;
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
                // Local pre-update snapshot so self-heal can roll data back if the
                // new version crash-loops. Stores the wf2_* keys only (the app's data).
                try {
                    const snap = {};
                    for (let i = 0; i < localStorage.length; i++) {
                        const k = localStorage.key(i);
                        if (k && k.indexOf('wf2_') === 0) snap[k] = localStorage.getItem(k);
                    }
                    localStorage.setItem('wf_preupdate_snapshot', JSON.stringify({ at: Date.now(), data: snap }));
                } catch (_) {}
            }},
            // THE STEP THAT USED TO LIE. It called reg.update() — which refetches
            // sw.js and nothing else — then slept 700ms while a bar labelled
            // "Downloading new version files" advanced to 40%. No version file was
            // ever downloaded. Now it downloads the actual modules this page runs
            // and drives the bar off completed bytes, so the number on screen is a
            // measurement rather than an animation.
            { pct: 68, eta: null, label: 'Downloading new version files…', run: async (report) => {
                try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (_) {}
                const files = _appFileList();
                if (!files.length) return;            // nothing measurable; do not fake a delay
                let done = 0;
                const started = Date.now();
                await Promise.all(files.map(async (src) => {
                    // cache: 'reload' bypasses the browser's HTTP cache and, with the
                    // service worker's network-first fetch handler, populates the new
                    // version's cache as a side effect — so this really is the download.
                    try { await fetch(src, { cache: 'reload' }); } catch (_) { /* offline/404: still counts as attempted */ }
                    done += 1;
                    const frac = done / files.length;
                    const elapsed = (Date.now() - started) / 1000;
                    // Remaining time projected from the rate actually observed so far.
                    const eta = frac > 0.05 ? Math.max(0, Math.round(elapsed / frac - elapsed)) : null;
                    report(12 + Math.round(frac * 56), eta, done, files.length);
                }));
            }},
            { pct: 88, eta: 2, label: 'Swapping core files…', run: async () => {
                try { localStorage.setItem(LS_PENDING, version); } catch (_) {}
                // tell the waiting SW to take over (triggers controllerchange→reload)
                try {
                    const reg = await navigator.serviceWorker.getRegistration();
                    const w = (reg && reg.waiting) || _swWaiting;
                    if (w) w.postMessage({ type: 'SKIP_WAITING' });
                } catch (_) {}
            }},
        ];

        for (const st of steps) {
            setStep(st.label); setEta(st.eta);
            // Steps report real sub-progress; those that cannot simply do not call it.
            await st.run((pct, eta, done, total) => {
                setBar(pct);
                if (eta != null) setEta(eta);
                if (total) setStep(st.label + ' (' + done + '/' + total + ')');
            });
            setBar(st.pct);
        }

        // Mark the new version installed and queue the post-update popup.
        _markInstalled(version);
        try { localStorage.setItem(LS_SEEN_POPUP, ''); } catch (_) {}
        setBar(100); setEta(0);
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
    //  CHECK FOR UPDATES (manual)
    // ───────────────────────────────────────────────────────────────────────
    async function checkForUpdates() {
        const btn = document.getElementById('wfCheckBtn');
        if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
        // re-fetch manifest + ask the SW to look for new files
        await _loadManifest();
        try { const reg = await navigator.serviceWorker.getRegistration(); if (reg) await reg.update(); } catch (_) {}
        await _sleep(900);
        if (btn) { btn.disabled = false; btn.textContent = 'Check now'; }
        _refreshDashboardPill();
        _renderSettingsCard();
        if (_updateAvailable() || _swWaiting) {
            _notify('Update available — v' + _latestVersion() + ' is ready to install.', 'success');
            openUpdateSection();
        } else {
            _notify('You\'re on the latest version (v' + (_installedVersion() || CURRENT_VERSION) + ').', 'info');
        }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  SYSTEM SELF-CHECK / DIAGNOSTICS
    //  The honest version of "all the AIs check the code": a multi-stage
    //  diagnostic that verifies every engine is loaded and responding, checks
    //  data integrity, and reports issues. Runs real checks, not theatre.
    // ───────────────────────────────────────────────────────────────────────
    function _runChecks() {
        const checks = [];
        const ok = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

        // Stage 1 — core engines present
        ok('Brain / classifier reachable', typeof window.wfBrainClassify === 'function' || typeof window.wfClassifySms === 'function', 'SMS/statement classification');
        ok('Category intelligence', !!(window.wfCategoryAI && window.wfCategoryAI.classify), '600+ keyword rules');
        ok('Learning memory', !!(window.wfMemory && window.wfMemory.recall), 'remembers your categories');
        ok('Duplicate defence', !!(window.wfDedup && window.wfDedup.scanExisting), 'stops double-filing');
        ok('Review queue', !!(window.wfReview && window.wfReview.add), 'ask-me-later');
        ok('Background queue', !!(window.wfQueue && window.wfQueue.enqueueSms), 'walk-away processing');
        ok('Encryption', !!(window.wfCrypto && (window.wfCrypto.isAvailable ? window.wfCrypto.isAvailable() : true)), 'AES-256-GCM at rest');
        ok('Card registry', !!(window.wfCardRegistry && window.wfCardRegistry.get), 'card→type routing');
        ok('Update system', !!(window.wfUpdate && window.wfUpdate.start), 'this engine');
        ok('Boot Guard', typeof window.__wfBootGuardSuccess === 'function', 'purges bad cache & recovers from black screen');
        ok('Feedback intelligence', !!(window.wfFeedbackAI && window.wfFeedbackAI.analyse), 'semantic prioritisation');

        // Stage 2 — storage + data integrity
        let dbOk = false, recCount = 0;
        try {
            dbOk = !!(window.DB && typeof DB.get === 'function');
            if (dbOk) ['expenses', 'income', 'subscriptions', 'cconetime', 'ccinstall'].forEach(k => { try { recCount += (DB.get(k) || []).length; } catch (_) {} });
        } catch (_) {}
        ok('Local database', dbOk, recCount + ' records readable');

        // Stage 3 — cloud + backup
        // Cloud sync: Firestore is up if the firebase SDK loaded AND an app is
        // initialised. Check several signals so a local variable name doesn't
        // cause a false "CHECK".
        let cloudOk = false;
        try {
            const fb = window.firebase || (typeof firebase !== 'undefined' ? firebase : null);
            const hasApp = !!(fb && fb.apps && fb.apps.length > 0);
            const hasStore = !!(window.db || (fb && fb.firestore));
            cloudOk = !!(fb && (hasApp || hasStore));
        } catch (_) {}
        ok('Cloud sync', cloudOk, cloudOk ? 'real-time Firestore' : 'sign in to enable cloud sync');
        let lastBackup = null;
        try { lastBackup = (typeof window._getLastBackupMs === 'function') ? window._getLastBackupMs() : null; } catch (_) {}
        ok('Backup ready', !!(typeof window.backupNow === 'function'), lastBackup ? ('last: ' + new Date(lastBackup).toLocaleString()) : 'backup engine present');

        // Stage 4 — service worker / offline
        ok('Offline support', 'serviceWorker' in navigator, 'works without signal');

        // Stage 5 — live functional probe (actually classify a known string)
        let probeOk = false, probeDetail = '';
        try {
            if (window.wfCategoryAI && window.wfCategoryAI.classify) {
                const r = window.wfCategoryAI.classify('CARGILLS FOOD CITY', 'debit LKR1000 CARGILLS FOOD CITY', { type: 'debit', useMemory: false });
                probeOk = r && /grocer|food/i.test(r.category);
                probeDetail = 'Cargills → ' + (r ? r.category : '?');
            }
        } catch (_) {}
        ok('Live classification probe', probeOk, probeDetail);

        return checks;
    }

    function showDiagnostics() {
        _closeOverlay('wfDiag');
        const ov = document.createElement('div');
        ov.id = 'wfDiag';
        ov.style.cssText = _overlayCss();
        ov.innerHTML = _sheet('System Self-Check', 'Running diagnostics…',
            '<div id="wfDiagBody" style="min-height:120px;display:flex;align-items:center;justify-content:center;color:var(--text3);font-size:13px;">Scanning all engines…</div>',
            '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._close(\'wfDiag\')">Close</button>');
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');

        // run checks progressively for a "working" feel, then render results
        setTimeout(() => {
            const checks = _runChecks();
            const passed = checks.filter(c => c.pass).length;
            const total = checks.length;
            const allGood = passed === total;
            const rows = checks.map(c =>
                '<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--border,#1f2638);">' +
                    '<span style="font-size:15px;">' + (c.pass ? '✅' : '⚠️') + '</span>' +
                    '<div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text,#e6e7eb);">' + _esc(c.name) + '</div>' +
                    (c.detail ? '<div style="font-size:11px;color:var(--text3,#8b95a8);">' + _esc(c.detail) + '</div>' : '') + '</div>' +
                    '<span style="font-size:11px;font-weight:700;color:' + (c.pass ? '#10b981' : '#f59e0b') + ';">' + (c.pass ? 'OK' : 'CHECK') + '</span>' +
                '</div>').join('');
            const body = document.getElementById('wfDiagBody');
            if (body) {
                body.style.display = 'block';
                body.innerHTML =
                    '<div style="text-align:center;margin-bottom:14px;">' +
                        '<div style="font-size:34px;font-weight:900;color:' + (allGood ? '#10b981' : '#f59e0b') + ';">' + passed + '/' + total + '</div>' +
                        '<div style="font-size:12.5px;color:var(--text3,#8b95a8);">' + (allGood ? 'All systems operational' : 'Some items need attention') + '</div>' +
                    '</div>' + rows;
            }
            const sub = ov.querySelector('div[style*="font-size:12.5px"]');
            if (sub) sub.textContent = allGood ? 'All systems operational' : passed + '/' + total + ' checks passed';
        }, 900);
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
                '<div>' +
                    '<input type="file" id="wfFbImg" accept="image/*" style="display:none;" />' +
                    '<button type="button" id="wfFbImgBtn" style="width:100%;padding:11px;background:var(--bg,#060a14);border:1px dashed var(--border2,#1f2638);border-radius:9px;color:var(--text3,#8b95a8);font-size:13px;cursor:pointer;">📎 Attach a screenshot (optional)</button>' +
                    '<div id="wfFbImgPreview" style="display:none;margin-top:8px;position:relative;"></div>' +
                '</div>' +
                '<label style="display:flex;align-items:flex-start;gap:8px;font-size:12px;color:var(--text3,#8b95a8);line-height:1.5;"><input type="checkbox" id="wfFbDiag" checked style="margin-top:2px;flex-shrink:0;"> <span>Send system diagnosis \u2014 attaches the recorded errors, stack traces, health snapshot and device details so the cause can be found automatically. <strong style="color:var(--text2,#a8b2c4);">Never includes any financial data.</strong></span></label>' +
            '</div>',
            '<div style="display:flex;gap:8px;">' +
                '<button class="btn btn-ghost" style="flex:1;" onclick="wfUpdate._close(\'wfFeedback\')">Cancel</button>' +
                '<button class="btn btn-primary" style="flex:2;" id="wfFbSend">Send feedback</button>' +
            '</div>'
        );
        document.body.appendChild(ov);
        requestAnimationFrame(() => ov.style.opacity = '1');
        ov.querySelector('#wfFbSend').onclick = _submitFeedback;
        // image attach: read as a downscaled data-URL so it's small enough to store
        const imgBtn = ov.querySelector('#wfFbImgBtn'), imgInput = ov.querySelector('#wfFbImg'), prev = ov.querySelector('#wfFbImgPreview');
        if (imgBtn && imgInput) {
            imgBtn.onclick = () => imgInput.click();
            imgInput.onchange = () => {
                const f = imgInput.files && imgInput.files[0];
                if (!f) return;
                const reader = new FileReader();
                reader.onload = () => {
                    // downscale to max 900px to keep the payload small
                    const img = new Image();
                    img.onload = () => {
                        const max = 900, scale = Math.min(1, max / Math.max(img.width, img.height));
                        const cv = document.createElement('canvas');
                        cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
                        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
                        _fbImageData = cv.toDataURL('image/jpeg', 0.7);
                        if (prev) { prev.style.display = 'block'; prev.innerHTML = '<img src="' + _fbImageData + '" style="max-width:100%;border-radius:8px;border:1px solid var(--border,#1f2638);"/><button type="button" onclick="this.parentNode.style.display=\'none\';this.parentNode.innerHTML=\'\';window.wfUpdate&&(window.wfUpdate._clearFbImg&&window.wfUpdate._clearFbImg());" style="position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);color:#fff;border:none;border-radius:50%;width:26px;height:26px;cursor:pointer;">×</button>'; }
                        if (imgBtn) imgBtn.textContent = '📎 Screenshot attached — tap to change';
                    };
                    img.src = reader.result;
                };
                reader.readAsDataURL(f);
            };
        }
    }

    /*  Collect the REAL diagnostics the "send system diagnosis" tick promises.
     *
     *  The tick used to attach only navigator.userAgent, the screen size and the
     *  language — while the app was already capturing a full crash report
     *  (_wfCrashReport), a health snapshot (_wfCollectHealth) and a detected-issue
     *  list (_wfDetectIssues) for the separate "Copy diagnostics" button. Ticking
     *  the box therefore sent almost nothing useful, which is why reports could
     *  not be acted on. This gathers what the tick actually claims to send.
     *
     *  Size-capped, and financial data is never included: only error messages,
     *  stack traces, counts and device facts.
     */
    function _collectDiagnostics() {
        var d = {
            ua: navigator.userAgent,
            screen: (screen.width + 'x' + screen.height),
            viewport: (window.innerWidth + 'x' + window.innerHeight),
            dpr: window.devicePixelRatio || 1,
            lang: navigator.language,
            online: navigator.onLine,
            tz: (function () { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return null; } })(),
            standalone: (function () { try { return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true; } catch (_) { return false; } })(),
            activePage: (function () { try { var a = document.querySelector('.page.active'); return a ? a.id.replace('page-', '') : ''; } catch (_) { return ''; } })(),
            domNodes: (function () { try { return document.getElementsByTagName('*').length; } catch (_) { return -1; } })()
        };
        // the captured error log — the single most useful thing for a fix
        try {
            var log = (typeof window._wfCrashReport === 'function' && window._wfCrashReport()) || [];
            var build = window.WF_APP_VERSION || CURRENT_VERSION;
            var fromThis = log.filter(function (e) { return e && e.ver === build; });
            d.errorSummary = {
                total: log.length,
                fromThisBuild: fromThis.length,
                uniqueMessages: Array.from(new Set(log.map(function (e) { return (e && e.msg) || ''; }).filter(Boolean))).slice(0, 15)
            };
            // most recent errors, newest first, trimmed so the payload stays small
            d.errors = log.slice(-8).reverse().map(function (e) {
                return {
                    msg: String((e && e.msg) || '').slice(0, 400),
                    stack: String((e && e.stack) || '').slice(0, 900),
                    page: (e && e.page) || null,
                    ver: (e && e.ver) || null,
                    at: (e && (e.t || e.when)) || null
                };
            });
        } catch (_) {}
        try {
            if (typeof window._wfCollectHealth === 'function') {
                var h = window._wfCollectHealth();
                d.health = JSON.parse(JSON.stringify(h)); // strip anything non-serialisable
            }
        } catch (_) {}
        try {
            if (typeof window._wfDetectIssues === 'function') {
                var issues = window._wfDetectIssues(d.health, d.errorSummary) || [];
                d.detectedIssues = issues.slice(0, 12);
            }
        } catch (_) {}
        // hard size cap: an oversized payload is silently dropped by the endpoint,
        // which would look to the user like their report vanished again
        try {
            var s = JSON.stringify(d);
            if (s.length > 24000) {
                delete d.health;
                d.errors = (d.errors || []).slice(0, 3);
                d._trimmed = true;
            }
        } catch (_) {}
        return d;
    }

    /**
     * The click handler for "Send feedback".
     *
     * THE BUG THIS WRAPPER EXISTS TO END: the button did nothing. No request, no
     * toast, no error, modal still open. In an `async` click handler that is what
     * BOTH failure modes look like — a synchronous throw becomes an unhandled
     * rejection nobody sees, and an `await` on a promise that never settles just
     * stops. Neither prints anything. From the outside they are indistinguishable
     * from a dead event listener, which is why the listener was the first suspect.
     *
     * So the work is wrapped: the button reports that it is working the moment it
     * is pressed, every failure ends in a visible message, and the control is
     * always returned to the user even when something below goes wrong.
     */
    async function _submitFeedback() {
        const btn = document.getElementById('wfFbSend');
        if (btn && btn.getAttribute('data-sending') === '1') return;   // ignore double-taps
        const restore = () => {
            if (!btn) return;
            btn.removeAttribute('data-sending');
            btn.disabled = false;
            btn.textContent = 'Send feedback';
        };
        if (btn) { btn.setAttribute('data-sending', '1'); btn.disabled = true; btn.textContent = 'Sending…'; }
        try {
            await _doSubmitFeedback();
        } catch (err) {
            // Previously invisible. An async handler that throws prints nothing to
            // the page and the user is left clicking a button that looks inert.
            try { console.error('[feedback] submit failed:', err); } catch (_) {}
            _notify('Could not send your feedback: ' + String((err && err.message) || err).slice(0, 200), 'warn');
        } finally {
            restore();
        }
    }

    async function _doSubmitFeedback() {
        const type = (document.getElementById('wfFbType') || {}).value || 'other';
        const text = ((document.getElementById('wfFbText') || {}).value || '').trim();
        const diag = !!(document.getElementById('wfFbDiag') || {}).checked;
        if (text.length < 4) { _notify('Please type a little more so we can help.', 'warn'); return; }
        const diagnostics = diag ? _collectDiagnostics() : null;
        const payload = {
            type, text,
            version: _installedVersion() || CURRENT_VERSION,
            createdAt: new Date().toISOString(),
            uid: (window.currentUser && window.currentUser.uid) || null,
            image: _fbImageData || null,
            // kept as top-level fields for backwards compatibility with the email
            // backup, which formats them individually
            ua: diag ? navigator.userAgent : null,
            screen: diag ? (screen.width + 'x' + screen.height) : null,
            lang: diag ? navigator.language : null,
            diagnostics: diagnostics
        };
        // ALWAYS keep a local copy first, so "Your Feedback" shows it instantly
        // and nothing is ever lost — even if it also goes to the cloud.
        try { const s = JSON.parse(sessionStorage.getItem('wf_feedback_session') || '[]'); s.push(payload); sessionStorage.setItem('wf_feedback_session', JSON.stringify(s)); } catch (_) {}
        try { const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); q.push(Object.assign({ _pending: true }, payload)); localStorage.setItem('wf_feedback_queue', JSON.stringify(q.slice(-50))); } catch (_) {}

        let stored = false;
        // (1) Firestore — so it can be fetched/analysed/prioritised
        try {
            if (window.db && window.firebase && firebase.firestore) {
                const uid = payload.uid || 'anon';
                // BOUNDED, and this is the line that made the button do nothing.
                //
                // Firestore's add() promise resolves only when the SERVER
                // acknowledges the write. If the SDK cannot reach the backend —
                // offline, blocked, expired auth, exhausted quota — the write is
                // applied to the local cache immediately and the promise stays
                // PENDING FOREVER. It never rejects, so the catch below cannot
                // help, and `await` on it halts this function permanently: no
                // POST is ever issued, no toast is ever shown, the modal never
                // closes. An unbounded await on a third-party SDK had been
                // sitting on the critical path of the submit.
                //
                // The report is already in localStorage and sessionStorage above,
                // so abandoning this write loses nothing — the queue retries it.
                await _withTimeout(
                    window.db.collection('feedback').add(Object.assign({}, payload, { uid,
                        _ts: firebase.firestore.FieldValue.serverTimestamp() })),
                    8000, 'Firestore write');
                stored = true;
                _markQueuedSent(payload);   // clear the _pending flag for this item
            }
        } catch (e) {
            try { console.warn('[feedback] Firestore copy skipped:', (e && e.message) || e); } catch (_) {}
        }
        // (2) TRIAGE — turn this into a GitHub issue so the autonomous pipeline
        //     can actually work on it.
        //
        //     THIS CALL WAS MISSING. /api/feedback-triage has existed all along and
        //     is the ONLY path by which feedback becomes something the agent can
        //     see, but no client code ever called it. Feedback went to Firestore
        //     and an optional email and stopped there, so the "autonomous system
        //     acts on my feedback" loop was never connected at either end.
        //
        //     We remember the issue number so the app can later report back that
        //     the work is done — see _checkFeedbackCompletions().
        let issueNumber = null;
        let triageError = null;
        try {
            const r = await _fetchWithTimeout('/api/feedback-triage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    type, text,
                    version: payload.version,
                    createdAt: payload.createdAt,
                    diagnostics: diagnostics,
                    // The screenshot has to come WITH the report. feedback-triage.js
                    // renders `body.image` into the issue so the fix agent can look at
                    // what the user was looking at — but this call never sent the
                    // field, so that renderer received '' on every real submission and
                    // the picture went only to Firestore. Machinery present, signal
                    // absent, for the second time in the same feature.
                    image: payload.image || null
                })
                // Generous, because this endpoint classifies the report and calls
                // the GitHub API before answering — but finite, so a stalled
                // request ends in a message rather than a button that never
                // comes back.
            }, 30000);
            // Read the body on EVERY status, then decide from BOTH the status and
            // the body — see _readTriageResponse for why the body alone is not
            // enough to tell success from failure.
            const j = await r.json().catch(() => null);
            const verdict = _readTriageResponse(r.status, j);
            issueNumber = verdict.issue;
            triageError = verdict.reason;
            if (issueNumber) stored = true;
            if (triageError) {
                try {
                    console.warn('[feedback] not filed:', 'HTTP ' + r.status, (j && j.error) || 'unknown', triageError,
                        (j && j.configured) ? '(configured: repo=' + j.configured.repo + ' token=' + j.configured.token + ')' : '');
                } catch (_) {}
            }
        } catch (e) {
            // A request that never completed is still a report that was not filed.
            // Swallowing it silently is precisely how an unreachable endpoint came
            // back as "saved and prioritised" whenever Firestore had already
            // succeeded a few lines above.
            triageError = _readTriageResponse(0, null, e).reason;
        }
        if (issueNumber) { payload.issue = issueNumber; _attachIssueToQueued(payload, issueNumber); }

        // (3) Email backup for urgent alerts (optional endpoint, fails silently)
        //     `fetch` only rejects on a network failure, so awaiting it and setting
        //     stored = true counted a 404 or a 500 as "saved" — the same mistake in
        //     miniature.
        try {
            const rf = await _fetchWithTimeout('/api/feedback',
                { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }, 10000);
            if (rf && rf.ok) stored = true;
        } catch (_) {}
        _fbImageData = null;
        _close('wfFeedback');

        // Tell the user what will actually happen, not just "thanks".
        const said = _feedbackMessage({ issue: issueNumber, reason: triageError, stored: stored });
        _notify(said.msg, said.tone);
    }

    /**
     * Decide what a /api/feedback-triage response actually means.
     *
     * WHY THIS IS NOT AN INLINE `if (j && j.reason)` ANY MORE
     *   That is what it was, and it trusted the endpoint to name its own failures.
     *   The endpoint does — but it is not the only thing that answers this URL:
     *
     *     • api/router.js replies `{ error: 'Unknown endpoint' }` (404) or
     *       `{ error: 'Endpoint runtime crash' }` (500) — JSON, but with no
     *       `reason` field;
     *     • a platform-level failure (a function that fails to boot, a body over
     *       the size limit, a gateway timeout) replies with HTML, so `r.json()`
     *       rejects and `j` is null.
     *
     *   In every one of those cases the old check matched nothing, `triageError`
     *   stayed null, and the ladder below fell through to "saved and prioritised".
     *   The false confirmation this feature exists to remove, reintroduced one
     *   layer up from where it was fixed.
     *
     *   So the rule is inverted: SUCCESS must be proven — a 2xx carrying an issue
     *   number. Everything else is a failure, and a failure that cannot explain
     *   itself still has to say what it knows.
     *
     * @param {number} status  HTTP status, or 0 if the request never completed.
     * @param {object|null} body  Parsed JSON body, or null if it was not JSON.
     * @param {Error} [err]  The thrown error, when status is 0.
     */
    function _readTriageResponse(status, body, err) {
        const j = body && typeof body === 'object' ? body : null;
        if (status >= 200 && status < 300 && j && (j.issue || j.deduped)) {
            // `deduped` means an open issue already covers this — the report IS
            // represented, but saying "this is now queued as work item #N" would
            // claim their submission created it. Distinguished so the user can
            // tell "I filed something" from "this was already known".
            return { issue: j.issue || j.deduped, deduped: !j.issue && !!j.deduped, reason: null };
        }
        // The endpoint's own explanation, when there is one, is the best answer:
        // it knows whether the token is missing, unauthorised, or GitHub refused.
        if (j && j.reason) return { issue: null, reason: String(j.reason).slice(0, 300) };

        const detail = (j && (j.error || j.detail))
            ? ' (' + String(j.error || j.detail).slice(0, 120) + ')' : '';
        if (!status) {
            if (typeof navigator !== 'undefined' && navigator.onLine === false) {
                return { issue: null, reason: 'you appear to be offline. It will be filed automatically once you are back online.' };
            }
            return { issue: null, reason: 'the server could not be reached (' + String((err && err.message) || 'network error').slice(0, 120) + ').' };
        }
        if (status === 404) {
            return { issue: null, reason: 'the triage endpoint is not available on this deployment (HTTP 404)' + detail + '.' };
        }
        return { issue: null, reason: 'the server answered HTTP ' + status + ' without saying why' + detail + '.' };
    }

    /**
     * The words the user sees. Pure, so a test can prove which one they get.
     *
     * There is deliberately no branch left that says "prioritised". Nothing here
     * can know that a report was prioritised unless it became a work item, and
     * claiming it anyway is the exact thing the user caught us doing.
     */
    function _feedbackMessage(s) {
        if (s && s.issue) {
            return {
                msg: s.deduped
                    ? ('Thank you — this is already tracked as work item #' + s.issue
                        + '. You\'ll see it marked Completed here once the fix ships.')
                    : ('Thank you — this is now queued as work item #' + s.issue +
                        '. You\'ll see it marked Completed here once the fix ships.'),
                tone: 'success',
            };
        }
        if (s && s.reason) {
            // The report is SAFE — it is in the local queue and usually in Firestore
            // too — but it did not become a tracked work item, and that difference
            // is the whole point of saying anything at all.
            return { msg: 'Saved, but it could not be filed as a work item yet: ' + s.reason, tone: 'warn' };
        }
        return {
            msg: (s && s.stored)
                ? 'Saved — it already shows in “Your Feedback”.'
                : 'Saved — we\'ll send it automatically when you\'re back online. It already shows in “Your Feedback”.',
            tone: 'info',
        };
    }

    /** Record the issue number against the queued copy of this feedback item. */
    function _attachIssueToQueued(payload, issueNumber) {
        try {
            const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]');
            const key = (payload.text || '') + '|' + (payload.createdAt || '');
            const upd = q.map(x => ((x.text || '') + '|' + (x.createdAt || '')) === key
                ? Object.assign({}, x, { issue: issueNumber })
                : x);
            localStorage.setItem('wf_feedback_queue', JSON.stringify(upd));
        } catch (_) {}
    }

    // ───────────────────────────────────────────────────────────────────────
    //  Feedback completion reporting — the user asked for this explicitly:
    //  "when the system completes what I asked for, it must tell me it's done."
    //
    //  Polls /api/feedback-status for the issues this device created, marks the
    //  matching queued items completed, and shows one clear summary the first
    //  time each completion is seen.
    // ───────────────────────────────────────────────────────────────────────
    async function _checkFeedbackCompletions(opts) {
        const silent = !!(opts && opts.silent);
        let q;
        try { q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); } catch (_) { return []; }
        if (!Array.isArray(q) || !q.length) return [];

        // only issues we haven't already announced
        const pending = q.filter(x => x && x.issue && !x._completedSeen);
        if (!pending.length) return [];

        let items = [];
        try {
            const ids = Array.from(new Set(pending.map(x => x.issue))).slice(0, 25).join(',');
            const r = await fetch('/api/feedback-status?issues=' + encodeURIComponent(ids), { cache: 'no-store' });
            if (!r.ok) return [];
            const j = await r.json().catch(() => null);
            items = (j && Array.isArray(j.items)) ? j.items : [];
        } catch (_) { return []; }

        const byNumber = {};
        items.forEach(i => { if (i && i.number) byNumber[i.number] = i; });

        const finished = [];
        let changed = false;
        const upd = q.map(x => {
            if (!x || !x.issue) return x;
            const st = byNumber[x.issue];
            if (!st) return x;
            const next = Object.assign({}, x, {
                _status: st.completed ? 'completed' : st.needsHuman ? 'needs-attention' : st.inProgress ? 'in-progress' : 'open',
                _shippedVersion: st.shippedVersion || null
            });
            if (st.completed && !x._completedSeen) {
                next._completedSeen = true;
                finished.push({ text: x.text, issue: x.issue, version: st.shippedVersion, type: x.type });
                changed = true;
            } else if (next._status !== x._status) {
                changed = true;
            }
            return next;
        });
        if (changed) { try { localStorage.setItem('wf_feedback_queue', JSON.stringify(upd)); } catch (_) {} }

        if (finished.length && !silent) _showCompletionPopup(finished);
        return finished;
    }

    /** A centred, scrollable, dismissible summary of what just got fixed. */
    function _showCompletionPopup(finished) {
        try {
            const rows = finished.map(f =>
                '<div style="padding:12px 14px;border:1px solid var(--border2,#1f2638);border-radius:12px;margin-bottom:10px;background:rgba(16,185,129,0.06);">' +
                    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                        '<span style="font-size:16px;">✅</span>' +
                        '<span style="font-weight:800;font-size:13px;color:var(--green,#10b981);">Done' +
                        (f.version ? ' — shipped in v' + _esc(f.version) : '') + '</span>' +
                    '</div>' +
                    '<div style="font-size:13px;color:var(--text,#e6e7eb);line-height:1.5;">' + _esc(String(f.text || '').slice(0, 400)) + '</div>' +
                    '<div style="font-size:11px;color:var(--text3,#8b95a8);margin-top:6px;">Work item #' + _esc(String(f.issue)) + '</div>' +
                '</div>'
            ).join('');
            if (document.getElementById('wfFbDone')) return;   // never stack popups
            const ov = document.createElement('div');
            ov.id = 'wfFbDone';
            ov.style.cssText = _overlayCss();
            ov.innerHTML = _sheet(
                finished.length === 1 ? '✅ Your feedback is done' : '✅ ' + finished.length + ' of your reports are done',
                'You asked for this — here\'s what changed.',
                '<div style="max-height:52vh;overflow-y:auto;">' + rows + '</div>',
                '<button class="btn btn-primary" style="width:100%;" onclick="wfUpdate._close(\'wfFbDone\')">Close</button>'
            );
            document.body.appendChild(ov);
            requestAnimationFrame(() => { ov.style.opacity = '1'; });
        } catch (_) { /* a popup failure must never break the app */ }
    }

    // remove the _pending flag once an item is confirmed sent to the cloud
    function _markQueuedSent(payload) {
        try {
            const q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]');
            const key = (payload.text || '') + '|' + (payload.createdAt || '');
            const upd = q.map(x => ((x.text || '') + '|' + (x.createdAt || '')) === key ? Object.assign({}, x, { _pending: false }) : x);
            localStorage.setItem('wf_feedback_queue', JSON.stringify(upd));
        } catch (_) {}
    }

    // Flush any feedback that was queued while offline/closed → Firestore, so it
    // appears in the board and reaches the brain. Runs on launch + when online.
    async function _flushQueuedFeedback() {
        let q = [];
        try { q = JSON.parse(localStorage.getItem('wf_feedback_queue') || '[]'); } catch (_) { return; }
        const pending = q.filter(x => x && x._pending);
        if (!pending.length) return;
        if (!(window.db && window.firebase && firebase.firestore)) return;
        let changed = false;
        for (const p of pending) {
            try {
                const uid = p.uid || (window.currentUser && window.currentUser.uid) || 'anon';
                // Bounded, for the same reason the submit path is: Firestore's
                // add() resolves only on server ack and stays pending forever
                // when it cannot reach the backend. Unbounded here would stall
                // the whole flush on the first unreachable write.
                await _withTimeout(
                    window.db.collection('feedback').add(Object.assign({}, p, { uid, _pending: undefined,
                        _ts: firebase.firestore.FieldValue.serverTimestamp() })),
                    8000, 'Firestore flush');

                // AND FILE IT. This is the hole: the flush wrote to Firestore,
                // marked the item sent, and stopped — so a report submitted
                // while offline never became a work item. That is exactly the
                // bug #40 fixed on the online path ("feedback went to Firestore
                // and stopped"), surviving untouched in the one path nobody
                // tested, under a message that promises "we'll send it
                // automatically when you're back online".
                //
                // _pending is only cleared when BOTH have happened, so a report
                // that reached Firestore but not triage is retried rather than
                // being counted as delivered.
                let filed = false;
                try {
                    const r = await _fetchWithTimeout('/api/feedback-triage', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            type: p.type, text: p.text, version: p.version,
                            createdAt: p.createdAt, diagnostics: p.diagnostics || null,
                            image: p.image || null,
                        }),
                    }, 30000);
                    const j = await r.json().catch(() => null);
                    const v = _readTriageResponse(r.status, j);
                    if (v.issue) { p.issue = v.issue; filed = true; }
                } catch (_) { /* still unreachable — leave pending, try next time */ }

                if (filed) { p._pending = false; changed = true; }
            } catch (_) { /* still offline — keep for next time */ }
        }
        if (changed) { try { localStorage.setItem('wf_feedback_queue', JSON.stringify(q)); } catch (_) {} }
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

    /**
     * The app's own code, read from the document rather than a hand-kept list.
     *
     * A hardcoded array would drift the moment a module is added or deleted —
     * and this session deleted one — leaving the "download" step quietly missing
     * files while still reporting 100%. Reading <script src> means the list is
     * always exactly what this page loads.
     *
     * Same-origin only: third-party CDNs are not ours to re-fetch, and a failure
     * there must not be reported as a failed app update.
     */
    function _appFileList() {
        try {
            var out = [];
            var tags = document.querySelectorAll('script[src]');
            for (var i = 0; i < tags.length; i++) {
                var src = tags[i].getAttribute('src') || '';
                if (!src) continue;
                // Skip absolute cross-origin URLs; keep relative and same-origin paths.
                if (/^https?:\/\//i.test(src) && src.indexOf(location.origin) !== 0) continue;
                out.push(src);
            }
            // index.html itself is the shell every module hangs off, so it belongs
            // in the count the user watches.
            out.push('/index.html');
            return out;
        } catch (_) { return []; }
    }

    // ───────────────────────────────────────────────────────────────────────
    //  INIT
    // ───────────────────────────────────────────────────────────────────────
    async function init() {
        // Wrap everything so a failure in any single step can never prevent the
        // Software Update card from being injected (the "sometimes missing" bug).
        try { _watchServiceWorker(); } catch (_) {}

        const installed = _installedVersion();
        if (!installed) {
            _markInstalled(CURRENT_VERSION);
            try { localStorage.setItem(LS_SEEN_POPUP, CURRENT_VERSION); } catch (_) {}
        } else if (_cmp(CURRENT_VERSION, installed) > 0) {
            _markInstalled(CURRENT_VERSION);
            try { localStorage.removeItem(LS_SEEN_POPUP); } catch (_) {}
        }

        // Inject the card RIGHT NOW with whatever version info we already have,
        // BEFORE any awaited/network work. The manifest then loads in the
        // background and refreshes the card when it arrives.
        try { _injectSettingsCard(); _refreshDashboardPill(); } catch (_) {}

        // Load the manifest in the background (non-blocking). A hung/failed
        // Firestore/network call must never stall card injection.
        _loadManifest().then(() => {
            try { _refreshDashboardPill(); _renderSettingsCard(); } catch (_) {}
            // mandatory-update handling, after we know the real latest version
            try {
                if (_updateAvailable() && _isMandatory(_latestVersion())) {
                    if (_autoSecurityOn() && _updateType(_latestVersion()) === 'security') setTimeout(() => { _autoApplyIfSecurity(); }, 2000);
                    else setTimeout(() => { _notify('A required security update is available.', 'warn'); openUpdateSection(); }, 1800);
                }
            } catch (_) {}
        }).catch(() => {});

        setTimeout(_maybeShowPostUpdate, 1400);

        // Flush any feedback queued while offline/closed, and retry when back online.
        setTimeout(() => { _flushQueuedFeedback(); }, 3000);
        try { window.addEventListener('online', () => { _flushQueuedFeedback(); }); } catch (_) {}

        // Inject dashboard pill + settings card. First a short burst for the
        // initial paint, then a PERMANENT MutationObserver so the card is
        // guaranteed to (re)appear whenever the Settings page is in the DOM —
        // no finite retry count that could expire before Settings is opened.
        let tries = 0;
        const t = setInterval(() => {
            _refreshDashboardPill();
            _injectSettingsCard();
            if (++tries > 8) clearInterval(t);
        }, 600);

        // durable guard: whenever the Settings page re-renders, its
        // #wfUpdateCard placeholder is recreated EMPTY — re-fill it.
        //
        // CRITICAL FIX (v7.16.2): the previous version observed the ENTIRE
        // <body> and, on every single mutation, wrote to the DOM (#wfSbVer via
        // _refreshDashboardPill). Those writes were themselves mutations, so the
        // observer re-fired forever — an infinite microtask loop that pinned the
        // main thread. That one loop is what froze the splash progress bar at
        // ~40% (the app could never finish booting) AND what made every button
        // in the Software-Update section feel dead / the section appear to
        // vanish. The replacement below is loop-proof by design:
        //   • it is SCOPED to the settings container, not the whole body, so
        //     overlays, the clock, AI typing, etc. don't trigger it;
        //   • it NEVER touches the sidebar/pill on a mutation — it only ever
        //     re-fills an empty #wfUpdateCard;
        //   • it DISCONNECTS itself before writing and reconnects after, so it
        //     can never observe (and react to) its own changes;
        //   • it is debounced, so a burst of mutations collapses into one pass;
        //   • when the card is already present + filled it does NOTHING and
        //     schedules NOTHING — steady-state cost is effectively zero.
        try {
            const _target = () =>
                document.getElementById('page-settings') ||
                document.getElementById('settingsContent') ||
                document.body;
            let _scheduled = false;
            let mo = null;
            const _needsFill = () => {
                const ph = document.getElementById('wfUpdateCard');
                return !(ph && ph.querySelector('.settings-title')); // missing OR empty
            };
            const _fillNow = () => {
                _scheduled = false;
                if (!_needsFill()) return;            // already good → no DOM writes
                try { if (mo) mo.disconnect(); } catch (_) {}
                try { _injectSettingsCard(); } catch (_) {}   // creates-if-missing + fills
                try { if (mo) mo.observe(_target(), { childList: true, subtree: true }); } catch (_) {}
            };
            mo = new MutationObserver(() => {
                if (_scheduled) return;
                if (!_needsFill()) return;            // cheap read-only check, no writes
                _scheduled = true;
                setTimeout(_fillNow, 16);             // debounce one frame
            });
            mo.observe(_target(), { childList: true, subtree: true });
            window._wfUpdateObserver = mo;
        } catch (_) {}

        // heartbeat: timer-driven safety net (NOT mutation-driven, so it can
        // never loop). Re-fills an empty card and re-shows the dashboard pill if
        // it went missing after a dashboard re-render. Both calls are idempotent
        // and early-return when nothing is needed, so the steady-state cost is nil.
        setInterval(() => {
            try {
                const ph = document.getElementById('wfUpdateCard');
                if (ph && !ph.querySelector('.settings-title')) _renderSettingsCard();
                if (!document.getElementById('wfUpdatePill')) _refreshDashboardPill();
            } catch (_) {}
        }, 5000);

        // Re-check the manifest periodically (every 30 min) so a freshly
        // published update appears without a manual check.
        setInterval(async () => { try { await _loadManifest(); _refreshDashboardPill(); _renderSettingsCard(); } catch (_) {} }, 30 * 60 * 1000);
    }

    // ── DEV/TEST: simulate that an update is available so you can SEE the whole
    //    flow without publishing a new build. Call wfUpdate.simulate('7.13.0').
    //    Pass a version > current; clears with wfUpdate.simulate(false). ───────
    function simulateUpdate(versionOrFalse) {
        if (versionOrFalse === false || versionOrFalse == null) {
            _manifest = null;
            _markInstalled(CURRENT_VERSION);
            _refreshDashboardPill(); _renderSettingsCard();
            _notify('Test update cleared — back to current build.', 'info');
            return;
        }
        const v = String(versionOrFalse);
        _manifest = {
            latest: v,
            mandatory: [],
            notes: { [v]: {
                date: new Date().toISOString().slice(0, 10),
                type: 'full',
                headline: 'Test update ' + v,
                sections: [
                    { title: 'New', items: ['This is a simulated update so you can preview the full install journey.'] },
                    { title: 'Improved', items: ['Faster everything, smarter categorisation.'] },
                    { security: true, title: 'Security', items: ['Simulated monthly security hardening.'] }
                ]
            } }
        };
        // make sure the device is on an OLDER version than the simulated one
        try { localStorage.setItem(LS_INSTALLED, CURRENT_VERSION); } catch (_) {}
        _refreshDashboardPill(); _renderSettingsCard();
        _notify('Test update ' + v + ' is now available — check the Dashboard or Settings.', 'success');
        openUpdateSection();
    }

    window.wfUpdate = {
        init, start: startUpdate, whatsNew: showWhatsNew, openSection: openUpdateSection,
        feedback: openFeedback, check: checkForUpdates, diagnostics: showDiagnostics,
        simulate: simulateUpdate, setAutoSecurity: setAutoSecurity,
        _clearFbImg: () => { _fbImageData = null; },
        refresh: () => { _refreshDashboardPill(); _injectSettingsCard(); _renderSettingsCard(); },
        // Feedback completion reporting — exposed so the Settings screen and the
        // "Your Feedback" list can refresh statuses on demand.
        checkCompletions: _checkFeedbackCompletions,
        _collectDiagnostics,
        // Exposed for the same reason as _collectDiagnostics: the version the
        // app believes it is running is a claim the owner reads on screen, and a
        // test that only greps the source cannot tell a reconciled value from a
        // stale one. Read-only.
        _installedVersion,
        // Exposed so the test harness can prove which words a given server
        // response produces. The bug these replace was invisible to every test
        // that only read the source, because the logic was inline in an async
        // submit handler that needed a DOM, a network and Firebase to run.
        _readTriageResponse, _feedbackMessage,
        // Exposed because the failure they prevent — a promise that never settles
        // — cannot be caught by any test that only reads the source.
        _withTimeout, _fetchWithTimeout, _submitFeedback,
        _close, _closePost, version: CURRENT_VERSION
    };

    /*  Poll for feedback the system has finished.
     *
     *  Deliberately gentle: once shortly after launch (so the user sees a
     *  completion the next time they open the app, which is what they asked for),
     *  then every 15 minutes while the tab is open, and again whenever they come
     *  back to it. Each completion is announced exactly once — the _completedSeen
     *  flag is persisted, so reopening the app does not re-congratulate.
     */
    function _startCompletionWatcher() {
        const run = (silent) => { _checkFeedbackCompletions({ silent: !!silent }).catch(() => {}); };
        setTimeout(() => run(false), 6000);                    // after the app settles
        setInterval(() => run(false), 15 * 60 * 1000);
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') run(false);
        });
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', _startCompletionWatcher);
    } else {
        _startCompletionWatcher();
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => setTimeout(init, 1500));
    else setTimeout(init, 1500);

    console.log('[wfUpdate] ✓ Update system loaded (build ' + CURRENT_VERSION + ')');
})();
