#!/usr/bin/env bun
// Parse a TIS PDF (or its pdftotext -layout text) into reconciliation targets
// and validated line items. Debug/standalone entry point - the normal path is
// `bun run extract <client-dir>`, which calls the same parser.
//
// Usage:
//   bun scripts/parse-tis.ts <TIS.pdf|tis.txt> [--pan AAAAA9999A --dob DD/MM/YYYY] [--password PW]

import { readFileSync } from "node:fs";
import { pdfToText } from "./lib/pdftext";
import { parseTis } from "./lib/tis";

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
  console.error("usage: bun scripts/parse-tis.ts <TIS.pdf|tis.txt> [--pan PAN --dob DD/MM/YYYY] [--password PW]");
  process.exit(1);
}

const text = file.toLowerCase().endsWith(".pdf")
  ? pdfToText(file, { pan: opts.pan, dob: opts.dob, password: opts.password }).text
  : readFileSync(file, "utf8");

const result = parseTis(text);
console.log(JSON.stringify(result, null, 2));
if (result.flags.length > 0) process.exit(2);
