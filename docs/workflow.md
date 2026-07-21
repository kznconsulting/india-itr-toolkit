# India tax filing workflow

The operator's runbook for this folder. One pass per assessment year, per client; each client's data lives in their own `clients/<name>/` folder and `bun run status` shows the whole book at a glance.

## Annual cycle at a glance

| When | What |
|---|---|
| Jun 15 / Sep 15 / Dec 15 / Mar 15 | Advance-tax instalments for the running year (15% / 45% / 75% / 100% cumulative) if net liability after TDS is ₹10,000 or more |
| April-May | FY closes; start collecting documents; AIS/26AS fill in as deductors file their TDS returns (mostly complete by mid-June) |
| By Jun 15 | Employer issues Form 16 |
| June-July | Prepare, reconcile, file (ITR-1/2 due Jul 31; non-audit ITR-3/4 due Aug 31 from AY 2026-27) |
| Within 30 days of upload | E-verify, or the return is treated as not filed |
| Weeks to months after | 143(1) intimation and refund credit |
| Dec 31 | Last date for belated returns u/s 139(4); revised returns u/s 139(5) run until Mar 31 of the following year (Finance Act 2026) |

## Step 1: Gather documents

- [ ] Form 16 from each employer (Part A and Part B)
- [ ] Form 16A for TDS on interest and other non-salary income
- [ ] AIS + TIS download (portal: Services → Annual Information Statement)
- [ ] Form 26AS (portal: e-File → Income Tax Returns → View Form 26AS)
- [ ] Prefill JSON (portal: e-File → File Income Tax Return → select AY → offline mode → Download Pre-filled Data) - the government's own auto-populated values, used to cross-check the generated return before upload
- [ ] Bank interest certificates (savings and FD, every bank)
- [ ] Capital-gains statements: broker P&L, mutual-fund statements (CAMS/KFintech), property sale deeds if any
- [ ] Home-loan interest certificate, rent receipts / HRA proofs (old regime)
- [ ] 80C/80D proofs: PPF, ELSS, LIC, tuition fees, health-insurance receipts (old regime)
- [ ] Foreign assets or income details if any (forces ITR-2 or higher, Schedule FA)
- [ ] Last year's filed JSON and ITR-V from `archive/`

## Step 2: Reconcile before preparing

Every TDS/TCS credit claimed must exist in 26AS, and every income AIS knows about must appear in the return. Chase mismatches now (wrong PAN registered with a bank, employer filed TDS late, duplicate SFT entries in AIS): they become notices later. AIS allows submitting feedback on wrong entries; do that before filing.

## Step 3: Choose the regime

The new regime is the default. Run the processor on a draft and read the regime-comparison table: it prices the old regime at several deduction levels and computes the break-even deduction amount. Salaried taxpayers can switch regimes every year in the return itself; business income requires Form 10-IEA before the due date to opt out.

## Step 4: Prepare the computation statement (no ITD utility)

The ITD offline utility is not used in this practice (no reliable Mac support). Instead, each client gets a statement Excel built from their portal documents:

- Drop the standard 3 files into `clients/<name>/` (`/fetch-portal-docs` does this): prefill JSON, AIS JSON, 26AS - the TIS/AIS PDFs only as fallback when the AIS JSON isn't available or usable yet
- `bun run extract clients/<name>` - parses them into `AY<yyyy-yy>-statement-data.json` (draft) and prints a gap digest; resolve each gap per [extract-from-pdfs.md](extract-from-pdfs.md) and delete its `_gaps` entry
- Run `bun run statement clients/<name>/AY<yyyy-yy>-statement-data.json` - it builds the statement Excel (Income sheet with both-regime computation and prior-year comparatives, plus Dividends, Interest, Capital Gains, and loss roll-forward sheets) and refuses to produce output that does not reconcile to the TIS totals, 26AS TDS, and the tax engine
- Review the Notes flags in the sheet; anything unconfirmed is listed there

## Step 5: File, then cross-check the JSON here

