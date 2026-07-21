#!/usr/bin/env python3
"""Pre-upload checker: the ITD's own published validation rules, encoded.

The CBDT publishes the exact validation rules the e-filing portal enforces at
upload, per form per AY (schemas/AY<yy>/ITR-3_Validation_Rules_*.pdf). Category
A rules block the upload outright. This script encodes the subset applicable to
this practice's return shape (44ADA presumptive + capital gains + other
sources + TDS refunds) so uploads cannot bounce on known rules.

Rule references (VR-n) follow the AY 2026-27 ITR-3 rules PDF numbering.
Add rules here as new return shapes appear; never weaken one to make a
return pass - fix the return.

Coverage policy (AY 2026-27 rulebook: 1,029 Category A rules):
- ~52 are portal-side only (PAN database, filing history, system checks) -
  not encodable offline; the portal enforces them at upload.
- ~457 govern schedules this practice does not file (audit, depreciation,
  firms, foreign assets, VDA, salary, let-out property...). These are
  discharged by the SHAPE GUARDS below: one assertion per family proving
  the governing fields are absent/zero, failing loudly when a new client
  shape appears - extend the toolkit consciously at that point.
- The rest are cross-schedule identities; the ones that can fire on
  populated fields are encoded individually. The prior-year FILED return
  is the control: CPC accepted it, so every encoded check must pass on it.

Usage: python3 scripts/check-rules.py <itr3-return.json>
       (or: bun run check <itr3-return.json>)
"""

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
failures = []
passes = 0


def check(rule, label, ok, detail=""):
    global passes
    if ok:
        passes += 1
    else:
        failures.append(f"{rule} {label}: {detail}")


def close(a, b, tol=1):
    return abs((a or 0) - (b or 0)) <= tol


