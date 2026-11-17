# Search probe: one decision call with the search schema and one Sonar call, with a Key of its own.
#   search-probe.ps1                          shows the fixed texts, the two calls and the worst case. No request, .env not read.
#   search-probe.ps1 -Approve -MaxUsd 0.10    spends money, after the user has agreed to that cap. It reads CLO_TEST_API_KEY,
#                                             whose daily limit must not be above the cap.
# Results go to captures\search-probe-results.jsonl as field names, numbers and classifications only.
# It never changes config.json, versions.lock.json or .env, and starts neither the bot nor the Gateway.
param(
  [switch]$Approve,
  [string]$MaxUsd
)
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
$probeArgs = @('--disable-warning=ExperimentalWarning', (Join-Path $Root 'src\tools\search-probe.mjs'))
if ($Approve) { $probeArgs += '--approve' }
if ($MaxUsd) { $probeArgs += @('--max-usd', $MaxUsd) }
$oldEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  & $NodeExe @probeArgs
  $code = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $oldEncoding
}
exit $code
