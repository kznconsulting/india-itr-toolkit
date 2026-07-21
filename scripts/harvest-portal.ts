#!/usr/bin/env bun
// Guided portal harvest: the zero-token gather phase (see AGENTS.md "Portal
// browser sessions" and docs/missing-functionality.md "Deterministic
// portal-harvest script").
//
// v1 design - simplest and most resilient on purpose:
//   - NO DOM selectors: the operator does every portal click (they know the
//     portal; menus drift). The script owns everything that must be exact:
//     session/browser management, the identity gate, download capture,
//     PAN verification, naming, filing, and the digest.
//   - NO dependencies: raw Chrome DevTools Protocol over Bun's built-in
//     WebSocket/fetch. The practice Chrome is attached to, never owned - it
//     outlives every run, so re-attach never costs a re-login/OTP.
//   - Downloads are captured wherever they land (practice staging dir via
//     CDP Browser.setDownloadBehavior, plus ~/Downloads as belt-and-braces),
//     no matter who clicked.
//
// Usage:
//   bun run harvest clients/<slug> [--ay 2026-27] [--pan AAAPZ8888Z]
//                                  [--port 9992] [--skip-gate] [--no-browser]
//
// While running: type  s + Enter  to skip the current artifact,
//                      q + Enter  to stop and print the digest.
// --skip-gate / --no-browser exist for maintainer self-tests (see docs/maintainer.md).

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import {
  aisPdfFallbackSteps,
  artifactFileName,
  classifyDownload,
  defaultAY,
  harvestSteps,
  initialsFromSlug,
  looksAisEncrypted,
  namePartsFromSlug,
  PAN_RE,
  scanPans,
  sweepClassify,
  verifyJsonArtifact,
  type ArtifactKey,
  type StepSpec,
} from "./lib/harvest";

// ---------------------------------------------------------------- arguments

function parseArgs(argv: string[]) {
  const opts: Record<string, string | boolean> = {};
  let dir: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-gate" || a === "--no-browser" || a === "--sweep") opts[a.slice(2)] = true;
    else if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
    else dir ??= a;
  }
  return { dir, opts };
}

const { dir: clientDir, opts } = parseArgs(process.argv.slice(2));
if (!clientDir || !existsSync(clientDir)) {
  console.error("usage: bun run harvest clients/<slug> [--sweep [--days N]] [--ay 2026-27] [--pan PAN] [--port 9992] [--skip-gate] [--no-browser]");
  if (clientDir) console.error(`client folder not found: ${clientDir}`);
  process.exit(1);
}

const slug = basename(clientDir.replace(/\/+$/, ""));
const ay = typeof opts.ay === "string" && opts.ay ? opts.ay : defaultAY(new Date());
const initials = initialsFromSlug(slug);
const nameParts = namePartsFromSlug(slug);
const noBrowser = opts["no-browser"] === true;
const skipGate = opts["skip-gate"] === true || noBrowser;
const port = Number(opts.port || 9992);

const HOME = homedir();
const PROFILE_DIR = join(HOME, ".india-taxes-chrome");
const STAGING = join(PROFILE_DIR, "downloads");
const USER_DOWNLOADS = join(HOME, "Downloads");
const LOGIN_URL = "https://eportal.incometax.gov.in/iec/foservices/#/login";
const PORTAL_HOSTS = /incometax\.gov\.in|insight\.gov\.in|tdscpc\.gov\.in/;

mkdirSync(STAGING, { recursive: true });

// Expected PAN: --pan > newest statement-data.json in the client folder > prompt.
function panFromStatementData(): string | null {
  try {
    const candidates = readdirSync(clientDir!)
      .filter((f) => f.endsWith("statement-data.json"))
      .sort()
      .reverse();
    for (const f of candidates) {
      const pan = JSON.parse(readFileSync(join(clientDir!, f), "utf8"))?.client?.pan;
      if (typeof pan === "string" && new RegExp(`^${PAN_RE.source.slice(2, -2)}$`).test(pan)) return pan;
    }
  } catch {}
  return null;
}

