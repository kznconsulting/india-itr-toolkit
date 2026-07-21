// Deterministic parser for Form 26AS (Annual Tax Statement) layout text
// (pdftotext -layout). Part I (TDS) is parsed fully: per-deductor totals with
// their transaction rows (dates matter - dividend payment dates drive the
// statement's 234C period allocation). Every deductor's rows must sum to its
// header totals (reversal rows net out) or the deductor is flagged.
//
// Parts II-X are not modelled: any of them showing transactions is flagged
// with a park-instruction, never silently ignored.

import { inrAmount } from "./pdftext";

export interface F26asTxn {
  section: string; // "194", "194A", "194JB", ...
  txnDate: string; // DD/MM/YYYY (normalized from dd-MMM-yyyy)
  bookingStatus: string; // F/U/P/O/Z/M
  bookingDate: string;
  remark: string; // "-" or legend letter (G = reprocessing/reversal, ...)
  paid: number;
  tds: number;
  deposited: number;
}

export interface F26asDeductor {
  name: string;
  tan: string;
  paid: number;
  tds: number;
  deposited: number;
  sections: string[]; // distinct sections seen in rows
  rows: F26asTxn[];
}

export interface F26asIdentity {
  pan: string | null;
  name: string | null;
  fy: string | null;
  ay: string | null;
  updatedTill: string | null;
}

export interface F26asResult {
  identity: F26asIdentity;
  deductors: F26asDeductor[];
  totalTds: number;
  flags: string[];
}

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function normDate(d: string): string {
  const m = d.match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return d;
  return `${m[1]}/${MONTHS[m[2]] ?? "??"}/${m[3]}`;
}

const TAN_RE = /\b([A-Z]{4}\d{5}[A-Z])\b/;
// " 3   GURRISHMA INTERNATIONAL PRIVATE LIMITED   MUMG20354F   715200.00   71520.00   71520.00"
const DEDUCTOR_RE =
  /^\s*(\d{1,3})\s+(\S.*?\S)\s+([A-Z]{4}\d{5}[A-Z])\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;
// " 1   194A   01-Jan-2026   F   02-Jun-2026   G   -18089.00   -1809.00   -1809.00"
const TXN_RE =
  /^\s*(\d{1,3})\s+(\S+)\s+(\d{2}-[A-Za-z]{3}-\d{4})\s+([A-Z])\s+(\d{2}-[A-Za-z]{3}-\d{4})\s+(\S+)\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s+(-?[\d,]+\.\d{2})\s*$/;

