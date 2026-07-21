import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseIntimation } from "./intimation";

const sample = readFileSync(join(import.meta.dir, "../../samples/sample-intimation-layout.txt"), "utf8");

describe("parseIntimation", () => {
  const r = parseIntimation(sample);

  test("identity and outcome", () => {
    expect(r.pan).toBe("ABCPX1234Z");
    expect(r.ay).toBe("2025-26");
    expect(r.ackNo).toBe("123456789012345");
    expect(r.din).toBe("CPC/2526/A1/999999999");
    expect(r.outcome).toBe("refund");
  });

  test("key figures, incl. wrapped rows (34, 36) and N/A columns", () => {
    expect(r.refundPrincipal).toBe(50500);
    expect(r.interest244A).toBe(1610);
    expect(r.tdsOn244A).toBe(0);
    expect(r.totalRefund).toBe(52110);
    expect(r.adjustedAgainstDemand).toBe(0);
    expect(r.netAmount).toBe(52110);
    expect(r.taxPayableFiled).toBe(10000);
    expect(r.taxPayableComputed).toBe(10000);
  });

  test("filed-vs-computed total-income diff is flagged", () => {
    expect(r.totalIncomeFiled).toBe(500000);
    expect(r.totalIncomeComputed).toBe(500100);
    expect(r.flags.some((f) => f.includes("differs from the filed figure by Rs. 100"))).toBe(true);
  });

  test("s.245 adjustment is flagged when nonzero", () => {
    const adj = sample.replace(
      /220\(2\) after following due process under section 245\(1\)\.\s+0/,
      "220(2) after following due process under section 245(1).                                        5,000",
    );
    const b = parseIntimation(adj);
    expect(b.adjustedAgainstDemand).toBe(5000);
    expect(b.flags.some((f) => f.includes("u/s 245"))).toBe(true);
  });

  test("demand orders are flagged", () => {
    const d = parseIntimation(
      sample
        .replace("You have a Refund for A.Y. 2025-26", "You have a Demand for A.Y. 2025-26")
        .replace("Net Amount Refundable 37=(35-36)", "Net Amount Payable 37=(35-36)"),
    );
    expect(d.outcome).toBe("demand");
    expect(d.flags.some((f) => f.includes("DEMAND"))).toBe(true);
  });

  test("unparseable text fails loudly with a no-retry instruction", () => {
    const e = parseIntimation("not an intimation");
    expect(e.flags.some((f) => f.includes("PARSE FAILED") && f.includes("Do not retry"))).toBe(true);
  });
});
