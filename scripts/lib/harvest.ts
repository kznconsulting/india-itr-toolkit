// Pure helpers for the portal harvester (scripts/harvest-portal.ts).
// Everything here is deterministic and unit-tested; the conductor script owns
// all I/O (CDP, filesystem watching, stdin).

export const PAN_RE = /\b[A-Z]{5}[0-9]{4}[A-Z]\b/g;

export type ArtifactKey = "prefill" | "ais-json" | "ais-pdf" | "tis-pdf" | "26as";

export interface StepSpec {
  key: ArtifactKey;
  /** Label used in the practice filename convention. */
  label: "prefill" | "AIS" | "TIS" | "26AS";
  /** Accepted download extensions (lowercase, no dot). zip is unwrapped first. */
  exts: string[];
  /** True when the step is part of the standard 3-file set. */
  required: boolean;
  guide: string;
}

/** "asha-mehta" -> "AM" */
export function initialsFromSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w[0].toUpperCase())
    .join("");
}

/** "asha-mehta" -> ["asha", "mehta"] (for header-text matching). */
export function namePartsFromSlug(slug: string): string[] {
  return slug.split("-").filter(Boolean).map((w) => w.toLowerCase());
}

/** India AY: April onward belongs to the AY starting that calendar year. */
export function defaultAY(now: Date): string {
  const start = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
  return `${start}-${String(start + 1).slice(2)}`;
}

export function ayStartYear(ay: string): string {
  const m = ay.match(/^(\d{4})-(\d{2})$/);
  if (!m) throw new Error(`bad assessment year "${ay}" (want e.g. 2026-27)`);
  const start = Number(m[1]);
  if ((start + 1) % 100 !== Number(m[2])) throw new Error(`assessment year "${ay}" is not consecutive`);
  return m[1];
}

/** `prefill - AM AAAPZ8888Z-2026 - 21.07.2026.json` per the practice convention. */
export function artifactFileName(
  label: StepSpec["label"],
  initials: string,
  pan: string,
  ay: string,
  date: Date,
  ext: string,
): string {
  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  return `${label} - ${initials} ${pan}-${ayStartYear(ay)} - ${dd}.${mm}.${date.getFullYear()}.${ext}`;
}

/** All PAN-shaped tokens in a blob of text, deduped, expected one first. */
export function scanPans(text: string): string[] {
  return [...new Set(text.match(PAN_RE) ?? [])];
}

export interface VerifyResult {
  ok: boolean;
  warnings: string[];
}

/** Cheap sanity check on a downloaded JSON artifact; deep parsing is extract's job. */
export function verifyJsonArtifact(raw: string, expectedPan: string): VerifyResult {
  const warnings: string[] = [];
  try {
    JSON.parse(raw);
  } catch {
    return { ok: false, warnings: ["does not parse as JSON - re-download it"] };
  }
  const pans = scanPans(raw);
  if (!pans.includes(expectedPan)) warnings.push(`expected PAN ${expectedPan} not found in the file`);
  const foreign = pans.filter((p) => p !== expectedPan).slice(0, 3);
  if (foreign.length && !pans.includes(expectedPan))
    warnings.push(`file mentions other PAN(s): ${foreign.join(", ")} - WRONG CLIENT? do not run extract until resolved`);
  return { ok: warnings.length === 0, warnings };
}

/** Best-effort artifact guess for unclaimed downloads in the digest. */
export function classifyDownload(fileName: string): ArtifactKey | null {
  const f = fileName.toLowerCase();
  // TRACES text-export zip/txt is named `<PAN>-<year>` with no artifact marker;
  // match it FIRST so a PAN containing "ais"/"tis" cannot misclassify.
  if (/^[a-z]{5}\d{4}[a-z]-\d{4}(\s*\(\d+\))?\.(zip|txt)$/.test(f)) return "26as";
  if (f.includes("prefill") || /^itr.*\.json$/.test(f)) return "prefill";
  if (f.includes("tis")) return "tis-pdf";
  if (f.includes("ais")) return f.endsWith(".json") ? "ais-json" : "ais-pdf";
  if (f.includes("26as") || f.includes("annual tax statement") || f.includes("taxstatement")) return "26as";
  return null;
}

/** The AIS portal's JSON export is encrypted: 64 hex chars then base64 ciphertext. */
export function looksAisEncrypted(raw: string): boolean {
  return /^[0-9a-f]{64}[A-Za-z0-9+/=]/.test(raw.slice(0, 100));
}

export interface SweepMatch {
  artifact: ArtifactKey;
  panMatch: "exact" | "masked" | "none";
}

/**
 * Classify a Downloads-folder file for sweep mode and check it belongs to this
 * client. Portal filenames embed the PAN, but some portals mask it
 * (XXXPG9762X for AGEPG9762H) - the middle six characters survive masking.
 */
export function sweepClassify(fileName: string, pan: string): SweepMatch | null {
  const artifact = classifyDownload(fileName);
  if (!artifact) return null;
  const upper = fileName.toUpperCase();
  if (upper.includes(pan.toUpperCase())) return { artifact, panMatch: "exact" };
  if (new RegExp(`[A-ZX]{3}${pan.slice(3, 9).toUpperCase()}[A-ZX]`).test(upper)) return { artifact, panMatch: "masked" };
  return { artifact, panMatch: "none" };
}

export function harvestSteps(ay: string): StepSpec[] {
  return [
    {
      key: "prefill",
      label: "prefill",
      exts: ["json", "zip"],
      required: true,
      guide: [
        `e-File > Income Tax Returns > File Income Tax Return > select AY ${ay} >`,
        `choose OFFLINE mode > "Download Pre-filled Data".`,
        `Do NOT continue into an actual filing - leave the flow once the download starts.`,
      ].join("\n  "),
    },
    {
      key: "ais-json",
      label: "AIS",
      exts: ["json", "zip"],
      required: true,
      guide: [
        `Services > Annual Information Statement > proceed to the AIS portal >`,
        `download the JSON export for FY ${fyForAy(ay)}.`,
        `If this client has no JSON export, type s - the script will fall back to the AIS + TIS PDFs.`,
      ].join("\n  "),
    },
    {
      key: "26as",
      label: "26AS",
      exts: ["pdf", "txt", "zip"],
      required: true,
      guide: [
        `e-File > Income Tax Returns > View Form 26AS > agree > proceed to TRACES >`,
        `select AY ${ay} > download as PDF (Text export also accepted). Never the HTML view.`,
      ].join("\n  "),
    },
  ];
}

export function aisPdfFallbackSteps(ay: string): StepSpec[] {
  const fy = fyForAy(ay);
  return [
    {
      key: "ais-pdf",
      label: "AIS",
      exts: ["pdf", "zip"],
      required: false,
      guide: `In the AIS portal, download the AIS PDF for FY ${fy}.`,
    },
    {
      key: "tis-pdf",
      label: "TIS",
      exts: ["pdf", "zip"],
      required: false,
      guide: `In the AIS portal, download the TIS PDF for FY ${fy}.`,
    },
  ];
}

/** AY 2026-27 covers FY 2025-26. */
export function fyForAy(ay: string): string {
  const start = Number(ayStartYear(ay));
  return `${start - 1}-${String(start).slice(2)}`;
}
