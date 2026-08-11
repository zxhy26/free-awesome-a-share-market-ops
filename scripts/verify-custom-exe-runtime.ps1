param(
  [Parameter(Mandatory = $true)]
  [string]$CustomExe,

  [Parameter(Mandatory = $true)]
  [string]$TestRoot,

  [int]$TimeoutSeconds = 90,

  [switch]$KeepTestRoot
)

$ErrorActionPreference = "Stop"
$DefaultUiPort = 18765
$CustomExe = [IO.Path]::GetFullPath($CustomExe)
$TestRoot = [IO.Path]::GetFullPath($TestRoot)
$TestParent = [IO.Path]::GetFullPath((Split-Path -Parent $TestRoot))

function Decode-Utf8([string]$Base64) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($Base64))
}

$TaskNames = @(
  (Decode-Utf8 "QeiCoTBBTVbnm5jliY3mlbDmja7mupDlh4blpIc="),
  (Decode-Utf8 "QeiCoeebmOS4reWunuaXtuiHquWKqOabtOaWsA=="),
  (Decode-Utf8 "QeiCoeaUtuebmOacgOe7iOWkjeebmOabtOaWsA=="),
  (Decode-Utf8 "QeiCoemHj+WMlumAieiCoeaUtuebmOiHquWKqOabtOaWsA=="),
  (Decode-Utf8 "QeiCoeacuuaehOihjeeUn+WTgeaUtuebmOabtOaWsA=="),
  (Decode-Utf8 "QeiCoeWkjeebmOWQjOatpeacjeWKoQ=="),
  (Decode-Utf8 "QeiCoeW8gOacuuWQjuihpeabtOaWsA==")
)
$ServiceScriptName = Decode-Utf8 "5aSN55uY5ZCM5q2l5pyN5YqhLmpz"

if (-not $TestRoot.StartsWith($TestParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
  throw "The runtime smoke root is outside its expected parent."
}
if (-not (Test-Path -LiteralPath $CustomExe -PathType Leaf)) {
  throw "Custom release file is missing: $CustomExe"
}
if ($TimeoutSeconds -lt 15 -or $TimeoutSeconds -gt 300) {
  throw "TimeoutSeconds must be between 15 and 300."
}

function Get-PortListeners([int]$Port) {
  $Rows = @()
  foreach ($Connection in @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)) {
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$($Connection.OwningProcess)" -ErrorAction SilentlyContinue
    $Rows += [pscustomobject]@{
      port = $Port
      pid = [int]$Connection.OwningProcess
      name = [string]$Process.Name
      executable = [string]$Process.ExecutablePath
      commandLine = [string]$Process.CommandLine
    }
  }
  return @($Rows)
}

function Get-Json([string]$Url, [int]$TimeoutSec = 5) {
  $Response = Invoke-WebRequest -UseBasicParsing -Uri $Url -TimeoutSec $TimeoutSec -Headers @{ Accept = "application/json" }
  if ([int]$Response.StatusCode -ne 200) {
    throw "$Url returned HTTP $($Response.StatusCode)."
  }
  return ($Response.Content | ConvertFrom-Json)
}

function Assert-True($Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Snapshot-ScheduledTasks {
  $Snapshots = @()
  foreach ($TaskName in $TaskNames) {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $Task) { continue }
    if ([string]$Task.State -eq "Running") {
      throw "Runtime smoke cannot replace a running scheduled task: $TaskName"
    }
    $Snapshots += [pscustomobject]@{
      name = $Task.TaskName
      path = $Task.TaskPath
      xml = Export-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath
    }
  }
  return @($Snapshots)
}

function Remove-CurrentScheduledTasks {
  foreach ($TaskName in $TaskNames) {
    $Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    if (-not $Task) { continue }
    if ([string]$Task.State -eq "Running") {
      Stop-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath -ErrorAction SilentlyContinue
    }
    Unregister-ScheduledTask -TaskName $Task.TaskName -TaskPath $Task.TaskPath -Confirm:$false -ErrorAction SilentlyContinue
  }
}

