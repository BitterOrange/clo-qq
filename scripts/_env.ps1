# Shared environment for project scripts. Dot-source this; it only changes the current process.
$ErrorActionPreference = 'Stop'
$script:Root = Split-Path -Parent $PSScriptRoot
$script:RepoRt = Join-Path $script:Root '.runtime'
# Tests move project state, never the private Node or packages.
$script:Rt = if ($env:CLO_TEST_ROOT) { Join-Path $env:CLO_TEST_ROOT '.runtime' } else { $script:RepoRt }
$script:NodeDir = Join-Path $script:RepoRt 'node'
$script:NodeExe = Join-Path $script:NodeDir 'node.exe'
$script:NpmCli = Join-Path $script:NodeDir 'node_modules\npm\bin\npm-cli.js'
$script:PkgDir = Join-Path $script:RepoRt 'pkg'
$script:CliMjs = Join-Path $script:Root 'src\cli\clo.mjs'

# No proxy may reach any request made by this project.
foreach ($n in 'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy','NO_PROXY','no_proxy','NPM_CONFIG_PROXY','NPM_CONFIG_HTTPS_PROXY','NODE_USE_ENV_PROXY') {
  Remove-Item "Env:$n" -ErrorAction SilentlyContinue
}

# State isolation: never read or write the user's default OpenClaw directories.
$env:OPENCLAW_HOME = Join-Path $script:Rt 'home'
$env:OPENCLAW_STATE_DIR = Join-Path $script:Rt 'state'
$env:OPENCLAW_CONFIG_PATH = Join-Path $script:Rt 'state\openclaw.json'
$env:OPENCLAW_WORKSPACE_DIR = Join-Path $script:Rt 'workspace'

function Invoke-Clo {
  # Runs the console on the private Node and returns its exit code. UTF-8 only for this call.
  if (-not (Test-Path -LiteralPath $script:NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
  $oldEncoding = [Console]::OutputEncoding
  try {
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & $script:NodeExe --disable-warning=ExperimentalWarning $script:CliMjs @args | Out-Host
    return $LASTEXITCODE
  } finally {
    [Console]::OutputEncoding = $oldEncoding
  }
}

function Invoke-CloStart {
  # A process started normally inherits every inheritable handle PowerShell holds, and would pass them on to
  # the Gateway. A caller reading this script's output would then wait until the Gateway exits (observed).
  # Start-Process with a hidden window goes through ShellExecute, which passes none of them.
  if (-not (Test-Path -LiteralPath $script:NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
  New-Item -ItemType Directory -Force -Path $script:Rt | Out-Null
  $outFile = Join-Path $script:Rt ("clo-start-" + [Guid]::NewGuid().ToString('N') + '.txt')
  $argList = @('--disable-warning=ExperimentalWarning', ('"' + $script:CliMjs + '"'), '--output-file', ('"' + $outFile + '"'), 'start') + $args
  # Not -Wait: it also waits for descendants, and the Gateway is one on purpose.
  $p = Start-Process -FilePath $script:NodeExe -ArgumentList $argList -WindowStyle Hidden -PassThru
  $null = $p.Handle
  $p.WaitForExit()
  if (Test-Path -LiteralPath $outFile) {
    $bytes = [System.IO.File]::ReadAllBytes($outFile)
    Remove-Item -LiteralPath $outFile -Force
    $oldEncoding = [Console]::OutputEncoding
    try {
      [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
      [System.Text.Encoding]::UTF8.GetString($bytes) | Out-Host
    } finally {
      [Console]::OutputEncoding = $oldEncoding
    }
  }
  return $p.ExitCode
}

function Invoke-PrivateNpm {
  # PATH changes only around this child process, so lifecycle scripts cannot pick up the system Node.
  param([Parameter(Mandatory)][string[]]$NpmArgs, [Parameter(Mandatory)][string]$WorkDir)
  $old = $env:PATH
  try {
    $env:PATH = "$script:NodeDir;$old"
    Push-Location -LiteralPath $WorkDir
    & $script:NodeExe $script:NpmCli @NpmArgs
    if ($LASTEXITCODE -ne 0) { throw "npm $($NpmArgs -join ' ') failed with exit code $LASTEXITCODE" }
  } finally {
    Pop-Location
    $env:PATH = $old
  }
}
