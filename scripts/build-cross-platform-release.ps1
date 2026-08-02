param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Member", "Basic", "Self", "Custom")]
  [string]$Edition,

  [Parameter(Mandatory = $true)]
  [string]$PayloadRoot,

  [Parameter(Mandatory = $true)]
  [string]$WindowsExe,

  [Parameter(Mandatory = $true)]
  [string]$MacRuntimeCore,

  [Parameter(Mandatory = $true)]
  [string]$OutputZip,

  [string]$Version = "",

  [string]$WorkRoot = ""
)

$ErrorActionPreference = "Stop"
$PayloadRoot = [IO.Path]::GetFullPath($PayloadRoot)
$WindowsExe = [IO.Path]::GetFullPath($WindowsExe)
$MacRuntimeCore = [IO.Path]::GetFullPath($MacRuntimeCore)
$OutputZip = [IO.Path]::GetFullPath($OutputZip)
if (-not $WorkRoot) {
  $WorkRoot = Join-Path ([IO.Path]::GetDirectoryName($OutputZip)) "跨平台构建临时"
}
$WorkRoot = [IO.Path]::GetFullPath($WorkRoot)

$Package = Get-Content -LiteralPath (Join-Path $PSScriptRoot "..\package.json") -Raw -Encoding UTF8 | ConvertFrom-Json
if (-not $Version) { $Version = [string]$Package.version }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "版本号格式无效：$Version" }

$Profiles = @{
  Member = @{ DisplayName = "大a后勤部"; EditionCode = "member"; ReleaseEdition = "member"; BundleId = "com.zxhy26.asharereview.member"; WindowsName = "大a后勤部.exe"; Quant = $false; Admin = $false; PrivateKey = $false; Shortline = $false }
  Basic = @{ DisplayName = "复盘软件基础版"; EditionCode = "basic"; ReleaseEdition = "basic"; BundleId = "com.zxhy26.asharereview.basic"; WindowsName = "复盘软件基础版.exe"; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $false }
  Self = @{ DisplayName = "复盘软件自用版"; EditionCode = "self"; ReleaseEdition = "self"; BundleId = "com.zxhy26.asharereview.self"; WindowsName = "复盘软件自用版.exe"; Quant = $true; Admin = $true; PrivateKey = $true; Shortline = $false }
  Custom = @{ DisplayName = "复盘软件定制版-短线模型V1.0"; EditionCode = "basic"; ReleaseEdition = "custom"; BundleId = "com.zxhy26.asharereview.custom"; WindowsName = "复盘软件定制版-短线模型V1.0.exe"; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $true }
}
$Profile = $Profiles[$Edition]

foreach ($RequiredPath in @(
  $PayloadRoot,
  $WindowsExe,
  (Join-Path $PayloadRoot "程序\应用\index.html"),
  (Join-Path $PayloadRoot "程序\应用\backend\复盘同步服务.js"),
  (Join-Path $MacRuntimeCore "AshareReviewLauncher"),
  (Join-Path $MacRuntimeCore "node"),
  (Join-Path $MacRuntimeCore "AppIcon.icns"),
  (Join-Path $MacRuntimeCore "runtime-info.json")
)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) { throw "跨平台构建文件不存在：$RequiredPath" }
}

$AppRoot = Join-Path $PayloadRoot "程序\应用"
$QuantPage = Join-Path $AppRoot "pages\quant.html"
$AdminPage = Join-Path $AppRoot "pages\member-admin.html"
$PrivateKey = Join-Path $AppRoot "backend\会员私钥.pem"
$ShortlinePage = Join-Path $AppRoot "pages\shortline.html"
$ActualBoundaries = @{
  Quant = Test-Path -LiteralPath $QuantPage -PathType Leaf
  Admin = Test-Path -LiteralPath $AdminPage -PathType Leaf
  PrivateKey = Test-Path -LiteralPath $PrivateKey -PathType Leaf
  Shortline = Test-Path -LiteralPath $ShortlinePage -PathType Leaf
}
foreach ($Boundary in @("Quant", "Admin", "PrivateKey", "Shortline")) {
  if ([bool]$ActualBoundaries[$Boundary] -ne [bool]$Profile[$Boundary]) {
    throw "$Edition 版功能边界不正确：$Boundary=$($ActualBoundaries[$Boundary])，预期=$($Profile[$Boundary])"
  }
}

