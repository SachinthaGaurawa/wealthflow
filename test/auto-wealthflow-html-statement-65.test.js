import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("wealthflow-html-statement.js", () => {
  let originalWindow;
  let mockWindow;

  beforeEach(() => {
    originalWindow = global.window;
    mockWindow = {
      document: {
        createElement: vi.fn(() => ({
          src: "",
          async: false,
          defer: false,
          onload: null,
          onerror: null,
        })),
        head: {
          appendChild: vi.fn(),
        },
      },
      CryptoJS: null,
    };
    global.window = mockWindow;
  });

  afterEach(() => {
    global.window = originalWindow;
  });

  it("should add defer attribute to script element when loading CryptoJS", async () => {
    const module = await import("../wealthflow-html-statement.js");
    const scriptElement = mockWindow.document.createElement();

    mockWindow.document.createElement.mockReturnValueOnce(scriptElement);

    await module.default.ensureCryptoJS();

    expect(scriptElement.defer).toBe(true);
  });

  it("should not add defer attribute to script element when CryptoJS is already loaded", async () => {
    mockWindow.CryptoJS = {
      AES: {},
      algo: {
        SHA1: {},
      },
    };

    const module = await import("../wealthflow-html-statement.js");
    const scriptElement = mockWindow.document.createElement();

    mockWindow.document.createElement.mockReturnValueOnce(scriptElement);

    await module.default.ensureCryptoJS();

    expect(scriptElement.defer).toBe(false);
  });

  it("should handle empty input in isEncryptedHtmlStatement", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.isEncryptedHtmlStatement("")).toBe(false);
    expect(module.default.isEncryptedHtmlStatement(null)).toBe(false);
    expect(module.default.isEncryptedHtmlStatement(undefined)).toBe(false);
  });

  it("should handle non-string input in isEncryptedHtmlStatement", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.isEncryptedHtmlStatement(123)).toBe(false);
    expect(module.default.isEncryptedHtmlStatement({})).toBe(false);
    expect(module.default.isEncryptedHtmlStatement([])).toBe(false);
  });

  it("should handle empty input in looksLikeStatement", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.looksLikeStatement("")).toBe(false);
    expect(module.default.looksLikeStatement(null)).toBe(false);
    expect(module.default.looksLikeStatement(undefined)).toBe(false);
  });

  it("should handle non-string input in looksLikeStatement", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.looksLikeStatement(123)).toBe(false);
    expect(module.default.looksLikeStatement({})).toBe(false);
    expect(module.default.looksLikeStatement([])).toBe(false);
  });

  it("should handle empty input in decrypt", async () => {
    const module = await import("../wealthflow-html-statement.js");

    await expect(module.default.decrypt("", "password")).rejects.toThrow();
    await expect(module.default.decrypt(null, "password")).rejects.toThrow();
    await expect(module.default.decrypt(undefined, "password")).rejects.toThrow();
  });

  it("should handle non-string input in decrypt", async () => {
    const module = await import("../wealthflow-html-statement.js");

    await expect(module.default.decrypt(123, "password")).rejects.toThrow();
    await expect(module.default.decrypt({}, "password")).rejects.toThrow();
    await expect(module.default.decrypt([], "password")).rejects.toThrow();
  });

  it("should handle empty input in htmlToText", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.htmlToText("")).toBe("");
    expect(module.default.htmlToText(null)).toBe("");
    expect(module.default.htmlToText(undefined)).toBe("");
  });

  it("should handle non-string input in htmlToText", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.htmlToText(123)).toBe("123");
    expect(module.default.htmlToText({})).toBe("[object Object]");
    expect(module.default.htmlToText([])).toBe("");
  });

  it("should handle empty input in htmlToTransactions", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.htmlToTransactions("")).toEqual([]);
    expect(module.default.htmlToTransactions(null)).toEqual([]);
    expect(module.default.htmlToTransactions(undefined)).toEqual([]);
  });

  it("should handle non-string input in htmlToTransactions", async () => {
    const module = await import("../wealthflow-html-statement.js");

    expect(module.default.htmlToTransactions(123)).toEqual([]);
    expect(module.default.htmlToTransactions({})).toEqual([]);
    expect(module.default.htmlToTransactions([])).toEqual([]);
  });

  it("should handle empty input in getStatementText", async () => {
    const module = await import("../wealthflow-html-statement.js");

    await expect(module.default.getStatementText("")).rejects.toThrow();
    await expect(module.default.getStatementText(null)).rejects.toThrow();
    await expect(module.default.getStatementText(undefined)).rejects.toThrow();
  });

  it("should handle non-string input in getStatementText", async () => {
    const module = await import("../wealthflow-html-statement.js");

    await expect(module.default.getStatementText(123)).rejects.toThrow();
    await expect(module.default.getStatementText({})).rejects.toThrow();
    await expect(module.default.getStatementText([])).rejects.toThrow();
  });
});
