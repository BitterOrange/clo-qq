# Q0b: sends one fixed test text after explicit approval, then stops. Never retries, never calls a model.
#   q0-send.ps1 -Case passive-text -Allow id_xxxx               shows the text, sends nothing
#   q0-send.ps1 -Case passive-text -Allow id_xxxx -Approve      sends once, after the user has agreed
param(
  [Parameter(Mandatory)][string]$Case,
  [Parameter(Mandatory)][string]$Allow,
  [switch]$Approve
)
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
$probeArgs = @((Join-Path $Root 'src\tools\qq-send-probe.mjs'), '--case', $Case, '--allow', $Allow)
if ($Approve) { $probeArgs += @('--approve', $Case) }
& $NodeExe @probeArgs
exit $LASTEXITCODE
