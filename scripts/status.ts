#!/usr/bin/env bun
// Practice-wide status board: one row per client per assessment year.
//
// It resolves each client-year to a pipeline STAGE, not just filed/pending, by
// reading three things off disk:
//   - clients/<name>/AY<yy-yy>-statement-data.json  (the extract DRAFT + its _gaps)
//   - clients/<name>/reports/*.summary.json         (written by verify's process step)
//   - clients/<name>/archive/AY<yy-yy>/             (non-empty = FILED)
// so a client sitting between extract and verify shows as EXTRACTED with its open
// gaps listed, instead of collapsing to a bare "(no drafts processed)" row.
//
// Usage: bun scripts/status.ts [clientsDir] [--next]   (default: clients/)
// --next adds a NEXT column: the recommended next action per client-year.
// Open gaps are always listed below the table when any exist.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyDownload } from "./lib/harvest";

const argv = process.argv.slice(2);
const SHOW_NEXT = argv.includes("--next");
const CLIENTS_DIR = argv.filter((a) => a !== "--next")[0] ?? "clients";

const inr = (n: number | null | undefined): string =>
  n == null ? "-" : "₹" + Math.round(n).toLocaleString("en-IN");

interface Summary {
  name?: string | null;
  pan?: string | null;
  ay?: string;
  form?: string;
  regime?: string;
  liability?: number | null;
  refundDue?: number | null;
  balancePayable?: number | null;
  fails?: number;
  warns?: number;
  source?: string;
  processedAt?: string;
}

interface Gap {
  field: string;
  action: string;
}

interface DraftInfo {
  ay: string;
  file: string;
  name: string | null;
  gaps: Gap[];
}

type Stage = "FILED" | "VERIFIED" | "READY" | "EXTRACTED" | "HARVESTED" | "EMPTY";

interface Row {
  client: string;
  ay: string;
  form: string;
  name: string;
  draft: string;
  checks: string;
  position: string;
  stage: string;
  next: string;
  gaps: Gap[];
}

function nextAction(stage: Stage, s: Summary | undefined, client: string, gapCount: number): string {
  switch (stage) {
    case "FILED":
      return "-";
    case "VERIFIED":
      if ((s?.fails ?? 0) > 0) return "fix the data file, re-run bun run verify";
      if ((s?.warns ?? 0) > 0) return "resolve warnings (report), then upload + e-verify";
      return "upload (offline mode) + e-verify, then archive/";
    case "READY":
      return "bun run statement -> verify";
    case "EXTRACTED":
      return `resolve ${gapCount} gap(s) below, then statement -> verify`;
    case "HARVESTED":
      return `bun run extract clients/${client}`;
    case "EMPTY":
      return `bun run harvest clients/${client} --sweep --pan <PAN>`;
  }
}

function latestSummariesByAy(reportsDir: string): Map<string, Summary> {
  const byAy = new Map<string, Summary>();
  if (!existsSync(reportsDir)) return byAy;
  for (const f of readdirSync(reportsDir)) {
    if (!f.endsWith(".summary.json")) continue;
    try {
      const s: Summary = JSON.parse(readFileSync(join(reportsDir, f), "utf8"));
      const ay = s.ay ?? "unknown";
      const prev = byAy.get(ay);
      if (!prev || String(s.processedAt ?? "") > String(prev.processedAt ?? "")) byAy.set(ay, s);
    } catch {
      // unreadable summary: skip
    }
  }
  return byAy;
}

