import { ageBandFromDob, computeTax } from "./tax";
import type { Check, NormalizedReturn } from "./types";

const inr = (n: number) => "₹" + Math.round(n).toLocaleString("en-IN");
const close = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

export function validateReturn(r: NormalizedReturn): Check[] {
  const checks: Check[] = [];
  const add = (id: string, level: Check["level"], message: string) =>
    checks.push({ id, level, message });

  if (r.assessee.pan) {
    if (/^[A-Z]{5}\d{4}[A-Z]$/.test(r.assessee.pan)) {
      add("pan-format", "pass", `PAN ${r.assessee.pan} is well-formed`);
    } else {
      add("pan-format", "fail", `PAN "${r.assessee.pan}" does not match the AAAAA9999A format`);
    }
  } else {
    add("pan-format", "warn", "PAN missing from PersonalInfo");
  }

  const inc = r.income;
  if (inc.grossTotal != null && inc.salaryNet != null) {
    const sum =
      (inc.salaryNet ?? 0) +
      (inc.houseProperty ?? 0) +
      (inc.business ?? 0) +
      (inc.capitalGains ?? 0) +
      (inc.otherSources ?? 0);
    // GTI can be below the head-sum when brought-forward losses were set off (Schedule BFLA)
    if (close(sum, inc.grossTotal, 1)) {
      add("heads-sum", "pass", `Income heads add up to gross total income (${inr(inc.grossTotal)})`);
    } else if (sum > inc.grossTotal) {
      add("heads-sum", "info", `Income heads sum to ${inr(sum)} vs GTI ${inr(inc.grossTotal)}: difference ${inr(sum - inc.grossTotal)} should equal brought-forward losses set off (Schedule BFLA)`);
    } else {
      add("heads-sum", "fail", `Income heads sum to ${inr(sum)} but gross total income says ${inr(inc.grossTotal)}`);
    }
  }

  if (inc.grossTotal != null && r.deductions.total != null && r.totalIncome != null) {
    const expected = inc.grossTotal - r.deductions.total;
    if (close(expected, r.totalIncome, 10)) {
      add("total-income", "pass", `Total income = GTI minus Chapter VI-A (${inr(r.totalIncome)}, s.288A rounding allowed)`);
    } else {
      add("total-income", "fail", `GTI ${inr(inc.grossTotal)} minus deductions ${inr(r.deductions.total)} = ${inr(expected)}, but the return says ${inr(r.totalIncome)}`);
    }
  }

  if (r.regime === "new" && (r.deductions.total ?? 0) > 0) {
    const allowedInNew = new Set([
      "Section80CCDEmployer",
      "Section80CCD2",
      "Section80CCH",
      "Section80JJAA",
    ]);
    const disallowed = Object.keys(r.deductions.items).filter((k) => !allowedInNew.has(k));
    if (disallowed.length > 0) {
      add("regime-deductions", "warn", `New-regime return claims deductions not available u/s 115BAC: ${disallowed.join(", ")}`);
    } else {
      add("regime-deductions", "pass", "Chapter VI-A claims are limited to sections allowed in the new regime");
    }
  }

  const p = r.paid;
  if (p.total != null) {
    const sum = (p.tds ?? 0) + (p.tcs ?? 0) + (p.advance ?? 0) + (p.selfAssessment ?? 0);
    if (close(sum, p.total, 1)) {
      add("paid-sum", "pass", `Tax payments add up (${inr(p.total)})`);
    } else {
      add("paid-sum", "fail", `TDS + TCS + advance + self-assessment = ${inr(sum)} but total taxes paid says ${inr(p.total)}`);
    }
  }

  if (r.tax.totalPayable != null && p.total != null) {
    const diff = r.tax.totalPayable - p.total; // positive: payable, negative: refund
    if (diff > 0) {
      if (r.settlement.balancePayable != null && close(r.settlement.balancePayable, diff, 10)) {
        add("settlement", "pass", `Balance payable ${inr(r.settlement.balancePayable)} matches liability minus payments`);
      } else {
        add("settlement", "fail", `Liability ${inr(r.tax.totalPayable)} minus payments ${inr(p.total)} leaves ${inr(diff)}, but balance payable says ${inr(r.settlement.balancePayable ?? 0)}`);
      }
    } else {
      const refund = -diff;
      if (close(r.settlement.refundDue ?? 0, refund, 10)) {
        add(
          "settlement",
          "pass",
          refund === 0
            ? "Nil balance: payments exactly cover the liability"
            : `Refund due ${inr(r.settlement.refundDue ?? 0)} matches payments minus liability`,
        );
      } else {
        add("settlement", "fail", `Payments exceed liability by ${inr(refund)}, but refund due says ${inr(r.settlement.refundDue ?? 0)}`);
      }
    }
  }

  if ((r.settlement.refundDue ?? 0) > 0) {
    if (r.settlement.bankPresent) {
      add("refund-bank", "pass", "Refund due and bank details are present (ensure the account is pre-validated on the portal)");
    } else {
      add("refund-bank", "fail", "Refund is due but no bank account details were found in the return");
    }
  }

  // Recompute with our slab engine. ITR-1 only: no special-rate income can appear there.
  if (r.form === "ITR-1" && r.totalIncome != null && (r.regime === "new" || r.regime === "old")) {
    const bd = computeTax({
      totalIncome: r.totalIncome,
      regime: r.regime,
      ay: r.assessmentYear,
      age: ageBandFromDob(r.assessee.dob, r.assessmentYear),
    });
    if (!bd) {
      add("tax-recompute", "info", `No slab table for AY ${r.assessmentYear} in scripts/lib/tax.ts; recomputation skipped`);
    } else {
      const cmp: [string, number | null, number][] = [
        ["tax on total income", r.tax.slabTax, bd.slabTax],
        ["rebate u/s 87A", r.tax.rebate87A, bd.rebate87A],
        ["cess", r.tax.cess, bd.cess],
        ["gross tax liability", r.tax.grossLiability, bd.afterRebate + bd.surcharge + bd.cess],
      ];
      const mismatches = cmp
        .filter(([, declared, computed]) => declared != null && !close(declared, computed, 10))
        .map(([label, declared, computed]) => `${label}: return ${inr(declared!)} vs recomputed ${inr(computed)}`);
      if (mismatches.length === 0) {
        add("tax-recompute", "pass", `Slab-engine recomputation matches the utility (${inr(bd.afterRebate + bd.surcharge + bd.cess)} incl. cess)`);
      } else {
        add("tax-recompute", "warn", `Recomputation differs - ${mismatches.join("; ")}. Investigate before filing (special-rate income or an engine gap can explain it).`);
      }
    }
  } else if (r.form !== "ITR-1" && r.totalIncome != null) {
    add("tax-recompute", "info", `${r.form} can include special-rate income; slab-engine recomputation skipped`);
  }

  if ((r.tax.fee234F ?? 0) > 0) {
    add("late-fee", "warn", `Late-filing fee ${inr(r.tax.fee234F!)} u/s 234F is included`);
  }
  if ((r.tax.interest ?? 0) > 0) {
    add("interest", "info", `Interest ${inr(r.tax.interest!)} u/s 234A/B/C charged: consider advance-tax instalments next year`);
  }

  return checks;
}
