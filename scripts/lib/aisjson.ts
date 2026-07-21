// AIS portal-JSON parser - the PRIMARY source for AIS data. The standard
// harvest is 3 files (prefill JSON + AIS JSON + 26AS); the TIS/AIS PDFs are
// fallback-only, used when the JSON export doesn't exist.
//
// Returns the SAME shape as the TIS parser (identity, reconciliation targets,
// validated line items) so `bun run extract` can use either source
// interchangeably. TIS is a derived aggregation of AIS, so the targets MUST
// reproduce the TIS PDF's numbers - validated exactly against the first real
// client (docs/missing-functionality.md "AIS-JSON parser").
//
// THE FILE IS ENCRYPTED. The portal's "AIS JSON (for AIS Utility)" export is
// AES-256-CBC + PBKDF2-HMAC-SHA256, keyed on the taxpayer's PAN+DOB - the same
// public scheme the AIS Utility uses. Layout (all one line):
//   [32 hex = 16-byte IV][32 hex = 16-byte salt][base64 ciphertext]
//   key  = PBKDF2(pan.toLowerCase() + "GQ39%*g" + ddmmyyyy, salt, 1000, 32, sha256)
//   text = AES-256-CBC/PKCS7(ciphertext, key, iv)
// The "GQ39%*g" middle segment is a constant baked into the utility; it can
// change across utility versions, so decryption is verified by "does the result
// parse as JSON" rather than assumed.

import { createDecipheriv, pbkdf2Sync } from "node:crypto";
import {
  CATEGORY_INFORMATIONAL,
  CATEGORY_REFUND_INTEREST,
  CATEGORY_TARGETS,
  CATEGORY_TOOLKIT_GAPS,
  type TisIdentity,
  type TisLineItem,
} from "./tis";

const PASSWORD_MIDDLE = "GQ39%*g";

export interface AisJsonCapitalGainsItem {
  name: string;
  isin?: string;
  saleDate?: string;
  saleValue: number;
  cost: number;
  costUnconfirmed?: boolean;
  assetClass?: string;
  source: string;
}

export interface AisJsonResult {
  supported: boolean;
  reason?: string;
  // populated when supported (mirrors TisParseResult so extract can swap sources):
  identity?: TisIdentity;
  reconciliation?: Record<string, number>;
  lineItems?: Record<string, TisLineItem[]>;
  refundInterestHint?: number | null;
  capitalGains?: { shortTerm: AisJsonCapitalGainsItem[]; longTerm: AisJsonCapitalGainsItem[] };
  /** NRI tell-tale: s.195/196 TDS or foreign-remittance receipts present. */
  nriSignal?: boolean;
  flags?: string[];
}

// ---------------------------------------------------------------- decryption

/** true for the portal's encrypted export (32+32 hex header, then base64/hex body). */
export function isEncryptedAisExport(raw: string): boolean {
  return /^[0-9a-fA-F]{64}[A-Za-z0-9+/=]/.test(raw.trim().slice(0, 100));
}

/** DDMMYYYY from "YYYY-MM-DD", "DD/MM/YYYY", "DD-MM-YYYY", or an 8-digit string. */
export function normalizeDob(dob: string): string | null {
  const s = dob.trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return m[3] + m[2] + m[1];
  m = s.match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (m) return m[1] + m[2] + m[3];
  if (/^\d{8}$/.test(s)) return s;
  return null;
}

/** Decrypt the portal export to plaintext JSON. Throws on bad password/format. */
export function decryptAisExport(raw: string, pan: string, dobDdmmyyyy: string): string {
  const hex = raw.trim();
  const iv = Buffer.from(hex.slice(0, 32), "hex");
  const salt = Buffer.from(hex.slice(32, 64), "hex");
  const body = hex.slice(64);
  let ct = Buffer.from(body, "base64");
  if (ct.length === 0 || ct.length % 16 !== 0) ct = Buffer.from(body, "hex");
  const key = pbkdf2Sync(`${pan.toLowerCase()}${PASSWORD_MIDDLE}${dobDdmmyyyy}`, salt, 1000, 32, "sha256");
  const d = createDecipheriv("aes-256-cbc", key, iv);
  return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
}

// --------------------------------------------------------------- l2 helpers

interface L2Row {
  category: string;
  infoCode: string;
  categoryCode: string;
  amount: number;
}

