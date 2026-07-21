# Porting this folder to another machine (e.g. a new operator's)

This toolkit is designed to run under a smaller model (Sonnet) with minimal in-session reasoning: all computation lives in scripts, all procedure lives in docs. Porting is: install three tools, copy the folder, run the doctor.

## 1. Install prerequisites

Minimum human installs: **Homebrew** (brew.sh) and one **agent harness** - the agent can then run the rest of this section itself:

**Agent harness** (pick one; the repo carries config for both):

- **Claude Code CLI + OpenRouter** (preferred: first-party TUI, no subscription, no new accounts; billed against OpenRouter prepaid credits). Install Claude Code (native installer at code.claude.com; it keeps itself updated), then configure via the shell environment - project settings are NOT read by the first-launch login wizard, so the env must live in `~/.zshenv` (sourced by every zsh invocation, including scripts and ssh commands; chmod 600 - it holds the key):

  ```sh
  export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
  export ANTHROPIC_AUTH_TOKEN="<openrouter-api-key>"   # a scoped key with its own credit limit
  export ANTHROPIC_API_KEY=""                          # must be present and explicitly empty
  ```

  Do NOT pin any `ANTHROPIC_DEFAULT_*_MODEL` (or `ANTHROPIC_SMALL_FAST_MODEL`) to an OpenRouter slug - neither the `~anthropic/...` alias form nor the plain `anthropic/...` form: Claude Code then treats the model as unrecognized, which breaks context-window tracking, auto-compaction, AND prompt caching (measured 2026-07-21: an identical one-shot cost $0.246 with `anthropic/claude-haiku-4.5` pinned vs $0.017 unpinned). Leave model selection to `.claude/settings.local.json` (`{"model": "sonnet"}`) - the native Anthropic model IDs map through OpenRouter automatically, and that includes the tier aliases: `--model haiku` and subagents spawned with `model: haiku` resolve to native Haiku with zero configuration (verified live on this setup).

  Then mark onboarding complete so the login wizard never runs (set `"hasCompletedOnboarding": true` in `~/.claude.json`, merging if the file exists), and pin the model with a machine-local `.claude/settings.local.json` inside this folder containing just `{"model": "sonnet"}`. Never sign in - the env is the auth. Verify with `/status` (should show the OpenRouter base URL). In the OpenRouter dashboard, keep Anthropic (first-party) as the top-priority provider for Claude models. Reference: openrouter.ai/docs/cookbook/coding-agents/claude-code-integration
- **Claude Code with a claude.ai subscription** (Pro or above; only needed if the browser skills are wanted) - sign in and select Sonnet. Adds /fetch-portal-docs and assisted /file-return via **Chrome + the Claude in Chrome extension**, signed in.

The browser skills are NOT available on the OpenRouter path - use the manual portal-download steps in the runbooks instead. Every harness reads `AGENTS.md`/`CLAUDE.md` in this folder automatically; it points to the runbooks.

The maintainer's own machine runs Claude Code on a claude.ai subscription with no `settings.local.json` env overrides - the OpenRouter block above is for ported machines only.

**Runtime** (the agent installs these itself):

- **bun** - `brew install bun` (or `curl -fsSL https://bun.sh/install | bash`) - runs the JSON processor, tax engine, and status board
- **python3 + openpyxl + jsonschema** - macOS ships python3 (Xcode Command Line Tools will prompt once on first brew/git use); then `pip3 install openpyxl jsonschema`. On newer Homebrew/macOS pythons this hits PEP 668 ("externally managed environment") - append `--break-system-packages`, or `--user`.
- **poppler** - `brew install poppler` - provides `pdftotext`, which the PDF extraction runbook shells out to (AIS/TIS/26AS arrive as password-protected PDFs)
- **git** - comes with the Command Line Tools
- Optional: **LibreOffice** - only for headless xlsx recalculation; not required (the builder self-verifies its formulas and Excel recalculates on open)

**Friendly terminal setup** (optional; what the first ported machine runs): install **Ghostty**, then configure `~/.config/ghostty/config` with a light high-contrast theme, a larger font, `working-directory` pointing at this folder, and `command` pointing at a small wrapper script (`~/.local/bin/claude-tax`: `#!/bin/zsh`, `cd ~/india-itr-toolkit && exec ~/.local/bin/claude`). Add a LaunchAgent that runs `open -a Ghostty` at login. Result: the operator logs in and the assistant is already open in the right folder - no shell, no commands. Simpler fallback: a `~/Desktop/Tax Toolkit.command` containing `cd <absolute path to this folder> && exec claude` (mark executable; opens in Terminal).

