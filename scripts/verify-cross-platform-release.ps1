param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,

  [Parameter(Mandatory = $true)]
  [ValidateSet("Member", "Basic", "Self", "Custom")]
  [string]$Edition
)

$ErrorActionPreference = "Stop"
$PackagePath = [IO.Path]::GetFullPath($PackagePath)
if (-not (Test-Path -LiteralPath $PackagePath -PathType Leaf)) {
  throw "跨平台发行包不存在：$PackagePath"
}

$Profiles = @{
  Member = @{ DisplayName = "大a后勤部"; WindowsName = "大a后勤部.exe"; Quant = $false; Admin = $false; PrivateKey = $false; Shortline = $false }
  Basic = @{ DisplayName = "复盘软件基础版"; WindowsName = "复盘软件基础版.exe"; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $false }
  Self = @{ DisplayName = "复盘软件自用版"; WindowsName = "复盘软件自用版.exe"; Quant = $true; Admin = $true; PrivateKey = $true; Shortline = $false }
  Custom = @{ DisplayName = "复盘软件定制版-短线模型V1.0"; WindowsName = "复盘软件定制版-短线模型V1.0.exe"; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $true }
}
$Profile = $Profiles[$Edition]

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$Stream = [IO.File]::OpenRead($PackagePath)
try {
  $Archive = [IO.Compression.ZipArchive]::new($Stream, [IO.Compression.ZipArchiveMode]::Read, $false, [Text.Encoding]::UTF8)
  try {
    $Entries = @($Archive.Entries)
    $Names = @($Entries | Select-Object -ExpandProperty FullName)
    if (-not $Names.Count) { throw "跨平台发行包为空" }
    $Root = ($Names[0] -split '/')[0]
    if (-not $Root) { throw "跨平台发行包缺少根目录" }

    function Entry-BySuffix([string]$Suffix) {
      return $Entries | Where-Object { $_.FullName.EndsWith($Suffix, [StringComparison]::Ordinal) } | Select-Object -First 1
    }
    function Read-EntryText($Entry) {
      if (-not $Entry) { return "" }
      $Reader = [IO.StreamReader]::new($Entry.Open(), [Text.Encoding]::UTF8, $true)
      try { return $Reader.ReadToEnd() } finally { $Reader.Dispose() }
    }
    function Read-EntryPrefix($Entry, [int]$Length) {
      if (-not $Entry) { return [byte[]]@() }
      $Input = $Entry.Open()
      try {
        $Buffer = New-Object byte[] $Length
        $Read = $Input.Read($Buffer, 0, $Length)
        if ($Read -eq $Length) { return $Buffer }
        return [byte[]]$Buffer[0..([Math]::Max(0, $Read - 1))]
      } finally { $Input.Dispose() }
    }
    function Read-BigEndianUInt32([byte[]]$Bytes, [int]$Offset) {
      return ([uint32]$Bytes[$Offset] -shl 24) -bor ([uint32]$Bytes[$Offset + 1] -shl 16) -bor ([uint32]$Bytes[$Offset + 2] -shl 8) -bor [uint32]$Bytes[$Offset + 3]
    }
    function Mach-Architectures($Entry) {
      $Bytes = Read-EntryPrefix $Entry 256
      if ($Bytes.Length -lt 28) { return @() }
      $Magic = Read-BigEndianUInt32 $Bytes 0
      if ($Magic -ne [Convert]::ToUInt32("CAFEBABE", 16)) { return @() }
      $Count = [int](Read-BigEndianUInt32 $Bytes 4)
      $Architectures = @()
      for ($Index = 0; $Index -lt $Count; $Index++) {
        $Offset = 8 + $Index * 20
        if ($Offset + 4 -gt $Bytes.Length) { break }
        $Cpu = Read-BigEndianUInt32 $Bytes $Offset
        if ($Cpu -eq 0x0100000C) { $Architectures += "arm64" }
        elseif ($Cpu -eq 0x01000007) { $Architectures += "x86_64" }
        else { $Architectures += ("cpu-0x{0:X8}" -f $Cpu) }
      }
      return @($Architectures | Sort-Object -Unique)
    }
    function Assert-ExecutableMode($Entry, [string]$Label) {
      if (-not $Entry) { throw "$Label 不存在" }
      $Mode = ($Entry.ExternalAttributes -shr 16) -band 0xFFFF
      if (($Mode -band 0x49) -eq 0) { throw "$Label 缺少 macOS 可执行权限，模式=0x$($Mode.ToString('X4'))" }
    }

    $WindowsEntry = Entry-BySuffix ("/Windows/" + $Profile.WindowsName)
    $LauncherEntry = Entry-BySuffix ("/macOS/" + $Profile.DisplayName + ".app/Contents/MacOS/AshareReviewLauncher")
    $NodeEntry = Entry-BySuffix ("/macOS/" + $Profile.DisplayName + ".app/Contents/Resources/runtime/node")
    $InfoEntry = Entry-BySuffix ("/macOS/" + $Profile.DisplayName + ".app/Contents/Info.plist")
    $ConfigEntry = Entry-BySuffix ("/macOS/" + $Profile.DisplayName + ".app/Contents/Resources/launcher-config.json")
    $ServiceEntry = Entry-BySuffix "/Contents/Resources/payload/程序/应用/backend/复盘同步服务.js"
    $UpdaterEntry = Entry-BySuffix "/Contents/Resources/payload/程序/应用/backend/自动更新A股田字格.js"
    $CommandEntry = Entry-BySuffix "/macOS/苹果首次打开.command"
    $VersionEntry = Entry-BySuffix "/版本信息.json"

    foreach ($Required in @($WindowsEntry, $LauncherEntry, $NodeEntry, $InfoEntry, $ConfigEntry, $ServiceEntry, $UpdaterEntry, $CommandEntry, $VersionEntry)) {
      if (-not $Required) { throw "跨平台发行包缺少必需文件" }
    }
    $WindowsHeader = Read-EntryPrefix $WindowsEntry 2
    if ($WindowsHeader.Length -ne 2 -or [Text.Encoding]::ASCII.GetString($WindowsHeader) -ne "MZ") {
      throw "Windows 启动程序不是有效 PE 文件"
    }
    Assert-ExecutableMode $LauncherEntry "macOS 原生启动器"
    Assert-ExecutableMode $NodeEntry "macOS Node 运行时"
    Assert-ExecutableMode $CommandEntry "macOS 首次打开脚本"

    $LauncherArchitectures = Mach-Architectures $LauncherEntry
    $NodeArchitectures = Mach-Architectures $NodeEntry
    foreach ($Architecture in @("arm64", "x86_64")) {
      if ($Architecture -notin $LauncherArchitectures) { throw "macOS 启动器缺少 $Architecture 架构" }
      if ($Architecture -notin $NodeArchitectures) { throw "macOS Node 运行时缺少 $Architecture 架构" }
    }

    $Config = Read-EntryText $ConfigEntry | ConvertFrom-Json
    $VersionInfo = Read-EntryText $VersionEntry | ConvertFrom-Json
    if ($Config.displayName -ne $Profile.DisplayName) { throw "macOS 启动器产品名不正确" }
    if ($VersionInfo.product -ne $Profile.DisplayName) { throw "版本信息产品名不正确" }
    if (@($VersionInfo.platforms) -notcontains "macOS-arm64" -or @($VersionInfo.platforms) -notcontains "macOS-x86_64") {
      throw "版本信息未声明两种 Mac 架构"
    }

    $Quant = [bool](Entry-BySuffix "/Contents/Resources/payload/程序/应用/pages/quant.html")
    $Admin = [bool](Entry-BySuffix "/Contents/Resources/payload/程序/应用/pages/member-admin.html")
    $PrivateKey = [bool](Entry-BySuffix "/Contents/Resources/payload/程序/应用/backend/会员私钥.pem")
    $Shortline = [bool](Entry-BySuffix "/Contents/Resources/payload/程序/应用/pages/shortline.html")
    $Boundaries = @{Quant=$Quant; Admin=$Admin; PrivateKey=$PrivateKey; Shortline=$Shortline}
    foreach ($Boundary in $Boundaries.Keys) {
      if ([bool]$Boundaries[$Boundary] -ne [bool]$Profile[$Boundary]) {
        throw "$Edition 版 Mac 载荷边界错误：$Boundary=$($Boundaries[$Boundary])"
      }
    }

    [ordered]@{
      ok = $true
      packagePath = $PackagePath
      edition = $Edition
      product = $Profile.DisplayName
      version = $Config.version
      entries = $Entries.Count
      bytes = (Get-Item -LiteralPath $PackagePath).Length
      sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $PackagePath).Hash
      windowsMZ = $true
      macLauncherArchitectures = $LauncherArchitectures
      macNodeArchitectures = $NodeArchitectures
      executableModes = $true
      boundaries = $Boundaries
      serviceCrossPlatform = ((Read-EntryText $ServiceEntry) -match 'process\.platform === "win32"')
      updaterUsesMacCurl = ((Read-EntryText $UpdaterEntry) -match '"/usr/bin/curl"')
    } | ConvertTo-Json -Depth 5
  } finally { $Archive.Dispose() }
} finally { $Stream.Dispose() }
