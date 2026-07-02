/*  wealthflow-icons.js — professional inline-SVG icon system (no emojis)  v2
 *
 *  Renders REAL inline <svg> (not CSS masks, not <img>) so icons are reliable on
 *  iOS/Safari/PWA, inherit text color via stroke="currentColor", and need no
 *  network. Two ways to use:
 *    1) Markup written before this script runs:  <i data-wfi="edit"></i>
 *       → hydrated into an <svg> automatically (also re-hydrated after renders).
 *    2) From JS:  WFIcon('edit')  → an inline <svg> string (safe in templates).
 *  For places that take textContent only, use WFIconNode('edit') → DOM node.
 */
(function () {
    'use strict';
    var P = {
        dashboard:'<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>',
        calendar:'<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
        wallet:'<path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>',
        bank:'<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
        card:'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/>',
        clock:'<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
        receipt:'<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z"/><line x1="8" y1="7" x2="16" y2="7"/><line x1="8" y1="11" x2="16" y2="11"/><line x1="8" y1="15" x2="13" y2="15"/>',
        cheque:'<rect x="2" y="5" width="20" height="14" rx="2"/><line x1="6" y1="10" x2="13" y2="10"/><line x1="6" y1="14" x2="10" y2="14"/>',
        target:'<circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/>',
        ruler:'<path d="M21.3 8.7 15.3 2.7a1 1 0 0 0-1.4 0l-11.2 11.2a1 1 0 0 0 0 1.4l6 6a1 1 0 0 0 1.4 0l11.2-11.2a1 1 0 0 0 0-1.4Z"/><path d="m7.5 10.5 2 2"/><path d="m10.5 7.5 2 2"/><path d="m13.5 4.5 2 2"/>',
        trophy:'<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
        fileText:'<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"/><path d="M14 2v6h6"/><path d="M16 13H8"/><path d="M16 17H8"/><path d="M10 9H8"/>',
        history:'<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
        bell:'<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
        bomb:'<circle cx="11" cy="13" r="8"/><path d="M14.35 4.65 16.3 2.7a2.41 2.41 0 0 1 3.4 0l1.6 1.6a2.4 2.4 0 0 1 0 3.4l-1.95 1.95"/><line x1="15" y1="9" x2="18" y2="6"/>',
        crystal:'<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
        globe:'<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>',
        devices:'<rect x="2" y="4" width="13" height="10" rx="2"/><path d="M6 18h4"/><rect x="16" y="8" width="6" height="12" rx="2"/>',
        settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z"/>',
        bot:'<rect x="4" y="8" width="16" height="12" rx="2"/><path d="M12 8V4"/><circle cx="12" cy="3" r="1"/><line x1="9" y1="13" x2="9" y2="15"/><line x1="15" y1="13" x2="15" y2="15"/>',
        trendUp:'<polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/>',
        coins:'<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
        chartLine:'<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m7 14 4-4 4 4 5-6"/>',
        check:'<polyline points="20 6 9 17 4 12"/>',
        checkCircle:'<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/>',
        edit:'<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>',
        trash:'<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" y1="11" x2="10" y2="17"/><line x1="14" y1="11" x2="14" y2="17"/>',
        plus:'<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
        x:'<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
        upload:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>',
        scan:'<path d="M3 7V5a2 2 0 0 1 2-2h2"/><path d="M17 3h2a2 2 0 0 1 2 2v2"/><path d="M21 17v2a2 2 0 0 1-2 2h-2"/><path d="M7 21H5a2 2 0 0 1-2-2v-2"/><line x1="7" y1="12" x2="17" y2="12"/>',
        lock:'<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
        gift:'<rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13"/><path d="M19 12v7a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/>',
        gem:'<path d="M6 3h12l4 6-10 13L2 9Z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/>',
        moon:'<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>',
        sun:'<circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.2" y1="4.2" x2="5.6" y2="5.6"/><line x1="18.4" y1="18.4" x2="19.8" y2="19.8"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.2" y1="19.8" x2="5.6" y2="18.4"/><line x1="18.4" y1="5.6" x2="19.8" y2="4.2"/>',
        sparkles:'<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z"/>',
        send:'<line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9"/>',
        menu:'<line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/>',
        thumbsUp:'<path d="M7 10v12"/><path d="M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88Z"/>',
        thumbsDown:'<path d="M17 14V2"/><path d="M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88Z"/>',
        eye:'<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
        download:'<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
        refresh:'<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
        alert:'<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
        info:'<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
        undo:'<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H9"/>',
        cloud:'<path d="M17.5 19H7A5 5 0 0 1 7 9a6 6 0 0 1 11.3 1.7A4.5 4.5 0 0 1 17.5 19Z"/>',
        cloudDownload:'<path d="M12 13v8"/><path d="m8 17 4 4 4-4"/><path d="M20.5 15.5A5 5 0 0 0 18 6.5a6 6 0 0 0-11.3 1.7A4.5 4.5 0 0 0 6 17"/>'
    };
    function svg(name, attrs) {
        var d = P[name]; if (!d) return '';
        return '<svg class="wfi wfi-' + name + '" width="1em" height="1em" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"' + (attrs || '') + '>' + d + '</svg>';
    }
    function WFIcon(name) { return svg(name); }
    WFIcon.has = function (n) { return !!P[n]; };
    WFIcon.svg = svg;
    function WFIconNode(name) {
        var wrap = document.createElement('span');
        wrap.className = 'wfi-host';
        wrap.innerHTML = svg(name) || '';
        return wrap.firstChild;
    }
    // Hydrate <i data-wfi="name"> placeholders into real SVGs.
    function hydrate(root) {
        try {
            (root || document).querySelectorAll('i[data-wfi]:not([data-wfi-done])').forEach(function (el) {
                var n = el.getAttribute('data-wfi');
                if (P[n]) { el.innerHTML = svg(n); el.setAttribute('data-wfi-done', '1'); el.style.display = 'inline-flex'; el.style.alignItems = 'center'; }
            });
        } catch (_) {}
    }
    // base sizing CSS (kept tiny; SVG inherits font-size via 1em)
    try {
        var st = document.createElement('style'); st.id = 'wfIconStyles';
        st.textContent = '.wfi{display:inline-block;vertical-align:-0.14em;flex-shrink:0}.nav-icon .wfi{font-size:17px;vertical-align:-3px}.ib .wfi{font-size:14px}.ib.c .wfi{color:var(--green,#10b981)}.ib.e .wfi{color:var(--accent,#d4af37)}.ib.d .wfi{color:var(--red,#ef4444)}i[data-wfi]{display:inline-flex;align-items:center;line-height:0}';
        (document.head || document.documentElement).appendChild(st);
    } catch (_) {}
    window.WFIcon = WFIcon;
    window.WFIconNode = WFIconNode;
    window.WFIconHydrate = hydrate;
    // hydrate now (in case markup already parsed) + after DOM ready + on a light interval
    function boot() { hydrate(document); }
    if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
    // observe DOM additions so dynamically-rendered <i data-wfi> get hydrated
    try {
        var mo = new MutationObserver(function (muts) {
            for (var i = 0; i < muts.length; i++) { if (muts[i].addedNodes && muts[i].addedNodes.length) { hydrate(document); break; } }
        });
        if (document.body) mo.observe(document.body, { childList: true, subtree: true });
        else document.addEventListener('DOMContentLoaded', function () { mo.observe(document.body, { childList: true, subtree: true }); });
    } catch (_) {}
})();

