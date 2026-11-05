# Read-only checks of config, versions and the rendered files. No value of a secret is printed.
. (Join-Path $PSScriptRoot '_env.ps1')
exit (Invoke-Clo doctor @args)
