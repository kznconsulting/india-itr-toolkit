import { expect, test } from "bun:test";
import {
  ageBandFromDob,
  computeRefundInterest244A,
  computeTax,
  computeTotalTax,
} from "./tax";

const t = (o: Parameters<typeof computeTax>[0]) => computeTax(o)!;
const tt = (o: Parameters<typeof computeTotalTax>[0]) => computeTotalTax(o)!;

test("new regime AY 2026-27: ₹12L is fully rebated", () => {
  const bd = t({ totalIncome: 1_200_000, regime: "new", ay: "2026-27" });
  expect(bd.slabTax).toBe(60_000);
  expect(bd.rebate87A).toBe(60_000);
  expect(bd.total).toBe(0);
});

test("new regime AY 2026-27: marginal relief just above ₹12L", () => {
  const bd = t({ totalIncome: 1_210_000, regime: "new", ay: "2026-27" });
  expect(bd.afterRebate).toBe(10_000);
  expect(bd.marginalReliefApplied).toBe(true);
  expect(bd.total).toBe(10_400);
});

test("new regime AY 2026-27: ₹15.65L", () => {
  const bd = t({ totalIncome: 1_565_000, regime: "new", ay: "2026-27" });
  expect(bd.slabTax).toBe(114_750);
  expect(bd.cess).toBe(4_590);
  expect(bd.total).toBe(119_340);
});

test("new regime AY 2026-27: 10% surcharge above ₹50L", () => {
  const bd = t({ totalIncome: 6_000_000, regime: "new", ay: "2026-27" });
  expect(bd.slabTax).toBe(1_380_000);
  expect(bd.surcharge).toBe(138_000);
  expect(bd.total).toBe(1_578_720);
});

test("new regime AY 2026-27: surcharge marginal relief just above ₹50L", () => {
  const bd = t({ totalIncome: 5_010_000, regime: "new", ay: "2026-27" });
  // tax at 50L is 10,80,000; relief caps tax+surcharge at 10,80,000 + 10,000
  expect(bd.afterRebate + bd.surcharge).toBe(1_090_000);
  expect(bd.marginalReliefApplied).toBe(true);
});

test("old regime AY 2026-27: ₹4.9L fully rebated", () => {
  const bd = t({ totalIncome: 490_000, regime: "old", ay: "2026-27" });
  expect(bd.slabTax).toBe(12_000);
  expect(bd.total).toBe(0);
});

test("old regime AY 2026-27: ₹10L", () => {
  const bd = t({ totalIncome: 1_000_000, regime: "old", ay: "2026-27" });
  expect(bd.total).toBe(117_000);
});

test("old regime senior citizen: ₹3L within exemption", () => {
  const bd = t({ totalIncome: 300_000, regime: "old", ay: "2026-27", age: "s60to79" });
  expect(bd.total).toBe(0);
});

test("new regime AY 2025-26: ₹7L fully rebated", () => {
  const bd = t({ totalIncome: 700_000, regime: "new", ay: "2025-26" });
  expect(bd.slabTax).toBe(20_000);
  expect(bd.total).toBe(0);
});

test("unsupported AY returns null", () => {
  expect(computeTax({ totalIncome: 1_000_000, regime: "new", ay: "2019-20" })).toBeNull();
});

test("244A interest matches a real AY 2025-26 CPC intimation", () => {
  // Intimation: refund 1,00,273, filed 13/08/2025 (due date extended to 15/09/2025),
  // refund granted 23/10/2025 -> principal 1,00,200 x 0.5% x 7 months = 3,507
  const r = computeRefundInterest244A({
    refundAmount: 100_273,
    ay: "2025-26",
    refundDate: "2025-10-23",
    filingDate: "2025-08-13",
    dueDate: "2025-09-15",
  })!;
  expect(r.principal).toBe(100_200);
  expect(r.months).toBe(7);
  expect(r.interest).toBe(3_507);
  expect(r.startedFromFiling).toBe(false);
});

test("244A interest runs from the filing month for belated returns", () => {
  const r = computeRefundInterest244A({
    refundAmount: 50_000,
    ay: "2025-26",
    refundDate: "2026-02-10",
    filingDate: "2025-12-05",
    dueDate: "2025-09-15",
  })!;
  expect(r.startedFromFiling).toBe(true);
  expect(r.months).toBe(3); // Dec, Jan, Feb
  expect(r.interest).toBe(750); // 50,000 x 0.5% x 3
});

test("244A: rule 119A floors the principal; proviso denies interest under 10% of tax", () => {
  const floored = computeRefundInterest244A({
    refundAmount: 99,
    ay: "2025-26",
    refundDate: "2025-10-23",
  })!;
  expect(floored.principal).toBe(0);
  expect(floored.interest).toBe(0);
  const denied = computeRefundInterest244A({
    refundAmount: 500,
    ay: "2025-26",
    refundDate: "2025-10-23",
    taxDetermined: 10_000,
  })!;
  expect(denied.interest).toBe(0);
});

