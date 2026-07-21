// Slab engine for cross-checking the ITD utility's computation and comparing regimes.
// Scope: normal slab-rate income, 111A STCG and 112A LTCG special rates (incl. the 112A
// exemption, the resident-only basic-exemption adjustment, and the resident-only 87A gate),
// composed by computeTotalTax(). Not modelled: s.112 non-equity LTCG (property, debt, gold),
// AMT, relief u/s 89/90/91, agricultural-income aggregation. The utility/portal is
// authoritative.

export type Regime = "new" | "old";
export type AgeBand = "lt60" | "s60to79" | "gte80";
export type ResidentialStatus = "resident" | "nri";

interface Slab {
  upTo: number | null; // null = no upper bound
  rate: number;
}

interface RegimeRules {
  slabs: Slab[];
  rebate: { threshold: number; cap: number; marginalRelief: boolean };
  surcharge: { threshold: number; rate: number }[]; // ascending by threshold
  standardDeduction: number;
}

const CESS_RATE = 0.04;

const NEW_SURCHARGE = [
  { threshold: 5_000_000, rate: 0.1 },
  { threshold: 10_000_000, rate: 0.15 },
  { threshold: 20_000_000, rate: 0.25 }, // capped at 25% under 115BAC
];

const OLD_SURCHARGE = [
  { threshold: 5_000_000, rate: 0.1 },
  { threshold: 10_000_000, rate: 0.15 },
  { threshold: 20_000_000, rate: 0.25 },
  { threshold: 50_000_000, rate: 0.37 },
];

function newRegimeRules(ay: string): RegimeRules | null {
  if (ay === "2026-27") {
    return {
      slabs: [
        { upTo: 400_000, rate: 0 },
        { upTo: 800_000, rate: 0.05 },
        { upTo: 1_200_000, rate: 0.1 },
        { upTo: 1_600_000, rate: 0.15 },
        { upTo: 2_000_000, rate: 0.2 },
        { upTo: 2_400_000, rate: 0.25 },
        { upTo: null, rate: 0.3 },
      ],
      rebate: { threshold: 1_200_000, cap: 60_000, marginalRelief: true },
      surcharge: NEW_SURCHARGE,
      standardDeduction: 75_000,
    };
  }
  if (ay === "2025-26") {
    return {
      slabs: [
        { upTo: 300_000, rate: 0 },
        { upTo: 700_000, rate: 0.05 },
        { upTo: 1_000_000, rate: 0.1 },
        { upTo: 1_200_000, rate: 0.15 },
        { upTo: 1_500_000, rate: 0.2 },
        { upTo: null, rate: 0.3 },
      ],
      rebate: { threshold: 700_000, cap: 25_000, marginalRelief: true },
      surcharge: NEW_SURCHARGE,
      standardDeduction: 75_000,
    };
  }
  return null;
}

function oldRegimeRules(ay: string, age: AgeBand): RegimeRules | null {
  if (ay !== "2025-26" && ay !== "2026-27") return null;
  const exemption = age === "gte80" ? 500_000 : age === "s60to79" ? 300_000 : 250_000;
  return {
    slabs: [
      { upTo: exemption, rate: 0 },
      { upTo: 500_000, rate: 0.05 },
      { upTo: 1_000_000, rate: 0.2 },
      { upTo: null, rate: 0.3 },
    ],
    rebate: { threshold: 500_000, cap: 12_500, marginalRelief: false },
    surcharge: OLD_SURCHARGE,
    standardDeduction: 50_000,
  };
}

// Public view of a regime's rules, for tooling outside TypeScript (scripts/tax-cli.ts
// serves this as JSON to scripts/build-statement.py). Keeps slab rules single-source.
export function getRules(
  regime: Regime,
  ay: string,
  age: AgeBand = "lt60",
): (RegimeRules & { cessRate: number }) | null {
  const rules = regime === "new" ? newRegimeRules(ay) : oldRegimeRules(ay, age);
  return rules ? { ...rules, cessRate: CESS_RATE } : null;
}

