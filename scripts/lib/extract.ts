import type { NormalizedReturn, Regime } from "./types";

export function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// Try each dot-path in order; return the first defined value. The ITD schema
// renames fields between years, so extractors pass candidate paths.
export function get(obj: unknown, ...paths: string[]): any {
  for (const path of paths) {
    const v = path
      .split(".")
      .reduce<any>((o, k) => (o == null ? undefined : o[k]), obj as any);
    if (v !== undefined) return v;
  }
  return undefined;
}

const getNum = (obj: unknown, ...paths: string[]): number | null =>
  num(get(obj, ...paths));

const FORM_NAMES: Record<string, string> = {
  ITR1: "ITR-1",
  ITR2: "ITR-2",
  ITR3: "ITR-3",
  ITR4: "ITR-4",
  ITR5: "ITR-5",
  ITR6: "ITR-6",
  ITR7: "ITR-7",
};

const FILING_SECTIONS: Record<string, string> = {
  "11": "139(1) - on or before the due date",
  "12": "139(4) - belated",
  "13": "142(1) - in response to notice",
  "14": "148 - income escaping assessment",
  "17": "139(5) - revised",
  "18": "139(9) - defective return response",
  "20": "119(2)(b) - condonation of delay",
  "21": "139(8A) - updated return (ITR-U)",
};

export function detectFormKey(json: any): string | null {
  const itr = json?.ITR;
  if (!itr || typeof itr !== "object") return null;
  return Object.keys(itr).find((k) => /^ITR\d/.test(k)) ?? null;
}

