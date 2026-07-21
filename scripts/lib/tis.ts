// Deterministic parser for the TIS (Taxpayer Information Summary) PDF's layout
// text (pdftotext -layout). Two things come out of it:
//
//   1. The front-page category totals ("Accepted by Taxpayer" column) - these
//      ARE the statement-data `reconciliation` block.
//   2. Best-effort line items from the annexure (per-company dividends,
//      per-bank interest, per-payer business receipts). Line items for a
//      category are kept ONLY if they sum exactly to that category's accepted
//      total; otherwise they are dropped and the category is flagged for
//      manual fill - the parser can be wrong, the targets cannot.
//
// Unexpected input never throws mid-parse: unknown categories and unparseable
// blocks land in `flags` with an explicit instruction (fill manually / log a
// gap-ledger entry), so a small-model operator always has a next step and
// never retry-loops.

import { inrAmount } from "./pdftext";

// Category classification is shared with the AIS-JSON parser (lib/aisjson.ts):
// the AIS "Information Category" name is identical to the TIS category name, so
// both sources MUST classify a category the same way. Exported to guarantee that.

/** TIS/AIS category -> statement-data reconciliation key (modelled income only). */
export const CATEGORY_TARGETS: Record<string, string> = {
  "Dividend": "tisDividend",
  "Interest from savings bank": "tisSavingsInterest",
  "Interest from deposit": "tisDepositInterest",
  "Interest from others": "tisOtherInterest",
  "Sale of securities and units of mutual fund": "tisSecuritiesSale",
  "Business receipts": "tisBusinessReceipts",
  "Salary": "tisSalary",
  "Rent received": "tisRent",
};

// Categories that are informational for the statement (purchases, cash flows,
// balances): listed in the digest, no reconciliation target, no action needed.
export const CATEGORY_INFORMATIONAL = new Set([
  "Purchase of securities and units of mutual funds",
  "Purchase of time deposits",
  "Off market credit transactions",
  "Off market debit transactions",
  "Cash deposits",
  "Cash withdrawals",
  "Balance in account",
  "Credit/Debit card",
  "Receipt of foreign remittance",
  "Foreign travel",
  "GST turnover",
  "GST purchases",
  "Business expenses",
  "Miscellaneous payments",
  "Rent payments",
  "Interest paid",
]);

// Income the toolkit deliberately does not model: hitting one of these is a
// park-the-client situation, not a parse failure.
export const CATEGORY_TOOLKIT_GAPS = new Set([
  "Sale of immovable property",
  "Purchase of immovable property", // informational, but often pairs with a sale
  "Winnings from lottery or crossword puzzle",
  "Winnings from online games",
  "Income from retirement benefit account",
]);

// Handled outside the reconciliation block: the authoritative 244A figure comes
// from the intimation / the prefill's CPC row, never from AIS. Surfaced as a hint.
export const CATEGORY_REFUND_INTEREST = "Interest from income tax refund";

export interface TisIdentity {
  pan: string | null;
  name: string | null;
  dob: string | null; // DD/MM/YYYY
  fy: string | null; // "2025-26"
  ay: string | null; // "2026-27" (derived)
  generatedOn: string | null; // DD/MM/YYYY
}

export interface TisCategory {
  name: string;
  processed: number;
  accepted: number;
  target: string | null; // reconciliation key, if modelled
}

export interface TisLineItem {
  name: string;
  amount: number; // accepted value
}

export interface TisParseResult {
  identity: TisIdentity;
  categories: TisCategory[];
  /** Only builder-known keys, accepted values. */
  reconciliation: Record<string, number>;
  /** Validated line items per reconciliation key (sum === category accepted). */
  lineItems: Record<string, TisLineItem[]>;
  refundInterestHint: number | null;
  flags: string[];
}

const PAN_RE = /\b([A-Z]{5}\d{4}[A-Z])\b/;

