import { describe, it, expect } from "vitest";
import { JSDOM } from 'jsdom';

// Create a minimal global/window shim
const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);
globalThis.window = dom.window;
globalThis.document = dom.window.document;

// Load the module
await import('../wealthflow-data-health.js');

describe('WealthFlow Data Health', () => {
    it('should measure tombstones and records', () => {
        const appData = {
            _tomb: {
                income: { id1: Date.now() - 100 * 24 * 3600 * 1000, id2: Date.now() },
                incomeRecv: { id3: Date.now() - 100 * 24 * 3600 * 1000 },
                loans: { id4: Date.now() },
            },
            income: [{ id: 'id1' }, { id: 'id2' }],
            incomeRecv: [{ id: 'id3' }],
            loans: [{ id: 'id4' }],
        };

        const result = window.WFDataHealth.measure(appData);

        expect(result.tombstones.count).toBe(4);
        expect(result.tombstones.expired).toBe(2);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(4);
        expect(result.totalBytes).toBeGreaterThan(0);
        expect(result.sharePct).toBeGreaterThan(0);
    });

    it('should handle empty tombstones', () => {
        const appData = {
            _tomb: {},
            income: [{ id: 'id1' }, { id: 'id2' }],
            incomeRecv: [{ id: 'id3' }],
            loans: [{ id: 'id4' }],
        };

        const result = window.WFDataHealth.measure(appData);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(4);
        expect(result.totalBytes).toBeGreaterThan(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle null appData', () => {
        const result = window.WFDataHealth.measure(null);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(0);
        expect(result.totalBytes).toBe(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle undefined appData', () => {
        const result = window.WFDataHealth.measure(undefined);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(0);
        expect(result.totalBytes).toBe(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle NaN appData', () => {
        const result = window.WFDataHealth.measure(NaN);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(0);
        expect(result.totalBytes).toBe(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle negative appData', () => {
        const result = window.WFDataHealth.measure(-1);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(0);
        expect(result.totalBytes).toBe(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle huge appData', () => {
        const appData = {
            _tomb: {
                income: {},
            },
            income: Array(100000).fill({ id: 'id1' }),
        };

        const result = window.WFDataHealth.measure(appData);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(100000);
        expect(result.totalBytes).toBeGreaterThan(0);
        expect(result.sharePct).toBe(0);
    });

    it('should handle unicode appData', () => {
        const appData = {
            _tomb: {
                income: { 'id1': Date.now() },
            },
            income: [{ id: 'id1' }],
        };

        const result = window.WFDataHealth.measure(appData);

        expect(result.tombstones.count).toBe(1);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(1);
        expect(result.totalBytes).toBeGreaterThan(0);
        expect(result.sharePct).toBeGreaterThan(0);
    });

    it('should handle malformed appData', () => {
        const appData = {
            _tomb: 'string',
            income: 'string',
        };

        const result = window.WFDataHealth.measure(appData);

        expect(result.tombstones.count).toBe(0);
        expect(result.tombstones.expired).toBe(0);
        expect(result.tombstones.orphaned).toBe(0);
        expect(result.records.count).toBe(0);
        expect(result.totalBytes).toBe(0);
        expect(result.sharePct).toBe(0);
    });
});