/*  Auto-replace known emoji glyphs in rendered UI text with inline SVG icons.
 *  Pure typography (→ ✓ ↑ ↓ • …) is intentionally kept. Runs after renders via
 *  the same MutationObserver. Skips inputs, textareas, [contenteditable], <script>,
 *  <style>, and any element marked data-noicon. */
(function () {
    'use strict';
    if (!window.WFIcon) return;
    var MAP = {
        '📊':'chartLine','📈':'trendUp','📉':'chartLine','🧾':'receipt','📋':'receipt','🗑️':'trash','🗑':'trash',
        '✅':'checkCircle','☑️':'checkCircle','❌':'x','✖️':'x','✕':'x','⚠️':'alert','⚠':'alert','ℹ️':'info',
        '🎯':'target','💡':'sparkles','🧠':'bot','🤖':'bot','💰':'wallet','🏦':'bank','🔄':'refresh','📅':'calendar',
        '🎉':'sparkles','✨':'sparkles','⏰':'clock','⏳':'clock','☁️':'globe','☁':'globe','⚡':'sparkles','🌐':'globe',
        '📄':'cheque','🛡️':'lock','🛡':'lock','💳':'card','🔐':'lock','🔒':'lock','🔓':'lock','🔔':'bell','📱':'devices',
        '💾':'download','💬':'info','📁':'receipt','👤':'bot','📸':'scan','📥':'download','📤':'upload','🔊':'bell',
        '🔗':'globe','📐':'ruler','🏆':'trophy','💣':'bomb','🔮':'crystal','⚙️':'settings','⛽':'coins','💸':'coins',
        '👍':'thumbsUp','👎':'thumbsDown','👁️':'eye','👁':'eye','💎':'gem','🎁':'gift','⬇️':'download','⬆️':'upload',
        '📦':'receipt','💵':'wallet','💴':'wallet','💶':'wallet','💷':'wallet','🟢':'checkCircle','🔴':'alert','🟡':'alert',
        '↩️':'undo','↩':'undo','🏛️':'bank','🏛':'bank','📜':'fileText','📷':'scan'
    };
    // Build one regex of all emoji keys (longest first to match VS16 variants)
    var keys = Object.keys(MAP).sort(function (a, b) { return b.length - a.length; });
    var rx = new RegExp('(' + keys.map(function (k) { return k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }).join('|') + ')', 'g');
    var SKIP = { SCRIPT:1, STYLE:1, TEXTAREA:1, INPUT:1, SVG:1, NOSCRIPT:1, OPTION:1, SELECT:1 };

    function replaceIn(root) {
        try {
            root = root || document.body; if (!root) return;
            var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
                acceptNode: function (n) {
                    if (!n.nodeValue || !rx.test(n.nodeValue)) return NodeFilter.FILTER_REJECT;
                    var p = n.parentNode;
                    while (p && p.nodeType === 1) {
                        if (SKIP[p.tagName]) return NodeFilter.FILTER_REJECT;
                        if (p.isContentEditable) return NodeFilter.FILTER_REJECT;
                        if (p.hasAttribute && p.hasAttribute('data-noicon')) return NodeFilter.FILTER_REJECT;
                        p = p.parentNode;
                    }
                    return NodeFilter.FILTER_ACCEPT;
                }
            });
            var hits = [], node;
            while ((node = walker.nextNode())) hits.push(node);
            hits.forEach(function (textNode) {
                var val = textNode.nodeValue; rx.lastIndex = 0;
                if (!rx.test(val)) return;
                var frag = document.createDocumentFragment();
                var last = 0, m; rx.lastIndex = 0;
                while ((m = rx.exec(val))) {
                    if (m.index > last) frag.appendChild(document.createTextNode(val.slice(last, m.index)));
                    var key = MAP[m[1]];
                    var node2 = key && window.WFIconNode ? window.WFIconNode(key) : null;
                    if (node2) { node2.style.verticalAlign = '-0.14em'; frag.appendChild(node2); }
                    else frag.appendChild(document.createTextNode(m[1]));
                    last = m.index + m[1].length;
                }
                if (last < val.length) frag.appendChild(document.createTextNode(val.slice(last)));
                if (textNode.parentNode) textNode.parentNode.replaceChild(frag, textNode);
            });
        } catch (_) {}
    }
    window.WFIconStripEmoji = replaceIn;
    var _t = null;
    function schedule() { if (_t) return; _t = setTimeout(function () { _t = null; replaceIn(document.body); }, 120); }
    if (document.readyState !== 'loading') schedule(); else document.addEventListener('DOMContentLoaded', schedule);
    try {
        var mo = new MutationObserver(function (m) { for (var i = 0; i < m.length; i++) { if (m[i].addedNodes && m[i].addedNodes.length) { schedule(); break; } } });
        function arm() { if (document.body) mo.observe(document.body, { childList: true, subtree: true }); }
        if (document.body) arm(); else document.addEventListener('DOMContentLoaded', arm);
    } catch (_) {}
})();
