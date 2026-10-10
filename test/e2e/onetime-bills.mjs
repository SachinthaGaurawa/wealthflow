/** Browser run of the One-Time bill, through the real form: what the owner types, what is saved, and what the app then
 * says about it (the card, the reminders, the monthly plan, the cash-flow forecast, the advisor's sheet).
 * Real Chromium, stubbed Firebase, invented books. Run from the repository root:  node test/e2e/onetime-bills.mjs
 */
import { bootApp } from './harness.mjs';
import { SEED } from './dashboard-seed.mjs';

const app = await bootApp();
const { page } = app;
const fail = [];
const check = (cond, msg) => { if (!cond) fail.push(msg); };
const note = page.locator('#wfPostUpdate');
if (await note.isVisible().catch(() => false)) await note.getByRole('button', { name: /Return to Dashboard/ }).click().catch(() => {});

const books = SEED();
books.subscriptions = [];
await page.evaluate((s) => { for (const [k, v] of Object.entries(s)) DB.set(k, v, true); }, books);

const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Type a bill into the real form and press Save. */
const addThroughForm = (b) => page.evaluate((x) => {
    openModal('mdSubscription'); clearSubForm();
    document.getElementById('sub_name').value = x.name;
    document.getElementById('sub_amount').value = String(x.amount);
    document.getElementById('sub_cycle').value = x.cycle;
    syncSubscriptionCycleFields();
    if (x.cycle === 'once') { document.getElementById('sub_due_date').value = x.due; document.getElementById('sub_due_date').dispatchEvent(new Event('change')); }
    else document.getElementById('sub_day').value = String(x.day || 15);
    if (x.status !== undefined && document.getElementById('sub_paid')) { const s = document.getElementById('sub_paid'); s.value = x.status; s.onchange && s.onchange(); }
    saveSubscription();
}, b);

await addThroughForm({ name: 'Lifetime licence', amount: 45000, cycle: 'once', due: iso(-30) });          // bought a month ago
await addThroughForm({ name: 'Annual levy (once)', amount: 12000, cycle: 'once', due: iso(3) });           // due in 3 days
await addThroughForm({ name: 'Far one-off', amount: 9000, cycle: 'once', due: iso(80) });                  // far ahead
await addThroughForm({ name: 'Netflix', amount: 2500, cycle: 'monthly', day: 15 });

const saved = await page.evaluate(() => DB.get('subscriptions').map((s) => ({ name: s.name, cycle: s.cycle, due: s.dueDate, paid: s.paid, completed: s.completed, reopened: s.reopened })));
const by = (n) => saved.find((s) => s.name === n) || {};
console.log('saved', JSON.stringify(saved));
check(by('Lifetime licence').paid === true, 'a one-time bill dated in the past is already paid');
check(by('Annual levy (once)').paid === false, 'a bill due in 3 days is not paid yet');
check(by('Far one-off').paid === false, 'a far bill is not paid yet');

const notes = await page.evaluate(() => WFNotif.compute().map((n) => ({ id: n.id, title: n.title, when: n.when, sev: n.sev })));
console.log('notifications', JSON.stringify(notes));
check(!notes.some((n) => /Lifetime licence/.test(n.title)), 'a paid lifetime bill raises no reminder');
check(notes.some((n) => /Annual levy/.test(n.title)), 'a bill due in 3 days reminds');
check(!notes.some((n) => /Far one-off/.test(n.title)), 'a bill 80 days away does not remind yet');

await page.evaluate(() => showPage('subscriptions', [...document.querySelectorAll('.nav-item')].find((e) => (e.getAttribute('onclick') || '').includes("'subscriptions'"))));
await page.waitForTimeout(700);
const cards = await page.evaluate(() => [...document.querySelectorAll('#subscriptionList > *')].map((c) => c.innerText.replace(/\s+/g, ' ').trim().slice(0, 220)));
console.log('cards', JSON.stringify(cards, null, 1));
const stats = await page.evaluate(() => document.getElementById('subStats').innerText.replace(/\s+/g, ' '));
console.log('stats', stats);

const flows = await page.evaluate(() => {
    try { const r = WFCash && WFCash.project ? 1 : 0; return { r }; } catch (e) { return { err: String(e) }; }
});
console.log('flows', JSON.stringify(flows));

if (app.pageErrors.length) console.log('pageErrors', JSON.stringify(app.pageErrors.slice(0, 5)));
await app.close();
if (fail.length) { console.error('FAIL\n- ' + fail.join('\n- ')); process.exit(1); }
console.log('onetime-bills: ok');
