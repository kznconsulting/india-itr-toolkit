# Maintainer handbook

Everything about EXTENDING the toolkit. Operators never need this file - that is the point: AGENTS.md stays lean (every operator session pays for it on every request), and the thinking lives here and in the scripts. Read this on the maintainer's machine when adding capability, fixing a parser, or onboarding a new assessment year.

## Design principles

The toolkit runs under a smaller model (Sonnet) on the operator's machine (docs/porting.md):

- **Logic lives in scripts, not in-session reasoning.** Operator model work is limited to resolving extraction gaps and reviewing flagged items. Everything else is deterministic and self-verifying. When you find the operator model doing repeated in-session work, that is a missing script feature - build it here, with tests.
- **Token discipline is a design constraint.** Script stdout is a digest, not a log: one line per passing step, full detail only on failure, counts instead of per-item noise (see the pruned-template-keys summary in generate-itr.py for the pattern). Failure messages must name the ONE next action - a Sonnet operator will otherwise retry-loop (the STCG endless loop of July 2026 is the cautionary tale; the "two strikes, then park" rule in AGENTS.md is the behavioral backstop, `die_gap()`/PARK in the builders is the mechanical one).
- **Scripts are generic across clients** - client specifics belong in the client's data file, never hardcoded.
- **Self-verification over trust**: builders re-evaluate what they wrote and assert against reconciliation targets; parsers keep line items only when they sum exactly to the category target.
- **Tax rules are single-source** in `scripts/lib/tax.ts`; Python reads them via `bun scripts/tax-cli.ts`. Never duplicate slab numbers.
- **Guards are load-bearing.** The generator and rule checker abort on surcharge income, surviving special-rate gains, old regime, multiple business items, non-ITR-3. A guard firing on an operator machine = park + gap-ledger entry; extending the guard consciously happens here, with validation figures from a real filed return.

## Extraction architecture (the operator-token work of 2026-07)

```
/fetch-portal-docs -> clients/<slug>/: prefill.json + AIS.json + 26AS.pdf   (the standard 3;
                      TIS/AIS PDFs are fallback-only when the AIS JSON is absent or unusable)
bun run extract    -> scripts/extract-data.ts (orchestrator; AIS-JSON-primary source selection)
                      lib/aisjson.ts   PRIMARY source once implemented - PENDING the first real
                                       portal AIS JSON. Must yield the TisParseResult shape
                                       (targets + line items) plus CG lots and SFT-018 quarters;
                                       kills the pdftotext layout-damage class of bugs.
                      lib/tis.ts       FALLBACK targets source (TIS front-page totals -> the
                                       reconciliation block; annexure line items kept only if
                                       they sum to the target)
                      lib/f26as.ts     26AS Part I deductors + txn rows; reversal netting; s.194
                                       payment dates -> 234C period columns (periodsFromRows);
                                       Parts II-X with content -> park flag
                      lib/intimation.ts 143(1) intimation -> authoritative 244A interest + CPC
                                       principal + filed-vs-computed diffs (s.245 adjustments and
                                       demand orders -> loud flags); extract prefers it over the
                                       prefill CPC row and cross-checks the two
                      lib/pdftext.ts   pdftotext wrapper; tries no-password, PAN+DOB lower, upper
                      parse-ais-cg.py  FALLBACK CG source (AIS PDF layout parse)
                   -> AY<yyyy-yy>-statement-data.json draft with _gaps[] + printed digest
```

- **Carry-forward sidecar**: every verified statement build writes `AY<ay>-carryforward.json` next to
  the data file (computed GTI per regime, TDS, the loss set-off applied and next year's
  brought-forward figure + lossHistory row). Next year's extract consumes it to auto-fill
  `priorYear.gti` and roll the capital loss forward (idempotent history append) - killing the two
  recurring judgment gaps. No sidecar -> those gaps fall back to manual with a hint to rebuild the
  prior statement.