export function parse26as(text: string): F26asResult {
  const lines = text.split("\n");
  const flags: string[] = [];

  const pan = text.match(/Permanent Account Number \(PAN\)\s+([A-Z]{5}\d{4}[A-Z])/)?.[1] ?? null;
  const fy = text.match(/Financial Year\s+(\d{4}-\d{2})/)?.[1] ?? null;
  const ay = text.match(/Assessment Year\s+(\d{4}-\d{2})/)?.[1] ?? null;
  const updatedTill = text.match(/Data updated till\s+(\d{2}-[A-Za-z]{3}-\d{4})/)?.[1] ?? null;
  let name: string | null = null;
  for (const l of lines) {
    const m = l.match(/Name of Assessee\s+(\S.*\S)\s*$/);
    if (m && !/Assessee PAN/.test(l)) {
      name = m[1].trim();
      break;
    }
  }
  const identity: F26asIdentity = {
    pan,
    name,
    fy,
    ay,
    updatedTill: updatedTill ? normDate(updatedTill) : null,
  };

  // ---- slice out PART-I ----
  const partStarts: { part: string; idx: number }[] = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\s*PART[- ]?([IVX]+)\s*-/i);
    if (m) partStarts.push({ part: m[1].toUpperCase(), idx: i });
  });
  const p1 = partStarts.find((p) => p.part === "I");
  const p1End = partStarts.find((p) => p.idx > (p1?.idx ?? 0))?.idx ?? lines.length;

  const deductors: F26asDeductor[] = [];
  if (!p1) {
    flags.push(
      "26AS PARSE FAILED: PART-I header not found. Do not retry with the same file. Take the TDS " +
        "figures manually from the 26AS PDF and log a gap-ledger entry (docs/missing-functionality.md) " +
        "so the parser can be fixed.",
    );
  } else {
    let current: F26asDeductor | null = null;
    for (let i = p1.idx + 1; i < p1End; i++) {
      const line = lines[i];
      const txn = line.match(TXN_RE);
      if (txn) {
        if (!current) {
          flags.push(`26AS: transaction row before any deductor header (line ${i + 1}) - parser confused; verify TDS manually.`);
          continue;
        }
        current.rows.push({
          section: txn[2],
          txnDate: normDate(txn[3]),
          bookingStatus: txn[4],
          bookingDate: normDate(txn[5]),
          remark: txn[6],
          paid: inrAmount(txn[7]) ?? 0,
          tds: inrAmount(txn[8]) ?? 0,
          deposited: inrAmount(txn[9]) ?? 0,
        });
        continue;
      }
      const ded = line.match(DEDUCTOR_RE);
      // guard against header lines that happen to end in numbers: deductor rows
      // never contain header keywords
      if (ded && !/Sr\.\s*No|Name of Deductor|Section/.test(line)) {
        current = {
          name: ded[2].replace(/\s+/g, " ").trim(),
          tan: ded[3],
          paid: inrAmount(ded[4]) ?? 0,
          tds: inrAmount(ded[5]) ?? 0,
          deposited: inrAmount(ded[6]) ?? 0,
          sections: [],
          rows: [],
        };
        deductors.push(current);
        continue;
      }
      // a line with a TAN that matched neither pattern is probably a wrapped
      // deductor name - rare, flag rather than guess
      if (TAN_RE.test(line) && !/Sr\.\s*No|Name of Deductor|TAN of Deductor/.test(line) && line.trim() !== "") {
        flags.push(
          `26AS: unparsed PART-I line ${i + 1} containing a TAN ("${line.trim().slice(0, 80)}..."). ` +
            `A deductor may be missing - verify the TDS total against the PDF before relying on it.`,
        );
      }
    }
  }

  // ---- per-deductor verification + row-level notes ----
  for (const d of deductors) {
    d.sections = [...new Set(d.rows.map((r) => r.section))];
    const rowSum = Math.round(d.rows.reduce((a, r) => a + r.tds, 0) * 100) / 100;
    if (d.rows.length > 0 && Math.abs(rowSum - d.tds) > 0.01) {
      flags.push(
        `26AS: ${d.name} (${d.tan}) rows sum to TDS ${rowSum} but the deductor header says ${d.tds}. ` +
          `Using the header total (it is already net of reversals), but verify against the PDF.`,
      );
    }
    for (const r of d.rows) {
      if (r.bookingStatus !== "F" && r.tds !== 0) {
        flags.push(
          `26AS: ${d.name} has a row with booking status "${r.bookingStatus}" (not Final) for TDS ${r.tds}. ` +
            `That credit may not be claimable yet - resolve with the deductor before filing.`,
        );
      }
    }
  }

  // ---- non-modelled parts with content ----
  for (let k = 0; k < partStarts.length; k++) {
    const { part, idx } = partStarts[k];
    if (part === "I") continue;
    const end = partStarts[k + 1]?.idx ?? lines.length;
    const body = lines.slice(idx, end).join("\n");
    if (!/No Transactions Present/i.test(body)) {
      // Parts II..X each carry this marker when empty; a missing marker means rows exist
      flags.push(
        `26AS PART-${part} appears to contain transactions, which this toolkit does not model. ` +
          `Do NOT improvise: log an OPEN entry in docs/missing-functionality.md (quote the part heading), ` +
          `park this client, and move on (AGENTS.md "Escalate, don't extend").`,
      );
    }
  }

  const totalTds = Math.round(deductors.reduce((a, d) => a + d.tds, 0));
  return { identity, deductors, totalTds, flags };
}

/**
 * Allocate a deductor's payment rows into the statement's advance-tax period
 * columns (L: to 15/6, M: 16/6-15/9, N: 16/9-15/12, O: 16/12-15/3, P: 16/3-31/3).
 * Used for dividend TDS-194 rows, whose transaction dates are payment dates.
 */
export function periodsFromRows(rows: F26asTxn[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const m = r.txnDate.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!m) continue;
    const day = Number(m[1]);
    const mon = Number(m[2]);
    let col: string;
    if (mon === 4 || mon === 5 || (mon === 6 && day <= 15)) col = "L";
    else if (mon === 7 || mon === 8 || (mon === 6 && day > 15) || (mon === 9 && day <= 15)) col = "M";
    else if (mon === 10 || mon === 11 || (mon === 9 && day > 15) || (mon === 12 && day <= 15)) col = "N";
    else if (mon === 1 || mon === 2 || (mon === 12 && day > 15) || (mon === 3 && day <= 15)) col = "O";
    else col = "P"; // 16-31 Mar
    out[col] = (out[col] ?? 0) + r.paid;
  }
  return out;
}
