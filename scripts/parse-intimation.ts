#!/usr/bin/env bun
// Parse a CPC 143(1) intimation order into its key figures (244A interest,
// CPC-determined refund principal, filed-vs-computed diffs). Standalone entry
// point - `bun run extract` calls the same parser automatically when an
// intimation PDF is in the client folder.
//
// Usage:
//   bun run parse-intimation <intimation.pdf|.txt> [--pan PAN --dob DD/MM/YYYY] [--password PW]

import { readFileSync } from "node:fs";
import { pdfToText } from "./lib/pdftext";
import { parseIntimation } from "./lib/intimation";

function parseArgs(argv: string[]): { file?: string; opts: Record<string, string> } {
  const opts: Record<string, string> = {};
  let file: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) opts[argv[i].slice(2)] = argv[++i] ?? "";
    else file ??= argv[i];
  }
  return { file, opts };
}

const { file, opts } = parseArgs(process.argv.slice(2));
if (!file) {
  console.error("usage: bun run parse-intimation <intimation.pdf|.txt> [--pan PAN --dob DD/MM/YYYY] [--password PW]");
  process.exit(1);
}

const text = file.toLowerCase().endsWith(".pdf")
  ? pdfToText(file, { pan: opts.pan, dob: opts.dob, password: opts.password }).text
  : readFileSync(file, "utf8");

const result = parseIntimation(text);
console.log(JSON.stringify(result, null, 2));
if (result.flags.some((f) => f.includes("PARSE FAILED"))) process.exit(2);
