# Installs the private Node and locked packages. Safe to run repeatedly.
#   setup.ps1            private Node and the QQ SDK (enough for Q0)
#   setup.ps1 -Runtime   also OpenClaw and the search plugin
param([switch]$Runtime)
. (Join-Path $PSScriptRoot '_env.ps1')

$lock = Get-Content -LiteralPath (Join-Path $Root 'versions.lock.json') -Raw | ConvertFrom-Json
New-Item -ItemType Directory -Force -Path $Rt | Out-Null

# 1. Private Node, verified before extraction.
$wanted = "v$($lock.node.version)"
$have = if (Test-Path -LiteralPath $NodeExe) { (& $NodeExe --version) } else { '' }
if ($have -ne $wanted) {
  $zip = Join-Path $Rt $lock.node.file
  if (-not (Test-Path -LiteralPath $zip)) {
    Write-Host "Downloading $($lock.node.file)"
    Invoke-WebRequest -Uri $lock.node.url -OutFile $zip -NoProxy
  }
  $sha = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($sha -ne $lock.node.sha256) {
    Remove-Item -LiteralPath $zip -Force
    throw "Node zip checksum mismatch: got $sha. The file was removed. Nothing was installed."
  }
  $tmp = Join-Path $Rt 'node-extract'
  if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
  Expand-Archive -LiteralPath $zip -DestinationPath $tmp
  if (Test-Path -LiteralPath $NodeDir) { Remove-Item -LiteralPath $NodeDir -Recurse -Force }
  Move-Item -LiteralPath (Join-Path $tmp ($lock.node.file -replace '\.zip$','')) -Destination $NodeDir
  Remove-Item -LiteralPath $tmp -Recurse -Force
  Remove-Item -LiteralPath $zip -Force
}
Write-Host "Private Node: $(& $NodeExe --version)"

function Assert-LockIntegrity([string]$LockFile, [string]$Name, $Entry) {
  $l = Get-Content -LiteralPath $LockFile -Raw | ConvertFrom-Json -AsHashtable
  $p = $l.packages["node_modules/$Name"]
  if (-not $p) { throw "$Name is missing from $LockFile" }
  if ($p.version -ne $Entry.version) { throw "$Name is $($p.version) in the lockfile, expected $($Entry.version)" }
  if ($p.integrity -ne $Entry.integrity) { throw "$Name integrity in the lockfile differs from versions.lock.json" }
}

# 2. QQ SDK. npm ci enforces the lockfile; the first run creates it.
$rootLock = Join-Path $Root 'package-lock.json'
if (Test-Path -LiteralPath $rootLock) {
  Invoke-PrivateNpm -WorkDir $Root -NpmArgs @('ci','--ignore-scripts','--no-audit','--no-fund')
} else {
  Invoke-PrivateNpm -WorkDir $Root -NpmArgs @('install','--ignore-scripts','--no-audit','--no-fund','--save-exact')
}
Assert-LockIntegrity $rootLock '@tencent-connect/qqbot-nodejs' $lock.npm.'@tencent-connect/qqbot-nodejs'
Write-Host 'QQ SDK: locked version and integrity verified'

# 3. OpenClaw and the search plugin, kept in .runtime\pkg.
if ($Runtime) {
  New-Item -ItemType Directory -Force -Path $PkgDir | Out-Null
  $src = Join-Path $Root 'runtime-lock'
  Copy-Item -LiteralPath (Join-Path $src 'package.json') -Destination $PkgDir -Force
  $srcLock = Join-Path $src 'package-lock.json'
  if (Test-Path -LiteralPath $srcLock) {
    Copy-Item -LiteralPath $srcLock -Destination $PkgDir -Force
    Invoke-PrivateNpm -WorkDir $PkgDir -NpmArgs @('ci','--no-audit','--no-fund')
  } else {
    Invoke-PrivateNpm -WorkDir $PkgDir -NpmArgs @('install','--no-audit','--no-fund','--save-exact')
    Copy-Item -LiteralPath (Join-Path $PkgDir 'package-lock.json') -Destination $srcLock -Force
  }
  foreach ($n in 'openclaw','@openclaw/perplexity-plugin') {
    Assert-LockIntegrity (Join-Path $PkgDir 'package-lock.json') $n $lock.npm.$n
  }
  Write-Host 'OpenClaw and search plugin: locked versions and integrity verified'
}
Write-Host 'Setup finished. System Node and PATH were not changed.'
