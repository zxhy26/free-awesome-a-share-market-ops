param(
  [switch]$RegisterOnly
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"

function Write-RunLog($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy/MM/dd HH:mm:ss"), $message
  Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line
}

function Escape-Xml($text) {
  return [System.Security.SecurityElement]::Escape($text)
}

function Ensure-SilentRunner {
  $runner = Join-Path $scriptDir "静默运行PowerShell.vbs"
  $content = @'
Option Explicit
Dim shell, psExe, scriptPath, cmd, i, exitCode
Set shell = CreateObject("WScript.Shell")
If WScript.Arguments.Count < 1 Then
  WScript.Quit 2
End If
scriptPath = WScript.Arguments(0)
psExe = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
cmd = """" & psExe & """ -NoLogo -NoProfile -ExecutionPolicy Bypass -File """ & scriptPath & """"
For i = 1 To WScript.Arguments.Count - 1
  cmd = cmd & " " & WScript.Arguments(i)
Next
exitCode = shell.Run(cmd, 0, True)
WScript.Quit exitCode
'@
  Set-Content -LiteralPath $runner -Value $content -Encoding Unicode
}

function Register-XmlTask($taskName, $scriptPath, $startTime, $repeatInterval, $repeatDuration, $executionTimeLimit = "PT20M") {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $silentRunner = Join-Path $scriptDir "静默运行PowerShell.vbs"
  $wscript = "$env:SystemRoot\System32\wscript.exe"
  $args = "`"$silentRunner`" `"$scriptPath`""
  $startBoundary = (Get-Date -Hour $startTime.Hours -Minute $startTime.Minutes -Second 0).ToString("yyyy-MM-ddTHH:mm:ss")
  $repetition = ""
  if ($repeatInterval -and $repeatDuration) {
    $repetition = "<Repetition><Interval>$repeatInterval</Interval><Duration>$repeatDuration</Duration><StopAtDurationEnd>true</StopAtDurationEnd></Repetition>"
  }
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>A股复盘软件后台任务</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>$startBoundary</StartBoundary>
      <Enabled>true</Enabled>
      $repetition
      <ScheduleByWeek>
        <DaysOfWeek><Monday/><Tuesday/><Wednesday/><Thursday/><Friday/></DaysOfWeek>
        <WeeksInterval>1</WeeksInterval>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Escape-Xml $user)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>$executionTimeLimit</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $wscript)</Command>
      <Arguments>$(Escape-Xml $args)</Arguments>
      <WorkingDirectory>$(Escape-Xml $scriptDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
  Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
}

function Register-LogonTask($taskName, $scriptPath) {
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $silentRunner = Join-Path $scriptDir "静默运行PowerShell.vbs"
  $wscript = "$env:SystemRoot\System32\wscript.exe"
  $args = "`"$silentRunner`" `"$scriptPath`""
  $xml = @"
<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>A股复盘软件本地同步服务</Description></RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>$(Escape-Xml $user)</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>$(Escape-Xml $user)</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings><StopOnIdleEnd>false</StopOnIdleEnd><RestartOnIdle>false</RestartOnIdle></IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>true</Hidden>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT10M</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>$(Escape-Xml $wscript)</Command>
      <Arguments>$(Escape-Xml $args)</Arguments>
      <WorkingDirectory>$(Escape-Xml $scriptDir)</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
"@
  Register-ScheduledTask -TaskName $taskName -Xml $xml -Force | Out-Null
}

try {
  Ensure-SilentRunner
  if (Get-ScheduledTask -TaskName "A股0AMV盘前数据源准备" -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName "A股0AMV盘前数据源准备" -Confirm:$false
    Write-RunLog "已删除旧任务：A股0AMV盘前数据源准备。"
  }
  Register-XmlTask -taskName "A股盘中实时自动更新" -scriptPath (Join-Path $scriptDir "盘中实时更新.ps1") -startTime ([TimeSpan]"09:25") -repeatInterval "PT1M" -repeatDuration "PT5H40M"
  Register-XmlTask -taskName "A股收盘最终复盘更新" -scriptPath (Join-Path $scriptDir "运行自动更新.ps1") -startTime ([TimeSpan]"15:05") -repeatInterval $null -repeatDuration $null -executionTimeLimit "PT40M"
  # 普通版不注册量化选股任务。
  Register-XmlTask -taskName "A股机构衍生品收盘更新" -scriptPath (Join-Path $scriptDir "更新机构衍生品.ps1") -startTime ([TimeSpan]"17:15") -repeatInterval $null -repeatDuration $null -executionTimeLimit "PT10M"
  Register-LogonTask -taskName "A股复盘同步服务" -scriptPath (Join-Path $scriptDir "启动复盘同步服务.ps1")
  Register-LogonTask -taskName "A股开机后补更新" -scriptPath (Join-Path $scriptDir "开机后检查更新.ps1")
  if (-not $RegisterOnly) {
    Start-ScheduledTask -TaskName "A股复盘同步服务"
  }
  Write-RunLog "复盘软件自动同步已安装：登录后启动本地同步服务；09:25预启动，09:30-15:00每1分钟同步市场；15:05收盘最终更新；17:15更新中金所机构衍生品；15:00后开机自动补更新。"
  "installed"
} catch {
  Write-RunLog ("盘中实时任务安装失败：" + $_.Exception.Message)
  throw
}
