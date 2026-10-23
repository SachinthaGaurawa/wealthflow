/* =============================================================================
 * test/contacts_service_test.js — the one contact-selection service (wealthflow-people.js: pickContactResult)
 * -----------------------------------------------------------------------------
 * Owner, 2026-10-23: the Contacts button must open the device's own contacts wherever the device allows it. Two things can open them: Chrome's Contact Picker
 * (Android) and the WealthFlow app's own picker (native/, a Capacitor build: iPhone and Android). The service picks the one that exists, answers with an explicit
 * outcome, and never opens a file dialog or touches a form. Pinned here, with the native bridge and the browser API replaced by stand-ins:
 *   - which picker is chosen, and that nothing is "supported" in a plain Safari or desktop browser;
 *   - selected / cancelled / no-phone-number / permission-denied / unsupported / error / busy, for both pickers;
 *   - a native answer in an unexpected shape is an error, never a number;
 *   - a second request while one is open does not open another, and the lock is released afterwards, whatever happened;
 *   - nothing but the name and the numbers the person chose comes out.
 * ===========================================================================*/
import { describe, it, expect } from 'vitest';
import { contactPickerSupported, contactPickerKind, pickContactResult, pickContacts } from '../wealthflow-people.js';

/** A window the way the app shell shows it: Capacitor present, the plugin answering with `answer` (a value, or a function returning a promise). */
function appWindow(answer, { available = true, native = true } = {}) {
    const calls = { n: 0 };
    const plugin = { pick: () => { calls.n += 1; return typeof answer === 'function' ? answer() : Promise.resolve(answer); } };
    const w = {
        navigator: {},
        Capacitor: {
            isNativePlatform: () => native,
            isPluginAvailable: (n) => available && n === 'WealthFlowContactPicker',
            registerPlugin: () => plugin,
        },
    };
    return { w, calls };
}
/** A window with Chrome's picker. */
function chromeWindow(select) {
    const calls = { n: 0, args: null };
    const w = { ContactsManager: function ContactsManager() {}, navigator: { contacts: { select: (props, opts) => { calls.n += 1; calls.args = [props, opts]; return select(); } } } };
    return { w, calls };
}

describe('which picker', () => {
    it('is none in a plain browser: nothing is promised', () => {
        expect(contactPickerSupported({ navigator: {} })).toBe(false);
        expect(contactPickerKind({ navigator: {} })).toBe('');
        expect(contactPickerSupported(null)).toBe(false);
        // a Safari that only has a clipboard and a Capacitor-less page
        expect(contactPickerKind({ navigator: { clipboard: {} }, Capacitor: {} })).toBe('');
    });
    it('is the app picker inside the app shell', () => {
        const { w } = appWindow({ cancelled: true });
        expect(contactPickerSupported(w)).toBe(true);
        expect(contactPickerKind(w)).toBe('native');
    });
    it('is Chrome\'s picker where it exists', () => {
        const { w } = chromeWindow(async () => []);
        expect(contactPickerKind(w)).toBe('web');
    });
    it('is the app picker even when the page also has a web picker (the app one asks for no permission)', () => {
        const { w } = appWindow({ cancelled: true });
        w.ContactsManager = function ContactsManager() {}; w.navigator.contacts = { select: () => Promise.resolve([]) };
        expect(contactPickerKind(w)).toBe('native');
    });
    it('is none when the shell lacks the plugin, or Capacitor is only the web build', () => {
        expect(contactPickerKind(appWindow({}, { available: false }).w)).toBe('');
        expect(contactPickerKind(appWindow({}, { native: false }).w)).toBe('');
        expect(contactPickerKind({ navigator: {}, Capacitor: { isNativePlatform: () => { throw new Error('boom'); } } })).toBe('');
    });
});

