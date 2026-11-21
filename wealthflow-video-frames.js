/* =============================================================================
 * wealthflow-video-frames.js — look at a screen recording the way a person would   (window.WFVideoFrames)
 * -----------------------------------------------------------------------------
 * WHY (owner, 2026-11-20): "when I upload a screen recording, look at it one after another, then frame by frame, understand it, think for yourself, and work out what the
 * problem is." A recording is hundreds of megabytes and ten minutes of nothing happening between two taps, so it cannot be sent as it is, and a model cannot read
 * all of it. What a person does is watch for WHEN SOMETHING CHANGES and then look hard at those moments. This file does the same on the device:
 *
 *   1. walk the video in small steps (at most ~120 looks), drawing each look as a tiny grey picture and measuring how much the screen changed since the last one;
 *   2. choose up to ten frames: the first, the last, the strongest changes, the moment each change has settled (the result of a tap) and, for the two biggest, the moment before;
 *   3. draw only those at reading quality (the server's vision models read them one by one, then reason over the sequence);
 *   4. keep a motion timeline (second, how much changed) so the analysis knows what happened when.
 *
 * The video itself is never uploaded: only those frames, the timeline and the length, and only when the person taps Send.
 *
 * Pure parts (sampleTimes, signatureDiff, changeSeries, pickFrames, motionTimeline) are exported for tests; extract() needs a browser.
 * ===========================================================================*/