function parseIdentity(lines: string[]): TisIdentity {
  const text = lines.join("\n");
  const pan = text.match(PAN_RE)?.[1] ?? null;
  const fy = text.match(/Financial Year\s+(\d{4}-\d{2})/)?.[1] ?? null;
  let ay: string | null = null;
  if (fy) {
    const m = fy.match(/^(\d{4})-(\d{2})$/);
    if (m) ay = `${Number(m[1]) + 1}-${String(Number(m[2]) + 1).padStart(2, "0")}`;
  }
  const generatedOn = text.match(/Generation Date\s*:\s*(\d{2}\/\d{2}\/\d{4})/)?.[1] ?? null;

  // Front page is label-line-then-value-line; find the value under a label by column.
  let name: string | null = null;
  let dob: string | null = null;
  for (let i = 0; i < Math.min(lines.length, 40); i++) {
    const nameCol = lines[i].indexOf("Name of Assessee");
    if (nameCol >= 0 && lines[i + 1]) {
      const v = lines[i + 1].slice(nameCol).trim();
      if (v && !name) name = v;
    }
    if (lines[i].includes("Date of Birth") && lines[i + 1]) {
      const m = lines[i + 1].match(/(\d{2}\/\d{2}\/\d{4})/);
      if (m && !dob) dob = m[1];
    }
  }
  return { pan, name, dob, fy, ay, generatedOn };
}

/** A summary/annexure category row: " 1   Dividend   1,71,326   1,71,326" */
const CATEGORY_ROW_RE = /^\s{0,4}(\d{1,3})\s{2,}(\S(?:.*\S)?)\s{2,}([\d,]+)\s{2,}([\d,]+)\s*$/;
/** An annexure detail row start: " 1   SFT   ..." or " 2   TDS/   ..."
 *  (no \b after the alternation: "/" + space has no word boundary) */
const DETAIL_ROW_RE = /^\s{0,4}(\d{1,3})\s{2,}(SFT|TDS\/)(?:\s|$)/;

function isNoise(line: string): boolean {
  return (
    /^\s*$/.test(line) ||
    /Download ID|Generation Date|Page \d+ of \d+|^\s*PAN\s|Financial Year/.test(line) ||
    /^\s*[A-Z]{5}\d{4}[A-Z]\s/.test(line) || // page-break identity strip
    /-{5,}/.test(line) ||
    /All amount values are in INR/.test(line)
  );
}

function isDetailHeader(line: string): boolean {
  return /SR\.\s*NO\.\s+PART\s+INFORMATION/.test(line);
}

