# Stops only the PID this project recorded, after checking its start time and command line.
. (Join-Path $PSScriptRoot '_env.ps1')
exit (Invoke-Clo stop @args)
