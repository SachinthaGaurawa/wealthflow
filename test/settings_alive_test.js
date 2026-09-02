/* =============================================================================
 * test/settings_alive_test.js — a switch that saves a value and changes nothing
 * -----------------------------------------------------------------------------
 * THE OWNER'S REPORT: "in setting's most options are not working."
 *
 * I audited that once and answered the wrong question. Every control in the
 * settings screen calls a handler that exists and reaches DB.set — so I
 * reported them all as wired. Reaching storage is not doing something. Driving
 * all 37 controls in a browser confirmed the write half works perfectly; what
 * it could not tell me is whether anything ever READS the value back.
 *
 * Eight did not:
 *
 *   compactMode          "Reduce spacing"                   — no CSS anywhere
 *   showSavingsRate      "Show the rate on the dashboard"   — card always shown
 *   notifPayday          "Confirm receipt on each payday"   — banner always fired
 *   smartExpenseSuggest  "AI suggests categories as you type" — always suggested
 *   aiNotifications      "AI proactively sends reminders"   — always sent
 *   notifBudget          "Alert past 50% by mid-month"      — never read
 *   notifAnomaly         "Detect unusually high charges"    — no such alert
 *   notifWeeklyTip       "A tip every Friday evening"       — no such tip
 *
 * Four of them named a feature that already existed and simply was not
 * consulted; the rest named one that did not exist. Both are the same defect
 * from the owner's chair: they flipped a switch and nothing happened.
 *
 * This file is the guard against the whole class. Every key the settings screen
 * writes must be read somewhere that is not the settings screen itself.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MODULES = fs.readdirSync(ROOT).filter((f) => /^wealthflow-.*\.js$/.test(f))
    .map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');

/** The body of a top-level function in index.html, brace-matched past its args. */
function fn(name, src = HTML) {
    const at = src.search(new RegExp(`\\n\\s*(?:async\\s+)?function ${name}\\s*\\(`));
    if (at < 0) return '';
    let i = src.indexOf('(', at);
    let depth = 0;
    for (; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') { depth -= 1; if (depth === 0) { i += 1; break; } }
    }
    depth = 0;
    for (let j = src.indexOf('{', i); j < src.length; j += 1) {
        if (src[j] === '{') depth += 1;
        else if (src[j] === '}') { depth -= 1; if (depth === 0) return src.slice(at, j + 1); }
    }
    return src.slice(at);
}

/* Every key the settings screen writes. Read from the source rather than
 * listed here, so a new switch is covered the day it is added. */
const KEYS = [...new Set([...HTML.matchAll(/toggleSetting\('([A-Za-z0-9_]+)'/g)].map((m) => m[1]))];

/* The haystack with the settings SCREEN removed: its own markup mentions every
 * key (to draw the switch in the right position), and counting that as a reader
 * is what let eight dead switches look alive. */
const CONSUMERS = (() => {
    const render = fn('renderSettings');
    const toggle = fn('toggleSetting');
    let rest = HTML;
    for (const chunk of [render, toggle]) if (chunk) rest = rest.split(chunk).join('\n');
    /* The two default-object declarations name keys without reading them. */
    rest = rest.replace(/settings: \{[^}]*\}/g, ' ').replace(/DB\.getObj\('settings', \{ backupFreq[^}]*\}\)/g, ' ');
    return rest + '\n' + MODULES;
})();

describe('every settings switch does something', () => {
    it('there are switches to check, and the list came from the source', () => {
        /* If this ever reads zero, the loop below passes by testing nothing. */
        expect(KEYS.length).toBeGreaterThan(20);
        expect(KEYS).toContain('compactMode');
        expect(KEYS).toContain('notifBudget');
    });

    it.each(KEYS)('%s is read somewhere outside the settings screen', (key) => {
        const patterns = [
            new RegExp(`\\.${key}\\b`),            // s.key, settings.key, _aiPrefs.key
            new RegExp(`\\['${key}'\\]`),          // settings['key']
            new RegExp(`\\b${key}\\s*(?:!==|===)`), // key !== false
        ];
        const found = patterns.some((re) => re.test(CONSUMERS));
        expect(found,
            `"${key}" is written by the settings screen and read by nothing — `
            + 'a switch that saves a value and changes nothing is what "the options are not working" means').toBe(true);
    });
});

