#!/usr/bin/env bun
// Process ITR JSONs exported by the Income Tax Department's offline utility.
//
// Usage:
//   bun scripts/process-itr.ts <return.json> [--out <report.md>]   # one return, detailed output
//   bun scripts/process-itr.ts <dir-or-files...>                    # batch: e.g. clients/ or clients/mehta/inbox/
//
// Reports land next to the input: clients/<name>/inbox/foo.json -> clients/<name>/reports/foo.report.md
// (top-level reports/ for anything outside an inbox). A machine-readable .summary.json is written
// beside every report; scripts/status.ts aggregates those into the practice-wide status board.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { extractReturn } from "./lib/extract";
import { inr, LEVEL_ICON, renderReport } from "./lib/report";
import { ageBandFromDob, compareRegimes } from "./lib/tax";
import { validateReturn } from "./lib/validate";
import type { Check, NormalizedReturn } from "./lib/types";

const SKIP_DIRS = new Set(["archive", "reports", "node_modules"]);

interface Processed {
  ret: NormalizedReturn;
  checks: Check[];
  comparison: ReturnType<typeof compareRegimes>;
  out: string;
  fails: number;
  warns: number;
}

function walk(dir: string, out: string[]) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(full, out);
    } else if (/\.json$/i.test(entry.name) && !/\.summary\.json$/i.test(entry.name)) {
      out.push(full);
    }
  }
}

function collectInputs(paths: string[]): string[] {
  const files: string[] = [];
  for (const p of paths) {
    if (statSync(p).isDirectory()) walk(p, files);
    else files.push(p);
  }
  return files.sort();
}

function defaultOut(inputPath: string): string {
  const dir = dirname(inputPath);
  const base = basename(inputPath).replace(/\.json$/i, "") + ".report.md";
  if (basename(dir) === "inbox") return join(dirname(dir), "reports", base);
  return join("reports", base);
}

function positionOf(r: NormalizedReturn): string {
  if ((r.settlement.refundDue ?? 0) > 0) return `refund ${inr(r.settlement.refundDue)}`;
  if ((r.settlement.balancePayable ?? 0) > 0) return `pay ${inr(r.settlement.balancePayable)}`;
  if (r.tax.totalPayable != null) return "settled";
  return "-";
}

function processFile(inputPath: string, outPath: string | null): Processed {
  const json = JSON.parse(readFileSync(inputPath, "utf8"));
  const ret = extractReturn(json);
  const checks = validateReturn(ret);
  const comparison =
    ret.income.grossTotal != null && (ret.regime === "new" || ret.regime === "old")
      ? compareRegimes({
          grossTotalIncome: ret.income.grossTotal,
          filedRegime: ret.regime,
          salaried: (ret.income.salaryNet ?? 0) > 0,
          ay: ret.assessmentYear,
          age: ageBandFromDob(ret.assessee.dob, ret.assessmentYear),
        })
      : null;

  const out = outPath ?? defaultOut(inputPath);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderReport(ret, checks, comparison, inputPath));

  const fails = checks.filter((c) => c.level === "fail").length;
  const warns = checks.filter((c) => c.level === "warn").length;
  const summaryPath = out.endsWith(".report.md")
    ? out.replace(/\.report\.md$/, ".summary.json")
    : out + ".summary.json";
  writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        name: ret.assessee.name,
        pan: ret.assessee.pan,
        ay: ret.assessmentYear,
        form: ret.form,
        regime: ret.regime,
        totalIncome: ret.totalIncome,
        liability: ret.tax.totalPayable,
        paid: ret.paid.total,
        refundDue: ret.settlement.refundDue,
        balancePayable: ret.settlement.balancePayable,
        fails,
        warns,
        source: inputPath,
        report: out,
        processedAt: new Date().toISOString(),
      },
      null,
      2,
    ) + "\n",
  );
  return { ret, checks, comparison, out, fails, warns };
}

function printDetailed(p: Processed, inputPath: string) {
  const { ret, checks, comparison } = p;
  console.log(`${ret.form} · AY ${ret.assessmentYear} · ${ret.assessee.name ?? "?"} · regime: ${ret.regime}`);
  console.log(
    `Total income ${inr(ret.totalIncome)} · liability ${inr(ret.tax.totalPayable)} · paid ${inr(ret.paid.total)} · ${positionOf(ret)}`,
  );
  console.log("");
  for (const c of checks) console.log(`  ${LEVEL_ICON[c.level]} ${c.message}`);
  if (comparison) {
    console.log("");
    if (comparison.breakEvenDeductions == null) {
      console.log(`  Regimes: old cannot beat new (${inr(comparison.newRegime.total)}) at any deduction level`);
    } else if (comparison.breakEvenDeductions === 0) {
      console.log(`  Regimes: old is already cheaper than new (${inr(comparison.newRegime.total)}) with zero deductions`);
    } else {
      console.log(`  Regimes: new costs ${inr(comparison.newRegime.total)}; old wins beyond ~${inr(comparison.breakEvenDeductions)} of deductions`);
    }
  }
  console.log(`\nReport: ${p.out} (${p.fails} fail, ${p.warns} warn)`);
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf("--out");
  let outPath: string | null = null;
  if (outIdx !== -1) {
    outPath = args[outIdx + 1] ?? null;
    args.splice(outIdx, 2);
  }
  if (args.length === 0) {
    console.error("Usage: bun scripts/process-itr.ts <return.json | dir> [more paths...] [--out <report.md>]");
    process.exit(2);
  }

  let files: string[];
  try {
    files = collectInputs(args);
  } catch (e) {
    console.error(`Cannot read input: ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }
  if (files.length === 0) {
    console.error(`No return JSONs found under: ${args.join(", ")}`);
    process.exit(2);
  }
  if (files.length > 1 && outPath) {
    console.error("--out only works with a single input file.");
    process.exit(2);
  }

  if (files.length === 1) {
    const p = processFile(files[0], outPath);
    printDetailed(p, files[0]);
    if (p.fails > 0) process.exit(1);
    return;
  }

  let failing = 0;
  let warning = 0;
  let errored = 0;
  for (const f of files) {
    try {
      const p = processFile(f, null);
      const state = p.fails > 0 ? "FAIL" : p.warns > 0 ? "warn" : "ok  ";
      if (p.fails > 0) failing++;
      else if (p.warns > 0) warning++;
      console.log(
        `${state}  ${f} · ${p.ret.form} AY ${p.ret.assessmentYear} · ${p.ret.assessee.name ?? "?"} · ${p.fails} fail, ${p.warns} warn · ${positionOf(p.ret)}`,
      );
    } catch (e) {
      errored++;
      console.log(`ERR   ${f} · ${e instanceof Error ? e.message : e}`);
    }
  }
  const clean = files.length - failing - warning - errored;
  console.log(`\nProcessed ${files.length} returns: ${clean} clean, ${warning} with warnings, ${failing} failing, ${errored} unreadable.`);
  console.log(`Run "bun run status" for the per-client board.`);
  if (failing > 0 || errored > 0) process.exit(1);
}

main();
