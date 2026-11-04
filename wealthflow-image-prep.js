/* =============================================================================
 * wealthflow-image-prep.js — get ANY screenshot ready for the AI to read   (window.WFImagePrep)
 * -----------------------------------------------------------------------------
 * WHY (owner, 2026-11-04): a feedback screenshot of any size must be understood by the AI. The old
 * path made ONE 900px thumbnail small enough for a GitHub issue body (about 32 KB). That is a
 * postage stamp: small text and thin overlaps vanish, and a tall full-page capture is unreadable.
 *
 * WHAT IT MAKES from whatever the person picked (a 40 KB crop or a 25 MB retina capture):
 *   thumb   one picture that fits an issue body (<= 43,500 characters), as before;
 *   reading up to 3 pictures at reading quality (long side <= 1568 px, each <= ~1,000,000 characters).
 *           A tall or wide capture is cut into overlapping parts so the text stays legible instead of
 *           being shrunk until it cannot be read. The server reads these when the report is filed
 *           (feedback-triage.js) and writes what they show into the issue.
 *
 * Everything happens in the browser; nothing is uploaded until the person taps Send. planTiles and
 * the quality ladders are pure so they can be tested without a canvas.
 * ===========================================================================*/
(function (root) {
    'use strict';

    var THUMB_CAP = 43500;            // characters of data URL that fit the issue body next to the report
    var READ_SIDE = 1568;             // the long side a vision model reads well
    var READ_CAP = 1000000;           // characters per reading picture (the server accepts up to 1,100,000)
    var MAX_TILES = 3;
    var THUMB_LADDER = [[900, 0.7], [900, 0.5], [900, 0.38], [720, 0.45], [560, 0.42], [440, 0.4], [360, 0.35]];
    var READ_QUALITIES = [0.85, 0.74, 0.62, 0.5, 0.4];

    /**
     * How to cut a w x h picture for reading. A picture that is not extreme is one tile. A tall one
     * (height over 2.6 x width, so an ordinary phone screenshot stays whole) or a wide one (width over 3 x height) is cut along its long side into
     * up to MAX_TILES parts that overlap by 8%, so a line of text cut at an edge is whole in a neighbour.
     * @returns {{ sx:number, sy:number, sw:number, sh:number }[]}
     */
    function planTiles(w, h) {
        w = Math.max(1, Math.floor(w)); h = Math.max(1, Math.floor(h));
        var tall = h > 2.6 * w, wide = w > 3 * h;
        if (!tall && !wide) return [{ sx: 0, sy: 0, sw: w, sh: h }];
        var long = tall ? h : w, short = tall ? w : h;
        // aim for parts about 1.5 x as long as they are wide, never more than MAX_TILES
        var n = Math.min(MAX_TILES, Math.max(2, Math.ceil(long / (short * 1.5))));
        var overlap = Math.round(long * 0.08 / n);
        var step = long / n, out = [];
        for (var i = 0; i < n; i++) {
            var from = Math.max(0, Math.round(i * step) - (i ? overlap : 0));
            var to = Math.min(long, Math.round((i + 1) * step) + (i < n - 1 ? overlap : 0));
            out.push(tall ? { sx: 0, sy: from, sw: w, sh: to - from } : { sx: from, sy: 0, sw: to - from, sh: h });
        }
        return out;
    }

    /** Longest side after scaling `sw x sh` so its long side is `side`. Never scales up. */
    function scaledSize(sw, sh, side) {
        var k = Math.min(1, side / Math.max(sw, sh));
        return { w: Math.max(1, Math.round(sw * k)), h: Math.max(1, Math.round(sh * k)) };
    }

    function drawTo(canvas, src, rect, side) {
        var d = scaledSize(rect.sw, rect.sh, side);
        canvas.width = d.w; canvas.height = d.h;
        var cx = canvas.getContext('2d');
        cx.fillStyle = '#fff'; cx.fillRect(0, 0, d.w, d.h);   // JPEG has no alpha: transparent areas must not turn black
        cx.drawImage(src, rect.sx, rect.sy, rect.sw, rect.sh, 0, 0, d.w, d.h);
    }

    /** One rendition: shrink quality, then size, until the data URL is within `cap`. */
    function render(src, rect, rungs, cap) {
        var cv = document.createElement('canvas'), best = '';
        for (var i = 0; i < rungs.length; i++) {
            drawTo(cv, src, rect, rungs[i][0]);
            best = cv.toDataURL('image/jpeg', rungs[i][1]);
            if (best.length <= cap) break;
        }
        cv.width = cv.height = 0;
        return best.length <= cap ? best : '';
    }

    function readingRungs() {
        var out = [], sides = [READ_SIDE, 1280, 1024, 800];
        for (var s = 0; s < sides.length; s++) for (var q = 0; q < READ_QUALITIES.length; q++) out.push([sides[s], READ_QUALITIES[q]]);
        return out;
    }

    /** Decode a File of any size; falls back to a reduced decode when the full one is refused (very large captures). */
    function decode(file) {
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(file).catch(function () { return createImageBitmap(file, { resizeWidth: 2600, resizeQuality: 'high' }); });
        }
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(file), img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('unreadable image')); };
            img.src = url;
        });
    }

    /**
     * @param {File|Blob} file anything the browser can decode, of any size
     * @returns {Promise<{ ok:boolean, thumb:string, reading:string[], width:number, height:number, tiles:number, reason?:string }>}
     */
    function prepare(file) {
        return decode(file).then(function (bmp) {
            var w = bmp.width, h = bmp.height;
            var thumb = render(bmp, { sx: 0, sy: 0, sw: w, sh: h }, THUMB_LADDER, THUMB_CAP);
            var rungs = readingRungs(), reading = [];
            planTiles(w, h).forEach(function (rect) {
                var one = render(bmp, rect, rungs, READ_CAP);
                if (one) reading.push(one);
            });
            if (bmp.close) { try { bmp.close(); } catch (_) { /* nothing to free */ } }
            return { ok: !!(thumb || reading.length), thumb: thumb, reading: reading, width: w, height: h, tiles: reading.length };
        }).catch(function (e) {
            return { ok: false, thumb: '', reading: [], width: 0, height: 0, tiles: 0, reason: String((e && e.message) || e).slice(0, 120) };
        });
    }

    root.WFImagePrep = { prepare: prepare, planTiles: planTiles, scaledSize: scaledSize, THUMB_CAP: THUMB_CAP, READ_CAP: READ_CAP, READ_SIDE: READ_SIDE, MAX_TILES: MAX_TILES };
})(typeof window !== 'undefined' ? window : globalThis);
