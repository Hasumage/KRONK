param([int]$HealthPort = 3001)
$ErrorActionPreference = 'Stop'
$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPath = Join-Path $projectPath 'dist\business-main.js'
$dataPath = Join-Path $projectPath 'data'
if (-not (Test-Path -LiteralPath $entryPath)) { throw 'Сначала выполните npm run build.' }
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
$pidPath = Join-Path $dataPath 'business-service.pid'
if (Test-Path -LiteralPath $pidPath) {
  $servicePid = [int]([System.IO.File]::ReadAllText($pidPath).Trim())
  $previous = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
  if ($previous -and $previous.CommandLine -and $previous.CommandLine.IndexOf($entryPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    Write-Output "KRONK уже запущен, PID $servicePid"
    exit 0
  }
}
$nodePath = (Get-Command node).Source
$service = Start-Process -FilePath $nodePath -ArgumentList @(('"' + $entryPath + '"'), '--live') -WorkingDirectory $projectPath -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataPath 'business-service.log') -RedirectStandardError (Join-Path $dataPath 'business-service-error.log') -PassThru
[System.IO.File]::WriteAllText($pidPath, $service.Id.ToString())
for ($attempt = 0; $attempt -lt 40; $attempt++) {
  Start-Sleep -Milliseconds 250
  $service.Refresh()
  if ($service.HasExited) { throw 'Сервис завершился. Проверьте data/business-service-error.log и data/business-service.log.' }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$HealthPort/health" -TimeoutSec 1
    if ($health.ok) { $health | ConvertTo-Json -Depth 4; exit 0 }
  } catch { }
}
throw 'Сервис запущен, но healthcheck пока не подтвердил готовность. Проверьте локальные логи.'
