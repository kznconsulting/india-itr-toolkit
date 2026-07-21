# india-itr-toolkit

[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Runtime: Bun](https://img.shields.io/badge/runtime-bun-black?logo=bun)](https://bun.sh)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Scripted, self-verifying preparation of India income-tax returns (ITR) from the Income Tax Department portal's own documents. Everything runs locally, every computation is deterministic and checked, and every judgment call is left to a human.

> [!WARNING]
> **This is a guide to help you do your taxes, not a tax professional.** It models a finite set of situations (see the [gap ledger](docs/missing-functionality.md)), tax law changes every year, and a bug or an unmodelled rule can produce a wrong return that looks right. **Always have a qualified tax professional (a Chartered Accountant) review the computation statement and the return JSON before anything is uploaded**, and compare the portal's computed summary against the toolkit's printed totals before submitting. You are responsible for what you file. Nothing here is tax advice, and the software comes with no warranty (see [LICENSE](LICENSE)).

## What it does

- **Parses the portal's own documents, deterministically.** The prefill JSON, the AES-encrypted "AIS JSON for utility" export (decrypted locally with PAN + DOB), Form 26AS (TRACES text export or PDF), TIS/AIS PDFs as fallback, and CPC 143(1) intimations. Scripts print digests of every figure; no document ever leaves your machine.
- **Drafts the computation.** `bun run extract` reconciles those sources into one `statement-data.json` draft and prints a gap digest: the short list of things only a human can resolve (unconfirmed acquisition costs, unmatched TDS, residency questions).
- **Builds a self-verifying Excel computation statement** for review and sign-off.
- **Generates the return JSON** (ITR-3 today; ITR-2 via the statement + filing-guide path) for the portal's offline-mode upload, then verifies it end to end: regeneration, 57 encoded CBDT validation rules, independent reprocessing, and a diff against the government's own prefill, with the expected portal totals printed for the final human check.
- **Computes the hard parts** and asserts them in unit tests validated to the rupee against real filed returns and CPC intimations (figures anonymized): new/old regime slabs and 87A, NRI treatment, 111A/112A special-rate capital gains (including the 23-07-2024 rate split and the ₹1,25,000 exemption), house property u/s 24, 234C interest, 244A refund interest.
- **Tracks a multi-client pipeline.** `bun run status` shows each client-year's stage (EMPTY, HARVESTED, EXTRACTED, READY, VERIFIED, FILED) and every open gap.

What it deliberately does **not** do: log in to the portal, submit anything, or touch OTP/e-verification. Login and filing always stay with a human. A harvest helper files the documents a human downloads (naming, PAN-checking, unzipping); a guided browser mode can drive a human-logged-in session read-only.

## Quick start

Requirements: [bun](https://bun.sh), python3 with `openpyxl` and `jsonschema`, and poppler's `pdftotext`.

```sh
git clone https://github.com/kznconsulting/india-itr-toolkit.git && cd india-itr-toolkit
bun run doctor     # environment check; also enables the PII pre-commit guard
bun test

# try the pipeline on the fictitious sample data
bun run statement samples/sample-statement-data.json
bun run process samples/sample-itr1.json
```

## The per-taxpayer loop

```sh
bun run harvest clients/<slug> --sweep --pan <PAN>  # file the portal downloads from ~/Downloads
bun run extract clients/<slug>                      # parse everything -> draft + gap digest
# resolve each listed gap by hand, then:
bun run statement clients/<slug>/AY<yyyy-yy>-statement-data.json   # Excel for review
bun run verify clients/<slug>/AY<yyyy-yy>-statement-data.json      # generate + check + reprocess + prefill diff
# upload the generated JSON in the portal's offline mode; e-verify within 30 days
```

Runbooks live in [docs/](docs/): [workflow.md](docs/workflow.md) end to end, [extract-from-pdfs.md](docs/extract-from-pdfs.md) for gap resolution, [reference.md](docs/reference.md) for the year's rates and dates, [porting.md](docs/porting.md) for setting up a new machine.

The repo is also an agent-operated system: [AGENTS.md](AGENTS.md) is the operator handbook for running the practice loop with Claude Code or a compatible coding agent, with the judgment calls kept human. Every command above is a plain CLI; no agent is required.

Two roles run it: the **operator** does the filings (the loop above; portal logins and sign-offs always stay with this human) and the **maintainer** extends the toolkit ([docs/maintainer.md](docs/maintainer.md)). They can be two people on two machines, synced through git and the [gap ledger](docs/missing-functionality.md), or one person wearing both hats. A fresh clone behaves as a maintainer machine; a gitignored `.machine-role` file marks a dedicated operator machine (see [docs/porting.md](docs/porting.md)).

## Data privacy

Taxpayer data (PAN, Aadhaar, bank accounts, income detail) never enters this repository. `clients/` and `reports/` are gitignored, a pre-commit hook (enabled by `bun run doctor`) hard-blocks staged client paths, and everything in `samples/` is fictitious. Keep it that way in contributions: no real names, figures-with-identity, PANs, or TANs, anywhere, including commit messages and issues.

## Scope and disclaimers

- Current focus: AY 2026-27, individual returns, the situations recorded in the [gap ledger](docs/missing-functionality.md). Unmodelled situations abort loudly rather than guess.
- `schemas/` contains the Income Tax Department's official ITR schema and validation-rule documents, included for reference. They are Government of India works and are not covered by this project's MIT license.
- This project is not affiliated with or endorsed by the Income Tax Department. Once more: **have a professional review the output before you file.**

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Short version: keep scripts deterministic and loud, never commit real taxpayer data, and back any tax-logic change with unit tests citing anonymized real-return figures.

## About Kaizen

This toolkit is built and maintained by [Kaizen](https://kznconsulting.com), an AI consulting firm. It is a working example of how we build agent-operated systems: deterministic scripts do the work, models handle only the judgment calls, and every number is verified before a human signs off. If your business could use systems like this, get in touch: [hello@kznconsulting.com](mailto:hello@kznconsulting.com).

## License

[MIT](LICENSE), except `schemas/` as noted above.
