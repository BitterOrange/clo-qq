# Starts the Gateway in a hidden window with the private Node, after doctor passes. PID goes in .runtime\pids.
. (Join-Path $PSScriptRoot '_env.ps1')
exit (Invoke-CloStart @args)
