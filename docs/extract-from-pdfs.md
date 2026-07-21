# Runbook: portal documents → statement-data.json → statement Excel

The extraction step is SCRIPTED: `bun run extract` parses the TIS, 26AS, and prefill and writes the draft data file plus a gap digest. The operator's job is resolving the digest's gaps - not reading documents. Never open the PDFs (or return/prefill JSONs) in-session; if extract cannot parse something, its message says exactly what to do instead.

## The pipeline

```
/fetch-portal-docs                      standard 3: prefill JSON + AIS JSON + 26AS -> clients/<slug>/
                                        (TIS/AIS PDFs fallback-only, when the JSON isn't available/usable)
bun run extract clients/<slug>          -> AY<yyyy-yy>-statement-data.json (draft with _gaps[]) + digest
resolve each gap, delete its _gaps entry
bun run statement clients/<slug>/AY<yyyy-yy>-statement-data.json   -> statement Excel (self-verifying)
```

Extract fills the reconciliation targets (AIS JSON primary; TIS PDF fallback - Accepted values either way; the digest labels which source it used), dividend/interest/business line items (validated against the targets), TDS + TANs + dividend 234C periods (26AS), refund interest (143(1) intimation when in the folder, else the prefill CPC row), the prior-year comparatives/account details (prior data file), and the prior GTI + capital-loss roll-forward (the `AY<prior>-carryforward.json` sidecar that every verified statement build writes). The builder refuses to run while `_gaps` is non-empty, and re-verifies everything it writes; **a failing check means bad input data - fix the data, never the check.**

## Resolving the common gaps

The digest's gap text is self-contained; this section is the background for the judgment calls.

- **capitalGains** - the digest prints the exact `pdftotext` + `bun run parse-cg --expect-sale-total <TIS target>` invocation. parse-cg groups per security (`--per-lot` for rows), sets `costUnconfirmed: true` on zero-cost lots (an off-market transfer-in the depository has no basis for - get the real cost from the client/broker before filing, never file the zero), tags non-equity rows with `assetClass` (builder refuses them: park per AGENTS.md), and exits non-zero on any unparsed row. If it fails: prefer fetching the portal's AIS **JSON** export; do not hand-read the table.
- **capitalGains.lossBroughtForward** - roll forward from the prior year's loss sheet: append the prior AY's set-off row to `lossHistory`, adjust the figure. Losses carry 8 AYs.
- **interest.refundInterest** - the refund credited = CPC principal + 244A interest; only the interest is income, and "received minus claimed" is WRONG whenever CPC adjusted the principal. Source order: (1) the 143(1) intimation (`bun run parse-intimation <pdf>`; extract applies it automatically when the PDF is in the folder and cross-checks the prefill against it); (2) `bun run tax refund-interest --from-prefill <prefill.json>`; (3) `bun run tax refund-interest --refund <principal> --ay <prior-ay> --refund-date DD/MM/YYYY`; (4) last resort received-minus-claimed, flagged loudly. Cite the source in the `note`.
- **salary / houseProperty** - fill from Form 16 / the rent detail (ALV = 100% of gross rent pre co-owner split, tenant name/TAN, co-ownership share, local taxes).
- **business.items (new payer)** - set `presumptiveRate` and the 44ADA `meta` block (commencement date, nature-of-business code, trade name); copy the shape from `samples/sample-statement-data.json`.
- **client block (no prior year)** - identity/address/banks from the prefill or last year's filed return, never from memory.
- **exemptIncome / priorYear.gti** - from the client (PPF certificate) / the prior year's statement Excel. Anything assumed or unconfirmed goes into `notes` as a flag phrased for the reviewer.

**NRI clients**: extract flags s.195/196-rate TDS in the 26AS (~20.8% dividends / ~31.2% interest). Confirm with the client, set `client.residentialStatus: "NRI"`, re-run extract. NRI savings interest carries s.195 TDS too (`interest.savingsTds`, target `tisSavingsInterestTds`) - residents never have TDS on savings accounts.

**Dividend periods** (234C): filled automatically from 26AS s.194 payment dates. SFT-only scrips have no payment date (AIS reports only the annual filing date - that is NOT a payment date): leave `periods` empty with a note; it only matters when advance-tax interest is in play.

## What IS modelled (statement builder + guide, cross-checked by the engine)

- Salary (gross + TDS + regime-dependent standard deduction u/s 16(ia))
- House property: ALV, local taxes, co-ownership share, 30% u/s 24(a), tenant TDS 194-I(b)
- STCG 111A / LTCG 112A incl. the 23-07-2024 rate split, Rs. 1.25L exemption, b/f LT loss set-off, 87A interplay, NRI handling

## Known limits (the build aborts with a park instruction; never work around)

- Surcharge: TOTAL income above Rs. 50 lakh
- Non-equity capital gains (s.112: property, debt funds, gold)
- A net ST capital loss, or a fresh net LT loss (set-off ordering / new-loss carry-forward)
- s.24(b) home-loan interest (schema field exists; no validated example yet)

## Fallback: manual extraction (only if extract itself fails and says so)

Field map, in the order that works: **TIS front page first** (Accepted column → `reconciliation.tis*`: Dividend, Interest from savings bank / from deposit / from others (s.193 → `interest.other[]`+`otherTds`, its own bucket - never fold into deposits), Sale of securities..., Business receipts, Salary, Rent received + `tisRentTds`). **AIS Part B for detail** (B1 TDS rows per section: 194 dividends w/ payment dates, 194A deposit TDS, 193 securities interest, 194J/192 business/salary, 194I(b) rent; B2 SFT: 015 dividend per company, 016(SB)/(TD) interest per account, 018 MF dividends w/ quarter, 17 securities sales → parse-cg regardless). **26AS Part I is the TDS truth** (per-deductor totals are already net of `G`-remark reversals; `reconciliation.totalTds` = grand total; TRACES wins over AIS on conflict). PDF passwords are PAN+DOB(DDMMYYYY) - lowercase PAN first (scripts already try both). Note each document's generation date in `notes`; re-download before filing if stale.
