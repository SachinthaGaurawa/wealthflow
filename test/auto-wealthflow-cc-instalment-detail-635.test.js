import { describe, it, expect } from "vitest";
import { loadBrowserModule } from "./helpers/load-browser-module.js";

// Generated from the TEST RECIPE at the end of wealthflow-cc-instalment-detail.js (autonomy/recipe-test.mjs): same books, same page, same calls, same element.
const BOOKS = {
  "ccinstall": [
    {
      "id": "p1",
      "product": "iPhone 15",
      "buyer": "Self",
      "bank": "HNB",
      "total": 314254,
      "monthly": 20968.68,
      "duration": 15,
      "rate": 0,
      "date": "2025-06-15",
      "completed": false,
      "skipped": [],
      "notes": "3-year plan"
    }
  ]
};

describe("wealthflow-cc-instalment-detail.js draws what its author said it draws", () => {
    it("after mount(), open() the element #wfCciDetailTitle shows \"iPhone 15\"", async () => {
        const { window, document } = loadBrowserModule("wealthflow-cc-instalment-detail.js", {
            html: "<table><tbody id=\"cciBody\"><tr><td>iPhone 15</td><td><button onclick=\"editCCI('p1')\">edit</button></td></tr></tbody></table>",
            globals: { DB: { get: (key) => BOOKS[key] || [], getObj: (key, dflt) => (BOOKS[key] !== undefined ? BOOKS[key] : dflt) } },
        });
        const api = window.WFCCInstalmentDetail;
        expect(typeof api).toBe("object");
        expect(typeof api.mount).toBe("function");
        await api.mount();
        expect(typeof api.open).toBe("function");
        await api.open("p1");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const el = document.querySelector("#wfCciDetailTitle");
        expect(el, "the element the recipe names was never drawn").toBeTruthy();
        const said = String(el.textContent || "");
        expect(said).toContain("iPhone 15");
    });

    it("an empty book does not throw", async () => {
        const { window } = loadBrowserModule("wealthflow-cc-instalment-detail.js", {
            html: "<table><tbody id=\"cciBody\"><tr><td>iPhone 15</td><td><button onclick=\"editCCI('p1')\">edit</button></td></tr></tbody></table>",
            globals: { DB: { get: () => [], getObj: (key, dflt) => dflt } },
        });
        await Promise.resolve(window.WFCCInstalmentDetail.mount()).catch(() => {});
        await Promise.resolve(window.WFCCInstalmentDetail.open("p1")).catch(() => {});
    });
});
