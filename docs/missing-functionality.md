# Toolkit gap ledger (operator <-> maintainer sync)

Capability gaps, tracked **OPEN -> IMPLEMENTED -> VERIFIED** (sections below; an entry
moves between sections, keeping its id). Qualifiers in brackets: `[needs-real-data]`
(blocked on a real example), `[speculative]` (no blocked client yet).

- **Operator**: when a guard parks a client - `git pull`, append a `GAP-NNN` entry (next
  free id) at the TOP of OPEN using the template, commit+push just that, move to the
  next client (AGENTS.md "Escalate, don't extend").
- **Maintainer**: implement with unit tests asserting the entry's validation figures,
  then move the entry to IMPLEMENTED and add a dated Trail line. Implementation detail
  lives in the commit and the code, not here.
- **Operator**: re-run the parked client; on reconciliation add the dated Trail line and
  move the entry to VERIFIED (it collapses into the table; validation figures are
  permanent - they are what the tests cite).

Entries carry figures only - never PAN, Aadhaar, bank accounts, addresses, co-owner
identities, or client names/slugs (refer to clients as "client A" / "client B").
Always `git pull` before editing. Full conventions: docs/maintainer.md "Gap-ledger
protocol".

Template:

```markdown
### GAP-NNN <short title>  [qualifier]
- Shape: <date, machine; blocked client shape - figures only, no identity>
- Symptom: <guard message, or what could not be computed>
- Spec: <what needs to exist: sections, rates, schema fields, ordering rules>
- Validation figures: <real filed-return amounts the implementation must reproduce>
- Trail: <date> reported -> <dated one-liners as the entry moves>
```

---

## OPEN (priority order; append new entries at the top)

### GAP-005 ITR-2 generation
- Shape: 2026-07-20, operator; NRI client, ITR-2, equity CG + co-owned house property
  (statement + guide paths work; only full JSON generation is blocked).
- Symptom: `generate-itr.py` is ITR-3-only per its own guard. ITR-2 clients stay on the
  `statement` + `guide` (portal online-mode) path.
- Spec: needs a filed ITR-2 as template plus the BE/AE leg mapping: `ScheduleSI` paired
  `1A_BE`/`1A` (111A) and `2A_BE`/`2A` (112A) rows; `ScheduleCGFor23` mirrors the split
  (`EquityMFonSTTDtls_BE`/`EquityMFonSTTDtls`, `BalanceCGTransferBE`/`BalanceCGTransferAE`).
  Special-rate tax feeds `PartB_TTI.ComputationOfTaxLiability.TaxAtSpecialRates`
  alongside (not blended with) `TaxAtNormalRatesOnAggrInc`. NRI schema fields to carry:
  `FilingStatus.ResidentialStatus` ("NRI"), `ConditionsResStatus`,
  `TotalPrStayIndiaPrevYr`, `TotalPrStayIndia4PrecYr`,
  `JurisdictionResPrevYr.JurisdictionResPrevYrDtls[]` (foreign TIN + country),
  `PartB_TTI.AssetOutIndiaFlag`.
- Validation figures: GAP-002's filed AY 2025-26 ITR-2 reconciliation applies to a
  generated JSON.
- Trail: 2026-07-20 reported.

### GAP-006 s.24(b) home-loan interest on house property  [needs-real-data]
- Symptom: `IntOnBorwCap` exists in the schema; the arithmetic is coded nowhere, and the
  only real data point so far is Rs. 0, which validates nothing.
- Spec: deduct 24(b) interest after the 30% deduction u/s 24(a) (GAP-003 has the
  validated step order). Do not trust an implementation until a real non-zero example
  reconciles.
- Trail: 2026-07-19 reported alongside GAP-003; blocked on a real non-zero data point.

### GAP-007 s.112 non-equity LTCG (property, pre-2023 debt funds, gold)  [speculative]
- Symptom: builder and guide refuse capital-gains items whose `assetClass` is not
  "equity" (the AIS parser tags them automatically).