function Restore-ScheduledTasks($Snapshots) {
  Remove-CurrentScheduledTasks
  foreach ($Snapshot in @($Snapshots)) {
    Register-ScheduledTask -TaskName $Snapshot.name -TaskPath $Snapshot.path -Xml $Snapshot.xml -Force | Out-Null
  }
}

function Get-TestRuntimeProcesses {
  $Rows = @()
  foreach ($Process in @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue)) {
    if ([int]$Process.ProcessId -le 4 -or [int]$Process.ProcessId -eq $PID) { continue }
    $Executable = [string]$Process.ExecutablePath
    $CommandLine = [string]$Process.CommandLine
    $InsideTestRoot = $Executable.StartsWith($TestRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)
    $ReferencesTestRoot = $CommandLine.IndexOf($TestRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0
    if ($InsideTestRoot -or $ReferencesTestRoot) {
      $Rows += $Process
    }
  }
  return @($Rows)
}

function Stop-TestRuntimeProcesses {
  for ($Attempt = 0; $Attempt -lt 6; $Attempt++) {
    $Processes = @(Get-TestRuntimeProcesses)
    if ($Processes.Count -eq 0) { return }
    foreach ($Process in $Processes) {
      Stop-Process -Id $Process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 300
  }
}

function Remove-TestRootSafely {
  if (-not (Test-Path -LiteralPath $TestRoot)) { return }
  $ResolvedCleanup = [IO.Path]::GetFullPath($TestRoot)
  if (-not $ResolvedCleanup.StartsWith($TestParent + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to clean a runtime smoke path outside its requested parent."
  }
  for ($Attempt = 0; $Attempt -lt 12; $Attempt++) {
    if (-not (Test-Path -LiteralPath $ResolvedCleanup)) { return }
    try {
      Remove-Item -LiteralPath $ResolvedCleanup -Recurse -Force -ErrorAction Stop
    } catch {
      try { [IO.Directory]::Delete($ResolvedCleanup, $true) } catch {}
    }
    if (-not (Test-Path -LiteralPath $ResolvedCleanup)) { return }
    Start-Sleep -Milliseconds (150 + (100 * $Attempt))
  }
  throw "Runtime smoke root could not be cleaned after stopping its processes: $ResolvedCleanup"
}

function Get-TestServiceProcesses {
  return @(
    Get-TestRuntimeProcesses |
      Where-Object {
        $_.Name -ieq "node.exe" -and
        ([string]$_.CommandLine).IndexOf($ServiceScriptName, [StringComparison]::OrdinalIgnoreCase) -ge 0
      }
  )
}

function Assert-SingleDefaultService {
  $Services = @(Get-TestServiceProcesses)
  Assert-True ($Services.Count -eq 1) (
    "The real custom EXE created $($Services.Count) backend services; exactly one is required. " +
    (($Services | Select-Object ProcessId, ParentProcessId, ExecutablePath, CommandLine | ConvertTo-Json -Compress) -join "")
  )
  $ServicePid = [int]$Services[0].ProcessId
  $Listeners = @(
    Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
      Where-Object { [int]$_.OwningProcess -eq $ServicePid }
  )
  $Ports = @($Listeners | ForEach-Object { [int]$_.LocalPort } | Sort-Object -Unique)
  Assert-True ($Ports.Count -eq 1 -and $Ports[0] -eq $DefaultUiPort) (
    "The real custom EXE backend must listen only on 127.0.0.1:$DefaultUiPort; actual ports: $($Ports -join ',')."
  )
  return $ServicePid
}

function Assert-WebSocketUpgrade([int]$Port) {
  $Socket = [System.Net.WebSockets.ClientWebSocket]::new()
  $Cancellation = [Threading.CancellationTokenSource]::new()
  try {
    $Cancellation.CancelAfter(5000)
    $null = $Socket.ConnectAsync(
      [Uri]"ws://127.0.0.1:$Port/api/v1/shortline/ws",
      $Cancellation.Token
    ).GetAwaiter().GetResult()
    Assert-True ($Socket.State -eq [System.Net.WebSockets.WebSocketState]::Open) "Shortline WebSocket did not upgrade to an open connection."
  } finally {
    $Cancellation.Dispose()
    $Socket.Dispose()
  }
}

$ExistingListeners = @(Get-PortListeners $DefaultUiPort)
if ($ExistingListeners.Count -gt 0) {
  throw (
    "Runtime smoke requires default UI port $DefaultUiPort to be free before launching the real EXE. " +
    "Existing listener: " + ($ExistingListeners | ConvertTo-Json -Compress)
  )
}
if (Test-Path -LiteralPath $TestRoot) {
  Stop-TestRuntimeProcesses
  Remove-TestRootSafely
}
[IO.Directory]::CreateDirectory($TestRoot) | Out-Null

$SavedEnvironment = @{}
foreach ($Name in @(
  "A_SHARE_REVIEW_LAUNCHER_TEST_ONLY",
  "A_SHARE_REVIEW_LAUNCHER_TEST_ROOT",
  "A_SHARE_REVIEW_LAUNCHER_TEST_RESULT",
  "A_SHARE_REVIEW_PORT",
  "A_SHARE_REVIEW_HOST",
  "A_SHARE_REVIEW_EDITION",
  "A_SHARE_REVIEW_RELEASE_EDITION",
  "A_SHARE_REVIEW_LAUNCH_PORT",
  "A_SHARE_REVIEW_LAUNCHER_VERSION",
  "A_SHARE_REVIEW_UPDATE_MANIFEST_URL",
  "A_SHARE_REVIEW_HEADLESS_VERIFY"
)) {
  $SavedEnvironment[$Name] = [Environment]::GetEnvironmentVariable($Name, "Process")
}

$TaskSnapshots = @()
$TaskSnapshotComplete = $false
$Launcher = $null
$Result = $null
try {
  $TaskSnapshots = @(Snapshot-ScheduledTasks)
  $TaskSnapshotComplete = $true
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_ONLY = $null
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_ROOT = $TestRoot
  $env:A_SHARE_REVIEW_LAUNCHER_TEST_RESULT = $null
  $env:A_SHARE_REVIEW_PORT = $null
  $env:A_SHARE_REVIEW_HOST = $null
  $env:A_SHARE_REVIEW_EDITION = $null
  $env:A_SHARE_REVIEW_RELEASE_EDITION = $null
  $env:A_SHARE_REVIEW_LAUNCH_PORT = $null
  $env:A_SHARE_REVIEW_LAUNCHER_VERSION = $null
  $env:A_SHARE_REVIEW_UPDATE_MANIFEST_URL = $null
  $env:A_SHARE_REVIEW_HEADLESS_VERIFY = "1"

  $StartedAt = Get-Date
  $Launcher = Start-Process -FilePath $CustomExe -WindowStyle Hidden -PassThru
  $Deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  $Meta = $null
  $LastProbeError = ""
  while ((Get-Date) -lt $Deadline) {
    try {
      $Meta = Get-Json "http://127.0.0.1:$DefaultUiPort/api/v1/meta" 3
      break
    } catch {
      $LastProbeError = $_.Exception.Message
      Start-Sleep -Milliseconds 250
    }
  }
  if (-not $Meta) {
    throw "The real custom EXE did not expose /api/v1/meta on port ${DefaultUiPort}: $LastProbeError"
  }

  Assert-True ($Meta.releaseEdition -eq "custom") "Default UI port $DefaultUiPort is not custom: releaseEdition=$($Meta.releaseEdition)."
  Assert-True (@($Meta.capabilities) -contains "shortline") "Default UI port $DefaultUiPort does not advertise shortline capability."
  foreach ($Endpoint in @(
    "/api/v1/shortline/review",
    "/api/v1/shortline/config",
    "WS /api/v1/shortline/ws"
  )) {
    Assert-True (@($Meta.endpoints) -contains $Endpoint) "Default UI service meta is missing $Endpoint."
  }

  $Today = Get-Date -Format "yyyy-MM-dd"
  $EndpointResults = @()
  foreach ($Path in @(
    "/api/v1/shortline/config",
    "/api/v1/shortline/review?date=$Today",
    "/api/v1/shortline/day2/live?date=$Today"
  )) {
    $Body = Get-Json "http://127.0.0.1:$DefaultUiPort$Path" 8
    Assert-True ($Body.ok -eq $true) "$Path did not return the standard shortline success envelope."
    $EndpointResults += [pscustomobject]@{ path = $Path; ok = $true }
  }
  $Status = Get-Json "http://127.0.0.1:$DefaultUiPort/api/v1/status" 5
  Assert-True ($Status.shortline.enabled -eq $true) "Default UI status reports shortline disabled."
  Assert-True ($Status.shortline.releaseEdition -eq "custom") "Default UI status is not bound to the custom release edition."
  $AppResponse = Invoke-WebRequest -UseBasicParsing -Uri "http://127.0.0.1:$DefaultUiPort/app/" -TimeoutSec 5
  Assert-True ([int]$AppResponse.StatusCode -eq 200) "Default UI /app/ did not return HTTP 200."
  Assert-WebSocketUpgrade $DefaultUiPort

  # Give the inner UI enough time to reveal a late second backend before accepting the release.
  Start-Sleep -Seconds 5
  $ServicePid = Assert-SingleDefaultService
  $LateMeta = Get-Json "http://127.0.0.1:$DefaultUiPort/api/v1/meta" 5
  Assert-True ($LateMeta.releaseEdition -eq "custom") "Default UI port changed ownership after startup."

  $RuntimeMetadata = Get-ChildItem -LiteralPath $TestRoot -Recurse -File -Filter ".launcher.json" |
    Select-Object -First 1
  Assert-True ($null -ne $RuntimeMetadata) "The real launcher did not write runtime metadata under the smoke root."
  $LauncherMetadata = Get-Content -LiteralPath $RuntimeMetadata.FullName -Raw -Encoding UTF8 | ConvertFrom-Json
  Assert-True ($LauncherMetadata.releaseEdition -eq "custom") "Extracted launcher metadata is not custom."

  $Result = [pscustomobject]@{
    ok = $true
    gate = "real-custom-exe-default-port"
    exe = $CustomExe
    exeSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $CustomExe).Hash
    startedAt = $StartedAt.ToString("o")
    verifiedAt = (Get-Date).ToString("o")
    defaultUiPort = $DefaultUiPort
    releaseEdition = $LateMeta.releaseEdition
    capabilities = @($LateMeta.capabilities)
    backendPid = $ServicePid
    backendCount = @(Get-TestServiceProcesses).Count
    websocket = "101/open"
    endpoints = $EndpointResults
    runtimeRoot = $LauncherMetadata.runtimeRoot
  }
} finally {
  if ($Launcher -and -not $Launcher.HasExited) {
    Stop-Process -Id $Launcher.Id -Force -ErrorAction SilentlyContinue
  }
  if ($TaskSnapshotComplete) {
    try { Remove-CurrentScheduledTasks } catch { Write-Warning "Failed to remove smoke scheduled tasks: $($_.Exception.Message)" }
  }
  try { Stop-TestRuntimeProcesses } catch { Write-Warning "Failed to stop smoke runtime processes: $($_.Exception.Message)" }
  if ($TaskSnapshotComplete) {
    try { Restore-ScheduledTasks $TaskSnapshots } catch { Write-Warning "Failed to restore scheduled tasks: $($_.Exception.Message)" }
  }
  foreach ($Name in $SavedEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($Name, $SavedEnvironment[$Name], "Process")
  }
  if (-not $KeepTestRoot -and (Test-Path -LiteralPath $TestRoot)) {
    Remove-TestRootSafely
  }
}

$Result | ConvertTo-Json -Depth 6
