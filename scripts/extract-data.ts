#!/usr/bin/env bun
// Deterministic gather-to-draft extraction: turns a client folder's TIS + 26AS
// (+ prefill JSON, + prior-year data file) into a draft AY statement-data.json
// plus a short gap digest. The operator model reads the DIGEST, resolves the
// listed gaps, and runs `bun run statement` - it never reads the PDFs.
//
//   bun run extract clients/<slug> [--ay 2026-27] [--force]
//
// What it fills deterministically:
//   - reconciliation targets (TIS front page, accepted column)
//   - dividend items w/ gross (TIS), TDS + TAN + payment periods (26AS s.194)
//   - savings/deposit/business rows (TIS) merged with 26AS TDS and the prior
//     year's account details and comparatives
//   - refund interest from the prefill's CPC row (authoritative source order:
//     intimation > prefill CPC > computed - see docs/extract-from-pdfs.md)
// Everything it cannot fill becomes a `_gaps` entry INSIDE the draft; the
// statement builder refuses to build while _gaps is non-empty, so a gap can
// be resolved or consciously deleted but never silently filed.
//
// Failure philosophy (the anti-token-burn rule): every unexpected condition
// produces ONE clear instruction - fix a named thing, or park the client and
// log a gap-ledger entry. Nothing in here is ever worth retrying unchanged.

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pdfToText } from "./lib/pdftext";
import { parseTis, type TisLineItem, type TisParseResult } from "./lib/tis";
import { parse26as, periodsFromRows, type F26asDeductor, type F26asResult } from "./lib/f26as";
import { parse26asText } from "./lib/f26astext";
import { parseAisJson, type AisJsonResult } from "./lib/aisjson";
import { parseIntimation, type IntimationResult } from "./lib/intimation";

// ---------- small helpers ----------

const GENERIC_TOKENS = new Set([
  "LTD", "LIMITED", "PVT", "PRIVATE", "INDIA", "CORP", "CORPORATION", "COMPANY", "CO", "THE",
]);

function nameTokens(name: string): Set<string> {
  const cleaned = name
    .toUpperCase()
    .replace(/\(.*?\)/g, " ")
    // MF dividends arrive under the registrar's name: "Computer Age Management
    // Services Limited - HDFC Asset Management Company Limited(H)" - match on
    // the fund, not the registrar
    .replace(/^COMPUTER AGE MANAGEMENT SERVICES[^-]*-\s*/, "")
    .replace(/^KFIN TECH[^-]*-\s*/, "")
    .replace(/ASSET MANAGEMENT COMPANY/g, "AMC")
    .replace(/MUTUAL FUND/g, "MF")
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((t) => t && !GENERIC_TOKENS.has(t));
  return new Set(cleaned);
}

function squash(name: string): string {
  return [...nameTokens(name)].join("");
}

/** Fuzzy company/bank-name match: token-subset either way, squashed equality,
 *  or acronym match ("PUNJAB NATIONAL BANK" ~ "PNB"). */
function namesMatch(a: string, b: string): boolean {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  const subset = (x: Set<string>, y: Set<string>) => [...x].every((t) => y.has(t));
  if (subset(ta, tb) || subset(tb, ta)) return true;
  if (squash(a) === squash(b)) return true;
  const acro = (ts: Set<string>) => [...ts].map((t) => t[0]).join("");
  if (ta.size > 1 && tb.has(acro(ta))) return true;
  if (tb.size > 1 && ta.has(acro(tb))) return true;
  return false;
}

const inr = (n: number) => "Rs. " + Math.round(n).toLocaleString("en-IN");

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

interface Gap {
  field: string;
  action: string;
}

// ---------- locate inputs ----------

function parseArgs(argv: string[]): { dir?: string; ay?: string; force: boolean } {
  let dir: string | undefined;
  let ay: string | undefined;
  let force = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--ay") ay = argv[++i];
    else if (argv[i] === "--force") force = true;
    else dir ??= argv[i];
  }
  return { dir, ay, force };
}

const { dir, ay: ayArg, force } = parseArgs(process.argv.slice(2));
if (!dir) die("usage: bun run extract clients/<slug> [--ay 2026-27] [--force]");
if (!existsSync(dir)) die(`${dir} does not exist`);

const files = readdirSync(dir);
const find = (re: RegExp, ext: string) =>
  files.filter((f) => re.test(f) && f.toLowerCase().endsWith(ext)).sort().pop();

const tisPdf = find(/\bTIS\b/i, ".pdf");
const f26asText = find(/\b26AS\b/i, ".txt");
const f26asPdf = find(/\b26AS\b/i, ".pdf");
const aisPdf = find(/\bAIS\b/i, ".pdf");
const aisJson = find(/\bAIS\b/i, ".json");
const prefillJson = find(/prefill/i, ".json");
const intimationPdf = find(/intimation/i, ".pdf");

// ---------- prior-year data file (for identity, carry-forwards, comparatives) ----------

interface AnyObj {
  [k: string]: any;
}

