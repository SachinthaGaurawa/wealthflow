import { describe, it, expect } from "vitest";
import { printedPaymentsCheck } from "../statement-direction.mjs";

describe("printedPaymentsCheck", () => {
  it("returns 'agree' when payment lines sum exactly to the printed total", () => {
    const parsed = {
      printedFigures: { payments: 1200 },
      rows: [
        { valid: true, direction: "credit", narration: "payment", amount: 700 },
        { valid: true, direction: "credit", narration: "pmt", amount: 500 },
      ],
    };
    expect(printedPaymentsCheck(parsed)).toBe("agree");
  });

  it("returns 'differs' when the sum of payment lines does not match the printed total", () => {
    const parsed = {
      printedFigures: { payments: 1500 },
      rows: [
        { valid: true, direction: "credit", narration: "payment", amount: 800 },
        { valid: true, direction: "credit", narration: "pmt", amount: 600 },
      ],
    };
    expect(printedPaymentsCheck(parsed)).toBe("differs");
  });

  it("returns 'none' when the printed total payments is not a positive number", () => {
    const parsed = {
      printedFigures: { payments: 0 },
      rows: [
        { valid: true, direction: "credit", narration: "payment", amount: 500 },
      ],
    };
    expect(printedPaymentsCheck(parsed)).toBe("none");
  });

  it("excludes rows that contain both payment and adjustment words", () => {
    // Before the fix this row would be counted as a payment → 'agree'.
    // After the fix the row is excluded → sum = 0 → 'differs'.
    const parsed = {
      printedFigures: { payments: 1000 },
      rows: [
        {
          valid: true,
          direction: "credit",
          narration: "payment adjustment",
          amount: 1000,
        },
      ],
    };
    expect(printedPaymentsCheck(parsed)).toBe("differs");
  });
});