describe('the app picker', () => {
    it('selected: one number, one contact', async () => {
        const { w, calls } = appWindow({ cancelled: false, name: ' Kamal  Silva ', number: '077 555 1212' });
        const r = await pickContactResult(w);
        expect(r).toEqual({ status: 'selected', source: 'native', contacts: [{ name: 'Kamal Silva', tels: ['077 555 1212'] }] });
        expect(calls.n).toBe(1);
    });
    it('selected: several numbers are kept apart, never joined', async () => {
        const { w } = appWindow({ cancelled: false, name: 'Ahmed', numbers: ['0771112222', '+94 71 234 5678', '0771112222'] });
        const r = await pickContactResult(w);
        expect(r.contacts[0].tels).toEqual(['0771112222', '+94 71 234 5678']);
    });
    it('keeps a leading zero and a plus', async () => {
        const { w } = appWindow({ cancelled: false, name: 'X', number: '0771234567' });
        expect((await pickContactResult(w)).contacts[0].tels[0]).toBe('0771234567');
        const { w: w2 } = appWindow({ cancelled: false, name: 'X', number: '+447911123456' });
        expect((await pickContactResult(w2)).contacts[0].tels[0]).toBe('+447911123456');
    });
    it('cancelled: nothing comes back', async () => {
        const { w } = appWindow({ cancelled: true });
        expect(await pickContactResult(w)).toEqual({ status: 'cancelled', contacts: [], source: 'native' });
        expect(await pickContacts(w)).toEqual([]);
    });
    it('a contact without a number is recoverable: the page can name them', async () => {
        const { w } = appWindow({ cancelled: false, name: 'No Number' });
        const r = await pickContactResult(w);
        expect(r.status).toBe('no-phone-number');
        expect(r.contacts).toEqual([{ name: 'No Number', tels: [] }]);
    });
    it('nothing chosen (empty answer) is a cancel', async () => {
        const { w } = appWindow({ cancelled: false });
        expect((await pickContactResult(w)).status).toBe('cancelled');
    });
    it('permission denied, in either spelling, says what to do and opens nothing', async () => {
        for (const err of [{ code: 'PERMISSION_DENIED' }, { message: 'Permission denied by the user' }, { code: 'restricted' }]) {
            const { w } = appWindow(() => Promise.reject(Object.assign(new Error(err.message || 'x'), err)));
            const r = await pickContactResult(w);
            expect(r.status).toBe('permission-denied');
            expect(r.userMessage).toMatch(/paste/i);
            expect(r.contacts).toEqual([]);
        }
    });
    it('a plugin that reports a cancel as an error is still a cancel', async () => {
        const { w } = appWindow(() => Promise.reject(Object.assign(new Error('User cancelled'), { code: 'CANCELLED' })));
        expect((await pickContactResult(w)).status).toBe('cancelled');
    });
    it('any other plugin failure is an error with words fit to show', async () => {
        const { w } = appWindow(() => Promise.reject(new Error('java.lang.NullPointerException at x.y')));
        const r = await pickContactResult(w);
        expect(r.status).toBe('error');
        expect(r.userMessage).toMatch(/paste/i);
        expect(JSON.stringify(r)).not.toMatch(/NullPointer/);
    });
    it('an answer in an unexpected shape is an error, never a number', async () => {
        for (const bad of [null, undefined, 'tel:0771234567', 42, [], {}, { number: 5 }, { name: 7, number: '0771234567' }, { numbers: 'x' }, { numbers: [1, 2] }, { weird: true }]) {
            const { w } = appWindow(bad);
            const r = await pickContactResult(w);
            expect(r.status, JSON.stringify(bad)).toBe('error');
            expect(r.contacts).toEqual([]);
        }
    });
    it('only the name and the numbers are passed on: nothing else the plugin sent', async () => {
        const { w } = appWindow({ cancelled: false, name: 'A', number: '0771234567', email: 'a@b.c', photo: 'data:x', address: 'Colombo', id: 7 });
        const r = await pickContactResult(w);
        expect(Object.keys(r.contacts[0]).sort()).toEqual(['name', 'tels']);
        expect(JSON.stringify(r)).not.toMatch(/a@b\.c|Colombo|data:x/);
    });
});

describe('Chrome\'s picker', () => {
    it('selected, asking only for the name and the number', async () => {
        const { w, calls } = chromeWindow(async () => [{ name: ['Nimali'], tel: ['071 222 3344'] }]);
        const r = await pickContactResult(w, { multiple: false });
        expect(r).toEqual({ status: 'selected', source: 'web', contacts: [{ name: 'Nimali', tels: ['071 222 3344'] }] });
        expect(calls.args).toEqual([['name', 'tel'], { multiple: false }]);
    });
    it('cancel, refusal and the other failures', async () => {
        const named = (name) => chromeWindow(() => Promise.reject(Object.assign(new Error('x'), { name })));
        expect((await pickContactResult(named('AbortError').w)).status).toBe('cancelled');
        expect((await pickContactResult(named('NotAllowedError').w)).status).toBe('permission-denied');
        const sec = await pickContactResult(named('SecurityError').w);
        expect(sec.status).toBe('error'); expect(sec.userMessage).toMatch(/tap/i);
        const open = await pickContactResult(named('InvalidStateError').w);
        expect(open.status).toBe('error'); expect(open.userMessage).toMatch(/already open/i);
        expect((await pickContactResult(named('TypeError').w)).status).toBe('error');
    });
    it('no number is recoverable', async () => {
        const { w } = chromeWindow(async () => [{ name: ['Nobody'], tel: [] }]);
        expect((await pickContactResult(w)).status).toBe('no-phone-number');
    });
});

describe('unsupported', () => {
    it('says so, with words, and calls nothing', async () => {
        const r = await pickContactResult({ navigator: {} });
        expect(r).toMatchObject({ status: 'unsupported', contacts: [] });
        expect(r.userMessage).toMatch(/paste/i);
        await expect(pickContacts({ navigator: {} })).rejects.toMatchObject({ status: 'unsupported', userMessage: expect.stringMatching(/paste/i) });
    });
});

describe('one picker at a time', () => {
    it('a second request while one is open is busy and calls nothing; the lock is released afterwards', async () => {
        let release;
        const { w, calls } = appWindow(() => new Promise((res) => { release = res; }));
        const first = pickContactResult(w);
        await Promise.resolve();
        const second = await pickContactResult(w);
        const third = await pickContactResult(w);
        expect(second).toEqual({ status: 'busy', contacts: [] });
        expect(third.status).toBe('busy');
        expect(calls.n).toBe(1);
        release({ cancelled: false, name: 'A', number: '0771234567' });
        expect((await first).status).toBe('selected');
        // released: the next tap opens a picker again
        const { w: w2, calls: c2 } = appWindow({ cancelled: true });
        expect((await pickContactResult(w2)).status).toBe('cancelled');
        expect(c2.n).toBe(1);
    });
    it('the lock is released after a failure too', async () => {
        const { w } = appWindow(() => Promise.reject(new Error('boom')));
        expect((await pickContactResult(w)).status).toBe('error');
        const ok = appWindow({ cancelled: false, name: 'B', number: '0712223344' });
        expect((await pickContactResult(ok.w)).status).toBe('selected');
    });
    it('pickContacts: busy reads as "nothing chosen", never as an error', async () => {
        let release;
        const { w } = appWindow(() => new Promise((res) => { release = res; }));
        const first = pickContactResult(w);
        await Promise.resolve();
        expect(await pickContacts(w)).toEqual([]);
        release({ cancelled: true });
        await first;
    });
});