Permission prompts are pre-answered by the committed `.claude/settings.json`: the toolkit's whole command surface (bun run, the scripts, git pull/commit/push, pdftotext) is allow-listed, edits inside the repo are auto-accepted, and force-push/hard-reset are denied outright. Anything outside that list still prompts or is judged by the harness - by design; do not widen the list casually.

## 2. Move the folder

Two parts, moved differently:

- **Toolkit** (scripts, docs, samples): a git clone. The public home is `github.com/kznconsulting/india-itr-toolkit`; a practice whose operator machines push gap-ledger entries back typically runs its own private fork or copy of it. For an operator machine that pushes, create a free GitHub account for the operator and invite it as a collaborator on the practice's repo (same repo for everyone, not per-person forks - it stays the single two-way sync channel: the maintainer pushes fixes, the operator's machine pulls, and local toolkit improvements are committed and pushed back for the maintainer to review). Authenticate with `gh auth login` on the new machine and set the commit identity: `git config user.name "<operator>"` and `git config user.email "<their email>"`. Note the commit identity becomes public on a public repo - use GitHub's noreply email. Alternative that needs no GitHub at all: copy the folder wholesale including `.git` (AirDrop/USB) and pull later when convenient.
- **Client data** (`clients/`): gitignored on purpose (PAN, Aadhaar, bank details). Always transferred separately and securely - AirDrop, encrypted disk, or a direct copy. Never email it, never put it in a cloud drive unencrypted, never commit it.

```sh
# on the new machine
git clone https://github.com/kznconsulting/india-itr-toolkit.git   # or the practice's private fork, or copy the folder wholesale
# then place the clients/ directory inside it
```

## 3. Verify

```sh
cd india-itr-toolkit
echo operator > .machine-role   # marks this as an operator machine: the agent commits and
                                # pushes toolkit changes proactively (AGENTS.md); gitignored
bun run doctor      # checks bun, python3, openpyxl, tax engine, statement builder
```

All checks must PASS. Each FAIL line names its fix.

## 4. Day-to-day operation (what the operator actually runs)

| Task | Command | Runbook |
|---|---|---|
| Gather a client's portal documents | `/fetch-portal-docs` (agent skill; operator logs in) | the skill file |
| New client-year: PDFs → statement | fill `statement-data.json`, then `bun run statement <data.json>` | docs/extract-from-pdfs.md |
| Generate the return JSON | `bun run generate <data.json> --template <prior-filed.json>` | script docstring |
| Pre-upload verification | `bun run check`, `bun run process`, `bun run prefill` | docs/workflow.md step 6 |
| First-year client (no template) | `bun run guide <data.json>`, then `/file-return` | the skill file |
| Review a return JSON from the portal | `bun run process <file.json>` | docs/workflow.md |
| Whole-practice overview | `bun run status` | docs/workflow.md |
| Tax lookups incl. 244A refund interest | `bun run tax compute\|rules\|ageband\|refund-interest ...` | script docstring |
| Annual updates (each Finance Act / new AY) | edit `scripts/lib/tax.ts` + `docs/reference.md`, add tests; re-download `schemas/AY<new>/` | AGENTS.md gotchas |

## 5. Updates

The repo is the deployment channel; nothing needs remote access to the machine:

- **Toolkit updates**: fixes are pushed to the git remote from the maintainer's machine; on this machine the operator just asks the agent to "update the toolkit", which runs `git pull` then `bun run doctor` (all green or the FAIL line names the fix). Local toolkit fixes flow the other way: commit and push them for the maintainer to review. Client data never travels over git - the gitignore plus the `.githooks/pre-commit` guard (enabled by doctor) block `clients/`, `reports/`, and machine-local config from ever entering history.
- **Tool updates**: occasionally `brew upgrade bun poppler` (Claude Code updates itself) - the agent can run this too.
- **New assessment year**: pull (the maintainer commits the new `schemas/AY<new>/` and tax-engine rules); nothing else changes on this machine.

When something breaks beyond what a pull fixes, the escalation path is the gap ledger (AGENTS.md "Escalate, don't extend"): the operator parks the client and pushes the entry; the maintainer ships the fix through the same remote. Do not set up standing remote access (SSH, screen sharing) to an operator machine - it holds client PII, and this workflow is designed so nobody ever needs to log into it.

## 6. Operating principles on the new machine

- The scripts are self-verifying; a green build means the arithmetic reconciles. If a check fails, fix the input data, never bypass the check.
- Anything the toolkit cannot verify is flagged in the statement's Notes for a human to confirm.
- Client folders are the privacy boundary: one client's documents never go into another's folder, and nothing under `clients/` leaves the machine.
