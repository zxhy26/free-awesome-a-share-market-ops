param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"
$lockPath = Join-Path $scriptDir "盘中实时更新.lock"
$lockStream = $null

function Write-RunLog($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy/MM/dd HH:mm:ss"), $message
  for ($i = 0; $i -lt 8; $i++) {
    try {
      Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line
      return
    } catch {
      Start-Sleep -Milliseconds (80 * ($i + 1))
    }
  }
  try { Add-Content -LiteralPath ($logPath + ".fallback") -Encoding UTF8 -Value $line } catch {}
}

function Get-NodeExe {
  $nodeExe = $env:A_SHARE_REVIEW_NODE
  if (-not $nodeExe) {
    $nodeExe = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\..\运行环境\node.exe"))
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    throw "找不到 Node.js"
  }
  return $nodeExe
}

try {
  $now = Get-Date
  if (-not $Force -and ($now.DayOfWeek -eq [DayOfWeek]::Saturday -or $now.DayOfWeek -eq [DayOfWeek]::Sunday)) {
    Write-RunLog "盘中实时更新跳过：今天不是工作日。"
    exit 0
  }

  $start = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 9 -Minute 15 -Second 0
  $end = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0
  if (-not $Force -and ($now -lt $start -or $now -gt $end)) {
    Write-RunLog "盘中实时更新跳过：当前不在盘中刷新时间段。"
    exit 0
  }

  $lunchStart = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 11 -Minute 30 -Second 0
  $lunchEnd = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 13 -Minute 0 -Second 0
  if (-not $Force -and $now -gt $lunchStart -and $now -lt $lunchEnd) {
    Write-RunLog "盘中实时更新跳过：午休停盘，13:00 后恢复。"
    exit 0
  }

  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Write-RunLog "盘中实时更新跳过：已有更新任务在运行。"
    exit 0
  }

  $nodeExe = Get-NodeExe
  if ($Force) {
    Write-RunLog "手动同步启动"
  } else {
    Write-RunLog "09:15集合竞价与盘中实时更新启动"
  }
  $updateArgs = @("--intraday", "--skip-quant", "--no-compass")
  if ($Force) {
    $updateArgs += @("--force", "--policy-news-force")
  }
  & $nodeExe (Join-Path $scriptDir "自动更新A股田字格.js") @updateArgs
  $code = $LASTEXITCODE
  $derivativesArgs = @((Join-Path $scriptDir "更新机构衍生品.js"))
  if ($Force) { $derivativesArgs += "--force" }
  & $nodeExe @derivativesArgs
  $derivativesCode = $LASTEXITCODE
  if ($derivativesCode -ne 0) {
    Write-RunLog "机构衍生品更新失败，保留上一份有效数据，退出码：$derivativesCode"
  }
  if ($Force) {
    Write-RunLog "手动同步结束，退出码：$code"
  } else {
    Write-RunLog "盘中实时更新结束，退出码：$code"
  }
  exit $code
} catch {
  Write-RunLog ("盘中实时更新异常：" + $_.Exception.Message)
  exit 1
} finally {
  if ($lockStream) {
    $lockStream.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}
