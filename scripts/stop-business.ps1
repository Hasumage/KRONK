$ErrorActionPreference = 'Stop'
$projectPath = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$entryPath = Join-Path $projectPath 'dist\business-main.js'
$pidPath = Join-Path $projectPath 'data\business-service.pid'
if (-not (Test-Path -LiteralPath $pidPath)) { Write-Output 'Нет PID запущенного сервиса.'; exit 0 }
$servicePid = [int]([System.IO.File]::ReadAllText($pidPath).Trim())
$service = Get-CimInstance Win32_Process -Filter "ProcessId = $servicePid" -ErrorAction SilentlyContinue
if (-not $service) { Write-Output 'Сервис уже остановлен.'; exit 0 }
if (-not $service.CommandLine -or $service.CommandLine.IndexOf($entryPath, [System.StringComparison]::OrdinalIgnoreCase) -lt 0) { throw 'PID принадлежит другому процессу; остановка отменена.' }
Stop-Process -Id $servicePid
Write-Output 'KRONK остановлен. Для временной паузы используйте /pause в чате с ботом.'