- `_gaps` is the safety interlock: build-statement.py and generate-itr.py refuse while it is non-empty, so a draft can never be filed with placeholder data. Gap text is written for the operator: one action each.
- Fixtures: `samples/sample-tis-layout.txt` / `sample-26as-layout.txt` (fictitious, structurally faithful; tests in scripts/lib/*.test.ts). The real-world validation fixture is a real client's AY 2026-27 file set: extract's draft reproduced the hand-built file's every figure (incl. per-quarter 234C periods) and built green.
- Name matching (extract-data.ts `namesMatch`): token-subset either way after dropping generic tokens, squashed equality, acronym ("PNB" ~ "PUNJAB NATIONAL BANK"), MF-registrar strip ("Computer Age Management Services Limited - X" -> X, AMC/MF normalization). A failed match only costs a gap/flag, never wrong data.
- TIS categories are classified three ways in lib/tis.ts: TARGETS (modelled income -> reconciliation keys), INFORMATIONAL (purchases/cash flows - listed, no action), everything else -> park flag. When a new legitimate category appears, add it to the right list.

## Tax engine

`scripts/lib/tax.ts` covers AY 2025-26 and 2026-27: slabs plus 111A/112A special-rate gains via `computeTotalTax()` (rate split at 23-07-2024, Rs. 1.25L 112A exemption, resident-only basic-exemption adjustment, NRI 87A gate; validated against a real filed NRI ITR-2 - see tax.test.ts). NOT modelled: s.112 non-equity LTCG, AMT, surcharge marginal relief on mixed special-rate income. It is a cross-check aid, NOT authoritative - the portal computation governs. Add each new AY's rules there after the Finance Act.

- 87A/special-rate interplay (new regime): the eligibility threshold looks at TOTAL income including 111A/112A gains, but the rebate only offsets slab-rate tax; old regime can offset 111A (never 112A, s.112A(6)) with the leftover cap. Encoded in `computeTotalTax()`.
- NRI clients: no 87A at any income, old-regime slabs at the base exemption, no basic-exemption adjustment against special-rate gains. NRI savings-bank interest carries s.195 TDS (`interest.savingsTds`, target `tisSavingsInterestTds`) - residents never have TDS on savings.
- 244A refund interest: principal floored to Rs. 100 (rule 119A), 0.5%/month, from April of the AY (or the filing month if belated), part-month = full month. Verified against a real intimation.

## Schema-drift gotchas (extraction/generation)

- The ITD JSON schema drifts between AYs and forms. `scripts/lib/extract.ts` uses candidate-key lookups (`get(obj, "A.B", "C.D")`); when a real file arrives with different keys, extend the candidate lists rather than renaming.
- ITR-2 nests income totals under `"PartB-TI"` (hyphen). Numeric fields sometimes arrive as strings; always coerce through `num()`.
- Regime flag: newer schemas use `OptOutNewTaxRegime` ("Y" = opted OUT into old regime); older ones `NewTaxRegime`. `detectRegime()` handles both.
- The prefill JSON is its own camelCase format: Aadhaar base64-encoded, TDS section codes compressed (`4JB` = 194J(b)). The CPC refund-interest row lives at `incDeductionsOthIncCPC[]` (variants: `form26as.incomeDeductionsOthersInc[]`, `insights.incomeDeductionsOthersInc[]`) with `othSrcNatureDesc == "TAX"`. `compare-prefill.py` normalizes; don't "fix" cosmetic differences.
- generate-itr.py prunes template keys absent from the target schema, classified four ways: zero/empty drops (one summary line), known renames from `RENAMED_KEYS` whose survivor verifiably holds the identical value (one line - the generator dual-writes old+new names on purpose, e.g. `Balance112AAE`/`Balance112A`), label-only strings with no amounts under them (one line, names listed), and everything else - a NONZERO drop that warns individually and must be chased (add the rename to `RENAMED_KEYS` + the dual-write once confirmed). AY 2026-27 examples: the 112A before/after-23-07 split fields collapsed to unsuffixed names, `ShareTransferredOnOrBefore` -> `ShareOnOrBefore`, `ScheduleEI.OthersInc` -> `OthersIncDtls[]`.
- ITR-1 extraction is tested against `samples/sample-itr1.json`; ITR-3 against a real filed return; ITR-2 paths are best-effort and untuned - expect nulls and fix `extractItr2` when the first real ITR-2 lands.
- The prior-year FILED return is the control: it must always pass `bun run check`.

## Source-document notes

- Standard harvest is 3 files (prefill JSON + AIS JSON + 26AS); TIS/AIS PDFs are fallback-only. For 26AS the target format is the TRACES TEXT export (delimited `^` machine format, the only option for very large statements) and extract now PREFERS it (lib/f26astext.ts) - the PDF (lib/f26as.ts) is the fallback; HTML never (rendered view, truncates). The text parse is strictly cleaner than the PDF parse (one real AY 2026-27 client: 37 deductors, 0 flags text vs 4 flags PDF from pdftotext layout damage). Rationale: the prefill uniquely carries identity/banks/CPC refund interest, the AIS JSON carries all line-item detail + CG lots, and 26AS uniquely carries booking status (F/U/P/O) + reversal detail - TRACES is authoritative for TDS credits, so 26AS never drops. TIS is a derived aggregation of AIS (fallback targets source until the AIS-JSON parser lands, and its validation control afterwards). All the historical pdftotext gotchas (wrapped CG rows, stranded fragments, password case) are handled inside the parsers - the password dance (lowercase-PAN+DOB first, then uppercase) lives in lib/pdftext.ts.
- Gather phase: no public API (ERI channel needs intermediary registration); login is per-client, OTP-gated, sessions idle out ~15 min. `scripts/harvest-portal.ts` (BUILT - see "Portal harvester" below) conducts the gather with zero model tokens; /fetch-portal-docs runs it when present and browser-drives only as the fallback, with a one-login-one-harvest rule.
- 26AS reversal rows (remark `G`) net inside each deductor's header total; AIS marks superseded rows `Inactive` (count only `Active`); TIS deduplicates SFT-vs-TDS double listings in "Processed by System" - the parsers rely on these invariants and flag when sums disagree.
- **AIS-JSON is encrypted** (lib/aisjson.ts, built 2026-07-21): AES-256-CBC + PBKDF2-HMAC-SHA256 keyed on the taxpayer's PAN+DOB - the AIS Utility's own public scheme. Layout `[32 hex IV][32 hex salt][base64 ciphertext]`; key = `PBKDF2(pan.toLowerCase() + "GQ39%*g" + ddmmyyyy, salt, 1000, 32, sha256)`; AES-256-CBC/PKCS7. The `"GQ39%*g"` middle constant is baked into the utility and can change across versions, so decryption is verified by "does it parse as JSON," never assumed. Decrypted shape: `partA` (identity, FLAT columnData), `header.columnData=["2025-26"]` (FY), `partB.sections` B1 (TDS/TCS), B2 (SFT), B3 (tax paid), B4 (demand/refund - prior-year principal, NOT 244A), B7 (misc). Each info element carries an `l2` aggregate (one row per payer/scrip - a category spans MANY elements, so aggregate across elements) and an `l1` per-transaction detail (with `status` Active/Inactive). Reconciliation dedup = sum-within-code, max-across-codes. The SOS (securities-sale) `l1` carries per-lot cost + ISIN + ST/LT + off-market + grandfathering FMV, so `readCapitalGainsLots`/`groupCapitalGains` build the `capitalGains` rows straight from JSON (parse-cg's shape + grouping; parse-cg is now fallback-only for client-emailed PDFs / historical years). Category classification is imported from tis.ts so AIS and TIS never diverge.
- Dividend TDS threshold Rs. 10,000 from FY 2025-26 - small dividends legitimately have no TDS row.
- 234C period columns (statement Excel): `L` <=15/6, `M` 16/6-15/9, `N` 16/9-15/12, `O` 16/12-15/3, `P` 16/3-31/3. Dividends: filled deterministically from 26AS s.194 transaction dates; SFT-015-only scrips have no payment date (annual filing date only - never allocate from it). Capital gains (GAP-016): each lot bucketed from its `saleDate` at build time (`_period_col` in build-statement.py, `salePeriodColumn` in lib/tax.ts for the guide; FY-validated, hard stop on bad dates), per-section totals anchored in the build's self-verification.

## Portal harvester (harvest-portal.ts)

- v1 design, on purpose: **zero DOM selectors** (the operator does every portal click from printed guides - portal menus drift, humans don't) and **zero dependencies** (raw CDP over Bun's built-in WebSocket/fetch; no Playwright until a selector-driven v2 earns it). The script owns what must be exact: practice-Chrome lifecycle (attach-only on port 9992, profile `~/.india-taxes-chrome`, never owns the process - see AGENTS.md "Portal browser sessions"), the PAN identity gate, download capture (CDP `Browser.setDownloadBehavior` routes into `~/.india-taxes-chrome/downloads`, `~/Downloads` watched as backup, two-tick size-stability polling so it captures no matter who clicked), zip unwrapping, PAN verification, convention naming, AY-subfolder-aware filing, digest + exit code. Pure logic lives in `scripts/lib/harvest.ts` (unit-tested); `harvest-portal.ts` is I/O only.
- Testing harvest-portal (maintainer machine, no portal login needed):
  1. `bun test scripts/lib/harvest.test.ts` - naming, AY math, PAN scan/verify, step specs.
  2. Headless-ish end-to-end (no Chrome): `mkdir -p clients/harvest-selftest`, then pipe commands and fake downloads:
     `(sleep 2; cp samples/sample-itr1.json ~/.india-taxes-chrome/downloads/x.json; sleep 5; echo s; sleep 1; echo s; sleep 1; echo s; sleep 1; cp samples/sample-26as-layout.txt ~/.india-taxes-chrome/downloads/y.txt; sleep 5) | bun run harvest clients/harvest-selftest --pan AAAPZ9999Z --ay 2025-26 --no-browser`
     Expect: prefill + 26AS filed under convention names, AIS marked skipped with the PDF-fallback steps offered, digest INCOMPLETE, exit 1. Drop a wrong-PAN file (samples/sample-statement-data.json, PAN AAAPZ8888Z) to see the WRONG CLIENT warning; zip a JSON to see unwrapping. Files already in the staging dir at start are baseline and ignored - use fresh names.
  3. Live CDP layer: `bun run harvest clients/harvest-selftest --pan AAAPZ9999Z` spawns the practice Chrome at the portal login; check no "could not set the download folder" warning (download routing OK), any file downloaded in that window gets captured, `q` aborts cleanly. `curl http://127.0.0.1:9992/json/list` shows the portal tab.
  4. The real-portal calibration (gate auto-pass on PAN/name, real artifact set) can only happen with an actual login - first operator run of the season is the verification, reconciled against the ledger entry's validation numbers.
  Clean up after: `pkill -f "user-data-dir=$HOME/.india-taxes-chrome"; rm -rf clients/harvest-selftest ~/.india-taxes-chrome/downloads/*`.

## Gap-ledger protocol (docs/missing-functionality.md)

The ledger tracks capability gaps through three sections an entry moves between, keeping its `GAP-NNN` id (next free number, chronological): **OPEN** (the backlog, priority order, operator-appended at the top) -> **IMPLEMENTED - awaiting operator verification** (newest first) -> **VERIFIED** (a permanent table: capability, validation figures, asserting test). Qualifiers: `[needs-real-data]` (blocked on a real example), `[speculative]` (guard exists, no blocked client yet).

Conventions that keep it from becoming a scratchpad again:

- **Entries are tickets, not diaries.** Symptom / Spec / Validation figures, plus a `Trail:` of dated one-liners as it moves. Implementation narrative lives in the commit message and the code; the Trail line just points there. Reference material (encryption schemes, format layouts) goes in this handbook, not in entries.
- **Validation figures are the permanent artifact.** They are what unit tests cite; when an entry reaches VERIFIED it collapses into the table but the figures are never trimmed. Figures only - the ledger's PII policy (no client names/slugs, no identity) is enforced by the human-reviewed commit that publishes an entry.
- **Cross-reference by id** (`GAP-003 has the validated step order`), never by "the entry below".
- **Direction - GitHub issues**: once the public repo (kznconsulting/india-itr-toolkit) is live, generalizable OPEN entries get mirrored as labeled public issues (`gap`, `needs-real-data`, `speculative`) by the maintainer, and community requests arrive there. Operator escalation STAYS in this file - it is git-native, works offline, and keeps the figures-only PII gate behind a reviewed commit. The VERIFIED table stays in-repo forever regardless: issues close and get buried; the tests' cited figures must live next to the tests.

## Public release sync (kznconsulting/india-itr-toolkit)

The public repo is a one-way, maintainer-curated export of this one. The `public-release`
branch holds its entire history: one squashed "Initial public release" commit (the
fresh-history firewall - the practice repo's history, with its operator authorship and
old client-name blobs, is never published), then ONE tree-copy commit per release batch.
Public history is deliberately batch-grained: adopters see features landing, not the
practice's operational trail. The operator never touches the public repo - escalation
stays in the gap ledger (see "Direction - GitHub issues" above).

- `scripts/release-public.sh` is the only sync path. Dry-run by default (PII scans +
  outgoing diff); `--commit -m "<curated message>"` writes the release commit,
  re-authored to the public identity taken from the branch's own prior commits (so the
  local machine's git config can never leak), with a `Synced-from: <master sha>` trailer
  the next run uses to list the batch. It never pushes: publishing is
  `git push public public-release:master`, a per-release maintainer decision.
- Scans hard-fail the sync: PAN-shaped strings outside the fictitious fixtures
  (samples/, schemas/, tests), any tracked file under clients/, and every pattern in
  `.release-scan-terms` - a GITIGNORED maintainer-local file (one case-insensitive
  regex per line) covering client names, operator identity, and machine hostnames.
  The terms themselves are PII, which is why that file must never be committed; keep
  it current - new client means adding the name parts before the next sync.
- Ledger validation figures (real filed-return amounts, "client A/B") ship publicly by
  design: the PII gate is names/identifiers, enforced when entries are written and
  re-checked here; amounts are what the unit tests cite.
- The divergence guard refuses to run when public/master has commits missing from
  public-release (someone merged an external PR). The tree-copy model assumes zero
  external commits; the first accepted community PR means revisiting the model -
  cherry-picking into master preserves content but clobbers contributor authorship,
  so don't do that silently. Never force-push public.

## Housekeeping

- New AY: download the schema, schema-change doc, and validation-rules PDF from incometax.gov.in -> Downloads into `schemas/AY<yyyy-yy>/`; add engine rules; re-run the prior-year control.
- Keep AGENTS.md lean: additions there must earn their per-session cost for the OPERATOR. Maintainer knowledge goes here; per-procedure detail goes in the runbook the digest points to.
- `.machine-role` (gitignored) is set to `operator` during porting (docs/porting.md); its absence marks the maintainer machine.
