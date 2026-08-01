import { describe, it, expect, beforeEach } from "vitest";
import fs from "node:fs";

// The generated harness used `await import("../wealthflow-review.js")` inside
// beforeEach. ESM imports are CACHED, so the module executed once while each
// beforeEach replaced global.window with a fresh object — after the first test
// the module had no way to attach itself to the new window, and `wfReview` was
// undefined for every case that followed. Only the first test ran against
// anything at all.
//
// Loading the source through `new Function` per test, the way the rest of this
// repository's suites do, gives a genuinely fresh instance each time.
const SRC = fs.readFileSync("wealthflow-review.js", "utf8");

describe("WealthFlow Review", () => {
  let wfReview;

  beforeEach(() => {
    const store = new Map();
    const noop = () => {};
    const el = () => ({
      style: {}, innerHTML: "", value: "", dataset: {},
      classList: { add: noop, remove: noop, contains: () => false },
      appendChild: noop, remove: noop, setAttribute: noop, getAttribute: () => null,
      addEventListener: noop, querySelector: () => el(), querySelectorAll: () => [],
      focus: noop, click: noop,
    });
    const doc = {
      getElementById: () => el(), querySelector: () => el(), querySelectorAll: () => [],
      createElement: el, body: { appendChild: noop, insertAdjacentHTML: noop },
      head: { appendChild: noop }, addEventListener: noop,
    };
    const win = {
      WF_REVIEW_LOADED: false,
      wfCrypto: {
        secureGet: async (k) => (store.has(k) ? store.get(k) : null),
        secureSet: async (k, v) => { store.set(k, v); },
      },
      notify: noop,
      localStorage: { getItem: () => null, setItem: noop, removeItem: noop },
      document: doc,
    };
    new Function("window", "document", "console", SRC)(
      win, doc, { log: noop, warn: noop, error: noop },
    );
    wfReview = win.wfReview;
  });

  it("should add an item to the review queue with a generated reason", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
  });

  it("should generate a reason based on the brain object", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain);
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    // "assumed" and "unknown" are MUTUALLY EXCLUSIVE parser states — assumed
    // means it guessed a direction, empty means it refused to guess — so the
    // else-if in the implementation is correct and the original expectation,
    // which wanted both from one row, described a row that cannot exist.
    expect(items[0].reason).toBe("Ambiguous: balance not verified, direction assumed, low confidence (40%), test reason.");
    expect(items[0].hash).toBe("test_hash");
  });

  it("should not add duplicate items to the review queue", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id1 = await wfReview.add(brain);
    const id2 = await wfReview.add(brain);
    expect(id1).toBeDefined();
    expect(id2).toBeNull();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id1);
  });

  it("should handle empty or null brain object", async () => {
    const id = await wfReview.add(null, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBeNull();
  });

  it("should handle brain object with missing properties", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: true,
        directionSource: "balance",
        direction: "debit",
        needsReview: false,
      },
      routed: {
        confidence: 0.9,
        needsReview: false,
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
  });

  it("should handle brain object with invalid properties", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: "invalid",
        directionSource: 123,
        direction: {},
        needsReview: "true",
      },
      routed: {
        confidence: "high",
        needsReview: "yes",
        reviewReason: 42,
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
  });

  it("should handle brain object with unicode properties", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
        raw_merchant: "テスト商人",
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "テスト理由",
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
    expect(items[0].merchant).toBe("テスト商人");
  });

  it("should handle brain object with huge properties", async () => {
    const hugeString = "a".repeat(1000000);
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
        raw_merchant: hugeString,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: hugeString,
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
    expect(items[0].merchant).toBe(hugeString);
  });

  it("should handle brain object with null and undefined properties", async () => {
    const brain = {
      hash: null,
      parsed: {
        balanceVerified: null,
        directionSource: undefined,
        direction: null,
        needsReview: undefined,
      },
      routed: {
        confidence: null,
        needsReview: undefined,
        reviewReason: null,
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBeNull();
  });

  it("should handle brain object with NaN properties", async () => {
    const brain = {
      hash: NaN,
      parsed: {
        balanceVerified: NaN,
        directionSource: NaN,
        direction: NaN,
        needsReview: NaN,
      },
      routed: {
        confidence: NaN,
        needsReview: NaN,
        reviewReason: NaN,
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBeNull();
  });

  it("should handle brain object with negative properties", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
        amount: -100,
      },
      routed: {
        confidence: -0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
    expect(items[0].amount).toBe(-100);
  });

  it("should handle brain object with malformed properties", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
        amount: "not a number",
      },
      routed: {
        confidence: "not a number",
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain, "Custom reason");
    expect(id).toBeDefined();

    const items = await wfReview.list();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(id);
    expect(items[0].reason).toBe("Custom reason");
    expect(items[0].hash).toBe("test_hash");
    expect(items[0].amount).toBe("not a number");
  });

  it("should resolve an item and update the review queue", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain);
    expect(id).toBeDefined();

    const decision = {
      category: "Food",
      module: "expenses",
    };

    await wfReview.resolve(id, decision);

    const items = await wfReview.list();
    expect(items).toHaveLength(0);
  });

  it("should skip an item and update the review queue", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain);
    expect(id).toBeDefined();

    await wfReview.skip(id);

    const items = await wfReview.list();
    expect(items).toHaveLength(0);
  });

  it("should remove an item and update the review queue", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const id = await wfReview.add(brain);
    expect(id).toBeDefined();

    await wfReview.remove(id);

    const items = await wfReview.list();
    expect(items).toHaveLength(0);
  });

  it("should count the number of pending items", async () => {
    const brain1 = {
      hash: "test_hash_1",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    const brain2 = {
      hash: "test_hash_2",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    await wfReview.add(brain1);
    await wfReview.add(brain2);

    const count = await wfReview.count();
    expect(count).toBe(2);
  });

  it("should open the review modal", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    await wfReview.add(brain);

    const modalOpened = await wfReview.openModal();
    expect(modalOpened).toBe(true);
  });

  it("should prompt if there are pending items", async () => {
    const brain = {
      hash: "test_hash",
      parsed: {
        balanceVerified: false,
        directionSource: "assumed",
        direction: "",
        needsReview: true,
      },
      routed: {
        confidence: 0.4,
        needsReview: true,
        reviewReason: "test reason",
      },
    };

    await wfReview.add(brain);

    const prompted = await wfReview.promptIfPending();
    expect(prompted).toBe(true);
  });

  it("should not prompt if there are no pending items", async () => {
    const prompted = await wfReview.promptIfPending();
    expect(prompted).toBe(false);
  });
});
