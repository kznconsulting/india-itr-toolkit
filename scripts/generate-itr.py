#!/usr/bin/env python3
"""Generate an ITR-3 return JSON from statement-data.json.

Strategy: clone-and-update. The prior year's FILED JSON (a return CPC actually
accepted for this client) is the structural template; every figure is rewritten
from the statement data; the result is validated against the official ITD JSON
schema for the target AY (schemas/AY<yyyy-yy>/ITR-3_*_Main_*.json).

    python3 scripts/generate-itr.py <statement-data.json> \
        --template <prior-year-filed.json> [--out <file.json>]
    (or: bun run generate <statement-data.json> --template <filed.json>)

The output is a DRAFT for the portal's offline-mode upload. The portal's own
validation and its computed-summary screen remain the final gate: if the
portal's Part B-TTI numbers differ from this script's printed expectations,
STOP and reconcile (see the file-return skill).

Design notes (read before editing):
- Scope guards mirror build-statement.py: aborts if taxable income exceeds
  Rs. 50 lakh (surcharge) or if net taxable capital gains survive set-off
  (special rates). Extend consciously.
- Schema drift is handled in two layers: known renames are mapped explicitly
  (e.g. the AY 2026-27 Form 10-IEA regime-history fields), and a prune pass
  drops any template field the target schema no longer allows, WARNING each,
  before strict draft-04 validation.
- Values this script cannot know are copied from the template and listed as
  warnings (no-books cash balance, software/creation IDs). Resolve each
  warning before filing.
- Tax figures come from scripts/lib/tax.ts via `bun scripts/tax-cli.ts` -
  never duplicate slab numbers here.
"""

import copy
import glob
import json
import subprocess
import sys
from datetime import date
from pathlib import Path

try:
    from jsonschema import Draft4Validator
except ImportError:
    print("ERROR: pip3 install jsonschema (see docs/porting.md)", file=sys.stderr)
    sys.exit(1)

REPO_ROOT = Path(__file__).resolve().parent.parent
SURCHARGE_GUARD = 5_000_000
warnings: list[str] = []


def warn(msg):
    warnings.append(msg)


def die(msg):
    print(f"ERROR: {msg}", file=sys.stderr)
    sys.exit(1)


# Toolkit gaps are not data errors: retrying, tweaking inputs, or working around
# them burns tokens and risks a wrong return. One instruction, then move on.
PARK = (
    "\nThis is a TOOLKIT GAP, not a data error - do NOT retry or work around it. "
    "On an operator machine: git pull, add an OPEN entry to docs/missing-functionality.md, "
    "commit+push, tell the operator this client is PARKED pending a toolkit update, and "
    "move to the next client (AGENTS.md 'Escalate, don't extend')."
)


def die_gap(msg):
    die(msg + PARK)


def rup(x):  # half-up rounding, as the ITD utility computes
    return int(x + 0.5)


def tax_cli(*args):
    out = subprocess.run(["bun", "scripts/tax-cli.ts", *args], cwd=REPO_ROOT,
                         capture_output=True, text=True, check=True)
    result = json.loads(out.stdout)
    if "error" in result:
        die(f"tax-cli: {result['error']}")
    return result


def date_range(quarters, unallocated_to_q1=0):
    """Map statement period columns L..P to the ITR DateRange object."""
    q = dict(quarters or {})
    return {
        "Upto15Of6": q.get("L", 0) + unallocated_to_q1,
        "Up16Of6To15Of9": q.get("M", 0),
        "Up16Of9To15Of12": q.get("N", 0),
        "Up16Of12To15Of3": q.get("O", 0),
        "Up16Of3To31Of3": q.get("P", 0),
    }


# ---------------------------------------------------------------- schema tools
dropped_zero: list[str] = []     # pruned keys with zero/empty values (schema drift noise)
dropped_renamed: list[str] = []  # pruned old names whose rename carries the same value
dropped_labels: list[str] = []   # pruned string labels with no amounts anywhere under them

