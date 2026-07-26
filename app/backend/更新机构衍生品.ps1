param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$portableRoot = if ($env:A_SHARE_REVIEW_PORTABLE_ROOT) {
  [System.IO.Path]::GetFullPath($env:A_SHARE_REVIEW_PORTABLE_ROOT)
} else {
  [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\.."))
}
$env:A_SHARE_REVIEW_PORTABLE_ROOT = $portableRoot
$nodeExe = $env:A_SHARE_REVIEW_NODE
if (-not $nodeExe) {
  $nodeExe = [System.IO.Path]::GetFullPath((Join-Path $portableRoot "运行环境\node.exe"))
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCommand) { $nodeExe = $nodeCommand.Source }
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  throw "找不到 Node.js"
}

$arguments = @((Join-Path $scriptDir "更新机构衍生品.js"))
if ($Force) { $arguments += "--force" }
& $nodeExe @arguments
exit $LASTEXITCODE
