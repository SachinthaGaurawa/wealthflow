/* wf-stmt-toolbar.js - the Print / Share / Close buttons of a shared loan statement page.
 *
 * A shared statement (/r/<id>, served by statement-view.js) is a stored HTML document. Its toolbar
 * used to carry inline onclick="..." attributes, which the page's Content-Security-Policy no longer
 * allows (script-src has no 'unsafe-inline'), and a stored document must never get that keyword
 * back: whatever is stored there is somebody's upload. So the buttons are wired from this one
 * same-origin file, which statement-view.js adds to the page, by the id each button carries.
 *
 * A button that already has a handler is left alone (the popup the app opens binds its own).
 */
(function () {
    'use strict';
    function on(id, fn) {
        var b = document.getElementById(id);
        if (b && !b.onclick) b.onclick = fn;
    }
    on('btnPrint', function () { window.print(); });
    on('btnClose', function () { try { window.close(); } catch (_) { /* a tab the user opened cannot be closed by script */ } });
    on('btnShare', function () {
        var url = String(window.location.href);
        if (navigator.share) { navigator.share({ title: document.title, url: url }).catch(function () {}); return; }
        if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).catch(function () {});
    });
})();