# Known yearly renames (old name -> replacement in the SAME parent object). The
# generator dual-writes value fields under both names on purpose - pruning the
# losing name is expected, PROVIDED the survivor holds the identical value
# (checked at prune time; a stale map entry falls through to the loud warning).
RENAMED_KEYS = {
    "Balance112AAE": "Balance112A",
    "TotalBalance112A": "Balance112A",
    "BalanceCGTransferAE": "BalanceCG",
    "CapgainonAssetsTransferAE": "CapgainonAssets",
    "ShareTransferredOnOrBefore": "ShareOnOrBefore",  # AY 2026-27 rename; old filed JSONs carry both
}


def _is_zeroish(v):
    """Zero/empty template residue: safe to prune silently (summarized once)."""
    if v is None or v == 0 or v == "" or v == "NO" or v == "N":
        return True
    if isinstance(v, dict):
        return all(_is_zeroish(x) for x in v.values())
    if isinstance(v, list):
        return all(_is_zeroish(x) for x in v)
    return False


def _has_amount(v):
    """True if a nonzero NUMBER lives anywhere under v - the only kind of drop
    that can mean lost money. Bare label/enum strings are inert without one."""
    if isinstance(v, bool):
        return False
    if isinstance(v, (int, float)):
        return v != 0
    if isinstance(v, dict):
        return any(_has_amount(x) for x in v.values())
    if isinstance(v, list):
        return any(_has_amount(x) for x in v)
    return False


def resolve(schema_node, defs):
    while isinstance(schema_node, dict) and "$ref" in schema_node:
        schema_node = defs[schema_node["$ref"].split("/")[-1]]
    if isinstance(schema_node, dict) and "allOf" in schema_node:
        merged = {k: v for k, v in schema_node.items() if k != "allOf"}
        for part in schema_node["allOf"]:
            part = resolve(part, defs)
            for k, v in part.items():
                if k == "properties":
                    merged.setdefault("properties", {}).update(v)
                else:
                    merged.setdefault(k, v)
        return merged
    return schema_node


def prune(instance, schema_node, defs, path=""):
    """Drop properties the target schema does not allow, warning each.
    Handles the yearly field renames (dropped side); new required fields
    surface later through validation."""
    schema_node = resolve(schema_node, defs)
    if isinstance(instance, dict):
        props = schema_node.get("properties", {})
        extra_ok = schema_node.get("additionalProperties", True)
        for key in list(instance.keys()):
            if key in props:
                prune(instance[key], props[key], defs, f"{path}.{key}")
            elif extra_ok is False:
                renamed_to = RENAMED_KEYS.get(key)
                if renamed_to is not None and instance.get(renamed_to) == instance[key]:
                    dropped_renamed.append(f"{path}.{key}")
                elif _is_zeroish(instance[key]):
                    dropped_zero.append(f"{path}.{key}")
                elif not _has_amount(instance[key]):
                    dropped_labels.append(f"{path}.{key}={instance[key]!r}")
                else:
                    warn(f"dropped {path}.{key} (not in target schema) with NONZERO value "
                         f"{instance[key]!r} - confirm the new schema carries it elsewhere")
                del instance[key]
    elif isinstance(instance, list):
        items = schema_node.get("items", {})
        for i, entry in enumerate(instance):
            prune(entry, items, defs, f"{path}[{i}]")


