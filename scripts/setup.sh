#!/usr/bin/env bash
# Installs the private Node and locked packages on Linux x64, as the current user. Safe to run repeatedly.
# Needs no root rights and never changes the system Node or PATH.
#   setup.sh             private Node and the QQ SDK (enough for Q0)
#   setup.sh --runtime   also OpenClaw and the search plugin
set -euo pipefail
case "${BASH_SOURCE[0]}" in */*) clo_here="${BASH_SOURCE[0]%/*}" ;; *) clo_here=. ;; esac
[ -f "$clo_here/_env.sh" ] || { echo "No _env.sh next to ${BASH_SOURCE[0]}. Link the project folder, not the script file." >&2; exit 2; }
. "$clo_here/_env.sh"

runtime=0
for arg in "$@"; do
  case "$arg" in
    --runtime) runtime=1 ;;
    *) echo "Unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'setup.sh supports Linux x64 only. On Windows use scripts\setup.ps1.' >&2
  exit 1
fi

lock="$CLO_ROOT/versions.lock.json"

# One field of the nodeLinuxX64 entry, read before any Node exists. Only the known shape is accepted: anything that
# does not match exactly once stops here, and nothing is downloaded.
lock_field() {
  local key="$1" pattern="$2" block value
  block="$(sed -n '/^  "nodeLinuxX64": {$/,/^  },\{0,1\}$/p' "$lock")"
  value="$(printf '%s\n' "$block" | sed -n "s/^    \"$key\": \"\\($pattern\\)\",\\{0,1\\}\$/\\1/p")"
  if [ -z "$value" ] || [ "$(printf '%s\n' "$value" | wc -l)" -ne 1 ]; then
    echo "versions.lock.json: nodeLinuxX64.$key is missing or malformed. Nothing was installed." >&2
    exit 1
  fi
  printf '%s' "$value"
}

ver="$(lock_field version '[0-9]\{1,3\}\.[0-9]\{1,3\}\.[0-9]\{1,3\}')"
sha="$(lock_field sha256 '[0-9a-f]\{64\}')"
file="$(lock_field file '[^"]*')"
url="$(lock_field url '[^"]*')"
if ! [[ "$sha" =~ ^[0-9a-f]{64}$ ]] || [ "$file" != "node-v$ver-linux-x64.tar.xz" ] || [ "$url" != "https://nodejs.org/dist/v$ver/$file" ]; then
  echo 'versions.lock.json: the nodeLinuxX64 entry is inconsistent. Nothing was installed.' >&2
  exit 1
fi

# The runtime folder holds the ledger, the Gateway token and logs: owner-only, whatever the umask. Ubuntu's default
# umask 002 would leave it group-writable. Only this folder is narrowed; what is inside is the console's to narrow.
( umask 077 && mkdir -p -- "$CLO_RT" "$CLO_REPO_RT" )
chmod go-rwx -- "$CLO_RT" "$CLO_REPO_RT"

# 1. Private Node, verified before extraction.
wanted="v$ver"
have=''
if [ -x "$CLO_NODE" ]; then have="$("$CLO_NODE" --version 2>/dev/null || true)"; fi
if [ "$have" != "$wanted" ]; then
  tarball="$CLO_RT/$file"
  if [ ! -f "$tarball" ]; then
    echo "Downloading $file"
    # -q first: no curlrc, so no proxy or other setting comes from the user's files.
    if ! curl -q --fail --location --proto '=https' --proto-redir '=https' --silent --show-error --output "$tarball.part" "$url"; then
      rm -f -- "$tarball.part"
      echo 'Download failed. Nothing was installed.' >&2
      exit 1
    fi
    mv -f -- "$tarball.part" "$tarball"
  fi
  got="$(sha256sum < "$tarball")"
  got="${got%% *}"
  if [ "$got" != "$sha" ]; then
    rm -f -- "$tarball"
    echo "Node tarball checksum mismatch: got $got. The file was removed. Nothing was installed." >&2
    exit 1
  fi
  tmp="$CLO_RT/node-extract"
  rm -rf -- "$tmp"
  mkdir -p -- "$tmp"
  tar -xJf "$tarball" -C "$tmp" --no-same-owner
  if [ ! -x "$tmp/${file%.tar.xz}/bin/node" ]; then
    rm -rf -- "$tmp"
    echo 'The tarball holds no bin/node where expected. Nothing was installed.' >&2
    exit 1
  fi
  rm -rf -- "$CLO_NODE_DIR"
  mv -- "$tmp/${file%.tar.xz}" "$CLO_NODE_DIR"
  rm -rf -- "$tmp"
  rm -f -- "$tarball"
fi
have="$("$CLO_NODE" --version)"
if [ "$have" != "$wanted" ]; then
  echo "Private Node reports $have, expected $wanted." >&2
  exit 1
fi
# The same entry read as JSON must agree with the strict read above.
"$CLO_NODE" -e '
const [file, ver, sha, name, url] = process.argv.slice(1);
const e = JSON.parse(require("fs").readFileSync(file, "utf8").replace(/^\uFEFF/, "")).nodeLinuxX64 ?? {};
if (e.version !== ver || e.sha256 !== sha || e.file !== name || e.url !== url) {
  console.error("versions.lock.json reads differently as JSON. Stopped.");
  process.exit(1);
}' "$lock" "$ver" "$sha" "$file" "$url"
echo "Private Node: $have"

# The installed lock entry must match versions.lock.json in version and integrity.
assert_lock() {
  "$CLO_NODE" -e '
const fs = require("fs");
const [lockFile, versions, name] = process.argv.slice(1);
const want = JSON.parse(fs.readFileSync(versions, "utf8").replace(/^\uFEFF/, "")).npm?.[name];
const p = JSON.parse(fs.readFileSync(lockFile, "utf8")).packages?.["node_modules/" + name];
const fail = (m) => { console.error(m); process.exit(1); };
if (!want) fail(name + " is missing from versions.lock.json");
if (!p) fail(name + " is missing from " + lockFile);
if (p.version !== want.version) fail(name + " is " + p.version + " in the lockfile, expected " + want.version);
if (p.integrity !== want.integrity) fail(name + " integrity in the lockfile differs from versions.lock.json");
' "$1" "$lock" "$2"
}

# 2. QQ SDK. npm ci enforces the lockfile. Off Windows there is no first run that creates it.
if [ ! -f "$CLO_ROOT/package-lock.json" ]; then
  echo 'package-lock.json is missing. Nothing more was installed.' >&2
  exit 1
fi
clo_npm "$CLO_ROOT" ci --ignore-scripts --no-audit --no-fund
assert_lock "$CLO_ROOT/package-lock.json" '@tencent-connect/qqbot-nodejs'
echo 'QQ SDK: locked version and integrity verified'

# 3. OpenClaw and the search plugin, kept in .runtime/pkg.
if [ "$runtime" = 1 ]; then
  src="$CLO_ROOT/runtime-lock"
  if [ ! -f "$src/package-lock.json" ]; then
    echo 'runtime-lock/package-lock.json is missing. Nothing more was installed.' >&2
    exit 1
  fi
  mkdir -p -- "$CLO_PKG_DIR"
  cp -f -- "$src/package.json" "$src/package-lock.json" "$CLO_PKG_DIR/"
  clo_npm "$CLO_PKG_DIR" ci --no-audit --no-fund
  for name in openclaw '@openclaw/perplexity-plugin'; do
    assert_lock "$CLO_PKG_DIR/package-lock.json" "$name"
  done
  echo 'OpenClaw and search plugin: locked versions and integrity verified'
fi
# 4. .env and config.json from their templates, only where missing, readable by this user alone. git keeps no mode
# but the executable bit, so the templates cannot carry 0600; umask 077 makes the copy 0600. An existing file is
# never touched: its mode is the user's (doctor reports a wide .env).
for pair in '.env.example:.env' 'config.example.json:config.json'; do
  from="$CLO_ROOT/${pair%%:*}"
  to="$CLO_ROOT/${pair#*:}"
  if [ ! -e "$to" ] && [ -f "$from" ]; then
    ( umask 077 && cp -- "$from" "$to" )
    echo "Created ${pair#*:} from ${pair%%:*} (owner-only). Fill it in yourself."
  fi
done
echo 'Setup finished. System Node and PATH were not changed.'
