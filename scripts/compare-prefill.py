#!/usr/bin/env python3
"""Compare the portal's prefill JSON against a generated/filed ITR-3 return.

The prefill is the government's own auto-populated view (built from 26AS/AIS
plus the e-filing profile). Every figure it carries must appear in our return;
anything in our return that the prefill lacks is listed for awareness (the
prefill does NOT carry everything - capital gains from SFT data and interest
on IT refunds are normally absent, and that is not an error).

Format notes (learned from a real prefill, AY 2026-27):
- camelCase keys, unrelated to the return schema
- aadhaarCardNo is base64-encoded
- TDS section codes are compressed ("4JB" for 194J(b), "94A" for 194A);
  compare by normalized suffix, not equality

Usage: python3 scripts/compare-prefill.py <prefill.json> <return.json>
       (or: bun run prefill <prefill.json> <return.json>)
Exit 1 on any hard mismatch. Fix the statement data / regenerate - never
hand-edit the return to match.
"""

import base64
import json
import sys
from pathlib import Path

failures, notes = [], []
passes = 0


def check(label, ok, detail=""):
    global passes
    if ok:
        passes += 1
        print(f"  ok    {label}")
    else:
        failures.append(label)
        print(f"  FAIL  {label}: {detail}")


def note(msg):
    notes.append(msg)


def norm_section(code):
    c = "".join(ch for ch in str(code).upper() if ch.isalnum())
    return c[-3:] if len(c) >= 3 else c


