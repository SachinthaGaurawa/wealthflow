import { describe, it, expect, beforeEach, afterEach } from "vitest";

describe("WealthFlow Intelligence Panel", () => {
  let originalWindow;
  let originalDocument;

  beforeEach(() => {
    // Save the original window and document
    originalWindow = global.window;
    originalDocument = global.document;

    // Create a minimal DOM shim
    const { JSDOM } = require("jsdom");
    const dom = new JSDOM(`<!DOCTYPE html><html><body></body></html>`);

    // Set up a minimal global/window shim
    global.window = dom.window;
    global.document = dom.window.document;

    // Mock the notify function
    global.window.notify = () => {};

    // Mock the wfMemory object
    global.window.wfMemory = {
      export: async () => ({}),
      forget: async () => {},
    };
  });

  afterEach(() => {
    // Restore the original window and document
    global.window = originalWindow;
    global.document = originalDocument;
  });

  it("should inject the panel into the DOM", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Check if the panel was injected
    const panel = document.getElementById("wfIntelPanel");
    expect(panel).not.toBeNull();
    expect(panel.querySelector(".settings-title").textContent).toBe("Autonomous AI Engine");
  });

  it("should not inject the panel if it already exists", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Create the panel manually
    const panel = document.createElement("div");
    panel.id = "wfIntelPanel";
    document.body.appendChild(panel);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Check if the panel was not duplicated
    const panels = document.querySelectorAll("#wfIntelPanel");
    expect(panels.length).toBe(1);
  });

  it("should handle missing mount point gracefully", async () => {
    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Check if the panel was not injected
    const panel = document.getElementById("wfIntelPanel");
    expect(panel).toBeNull();
  });

  it("should handle empty settings sections gracefully", async () => {
    // Create an empty settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Check if the panel was not injected
    const panel = document.getElementById("wfIntelPanel");
    expect(panel).toBeNull();
  });

  it("should handle multiple settings sections", async () => {
    // Create multiple settings sections
    const settingsSection1 = document.createElement("div");
    settingsSection1.className = "settings-section";
    settingsSection1.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection1);

    const settingsSection2 = document.createElement("div");
    settingsSection2.className = "settings-section";
    document.body.appendChild(settingsSection2);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Check if the panel was injected after the first settings section
    const panel = document.getElementById("wfIntelPanel");
    expect(panel).not.toBeNull();
    expect(panel.previousElementSibling).toBe(settingsSection1);
  });

  it("should handle the forget button click", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Mock the wfMemory.export function
    global.window.wfMemory.export = async () => ({ merchant1: { display: "Merchant 1" }, merchant2: { display: "Merchant 2" } });

    // Mock the wfMemory.forget function
    let forgetCalled = false;
    global.window.wfMemory.forget = async (merchant) => {
      forgetCalled = true;
      expect(merchant).toBe("Merchant 1" || "Merchant 2");
    };

    // Click the forget button
    const forgetButton = document.getElementById("wfIntelForget");
    forgetButton.click();

    // Wait for the forget function to be called
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check if the forget function was called
    expect(forgetCalled).toBe(true);
  });

  it("should handle the review button click", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Mock the wfReview function
    let reviewCalled = false;
    global.window.wfReview = async () => {
      reviewCalled = true;
    };

    // Click the review button
    const reviewButton = document.getElementById("wfIntelReview");
    reviewButton.click();

    // Wait for the review function to be called
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check if the review function was called
    expect(reviewCalled).toBe(true);
  });

  it("should handle the dedup button click", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Mock the wfDedup function
    let dedupCalled = false;
    global.window.wfDedup = async () => {
      dedupCalled = true;
      return [];
    };

    // Click the dedup button
    const dedupButton = document.getElementById("wfIntelDedup");
    dedupButton.click();

    // Wait for the dedup function to be called
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check if the dedup function was called
    expect(dedupCalled).toBe(true);
  });

  it("should handle the queue button click", async () => {
    // Create a minimal settings section
    const settingsSection = document.createElement("div");
    settingsSection.className = "settings-section";
    settingsSection.id = "wfSmsPasteMount";
    document.body.appendChild(settingsSection);

    // Import the module
    await import("../wealthflow-intel-panel.js");

    // Mock the wfQueue function
    let queueCalled = false;
    global.window.wfQueue = async () => {
      queueCalled = true;
    };

    // Click the queue button
    const queueButton = document.getElementById("wfIntelQueueRun");
    queueButton.click();

    // Wait for the queue function to be called
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Check if the queue function was called
    expect(queueCalled).toBe(true);
  });
});
