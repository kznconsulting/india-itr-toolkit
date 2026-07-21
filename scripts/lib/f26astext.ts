// Deterministic parser for the Form 26AS TEXT export (the delimited machine
// format TRACES offers, and the only format for very large statements). Same
// output shape as parse26as (the pdftotext parser in f26as.ts) so extract can
// prefer text over PDF the way it prefers AIS JSON over the AIS PDF.
//
// The text export is '^'-delimited (older exports use '|'). Structure:
//   <blank>^Annual Tax Statement^<blank>
//   File Creation Date^PAN^Current Status of PAN^Financial Year^Assessment Year^Name^Address...
//   <values row, same columns>
//   PART-I - Details of Tax Deducted at Source
//     Sr. No.^Name of Deductor^TAN^^^^^Total Amount Paid^Total Tax Deducted^Total TDS Deposited   (deductor header)
//     1^AKSHARCHEM (INDIA) LIMITED^AHMA00336A^^^^^962500.00^96250.00^96250.00                       (deductor row)
//       ^Sr. No.^Section^Transaction Date^Status of Booking^Date of Booking^Remarks^Amount^Tax^Deposited (txn header)
//       ^1^194^23-Sep-2025^F^23-Oct-2025^-^600.00^60.00^60.00                                        (txn row)
//   PART-II ... PART-X: each is either populated or carries a "No Transactions
//   Present" marker; a populated Part II-X is flagged (not modelled), never dropped.
//
// Amounts sit at delimiter indices 7/8/9 in both deductor and txn rows.

import type { F26asDeductor, F26asIdentity, F26asResult, F26asTxn } from "./f26as";

const MONTHS: Record<string, string> = {
  Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06",
  Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12",
};

function normDate(d: string): string {
  const m = d.trim().match(/^(\d{2})-([A-Za-z]{3})-(\d{4})$/);
  return m ? `${m[1]}/${MONTHS[m[2]] ?? "??"}/${m[3]}` : d.trim();
}

const num = (s: string): number => Number(String(s ?? "").replace(/,/g, "").trim()) || 0;
const TAN_RE = /^[A-Z]{4}\d{5}[A-Z]$/;

function detectDelimiter(lines: string[]): string {
  const probe = lines.find((l) => l.includes("Permanent Account Number")) ?? "";
  return probe.includes("^") ? "^" : "|";
}

function parseIdentity(lines: string[], delim: string): F26asIdentity {
  const hdrIdx = lines.findIndex((l) => l.includes("Permanent Account Number"));
  const id: F26asIdentity = { pan: null, name: null, fy: null, ay: null, updatedTill: null };
  if (hdrIdx < 0) return id;
  const labels = lines[hdrIdx].split(delim).map((s) => s.trim());
  // the values row is the next non-empty line
  let valIdx = hdrIdx + 1;
  while (valIdx < lines.length && !lines[valIdx].trim()) valIdx++;
  const vals = (lines[valIdx] ?? "").split(delim).map((s) => s.trim());
  const at = (label: string) => {
    const i = labels.findIndex((l) => l.toLowerCase().includes(label.toLowerCase()));
    return i >= 0 ? vals[i] ?? null : null;
  };
  id.pan = at("Permanent Account Number");
  id.name = at("Name of Assessee");
  id.updatedTill = at("File Creation Date");
  const fyRaw = at("Financial Year"); // "2025-2026"
  const ayRaw = at("Assessment Year"); // "2026-2027"
  id.fy = fyRaw ? fyRaw.replace(/^(\d{4})-\d{2}(\d{2})$/, "$1-$2") : null;
  id.ay = ayRaw ? ayRaw.replace(/^(\d{4})-\d{2}(\d{2})$/, "$1-$2") : null;
  return id;
}

