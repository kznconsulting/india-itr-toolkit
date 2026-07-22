#!/usr/bin/env bun
// Generate a portal filing guide (markdown) from a client's statement-data.json.
//
// The guide maps every figure to the e-filing portal's online-mode screen where
// it goes, so filing the return is transcription, not judgment. It also states
// the expected Part B-TTI totals: if the portal shows anything different, the
// operator stops and reconciles instead of submitting.
//
// Screen names follow ITR-3 (the practice's common case: presumptive 44ADA +
// capital gains + other sources). For other forms the figures still hold but
// schedule names may differ; the guide says so when itrForm is not ITR-3.
//
// Usage: bun scripts/filing-guide.ts <statement-data.json> [--out <file.md>]
//        (or: bun run guide <statement-data.json>)

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ageBandFromDob, computeTotalTax, getRules, PERIOD_LABELS, salePeriodColumn } from "./lib/tax";
import type { ResidentialStatus } from "./lib/tax";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function dobToIso(dob: string): string {
  const m = dob.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) die(`client.dob must be DD/MM/YYYY, got "${dob}"`);
  return `${m![3]}-${m![2]}-${m![1]}`;
}

const args = process.argv.slice(2);
let outPath: string | null = null;
const outIdx = args.indexOf("--out");
if (outIdx !== -1) {
  outPath = args[outIdx + 1] ?? null;
  args.splice(outIdx, 2);
}
if (args.length !== 1) die("usage: bun scripts/filing-guide.ts <statement-data.json> [--out <file.md>]");

const dataPath = args[0];
const data = JSON.parse(readFileSync(dataPath, "utf8"));
const client = data.client;
const ay: string = data.assessmentYear;
const short = ay.slice(2);

// ---- derived figures (same arithmetic as build-statement.py, re-asserted below)
const salary = data.salary ?? {};
const salaryGross: number = salary.gross ?? 0;
const salaryTds: number = salary.tds ?? 0;

const bizItems: any[] = data.business?.items ?? [];
const bizGross = bizItems.reduce((s, b) => s + b.gross, 0);
const bizTds = bizItems.reduce((s, b) => s + (b.tds ?? 0), 0);
const presumptive = bizItems.reduce((s, b) => s + Math.round(b.gross * b.presumptiveRate), 0);

const interest = data.interest ?? {};
const sbTotal = (interest.savings ?? []).reduce((s: number, i: any) => s + i.amount, 0);
const sbTds = interest.savingsTds ?? 0; // NRI s.195 TDS; residents never have savings-account TDS
const depTotal = (interest.deposits ?? []).reduce((s: number, i: any) => s + i.amount, 0);
const depTds = interest.depositsTds ?? 0;
const refundInt = interest.refundInterest?.amount ?? 0;

const divItems: any[] = data.dividends?.items ?? [];
const divTotal = divItems.reduce((s, d) => s + (d.gross ?? 0), 0);
const divTds = divItems.reduce((s, d) => s + (d.tds ?? 0), 0);

const cg = data.capitalGains ?? {};
const ltItems: any[] = cg.longTerm ?? [];
const stItems: any[] = cg.shortTerm ?? [];
for (const i of [...ltItems, ...stItems]) {
  if ((i.assetClass ?? "equity") !== "equity")
    die(`non-equity capital-gains item "${i.name}" (${i.assetClass}): s.112/slab-rate assets are not modelled`);
}
const ltcg = ltItems.reduce((s, i) => s + (i.saleValue - i.cost), 0);
const lossBf: number = cg.lossBroughtForward ?? 0;
const setoff = ltcg > 0 && lossBf < 0 ? Math.min(ltcg, -lossBf) : 0;
const netLtcg = ltcg - setoff;
const lossCf = lossBf + setoff;
if (netLtcg < 0) die(`current-year net LT capital LOSS ${inr(-netLtcg)}: fresh-loss carry-forward not modelled`);

const stcgGross = stItems.reduce((s, i) => s + (i.saleValue - i.cost), 0);
if (stcgGross < 0) die(`net short-term capital LOSS ${inr(-stcgGross)}: ST-loss set-off ordering not modelled`);

