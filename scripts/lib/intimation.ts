// Deterministic parser for the CPC 143(1) intimation order's layout text
// (pdftotext -layout). The intimation is the AUTHORITATIVE source for the 244A
// refund interest and the CPC-determined refund principal - the two figures the
// runbook forbids estimating. It also carries the filed-vs-computed comparison
// (the "diff it against the filed numbers" post-filing check).
//
// Layout notes (validated against a real CPC order): the first half is the
// Hindi rendering (garbled by pdftotext - ignored); the English computation
// table has stable row descriptions with one or two trailing amount columns
// (as-filed | as-computed u/s 143(1)). Wrapped rows put the label on one line
// and the amounts on the numbered continuation line, so each anchor checks its
// own line first and the next line second.

import { inrAmount } from "./pdftext";

export interface IntimationResult {
  pan: string | null;
  ay: string | null; // "2025-26"
  ackNo: string | null;
  din: string | null;
  outcome: "refund" | "demand" | "unknown";
  totalIncomeFiled: number | null;
  totalIncomeComputed: number | null;
  taxPayableFiled: number | null;
  taxPayableComputed: number | null;
  refundPrincipal: number | null; // row 31, as computed - the CPC-determined principal
  interest244A: number | null; // row 33 - THE authoritative refund-interest figure
  tdsOn244A: number | null; // row 34 (non-residents)
  totalRefund: number | null; // row 35 = 31 + 33 - 34
  adjustedAgainstDemand: number | null; // row 36 (s.245 adjustment)
  netAmount: number | null; // row 37 (refundable, or payable on demand orders)
  flags: string[];
}

/** Trailing amount tokens on a line: "...  6,67,309   6,67,310" -> [667309, 667310];
 *  "N/A" columns come back as null. */
function trailingAmounts(line: string, max = 2): (number | null)[] {
  const out: (number | null)[] = [];
  let rest = line.replace(/\s+$/, "");
  for (let i = 0; i < max; i++) {
    const m = rest.match(/\s{2,}(N\/A|-?[\d,]+)$/);
    if (!m) break;
    out.unshift(m[1] === "N/A" ? null : inrAmount(m[1]));
    rest = rest.slice(0, rest.length - m[0].length);
  }
  return out;
}

/** Find the first line matching `anchor`; return its trailing amounts, looking
 *  at the next line when the anchor line itself carries none (wrapped rows). */
function rowAmounts(lines: string[], anchor: RegExp, max = 2): (number | null)[] {
  for (let i = 0; i < lines.length; i++) {
    if (!anchor.test(lines[i])) continue;
    const own = trailingAmounts(lines[i], max);
    if (own.length > 0) return own;
    if (lines[i + 1]) return trailingAmounts(lines[i + 1], max);
    return [];
  }
  return [];
}

const last = (a: (number | null)[]): number | null => (a.length ? a[a.length - 1] : null);

export function parseIntimation(text: string): IntimationResult {
  const lines = text.split("\n");
  const flags: string[] = [];

  const pan = text.match(/PAN\s*:\s*([A-Z]{5}\d{4}[A-Z])/)?.[1] ?? null;
  const din = text.match(/DIN\s*:\s*([A-Z0-9/]+)/)?.[1] ?? null;
  const ackNo = text.match(/Ack\.\s*No\.\s*:\s*(\d+)/)?.[1] ?? null;

  const banner = text.match(/You have a (Refund|Demand) for A\.Y\.\s*(\d{4}-\d{2})/i);
  const outcome = banner ? (banner[1].toLowerCase() as "refund" | "demand") : "unknown";
  const ay = banner?.[2] ?? text.match(/AY\s*:\s*(\d{4}-\d{2})/)?.[1] ?? null;

  const ti = rowAmounts(lines, /Total income \[11-13/);
  const tax = rowAmounts(lines, /Tax Payable on Total Income \(22a/);
  const refundPrincipal = last(rowAmounts(lines, /Refund amount \[31=/));
  const interest244A = last(rowAmounts(lines, /Interest u\/s 244A on refund/));
  const tdsOn244A = last(rowAmounts(lines, /TDS deducted on interest paid u\/s 244A/));
  const totalRefund = last(rowAmounts(lines, /Total income tax refund \[35=/));
  const adjustedAgainstDemand = last(rowAmounts(lines, /refund adjusted against demand/, 1));
  const netAmount =
    last(rowAmounts(lines, /Net Amount Refundable/, 1)) ?? last(rowAmounts(lines, /Net Amount Payable/, 1));

  const result: IntimationResult = {
    pan,
    ay,
    ackNo,
    din,
    outcome,
    totalIncomeFiled: ti[0] ?? null,
    totalIncomeComputed: ti.length > 1 ? ti[1] : null,
    taxPayableFiled: tax[0] ?? null,
    taxPayableComputed: tax.length > 1 ? tax[1] : null,
    refundPrincipal,
    interest244A,
    tdsOn244A,
    totalRefund,
    adjustedAgainstDemand,
    netAmount,
    flags,
  };

  if (outcome === "unknown" && interest244A == null && refundPrincipal == null) {
    flags.push(
      "INTIMATION PARSE FAILED: neither the refund/demand banner nor the computation rows were found. " +
        "Do not retry unchanged. Take the figures manually from the PDF's English computation table and " +
        "log a gap-ledger entry (docs/missing-functionality.md) quoting the layout so the parser can be fixed.",
    );
    return result;
  }
  if (outcome === "demand") {
    flags.push(
      `intimation raises a DEMAND${netAmount != null ? ` of Rs. ${netAmount.toLocaleString("en-IN")}` : ""} - ` +
        `review the filed-vs-computed columns and respond within the deadline; do not just file the next year over it.`,
    );
  }
  if (
    result.totalIncomeFiled != null &&
    result.totalIncomeComputed != null &&
    result.totalIncomeFiled !== result.totalIncomeComputed
  ) {
    flags.push(
      `CPC computed total income differs from the filed figure by Rs. ` +
        `${Math.abs(result.totalIncomeComputed - result.totalIncomeFiled).toLocaleString("en-IN")} ` +
        `(${result.totalIncomeFiled.toLocaleString("en-IN")} filed vs ${result.totalIncomeComputed.toLocaleString("en-IN")} computed) - ` +
        `usually rounding; investigate if larger than a few rupees.`,
    );
  }
  if (adjustedAgainstDemand != null && adjustedAgainstDemand > 0) {
    flags.push(
      `Rs. ${adjustedAgainstDemand.toLocaleString("en-IN")} of the refund was adjusted against an earlier ` +
        `demand u/s 245 - the amount credited to the bank is NOT principal + interest; account for the adjustment.`,
    );
  }
  return result;
}
