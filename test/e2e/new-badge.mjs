/** Browser regression for the NEW tag: it puts itself on a screen or an option that is new, shows the same pill in the sidebar and the phone More
 * sheet, never says "new" about a screen that already existed (the AI Advisor used to), and takes itself off after 7 days with nobody editing anything.
 * Real Chromium, stubbed Firebase, no real account. Run from the repository root:  node test/e2e/new-badge.mjs
 * WF_NEWBADGE_ARTIFACTS optionally selects the screenshot directory (default /tmp/wealthflow-new-badge).
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { bootApp } from './harness.mjs';

const artifacts = process.env.WF_NEWBADGE_ARTIFACTS || '/tmp/wealthflow-new-badge';
await fs.mkdir(artifacts, { recursive: true });
const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };
const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

// The old behaviour set the AI Advisor's tag three seconds after launch: wait past it, then nothing may be tagged.
await page.setViewportSize({ width: 1280, height: 900 });
await page.waitForTimeout(3800);
const quiet = await page.evaluate(() => ({
    tags: document.querySelectorAll('.wf-new').length,
    ai: !!document.querySelector('#aiNavItem .wf-new'),
    nb: (() => { const n = document.getElementById('nb-ai'); return n ? { text: n.textContent.trim(), shown: getComputedStyle(n).display !== 'none' } : null; })(),
    api: !!(window.WFNew && window.WFNew.scan),
}));
check(quiet.api, 'window.WFNew should exist (wealthflow-new-badge.js did not load)');
check(quiet.tags === 0, `nothing that already existed may be tagged NEW, found ${quiet.tags}`);
check(!quiet.ai, 'the AI Advisor must not wear a NEW tag');
check(!quiet.nb || !(quiet.nb.shown && /NEW/i.test(quiet.nb.text)), 'the old hand-set NEW on #nb-ai must be gone');

// A screen that is new: add a sidebar entry the way a future change would (no date, no list edited).
await page.evaluate(() => {
    const settings = [...document.querySelectorAll('.sb-nav .nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'settings'"));
    const el = document.createElement('div');
    el.className = 'nav-item'; el.id = 'tstNewScreen';
    el.setAttribute('onclick', "showPage('zakatplanner',this)");
    el.innerHTML = '<span class="nav-icon"><i data-wfi="target"></i></span> Zakat Planner';
    settings.parentNode.insertBefore(el, settings);
});
await page.waitForTimeout(900);
const created = await page.evaluate(() => {
    const p = document.querySelector('#tstNewScreen > .wf-new');
    const stamp = JSON.parse(localStorage.getItem('wf_new_seen_v1') || '{}');
    return p && { text: p.textContent, left: p.getAttribute('data-left'), title: p.title, stamped: Number.isFinite(stamp.zakatplanner), right: Math.round(document.querySelector('#tstNewScreen').getBoundingClientRect().right - p.getBoundingClientRect().right) };
});
check(created && created.text === 'NEW', 'a screen that is not in the baseline should get a NEW tag by itself');
check(created && created.left === '7', `a tag starts at 7 days left, got ${created && created.left}`);
check(created && created.stamped, 'the first sighting of a new screen should be stamped');
check(created && created.right <= 16, `the tag sits at the right edge of the row, ${created && created.right}px from it`);

// An option: dated elements. The week is counted from the person's FIRST LOOK, not from the day it shipped (owner, 2026-11-07).
// A person who began a month ago and comes back: an option that shipped today or 6 days ago shows its full 7 days; one that shipped
// before they began (40 days ago) is not new to them; a malformed date shows nothing; a row that has not been on screen has not started its week.
await page.evaluate(() => {
    const began = Date.now() - 30 * 86400000;
    const all = JSON.parse(localStorage.getItem('wf_new_seen_v1') || '{}'); all._since = began; localStorage.setItem('wf_new_seen_v1', JSON.stringify(all));
    const acct = DB.getObj('newSeen', {}); DB.set('newSeen', { ...acct, _since: began });
    const day = (d) => new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
    const host = document.querySelector('#page-settings') || document.body;
    host.insertAdjacentHTML('beforeend', ['0', '6', '40', 'soon'].map((d) => `<div class="tst-opt" id="tstOpt${d}" data-wf-new="${d === 'soon' ? 'soon' : day(+d)}" style="display:block;min-height:20px">Option ${d}</div>`).join('')
        + `<div class="tst-opt" id="tstOptHidden" data-wf-new="${day(2)}" style="display:none">Option hidden</div>`);
    document.querySelectorAll('.tst-opt').forEach((e) => { e.style.display = e.id === 'tstOptHidden' ? 'none' : 'block'; });
    // the settings page itself may not be the open one: show the host so the rows are really on screen
    if (host.id === 'page-settings') { host.style.display = 'block'; }
});
await page.waitForTimeout(900);
const opts = await page.evaluate(() => Object.fromEntries(['0', '6', '40', 'soon', 'Hidden'].map((d) => { const p = document.querySelector(`#tstOpt${d} > .wf-new`); return [d, p ? p.getAttribute('data-left') : null]; })));
check(opts['0'] === '7', `an option dated today shows its full 7 days from the first look, got ${opts['0']}`);
check(opts['6'] === '7', `an option that shipped 6 days ago, first seen now, still shows 7 days (not 1), got ${opts['6']}`);
check(opts['40'] === null, 'an option that shipped before the person began must not show');
check(opts.soon === null, 'a malformed date must not show a tag');
check(opts.Hidden === null, 'a row that has not been on screen has not started its week');
await page.evaluate(() => { document.getElementById('tstOptHidden').style.display = 'block'; });
await page.waitForTimeout(1200);
const revealed = await page.evaluate(() => { const p = document.querySelector('#tstOptHidden > .wf-new'); return p ? p.getAttribute('data-left') : null; });
check(revealed === '7', `once the hidden row is opened its week starts: 7 days left, got ${revealed}`);
const kept = await page.evaluate(() => ({ local: Object.keys(JSON.parse(localStorage.getItem('wf_new_seen_v1') || '{}')).filter((k) => k.startsWith('f:')).length, account: Object.keys(DB.getObj('newSeen', {})).filter((k) => k.startsWith('f:')).length }));
check(kept.local >= 3 && kept.account >= 3, `each first look is kept on the device (${kept.local}) and on the account (${kept.account})`);

// The phone: the More sheet shows the same tag, and a NEW tag is not "needs attention".
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await page.locator('.wf-tab[data-more]').click();
await page.waitForTimeout(500);
const sheet = await page.evaluate(() => {
    const items = [...document.querySelectorAll('.wf-sheet .wf-item')];
    const hit = items.find((i) => /Zakat Planner/.test(i.textContent));
    const b = hit && hit.querySelector('.wf-badge-new');
    const r = b && b.getBoundingClientRect(), ir = hit && hit.getBoundingClientRect();
    return { found: !!hit, tag: b ? b.textContent : null, label: hit ? hit.textContent.replace('NEW', '').trim() : null, inside: !!(r && r.right <= ir.right + 1 && r.left >= ir.left - 1 && r.top >= ir.top - 1), others: items.filter((i) => i.querySelector('.wf-badge-new')).length, ai: items.filter((i) => /AI Advisor/.test(i.textContent) && i.querySelector('.wf-badge-new')).length };
});
check(sheet.found, 'the new screen should be in the More sheet');
check(sheet.tag === 'NEW', 'the More sheet should show the NEW tag on the new screen');
check(sheet.label === 'Zakat Planner', `the tag must not leak into the screen name, got "${sheet.label}"`);
check(sheet.inside, 'the tag should sit inside its tile');
check(sheet.ai === 0, 'the AI Advisor tile must not carry NEW');
await page.evaluate(() => { const i = [...document.querySelectorAll('.wf-sheet .wf-item')].find((e) => /Zakat Planner/.test(e.textContent)); if (i) i.scrollIntoView({ block: 'center' }); });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(artifacts, 'more-sheet.png') });
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
const dot = await page.evaluate(() => !!document.querySelector('.wf-tab[data-more] .wf-dot'));
check(!dot, 'a NEW tag alone must not light the red "needs attention" dot on More');

// Desktop pictures, dark and light.
await page.setViewportSize({ width: 1280, height: 900 });
for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
    await page.waitForTimeout(400);
    await page.evaluate(() => document.querySelector('#tstNewScreen').scrollIntoView({ block: 'center' }));
    await page.waitForTimeout(500);
    const sb = page.locator('#sidebar');
    await sb.screenshot({ path: path.join(artifacts, `sidebar-${theme}.png`) });
    const contrast = await page.evaluate(() => { const p = document.querySelector('#tstNewScreen > .wf-new'); const cs = getComputedStyle(p); return { color: cs.color, bg: cs.backgroundImage.slice(0, 60) }; });
    check(/gradient/.test(contrast.bg), `the tag has a gold fill in the ${theme} theme`);
}
await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));

// Seven days on: a page left open drops the tag with no reload and no edit; an earlier stamp ends it too.
const after = await page.evaluate(() => {
    const out = {};
    const week = Date.now() + 8 * 86400000;
    window.WFNew.scan(document, window, week);
    out.screen = !!document.querySelector('#tstNewScreen > .wf-new');
    out.options = document.querySelectorAll('.tst-opt > .wf-new').length;
    // and a stamp from 3 days ago leaves 4 days
    const stamp = JSON.parse(localStorage.getItem('wf_new_seen_v1') || '{}');
    stamp.zakatplanner = Date.now() - 3 * 86400000; localStorage.setItem('wf_new_seen_v1', JSON.stringify(stamp));
    window.WFNew.scan(document, window, Date.now());
    const p = document.querySelector('#tstNewScreen > .wf-new');
    out.threeDays = p ? p.getAttribute('data-left') : null;
    return out;
});
check(after.screen === false, 'a new screen must lose its tag 7 days on');
check(after.options === 0, 'dated options must lose their tags 7 days after the first look');
check(after.threeDays === '4', `a screen first seen 3 days ago has 4 days left, got ${after.threeDays}`);

// Reduced motion: the tag appears without animating.
await page.emulateMedia({ reducedMotion: 'reduce' });
const anim = await page.evaluate(() => getComputedStyle(document.querySelector('#tstNewScreen > .wf-new')).animationName);
check(anim === 'none', `reduced motion should not animate the tag, got ${anim}`);

await app.close?.();
if (fail.length) { console.error('NEW TAG FAILED:\n - ' + fail.join('\n - ')); process.exit(1); }
console.log('new-badge e2e: all checks passed');
process.exit(0);