let prior: AnyObj | null = null;
let priorFile: string | null = null;
// try every AY-statement-data file, pick the newest AY below the target year
const dataFiles = files.filter((f) => /^AY\d{4}-\d{2}-statement-data\.json$/.test(f)).sort();

function loadJson(path: string): AnyObj | null {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

// ---------- targets source: AIS JSON (primary), TIS PDF (fallback) ----------

const panDobHint = (() => {
  for (const f of [...dataFiles].reverse()) {
    const d = loadJson(join(dir, f));
    if (d?.client?.pan) return { pan: d.client.pan as string, dob: d.client.dob as string | undefined };
  }
  // Fall back to the prefill (always present in a standard harvest, and the
  // source of the AIS-JSON decryption password for a brand-new client).
  if (prefillJson) {
    const p = loadJson(join(dir, prefillJson));
    const pi = p?.personalInfo ?? {};
    const pan = pi.pan ?? pi.assesseVerPan ?? p?.pan;
    const dob = pi.dob ?? pi?.orgFirmInfo?.DateOFFormOrIncorp;
    if (pan) return { pan: pan as string, dob: dob as string | undefined };
  }
  return { pan: undefined, dob: undefined };
})();

let aisJsonNote: string | null = null;
let cgFromAisJson: AisJsonResult["capitalGains"] | undefined;
let targetsSourceLabel = "";
let tisOrNull: TisParseResult | null = null;

if (aisJson) {
  // The export is encrypted (AES/PBKDF2 keyed on PAN+DOB); the parser decrypts
  // it, so it needs the raw file text plus the PAN/DOB hint, not a parsed object.
  const parsed = parseAisJson(readFileSync(join(dir, aisJson), "utf8"), panDobHint);
  if (parsed.supported && parsed.identity && parsed.reconciliation) {
    tisOrNull = {
      identity: parsed.identity,
      categories: [],
      reconciliation: parsed.reconciliation,
      lineItems: parsed.lineItems ?? {},
      refundInterestHint: parsed.refundInterestHint ?? null,
      flags: parsed.flags ?? [],
    };
    cgFromAisJson = parsed.capitalGains;
    targetsSourceLabel = `AIS JSON (primary)`;
  } else {
    aisJsonNote = `${aisJson}: ${parsed.reason}`;
  }
} else {
  aisJsonNote =
    "no AIS JSON in the folder - it is the PRIMARY AIS source (one extra click in the portal's " +
    "download dialog); fetch it next time (/fetch-portal-docs). TIS/AIS PDFs are fallback-only.";
}
if (!tisOrNull) {
  if (!tisPdf) {
    if (aisJson) {
      die(
        `${dir} has an AIS JSON but its parser is not implemented yet ` +
          `(docs/missing-functionality.md "AIS-JSON parser" is OPEN). Transitional fallback: fetch the ` +
          `TIS PDF for this client in the same portal session and re-run - or implement the parser ` +
          `(maintainer machine). Do not hand-read any document.`,
      );
    }
    die(
      `no AIS JSON and no TIS PDF in ${dir} - nothing to derive the reconciliation targets from. ` +
        `Fetch the client's documents first (/fetch-portal-docs): prefill JSON + AIS JSON + 26AS ` +
        `(PDFs only as fallback when the JSON export is unavailable).`,
    );
  }
  tisOrNull = parseTis(pdfToText(join(dir, tisPdf), panDobHint).text);
  targetsSourceLabel = `TIS PDF (fallback - ${aisJson ? "AIS JSON parser pending" : "no AIS JSON"})`;
}
const tis: TisParseResult = tisOrNull;
if (!tis.identity.pan || Object.keys(tis.reconciliation).length === 0) {
  die(
    `${targetsSourceLabel} produced no usable targets. Do NOT retry unchanged. ` +
      `Log a gap-ledger entry (docs/missing-functionality.md) quoting the source's first page, ` +
      `fill the statement-data.json manually per docs/extract-from-pdfs.md, and continue.`,
  );
}
const ay = ayArg ?? tis.identity.ay;
if (!ay) die("could not derive the assessment year from the TIS; pass --ay 2026-27");
if (ayArg && tis.identity.ay && ayArg !== tis.identity.ay) {
  die(
    `AY mismatch: you asked for ${ayArg} but ${tisPdf} is for AY ${tis.identity.ay}. ` +
      `The folder holds a stale or wrong-year TIS - fetch the right year's documents first.`,
  );
}

const priorAy = (() => {
  const m = ay.match(/^(\d{4})-(\d{2})$/);
  return m ? `${Number(m[1]) - 1}-${String(Number(m[2]) - 1).padStart(2, "0")}` : null;
})();
if (priorAy) {
  const pf = `AY${priorAy}-statement-data.json`;
  if (files.includes(pf)) {
    prior = loadJson(join(dir, pf));
    priorFile = pf;
  }
}

// carry-forward sidecar: written by the prior year's verified statement build;
// carries what the data file doesn't (computed GTI, the loss set-off applied)
const carryforward: AnyObj | null = priorAy ? loadJson(join(dir, `AY${priorAy}-carryforward.json`)) : null;

// ---------- parse 26AS ----------

// 26AS: prefer the TRACES TEXT export (delimited, reliable - no pdftotext
// layout damage) over the PDF, the same way AIS JSON is preferred over the PDF.
let f26: F26asResult | null = null;
let f26asSource: string | null = null;
if (f26asText) {
  f26 = parse26asText(readFileSync(join(dir, f26asText), "utf8"));
  f26asSource = `${f26asText} (text export)`;
} else if (f26asPdf) {
  f26 = parse26as(pdfToText(join(dir, f26asPdf), panDobHint).text);
  f26asSource = `${f26asPdf} (PDF - text export is the reliable format; fetch it next time)`;
}

// ---------- identity gate ----------

const pans = new Set<string>();
if (tis.identity.pan) pans.add(tis.identity.pan);
if (f26?.identity.pan) pans.add(f26.identity.pan);
if (prior?.client?.pan) pans.add(prior.client.pan);
if (pans.size > 1) {
  die(
    `IDENTITY GATE FAILED: documents in ${dir} carry different PANs (${[...pans].join(", ")}). ` +
      `A wrong client's file is in this folder - STOP and sort the files before anything else. ` +
      `Never mix two clients' documents in one folder.`,
  );
}
const pan = [...pans][0];
if (f26?.identity.ay && f26.identity.ay !== ay) {
  die(
    `AY mismatch: targets say ${ay} but ${f26asSource} is for AY ${f26.identity.ay}. ` +
      `Fetch the matching year's 26AS before extracting.`,
  );
}

// ---------- output path guard ----------

const outName = `AY${ay}-statement-data.json`;
const outPath = join(dir, outName);
if (existsSync(outPath) && !force) {
  die(
    `${outPath} already exists. Re-running extract would clobber any manual edits in it. ` +
      `If you really want a fresh extraction, re-run with --force; otherwise edit the existing file.`,
  );
}

// ---------- classify 26AS deductors ----------

const gaps: Gap[] = [];
const digestFlags: string[] = [...tis.flags, ...(f26?.flags ?? [])];

const DIV_SECTIONS = new Set(["194", "194K"]);
const DEPOSIT_SECTIONS = new Set(["194A"]);
const BUSINESS_SECTIONS = new Set(["194J", "194JA", "194JB", "194J(A)", "194J(B)"]);
const SALARY_SECTIONS = new Set(["192"]);
const RENT_SECTIONS = new Set(["194I(B)", "194IB", "194I"]);
const OTHER_INT_SECTIONS = new Set(["193"]);
const NRI_SECTIONS = new Set(["195", "196A", "196B", "196C", "196D"]);

type Bucket = "dividend" | "deposit" | "business" | "salary" | "rent" | "otherInterest" | "nri" | "unknown";

function bucketOf(d: F26asDeductor): Bucket {
  const secs = d.sections.map((s) => s.toUpperCase());
  const hit = (set: Set<string>) => secs.some((s) => set.has(s));
  if (hit(DIV_SECTIONS)) return "dividend";
  if (hit(DEPOSIT_SECTIONS)) return "deposit";
  if (hit(BUSINESS_SECTIONS)) return "business";
  if (hit(SALARY_SECTIONS)) return "salary";
  if (hit(RENT_SECTIONS)) return "rent";
  if (hit(OTHER_INT_SECTIONS)) return "otherInterest";
  if (hit(NRI_SECTIONS)) return "nri";
  return "unknown";
}

const byBucket: Record<Bucket, F26asDeductor[]> = {
  dividend: [], deposit: [], business: [], salary: [], rent: [], otherInterest: [], nri: [], unknown: [],
};
for (const d of f26?.deductors ?? []) byBucket[bucketOf(d)].push(d);

for (const d of byBucket.unknown) {
  digestFlags.push(
    `26AS deductor ${d.name} (${d.tan}) deducts under section(s) ${d.sections.join(",")} which this ` +
      `toolkit does not classify. If this is income the toolkit does not model, log a gap-ledger entry ` +
      `and park the client; otherwise place its ${inr(d.tds)} TDS manually in the data file.`,
  );
}
if (byBucket.nri.length > 0) {
  digestFlags.push(
    `26AS shows section-195/196 (non-resident rate) TDS: this looks like an NRI client. Confirm with ` +
      `the client and set client.residentialStatus: "NRI" (see docs/extract-from-pdfs.md, "NRI clients").`,
  );
}

// ---------- prefill: refund interest (CPC row) ----------

let refundInterestFromPrefill: number | null = null;
if (prefillJson) {
  const p = loadJson(join(dir, prefillJson));
  const rowSets = [
    p?.incDeductionsOthIncCPC,
    p?.form26as?.incomeDeductionsOthersInc,
    p?.insights?.incomeDeductionsOthersInc,
  ].filter(Array.isArray);
  for (const rows of rowSets) {
    for (const r of rows) {
      if (String(r?.othSrcNatureDesc ?? "").toUpperCase() === "TAX" && r?.othSrcOthAmount != null) {
        refundInterestFromPrefill = Number(r.othSrcOthAmount);
        break;
      }
    }
    if (refundInterestFromPrefill != null) break;
  }
}

// ---------- intimation: the authoritative 244A source when present ----------

let intimation: IntimationResult | null = null;
if (intimationPdf) {
  try {
    intimation = parseIntimation(pdfToText(join(dir, intimationPdf), panDobHint).text);
  } catch (e) {
    digestFlags.push(`could not open ${intimationPdf} (${e}) - continuing without it; refund interest falls back to the prefill CPC row.`);
  }
  if (intimation) {
    if (intimation.pan && pan && intimation.pan !== pan) {
      die(
        `IDENTITY GATE FAILED: ${intimationPdf} is for PAN ${intimation.pan} but this folder's documents ` +
          `are for ${pan}. A wrong client's intimation is in this folder - STOP and sort the files.`,
      );
    }
    if (intimation.ay && priorAy && intimation.ay !== priorAy) {
      digestFlags.push(
        `${intimationPdf} is for AY ${intimation.ay}, not the prior year (${priorAy}) - its 244A figure was ` +
          `NOT used for this year's refund interest.`,
      );
      intimation = null;
    } else {
      digestFlags.push(...intimation.flags);
    }
  }
}

// ---------- build the draft ----------

const rec: AnyObj = { ...tis.reconciliation };
if (f26) rec.totalTds = f26.totalTds;

const draft: AnyObj = {
  _source:
    `bun run extract: targets from ${targetsSourceLabel}` +
    (tis.identity.generatedOn ? ` (${tis.identity.generatedOn})` : "") +
    (f26 ? `, 26AS (till ${f26.identity.updatedTill ?? "?"})` : ", no 26AS") +
    (prefillJson ? `, prefill ${prefillJson}` : "") +
    (priorFile ? `; priors from ${priorFile}` : "; no prior-year data file"),
  _gaps: gaps,
  assessmentYear: ay,
  priorYearLabel: priorAy ?? undefined,
};

// client block
if (prior?.client) {
  draft.client = structuredClone(prior.client);
} else {
  const displayName = (tis.identity.name ?? "Client")
    .toLowerCase()
    .replace(/\b\w/g, (c) => c.toUpperCase());
  draft.client = {
    name: tis.identity.name,
    displayName,
    pan: pan ?? null,
    dob: tis.identity.dob,
    residentialStatus: "Resident",
  };
  gaps.push({
    field: "client",
    action:
      "no prior-year data file: fill address, status, ward, itrForm, regime, banks from the prefill " +
      "JSON / last year's filed return (never from memory).",
  });
}

// salary
if (rec.tisSalary) {
  draft.salary = { gross: rec.tisSalary };
  gaps.push({
    field: "salary",
    action: `TIS shows salary ${inr(rec.tisSalary)}: fill employer detail + TDS from Form 16 / 26AS s.192, and prior-year comparatives.`,
  });
  if (byBucket.salary.length === 0) {
    digestFlags.push("TIS shows salary but 26AS has no s.192 deductor - reconcile before filing.");
  }
} else {
  draft.salary = prior?.salary?.note ? { note: prior.salary.note, priorNote: prior.salary.note } : { note: "NIL" };
}

// house property
if (rec.tisRent) {
  const rentTds = byBucket.rent.reduce((a, d) => a + d.tds, 0);
  if (rentTds) rec.tisRentTds = Math.round(rentTds);
  draft.houseProperty = {};
  gaps.push({
    field: "houseProperty",
    action:
      `TIS shows rent ${inr(rec.tisRent)}: fill properties[] (ALV = 100% gross rent, tenant name/TAN, ` +
      `co-ownership share, local taxes) - see docs/extract-from-pdfs.md.`,
  });
} else if (prior?.houseProperty) {
  draft.houseProperty = structuredClone(prior.houseProperty);
  if (typeof draft.houseProperty.prior === "number") {
    // prior year's current figure becomes this year's comparative; NIL stays NIL
  }
}

// business
if (rec.tisBusinessReceipts || byBucket.business.length > 0) {
  const items: AnyObj[] = [];
  const priorItems: AnyObj[] = prior?.business?.items ?? [];
  for (const d of byBucket.business) {
    const pi = priorItems.find((p) => p.tan === d.tan || namesMatch(p.payer ?? "", d.name));
    const item: AnyObj = {
      payer: pi?.payer ?? d.name,
      tan: d.tan,
      gross: Math.round(d.paid),
      tds: Math.round(d.tds),
      in26AS: true,
      inAIS: true,
    };
    if (pi) {
      if (pi.presumptiveRate != null) item.presumptiveRate = pi.presumptiveRate;
      if (pi.meta) item.meta = structuredClone(pi.meta);
      item.prior = {
        gross: pi.gross,
        tds: pi.tds,
        ...(pi.presumptiveRate != null ? { presumptive: Math.round(pi.gross * pi.presumptiveRate) } : {}),
      };
    } else {
      gaps.push({
        field: "business.items",
        action:
          `new payer ${d.name} (${d.tan}): set presumptiveRate and the 44ADA meta block ` +
          `(commencement date, nature-of-business code, trade name) - copy the shape from samples/sample-statement-data.json.`,
      });
    }
    items.push(item);
  }
  draft.business = { items };
  const grossSum = items.reduce((a, i) => a + (i.gross ?? 0), 0);
  if (rec.tisBusinessReceipts && grossSum !== rec.tisBusinessReceipts) {
    gaps.push({
      field: "business",
      action:
        `26AS business gross ${inr(grossSum)} != TIS business receipts ${inr(rec.tisBusinessReceipts)}: ` +
        `find the missing receipts (cash/unTDSed billing?) before building.`,
    });
  }
} else if (prior?.business) {
  digestFlags.push(
    "prior year had business income but this year's TIS/26AS show none - confirm the business really ended.",
  );
}

// interest: savings
const savingsItems: AnyObj[] = [];
if (tis.lineItems.tisSavingsInterest) {
  const priorSavings: AnyObj[] = prior?.interest?.savings ?? [];
  for (const it of tis.lineItems.tisSavingsInterest) {
    const pi = priorSavings.find((p) => namesMatch(p.bank ?? "", it.name));
    savingsItems.push({
      bank: pi?.bank ?? it.name,
      ...(pi?.account ? { account: pi.account } : {}),
      ...(pi?.ifsc ? { ifsc: pi.ifsc } : {}),
      amount: it.amount,
      ...(pi?.amount != null ? { prior: pi.amount } : {}),
    });
    if (!pi && priorSavings.length > 0) {
      gaps.push({
        field: "interest.savings",
        action: `new savings bank "${it.name}": fill the account number (from the client / bank certificate).`,
      });
    }
  }
} else if (rec.tisSavingsInterest) {
  gaps.push({
    field: "interest.savings",
    action: `TIS savings-interest line items did not parse: split ${inr(rec.tisSavingsInterest)} per bank manually from the TIS annexure.`,
  });
}

// interest: deposits
const depositItems: AnyObj[] = [];
const depositTds = byBucket.deposit.reduce((a, d) => a + d.tds, 0);
if (tis.lineItems.tisDepositInterest) {
  const priorDeposits: AnyObj[] = prior?.interest?.deposits ?? [];
  for (const it of tis.lineItems.tisDepositInterest) {
    const matches = priorDeposits.filter((p) => namesMatch(p.bank ?? "", it.name));
    const ded = byBucket.deposit.find((d) => namesMatch(d.name, it.name));
    if (matches.length === 1) {
      depositItems.push({
        bank: matches[0].bank,
        ...(matches[0].account ? { account: matches[0].account } : {}),
        ...(ded ? { tan: ded.tan } : {}),
        amount: it.amount,
      });
    } else {
      depositItems.push({ bank: it.name, ...(ded ? { tan: ded.tan } : {}), amount: it.amount });
      if (matches.length > 1) {
        gaps.push({
          field: "interest.deposits",
          action:
            `"${it.name}" ${inr(it.amount)} is a bank-level aggregate; the prior year split it across ` +
            `${matches.length} accounts (${matches.map((m) => m.account).join(", ")}). Split per account ` +
            `from the bank certificate if the operator wants that detail (totals already reconcile).`,
        });
      } else if (priorDeposits.length > 0) {
        digestFlags.push(
          `deposit row "${it.name}" matched no prior-year deposit account (prior banks: ` +
            `${priorDeposits.map((p) => p.bank).join(", ")}) - carry account detail/splits manually if wanted.`,
        );
      }
    }
  }
} else if (rec.tisDepositInterest) {
  gaps.push({
    field: "interest.deposits",
    action: `TIS deposit-interest line items did not parse: split ${inr(rec.tisDepositInterest)} per bank manually from the TIS annexure.`,
  });
}

// interest: others (s.193)
const otherTds = byBucket.otherInterest.reduce((a, d) => a + d.tds, 0);
if (rec.tisOtherInterest) {
  gaps.push({
    field: "interest.other",
    action:
      `TIS "Interest from others" ${inr(rec.tisOtherInterest)} (s.193 securities/NCD interest): fill the ` +
      `per-issuer rows from the TIS annexure/AIS. 26AS s.193 TDS parsed: ${inr(otherTds)}.`,
  });
}

draft.interest = {
  ...(savingsItems.length ? { savings: savingsItems } : {}),
  ...(prior?.interest?.savings
    ? { savingsPriorTotal: prior.interest.savings.reduce((a: number, p: AnyObj) => a + (p.amount ?? 0), 0) }
    : {}),
  ...(depositItems.length ? { deposits: depositItems } : {}),
  ...(depositTds ? { depositsTds: Math.round(depositTds) } : {}),
  ...(prior?.interest?.deposits
    ? {
        depositsPrior: {
          gross: prior.interest.deposits.reduce((a: number, p: AnyObj) => a + (p.amount ?? 0), 0),
          tds: prior.interest.depositsTds ?? 0,
        },
      }
    : {}),
  ...(otherTds ? { otherTds: Math.round(otherTds) } : {}),
};

// refund interest: intimation (authoritative) > prefill CPC row > gap
if (intimation?.interest244A != null) {
  draft.interest.refundInterest = {
    amount: intimation.interest244A,
    ...(intimation.refundPrincipal != null ? { refundPrincipalPerIntimation: intimation.refundPrincipal } : {}),
    ...(prior?.interest?.refundInterest?.amount != null ? { prior: prior.interest.refundInterest.amount } : {}),
    note:
      `per 143(1) intimation ${intimationPdf} (AY ${intimation.ay}): principal ` +
      `${intimation.refundPrincipal?.toLocaleString("en-IN") ?? "?"} + 244A interest ` +
      `${intimation.interest244A.toLocaleString("en-IN")}`,
  };
  if (refundInterestFromPrefill != null && refundInterestFromPrefill !== intimation.interest244A) {
    digestFlags.push(
      `refund-interest MISMATCH: intimation says ${inr(intimation.interest244A)} but the prefill CPC row ` +
        `says ${inr(refundInterestFromPrefill)}. The intimation wins, but investigate the difference.`,
    );
  }
} else if (refundInterestFromPrefill != null) {
  draft.interest.refundInterest = {
    amount: refundInterestFromPrefill,
    ...(prior?.interest?.refundInterest?.amount != null ? { prior: prior.interest.refundInterest.amount } : {}),
    note: `per prefill CPC row (${prefillJson}); cross-check against the 143(1) intimation if at hand`,
  };
} else if (tis.refundInterestHint != null || prior?.interest?.refundInterest) {
  gaps.push({
    field: "interest.refundInterest",
    action:
      `fill 244A refund interest${tis.refundInterestHint != null ? ` (TIS hints ${inr(tis.refundInterestHint)})` : ""}: ` +
      `1) the 143(1) intimation (bun run parse-intimation <pdf>${intimationPdf ? `; ${intimationPdf} is in the folder` : ""}), ` +
      `2) the prefill CPC row (bun run tax refund-interest --from-prefill <prefill.json>), ` +
      `3) bun run tax refund-interest --refund ... NEVER received-minus-claimed.`,
  });
}

// dividends
if (tis.lineItems.tisDividend) {
  const priorDivs: AnyObj[] = prior?.dividends?.items ?? [];
  const matchedPrior = new Set<AnyObj>();
  const items: AnyObj[] = [];
  let divTds = 0;
  for (const it of tis.lineItems.tisDividend) {
    const pi = priorDivs.find((p) => !matchedPrior.has(p) && namesMatch(p.name ?? "", it.name));
    if (pi) matchedPrior.add(pi);
    const ded = byBucket.dividend.find((d) => namesMatch(d.name, it.name));
    const item: AnyObj = { name: pi?.name ?? it.name, gross: it.amount };
    if (ded) {
      item.tds = Math.round(ded.tds);
      item.tan = ded.tan;
      item.periods = periodsFromRows(ded.rows);
      divTds += ded.tds;
    }
    if (pi?.gross != null) item.priorGross = pi.gross;
    if (pi?.tds != null) item.priorTds = pi.tds;
    items.push(item);
  }
  for (const pi of priorDivs) {
    if (!matchedPrior.has(pi) && pi.gross != null) {
      items.push({ name: pi.name, priorGross: pi.gross, ...(pi.tds != null ? { priorTds: pi.tds } : {}) });
    }
  }
  if (divTds) rec.tisDividendTds = Math.round(divTds);
  draft.dividends = {
    items,
    ...(prior?.dividends?.items
      ? {
          prior: {
            total: prior.dividends.items.reduce((a: number, p: AnyObj) => a + (p.gross ?? 0), 0),
            tds: prior.dividends.items.reduce((a: number, p: AnyObj) => a + (p.tds ?? 0), 0),
          },
        }
      : {}),
    notes: [
      "periods filled from 26AS s.194 payment dates where TDS exists; SFT-only scrips have no payment dates " +
        "(AIS reports only the annual filing date) - leave their periods empty unless 234C matters.",
    ],
  };
  const unmatchedDed = byBucket.dividend.filter((d) => !items.some((i) => i.tan === d.tan));
  for (const d of unmatchedDed) {
    digestFlags.push(
      `26AS dividend deductor ${d.name} (${d.tan}, TDS ${inr(d.tds)}) matched no TIS dividend row - ` +
        `attach its TDS to the right item manually.`,
    );
  }
} else if (rec.tisDividend) {
  gaps.push({
    field: "dividends",
    action: `TIS dividend line items did not parse: fill per-company rows manually from the TIS annexure (target ${inr(rec.tisDividend)}).`,
  });
}

// capital gains: the sidecar rolls the loss forward deterministically; without
// it the prior figure is carried unchanged with a roll-forward gap
const cfLoss = carryforward?.capitalLoss;
const rolledLoss: { value: number; history: AnyObj[] } | null =
  cfLoss?.carryForwardNext != null
    ? (() => {
        const history: AnyObj[] = prior?.capitalGains?.lossHistory
          ? structuredClone(prior.capitalGains.lossHistory)
          : [];
        const row = cfLoss.lossHistoryAppend;
        // idempotent: skip the append if the prior file already carries this row
        if (row && !history.some((h) => h.ay === row.ay && h.movement === row.movement)) history.push(row);
        return { value: cfLoss.carryForwardNext as number, history };
      })()
    : null;
if (rolledLoss) {
  digestFlags.push(
    `capital loss rolled forward from the AY ${priorAy} carry-forward sidecar: ` +
      `${inr(rolledLoss.value)} (set-off applied last year: ${inr(cfLoss.setOffThisYear ?? 0)}).`,
  );
}

if (rec.tisSecuritiesSale) {
  draft.capitalGains = rolledLoss
    ? {
        ...(rolledLoss.value !== 0 ? { lossBroughtForward: rolledLoss.value } : {}),
        ...(rolledLoss.history.length ? { lossHistory: rolledLoss.history } : {}),
      }
    : {
        ...(prior?.capitalGains?.lossBroughtForward != null
          ? { lossBroughtForward: prior.capitalGains.lossBroughtForward }
          : {}),
        ...(prior?.capitalGains?.lossHistory ? { lossHistory: structuredClone(prior.capitalGains.lossHistory) } : {}),
      };
  if (cgFromAisJson) {
    // primary path: lots straight from the AIS JSON, already validated by the parser
    draft.capitalGains.longTerm = cgFromAisJson.longTerm;
    if (cgFromAisJson.shortTerm.length) draft.capitalGains.shortTerm = cgFromAisJson.shortTerm;
    else draft.capitalGains.shortTermNote = "NIL this year";
    const unconfirmed = [...cgFromAisJson.longTerm, ...cgFromAisJson.shortTerm].filter((i) => i.costUnconfirmed);
    if (unconfirmed.length) {
      gaps.push({
        field: "capitalGains",
        action:
          `${unconfirmed.length} lot(s) have costUnconfirmed (zero cost reported): get the real cost ` +
          `from the client/broker before filing - never file a zero cost as-is.`,
      });
    }
  } else if (aisPdf) {
    gaps.push({
      field: "capitalGains",
      action:
        `securities sales ${inr(rec.tisSecuritiesSale)} on the ${targetsSourceLabel}. Fill the lots deterministically - do NOT read the AIS table in-session:\n` +
        `       pdftotext -layout "${join(dir, aisPdf)}" /tmp/ais_layout.txt\n` +
        `       bun run parse-cg /tmp/ais_layout.txt --expect-sale-total ${rec.tisSecuritiesSale}\n` +
        `     (rm the /tmp file after).`,
    });
  } else if (aisJson) {
    // Reached only when the AIS-JSON CG extraction returned nothing / did not
    // reconcile (the parser drops the lots and flags a MISMATCH rather than hand
    // over half-right rows). Fall back to the AIS PDF.
    gaps.push({
      field: "capitalGains",
      action:
        `securities sales ${inr(rec.tisSecuritiesSale)}: the AIS JSON's per-lot detail could not be reconciled ` +
        `(see the CAPITAL-GAINS MISMATCH flag above). Fetch the AIS PDF and run parse-cg as the cross-check:\n` +
        `       pdftotext -layout "<AIS.pdf>" /tmp/ais_layout.txt\n` +
        `       bun run parse-cg /tmp/ais_layout.txt --expect-sale-total ${rec.tisSecuritiesSale}`,
    });
  } else {
    gaps.push({
      field: "capitalGains",
      action:
        `securities sales ${inr(rec.tisSecuritiesSale)} but no AIS source is in the folder - fetch the ` +
        `AIS JSON (/fetch-portal-docs) and re-run.`,
    });
  }
  if (!rolledLoss && prior?.capitalGains?.lossBroughtForward != null) {
    gaps.push({
      field: "capitalGains.lossBroughtForward",
      action:
        `carried ${inr(prior.capitalGains.lossBroughtForward)} from ${priorFile}; roll it forward: append the ` +
        `AY ${priorAy} set-off row to lossHistory and adjust the figure per the prior year's statement ` +
        `(a rebuilt AY ${priorAy} statement writes a carry-forward sidecar that automates this next time).`,
    });
  }
} else if (rolledLoss && rolledLoss.value !== 0) {
  draft.capitalGains = {
    lossBroughtForward: rolledLoss.value,
    ...(rolledLoss.history.length ? { lossHistory: rolledLoss.history } : {}),
    shortTermNote: "NIL this year",
  };
} else if (prior?.capitalGains?.lossBroughtForward) {
  draft.capitalGains = {
    lossBroughtForward: prior.capitalGains.lossBroughtForward,
    ...(prior.capitalGains.lossHistory ? { lossHistory: structuredClone(prior.capitalGains.lossHistory) } : {}),
    shortTermNote: "NIL this year",
  };
  digestFlags.push(
    "no securities sales this year; brought-forward loss carried UNCHANGED (no carry-forward sidecar - " +
      "confirm no set-off happened last year).",
  );
}

// deductions / exempt income / taxes paid: carry shapes, flag what needs proof
if (prior?.deductions) draft.deductions = structuredClone(prior.deductions);
if (prior?.exemptIncome) {
  draft.exemptIncome = structuredClone(prior.exemptIncome);
  gaps.push({
    field: "exemptIncome",
    action: "prior year had exempt income (PPF etc.): get this year's figure from the client, or null it with a note.",
  });
}
draft.taxesPaid = { advance: 0, selfAssessment: 0 };
if (prefillJson) {
  digestFlags.push("taxesPaid set to 0/0 - if the client paid advance/self-assessment tax it appears in the prefill; verify.");
}

if (carryforward?.gti != null) {
  draft.priorYear = { gti: carryforward.gti, tds: carryforward.tds ?? prior?.reconciliation?.totalTds ?? null };
} else if (prior) {
  draft.priorYear = { tds: prior.reconciliation?.totalTds ?? null };
  gaps.push({
    field: "priorYear.gti",
    action:
      `fill the prior year's gross total income from the AY ${priorAy} statement (Income sheet) - ` +
      `a rebuilt AY ${priorAy} statement writes a carry-forward sidecar that automates this next time.`,
  });
}
if (prior?.refundBankNote) draft.refundBankNote = prior.refundBankNote;

draft.reconciliation = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, Math.round(v as number)]));

