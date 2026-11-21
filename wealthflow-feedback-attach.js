/* =============================================================================
 * wealthflow-feedback-attach.js — up to five screenshots and documents on one report   (window.WFFeedbackAttach)
 * -----------------------------------------------------------------------------
 * WHY (owner, 2026-11-13): "Send feedback" took ONE picture. A bug is often shown by several screens, or by a screenshot plus
 * the statement or log it came from. The person can now pick up to five files, in one go or one at a time:
 *   - pictures of any size      -> wealthflow-image-prep.js (an issue-sized thumbnail + reading-quality parts), as before
 *   - PDF documents             -> the first pages are drawn with the app's own PDF.js and read as pictures
 *   - text files (.txt .csv .tsv .json .log .md) -> the first characters, read in the browser
 *   - ONE screen recording (video, up to 5 minutes)  -> wealthflow-video-frames.js walks it in the browser and keeps up to ten frames
 *     (where the picture changed most, plus the first and last) and a motion timeline; the video itself never leaves the device
 * Word, Excel and other Office files cannot be opened in the browser: they are refused with a message saying so, not dropped.
 *
 * ONE REQUEST HAS A CEILING (the serverless body limit is 4.5 MB), so what each file may use depends on how many there are:
 * reading pictures share ~3.2 million characters, thumbnails share the ~43,500 an issue body can hold next to the report.
 * That is why the files are PREPARED WHEN YOU TAP SEND, for the real count, and not when you pick them (a picture prepared
 * for one-of-five would be needlessly blurry when it is the only one, and one prepared for one-of-one would not fit beside four others).
 *
 * Nothing leaves the device until the person taps Send. Names are shown as typed on the device only; the server keeps the
 * kind and a number, never the name (a file name can be a card or an account number).
 *
 * Pure parts (kindOf, budgets, plan) are exported for tests. The rest needs a DOM.
 * ===========================================================================*/
