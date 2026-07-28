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

function Resolve-TdxVipdoc {
  $candidates = New-Object System.Collections.Generic.List[string]
  if ($env:A_SHARE_REVIEW_TDX_VIPDOC) { $candidates.Add($env:A_SHARE_REVIEW_TDX_VIPDOC) }

  foreach ($processName in @("TdxW", "Tdx", "通达信")) {
    try {
      Get-Process -Name $processName -ErrorAction SilentlyContinue | ForEach-Object {
        if ($_.Path) { $candidates.Add((Join-Path (Split-Path -Parent $_.Path) "vipdoc")) }
      }
    } catch {}
  }

  foreach ($registryPath in @(
    "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
    "HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
  )) {
    try {
      Get-ItemProperty -Path $registryPath -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -match "通达信|TongDaXin" } |
        ForEach-Object {
          if ($_.InstallLocation) { $candidates.Add((Join-Path ([Environment]::ExpandEnvironmentVariables([string]$_.InstallLocation).Trim('"')) "vipdoc")) }
          if ($_.DisplayIcon) {
            $icon = [Environment]::ExpandEnvironmentVariables([string]$_.DisplayIcon).Trim()
            $icon = ($icon -replace ',\s*\d+$', '').Trim('"')
            if (Test-Path -LiteralPath $icon -PathType Leaf) { $candidates.Add((Join-Path (Split-Path -Parent $icon) "vipdoc")) }
          }
        }
    } catch {}
  }

  foreach ($drive in @("C:\", "D:\", "E:\", "F:\")) {
    if (-not (Test-Path -LiteralPath $drive)) { continue }
    foreach ($relative in @("股票\vipdoc", "通达信\vipdoc", "new_tdx\vipdoc", "tdx\vipdoc", "TdxW\vipdoc")) {
      $candidates.Add([System.IO.Path]::Combine($drive, $relative))
    }
  }

  foreach ($candidate in $candidates | Where-Object { $_ } | Select-Object -Unique) {
    try {
      $full = [System.IO.Path]::GetFullPath($candidate)
      if ((Test-Path -LiteralPath (Join-Path $full "sh\lday")) -and (Test-Path -LiteralPath (Join-Path $full "sz\lday"))) {
        return $full
      }
    } catch {}
  }
  return ""
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
  if (-not $env:A_SHARE_REVIEW_TDX_VIPDOC) {
    $tdxVipdoc = Resolve-TdxVipdoc
    if ($tdxVipdoc) {
      $env:A_SHARE_REVIEW_TDX_VIPDOC = $tdxVipdoc
      Write-RunLog ("自动更新使用通达信本地日线：" + $tdxVipdoc)
    } else {
      Write-RunLog "自动更新未发现通达信本地日线，量化模块将使用线上真实日线。"
    }
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
