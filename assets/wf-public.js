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
    fab.addEventListener('click', function () {
        try { win.scrollTo({ top: 0, behavior: reduced() ? 'auto' : 'smooth' }); } catch (_) { win.scrollTo(0, 0); }
        var main = d.getElementById('main');
        if (main) { main.setAttribute('tabindex', '-1'); try { main.focus({ preventScroll: true }); } catch (_) { /* focus is a courtesy */ } }
    });
    d.body.appendChild(fab);
    if (hasIO) watch(marker(560), function (e) { fab.classList.toggle('is-on', !e.isIntersecting && e.boundingClientRect.top < 0); });
    else fab.classList.add('is-on');

    if (!root.classList.contains('wfp-home')) return;

    /* Home: sections come in as they reach the screen, one after another within a group. */
    var targets = d.querySelectorAll('.sec-head, .card, .steps li, .notice, .cta-band .panel');
    var count = new Map();
    Array.prototype.forEach.call(targets, function (el) {
        var n = count.get(el.parentNode) || 0;
        count.set(el.parentNode, n + 1);
        el.style.setProperty('--i', Math.min(n, 5));
    });
    if (hasIO && !reduced()) {
        var io = new IntersectionObserver(function (list) {
            list.forEach(function (e) {
                if (!e.isIntersecting) return;
                e.target.classList.add('in');
                io.unobserve(e.target);
            });
        }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });
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
