param([Parameter(Mandatory = $true)][int]$AuthProcessId)
$ErrorActionPreference = 'Stop'
$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$auth = Get-CimInstance Win32_Process -Filter "ProcessId = $AuthProcessId" -ErrorAction SilentlyContinue
if ($auth -and (-not $auth.CommandLine -or $auth.CommandLine -notmatch 'business-oauth\.js')) { throw 'OAuth PID belongs to another process.' }
for ($attempt = 0; $attempt -lt 360; $attempt++) {
  if (-not (Get-Process -Id $AuthProcessId -ErrorAction SilentlyContinue)) {
    & (Join-Path $projectPath 'scripts\start-business.ps1')
    exit $LASTEXITCODE
  }
  Start-Sleep -Seconds 1
}
throw 'OAuth process did not stop; no second service was launched.'
