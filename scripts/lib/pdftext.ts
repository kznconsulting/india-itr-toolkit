// pdftotext wrapper for portal PDFs (AIS/TIS/26AS/intimations).
//
// Handles the password dance so no operator ever has to: portal downloads are
// usually unencrypted, client-emailed copies are locked with PAN+DOB (DDMMYYYY).
// The documented password is lowercase-PAN but uppercase has been seen in the
// wild, so we try: no password, lowercase, uppercase - in that order.

import { spawnSync } from "node:child_process";

export interface PdfTextResult {
  text: string;
  passwordUsed: string | null; // null = file was not encrypted
}

export class PdfTextError extends Error {}

function runPdftotext(pdfPath: string, password?: string): { ok: boolean; text: string; err: string } {
  const args = ["-layout"];
  if (password) args.push("-upw", password);
  args.push(pdfPath, "-");
  const res = spawnSync("pdftotext", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (res.error) {
    throw new PdfTextError(
      "pdftotext is not installed or not on PATH - run `bun run doctor` (docs/porting.md).",
    );
  }
  return { ok: res.status === 0, text: res.stdout ?? "", err: res.stderr ?? "" };
}

/** Extract layout-preserved text, trying the practice's known password patterns. */
export function pdfToText(
  pdfPath: string,
  opts: { pan?: string; dob?: string; password?: string } = {},
): PdfTextResult {
  const candidates: (string | undefined)[] = [undefined];
  if (opts.password) candidates.push(opts.password);
  if (opts.pan && opts.dob) {
    const dob = opts.dob.replace(/\//g, ""); // DD/MM/YYYY -> DDMMYYYY
    candidates.push(opts.pan.toLowerCase() + dob, opts.pan.toUpperCase() + dob);
  }
  let lastErr = "";
  for (const pw of candidates) {
    const res = runPdftotext(pdfPath, pw);
    if (res.ok) return { text: res.text, passwordUsed: pw ?? null };
    lastErr = res.err;
  }
  throw new PdfTextError(
    `could not open ${pdfPath}: tried ${candidates.length} password variant(s) ` +
      `(none, PAN+DOB lower/upper case). pdftotext said: ${lastErr.trim() || "(no message)"}. ` +
      `If the client supplied a different password, pass it explicitly.`,
  );
}

/** "1,10,589" / "110589.00" / "-" -> number | null. Indian digit grouping. */
export function inrAmount(s: string): number | null {
  const t = s.trim();
  if (t === "" || t === "-") return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}
