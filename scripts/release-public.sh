#!/bin/bash
# Public-release sync: copy master's tree onto public-release as ONE curated,
# re-authored commit, after hard-failing PII scans. Maintainer tooling; runbook:
# docs/maintainer.md "Public release sync". Dry-run by default; never pushes.
#
# Usage:
#   scripts/release-public.sh                     # dry-run: scans + outgoing diff
#   scripts/release-public.sh --commit -m "msg"   # scans, then commit on public-release
set -u
cd "$(dirname "$0")/.."

die() { echo "FAIL: $1" >&2; exit 1; }

commit=0; msg=""
while [ $# -gt 0 ]; do
  case "$1" in
    --commit) commit=1; shift ;;
    -m) msg="${2:?-m needs a message}"; shift 2 ;;
    *) die "unknown arg '$1' (usage: release-public.sh [--commit -m \"message\"])" ;;
  esac
done
[ "$commit" = 1 ] && [ -z "$msg" ] && die '--commit needs -m "curated release message"'
git rev-parse --verify -q public-release >/dev/null || die "no public-release branch on this machine"

echo "== PII scans on master's tree"
bad=0

# 1. PAN-shaped strings outside the fictitious fixtures (samples/, schemas/, tests)
if git grep -nE '\b[A-Z]{5}[0-9]{4}[A-Z]\b' master -- ':!samples' ':!schemas' ':!*test*'; then
  echo "   ^ PAN-pattern hits"; bad=1
else
  echo "   PAN pattern: clean"
fi

# 2. Maintainer-local terms (client names, operator identity, machine hostnames).
#    Gitignored on purpose: the terms themselves are the PII.
terms=.release-scan-terms
[ -s "$terms" ] || die "$terms missing/empty - create it (gitignored): one case-insensitive regex per line covering client names, operator identity, machine hostnames"
nterms=0
while IFS= read -r re; do
  [ -z "$re" ] && continue
  case "$re" in \#*) continue ;; esac
  nterms=$((nterms+1))
  git grep -inE "$re" master -- .
  rc=$?
  [ $rc = 0 ] && { echo "   ^ term hits: $re"; bad=1; }
  [ $rc = 2 ] && die "bad regex in $terms: $re"
done < "$terms"
[ "$bad" = 0 ] && echo "   local terms ($nterms patterns): clean"

# 3. Nothing tracked under clients/ beyond the placeholder
extra=$(git ls-tree -r --name-only master -- clients/ | grep -v '^clients/\.gitkeep$')
[ -n "$extra" ] && { echo "   tracked files under clients/: $extra"; bad=1; }

[ "$bad" = 0 ] || die "scan hits above - fix on master (or extend the fixture exclusions consciously), then re-run"
echo "   all scans clean"

# 4. Divergence guard: refuse to strand commits that exist only on the public remote
if git fetch public 2>/dev/null; then
  git merge-base --is-ancestor public/master public-release ||
    die "public/master has commits NOT in public-release (external PR?) - reconcile into master first; never force-push public"
else
  echo "WARN: could not fetch 'public' - divergence unchecked (offline?)"
fi

mtree=$(git rev-parse 'master^{tree}')
[ "$mtree" = "$(git rev-parse 'public-release^{tree}')" ] && { echo "nothing to release: public-release already matches master"; exit 0; }

echo
echo "== outgoing diff (public-release -> master tree)"
git diff --stat public-release master
last=$(git log -1 --format=%B public-release | sed -n 's/^Synced-from: //p')
if [ -n "$last" ]; then
  echo
  echo "== master commits in this batch"
  git log --oneline "$last..master"
fi

if [ "$commit" = 0 ]; then
  echo
  echo 'dry-run only - review the diff above, then: scripts/release-public.sh --commit -m "<curated message>"'
  exit 0
fi

# Re-author to the public identity taken from the branch's own history, so the
# local machine's git config (operator identity included) can never leak into
# a public commit.
an=$(git log -1 --format=%an public-release); ae=$(git log -1 --format=%ae public-release)
old=$(git rev-parse public-release)
new=$(GIT_AUTHOR_NAME="$an" GIT_AUTHOR_EMAIL="$ae" GIT_COMMITTER_NAME="$an" GIT_COMMITTER_EMAIL="$ae" \
      git commit-tree "$mtree" -p "$old" -m "$msg" -m "Synced-from: $(git rev-parse master)") || die "commit-tree failed"
git update-ref refs/heads/public-release "$new" "$old" || die "update-ref failed (public-release moved underneath us?)"
echo "committed $(git rev-parse --short "$new") on public-release (author: $an <$ae>)"
echo "review:  git show --stat public-release"
echo "publish: git push public public-release:master   (maintainer decision - not automated)"