function slabTax(slabs: Slab[], income: number): number {
  let tax = 0;
  let lower = 0;
  for (const slab of slabs) {
    const upper = slab.upTo ?? Infinity;
    if (upper <= lower) continue; // collapsed band (super-senior exemption swallows the 5% band)
    if (income > lower) tax += (Math.min(income, upper) - lower) * slab.rate;
    lower = upper;
  }
  return tax;
}

const round10 = (n: number) => Math.round(n / 10) * 10;

export interface TaxBreakdown {
  regime: Regime;
  ay: string;
  totalIncome: number;
  slabTax: number;
  rebate87A: number;
  afterRebate: number;
  surcharge: number;
  cess: number;
  total: number; // rounded to nearest ₹10 (s.288B)
  marginalReliefApplied: boolean;
}

export function computeTax(opts: {
  totalIncome: number;
  regime: Regime;
  ay: string;
  age?: AgeBand;
  // s.87A is scoped to "an individual, being a resident in India": NRIs get no rebate at
  // any income level. Old-regime senior/super-senior exemption slabs are likewise
  // resident-only, so NRIs are priced on the base (lt60) old-regime slabs.
  residentialStatus?: ResidentialStatus;
  // Taxable special-rate income (111A/112A gains) outside `totalIncome`. Counted ONLY
  // toward the 87A eligibility threshold - the rebate itself stays capped to slab tax.
  // A client whose slab income is under the threshold but whose gains push total income
  // over it gets NO rebate (per the utility's and FA 2025's reading of s.87A).
  specialRateIncome?: number;
}): TaxBreakdown | null {
  const resident = (opts.residentialStatus ?? "resident") === "resident";
  const rules =
    opts.regime === "new"
      ? newRegimeRules(opts.ay)
      : oldRegimeRules(opts.ay, resident ? (opts.age ?? "lt60") : "lt60");
  if (!rules) return null;

  const ti = opts.totalIncome;
  const tiForRebate = ti + (opts.specialRateIncome ?? 0);
  const gross = slabTax(rules.slabs, ti);
  let rebate = 0;
  let marginal = false;
  if (!resident) {
    // no 87A for non-residents
  } else if (tiForRebate <= rules.rebate.threshold) {
    rebate = Math.min(gross, rules.rebate.cap);
  } else if (rules.rebate.marginalRelief) {
    // 87A marginal relief: tax capped at the amount by which income exceeds the threshold
    const excess = tiForRebate - rules.rebate.threshold;
    if (gross > excess) {
      rebate = gross - excess;
      marginal = true;
    }
  }
  const afterRebate = gross - rebate;

  let surcharge = 0;
  const brackets = [...rules.surcharge].sort((a, b) => b.threshold - a.threshold);
  const bracket = brackets.find((b) => ti > b.threshold);
  if (bracket) {
    surcharge = afterRebate * bracket.rate;
    // Marginal relief: tax + surcharge cannot exceed what is payable at the
    // threshold plus the income above it.
    const taxAtThreshold = slabTax(rules.slabs, bracket.threshold);
    const bracketBelow = brackets.find((b) => bracket.threshold > b.threshold);
    const surchargeAtThreshold = bracketBelow ? taxAtThreshold * bracketBelow.rate : 0;
    const cap = taxAtThreshold + surchargeAtThreshold + (ti - bracket.threshold);
    if (afterRebate + surcharge > cap) {
      surcharge = Math.max(0, cap - afterRebate);
      marginal = true;
    }
  }

  const cess = (afterRebate + surcharge) * CESS_RATE;
  return {
    regime: opts.regime,
    ay: opts.ay,
    totalIncome: ti,
    slabTax: gross,
    rebate87A: rebate,
    afterRebate,
    surcharge,
    cess,
    total: round10(afterRebate + surcharge + cess),
    marginalReliefApplied: marginal,
  };
}