File the return in the e-filing portal's **online mode** (supported for ITR-1 through ITR-4), entering figures from the statement. The portal still produces JSON: download the prefill JSON before filing and the filed JSON after, and run them through the processor as a cross-check:

```sh
bun run process clients/mehta/inbox/AY2026-27-mehta-filed.json

# or sweep every client's inbox at once
bun run process clients/
```

Read the report in the client's `reports/` folder. Any failed check or mismatch against the statement means a correction (revise before the window closes). Understand every warning (some are informational, like 234C interest that is simply payable).

## Step 6: File and e-verify

**Preferred (when a prior-year filed JSON exists): generate the return JSON and upload it.**

```sh
bun run verify clients/<name>/AY<yyyy-yy>-statement-data.json
```

One command: generate (template auto-discovered from `archive/`/the client root, or `--template`), the CBDT validation-rules check, the independent processor review, and the government-prefill diff - stopping at the first hard failure with that step's own instructions. The individual commands (`generate`, `check`, `process`, `prefill`) still exist for debugging a single step.

The generator clones the prior year's filed return (a structure CPC already accepted for this client), rewrites every figure from the statement data, and refuses to emit anything that fails the official ITD schema. Resolve every WARNING verify prints, then: portal - e-File - File Income Tax Return - **offline mode** - upload the JSON. The portal validates and shows its computed summary: it must match verify's printed expectations (stop and reconcile otherwise), then submit and e-verify. Forty screens become one upload.

**Fallback (first-time clients, or if the upload is rejected): online mode with the filing guide.**

```sh
bun run guide clients/<name>/AY<yyyy-yy>-statement-data.json
```

The guide walks the portal's online mode screen by screen with the client's exact figures, and states the expected Part B-TTI totals: if the portal computes anything different, stop and reconcile before submitting. E-verify immediately after submitting (Aadhaar OTP is fastest); an unverified return lapses after 30 days.

The `/file-return` skill wraps this end to end, including an optional assisted-filing mode where the agent types the figures into the portal one screen at a time and waits for the operator's approval before each Continue. Login, OTP, captcha, the final Submit, and e-verification always stay with the operator.

## Step 7: Archive

Move into the client's `archive/AY2026-27/`:

- the exact JSON that was filed
- the ITR-V / acknowledgement PDF
- the final report from `reports/`
- the AIS/26AS snapshots used for reconciliation

A non-empty `archive/AY2026-27/` is what flips that client-year to FILED on `bun run status`.

## Running multiple clients

- **One folder per client** (`clients/<kebab-case-name>/`), each with its own `inbox/`, `reports/`, `archive/`. Never mix two clients' files in one folder; the folder is the privacy boundary.
- **Track the book** with `bun run status`: one row per client per AY showing the latest draft, check results, refund or payable position, and the pipeline STAGE (EMPTY / HARVESTED / EXTRACTED / READY / VERIFIED / FILED). Any client-year still carrying open gaps lists them below the table, so the board doubles as the "what are we waiting on the client for" digest. `--next` adds the recommended next command per row.
- **During filing season**, run `bun run process clients/` after each batch of new drafts; it skips archives and only reads inboxes.
- **Portal reality:** each return is filed from that client's own e-filing login (or through ERI registration if operating as a registered e-return intermediary), and e-verification is done by the client (their Aadhaar OTP or net-banking). Plan the handoff: send the client the final report for sign-off before uploading, and chase e-verification within the 30-day window.
- **Consent and retention:** you are holding PAN, Aadhaar-linked data, and bank details for other people. Collect returns/documents with consent, share reports only with that client, and delete data when a client leaves.

## Post-filing

- 143(1) intimation: diff it against the filed numbers; a mismatch usually means a TDS credit CPC could not match
- Refund: track on the portal; if it was adjusted against an old demand (s.245), the intimation says so
- Notices arrive on the portal and by email; respond within the stated deadlines
- Keep records at least 8 years (longer where foreign assets are involved)
