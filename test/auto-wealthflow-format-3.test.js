import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

describe('wealthflow-format.js', () => {
    let window;
    let WFFmt;

    beforeEach(async () => {
        const dom = new JSDOM();
        window = dom.window;
        await import('../wealthflow-format.js');
        WFFmt = window.WFFmt;
    });

    it('renders 3-digit numbered list items correctly', () => {
        const input = '100. hundred';
        const expectedOutput = '<div class="ai-numbered"><span class="ai-num">100</span> <span>hundred</span></div>';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toContain(expectedOutput);
    });

    it('renders 1-digit and 2-digit numbered list items correctly', () => {
        const input = '1. one\n2. two';
        const expectedOutput = '<div class="ai-numbered"><span class="ai-num">1</span> <span>one</span></div>\n<div class="ai-numbered"><span class="ai-num">2</span> <span>two</span></div>';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toContain(expectedOutput);
    });

    it('renders empty string correctly', () => {
        const input = '';
        const expectedOutput = '';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });

    it('renders null input correctly', () => {
        const input = null;
        const expectedOutput = '';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });

    it('renders undefined input correctly', () => {
        const input = undefined;
        const expectedOutput = '';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });

    it('renders NaN input correctly', () => {
        const input = NaN;
        const expectedOutput = '';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });

    it('renders negative number input correctly', () => {
        const input = '-1. negative';
        const expectedOutput = '-1. negative';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });

    it('renders huge number input correctly', () => {
        const input = '1000. huge';
        const expectedOutput = '<div class="ai-numbered"><span class="ai-num">1000</span> <span>huge</span></div>';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toContain(expectedOutput);
    });

    it('renders unicode input correctly', () => {
        const input = '1. ஒன்று';
        const expectedOutput = '<div class="ai-numbered"><span class="ai-num">1</span> <span>ஒன்று</span></div>';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toContain(expectedOutput);
    });

    it('renders malformed input correctly', () => {
        const input = 'abc. malformed';
        const expectedOutput = 'abc. malformed';
        const renderedHtml = WFFmt.render(input);
        expect(renderedHtml).toBe(expectedOutput);
    });
});