// ---- Special-rate capital gains: s.111A STCG and s.112A LTCG ----
// 111A: STCG on listed equity shares / equity-oriented MF units / units of a business
// trust, sold on a recognised stock exchange with STT paid. Flat rate, independent of
// slab/regime, no Chapter VI-A set-off. FA (No. 2) 2024 raised the rate from 15% to 20%
// for transfers on/after 23-07-2024.
// 112A: LTCG on the same asset classes, above an annual exemption of ₹1,25,000
// (raised from ₹1,00,000 by FA (No. 2) 2024, effective AY 2025-26 for the whole year).
// Rate raised from 10% to 12.5% for transfers on/after 23-07-2024. Validated against a
// real filed AY 2025-26 ITR-2 (docs/missing-functionality.md figures).
// NOT covered: s.112 non-equity LTCG (property, debt, gold) - flag those for manual work.
const RATE_CHANGE_DATE = "2024-07-23";
const STCG_111A_RATE_ON_OR_AFTER = 0.2;
const STCG_111A_RATE_BEFORE = 0.15;
const LTCG_112A_RATE_ON_OR_AFTER = 0.125;
const LTCG_112A_RATE_BEFORE = 0.1;
const LTCG_112A_EXEMPTION = 125_000; // per AY (both supported AYs)

export interface Stcg111ABreakdown {
  stcgAmount: number;
  rate: number;
  tax: number; // before cess
  cess: number;
  total: number;
}

// Single-leg convenience for quick lookups (tax-cli stcg111a). computeTotalTax() below is
// the full-picture API. `saleDate` (YYYY-MM-DD) picks the rate; omit for on/after-change.
export function stcg111ATax(opts: {
  stcgAmount: number;
  saleDate?: string;
}): Stcg111ABreakdown {
  const rate =
    !opts.saleDate || opts.saleDate >= RATE_CHANGE_DATE
      ? STCG_111A_RATE_ON_OR_AFTER
      : STCG_111A_RATE_BEFORE;
  const tax = opts.stcgAmount * rate;
  const cess = tax * CESS_RATE;
  return { stcgAmount: opts.stcgAmount, rate, tax, cess, total: tax + cess };
}

// ---- computeTotalTax: slab income + 111A/112A gains, the full liability picture ----
// Gains arrive pre-split into before/on-after 23-07-2024 legs (post loss-set-off; the
// "before" legs can only be non-zero for AY 2025-26 - every FY 2025-26 transfer is
// post-change).
export interface SpecialRateGains {
  stcg111ABefore?: number;
  stcg111AOnAfter?: number;
  ltcg112ABefore?: number;
  ltcg112AOnAfter?: number;
}

interface SpecialLeg {
  gross: number;
  taxable: number; // after 112A exemption and basic-exemption adjustment
  rate: number;
  tax: number;
}

export interface TotalTaxBreakdown {
  regime: Regime;
  ay: string;
  residentialStatus: ResidentialStatus;
  slabIncome: number;
  totalIncome: number; // slab income + gross special-rate gains (the return's "total income")
  slab: TaxBreakdown; // rebate already residency- and threshold-gated
  // Resident-only (s.111A(2)/112A(2) provisos): unexhausted basic exemption absorbs
  // special-rate gains, highest-rate leg first (taxpayer-favourable order; the portal is
  // authoritative if it chooses differently - reconcile at filing).
  basicExemptionAdjustment: number;
  stcg111A: { before: SpecialLeg; onAfter: SpecialLeg; tax: number };
  ltcg112A: { before: SpecialLeg; onAfter: SpecialLeg; exemption: number; tax: number };
  specialRateTax: number;
  // Old regime only: 87A's cap can also absorb 111A tax (never 112A tax, s.112A(6)).
  rebate87AOnSpecial: number;
  taxPayable: number; // slab after-rebate + special-rate tax - rebate87AOnSpecial
  surcharge: number;
  surchargeNote: string | null;
  cess: number;
  grossTaxLiability: number; // taxPayable + surcharge + cess, unrounded
  total: number; // rounded to nearest ₹10 (s.288B)
}

