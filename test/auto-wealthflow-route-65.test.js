import { describe, it, expect } from "vitest";

describe("wealthflow-route.js", () => {
  let WFRoute;

  beforeEach(async () => {
    // Set up a minimal global/window shim
    global.window = {};
    // Load the module
    await import('../wealthflow-route.js');
    WFRoute = global.window.WFRoute;
  });

  afterEach(() => {
    // Clean up the global/window shim
    delete global.window;
  });

  describe("routeTransaction", () => {
    it("should route a credit-card debit transaction to CC One-Time", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: "Purchase at Amazon"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should route a credit-card credit transaction to cc_payment", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "credit",
        description: "Payment received"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("cc_payment");
    });

    it("should route a bank-account debit transaction to Expenses", () => {
      const transaction = {
        accountType: "bank_account",
        direction: "debit",
        description: "Grocery shopping"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("Expenses");
    });

    it("should route a bank-account credit transaction to Income if it looks like real income", () => {
      const transaction = {
        accountType: "bank_account",
        direction: "credit",
        description: "Salary deposit"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("Income");
    });

    it("should route a bank-account credit transaction to Expenses if it does not look like real income", () => {
      const transaction = {
        accountType: "bank_account",
        direction: "credit",
        description: "Refund received"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("Expenses");
    });

    it("should handle empty transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: ""
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle null transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: null
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle undefined transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: undefined
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle NaN transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: NaN
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle negative transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: -123
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle huge transaction description", () => {
      const hugeDescription = "a".repeat(10000);
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: hugeDescription
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle unicode transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: "Purchase at 亚马逊"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });

    it("should handle malformed transaction description", () => {
      const transaction = {
        accountType: "credit_card",
        direction: "debit",
        description: "Purchase at <script>alert('XSS')</script>"
      };
      expect(WFRoute.routeTransaction(transaction)).toBe("CC One-Time");
    });
  });

  describe("accountTypeForLast4", () => {
    it("should return the correct account type for a given last4", () => {
      // Assuming the module has a way to set up test data
      // This is a placeholder and should be replaced with actual test data
      expect(WFRoute.accountTypeForLast4("1234")).toBe("credit_card");
    });

    it("should handle empty last4", () => {
      expect(WFRoute.accountTypeForLast4("")).toBeUndefined();
    });

    it("should handle null last4", () => {
      expect(WFRoute.accountTypeForLast4(null)).toBeUndefined();
    });

    it("should handle undefined last4", () => {
      expect(WFRoute.accountTypeForLast4(undefined)).toBeUndefined();
    });

    it("should handle NaN last4", () => {
      expect(WFRoute.accountTypeForLast4(NaN)).toBeUndefined();
    });

    it("should handle negative last4", () => {
      expect(WFRoute.accountTypeForLast4(-1234)).toBeUndefined();
    });

    it("should handle huge last4", () => {
      const hugeLast4 = "1".repeat(10000);
      expect(WFRoute.accountTypeForLast4(hugeLast4)).toBeUndefined();
    });

    it("should handle unicode last4", () => {
      expect(WFRoute.accountTypeForLast4("亚马逊")).toBeUndefined();
    });

    it("should handle malformed last4", () => {
      expect(WFRoute.accountTypeForLast4("<script>alert('XSS')</script>")).toBeUndefined();
    });
  });

  describe("inferAccountType", () => {
    it("should infer the correct account type for a given description", () => {
      expect(WFRoute.inferAccountType("Credit Card")).toBe("credit_card");
    });

    it("should handle empty description", () => {
      expect(WFRoute.inferAccountType("")).toBeUndefined();
    });

    it("should handle null description", () => {
      expect(WFRoute.inferAccountType(null)).toBeUndefined();
    });

    it("should handle undefined description", () => {
      expect(WFRoute.inferAccountType(undefined)).toBeUndefined();
    });

    it("should handle NaN description", () => {
      expect(WFRoute.inferAccountType(NaN)).toBeUndefined();
    });

    it("should handle negative description", () => {
      expect(WFRoute.inferAccountType(-123)).toBeUndefined();
    });

    it("should handle huge description", () => {
      const hugeDescription = "a".repeat(10000);
      expect(WFRoute.inferAccountType(hugeDescription)).toBeUndefined();
    });

    it("should handle unicode description", () => {
      expect(WFRoute.inferAccountType("信用卡")).toBe("credit_card");
    });

    it("should handle malformed description", () => {
      expect(WFRoute.inferAccountType("<script>alert('XSS')</script>")).toBeUndefined();
    });
  });

  describe("expenseCategory", () => {
    it("should return the correct expense category for a given description", () => {
      expect(WFRoute.expenseCategory("Grocery shopping")).toBe("Groceries");
    });

    it("should handle empty description", () => {
      expect(WFRoute.expenseCategory("")).toBeUndefined();
    });

    it("should handle null description", () => {
      expect(WFRoute.expenseCategory(null)).toBeUndefined();
    });

    it("should handle undefined description", () => {
      expect(WFRoute.expenseCategory(undefined)).toBeUndefined();
    });

    it("should handle NaN description", () => {
      expect(WFRoute.expenseCategory(NaN)).toBeUndefined();
    });

    it("should handle negative description", () => {
      expect(WFRoute.expenseCategory(-123)).toBeUndefined();
    });

    it("should handle huge description", () => {
      const hugeDescription = "a".repeat(10000);
      expect(WFRoute.expenseCategory(hugeDescription)).toBeUndefined();
    });

    it("should handle unicode description", () => {
      expect(WFRoute.expenseCategory("购物")).toBeUndefined();
    });

    it("should handle malformed description", () => {
      expect(WFRoute.expenseCategory("<script>alert('XSS')</script>")).toBeUndefined();
    });
  });

  describe("incomeKind", () => {
    it("should return the correct income kind for a given description", () => {
      expect(WFRoute.incomeKind("Salary deposit")).toBe("salary");
    });

    it("should handle empty description", () => {
      expect(WFRoute.incomeKind("")).toBeUndefined();
    });

    it("should handle null description", () => {
      expect(WFRoute.incomeKind(null)).toBeUndefined();
    });

    it("should handle undefined description", () => {
      expect(WFRoute.incomeKind(undefined)).toBeUndefined();
    });

    it("should handle NaN description", () => {
      expect(WFRoute.incomeKind(NaN)).toBeUndefined();
    });

    it("should handle negative description", () => {
      expect(WFRoute.incomeKind(-123)).toBeUndefined();
    });

    it("should handle huge description", () => {
      const hugeDescription = "a".repeat(10000);
      expect(WFRoute.incomeKind(hugeDescription)).toBeUndefined();
    });

    it("should handle unicode description", () => {
      expect(WFRoute.incomeKind("工资存款")).toBe("salary");
    });

    it("should handle malformed description", () => {
      expect(WFRoute.incomeKind("<script>alert('XSS')</script>")).toBeUndefined();
    });
  });
});
