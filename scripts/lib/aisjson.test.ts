import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  decryptAisExport,
  isEncryptedAisExport,
  normalizeDob,
  parseAisJson,
} from "./aisjson";

const encrypted = readFileSync(join(import.meta.dir, "../../samples/sample-ais-export-encrypted.txt"), "utf8");
// Fictitious credentials the fixture was encrypted with (see samples generator).
const PAN = "ABCPZ1234K";
const DOB = "1985-04-12";

describe("normalizeDob", () => {
  test("accepts the formats extract can hand it", () => {
    expect(normalizeDob("1985-04-12")).toBe("12041985"); // prefill
    expect(normalizeDob("12/04/1985")).toBe("12041985"); // statement-data / TIS
    expect(normalizeDob("12-04-1985")).toBe("12041985");
    expect(normalizeDob("12041985")).toBe("12041985");
    expect(normalizeDob("garbage")).toBeNull();
  });
});

describe("isEncryptedAisExport", () => {
  test("true for the 64-hex-header export, false for plain JSON", () => {
    expect(isEncryptedAisExport(encrypted)).toBe(true);
    expect(isEncryptedAisExport('{"partB":{}}')).toBe(false);
  });
});

describe("decryptAisExport", () => {
  test("round-trips to valid JSON with the right password", () => {
    const j = JSON.parse(decryptAisExport(encrypted, PAN, "12041985"));
    expect(j.metadata.loggedInPan).toBe(PAN);
  });
  test("wrong DOB throws (bad padding), never silently wrong", () => {
    expect(() => decryptAisExport(encrypted, PAN, "01011900")).toThrow();
  });
});

describe("parseAisJson (encrypted export end-to-end)", () => {
  const r = parseAisJson(encrypted, { pan: PAN, dob: DOB });

  test("supported, with identity from the decrypted file", () => {
    expect(r.supported).toBe(true);
    expect(r.identity?.pan).toBe(PAN);
    expect(r.identity?.name).toBe("TEST TAXPAYER");
    expect(r.identity?.dob).toBe("12/04/1985");
    expect(r.identity?.fy).toBe("2025-26");
    expect(r.identity?.ay).toBe("2026-27");
  });

  test("dedups SFT-vs-TDS: dividend total is the SFT superset (700), not the sum (1000) nor the TDS subset (300)", () => {
    expect(r.reconciliation?.tisDividend).toBe(700);
    expect(r.reconciliation?.tisSavingsInterest).toBe(1200);
  });

  test("emits a transparency flag naming both codes when a category is double-listed", () => {
    expect(r.flags?.some((f) => f.includes("Dividend") && f.includes("TDS-194") && f.includes("SFT-015"))).toBe(true);
  });

  test("line items reconcile to the target and drop Inactive rows", () => {
    // dividend/savings NAME comes from the parent l2 "Information Source" (TAN suffix
    // stripped), NOT from an l1 field - dividend l1 has no name at all.
    expect(r.lineItems?.tisDividend).toEqual([{ name: "ACME LTD", amount: 700 }]);
    // savings has an Inactive 50 row that must be excluded, leaving 1200; named by bank
    expect(r.lineItems?.tisSavingsInterest).toEqual([{ name: "GLOBAL BANK LIMITED", amount: 1200 }]);
  });

  test("every income line item carries a non-empty name (the dividend-name gap)", () => {
    const all = Object.values(r.lineItems ?? {}).flat();
    expect(all.length).toBeGreaterThan(0);
    expect(all.filter((i) => !i.name).length).toBe(0);
  });
});

describe("capital gains from the SOS l1 detail", () => {
  const r = parseAisJson(encrypted, { pan: PAN, dob: DOB });
  const cg = r.capitalGains!;

  test("securities-sale total becomes a reconciliation target", () => {
    expect(r.reconciliation?.tisSecuritiesSale).toBe(4300);
  });

  test("Active lots group by ISIN+term; Inactive row is excluded", () => {
    // 4 Active lots: two ACME (Short, same ISIN) merge; BHARAT (Long); CIPLA (Short)
    expect(cg.shortTerm.length).toBe(2);
    expect(cg.longTerm.length).toBe(1);
    const acme = cg.shortTerm.find((i) => i.isin === "INE001A01001")!;
    expect(acme.saleValue).toBe(1500); // 1000 + 500
    expect(acme.cost).toBe(900); // 600 + 300
    expect(acme.saleDate).toBe("20/06/2025"); // latest of the two
  });

  test("lots reconcile to the securities-sale total (no MISMATCH flag)", () => {
    const total = [...cg.shortTerm, ...cg.longTerm].reduce((a, i) => a + i.saleValue, 0);
    expect(total).toBe(4300);
    expect(r.flags?.some((f) => f.includes("MISMATCH"))).toBeFalsy();
  });

  test("zero-cost lot is costUnconfirmed + offMarket and flagged", () => {
    const cipla = cg.shortTerm.find((i) => i.isin === "INE003C01003")!;
    expect(cipla.cost).toBe(0);
    expect(cipla.costUnconfirmed).toBe(true);
    expect((cipla as any).offMarket).toBe(true);
    expect(r.flags?.some((f) => f.includes("ZERO cost"))).toBe(true);
  });

  test("Inactive lot never appears (would have been 999)", () => {
    expect([...cg.shortTerm, ...cg.longTerm].some((i) => i.saleValue === 999)).toBe(false);
  });

  test("listed-equity lots carry no assetClass override (builder-accepted)", () => {
    expect(cg.longTerm[0].assetClass).toBeUndefined();
    expect(cg.longTerm[0].source).toBe("AIS SFT (sale of securities)");
  });
});

describe("parseAisJson (guard paths)", () => {
  test("encrypted but no PAN/DOB -> unsupported with a clear reason, never a throw", () => {
    const r = parseAisJson(encrypted, {});
    expect(r.supported).toBe(false);
    expect(r.reason).toContain("PAN/DOB");
  });
  test("wrong password -> unsupported, not a crash", () => {
    const r = parseAisJson(encrypted, { pan: PAN, dob: "1999-09-09" });
    expect(r.supported).toBe(false);
    expect(r.reason).toContain("decryption failed");
  });
  test("plaintext JSON of the wrong shape -> unsupported", () => {
    const r = parseAisJson('{"hello":"world"}');
    expect(r.supported).toBe(false);
  });
  test("accepts an already-parsed plaintext object (back-compat)", () => {
    const plain = JSON.parse(decryptAisExport(encrypted, PAN, "12041985"));
    const r = parseAisJson(plain);
    expect(r.supported).toBe(true);
    expect(r.reconciliation?.tisDividend).toBe(700);
  });
});
