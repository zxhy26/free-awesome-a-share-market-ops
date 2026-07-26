param(
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"
$portableRoot = if ($env:A_SHARE_REVIEW_PORTABLE_ROOT) {
  [System.IO.Path]::GetFullPath($env:A_SHARE_REVIEW_PORTABLE_ROOT)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\.."))
}
$outputPath = Join-Path $portableRoot "生成文件\A股三项同步复盘_最新.html"

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

function Test-PageFreshForToday($todayText) {
  if (-not (Test-Path -LiteralPath $outputPath)) {
    return $false
  }
  try {
    $html = Get-Content -LiteralPath $outputPath -Raw -Encoding UTF8
    $todayPattern = [regex]::Escape($todayText)
    $indexFresh = $html -match ('"index"\s*:\s*\{[\s\S]*?"tradeDate"\s*:\s*"' + $todayPattern + '"')
    $industryFresh = $html -match ('"industry"\s*:\s*\{[\s\S]*?"tradeDate"\s*:\s*"' + $todayPattern + '"')
    $conceptFresh = $html -match ('"concept"\s*:\s*\{[\s\S]*?"tradeDate"\s*:\s*"' + $todayPattern + '"')
    return ($indexFresh -and $industryFresh -and $conceptFresh)
  } catch {
    return $false
  }
}

try {
  $now = Get-Date
  if ($now.DayOfWeek -eq [DayOfWeek]::Saturday -or $now.DayOfWeek -eq [DayOfWeek]::Sunday) {
    Write-RunLog "开机补更新跳过：今天不是工作日。"
    exit 0
  }

  $cutoff = Get-Date -Year $now.Year -Month $now.Month -Day $now.Day -Hour 15 -Minute 0 -Second 0
  if ($now -lt $cutoff) {
    Write-RunLog "开机补更新跳过：当前还没到 15:00。"
    exit 0
  }

  $todayText = $now.ToString("yyyy-MM-dd")
  if (Test-PageFreshForToday $todayText) {
    Write-RunLog "开机补更新跳过：主页面已经是今天数据。"
    exit 0
  }

  $runner = Join-Path $scriptDir "运行自动更新.ps1"
  if (-not (Test-Path -LiteralPath $runner)) {
    Write-RunLog "开机补更新失败：找不到运行入口。"
    exit 1
  }

  if ($DryRun) {
    Write-RunLog "开机补更新演练：已过 15:00，且页面不是今天完整数据，将运行自动更新。"
    exit 0
  }

  Write-RunLog "开机补更新触发：已过 15:00，后台运行自动更新。"
  & powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $runner
  $code = $LASTEXITCODE
  Write-RunLog "开机补更新结束，退出码：$code"
  exit $code
} catch {
  Write-RunLog ("开机补更新异常：" + $_.Exception.Message)
  exit 1
}
