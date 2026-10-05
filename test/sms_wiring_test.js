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
        expect(body).toContain("['sms_notifications_enabled', 'sms_enabled_at', 'phone', 'nic', 'personId'].forEach(k => { if (prevRec[k] !== undefined) rec[k] = prevRec[k]; });");
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

    it('runs the sweep once a day, inside the sending window in Sri Lanka', () => {
        const cron = JSON.parse(read('vercel.json')).crons.find((c) => c.path === '/api/sms-sweep');
        expect(cron).toBeTruthy();
        const [min, hour] = cron.schedule.split(' ').map(Number);
        const colombo = (hour * 60 + min + 330) % 1440;                  // UTC+5:30
        expect(colombo).toBeGreaterThanOrEqual(8 * 60);
        expect(colombo).toBeLessThan(20 * 60);
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
