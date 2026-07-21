# india-itr-toolkit

Multi-client India income-tax practice. Per client-year: portal documents are parsed by scripts into a `statement-data.json` draft, the operator resolves the flagged gaps, and everything downstream (statement Excel, ITR-3 return JSON, five-way verification) is deterministic and self-verifying. The ITD offline utility is NOT used; filing is the portal's offline-mode JSON upload (first-year clients: online mode with the generated guide).

This file is the OPERATOR handbook - lean by design so every session stays cheap. Toolkit internals, tax-engine notes, and script-extension guidance live in docs/maintainer.md (maintainer machine only).

**Roles.** The **operator** is the human (plus their agent) who runs the per-client loop and owns every login/OTP, judgment call, and sign-off; the **maintainer** extends the toolkit (docs/maintainer.md). In a multi-person practice they are different people on different machines, synced through git and the gap ledger (docs/missing-functionality.md). One person can hold both roles on one machine - keep the session types separate: a client session never extends the toolkit (park via the ledger, implement in a later maintainer session), and a maintainer session never touches client folders. A gitignored `.machine-role` file containing `operator` marks a dedicated operator machine; absent means maintainer.

## Operating rules

- **Scripts read documents; you read digests.** Never open an AIS/TIS/26AS/intimation PDF or a return/prefill JSON in-session - every figure you need is printed by a script (`extract`, `verify`, `parse-intimation`, `tax refund-interest --from-prefill`, `parse-cg`). If a corner case truly forces reading a document, do it in a subagent that returns only the extracted fields.
- **Delegate mechanics to Haiku subagents.** For self-contained mechanical steps - applying the digest's listed edits to a data file, batch renames/moves, summarizing a long report - spawn a subagent with `model: haiku` (a third of the price; the alias resolves natively, no configuration). Keep judgment in the main loop: gap decisions, flag review, anything tax-flavored.
- **Two strikes, then park.** If the same command fails twice for the same reason, stop. Do not loop, tweak inputs, or hand-compute around it. Follow the failure message: fix the named data field once, or park the client.
- **Escalate, don't extend - on operator machines.** When a guard aborts or a computation isn't modelled: `git pull`, append a `GAP-NNN` entry (next free id, template in the file) at the top of the OPEN section of `docs/missing-functionality.md` (symptom, spec, validation figures - amounts only, never PII or client names), commit+push, tell the operator the client is **parked**, move to the next client. Never extend tax logic or scripts in-session. Small data fixes, doc corrections, and new gotchas are still yours to make directly.
- **One client per session.** Finish (or park) a client, then start fresh for the next - context from one client is dead weight (and a privacy risk) for the next.
- **A failing check means bad input data** - fix the data, never the check, and never invent a number to make a check pass.
- **Commit and push proactively - operator machines only** (`.machine-role` file says `operator`): commit anything outside `clients/` to `origin` without being asked. If the file is absent or different, this is the maintainer's machine: commit only when asked. `clients/` is gitignored and never committed.
- At the start of a work session run `caffeinate -i &` (kill it when done) so macOS doesn't sleep mid-run.

## The per-client loop

```sh
bun run status --next                  # the board tells you what each client needs
# gather: the operator downloads the 3 files (prefill JSON + AIS JSON + 26AS text)
#         into ~/Downloads, then:
bun run harvest clients/<slug> --sweep --pan <PAN>   # files them from Downloads -> clients/<slug>/ (named, PAN-checked, 26AS unzipped)
#   (or `bun run harvest clients/<slug>` to drive a logged-in browser instead of a manual download)
bun run extract clients/<slug>         # parses prefill + AIS JSON + 26AS -> statement-data.json draft + gap digest
# resolve each gap the digest lists, delete its _gaps entry
bun run statement clients/<slug>/AY<yyyy-yy>-statement-data.json    # Excel; operator reviews & signs off
bun run verify clients/<slug>/AY<yyyy-yy>-statement-data.json       # generate+check+process+prefill, one summary
# operator uploads the generated JSON (portal offline mode); portal summary must equal verify's printed totals
# client e-verifies within 30 days; filed JSON + ITR-V -> clients/<slug>/archive/AY<yyyy-yy>/
```

Runbooks when a step needs more detail: docs/workflow.md (end-to-end), docs/extract-from-pdfs.md (gap resolution), docs/reference.md (rates/dates). `/file-return` wraps guide generation and assisted filing; login/OTP/submit/e-verify always stay with the operator.

## Commands

