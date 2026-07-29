import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';

describe('wealthflow-format.js', () => {
    let window;
    let WFFmt;

    beforeEach(async () => {
        const dom = new JSDOM();
        window = dom.window;
        const module = await import('../wealthflow-format.js');
        WFFmt = window.WFFmt;
    });

    it('renders numbered list with 3-digit number', () => {
        const input = '100. hundred';
        const expected = '<div class="ai-numbered"><span class="ai-num">100</span> <span>hundred</span></div>';
        const result = WFFmt.render(input);
        expect(result).toContain(expected);
    });

    it('renders numbered list with 1-digit number', () => {
        const input = '1. one';
        const expected = '<div class="ai-numbered"><span class="ai-num">1</span> <span>one</span></div>';
        const result = WFFmt.render(input);
        expect(result).toContain(expected);
    });

    it('renders numbered list with 2-digit number', () => {
        const input = '10. ten';
        const expected = '<div class="ai-numbered"><span class="ai-num">10</span> <span>ten</span></div>';
        const result = WFFmt.render(input);
        expect(result).toContain(expected);
    });

    it('renders plain text without numbered list', () => {
        const input = 'not a list';
        const result = WFFmt.render(input);
        expect(result).not.toContain('ai-numbered');
    });

    it('renders multiple numbered lists', () => {
        const input = '1. one\n2. two\n100. hundred';
        const expected1 = '<div class="ai-numbered"><span class="ai-num">1</span> <span>one</span></div>';
        const expected2 = '<div class="ai-numbered"><span class="ai-num">2</span> <span>two</span></div>';
        const expected3 = '<div class="ai-numbered"><span class="ai-num">100</span> <span>hundred</span></div>';
        const result = WFFmt.render(input);
        expect(result).toContain(expected1);
        expect(result).toContain(expected2);
        expect(result).toContain(expected3);
    });
});
