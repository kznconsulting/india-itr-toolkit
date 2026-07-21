---
name: file-return
description: Generate a client's ITR filing guide and optionally drive a verified, screen-by-screen assisted filing session on the e-filing portal. Use when the user says "file <client>'s return", "filing guide for <client>", "help me file <client>'s ITR", or a reviewed statement is ready to file.
---

# File a client's ITR

> **EXPERIMENTAL for outside adopters.** This skill assists a REAL tax filing on incometax.gov.in. It is exercised inside the practice that built it, under its human-in-the-loop rules; nothing here has been hardened for other setups. If you cloned this repo: do not use the assisted-browser mode at all until you have read every hard-stop rule below, and never let it near a real return unless `bun run verify` is green and a qualified professional has reviewed the statement. The guide + portal-offline-JSON-upload path needs no browser automation and is the recommended way to file.

Three modes: **guide** (always run first), **JSON-upload filing** (preferred when a prior-year filed JSON exists), and **assisted browser filing** (only when asked). In every mode the operator owns login, OTP, captcha, the final Submit, and e-verification.

## Preconditions

1. Locate the client: `clients/<slug>/`. If the user gave a name, match it to a folder.
2. Find the current AY's `AY<yyyy-yy>-statement-data.json` in that folder.
   - Missing → STOP. Tell the user the extraction step comes first: docs/extract-from-pdfs.md.
3. The statement Excel must exist and the user must have reviewed it. If in doubt, ask "has the statement been reviewed?" before proceeding.

## Mode A: generate the guide (always do this)

```sh
bun run guide clients/<slug>/AY<yyyy-yy>-statement-data.json
```

- Regenerate every time (cheap; picks up any data-file edits). Never hand-edit the guide - fix the data file and re-run.
- Report the one-line expected outcome the script prints (tax / refund) and the guide's path.
- If the script errors, a reconciliation target failed: fix the data file, never the check.

## Mode B: JSON-upload filing (preferred when a prior-year filed JSON exists)

```sh
bun run verify clients/<slug>/AY<yyyy-yy>-statement-data.json
```

One command runs generate + the CBDT rules check + the processor review + the prefill diff and prints one summary with the expected portal totals (template auto-discovered; `--template`/`--prefill` to override).

- Every WARNING verify prints must be resolved (missing client figures, template-copied values) - regenerate after fixing the data file. Never hand-edit the generated JSON.
- The operator uploads the JSON on the portal (e-File - File Income Tax Return - offline mode), compares the portal's computed summary against the generator's printed expectations, and only then submits and e-verifies. A summary mismatch is a hard stop.
- If the portal rejects the upload (schema/software-id quirks), fall back to Mode C with the guide - the figures are identical.

## Mode C: assisted filing (only when asked)

Roles are fixed: **the operator owns identity and consequence; the agent owns transcription.**

### The operator does, always, by hand
- Portal login, password, OTP, captcha - the agent NEVER types, reads, or requests credentials or codes
- The final Submit
- E-verification

### Setup
- The operator logs in to incometax.gov.in themselves, in a browser the agent can drive (Claude in Chrome on their machine, or the app's browser pane where they type the login themselves), and navigates to the return (e-File - Income Tax Returns - File Income Tax Return - Online mode).
- The agent opens the client's filing guide; it is the single source for every value entered.

### Loop - one guide section per iteration
1. Confirm the on-screen schedule matches the current guide section. Portal DOM and labels drift: if the screen name differs, find the equivalent section and confirm with the operator BEFORE touching any field.
2. Enter ONLY the fields listed in that guide section, values verbatim from the guide.
3. Read back: screenshot + read the page, list every entered value next to the guide's figure.
4. WAIT for the operator's explicit go-ahead ("ok" / "next"). Never click Continue, Save, or Confirm before it.
5. Save draft when the portal offers it (drafts are harmless; submission is not).

### Hard stops - halt, report, wait for the operator
- Any portal-computed total that differs from the guide's expected Part B-TTI figures
- Any validation error or warning banner
- Any prefilled row the guide does not mention (surface it; never delete prefill on your own)
- Session expiry or unexpected navigation

### Never
- Enter or read credentials, OTPs, or captchas (ask the operator to do it)
- Click the final Submit or anything labelled as filing/verification
- Proceed past a hard stop without an explicit human decision

## After filing (either mode)

Follow the guide's "After filing" block:

```sh
# operator downloads the filed JSON + ITR-V from the portal
bun run process clients/<slug>/inbox/AY<yyyy-yy>-<slug>-filed.json   # cross-check what was filed
# archive filed JSON + ITR-V + statement + AIS/26AS into clients/<slug>/archive/AY<yyyy-yy>/
bun run status                                                       # board should show FILED
```

If the processor flags any mismatch against the statement, raise it immediately - a revised return is cheap now (window per docs/reference.md) and expensive later.
