param(
  [Parameter(Mandatory = $true)]
  [string]$TestRoot,

  [Parameter(Mandatory = $true)]
  [string]$MemberExe,

  [Parameter(Mandatory = $true)]
  [string]$BasicExe,

  [Parameter(Mandatory = $true)]
  [string]$SelfExe,

  [string]$CustomExe = ""
)

$ErrorActionPreference = "Stop"
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
$TestParent = [IO.Path]::GetFullPath((Split-Path -Parent $TestRoot))
if (-not $TestRoot.StartsWith($TestParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The verification root is outside its expected parent."
}

$Targets = @(
  @{ Name = "Member"; Exe = $MemberExe; Quant = $false; Admin = $false; PrivateKey = $false; Shortline = $false },
  @{ Name = "Basic"; Exe = $BasicExe; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $false },
  @{ Name = "Self"; Exe = $SelfExe; Quant = $true; Admin = $true; PrivateKey = $true; Shortline = $false }
)
if ($CustomExe) {
  $Targets += @{ Name = "Custom"; Exe = $CustomExe; Quant = $true; Admin = $false; PrivateKey = $false; Shortline = $true }
}

foreach ($Target in $Targets) {
  if (-not (Test-Path -LiteralPath $Target.Exe -PathType Leaf)) {
    throw "Release file is missing: $($Target.Exe)"
  }
}

if (Test-Path -LiteralPath $TestRoot) {
  Remove-Item -LiteralPath $TestRoot -Recurse -Force
}
New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null

$PreviousTestOnly = $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY
$PreviousTestRoot = $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT
$PreviousTestResult = $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT
$Results = @()

try {
  foreach ($Target in $Targets) {
    $EditionRoot = Join-Path $TestRoot $Target.Name
    $ResultPath = Join-Path $TestRoot ($Target.Name + ".json")
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY = "1"
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT = $EditionRoot
    $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT = $ResultPath
    $Process = Start-Process -FilePath $Target.Exe -WindowStyle Hidden -Wait -PassThru
    if ($Process.ExitCode -ne 0) {
      throw "$($Target.Name) launcher extraction failed with exit code $($Process.ExitCode)."
    }

    $Result = Get-Content -LiteralPath $ResultPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $IndexFile = Get-ChildItem -LiteralPath $Result.runtimeRoot -Recurse -File -Filter "index.html" |
      Where-Object { Test-Path -LiteralPath (Join-Path $_.Directory.FullName "backend") } |
      Select-Object -First 1
    if (-not $IndexFile) {
      throw "$($Target.Name) payload app root was not found."
    }
    $AppRoot = $IndexFile.Directory.FullName
    $Index = Get-Content -LiteralPath $IndexFile.FullName -Raw -Encoding UTF8
    $HasQuant = $Index -match "quant\.html"
    $HasAdmin = $Index -match "member-admin\.html"
    $HasShortline = $Index -match "shortline\.html"
    $HasPrivateKey = @(
      Get-ChildItem -LiteralPath (Join-Path $AppRoot "backend") -Recurse -File -Filter "*.pem" |
        Where-Object {
          (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) -match "PRIVATE KEY"
        }
    ).Count -gt 0
    $HasLiveModule = Test-Path -LiteralPath (Join-Path $AppRoot "backend\live-sector-flow.js")
    $HasIndexCatalog = Test-Path -LiteralPath (Join-Path $AppRoot "backend\index-catalog.js")
    $HasIndexWorkspace = Test-Path -LiteralPath (Join-Path $AppRoot "assets\js\index-workspace.js")
    $HasDisplaySettings = Test-Path -LiteralPath (Join-Path $AppRoot "assets\js\display-settings.js")
    $HasPersistentSettings = Test-Path -LiteralPath (Join-Path $AppRoot "assets\js\persistent-settings.js")
    $BackendScriptContents = @(
      Get-ChildItem -LiteralPath (Join-Path $AppRoot "backend") -File -Filter "*.js" |
        ForEach-Object { Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8 }
    )
    $HasUserPreferencesFile = @(
      $BackendScriptContents | Where-Object { $_ -match "createUserPreferencesService" }
    ).Count -gt 0
    $HasUserPreferencesRoute = @(
      $BackendScriptContents | Where-Object { $_ -match "userPreferences\.handleRequest" }
    ).Count -gt 0
    $HasUserPreferences = $HasUserPreferencesFile -and $HasUserPreferencesRoute
    $HasDisplayControls = $Index -match 'id="zoomRange"' -and
      $Index -match 'id="fontSizeButton"' -and
      $Index -match 'id="indexPicker"'
    $BoundaryOk = $HasQuant -eq $Target.Quant -and
      $HasAdmin -eq $Target.Admin -and
      $HasPrivateKey -eq $Target.PrivateKey -and
      $HasShortline -eq $Target.Shortline
    if (-not $HasLiveModule -or -not $HasIndexCatalog -or -not $HasIndexWorkspace -or
      -not $HasDisplaySettings -or -not $HasPersistentSettings -or -not $HasUserPreferences -or
      -not $HasDisplayControls -or -not $BoundaryOk) {
      $FeatureState = [ordered]@{
        liveModule = $HasLiveModule
        indexCatalog = $HasIndexCatalog
        indexWorkspace = $HasIndexWorkspace
        displaySettings = $HasDisplaySettings
        persistentSettings = $HasPersistentSettings
        userPreferences = $HasUserPreferences
        userPreferencesFile = $HasUserPreferencesFile
        userPreferencesRoute = $HasUserPreferencesRoute
        displayControls = $HasDisplayControls
        boundaryOk = $BoundaryOk
      } | ConvertTo-Json -Compress
      throw "$($Target.Name) payload feature boundary is invalid: $FeatureState"
    }

    $Results += [pscustomobject]@{
      edition = $Target.Name
      exitCode = $Process.ExitCode
      fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($Target.Exe).FileVersion
      payloadFiles = $Result.fileCount
      payloadSha256 = $Result.payloadSha256
      liveModule = $HasLiveModule
      quant = $HasQuant
      admin = $HasAdmin
      privateKey = $HasPrivateKey
      shortline = $HasShortline
      indexCatalog = $HasIndexCatalog
      indexWorkspace = $HasIndexWorkspace
      displaySettings = $HasDisplaySettings
      persistentSettings = $HasPersistentSettings
      userPreferences = $HasUserPreferences
      boundaryOk = $BoundaryOk
      exeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $Target.Exe).Hash
      sizeMB = [Math]::Round((Get-Item -LiteralPath $Target.Exe).Length / 1MB, 2)
      signature = (Get-AuthenticodeSignature -LiteralPath $Target.Exe).Status.ToString()
    }
  }
} finally {
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY = $PreviousTestOnly
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT = $PreviousTestRoot
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT = $PreviousTestResult
  if (Test-Path -LiteralPath $TestRoot) {
    $ResolvedCleanup = [IO.Path]::GetFullPath($TestRoot)
    if (-not $ResolvedCleanup.StartsWith($TestParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to clean a path outside the requested parent."
    }
    Remove-Item -LiteralPath $ResolvedCleanup -Recurse -Force
  }
}

$Results | ConvertTo-Json -Depth 4
