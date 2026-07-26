param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = $env:A_SHARE_REVIEW_NODE
if (-not $nodeExe) {
  $nodeExe = [System.IO.Path]::GetFullPath((Join-Path $scriptDir "..\..\..\运行环境\node.exe"))
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
}
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "找不到 Node.js" }

$arguments = @("--policy-news-only", "--no-compass")
if ($Force) { $arguments += "--policy-news-force" }
& $nodeExe (Join-Path $scriptDir "自动更新A股田字格.js") @arguments
exit $LASTEXITCODE