export function computeTotalTax(opts: {
  slabIncome: number; // normal-rate taxable income after deductions (288A-rounded by caller)
  gains?: SpecialRateGains;
  regime: Regime;
  ay: string;
  age?: AgeBand;
  residentialStatus?: ResidentialStatus;
}): TotalTaxBreakdown | null {
  const residentialStatus = opts.residentialStatus ?? "resident";
  const resident = residentialStatus === "resident";
  const g = opts.gains ?? {};
  const stBefore = Math.max(0, g.stcg111ABefore ?? 0);
  const stOnAfter = Math.max(0, g.stcg111AOnAfter ?? 0);
  const ltBefore = Math.max(0, g.ltcg112ABefore ?? 0);
  const ltOnAfter = Math.max(0, g.ltcg112AOnAfter ?? 0);
  const grossSpecial = stBefore + stOnAfter + ltBefore + ltOnAfter;

  const rules =
    opts.regime === "new"
      ? newRegimeRules(opts.ay)
      : oldRegimeRules(opts.ay, resident ? (opts.age ?? "lt60") : "lt60");
  if (!rules) return null;

  // 112A exemption on the combined LTCG, chronological (before-)leg first.
  let exemptionLeft = Math.min(LTCG_112A_EXEMPTION, ltBefore + ltOnAfter);
  const exemption = exemptionLeft;
  const ltBeforeExempted = Math.min(ltBefore, exemptionLeft);
  exemptionLeft -= ltBeforeExempted;
  const ltOnAfterExempted = Math.min(ltOnAfter, exemptionLeft);

  // Basic-exemption adjustment (residents only): shortfall of slab income below the
  // zero-rate band absorbs special-rate gains, highest rate first.
  const zeroBand = rules.slabs[0].rate === 0 ? (rules.slabs[0].upTo ?? 0) : 0;
  let shortfall = resident ? Math.max(0, zeroBand - Math.max(0, opts.slabIncome)) : 0;
  const basicExemptionAdjustment = Math.min(
    shortfall,
    stBefore + stOnAfter + (ltBefore - ltBeforeExempted) + (ltOnAfter - ltOnAfterExempted),
  );
  const absorb = (amount: number) => {
    const used = Math.min(shortfall, amount);
    shortfall -= used;
    return amount - used;
  };
  const leg = (gross: number, alreadyExempt: number, rate: number): SpecialLeg => {
    const taxable = absorb(gross - alreadyExempt);
    return { gross, taxable, rate, tax: Math.round(taxable * rate) };
  };
  const stOnAfterLeg = leg(stOnAfter, 0, STCG_111A_RATE_ON_OR_AFTER);
  const stBeforeLeg = leg(stBefore, 0, STCG_111A_RATE_BEFORE);
  const ltOnAfterLeg = leg(ltOnAfter, ltOnAfterExempted, LTCG_112A_RATE_ON_OR_AFTER);
  const ltBeforeLeg = leg(ltBefore, ltBeforeExempted, LTCG_112A_RATE_BEFORE);
  const stcgTax = stBeforeLeg.tax + stOnAfterLeg.tax;
  const ltcgTax = ltBeforeLeg.tax + ltOnAfterLeg.tax;
  const specialRateTax = stcgTax + ltcgTax;

  const slab = computeTax({
    totalIncome: opts.slabIncome,
    regime: opts.regime,
    ay: opts.ay,
    age: opts.age,
    residentialStatus,
    specialRateIncome: grossSpecial,
  });
  if (!slab) return null;

  const totalIncome = opts.slabIncome + grossSpecial;

  // Old regime: leftover 87A cap offsets 111A tax (112A tax stays out per s.112A(6)).
  let rebate87AOnSpecial = 0;
  if (
    opts.regime === "old" &&
    resident &&
    totalIncome <= rules.rebate.threshold
  ) {
    rebate87AOnSpecial = Math.min(rules.rebate.cap - slab.rebate87A, stcgTax);
  }

  // Rupee-round the slab component the way the utility rounds each Part B-TTI line
  // (TaxAtNormalRatesOnAggrInc is a whole-rupee field).
  const taxPayable = Math.round(slab.afterRebate) + specialRateTax - rebate87AOnSpecial;

  // Surcharge on the combined picture. The rate bracket comes from total income; the
  // part on 111A/112A tax is capped at 15%. Surcharge marginal relief for mixed
  // special-rate income is NOT modelled - the statement builder guards at ₹50L, so this
  // only fires on direct engine use.
  let surcharge = 0;
  let surchargeNote: string | null = null;
  const brackets = [...rules.surcharge].sort((a, b) => b.threshold - a.threshold);
  const bracket = brackets.find((b) => totalIncome > b.threshold);
  if (bracket) {
    surcharge =
      slab.afterRebate * bracket.rate +
      specialRateTax * Math.min(bracket.rate, 0.15);
    surchargeNote =
      "surcharge without marginal relief (not modelled for mixed special-rate income) - portal authoritative";
  }

  const cess = Math.round((taxPayable + surcharge) * CESS_RATE);
  const grossTaxLiability = taxPayable + surcharge + cess;
  return {
    regime: opts.regime,
    ay: opts.ay,
    residentialStatus,
    slabIncome: opts.slabIncome,
    totalIncome,
    slab,
    basicExemptionAdjustment,
    stcg111A: { before: stBeforeLeg, onAfter: stOnAfterLeg, tax: stcgTax },
    ltcg112A: {
      before: ltBeforeLeg,
      onAfter: ltOnAfterLeg,
      exemption,
      tax: ltcgTax,
    },
    specialRateTax,
    rebate87AOnSpecial,
    taxPayable,
    surcharge,
    surchargeNote,
    cess,
    grossTaxLiability,
    total: round10(grossTaxLiability),
  };
}

