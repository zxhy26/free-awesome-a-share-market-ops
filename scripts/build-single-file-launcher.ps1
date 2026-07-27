param(
  [Parameter(Mandatory = $true)]
  [string]$PayloadRoot,

  [Parameter(Mandatory = $true)]
  [string]$OutputPath,

  [ValidateSet("Member", "NoQuantSelf", "Self")]
  [string]$Edition = "Member",

  [string]$LauncherSource = (Join-Path $PSScriptRoot "..\windows-launcher\single-file-launcher.cs"),

  [string]$CertificateThumbprint = ""
)

$ErrorActionPreference = "Stop"
$PayloadRoot = [IO.Path]::GetFullPath($PayloadRoot)
$OutputPath = [IO.Path]::GetFullPath($OutputPath)
$LauncherSource = [IO.Path]::GetFullPath($LauncherSource)

foreach ($RequiredPath in @(
  $PayloadRoot,
  $LauncherSource,
  (Join-Path $PayloadRoot "A股复盘Windows版.exe"),
  (Join-Path $PayloadRoot "程序\应用\index.html"),
  (Join-Path $PayloadRoot "运行环境\node.exe")
)) {
  if (-not (Test-Path -LiteralPath $RequiredPath)) {
    throw "构建必需文件不存在：$RequiredPath"
  }
}

$Csc = @(
  (Join-Path $env:WINDIR "Microsoft.NET\Framework64\v4.0.30319\csc.exe"),
  (Join-Path $env:WINDIR "Microsoft.NET\Framework\v4.0.30319\csc.exe")
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Csc) {
  throw "未找到 .NET Framework C# 编译器。"
}

$BuildRoot = Join-Path ([IO.Path]::GetTempPath()) ("AshareReviewBuild-" + [Guid]::NewGuid().ToString("N"))
$PayloadZip = Join-Path $BuildRoot "payload.zip"
$HashFile = Join-Path $BuildRoot "payload.sha256"
$CompiledExe = Join-Path $BuildRoot "launcher.exe"
$TestRoot = Join-Path ([IO.Path]::GetTempPath()) ("AshareLauncherTest-" + [Guid]::NewGuid().ToString("N").Substring(0, 8))
$TestResult = Join-Path $BuildRoot "launcher-test.json"

try {
  New-Item -ItemType Directory -Path $BuildRoot -Force | Out-Null
  Compress-Archive -Path (Join-Path $PayloadRoot "*") -DestinationPath $PayloadZip -CompressionLevel Optimal
  $PayloadHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $PayloadZip).Hash
  [IO.File]::WriteAllText($HashFile, $PayloadHash, [Text.Encoding]::ASCII)

  $Define = switch ($Edition) {
    "NoQuantSelf" { "/define:NO_QUANT_SELF_EDITION" }
    "Self" { "/define:SELF_EDITION" }
    default { $null }
  }
  $CompilerArguments = @(
    "/nologo",
    "/target:winexe",
    "/platform:anycpu",
    "/optimize+",
    "/out:$CompiledExe",
    "/reference:System.dll",
    "/reference:System.Core.dll",
    "/reference:System.Windows.Forms.dll",
    "/reference:System.IO.Compression.dll",
    "/reference:System.IO.Compression.FileSystem.dll",
    "/resource:$PayloadZip,AshareReviewPayload",
    "/resource:$HashFile,AshareReviewPayloadHash"
  )
  if ($Define) { $CompilerArguments += $Define }
  $CompilerArguments += $LauncherSource
  & $Csc @CompilerArguments
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $CompiledExe)) {
    throw "单文件启动器编译失败。"
  }

  $PreviousTestOnly = $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY
  $PreviousTestRoot = $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT
  $PreviousTestResult = $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT
  try {
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY = "1"
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT = $TestRoot
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT = $TestResult
    $Process = Start-Process -FilePath $CompiledExe -WindowStyle Hidden -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
      $TestMessage = ""
      if (Test-Path -LiteralPath $TestResult) {
        try {
          $FailedResult = Get-Content -LiteralPath $TestResult -Raw -Encoding UTF8 | ConvertFrom-Json
          $TestMessage = [string]$FailedResult.message
        } catch {
          $TestMessage = "无法读取启动器测试结果"
        }
      }
      throw "启动器载荷释放测试失败，退出码 $($Process.ExitCode)：$TestMessage"
    }
  } finally {
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY = $PreviousTestOnly
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT = $PreviousTestRoot
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT = $PreviousTestResult
  }

  $Result = Get-Content -LiteralPath $TestResult -Raw -Encoding UTF8 | ConvertFrom-Json
  if (-not $Result.ok -or $Result.payloadSha256 -ne $PayloadHash -or $Result.fileCount -lt 20) {
    throw "启动器载荷验证结果不完整。"
  }

  if ($CertificateThumbprint) {
    $SignTool = Get-Command signtool.exe -ErrorAction SilentlyContinue
    if (-not $SignTool) { throw "指定了签名证书，但未找到 signtool.exe。" }
    & $SignTool.Source sign /sha1 $CertificateThumbprint /fd SHA256 /td SHA256 /tr "http://timestamp.digicert.com" $CompiledExe
    if ($LASTEXITCODE -ne 0) { throw "Authenticode 签名失败。" }
    $Signature = Get-AuthenticodeSignature -LiteralPath $CompiledExe
    if ($Signature.Status -ne "Valid") { throw "签名完成后验证未通过：$($Signature.Status)" }
  }

  $OutputDirectory = Split-Path -Parent $OutputPath
  New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
  Copy-Item -LiteralPath $CompiledExe -Destination $OutputPath -Force
  $OutputHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $OutputPath).Hash
  if ($OutputHash -ne (Get-FileHash -Algorithm SHA256 -LiteralPath $CompiledExe).Hash) {
    throw "输出文件复制后哈希不一致。"
  }

  [pscustomobject]@{
    ok = $true
    edition = $Edition
    outputPath = $OutputPath
    outputSha256 = $OutputHash
    payloadSha256 = $PayloadHash
    payloadFiles = $Result.fileCount
    signature = (Get-AuthenticodeSignature -LiteralPath $OutputPath).Status.ToString()
  } | ConvertTo-Json -Depth 4
} finally {
  foreach ($TemporaryRoot in @($TestRoot, $BuildRoot)) {
    if (-not (Test-Path -LiteralPath $TemporaryRoot)) { continue }
    $ResolvedBuildRoot = [IO.Path]::GetFullPath($TemporaryRoot)
    $ResolvedTempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
    if (-not $ResolvedBuildRoot.StartsWith($ResolvedTempRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "拒绝清理临时目录之外的路径：$ResolvedBuildRoot"
    }
    Remove-Item -LiteralPath $ResolvedBuildRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
