import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseTis } from "./tis";

const sample = readFileSync(join(import.meta.dir, "../../samples/sample-tis-layout.txt"), "utf8");

describe("parseTis", () => {
  const r = parseTis(sample);

  test("identity from the front page", () => {
    expect(r.identity.pan).toBe("ABCPX1234Z");
    expect(r.identity.name).toBe("TEST TAXPAYER");
    expect(r.identity.dob).toBe("01/01/1970");
    expect(r.identity.fy).toBe("2025-26");
    expect(r.identity.ay).toBe("2026-27");
    expect(r.identity.generatedOn).toBe("01/07/2026");
  });

  test("reconciliation targets use the accepted column", () => {
    expect(r.reconciliation).toEqual({
      tisDividend: 12000,
      tisSavingsInterest: 1500,
      tisBusinessReceipts: 100000,
    });
  });

  test("unknown category is flagged with a park instruction, not dropped silently", () => {
    const flag = r.flags.find((f) => f.includes("Lease of biofuel plant"));
    expect(flag).toBeDefined();
    expect(flag).toContain("missing-functionality.md");
  });

  test("line items reconcile per category; TDS dedup rows are skipped", () => {
    expect(r.lineItems.tisDividend?.map((i) => i.amount)).toEqual([10000, 2000]);
    expect(r.lineItems.tisDividend?.[0].name).toBe("ALPHA INDUSTRIES LIMITED");
    // wrapped multi-line name is reassembled, reporting-entity suffix stripped
    expect(r.lineItems.tisDividend?.[1].name).toBe(
      "Registrar Services Limited - BETA Asset Management Company Limited(G)",
    );
    expect(r.lineItems.tisSavingsInterest?.map((i) => i.amount)).toEqual([1500]);
  });

  test("a TDS/TCS row that carries the accepted value is a real line item", () => {
    expect(r.lineItems.tisBusinessReceipts?.[0]).toEqual({
      name: "DELTA CONSULTING PRIVATE LIMITED",
      amount: 100000,
    });
  });

  test("non-reconciling line items are dropped with a flag, targets survive", () => {
    // corrupt one line-item amount so the dividend items no longer sum to 12,000
    const broken = sample.replace(/10,000             10,000                  10,000/, "10,000              9,999                   9,999");
    const b = parseTis(broken);
    expect(b.reconciliation.tisDividend).toBe(12000); // target untouched
    expect(b.lineItems.tisDividend).toBeUndefined();
    expect(b.flags.some((f) => f.includes("tisDividend") && f.includes("did not reconcile"))).toBe(true);
  });

  test("empty text fails loudly with a no-retry instruction", () => {
    const e = parseTis("not a TIS at all");
    expect(e.flags.some((f) => f.includes("TIS PARSE FAILED") && f.includes("Do not retry"))).toBe(true);
  });
});