def main():
    if len(sys.argv) != 2:
        print("usage: check-rules.py <itr3-return.json>", file=sys.stderr)
        sys.exit(2)
    doc = json.loads(Path(sys.argv[1]).read_text())
    itr = doc.get("ITR", {}).get("ITR3")
    if not itr:
        print("not an ITR-3 JSON", file=sys.stderr)
        sys.exit(2)

    ay_start = itr.get("Form_ITR3", {}).get("AssessmentYear", "")
    ay = f"{ay_start}-{str((int(ay_start) + 1) % 100).zfill(2)}" if ay_start else ""
    fs = itr.get("PartA_GEN1", {}).get("FilingStatus", {})
    old_regime = fs.get("Yes_ContOptOutNewTaxReg") == "Y" or fs.get("F10IEACurrAYOldRegime") == "Y"
    regime = "old" if old_regime else "new"

    # ---- P&L / Schedule BP: presumptive 44ADA
    pl = itr.get("PARTA_PL", {}).get("PersumptiveInc44ADA", {})
    gross, presum = pl.get("GrsReceipt", 0), pl.get("TotPersumptiveInc44ADA", 0)
    if gross:
        check("VR-111", "44ADA income cannot exceed gross receipts", presum <= gross,
              f"presumptive {presum} > gross {gross}")
        check("VR-107", "44ADA income must be at least 50% of gross receipts",
              presum >= round(gross * 0.5), f"presumptive {presum} < 50% of {gross}")
        modes = pl.get("GrsTrnOverBank44ADA", 0) + pl.get("GrsTotalTrnOverInCash44ADA", 0) \
            + pl.get("GrsTrnOverAnyOthMode44ADA", 0)
        check("VR-*", "44ADA receipt modes sum to gross receipts", close(modes, gross),
              f"modes {modes} vs gross {gross}")
    bp = itr.get("ITR3ScheduleBP", {}).get("BusinessIncOthThanSpec", {})
    check("VR-113", "Schedule BP 44ADA equals P&L 62(ii)",
          close(bp.get("DeemedProfitBusUs", {}).get("Section44ADA", 0), presum),
          f"BP {bp.get('DeemedProfitBusUs', {}).get('Section44ADA')} vs P&L {presum}")

    # ---- Schedule OS internal totals
    os_ = itr.get("ScheduleOS", {})
    inc = os_.get("IncOthThanOwnRaceHorse", {})
    interest_parts = (inc.get("IntrstFrmSavingBank", 0) + inc.get("IntrstFrmTermDeposit", 0)
                      + inc.get("IntrstFrmIncmTaxRefund", 0) + inc.get("IntrstFrmOthers", 0))
    check("VR-505*", "Schedule OS interest components sum to InterestGross",
          close(inc.get("InterestGross", 0), interest_parts),
          f"parts {interest_parts} vs InterestGross {inc.get('InterestGross')}")
    check("VR-510", "Schedule OS gross at applicable rate = dividend + interest + others",
          close(inc.get("GrossIncChrgblTaxAtAppRate", 0),
                inc.get("DividendGross", 0) + inc.get("InterestGross", 0)
                + inc.get("OthersGross", 0) + inc.get("RentFromMachPlantBldgs", 0)),
          f"{inc.get('GrossIncChrgblTaxAtAppRate')} vs components")
    check("VR-511", "Schedule OS income chargeable equals total (no race horse)",
          close(os_.get("IncChargeable", 0), os_.get("TotOthSrcNoRaceHorse", 0)),
          f"{os_.get('IncChargeable')} vs {os_.get('TotOthSrcNoRaceHorse')}")
    dr = os_.get("DividendIncUs115BBDA", {}).get("DateRange", {})
    if inc.get("DividendOthThan22e"):
        check("VR-*", "dividend quarterly breakup sums to dividend income",
              close(sum(dr.values()), inc.get("DividendOthThan22e", 0)),
              f"quarters {sum(dr.values())} vs dividend {inc.get('DividendOthThan22e')}")

    # ---- Schedule 112A vs Schedule CG
    s112 = itr.get("Schedule112A", {})
    cg = itr.get("ScheduleCGFor23", {})
    if s112:
        check("VR-*", "112A balance = sale value minus deductions",
              close(s112.get("Balance112A", 0),
                    s112.get("SaleValue112A", 0) - s112.get("Deductions112A", 0)),
              f"{s112.get('Balance112A')} vs {s112.get('SaleValue112A')} - {s112.get('Deductions112A')}")
        eq = cg.get("LongTermCapGain23", {}).get("SaleOfEquityShareUs112A", {})
        check("VR-393", "Schedule CG LTCG u/s 112A equals Schedule 112A total",
              close(eq.get("CapgainonAssets", 0), s112.get("Balance112A", 0)),
              f"CG {eq.get('CapgainonAssets')} vs 112A {s112.get('Balance112A')}")

    # ---- CFL / BFLA / Part B-TI loss linkage
    cfl = itr.get("ScheduleCFL", {})
    bfla = itr.get("ScheduleBFLA", {})
    ti = itr.get("PartB-TI", {})
    bf = cfl.get("TotalOfBFLossesEarlierYrs", {}).get("LossSummaryDetail", {}).get("TotalLTCGPTILossCF", 0)
    adj = cfl.get("AdjTotBFLossInBFLA", {}).get("LossSummaryDetail", {}).get("TotalLTCGPTILossCF", 0)
    cf = cfl.get("TotalLossCFSummary", {}).get("LossSummaryDetail", {}).get("TotalLTCGPTILossCF", 0)
    if bf or cf:
        check("VR-*", "CFL: carried-forward = brought-forward minus set-off",
              close(cf, bf - adj), f"c/f {cf} vs b/f {bf} - setoff {adj}")
    tot_setoff = bfla.get("TotalBFLossSetOff", {}).get("TotBFLossSetoff", 0)
    check("VR-584*", "BFLA total set-off equals CFL adjustment",
          close(tot_setoff, adj), f"BFLA {tot_setoff} vs CFL {adj}")
    check("VR-*", "Part B-TI brought-forward losses set off equals BFLA total",
          close(ti.get("BroughtFwdLossesSetoff", 0), tot_setoff),
          f"B-TI {ti.get('BroughtFwdLossesSetoff')} vs BFLA {tot_setoff}")
    check("VR-*", "BFLA income after set-off equals Part B-TI gross total income",
          close(bfla.get("IncomeOfCurrYrAftCYLABFLA", 0), ti.get("GrossTotalIncome", 0)),
          f"BFLA {bfla.get('IncomeOfCurrYrAftCYLABFLA')} vs GTI {ti.get('GrossTotalIncome')}")

    # ---- Part B-TI head totals
    heads = (ti.get("ProfBusGain", {}).get("TotProfBusGain", 0)
             + ti.get("IncFromOS", {}).get("TotIncFromOS", 0)
             + ti.get("CapGain", {}).get("TotalCapGains", 0)
             + ti.get("Salaries", 0) + ti.get("IncomeFromHP", 0))
    check("VR-*", "Part B-TI total of heads equals TotalTI", close(ti.get("TotalTI", 0), heads),
          f"TotalTI {ti.get('TotalTI')} vs heads {heads}")
    check("VR-*", "Part B-TI GTI = balance after CY losses minus BF set-off",
          close(ti.get("GrossTotalIncome", 0),
                ti.get("BalanceAfterSetoffLosses", 0) - ti.get("BroughtFwdLossesSetoff", 0)),
          f"GTI {ti.get('GrossTotalIncome')}")
    check("VR-*", "Part B-TI total income = GTI minus Chapter VI-A",
          close(ti.get("TotalIncome", 0),
                ti.get("GrossTotalIncome", 0)
                - ti.get("DeductionsUndSchVIADtl", {}).get("TotDeductUndSchVIA", 0)),
          f"TI {ti.get('TotalIncome')}")

    # ---- Part B-TTI tax chain
    tti = itr.get("PartB_TTI", {})
    comp = tti.get("ComputationOfTaxLiability", {})
    tp = comp.get("TaxPayableOnTI", {})
    check("VR-964", "tax after rebate = tax on total income minus 87A rebate",
          close(tp.get("TaxPayableOnRebate", 0),
                tp.get("TaxPayableOnTotInc", 0) - tp.get("Rebate87A", 0)),
          f"{tp.get('TaxPayableOnRebate')} vs {tp.get('TaxPayableOnTotInc')} - {tp.get('Rebate87A')}")
    check("VR-965", "gross tax liability = tax after rebate + surcharge + cess",
          close(tp.get("GrossTaxLiability", 0),
                tp.get("TaxPayableOnRebate", 0) + tp.get("TotalSurcharge", 0)
                + tp.get("EducationCess", 0)),
          f"{tp.get('GrossTaxLiability')}")
    if ay:
        rules = json.loads(subprocess.run(
            ["bun", "scripts/tax-cli.ts", "rules", "--regime", regime, "--ay", ay],
            cwd=REPO_ROOT, capture_output=True, text=True).stdout)
        if "error" not in rules:
            cap = rules["rebate"]["cap"]
            check("VR-957*", f"87A rebate within the {regime}-regime cap for AY {ay}",
                  tp.get("Rebate87A", 0) <= cap, f"rebate {tp.get('Rebate87A')} > cap {cap}")

    # ---- TDS and refund arithmetic
    tds2 = itr.get("ScheduleTDS2", {})
    rows_total = sum(r.get("TaxDeductCreditDtls", {}).get("TaxClaimedOwnHands", 0)
                     for r in tds2.get("TDSOthThanSalaryDtls", []))
    check("VR-*", "Schedule TDS2 total equals sum of rows",
          close(tds2.get("TotalTDSonOthThanSals", 0), rows_total),
          f"total {tds2.get('TotalTDSonOthThanSals')} vs rows {rows_total}")
    paid = tti.get("TaxPaid", {}).get("TaxesPaid", {})
    check("VR-*", "Part B-TTI TDS equals TDS schedules",
          close(paid.get("TDS", 0), rows_total), f"TTI {paid.get('TDS')} vs schedule {rows_total}")
    total_paid = paid.get("TotalTaxesPaid", 0)
    check("VR-*", "total taxes paid = TDS + TCS + advance + self-assessment",
          close(total_paid, paid.get("TDS", 0) + paid.get("TCS", 0)
                + paid.get("AdvanceTax", 0) + paid.get("SelfAssessmentTax", 0)),
          f"{total_paid}")
    liability = comp.get("AggregateTaxInterestLiability", 0)
    refund = tti.get("Refund", {}).get("RefundDue", 0)
    if total_paid > liability:
        check("VR-*", "refund due = taxes paid minus aggregate liability",
              close(refund, total_paid - liability, 10),
              f"refund {refund} vs {total_paid} - {liability}")

    # ---- Schedule SI and special-rate linkage (identities, so STCG years also pass)
    si = itr.get("ScheduleSI", {})
    si_rows = sum(e.get("SplRateInc", 0) for e in si.get("SplCodeRateTax", []))
    si_tax_rows = sum(e.get("SplRateIncTax", 0) for e in si.get("SplCodeRateTax", []))
    check("VR-*", "Schedule SI total equals sum of rows",
          close(si.get("TotSplRateInc", 0), si_rows),
          f"{si.get('TotSplRateInc')} vs {si_rows}")
    check("VR-861", "Schedule SI tax equals sum of row taxes",
          close(si.get("TotSplRateIncTax", 0), si_tax_rows),
          f"{si.get('TotSplRateIncTax')} vs {si_tax_rows}")
    check("VR-*", "Part B-TI special-rate income equals Schedule SI total",
          close(ti.get("IncChargeableTaxSplRates", 0), si.get("TotSplRateInc", 0)),
          f"B-TI {ti.get('IncChargeableTaxSplRates')} vs SI {si.get('TotSplRateInc')}")
    check("VR-*", "Part B-TTI tax at special rates equals Schedule SI tax",
          close(tp.get("TaxAtSpecialRates", 0), si.get("TotSplRateIncTax", 0)),
          f"TTI {tp.get('TaxAtSpecialRates')} vs SI {si.get('TotSplRateIncTax')}")

    # ---- more populated-path identities
    pi = itr.get("PartA_GEN1", {}).get("PersonalInfo", {})
    ver = itr.get("Verification", {})
    if ver.get("Capacity") == "S":
        check("VR-8*", "verification PAN equals assessee PAN (self capacity)",
              ver.get("Declaration", {}).get("AssesseeVerPAN") == pi.get("PAN"),
              f"{ver.get('Declaration', {}).get('AssesseeVerPAN')} vs {pi.get('PAN')}")
    banks = tti.get("Refund", {}).get("BankAccountDtls", {}).get("AddtnlBankDetails", [])
    refund_banks = [x for x in banks if str(x.get("UseForRefund")).lower() == "true"]
    check("VR-*", "exactly one bank account nominated for refund",
          len(refund_banks) == 1, f"{len(refund_banks)} nominated of {len(banks)}")
    cgt = ti.get("CapGain", {})
    check("VR-916*", "Part B-TI capital gains total equals ST + LT totals",
          close(cgt.get("TotalCapGains", 0),
                cgt.get("ShortTerm", {}).get("TotalShortTerm", 0)
                + cgt.get("LongTerm", {}).get("TotalLongTerm", 0)),
          f"{cgt.get('TotalCapGains')}")
    st23 = cg.get("ShortTermCapGainFor23", {})
    check("VR-*", "Part B-TI STCG equals Schedule CG STCG total",
          close(cgt.get("ShortTerm", {}).get("TotalShortTerm", 0), st23.get("TotalSTCG", 0)),
          f"B-TI {cgt.get('ShortTerm', {}).get('TotalShortTerm')} vs CG {st23.get('TotalSTCG')}")
    check("VR-*", "Schedule OS balance = gross at applicable rate minus s.57 deductions",
          close(inc.get("BalanceNoRaceHorse", 0),
                inc.get("GrossIncChrgblTaxAtAppRate", 0)
                - inc.get("Deductions", {}).get("TotDeductions", 0)),
          f"{inc.get('BalanceNoRaceHorse')}")
    cyla = itr.get("ScheduleCYLA", {})
    for head, ti_val in [("BusProfExclSpecProf", ti.get("ProfBusGain", {}).get("TotProfBusGain", 0)),
                         ("OthSrcExclRaceHorse", ti.get("IncFromOS", {}).get("TotIncFromOS", 0))]:
        c_ = cyla.get(head, {}).get("IncCYLA", {})
        b_ = bfla.get(head, {}).get("IncBFLA", {})
        check("VR-556*", f"CYLA {head} head income matches Part B-TI",
              close(c_.get("IncOfCurYrUnderThatHead", 0), ti_val),
              f"CYLA {c_.get('IncOfCurYrUnderThatHead')} vs B-TI {ti_val}")
        check("VR-613*", f"BFLA {head} intake equals CYLA after set-off",
              close(b_.get("IncOfCurYrUndHeadFromCYLA", 0), c_.get("IncOfCurYrAfterSetOff", 0)),
              f"BFLA {b_.get('IncOfCurYrUndHeadFromCYLA')} vs CYLA {c_.get('IncOfCurYrAfterSetOff')}")
    for i, r in enumerate(itr.get("Schedule112A", {}).get("Schedule112ADtls", [])):
        check("VR-*", f"112A row {i + 1}: balance = sale value minus total deductions",
              close(r.get("Balance", 0), r.get("TotSaleValue", 0) - r.get("TotalDeductions", 0)),
              f"{r.get('Balance')}")
    rows112 = sum(r.get("Balance", 0) for r in itr.get("Schedule112A", {}).get("Schedule112ADtls", []))
    if s112:
        # parent-total field renamed between AYs: TotalBalance112A (25-26) -> Balance112A (26-27)
        parent112 = s112.get("TotalBalance112A", s112.get("Balance112A", 0))
        check("VR-*", "112A parent total equals sum of rows",
              close(parent112, rows112), f"{parent112} vs {rows112}")
    for i, r in enumerate(tds2.get("TDSOthThanSalaryDtls", [])):
        d_ = r.get("TaxDeductCreditDtls", {})
        check("VR-*", f"TDS row {i + 1}: claimed cannot exceed deducted",
              d_.get("TaxClaimedOwnHands", 0) <= d_.get("TaxDeductedOwnHands", 0),
              f"claimed {d_.get('TaxClaimedOwnHands')} > deducted {d_.get('TaxDeductedOwnHands')}")
    check("VR-*", "balance payable and refund due cannot both be positive",
          not (tti.get("TaxPaid", {}).get("BalTaxPayable", 0) > 0
               and tti.get("Refund", {}).get("RefundDue", 0) > 0), "both positive")
    amtc = itr.get("ScheduleAMTC", {})
    if amtc:
        check("VR-*", "Schedule AMTC current AY matches the form AY",
              amtc.get("CurrAssYr") == ay, f"{amtc.get('CurrAssYr')} vs {ay}")

    # ---- Category B rules (return uploads FINE, then bites as a 139(9)
    # defective-return notice weeks later - encode so they fire on our desk instead)
    bp_income = itr.get("ITR3ScheduleBP", {}).get("IncChrgUnHdProftGain", 0)
    if bp_income > 250_000:
        nb = itr.get("PARTA_BS", {}).get("NoBooksOfAccBS", {})
        check("VR-B3", "B/P income above 2.5L: balance-sheet particulars must be filled",
              bool(nb) and nb.get("CashBalAmt") is not None,
              "no-books balance sheet block empty - 139(9) defect risk")
    bp_div_reduced = (itr.get("ITR3ScheduleBP", {}).get("BusinessIncOthThanSpec", {})
                      .get("IncRecCredPLOthHeadDtls", {}).get("Dividend", 0))
    check("VR-B21", "dividend reduced from Schedule BP cannot exceed dividend offered in OS",
          bp_div_reduced <= inc.get("DividendGross", 0),
          f"BP reduction {bp_div_reduced} > OS dividend {inc.get('DividendGross')}")
    if gross and presum < round(gross * 0.5):
        check("VR-B8", "profit below 50% of professional receipts without audit info",
              False, "44ADA(4) audit territory - 139(9) defect risk")

    # ---- shape guards: prove entire rule families cannot fire on this return.
    # A failure here means a NEW client shape - extend the toolkit consciously.
    guard = [
        ("no salary income (salary rule family)", close(ti.get("Salaries", 0), 0)),
        ("no house-property income (HP/24(b) rule family)", close(ti.get("IncomeFromHP", 0), 0)),
        ("no TCS claimed (TCS rule family)",
         not itr.get("ScheduleTCS") or close(itr.get("ScheduleTCS", {}).get("TotalSchTCS", 0), 0)),
        ("no Chapter VI-A deductions (new-regime + VIA rule family)",
         close(ti.get("DeductionsUndSchVIADtl", {}).get("TotDeductUndSchVIA", 0), 0)),
        ("not liable to audit (44AB/audit-report rule family)",
         itr.get("PartA_GEN2", {}).get("AuditInfo", {}).get("LiableSec44ABflg", "N") == "N"),
        ("44ADA is the only presumptive section (44AD/44AE/44B* rule families)",
         all(close(v, 0) for k, v in itr.get("ITR3ScheduleBP", {})
             .get("BusinessIncOthThanSpec", {}).get("DeemedProfitBusUs", {}).items()
             if k not in ("Section44ADA", "TotDeemedProfitBusUs"))),
        ("no VDA income (virtual-digital-asset rule family)",
         close(cg.get("IncmFromVDATrnsf", 0), 0)),
        ("no foreign assets (Schedule FA/FSI/TR rule families)",
         tti.get("AssetOutIndiaFlag", "NO") == "NO" and not itr.get("ScheduleFA")),
        ("no AMT liability (115JC/JD rule family)",
         close(itr.get("PartB_TTI", {}).get("ComputationOfTaxLiability", {})
               .get("TaxPayableOnDeemedTI", {}).get("TotalTax", 0), 0)),
        ("resident individual, no Portuguese Civil Code (5A rule family)",
         fs.get("PortugeseCC5A", "N") == "N" and fs.get("ResidentialStatus") == "RES"),
    ]
    for label, ok in guard:
        check("SHAPE", label, ok, "return shape changed - extend generator/checker before filing")

    print(f"{Path(sys.argv[1]).name} · AY {ay} · {regime} regime")
    if failures:
        print(f"\n{passes} passed, {len(failures)} FAILED:")
        for f in failures:
            print(f"  FAIL  {f}")
        sys.exit(1)
    print(f"all {passes} encoded validation rules pass "
          "(subset of the CBDT rules PDF - the portal remains the final authority)")


if __name__ == "__main__":
    main()
