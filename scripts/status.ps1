# Mode, liveness, pauses, spend today and alerts. Read only, unless --ack is given.
. (Join-Path $PSScriptRoot '_env.ps1')
exit (Invoke-Clo status @args)
