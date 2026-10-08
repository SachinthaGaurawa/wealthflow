import { describe, expect, it } from 'vitest';
import {
    OFFICIAL_EMAIL,
    OFFICIAL_ORIGIN,
    canonicalizeLegacyUrl,
    publicOrigin,
    publicUrl,
} from '../wealthflow-public-identity.mjs';

describe('the public WealthFlow identity', () => {
    it('has one exact production origin and customer email', () => {
        expect(OFFICIAL_ORIGIN).toBe('https://www.wealthflow.lk');
        expect(OFFICIAL_EMAIL).toBe('info@wealthflow.lk');
        expect(publicOrigin({})).toBe(OFFICIAL_ORIGIN);
    });

    it('accepts only a complete safe HTTPS origin override', () => {
        expect(publicOrigin({ WEALTHFLOW_PUBLIC_ORIGIN: 'https://preview.example.test/' }))
            .toBe('https://preview.example.test');

        for (const bad of [
            'http://preview.example.test',
            'https://user:secret@preview.example.test',
            'https://preview.example.test/nested',
            'https://preview.example.test/?x=1',
            'https://preview.example.test/#frag',
            '//preview.example.test',
            'not a URL',
        ]) {
            expect(publicOrigin({ WEALTHFLOW_PUBLIC_ORIGIN: bad }), bad)
                .toBe(OFFICIAL_ORIGIN);
        }
    });

    it('joins public paths without double slashes or losing queries', () => {
        expect(publicUrl('/t/AbC_123')).toBe('https://www.wealthflow.lk/t/AbC_123');
        expect(publicUrl('api/statement-view?id=Eight888'))
            .toBe('https://www.wealthflow.lk/api/statement-view?id=Eight888');
        expect(publicUrl('?s=Eight888')).toBe('https://www.wealthflow.lk/?s=Eight888');
        expect(publicUrl('/t/AbC_123', { WEALTHFLOW_PUBLIC_ORIGIN: 'https://preview.example.test/' }))
            .toBe('https://preview.example.test/t/AbC_123');
    });
});

describe('legacy public links', () => {
    it.each([
        [
            'https://wealthflow-personal.vercel.app/t/Token_123?lang=si#balance',
            'https://www.wealthflow.lk/t/Token_123?lang=si#balance',
        ],
        [
            'https://wealthflow-peach.vercel.app/api/statement-view?id=Eight888',
            'https://www.wealthflow.lk/api/statement-view?id=Eight888',
        ],
        [
            'https://sachinthagaurawa.github.io/wealthflow/?s=Eight888#top',
            'https://www.wealthflow.lk/?s=Eight888#top',
        ],
        [
            'https://sachinthagaurawa.github.io/wealthflow/t/Token_123?lang=si',
            'https://www.wealthflow.lk/t/Token_123?lang=si',
        ],
    ])('moves %s to the official origin without changing its state', (before, after) => {
        expect(canonicalizeLegacyUrl(before)).toBe(after);
    });

    it('does not claim unrelated or malformed URLs as WealthFlow links', () => {
        for (const value of [
            'https://example.com/?next=https://wealthflow-personal.vercel.app',
            'https://sachinthagaurawa.github.io/a-different-project/?s=Eight888',
            'https://user:secret@wealthflow-personal.vercel.app/?s=Eight888',
            'javascript:alert(1)',
            'not a URL',
            '',
        ]) {
            expect(canonicalizeLegacyUrl(value), value).toBe(value);
        }
    });

    it('leaves the official URL byte-for-byte unchanged', () => {
        const official = 'https://www.wealthflow.lk/t/Token_123?lang=si#balance';
        expect(canonicalizeLegacyUrl(official)).toBe(official);
    });
});
