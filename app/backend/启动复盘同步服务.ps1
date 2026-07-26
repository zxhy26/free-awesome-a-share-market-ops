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

try {
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