// Special-rate legs, split at the FA (No. 2) 2024 rate-change date (23-07-2024);
// same arithmetic as build-statement.py.
const RATE_CHANGE = "2024-07-23";
const gainOf = (i: any) => i.saleValue - i.cost;
const isBefore = (i: any) => {
  const m = String(i.saleDate ?? "").match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` < RATE_CHANGE : false; // undated -> on/after
};
const legs = (items: any[]) => {
  const before = items.filter(isBefore).reduce((s, i) => s + gainOf(i), 0);
  const total = items.reduce((s, i) => s + gainOf(i), 0);
  return [before, total - before] as const;
};
const [stBefore, stAfter] = legs(stItems);
const [ltBefore, ltAfter] = legs(ltItems);
let ltBeforeNet: number, ltAfterNet: number;
if (ltBefore <= 0 || ltAfter <= 0) {
  ltBeforeNet = ltAfter <= 0 ? Math.max(0, netLtcg) : 0;
  ltAfterNet = ltAfter > 0 ? Math.max(0, netLtcg) : 0;
} else {
  ltBeforeNet = Math.max(0, ltBefore - setoff); // b/f loss set off chronologically
  ltAfterNet = ltAfter - Math.max(0, setoff - ltBefore);
}
let stBeforeNet: number, stAfterNet: number;
if (stBefore <= 0 || stAfter <= 0) {
  stBeforeNet = stAfter <= 0 ? Math.max(0, stcgGross) : 0;
  stAfterNet = stAfter > 0 ? Math.max(0, stcgGross) : 0;
} else {
  stBeforeNet = stBefore;
  stAfterNet = stAfter;
}
const specialGross = stcgGross + netLtcg;

const hp = data.houseProperty ?? {};
const hpProps: any[] = hp.properties ?? [];
const hpCalc = hpProps.map((p) => {
  const alv = p.annualLetableValue;
  const tax = p.propertyTax ?? 0;
  const balanceAlv = alv - tax;
  const sharePct = p.assesseeSharePercent ?? 100;
  const ownedShare = Math.round((balanceAlv * sharePct) / 100);
  const thirtyPct = Math.round(ownedShare * 0.3);
  const incomeHp = ownedShare - thirtyPct;
  return { alv, tax, balanceAlv, sharePct, ownedShare, thirtyPct, incomeHp, tds: p.tds ?? 0 };
});
const hpIncomeTotal = hpCalc.reduce((s, c) => s + c.incomeHp, 0);
const hpTdsTotal = hpCalc.reduce((s, c) => s + c.tds, 0);

const age = ageBandFromDob(dobToIso(client.dob), ay);
const regime = client.regime === "old" ? "old" : "new";
const resRaw = String(client.residentialStatus ?? "resident").toLowerCase();
const residentialStatus: ResidentialStatus =
  resRaw.includes("nri") || resRaw.includes("non-resident") || resRaw === "nr" ? "nri" : "resident";
const rules = getRules(regime, ay, residentialStatus === "nri" ? "lt60" : age);
if (!rules) die(`no tax rules for AY ${ay} in scripts/lib/tax.ts`);
const stdDed = salaryGross ? rules.standardDeduction : 0;

const osTotal = sbTotal + depTotal + refundInt + divTotal;
const gti = salaryGross + presumptive + hpIncomeTotal + netLtcg + stcgGross + osTotal;
const dedNew = (data.deductions?.newRegime ?? []).reduce((s: number, d: any) => s + d.amount, 0) + stdDed;
const tiNew = gti - dedNew - specialGross; // slab-rate base only (111A/112A income excluded, no set-off against it)
const rNew = Math.round(tiNew / 10) * 10;
const rTotal = Math.round((gti - dedNew) / 10) * 10; // portal's Part B-TTI "Total income" (includes special-rate gains)
const tdsTotal = salaryTds + bizTds + sbTds + depTds + divTds + hpTdsTotal;
const paid = data.taxesPaid ?? {};
const totalPaid = tdsTotal + (paid.advance ?? 0) + (paid.selfAssessment ?? 0);

const rec = data.reconciliation ?? {};
for (const [label, got, want] of [
  ["salary", salaryGross, rec.tisSalary],
  ["dividends", divTotal, rec.tisDividend],
  ["dividend TDS", divTds, rec.tisDividendTds],
  ["savings interest", sbTotal, rec.tisSavingsInterest],
  ["savings interest TDS", sbTds, rec.tisSavingsInterestTds],
  ["deposit interest", depTotal, rec.tisDepositInterest],
  ["business receipts", bizGross, rec.tisBusinessReceipts],
  ["total TDS", tdsTotal, rec.totalTds],
  ["house property rent (100% ALV)", hpCalc.reduce((s, c) => s + c.alv, 0), rec.tisRent],
  ["house property TDS", hpTdsTotal, rec.tisRentTds],
] as [string, number, number | undefined][]) {
  if (want !== undefined && got !== want) die(`reconciliation failed - ${label}: ${got} vs target ${want}`);
}

// Full-liability computation: slab + 111A/112A special rates, 112A exemption,
// resident-only basic-exemption adjustment and 87A gate (build-statement.py runs the
// same computation; the two must agree by construction).
const comp = computeTotalTax({
  slabIncome: rNew,
  regime,
  ay,
  age,
  residentialStatus,
  gains: {
    stcg111ABefore: stBeforeNet,
    stcg111AOnAfter: stAfterNet,
    ltcg112ABefore: ltBeforeNet,
    ltcg112AOnAfter: ltAfterNet,
  },
});
if (!comp) die(`no tax rules for AY ${ay} in scripts/lib/tax.ts`);
if (comp.totalIncome > 5_000_000)
  die(`total income ${inr(comp.totalIncome)} exceeds ₹50L: surcharge not modelled - extend the toolkit`);
const expectedTax = comp.grossTaxLiability;
const refund = totalPaid - expectedTax;

// dividend quarterly breakup (Schedule OS item for 234C)
const perTotals: Record<string, number> = { L: 0, M: 0, N: 0, O: 0, P: 0 };
for (const d of divItems) for (const [c, v] of Object.entries(d.periods ?? {})) perTotals[c] += v as number;
const allocated = Object.values(perTotals).reduce((a, b) => a + b, 0);
const unallocated = divTotal - allocated;

// ---- emit markdown
const L: string[] = [];
const push = (s = "") => L.push(s);
const check = (s: string) => push(`- [ ] ${s}`);

push(`# Filing guide: ${client.name} - AY ${ay} (${client.itrForm}, ${regime === "new" ? "New Regime" : "Old Regime"})`);
push();
push(`Generated from \`${dataPath}\`. Expected outcome: **tax ${inr(expectedTax)}, refund ${inr(refund)}**.`);
push(`If the portal computes anything different at Part B-TTI, STOP and reconcile - do not submit.`);
if (client.itrForm !== "ITR-3") push(`\n> Note: screen names below follow ITR-3; for ${client.itrForm} they may differ slightly.`);
push();
push(`## Before you start`);
push();
check(`Re-download AIS and 26AS; confirm totals still match the statement (they change as deductors revise filings)`);
check(`Refund bank account pre-validated AND nominated for refund (profile → My Bank Account)`);
check(`Aadhaar-linked mobile available for the e-verify OTP`);
check(`Last year's filed return open for reference (financial particulars, books-of-account answers)`);
push();
push(`## Start the return`);
push();
push(`e-File → Income Tax Returns → File Income Tax Return → AY ${ay} → **Online** → Individual → **${client.itrForm}** → Start new filing.`);
push();
check(`Filing section: 139(1) - ${client.returnStatus ?? "Original Return"}`);
check(`"Do you wish to opt out of the new tax regime?" → **${regime === "new" ? "No" : "Yes"}** ${regime === "new" ? "(continue NTR)" : "(old regime)"}`);
for (const n of client.regimeNotes ?? []) push(`  - ${n}`);
push();
push(`## Part A - General (mostly prefilled - verify)`);
push();
check(`Name / PAN ${client.pan} / DOB ${client.dob} / address / contact - verify prefill`);
if (residentialStatus === "nri") {
  check(`Residential status: **Non-Resident** - fill days-of-stay + jurisdiction of residence (foreign TIN) when asked; no 87A rebate applies`);
} else {
  check(`Residential status: Resident (verify prefill)`);
}
check(`Bank accounts listed; refund account: ${(client.banks ?? []).find((b: any) => b.useForRefund)?.label ?? "-"}`);
push();

if (salaryGross) {
  push(`## Schedule Salary`);
  push();
  check(`Employer: ${salary.payer ?? "-"} (TAN ${salary.tan ?? "-"}) - Gross salary **${inr(salaryGross)}**, TDS **${inr(salaryTds)}**`);
  check(`Less: Standard deduction u/s 16(ia): **${inr(stdDed)}**`);
  push();
} else if (salary.note) {
  push(`## Schedule Salary`);
  push();
  check(`No salary income (${salary.note})`);
  push();
}

if (hpProps.length) {
  push(`## Schedule House Property`);
  push();
  for (const [p, c] of hpProps.map((p, i) => [p, hpCalc[i]] as [any, typeof hpCalc[0]])) {
    check(`Property: ${p.address ?? "-"}; tenant ${p.tenant?.name ?? "-"} (TAN ${p.tenant?.tan ?? "-"})`);
    if (p.coOwner) check(`Co-owned with ${p.coOwner.name} (${p.coOwner.percentShare}%) - your share **${c.sharePct}%**`);
    check(`Annual Letable Value **${inr(c.alv)}**, less local taxes **${inr(c.tax)}** → Balance ALV **${inr(c.balanceAlv)}**`);
    check(`Your share of Balance ALV **${inr(c.ownedShare)}**, less 30% standard deduction **${inr(c.thirtyPct)}** → income from this property **${inr(c.incomeHp)}**`);
  }
  check(`Total income from house property **${inr(hpIncomeTotal)}**, TDS **${inr(hpTdsTotal)}**`);
  push();
}

if (bizItems.length) {
  push(`## Nature of Business + P&L (presumptive u/s 44ADA)`);
  push();
  for (const b of bizItems) {
    for (const [k, v] of Object.entries(b.meta ?? {})) check(`${k}: ${v}`);
    check(`Schedule P&L item 62 (44ADA): Gross receipts **${inr(b.gross)}**; presumptive income (${(b.presumptiveRate * 100).toFixed(0)}%) **${inr(Math.round(b.gross * b.presumptiveRate))}**`);
  }
  check(`GST details on the 44ADA screen: as applicable (confirm registration status with client)`);
  check(`Financial particulars (debtors/creditors/stock/cash where books not maintained): follow last year's filed return`);
  push();
}

if (ltItems.length || lossBf || stItems.length) {
  push(`## Schedule CG + 112A + BFLA/CFL`);
  push();
  for (const i of ltItems) {
    check(`Schedule 112A row: ${i.name} - ISIN ${i.isin ?? "-"}, sale ${i.saleDate ?? "-"}, consideration **${inr(i.saleValue)}**, cost of acquisition **${inr(i.cost)}** → LTCG ${inr(i.saleValue - i.cost)}`);
  }
  if (lossBf) {
    check(`Schedule CFL shows brought-forward LT loss **${inr(-lossBf)}** (per earlier returns)`);
    check(`Schedule BFLA sets off **${inr(setoff)}** against this year's LTCG → net LTCG **${inr(netLtcg)}**`);
    check(`Schedule CFL carry-forward to next year: **${inr(-lossCf)}**`);
  }
  for (const i of stItems) {
    const rate = isBefore(i) ? comp.stcg111A.before.rate : comp.stcg111A.onAfter.rate;
    check(`Schedule 111A row: ${i.name} - ISIN ${i.isin ?? "-"}, sale ${i.saleDate ?? "-"}, consideration **${inr(i.saleValue)}**, cost of acquisition **${inr(i.cost)}** → STCG ${inr(i.saleValue - i.cost)} (flat ${(rate * 100).toFixed(1).replace(/\.0$/, "")}%, no Chapter VI-A set-off)`);
  }
  if (netLtcg > 0) {
    check(`Portal computes LTCG u/s 112A: net gain **${inr(netLtcg)}** less exemption **${inr(comp.ltcg112A.exemption)}** → taxable **${inr(comp.ltcg112A.before.taxable + comp.ltcg112A.onAfter.taxable)}** → tax **${inr(comp.ltcg112A.tax)}**`);
  }
  if (comp.basicExemptionAdjustment > 0) {
    check(`Unexhausted basic exemption absorbs **${inr(comp.basicExemptionAdjustment)}** of the gains (resident-only adjustment - the portal applies it automatically; verify it did)`);
  }
  // "Information about accrual/receipt of capital gain" table (asked for 234C):
  // gains bucketed by period of sale, gross (before BFLA - the portal derives the net)
  const cgPeriodTotals = (items: any[]) => {
    const t: Record<string, number> = { L: 0, M: 0, N: 0, O: 0, P: 0 };
    try {
      for (const i of items) t[salePeriodColumn(String(i.saleDate ?? ""), ay)] += gainOf(i);
    } catch (e) {
      die(`capital-gains item without a usable sale date: ${(e as Error).message} - fix the data file`);
    }
    return t;
  };
  for (const [label, items, total] of [
    [`STCG u/s 111A`, stItems, stcgGross],
    [`LTCG u/s 112A`, ltItems, ltcg],
  ] as [string, any[], number][]) {
    if (!items.length || total <= 0) continue;
    check(`Accrual/receipt of capital gain table - ${label} **${inr(total)}** by period of sale (gross, before any set-off):`);
    const t = cgPeriodTotals(items);
    for (const [c, lab] of Object.entries(PERIOD_LABELS)) {
      if (t[c]) push(`    - ${lab}: **${inr(t[c])}**`);
    }
  }
  push();
}

push(`## Schedule OS (Other Sources)`);
push();
if (divTotal) {
  check(`Dividend income (gross): **${inr(divTotal)}**`);
  push(`  Quarterly breakup (asked for 234C):`);
  for (const [c, label] of Object.entries(PERIOD_LABELS)) {
    if (perTotals[c]) push(`    - ${label}: **${inr(perTotals[c])}**`);
  }
  if (unallocated > 0) {
    push(`    - Unallocated (no payment dates in AIS): **${inr(unallocated)}** - allocate per bank statements; ` +
         (expectedTax === 0 ? `with NIL tax, 234C is zero regardless, so the earliest quarter is a safe default.` : `verify against bank statements before allocating.`));
  }
}
if (depTotal) check(`Interest from deposits: **${inr(depTotal)}**`);
if (sbTotal) check(`Interest from savings bank: **${inr(sbTotal)}**${sbTds ? ` (carries TDS ${inr(sbTds)} u/s 195 - non-resident)` : ""}`);
if (refundInt) check(`Interest on income-tax refund: **${inr(refundInt)}** (${interest.refundInterest?.note ?? ""})`);
push();

push(`## Chapter VI-A`);
push();
if (regime === "new") {
  check(`No deductions (new regime)${dedNew - stdDed ? ` except: ${inr(dedNew - stdDed)} as per data file` : ""}`);
} else {
  for (const d of data.deductions?.oldRegime ?? []) check(`${d.section}: ${inr(d.amount)} (${d.desc ?? ""})`);
}
push();

push(`## Schedule TDS (prefilled from 26AS - verify each row)`);
push();
push(`| Deductor | TAN | TDS |`);
push(`|---|---|---:|`);
if (salaryTds) push(`| ${salary.payer ?? "-"} | ${salary.tan ?? "-"} | ${inr(salaryTds)} |`);
for (const p of hpProps) if (p.tds) push(`| ${p.tenant?.name ?? "-"} (tenant) | ${p.tenant?.tan ?? "-"} | ${inr(p.tds)} |`);
for (const b of bizItems) if (b.tds) push(`| ${b.payer} | ${b.tan ?? "-"} | ${inr(b.tds)} |`);
for (const i of interest.deposits ?? []) {
  if (i.tan) { push(`| ${i.bank} | ${i.tan} | ${inr(depTds)} |`); break; }
}
if (sbTds) {
  const sb = (interest.savings ?? []).find((i: any) => i.tan) ?? (interest.savings ?? [])[0] ?? {};
  push(`| ${sb.bank ?? "-"} (savings a/c, s.195) | ${sb.tan ?? "-"} | ${inr(sbTds)} |`);
}
for (const d of divItems) if (d.tds) push(`| ${d.name} | ${d.tan ?? "-"} | ${inr(d.tds)} |`);
push(`| **Total** | | **${inr(tdsTotal)}** |`);
push();
check(`Every 26AS row claimed; no extra rows; total TDS = **${inr(tdsTotal)}**`);
if (paid.advance) check(`Schedule IT: advance tax ${inr(paid.advance)}`);
if (paid.selfAssessment) check(`Schedule IT: self-assessment tax ${inr(paid.selfAssessment)}`);
push();

push(`## Verify Part B-TTI before submitting (STOP if different)`);
push();
push(`| Portal field | Expected |`);
push(`|---|---:|`);
push(`| Gross total income | ${inr(gti)} |`);
push(`| Total income (rounded) | ${inr(rTotal)} |`);
if (stcgGross > 0) push(`| ...of which STCG u/s 111A (special rate, no set-off) | ${inr(stcgGross)} |`);
if (netLtcg > 0) push(`| ...of which LTCG u/s 112A (special rate above ${inr(comp.ltcg112A.exemption)} exemption) | ${inr(netLtcg)} |`);
push(`| Tax at normal (slab) rates${residentialStatus === "nri" ? "" : " after rebate 87A"} | ${inr(Math.round(comp.slab.afterRebate))} |`);
if (comp.specialRateTax > 0) push(`| Tax at special rates (111A ${inr(comp.stcg111A.tax)} + 112A ${inr(comp.ltcg112A.tax)}) | ${inr(comp.specialRateTax)} |`);
if (comp.rebate87AOnSpecial > 0) push(`| Less: 87A rebate against 111A tax (old regime) | ${inr(comp.rebate87AOnSpecial)} |`);
push(`| Health & education cess (4%) | ${inr(comp.cess)} |`);
push(`| **Gross tax liability** | **${inr(expectedTax)}** |`);
push(`| Total taxes paid | ${inr(totalPaid)} |`);
push(`| **Refund due** | **${inr(refund)}** |`);
if (residentialStatus === "nri") push(`\n> NRI: no 87A rebate at any income level, and the basic-exemption adjustment against special-rate gains does not apply.`);
push();
check(`Schedule AL: ${rTotal > 5_000_000 ? "REQUIRED (income > 50L) - prepare assets/liabilities" : "not applicable (income <= 50L)"}`);
check(`Schedule FA: confirm client has no foreign assets/accounts (mandatory if any)`);
push();
push(`## Submit and e-verify`);
push();
check(`Preview the return PDF; spot-check against the statement Excel`);
check(`Submit, then **e-verify immediately** (Aadhaar OTP) - unverified returns lapse after 30 days`);
check(`Download: filed JSON, ITR-V acknowledgement, and the return PDF`);
push();
push(`## After filing (back in this repo)`);
push();
push("```sh");
push(`# drop the filed JSON into the client's inbox, then:`);
push(`bun run process clients/<name>/inbox/AY${ay}-<client>-filed.json   # cross-check what was filed`);
push(`# then archive: filed JSON + ITR-V + statement + AIS/26AS snapshots -> clients/<name>/archive/AY${ay}/`);
push(`bun run status                                                    # board should show FILED`);
push("```");
push();
push(`---`);
push(`*Generated by scripts/filing-guide.ts. Figures verified against the reconciliation targets; tax via scripts/lib/tax.ts.*`);

const out = outPath ?? join(dirname(dataPath), `${client.displayName}_AY ${short}_Filing-Guide.md`);
writeFileSync(out, L.join("\n") + "\n");
console.log(`Expected: tax ${inr(expectedTax)}, refund ${inr(refund)} (${regime} regime, AY ${ay})`);
console.log(`saved: ${out}`);