# ---------------------------------------------------------------- main build
def main():
    args = sys.argv[1:]
    def take(flag):
        if flag in args:
            i = args.index(flag)
            v = args[i + 1]
            del args[i:i + 2]
            return v
        return None

    template_path = take("--template")
    out_path = take("--out")
    if len(args) != 1 or not template_path:
        die("usage: generate-itr.py <statement-data.json> --template <prior-filed.json> [--out <file.json>]")

    data_path = Path(args[0])
    data = json.loads(data_path.read_text())
    gaps = data.get("_gaps") or []
    if gaps:
        die("unresolved extraction gaps in the data file - resolve each one and delete its _gaps "
            "entry (never generate over a gap):\n  "
            + "\n  ".join(f"[{g.get('field')}] {g.get('action')}" for g in gaps))
    template = json.loads(Path(template_path).read_text())
    ay = data["assessmentYear"]  # "2026-27"
    ay_start = ay[:4]

    schema_glob = str(REPO_ROOT / f"schemas/AY{ay}/ITR-3*Main*.json")
    schema_files = glob.glob(schema_glob)
    if not schema_files:
        die(f"no ITR-3 schema found at {schema_glob} - download it per docs (incometax.gov.in > Downloads)")
    schema = json.loads(Path(schema_files[0]).read_text())
    defs = schema.get("definitions", {})

    client = data["client"]
    if client.get("itrForm") != "ITR-3":
        die_gap(f"this generator covers ITR-3 only; data file says {client.get('itrForm')}")
    if client.get("regime") != "new":
        die_gap("this generator currently assumes the new tax regime")

    # ---- figures (same arithmetic as build-statement.py, asserted against reconciliation)
    biz = data["business"]["items"]
    if len(biz) != 1:
        die_gap("generator currently supports exactly one 44ADA business item")
    b = biz[0]
    presumptive = rup(b["gross"] * b["presumptiveRate"])

    interest = data["interest"]
    sb_total = sum(i["amount"] for i in interest.get("savings", []))
    dep_total = sum(i["amount"] for i in interest.get("deposits", []))
    dep_tds = interest.get("depositsTds", 0)
    refund_int = (interest.get("refundInterest") or {}).get("amount", 0)
    int_total = sb_total + dep_total + refund_int

    div = data.get("dividends", {})
    div_total = sum(d.get("gross") or 0 for d in div.get("items", []))
    div_tds = sum(d.get("tds") or 0 for d in div.get("items", []))
    div_periods: dict = {}
    for d in div.get("items", []):
        for col, v in (d.get("periods") or {}).items():
            div_periods[col] = div_periods.get(col, 0) + v
    div_unallocated = div_total - sum(div_periods.values())
    if div_unallocated > 0:
        warn(f"dividends without payment dates (Rs. {div_unallocated:,}) allocated to the first "
             "234C quarter (same convention as the filed prior-year return); harmless when tax is NIL")

    cg = data.get("capitalGains", {})
    lt = cg.get("longTerm", [])
    ltcg = sum(i["saleValue"] - i["cost"] for i in lt)
    lt_sale = sum(i["saleValue"] for i in lt)
    lt_cost = sum(i["cost"] for i in lt)
    loss_bf = cg.get("lossBroughtForward", 0)
    setoff = min(ltcg, -loss_bf) if ltcg > 0 and loss_bf < 0 else 0
    net_ltcg = ltcg - setoff
    if net_ltcg > 0 or cg.get("shortTerm"):
        die_gap("taxable capital gains survive set-off: Schedule CG/SI special rates not modelled in the generator")

    os_total = int_total + div_total
    gti = presumptive + net_ltcg + os_total
    total_ti = gti + setoff  # head income before BFLA set-off
    tds_total = b.get("tds", 0) + dep_tds + div_tds
    rec = data.get("reconciliation", {})
    for label, got, want in [("business", b["gross"], rec.get("tisBusinessReceipts")),
                             ("dividends", div_total, rec.get("tisDividend")),
                             ("savings interest", sb_total, rec.get("tisSavingsInterest")),
                             ("deposit interest", dep_total, rec.get("tisDepositInterest")),
                             ("total TDS", tds_total, rec.get("totalTds"))]:
        if want is not None and got != want:
            die(f"reconciliation failed - {label}: {got} vs {want}. Fix the DATA (re-read the source figure), never the check. If the same check fails twice for the same reason, stop guessing: re-run bun run extract / re-read the PDF instead.")
    if gti > SURCHARGE_GUARD:
        die_gap("income above Rs. 50 lakh: surcharge not modelled")

    age = tax_cli("ageband", "--dob", client["dob"], "--ay", ay)["age"]
    rules = tax_cli("rules", "--regime", "new", "--ay", ay, "--age", age)
    slab_tax = 0
    lower = 0
    for band in rules["slabs"]:
        upper = band.get("upTo") or float("inf")
        if gti > lower:
            slab_tax += (min(gti, upper) - lower) * band["rate"]
        lower = upper if upper != float("inf") else lower
    slab_tax = rup(slab_tax)
    rebate = min(slab_tax, rules["rebate"]["cap"]) if gti <= rules["rebate"]["threshold"] else 0
    if gti > rules["rebate"]["threshold"]:
        die_gap("income above the 87A threshold: tax becomes payable, which this generator does not model")
    refund = tds_total  # nil tax within rebate -> full TDS refundable

    exempt = next((e for e in data.get("exemptIncome", []) if e.get("name") == "PPF Interest"), None)
    ppf = exempt.get("amount") if exempt else None
    if ppf is None:
        ppf = 0
        warn("Schedule EI: PPF/exempt interest is NOT known (statement data says awaited) - "
             "get the figure from the client and regenerate before filing")

    # ---- clone and rewrite
    itr = copy.deepcopy(template["ITR"]["ITR3"])
    today = date.today().isoformat()

    itr["Form_ITR3"]["AssessmentYear"] = ay_start
    itr["Form_ITR3"]["SchemaVer"] = "Ver1.0"
    itr["Form_ITR3"]["FormVer"] = "Ver1.0"
    itr["CreationInfo"]["JSONCreationDate"] = today
    itr["CreationInfo"]["Digest"] = "-"
    warn(f"CreationInfo.SWVersionNo/SWCreatedBy copied from the prior-year filed JSON "
         f"({itr['CreationInfo'].get('SWCreatedBy')}); the portal may replace or reject these - "
         "if upload fails here, file via the portal's online mode using the filing guide instead")

    # FilingStatus: rebuilt fresh - AY 2026-27 renamed the 10-IEA history fields.
    old_fs = template["ITR"]["ITR3"]["PartA_GEN1"]["FilingStatus"]
    fs = {
        "ReturnFileSec": 11,
        "IncFrmBusOrProf": "Y",
        "SeventhProvisio139": "N",
        "ResidentialStatus": "RES",
        "ConditionsResStatus": old_fs.get("ConditionsResStatus", "1"),
        "HeldUnlistedEqShrPrYrFlg": "N",
        "ForeignExchangeFlag": "N",
        "FiiFpiFlag": "N",
        "PortugeseCC5A": "N",
        "PartnerInFirmFlg": "N",
        "CompDirectorPrvYrFlg": "N",
        "BenefitUs115HFlg": "N",
        "AsseseeRepFlg": "N",
        "NriSEPinIndia": old_fs.get("NriSEPinIndia", "NA"),
        "NriPEinIndia": old_fs.get("NriPEinIndia", "N"),
        "AggrPaymentTransac": 0,
        "NumberOfUsers": 0,
        "ItrFilingDueDate": f"{int(ay_start)}-08-31",  # non-audit ITR-3 (schema enum)
        # 10-IEA history: opted OUT to old regime in AY 2024-25, re-entered new
        # regime in AY 2025-26. No fresh 10-IEA this year (locked into NTR).
        "F10IEACurrAYNewRegime": "N",
        "F10IEACurrAYOldRegime": "N",
    }
    if old_fs.get("OptOutNewTaxRegime_Form10IEA_AY24_25") == "Y":
        fs["Form10IEAEarlierAYOldRegime"] = "Y"
        fs["Form10IEAAssYear"] = "2024-25"
        if old_fs.get("Form10IEAAckNo_AY24_25"):
            fs["Form10IEAEarlierAYAckOldRegime"] = old_fs["Form10IEAAckNo_AY24_25"]
    if old_fs.get("Form10IEAAckNo"):  # the AY 2025-26 re-entry filing
        fs["F10IEAEarlierAYNewRegime"] = "Y"
        fs["AssYrF10IEANewTaxReg"] = "2025-26"
        fs["Form10IEAEarlierAYAckNewRegime"] = old_fs["Form10IEAAckNo"]
    itr["PartA_GEN1"]["FilingStatus"] = fs

    # Business: P&L (44ADA), Schedule BP
    pl = itr["PARTA_PL"]["PersumptiveInc44ADA"]
    pl["GrsReceipt"] = b["gross"]
    pl["GrsTrnOverBank44ADA"] = b["gross"]
    pl["GrsTotalTrnOverInCash44ADA"] = 0
    pl["GrsTrnOverAnyOthMode44ADA"] = 0
    pl["TotPersumptiveInc44ADA"] = presumptive
    bp = itr["ITR3ScheduleBP"]["BusinessIncOthThanSpec"]
    for key in ["ProfBfrTaxPL", "PLUs44sChapXIIG", "NetPLAftAdjBusOthThanSpec",
                "IncomeOtherThanRule", "NetPLBusOthThanSpec7A7B7C"]:
        bp[key] = presumptive
    bp["DeemedProfitBusUs"]["Section44ADA"] = presumptive
    bp["DeemedProfitBusUs"]["TotDeemedProfitBusUs"] = presumptive
    bp["ProfitLossInclRefrdSec"]["ProfitLossUs44ADA"] = presumptive
    itr["ITR3ScheduleBP"]["IncChrgUnHdProftGain"] = presumptive
    warn(f"PARTA_BS no-books cash balance copied from prior year "
         f"(Rs. {itr['PARTA_BS']['NoBooksOfAccBS'].get('CashBalAmt', 0):,}) - confirm with client")

    # Other sources
    osch = itr["ScheduleOS"]
    inc = osch["IncOthThanOwnRaceHorse"]
    inc["DividendOthThan22e"] = div_total
    inc["DividendGross"] = div_total
    inc["IntrstFrmTermDeposit"] = dep_total
    inc["IntrstFrmSavingBank"] = sb_total
    inc["IntrstFrmIncmTaxRefund"] = refund_int
    inc["InterestGross"] = int_total
    inc["GrossIncChrgblTaxAtAppRate"] = os_total
    inc["BalanceNoRaceHorse"] = os_total
    osch["TotOthSrcNoRaceHorse"] = os_total
    osch["IncChargeable"] = os_total
    osch["DividendIncUs115BBDA"]["DateRange"] = date_range(div_periods, div_unallocated)

    # Capital gains: consolidated 112A row (as filed last year), full BFLA set-off
    s112 = itr["Schedule112A"]
    row = s112["Schedule112ADtls"][0]
    row.update({"TotSaleValue": lt_sale, "CostAcqWithoutIndx": lt_cost, "AcquisitionCost": lt_cost,
                "TotalDeductions": lt_cost, "Balance": ltcg})
    for k, v in [("Balance112AAE", ltcg), ("TotalBalance112A", ltcg), ("Balance112ABE", 0),
                 ("SaleValue112A", lt_sale), ("CostAcqWithoutIndx112A", lt_cost),
                 ("AcquisitionCost112A", lt_cost), ("Deductions112A", lt_cost), ("Balance112A", ltcg)]:
        s112[k] = v

    cg23 = itr["ScheduleCGFor23"]
    ltblock = cg23["LongTermCapGain23"]
    ltblock["TotalLTCG"] = ltcg
    eq = ltblock["SaleOfEquityShareUs112A"]
    for k in ["BalanceCGTransferAE", "BalanceCG", "CapgainonAssetsTransferAE", "CapgainonAssets"]:
        eq[k] = ltcg
    for k in ["BalanceCGTransferBE", "CapgainonAssetsTransferBE"]:
        eq[k] = 0
    st = cg23["ShortTermCapGainFor23"]
    st["TotalSTCG"] = 0
    for mf in st.get("EquityMFonSTT", []):
        for blk in ["EquityMFonSTTDtls", "EquityMFonSTTDtls_BE"]:
            mf[blk].update({"FullConsideration": 0, "BalanceCG": 0, "CapgainonAssets": 0})
            mf[blk]["DeductSec48"].update({"AquisitCost": 0, "TotalDedn": 0})
        mf["TotalCapGainonassets"] = 0
    cyl = cg23["CurrYrLosses"]
    cyl["InLtcg12_5Per"].update({"CurrYearIncome": ltcg, "CurrYrCapGain": ltcg})
    cyl["InStcg20Per"].update({"CurrYearIncome": 0, "CurrYrCapGain": 0})
    cg23["SumOfCGIncm"] = ltcg
    cg23["TotScheduleCGFor23"] = ltcg
    # accrual quarter: place LTCG by sale date (Q 16/12-15/3 for a Feb sale)
    sale_quarters: dict = {}
    for i in lt:
        dd, mm, _ = i["saleDate"].split("/")
        m, d_ = int(mm), int(dd)
        col = ("L" if (m, d_) <= (6, 15) else "M" if (m, d_) <= (9, 15) else
               "N" if (m, d_) <= (12, 15) else "O" if (m, d_) <= (3, 15) or m >= 12 else "P")
        if m <= 3 and (m, d_) > (3, 15):
            col = "P"
        sale_quarters[col] = sale_quarters.get(col, 0) + (i["saleValue"] - i["cost"])
    acc = cg23["AccruOrRecOfCG"]["LongTermUnder12_5Per"]["DateRange"]
    for k, v in date_range(sale_quarters).items():
        if k in acc:
            acc[k] = v
    acc2 = cg23["AccruOrRecOfCG"]["ShortTermUnder20Per"]["DateRange"]
    for k in acc2:
        acc2[k] = 0

    # CYLA / BFLA / CFL
    cyla = itr["ScheduleCYLA"]
    cyla["OthSrcExclRaceHorse"]["IncCYLA"].update(
        {"IncOfCurYrUnderThatHead": os_total, "IncOfCurYrAfterSetOff": os_total})
    cyla["BusProfExclSpecProf"]["IncCYLA"].update(
        {"IncOfCurYrUnderThatHead": presumptive, "IncOfCurYrAfterSetOff": presumptive})
    cyla["LTCG12_5Per"]["IncCYLA"].update(
        {"IncOfCurYrUnderThatHead": ltcg, "IncOfCurYrAfterSetOff": ltcg})
    cyla["STCG20Per"]["IncCYLA"].update({"IncOfCurYrUnderThatHead": 0, "IncOfCurYrAfterSetOff": 0})

    bfla = itr["ScheduleBFLA"]
    bfla["BusProfExclSpecProf"]["IncBFLA"].update(
        {"IncOfCurYrUndHeadFromCYLA": presumptive, "IncOfCurYrAfterSetOffBFLosses": presumptive})
    bfla["OthSrcExclRaceHorse"]["IncBFLA"].update(
        {"IncOfCurYrUndHeadFromCYLA": os_total, "IncOfCurYrAfterSetOffBFLosses": os_total})
    bfla["LTCG12_5Per"]["IncBFLA"].update(
        {"IncOfCurYrUndHeadFromCYLA": ltcg, "BFlossPrevYrUndSameHeadSetoff": setoff,
         "IncOfCurYrAfterSetOffBFLosses": ltcg - setoff})
    bfla["STCG20Per"]["IncBFLA"].update(
        {"IncOfCurYrUndHeadFromCYLA": 0, "BFlossPrevYrUndSameHeadSetoff": 0,
         "IncOfCurYrAfterSetOffBFLosses": 0})
    bfla["TotalBFLossSetOff"]["TotBFLossSetoff"] = setoff
    bfla["IncomeOfCurrYrAftCYLABFLA"] = gti

    cfl = itr["ScheduleCFL"]
    bf_total = -loss_bf
    cfl_year = cfl.get("LossCFCurrentAssmntYear2022", {}).get("CarryFwdLossDetail", {})
    cfl_year["TotalLTCGPTILossCF"] = bf_total
    cfl["TotalOfBFLossesEarlierYrs"]["LossSummaryDetail"]["TotalLTCGPTILossCF"] = bf_total
    cfl["AdjTotBFLossInBFLA"]["LossSummaryDetail"]["TotalLTCGPTILossCF"] = setoff
    cfl["TotalLossCFSummary"]["LossSummaryDetail"]["TotalLTCGPTILossCF"] = bf_total - setoff

    # SI (no special-rate income survives), EI, AMTC, UD
    for entry in itr["ScheduleSI"]["SplCodeRateTax"]:
        entry["SplRateInc"] = 0
        entry["SplRateIncTax"] = 0
    itr["ScheduleSI"]["TotSplRateInc"] = 0
    itr["ScheduleSI"]["TotSplRateIncTax"] = 0

    itr["ScheduleEI"]["InterestInc"] = ppf
    itr["ScheduleEI"]["TotalExemptInc"] = ppf

    amtc = itr["ScheduleAMTC"]
    amtc["CurrAssYr"] = ay
    prior_ay_label = data.get("priorYearLabel", "2025-26")
    if not any(r.get("AssYr") == prior_ay_label for r in amtc["ScheduleAMTCDtls"]):
        zero_row = {k: (prior_ay_label if k == "AssYr" else 0) for k in amtc["ScheduleAMTCDtls"][0]}
        amtc["ScheduleAMTCDtls"].append(zero_row)
    amtc["TaxOthProvisions"] = 0
    amtc["AmtTaxCreditAvailable"] = 0
    itr["ITR3ScheduleUD"]["CurrAssYr"] = ay

    # TDS schedule: rebuilt from the statement data
    row_shape = template["ITR"]["ITR3"]["ScheduleTDS2"]["TDSOthThanSalaryDtls"][0]
    tds_rows = []
    entries = [(b.get("tan"), b["gross"], b.get("tds", 0), "94J-B")]
    first_dep_tan = next((i.get("tan") for i in interest.get("deposits", []) if i.get("tan")), None)
    if dep_tds:
        entries.append((first_dep_tan, dep_total, dep_tds, "94A"))
    for d in div.get("items", []):
        if d.get("tds"):
            entries.append((d.get("tan"), d["gross"], d["tds"], "194"))
    for tan, gross, tds_amt, section in entries:
        row = copy.deepcopy(row_shape)
        row["TANOfDeductor"] = tan
        row["GrossAmount"] = gross
        row["TDSSection"] = section
        row["TaxDeductCreditDtls"].update(
            {"TaxDeductedOwnHands": tds_amt, "TaxClaimedOwnHands": tds_amt})
        tds_rows.append(row)
    itr["ScheduleTDS2"]["TDSOthThanSalaryDtls"] = tds_rows
    itr["ScheduleTDS2"]["TotalTDSonOthThanSals"] = tds_total
    warn('TDS rows use HeadOfIncome "OS" including the 194J business receipts - '
         "same as the accepted prior-year filing; change only if the portal objects")

    # Part B-TI
    ti = itr["PartB-TI"]
    ti["ProfBusGain"].update({"ProfGainNoSpecBus": presumptive, "TotProfBusGain": presumptive})
    ti["IncFromOS"].update({"OtherSrcThanOwnRaceHorse": os_total, "TotIncFromOS": os_total,
                            "IncChargblSplRate": 0})
    ti["CapGain"]["LongTerm"].update({"LongTerm12_5Per": ltcg, "TotalLongTerm": ltcg})
    ti["CapGain"]["ShortTerm"].update({"ShortTerm20Per": 0, "TotalShortTerm": 0})
    ti["CapGain"].update({"ShortTermLongTermTotal": ltcg, "TotalCapGains": ltcg})
    ti["TotalTI"] = total_ti
    ti["BalanceAfterSetoffLosses"] = total_ti
    ti["BroughtFwdLossesSetoff"] = setoff
    ti["GrossTotalIncome"] = gti
    ti["TotalIncome"] = gti
    ti["AggregateIncome"] = gti
    ti["IncChargeableTaxSplRates"] = 0
    ti["IncChargeTaxSplRate111A112"] = 0
    ti["CurrentYearLoss"] = 0
    ti["LossesOfCurrentYearCarriedFwd"] = 0

    # Part B-TTI
    tti = itr["PartB_TTI"]
    comp = tti["ComputationOfTaxLiability"]
    tp = comp["TaxPayableOnTI"]
    tp.update({"TaxAtNormalRatesOnAggrInc": slab_tax, "TaxAtSpecialRates": 0,
               "TaxPayableOnTotInc": slab_tax, "Rebate87A": rebate,
               "TaxPayableOnRebate": slab_tax - rebate, "EducationCess": 0,
               "GrossTaxLiability": 0, "TotalSurcharge": 0})
    comp["GrossTaxPayable"] = 0
    comp["GrossTaxPay"]["TaxInc17"] = 0
    comp["TaxPayAfterCreditUs115JD"] = 0
    comp["NetTaxLiability"] = 0
    comp["AggregateTaxInterestLiability"] = 0
    for k in comp["IntrstPay"]:
        comp["IntrstPay"][k] = 0
    tti["TaxPaid"]["TaxesPaid"].update({"TDS": tds_total, "TotalTaxesPaid": tds_total,
                                        "AdvanceTax": 0, "TCS": 0, "SelfAssessmentTax": 0})
    tti["TaxPaid"]["BalTaxPayable"] = 0
    tti["Refund"]["RefundDue"] = refund

    itr["Verification"]["Date"] = today

    # ---- AY 2026-27 additions the prior-year template cannot know about
    # New presumptive section 44BBD (Budget 2025) - not applicable, zero.
    bp["DeemedProfitBusUs"]["Section44BBD"] = 0
    bp["ProfitLossInclRefrdSec"]["ProfitLossUs44BBD"] = 0
    # MSME interest disallowance now also asked in Part A-OI.
    itr["PARTA_OI"].setdefault("InterestDisAllowUs23SMEAct", 0)
    # New secondary-address flag.
    itr["PartA_GEN1"]["PersonalInfo"].setdefault("SecondaryAdd", "N")
    # New 54/54F-family deduction-claim block in Schedule CG - nothing claimed.
    cg23.setdefault("DeducClaimInfo", {"TotDeductClaim": 0})
    # Schedule SI: keep only special-rate codes the new schema still knows
    # (the pre/post-23-Jul-2024 "_BE" split and some PTI codes were removed).
    si_enum = set(defs["SplCodeRateTax"]["properties"]["SecCode"]["enum"]) \
        if "SplCodeRateTax" in defs else None
    if si_enum is None:
        items = resolve(defs["ScheduleSI"]["properties"]["SplCodeRateTax"], defs)
        si_enum = set(resolve(items["items"], defs)["properties"]["SecCode"]["enum"])
    before = len(itr["ScheduleSI"]["SplCodeRateTax"])
    itr["ScheduleSI"]["SplCodeRateTax"] = [
        e for e in itr["ScheduleSI"]["SplCodeRateTax"] if e["SecCode"] in si_enum]
    dropped = before - len(itr["ScheduleSI"]["SplCodeRateTax"])
    if dropped:
        warn(f"Schedule SI: dropped {dropped} special-rate codes the AY {ay} schema removed "
             "(all were zero)")

    # ---- prune to the target schema, then strict validation
    doc = {"ITR": {"ITR3": itr}}
    prune(doc, schema, defs, "ITR")
    if dropped_zero:
        warn(f"pruned {len(dropped_zero)} zero/empty template-only keys absent from the AY {ay} "
             "schema (yearly schema drift - harmless; any NONZERO drop gets its own warning above)")
    if dropped_renamed:
        warn(f"pruned {len(dropped_renamed)} old-name keys superseded by their AY renames "
             "(survivor verified to hold the identical value - see RENAMED_KEYS)")
    if dropped_labels:
        warn(f"pruned {len(dropped_labels)} label-only keys with no amounts under them: "
             + ", ".join(k.split('.')[-1] for k in dropped_labels))
    errors = sorted(Draft4Validator(schema).iter_errors(doc), key=lambda e: str(e.path))
    if errors:
        print(f"SCHEMA VALIDATION FAILED ({len(errors)} errors):", file=sys.stderr)
        for e in errors[:20]:
            loc = "/".join(str(p) for p in e.path)
            print(f"  {loc}: {e.message[:160]}", file=sys.stderr)
        sys.exit(1)

    out = out_path or str(data_path.parent / "inbox" / f"AY{ay}-generated-draft1.json")
    Path(out).parent.mkdir(parents=True, exist_ok=True)
    Path(out).write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")

    print(f"saved: {out} (schema-valid against {Path(schema_files[0]).name})")
    print(f"expected at the portal: GTI {gti:,} · total income {gti:,} · tax 0 · refund {refund:,}")
    if warnings:
        print(f"\nWARNINGS ({len(warnings)}) - resolve before filing:")
        for w in warnings:
            print(f"  - {w}")
    print(f"\nnext: bun run process {out}")


if __name__ == "__main__":
    main()
