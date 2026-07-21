import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse26asText } from "./f26astext";

const sample = readFileSync(join(import.meta.dir, "../../samples/sample-26as-text.txt"), "utf8");

describe("parse26asText", () => {
  const r = parse26asText(sample);

  test("identity from the header row", () => {
    expect(r.identity.pan).toBe("ABCPZ1234K");
    expect(r.identity.name).toBe("TEST TAXPAYER");
    expect(r.identity.fy).toBe("2025-26");
    expect(r.identity.ay).toBe("2026-27");
    expect(r.identity.updatedTill).toBe("01-Jul-2026");
  });

  test("Part-I deductors with header totals", () => {
    expect(r.deductors.length).toBe(2);
    const acme = r.deductors[0];
    expect(acme.name).toBe("ACME STEEL LIMITED");
    expect(acme.tan).toBe("BLRA00001A");
    expect(acme.tds).toBe(1000);
    expect(acme.rows.length).toBe(2); // includes the reversal
    expect(acme.sections).toEqual(["194"]);
  });

  test("reversal (remark G, negative) nets to the header total - no flag", () => {
    // 1200 + (-200) = 1000 == header 1000
    const acme = r.deductors[0];
    expect(acme.rows[1].remark).toBe("G");
    expect(acme.rows[1].tds).toBe(-200);
    expect(r.flags.filter((f) => f.includes("ACME"))).toEqual([]);
  });

  test("dates normalised to DD/MM/YYYY", () => {
    expect(r.deductors[0].rows[0].txnDate).toBe("15/05/2025");
    expect(r.deductors[1].rows[0].txnDate).toBe("30/09/2025");
  });

  test("totalTds sums the deductor headers", () => {
    expect(r.totalTds).toBe(6000); // 1000 + 5000
  });

  test("empty Parts II-X (No Transactions marker) raise no flags", () => {
    expect(r.flags).toEqual([]);
  });
});

describe("parse26asText guards", () => {
  test("a populated Part II-X is flagged, never silently dropped", () => {
    const withPartVII = sample.replace(
      "PART-VII - Details of Paid Refund\nSr. No.^Assessment Year^Mode^Refund Issued^Nature of Refund^Amount of Refund^Interest^Date of Payment^Remarks\n^^^*********** No Transactions Present ***********^^",
      "PART-VII - Details of Paid Refund\nSr. No.^Assessment Year^Mode^Refund Issued^Nature of Refund^Amount of Refund^Interest^Date of Payment^Remarks\n1^2025-26^ECS^15-Nov-2025^Refund^37000.00^500.00^15-Nov-2025^-",
    );
    const r = parse26asText(withPartVII);
    expect(r.flags.some((f) => f.includes("PART-VII"))).toBe(true);
  });

  test("deductor whose rows do not reconcile to its header is flagged", () => {
    const broken = sample.replace("^1^194A^30-Sep-2025^F^15-Oct-2025^-^50000.00^5000.00^5000.00", "^1^194A^30-Sep-2025^F^15-Oct-2025^-^50000.00^4000.00^4000.00");
    const r = parse26asText(broken);
    expect(r.flags.some((f) => f.includes("GLOBAL BANK") && f.includes("mis-read"))).toBe(true);
  });

  test("not-a-26AS text fails loudly", () => {
    const r = parse26asText("just some random text\nwith no parts");
    expect(r.flags.some((f) => f.includes("PARSE FAILED"))).toBe(true);
    expect(r.deductors.length).toBe(0);
  });
});
