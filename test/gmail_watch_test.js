/* =============================================================================
 * test/gmail_watch_test.js — the decisions behind asking Gmail to notify us
 * -----------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 *
 * gmail-hook.js verifies a Pub/Sub push and files the statements it finds. It is
 * complete and it had never run once, because Google publishes to a topic only
 * while the mailbox has an active users.watch — and nothing in this repository
 * ever called it. PUB_SUB_TOPIC was set as an environment variable and read by
 * nobody.
 *
 * A watch also expires after SEVEN DAYS, so "register it" is not the feature;
 * "keep it registered" is. These pin both halves.
 * ===========================================================================*/

import { describe, it, expect } from 'vitest';
import {
    WATCH, topicNameFrom, missingWatchConfig, watchBody, watchRecord,
    daysLeft, needsRenewal, watchStatusOf,
} from '../gmail-watch.mjs';

const DAY = 86400000;
const NOW = 1_700_000_000_000;

describe('the topic name is built from what a person actually copies', () => {
    it('accepts a bare topic id with a project', () => {
        expect(topicNameFrom({ GCP_PROJECT_ID: 'wf-proj', PUB_SUB_TOPIC: 'statements' }))
            .toBe('projects/wf-proj/topics/statements');
    });

    it('accepts a full resource name, which is the other thing the console shows', () => {
        /* Requiring one spelling and failing silently on the other is a
         * configuration trap whose symptom appears days later as "no statements
         * ever arrived". */
        expect(topicNameFrom({ PUB_SUB_TOPIC: 'projects/other/topics/mail' }))
            .toBe('projects/other/topics/mail');
    });

    it('ignores GCP_PROJECT_ID when the topic already names its project', () => {
        expect(topicNameFrom({ GCP_PROJECT_ID: 'ignored', PUB_SUB_TOPIC: 'projects/real/topics/t' }))
            .toBe('projects/real/topics/t');
    });

    it('returns null rather than a malformed name', () => {
        expect(topicNameFrom({})).toBe(null);
        expect(topicNameFrom({ PUB_SUB_TOPIC: 'statements' })).toBe(null);          // no project
        expect(topicNameFrom({ PUB_SUB_TOPIC: 'projects/only' })).toBe(null);       // half a name
        expect(topicNameFrom({ PUB_SUB_TOPIC: 'projects/a/topics/b/c' })).toBe(null);
        expect(topicNameFrom({ GCP_PROJECT_ID: 'p', PUB_SUB_TOPIC: 'has space' })).toBe(null);
        expect(topicNameFrom({ GCP_PROJECT_ID: 'bad/project', PUB_SUB_TOPIC: 't' })).toBe(null);
        expect(topicNameFrom({ GCP_PROJECT_ID: 'p', PUB_SUB_TOPIC: '   ' })).toBe(null);
    });

    it('a slash in the bare topic cannot smuggle in another project', () => {
        expect(topicNameFrom({ GCP_PROJECT_ID: 'mine', PUB_SUB_TOPIC: '../../theirs/topics/t' })).toBe(null);
    });
});

describe('the configuration report names what is actually needed', () => {
    it('lists everything when nothing is set', () => {
        expect(missingWatchConfig({}).sort()).toEqual(
            ['GCP_PROJECT_ID', 'GOOGLE_OAUTH_CLIENT_ID', 'GOOGLE_OAUTH_CLIENT_SECRET', 'PUB_SUB_TOPIC'],
        );
    });

    it('does not demand GCP_PROJECT_ID when the topic supplies it', () => {
        /* Reporting a variable that would change nothing sends somebody to set
         * it and then wonder why the pipeline is still silent. */
        expect(missingWatchConfig({
            GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's',
            PUB_SUB_TOPIC: 'projects/p/topics/t',
        })).toEqual([]);
    });

    it('reports nothing once all four are set', () => {
        expect(missingWatchConfig({
            GOOGLE_OAUTH_CLIENT_ID: 'i', GOOGLE_OAUTH_CLIENT_SECRET: 's',
            GCP_PROJECT_ID: 'p', PUB_SUB_TOPIC: 't',
        })).toEqual([]);
    });

    it('treats whitespace as unset', () => {
        expect(missingWatchConfig({ GOOGLE_OAUTH_CLIENT_ID: '  ' })).toContain('GOOGLE_OAUTH_CLIENT_ID');
    });
});

describe('the watch request filters to the inbox', () => {
    it('asks only for INBOX', () => {
        /* Without a filter Gmail notifies on every mailbox change — drafts,
         * reads, label edits — and each one costs an invocation and a history
         * query that finds nothing. */
        expect(watchBody('projects/p/topics/t')).toEqual({
            topicName: 'projects/p/topics/t',
            labelIds: ['INBOX'],
            labelFilterBehavior: 'INCLUDE',
        });
    });
});