function ayLabel(raw: unknown): string {
  const start = num(raw);
  if (start == null) return raw ? String(raw) : "unknown";
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

function detectRegime(filingStatus: unknown): Regime {
  // AY 2024-25 onwards the new regime is the default and the flag asks about opting out.
  const optOut = get(filingStatus, "OptOutNewTaxRegime");
  if (optOut === "Y") return "old";
  if (optOut === "N") return "new";
  const optIn = get(filingStatus, "NewTaxRegime", "OptingNewTaxRegime");
  if (optIn === "Y") return "new";
  if (optIn === "N") return "old";
  return "unknown";
}

function filingSection(raw: unknown): string | null {
  if (raw == null) return null;
  return FILING_SECTIONS[String(raw)] ?? `section code ${raw}`;
}

function joinName(assesseeName: unknown): string | null {
  if (!assesseeName || typeof assesseeName !== "object") return null;
  const n = assesseeName as Record<string, unknown>;
  const parts = [n.FirstName, n.MiddleName, n.SurNameOrOrgName].filter(
    (p): p is string => typeof p === "string" && p.trim() !== "",
  );
  return parts.length > 0 ? parts.join(" ") : null;
}

function hasBank(bankDtls: unknown): boolean {
  const accounts = get(bankDtls, "AddtnlBankDetails");
  return Array.isArray(accounts) && accounts.some((a) => get(a, "BankAccountNo"));
}

function viaItems(via: unknown): Record<string, number> {
  const items: Record<string, number> = {};
  if (via && typeof via === "object") {
    for (const [k, v] of Object.entries(via)) {
      if (k === "TotalChapVIADeductions") continue;
      const n = num(v);
      if (n != null && n > 0) items[k] = n;
    }
  }
  return items;
}

function emptyReturn(formKey: string, body: any): NormalizedReturn {
  return {
    form: FORM_NAMES[formKey] ?? formKey,
    formKey,
    assessmentYear: ayLabel(get(body, `Form_${formKey}.AssessmentYear`)),
    regime: "unknown",
    filingSection: null,
    assessee: { name: null, pan: null, dob: null },
    income: {
      salaryGross: null,
      salaryNet: null,
      houseProperty: null,
      business: null,
      capitalGains: null,
      otherSources: null,
      grossTotal: null,
    },
    deductions: { total: null, items: {} },
    totalIncome: null,
    tax: {
      slabTax: null,
      rebate87A: null,
      afterRebate: null,
      surcharge: null,
      cess: null,
      grossLiability: null,
      relief: null,
      netLiability: null,
      interest: null,
      fee234F: null,
      totalPayable: null,
    },
    paid: { tds: null, tcs: null, advance: null, selfAssessment: null, total: null },
    settlement: { balancePayable: null, refundDue: null, bankPresent: false },
    sections: body && typeof body === "object" ? Object.keys(body) : [],
    raw: body,
  };
}

export function extractReturn(json: any): NormalizedReturn {
  const formKey = detectFormKey(json);
  if (!formKey) {
    throw new Error(
      'Not an ITR JSON: expected a top-level "ITR" object containing an ITR<N> key.',
    );
  }
  const body = json.ITR[formKey];
  const r = emptyReturn(formKey, body);
  if (formKey === "ITR1") return extractItr1(body, r);
  if (formKey === "ITR2") return extractItr2(body, r);
  if (formKey === "ITR3") return extractItr3(body, r);
  return r; // other forms: header + section list only; extend when a real file shows up
}

// ITR-3 shares PartB-TI / PartB_TTI shapes with ITR-2; adds business income and
// its own regime flags. Field names verified against a real filed AY 2025-26 ITR-3.
function extractItr3(b: any, r: NormalizedReturn): NormalizedReturn {
  r = extractItr2(b, r);
  r.form = "ITR-3";
  const ti = b?.["PartB-TI"] ?? {};
  r.income.business = num(get(ti, "ProfBusGain.TotProfBusGain"));
  // Regime: ITR-3 (AY 2025-26 schema) tracks 10-IEA opt-out history. "Y" on the
  // continue-opt-out flag means old regime; otherwise the new regime applies.
  const fs = get(b, "PartA_GEN1.FilingStatus");
  if (r.regime === "unknown" && fs) {
    const contOptOut = get(fs, "Yes_ContOptOutNewTaxReg", "F10IEACurrAYOldRegime");
    const optOutMethod = get(fs, "OptOutNewTaxRegime_Method");
    if (contOptOut === "Y") r.regime = "old";
    else if (contOptOut === "N" || optOutMethod !== undefined) r.regime = "new";
  }
  return r;
}

function extractItr1(b: any, r: NormalizedReturn): NormalizedReturn {
  const inc = b?.ITR1_IncomeDeductions ?? {};
  const tax = b?.ITR1_TaxComputation ?? {};
  const paid = get(b, "TaxPaid.TaxesPaid") ?? {};

  r.regime = detectRegime(b?.FilingStatus);
  r.filingSection = filingSection(get(b, "FilingStatus.ReturnFileSec"));
  r.assessee = {
    name: joinName(get(b, "PersonalInfo.AssesseeName")),
    pan: get(b, "PersonalInfo.PAN") ?? null,
    dob: get(b, "PersonalInfo.DOB") ?? null,
  };
  r.income = {
    salaryGross: getNum(inc, "GrossSalary"),
    salaryNet: getNum(inc, "IncomeFromSal"),
    houseProperty: getNum(inc, "TotalIncomeOfHP"),
    capitalGains: getNum(inc, "LongTermCapGain112A", "TotalCapitalGains"),
    otherSources: getNum(inc, "IncomeOthSrc"),
    grossTotal: getNum(inc, "GrossTotIncome"),
  };
  const via = get(inc, "DeductUndChapVIA") ?? get(inc, "UsrDeductUndChapVIA");
  r.deductions = { total: getNum(via, "TotalChapVIADeductions"), items: viaItems(via) };
  r.totalIncome = getNum(inc, "TotalIncome");
  r.tax = {
    slabTax: getNum(tax, "TotalTaxPayable"),
    rebate87A: getNum(tax, "Rebate87A"),
    afterRebate: getNum(tax, "TaxPayableOnRebate"),
    surcharge: null, // ITR-1 is capped at ₹50L total income; no surcharge field
    cess: getNum(tax, "EducationCess", "HealthEduCess"),
    grossLiability: getNum(tax, "GrossTaxLiability"),
    relief: getNum(tax, "Section89"),
    netLiability: getNum(tax, "NetTaxLiability"),
    interest: getNum(tax, "TotalIntrstPay"),
    fee234F: getNum(tax, "LateFilingFee234F", "FeePayable"),
    totalPayable: getNum(tax, "TotTaxPlusIntrstPay"),
  };
  r.paid = {
    tds: getNum(paid, "TDS"),
    tcs: getNum(paid, "TCS"),
    advance: getNum(paid, "AdvanceTax"),
    selfAssessment: getNum(paid, "SelfAssessmentTax"),
    total: getNum(paid, "TotalTaxesPaid"),
  };
  r.settlement = {
    balancePayable: getNum(b, "TaxPaid.BalTaxPayable"),
    refundDue: getNum(b, "Refund.RefundDue"),
    bankPresent: hasBank(get(b, "Refund.BankAccountDtls")),
  };
  return r;
}

// Best-effort paths from schema knowledge; tune against the first real ITR-2 file.
function extractItr2(b: any, r: NormalizedReturn): NormalizedReturn {
  const gen = b?.PartA_GEN1 ?? {};
  const ti = b?.["PartB-TI"] ?? b?.PartB_TI ?? {};
  const tti = b?.PartB_TTI ?? {};
  const comp = tti?.ComputationOfTaxLiability ?? {};
  const paid = get(tti, "TaxPaid.TaxesPaid") ?? {};

  r.regime = detectRegime(gen?.FilingStatus);
  r.filingSection = filingSection(get(gen, "FilingStatus.ReturnFileSec"));
  r.assessee = {
    name: joinName(get(gen, "PersonalInfo.AssesseeName")),
    pan: get(gen, "PersonalInfo.PAN") ?? null,
    dob: get(gen, "PersonalInfo.DOB") ?? null,
  };
  r.income = {
    salaryGross: getNum(b, "ScheduleS.TotalGrossSalary"),
    salaryNet: getNum(ti, "Salaries"),
    houseProperty: getNum(ti, "IncomeFromHP"),
    business: null,
    capitalGains: getNum(ti, "CapGain.TotalCapGains"),
    otherSources: getNum(ti, "IncFromOS.TotIncFromOS", "IncFromOS"),
    grossTotal: getNum(ti, "GrossTotalIncome"),
  };
  const via = get(b, "ScheduleVIA.DeductUndChapVIA") ?? get(b, "ScheduleVIA.UsrDeductUndChapVIA");
  r.deductions = {
    total: getNum(ti, "DeductionsUnderScheduleVIA") ?? getNum(via, "TotalChapVIADeductions"),
    items: viaItems(via),
  };
  r.totalIncome = getNum(ti, "TotalIncome");
  r.tax = {
    slabTax: getNum(comp, "TaxPayableOnTI.TaxPayableOnTotInc"),
    rebate87A: getNum(comp, "Rebate87A"),
    afterRebate: getNum(comp, "TaxPayableOnRebate.TotTaxPayableOnRebate"),
    surcharge: getNum(comp, "TaxPayableOnRebate.SurchargeOnTaxPayable", "Surcharge"),
    cess: getNum(comp, "TaxPayableOnRebate.EducationCess", "EducationCess"),
    grossLiability: getNum(comp, "GrossTaxLiability"),
    relief: getNum(comp, "TaxRelief.TotTaxRelief"),
    netLiability: getNum(comp, "NetTaxLiability"),
    interest: getNum(comp, "IntrstPay.TotalIntrstPay", "TotalIntrstPay"),
    fee234F: getNum(comp, "IntrstPay.LateFilingFee234F", "LateFilingFee234F"),
    totalPayable: getNum(comp, "AggregateTaxInterestLiability"),
  };
  r.paid = {
    tds: getNum(paid, "TDS"),
    tcs: getNum(paid, "TCS"),
    advance: getNum(paid, "AdvanceTax"),
    selfAssessment: getNum(paid, "SelfAssessmentTax"),
    total: getNum(paid, "TotalTaxesPaid"),
  };
  r.settlement = {
    balancePayable: getNum(tti, "TaxPaid.BalTaxPayable"),
    refundDue: getNum(tti, "Refund.RefundDue"),
    bankPresent: hasBank(get(tti, "Refund.BankAccountDtls")),
  };
  return r;
}