let pan = typeof opts.pan === "string" ? opts.pan.toUpperCase() : "";
if (!pan) pan = panFromStatementData() ?? "";
if (!pan) {
  pan = (prompt(`Expected PAN for ${slug} (identity gate + filenames):`) ?? "").trim().toUpperCase();
}
if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(pan)) {
  console.error(`"${pan}" is not a valid PAN. Pass --pan or fix the client's statement-data.json.`);
  process.exit(1);
}

// Destination: legacy per-year subfolder when the client keeps one, else the folder root.
const aySubdir = join(clientDir, `AY ${ay}`);
const destDir = existsSync(aySubdir) ? aySubdir : clientDir;

// ------------------------------------------------------------ stdin commands

const commands: string[] = [];
(async () => {
  try {
    for await (const line of console) commands.push(line.trim().toLowerCase());
  } catch {}
})();
const nextCommand = () => commands.shift();

// ----------------------------------------------------------------- raw CDP

async function cdpHttp(path: string, method: "GET" | "PUT" = "GET"): Promise<any | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method, signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}

/** One-shot CDP command over a fresh WebSocket; resolves null on any failure. */
function cdpSend(wsUrl: string, method: string, params: object, timeoutMs = 5000): Promise<any | null> {
  return new Promise((resolve) => {
    let settled = false;
    let ws: WebSocket;
    const finish = (v: any | null) => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      resolve(v);
    };
    try { ws = new WebSocket(wsUrl); } catch { return resolve(null); }
    const timer = setTimeout(() => finish(null), timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method, params }));
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data));
        if (msg.id === 1) { clearTimeout(timer); finish(msg.result ?? null); }
      } catch {}
    };
    ws.onerror = () => { clearTimeout(timer); finish(null); };
  });
}

const evalInPage = (wsUrl: string, expression: string) =>
  cdpSend(wsUrl, "Runtime.evaluate", { expression, returnByValue: true }).then((r) => r?.result?.value ?? null);

async function portalPageTexts(): Promise<string[]> {
  const targets = (await cdpHttp("/json/list")) as any[] | null;
  if (!targets) return [];
  const texts: string[] = [];
  for (const t of targets) {
    if (t.type !== "page" || !PORTAL_HOSTS.test(t.url ?? "") || !t.webSocketDebuggerUrl) continue;
    const text = await evalInPage(t.webSocketDebuggerUrl, "document.body ? document.body.innerText : ''");
    if (typeof text === "string" && text) texts.push(text);
  }
  return texts;
}

function findChrome(): string | null {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    join(HOME, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
  ].filter(Boolean) as string[];
  return candidates.find((c) => existsSync(c)) ?? null;
}