(function (root) {
    'use strict';

    var MAX_SECONDS = 300;                       // a recording longer than five minutes is refused with a message, not cut silently
    var MAX_BYTES = 1500 * 1024 * 1024;
    var MAX_FRAMES = 10;
    var MAX_LOOKS = 120;
    var SIG = 32;                                // a look is drawn at 32 x 32 grey pixels
    var FRAME_SIDE = 1280;                       // the long side of a chosen frame
    var SEEK_TIMEOUT_MS = 6000;

    var VIDEO_EXT = /\.(mp4|m4v|mov|webm|3gp|3gpp|mkv|avi)$/i;

    /** Is this File-like a video? */
    function isVideo(f) {
        var type = String((f && f.type) || '').toLowerCase(), name = String((f && f.name) || '');
        return /^video\//.test(type) || VIDEO_EXT.test(name);
    }

    function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

    /**
     * The moments to look at: about one look per `step` seconds, where step is duration/60 kept between a quarter and a second and a half, never more than
     * MAX_LOOKS looks, always including the very beginning and the very end.
     */
    function sampleTimes(duration) {
        var d = Number(duration);
        if (!isFinite(d) || d <= 0) return [0];
        var step = clamp(d / 60, 0.25, 1.5);
        var n = Math.min(MAX_LOOKS, Math.max(2, Math.ceil(d / step) + 1));
        var last = Math.max(0, d - 0.05), out = [];
        for (var i = 0; i < n; i++) out.push(Math.round((last * i / (n - 1)) * 1000) / 1000);
        return out;
    }

    /** How much two grey pictures differ: 0 (identical) .. 1 (black against white). */
    function signatureDiff(a, b) {
        if (!a || !b || !a.length || a.length !== b.length) return 0;
        var sum = 0;
        for (var i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
        return sum / (a.length * 255);
    }

    /** change[i] = how much look i differs from look i-1 (change[0] = 0). */
    function changeSeries(samples) {
        var out = [0];
        for (var i = 1; i < samples.length; i++) out.push(signatureDiff(samples[i - 1].sig, samples[i].sig));
        return out;
    }

    function median(list) {
        var s = list.slice().sort(function (x, y) { return x - y; });
        return s.length ? s[Math.floor(s.length / 2)] : 0;
    }

    /**
     * Which looks become frames. Pure: no picture is needed, only the grey signatures (or ready-made `change` values) and their times.
     * @param {{t:number, sig?:number[], change?:number}[]} samples  in time order
     * @param {{max?:number}} [opts]
     * @returns {{ i:number, t:number, change:number, why:'first'|'last'|'change'|'settled'|'before'|'even' }[]}  in time order, at most `max`, always the first and the last
     */
    function pickFrames(samples, opts) {
        var max = clamp(Math.floor((opts && opts.max) || MAX_FRAMES), 2, 24);
        var n = (samples || []).length;
        if (!n) return [];
        var change = samples.every(function (s) { return typeof s.change === 'number'; }) ? samples.map(function (s) { return s.change; }) : changeSeries(samples);
        var duration = samples[n - 1].t - samples[0].t;
        var minGap = Math.max(0.3, duration / (max * 2.5));
        var chosen = {}, count = 0;
        function near(i) {
            for (var k in chosen) if (Math.abs(samples[+k].t - samples[i].t) < minGap) return true;
            return false;
        }
        function add(i, why, force) {
            if (i < 0 || i >= n || chosen[i] !== undefined || count >= max) return false;
            if (!force && near(i)) return false;
            chosen[i] = why; count++;
            return true;
        }
        add(0, 'first', true);
        if (n > 1) add(n - 1, 'last', true);
        // the strongest moments of change: a local maximum clearly above the usual restlessness of this recording
        var thr = Math.max(0.012, median(change) * 3);
        var peaks = [];
        for (var i = 1; i < n - 1; i++) {
            if (change[i] >= thr && change[i] >= change[i - 1] && change[i] >= change[i + 1]) peaks.push(i);
        }
        peaks.sort(function (a, b) { return change[b] - change[a]; });
        var events = 0;
        for (var p = 0; p < peaks.length && count < max; p++) {
            var at = peaks[p];
            if (near(at)) continue;                                       // the same event, or too close to one already taken
            // the screen right after the change has landed, then once it has stopped moving: that is what a person looks at to see the RESULT of a tap
            var settled = -1;
            for (var j = at + 1; j < Math.min(n, at + 5); j++) { if (change[j] < change[at] * 0.35) { settled = j; break; } }
            add(at, 'change', true);
            if (settled > at) add(settled, 'settled', true);
            // and, for the two strongest events, the screen just BEFORE it: what the person tapped on
            if (events < 2 && at - 1 >= 0) add(at - 1, 'before', true);
            events++;
        }
        // a recording where nothing much changes is still shown at a few even moments
        var want = Math.min(max, 6, n);
        for (var s = 1; count < want && s < 40; s++) {
            var idx = Math.round((n - 1) * s / Math.max(1, want));
            add(idx, 'even');
        }
        var out = [];
        Object.keys(chosen).forEach(function (k) { var i2 = +k; out.push({ i: i2, t: samples[i2].t, change: Math.round(change[i2] * 1000) / 1000, why: chosen[k] }); });
        out.sort(function (x, y) { return x.t - y.t; });
        return out;
    }

    /** [second, change] pairs, at most `max` of them (the strongest moments are kept when there are more looks than that). */
    function motionTimeline(samples, max) {
        max = Math.max(4, max || 60);
        var change = samples.every(function (s) { return typeof s.change === 'number'; }) ? samples.map(function (s) { return s.change; }) : changeSeries(samples);
        var rows = samples.map(function (s, i) { return [Math.round(s.t * 10) / 10, Math.round(change[i] * 1000) / 1000]; });
        if (rows.length <= max) return rows;
        var keep = {};
        keep[0] = keep[rows.length - 1] = true;
        rows.map(function (r, i) { return i; }).sort(function (a, b) { return rows[b][1] - rows[a][1]; }).slice(0, max - 2).forEach(function (i) { keep[i] = true; });
        return rows.filter(function (r, i) { return keep[i]; });
    }

    // ── the browser part ────────────────────────────────────────────────────────────────────────────────────────────

    function openVideo(file) {
        return new Promise(function (resolve, reject) {
            var url = root.URL.createObjectURL(file);
            var v = document.createElement('video');
            v.muted = true; v.playsInline = true; v.preload = 'auto'; v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
            v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none;';
            var done = false;
            var timer = setTimeout(function () { fin(new Error('the recording did not open in time')); }, 20000);
            function fin(err) {
                if (done) return; done = true; clearTimeout(timer);
                v.onloadeddata = v.onerror = null;
                if (err) { try { root.URL.revokeObjectURL(url); } catch (_) { /* nothing to free */ } try { v.remove(); } catch (_) { /* detached */ } reject(err); }
                else resolve({ video: v, url: url });
            }
            v.onloadeddata = function () { fin(null); };
            v.onerror = function () { fin(new Error('this recording cannot be opened by the browser (its video format is not supported here)')); };
            document.body.appendChild(v);
            v.src = url;
        });
    }

    /** A recording made by a browser (webm) can open with no length. Seeking far past the end makes the browser work it out. */
    function learnDuration(v) {
        if (isFinite(v.duration) && v.duration > 0) return Promise.resolve();
        return new Promise(function (resolve) {
            var done = false;
            function fin() { if (done) return; done = true; clearTimeout(timer); v.removeEventListener('durationchange', onChange); v.removeEventListener('seeked', fin); resolve(); }
            function onChange() { if (isFinite(v.duration) && v.duration > 0) fin(); }
            var timer = setTimeout(fin, 6000);
            v.addEventListener('durationchange', onChange); v.addEventListener('seeked', fin);
            try { v.currentTime = 1e101; } catch (_) { fin(); }
        }).then(function () { try { v.currentTime = 0; } catch (_) { /* nothing to rewind */ } });
    }

    function seek(v, t) {
        return new Promise(function (resolve) {
            var done = false;
            function fin() { if (done) return; done = true; clearTimeout(timer); v.removeEventListener('seeked', fin); resolve(); }
            var timer = setTimeout(fin, SEEK_TIMEOUT_MS);
            v.addEventListener('seeked', fin);
            try { v.currentTime = Math.min(Math.max(0, t), Math.max(0, (v.duration || t) - 0.01)); } catch (_) { fin(); }
        });
    }

    function grey(canvas) {
        var d = canvas.getContext('2d').getImageData(0, 0, SIG, SIG).data, out = new Array(SIG * SIG);
        for (var i = 0; i < SIG * SIG; i++) out[i] = Math.round(d[i * 4] * 0.299 + d[i * 4 + 1] * 0.587 + d[i * 4 + 2] * 0.114);
        return out;
    }

    /**
     * Walk a recording and return the frames worth reading. Never rejects: a recording that cannot be used says why in `reason`.
     * @param {File|Blob} file
     * @param {{ onProgress?:(done:number,total:number)=>void, max?:number }} [opts]
     * @returns {Promise<{ ok:boolean, reason?:string, duration:number, width:number, height:number, frames:{t:number, change:number, why:string, canvas:HTMLCanvasElement}[], motion:number[][] }>}
     */
    function extract(file, opts) {
        opts = opts || {};
        var fail = function (reason, extra) { return Object.assign({ ok: false, reason: reason, duration: 0, width: 0, height: 0, frames: [], motion: [] }, extra || {}); };
        if (file && file.size > MAX_BYTES) return Promise.resolve(fail('the recording is over 1.5 GB'));
        var opened = null;
        return openVideo(file).then(function (o) { opened = o; return learnDuration(o.video).then(function () { return o; }); }).then(function (o) {
            var v = o.video, duration = v.duration;
            if (!isFinite(duration) || duration < 0.3) return fail('the recording has no length the browser can read');
            if (duration > MAX_SECONDS) return fail('the recording is longer than ' + Math.round(MAX_SECONDS / 60) + ' minutes (' + Math.round(duration) + ' s)', { duration: duration });
            var w = v.videoWidth || 0, h = v.videoHeight || 0;
            if (!w || !h) return fail('the recording has no picture the browser can read');
            var times = sampleTimes(duration), total = times.length + (opts.max || MAX_FRAMES);
            var sigCanvas = document.createElement('canvas'); sigCanvas.width = sigCanvas.height = SIG;
            var sx = sigCanvas.getContext('2d'), samples = [], idx = 0;
            function look() {
                if (idx >= times.length) return Promise.resolve();
                var t = times[idx];
                return seek(v, t).then(function () {
                    sx.drawImage(v, 0, 0, SIG, SIG);
                    samples.push({ t: t, sig: grey(sigCanvas) });
                    idx++;
                    if (opts.onProgress) { try { opts.onProgress(idx, total); } catch (_) { /* a callback must not stop the walk */ } }
                    return look();
                });
            }
            return look().then(function () {
                var picks = pickFrames(samples, { max: opts.max || MAX_FRAMES });
                var motion = motionTimeline(samples);
                var k = Math.min(1, FRAME_SIDE / Math.max(w, h)), cw = Math.max(1, Math.round(w * k)), ch = Math.max(1, Math.round(h * k));
                var frames = [], at = 0;
                function draw() {
                    if (at >= picks.length) return Promise.resolve();
                    var p = picks[at];
                    return seek(v, p.t).then(function () {
                        var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
                        var cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cw, ch); cx.drawImage(v, 0, 0, cw, ch);
                        frames.push({ t: p.t, change: p.change, why: p.why, canvas: cv });
                        at++;
                        if (opts.onProgress) { try { opts.onProgress(times.length + at, total); } catch (_) { /* ignore */ } }
                        return draw();
                    });
                }
                return draw().then(function () { return { ok: frames.length > 0, reason: frames.length ? '' : 'no frame could be drawn', duration: duration, width: w, height: h, frames: frames, motion: motion }; });
            });
        }).catch(function (e) {
            return fail(String((e && e.message) || e).slice(0, 160));
        }).then(function (r) {
            if (opened) { try { root.URL.revokeObjectURL(opened.url); } catch (_) { /* nothing to free */ } try { opened.video.removeAttribute('src'); opened.video.load(); opened.video.remove(); } catch (_) { /* detached */ } }
            return r;
        });
    }

    /** A small contact sheet (up to six frames in a row) for the chip in the sheet. It stays on the device. */
    function contactSheet(frames) {
        try {
            var list = (frames || []).slice(0, 6);
            if (!list.length) return '';
            var th = 72, tw = Math.round(th * (list[0].canvas.width / list[0].canvas.height));
            var cv = document.createElement('canvas'); cv.width = tw * list.length; cv.height = th;
            var cx = cv.getContext('2d');
            list.forEach(function (f, i) { cx.drawImage(f.canvas, i * tw, 0, tw, th); });
            return cv.toDataURL('image/jpeg', 0.6);
        } catch (_) { return ''; }
    }

    root.WFVideoFrames = {
        MAX_SECONDS: MAX_SECONDS, MAX_BYTES: MAX_BYTES, MAX_FRAMES: MAX_FRAMES,
        isVideo: isVideo, sampleTimes: sampleTimes, signatureDiff: signatureDiff, changeSeries: changeSeries, pickFrames: pickFrames, motionTimeline: motionTimeline,
        extract: extract, contactSheet: contactSheet,
    };
})(typeof window !== 'undefined' ? window : globalThis);