- `bun run harvest clients/<slug> --sweep [--pan PAN] [--days N]` - NO browser: files the standard 3 (prefill JSON + AIS JSON + 26AS) that the operator already downloaded into `~/Downloads`, into `clients/<slug>/` - PAN-checked (masked PANs ok), convention-named, 26AS zip auto-unzipped with the DOB from the prefill. `--pan` needed for a brand-new client (no prior statement-data to read it from). This is the low-token gather path.
- `bun run harvest clients/<slug> [--ay yyyy-yy]` - guided browser gather (alternative to --sweep): attaches the practice Chrome, prints each click path, captures/verifies/names/files every download, digest at the end
- `bun run extract clients/<slug> [--force]` - portal docs -> statement-data draft + gap digest
- `bun run statement <data.json> [--out f.xlsx]` - computation-statement Excel (self-verifying)
- `bun run verify <data.json>` - generate -> check -> process -> prefill in one run; prints expected portal totals (individual commands still exist: `generate --template <prior-filed.json>`, `check`, `process`, `prefill`)
- `bun run guide <data.json>` - screen-by-screen online-mode filing guide (first-year clients)
- `bun run parse-cg <ais-layout.txt> --expect-sale-total N` - AIS capital-gains table -> capitalGains rows (extract's digest prints the exact invocation when needed)
- `bun run status [--next]` - practice board: one row per client-year with its pipeline STAGE (EMPTY -> HARVESTED -> EXTRACTED(N gaps) -> READY -> VERIFIED -> FILED), and every open gap listed below the table (the "waiting on the client" digest). `--next` adds the recommended action per client
- `bun run parse-intimation <143(1).pdf>` - CPC intimation -> 244A interest, refund principal, filed-vs-computed diffs (extract runs it automatically when the PDF is in the folder)
- `bun run tax refund-interest --from-prefill <prefill.json>` - 244A figure from the prefill CPC row, no JSON reading
- `bun run process clients/` - batch re-review every inbox; `bun run doctor` - environment check; `bun test`

## Portal browser sessions (human-agent handoff)

- **One shared practice Chrome; attach, never launch.** All portal automation - the harvest script, any agent browsing - connects to the dedicated practice Chrome (own profile dir, started with `--remote-debugging-port`) via CDP. Never launch a separate browser, never headless, never Playwright `launchPersistentContext`, never close the window: the browser must outlive every script/agent run so the logged-in session survives handoffs. Each re-login costs the client an OTP, and portal sessions idle out in ~15 minutes.
- **The operator always logs in.** Login, captcha, and OTP happen by human hands in that same window. Automation waits for the logged-in state, then runs the identity gate (header PAN/name vs the intended client) before downloading anything.
- **Handoff is the design, not a failure.** Human, deterministic script, and agent drive the same session interchangeably. On selector drift a script drops to guided-manual: print the exact click path for the operator and keep listening - download capture, PAN verification, renaming, and filing into `clients/<slug>/` stay automated even when the human does the clicking. Log the drift in the gap ledger.
- **Agent-driven browsing is the rescue path only.** Attach to the same CDP endpoint, do the one step that needs judgment, hand back to the script or the human. Routine navigation is never worth model tokens.
- **Read-only outside `/file-return`**: navigate and download only - never submit, verify, consent, or change settings on the client's behalf.

## Layout

- `clients/<slug>/` (kebab-case, gitignored): source PDFs + prefill at the root alongside `AY<yyyy-yy>-statement-data.json` and the statement Excel; `inbox/` for return-JSON drafts; `reports/` (generated); `archive/AY<yyyy-yy>/` for the filed JSON + ITR-V (non-empty = FILED on the board).
- **Legacy clients** live in `~/Documents/<Client Name>/` - before `mkdir`, search `~/Documents` for the client's real name (and close variants) and `ln -s` the folder as `clients/<slug>` instead. If the client keeps per-year subfolders (`AY 2025-26/Statement/`), land the Excel there via `--out`, following their existing pattern.
- `samples/` - fictitious data only. `docs/` - runbooks. `schemas/AY<yyyy-yy>/` - official ITD schema + validation rules per AY.

## Data sensitivity

Real client files hold PAN, Aadhaar, bank accounts, address, full income detail. Everything under `clients/` and `reports/` is gitignored: never commit it, never publish it to artifacts/external services/logs, keep each client's data strictly inside their own folder. `.githooks/pre-commit` (enabled by `bun run doctor`) hard-blocks staged client paths; never bypass with `--no-verify`. Samples must be fictitious.

## Operator gotchas

- **AIS zero-cost lots** (`costUnconfirmed: true`, set by parse-cg): never file until the real cost arrives from the client/broker - a false zero overstates gains.
- **244A refund interest**: never received-minus-claimed. Order: 143(1) intimation (`parse-intimation`; extract applies it automatically) > prefill CPC row (`--from-prefill`) > computed (`bun run tax refund-interest --refund ...`).
- **NRI tell-tale**: extract flags s.195/196 TDS in the 26AS. Confirm with the client, set `client.residentialStatus: "NRI"`, re-run.
- **Prefill diff notes are normal**: the government prefill legitimately lacks capital gains and refund interest; `verify` marks those informational, not failures.
- **AIS JSON is the PRIMARY AIS source** and its parser is live: extract decrypts the export (it is AES-encrypted, keyed on the client's PAN+DOB from the prefill), derives the reconciliation targets AND the per-lot capital gains from it directly - no TIS, no AIS PDF, no parse-cg for the standard case. The TIS/AIS PDFs are fallback-only (JSON export missing, a decryption/version failure, or a CAPITAL-GAINS MISMATCH - all named in the digest). The **26AS** is still its own download. Follow what extract labels as the source. Two normal-but-loud flags to understand: a category "reported under N codes" is the SFT-vs-TDS de-duplication (it keeps the larger - eyeball vs the 26AS if odd); and CG "costUnconfirmed"/"ZERO cost" lots are the off-market-transfer trap - get the real cost from the client/broker, NEVER file a zero cost as-is.