$BuildRoot = Join-Path $WorkRoot ("AshareCrossPlatform-" + [Guid]::NewGuid().ToString("N"))
$ReleaseFolder = Join-Path $BuildRoot ($Profile.DisplayName + "_" + $Version)
$WindowsFolder = Join-Path $ReleaseFolder "Windows"
$MacFolder = Join-Path $ReleaseFolder "macOS"
$AppBundle = Join-Path $MacFolder ($Profile.DisplayName + ".app")
$Contents = Join-Path $AppBundle "Contents"
$MacOS = Join-Path $Contents "MacOS"
$Resources = Join-Path $Contents "Resources"
$Runtime = Join-Path $Resources "runtime"
$Payload = Join-Path $Resources "payload"

try {
  foreach ($Directory in @($WindowsFolder, $MacOS, $Runtime, $Payload)) {
    [IO.Directory]::CreateDirectory($Directory) | Out-Null
  }
  [IO.File]::Copy($WindowsExe, (Join-Path $WindowsFolder $Profile.WindowsName), $true)
  [IO.File]::Copy((Join-Path $MacRuntimeCore "AshareReviewLauncher"), (Join-Path $MacOS "AshareReviewLauncher"), $true)
  [IO.File]::Copy((Join-Path $MacRuntimeCore "node"), (Join-Path $Runtime "node"), $true)
  [IO.File]::Copy((Join-Path $MacRuntimeCore "AppIcon.icns"), (Join-Path $Resources "AppIcon.icns"), $true)
  [IO.File]::Copy((Join-Path $MacRuntimeCore "runtime-info.json"), (Join-Path $Runtime "runtime-info.json"), $true)

  foreach ($DirectoryName in @("程序", "数据历史", "缓存")) {
    $Source = Join-Path $PayloadRoot $DirectoryName
    if (Test-Path -LiteralPath $Source -PathType Container) {
      Copy-Item -LiteralPath $Source -Destination (Join-Path $Payload $DirectoryName) -Recurse -Force
    }
  }
  foreach ($DirectoryName in @("生成文件", "缓存", "数据历史")) {
    [IO.Directory]::CreateDirectory((Join-Path $Payload $DirectoryName)) | Out-Null
  }

  $BuildNumber = (($Version -split '\.') | ForEach-Object { [int]$_ })
  $BundleVersion = "{0}{1:D2}{2:D2}" -f $BuildNumber[0], $BuildNumber[1], $BuildNumber[2]
  $InfoPlist = @"
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>
  <key>CFBundleDisplayName</key><string>$($Profile.DisplayName)</string>
  <key>CFBundleExecutable</key><string>AshareReviewLauncher</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundleIdentifier</key><string>$($Profile.BundleId)</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>CFBundleName</key><string>$($Profile.DisplayName)</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$Version</string>
  <key>CFBundleVersion</key><string>$BundleVersion</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
"@
  [IO.File]::WriteAllText((Join-Path $Contents "Info.plist"), $InfoPlist, [Text.UTF8Encoding]::new($false))

  $LauncherConfig = [ordered]@{
    displayName = $Profile.DisplayName
    edition = $Profile.EditionCode
    releaseEdition = $Profile.ReleaseEdition
    version = $Version
    payloadRevision = "release-$Version"
    appSupportDirectory = "A股复盘软件"
    minimumWidth = 1280
    minimumHeight = 780
  }
  [IO.File]::WriteAllText(
    (Join-Path $Resources "launcher-config.json"),
    (($LauncherConfig | ConvertTo-Json -Depth 3) + "`n"),
    [Text.UTF8Encoding]::new($false)
  )

  $MacCommandName = "苹果首次打开.command"
  $MacCommand = @"
#!/bin/zsh
set -eu
BASE_DIR="`${0:A:h}"
APP_PATH="`$BASE_DIR/$($Profile.DisplayName).app"
/usr/bin/xattr -dr com.apple.quarantine "`$APP_PATH" 2>/dev/null || true
/usr/bin/open "`$APP_PATH"
"@
  [IO.File]::WriteAllText((Join-Path $MacFolder $MacCommandName), $MacCommand.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))

  $Instructions = @"
$($Profile.DisplayName) $Version

Windows：进入 Windows 文件夹，双击 $($Profile.WindowsName)。
苹果电脑：进入 macOS 文件夹，双击 $($Profile.DisplayName).app。
如果 macOS 首次提示无法验证开发者，请双击“$MacCommandName”；只需首次执行一次。

