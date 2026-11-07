# Q5 for the Anthropic API: paid probe, apart from q5-probe.ps1. No Gateway and no QQ: two Opus turns (cold, then
# warm) and one Haiku decision, in this process, against api.anthropic.com only.
#   q5-anthropic.ps1                                          shows the texts, the requests and the static bound. No request, .env not read.
#   q5-anthropic.ps1 -Approve -MaxUsd 0.10 -HardCapAttested   spends money, after the user has agreed to that cap.
# Anthropic enforces no per-key daily limit. -HardCapAttested says that CLO_TEST_ANTHROPIC_API_KEY belongs to a
# dedicated probe workspace whose spend limit or prepaid balance (auto-reload off) is the stop on the provider side.
# Results go to captures\q5-anthropic.jsonl as numbers and classifications only. It never changes config.json.
param(
  [switch]$Approve,
  [string]$MaxUsd,
  [switch]$HardCapAttested
)
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
$probeArgs = @('--disable-warning=ExperimentalWarning', (Join-Path $Root 'src\tools\q5-anthropic.mjs'))
if ($Approve) { $probeArgs += '--approve' }
if ($MaxUsd) { $probeArgs += @('--max-usd', $MaxUsd) }
if ($HardCapAttested) { $probeArgs += '--hard-cap-attested' }
$oldEncoding = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
  & $NodeExe @probeArgs
  $code = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $oldEncoding
}
exit $code
