---
name: fetch-portal-docs
description: Drive the operator's logged-in browser session to download a client's e-filing documents (prefill JSON, AIS, TIS, 26AS) and file them into the client's folder with the practice naming convention. Use when the user says "download the prefill", "fetch <client>'s AIS/TIS/26AS", "pull the portal documents", or during the gather phase of the filing workflow.
---

# Fetch a client's portal documents

> **EXPERIMENTAL for outside adopters.** This skill drives a live, logged-in session on incometax.gov.in. It is exercised routinely inside the practice that built it, but it is calibrated to that practice's setup (dedicated Chrome profile, CDP attach on port 9992, human-in-the-loop rules in AGENTS.md "Portal browser sessions"). If you cloned this repo: do not enable it until you have read this whole file plus those rules, and tested against your own account. You do not need it - the manual-download path (`bun run harvest --sweep`) covers the gather phase with no browser automation at all.

Automates the gather phase: prefill JSON + AIS (PDF and JSON) + TIS + 26AS from incometax.gov.in, then renamed and filed into `clients/<slug>/`. There is no public API (programmatic access needs ERI registration - not this practice), so the gather is browser-based and login/OTP is always the operator's step.

## Zero-token path first (preferred - this is how the practice runs now)

The deterministic harvester (`scripts/harvest-portal.ts`) is BUILT. Do NOT drive a browser unless neither path below works.

**Sweep path (best - the operator already downloaded the files).** The standard 3 (prefill JSON + AIS JSON + 26AS **text export**) are downloadable by hand in a few clicks; the operator does that into `~/Downloads`, then:

```sh
bun run harvest clients/<slug> --sweep --pan <PAN>
```

The script finds this client's files in `~/Downloads` (PAN-matched, masked PANs like `XXXPG9762X` handled), verifies, convention-names, unzips the 26AS text zip with the DOB from the prefill, and files everything into `clients/<slug>/`. `--pan` is needed only for a brand-new client (otherwise it reads the PAN from the folder's statement-data). Your whole job is to run it and relay the digest. This burns no model tokens on navigation.

**Guided-browser path (no manual download).** `bun run harvest clients/<slug>` attaches the practice Chrome; the operator logs in + OTPs like a human, and the script captures/names/files each download.

Fall back to the manual browser flow below ONLY if both fail (selector drift / portal change - log it in the gap ledger, then browse).

## Hard rules (same as file-return)

- The operator logs in. The agent NEVER types, reads, or requests passwords, captchas, or OTPs. Portal login may need the client's Aadhaar-OTP mobile - coordinate with the client before starting.
- Read-only session: navigate and download ONLY. Never submit a form, never change profile/settings, never click anything that files, verifies, or consents on the client's behalf. Decline non-essential popups.
- Use the browser the operator is logged into (Claude in Chrome on their machine, or the app browser pane where they logged in themselves).

## Identity gate (do this FIRST, every client)

After the operator logs in, read the logged-in PAN/name shown in the portal header and confirm it matches the intended client's data file BEFORE downloading anything. Wrong session = another client's PII in the wrong folder. When processing several clients, the operator logs out and in between clients; re-run this gate each time.

## The fetch routine

**One login = one complete harvest.** Portal sessions idle out fast (~15 minutes), and each login costs the client an OTP. Immediately after the identity gate, download ALL of the artifacts below for that client before doing anything else (no verification chatter, no file renaming mid-session); rename and verify after the downloads are in hand.

Portal menus drift; on the first run of a season, confirm each click with the operator before making it, then proceed without pauses on later clients.

The standard set is 3 files: **prefill JSON, AIS JSON, 26AS PDF**. The TIS and AIS PDFs are FALLBACK-ONLY - download them only if the portal has no AIS JSON export for this client, or `bun run extract` has said it cannot use the JSON yet (the AIS-JSON parser entry in docs/missing-functionality.md still OPEN; in that transitional state grab both PDFs in the same session to save a re-login OTP). Nothing else, ever (no TRACES text export): each artifact has a distinct job, everything beyond these is redundancy.

1. **Prefill JSON**: e-File → Income Tax Returns → File Income Tax Return → select AY → Online/Offline chooser → offline mode → "Download Pre-filled Data" (do NOT continue into an actual filing; leave the flow after the download).
2. **AIS JSON**: Services → Annual Information Statement → download the JSON export. (*Fallback only, per the rule above*: the AIS PDF and TIS PDF from the same section; password PAN lowercase + DOB DDMMYYYY.)
3. **26AS**: e-File → Income Tax Returns → View Form 26AS (redirects to TRACES). Target format is the **Text export** (the machine format; the only one TRACES offers for very large statements). While the 26AS-text parser entry in docs/missing-functionality.md is still OPEN, download the PDF as well (extract parses the PDF today). Never the HTML view.
4. Session expiry mid-routine → tell the operator, wait for re-login, redo the identity gate.

## Filing the downloads

Move each file from the browser's download folder into `clients/<slug>/` using the existing convention, e.g.:

- `prefill - <initials> <PAN>-<year> - <dd.mm.yyyy>.json`
- `AIS - <initials> <PAN>-<year> - <dd.mm.yyyy>.pdf` (same for TIS, 26AS)
- `AIS - <initials> <PAN>-<year> - <dd.mm.yyyy>.json` (the AIS JSON export)

Then verify before declaring done:

- the prefill parses as JSON and its PAN matches the client
- PDFs open (page count > 0) and their PAN matches
- report what was fetched, with file sizes, and what failed

## After fetching

Continue the normal workflow: `bun run extract clients/<slug>` parses the fetched documents into the statement-data draft (docs/extract-from-pdfs.md); `bun run verify` later diffs the generated return against the prefill before upload.
