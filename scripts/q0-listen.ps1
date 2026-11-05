# Q0a: connects to the QQ gateway read-only and records redacted event shapes under captures\.
# It cannot reply. Press Ctrl+C to stop. Requires CLO_QQ_APP_ID and CLO_QQ_APP_SECRET in .env.
. (Join-Path $PSScriptRoot '_env.ps1')
if (-not (Test-Path -LiteralPath $NodeExe)) { throw 'Private Node is missing. Run scripts\setup.ps1 first.' }
& $NodeExe (Join-Path $Root 'src\tools\qq-listener.mjs')
exit $LASTEXITCODE