async function ensureChrome(): Promise<boolean> {
  if (await cdpHttp("/json/version")) return true;
  const chrome = findChrome();
  if (!chrome) {
    console.error("Google Chrome not found. Install it, or launch the practice Chrome yourself:");
    console.error(`  <chrome> --user-data-dir="${PROFILE_DIR}" --remote-debugging-port=${port} "${LOGIN_URL}"`);
    return false;
  }
  console.log("Starting the practice Chrome window...");
  Bun.spawn({
    cmd: [chrome, `--user-data-dir=${PROFILE_DIR}`, `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", LOGIN_URL],
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  }).unref();
  for (let i = 0; i < 40; i++) {
    await Bun.sleep(500);
    if (await cdpHttp("/json/version")) return true;
  }
  console.error("Could not reach the practice Chrome on port " + port + ".");
  console.error("If a practice window is already open from an old run, close ALL its windows and rerun.");
  return false;
}

async function routeDownloadsToStaging(): Promise<void> {
  const version = await cdpHttp("/json/version");
  const wsUrl = version?.webSocketDebuggerUrl;
  if (!wsUrl) return warn("could not set the download folder; will still capture from ~/Downloads");
  const r = await cdpSend(wsUrl, "Browser.setDownloadBehavior", { behavior: "allow", downloadPath: STAGING, eventsEnabled: false });
  if (r === null) warn("could not set the download folder; will still capture from ~/Downloads");
}

async function ensurePortalTab(): Promise<void> {
  const targets = (await cdpHttp("/json/list")) as any[] | null;
  if (targets?.some((t) => t.type === "page" && PORTAL_HOSTS.test(t.url ?? ""))) return;
  (await cdpHttp(`/json/new?url=${encodeURIComponent(LOGIN_URL)}`, "PUT")) ??
    (await cdpHttp(`/json/new?url=${encodeURIComponent(LOGIN_URL)}`, "GET"));
}

// ------------------------------------------------------------ download watch

interface Captured { path: string; name: string; size: number }

const watchDirs = [STAGING, USER_DOWNLOADS].filter((d) => existsSync(d));
const seen = new Set<string>();      // baseline + already-claimed download paths
const pending = new Map<string, number>(); // path -> last size (stability check)

function snapshotBaseline() {
  for (const dir of watchDirs) for (const f of listFiles(dir)) seen.add(join(dir, f));
}

function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir).filter((f) => !f.startsWith(".") && !/\.(crdownload|tmp|part|download)$/i.test(f));
  } catch {
    return [];
  }
}

/** One poll tick: returns a newly finished download with an allowed extension, if any. */
function pollDownloads(allowedExts: string[]): Captured | null {
  for (const dir of watchDirs) {
    for (const name of listFiles(dir)) {
      const path = join(dir, name);
      if (seen.has(path)) continue;
      const ext = name.split(".").pop()?.toLowerCase() ?? "";
      if (!allowedExts.includes(ext)) continue;
      let size = 0;
      try { size = statSync(path).size; } catch { continue; }
      if (size <= 0) continue;
      if (pending.get(path) === size) {
        pending.delete(path);
        seen.add(path);
        return { path, name, size };
      }
      pending.set(path, size);
    }
  }
  return null;
}

/** New portal-ish files that appeared during the run but were never claimed. */
function unclaimedDownloads(): string[] {
  const out: string[] = [];
  for (const dir of watchDirs) {
    for (const name of listFiles(dir)) {
      const path = join(dir, name);
      if (seen.has(path)) continue;
      if (!/\.(json|pdf|txt|zip)$/i.test(name)) continue;
      out.push(path);
    }
  }
  return out;
}

// ------------------------------------------------------------- file handling

function moveTo(src: string, destName: string): string {
  let dest = join(destDir, destName);
  if (existsSync(dest)) {
    const dot = destName.lastIndexOf(".");
    dest = join(destDir, `${destName.slice(0, dot)} (2)${destName.slice(dot)}`);
  }
  try {
    renameSync(src, dest);
  } catch {
    copyFileSync(src, dest);
    unlinkSync(src);
  }
  return dest;
}

/** DOB (ddmmyyyy) from an already-filed prefill JSON - the TRACES zip password. */
function dobPasswordFromPrefill(): string | null {
  try {
    for (const f of readdirSync(destDir)) {
      if (!/^prefill .*\.json$/i.test(f)) continue;
      const m = readFileSync(join(destDir, f), "utf8").match(/"(?:dob|dateOfBirth)"\s*:\s*"(\d{4})-(\d{2})-(\d{2})"/i);
      if (m) return m[3] + m[2] + m[1];
    }
  } catch {}
  return null;
}

/** If the download is a zip holding exactly one allowed file, unwrap it (trying the TRACES DOB password). */
function maybeUnzip(cap: Captured, allowedExts: string[]): Captured & { note?: string } {
  if (!cap.name.toLowerCase().endsWith(".zip")) return cap;
  const dob = dobPasswordFromPrefill();
  for (const extra of dob ? [[], ["-P", dob]] : [[]]) {
    const tmp = join(STAGING, `unzip-${Date.now()}`);
    if (Bun.spawnSync({ cmd: ["unzip", "-o", "-q", ...extra, cap.path, "-d", tmp] }).exitCode !== 0) continue;
    const inner = listFiles(tmp).filter((f) => allowedExts.includes(f.split(".").pop()?.toLowerCase() ?? ""));
    if (inner.length !== 1) break;
    const path = join(tmp, inner[0]);
    unlinkSync(cap.path);
    return { path, name: inner[0], size: statSync(path).size };
  }
  return { ...cap, note: "zip could not be unwrapped (password-protected or multi-file) - filed as-is, inspect by hand" };
}

/** JSON sanity check; the AIS portal's export is legitimately encrypted, not bad data. */
function verifyCapturedJson(raw: string, artifact: ArtifactKey): string[] {
  if (artifact.startsWith("ais") && looksAisEncrypted(raw))
    return ["AIS JSON is the portal's encrypted export (expected) - PAN is verified at parse time, not here"];
  return verifyJsonArtifact(raw, pan).warnings;
}

// ------------------------------------------------------------------- digest

interface Result { step: StepSpec; status: "filed" | "skipped" | "not-fetched"; dest?: string; size?: number; warnings: string[] }
const results: Result[] = [];
const globalWarnings: string[] = [];
const warn = (w: string) => { globalWarnings.push(w); console.log(`  ! ${w}`); };

function printDigest(gateNote: string) {
  const fmtSize = (n?: number) => (n == null ? "" : n > 1024 * 1024 ? ` (${(n / 1024 / 1024).toFixed(1)} MB)` : ` (${Math.round(n! / 1024)} KB)`);
  console.log(`\n================ harvest digest: ${slug}, AY ${ay} ================`);
  console.log(`identity gate: ${gateNote}`);
  for (const r of results) {
    const mark = r.status === "filed" ? (r.warnings.length ? "⚠" : "✓") : r.step.required ? "✗" : "-";
    console.log(`${mark} ${r.step.key.padEnd(8)} ${r.status === "filed" ? r.dest + fmtSize(r.size) : r.status.toUpperCase()}`);
    for (const w of r.warnings) console.log(`    ! ${w}`);
  }
  for (const w of globalWarnings) console.log(`! ${w}`);
  const stray = unclaimedDownloads();
  if (stray.length) {
    console.log(`unclaimed downloads (file by hand if relevant):`);
    for (const p of stray) console.log(`    ${p}${classifyDownload(basename(p)) ? `  (looks like ${classifyDownload(basename(p))})` : ""}`);
  }
  if (results.some((r) => r.status === "filed" && r.dest?.endsWith(".pdf")))
    console.log(`note: AIS/TIS PDFs open with password PAN lowercase + DOB ddmmyyyy.`);
  const missing = results.filter((r) => r.step.required && r.status !== "filed");
  console.log(missing.length
    ? `INCOMPLETE - still needed: ${missing.map((r) => r.step.key).join(", ")}. Re-run to fetch just those, or download by hand into ${destDir}/.`
    : `complete - next: bun run extract ${clientDir}`);
  console.log(`leave the practice Chrome window open (log out of the portal between clients; the browser itself stays running).`);
}

// -------------------------------------------------------------------- gate

async function identityGate(): Promise<string> {
  if (skipGate) return "SKIPPED (--skip-gate / --no-browser: maintainer self-test only)";
  console.log(`\nWaiting for login: ${nameParts.join(" ")} (${pan}).`);
  console.log(`Log in + OTP in the practice Chrome window. I never touch credential fields.`);
  console.log(`(y + Enter = I confirm the right account is logged in; q + Enter = abort)`);
  let lastNote = 0;
  while (true) {
    const cmd = nextCommand();
    if (cmd === "y") return "confirmed by operator (portal header unreadable)";
    if (cmd === "q") { console.log("aborted before login."); process.exit(1); }
    const texts = await portalPageTexts();
    for (const t of texts) {
      if (t.includes(pan)) return `PAN ${pan} seen in the portal - PASS`;
      const lower = t.toLowerCase();
      if (nameParts.every((p) => lower.includes(p))) return `client name matched in the portal (PAN not shown) - PASS`;
      const foreign = scanPans(t).filter((p) => p !== pan);
      if (foreign.length && Date.now() - lastNote > 15000) {
        lastNote = Date.now();
        console.log(`  !! a DIFFERENT PAN (${foreign[0]}) is on screen - wrong login? Log out and switch, or q to abort.`);
      }
    }
    if (Date.now() - lastNote > 30000) { lastNote = Date.now(); console.log(`  ...still waiting for login`); }
    await Bun.sleep(2500);
  }
}

// -------------------------------------------------------------------- main

console.log(`harvest: ${slug}  AY ${ay}  PAN ${pan}`);
console.log(`filing into: ${destDir}/`);

// --sweep: no browser at all. The operator downloads the documents manually,
// whenever and however they like; this files whatever portal-shaped files are
// sitting in Downloads/staging for THIS client (PAN-guarded, masked PANs ok).
if (opts.sweep === true) {
  const days = Number(opts.days || 7);
  const cutoff = Date.now() - days * 864e5;
  const labelFor: Record<ArtifactKey, StepSpec["label"]> = { prefill: "prefill", "ais-json": "AIS", "ais-pdf": "AIS", "tis-pdf": "TIS", "26as": "26AS" };
  const extsFor: Record<ArtifactKey, string[]> = { prefill: ["json"], "ais-json": ["json"], "ais-pdf": ["pdf"], "tis-pdf": ["pdf"], "26as": ["txt", "pdf", "zip"] };
  const stepsByKey = new Map([...harvestSteps(ay), ...aisPdfFallbackSteps(ay)].map((s) => [s.key, s]));
  const alreadyFiled = (artifact: ArtifactKey) => {
    try {
      return readdirSync(destDir).find(
        (f) => f.startsWith(`${labelFor[artifact]} - ${initials} ${pan}-`) && [...extsFor[artifact], "zip"].includes(f.split(".").pop()?.toLowerCase() ?? ""),
      );
    } catch {
      return undefined;
    }
  };

  const found = new Map<ArtifactKey, { path: string; name: string; mtime: number; size: number }[]>();
  for (const dir of watchDirs) {
    for (const name of listFiles(dir)) {
      if (!/\.(json|pdf|txt|zip)$/i.test(name)) continue;
      const path = join(dir, name);
      let st;
      try { st = statSync(path); } catch { continue; }
      if (!st.isFile() || st.mtimeMs < cutoff) continue;
      const m = sweepClassify(name, pan);
      if (!m) continue;
      if (m.panMatch === "none") { warn(`${path} looks like ${m.artifact} but its PAN is not ${pan} - NOT filed (another client's?)`); continue; }
      if (!found.has(m.artifact)) found.set(m.artifact, []);
      found.get(m.artifact)!.push({ path, name, mtime: st.mtimeMs, size: st.size });
    }
  }

  // Process the prefill FIRST: it lands the DOB the 26AS zip password needs
  // (dobPasswordFromPrefill reads it from the client folder), then the rest.
  const order: ArtifactKey[] = ["prefill", "ais-json", "ais-pdf", "tis-pdf", "26as"];
  const foundSorted = [...found.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  for (const [artifact, candidates] of foundSorted) {
    const existing = alreadyFiled(artifact);
    if (existing) {
      results.push({ step: stepsByKey.get(artifact)!, status: "filed", dest: join(destDir, existing), warnings: [`already in the client folder; new download(s) left untouched: ${candidates.map((c) => c.path).join(", ")}`] });
      continue;
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const [best, ...older] = candidates;
    for (const o of older) warn(`older ${artifact} left in place: ${o.path}`);
    const un = maybeUnzip({ path: best.path, name: best.name, size: best.size }, extsFor[artifact].filter((e) => e !== "zip"));
    const ext = un.name.split(".").pop()!.toLowerCase();
    const warnings: string[] = un.note ? [un.note] : [];
    if (ext === "json") warnings.push(...verifyCapturedJson(readFileSync(un.path, "utf8"), artifact));
    const dest = moveTo(un.path, artifactFileName(labelFor[artifact], initials, pan, ay, new Date(), ext));
    results.push({ step: stepsByKey.get(artifact)!, status: "filed", dest, size: un.size, warnings });
  }
  for (const artifact of ["prefill", "ais-json", "26as"] as ArtifactKey[]) {
    if (results.some((r) => r.step.key === artifact)) continue;
    const existing = alreadyFiled(artifact);
    results.push(existing
      ? { step: stepsByKey.get(artifact)!, status: "filed", dest: join(destDir, existing), warnings: [] }
      : { step: stepsByKey.get(artifact)!, status: "not-fetched", warnings: [] });
  }
  snapshotBaseline(); // everything currently on disk is baseline, not "unclaimed"
  printDigest(`SWEEP - no browser; files taken from ${watchDirs.join(" and ")} (newer than ${days}d)`);
  process.exit(results.some((r) => r.step.required && r.status !== "filed") ? 1 : 0);
}

if (!noBrowser) {
  if (!(await ensureChrome())) process.exit(1);
  await routeDownloadsToStaging();
  await ensurePortalTab();
}
snapshotBaseline();

const gateNote = await identityGate();
console.log(`identity gate: ${gateNote}\n`);

const queue: StepSpec[] = harvestSteps(ay);
let stopped = false;

for (let i = 0; i < queue.length && !stopped; i++) {
  const step = queue[i];
  console.log(`--- ${step.key} ---\n  ${step.guide}\n  waiting for the download... (s = skip, q = stop + digest)`);
  let heartbeat = Date.now();
  while (true) {
    const cmd = nextCommand();
    if (cmd === "q") { stopped = true; results.push({ step, status: "not-fetched", warnings: [] }); break; }
    if (cmd === "s") {
      results.push({ step, status: "skipped", warnings: [] });
      if (step.key === "ais-json") {
        console.log("  falling back to the AIS + TIS PDFs.");
        queue.splice(i + 1, 0, ...aisPdfFallbackSteps(ay));
      }
      break;
    }
    const cap = pollDownloads(step.exts);
    if (cap) {
      const un = maybeUnzip(cap, step.exts.filter((e) => e !== "zip"));
      const ext = un.name.split(".").pop()!.toLowerCase();
      const warnings: string[] = un.note ? [un.note] : [];
      if (ext === "json") warnings.push(...verifyCapturedJson(readFileSync(un.path, "utf8"), step.key));
      const dest = moveTo(un.path, artifactFileName(step.label, initials, pan, ay, new Date(), ext));
      results.push({ step, status: "filed", dest, size: un.size, warnings });
      console.log(`  ✓ filed: ${dest}${warnings.length ? "\n    ! " + warnings.join("\n    ! ") : ""}`);
      break;
    }
    if (Date.now() - heartbeat > 45000) { heartbeat = Date.now(); console.log(`  ...still waiting for ${step.key} (s = skip, q = stop)`); }
    await Bun.sleep(1000);
  }
}

for (const s of queue) if (!results.some((r) => r.step === s)) results.push({ step: s, status: "not-fetched", warnings: [] });

printDigest(gateNote);
process.exit(results.some((r) => r.step.required && r.status !== "filed") ? 1 : 0);
