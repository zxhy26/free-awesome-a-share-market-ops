param(
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$nodeExe = $env:A_SHARE_REVIEW_NODE
if (-not $nodeExe) {
  $portableRoot = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $scriptDir))
  $nodeExe = Get-ChildItem -LiteralPath $portableRoot -Directory |
    ForEach-Object { Join-Path $_.FullName "node.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } |
    Select-Object -First 1
}
if (-not (Test-Path -LiteralPath $nodeExe)) {
  $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
  if ($nodeCmd) { $nodeExe = $nodeCmd.Source }
}
if (-not (Test-Path -LiteralPath $nodeExe)) { throw "Node.js runtime was not found." }

$arguments = @()
if ($Force) { $arguments += "--force" }
& $nodeExe (Join-Path $scriptDir "next-week-events-updater.js") @arguments
exit $LASTEXITCODE