export function parse26asText(text: string): F26asResult {
  const lines = text.split(/\r?\n/);
  const delim = detectDelimiter(lines);
  const flags: string[] = [];
  const identity = parseIdentity(lines, delim);

  const deductors: F26asDeductor[] = [];
  let part = "";
  let current: F26asDeductor | null = null;

  const isDeductorHeader = (f: string[]) => f[0]?.trim() === "Sr. No." && /Name of Deductor/i.test(f[1] ?? "");
  const isTxnHeader = (f: string[]) => f[0]?.trim() === "" && /Sr\.?\s*No\.?/i.test(f[1] ?? "") && /Section/i.test(f[2] ?? "");
  const isDeductorRow = (f: string[]) => /^\d+$/.test(f[0]?.trim() ?? "") && TAN_RE.test((f[2] ?? "").trim());
  const isTxnRow = (f: string[]) =>
    (f[0]?.trim() ?? "") === "" && /^\d+$/.test(f[1]?.trim() ?? "") && (f[2]?.trim() ?? "") !== "" && !/Section/i.test(f[2] ?? "");

  for (const raw of lines) {
    const pm = raw.match(/PART-([IVX]+)\b/);
    if (pm) { part = pm[0]; continue; }
    if (!raw.trim()) continue;
    const f = raw.split(delim);

    if (part === "PART-I" || part === "") {
      if (isDeductorHeader(f) || isTxnHeader(f)) continue;
      if (isDeductorRow(f)) {
        current = {
          name: f[1].trim(),
          tan: f[2].trim(),
          paid: num(f[7]),
          tds: num(f[8]),
          deposited: num(f[9]),
          sections: [],
          rows: [],
        };
        deductors.push(current);
      } else if (isTxnRow(f) && current) {
        const txn: F26asTxn = {
          section: f[2].trim(),
          txnDate: normDate(f[3] ?? ""),
          bookingStatus: (f[4] ?? "").trim(),
          bookingDate: normDate(f[5] ?? ""),
          remark: (f[6] ?? "").trim(),
          paid: num(f[7]),
          tds: num(f[8]),
          deposited: num(f[9]),
        };
        current.rows.push(txn);
        if (!current.sections.includes(txn.section)) current.sections.push(txn.section);
      }
    } else {
      // PART-II..X: a data row (not a header, not the "No Transactions" marker) is unmodelled.
      if (/No Transactions Present/i.test(raw)) continue;
      if (/Sr\.?\s*No\.?|Name of|TAN of|PAN of|Acknowledgement|Assessment Year|Gross Total|Status of Booking|Financial Year|Short Payment/i.test(raw)) continue;
      const looksData = /^\s*(?:\d+)?[|^]\s*\d/.test(raw) || /^\d+[|^]/.test(raw);
      if (looksData) {
        flags.push(
          `26AS ${part} has transaction data this toolkit does not model (${raw.split(delim).slice(0, 3).join(" / ").slice(0, 80)}...). ` +
            `Do NOT ignore it: log a gap-ledger entry, park the client (AGENTS.md "Escalate, don't extend").`,
        );
      }
    }
  }

  // Validate each deductor: rows (netting reversals) must reconcile to the header.
  for (const d of deductors) {
    if (d.rows.length === 0) continue;
    const rowTds = d.rows.reduce((a, r) => a + r.tds, 0);
    if (Math.abs(rowTds - d.tds) > 1) {
      flags.push(
        `26AS deductor "${d.name}" (${d.tan}): transaction TDS sums to ${rowTds.toFixed(2)} but the header says ` +
          `${d.tds.toFixed(2)}. A row was mis-read - do not trust this deductor's total; cross-check the 26AS.`,
      );
    }
  }

  const totalTds = deductors.reduce((a, d) => a + d.tds, 0);
  if (deductors.length === 0) {
    flags.push(
      "26AS TEXT PARSE FAILED: no Part-I deductor rows found. Do not retry unchanged - check the file is the " +
        "TRACES text export (not HTML), or fall back to the 26AS PDF and log a gap-ledger entry.",
    );
  }
  return { identity, deductors, totalTds, flags };
}
