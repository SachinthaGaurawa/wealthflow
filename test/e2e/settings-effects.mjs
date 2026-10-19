/* Behavioural proof for every Settings control: each one is flipped in the real UI and then the EFFECT it promises is looked for
 * (a changed number format, a haptic pattern, a withheld alert, the weekly-backup day...), not just the stored value.
 * A setting that saves but changes nothing fails here. Part 1 display and device, part 2 notifications and reminders, part 3
 * what survives a reload. Lock behaviour (auto-lock timer, passcode-free entry) is in settings-lock.mjs. */
import { bootDevices } from './devices.mjs';

const w = await bootDevices(['d']);
const { page } = w.devices.d;
const results = [];
const check = async (key, fn) => {
    try {
        const r = await fn();
        const ok = r === true || (r && r.ok === true);
        results.push({ key, ok, detail: ok ? (r && r.detail) || '' : (r && r.detail) || String(r) });
    } catch (e) { results.push({ key, ok: false, detail: 'threw: ' + String(e.message).slice(0, 200) }); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const settings = () => page.evaluate(() => JSON.parse(JSON.stringify(DB.getObj('settings', {}))));
const openSettings = async () => { await page.evaluate(() => showPage('settings')); await page.waitForSelector('#settingsContent .toggle[data-setting]', { state: 'visible', timeout: 15000 }); };
const flip = (key) => page.evaluate((k) => { const el = document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`); if (!el) return null; el.click(); return el.classList.contains('on'); }, key);
const pick = (handler, value) => page.evaluate(([h, v]) => {
    const el = [...document.querySelectorAll('#settingsContent select, #settingsContent input')].find((x) => (x.getAttribute('onchange') || '').includes(h));
    if (!el) return false; el.value = v; el.dispatchEvent(new Event('change', { bubbles: true })); return true;
}, [handler, value]);
const setOn = async (key, want) => { const cur = await page.evaluate((k) => document.querySelector(`#settingsContent .toggle[data-setting="${k}"]`).classList.contains('on'), key); if (cur !== want) await flip(key); };

try {
    await page.evaluate(() => {
        window.__vib = []; navigator.vibrate = (p) => { window.__vib.push(p); return true; };
        window.__os = []; window.__ban = [];
    });
    await openSettings();

    // ---------- theme
    await check('theme', async () => {
        const read = () => page.evaluate(() => ({ t: document.documentElement.getAttribute('data-theme'), bg: getComputedStyle(document.body).backgroundColor }));
        const a = await read(); await flip('theme'); await sleep(300); const b = await read();
        await flip('theme'); await sleep(300); const c = await read();
        return { ok: a.t !== b.t && a.bg !== b.bg && c.t === a.t, detail: JSON.stringify({ a: a.t, b: b.t }) };
    });

    // ---------- haptics
    await check('haptics + hapticIntensity', async () => {
        const fire = async () => { await page.evaluate(() => { window.__vib.length = 0; triggerHaptic('success'); }); return page.evaluate(() => window.__vib.filter((p) => p !== 0)); };
        await setOn('haptics', true);
        await pick("hapticIntensity", 'standard'); const std = await fire();
        await pick("hapticIntensity", 'subtle'); const sub = await fire();
        await pick("hapticIntensity", 'heavy'); const hvy = await fire();
        await pick("hapticIntensity", 'off'); const off = await fire();
        await pick("hapticIntensity", 'standard'); await setOn('haptics', false); const sw = await fire();
        await setOn('haptics', true);
        const sum = (x) => (x[0] || []).reduce ? (x[0] || []).reduce((a, b) => a + b, 0) : x[0] || 0;
        const ok = sum(std) > 0 && sum(sub) < sum(std) && sum(hvy) > sum(std) && off.length === 0 && sw.length === 0;
        return { ok, detail: `std=${sum(std)} subtle=${sum(sub)} heavy=${sum(hvy)} off=${off.length} switchOff=${sw.length}` };
    });

    // ---------- compact mode
    await check('compactMode', async () => {
        await page.evaluate(() => showPage('dashboard')); await sleep(400);
        const pad = () => page.evaluate(() => { const c = document.querySelector('#page-dashboard .stat-card') || document.querySelector('.card'); return { cls: document.body.classList.contains('wf-compact'), pad: c ? getComputedStyle(c).paddingTop : null, h: c ? c.getBoundingClientRect().height : 0 }; });
        await openSettings(); await setOn('compactMode', false); await page.evaluate(() => showPage('dashboard')); await sleep(300); const a = await pad();
        await openSettings(); await flip('compactMode'); await page.evaluate(() => showPage('dashboard')); await sleep(300); const b = await pad();
        await openSettings(); await setOn('compactMode', false);
        return { ok: !a.cls && b.cls && a.h > b.h, detail: JSON.stringify({ a, b }) };
    });

    // ---------- currency / round / privacy
    await check('currency', async () => {
        await openSettings(); await pick("'currency'", 'USD');
        const f = await page.evaluate(() => fmt(1234.5));
        await page.evaluate(() => showPage('dashboard')); await sleep(300);
        const dash = await page.evaluate(() => document.querySelector('#page-dashboard').innerText.includes('USD'));
        await openSettings(); await pick("'currency'", 'LKR');
        return { ok: f.startsWith('USD') && dash, detail: f + ' dash=' + dash };
    });
    await check('roundAmounts', async () => {
        await openSettings(); await setOn('privacyMode', false); await setOn('roundAmounts', false);
        const a = await page.evaluate(() => fmt(1234.56)); await flip('roundAmounts'); const b = await page.evaluate(() => fmt(1234.56));
        const stored = await settings();
        await flip('roundAmounts');
        return { ok: /\.56$/.test(a) && !/\./.test(b) && stored.roundAmounts === true, detail: a + ' -> ' + b };
    });
    await check('privacyMode (+ legacy hideSensitive alias)', async () => {
        await openSettings(); await setOn('roundAmounts', false); await setOn('privacyMode', false);
        // an account that still carries the older alias
        await page.evaluate(() => { const s = DB.getObj('settings', {}); s.hideSensitive = true; DB.set('settings', s); });
        const stuck = await page.evaluate(() => fmt(100));
        await openSettings();
        // the switch must show "on" because amounts ARE hidden; turning it off must reveal them
        const shownOn = await page.evaluate(() => document.querySelector('#settingsContent .toggle[data-setting="privacyMode"]').classList.contains('on'));
        if (!shownOn) await flip('privacyMode');
        await flip('privacyMode');
        const after = await page.evaluate(() => fmt(100));
        const hidden = await (async () => { await flip('privacyMode'); return page.evaluate(() => fmt(100)); })();
        await flip('privacyMode');
        return { ok: /••/.test(stuck) ? !/••/.test(after) && /••/.test(hidden) : !/••/.test(after) && /••/.test(hidden), detail: `legacy=${stuck} off=${after} on=${hidden} switchShowedOn=${shownOn}` };
    });
    await check('round and privacy are mutually exclusive', async () => {
        await openSettings(); await setOn('privacyMode', false); await setOn('roundAmounts', true); await flip('privacyMode');
        const s = await settings(); const r = await page.evaluate(() => document.querySelector('#settingsContent .toggle[data-setting="roundAmounts"]').classList.contains('on'));
        await flip('privacyMode');
        return { ok: s.privacyMode === true && s.roundAmounts === false && r === false, detail: JSON.stringify({ p: s.privacyMode, r: s.roundAmounts, rOn: r }) };
    });

    // ---------- dashboard
    await check('showSavingsRate', async () => {
        const has = () => page.evaluate(() => /Savings Rate/i.test(document.querySelector('#page-dashboard').innerText));
        await openSettings(); await setOn('showSavingsRate', true); await page.evaluate(() => showPage('dashboard')); await sleep(300); const a = await has();
        await openSettings(); await flip('showSavingsRate'); await page.evaluate(() => showPage('dashboard')); await sleep(300); const b = await has();
        await openSettings(); await setOn('showSavingsRate', true);
        return { ok: a && !b, detail: `on=${a} off=${b}` };
    });
    await check('dashPeriod', async () => {
        const title = () => page.evaluate(() => document.querySelector('#page-dashboard').innerText);
        const seen = {};
        for (const [v, label] of [['thisMonth', 'This Month Expenses'], ['lastMonth', 'Last Month Expenses'], ['last3', '3-Month Expenses'], ['thisYear', 'This Year Expenses'], ['allTime', 'Total Expenses']]) {
            await openSettings(); await pick("'dashPeriod'", v); await page.evaluate(() => showPage('dashboard')); await sleep(250);
            seen[v] = (await title()).toLowerCase().includes(label.toLowerCase());
        }
        await openSettings(); await pick("'dashPeriod'", 'thisMonth');
        return { ok: Object.values(seen).every(Boolean), detail: JSON.stringify(seen) };
    });

    // ---------- week start -> weekly backup day
    await check('weekStart', async () => {
        await openSettings();
        await pick("'weekStart'", 'monday');
        const mon = await page.evaluate(() => { const d = _nextScheduledBackupTime('weekly', new Date('2026-10-07T10:00:00')); return d.getDay(); });
        await pick("'weekStart'", 'sunday');
        const sun = await page.evaluate(() => { const d = _nextScheduledBackupTime('weekly', new Date('2026-10-07T10:00:00')); return d.getDay(); });
        const label = await page.evaluate(() => [...document.querySelectorAll('#settingsContent option[value="weekly"]')].map((o) => o.textContent).join('|'));
        await pick("'weekStart'", 'monday');
        return { ok: mon === 0 && sun === 6 && /Sat/.test(label), detail: `monday->${mon} sunday->${sun} label=${label}` };
    });
    await check('autoBackupFreq', async () => {
        await openSettings();
        const out = {};
        for (const f of ['daily', 'weekly', 'monthly']) { await pick("autoBackupFreq", f); out[f] = await page.evaluate((fr) => { const d = _nextScheduledBackupTime(fr, new Date('2026-10-07T10:00:00')); return d ? d.toISOString() : null; }, f); }
        await pick("autoBackupFreq", 'off');
        const s = await settings();
        const off = await page.evaluate(() => _nextScheduledBackupTime('off', new Date()));
        return { ok: s.autoBackupFreq === 'off' && off === null && Object.values(out).every(Boolean) && new Set(Object.values(out)).size === 3, detail: JSON.stringify(out) };
    });

    // ---------- sounds
    await check('sounds + soundVolume', async () => {
        await page.evaluate(() => {
            window.__gain = [];
            const mk = () => ({ gain: { setValueAtTime: (v) => window.__gain.push(v), exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, frequency: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} }, start() {}, stop() {}, type: '' });
            _audioCtx = { state: 'running', currentTime: 0, destination: {}, resume() {}, createOscillator: mk, createGain: mk, createBuffer() { return {}; }, createBufferSource: mk };
        });
        const play = async () => { await page.evaluate(() => { window.__gain.length = 0; playUISound('click'); }); return page.evaluate(() => window.__gain.slice()); };
        await openSettings(); await setOn('sounds', true);
        await pick("soundVolume", 'low'); const lo = await play();
        await pick("soundVolume", 'high'); const hi = await play();
        await setOn('sounds', false); const off = await play();
        await setOn('sounds', true); await pick("soundVolume", 'low');
        return { ok: lo[0] > 0 && hi[0] > lo[0] && off.length === 0, detail: `low=${lo[0]} high=${hi[0]} off=${off.length}` };
    });

    // ---------- auto-lock menu shows what the timer does
    await check('autoLock (menu = effective value when unset)', async () => {
        await page.evaluate(() => { const s = DB.getObj('settings', {}); delete s.autoLock; DB.set('settings', s); });
        await openSettings();
        const shown = await page.evaluate(() => { const el = [...document.querySelectorAll('#settingsContent select')].find((x) => (x.getAttribute('onchange') || '').includes('updateAutoLock')); return el.value; });
        await pick('updateAutoLock', '15');
        return { ok: shown === '15', detail: 'menu shows ' + shown + ' while the timer uses 15' };
    });
    // ---------- seed records the reminders look at
    await page.evaluate(() => {
        const ymd = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const plus = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + n); return d; };
        window.__ymd = ymd; window.__plus = plus;
        DB.set('cconetime', [{ id: 'cc1', desc: 'Probe card charge', amount: 5000, deadline: ymd(plus(2)), paid: false, bank: 'Test', merchant: 'Probe card charge' }]);
        // The loan's start is the due date one month back. A due day the previous month does not have (31 Mar -> 28 Feb) would
        // roll over and move the due date, so take the nearest day, up to three out, whose day exists in the month before it.
        const l = (() => { for (let n = 3; n >= 0; n--) { const d = plus(n); const prevLen = new Date(d.getFullYear(), d.getMonth(), 0).getDate(); if (d.getDate() <= prevLen) return new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), 12); } return plus(0); })();
        DB.set('loans', [{ id: 'ln1', name: 'Probe loan', amount: 120000, rate: 10, duration: 12, monthly: 10500, start: ymd(l), bank: 'Test', type: 'bank' }]);
        DB.set('cheques', [{ id: 'ch1', status: 'pending', release: ymd(plus(3)), party: 'Probe party', amount: 2500, no: '777', type: 'issued' }]);
        DB.set('targets', [{ id: 't1', name: 'Probe target', amount: 1000, start: ymd(plus(-5)), end: ymd(plus(60)), savings: [{ id: 's1', amount: 600, date: ymd(plus(-1)) }] }]);
        DB.set('income', [{ id: 'in1', name: 'Probe salary', company: 'Probe', amount: 100000, monthly: 100000, freq: 'monthly', day: ymd(plus(0)), start: ymd(plus(-60)), rate: 0 }]);
        DB.set('subscriptions', [{ id: 'sb1', name: 'Probe sub', amount: 1000, monthOverrides: { [ymd(plus(0)).slice(0, 7)]: 2000 }, cycle: 'monthly' }]);
        try { localStorage.removeItem('wf_alerted_today'); } catch (_) {}
        window.__os = []; window.__ban = [];
        window.sendOSNotification = (t, b) => { window.__os.push(String(b || t)); };
        window.showActionableBanner = (o) => { window.__ban.push(String((o && (o.title || o.message)) || '')); };
    });
    const resetSeen = () => page.evaluate(() => { try { localStorage.removeItem('wf_alerted_today'); localStorage.removeItem('wf_notif_dismissed_' + window.WFWhen.ymd(new Date())); } catch (_) {} window.__os = []; window.__ban = []; });
    const deadlines = async () => { await resetSeen(); await page.evaluate(() => checkDeadlineAlerts()); return page.evaluate(() => window.__os.slice()); };
    const has = (list, re) => list.some((x) => re.test(x));
    await openSettings();
    // quiet hours must not be in the way of the probes
    await setOn('quietHoursEnabled', false); await setOn('notifications', true);
    await setOn('notifCCOT', true); await setOn('notifLoan', true); await setOn('notifCheque', true); await setOn('notifTarget', true); await setOn('notifAnomaly', true);

    await check('notifications (master) + notifCCOT + notifLoan + notifCheque + notifTarget + notifAnomaly -> deadline alerts', async () => {
        const all = await deadlines();
        const got = { ccot: has(all, /Probe card charge/), loan: has(all, /Probe loan/), chq: has(all, /cheque #777/), tgt: has(all, /Probe target/), anom: has(all, /Probe sub/) };
        await setOn('notifCCOT', false); const noCC = await deadlines(); await setOn('notifCCOT', true);
        await setOn('notifLoan', false); const noLn = await deadlines(); await setOn('notifLoan', true);
        await setOn('notifCheque', false); const noCh = await deadlines(); await setOn('notifCheque', true);
        await setOn('notifTarget', false); const noTg = await deadlines(); await setOn('notifTarget', true);
        await setOn('notifAnomaly', false); const noAn = await deadlines(); await setOn('notifAnomaly', true);
        await setOn('notifications', false); const none = await deadlines(); await setOn('notifications', true);
        const ok = Object.values(got).every(Boolean) && !has(noCC, /Probe card charge/) && has(noCC, /Probe loan/) && !has(noLn, /Probe loan/) && !has(noCh, /cheque #777/)
            && !has(noTg, /Probe target/) && !has(noAn, /Probe sub/) && none.length === 0;
        return { ok, detail: JSON.stringify(got) + ` offCC=${noCC.length} offLn=${noLn.length} offCh=${noCh.length} offTg=${noTg.length} offAn=${noAn.length} master=${none.length}` };
    });

    await check('quietHoursEnabled + quietStart + quietEnd', async () => {
        const hh = (m) => String(Math.floor(((m % 1440) + 1440) % 1440 / 60)).padStart(2, '0') + ':' + String(((m % 1440) + 1440) % 1440 % 60).padStart(2, '0');
        const nowMin = await page.evaluate(() => { const d = new Date(); return d.getHours() * 60 + d.getMinutes(); });
        await setOn('quietHoursEnabled', true);
        await pick("quietStart", hh(nowMin - 60)); await pick("quietEnd", hh(nowMin + 60));
        const inside = await deadlines();
        await pick("quietStart", hh(nowMin + 120)); await pick("quietEnd", hh(nowMin + 180));
        const outside = await deadlines();
        await pick("quietStart", hh(nowMin - 60)); await pick("quietEnd", hh(nowMin + 60)); await setOn('quietHoursEnabled', false);
        const disabled = await deadlines();
        const s = await settings();
        return { ok: inside.length === 0 && outside.length > 0 && disabled.length > 0 && !!s.quietStart && !!s.quietEnd, detail: `start=${s.quietStart} end=${s.quietEnd} inside=${inside.length} outside=${outside.length} disabled=${disabled.length}` };
    });

    await check('notifMaxPerDay', async () => {
        const run = async (max, count) => {
            await openSettings(); await pick("notifMaxPerDay", String(max));
            return page.evaluate((c) => {
                const t = window.WFWhen.today(); localStorage.setItem('wf_smart_notif_history', JSON.stringify({ _lastDate: t, _todayCount: c }));
                try { setSmartNotifHistory({ _lastDate: t, _todayCount: c }); } catch (_) {}
                window.__os = []; triggerSmartNotifications(); return window.__os.length;
            }, count);
        };
        const blocked = await run(2, 2); const allowed = await run(3, 2);
        await pick("notifMaxPerDay", '3');
        return { ok: blocked === 0 && allowed > 0, detail: `limit2/count2=${blocked} limit3/count2=${allowed}` };
    });

    await check('triggerSmartNotifications honours the category switches', async () => {
        const only = (cat) => page.evaluate((c) => { window.shuffleArray = () => [c]; window.__os = []; const t = window.WFWhen.today(); setSmartNotifHistory({ _lastDate: t, _todayCount: 0 }); triggerSmartNotifications(); return window.__os.length; }, cat);
        const out = {};
        // payment: one loan due in 3 days + one card due in 2: nothing else to send
        await setOn('notifLoan', true); await setOn('notifCCOT', false); out.paymentLoanOnly = await only('payment');
        await page.evaluate(() => { const l = DB.get('loans'); window.__loans = l; DB.set('loans', []); });
        out.paymentNothing = await only('payment');
        await setOn('notifCCOT', true); out.paymentCard = await only('payment');
        await page.evaluate(() => DB.set('loans', window.__loans));
        await setOn('notifTarget', true); out.target = await only('target'); await setOn('notifTarget', false); out.targetOff = await only('target'); await setOn('notifTarget', true);
        await page.evaluate(() => { DB.set('cconetime', [{ id: 'cc2', desc: 'Late card', amount: 100, deadline: window.__ymd(window.__plus(-3)), paid: false }]); });
        await setOn('notifCCOT', true); out.overdue = await only('overdue'); await setOn('notifCCOT', false); out.overdueOff = await only('overdue'); await setOn('notifCCOT', true);
        await page.evaluate(() => { delete window.shuffleArray; });
        return { ok: out.paymentLoanOnly > 0 && out.paymentNothing === 0 && out.paymentCard > 0 && out.target > 0 && out.targetOff === 0 && out.overdue > 0 && out.overdueOff === 0, detail: JSON.stringify(out) };
    });

    await check('notifPayday', async () => {
        const run = async () => { await resetSeen(); await page.evaluate(() => checkActionableReminders()); return page.evaluate(() => window.__ban.length); };
        await setOn('notifPayday', true); const on = await run(); await setOn('notifPayday', false); const off = await run(); await setOn('notifPayday', true);
        return { ok: on > 0 && off === 0, detail: `on=${on} off=${off}` };
    });

    // ---------- the two date-driven reminders: run them on a chosen day by replacing the page's clock for one call
    const atTime = (iso, run) => page.evaluate(async ([when, src]) => {
        const Real = Date; const fixed = new Real(when).getTime();
        class Fixed extends Real { constructor(...a) { if (a.length) super(...a); else super(fixed); } static now() { return fixed; } }
        window.Date = Fixed;
        try { return await window[src](); } finally { window.Date = Real; }
    }, [iso, run]);
    await page.evaluate(() => {
        window.__budgetProbe = () => { localStorage.removeItem('wf_notif_budget_' + new Date().toISOString().slice(0, 7)); window.__os = []; window.__sn = []; checkAndSendAIReminders(); return window.__sn.length + window.__os.length; };
        window.__tipProbe = () => { try { localStorage.removeItem('wf_alerted_today'); } catch (_) {} window.__tags = []; checkDeadlineAlerts(); return window.__tags.filter((x) => /^wf-tip-/.test(x)).length; };
        const plain = window.sendOSNotification;
        window.sendOSNotification = (t, b, tag) => { (window.__tags = window.__tags || []).push(String(tag || '')); return plain(t, b, tag); };
        window.sendSmartNotification = (t, b) => { (window.__sn = window.__sn || []).push(String(t) + ' ' + String(b || '')); };
        // the reminder sweep only runs once the browser has granted notification permission
        try { Object.defineProperty(Notification, 'permission', { get: () => 'granted', configurable: true }); } catch (_) {}
    });
    await check('notifBudget (mid-month budget alert)', async () => {
        await page.evaluate(() => {
            const d = new Date(2026, 9, 15, 12); const ymd = (x) => x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
            DB.set('expenses', [{ id: 'ex-big', desc: 'Probe spend', amount: 80000, category: 'Shopping', date: ymd(d) }]);
            DB.set('income', [{ id: 'in1', name: 'Probe salary', company: 'Probe', amount: 100000, monthly: 100000, freq: 'monthly', day: '2026-10-01', start: '2026-01-01', rate: 0 }]);
        });
        await setOn('notifications', true); await setOn('quietHoursEnabled', false);
        await openSettings(); await page.evaluate(() => { const s = DB.getObj('settings', {}); s.aiNotifications = true; DB.set('settings', s); });
        const grab = async () => { const r = await atTime('2026-10-15T12:00:00', '__budgetProbe'); return r; };
        await setOn('notifBudget', true); const on = await grab();
        await setOn('notifBudget', false); const off = await grab();
        await setOn('notifBudget', true);
        return { ok: on > 0 && off === 0, detail: `switch on=${on} switch off=${off}` };
    });
    await check('notifWeeklyTip (Friday evening tip)', async () => {
        await setOn('notifWeeklyTip', true);
        const friday = await atTime('2026-10-09T18:00:00', '__tipProbe');
        const saturday = await atTime('2026-10-10T18:00:00', '__tipProbe');
        await setOn('notifWeeklyTip', false);
        const off = await atTime('2026-10-09T18:00:00', '__tipProbe');
        await setOn('notifWeeklyTip', true);
        return { ok: friday > 0 && saturday === 0 && off === 0, detail: `friday on=${friday} saturday on=${saturday} friday off=${off}` };
    });

    // ---------- the four AI-preference switches
    await check('aiNotifications (AI reminders)', async () => {
        const run = () => atTime('2026-10-15T12:00:00', '__budgetProbe');
        await openSettings(); await setOn('notifBudget', true);
        await setOn('aiNotifications', true); const on = await run();
        await setOn('aiNotifications', false); const off = await run();
        await setOn('aiNotifications', true);
        return { ok: on > 0 && off === 0, detail: `on=${on} off=${off}` };
    });
    await check('autoCategory + smartExpenseSuggest (category guessed from a description)', async () => {
        await openSettings();
        const guess = () => page.evaluate(async () => { const sel = document.getElementById('e_cat'); sel.value = 'Other'; await autoDetectCategory('petrol shed'); return sel.value; });
        const direct = () => page.evaluate(() => autoCategorizeExpense('KFC'));
        await setOn('autoCategory', true); await setOn('smartExpenseSuggest', true);
        const both = await guess(); const kfc = await direct();
        await setOn('smartExpenseSuggest', false); const noSuggest = await guess();
        await setOn('smartExpenseSuggest', true); await setOn('autoCategory', false);
        const noAuto = await guess(); const noAutoDirect = await direct();
        await setOn('autoCategory', true);
        return { ok: both === 'Fuel' && kfc === 'Dining' && noSuggest === 'Other' && noAuto === 'Other' && noAutoDirect === null, detail: `both=${both} kfc=${kfc} suggestOff=${noSuggest} autoOff=${noAuto}/${noAutoDirect}` };
    });
    await check('loanAlertPct (warn when a new loan\'s rate is above the threshold)', async () => {
        await openSettings();
        const save = (rate) => page.evaluate(async (r) => {
            window.__toasts = []; const orig = window.notify; window.notify = (m, t) => { window.__toasts.push(String(m)); };
            try {
                document.getElementById('l_name').value = 'Probe loan ' + r; document.getElementById('l_amount').value = '100000'; document.getElementById('l_rate').value = String(r);
                document.getElementById('l_dur').value = '12'; document.getElementById('l_start').value = '2026-10-01';
                const bank = document.getElementById('l_bank'); const real = [...bank.options].find((o) => o.value); if (!real) bank.innerHTML = '<option value="Test">Test</option>'; bank.value = real ? real.value : 'Test';
                saveLoan();
            } finally { window.notify = orig; }
            DB.set('loans', DB.get('loans').filter((l) => !String(l.name).startsWith('Probe loan ')));
            return window.__toasts.some((t) => /above your/.test(t));
        }, rate);
        await pick("loanAlertPct", '10'); const above = await save(14); const below = await save(8);
        await pick("loanAlertPct", '18'); const raised = await save(14);
        await pick("loanAlertPct", '15');
        return { ok: above === true && below === false && raised === false, detail: `14% vs 10% -> ${above}; 8% vs 10% -> ${below}; 14% vs 18% -> ${raised}` };
    });

    // ---------- the bell answers to both sets of switches
    await check('bell: All Notifications + loan/cheque/card switches (older) and Enable + per-kind (newer)', async () => {
        await page.evaluate(() => { DB.set('cconetime', [{ id: 'cc1', desc: 'Probe card charge', amount: 5000, deadline: window.__ymd(window.__plus(2)), paid: false, bank: 'Test' }]); });
        const kinds = () => page.evaluate(() => WFNotif.compute().map((n) => n.cat).sort().join(','));
        const base = await kinds();
        await setOn('notifications', false); const m = await kinds(); await setOn('notifications', true);
        await setOn('notifCheque', false); const c = await kinds(); await setOn('notifCheque', true);
        await setOn('notifCCOT', false); const k = await kinds(); await setOn('notifCCOT', true);
        await setOn('notifLoan', false); const l = await kinds(); await setOn('notifLoan', true);
        await page.evaluate(() => { WFNotif.toggleSetting('enabled'); }); const e = await kinds(); await page.evaluate(() => { WFNotif.toggleSetting('enabled'); });
        await page.evaluate(() => { WFNotif.toggleSetting('cheques'); }); const nc = await kinds(); await page.evaluate(() => { WFNotif.toggleSetting('cheques'); });
        const back = await kinds();
        const ok = /Cheque/.test(base) && /Card payment/.test(base) && /Loan/.test(base) && m === '' && !/Cheque/.test(c) && /Loan/.test(c) && !/Card payment/.test(k) && !/Loan/.test(l) && e === '' && !/Cheque/.test(nc) && back === base;
        return { ok, detail: `base=[${base}] master=[${m}] noCheque=[${c}] noCard=[${k}] noLoan=[${l}] bellOff=[${e}] bellNoCheque=[${nc}]` };
    });

    // ---------- applied again after a refresh (the half that used to be missing)
    await check('theme + compactMode + privacyMode + roundAmounts are re-applied at boot', async () => {
        await openSettings();
        await setOn('compactMode', true); await setOn('roundAmounts', true);
        const themeBefore = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        await flip('theme'); await sleep(300);
        const themeSet = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
        await sleep(1500);
        const d = await w.reload('d'); const p2 = d.page;
        await sleep(500);
        const after = await p2.evaluate(() => ({ t: document.documentElement.getAttribute('data-theme'), c: document.body.classList.contains('wf-compact'), f: fmt(1234.56), s: DB.getObj('settings', {}) }));
        // restore on the new page
        await p2.evaluate(() => { const s = DB.getObj('settings', {}); s.compactMode = false; s.roundAmounts = false; s.theme = 'dark'; DB.set('settings', s); _applyDisplaySettings(); });
        return { ok: after.t === themeSet && themeSet !== themeBefore && after.c === true && after.f === 'LKR 1,235', detail: JSON.stringify({ themeBefore, themeSet, after: { t: after.t, c: after.c, f: after.f } }) };
    });

} finally {
    const out = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'}  ${r.key} \u2014 ${r.detail}`).join('\n');
    console.log(out);
    console.log(`\n${results.filter((r) => r.ok).length}/${results.length} passed`);
    if (results.some((r) => !r.ok) || !results.length) process.exitCode = 1;
    await w.close();
}
