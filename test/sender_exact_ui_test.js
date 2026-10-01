import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseHTML } from 'linkedom';
import { normalizeSender } from '../wealthflow-mail-senders.mjs';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name) {
    const start = html.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`Missing ${name}`);
    return html.slice(start, html.indexOf('\n        }', start) + 10);
}
function page(names = []) {
    const { document } = parseHTML('<html><body><div id="_sl_body"></div></body></html>');
    const context = vm.createContext({ document, window: { WFMailSenders: { normalizeSender } },
        currentUser: { uid: 'owner' }, requestAnimationFrame: fn => fn(), setTimeout: fn => fn(), notify: vi.fn(),
        _mailBootCheck: vi.fn(async () => {}),
        _mailSyncState: { stage: 'idle', error: null }, renderMailSync: vi.fn(),
        _senders: { stage: 'idle', pending: [], approved: [], blocked: [], legacyApproved: [], busy: '', error: null },
        _discover: { stage: 'idle' }, DISCOVERY_MONTHS: 24, _coverageStrip: () => '', _bankHuntPanel: () => '',
        _sendersLoad: vi.fn(), _sendersDo: vi.fn(async () => false), _ownedBanks: () => ['HNB', 'DFCC'],
        _wfEsc: value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]),
    });
    vm.runInContext(source('_exactStatementAddress'), context);
    for (const name of names) vm.runInContext(source(name), context);
    return context;
}

describe('exact statement sender settings', () => {
    it('requires an exact mailbox and rejects display strings or domains', () => {
        const p = page();
        expect(p._exactStatementAddress('STATEMENTS@HNB.LK')).toBe(true);
        for (const value of ['hnb.lk', '@hnb.lk', 'HNB <statements@hnb.lk>', 'broken@@hnb.lk', 'statements@localhost']) expect(p._exactStatementAddress(value)).toBe(false);
    });
    it('blocks invalid submissions before API calls and preserves an address after server failure', async () => {
        const p = page(['openSenderList']); p.openSenderList();
        const input = p.document.getElementById('_sl_addr');
        expect(input.type).toBe('email');
        input.value = 'hnb.lk';
        await p.document.getElementById('_sl_add').onclick();
        expect(p._sendersDo).not.toHaveBeenCalled();
        input.value = 'statements@hnb.lk';
        await p.document.getElementById('_sl_add').onclick();
        expect(input.value).toBe('statements@hnb.lk');
        expect(p._sendersDo).toHaveBeenCalledWith('add', 'statements@hnb.lk', { status: 'approved', name: '' });
    });
    it('does not count legacy domains or built-in names as approved bank coverage', () => {
        const p = page(['_senderCoverage']);
        p.window.WFAccounts = { bankNamesMatch: (a, b) => a === b };
        p._senders.approved = [{ id: 'hnb.lk', name: 'HNB' }, { id: 'statements@dfccbank.com', name: 'DFCC' }];
        p._senders.knownBanks = ['HNB', 'DFCC'];
        const result = p._senderCoverage();
        expect(result.covered).toBe(1); expect(Array.from(result.uncovered)).toEqual(['HNB']);
    });
    it('offers domain blocking while permitting approval only for exact address discoveries', () => {
        const p = page(['_senderFunnelOf', '_senderFunnelText', '_senderRow', '_senderBtn', 'renderSenderList']);
        p._senders.pending = [{ id: 'hnb.lk', name: 'HNB' }, { id: 'statements@dfccbank.com', name: 'DFCC' }];
        p.renderSenderList();
        const host = p.document.getElementById('_sl_body');
        expect(host.querySelector('[data-sact="approve"][data-sval="hnb.lk"]')).toBeNull();
        expect(host.querySelector('[data-sact="block"][data-sval="hnb.lk"]')).not.toBeNull();
        expect(host.querySelector('[data-sact="approve"][data-sval="statements@dfccbank.com"]')).not.toBeNull();
        expect(host.textContent).toContain('Statement processing is stopped until');
        expect(host.textContent).not.toContain('WealthFlow has to guess');
    });
    it('routes manual sync through the cloud worker before any legacy browser writes', async () => {
        const p = page();
        p.window.WFStatementCloud = { getState: () => ({ configured: true, saved: true }), sync: vi.fn(async () => ({ ok: true })), openReview: vi.fn() };
        // Evaluate the actual entry point. The legacy dependencies are absent:
        // reaching them would fail, exposing a missing early return.
        vm.runInContext('async ' + source('runMailSync'), p);
        await p.runMailSync();
        expect(p.window.WFStatementCloud.sync).toHaveBeenCalledOnce();
        expect(p._mailBootCheck).toHaveBeenCalledOnce();
        expect(p.window.WFStatementCloud.openReview).toHaveBeenCalledOnce();
    });
    it('never falls back to a competing browser writer after cloud sync failure', async () => {
        const p = page();
        p.window.WFStatementCloud = { getState: () => ({ configured: true, saved: true }), sync: vi.fn(async () => { throw new Error('temporary failure'); }), openReview: vi.fn() };
        vm.runInContext('async ' + source('runMailSync'), p);
        await p.runMailSync();
        expect(p.window.WFStatementCloud.openReview).not.toHaveBeenCalled();
        expect(p.notify).toHaveBeenCalledWith('Background statement sync could not complete. Statements remain pending for retry.', 'warn');
    });
    it('surfaces a refused cloud start instead of treating it as a successful check', async () => {
        const p = page();
        p.window.WFStatementCloud = { getState: () => ({ configured: true, saved: true }), sync: vi.fn(async () => ({ ok: false, reason: 'cloud-vault-required' })), friendly: vi.fn(() => 'Sign in to access your cloud statement vault.'), openReview: vi.fn() };
        vm.runInContext('async ' + source('runMailSync'), p);
        await p.runMailSync();
        expect(p.window.WFStatementCloud.openReview).not.toHaveBeenCalled();
        expect(p.notify).toHaveBeenCalledWith('Sign in to access your cloud statement vault.', 'warn');
    });
    it('checks unknown cloud state before choosing a writer', async () => {
        const p = page(); let checked = false;
        p.window.WFStatementCloud = { getState: () => ({ configured: checked ? true : null, saved: checked }), status: vi.fn(async () => { checked = true; }), sync: vi.fn(async () => ({ ok: true })), openReview: vi.fn() };
        vm.runInContext('async ' + source('runMailSync'), p);
        await p.runMailSync();
        expect(p.window.WFStatementCloud.status).toHaveBeenCalledOnce();
        expect(p.window.WFStatementCloud.sync).toHaveBeenCalledOnce();
    });
    it('refuses a device writer when unknown cloud status cannot be verified', async () => {
        const p = page();
        p.window.WFStatementCloud = { getState: () => ({ configured: null, saved: false }), status: vi.fn(async () => { throw new Error('identity unavailable'); }) };
        vm.runInContext('async ' + source('runMailSync'), p);
        await p.runMailSync();
        expect(p.window.WFStatementCloud.status).toHaveBeenCalledOnce();
        expect(p.notify).toHaveBeenCalledWith('Could not verify background statement processing. No competing device import was started; retry while signed in.', 'warn');
    });
});

