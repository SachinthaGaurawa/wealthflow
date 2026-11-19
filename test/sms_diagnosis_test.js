/* =============================================================================
 * test/sms_diagnosis_test.js — what the pasted diagnosis says about text messages
 * -----------------------------------------------------------------------------
 * Owner, 2026-11-19: "messages are not going, is it the gateway or its hosting?". The diagnosis had nothing about texts, so the answer needed the
 * owner's own screens. smsDiagnosis() names the first thing that explains silence, from counts and kinds only: never a number, a name or a body.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import { smsDiagnosis, gatewayWords, panelHtml, countOn } from '../wealthflow-sms.js';

const NOW = Date.parse('2026-11-19T15:20:00Z');
const user = { debtors: [{ id: 'd1', name: 'Secret Name', phone: '+94711234567', sms_notifications_enabled: true }], income: [], settings: {} };
const base = { user, now: NOW, signedIn: true };

describe('smsDiagnosis', () => {
    it('is silent about people: no phone, no name, no body can appear in it', () => {
        const rows = [{ id: 'a', status: 'sent', kind: 'B.receipt', to: '+94 71 *** 4567', body: 'Hello Secret Name', sentAt: NOW - 60000, occurredAt: NOW - 61000 }];
        const text = JSON.stringify(smsDiagnosis({ ...base, rows, status: { configured: true, units: 40, unitsAt: NOW - 5000 } }));
        expect(text).not.toMatch(/Secret Name|94711234567|4567|Hello/);
    });

    it('counts the log by status and says why texts are waiting', () => {
        const rows = [
            { id: '1', status: 'queued', kind: 'B.receipt', occurredAt: NOW - 3600e3, error: { kind: 'credit', message: 'no units' } },
            { id: '2', status: 'queued', kind: 'B.late', occurredAt: NOW - 1000, nextAttemptAt: NOW + 3600e3 },
            { id: '3', status: 'failed', kind: 'B.receipt', occurredAt: NOW - 500, error: { kind: 'invalid-recipient' } },
            { id: '4', status: 'sent', kind: 'B.receipt', sentAt: NOW - 120000, occurredAt: NOW - 130000 },
            { id: '_status', status: 'x' },
        ];
        const d = smsDiagnosis({ ...base, rows });
        expect(d.log.rows).toBe(4);
        expect(d.log.byStatus).toEqual({ queued: 2, failed: 1, sent: 1 });
        expect(d.log.troubleBy).toEqual({ 'queued:credit': 1, 'queued:scheduled-for-later': 1, 'failed:invalid-recipient': 1 });
        expect(d.log.newestSentAgoSec).toBe(120);
        expect(d.log.oldestWaitingAgoSec).toBe(3600);
        expect(d.verdict).toBe('texts are waiting for Text.lk credit');
    });

    it('puts a gateway fault ahead of everything else', () => {
        const d = smsDiagnosis({ ...base, rows: [], gateway: { at: NOW - 3000, configured: true, reachable: false, failure: 'network' } });
        expect(d.verdict).toMatch(/could not reach Text\.lk/);
        expect(d.gateway.checkedAgoSec).toBe(3);
        expect(smsDiagnosis({ ...base, gateway: { configured: true, tokenAccepted: false, reachable: true, failure: 'auth' } }).verdict).toMatch(/refused the token/);
        expect(smsDiagnosis({ ...base, gateway: { configured: true, tokenAccepted: true, reachable: true, lowCredit: true } }).verdict).toMatch(/out of credit/);
        expect(smsDiagnosis({ ...base, gateway: { configured: false } }).verdict).toMatch(/token is not set/);
    });

    it('says so when no record has the switch on and nothing is owed', () => {
        const d = smsDiagnosis({ ...base, user: { debtors: [{ id: 'x', sms_notifications_enabled: false }], income: [], settings: {} } });
        expect(d.recordsWithSwitchOn).toBe(0);
        expect(d.verdict).toMatch(/nothing is owed/);
    });

    it('reports a refused account and an unacknowledged change', () => {
        expect(smsDiagnosis({ ...base, notifier: { disabled: true } }).verdict).toMatch(/403|allow-list/);
        const d = smsDiagnosis({ ...base, notifier: { lastKickAt: NOW - 90000, lastError: 'Could not reach the server.' }, rows: [{ id: 'z', status: 'sent', sentAt: 1, occurredAt: 1 }] });
        expect(d.notifier.lastLookAgoSec).toBe(90);
        expect(d.verdict).toMatch(/last look at the server failed/);
        expect(smsDiagnosis({ ...base, notifier: {}, owes: true, rows: [{ id: 'z', status: 'sent', sentAt: 1, occurredAt: 1 }] }).verdict).toMatch(/has not yet reached the server/);
    });

    it('carries the last answer of the server and the credit reading with its age', () => {
        const d = smsDiagnosis({ ...base, rows: [{ id: 'z', status: 'sent', sentAt: 1, occurredAt: 1 }], notifier: { lastKickAt: NOW - 1000, lastSummary: { derived: 3, enqueued: 1, sent: 1, held: 0, retry: 0, failed: 0, cancelled: 0, remaining: 0, configured: true, phases: { total: 99 } } }, status: { configured: true, units: 12, unitsAt: NOW - 60000, autoRunAt: NOW - 7200e3, issues: [{ reason: 'no-phone', recordId: 'd1' }] } });
        expect(d.notifier.lastAnswer).toEqual({ derived: 3, enqueued: 1, sent: 1, held: 0, retry: 0, failed: 0, cancelled: 0, remaining: 0 });
        expect(d.status).toMatchObject({ units: 12, unitsReadAgoSec: 60, dailySweepAgoSec: 7200, issues: ['no-phone'] });
        expect(JSON.stringify(d)).not.toContain('d1');
    });

    it('says why a settled or repaid debtor can be silent on purpose, as counts only', () => {
        const rows = [{ id: 'z', status: 'sent', sentAt: 1, occurredAt: 1 }];
        const waiting = { debtors: [
            { id: 'd1', name: 'Secret Name', phone: '+94711234567', sms_notifications_enabled: true, sms_enabled_at: NOW - 86400e3, events: [
                { id: 'e1', kind: 'lent', amount: 5000, date: '2026-11-01', at: NOW - 3 * 86400e3 },
                { id: 'e2', kind: 'repayment', amount: 5000, date: '2026-11-19', confirmed: false } ] },
            { id: 'd2', name: 'Other Name', sms_notifications_enabled: false, events: [] },
        ], income: [], settings: {} };
        const d = smsDiagnosis({ ...base, user: waiting, rows });
        expect(d.debtors).toEqual({ total: 2, switchOn: 1, switchOff: 1, unconfirmedEntries: 1, entriesOlderThanSwitch: 1 });
        expect(d.verdict).toMatch(/not confirmed yet, and a text is sent only for confirmed money/);
        expect(d.verdict).toMatch(/1 of 2 debtors has the SMS switch off/);
        expect(d.verdict).toMatch(/dated before the switch was turned on/);
        expect(JSON.stringify(d)).not.toMatch(/Secret Name|Other Name|94711234567|e2/);
        // nothing silent: the plain verdict stays plain
        expect(smsDiagnosis({ ...base, rows }).verdict).toBe('nothing wrong found');
    });

    it('never throws on junk', () => {
        expect(() => smsDiagnosis({ rows: null, status: 5, notifier: 'x', gateway: [], user: null })).not.toThrow();
        expect(() => smsDiagnosis()).not.toThrow();
    });
});

describe('the gateway words', () => {
    it('say what to do', () => {
        expect(gatewayWords({ configured: true, reachable: true, tokenAccepted: true })).toMatch(/answered and accepted/);
        expect(gatewayWords({ configured: true, failure: 'sender' })).toMatch(/sender ID/);
        expect(gatewayWords({ error: 'x' })).toBe('');
        expect(gatewayWords(null)).toBe('');
    });
});

describe('the panel', () => {
    it('has a button that checks the gateway and shows the last answer', () => {
        const html = panelHtml({ gateway: { at: NOW, configured: true, reachable: true, tokenAccepted: true }, now: NOW });
        expect(html).toContain('WFSms.testGateway()');
        expect(html).toContain('Text.lk answered and accepted the token.');
        expect(panelHtml({ gateway: { at: NOW, error: 'no answer in 20 s' } })).toContain('The check could not be made: no answer in 20 s.');
        expect(panelHtml({})).toContain('Check the SMS gateway');
    });
});

describe('counting', () => {
    it('countOn is what the diagnosis reports', () => {
        expect(countOn(user)).toBe(1);
    });
});