// The extract DRAFT per AY: clients/<name>/AY<yy-yy>-statement-data.json, with its
// _gaps. This is what makes a between-extract-and-verify client visible.
function draftsByAy(clientDir: string): Map<string, DraftInfo> {
  const byAy = new Map<string, DraftInfo>();
  if (!existsSync(clientDir)) return byAy;
  for (const f of readdirSync(clientDir)) {
    const m = f.match(/^AY(\d{4}-\d{2})-statement-data\.json$/);
    if (!m) continue;
    try {
      const d = JSON.parse(readFileSync(join(clientDir, f), "utf8"));
      const gaps: Gap[] = Array.isArray(d._gaps)
        ? d._gaps.filter((g: any) => g && typeof g.field === "string" && typeof g.action === "string")
        : [];
      const name = typeof d.client?.name === "string" ? d.client.name : null;
      byAy.set(m[1], { ay: m[1], file: f, name, gaps });
    } catch {
      // unreadable draft: skip
    }
  }
  return byAy;
}

// Any harvested portal artifact (prefill/AIS/26AS/TIS) at the client root -> the
// difference between an EMPTY folder and one that's been HARVESTED but not extracted.
function hasSourceFiles(clientDir: string): boolean {
  if (!existsSync(clientDir)) return false;
  return readdirSync(clientDir, { withFileTypes: true })
    .filter((d) => d.isFile())
    .some((d) => classifyDownload(d.name) !== null);
}

