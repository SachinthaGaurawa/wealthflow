/* The proving test is generated from the module's own TEST RECIPE (autonomy/recipe-test.mjs).
 * The recipe below is the one the author wrote for #635 in run 44640763964 (logged by #644); the model-written test ignored it three times. */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { readRecipe, parseCall, parseExpect, parseBooks, testFromRecipe } from '../autonomy/recipe-test.mjs';
import { verifyTestProves } from '../autonomy/agent-swarm.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const plan = { name: 'wealthflow-zz-recipe-fixture.js', api: 'WFZzRecipeFixture' };

const RECIPE = `
/* TEST RECIPE
   books: {"ccinstall": [{"id":"p1","product":"Samsung TV","bank":"HNB","buyer":"Self","monthly":15000,"total":180000,"duration":12,"date":"2025-01-15","rate":0,"skipped":[],"notes":"","completed":false}]}
   page: <table><tbody id="cciBody"><tr><td>Samsung TV</td><td><div class="act-btns"><button onclick="editCCI('p1')">edit</button></div></td></tr></tbody></table>
   steps: WFZzRecipeFixture.mount(); WFZzRecipeFixture.open("p1")
   expect: element with class "wf-cci-title" holds text "Samsung TV"
*/`;

// A small module that really draws what the recipe says.
const GOOD = `(function (root) {
  'use strict';
  function mount() { if (!root.document) return; }
  function open(id) {
    var books = root.DB && root.DB.get ? root.DB.get('ccinstall') : [];
    var rec = (books || []).filter(function (r) { return r.id === id; })[0];
    if (!rec) return;
    var box = root.document.createElement('div');
    var t = root.document.createElement('h2');
    t.className = 'wf-cci-title';
    t.textContent = rec.product;
    box.appendChild(t);
    root.document.body.appendChild(box);
  }
  root.WFZzRecipeFixture = { mount: mount, open: open };
})(typeof window !== 'undefined' ? window : globalThis);
${RECIPE}`;

// The failure seen on #635: the module draws nothing for the recipe's own record.
const DRAWS_NOTHING = GOOD.replace("t.textContent = rec.product;", "t.textContent = '';");

describe('recipe reading', () => {
    it('reads the four fields of the recipe', () => {
        const r = readRecipe(GOOD);
        expect(Object.keys(r).sort()).toEqual(['books', 'expect', 'page', 'steps']);
        expect(r.steps).toContain('open("p1")');
    });
    it('parses the books, the calls and the expected element', () => {
        const r = readRecipe(GOOD);
        expect(parseBooks(r.books).ccinstall[0].id).toBe('p1');
        expect(parseCall('WFZzRecipeFixture.open("p1")', plan.api)).toEqual({ fn: 'open', args: ['p1'] });
        expect(parseCall("WFZzRecipeFixture.open('p1', 2)", plan.api)).toEqual({ fn: 'open', args: ['p1', 2] });
        expect(parseCall('WFZzRecipeFixture.mount()', plan.api)).toEqual({ fn: 'mount', args: [] });
        expect(parseExpect(r.expect)).toEqual({ selector: '.wf-cci-title', text: 'Samsung TV' });
        expect(parseExpect('the element with id wfCciDetailRoot then holds "Samsung TV" and "HNB"')).toEqual({ selector: '#wfCciDetailRoot', text: 'HNB' });
    });
    it('refuses calls it cannot run as written', () => {
        expect(parseCall('somethingElse.open("p1")', plan.api)).toBeNull();
        expect(parseCall('WFZzRecipeFixture.open(document.body)', plan.api)).toBeNull();
        expect(parseCall('WFOther.open("p1")', plan.api)).toBeNull();
    });
    it('says why when the recipe cannot be turned into a test', () => {
        expect(testFromRecipe(plan, 'no recipe here').ok).toBe(false);
        expect(testFromRecipe(plan, GOOD.replace(/books:.*\n/, 'books: none\n')).why).toMatch(/books/);
        expect(testFromRecipe(plan, GOOD.replace(/steps:.*\n/, 'steps: click the row\n')).why).toMatch(/steps/);
        expect(testFromRecipe(plan, GOOD.replace(/expect:.*\n/, 'expect: it looks right\n')).why).toMatch(/element/);
    });
});

describe('the generated test, run for real', () => {
    const tf = 'test/auto-zz-recipe-fixture.test.js';
    const target = path.join(ROOT, plan.name);
    const run = (code) => {
        const gen = testFromRecipe(plan, code);
        expect(gen.ok).toBe(true);
        expect(gen.source).toContain('open("p1")');
        expect(gen.source).toContain('"Samsung TV"');
        try { return verifyTestProves({ repoDir: ROOT, targetFile: plan.name, before: '', after: code, testFile: tf, testSource: gen.source }); }
        finally { try { fs.unlinkSync(target); } catch { /* never left behind */ } }
    };
    it('is red with no module and green with a module that draws what the recipe says', () => {
        const proof = run(GOOD);
        expect(proof.reason).toBeUndefined();
        expect(proof.ok).toBe(true);
    }, 60000);
    it('fails a module that draws nothing for its own recipe, with the real message', () => {
        const proof = run(DRAWS_NOTHING);
        expect(proof.ok).toBe(false);
        expect(proof.afterPassed).toBe(false);
        expect(String(proof.output)).toMatch(/Samsung TV/);
    }, 60000);
});
