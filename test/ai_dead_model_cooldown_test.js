import { describe, it, expect, beforeEach } from 'vitest';
import { coolProvider, providerAvailable, resetProviderCooldowns } from '../api/ai.js';

/* A model that no longer exists does not come back until the code names another. Production logs showed Fireworks (404 "Model not
 * found"), NVIDIA (410 "reached its end of life"), Cerebras (404) and OpenRouter (404 "unavailable for free") being asked again
 * on every call, each spending its share of the deadline on a certain failure. They are now left alone for hours; a rate limit
 * is still a couple of minutes, and a timeout one minute. */
const NOW = Date.parse('2026-10-01T06:00:00Z');
beforeEach(() => resetProviderCooldowns());

describe('provider cool-downs', () => {
    const down = (message) => { resetProviderCooldowns(); coolProvider('X', new Error(message), NOW); return [1000 * 60 * 5, 1000 * 3600 * 5, 1000 * 3600 * 7].map(ms => providerAvailable('X', NOW + ms)); };
    it('a model that is gone stays out for hours', () => {
        for (const m of [
            'Fireworks status 404: {"error":{"message":"Model not found, inaccessible, and/or not deployed"}}',
            'NVIDIA status 410: {"title":"Gone","detail":"The model \'meta/llama-3.1-8b-instruct\' has reached its end of life on 2026-08-26"}',
            'Cerebras status 404: {"message":"Model does not exist or you do not have access to it."}',
            'OpenRouterFinance status 404: {"error":{"message":"This model is unavailable for free."}}',
        ]) expect(down(m), m).toEqual([false, false, true]);
    });
    it('a rate limit is minutes, a timeout one minute, billing hours, anything else seconds', () => {
        expect(down('Gemini status 429: quota')).toEqual([true, true, true]);
        resetProviderCooldowns(); coolProvider('X', new Error('Mistral status 429'), NOW);
        expect(providerAvailable('X', NOW + 60 * 1000)).toBe(false); expect(providerAvailable('X', NOW + 3 * 60 * 1000)).toBe(true);
        resetProviderCooldowns(); coolProvider('X', new Error('Provider response deadline exceeded'), NOW);
        expect(providerAvailable('X', NOW + 30 * 1000)).toBe(false); expect(providerAvailable('X', NOW + 61 * 1000)).toBe(true);
        resetProviderCooldowns(); coolProvider('X', new Error('credit balance too low'), NOW);
        expect(providerAvailable('X', NOW + 5 * 3600 * 1000)).toBe(false);
        resetProviderCooldowns(); coolProvider('X', new Error('something odd'), NOW);
        expect(providerAvailable('X', NOW + 20 * 1000)).toBe(true);
    });
    it('a 404 that is not about a model (a bad URL fragment in a number) is not mistaken for one: "status 4040" is not 404', () => {
        resetProviderCooldowns(); coolProvider('X', new Error('status 40412 weird'), NOW);
        expect(providerAvailable('X', NOW + 20 * 1000)).toBe(true);
    });
});
