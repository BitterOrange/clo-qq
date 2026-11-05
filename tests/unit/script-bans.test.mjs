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
];

const scanned = () => {
  const files = [];
  for (const dir of ['scripts', join('src', 'cli')]) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (/\.(ps1|mjs|js)$/.test(name)) files.push(join(dir, name));
    }
  }
  return files;
};

test('every banned pattern matches a planted example (positive controls)', () => {
  for (const [name, re, planted] of BANS) assert.match(planted, re, name);
});

test('the scan covers the scripts and the console', () => {
  const names = scanned().map((f) => f.replace(/\\/g, '/'));
  for (const f of ['scripts/_env.ps1', 'scripts/start.ps1', 'scripts/stop.ps1', 'scripts/status.ps1', 'scripts/doctor.ps1', 'scripts/clo.ps1', 'scripts/setup.ps1', 'src/cli/clo.mjs', 'src/cli/lifecycle.mjs', 'src/cli/doctor.mjs', 'src/cli/status.mjs']) {
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
