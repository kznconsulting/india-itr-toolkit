import type { RegimeComparison } from "./tax";
import type { Check, NormalizedReturn } from "./types";

export const inr = (n: number | null | undefined): string =>
  n == null ? "-" : "₹" + Math.round(n).toLocaleString("en-IN");

export const LEVEL_ICON: Record<Check["level"], string> = {
  pass: "✅",
  warn: "⚠️",
  fail: "❌",
  info: "ℹ️",
};

export function renderReport(
  r: NormalizedReturn,
  checks: Check[],
  comparison: RegimeComparison | null,
  sourcePath: string,
): string {
  const L: string[] = [];
  const push = (s = "") => L.push(s);
  const row = (label: string, value: string) => push(`| ${label} | ${value} |`);

  push(`# ITR review: ${r.assessee.name ?? "unknown assessee"} · AY ${r.assessmentYear}`);
  push();
  push(`| | |`);
  push(`|---|---|`);
  row("Source", `\`${sourcePath}\``);
  row("Generated", new Date().toISOString().slice(0, 10));
  row("Form", r.form);
  row("PAN", r.assessee.pan ?? "-");
  row("Regime", r.regime === "new" ? "New (115BAC, default)" : r.regime === "old" ? "Old (opted out)" : "unknown");
  row("Filed under", r.filingSection ?? "-");
  push();

  if (r.income.grossTotal == null) {
    push(`> Extraction found no income figures for ${r.form}. Schedules present: ${r.sections.join(", ")}.`);
    push(`> Extend the extractor in scripts/lib/extract.ts for this form/schema, then re-run.`);
    push();
  }

  push(`## Income`);
  push();
  push(`| Head | Amount |`);
  push(`|---|---:|`);
  if (r.income.salaryGross != null) row("Gross salary", inr(r.income.salaryGross));
  row("Salary (after s.16 deductions)", inr(r.income.salaryNet));
  row("House property", inr(r.income.houseProperty));
  if (r.income.business != null) row("Business/profession", inr(r.income.business));
  if (r.income.capitalGains != null) row("Capital gains", inr(r.income.capitalGains));
  row("Other sources", inr(r.income.otherSources));
  row("**Gross total income**", `**${inr(r.income.grossTotal)}**`);
  push();

  push(`## Deductions (Chapter VI-A)`);
  push();
  const items = Object.entries(r.deductions.items);
  if (items.length === 0) {
    push(`None claimed${(r.deductions.total ?? 0) > 0 ? ` (but the total field says ${inr(r.deductions.total)})` : ""}.`);
  } else {
    push(`| Section | Amount |`);
    push(`|---|---:|`);
    for (const [k, v] of items) row(k.replace(/^Section/, ""), inr(v));
    row("**Total**", `**${inr(r.deductions.total)}**`);
  }
  push();

  push(`## Tax computation`);
  push();
  push(`| | Amount |`);
  push(`|---|---:|`);
  row("Total income", inr(r.totalIncome));
  row("Tax on total income", inr(r.tax.slabTax));
  row("Rebate u/s 87A", inr(r.tax.rebate87A));
  row("Tax after rebate", inr(r.tax.afterRebate));
  if (r.tax.surcharge != null) row("Surcharge", inr(r.tax.surcharge));
  row("Health & education cess (4%)", inr(r.tax.cess));
  row("**Gross tax liability**", `**${inr(r.tax.grossLiability)}**`);
  if ((r.tax.relief ?? 0) > 0) row("Relief u/s 89", inr(r.tax.relief));
  row("Net tax liability", inr(r.tax.netLiability));
  row("Interest u/s 234A/B/C", inr(r.tax.interest));
  if ((r.tax.fee234F ?? 0) > 0) row("Late-filing fee u/s 234F", inr(r.tax.fee234F));
  row("**Total tax + interest payable**", `**${inr(r.tax.totalPayable)}**`);
  push();

  push(`## Taxes paid`);
  push();
  push(`| | Amount |`);
  push(`|---|---:|`);
  row("TDS", inr(r.paid.tds));
  row("TCS", inr(r.paid.tcs));
  row("Advance tax", inr(r.paid.advance));
  row("Self-assessment tax", inr(r.paid.selfAssessment));
  row("**Total paid**", `**${inr(r.paid.total)}**`);
  if ((r.settlement.refundDue ?? 0) > 0) {
    row("**Refund due**", `**${inr(r.settlement.refundDue)}**`);
  } else {
    row("**Balance payable**", `**${inr(r.settlement.balancePayable)}**`);
  }
  push();

  push(`## Validation`);
  push();
  for (const c of checks) push(`- ${LEVEL_ICON[c.level]} ${c.message}`);
  push();

  if (comparison) {
    push(`## Regime comparison (indicative)`);
    push();
    push(`New regime: **${inr(comparison.newRegime.total)}** on taxable income of ${inr(comparison.newRegime.totalIncome)}.`);
    push();
    push(`| Old-regime deductions | Old taxable income | Old-regime tax | vs new |`);
    push(`|---:|---:|---:|---:|`);
    for (const c of comparison.oldRegimeRows) {
      const delta = c.tax - comparison.newRegime.total;
      const deltaStr = (delta >= 0 ? "+" : "-") + inr(Math.abs(delta));
      push(`| ${inr(c.deductions)} | ${inr(c.taxableIncome)} | ${inr(c.tax)} | ${deltaStr} |`);
    }
    push();
    if (comparison.breakEvenDeductions == null) {
      push(`The old regime cannot beat the new regime at any deduction level for this income.`);
    } else if (comparison.breakEvenDeductions === 0) {
      push(`The old regime is already cheaper with zero deductions; double-check the regime choice.`);
    } else {
      push(`Break-even: the old regime wins once combined deductions/exemptions reach about **${inr(comparison.breakEvenDeductions)}**.`);
    }
    push();
    for (const n of comparison.notes) push(`- ${n}`);
    push();
  }

  push(`## Next steps`);
  push();
  push(`- [ ] Fix every ❌, understand every ⚠️, re-export from the utility, re-run this report`);
  push(`- [ ] Reconcile TDS/TCS credits and reported income against Form 26AS and AIS`);
  push(`- [ ] Confirm the regime choice against the comparison above`);
  push(`- [ ] Ensure the refund bank account is pre-validated on the e-filing portal`);
  push(`- [ ] Upload the JSON on incometax.gov.in and e-verify within 30 days`);
  push(`- [ ] Archive the filed JSON, ITR-V, and this report in archive/AY${r.assessmentYear}/`);
  push();
  push(`---`);
  push();
  push(`*Generated by scripts/process-itr.ts. The ITD utility/portal computation is authoritative; this report is a review aid, not tax advice.*`);

  return L.join("\n") + "\n";
}