(function (root) {
    'use strict';

    var MAX_FILES = 5;
    var TOTAL_READING = 3200000;     // characters of reading pictures one request may carry (the body limit is ~4.5 MB)
    var TOTAL_THUMBS = 43500;        // characters of thumbnails an issue body can hold next to the report
    var READ_CAP = 1000000;          // one reading picture, as in wealthflow-image-prep.js
    var TEXT_CHARS = 12000;          // characters kept of one text file
    var TEXT_READ_BYTES = 400000;    // bytes read of one text file
    var PDF_PAGES = 2;               // pages of a PDF that are drawn and read
    var PDF_SIDE = 1568;             // long side of a drawn page
    var PDF_MAX_BYTES = 30 * 1024 * 1024;
    var VIDEO_MAX_BYTES = 1500 * 1024 * 1024;
    var TEXT_MAX_BYTES = 8 * 1024 * 1024;
    var TEXT_EXT = /\.(txt|csv|tsv|json|log|md)$/i;
    var IMAGE_EXT = /\.(png|jpe?g|webp|gif|bmp|avif|heic|heif)$/i;
    var OFFICE_EXT = /\.(docx?|xlsx?|pptx?|odt|ods|rtf|pages|numbers)$/i;
    var VIDEO_EXT = /\.(mp4|m4v|mov|webm|3gp|3gpp|mkv|avi)$/i;
    var VIDEO_FRAME_CAP = 200000;    // characters of one video frame
    var VIDEO_UNITS = 3;             // a recording reads like three pictures when it shares the reading budget
    var ACCEPT = 'image/*,video/*,.mp4,.mov,.m4v,.webm,.3gp,application/pdf,.pdf,.txt,.csv,.tsv,.json,.log,.md';

    /** 'image' | 'video' | 'pdf' | 'text' | 'office' | '' for a File-like { name, type, size }. */
    function kindOf(f) {
        var name = String((f && f.name) || ''), type = String((f && f.type) || '').toLowerCase();
        if (/^video\//.test(type) || VIDEO_EXT.test(name)) return 'video';
        if (type === 'application/pdf' || /\.pdf$/i.test(name)) return 'pdf';
        if (/^image\//.test(type) || IMAGE_EXT.test(name)) return 'image';
        if (OFFICE_EXT.test(name) || /officedocument|msword|ms-excel|ms-powerpoint|opendocument/.test(type)) return 'office';
        if (/^text\//.test(type) || TEXT_EXT.test(name) || type === 'application/json') return 'text';
        return '';
    }

    /**
     * What each file may use when `kinds` (['image','pdf','text', ...]) are sent together.
     * @returns {{ thumbCap:number, share:number, readCap:number, maxTiles:number, pdfPages:number, videoShare:number }}
     */
    function budgets(kinds) {
        var reading = 0, thumbs = 0;
        (kinds || []).forEach(function (k) {
            if (k === 'image' || k === 'pdf') { reading += 1; thumbs += 1; }
            else if (k === 'video') { reading += VIDEO_UNITS; thumbs += 1; }
        });
        reading = Math.max(1, reading); thumbs = Math.max(1, thumbs);
        // Each picture or PDF gets an equal SHARE of the reading budget and spends it over its own parts (a tall page is cut
        // into up to three, a PDF gives up to two pages), so the whole report is always inside the body limit and a tall
        // capture still gets its parts when five files are attached.
        var share = Math.floor(TOTAL_READING / reading);
        return {
            thumbCap: Math.max(1, Math.floor(TOTAL_THUMBS / thumbs)),
            share: share,
            videoShare: share * VIDEO_UNITS,
            readCap: Math.max(60000, Math.min(READ_CAP, share)),
            maxTiles: 3,
            pdfPages: PDF_PAGES,
        };
    }

    /** Which of `incoming` are taken, given what is already held. Pure. */
    function plan(held, incoming) {
        var take = [], refuse = [], have = (held || []).slice();
        (incoming || []).forEach(function (f) {
            var name = String((f && f.name) || 'file'), kind = kindOf(f), size = Number(f && f.size) || 0;
            if (have.some(function (h) { return h.name === name && h.size === size; })) { refuse.push({ name: name, why: 'already attached' }); return; }
            if (!kind) { refuse.push({ name: name, why: 'this kind of file cannot be read' }); return; }
            if (kind === 'office') { refuse.push({ name: name, why: 'Word, Excel and similar files cannot be opened here; save it as a PDF, or paste the text into the box above' }); return; }
            if (kind === 'video' && have.some(function (h) { return h.kind === 'video'; })) { refuse.push({ name: name, why: 'only one screen recording fits in one report' }); return; }
            if (kind === 'video' && size > VIDEO_MAX_BYTES) { refuse.push({ name: name, why: 'the recording is over 1.5 GB' }); return; }
            if (kind === 'pdf' && size > PDF_MAX_BYTES) { refuse.push({ name: name, why: 'the PDF is over 30 MB' }); return; }
            if (kind === 'text' && size > TEXT_MAX_BYTES) { refuse.push({ name: name, why: 'the text file is over 8 MB' }); return; }
            if (have.length >= MAX_FILES) { refuse.push({ name: name, why: 'only ' + MAX_FILES + ' files fit in one report' }); return; }
            var item = { name: name, size: size, kind: kind };
            have.push(item); take.push(item);
        });
        return { take: take, refuse: refuse };
    }

    // ── preparing the real files (needs the browser) ─────────────────────────────────────────────────────────────────
    function readText(file) {
        var part = file.slice ? file.slice(0, TEXT_READ_BYTES) : file;
        if (part.text) return part.text();
        return new Promise(function (resolve, reject) {
            var r = new root.FileReader();
            r.onload = function () { resolve(String(r.result || '')); };
            r.onerror = function () { reject(new Error('unreadable text')); };
            r.readAsText(part);
        });
    }

    function pdfLib() {
        var ai = root.WF_AI_V4 && root.WF_AI_V4.utils;
        if (root.pdfjsLib && root.pdfjsLib.getDocument) return Promise.resolve(root.pdfjsLib);
        if (ai && ai.ensurePdfJs) return ai.ensurePdfJs();
        return Promise.reject(new Error('the PDF reader is not available'));
    }

    function renderPdf(file, b) {
        var P = root.WFImagePrep;
        return pdfLib().then(function (lib) {
            return file.arrayBuffer().then(function (buf) { return lib.getDocument({ data: new Uint8Array(buf) }).promise; });
        }).then(function (doc) {
            var total = doc.numPages, n = Math.min(total, b.pdfPages), out = { thumb: '', reading: [], pages: n, totalPages: total };
            var chain = Promise.resolve();
            for (var p = 1; p <= n; p++) {
                (function (pageNo) {
                    chain = chain.then(function () { return doc.getPage(pageNo); }).then(function (page) {
                        var v0 = page.getViewport({ scale: 1 });
                        var scale = Math.min(3, PDF_SIDE / Math.max(v0.width, v0.height, 1));
                        var vp = page.getViewport({ scale: scale });
                        var cv = document.createElement('canvas');
                        cv.width = Math.max(1, Math.round(vp.width)); cv.height = Math.max(1, Math.round(vp.height));
                        return page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise.then(function () {
                            // the first page makes the thumbnail; every page makes one reading picture
                            var r = P.prepareSource(cv, { thumbCap: pageNo === 1 ? b.thumbCap : 1, readCap: Math.max(60000, Math.min(b.readCap, Math.floor(b.share / b.pdfPages))), maxTiles: 1 });
                            if (pageNo === 1) out.thumb = r.thumb;
                            if (r.reading[0]) out.reading.push(r.reading[0]);
                            cv.width = cv.height = 0;
                        });
                    });
                })(p);
            }
            return chain.then(function () { try { doc.destroy(); } catch (_) { /* nothing to free */ } return out; });
        });
    }

    var onVideoProgress = null;      // set by collect() so the sheet can say how far the recording has been read

    /**
     * Walk one recording in the browser (wealthflow-video-frames.js) and make what the server needs: up to ten frames at reading
     * quality with the second each one is from and why it was kept, the motion timeline, and one small contact sheet for the issue.
     * The video itself is never sent. Rejects with a message the person can read.
     */
    function renderVideo(file, b) {
        var V = root.WFVideoFrames, P = root.WFImagePrep;
        if (!V || !P) return Promise.reject(new Error('the recording reader is not available'));
        return V.extract(file, { onProgress: onVideoProgress }).then(function (r) {
            if (!r.ok) throw new Error(r.reason || 'the recording could not be read');
            var n = r.frames.length;
            var cap = Math.max(40000, Math.min(VIDEO_FRAME_CAP, Math.floor((b.videoShare || TOTAL_READING) / Math.max(1, n))));
            var frames = [];
            r.frames.forEach(function (f) {
                var q = P.prepareSource(f.canvas, { thumbCap: 1, readCap: cap, maxTiles: 1 });
                if (q.reading[0]) frames.push({ t: Math.round(f.t * 10) / 10, why: String(f.why || '').slice(0, 40), image: q.reading[0] });
            });
            var thumb = V.contactSheet(r.frames);
            if (thumb.length > b.thumbCap) thumb = P.prepareSource(r.frames[0].canvas, { thumbCap: b.thumbCap, readCap: 60000, maxTiles: 1 }).thumb || '';
            r.frames.forEach(function (f) { f.canvas.width = f.canvas.height = 0; });
            if (!frames.length) throw new Error('no frame could be prepared');
            return { thumb: thumb, frames: frames, motion: r.motion || [], duration: Math.round(r.duration * 10) / 10, width: r.width, height: r.height };
        });
    }

    /**
     * Prepare every held file for the real count and say which could not be used. Never rejects.
     * @param {{ file:object, name:string, kind:string }[]} held
     * @returns {Promise<{ attachments:object[], skipped:{name:string,why:string}[] }>}
     */
    function prepareAll(held) {
        var b = budgets(held.map(function (h) { return h.kind; }));
        var attachments = [], skipped = [];
        var chain = Promise.resolve();
        held.forEach(function (h, i) {
            chain = chain.then(function () {
                if (h.kind === 'image') {
                    if (!root.WFImagePrep) { skipped.push({ name: h.name, why: 'the picture reader is not available' }); return; }
                    return root.WFImagePrep.prepare(h.file, { thumbCap: b.thumbCap, readCap: b.readCap, readShare: b.share, maxTiles: b.maxTiles }).then(function (r) {
                        if (!r.ok) { skipped.push({ name: h.name, why: 'the picture could not be read' }); return; }
                        attachments.push({ kind: 'image', n: i + 1, thumb: r.thumb || '', reading: r.reading || [] });
                    });
                }
                if (h.kind === 'video') {
                    return renderVideo(h.file, b).then(function (r) {
                        attachments.push({ kind: 'video', n: i + 1, thumb: r.thumb, frames: r.frames, motion: r.motion, duration: r.duration, width: r.width, height: r.height });
                    }).catch(function (e) { skipped.push({ name: h.name, why: String((e && e.message) || 'the recording could not be read').slice(0, 140) }); });
                }
                if (h.kind === 'pdf') {
                    return renderPdf(h.file, b).then(function (r) {
                        if (!r.reading.length && !r.thumb) { skipped.push({ name: h.name, why: 'no page could be drawn' }); return; }
                        attachments.push({ kind: 'pdf', n: i + 1, thumb: r.thumb || '', reading: r.reading, pages: r.pages, totalPages: r.totalPages });
                    }).catch(function (e) {
                        var m = String((e && (e.name || e.message)) || e);
                        skipped.push({ name: h.name, why: /password/i.test(m) ? 'the PDF is password protected' : 'the PDF could not be read' });
                    });
                }
                if (h.kind === 'text') {
                    return readText(h.file).then(function (t) {
                        t = String(t || '').replace(/\u0000/g, '');
                        if (!t.trim()) { skipped.push({ name: h.name, why: 'the file is empty' }); return; }
                        attachments.push({ kind: 'text', n: i + 1, text: t.slice(0, TEXT_CHARS), truncated: t.length > TEXT_CHARS || h.size > TEXT_READ_BYTES });
                    }).catch(function () { skipped.push({ name: h.name, why: 'the text could not be read' }); });
                }
            });
        });
        return chain.then(function () { return { attachments: attachments, skipped: skipped }; }, function () { return { attachments: attachments, skipped: skipped }; });
    }

    // ── the control in the Send Feedback sheet ──────────────────────────────────────────────────────────────────────
    var held = [];          // { file, name, size, kind, url }
    var view = null;        // { host, list, btn, input, note, notify }

    function sizeText(n) { return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }

    function style(el, css) { el.style.cssText = css; return el; }

    function render() {
        if (!view) return;
        view.list.textContent = '';
        held.forEach(function (h, i) {
            var chip = style(document.createElement('div'), 'display:flex;align-items:center;gap:10px;padding:8px;border:1px solid var(--border,#1f2638);border-radius:9px;background:var(--bg,#060a14);');
            var pic = style(document.createElement('div'), 'width:40px;height:40px;border-radius:7px;flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:var(--text3,#8b95a8);background:var(--card,#0d1424);');
            if (h.url) { var im = document.createElement('img'); im.src = h.url; im.alt = ''; style(im, 'width:100%;height:100%;object-fit:cover;'); pic.appendChild(im); }
            else pic.textContent = h.kind === 'pdf' ? 'PDF' : h.kind === 'video' ? 'VIDEO' : 'TXT';
            var meta = style(document.createElement('div'), 'flex:1;min-width:0;');
            var nm = style(document.createElement('div'), 'font-size:13px;color:var(--text,#e6e7eb);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;');
            nm.textContent = h.name;
            var sub = style(document.createElement('div'), 'font-size:11.5px;color:var(--text3,#8b95a8);');
            sub.textContent = (h.kind === 'image' ? 'Picture' : h.kind === 'pdf' ? 'PDF document' : h.kind === 'video' ? 'Screen recording' : 'Text file') + ' · ' + sizeText(h.size);
            meta.appendChild(nm); meta.appendChild(sub);
            var x = style(document.createElement('button'), 'background:none;border:none;color:var(--text3,#8b95a8);font-size:20px;line-height:1;cursor:pointer;padding:4px 8px;');
            x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Remove ' + h.name);
            x.onclick = function () { remove(i); };
            chip.appendChild(pic); chip.appendChild(meta); chip.appendChild(x);
            view.list.appendChild(chip);
        });
        var full = held.length >= MAX_FILES;
        view.btn.disabled = full;
        view.btn.style.opacity = full ? '0.55' : '1';
        view.btn.textContent = full ? 'Limit reached — 5 files attached'
            : held.length ? '+ Add more (' + held.length + ' of ' + MAX_FILES + ' attached)'
            : '+ Attach screenshots, a screen recording or documents (optional, up to ' + MAX_FILES + ')';
        var vid = held.some(function (h) { return h.kind === 'video'; });
        view.note.textContent = vid ? 'The recording is read frame by frame by the AI here on your device first (this can take a minute); the video itself is not sent and its sound is not heard. Nothing is sent until you tap Send.'
            : held.length ? 'Pictures and PDF pages are read by the AI. Nothing is sent until you tap Send.' : '';
    }

    function remove(i) {
        var h = held[i];
        if (h && h.url && root.URL && root.URL.revokeObjectURL) { try { root.URL.revokeObjectURL(h.url); } catch (_) { /* optional */ } }
        held.splice(i, 1);
        render();
    }

    function clear() {
        held.forEach(function (h) { if (h.url && root.URL && root.URL.revokeObjectURL) { try { root.URL.revokeObjectURL(h.url); } catch (_) { /* optional */ } } });
        held = [];
        render();
    }

    function add(files) {
        var list = Array.prototype.slice.call(files || []);
        var p = plan(held.map(function (h) { return { name: h.name, size: h.size, kind: h.kind }; }), list);
        p.take.forEach(function (t) {
            var file = list.filter(function (f) { return String(f.name || 'file') === t.name && (Number(f.size) || 0) === t.size; })[0];
            var url = '';
            if (t.kind === 'image' && root.URL && root.URL.createObjectURL) { try { url = root.URL.createObjectURL(file); } catch (_) { url = ''; } }
            held.push({ file: file, name: t.name, size: t.size, kind: t.kind, url: url });
        });
        if (p.refuse.length && view && view.notify) {
            view.notify('Not attached: ' + p.refuse.slice(0, 3).map(function (r) { return r.name + ' (' + r.why + ')'; }).join('; ') + (p.refuse.length > 3 ? ' and ' + (p.refuse.length - 3) + ' more' : ''), 'warn');
        }
        render();
        return p;
    }

    /** Put the control into `host` (an empty element in the feedback sheet). A new sheet starts with nothing attached. */
    function mount(host, opts) {
        if (!host) return;
        clear();
        host.textContent = '';
        var input = document.createElement('input');
        input.type = 'file'; input.id = 'wfFbImg'; input.multiple = true; input.accept = ACCEPT; input.style.display = 'none';
        var btn = style(document.createElement('button'), 'width:100%;padding:11px;background:var(--bg,#060a14);border:1px dashed var(--border2,#1f2638);border-radius:9px;color:var(--text3,#8b95a8);font-size:13px;cursor:pointer;');
        btn.type = 'button'; btn.id = 'wfFbImgBtn';
        var list = style(document.createElement('div'), 'display:flex;flex-direction:column;gap:6px;margin-top:8px;');
        list.id = 'wfFbImgPreview';
        var note = style(document.createElement('div'), 'font-size:11.5px;color:var(--text3,#8b95a8);margin-top:6px;');
        host.appendChild(input); host.appendChild(btn); host.appendChild(list); host.appendChild(note);
        view = { host: host, list: list, btn: btn, input: input, note: note, notify: (opts && opts.notify) || null };
        btn.onclick = function () { input.value = ''; input.click(); };
        input.onchange = function () { add(input.files); input.value = ''; };
        render();
    }

    /**
     * Everything the report carries about the attached files, prepared for the real count. Never rejects.
     * @returns {Promise<{ attachments:object[], stored:object[], image:string|null, skipped:object[], count:number }>}
     *   attachments: what goes to triage (pictures, page renders, text) · stored: kind and thumbnail only, for Firestore and the local copy
     */
    function collect() {
        var mine = held.slice();
        if (!mine.length) return Promise.resolve({ attachments: [], stored: [], image: null, skipped: [], count: 0 });
        if (view && view.note) view.note.textContent = 'Preparing ' + mine.length + (mine.length === 1 ? ' file' : ' files') + '…';
        onVideoProgress = function (done, total) { if (view && view.note) view.note.textContent = 'Reading the recording… ' + Math.min(100, Math.round(done / Math.max(1, total) * 100)) + '%'; };
        return prepareAll(mine).then(function (r) {
            onVideoProgress = null;
            var stored = r.attachments.map(function (a) { return { kind: a.kind, n: a.n, thumb: a.thumb || '' }; });
            var first = r.attachments.filter(function (a) { return a.thumb; })[0];
            if (r.skipped.length && view && view.notify) {
                view.notify('Sent without: ' + r.skipped.slice(0, 3).map(function (s) { return s.name + ' (' + s.why + ')'; }).join('; '), 'warn');
            }
            return { attachments: r.attachments, stored: stored, image: first ? first.thumb : null, skipped: r.skipped, count: mine.length };
        }).catch(function () { return { attachments: [], stored: [], image: null, skipped: [], count: mine.length }; });
    }

    root.WFFeedbackAttach = {
        MAX_FILES: MAX_FILES, ACCEPT: ACCEPT, TOTAL_READING: TOTAL_READING, TOTAL_THUMBS: TOTAL_THUMBS,
        kindOf: kindOf, budgets: budgets, plan: plan, mount: mount, add: add, remove: remove, clear: clear, collect: collect,
        count: function () { return held.length; }, hasVideo: function () { return held.some(function (h) { return h.kind === 'video'; }); }, _prepareAll: prepareAll,
    };
})(typeof window !== 'undefined' ? window : globalThis);
