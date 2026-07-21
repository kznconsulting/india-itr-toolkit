#!/usr/bin/env bun
// JSON bridge to the tax rules in scripts/lib/tax.ts, for non-TypeScript tooling
// (scripts/build-statement.py calls this). Slab rules stay single-source in tax.ts.
//
// Usage:
//   bun scripts/tax-cli.ts compute --income 646897 --regime new --ay 2026-27 [--age s60to79 | --dob 05/12/1957]
//   bun scripts/tax-cli.ts rules   --regime old  --ay 2026-27 [--age s60to79 | --dob 05/12/1957]
//   bun scripts/tax-cli.ts ageband --dob 05/12/1957 --ay 2026-27
//   bun scripts/tax-cli.ts stcg111a --amount 2527 --ay 2026-27 [--sale-date 19/12/2025]
//   bun scripts/tax-cli.ts total --slab-income 646890 --regime new --ay 2026-27 \
//       [--stcg-after 2527] [--stcg-before N] [--ltcg-after N] [--ltcg-before N] \
//       [--age BAND | --dob DD/MM/YYYY] [--residential-status resident|nri]
//       (gain legs are post-set-off amounts, split at 23-07-2024 by transfer date)
//   bun scripts/tax-cli.ts refund-interest --refund 100273 --ay 2025-26 --refund-date 23/10/2025 \
//       [--filing-date 13/08/2025 --due-date 15/09/2025] [--tax-determined 17]
//
// All dates are DD/MM/YYYY (as printed on AIS/26AS/intimations). Output: one JSON object on stdout.

import {
  ageBandFromDob,
  computeRefundInterest244A,
  computeTax,
  computeTotalTax,
  getRules,
  stcg111ATax,
} from "./lib/tax";
import type { AgeBand, Regime, ResidentialStatus } from "./lib/tax";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1] ?? "";
  }
  return out;
}

function dobToIso(date: string): string {
  const m = date.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) fail(`dates must be DD/MM/YYYY, got "${date}"`);
  return `${m![3]}-${m![2]}-${m![1]}`;
}

function fail(message: string): never {
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

// --from-prefill: read the CPC-derived 244A figure straight out of the portal's
// prefill JSON (incDeductionsOthIncCPC "TAX" row) - the same authoritative number
// CPC used, no computation and no in-session JSON reading needed.
if (cmd === "refund-interest" && args["from-prefill"]) {
  const { readFileSync } = await import("node:fs");
  let prefill: any;
  try {
    prefill = JSON.parse(readFileSync(args["from-prefill"], "utf8"));
  } catch (e) {
    fail(`could not read ${args["from-prefill"]}: ${e}`);
  }
  const rowSets = [
    prefill?.incDeductionsOthIncCPC,
    prefill?.form26as?.incomeDeductionsOthersInc,
    prefill?.insights?.incomeDeductionsOthersInc,
  ].filter(Array.isArray);
  for (const rows of rowSets) {
    for (const r of rows) {
      if (String(r?.othSrcNatureDesc ?? "").toUpperCase() === "TAX" && r?.othSrcOthAmount != null) {
        console.log(
          JSON.stringify({ refundInterest: Number(r.othSrcOthAmount), source: "prefill CPC row (authoritative)" }),
        );
        process.exit(0);
      }
    }
  }
  fail(
    "no CPC refund-interest row in this prefill (othSrcNatureDesc=TAX). Use the 143(1) intimation " +
      "figure, or compute: bun run tax refund-interest --refund <principal> --ay <prior-ay> --refund-date DD/MM/YYYY",
  );
}

const ay = args.ay;
if (!ay) fail("--ay is required (e.g. 2026-27)");

if (cmd === "refund-interest") {
  const refundAmount = Number(args.refund);
  if (!Number.isFinite(refundAmount)) fail("--refund must be the refund principal (CPC-determined, not the amount credited)");
  if (!args["refund-date"]) fail("--refund-date is required (DD/MM/YYYY)");
  const result = computeRefundInterest244A({
    refundAmount,
    ay,
    refundDate: dobToIso(args["refund-date"]),
    filingDate: args["filing-date"] ? dobToIso(args["filing-date"]) : undefined,
    dueDate: args["due-date"] ? dobToIso(args["due-date"]) : undefined,
    taxDetermined: args["tax-determined"] ? Number(args["tax-determined"]) : undefined,
  });
  if (!result) fail(`bad --ay "${ay}"`);
  console.log(JSON.stringify(result));
  process.exit(0);
}

if (cmd === "stcg111a") {
  const amount = Number(args.amount);
  if (!Number.isFinite(amount)) fail("--amount must be a number");
  const result = stcg111ATax({
    stcgAmount: amount,
    saleDate: args["sale-date"] ? dobToIso(args["sale-date"]) : undefined,
  });
  console.log(JSON.stringify(result));
  process.exit(0);
}

let age: AgeBand = (args.age as AgeBand) ?? "lt60";
if (args.dob) age = ageBandFromDob(dobToIso(args.dob), ay);

if (cmd === "ageband") {
  console.log(JSON.stringify({ ay, age }));
} else if (cmd === "rules") {
  const regime = args.regime as Regime;
  if (regime !== "new" && regime !== "old") fail("--regime must be new|old");
  const rules = getRules(regime, ay, age);
  if (!rules) fail(`no rules for AY ${ay} - add them to scripts/lib/tax.ts`);
  console.log(JSON.stringify({ regime, ay, age, ...rules }));
} else if (cmd === "compute") {
  const regime = args.regime as Regime;
  if (regime !== "new" && regime !== "old") fail("--regime must be new|old");
  const income = Number(args.income);
  if (!Number.isFinite(income)) fail("--income must be a number");
  const bd = computeTax({ totalIncome: income, regime, ay, age });
  if (!bd) fail(`no rules for AY ${ay} - add them to scripts/lib/tax.ts`);
  console.log(JSON.stringify(bd));
} else if (cmd === "total") {
  const regime = args.regime as Regime;
  if (regime !== "new" && regime !== "old") fail("--regime must be new|old");
  const slabIncome = Number(args["slab-income"]);
  if (!Number.isFinite(slabIncome)) fail("--slab-income must be a number");
  const residentialStatus = (args["residential-status"] ?? "resident") as ResidentialStatus;
  if (residentialStatus !== "resident" && residentialStatus !== "nri")
    fail("--residential-status must be resident|nri");
  const num = (key: string) => {
    const n = Number(args[key] ?? 0);
    if (!Number.isFinite(n) || n < 0) fail(`--${key} must be a non-negative number`);
    return n;
  };
  const bd = computeTotalTax({
    slabIncome,
    regime,
    ay,
    age,
    residentialStatus,
    gains: {
      stcg111ABefore: num("stcg-before"),
      stcg111AOnAfter: num("stcg-after"),
      ltcg112ABefore: num("ltcg-before"),
      ltcg112AOnAfter: num("ltcg-after"),
    },
  });
  if (!bd) fail(`no rules for AY ${ay} - add them to scripts/lib/tax.ts`);
  console.log(JSON.stringify(bd));
} else {
  fail("usage: tax-cli.ts compute|rules|ageband|stcg111a|total --ay <yyyy-yy> [--regime new|old] [--income N | --slab-income N] [--age BAND | --dob DD/MM/YYYY]");
}