macOS 兼容范围：macOS 12 及以上，同时支持 Apple Silicon（M1/M2/M3/M4/M5）和 Intel 芯片。
数据更新：Windows 与 macOS 使用同一套公开实时行情和复盘数据逻辑；开盘期间随盘面刷新，手动同步仍可使用。
文件清理：新版本成功启动后自动删除该版本在用户应用数据目录中的旧运行副本，只保留当前版本；会员状态和用户设置不删除。
股票软件跳转：Windows 沿用当前设备股票软件适配；macOS 自动选择已安装且使用次数最高的支持软件，首次自动输入时系统可能要求“辅助功能”权限。

说明：本包未使用 Apple Developer ID 证书签名，因此从微信下载后 macOS 可能进行首次安全确认。原生双击、实时数据和功能运行不依赖 Windows。
"@
  [IO.File]::WriteAllText((Join-Path $ReleaseFolder "使用说明.txt"), $Instructions, [Text.UTF8Encoding]::new($false))

  $VersionInfo = [ordered]@{
    schemaVersion = 1
    product = $Profile.DisplayName
    version = $Version
    edition = $Profile.ReleaseEdition
    platforms = @("Windows", "macOS-arm64", "macOS-x86_64")
    minimumMacOS = "12.0"
    generatedAt = [DateTime]::UtcNow.ToString("o")
    windowsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $WindowsExe).Hash
    macRuntime = Get-Content -LiteralPath (Join-Path $MacRuntimeCore "runtime-info.json") -Raw -Encoding UTF8 | ConvertFrom-Json
    boundaries = $ActualBoundaries
  }
  [IO.File]::WriteAllText(
    (Join-Path $ReleaseFolder "版本信息.json"),
    (($VersionInfo | ConvertTo-Json -Depth 8) + "`n"),
    [Text.UTF8Encoding]::new($false)
  )

  $OutputDirectory = [IO.Path]::GetDirectoryName($OutputZip)
  [IO.Directory]::CreateDirectory($OutputDirectory) | Out-Null
  if ([IO.File]::Exists($OutputZip)) { [IO.File]::Delete($OutputZip) }
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $Stream = [IO.File]::Open($OutputZip, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
  try {
    $Archive = [IO.Compression.ZipArchive]::new($Stream, [IO.Compression.ZipArchiveMode]::Create, $false, [Text.Encoding]::UTF8)
    try {
      $RootParent = [IO.Path]::GetDirectoryName($ReleaseFolder)
      foreach ($File in Get-ChildItem -LiteralPath $ReleaseFolder -Recurse -File | Sort-Object FullName) {
        $Relative = $File.FullName.Substring($RootParent.Length + 1).Replace('\', '/')
        $Entry = $Archive.CreateEntry($Relative, [IO.Compression.CompressionLevel]::Optimal)
        $Executable = $Relative.EndsWith('/Contents/MacOS/AshareReviewLauncher', [StringComparison]::Ordinal) `
          -or $Relative.EndsWith('/Contents/Resources/runtime/node', [StringComparison]::Ordinal) `
          -or $Relative.EndsWith('/苹果首次打开.command', [StringComparison]::Ordinal)
        $Mode = if ($Executable) { 0x81ED } else { 0x81A4 }
        $Entry.ExternalAttributes = $Mode -shl 16
        $Input = [IO.File]::OpenRead($File.FullName)
        try {
          $Output = $Entry.Open()
          try { $Input.CopyTo($Output) } finally { $Output.Dispose() }
        } finally { $Input.Dispose() }
      }
    } finally { $Archive.Dispose() }
  } finally { $Stream.Dispose() }

  $Result = [ordered]@{
    ok = $true
    edition = $Edition
    product = $Profile.DisplayName
    version = $Version
    outputPath = $OutputZip
    bytes = (Get-Item -LiteralPath $OutputZip).Length
    sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputZip).Hash
    windowsSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $WindowsExe).Hash
    macArchitectures = @("arm64", "x86_64")
    boundaries = $ActualBoundaries
  }
  $Result | ConvertTo-Json -Depth 5
} finally {
  if ([IO.Directory]::Exists($BuildRoot)) {
    [IO.Directory]::Delete($BuildRoot, $true)
  }
}
