# Contributing

Thanks for helping. Two rules are absolute; everything else is convention.

## Rule 1: no real taxpayer data, ever

- Nothing that identifies a real person or their finances goes into the repo: no names or client slugs, no PAN/TAN/Aadhaar/bank accounts, no figures attached to an identity. This applies to code, docs, fixtures, commit messages, PR descriptions, and issues.
- `samples/` is fictitious only. Follow the existing patterns: PANs like `ABCPX1234Z`, banks like "Sample Bank", accounts of zeros, `TEST@EXAMPLE.COM`.
- Validation figures from real returns are welcome (they are what make the tax engine trustworthy) but only as anonymous amounts, the way `docs/missing-functionality.md` records them: "client A, AY 2026-27, totalTds 97,019".
- `bun run doctor` enables a pre-commit hook that blocks `clients/` and `reports/` paths. Do not bypass it with `--no-verify`.

## Rule 2: a failing check means bad input data

Fix the data, never the check, and never invent a number to make a check pass. The toolkit's value is that unmodelled situations abort loudly instead of producing a plausible wrong return.

## Setup

```sh
bun run doctor   # checks bun, python3, openpyxl, jsonschema, pdftotext; enables the PII guard
bun test
```

## Making changes

- **Tax logic** (`scripts/lib/tax.ts`, the builders, the rule checker): every change needs unit tests asserting validation figures from a real filed return or CPC intimation, anonymized as above. "Reproduces the filed return to the rupee" is the bar.
- **Parsers** (prefill, AIS JSON, 26AS, TIS, intimation): build against real document structure, never guessed layouts. Add a fictitious fixture to `samples/` that reproduces the structure you are handling, and a test against it.
- **New capability** follows the gap-ledger protocol in `docs/missing-functionality.md`: an entry with symptom, spec, and validation figures first, then the implementation citing them.
- Scripts stay deterministic: same inputs, same outputs, loud digests. No network calls, no model calls.
- Match the existing style of whatever you touch. TypeScript runs under bun; Python scripts target python3 with only `openpyxl`/`jsonschema`.

## Pull requests

Keep them small and single-purpose, with the reasoning in the PR description. If you changed any figure-producing path, paste the relevant digest or test output.
