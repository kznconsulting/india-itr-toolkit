import { describe, expect, test } from "bun:test";
import {
  aisPdfFallbackSteps,
  artifactFileName,
  ayStartYear,
  classifyDownload,
  defaultAY,
  fyForAy,
  harvestSteps,
  initialsFromSlug,
  looksAisEncrypted,
  namePartsFromSlug,
  scanPans,
  sweepClassify,
  verifyJsonArtifact,
} from "./harvest";

describe("slug helpers", () => {
  test("initials", () => {
    expect(initialsFromSlug("asha-mehta")).toBe("AM");
    expect(initialsFromSlug("rohan-kumar")).toBe("RK");
    expect(initialsFromSlug("x")).toBe("X");
  });
  test("name parts", () => {
    expect(namePartsFromSlug("asha-mehta")).toEqual(["asha", "mehta"]);
  });
});

describe("assessment year", () => {
  test("July belongs to the AY starting that year", () => {
    expect(defaultAY(new Date(2026, 6, 21))).toBe("2026-27");
  });
  test("February belongs to the prior AY", () => {
    expect(defaultAY(new Date(2026, 1, 10))).toBe("2025-26");
  });
  test("start year and FY", () => {
    expect(ayStartYear("2026-27")).toBe("2026");
    expect(fyForAy("2026-27")).toBe("2025-26");
    expect(() => ayStartYear("2026-28")).toThrow();
    expect(() => ayStartYear("26-27")).toThrow();
  });
});

describe("artifact naming", () => {
  test("matches the practice convention", () => {
    expect(artifactFileName("prefill", "GG", "AAAPZ8888Z", "2026-27", new Date(2026, 6, 21), "json")).toBe(
      "prefill - GG AAAPZ8888Z-2026 - 21.07.2026.json",
    );
    expect(artifactFileName("26AS", "VG", "AAAPZ8888Z", "2025-26", new Date(2026, 0, 5), "pdf")).toBe(
      "26AS - VG AAAPZ8888Z-2025 - 05.01.2026.pdf",
    );
  });
});

describe("PAN scanning and JSON verification", () => {
  test("scanPans dedupes and ignores non-PAN tokens", () => {
    expect(scanPans("pan AAAPZ8888Z ifsc HDFC0001234 tan BLRA12345C again AAAPZ8888Z")).toEqual([
      "AAAPZ8888Z",
      // BLRA12345C is TAN-shaped (4+5+1) and must NOT match the PAN pattern
    ]);
  });
  test("valid JSON with the expected PAN passes", () => {
    expect(verifyJsonArtifact('{"pan":"AAAPZ8888Z"}', "AAAPZ8888Z")).toEqual({ ok: true, warnings: [] });
  });
  test("non-JSON fails", () => {
    const r = verifyJsonArtifact("<html>session expired</html>", "AAAPZ8888Z");
    expect(r.ok).toBe(false);
    expect(r.warnings[0]).toContain("does not parse");
  });
  test("wrong-client file warns loudly", () => {
    const r = verifyJsonArtifact('{"pan":"ZZZPX9999A"}', "AAAPZ8888Z");
    expect(r.ok).toBe(false);
    expect(r.warnings.join(" ")).toContain("ZZZPX9999A");
    expect(r.warnings.join(" ")).toContain("WRONG CLIENT");
  });
});

describe("download classification", () => {
  test("guesses artifacts from portal filenames", () => {
    expect(classifyDownload("AIS_AAAPZ8888Z_2025-26.json")).toBe("ais-json");
    expect(classifyDownload("TIS_AAAPZ8888Z.pdf")).toBe("tis-pdf");
    expect(classifyDownload("AnnualTaxStatement_26AS.pdf")).toBe("26as");
    expect(classifyDownload("holiday-photos.heic")).toBeNull();
  });
  test("real portal names seen in calibration (2026-07)", () => {
    expect(classifyDownload("AAAPZ8888Z-Prefill-2026-21_61_2026_15_59.json")).toBe("prefill");
    expect(classifyDownload("XXXPZ8888X_2025-26_AIS_21072026.json")).toBe("ais-json");
    expect(classifyDownload("AAAPZ8888Z-2026.zip")).toBe("26as"); // TRACES text export
    expect(classifyDownload("AAAPZ8888Z-2026.txt")).toBe("26as");
    expect(classifyDownload("AAAPZ8888Z-2026 (1).zip")).toBe("26as"); // browser duplicate
    expect(classifyDownload("TAISX1234A-2026.zip")).toBe("26as"); // PAN containing "ais" must not misclassify
  });
});

describe("sweep classification", () => {
  const pan = "AAAPZ8888Z";
  test("exact PAN in the filename", () => {
    expect(sweepClassify("AAAPZ8888Z-Prefill-2026-1.json", pan)).toEqual({ artifact: "prefill", panMatch: "exact" });
  });
  test("masked PAN (portal masks first three and last char)", () => {
    expect(sweepClassify("XXXPZ8888X_2025-26_AIS_21072026.json", pan)).toEqual({ artifact: "ais-json", panMatch: "masked" });
  });
  test("wrong client is flagged, not filed", () => {
    expect(sweepClassify("ZZZZK1111A-Prefill-2026-1.json", pan)).toEqual({ artifact: "prefill", panMatch: "none" });
  });
  test("non-portal files ignored", () => {
    expect(sweepClassify("invoice-2026.pdf", pan)).toBeNull();
  });
});

describe("AIS encrypted-export detection", () => {
  test("hex header + base64 body is the encrypted shape", () => {
    expect(looksAisEncrypted("a".repeat(64) + "rm/3qUNZG6EgB8YBNkQ0iE==")).toBe(true);
    expect(looksAisEncrypted("baa8b3108aae8db48ad909f12a0488634f9b141c71c739d6ffb8e1b649c0488a" + "AAAA")).toBe(true);
  });
  test("plain JSON is not", () => {
    expect(looksAisEncrypted('{"pan":"AAAPZ8888Z"}')).toBe(false);
  });
});

describe("step specs", () => {
  test("standard set is prefill + AIS JSON + 26AS", () => {
    expect(harvestSteps("2026-27").map((s) => s.key)).toEqual(["prefill", "ais-json", "26as"]);
    expect(harvestSteps("2026-27").every((s) => s.required)).toBe(true);
  });
  test("fallback set is the two PDFs", () => {
    expect(aisPdfFallbackSteps("2026-27").map((s) => s.key)).toEqual(["ais-pdf", "tis-pdf"]);
  });
  test("guides mention the right AY and FY", () => {
    const [prefill, ais] = harvestSteps("2026-27");
    expect(prefill.guide).toContain("2026-27");
    expect(ais.guide).toContain("2025-26");
  });
});