describe('a sender row says how many EMAILS it sent and where they are, not how many times a scan walked past', () => {
    const rowText = (p, entry) => { p._senders.approved = [entry]; return p._senderRow(entry, '', null); };
    it('uses the state table when it has reported', () => {
        const p = page(['_senderFunnelOf', '_senderFunnelText', '_senderRow']);
        p.window.WFStatementCloud = { senderFunnel: () => [{ address: 'statements@dfccbank.com', total: 14, INGESTED: 12, PENDING: 1, PROCESSED: 0, REVIEW: 0, HELD: 0, REFUSED: 1, FAILED_VERIFICATION: 0 }] };
        const html = rowText(p, { id: 'statements@dfccbank.com', name: 'DFCC Bank', seenCount: 555 });
        expect(html).toContain('14 emails'); expect(html).toContain('12 filed'); expect(html).toContain('1 waiting'); expect(html).toContain('1 not statements');
        expect(html).not.toContain('555'); expect(html).not.toContain('seen');
    });
    it('a domain entry adds up every address under it', () => {
        const p = page(['_senderFunnelOf', '_senderFunnelText', '_senderRow']);
        p.window.WFStatementCloud = { senderFunnel: () => [{ address: 'a@dfccbank.com', total: 2, INGESTED: 2 }, { address: 'b@mail.dfccbank.com', total: 3, INGESTED: 1, FAILED_VERIFICATION: 2 }, { address: 'c@dfccbank.com.evil.example', total: 9, INGESTED: 9 }] };
        const html = rowText(p, { id: 'dfccbank.com', name: 'DFCC', seenCount: 99 });
        expect(html).toContain('5 emails'); expect(html).toContain('3 filed'); expect(html).toContain('2 blocked as unauthenticated');
    });
    it('before the first sync has reported, the old counter is kept but called what it is', () => {
        const p = page(['_senderFunnelOf', '_senderFunnelText', '_senderRow']);
        p.window.WFStatementCloud = { senderFunnel: () => [] };
        expect(rowText(p, { id: 'statements@dfccbank.com', name: 'DFCC Bank', seenCount: 555 })).toContain('scanned 555 times');
        p.window.WFStatementCloud = undefined;
        expect(rowText(p, { id: 'statements@dfccbank.com', name: 'DFCC Bank', seenCount: 1 })).toContain('scanned 1 time');
    });
});

