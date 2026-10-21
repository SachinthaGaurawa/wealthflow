/* wf-public.js - behaviour for the public pages (/, /privacy and /terms).
 *
 * Small on purpose: it has no libraries, makes no network request, reads no
 * account data, and never listens to the scroll event. Where the page needs to
 * know "has the reader moved" it watches a 1 px marker with IntersectionObserver,
 * which the browser reports once, when the marker crosses the edge of the screen.
 * The look of everything below lives in wf-public.css.
 */
(function () {
    'use strict';
    var d = document, root = d.documentElement, win = window;
    var hasIO = 'IntersectionObserver' in win;
    /* Reloading starts the page again from the top. Browsers put a reloaded page back where it was, which
       on a long page feels like the reload did nothing; a link to a section (#features) would also bring
       the reader straight back to it. Only a reload is treated this way: Back and Forward keep their place. */
    (function startAtTop() {
        try {
            var nav = win.performance && win.performance.getEntriesByType && win.performance.getEntriesByType('navigation')[0];
            var reload = nav ? nav.type === 'reload' : !!(win.performance && win.performance.navigation && win.performance.navigation.type === 1);
            if (!reload) return;
            var h = win.history;
            if ('scrollRestoration' in h) h.scrollRestoration = 'manual';
            if (win.location.hash) h.replaceState(null, '', win.location.pathname + win.location.search);
            root.style.scrollBehavior = 'auto';
            win.scrollTo(0, 0);
            /* The browser puts the old position back some time after load, so the page stays "manual" until
               it is left (then Back and Forward get their normal behaviour again). */
            win.addEventListener('load', function () { win.scrollTo(0, 0); root.style.scrollBehavior = ''; }, { once: true });
            win.addEventListener('pagehide', function () { if ('scrollRestoration' in h) h.scrollRestoration = 'auto'; }, { once: true });
        } catch (_) { /* the page simply opens where the browser puts it */ }
    })();

    function reduced() { try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (_) { return false; } }

    /* A 1 px marker at a fixed distance from the top of the page. */
    function marker(top) {
        var m = d.createElement('div');
        m.setAttribute('aria-hidden', 'true');
        m.style.cssText = 'position:absolute;left:0;top:' + top + 'px;width:1px;height:1px;opacity:0;pointer-events:none';
        d.body.appendChild(m);
        return m;
    }
    function watch(el, fn) {
        if (!hasIO) return;
        new IntersectionObserver(function (list) { fn(list[list.length - 1]); }).observe(el);
    }

    /* Header: settles (a shadow) once the page has moved. */
    var header = d.querySelector('header.top');
    if (header) watch(marker(8), function (e) { header.classList.toggle('is-stuck', !e.isIntersecting); });

    /* Back to top: appears after the first screen and is smooth to use. */
    var fab = d.createElement('button');
    fab.type = 'button';
    fab.className = 'wfp-top';
    fab.setAttribute('aria-label', 'Back to top');
    fab.setAttribute('title', 'Back to top');
    var NS = 'http://www.w3.org/2000/svg';
    var ring = d.createElementNS(NS, 'svg');
    ring.setAttribute('viewBox', '0 0 48 48');
    ring.setAttribute('aria-hidden', 'true');
    ring.setAttribute('focusable', 'false');
    ['wfp-ring-bg', 'wfp-ring'].forEach(function (cls) {
        var c = d.createElementNS(NS, 'circle');
        c.setAttribute('class', cls);
        c.setAttribute('cx', '24'); c.setAttribute('cy', '24'); c.setAttribute('r', '21');
        if (cls === 'wfp-ring') c.setAttribute('pathLength', '1');
        ring.appendChild(c);
    });
    var chev = d.createElement('span');
    chev.className = 'wfp-chev';
    chev.setAttribute('aria-hidden', 'true');
    fab.appendChild(ring);
    fab.appendChild(chev);
    /* The browser's own smooth scroll speeds up as the page gets longer. The glide to the top is drawn
       here instead: one gentle ease in and out whose length grows slowly with the distance, so the
       first and last moments are slow and the middle never becomes a rush. Any wheel, touch, key or
       mouse press hands the page straight back to the reader. */
    var gliding = false, glideFrame = 0, STOP = ['wheel', 'touchstart', 'keydown', 'mousedown'];
    function jump(y) {
        try { win.scrollTo({ top: y, behavior: 'instant' }); } catch (_) { win.scrollTo(0, y); }
    }
    function stopGlide() {
        if (!gliding) return;
        gliding = false;
        if (glideFrame) win.cancelAnimationFrame(glideFrame);
        glideFrame = 0;
        root.classList.remove('wfp-glide');
        STOP.forEach(function (t) { win.removeEventListener(t, stopGlide); });
    }
    function toTop() {
        var from = win.pageYOffset || root.scrollTop || 0;
        stopGlide();
        if (from <= 0) return;
        if (reduced() || !win.requestAnimationFrame) { jump(0); return; }
        var dur = Math.min(2200, 900 + from * 0.2), t0 = 0;
        gliding = true;
        root.classList.add('wfp-glide');
        STOP.forEach(function (t) { win.addEventListener(t, stopGlide, { passive: true }); });
        function step(now) {
            glideFrame = 0;
            if (!gliding) return;
            if (!t0) t0 = now;
            var p = Math.min(1, (now - t0) / dur);
            jump(from * (1 - (0.5 - 0.5 * Math.cos(Math.PI * p))));
            if (p < 1) glideFrame = win.requestAnimationFrame(step); else stopGlide();
        }
        glideFrame = win.requestAnimationFrame(step);
    }
    fab.addEventListener('click', function () {
        toTop();
        var main = d.getElementById('main');
        if (main) { main.setAttribute('tabindex', '-1'); try { main.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ } }
    });
    d.body.appendChild(fab);
    if (hasIO) watch(marker(560), function (e) { fab.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.top < 0); });
    else fab.classList.add('is-on');

    if (!root.classList.contains('wfp-home')) return;

    /* Home: sections come in as they reach the screen, one after another within a group. */
    var targets = d.querySelectorAll('.sec-head, .card, .steps li, .notice, .cta-band .panel');
    if (hasIO && !reduced()) {
        /* Reveal a little before a block reaches the screen (so the rise is under way, not starting, when it
           is seen), and give blocks that arrive together a gentle one-after-another order: top to bottom,
           left to right, at most four steps. Blocks already scrolled past just appear. */
        var io = new IntersectionObserver(function (list) {
            var batch = list.filter(function (e) { return e.isIntersecting || e.boundingClientRect.bottom < 0; });
            batch.sort(function (a, b) {
                var ra = Math.round(a.boundingClientRect.top / 40), rb = Math.round(b.boundingClientRect.top / 40);
                return ra - rb || a.boundingClientRect.left - b.boundingClientRect.left;
            });
            batch.forEach(function (e, i) {
                var el = e.target;
                if (e.boundingClientRect.bottom < 0) el.classList.add('in-now');
                el.style.setProperty('--i', Math.min(i, 4));
                el.classList.add('in');
                io.unobserve(el);
            });
        }, { rootMargin: '0px 0px 8% 0px', threshold: 0 });
        Array.prototype.forEach.call(targets, function (el) { io.observe(el); });
    } else {
        Array.prototype.forEach.call(targets, function (el) { el.classList.add('in'); });
    }

    /* Home: a soft light follows the mouse inside a card (the position is a CSS variable). */
    var frame = 0, card = null, px = 0, py = 0;
    d.addEventListener('pointermove', function (e) {
        if (e.pointerType !== 'mouse' || !e.target.closest) return;
        var c = e.target.closest('.card');
        if (!c) return;
        card = c; px = e.clientX; py = e.clientY;
        if (frame) return;
        frame = win.requestAnimationFrame(function () {
            frame = 0;
            var r = card.getBoundingClientRect();
            card.style.setProperty('--mx', (px - r.left) + 'px');
            card.style.setProperty('--my', (py - r.top) + 'px');
        });
    }, { passive: true });

    /* Home: the menu marks the section you are reading. */
    var links = {};
    Array.prototype.forEach.call(d.querySelectorAll('nav.main a.link[href^="#"]'), function (a) { links[a.getAttribute('href').slice(1)] = a; });
    if (hasIO) {
        var spy = new IntersectionObserver(function (list) {
            list.forEach(function (e) {
                var a = links[e.target.id];
                if (!a) return;
                if (e.isIntersecting) a.setAttribute('aria-current', 'location'); else a.removeAttribute('aria-current');
            });
        }, { rootMargin: '-45% 0px -50% 0px' });
        Object.keys(links).forEach(function (id) { var s = d.getElementById(id); if (s) spy.observe(s); });
    }
})();