export function parseTis(text: string): TisParseResult {
  const lines = text.split("\n");
  const identity = parseIdentity(lines);
  const flags: string[] = [];

  // ---- front-page summary table: first run of category rows, ends at the
  // "details under each information category" sentence (or the annexure).
  const categories: TisCategory[] = [];
  let summaryEnd = lines.findIndex((l) => /information details under each information category/i.test(l));
  if (summaryEnd < 0) summaryEnd = lines.findIndex((l) => /Annexure to Taxpayer Information Summary/i.test(l));
  if (summaryEnd < 0) summaryEnd = lines.length;
  for (let i = 0; i < summaryEnd; i++) {
    const m = lines[i].match(CATEGORY_ROW_RE);
    if (!m) continue;
    const name = m[2].replace(/\s+/g, " ").trim();
    categories.push({
      name,
      processed: inrAmount(m[3]) ?? 0,
      accepted: inrAmount(m[4]) ?? 0,
      target: CATEGORY_TARGETS[name] ?? null,
    });
  }
  if (categories.length === 0) {
    flags.push(
      "TIS PARSE FAILED: no category rows found on the front page. Do not retry with the same file. " +
        "Fill the reconciliation block manually from the TIS front page, and log a gap-ledger entry " +
        "(docs/missing-functionality.md) quoting the first 30 lines of the layout text so the parser can be fixed.",
    );
  }

  const reconciliation: Record<string, number> = {};
  let refundInterestHint: number | null = null;
  for (const c of categories) {
    if (c.target) {
      reconciliation[c.target] = c.accepted;
    } else if (c.name === CATEGORY_REFUND_INTEREST) {
      refundInterestHint = c.accepted;
    } else if (CATEGORY_TOOLKIT_GAPS.has(c.name)) {
      flags.push(
        `TIS category "${c.name}" (accepted Rs. ${c.accepted.toLocaleString("en-IN")}) is income the ` +
          `toolkit does not model. Do NOT improvise: log an OPEN entry in docs/missing-functionality.md, ` +
          `park this client, and move on (AGENTS.md "Escalate, don't extend").`,
      );
    } else if (!CATEGORY_INFORMATIONAL.has(c.name)) {
      flags.push(
        `TIS category "${c.name}" (accepted Rs. ${c.accepted.toLocaleString("en-IN")}) is not known to ` +
          `this parser. If it is income, treat it as a toolkit gap: log it in docs/missing-functionality.md ` +
          `and park the client. If it is clearly informational (a purchase/cash-flow entry), note it and continue.`,
      );
    }
  }

  // ---- annexure line items, validated per category ----
  const lineItems: Record<string, TisLineItem[]> = {};
  const annexureStart = summaryEnd;
  let current: { target: string; accepted: number; items: TisLineItem[] } | null = null;
  let srcCol = -1; // column where INFORMATION SOURCE starts
  let amtCol = -1; // column where AMOUNT DESCRIPTION starts
  let lastItem: TisLineItem | null = null;

  const finishCategory = () => {
    if (!current) return;
    const sum = current.items.reduce((a, i) => a + i.amount, 0);
    if (current.items.length > 0 && sum === current.accepted) {
      lineItems[current.target] = current.items;
    } else if (current.items.length > 0) {
      flags.push(
        `TIS line items for ${current.target} did not reconcile (parsed sum ${sum} vs accepted ` +
          `${current.accepted}); dropped them. The TARGET is still correct - fill the line items manually ` +
          `from the TIS annexure / AIS.`,
      );
    }
    current = null;
    lastItem = null;
  };

  for (let i = annexureStart; i < lines.length; i++) {
    const line = lines[i];
    if (isDetailHeader(line)) {
      // (re)compute column boundaries; headers repeat per block and per page
      const s = line.indexOf("INFORMATION SOURCE");
      const a = line.indexOf("AMOUNT", s >= 0 ? s + 1 : 0);
      if (s >= 0 && a > s) {
        srcCol = s;
        amtCol = a;
      }
      continue;
    }
    // detail rows also match the category pattern (both are "N  text  amounts"),
    // so the more specific detail check must come first
    if (!DETAIL_ROW_RE.test(line)) {
      const cat = line.match(CATEGORY_ROW_RE);
      if (cat) {
        const name = cat[2].replace(/\s+/g, " ").trim();
        const target = CATEGORY_TARGETS[name];
        finishCategory();
        if (target) current = { target, accepted: inrAmount(cat[4]) ?? 0, items: [] };
        continue;
      }
    }
    if (!current) continue;
    if (isNoise(line)) continue;

    if (DETAIL_ROW_RE.test(line)) {
      // peel up to 3 trailing amount columns (reported / processed / accepted)
      let rest = line.replace(/\s+$/, "");
      const cols: (number | null)[] = [];
      for (let k = 0; k < 3; k++) {
        const m = rest.match(/\s{2,}([\d,]+|-)$/);
        if (!m) break;
        cols.unshift(inrAmount(m[1]));
        rest = rest.slice(0, rest.length - m[0].length);
      }
      const accepted = cols.length ? cols[cols.length - 1] : null;
      const name = srcCol >= 0 ? line.slice(srcCol, amtCol).trim() : "";
      if (accepted != null && accepted !== 0) {
        lastItem = { name, amount: accepted };
        current.items.push(lastItem);
      } else {
        lastItem = null; // TDS/TCS dedup row ("-" columns): counted elsewhere
      }
      continue;
    }
    // continuation line: wrapped source-name cell
    if (lastItem && srcCol >= 0) {
      const frag = line.slice(srcCol, amtCol).trim();
      if (frag) lastItem.name = `${lastItem.name} ${frag}`.trim();
    }
  }
  finishCategory();

  // tidy names: strip the "(PAN.AZnnn)" / "(TAN)" reporting-entity suffix
  for (const items of Object.values(lineItems)) {
    for (const it of items) {
      it.name = it.name.replace(/\s*\([A-Z0-9.]+\)\s*$/, "").replace(/\s+/g, " ").trim();
    }
  }

  return { identity, categories, reconciliation, lineItems, refundInterestHint, flags };
}
