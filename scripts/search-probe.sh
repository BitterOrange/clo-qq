#!/usr/bin/env bash
# Search probe: one decision call with the search schema and one Sonar call, with a Key of its own.
#   search-probe.sh                            shows the fixed texts, the two calls and the worst case. No request, .env not read.
#   search-probe.sh --approve --max-usd 0.10   spends money, after the user has agreed to that cap. It reads CLO_TEST_API_KEY,
#                                              whose daily limit must not be above the cap.
# Results go to captures/search-probe-results.jsonl as field names, numbers and classifications only.
set -euo pipefail
case "${BASH_SOURCE[0]}" in */*) clo_here="${BASH_SOURCE[0]%/*}" ;; *) clo_here=. ;; esac
[ -f "$clo_here/_env.sh" ] || { echo "No _env.sh next to ${BASH_SOURCE[0]}. Link the project folder, not the script file." >&2; exit 2; }
. "$clo_here/_env.sh"
if [ ! -x "$CLO_NODE" ]; then
  echo 'Private Node is missing. Run scripts/setup.sh first.' >&2
  exit 1
fi
exec "$CLO_NODE" --disable-warning=ExperimentalWarning "$CLO_ROOT/src/tools/search-probe.mjs" "$@"
