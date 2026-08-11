$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"
$servicePath = Join-Path $scriptDir "复盘同步服务.js"
$port = 18765

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

function Test-ServicePort {
  $client = New-Object System.Net.Sockets.TcpClient
  try {
    $result = $client.BeginConnect("127.0.0.1", $port, $null, $null)
    if (-not $result.AsyncWaitHandle.WaitOne(500, $false)) {
      return $false
    }
    $client.EndConnect($result)
    return $true
  } catch {
    return $false
  } finally {
    $client.Close()
  }
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

function Import-LauncherEnvironment {
  $runtimeRoot = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\.."))
  $metadataPath = Join-Path $runtimeRoot ".launcher.json"
  if (-not (Test-Path -LiteralPath $metadataPath -PathType Leaf)) {
    Write-RunLog "未找到启动器元数据，后台服务将按普通版兼容模式启动。"
    return
  }

  try {
    $metadata = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $edition = [string]$metadata.edition
    $releaseEdition = [string]$metadata.releaseEdition
    $launcherVersion = [string]$metadata.version
    $manifestUrl = [string]$metadata.manifestUrl

    if ($edition) { $env:A_SHARE_REVIEW_EDITION = $edition }
    if ($releaseEdition) { $env:A_SHARE_REVIEW_RELEASE_EDITION = $releaseEdition }
    if ($launcherVersion) { $env:A_SHARE_REVIEW_LAUNCHER_VERSION = $launcherVersion }
    if ($manifestUrl) { $env:A_SHARE_REVIEW_UPDATE_MANIFEST_URL = $manifestUrl }

    Write-RunLog ("已载入启动器版本身份：edition={0}，releaseEdition={1}，version={2}" -f $edition, $releaseEdition, $launcherVersion)
  } catch {
    throw "启动器版本身份读取失败：$($_.Exception.Message)"
  }
}

try {
  Import-LauncherEnvironment
  if (Test-ServicePort) {
    Write-RunLog "复盘同步服务已在运行"
    exit 0
  }

  $nodeExe = Get-NodeExe
  Start-Process -FilePath $nodeExe -ArgumentList @($servicePath) -WorkingDirectory $scriptDir -WindowStyle Hidden
  Start-Sleep -Seconds 2
  if (Test-ServicePort) {
    Write-RunLog "复盘同步服务后台启动成功"
    exit 0
  }

  throw "复盘同步服务端口未打开"
} catch {
  Write-RunLog ("复盘同步服务启动失败：" + $_.Exception.Message)
  exit 1
}