describe('what gets recorded after a successful watch', () => {
    it('stores the expiry Google returned', () => {
        const rec = watchRecord({ expiration: String(NOW + 7 * DAY), historyId: '55' }, 'projects/p/topics/t', { now: NOW });
        expect(rec.watchExpiry).toBe(NOW + 7 * DAY);
        expect(rec.watchTopic).toBe('projects/p/topics/t');
        expect(rec.watchedAt).toBe(NOW);
    });

    it('falls back to seven days when Google returns no expiry', () => {
        const rec = watchRecord({}, 't', { now: NOW });
        expect(rec.watchExpiry).toBe(NOW + WATCH.MAX_LIFETIME_DAYS * DAY);
    });

    it('does NOT write historyId on a first registration', () => {
        /* gmail-link.mjs deliberately leaves historyId unset so the first push
         * starts from the beginning of the mailbox. Writing the current point
         * here would skip every statement already sitting in the inbox — the
         * whole backfill, lost silently at connect time. */
        const rec = watchRecord({ historyId: '9999', expiration: String(NOW + DAY) }, 't', { hadHistoryId: false, now: NOW });
        expect(rec.historyId).toBeUndefined();
    });

    it('DOES advance historyId on a renewal, where one already exists', () => {
        /* By then the pipeline has been running and the bookmark is real; not
         * advancing it makes the next push ask for a week of changes that were
         * all handled already. */
        const rec = watchRecord({ historyId: '9999', expiration: String(NOW + DAY) }, 't', { hadHistoryId: true, now: NOW });
        expect(rec.historyId).toBe('9999');
    });

    it('never invents a historyId Google did not send', () => {
        expect(watchRecord({ expiration: String(NOW + DAY) }, 't', { hadHistoryId: true, now: NOW }).historyId).toBeUndefined();
    });
});

describe('when to renew', () => {
    const linked = (over) => ({ refresh_token: 'x'.repeat(40), ...over });

    it('renews when there has never been a watch', () => {
        expect(needsRenewal(linked(), NOW)).toBe(true);
    });

    it('renews inside the margin, and leaves a fresh watch alone', () => {
        expect(needsRenewal(linked({ watchExpiry: NOW + 7 * DAY }), NOW)).toBe(false);
        expect(needsRenewal(linked({ watchExpiry: NOW + 6.5 * DAY }), NOW)).toBe(false);
        expect(needsRenewal(linked({ watchExpiry: NOW + 5 * DAY }), NOW)).toBe(true);
        expect(needsRenewal(linked({ watchExpiry: NOW + 1 * DAY }), NOW)).toBe(true);
    });

    it('renews exactly AT the margin, not just past it', () => {
        /* A boundary that renews only strictly inside leaves the one visit that
         * lands on the margin doing nothing, and the owner may not open the app
         * again for days. */
        expect(needsRenewal(linked({ watchExpiry: NOW + WATCH.RENEW_WITH_DAYS_LEFT * DAY }), NOW)).toBe(true);
    });

    it('renews an expired watch', () => {
        expect(needsRenewal(linked({ watchExpiry: NOW - DAY }), NOW)).toBe(true);
    });

    it('does not try when there is no mailbox to watch with', () => {
        expect(needsRenewal(null, NOW)).toBe(false);
        expect(needsRenewal({}, NOW)).toBe(false);
        expect(needsRenewal({ watchExpiry: NOW - DAY }, NOW)).toBe(false);
    });

    it('the margin leaves real room under Google’s maximum', () => {
        /* Renewing at the very last hour means one missed visit is a lapse. */
        expect(WATCH.RENEW_WITH_DAYS_LEFT).toBeLessThan(WATCH.MAX_LIFETIME_DAYS);
        expect(WATCH.MAX_LIFETIME_DAYS - WATCH.RENEW_WITH_DAYS_LEFT).toBeGreaterThanOrEqual(1);
    });
});

describe('what the card is told', () => {
    it('reports a live watch with a date and a countdown', () => {
        const st = watchStatusOf({ watchExpiry: NOW + 3 * DAY }, NOW);
        expect(st).toMatchObject({ watching: true, expiresAt: NOW + 3 * DAY, daysLeft: 3, expired: false });
    });

    it('flags a watch close to expiring', () => {
        expect(watchStatusOf({ watchExpiry: NOW + 1 * DAY }, NOW).expiring).toBe(true);
        expect(watchStatusOf({ watchExpiry: NOW + 5 * DAY }, NOW).expiring).toBe(false);
    });

    it('an expired watch is not "watching" and is not merely "expiring"', () => {
        const st = watchStatusOf({ watchExpiry: NOW - DAY }, NOW);
        expect(st.watching).toBe(false);
        expect(st.expired).toBe(true);
        expect(st.expiring).toBe(false);
    });

    it('no watch at all is reported as such, not as expired', () => {
        expect(watchStatusOf(null, NOW)).toEqual({
            watching: false, expiresAt: null, daysLeft: null, expiring: false, expired: false,
        });
    });

    it('daysLeft is never negative', () => {
        expect(watchStatusOf({ watchExpiry: NOW - 100 * DAY }, NOW).daysLeft).toBe(0);
    });

    it('says nothing about the token or the project', () => {
        const st = watchStatusOf({ watchExpiry: NOW + DAY, refresh_token: 'SECRET_TOKEN_VALUE', watchTopic: 'projects/p/topics/t' }, NOW);
        expect(JSON.stringify(st)).not.toContain('SECRET_TOKEN_VALUE');
        expect(JSON.stringify(st)).not.toContain('projects/p');
    });
});

describe('daysLeft', () => {
    it('is null when there is no expiry to measure', () => {
        expect(daysLeft(null, NOW)).toBe(null);
        expect(daysLeft({}, NOW)).toBe(null);
        expect(daysLeft({ watchExpiry: 'soon' }, NOW)).toBe(null);
        expect(daysLeft({ watchExpiry: 0 }, NOW)).toBe(null);
    });
});
