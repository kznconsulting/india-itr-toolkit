import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse26as, periodsFromRows } from "./f26as";

const sample = readFileSync(join(import.meta.dir, "../../samples/sample-26as-layout.txt"), "utf8");

describe("parse26as", () => {
  const r = parse26as(sample);

  test("identity", () => {
    expect(r.identity.pan).toBe("ABCPX1234Z");
    expect(r.identity.name).toBe("TEST TAXPAYER");
    expect(r.identity.fy).toBe("2025-26");
    expect(r.identity.ay).toBe("2026-27");
    expect(r.identity.updatedTill).toBe("01/07/2026");
  });

  test("deductors with sections, rows, and reversal-netted totals", () => {
    expect(r.deductors).toHaveLength(2);
    const [alpha, epsilon] = r.deductors;
    expect(alpha.name).toBe("ALPHA INDUSTRIES LIMITED");
    expect(alpha.tan).toBe("MUMA11111A");
    expect(alpha.sections).toEqual(["194"]);
    expect(alpha.tds).toBe(1000);
    expect(alpha.rows).toHaveLength(2);
    // reversal (remark G) rows net inside the header total
    expect(epsilon.tds).toBe(2000);
    expect(epsilon.rows.map((x) => x.tds)).toEqual([1500, -500, 1000]);
    expect(r.totalTds).toBe(3000);
    expect(r.flags).toEqual([]);
  });

  test("rows-vs-header mismatch is flagged, header wins", () => {
    // drop the reversal row so Epsilon's rows sum to 2500 against a header of 2000
    const broken = sample
      .split("\n")
      .filter((l) => !l.includes("-5000.00"))
      .join("\n");
    const b = parse26as(broken);
    expect(b.flags.some((f) => f.includes("EPSILON BANK LIMITED") && f.includes("header"))).toBe(true);
    expect(b.deductors[1].tds).toBe(2000);
  });

  test("non-Final booking status is flagged", () => {
    const broken = sample.replace(
      "    3             194A              01-Oct-2025                 F  ",
      "    3             194A              01-Oct-2025                 U  ",
    );
    const b = parse26as(broken);
    expect(b.flags.some((f) => f.includes('"U"') && f.includes("EPSILON"))).toBe(true);
  });

  test("a non-modelled PART with transactions is flagged with a park instruction", () => {
    const broken = sample.replace(
      /PART-VI-Details of Tax Collected at Source[\s\S]*?No Transactions Present/,
      "PART-VI-Details of Tax Collected at Source\n    1   SOME COLLECTOR   MUMC44444C   5000.00   50.00   50.00",
    );
    const b = parse26as(broken);
    const flag = b.flags.find((f) => f.includes("PART-VI"));
    expect(flag).toBeDefined();
    expect(flag).toContain("missing-functionality.md");
  });

  test("empty text fails loudly with a no-retry instruction", () => {
    const e = parse26as("not a 26AS");
    expect(e.flags.some((f) => f.includes("26AS PARSE FAILED") && f.includes("Do not retry"))).toBe(true);
  });
});

describe("periodsFromRows", () => {
  test("payment dates land in the correct advance-tax period columns", () => {
    const row = (txnDate: string, paid: number) => ({
      section: "194",
      txnDate,
      bookingStatus: "F",
      bookingDate: txnDate,
      remark: "-",
      paid,
      tds: 0,
      deposited: 0,
    });
    expect(
      periodsFromRows([
        row("10/06/2025", 100), // 10 Jun -> L
        row("16/06/2025", 200), // 16 Jun -> M
        row("30/09/2025", 300), // 30 Sep -> N
        row("15/01/2026", 400), // 15 Jan -> O (fiscal wrap)
        row("20/03/2026", 500), // 20 Mar -> P
        row("15/03/2026", 600), // 15 Mar -> O
      ]),
    ).toEqual({ L: 100, M: 200, N: 300, O: 1000, P: 500 });
  });
});