function filedAys(archiveDir: string): Set<string> {
  const filed = new Set<string>();
  if (!existsSync(archiveDir)) return filed;
  for (const d of readdirSync(archiveDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const m = d.name.match(/^AY(.+)$/i);
    if (!m) continue;
    if (readdirSync(join(archiveDir, d.name)).some((f) => !f.startsWith("."))) filed.add(m[1]);
  }
  return filed;
}

function positionOf(s: Summary): string {
  if ((s.refundDue ?? 0) > 0) return `refund ${inr(s.refundDue)}`;
  if ((s.balancePayable ?? 0) > 0) return `pay ${inr(s.balancePayable)}`;
  if (s.liability != null) return "settled";
  return "-";
}

function stageLabel(stage: Stage, gapCount: number, s: Summary | undefined): string {
  switch (stage) {
    case "EXTRACTED":
      return `EXTRACTED (${gapCount} gap${gapCount === 1 ? "" : "s"})`;
    case "VERIFIED":
      return (s?.fails ?? 0) > 0 ? "VERIFIED (fails)" : "VERIFIED";
    default:
      return stage;
  }
}

function main() {
  if (!existsSync(CLIENTS_DIR)) {
    printEmptyHelp();
    return;
  }
  // statSync (not the Dirent) so symlinked client folders resolve to their
  // target: legacy clients live in ~/Documents/<Name>/ and are linked in as
  // clients/<slug>, and a Dirent reports the symlink's own type, not the dir's.
  const clientDirs = readdirSync(CLIENTS_DIR)
    .filter((name) => !name.startsWith("."))
    .filter((name) => {
      try {
        return statSync(join(CLIENTS_DIR, name)).isDirectory();
      } catch {
        return false; // broken symlink / unreadable entry
      }
    })
    .sort();

  const rows: Row[] = [];
  for (const client of clientDirs) {
    const clientDir = join(CLIENTS_DIR, client);
    const summaries = latestSummariesByAy(join(clientDir, "reports"));
    const drafts = draftsByAy(clientDir);
    const filed = filedAys(join(clientDir, "archive"));
    const ays = new Set([...summaries.keys(), ...drafts.keys(), ...filed]);

    for (const ay of [...ays].sort().reverse()) {
      const s = summaries.get(ay);
      const draft = drafts.get(ay);
      const gaps = draft?.gaps ?? [];

      // Stage precedence: filed > verified (summary written) > extracted-with-gaps
      // > ready (draft, gaps resolved, not yet verified).
      let stage: Stage;
      if (filed.has(ay)) stage = "FILED";
      else if (s) stage = "VERIFIED";
      else if (draft && gaps.length > 0) stage = "EXTRACTED";
      else stage = "READY"; // draft present, no gaps, not verified

      rows.push({
        client,
        ay,
        form: s?.form ?? "-",
        name: s?.name ?? draft?.name ?? "-",
        draft: s?.source ? s.source.split("/").pop()! : (draft?.file ?? "-"),
        checks: s ? (s.fails ? `${s.fails} fail` : s.warns ? `${s.warns} warn` : "clean") : "-",
        position: s ? positionOf(s) : "-",
        stage: stageLabel(stage, gaps.length, s),
        next: nextAction(stage, s, client, gaps.length),
        gaps: stage === "EXTRACTED" ? gaps : [],
      });
    }

    if (ays.size === 0) {
      const stage: Stage = hasSourceFiles(clientDir) ? "HARVESTED" : "EMPTY";
      rows.push({
        client,
        ay: "-",
        form: "-",
        name: "-",
        draft: stage === "HARVESTED" ? "(harvested, not extracted)" : "(no files yet)",
        checks: "-",
        position: "-",
        stage,
        next: nextAction(stage, undefined, client, 0),
        gaps: [],
      });
    }
  }

  if (rows.length === 0) {
    printEmptyHelp();
    return;
  }

  const cols: [keyof Row, string][] = [
    ["client", "CLIENT"],
    ["ay", "AY"],
    ["form", "FORM"],
    ["name", "ASSESSEE"],
    ["draft", "LATEST DRAFT"],
    ["checks", "CHECKS"],
    ["position", "POSITION"],
    ["stage", "STAGE"],
    ...(SHOW_NEXT ? ([["next", "NEXT"]] as [keyof Row, string][]) : []),
  ];
  const cell = (r: Row, k: keyof Row) => String(r[k] ?? "");
  const width = (k: keyof Row, h: string) => Math.max(h.length, ...rows.map((r) => cell(r, k).length));
  const widths = cols.map(([k, h]) => width(k, h));
  const line = (vals: string[]) => vals.map((v, i) => v.padEnd(widths[i])).join("  ");

  console.log(line(cols.map(([, h]) => h)));
  console.log(line(widths.map((w) => "-".repeat(w))));
  for (const r of rows) console.log(line(cols.map(([k]) => cell(r, k))));

  printGaps(rows);

  const filedCount = rows.filter((r) => r.stage === "FILED").length;
  const failing = rows.filter((r) => r.checks.includes("fail")).length;
  const withGaps = rows.filter((r) => r.gaps.length > 0).length;
  console.log(
    `\n${clientDirs.length} client(s), ${rows.length} return-year(s): ${filedCount} filed, ${rows.length - filedCount} pending` +
      (withGaps > 0 ? `, ${withGaps} awaiting gap resolution` : "") +
      (failing > 0 ? `, ${failing} with failing checks` : "") +
      ".",
  );
}

// Every open gap across the practice, grouped by client-year: the "what are we
// waiting on the client for" digest.
function printGaps(rows: Row[]) {
  const withGaps = rows.filter((r) => r.gaps.length > 0);
  if (withGaps.length === 0) return;

  const total = withGaps.reduce((a, r) => a + r.gaps.length, 0);
  const fieldW = Math.max(...withGaps.flatMap((r) => r.gaps.map((g) => g.field.length)));
  console.log(`\nOPEN GAPS - ${total} across ${withGaps.length} client-year(s), resolve then re-run statement -> verify:`);
  for (const r of withGaps) {
    console.log(`\n  ${r.client}  AY${r.ay}`);
    for (const g of r.gaps) console.log(`    - ${g.field.padEnd(fieldW)}  ${g.action}`);
  }
}

function printEmptyHelp() {
  console.log(`No client data found under ${CLIENTS_DIR}/.

Layout (one folder per client):
  clients/<client-name>/inbox/               drop draft JSONs from the ITD utility here
  clients/<client-name>/reports/             generated reports + summaries (created automatically)
  clients/<client-name>/archive/AY2026-27/   the filed JSON + ITR-V once submitted

Then:
  bun run process clients/                   process every client's inbox
  bun run status                             this board`);
}

main();
