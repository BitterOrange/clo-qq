# Q5: paid probe. Real OpenClaw Gateway, mock QQ on loopback, the real OpenRouter key from .env.
#   q5-probe.ps1                             shows prompts, call count, models and worst case. No request, .env not read.
#   q5-probe.ps1 -Approve -MaxUsd 2.00       spends money, after the user has agreed to that cap. The Key's daily limit must not be above it.
#   q5-probe.ps1 -Approve -MaxUsd 2.00 -LagMinutes 20
#   q5-probe.ps1 -Runtime own                the project's own turn runner instead of a Gateway. It reads CLO_TEST_API_KEY,
#                                            a separate Key for this probe, instead of CLO_CHAT_API_KEY.
#   q5-probe.ps1 -Runtime own -Approve -MaxUsd 0.10
# Results go to captures\q5-results.jsonl as numbers and classifications only. It never changes config.json.
param(
  [switch]$Approve,
  [string]$MaxUsd,
  [string]$LagMinutes,
  [ValidateSet('openclaw', 'own')]
  [string]$Runtime = 'openclaw'
)
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
$probeArgs = @('--disable-warning=ExperimentalWarning', (Join-Path $Root 'src\tools\q5-probe.mjs'), '--runtime', $Runtime)
if ($Approve) { $probeArgs += '--approve' }
if ($MaxUsd) { $probeArgs += @('--max-usd', $MaxUsd) }
if ($LagMinutes) { $probeArgs += @('--lag-minutes', $LagMinutes) }
$oldEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  & $NodeExe @probeArgs
  $code = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $oldEncoding
}
exit $code
