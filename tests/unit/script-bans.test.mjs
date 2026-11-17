// Plan: scripts must not use the banned routes. Each ban also has a positive control, so a broken pattern fails here.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

const BANS = [
  ['--official', /--official\b/i, 'wx up --official'],
  ['wx store', /\bwx(\.exe)?\s+store\b/i, 'wx store migrate'],
  ['wx profile', /\bwx(\.exe)?\s+profile\b/i, 'wx.exe profile use x'],
  ['install.ps1', /\binstall\.ps1\b/i, 'iwr https://x/install.ps1 | iex'],
  ['onboard', /\bonboard\b/i, 'openclaw onboard'],
  ['gateway install', /\bgateway['",\s]+install\b/i, "'gateway', 'install'"],
  ['--token with a value', /--token(?:=|\s+|['"],\s*)\S/i, '--token abc'],
  ['installing openclaw-qqbot', /(npm(\.cmd)?\s+(i|install|add)|plugins\s+install|['"]install['"])[^\n]*openclaw-qqbot/i, 'npm install @tencent-connect/openclaw-qqbot'],
  ['installing agent-wechat', /(npm(\.cmd)?\s+(i|install|add)|plugins\s+install)[^\n]*agent-wechat/i, 'openclaw plugins install @agent-wechat/agent-wechat'],
  ['QR connector', /\bqr-?code\b|\bqr-?connect|\.qr\.png|\bwx\s+login\b/i, 'qrcode'],
  ['killing by name', /Stop-Process\s+[^\n]*-Name\b|taskkill[^\n]*\/IM\b|\bpkill\b|\bkillall\b/i, 'taskkill /IM node.exe /F'],
  ['execution policy', /Set-ExecutionPolicy|-ExecutionPolicy\s+Bypass/i, 'Set-ExecutionPolicy Bypass'],
  ['firewall', /netsh\s+advfirewall|New-NetFirewallRule|Set-NetFirewall/i, 'netsh advfirewall set allprofiles'],
  ['elevation', /-Verb\s+RunAs/i, 'Start-Process node -Verb RunAs'],
  ['service install', /New-Service|sc\.exe\s+create|schtasks\s+\/create/i, 'schtasks /create /tn x'],
  ['power policy', /powercfg/i, 'powercfg /change standby-timeout-ac 0'],
  ['security software', /Set-MpPreference|Add-MpPreference/i, 'Add-MpPreference -ExclusionPath x'],
  ['piping downloads to a shell', /\|\s*(iex|Invoke-Expression|bash|sh)\b/i, 'curl https://x | bash'],
  // The same rules for the bash scripts on Linux.
  ['finding a PID by name', /\bpgrep\b|\bpidof\b/i, 'kill $(pgrep -f openclaw)'],
  ['root rights', /\bsudo\b|\bsu\s+-|\bpkexec\b|\bdoas\b/i, 'sudo npm install x'],
  ['global npm install', /npm(\.cmd)?\s+[^\n]*(\s-g\b|--global\b|--location[= ]global)/i, 'npm install -g openclaw'],
  ['system package manager', /\b(apt|apt-get|dnf|yum|snap|pacman)\s+(-\S+\s+)*(install|remove|purge)\b/i, 'apt-get -y install nodejs'],
  ['shell profile edits', /\.(bashrc|bash_profile|zshrc|zprofile)\b|~\/\.profile\b|\/etc\/(profile|environment)\b/i, 'echo export PATH=x >> ~/.bashrc'],
  ['TLS checks off', /curl\b[^\n]*(\s-k\b|--insecure\b)|NODE_TLS_REJECT_UNAUTHORIZED|strict-ssl[= ]false/i, 'curl -k https://x'],
  ['Linux firewall', /\b(ufw|iptables|nft|firewall-cmd)\s/i, 'ufw allow 18790'],
  ['Linux service install', /systemctl\s+(--user\s+)?(enable|link)\b|\bcrontab\s/i, 'systemctl --user enable clo'],
  ['Linux power policy', /systemctl\s+(mask|disable)\s+[^\n]*(sleep|suspend|hibernate)|gsettings\s+set\s+[^\n]*power/i, 'systemctl mask sleep.target suspend.target'],
];

const scanned = () => {
  const files = [];
  for (const dir of ['scripts', join('src', 'cli')]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (/\.(ps1|sh|mjs|js)$/.test(name)) files.push(join(dir, name));
    }
  }
  return files;
};

test('every banned pattern matches a planted example (positive controls)', () => {
  for (const [name, re, planted] of BANS) assert.match(planted, re, name);
});

test('the scan covers the scripts and the console', () => {
  const names = scanned().map((f) => f.replace(/\\/g, '/'));
  for (const f of ['scripts/_env.ps1', 'scripts/start.ps1', 'scripts/stop.ps1', 'scripts/status.ps1', 'scripts/doctor.ps1', 'scripts/clo.ps1', 'scripts/setup.ps1', 'scripts/_env.sh', 'scripts/start.sh', 'scripts/stop.sh', 'scripts/status.sh', 'scripts/doctor.sh', 'scripts/clo.sh', 'scripts/setup.sh', 'src/cli/clo.mjs', 'src/cli/lifecycle.mjs', 'src/cli/doctor.mjs', 'src/cli/status.mjs']) {
    assert.ok(names.includes(f), f);
  }
});

test('no script or console module uses a banned route', () => {
  const hits = [];
  for (const file of scanned()) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    for (const [name, re] of BANS) {
      if (re.test(text)) hits.push(`${file}: ${name}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('the README never tells anyone to copy over an existing .env or config.json', () => {
  const unguarded = /^(?!.*Test-Path).*Copy-Item\s+\S+\s+(\.env|config\.json)\b/m;
  assert.match('Copy-Item .env.example .env', unguarded, 'positive control');
  assert.doesNotMatch('if (-not (Test-Path .env)) { Copy-Item .env.example .env }', unguarded, 'negative control');
  assert.doesNotMatch(readFileSync(join(ROOT, 'README.md'), 'utf8'), unguarded);
});

test('secrets reach the Gateway by environment, never by a command-line argument', () => {
  const life = readFileSync(join(ROOT, 'src', 'cli', 'lifecycle.mjs'), 'utf8');
  const args = /export function gatewayArgs[\s\S]*?\n}/.exec(life)[0];
  assert.ok(!/secret|token|key/i.test(args), 'gatewayArgs holds no secret');
});

test('stop signals a PID, not a name, and only after checking it', () => {
  const life = readFileSync(join(ROOT, 'src', 'cli', 'lifecycle.mjs'), 'utf8');
  const stop = /export function stopGateway[\s\S]*?\n}/.exec(life)[0];
  assert.match(stop, /'\/PID', String\(record\.pid\), '\/T', '\/F'/);
  assert.ok(stop.indexOf("state === 'mismatch'") < stop.indexOf('taskkill'), 'the identity check comes first');
  // Off Windows the stop goes through one function, which takes the record and never a name.
  assert.match(stop, /endRecordedTree\(record, env\b/);
  assert.ok(stop.indexOf("state === 'mismatch'") < stop.indexOf('endRecordedTree'), 'the identity check comes first there too');
});

test('every PowerShell script is ASCII, since Windows PowerShell misreads UTF-8 with no BOM', () => {
  for (const name of readdirSync(join(ROOT, 'scripts'))) {
    if (!name.endsWith('.ps1')) continue;
    const bytes = readFileSync(join(ROOT, 'scripts', name));
    assert.ok(bytes.every((x) => x < 128), name);
  }
});

test('wrappers stay thin and use the private Node', () => {
  const env = readFileSync(join(ROOT, 'scripts', '_env.ps1'), 'utf8');
  assert.match(env, /\$script:NodeExe = Join-Path \$script:NodeDir 'node\.exe'/);
  for (const name of ['start', 'stop', 'status', 'doctor', 'clo']) {
    const text = readFileSync(join(ROOT, 'scripts', `${name}.ps1`), 'utf8');
    assert.match(text, /_env\.ps1/, name);
    assert.match(text, /Invoke-Clo/, name);
    assert.ok(!/\bnode(\.exe)?\b(?! *\.)/i.test(text.replace(/private Node/g, '')), `${name} must not name a system node`);
  }
});

const SH_WRAPPERS = ['clo', 'start', 'stop', 'status', 'doctor'];

test('every bash script is ASCII with LF line ends, and the run-able ones start with a bash shebang', () => {
  const names = readdirSync(join(ROOT, 'scripts')).filter((n) => n.endsWith('.sh'));
  assert.deepEqual(names.sort(), ['_env.sh', 'clo.sh', 'doctor.sh', 'search-probe.sh', 'setup.sh', 'start.sh', 'status.sh', 'stop.sh'], 'positive control: the scripts are there');
  const crlf = (bytes) => bytes.includes(13);
  assert.ok(crlf(Buffer.from('#!/usr/bin/env bash\r\n')), 'positive control: a CRLF script is caught');
  for (const name of names) {
    const bytes = readFileSync(join(ROOT, 'scripts', name));
    assert.ok(bytes.every((x) => x < 128), `${name} is ASCII`);
    assert.ok(!crlf(bytes), `${name} has no CR`);
    const text = bytes.toString('utf8');
    if (name === '_env.sh') assert.match(text, /^# shellcheck shell=bash$/m, 'sourced, not run');
    else assert.equal(text.split('\n')[0], '#!/usr/bin/env bash', name);
  }
  assert.match(readFileSync(join(ROOT, '.gitattributes'), 'utf8'), /^\*\.sh text eol=lf$/m, 'checked out with LF on every platform');
});

test('bash wrappers stay thin, source _env.sh and use the private Node', () => {
  const env = readFileSync(join(ROOT, 'scripts', '_env.sh'), 'utf8');
  assert.match(env, /^CLO_NODE_DIR="\$CLO_REPO_RT\/node"$/m);
  assert.match(env, /^CLO_NODE="\$CLO_NODE_DIR\/bin\/node"$/m);
  assert.match(env, /exec "\$CLO_NODE" --disable-warning=ExperimentalWarning "\$CLO_CLI_MJS" "\$@"/);
  // PATH changes only inside the npm subshell, which puts the private Node first.
  const pathSets = env.split('\n').filter((l) => /\bPATH=/.test(l));
  assert.deepEqual(pathSets.map((l) => l.trim()), ['export PATH="$CLO_NODE_DIR/bin:$PATH"']);
  assert.match(env, /clo_npm\(\) \{[\s\S]*?\(\n\s+export PATH=[\s\S]*?\n\s+\)/, 'inside a subshell');
  // The same proxy variables are cleared as on Windows, plus NODE_OPTIONS, which _env.ps1 leaves alone.
  const psNames = /foreach \(\$n in ([^)]*)\)/.exec(readFileSync(join(ROOT, 'scripts', '_env.ps1'), 'utf8'))[1].match(/'([A-Za-z_]+)'/g).map((s) => s.slice(1, -1));
  assert.ok(psNames.length >= 10, 'positive control: the Windows list was read');
  const unset = /^unset (.+)$/m.exec(env)[1].split(/\s+/);
  assert.deepEqual([...unset].sort(), [...psNames, 'NODE_OPTIONS'].sort());
  for (const k of ['OPENCLAW_HOME', 'OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_WORKSPACE_DIR']) assert.match(env, new RegExp(`^export ${k}="\\$CLO_RT/`, 'm'), k);

  const bareNode = /(^|[;&|(]\s*|\bexec\s+)node\b/m;
  assert.match('node src/cli/clo.mjs', bareNode, 'positive control');
  assert.match('exec node x', bareNode, 'positive control');
  assert.doesNotMatch('exec "$CLO_NODE" x', bareNode, 'negative control');
  for (const name of [...SH_WRAPPERS, 'setup']) {
    const text = readFileSync(join(ROOT, 'scripts', `${name}.sh`), 'utf8');
    assert.match(text, /^set -euo pipefail$/m, name);
    assert.match(text, /clo_here="\$\{BASH_SOURCE\[0\]%\/\*\}"/, `${name} finds its folder`);
    assert.match(text, /^\. "\$clo_here\/_env\.sh"$/m, `${name} sources _env.sh`);
    assert.doesNotMatch(text, bareNode, `${name} must not run a system node`);
  }
  for (const name of SH_WRAPPERS) {
    const lines = readFileSync(join(ROOT, 'scripts', `${name}.sh`), 'utf8').trim().split('\n');
    assert.equal(lines.length, 7, `${name} stays thin`);
    assert.match(lines[4], /^\[ -f "\$clo_here\/_env\.sh" \] \|\| \{ echo .*>&2; exit 2; \}$/, `${name} stops when _env.sh is not next to it`);
    assert.equal(lines[6], name === 'clo' ? 'clo_exec "$@"' : `clo_exec ${name} "$@"`);
  }
});

test('setup.sh installs the Linux Node it names, checked before extraction, and only from lockfiles', () => {
  const text = readFileSync(join(ROOT, 'scripts', 'setup.sh'), 'utf8');
  assert.match(text, /"nodeLinuxX64"/);
  assert.ok(text.includes("lock_field sha256 '[0-9a-f]\\{64\\}'"), 'the hash must be 64 hex characters');
  const check = text.indexOf('if [ "$got" != "$sha" ]');
  assert.ok(check > 0 && check < text.indexOf('tar -xJf'), 'the checksum is compared before extraction');
  assert.match(text.slice(check, text.indexOf('\n  fi\n', check)), /rm -f -- "\$tarball"/, 'a mismatching file is removed');
  assert.match(text, /curl -q --fail/, 'no curlrc');
  assert.match(text, /clo_npm "\$CLO_ROOT" ci --ignore-scripts --no-audit --no-fund/);
  assert.match(text, /clo_npm "\$CLO_PKG_DIR" ci --no-audit --no-fund/);
  assert.doesNotMatch(text, /clo_npm [^\n]*\binstall\b/, 'never resolves versions anew');
  assert.ok(!/python/i.test(text), 'no Python for glue');
});