describe('the eight that were dead, each fixed at the place it was dead', () => {
    it('compactMode changes spacing, and the class is applied at BOOT as well as on toggle', () => {
        /* A body class applied only when the switch is flipped is a setting
         * that works until the page is reloaded — which is indistinguishable
         * from one that forgot itself, and is the other half of the owner's
         * complaint ("after a few hours it is deselected"). */
        expect(HTML).toMatch(/body\.wf-compact\s*\{/);
        expect(HTML).toMatch(/body\.wf-compact \.card\s*\{[^}]*padding/);
        const apply = fn('_applyDisplaySettings');
        expect(apply).toContain("classList.toggle('wf-compact'");
        expect(fn('renderDash')).toContain('_applyDisplaySettings()');
        expect(fn('toggleSetting')).toContain('_applyDisplaySettings()');
    });

    it('compact mode reduces SPACING and hides nothing', () => {
        /* The owner ruled out saving room by removing things. Compact is a
         * density setting; a display:none in it would be the lazy route they
         * named. */
        const block = HTML.slice(HTML.indexOf('body.wf-compact { --r'), HTML.indexOf('.liq-tabs {'));
        expect(block).not.toMatch(/display:\s*none/);
        expect(block).toMatch(/padding/);
    });

    it('showSavingsRate gates the card it names', () => {
        expect(HTML).toMatch(/showSavingsRate === false \? '' :/);
    });

    it('notifPayday gates the payday banner', () => {
        expect(fn('checkActionableReminders')).toContain("s.notifPayday === false");
    });

    it('smartExpenseSuggest gates the suggestion that already worked', () => {
        expect(fn('autoDetectCategory')).toContain('smartExpenseSuggest === false');
    });

    it('aiNotifications gates the engine it describes', () => {
        const body = fn('checkAndSendAIReminders');
        expect(body).toContain('aiNotifications === false');
        /* Before anything is sent, not after. */
        expect(body.indexOf('aiNotifications === false')).toBeLessThan(body.indexOf('sendSmartNotification('));
    });

    it('notifBudget gates the budget alert, at the threshold its own label promises', () => {
        /* The row says "exceeds 50% of income by mid-month" and the code used
         * 60%. The label is what the owner reads. */
        const body = fn('checkAndSendAIReminders');
        expect(body).toContain('notifBudget !== false');
        expect(body).toContain('spentPct > 50');
        expect(body).not.toContain('spentPct > 60');
        /* And it no longer fires on one calendar day only — a phone not opened
         * on the 15th never saw it at all. */
        expect(body).toMatch(/day >= 14 && day <= 17/);
    });

    it('notifAnomaly raises a real alert, from figures the owner actually recorded', () => {
        const body = fn('checkDeadlineAlerts');
        expect(body).toContain('notifAnomaly !== false');
        expect(body).toContain('monthOverrides');
        /* Only on a month with a real number in it: a warning about a charge
         * must never be a guess. */
        expect(body).toContain("typeof actual !== 'number'");
    });

    it('notifWeeklyTip sends the top insight on a Friday evening, and nothing when there is none', () => {
        const body = fn('checkDeadlineAlerts');
        expect(body).toContain('notifWeeklyTip !== false');
        expect(body).toMatch(/now\.getDay\(\) === 5/);
        expect(body).toMatch(/hour >= 17 && hour <= 21/);
        /* Reuses the ranking the dashboard already shows. A second engine
         * inventing its own advice would disagree with the strip on screen. */
        expect(body).toContain('WFInsights.brief(1)');
        /* Nothing to say is a real answer — filler is how a channel gets muted. */
        expect(body).toMatch(/if \(top && top\.title\)/);
    });
});

describe('and the two the guard itself found', () => {
    it('loanAlertPct warns when a loan is saved above it', () => {
        /* "Warn when a new loan rate exceeds this percentage", with an 8-25%
         * picker — stored, synced, remembered across reloads, read by nothing.
         * This is the moment its label names. */
        const body = fn('saveLoan');
        expect(body).toContain('loanAlertPct');
        expect(body).toContain('alert threshold');
        /* It warns; it does not refuse. The rate is a fact about a loan the
         * owner has already taken, and a form that would not accept it would
         * simply lose the record. */
        expect(body).not.toMatch(/loanAlertPct[\s\S]{0,300}return;/);
    });

    it('the sync-frequency control is gone, and the row says what actually happens', () => {
        /* It offered Real-time, Every 1 Hour and Wi-Fi Only, and nothing read
         * the value: the app syncs through a live Firestore listener whatever
         * is chosen. Building the other two means throttling the sync engine
         * that lost data until this week, and "Wi-Fi only" cannot be told from
         * mobile data in a browser on iOS at all. */
        expect(HTML).not.toContain("toggleSetting('syncFreq'");
        expect(HTML).toContain('Changes sync the moment you make them');
    });
});

describe('what the browser confirmed, kept as a contract', () => {
    it('the notification sub-toggles write through the same store, one level down', () => {
        /* They are not in appData.settings directly — WFNotif keeps them under
         * settings.notif and saves with the same DB.set, so they sync like
         * everything else. Written down because reading the top level made nine
         * working controls look broken. */
        const notif = fs.readFileSync(path.join(ROOT, 'wealthflow-notifications.js'), 'utf8');
        expect(notif).toContain("s.notif = n;");
        expect(notif).toContain("window.DB.set('settings', s)");
    });

    it('toggleSetting still reaches storage for every control', () => {
        const body = fn('toggleSetting');
        expect(body).toContain("DB.set('settings'");
    });
});
