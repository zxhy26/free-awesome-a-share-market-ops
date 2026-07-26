$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"
$lockPath = Join-Path $scriptDir "自动更新运行中.lock"
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

try {
  try {
    $lockStream = [System.IO.File]::Open($lockPath, [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
  } catch {
    Write-RunLog "已有自动更新任务在运行，本次跳过。"
    exit 0
  }

  Write-RunLog "任务入口启动"
  $nodeExe = $env:A_SHARE_REVIEW_NODE
  if (-not $nodeExe) {
    $nodeExe = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\..\运行环境\node.exe"))
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($nodeCmd) {
      $nodeExe = $nodeCmd.Source
    }
  }
  if (-not (Test-Path -LiteralPath $nodeExe)) {
    Write-RunLog "任务入口失败：找不到 Node.js"
    exit 1
  }
  Write-RunLog "任务入口使用 Node：$nodeExe"
  & $nodeExe (Join-Path $scriptDir "自动更新A股田字格.js") --wait --no-compass
  $code = $LASTEXITCODE
  & $nodeExe (Join-Path $scriptDir "更新机构衍生品.js") --force
  $derivativesCode = $LASTEXITCODE
  if ($derivativesCode -ne 0) {
    Write-RunLog "机构衍生品收盘更新失败，保留上一份有效数据，退出码：$derivativesCode"
  }
  Write-RunLog "任务入口结束，退出码：$code"
  exit $code
} catch {
  Write-RunLog ("任务入口异常：" + $_.Exception.Message)
  exit 1
} finally {
  if ($lockStream) {
    $lockStream.Dispose()
    Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
  }
}
