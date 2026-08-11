param(
  [Parameter(Mandatory = $true)]
  [string]$OutputRoot,

  [Parameter(Mandatory = $true)]
  [string]$SelfBase,

  [Parameter(Mandatory = $true)]
  [string]$CustomBase,

  [string]$RepoRoot = ""
)

$ErrorActionPreference = "Stop"
if (-not $RepoRoot) {
  $RepoRoot = Join-Path $PSScriptRoot ".."
}
$RepoRoot = [IO.Path]::GetFullPath($RepoRoot)
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot)
$SelfBase = [IO.Path]::GetFullPath($SelfBase)
$CustomBase = [IO.Path]::GetFullPath($CustomBase)

foreach ($RequiredPath in @(
  (Join-Path $RepoRoot "app\index.html"),
  (Join-Path $SelfBase "程序\应用\pages\quant.html"),
  (Join-Path $SelfBase "程序\应用\pages\member-admin.html"),
  (Join-Path $SelfBase "程序\应用\backend\会员私钥.pem"),
  (Join-Path $CustomBase "程序\应用\pages\shortline.html")
)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "发行载荷源文件不存在：$RequiredPath"
  }
}

function Copy-BasePayload([string]$Source, [string]$Target) {
  if (Test-Path -LiteralPath $Target) {
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
  [IO.Directory]::CreateDirectory($Target) | Out-Null

  foreach ($Name in @(
    "A股复盘Windows版.exe",
    "Microsoft.Web.WebView2.Core.dll",
    "Microsoft.Web.WebView2.WinForms.dll",
    "WebView2Loader.dll",
    "使用说明.txt"
  )) {
    $SourceFile = Join-Path $Source $Name
    if (Test-Path -LiteralPath $SourceFile -PathType Leaf) {
      Copy-Item -LiteralPath $SourceFile -Destination (Join-Path $Target $Name) -Force
    }
  }

  foreach ($Name in @("程序", "运行环境", "数据历史")) {
    $SourceDirectory = Join-Path $Source $Name
    if (-not (Test-Path -LiteralPath $SourceDirectory -PathType Container)) {
      throw "基础载荷目录不存在：$SourceDirectory"
    }
    Copy-Item -LiteralPath $SourceDirectory -Destination (Join-Path $Target $Name) -Recurse -Force
  }
  foreach ($Name in @("生成文件", "缓存")) {
    [IO.Directory]::CreateDirectory((Join-Path $Target $Name)) | Out-Null
  }
}

function Overlay-PublicApp([string]$Target) {
  $AppRoot = Join-Path $Target "程序\应用"
  foreach ($Entry in Get-ChildItem -LiteralPath (Join-Path $RepoRoot "app") -Force) {
    if ($Entry.Name -eq "data") { continue }
    $Destination = Join-Path $AppRoot $Entry.Name
    if ($Entry.PSIsContainer) {
      [IO.Directory]::CreateDirectory($Destination) | Out-Null
      Copy-Item -Path (Join-Path $Entry.FullName "*") -Destination $Destination -Recurse -Force
    } else {
      Copy-Item -LiteralPath $Entry.FullName -Destination $Destination -Force
    }
  }
  Copy-Item -LiteralPath (Join-Path $RepoRoot "app\data\theme-treasure.json") -Destination (Join-Path $AppRoot "data\theme-treasure.json") -Force
}

function Overlay-LatestRuntimeData([string]$Target) {
  $SourceData = Join-Path $SelfBase "程序\应用\data"
  $TargetData = Join-Path $Target "程序\应用\data"
  [IO.Directory]::CreateDirectory($TargetData) | Out-Null
  Get-ChildItem -LiteralPath $SourceData -File | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $TargetData $_.Name) -Force
  }
  Copy-Item -LiteralPath (Join-Path $RepoRoot "app\data\theme-treasure.json") -Destination (Join-Path $TargetData "theme-treasure.json") -Force
}

function Overlay-LatestHistory([string]$Target) {
  $SourceHistory = Join-Path $SelfBase "数据历史"
  $TargetHistory = Join-Path $Target "数据历史"
  if (-not (Test-Path -LiteralPath $SourceHistory -PathType Container)) {
    throw "最新公共历史目录不存在：$SourceHistory"
  }
  if (Test-Path -LiteralPath $TargetHistory) {
    Remove-Item -LiteralPath $TargetHistory -Recurse -Force
  }
  Copy-Item -LiteralPath $SourceHistory -Destination $TargetHistory -Recurse -Force
}

