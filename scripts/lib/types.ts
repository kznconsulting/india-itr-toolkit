export type Regime = "new" | "old" | "unknown";

// Form-agnostic view of a return. Fields the extractor couldn't find stay null;
// the validator and report tolerate nulls everywhere.
export interface NormalizedReturn {
  form: string; // "ITR-1"
  formKey: string; // "ITR1"
  assessmentYear: string; // "2026-27"
  regime: Regime;
  filingSection: string | null;
  assessee: { name: string | null; pan: string | null; dob: string | null };
  income: {
    salaryGross: number | null;
    salaryNet: number | null; // after s.16 deductions (standard deduction etc.)
    houseProperty: number | null;
    business: number | null; // profits and gains of business/profession (ITR-3/4)
    capitalGains: number | null;
    otherSources: number | null;
    grossTotal: number | null;
  };
  deductions: { total: number | null; items: Record<string, number> };
  totalIncome: number | null;
  tax: {
    slabTax: number | null; // tax on total income, before rebate
    rebate87A: number | null;
    afterRebate: number | null;
    surcharge: number | null;
    cess: number | null;
    grossLiability: number | null;
    relief: number | null; // s.89 etc.
    netLiability: number | null;
    interest: number | null; // 234A/B/C total
    fee234F: number | null;
    totalPayable: number | null; // tax + interest + fee
  };
  paid: {
    tds: number | null;
    tcs: number | null;
    advance: number | null;
    selfAssessment: number | null;
    total: number | null;
  };
  settlement: {
    balancePayable: number | null;
    refundDue: number | null;
    bankPresent: boolean;
  };
  sections: string[]; // top-level schedule keys present in the form body
  raw: unknown;
}

export interface Check {
  id: string;
  level: "pass" | "warn" | "fail" | "info";
  message: string;
}
