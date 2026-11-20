/* Where the NEW tag goes (autonomy/tag-placement.mjs): on what the person sees, never on an empty wrapper.
 * The shape below is the module the build lane wrote for #635 (PR 647): a wrapper in <body>, a sheet inside it that stays hidden until a row is tapped. */
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { placeTag, moveTag, variableForId, shownText, isHiddenSelf } from '../autonomy/tag-placement.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const TODAY = '2026-11-20';

const WRAPPED = `(function (root) {
  'use strict';
  var CONTAINER_ID = 'wfBoxRoot';
  var SHEET_ID = 'wfBoxSheet';
  function build() {
    var wrap = document.createElement('div');
    wrap.id = SHEET_ID;
    wrap.style.display = 'none';
    var t = document.createElement('h2'); t.textContent = 'Plan details'; wrap.appendChild(t);
    return wrap;
  }
  function mount() {
    var host = document.createElement('div');
    host.id = CONTAINER_ID;
    host.setAttribute('data-wf-new', '${TODAY}');
    host.appendChild(build());
    document.body.appendChild(host);
  }
  root.WFBox = { mount: mount };
})(typeof window !== 'undefined' ? window : globalThis);`;

const run = (code, extra = {}) => placeTag({ file: 'wealthflow-box.js', api: 'WFBox', code, today: TODAY, repoDir: ROOT, ...extra });

describe('pure helpers', () => {
    it('finds the variable that gets an id, even through a constant', () => {
        expect(variableForId(WRAPPED, 'wfBoxSheet').name).toBe('wrap');
        expect(variableForId(WRAPPED, 'wfBoxRoot').name).toBe('host');
        expect(variableForId(WRAPPED, 'nope')).toBeNull();
    });
    it('moves the tag line from one variable to another', () => {
        const out = moveTag(WRAPPED, TODAY, 'host', { id: 'wfBoxSheet' });
        expect(out).not.toMatch(/host\.setAttribute\('data-wf-new'/);
        expect(out).toMatch(/wrap\.id = SHEET_ID;\n\s*wrap\.setAttribute\('data-wf-new', '2026-11-20'\);/);
        expect(moveTag('no tag here', TODAY, 'host', { id: 'x' })).toBeNull();
    });
    it('reads only what a person would read', () => {
        const el = { nodeType: 1, style: {}, childNodes: [{ nodeType: 3, textContent: ' hi ' }, { nodeType: 1, style: { display: 'none' }, childNodes: [{ nodeType: 3, textContent: 'secret' }] }] };
        expect(shownText(el)).toBe('hi');
        expect(isHiddenSelf(el.childNodes[1])).toBe(true);
    });
});

describe('placing the tag by running the module', () => {
    it('moves a tag off an empty wrapper onto the hidden sheet', async () => {
        const r = await run(WRAPPED);
        expect(r.problems).toEqual([]);
        expect(r.moved).toMatch(/wfBoxSheet/);
        expect(r.code).toMatch(/wrap\.setAttribute\('data-wf-new', '2026-11-20'\)/);
        expect(r.code).not.toMatch(/host\.setAttribute\('data-wf-new'/);
        // and the moved version is now accepted as it stands
        const again = await run(r.code);
        expect(again.problems).toEqual([]);
        expect(again.moved).toBeUndefined();
    });
    it('leaves a tag that is already on the hidden sheet', async () => {
        const code = WRAPPED.replace("host.setAttribute('data-wf-new', '" + TODAY + "');", '').replace("wrap.style.display = 'none';", "wrap.style.display = 'none';\n    wrap.setAttribute('data-wf-new', '" + TODAY + "');");
        const r = await run(code);
        expect(r).toEqual({ code, problems: [] });
    });
    it('leaves a tag on something that shows text', async () => {
        const code = WRAPPED.replace("host.appendChild(build());", "host.textContent = 'Plans'; host.appendChild(build());");
        const r = await run(code);
        expect(r).toEqual({ code, problems: [] });
    });
    it('says what is wrong when there is no hidden element to move the tag to', async () => {
        const code = WRAPPED.replace("host.appendChild(build());", '');
        const r = await run(code);
        expect(r.code).toBe(code);
        expect(r.problems[0]).toMatch(/shows nothing by itself/);
    });
    it('measures nothing and blocks nothing when the module cannot be run', async () => {
        const r = await run('this is not javascript (');
        expect(r.problems).toEqual([]);
    });
});
