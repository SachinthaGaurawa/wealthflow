/* =============================================================================
 * test/sms_wiring_test.js — the text-message notices are connected, and connected safely
 * -----------------------------------------------------------------------------
 * A module that nothing loads, a route nothing registers and a collection nothing seals are
 * the three ways this kind of feature has shipped without working. Each is a string in a
 * file, so each is asserted where it lives.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
const HTML = read('index.html');
const ROUTER = read('api/router.js');
const RULES = read('firestore.rules');

describe('the page', () => {
    it('loads the module as a deferred ES module', () => {
        expect(HTML).toContain('<script type="module" src="wealthflow-sms.js"></script>');
    });

    it('nudges the server after a push to the cloud has been acknowledged, and never lets that break the push', () => {
        const at = HTML.indexOf('window.WFSms.afterPush()');
        expect(at).toBeGreaterThan(0);
        const around = HTML.slice(at - 200, at + 80);
        expect(around).toMatch(/try \{ if \(window\.WFSms\) window\.WFSms\.afterPush\(\); \} catch \(_\) \{ \}/);
        expect(HTML.lastIndexOf('function syncToCloud', at)).toBeGreaterThan(0);
        expect(HTML.lastIndexOf('function syncToCloud', at)).toBeGreaterThan(at - 6000);
        expect(HTML.slice(HTML.lastIndexOf('function syncToCloud', at), at)).toContain('.then(() => {');
    });

    it('the investment form carries its fields over by hand and validates BEFORE it saves anything', () => {
        const start = HTML.indexOf('function saveIncome()');
        const body = HTML.slice(start, HTML.indexOf('function clearIncomeForm()', start));
        expect(body).toContain("['sms_notifications_enabled', 'sms_enabled_at', 'phone', 'phone2', 'phone2_at', 'nic', 'fullName', 'personId', 'closedAt', 'closedEndWas'].forEach(k => { if (prevRec[k] !== undefined) rec[k] = prevRec[k]; });");
        expect(body.indexOf('WFSms.applyToggle')).toBeGreaterThan(0);
        expect(body.indexOf('WFSms.applyToggle')).toBeLessThan(body.indexOf("DB.set('income', arr)"));
        expect(body).toMatch(/if \(!sms\.ok\) \{[^}]*\breturn; \}/);
        expect(body).toMatch(/if \(contact && !contact\.ok\) \{[^}]*\breturn; \}/);
    });

    it('the debtor form validates before it saves, and takes the number from the contact fields', () => {
        const start = HTML.indexOf('function openDebtorModal(existing)');
        const body = HTML.slice(start, HTML.indexOf('window.openDebtorModal = openDebtorModal', start));
        expect(body).toContain("WFSms.blockHtml('_db_sms', { layer: 'B', record: d })");
        expect(body).toContain("WP.contactHtml('_db', { kind: 'debtor'");
        expect(body.indexOf('WFSms.applyToggle')).toBeGreaterThan(0);
        expect(body.indexOf('WFSms.applyToggle')).toBeLessThan(body.indexOf("DB.set('debtors', list)"));
        expect(body).toContain('phone: contact ? contact.phone');
        expect(body).toMatch(/if \(!sms\.ok\) \{[^}]*\breturn; \}/);
    });

    it('both forms take the second number from the contact fields and hand it to the same check as the first', () => {
        for (const [from, to] of [['function saveIncome()', 'function clearIncomeForm()'], ['function openDebtorModal(existing)', 'window.openDebtorModal = openDebtorModal']]) {
            const start = HTML.indexOf(from);
            const body = HTML.slice(start, HTML.indexOf(to, start));
            expect(body, from).toContain('if (contact.phone2) rec.phone2 = contact.phone2; else { delete rec.phone2; delete rec.phone2_at; }');
            expect(body, from).toMatch(/phone2: contact && (form|smsForm)\.enabled && contact\.phone2 \? contact\.phone2 : undefined/);
        }
    });

    it('an investment can be settled and closed, and re-opened, from its card; a closed one is listed as ended', () => {
        expect(HTML).toContain('function settleInvestment(id)');
        expect(HTML).toContain('function reopenInvestment(id)');
        const settle = HTML.slice(HTML.indexOf('function settleInvestment(id)'), HTML.indexOf('function reopenInvestment(id)'));
        expect(settle).toContain('showConfirm(');                                              // asks first: closing sends a text
        expect(settle).toContain('WFSms.closeInvestment(s, { now: Date.now(), todayISO: today() })');
        const list = HTML.slice(HTML.indexOf('function renderIncome()'), HTML.indexOf('async function confirmIncomeReceived'));
        expect(list).toContain("onclick=\"settleInvestment('");
        expect(list).toContain("onclick=\"reopenInvestment('");
        expect(list).toContain('const isClosed = (src) => Number(src.closedAt) > 0;');
        expect(list).toMatch(/activeArr = arr\.filter\(src => \{[^}]*!isClosed\(src\)/);
        expect(list).toMatch(/endedArr = arr\.filter\(src => \{[^}]*isClosed\(src\)/);
        const save = HTML.slice(HTML.indexOf('function saveIncome()'), HTML.indexOf('function clearIncomeForm()'));
        expect(save).toContain("rec.closedEndWas = rec.end || ''; rec.end = today();");        // an edit cannot leave a settled investment running
    });

    it('never mentions the gateway token: that name exists on the server only', () => {
        expect(HTML).not.toMatch(/TEXTLK/);
        for (const f of readdirSync(new URL('..', import.meta.url)).filter((n) => /^wealthflow-.*\.(js|mjs)$/.test(n))) {
            expect(read(f), f).not.toMatch(/TEXTLK_API_TOKEN\s*[=:]\s*['"][^'"]+['"]/);
        }
    });
});

describe('the server', () => {
    it('registers both endpoints with the router, so a path under /api reaches them', () => {
        expect(ROUTER).toMatch(/'sms-notify': \(\) => import\('\.\.\/sms-notify\.js'\)/);
        expect(ROUTER).toMatch(/'sms-sweep': \(\) => import\('\.\.\/sms-sweep\.js'\)/);
    });

    it('runs the sweep inside the sending window in Sri Lanka, and often enough that a number anywhere meets a run inside its own 08:00-20:00', () => {
        const crons = JSON.parse(read('vercel.json')).crons.filter((c) => c.path.split('?')[0] === '/api/sms-sweep');
        expect(crons.length).toBeGreaterThanOrEqual(1);
        const main = crons.find((c) => c.path === '/api/sms-sweep');
        expect(main).toBeTruthy();
        const [min0, hour0] = main.schedule.split(' ').map(Number);
        const colombo = (hour0 * 60 + min0 + 330) % 1440;                // UTC+5:30
        expect(colombo).toBeGreaterThanOrEqual(8 * 60);
        expect(colombo).toBeLessThan(20 * 60);
        // once a day each (a daily schedule is valid on every Vercel plan), and none of them a wildcard
        for (const c of crons) expect(c.schedule).toMatch(/^\d+ \d+ \* \* \*$/);
        const zones = { Auckland: 720, Sydney: 600, Tokyo: 540, Colombo: 330, Dubai: 240, Riyadh: 180, Paris: 60, London: 0, 'New York': -300, Chicago: -360, 'Los Angeles': -480, Honolulu: -600 };
        for (const [name, off] of Object.entries(zones)) {
            const inWindow = crons.some((c) => { const [m, h] = c.schedule.split(' ').map(Number); const local = (((h * 60 + m + off) % 1440) + 1440) % 1440; return local >= 8 * 60 && local < 20 * 60; });
            expect(inWindow, `${name} meets a sweep inside its window`).toBe(true);
        }
    });

    it('the sweep and the page-facing endpoint each say who may call them, in their own header', () => {
        expect(read('sms-sweep.js')).toMatch(/cronAuthorized/);
        expect(read('sms-notify.js')).toMatch(/smsAllowed/);
        expect(read('sms-notify.js')).toMatch(/identify/);
    });
});

describe('the rules', () => {
    it('keep the send ledger, the tenant links and their sessions away from every client, written out and not left to the default', () => {
        for (const path of ['match /wf-sms/{uid}/{document=**}', 'match /wf-tenants/{document=**}', 'match /wf-tenant-subjects/{document=**}']) {
            const at = RULES.indexOf(path);
            expect(at, path).toBeGreaterThan(0);
            expect(RULES.slice(at, at + 120)).toContain('allow read, write: if false;');
        }
    });

    it('make the owner-readable mirror read-only: a page that could write it could show itself a delivery that never happened', () => {
        expect(RULES).toMatch(/!\(collection in \['smsLog', /);
    });
});

describe('what ships is what is named', () => {
    it('keeps the environment variable names in one place, the gateway client', () => {
        const client = read('textlk.mjs');
        expect(client).toContain("TOKEN_ENV = 'TEXTLK_API_TOKEN'");
        expect(client).toContain("SENDER_ENV = 'TEXTLK_SENDER_ID'");
        expect(read('sms-access.mjs')).toContain('SMS_ALLOWED_EMAILS');
    });
});

describe('the Debtors screen: a part payment and the balance', () => {
    const fn = (name, next) => { const a = HTML.indexOf(`function ${name}(`); expect(a, name).toBeGreaterThan(0); const b = HTML.indexOf(next, a); return HTML.slice(a, b > a ? b : a + 8000); };

    it('offers Send balance only for a debtor whose texts are on and who still owes something, and routes it to one function', () => {
        expect(HTML).toMatch(/d\.sms_notifications_enabled === true && su\.outstanding > 0\) \? `<button[^`]*data-liq-bal=/);
        expect(HTML).toContain("b.onclick = () => _sendBalance(debtors[Number(b.getAttribute('data-liq-bal'))]);");
    });

    it('Send balance checks the pause BEFORE it asks, asks before it writes, reads the record again when the owner agrees, and writes only the request', () => {
        const body = fn('_sendBalance', 'function _settleDebtor');
        expect(body.indexOf('requestBalance(fresh')).toBeGreaterThan(0);
        expect(body.indexOf('requestBalance(fresh')).toBeLessThan(body.indexOf('showConfirm('));
        expect(body).toContain("DB.get('debtors')");
        expect(body).toContain('requestBalance(list[at]');
        expect(body).toContain('list[at] = r.record;');
        expect(body).not.toMatch(/addEvent|confirmEvent|events\s*[:=]/);                 // a request moves no money and changes no ledger
        expect(body).not.toMatch(/fetch\(|kickNow|sms-notify/);                          // the push that carries it nudges the server; asking early would read the old copy
    });

    it('a repayment is still logged as waiting unless the owner ticks that they can see the money, and the box starts unticked', () => {
        const body = fn('openDebtorEvent', 'window.openDebtorEvent');
        expect(body).toMatch(/id="_ev_now" style="[^"]*">/);
        expect(body).not.toMatch(/id="_ev_now"[^>]*checked/);
        expect(body).toContain('confirmed: countedNow,');
        expect(body).toContain("const countedNow = !isPay || !!(nowEl && nowEl.checked);");
        expect(body).toContain('waiting for your confirmation');
    });

    it('tells the owner what will be texted only when the texts are on', () => {
        const body = fn('openDebtorEvent', 'window.openDebtorEvent');
        expect(body).toContain("const smsOn = d.sms_notifications_enabled === true;");
        expect(body).toMatch(/\(smsOn \?/);
        expect(body).toContain('texted the amount and the balance that is left');
    });

    it('both ways of confirming say a text is queued, and only for a repayment on a debtor with the texts on', () => {
        expect(HTML).toMatch(/const texted = d\.sms_notifications_enabled === true && ev && ev\.kind === 'repayment';/);
        expect(HTML).toMatch(/const textedRow = list\[at\]\.sms_notifications_enabled === true && evRaw && evRaw\.kind === 'repayment';/);
    });

    it('the late-payment box is on the debtor form only, is passed to the one validator, and a reminder is refused before saving when there is no date to remind about', () => {
        const body = fn('openDebtorModal', 'window.openDebtorModal');
        expect(body).toContain("WFSms.blockHtml('_db_sms', { layer: 'B', record: d })");
        expect(body).toContain('remindLate: smsForm.remindLate');
        expect(body.indexOf('smsForm.remindLate && !(ov.querySelector(\'#_db_due\').value')).toBeGreaterThan(0);
        expect(body.indexOf('smsForm.remindLate && !(ov.querySelector(\'#_db_due\').value')).toBeLessThan(body.indexOf('WFSms.applyToggle('));
        // the investment form never offers it (layer A) and never passes the box
        expect(HTML).toContain("WFSms.blockHtml('i_sms', { layer: 'A', record: rec })");
    });
});
