#!/usr/bin/env bun
// One-shot verification chain: generate -> check -> process -> prefill, with a
// single consolidated PASS/FAIL block. Replaces four separate command rounds -
// the operator runs this once and reads one summary.
//
//   bun run verify clients/<slug>/AY<yyyy-yy>-statement-data.json
//       [--template <prior-filed.json>] [--prefill <prefill.json>] [--out <generated.json>]
//
// Auto-discovery (client folder conventions):
//   template: newest .json in archive/AY<prior>/, else a root-level filed
//             return JSON (a file containing an "ITR" object)
//   prefill:  a root-level *prefill*.json
//
// Stops at the FIRST hard failure and prints that step's own output verbatim -
// each downstream script already says exactly what to fix or when to park.
// Never "fix" a failure by editing the generated JSON: fix the data file and
// re-run. If the same step fails twice for the same reason, stop and re-check
// the inputs (or park per AGENTS.md) instead of iterating.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";

function die(msg: string): never {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

function parseArgs(argv: string[]) {
  const opts: Record<string, string> = {};
  let data: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i] ?? "";
    else data ??= argv[i];
  }
  return { data, opts };
}

const { data: dataPath, opts } = parseArgs(process.argv.slice(2));
if (!dataPath) {
  die("usage: bun run verify <statement-data.json> [--template <filed.json>] [--prefill <prefill.json>] [--out <generated.json>]");
}
if (!existsSync(dataPath)) die(`${dataPath} does not exist`);

const clientDir = dirname(dataPath);
const dataJson = JSON.parse(readFileSync(dataPath, "utf8"));
const ay: string | undefined = dataJson.assessmentYear;
if (!ay) die(`${dataPath} has no assessmentYear`);
const priorAy = (() => {
  const m = ay.match(/^(\d{4})-(\d{2})$/);
  return m ? `${Number(m[1]) - 1}-${String(Number(m[2]) - 1).padStart(2, "0")}` : null;
})();

// ---- template discovery ----
let template = opts.template;
if (!template) {
  const candidates: string[] = [];
  const archiveDir = join(clientDir, "archive", `AY${priorAy}`);
  if (priorAy && existsSync(archiveDir)) {
    for (const f of readdirSync(archiveDir).sort().reverse()) {
      if (f.endsWith(".json")) candidates.push(join(archiveDir, f));
    }
  }
  if (candidates.length === 0) {
    for (const f of readdirSync(clientDir)) {
      if (!f.endsWith(".json") || /statement-data|prefill|ais/i.test(f)) continue;
      try {
        const j = JSON.parse(readFileSync(join(clientDir, f), "utf8"));
        if (j?.ITR) candidates.push(join(clientDir, f));
      } catch {
        // not a return JSON: skip
      }
    }
  }
  if (candidates.length === 0) {
    die(
      `no prior-year filed return JSON found in ${clientDir} (looked in archive/AY${priorAy}/ and the ` +
        `client root). A first-year client has no template: use the online-mode path instead - ` +
        `bun run guide ${dataPath} - or pass --template explicitly.`,
    );
  }
  if (candidates.length > 1) {
    die(
      `multiple template candidates found - pass one explicitly with --template:\n  ${candidates.join("\n  ")}`,
    );
  }
  template = candidates[0];
}

// ---- prefill discovery ----
let prefill = opts.prefill;
if (!prefill) {
  const found = readdirSync(clientDir).filter((f) => /prefill/i.test(f) && f.endsWith(".json"));
  if (found.length === 1) prefill = join(clientDir, found[0]);
  else if (found.length > 1) die(`multiple prefill JSONs in ${clientDir} - pass --prefill explicitly`);
}

// ---- run the chain ----
interface StepResult {
  name: string;
  ok: boolean;
  summary: string;
  output: string;
}

function run(name: string, cmd: string[], summarize: (out: string) => string): StepResult {
  const res = spawnSync(cmd[0], cmd.slice(1), { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  const output = (res.stdout ?? "") + (res.stderr ?? "");
  const ok = res.status === 0;
  return { name, ok, summary: ok ? summarize(output) : "FAILED", output };
}

const lastLine = (out: string) =>
  out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.includes("RuntimeWarning") && !l.startsWith("<frozen"))
    .pop() ?? "";

const steps: StepResult[] = [];
const failNow = (s: StepResult) => {
  console.log(`VERIFY ${dataPath} - ${s.name} FAILED\n`);
  console.log(s.output.trim());
  console.log(
    `\nFix the DATA FILE (never the generated JSON or the check) and re-run bun run verify. ` +
      `If the failure names a toolkit gap, follow its park instruction instead of retrying.`,
  );
  process.exit(1);
};

// 1. generate
const genArgs = ["python3", "scripts/generate-itr.py", dataPath, "--template", template];
if (opts.out) genArgs.push("--out", opts.out);
const gen = run("generate", genArgs, (out) => {
  const saved = out.match(/^saved: (.*)$/m)?.[1] ?? "";
  return saved;
});
steps.push(gen);
if (!gen.ok) failNow(gen);
const generated = gen.output.match(/^saved: (\S+)/m)?.[1];
if (!generated) failNow({ ...gen, ok: false, output: gen.output + "\n(could not find the generated file path)" });
const expected = gen.output.match(/^expected at the portal: .*$/m)?.[0] ?? "";
const warningsBlock = gen.output.match(/WARNINGS \(\d+\)[^]*?(?=\n\n|$)/)?.[0] ?? "";

// 2. check (CBDT validation rules)
const check = run("check", ["python3", "scripts/check-rules.py", generated!], lastLine);
steps.push(check);
if (!check.ok) failNow(check);

// 3. process (independent review)
const proc = run("process", ["bun", "scripts/process-itr.ts", generated!], (out) => {
  const m = out.match(/report: .*$/m)?.[0];
  return m ?? lastLine(out);
});
steps.push(proc);
if (!proc.ok) failNow(proc);

// 4. prefill diff
if (prefill) {
  const pre = run("prefill", ["python3", "scripts/compare-prefill.py", prefill, generated!], lastLine);
  steps.push(pre);
  if (!pre.ok) failNow(pre);
} else {
  steps.push({
    name: "prefill",
    ok: true,
    summary: "SKIPPED - no prefill JSON in the client folder (fetch it for the full pre-upload check)",
    output: "",
  });
}

// ---- consolidated summary ----
console.log(`VERIFY ${dataPath}`);
for (const s of steps) console.log(`  ${s.ok ? "OK  " : "FAIL"}  ${s.name.padEnd(8)} ${s.summary}`);
if (expected) console.log(`\n${expected}`);
console.log(`  (upload in the portal's OFFLINE mode; if the portal's summary differs, STOP and reconcile)`);
if (warningsBlock) console.log(`\n${warningsBlock.trim()}`);
console.log(`\nall green: operator uploads ${generated}, then e-verify within 30 days; archive per docs/workflow.md`);
