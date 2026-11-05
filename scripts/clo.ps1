# Project console. Run with no arguments for the command list. Never prints a secret.
. (Join-Path $PSScriptRoot '_env.ps1')
if ($args.Count -gt 0 -and $args[0] -eq 'start') {
  $rest = @($args | Select-Object -Skip 1)
  exit (Invoke-CloStart @rest)
}
exit (Invoke-Clo @args)
