#!/bin/bash
# Environment check for the india-itr-toolkit. Run after cloning or porting
# to a new machine (see docs/porting.md). Exits non-zero if anything required
# is missing.
set -u
cd "$(dirname "$0")/.."

pass=0; fail=0
ok()   { echo "  PASS  $1"; pass=$((pass+1)); }
bad()  { echo "  FAIL  $1"; fail=$((fail+1)); }

echo "india-itr-toolkit doctor"
echo

if command -v bun >/dev/null 2>&1; then ok "bun $(bun --version)"; else bad "bun not found - install from https://bun.sh"; fi
if command -v python3 >/dev/null 2>&1; then ok "python3 $(python3 --version 2>&1 | cut -d' ' -f2)"; else bad "python3 not found"; fi
if python3 -c "import openpyxl" 2>/dev/null; then ok "python openpyxl"; else bad "openpyxl missing - pip3 install openpyxl"; fi
if python3 -c "import jsonschema" 2>/dev/null; then ok "python jsonschema"; else bad "jsonschema missing - pip3 install jsonschema (needed by generate-itr)"; fi
if command -v pdftotext >/dev/null 2>&1; then ok "pdftotext (poppler)"; else bad "pdftotext missing - brew install poppler (needed by the PDF extraction runbook)"; fi

if [ "$(git config core.hooksPath 2>/dev/null)" = ".githooks" ]; then
  ok "git PII pre-commit guard (.githooks)"
elif git config core.hooksPath .githooks 2>/dev/null; then
  ok "git PII pre-commit guard (enabled just now)"
else
  bad "could not enable the PII pre-commit guard - run 'git config core.hooksPath .githooks' inside the repo"
fi

if bun test >/dev/null 2>&1; then ok "bun test (slab engine)"; else bad "bun test failed - run 'bun test' to see why"; fi

if bun scripts/tax-cli.ts compute --income 1000000 --regime new --ay 2026-27 2>/dev/null | grep -q '"total"'; then
  ok "tax-cli bridge"
else
  bad "tax-cli bridge failed - run 'bun scripts/tax-cli.ts compute --income 1000000 --regime new --ay 2026-27'"
fi

if python3 -m py_compile scripts/build-statement.py scripts/generate-itr.py scripts/check-rules.py scripts/compare-prefill.py 2>/dev/null; then
  ok "python scripts compile (builder, generator, rule checker, prefill diff)"
else
  bad "a python script fails to compile - run 'python3 -m py_compile scripts/*.py'"
fi

SMOKE_OUT="${TMPDIR:-/tmp}/india-itr-toolkit-doctor-statement.xlsx"
if python3 scripts/build-statement.py samples/sample-statement-data.json --out "$SMOKE_OUT" >/dev/null 2>&1; then
  ok "statement builder (sample data)"
  rm -f "$SMOKE_OUT"
else
  bad "statement builder failed - run 'python3 scripts/build-statement.py samples/sample-statement-data.json' to see why"
fi

if command -v soffice >/dev/null 2>&1 || [ -d "/Applications/LibreOffice.app" ]; then
  ok "LibreOffice (optional, for xlsx recalculation)"
else
  echo "  note  LibreOffice not installed (optional) - the builder self-verifies formulas; Excel recalculates on open"
fi

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