const num = (s: unknown): number => Number(String(s ?? "").replace(/,/g, "")) || 0;

function readL2(el: any): L2Row[] {
  const l2 = el?.l2;
  if (!l2?.columnLabel || !Array.isArray(l2.columnData)) return [];
  const L: string[] = l2.columnLabel;
  const ci = L.indexOf("Information Category");
  const co = L.indexOf("Information Code");
  const cc = L.indexOf("Information Category Code");
  const am = L.indexOf("Amount");
  return l2.columnData
    .filter((r: unknown[]) => Array.isArray(r))
    .map((r: unknown[]) => ({
      category: String(r[ci] ?? "").trim(),
      infoCode: String(r[co] ?? "").trim(),
      categoryCode: String(r[cc] ?? "").trim(),
      amount: num(r[am]),
    }));
}

/** All info elements whose l2 category matches, across the B1/B2/B3 sections. */
function elementsByCategory(obj: any, category: string): any[] {
  const out: any[] = [];
  for (const sec of obj?.partB?.sections ?? []) {
    if (!/Part B[123]\b/.test(sec?.title ?? "")) continue;
    for (const el of sec.elements ?? []) {
      if (readL2(el).some((r) => r.category === category)) out.push(el);
    }
  }
  return out;
}

/** field-name -> index for an l1 block (columnLabel entries are {field}|{name}|string). */
function l1Index(el: any): { fields: string[]; at: (name: string) => number; rows: unknown[][] } {
  const l1 = el?.l1;
  const fields: string[] = (l1?.columnLabel ?? []).map((c: any) => (typeof c === "string" ? c : c?.field ?? c?.name ?? ""));
  const rows: unknown[][] = Array.isArray(l1?.columnData) ? l1.columnData.filter((r: unknown) => Array.isArray(r)) : [];
  const at = (name: string) => fields.findIndex((f) => f.toLowerCase() === name.toLowerCase());
  return { fields, at, rows };
}

// AIS securityClass -> the assetClass string the statement builder recognises.
// Mirrors parse-ais-cg.py classify() so JSON and PDF lots are treated identically:
// only "equity" (listed equity) is modelled; anything else forces a conscious call.
function assetClassFromSecurityClass(sc: string): string {
  const s = sc.toLowerCase();
  if (/debenture/.test(s)) return "debenture";
  if (/bond/.test(s)) return "bond";
  if (/unlisted/.test(s)) return "unlisted-equity";
  if (/equity/.test(s)) return "equity";
  if (/mutual|fund|unit/.test(s)) return "mutual-fund (confirm equity-oriented before treating as 111A/112A)";
  return "unknown";
}

interface CgLot {
  saleDate: string;
  name: string;
  isin: string | null;
  assetClass: string;
  term: "Short" | "Long" | null;
  saleValue: number;
  cost: number;
  offMarket: boolean;
}

/** Read every Active Sale-of-securities lot from the SOS element's l1 detail. */
function readCapitalGainsLots(sosEl: any): CgLot[] {
  const { at, rows } = l1Index(sosEl);
  const iDate = at("transferDate");
  const iName = at("securityName");
  const iClass = at("securityClass");
  const iDebit = at("debitType");
  const iCredit = at("creditType");
  const iAsset = at("assetType");
  const iSale = at("salesConsideration");
  const iCost = at("costOfAcquisition");
  const iStatus = at("status");
  const lots: CgLot[] = [];
  for (const r of rows) {
    if (iStatus >= 0 && String(r[iStatus] ?? "").toLowerCase() === "inactive") continue;
    const rawName = String(r[iName] ?? "");
    const isin = rawName.match(/\(([A-Z]{2}[A-Z0-9]{9}\d)\)/)?.[1] ?? null;
    const name = rawName.replace(/\([A-Z]{2}[A-Z0-9]{9}\d\)/, "").replace(/\s+/g, " ").trim();
    const assetType = String(r[iAsset] ?? "").toLowerCase();
    const marketText = `${r[iDebit] ?? ""} ${r[iCredit] ?? ""}`.toLowerCase();
    lots.push({
      saleDate: String(r[iDate] ?? "").trim(),
      name,
      isin,
      assetClass: assetClassFromSecurityClass(String(r[iClass] ?? "")),
      term: assetType.includes("short") ? "Short" : assetType.includes("long") ? "Long" : null,
      saleValue: num(r[iSale]),
      cost: num(r[iCost]),
      offMarket: marketText.includes("off"),
    });
  }
  return lots;
}