draft.notes = [
  `Prepared by bun run extract from TIS (${tis.identity.generatedOn ?? "?"})` +
    (f26 ? ` and 26AS (updated till ${f26.identity.updatedTill ?? "?"})` : "") +
    ". Re-download before filing if stale.",
];

// ---------- write + digest ----------

writeFileSync(outPath, JSON.stringify(draft, null, 2) + "\n");

const srcBits = [
  `targets: ${targetsSourceLabel}${tis.identity.generatedOn ? ` ${tis.identity.generatedOn}` : ""}`,
  f26 ? `26AS ${f26asText ? "text" : "PDF"} till ${f26.identity.updatedTill ?? "?"} OK` : "26AS MISSING",
  prefillJson ? `prefill OK` : "prefill MISSING",
  priorFile ? `prior ${priorFile} OK` : "no prior-year data",
  ...(carryforward ? [`carry-forward AY${priorAy} OK`] : []),
];

console.log(`EXTRACT ${dir} -> ${outName}`);
console.log(`sources: ${srcBits.join(" | ")}`);
console.log(`identity: PAN ${pan ?? "?"} ${tis.identity.name ?? "?"} (all sources agree)`);
console.log(
  "targets: " +
    Object.entries(draft.reconciliation)
      .map(([k, v]) => `${k.replace(/^tis/, "")} ${Number(v).toLocaleString("en-IN")}`)
      .join(" | "),
);
if (!f26) {
  gaps.push({
    field: "reconciliation.totalTds",
    action:
      "no 26AS in the folder: fetch it (TDS truth) and re-run - the TRACES TEXT export is preferred " +
      "(reliable; extract parses it directly), the PDF is the fallback. Or fill every TDS figure manually.",
  });
}
const filled: string[] = [];
if (draft.dividends?.items) filled.push(`${draft.dividends.items.length} dividend rows`);
if (savingsItems.length) filled.push(`${savingsItems.length} savings rows`);
if (depositItems.length) filled.push(`${depositItems.length} deposit rows`);
if (draft.business?.items?.length) filled.push(`${draft.business.items.length} business item(s)`);
if (draft.interest.refundInterest)
  filled.push(intimation?.interest244A != null ? "refund interest (intimation)" : "refund interest (prefill CPC)");
console.log(`filled: ${filled.join(", ") || "(nothing beyond targets)"}`);

if (aisJsonNote) console.log(`ais-json: ${aisJsonNote}`);

if (gaps.length) {
  console.log(`\nGAPS (${gaps.length}) - resolve each, delete its _gaps entry, then: bun run statement ${outPath}`);
  gaps.forEach((g, i) => console.log(`  ${i + 1}. [${g.field}] ${g.action}`));
} else {
  console.log(`\nno gaps - review the draft, then: bun run statement ${outPath}`);
}
if (digestFlags.length) {
  console.log(`\nFLAGS (${digestFlags.length}):`);
  digestFlags.forEach((f) => console.log(`  - ${f}`));
}
console.log(
  `\nIf a gap or flag needs tax capability the toolkit lacks: do NOT extend scripts in-session - ` +
    `log it in docs/missing-functionality.md, park the client, move on (AGENTS.md).`,
);