- Spec: s.112 rates incl. the 23-07-2024 change (20% with indexation before / 12.5%
  without after; land-and-building grandfathering choice for pre-change acquisitions).
- Trail: no blocked client yet.

### GAP-008 Surcharge above Rs. 50L total income  [speculative]
- Symptom: builder and guide abort when TOTAL income (incl. special-rate gains) exceeds
  Rs. 50,00,000. `computeTotalTax()` prices the 15%-capped surcharge on special-rate tax
  but NOT marginal relief on mixed income.
- Trail: no blocked client yet.

### GAP-009 Fresh net capital losses  [speculative]
- Symptom: a current-year net ST loss, or a fresh net LT loss, aborts the build
  (set-off ordering across legs and new-loss carry-forward are not modelled; only
  brought-forward LT loss set-off is).
- Trail: no blocked client yet.

## IMPLEMENTED - awaiting operator verification (newest first)

### GAP-017 build-statement.py reconciliation checks use strict equality, no paisa tolerance
- Shape: 2026-07-22, operator; NRI client, ITR-2, 58 AIS-JSON capital-gains lots
  (short-term + long-term) reconciled against `reconciliation.tisSecuritiesSale`.
- Symptom: `build-statement.py`'s reconciliation loop (`if want is not None and got !=
  want`) aborts: "reconciliation failed - securities sale vs TIS: data sums to
  12526295.9, target says 12526296." The two figures differ by exactly Rs. 0.10 - a
  paisa-rounding gap between the sum of itemized AIS lots (each already at full paisa
  precision, confirmed via `Decimal` - no floating-point artifact) and the TIS aggregate
  figure. There is no more-precise source figure to fetch; re-running extract cannot
  change this. `scripts/lib/aisjson.ts`'s own CAPITAL-GAINS MISMATCH guard already
  tolerates up to Rs. 0.50 on this exact same comparison (line ~526,
  `Math.abs(lotSaleTotal - reconciliation.tisSecuritiesSale) > 0.5`) - the extraction
  step accepted this data as reconciled; the statement builder's stricter check then
  rejects it.
- Spec: give `build-statement.py`'s reconciliation `checks` loop (around line 309-331)
  the same tolerance the extractor already uses for this check (e.g. `abs(got - want) >
  0.5` instead of `got != want`) - at minimum for "securities sale vs TIS"; consider
  whether other rupee-precision reconciliation lines in the same loop want the same
  treatment for consistency, though those are typically int rupee sums with no paisa
  component.
- Validation figures: 58 lots (53 ST + 5 LT) summing to exactly 1,25,26,295.90; TIS
  target 1,25,26,296 (diff Rs. 0.10).
- Trail: 2026-07-22 reported; client parked pending this fix -> 2026-07-22 implemented
  (uniform 0.5-rupee tolerance across the checks loop - an integer-rupee mismatch is
  always >= 1, so tolerance only forgives sub-rupee drift; validated on a sample
  variant: lots summing 4,59,999.90 vs target 4,60,000 builds green with all anchors,
  a 2-rupee diff still dies) -> AWAITING operator re-run of the parked client.

### GAP-016 STCG/LTCG 5-period (s.234C) accrual breakup on the Capital Gains sheet
- Shape: 2026-07-22, operator (NRI client, ITR-2 statement+guide path, equity CG
  lots across most of the 5 periods; same request also relayed to the maintainer
  off-ledger); the client's prior-year hand-built statements carry the breakup, the
  generated sheet did not.
- Symptom: `build_dividends_sheet()` already renders the 5 period columns L..P from
  each item's `periods` dict; `build_capital_gains_sheet()` had no period grouping
  or subtotals at all - the operator needs STCG and LTCG split across the 5
  advance-tax periods for the portal's "accrual/receipt of capital gain" table and
  the client-facing statement.
- Spec: bucket each lot by `saleDate` (every lot carries one - no name-matching
  dependency) into L "up to 15/6" / M "16/6 to 15/9" / N "16/9 to 15/12" /
  O "16/12 to 15/3" / P "16/3 to 31/3", validated against the AY's FY (unparseable
  or out-of-FY saleDate = data error, hard stop); per-section period totals on the
  sheet, all 10 cells anchored in the build's self-verification (zeros included so
  a mis-bucketed column cannot hide); same breakup in the filing guide's Schedule
  CG section (gross, before BFLA set-off). Also fixes generate-itr.py's inline LT
  accrual bucketing, which sent Jan/Feb sales to "up to 15/6" (a naive (month, day)
  tuple ladder never reaches the Jan-Mar wrap). LAYOUT NOTE: the client's own
  prior-year hand format was ROW-grouped period subtotal blocks with explicit
  pre-/post-23/07/2024 sections; implemented COLUMN-based L..P instead (house
  Dividends convention - same figures, one layout across sheets). If the accountant
  needs the prior row-grouped layout for the client-facing copy, flag it at
  verification and it becomes a follow-up entry.
- Validation figures: boundary tests 15/6->L, 16/6->M, 15/9->M, 16/9->N, 15/12->N,
  16/12->O, 15/3->O, 16/3->P, 31/3->P, and the regression 10/01->O; sample statement
  anchors LT 1,40,000 (16/6 to 15/9) + 80,000 (16/12 to 15/3), ST 20,000
  (16/9 to 15/12), 31 anchors green. Operator: verify the real client's period
  totals against AIS lot dates (lots span at least 3 periods).
- Trail: 2026-07-22 reported (operator, ledger + off-ledger relay) -> 2026-07-22
  implemented (`salePeriodColumn` + `PERIOD_LABELS` in lib/tax.ts with tests; CG
  sheet columns L..P with anchored totals in build-statement.py; guide accrual
  section; generate-itr.py Jan-Mar fix) -> AWAITING operator rebuild of the
  client's statement.

### GAP-015 AIS-JSON dividend line items carry no name
- Shape: 2026-07-21, operator; NRI client, 86 AIS-JSON dividend line items (TDS-194 and
  SFT-015 info codes both affected).
- Symptom: `readL1LineItems()` resolved names from `l1.columnLabel` fields that never
  exist on dividend rows (l1 is pure transaction mechanics), so every dividend item got
  `name: ""`, breaking extract's `namesMatch()` attachment of 26AS TDS - 0 of 86 items
  attached on the real client.
- Spec: the name lives one level up - the PARENT element's `l2.columnData[...]
  ["Information Source"]` (e.g. `"SAMPLE INFRA LIMITED (MUMS12345E)"`) or `el.infoSrcId`
  (the deductor's TAN for TDS-194 rows). Prefer it over l1 for ALL l1-sourced
  categories; CG lots use a separate reader, unaffected.
- Validation figures: 86 dividend items totalling Rs. 2,11,556 (matches
  `reconciliation.tisDividend`); after the fix every item carries a non-empty name and
  26AS-matching items attach tds/tan/periods.
- Trail: 2026-07-21 reported (operator) -> 2026-07-21 implemented
  (`elementSourceName()` in lib/aisjson.ts: parent source name, TAN suffix stripped,
  `infoSrcId` fallback; fixture + tests updated; validated on client B: 34 dividend
  names non-empty summing 55,890, savings named with the real bank summing 1,05,703,
  26AS TDS attaches) -> AWAITING operator re-run of the 86-item client.

### GAP-014 NRI savings-bank interest TDS has no schema field
- Shape: 2026-07-21, operator; NRI client, s.195 TDS on a savings-bank account (not a
  term deposit).
- Symptom: `interest.savings[]` and the `interest` block carried no TDS field or
  summation anywhere (contrast `depositsTds`). Residents never hit this (banks deduct
  no TDS on resident savings accounts); an NRI's savings interest is liable to flat
  s.195 TDS like any other NRI stream.
- Spec: `interest.savingsTds` mirroring `depositsTds`, summed into `tds_total`
  (build-statement.py) and `tdsTotal` (filing-guide.ts); reconciliation target
  `tisSavingsInterestTds`; Schedule-TDS row in the guide; 26AS-verify note in
  docs/extract-from-pdfs.md's NRI section.
- Validation figures: one savings-bank deductor, TotalPaid Rs. 1,05,703 / TotalTDS
  Rs. 32,980 - exactly 31.2%, the flat NRI s.195 rate; the interest amount matches the
  TIS savings target for the same client.
- Trail: 2026-07-21 reported (operator) -> 2026-07-21 implemented exactly per spec
  (builder + guide + target + docs; wiring exercised with the entry's own figures;
  prior-client + sample regressions unchanged) -> AWAITING operator re-run with
  `tisSavingsInterestTds: 32980` (total-TDS reconciliation should include it).

### GAP-013 Capital gains from AIS-JSON detail
- Shape: 2026-07-21, maintainer; split from GAP-012 once it landed - removes the
  AIS-PDF + parse-cg step for the standard case (JSON-first).
- Symptom (was): the AIS-JSON parser derived the securities-sale TOTAL but per-lot CG
  still came from the AIS PDF via parse-cg - the exact table that needed three rounds of
  wrap fixes and still lost lots (510/549). The JSON's SOS l1 detail carries every field
  as clean columns.
- Spec: Active-only SOS l1 rows -> lots {saleDate, name, isin, assetClass, term,
  saleValue, cost, offMarket}; parse-cg's grouping per (ISIN-or-name, term);
  `costUnconfirmed` when ANY lot in a group has zero cost. Loud flags beyond parse-cg:
  zero-sale-nonzero-cost lots (phantom-loss risk) and a hard CAPITAL-GAINS MISMATCH
  that DROPS the lots when their sale sum != the reconciliation target. Grandfathering
  NOT modelled (parse-cg parity); `fmvValue`/`indexCostOfAcquisition` are the starting
  fields if 112A grandfathering is ever added (client B had 0 lots with fmvValue>0).
- Validation figures: client B AY 2026-27 - 241 Active lots -> 53 ST + 5 LT groups;
  sale total 1,25,26,296 EXACTLY (matches the securities-sale target); ST gain
  19,47,448 / LT gain 2,28,224; 9 zero-cost lots -> 6 costUnconfirmed groups; 1
  phantom-loss lot flagged.
- Trail: 2026-07-21 implemented (`readCapitalGainsLots`/`groupCapitalGains` in
  lib/aisjson.ts; tests + SOS block in the synthetic fixture) -> AWAITING the next few
  CG clients; cross-check against parse-cg on the AIS PDF if non-listed-equity classes
  or grandfathering FMVs appear.

### GAP-012 AIS-JSON parser (preferred AIS source)
- Shape: 2026-07-21, maintainer; affects every CG-heavy client (PDF-layout parsing of
  SFT-17 needed three rounds of wrap/fragment fixes, see GAP-004).
- Symptom: the portal's AIS JSON export was unreadable (AES-encrypted; lib/aisjson.ts
  stub returned `supported: false`), so extract leaned on the TIS/AIS PDFs.
- Spec: decrypt (scheme documented in docs/maintainer.md "AIS-JSON is encrypted"), map
  identity + reconciliation targets + Active-only line items into the TisParseResult
  shape; category classification IMPORTED from tis.ts so AIS and TIS never diverge;
  SFT-vs-TDS dedup = SUM within an info code, MAX across codes, with a transparency
  flag naming multi-listed codes; NRI tell-tale (s.195/196, foreign remittance) as
  flag + `nriSignal`; PAN/DOB hint sourced from the prefill. TIS/AIS PDFs drop to
  fallback; 26AS stays regardless (booking status + reversals exist nowhere else).
- Validation figures: client B AY 2026-27 (NRI, 32 dividend payers, 241 CG lots) -
  Dividend 55,890, savings-bank interest 1,05,703, securities sale 1,25,26,296, all
  EXACTLY matching the parsed TIS PDF (cross-checked via parseTis); identity/FY/AY
  correct; 34+2 line items reconciled.
- Trail: 2026-07-21 implemented (lib/aisjson.ts + tests, synthetic encrypted fixture)
  -> AWAITING: keep the TIS-PDF dual-download for the next few AIS-JSON clients and
  eyeball the dedup flags until confidence builds.

### GAP-011 26AS text-export parser (target 26AS format)
- Shape: 2026-07-21, maintainer; TRACES offers ONLY the text export past a size
  threshold (so this parser is mandatory in the limit), and the delimited format kills
  the wrapped-deductor-name layout risk the PDF parse carries.
- Symptom: extract parsed only the 26AS PDF; HTML is not an option (rendered view,
  truncates on large statements).
- Spec: parse the TRACES text export (delimiter auto-detect: `^`, older `|`) into the
  same F26asResult shape as parse26as (identity, per-deductor rows with
  section/date/booking-status/remarks, reversal netting, park flags for populated
  Parts II-X), so periodsFromRows/234C work unchanged; extract discovery finds the
  .txt and PREFERS it over the PDF.
- Validation figures: PDF parity on client A AY 2026-27 (4 deductors, totalTds 97,019,
  s.194 payment dates driving periods L/M/N/O); client B AY 2026-27 - 37 deductors /
  totalTds 5,43,030.56 / 148 txn rows / sections {194,195} / ZERO flags, vs 4
  reconciliation flags on the SAME client's PDF (totals match to < Rs. 1, paise
  rounding).
- Trail: 2026-07-21 implemented (lib/f26astext.ts + tests, synthetic fixture
  samples/sample-26as-text.txt) -> AWAITING the next client; watch the first
  large-statement client (>500 rows) where the PDF format was the original pain point.

### GAP-010 Deterministic portal-harvest script (zero-token gather)
- Shape: 2026-07-21, maintainer; every client's gather phase (no public API - ERI
  registration is intermediary-scale; login is per-client and OTP-gated, ours by rule;
  sessions idle out ~15 min - but everything AFTER login is mechanical).
- Spec: `bun run harvest` attaches to the shared practice Chrome over CDP (never
  launch/own/close - AGENTS.md "Portal browser sessions"), waits for the human login,
  runs the PAN identity gate (hard-abort on mismatch), captures/verifies/names/files
  the standard 3 into `clients/<slug>/`, prints an extract-style digest with exit code.
  Selector misses drop to guided-manual: print the exact click path, keep listening
  (capture/verification/filing stay automated). Read-only session. Any agent-driven
  gather run appends its click-path observations here - that log is the calibration
  data for a selector-driven v2.
- Validation figures: one client's harvest must produce all artifacts, pass the PAN
  gate, and feed `bun run extract` with zero source-related flags (client A's
  AY 2026-27 file set is the reference shape).
- Trail: 2026-07-21 implemented (harvest-portal.ts + lib/harvest.ts + tests; v1
  deviates from the spec's Playwright plan on purpose - raw CDP over Bun's WebSocket,
  ZERO dependencies, ZERO DOM selectors, guided-manual as the primary mode; design +
  testing procedure: docs/maintainer.md "Portal harvester") -> 2026-07-21
  maintainer-tested end-to-end on samples (--no-browser) + live CDP attach against the
  real portal login page -> AWAITING the first real operator harvest of the season.

### GAP-004 AIS SFT-17 PDF parser fails on a real large CG table
- Shape: 2026-07-20/21, operator; NRI client, 549 capital-gains lots (equity +
  off-market transfers-in) in one AY 2026-27 AIS. (parse-cg is now fallback-only for
  client-emailed PDFs and historical years - see GAP-013.)
- Symptom: `bun run parse-cg` parsed 0/549 lots. This AIS wraps the class/type/term
  tokens onto a separate line ABOVE the data row (264/362 rows), wraps long names onto
  the line above (98 rows), strands tokens like a lone "term", and its data-line middles
  are ISIN-only - which the parser counted as names, attaching wrapped fragments to the
  WRONG lot (off-by-one at security boundaries).
- Spec: assemble a lot from up to 3 physical lines - buffer non-data lines as fragments
  and attach by content; read term/class/off-market ONLY from column-zone keywords so an
  in-name "LONG" cannot flip a lot; strip the ISIN from the data line in place; "has a
  name" requires 3+ consecutive letters; scope parsing to the table window; fail loudly
  when a lot's term or name cannot be established.
- Validation figures: 549 lots, sale-value total Rs. 1,64,61,538 (must match the TIS
  securities-sale line item, same figure).
- Trail: 2026-07-20 reported (operator) -> 2026-07-21 first pass implemented (fragment
  assembly; fixture samples/sample-ais-cg-layout-wrapped.txt reproduces both wrap
  variants) -> 2026-07-21 operator verify PARTIAL: 510/549 lots, off by exactly
  Rs. 16,06,966, root cause isolated to ISIN-stripping in `Lot.__init__` -> 2026-07-21
  second pass implemented exactly as the operator prescribed (+ the two-consecutive-lot
  fixture case) -> AWAITING operator re-run (`--expect-sale-total 16461538`, expect
  549 lots and a clean exit).

## VERIFIED (permanent validation record; figures asserted in scripts/lib/tax.test.ts)

All three surfaced 2026-07-19/20 (real NRI client's AY 2026-27 ITR-2: non-resident,
equity/equity-MF gains, co-owned rented property), were implemented as
`computeTotalTax()` in scripts/lib/tax.ts wired through build-statement.py and
filing-guide.ts (commits b99d60d, b4d538c), and were operator-verified 2026-07-21
against a real filed AY 2025-26 ITR-2, reproduced to the rupee (`bun scripts/tax-cli.ts
total`; 20/20 tests).

| ID | Capability | Validation figures (filed AY 2025-26 return) | Asserted in |
|---|---|---|---|
| GAP-001 | NRI residential status: s.87A is resident-scoped (eligibility gate, not income effect), old-regime slabs at base exemption, no basic-exemption adjustment against special-rate gains | AggregateIncome 11,21,891; TaxAtNormalRatesOnAggrInc 68,284 (= 4,00,000@5% + 3,00,000@10% + 1,21,891@15%); Rebate87A 0 - and 0 for a synthetic under-threshold NRI at 5,00,000 | tax.test.ts "NRI gets no 87A rebate even under the threshold", "computeTotalTax reproduces the filed NRI AY 2025-26 ITR-2 to the rupee" |
| GAP-002 | 111A/112A special-rate CG: legs split at 23-07-2024 (111A 15%/20%, 112A 10%/12.5%), single 1,25,000 112A exemption applied chronologically, resident-only basic-exemption adjustment, 87A threshold on total income while offsetting slab tax only | 111A_BE 9,76,496 @15% = 1,46,474; 111A 7,36,049 @20% = 1,47,210; 112A_BE 96,114 @10% = 0 (inside exemption; Schedule112A sale 19,20,585 - cost 18,24,471); TaxAtSpecialRates 2,93,684; + normal 68,284 = TaxPayableOnTotInc 3,61,968; Cess 14,479; GrossTaxLiability 3,76,447 (engine 3,76,450; s.288B round-to-10 in the filed figure) | tax.test.ts 111A/112A leg + total assertions |
| GAP-003 | House property s.24: ALV -> less local taxes -> co-ownership share -> 30% u/s 24(a); tenant TDS 194-I(b); targets tisRent (100% ALV) + tisRentTds. s.24(b) interest split to GAP-006 | ALV 21,00,000 - 64,954 = 20,35,046 (BalanceALV); x 50% = 10,17,523 (AnnualOfPropOwned); - 3,05,257 = 7,12,266 = PartB-TI.IncomeFromHP (hand-recomputed 2026-07-21) | tax.test.ts + build-statement wiring |