function toCgItem(g: {
  name: string;
  isin: string | null;
  assetClass: string;
  saleDate: string;
  saleValue: number;
  cost: number;
  costUnconfirmed: boolean;
  offMarket: boolean;
}): AisJsonCapitalGainsItem {
  const item: AisJsonCapitalGainsItem = {
    name: g.name,
    saleDate: g.saleDate,
    saleValue: g.saleValue,
    cost: g.cost,
    source: "AIS SFT (sale of securities)",
  };
  if (g.isin) item.isin = g.isin;
  if (g.assetClass !== "equity") item.assetClass = g.assetClass; // builder refuses non-equity
  if (g.costUnconfirmed) item.costUnconfirmed = true; // ANY lot in the group had zero cost
  if (g.offMarket) (item as any).offMarket = true;
  return item;
}

const cgDateKey = (d: string): number => {
  const m = d.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? Number(m[3]) * 10000 + Number(m[2]) * 100 + Number(m[1]) : 0;
};

/**
 * Build grouped capital-gains rows from the SOS lots, matching parse-ais-cg.py's
 * default grouping: per (ISIN-or-name, term), sum saleValue/cost, latest saleDate.
 * Returns the {shortTerm, longTerm} shape plus flags for the traps.
 */
function groupCapitalGains(lots: CgLot[]): {
  capitalGains: { shortTerm: AisJsonCapitalGainsItem[]; longTerm: AisJsonCapitalGainsItem[] };
  flags: string[];
} {
  const flags: string[] = [];
  const usable = lots.filter((l) => l.term);
  const noTerm = lots.length - usable.length;
  if (noTerm > 0) flags.push(`${noTerm} securities lot(s) had no Short/Long term in the AIS - dropped; check the AIS detail.`);

  const groups = new Map<string, CgLot[]>();
  for (const l of usable) {
    const key = `${l.isin ?? l.name}||${l.term}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(l);
  }

  const items: { Short: AisJsonCapitalGainsItem[]; Long: AisJsonCapitalGainsItem[] } = { Short: [], Long: [] };
  for (const ls of groups.values()) {
    const term = ls[0].term as "Short" | "Long";
    const classes = new Set(ls.map((l) => l.assetClass));
    items[term].push(
      toCgItem({
        name: ls.reduce((a, b) => (b.name.length > a.name.length ? b : a)).name,
        isin: ls[0].isin,
        assetClass: classes.size === 1 ? [...classes][0] : "mixed",
        saleDate: ls.reduce((a, b) => (cgDateKey(b.saleDate) > cgDateKey(a.saleDate) ? b : a)).saleDate,
        saleValue: ls.reduce((a, b) => a + b.saleValue, 0),
        cost: ls.reduce((a, b) => a + b.cost, 0),
        costUnconfirmed: ls.some((l) => l.cost === 0), // parity with parse-cg: any zero-cost lot flags the group
        offMarket: ls.some((l) => l.offMarket),
      }),
    );
  }
  items.Short.sort((a, b) => cgDateKey(a.saleDate ?? "") - cgDateKey(b.saleDate ?? ""));
  items.Long.sort((a, b) => cgDateKey(a.saleDate ?? "") - cgDateKey(b.saleDate ?? ""));
  const capitalGains = { shortTerm: items.Short, longTerm: items.Long };

  // Loud on the two traps that overstate a loss / understate a gain.
  const zeroCost = lots.filter((l) => l.cost === 0).length;
  if (zeroCost) {
    flags.push(
      `${zeroCost} securities lot(s) have ZERO cost in the AIS (off-market transfer-in without a depository ` +
        `basis): marked costUnconfirmed. Get the real cost from the client/broker - NEVER file a zero cost as-is.`,
    );
  }
  const zeroSale = lots.filter((l) => l.saleValue === 0 && l.cost > 0);
  if (zeroSale.length) {
    flags.push(
      `${zeroSale.length} securities lot(s) have ZERO sale value but a non-zero cost - this creates a phantom ` +
        `loss. Verify against the AIS/broker before filing (a genuine sale, a transfer-out, or a data quirk?).`,
    );
  }
  const nonEquity = new Set(lots.map((l) => l.assetClass).filter((c) => c !== "equity"));
  if (nonEquity.size) {
    flags.push(
      `securities lots include non-listed-equity classes (${[...nonEquity].join("; ")}); the statement builder ` +
        `refuses these until you confirm the 111A/112A treatment.`,
    );
  }
  return { capitalGains, flags };
}

/**
 * The element's payer/source ENTITY name, from the parent l2 "Information Source"
 * (TAN/PAN suffix stripped, like the TIS parser), falling back to infoSrcId (the
 * TAN itself). Dividend/interest l1 rows carry only transaction mechanics - the
 * entity name lives one level up, here. This is also the right 26AS join key.
 */
function elementSourceName(el: any): string {
  const l2 = el?.l2;
  const cd = l2?.columnData;
  const row = Array.isArray(cd) ? (Array.isArray(cd[0]) ? cd[0] : cd) : null;
  if (l2?.columnLabel && row) {
    const i = l2.columnLabel.indexOf("Information Source");
    if (i >= 0) {
      const clean = String(row[i] ?? "")
        .replace(/\s*\([A-Z0-9.]+\)\s*$/, "") // trailing "(TAN)"/"(PAN)"
        .replace(/\s+/g, " ")
        .trim();
      if (clean) return clean;
    }
  }
  return String(el?.infoSrcId ?? "").trim();
}

/** Best-effort Active line items from an element's l1 detail, named by its l2 source. */
function readL1LineItems(el: any): TisLineItem[] {
  const l1 = el?.l1;
  if (!l1?.columnLabel || !Array.isArray(l1.columnData)) return [];
  const fields: string[] = l1.columnLabel.map((c: any) => (typeof c === "string" ? c : c?.field ?? c?.name ?? ""));
  const find = (...names: string[]) => fields.findIndex((f) => names.some((n) => f.toLowerCase() === n.toLowerCase()));
  const amtI = find("amtPaid", "amount", "amtCr", "grossAmount", "amountPaid", "salePrice", "saleConsideration");
  const nameI = find("nameOfSource", "payerName", "deductorName", "name", "sourceName", "accountNo", "isin");
  const statusI = find("status");
  if (amtI < 0) return [];
  // The entity name (bank/company/payer) is the parent element's source, not an
  // l1 field - dividend l1 has no name at all, and it is the exact 26AS join key.
  const srcName = elementSourceName(el);
  const items: TisLineItem[] = [];
  for (const r of l1.columnData as unknown[][]) {
    if (!Array.isArray(r)) continue;
    if (statusI >= 0 && String(r[statusI] ?? "").toLowerCase() === "inactive") continue; // count only Active
    const amount = num(r[amtI]);
    if (amount === 0) continue;
    const l1Name = nameI >= 0 ? String(r[nameI] ?? "").trim() : "";
    items.push({ name: srcName || l1Name, amount });
  }
  return items;
}

// -------------------------------------------------------------- identity

/** columnData is a flat row ["a","b",...] here, occasionally [["a","b",...]]. */
function firstRow(cd: any): any[] | null {
  if (!Array.isArray(cd)) return null;
  return Array.isArray(cd[0]) ? cd[0] : cd;
}

function parseIdentity(j: any): TisIdentity {
  const fyCell = firstRow(j?.header?.columnData)?.[0];
  const fy: string | null = typeof fyCell === "string" ? fyCell : null;
  let ay: string | null = null;
  const m = fy?.match(/^(\d{4})-(\d{2})$/);
  if (m) ay = `${Number(m[1]) + 1}-${String(Number(m[2]) + 1).padStart(2, "0")}`;

  let pan: string | null = j?.metadata?.loggedInPan ?? null;
  let name: string | null = null;
  let dob: string | null = null;
  const pa = j?.partA;
  const row = firstRow(pa?.columnData);
  if (pa?.columnLabel && row) {
    const L: string[] = pa.columnLabel;
    const at = (label: string) => {
      const i = L.indexOf(label);
      return i >= 0 ? String(row[i] ?? "").trim() || null : null;
    };
    pan = at("Permanent Account Number (PAN)") ?? pan;
    name = at("Name of Assessee");
    const rawDob = at("Date of Birth");
    if (rawDob) {
      const dm = rawDob.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      dob = dm ? `${dm[3]}/${dm[2]}/${dm[1]}` : rawDob; // normalise to DD/MM/YYYY like TIS
    }
  }
  const generatedOn: string | null = j?.metadata?.downloadDate ?? null;
  return { pan, name, dob, fy, ay, generatedOn };
}

// ----------------------------------------------------------------- parse

/**
 * Parse the portal AIS JSON. `raw` is the file's text - encrypted export or,
 * defensively, already-plaintext JSON. `opts.pan`/`opts.dob` are needed to
 * decrypt an encrypted export (sourced from the prefill / prior data file).
 */
export function parseAisJson(raw: string | unknown, opts: { pan?: string; dob?: string } = {}): AisJsonResult {
  // Accept an already-parsed object (back-compat) or raw file text.
  let obj: any = null;
  if (typeof raw === "string") {
    if (isEncryptedAisExport(raw)) {
      if (!opts.pan || !opts.dob) {
        return {
          supported: false,
          reason:
            "AIS JSON is the portal's encrypted export but no PAN/DOB was available to decrypt it. " +
            "extract sources these from the prefill / prior-year data file - ensure the prefill JSON is in the folder.",
        };
      }
      const ddmmyyyy = normalizeDob(opts.dob);
      if (!ddmmyyyy) return { supported: false, reason: `could not read DOB "${opts.dob}" as a date to build the decryption password.` };
      try {
        obj = JSON.parse(decryptAisExport(raw, opts.pan, ddmmyyyy));
      } catch {
        return {
          supported: false,
          reason:
            "AIS JSON decryption failed (wrong PAN/DOB, or the utility's password scheme changed). " +
            "Verify the client's DOB, or grab the TIS PDF this season and log a gap-ledger note. Do not hand-read the file.",
        };
      }
    } else {
      try {
        obj = JSON.parse(raw);
      } catch {
        return { supported: false, reason: "file is neither the encrypted export nor valid JSON." };
      }
    }
  } else if (raw && typeof raw === "object") {
    obj = raw;
  } else {
    return { supported: false, reason: "file did not parse as a JSON object" };
  }

  if (!obj?.partB?.sections) {
    return { supported: false, reason: "decrypted, but not the expected AIS shape (no partB.sections) - AIS JSON version may have changed." };
  }

  const flags: string[] = [];
  const identity = parseIdentity(obj);

  // Flatten every l2 aggregate row from the information-bearing sections
  // (B1/B2/B3), remembering its parent element for line-item detail. One AIS
  // element usually carries ONE l2 row (one payer/scrip), so a category spans
  // many elements - aggregation MUST be across elements, not per element.
  interface Row { category: string; infoCode: string; amount: number; el: any }
  const rows: Row[] = [];
  for (const sec of obj.partB.sections) {
    if (!/Part B[123]\b/.test(sec?.title ?? "")) continue; // B4 refund / B7 misc handled separately
    for (const el of sec.elements ?? []) {
      for (const r of readL2(el)) rows.push({ category: r.category, infoCode: r.infoCode, amount: r.amount, el });
    }
  }

  // NRI tell-tale: s.195/196 TDS or foreign-remittance receipts.
  const nriSignal = rows.some((r) => r.category === "Receipt of foreign remittance" || /^TDS-19[56]/.test(r.infoCode));
  if (nriSignal) {
    flags.push(
      "NRI TELL-TALE: s.195/196 TDS or 'Receipt of foreign remittance' present in the AIS. Confirm residential " +
        "status with the client; if NRI, set client.residentialStatus = \"NRI\" and re-run (AGENTS.md operator gotchas).",
    );
  }

  const reconciliation: Record<string, number> = {};
  const lineItems: Record<string, TisLineItem[]> = {};
  let refundInterestHint: number | null = null;

  // Per category: SUM within an info-code, then take the MAX across info-codes.
  // TIS dedups SFT-vs-TDS double-listings by keeping the superset; validated to
  // reproduce the TIS PDF exactly on the first real client.
  const categories = [...new Set(rows.map((r) => r.category))];
  for (const category of categories) {
    const catRows = rows.filter((r) => r.category === category);
    const codeSums = new Map<string, number>();
    for (const r of catRows) codeSums.set(r.infoCode, (codeSums.get(r.infoCode) ?? 0) + r.amount);
    let winningCode = "";
    let target = -Infinity;
    for (const [code, sum] of codeSums) if (sum > target) { target = sum; winningCode = code; }
    if (!(target > -Infinity)) continue;

    if (codeSums.size > 1) {
      const parts = [...codeSums].map(([c, s]) => `${c}=${s.toLocaleString("en-IN")}`).join(", ");
      flags.push(
        `AIS category "${category}" is reported under ${codeSums.size} codes (${parts}); used the largest ` +
          `(${winningCode}) as the de-duplicated total, per TIS "Processed by System". Cross-check the 26AS if this looks off.`,
      );
    }

    const key = CATEGORY_TARGETS[category];
    if (key) {
      reconciliation[key] = target;
      // Line items: Active l1 detail from every element of the winning code.
      const items: TisLineItem[] = [];
      for (const r of catRows) if (r.infoCode === winningCode) items.push(...readL1LineItems(r.el));
      const sum = items.reduce((a, i) => a + i.amount, 0);
      if (items.length > 0 && sum === target) {
        for (const it of items) it.name = it.name.replace(/\s+/g, " ").trim();
        lineItems[key] = items;
      } else if (items.length > 0) {
        flags.push(
          `AIS line items for ${key} did not reconcile (parsed sum ${sum} vs total ${target}); dropped them. ` +
            `The TARGET is correct - fill line items manually from the AIS detail if the statement needs them.`,
        );
      }
    } else if (category === CATEGORY_REFUND_INTEREST) {
      refundInterestHint = target;
    } else if (CATEGORY_TOOLKIT_GAPS.has(category)) {
      flags.push(
        `AIS category "${category}" (Rs. ${target.toLocaleString("en-IN")}) is income the toolkit does not model. ` +
          `Do NOT improvise: log an OPEN entry in docs/missing-functionality.md, park this client, and move on.`,
      );
    } else if (!CATEGORY_INFORMATIONAL.has(category)) {
      flags.push(
        `AIS category "${category}" (Rs. ${target.toLocaleString("en-IN")}) is not known to this parser. ` +
          `If it is income, treat it as a toolkit gap (log it, park the client). If informational, note and continue.`,
      );
    }
  }

  // Capital gains: build per-lot rows straight from the Sale-of-securities l1
  // detail (the JSON carries cost/ISIN/term/off-market cleanly - none of the
  // pdftotext layout damage that breaks parse-cg on hundreds of lots).
  let capitalGains: AisJsonResult["capitalGains"];
  if (reconciliation.tisSecuritiesSale) {
    const sosEls = elementsByCategory(obj, "Sale of securities and units of mutual fund");
    const lots = sosEls.flatMap(readCapitalGainsLots);
    if (lots.length === 0) {
      flags.push(
        "AIS shows a securities-sale total but no per-lot detail could be read - fetch the AIS PDF and run parse-cg.",
      );
    } else {
      const grouped = groupCapitalGains(lots);
      capitalGains = grouped.capitalGains;
      flags.push(...grouped.flags);
      // The lots MUST sum to the reconciliation target (allow <Rs.1 rounding).
      const lotSaleTotal = lots.reduce((a, l) => a + l.saleValue, 0);
      if (Math.abs(lotSaleTotal - reconciliation.tisSecuritiesSale) > 0.5) {
        flags.push(
          `CAPITAL-GAINS MISMATCH: the ${lots.length} AIS lots sum to ${Math.round(lotSaleTotal).toLocaleString("en-IN")} ` +
            `but the securities-sale total is ${reconciliation.tisSecuritiesSale.toLocaleString("en-IN")}. Do NOT file; ` +
            `a lot was mis-read - fetch the AIS PDF and cross-check with parse-cg.`,
        );
        capitalGains = undefined; // don't hand extract half-right lots
      } else {
        flags.push(
          `Capital gains: ${lots.length} lots read from the AIS JSON (${capitalGains.shortTerm.length} ST + ` +
            `${capitalGains.longTerm.length} LT groups), sale total reconciled to ${reconciliation.tisSecuritiesSale.toLocaleString("en-IN")}.`,
        );
      }
    }
  }

  return { supported: true, identity, reconciliation, lineItems, refundInterestHint, nriSignal, capitalGains, flags };
}