// ---- Interest u/s 244A on refunds of TDS/TCS/advance tax (clause (1)(a)) ----
// Verified against a real CPC 143(1) intimation for AY 2025-26:
// refund 1,00,273 -> principal 1,00,200 (rule 119A: round DOWN to nearest 100),
// 0.5% per month, April of the AY through the refund month inclusive (7 months),
// part of a month counts as a full month -> 3,507. If the return was filed after
// the due date, interest runs from the filing month instead. Proviso: no interest
// when the refund is under 10% of the tax determined u/s 143(1).
// Not modelled: 244A(1)(b) self-assessment-tax refunds, 244A(1A) appeal-effect extra 3%.

export interface RefundInterest244A {
  principal: number; // rule 119A: refund rounded down to nearest ₹100
  months: number;
  ratePerMonth: number;
  interest: number;
  from: string; // YYYY-MM (first month interest runs for)
  to: string; // YYYY-MM (refund month)
  startedFromFiling: boolean; // true when belated filing shifted the start
}

const RATE_244A = 0.005;

function monthIndex(iso: string): number {
  const [y, m] = iso.split("-").map(Number);
  return y * 12 + (m - 1);
}

export function computeRefundInterest244A(opts: {
  refundAmount: number;
  ay: string; // "2025-26"
  refundDate: string; // YYYY-MM-DD, date of refund grant
  filingDate?: string; // YYYY-MM-DD
  dueDate?: string; // YYYY-MM-DD (statutory or extended); omit if filed on time
  taxDetermined?: number; // for the 10% proviso
}): RefundInterest244A | null {
  if (!/^\d{4}-\d{2}$/.test(opts.ay)) return null;
  const belated = Boolean(
    opts.filingDate && opts.dueDate && opts.filingDate > opts.dueDate,
  );
  const startIso = belated ? opts.filingDate!.slice(0, 7) : `${opts.ay.slice(0, 4)}-04`;
  const endIso = opts.refundDate.slice(0, 7);
  const months = Math.max(0, monthIndex(endIso) - monthIndex(startIso) + 1);
  const principal = Math.floor(opts.refundAmount / 100) * 100;
  const provisoDenied =
    opts.taxDetermined != null && opts.refundAmount < 0.1 * opts.taxDetermined;
  const interest = provisoDenied ? 0 : Math.round(principal * RATE_244A * months);
  return {
    principal,
    months,
    ratePerMonth: RATE_244A,
    interest,
    from: startIso,
    to: endIso,
    startedFromFiling: belated,
  };
}