// ---- special-rate gains + NRI (validation figures from a real filed AY 2025-26
// ITR-2, docs/missing-functionality.md - amounts only, no identity data) ----

test("computeTotalTax reproduces the filed NRI AY 2025-26 ITR-2 to the rupee", () => {
  const bd = tt({
    slabIncome: 1_121_891,
    regime: "new",
    ay: "2025-26",
    residentialStatus: "nri",
    gains: {
      stcg111ABefore: 976_496, // ScheduleSI 1A_BE @15%
      stcg111AOnAfter: 736_049, // ScheduleSI 1A @20%
      ltcg112ABefore: 96_114, // ScheduleSI 2A_BE - under the ₹1.25L exemption
    },
  });
  expect(Math.round(bd.slab.slabTax)).toBe(68_284); // TaxAtNormalRatesOnAggrInc
  expect(bd.slab.rebate87A).toBe(0); // 87A is resident-only
  expect(bd.stcg111A.before.tax).toBe(146_474);
  expect(bd.stcg111A.onAfter.tax).toBe(147_210);
  expect(bd.ltcg112A.tax).toBe(0); // fully inside the exemption
  expect(bd.specialRateTax).toBe(293_684); // TaxAtSpecialRates
  expect(bd.taxPayable).toBe(361_968); // TaxPayableOnTotInc
  expect(bd.cess).toBe(14_479); // EducationCess
  expect(bd.grossTaxLiability).toBe(376_447); // GrossTaxLiability
  expect(bd.surcharge).toBe(0); // total income ₹29.3L < ₹50L
  expect(bd.basicExemptionAdjustment).toBe(0); // NRI: adjustment not available
});

test("NRI gets no 87A rebate even under the threshold", () => {
  const bd = t({
    totalIncome: 500_000,
    regime: "new",
    ay: "2025-26",
    residentialStatus: "nri",
  });
  expect(bd.rebate87A).toBe(0);
  expect(bd.total).toBe(10_400); // 2L @5% + 4% cess
});

test("special-rate income counts toward the 87A threshold", () => {
  // Slab income alone is under ₹12L, but gains push total income over: no rebate.
  const over = t({
    totalIncome: 1_100_000,
    regime: "new",
    ay: "2026-27",
    specialRateIncome: 300_000,
  });
  expect(over.rebate87A).toBe(0);
  // Small gains that keep total income under the threshold: full rebate survives.
  const under = t({
    totalIncome: 1_100_000,
    regime: "new",
    ay: "2026-27",
    specialRateIncome: 50_000,
  });
  expect(under.rebate87A).toBe(50_000);
  expect(under.total).toBe(0);
});

test("112A exemption applies even when the rebate is lost", () => {
  const bd = tt({
    slabIncome: 1_200_000,
    regime: "new",
    ay: "2026-27",
    gains: { ltcg112AOnAfter: 200_000 },
  });
  expect(bd.ltcg112A.exemption).toBe(125_000);
  expect(bd.ltcg112A.tax).toBe(9_375); // 75,000 @12.5%
  expect(bd.slab.rebate87A).toBe(0); // total income ₹14L > ₹12L threshold
  expect(bd.taxPayable).toBe(69_375);
  expect(bd.total).toBe(72_150);
});

test("resident's unexhausted basic exemption absorbs STCG; NRI's does not", () => {
  const resident = tt({
    slabIncome: 300_000, // ₹1L short of the AY 2026-27 ₹4L zero band
    regime: "new",
    ay: "2026-27",
    gains: { stcg111AOnAfter: 150_000 },
  });
  expect(resident.basicExemptionAdjustment).toBe(100_000);
  expect(resident.stcg111A.tax).toBe(10_000); // 50,000 @20%
  expect(resident.total).toBe(10_400);
  const nri = tt({
    slabIncome: 300_000,
    regime: "new",
    ay: "2026-27",
    residentialStatus: "nri",
    gains: { stcg111AOnAfter: 150_000 },
  });
  expect(nri.basicExemptionAdjustment).toBe(0);
  expect(nri.stcg111A.tax).toBe(30_000);
  expect(nri.total).toBe(31_200);
});

test("old regime: leftover 87A cap offsets 111A tax but never 112A tax", () => {
  const bd = tt({
    slabIncome: 400_000,
    regime: "old",
    ay: "2026-27",
    gains: { stcg111AOnAfter: 50_000 },
  });
  expect(bd.slab.rebate87A).toBe(7_500); // slab tax fully rebated
  expect(bd.rebate87AOnSpecial).toBe(5_000); // 12,500 cap - 7,500 used
  expect(bd.taxPayable).toBe(5_000); // 10,000 STCG tax - 5,000
  expect(bd.total).toBe(5_200);
});

test("age band uses FY end (Mar 31 of the AY's first year)", () => {
  expect(ageBandFromDob("1966-03-31", "2026-27")).toBe("s60to79"); // turns 60 on 2026-03-31
  expect(ageBandFromDob("1966-04-01", "2026-27")).toBe("lt60");
  expect(ageBandFromDob("1988-04-15", "2026-27")).toBe("lt60");
});
