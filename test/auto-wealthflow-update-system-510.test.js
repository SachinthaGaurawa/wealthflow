import { describe, it, expect, vi } from "vitest";
import * as loader from "./helpers/load-browser-module.js";

describe("wealthflow-update-system.js", () => {
  it("should show the build id beside the version in the settings card", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/api/version")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ sha: "abc123def456" }),
        };
      }
      if (url.includes("/version.json")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ latest: "7.69.43" }),
        };
      }
      return { ok: false, status: 404 };
    };

    const { window, document } = loader.loadBrowserModule(
      "wealthflow-update-system.js",
      {
        html: '<div id="wfUpdateCard"></div>',
        fetchImpl,
      }
    );

    await window.wfUpdate.refresh();
    await vi.waitFor(() =>
      expect(document.getElementById("wfUpdateCard").textContent).toContain(
        "build abc123d"
      )
    );
  });

  it("should not show the build id when the fetch fails", async () => {
    const fetchImpl = async () => {
      throw new Error("Network error");
    };

    const { window, document } = loader.loadBrowserModule(
      "wealthflow-update-system.js",
      {
        html: '<div id="wfUpdateCard"></div>',
        fetchImpl,
      }
    );

    await window.wfUpdate.refresh();
    await vi.waitFor(() =>
      expect(document.getElementById("wfUpdateCard").textContent).not.toContain(
        "build"
      )
    );
  });

  it("should not show the build id when the sha is not provided", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/api/version")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({}),
        };
      }
      if (url.includes("/version.json")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ latest: "7.69.43" }),
        };
      }
      return { ok: false, status: 404 };
    };

    const { window, document } = loader.loadBrowserModule(
      "wealthflow-update-system.js",
      {
        html: '<div id="wfUpdateCard"></div>',
        fetchImpl,
      }
    );

    await window.wfUpdate.refresh();
    await vi.waitFor(() =>
      expect(document.getElementById("wfUpdateCard").textContent).not.toContain(
        "build"
      )
    );
  });

  it("should not show the build id when the sha is invalid", async () => {
    const fetchImpl = async (url) => {
      if (url.includes("/api/version")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ sha: "invalid" }),
        };
      }
      if (url.includes("/version.json")) {
        return {
          ok: true,
          status: 200,
          headers: { get: () => "application/json" },
          json: async () => ({ latest: "7.69.43" }),
        };
      }
      return { ok: false, status: 404 };
    };

    const { window, document } = loader.loadBrowserModule(
      "wealthflow-update-system.js",
      {
        html: '<div id="wfUpdateCard"></div>',
        fetchImpl,
      }
    );

    await window.wfUpdate.refresh();
    await vi.waitFor(() =>
      expect(document.getElementById("wfUpdateCard").textContent).not.toContain(
        "build"
      )
    );
  });
});
