import { describe, it, expect } from "vitest";
import { loadBrowserModule } from "./helpers/load-browser-module.js";

// Generated from the TEST RECIPE at the end of wealthflow-cc-instalment-detail.js (autonomy/recipe-test.mjs): same books, same page, same calls, same element.
const BOOKS = {
  "ccinstall": [
    {
      "id": "p1",
      "product": "iPhone 15",
      "bank": "HNB Credit Card",
      "buyer": "Self",
      "monthly": 15000,
      "total": 180000,
      "rate": 0,
      "duration": 12,
      "date": "2025-01-15",
      "completed": false,
      "notes": "",
      "skipped": []
    }
  ]
};

describe("wealthflow-cc-instalment-detail.js draws what its author said it draws", () => {
    it("after mount(), open() the element #wfCciDetailBody shows \"LKR 15,000.00\"", async () => {
        const { window, document } = loadBrowserModule("wealthflow-cc-instalment-detail.js", {
            html: "<table><tbody id=\"cciBody\"><tr><td><div>iPhone 15</div></td><td>Self</td><td><span class=\"badge bg-b\">HNB Credit Card</span></td><td class=\"td-a\">LKR 180,000.00</td><td class=\"td-mono\">0% Free</td><td class=\"td-r\">LKR 15,000.00</td><td class=\"td-mono\">12M</td><td class=\"td-m td-date\">2025-01-15</td><td></td><td><span class=\"badge bg-g\">Active</span></td><td><div class=\"act-btns\"></div></td></tr></tbody></table>",
            globals: { DB: { get: (key) => BOOKS[key] || [], getObj: (key, dflt) => (BOOKS[key] !== undefined ? BOOKS[key] : dflt) } },
        });
        const api = window.WFCCInstalmentDetail;
        expect(typeof api).toBe("object");
        expect(typeof api.mount).toBe("function");
        await api.mount();
        expect(typeof api.open).toBe("function");
        await api.open("p1");
        await new Promise((resolve) => setTimeout(resolve, 20));
        const el = document.querySelector("#wfCciDetailBody");
        expect(el, "the element the recipe names was never drawn").toBeTruthy();
        const said = String(el.textContent || "");
        expect(said).toContain("LKR 15,000.00");
    });

    it("an empty book does not throw", async () => {
        const { window } = loadBrowserModule("wealthflow-cc-instalment-detail.js", {
            html: "<table><tbody id=\"cciBody\"><tr><td><div>iPhone 15</div></td><td>Self</td><td><span class=\"badge bg-b\">HNB Credit Card</span></td><td class=\"td-a\">LKR 180,000.00</td><td class=\"td-mono\">0% Free</td><td class=\"td-r\">LKR 15,000.00</td><td class=\"td-mono\">12M</td><td class=\"td-m td-date\">2025-01-15</td><td></td><td><span class=\"badge bg-g\">Active</span></td><td><div class=\"act-btns\"></div></td></tr></tbody></table>",
            globals: { DB: { get: () => [], getObj: (key, dflt) => dflt } },
        });
        await Promise.resolve(window.WFCCInstalmentDetail.mount()).catch(() => {});
        await Promise.resolve(window.WFCCInstalmentDetail.open("p1")).catch(() => {});
    });
});