export function ageAt(dateIso: string, dobIso: string): number {
  const d = new Date(dateIso);
  const b = new Date(dobIso);
  let age = d.getFullYear() - b.getFullYear();
  const m = d.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && d.getDate() < b.getDate())) age--;
  return age;
}

export function ageBandFromDob(dob: string | null, ay: string): AgeBand {
  if (!dob || !/^\d{4}-\d{2}$/.test(ay)) return "lt60";
  const fyEnd = `${ay.slice(0, 4)}-03-31`; // AY 2026-27 covers FY 2025-26, ending 2026-03-31
  const age = ageAt(fyEnd, dob);
  return age >= 80 ? "gte80" : age >= 60 ? "s60to79" : "lt60";
}

export interface RegimeComparisonRow {
  deductions: number;
  taxableIncome: number;
  tax: number;
}

export interface RegimeComparison {
  ay: string;
  age: AgeBand;
  salaried: boolean;
  newRegime: TaxBreakdown;
  oldRegimeRows: RegimeComparisonRow[];
  breakEvenDeductions: number | null; // deductions needed for the old regime to match the new
  notes: string[];
}

// Rebuild a regime-neutral income base from the filed return, then price both regimes on it.
export function compareRegimes(opts: {
  grossTotalIncome: number; // as filed: after standard deduction, before Chapter VI-A
  filedRegime: Regime;
  salaried: boolean;
  ay: string;
  age: AgeBand;
}): RegimeComparison | null {
  const newRules = newRegimeRules(opts.ay);
  const oldRules = oldRegimeRules(opts.ay, opts.age);
  if (!newRules || !oldRules) return null;

  const filedStdDed = opts.salaried
    ? opts.filedRegime === "new"
      ? newRules.standardDeduction
      : oldRules.standardDeduction
    : 0;
  const base = opts.grossTotalIncome + filedStdDed; // before standard deduction, before Chapter VI-A

  const newTaxable = Math.max(0, base - (opts.salaried ? newRules.standardDeduction : 0));
  const oldBase = Math.max(0, base - (opts.salaried ? oldRules.standardDeduction : 0));

  const newBd = computeTax({ totalIncome: newTaxable, regime: "new", ay: opts.ay });
  if (!newBd) return null;

  const oldTaxAt = (deductions: number) =>
    computeTax({
      totalIncome: Math.max(0, oldBase - deductions),
      regime: "old",
      ay: opts.ay,
      age: opts.age,
    })!.total;

  const levels = [0, 150_000, 200_000, 300_000, 450_000, 600_000];
  const oldRegimeRows = levels.map((d) => ({
    deductions: d,
    taxableIncome: Math.max(0, oldBase - d),
    tax: oldTaxAt(d),
  }));

  // Smallest deduction amount (₹1,000 steps) where the old regime matches or beats the new.
  let breakEvenDeductions: number | null = null;
  for (let d = 0; d <= oldBase + 1_000; d += 1_000) {
    if (oldTaxAt(d) <= newBd.total) {
      breakEvenDeductions = d;
      break;
    }
  }

  const notes = [
    "Indicative only: assumes all income is normal slab-rate income and ignores exempt allowances (HRA, LTA) that exist only in the old regime.",
    `Standard deduction assumed: ₹${newRules.standardDeduction.toLocaleString("en-IN")} (new) vs ₹${oldRules.standardDeduction.toLocaleString("en-IN")} (old)${opts.salaried ? "." : " - not applied, since no salary income was found."}`,
    "The old-regime deduction column stands for everything claimable there: Chapter VI-A (80C, 80D, NPS...), home-loan interest u/s 24(b), HRA, and similar.",
  ];

  return {
    ay: opts.ay,
    age: opts.age,
    salaried: opts.salaried,
    newRegime: newBd,
    oldRegimeRows,
    breakEvenDeductions,
    notes,
  };
}