function Remove-PathIfPresent([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

function Set-EditionBoundary([string]$Edition, [string]$Target) {
  $AppRoot = Join-Path $Target "程序\应用"
  $IndexPath = Join-Path $AppRoot "index.html"
  $PrivateKey = Join-Path $AppRoot "backend\会员私钥.pem"
  $AdminFiles = @(
    (Join-Path $AppRoot "pages\member-admin.html"),
    (Join-Path $AppRoot "assets\js\member-admin.js"),
    (Join-Path $AppRoot "assets\css\member-admin.css")
  )
  $QuantFiles = @(
    (Join-Path $AppRoot "pages\quant.html"),
    (Join-Path $AppRoot "assets\js\quant-page.js"),
    (Join-Path $AppRoot "backend\运行量化选股.ps1")
  )
  $ShortlineFiles = @(
    (Join-Path $AppRoot "pages\shortline.html"),
    (Join-Path $AppRoot "assets\js\shortline-page.js"),
    (Join-Path $AppRoot "assets\css\shortline.css"),
    (Join-Path $AppRoot "data\shortline-holidays.json"),
    (Join-Path $AppRoot "backend\shortline-excel.js"),
    (Join-Path $AppRoot "backend\shortline-market-data.js"),
    (Join-Path $AppRoot "backend\shortline-monitor.js"),
    (Join-Path $AppRoot "backend\shortline-routes.js"),
    (Join-Path $AppRoot "backend\shortline-service.js"),
    (Join-Path $AppRoot "backend\shortline-websocket.js"),
    (Join-Path $AppRoot "backend\shortline-model")
  )

  $Links = @()
  switch ($Edition) {
    "Member" {
      foreach ($Path in @($PrivateKey) + $AdminFiles + $QuantFiles + $ShortlineFiles + @(
        (Join-Path $AppRoot "data\quant.json"),
        (Join-Path $AppRoot "data\quant-data.json")
      )) {
        Remove-PathIfPresent $Path
      }
    }
    "Basic" {
      foreach ($Path in @($PrivateKey) + $AdminFiles + $ShortlineFiles) { Remove-PathIfPresent $Path }
      $Links += '      <a class="button" href="/app/pages/quant.html"><span aria-hidden="true">⌁</span><span>量化选股</span></a>'
    }
    "Self" {
      foreach ($Path in $ShortlineFiles) { Remove-PathIfPresent $Path }
      $Links += '      <a class="button" href="/app/pages/quant.html"><span aria-hidden="true">⌁</span><span>量化选股</span></a>'
      $Links += '      <a class="button" href="/app/pages/member-admin.html"><span aria-hidden="true">◇</span><span>会员管理</span></a>'
    }
    "Custom" {
      foreach ($Path in @($PrivateKey) + $AdminFiles) { Remove-PathIfPresent $Path }
      $Links += '      <a class="button" href="/app/pages/quant.html"><span aria-hidden="true">⌁</span><span>量化选股</span></a>'
      $Links += '      <a class="button shortline-entry" href="/app/pages/shortline.html"><span aria-hidden="true">↗</span><span>短线</span></a>'
    }
    default { throw "未知版本：$Edition" }
  }

  $Index = Get-Content -LiteralPath $IndexPath -Raw -Encoding UTF8
  if ($Links.Count) {
    $Anchor = '      <a class="button" href="/app/pages/data-health.html"><span aria-hidden="true">●</span><span>数据状态</span></a>'
    if (-not $Index.Contains($Anchor)) { throw "$Edition 版首页缺少数据状态入口锚点" }
    $Index = $Index.Replace($Anchor, (($Links -join "`r`n") + "`r`n" + $Anchor))
  }
  [IO.File]::WriteAllText($IndexPath, $Index, [Text.UTF8Encoding]::new($false))
}

function Build-CustomReviewHost([string]$Target) {
  $Source = Join-Path $RepoRoot "windows-launcher\custom-review-host.cs"
  $Output = Join-Path $Target "A股复盘Windows版.exe"
  $Core = Join-Path $Target "Microsoft.Web.WebView2.Core.dll"
  $WinForms = Join-Path $Target "Microsoft.Web.WebView2.WinForms.dll"
  $CscCandidates = @(
    (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
    (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
  )
  $Csc = $CscCandidates | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
  foreach ($Required in @($Source, $Core, $WinForms)) {
    if (-not (Test-Path -LiteralPath $Required -PathType Leaf)) {
      throw "定制版单服务窗口构建依赖缺失：$Required"
    }
  }
  if (-not $Csc) { throw "找不到 .NET Framework C# 编译器，无法构建定制版单服务窗口。" }

  $Arguments = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/codepage:65001",
    "/out:$Output",
    "/reference:System.dll",
    "/reference:System.Drawing.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:$Core",
    "/reference:$WinForms",
    $Source
  )
  & $Csc @Arguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $Output -PathType Leaf)) {
    throw "定制版单服务窗口编译失败，退出码：$LASTEXITCODE"
  }
}

[IO.Directory]::CreateDirectory($OutputRoot) | Out-Null
$Profiles = @(
  @{ Edition = "Member"; Source = $SelfBase; Folder = "会员版" },
  @{ Edition = "Basic"; Source = $SelfBase; Folder = "基础版" },
  @{ Edition = "Self"; Source = $SelfBase; Folder = "自用版" },
  @{ Edition = "Custom"; Source = $CustomBase; Folder = "定制版" }
)

$Results = @()
foreach ($Profile in $Profiles) {
  $Target = Join-Path $OutputRoot $Profile.Folder
  Copy-BasePayload $Profile.Source $Target
  Overlay-PublicApp $Target
  Overlay-LatestRuntimeData $Target
  Overlay-LatestHistory $Target
  Set-EditionBoundary $Profile.Edition $Target
  if ($Profile.Edition -eq "Custom") {
    Build-CustomReviewHost $Target
  }
  $Results += [ordered]@{
    edition = $Profile.Edition
    target = $Target
    themeTreasure = Test-Path -LiteralPath (Join-Path $Target "程序\应用\pages\theme-treasure.html")
    quant = Test-Path -LiteralPath (Join-Path $Target "程序\应用\pages\quant.html")
    admin = Test-Path -LiteralPath (Join-Path $Target "程序\应用\pages\member-admin.html")
    privateKey = Test-Path -LiteralPath (Join-Path $Target "程序\应用\backend\会员私钥.pem")
    shortline = Test-Path -LiteralPath (Join-Path $Target "程序\应用\pages\shortline.html")
  }
}

$Results | ConvertTo-Json -Depth 4
