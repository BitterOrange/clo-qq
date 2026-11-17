# Shared environment for project scripts on Linux. Source this; it only changes the current shell.
# shellcheck shell=bash
# Needs no external command, so the wrappers run with the private Node folder as the whole PATH.
# The wrappers find this file next to themselves. A symlink to a wrapper file from another folder cannot be followed
# without an external command (readlink), so they stop there with a message; a symlinked project or scripts folder works.
case "${BASH_SOURCE[0]}" in
  */*) CLO_SCRIPTS="${BASH_SOURCE[0]%/*}" ;;
  *) CLO_SCRIPTS=. ;;
esac
CLO_ROOT="$(CDPATH='' cd -P -- "$CLO_SCRIPTS/.." && pwd -P)"
CLO_REPO_RT="$CLO_ROOT/.runtime"
# Tests move project state, never the private Node or packages.
if [ -n "${CLO_TEST_ROOT:-}" ]; then CLO_RT="$CLO_TEST_ROOT/.runtime"; else CLO_RT="$CLO_REPO_RT"; fi
CLO_NODE_DIR="$CLO_REPO_RT/node"
CLO_NODE="$CLO_NODE_DIR/bin/node"
CLO_NPM_CLI="$CLO_NODE_DIR/lib/node_modules/npm/bin/npm-cli.js"
CLO_PKG_DIR="$CLO_REPO_RT/pkg"
CLO_CLI_MJS="$CLO_ROOT/src/cli/clo.mjs"

# No proxy may reach any request made by this project.
# NODE_OPTIONS too: --use-env-proxy there turns Node's env proxy on at startup, and --require could load anything.
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy NO_PROXY no_proxy NPM_CONFIG_PROXY NPM_CONFIG_HTTPS_PROXY NODE_USE_ENV_PROXY NODE_OPTIONS

# State isolation: never read or write the user's default OpenClaw directories.
export OPENCLAW_HOME="$CLO_RT/home"
export OPENCLAW_STATE_DIR="$CLO_RT/state"
export OPENCLAW_CONFIG_PATH="$CLO_RT/state/openclaw.json"
export OPENCLAW_WORKSPACE_DIR="$CLO_RT/workspace"

clo_exec() {
  # Replaces this shell with the console on the private Node, so its output and exit code are the caller's.
  # start returns once the Gateway is up: the Gateway writes to its own log and holds none of this shell's output.
  if [ ! -x "$CLO_NODE" ]; then
    echo 'Private Node is missing. Run scripts/setup.sh first.' >&2
    exit 1
  fi
  exec "$CLO_NODE" --disable-warning=ExperimentalWarning "$CLO_CLI_MJS" "$@"
}

clo_npm() {
  # PATH changes only in this subshell, so lifecycle scripts cannot pick up a system Node.
  local workdir="$1"
  shift
  (
    export PATH="$CLO_NODE_DIR/bin:$PATH"
    cd -- "$workdir" || exit 1
    exec "$CLO_NODE" "$CLO_NPM_CLI" "$@"
  ) || { echo "npm $* failed" >&2; return 1; }
}
