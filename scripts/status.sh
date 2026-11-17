#!/usr/bin/env bash
# Mode, liveness, pauses, spend today and alerts. Read only, unless --ack is given.
set -euo pipefail
case "${BASH_SOURCE[0]}" in */*) clo_here="${BASH_SOURCE[0]%/*}" ;; *) clo_here=. ;; esac
[ -f "$clo_here/_env.sh" ] || { echo "No _env.sh next to ${BASH_SOURCE[0]}. Link the project folder, not the script file." >&2; exit 2; }
. "$clo_here/_env.sh"
clo_exec status "$@"