def main():
    if len(sys.argv) != 3:
        print("usage: compare-prefill.py <prefill.json> <return.json>", file=sys.stderr)
        sys.exit(2)
    prefill = json.loads(Path(sys.argv[1]).read_text())
    ret_doc = json.loads(Path(sys.argv[2]).read_text())
    itr = ret_doc.get("ITR", {}).get("ITR3")
    if not itr:
        print("return file is not an ITR-3 JSON", file=sys.stderr)
        sys.exit(2)

    # ---- identity
    p_pi = prefill.get("personalInfo", {})
    r_pi = itr.get("PartA_GEN1", {}).get("PersonalInfo", {})
    check("PAN matches", p_pi.get("pan") == r_pi.get("PAN"),
          f"prefill {p_pi.get('pan')} vs return {r_pi.get('PAN')}")
    check("DOB matches", p_pi.get("dob") == r_pi.get("DOB"),
          f"prefill {p_pi.get('dob')} vs return {r_pi.get('DOB')}")
    p_name = p_pi.get("assesseeName", {})
    r_name = r_pi.get("AssesseeName", {})
    check("name matches",
          (p_name.get("firstName"), p_name.get("surNameOrOrgName"))
          == (r_name.get("FirstName"), r_name.get("SurNameOrOrgName")),
          f"prefill {p_name} vs return {r_name}")
    try:
        p_aadhaar = base64.b64decode(p_pi.get("aadhaarCardNo", "")).decode()
    except Exception:
        p_aadhaar = p_pi.get("aadhaarCardNo", "")
    if p_aadhaar:
        check("Aadhaar matches (prefill is base64)",
              p_aadhaar == str(r_pi.get("AadhaarCardNo", "")),
              f"prefill {p_aadhaar} vs return {r_pi.get('AadhaarCardNo')}")

    # ---- TDS rows, matched by TAN (both directions)
    p_rows = {}
    for r in (prefill.get("form26as", {}).get("tdsOnOthThanSals", {})
              .get("tdSonOthThanSal", [])):
        tan = r.get("employerOrDeductorOrCollectDetl", {}).get("tan")
        p_rows[tan] = {
            "name": r.get("employerOrDeductorOrCollectDetl", {}).get("employerOrDeductorOrCollecterName", ""),
            "gross": r.get("grossAmount", 0),
            "tds": r.get("taxDeductCreditDtls", {}).get("taxDeductedOwnHands", 0),
            "section": r.get("sectionCode", ""),
        }
    r_rows = {}
    for r in itr.get("ScheduleTDS2", {}).get("TDSOthThanSalaryDtls", []):
        r_rows[r.get("TANOfDeductor")] = {
            "gross": r.get("GrossAmount", 0),
            "tds": r.get("TaxDeductCreditDtls", {}).get("TaxClaimedOwnHands", 0),
            "section": r.get("TDSSection", ""),
        }
    for tan, p in p_rows.items():
        if tan not in r_rows:
            check(f"TDS {tan} ({p['name'][:28]}) present in return", False,
                  f"government shows TDS {p['tds']:,} on {p['gross']:,} - missing from the return")
            continue
        r = r_rows[tan]
        check(f"TDS {tan} ({p['name'][:28]}): gross and TDS match",
              p["gross"] == r["gross"] and p["tds"] == r["tds"],
              f"prefill {p['gross']:,}/{p['tds']:,} vs return {r['gross']:,}/{r['tds']:,}")
        if norm_section(p["section"]) != norm_section(r["section"]):
            note(f"TDS {tan}: section code differs cosmetically "
                 f"(prefill {p['section']} vs return {r['section']})")
    for tan, r in r_rows.items():
        if tan not in p_rows:
            check(f"TDS {tan} claimed in return exists in government prefill", False,
                  f"return claims {r['tds']:,} the prefill does not show - will fail CPC matching")
    p_tds_total = sum(p["tds"] for p in p_rows.values())
    r_tds_total = itr.get("ScheduleTDS2", {}).get("TotalTDSonOthThanSals", 0)
    check("total TDS matches", p_tds_total == r_tds_total,
          f"prefill {p_tds_total:,} vs return {r_tds_total:,}")

    # ---- income figures the prefill carries
    p_os = prefill.get("form26as", {}).get("scheduleOS", {}).get("incOthThanOwnRaceHorse", {})
    r_os = itr.get("ScheduleOS", {}).get("IncOthThanOwnRaceHorse", {})
    if p_os.get("dividendGross") is not None:
        check("dividend income matches government view",
              p_os.get("dividendGross") == r_os.get("DividendGross"),
              f"prefill {p_os.get('dividendGross'):,} vs return {r_os.get('DividendGross'):,}")
    others = {i.get("othSrcNatureDesc"): i.get("othSrcOthAmount", 0)
              for i in prefill.get("form26as", {}).get("incomeDeductionsOthersInc", [])}
    for code, label, r_val in [
        ("IFD", "term/fixed deposit interest", r_os.get("IntrstFrmTermDeposit", 0)),
        ("SAV", "savings interest", r_os.get("IntrstFrmSavingBank", 0)),
        ("DIV", "dividends", r_os.get("DividendOthThan22e", 0)),
    ]:
        if code in others:
            check(f"{label} matches government view", others[code] == r_val,
                  f"prefill {others[code]:,} vs return {r_val:,}")

    # ---- bank accounts
    p_banks = {}
    for blk in prefill.get("bankAccountDtls", []):
        for b in blk.get("addtnlBankDetails", []):
            p_banks[b.get("bankAccountNo")] = str(b.get("useForRefund")).lower()
    r_banks = {}
    for b in (itr.get("PartB_TTI", {}).get("Refund", {})
              .get("BankAccountDtls", {}).get("AddtnlBankDetails", [])):
        r_banks[b.get("BankAccountNo")] = str(b.get("UseForRefund")).lower()
    check("bank accounts match the portal profile", set(p_banks) == set(r_banks),
          f"prefill {sorted(p_banks)} vs return {sorted(r_banks)}")
    p_refund = {a for a, u in p_banks.items() if u == "true"}
    r_refund = {a for a, u in r_banks.items() if u == "true"}
    check("refund-nominated account matches", p_refund == r_refund,
          f"prefill {p_refund} vs return {r_refund}")

    # ---- things our return has that the prefill does not carry (awareness, not errors)
    cg = itr.get("Schedule112A", {}).get("Balance112A", 0)
    if cg:
        note(f"return includes LTCG of {cg:,} (from AIS SFT data) - prefill does not carry capital gains")
    ri = r_os.get("IntrstFrmIncmTaxRefund", 0)
    if ri:
        note(f"return includes interest on IT refund of {ri:,} - prefill never carries this")

    print()
    if notes:
        print("notes:")
        for n in notes:
            print(f"  - {n}")
        print()
    if failures:
        print(f"{passes} matched, {len(failures)} MISMATCHED - do not upload; "
              "fix the statement data and regenerate")
        sys.exit(1)
    print(f"all {passes} comparisons match the government's prefill - clear to upload")


if __name__ == "__main__":
    main()
