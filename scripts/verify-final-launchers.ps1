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
    $RuntimeDirectories = @(Get-ChildItem -LiteralPath $Result.runtimeRoot -Directory -Recurse)
    $StructuredHistoryRoot = $RuntimeDirectories |
      Where-Object {
        (Test-Path -LiteralPath (Join-Path $_.FullName "index.json")) -and
          @(
            Get-ChildItem -LiteralPath $_.FullName -Directory -ErrorAction SilentlyContinue |
              Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' }
          ).Count -ge 15
      } |
      Select-Object -First 1
    $DailyHistoryRoot = $RuntimeDirectories |
      Where-Object {
        @(
          Get-ChildItem -LiteralPath $_.FullName -File -Filter "*.json" -ErrorAction SilentlyContinue |
            Where-Object { $_.BaseName -match '^\d{4}-\d{2}-\d{2}_' }
        ).Count -ge 15
      } |
      Select-Object -First 1
    if (-not $StructuredHistoryRoot -or -not $DailyHistoryRoot) {
      throw "$($Target.Name) payload history root was not found."
    }
    $HistoryDates = @(
      Get-ChildItem -LiteralPath $StructuredHistoryRoot.FullName -Directory |
        Where-Object { $_.Name -match '^\d{4}-\d{2}-\d{2}$' }
    )
    $DailyDates = @(
      Get-ChildItem -LiteralPath $DailyHistoryRoot.FullName -File -Filter "*.json" |
        Where-Object { $_.BaseName -match '^\d{4}-\d{2}-\d{2}_' }
    )
    if ($HistoryDates.Count -lt 15 -or $DailyDates.Count -lt 15) {
      throw "$($Target.Name) payload recent history is incomplete: structured=$($HistoryDates.Count), daily=$($DailyDates.Count)."
    }
    foreach ($HistoryDate in $HistoryDates) {
      foreach ($RequiredHistoryFile in @("market.json", "indices.json", "sectors.json", "stocks.json", "analysis.json", "health.json", "manifest.json")) {
        if (-not (Test-Path -LiteralPath (Join-Path $HistoryDate.FullName $RequiredHistoryFile))) {
          throw "$($Target.Name) payload history $($HistoryDate.Name) is missing $RequiredHistoryFile."
        }
      }
    }
    $Index = Get-Content -LiteralPath $IndexFile.FullName -Raw -Encoding UTF8
    $HasQuant = $Index -match "quant\.html"
    $HasAdmin = $Index -match "member-admin\.html"
    $HasShortline = $Index -match "shortline\.html"
    $MainServiceFile = Get-ChildItem -LiteralPath (Join-Path $AppRoot "backend") -File -Filter "*.js" |
      Where-Object {
        $Content = Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8
        $Content -match 'http\.createServer' -and $Content -match 'api/v1/status'
      } |
      Select-Object -First 1
    $MainService = if ($MainServiceFile) {
      Get-Content -LiteralPath $MainServiceFile.FullName -Raw -Encoding UTF8
    } else {
      ""
    }
    $ShortlineIntegrationOk = -not $Target.Shortline -or (
      $MainService -match 'createShortlineService' -and
      $MainService -match 'createShortlineRouteHandler' -and
      $MainService -match 'createShortlineMonitor' -and
      $MainService -match 'await\s+handleShortlineRequest' -and
      $MainService -match 'shortlineMonitor\.start\(\)' -and
      $MainService -match 'server\.on\("upgrade"' -and
      $MainService -match 'shortlineRuntimeStatus\(\)'
    )
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
    $HasDisplayPageSync = Test-Path -LiteralPath (Join-Path $AppRoot "assets\js\display-page-sync.js")
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
    $IndependentPagesSynced = @(
      Get-ChildItem -LiteralPath (Join-Path $AppRoot "pages") -File -Filter "*.html" |
        Where-Object { (Get-Content -LiteralPath $_.FullName -Raw -Encoding UTF8) -notmatch "display-page-sync\.js" }
    ).Count -eq 0
    $BoundaryOk = $HasQuant -eq $Target.Quant -and
      $HasAdmin -eq $Target.Admin -and
      $HasPrivateKey -eq $Target.PrivateKey -and
      $HasShortline -eq $Target.Shortline -and
      $ShortlineIntegrationOk
    if (-not $HasLiveModule -or -not $HasIndexCatalog -or -not $HasIndexWorkspace -or
      -not $HasDisplaySettings -or -not $HasDisplayPageSync -or -not $IndependentPagesSynced -or
      -not $HasPersistentSettings -or -not $HasUserPreferences -or
      -not $HasDisplayControls -or -not $BoundaryOk) {
      $FeatureState = [ordered]@{
        liveModule = $HasLiveModule
        indexCatalog = $HasIndexCatalog
        indexWorkspace = $HasIndexWorkspace
        displaySettings = $HasDisplaySettings
        displayPageSync = $HasDisplayPageSync
        independentPagesSynced = $IndependentPagesSynced
        persistentSettings = $HasPersistentSettings
        userPreferences = $HasUserPreferences
        userPreferencesFile = $HasUserPreferencesFile
        userPreferencesRoute = $HasUserPreferencesRoute
        displayControls = $HasDisplayControls
        boundaryOk = $BoundaryOk
        shortlineIntegration = $ShortlineIntegrationOk
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
      shortlineIntegration = $ShortlineIntegrationOk
      indexCatalog = $HasIndexCatalog
      indexWorkspace = $HasIndexWorkspace
      displaySettings = $HasDisplaySettings
      displayPageSync = $HasDisplayPageSync
      independentPagesSynced = $IndependentPagesSynced
      persistentSettings = $HasPersistentSettings
      userPreferences = $HasUserPreferences
      boundaryOk = $BoundaryOk
      historyDates = $HistoryDates.Count
      dailyDates = $DailyDates.Count
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
