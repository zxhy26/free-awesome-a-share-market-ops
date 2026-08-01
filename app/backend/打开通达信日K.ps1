[CmdletBinding()]
param(
  [string]$Code = "",
  [string]$Market = "",
  [string]$Name = "",
  [string]$PreferredApp = "",
  [switch]$StrictPreferred,
  [switch]$DryRun,
  [switch]$SelfTest,
  [switch]$NoWebFallback
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$logPath = Join-Path $scriptDir "自动更新日志.txt"
$stateDir = Join-Path $env:LOCALAPPDATA "A股复盘软件"
$choicePath = Join-Path $stateDir "股票软件选择.json"
$script:candidates = @()
$script:usageRecords = @()
$brokerPattern = "华泰证券|国泰海通|国泰君安|中信证券|招商证券|广发证券|银河证券|国信证券|中金财富|平安证券|东方证券|申万宏源|光大证券|国金证券|长江证券|国投证券|安信证券|浙商证券|兴业证券|方正证券|财通证券|东吴证券|华西证券|中泰证券|中原证券|山西证券|西南证券|国联民生|国联证券|湘财证券|华福证券|华安证券|南京证券|第一创业|万联证券|渤海证券|红塔证券|东兴证券|西部证券|首创证券|信达证券|天风证券|太平洋证券|证券交易|网上交易|独立委托|行情交易|涨乐财富通|涨乐全球通|佣金宝|蜻蜓点金|君弘|e海通财|金阳光|优理宝|智远一户通|信e投|长江e号|股票行情|股票交易|证券客户端|行情终端|交易终端|金融终端|财富终端"
$profiles = @(
  [pscustomobject]@{Id="tongdaxin";Name="通达信";Priority=90;Mode="05";Exe=@("Tdxw.exe","new_tdx.exe","tdx.exe","tdxmp.exe","tdxwin.exe");ExeRe="^(Tdxw|new_tdx|tdx|tdxmp|tdxwin)\.exe$";TextRe="通达信|TongDaXin|(^|\W)TDX($|\W)"},
  [pscustomobject]@{Id="ths";Name="同花顺";Priority=80;Mode="F5";Exe=@("hexin.exe","xiadan.exe","ths.exe");ExeRe="^(hexin|xiadan|ths)\.exe$";TextRe="同花顺|核新|iFinD"},
  [pscustomobject]@{Id="eastmoney";Name="东方财富";Priority=75;Mode="F5";Exe=@("mainfree.exe","eastmoney.exe","emclient.exe","dfcfw.exe","choice.exe");ExeRe="^(mainfree|eastmoney|emclient|dfcfw|choice)\.exe$";TextRe="东方财富|EastMoney|Choice金融终端"},
  [pscustomobject]@{Id="dazhihui";Name="大智慧";Priority=70;Mode="F5";Exe=@("dzh2.exe","dzh.exe","dzh365.exe");ExeRe="^(dzh2|dzh|dzh365)\.exe$";TextRe="大智慧|(^|\W)DZH($|\W)"},
  [pscustomobject]@{Id="compass";Name="指南针";Priority=65;Mode="F5";Exe=@("znz.exe","compass.exe","cwin.exe","jdzb.exe","WavMain.exe");ExeRe="^(znz|compass|cwin|jdzb|WavMain)\.exe$";TextRe="指南针|Compass|全赢"},
  [pscustomobject]@{Id="xueqiu";Name="雪球";Priority=50;Mode="F5";Exe=@("xueqiu.exe","snowball.exe");ExeRe="^(xueqiu|snowball)\.exe$";TextRe="雪球|Xueqiu|Snowball"},
  [pscustomobject]@{Id="broker";Name="券商行情软件";Priority=40;Mode="F5";Exe=@();ExeRe="a^";TextRe=$brokerPattern}
)
$displayPattern = ($profiles | ForEach-Object { "(?:" + $_.TextRe + ")" }) -join "|"
$excludedProcesses = @("chrome","msedge","firefox","explorer","applicationframehost","searchhost","shellexperiencehost","wechat","weixin")

function Write-RunLog($message) {
  $line = "[{0}] {1}" -f (Get-Date -Format "yyyy/MM/dd HH:mm:ss"), $message
  for($i=0;$i -lt 5;$i++){ try{ Add-Content -LiteralPath $logPath -Encoding UTF8 -Value $line; return }catch{ Start-Sleep -Milliseconds (80*($i+1)) } }
  try{ Add-Content -LiteralPath ($logPath+".fallback") -Encoding UTF8 -Value $line }catch{}
}

function Normalize-UsageKey($value) {
  $text=[Environment]::ExpandEnvironmentVariables([string]$value).Trim().Trim('"')
  if(-not$text){return ""}
  try{
    if($text-match'^[A-Za-z]:\\'){return [IO.Path]::GetFullPath($text).TrimEnd('\').ToLowerInvariant()}
  }catch{}
  $text.ToLowerInvariant()
}

function Load-FeatureUsage {
  $script:usageRecords=@()
  foreach($category in @("AppLaunch","AppSwitched","ShowJumpView")){
    $registryPath="HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\FeatureUsage\$category"
    try{$item=Get-ItemProperty -LiteralPath $registryPath -ErrorAction Stop}catch{continue}
    foreach($property in $item.PSObject.Properties){
      if($property.Name-match'^PS'){continue}
      $count=0
      try{$count=[Math]::Max(0,[int]$property.Value)}catch{continue}
      if($count-le0){continue}
      $key=Normalize-UsageKey $property.Name
      if($key){$script:usageRecords+=,[pscustomobject]@{Key=$key;Count=$count;Category=$category}}
    }
  }
}

function Candidate-Usage($candidate) {
  $path=Normalize-UsageKey $candidate.Exe
  $launch=Normalize-UsageKey $candidate.Launch
  $exeName=if($path){[IO.Path]::GetFileName($path)}else{""}
  $exact=0;$profile=0;$categories=@()
  foreach($record in $script:usageRecords){
    $key=[string]$record.Key;$matchedExact=$false;$matchedProfile=$false
    if($path-and$key-eq$path){$matchedExact=$true}
    elseif($launch-and$key-eq$launch){$matchedExact=$true}
    elseif($key-notmatch'^[a-z]:\\' -and $exeName -and ($key-eq$exeName -or $key.EndsWith("\$exeName"))){$matchedProfile=$true}
    elseif($candidate.Label-and$key-match[regex]::Escape(([string]$candidate.Label).ToLowerInvariant())){$matchedProfile=$true}
    elseif($candidate.Profile.Id-ne"broker"-and$key-match$candidate.Profile.TextRe){$matchedProfile=$true}
    if($matchedExact){$exact+=[int]$record.Count;$categories+=[string]$record.Category}
    elseif($matchedProfile){$profile+=[int]$record.Count;$categories+=[string]$record.Category}
  }
  [pscustomobject]@{Count=$(if($exact-gt0){$exact}else{$profile});ExactCount=$exact;ProfileCount=$profile;Categories=@($categories|Select-Object -Unique)}
}

function Sort-CandidatesByUsage($items) {
  @($items|Sort-Object `
    @{Expression={$_.UsageCount};Descending=$true}, `
    @{Expression={$_.IsForeground};Descending=$true}, `
    @{Expression={$_.IsRunning};Descending=$true}, `
    @{Expression={$_.Preferred};Descending=$true}, `
    @{Expression="Score";Descending=$true}, `
    @{Expression={$_.Profile.Priority};Descending=$true})
}

function Convert-Exe($raw) {
  if(-not $raw){ return "" }
  $text=[Environment]::ExpandEnvironmentVariables([string]$raw).Trim()
  if($text -match '^"([^"]+\.exe)"'){ return $matches[1] }
  if($text -match '^(.+?\.exe)(?:,|\s|$)'){ return $matches[1].Trim('"') }
  return $text.Trim('"')
}

function Custom-Profile($name) {
  [pscustomobject]@{Id="custom";Name=$(if($name){$name}else{"自定义股票软件"});Priority=100;Mode="F5";Exe=@();ExeRe="a^";TextRe="a^"}
}

function Profile-For($path,$label="",$forced="") {
  if($forced){
    $p=$profiles|Where-Object Id -eq $forced|Select-Object -First 1
    if($p){return $p}
    if($forced -eq "custom"){return Custom-Profile $label}
  }
  $exe=if($path){[IO.Path]::GetFileName([string]$path)}else{""}
  foreach($p in $profiles){ if(($exe -and $exe -match $p.ExeRe)-or($label -and $label -match $p.TextRe)){return $p} }
  return $null
}

Add-Type @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class LocalStockWindowApi {
 [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd,int nCmdShow);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd,out uint pid);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetClassName(IntPtr hWnd,StringBuilder text,int maxCount);
 [DllImport("user32.dll", CharSet=CharSet.Unicode)] private static extern int GetWindowText(IntPtr hWnd,StringBuilder text,int maxCount);
 [DllImport("user32.dll")] private static extern int GetWindowTextLength(IntPtr hWnd);
 private delegate bool EnumWindowProc(IntPtr hWnd,IntPtr lParam);
 [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent,EnumWindowProc callback,IntPtr lParam);

 public static string ClassName(IntPtr hWnd) {
   var text=new StringBuilder(256);
   return GetClassName(hWnd,text,text.Capacity)>0 ? text.ToString() : "";
 }
 private static string ReadText(IntPtr hWnd) {
   int length=GetWindowTextLength(hWnd);
   if(length<=0) return "";
   var text=new StringBuilder(Math.Min(length+1,4096));
   GetWindowText(hWnd,text,text.Capacity);
   return text.ToString();
 }
 public static string SurfaceText(IntPtr root) {
   var values=new List<string>();
   string rootText=ReadText(root);
   if(!String.IsNullOrWhiteSpace(rootText)) values.Add(rootText);
   int seen=0;
   EnumWindowProc callback=delegate(IntPtr child,IntPtr state) {
     if(seen++>=240) return false;
     string value=ReadText(child);
     if(!String.IsNullOrWhiteSpace(value)) values.Add(value);
     return true;
   };
   EnumChildWindows(root,callback,IntPtr.Zero);
   return String.Join("\n",values.ToArray());
 }
}
"@

function Foreground-Pid {
  try{[uint32]$id=0;$h=[LocalStockWindowApi]::GetForegroundWindow();if($h-ne[IntPtr]::Zero){[void][LocalStockWindowApi]::GetWindowThreadProcessId($h,[ref]$id)};[int]$id}catch{0}
}
function Process-Path($p){try{[string]$p.Path}catch{""}}
function Process-Label($p){$a=@([string]$p.ProcessName,[string]$p.MainWindowTitle);try{$a+=[string]$p.FileVersionInfo.ProductName}catch{};try{$a+=[string]$p.FileVersionInfo.FileDescription}catch{};($a|Where-Object{$_})-join" "}
function Refresh-Process($process){try{$process.Refresh();$process}catch{$null}}
function Window-Class($process){try{$p=Refresh-Process $process;if($p-and$p.MainWindowHandle-ne 0){[LocalStockWindowApi]::ClassName($p.MainWindowHandle)}else{""}}catch{""}}
function Window-SurfaceText($process){try{$p=Refresh-Process $process;if($p-and$p.MainWindowHandle-ne 0){([string]$p.MainWindowTitle)+"`n"+[LocalStockWindowApi]::SurfaceText($p.MainWindowHandle)}else{""}}catch{""}}

function Test-LoginWindow($process,$profile) {
  if($profile.Id-ne"tongdaxin"){return $false}
  $p=Refresh-Process $process
  if(-not$p-or$p.MainWindowHandle-eq 0){return $false}
  $class=Window-Class $p
  $surface=Window-SurfaceText $p
  if($surface-match"账号|密码|用户登录|登录通达信|短信登录|扫码登录|游客登录|免费注册|记住密码|找回密码"){return $true}
  [bool]($class-eq"#32770"-and$surface-notmatch"分析图表|行情报价|自选股|沪深|上证指数|板块指数|\[[^\]]+\]")
}

function Test-ReadyWindow($process,$profile) {
  $p=Refresh-Process $process
  if(-not$p-or$p.MainWindowHandle-eq 0){return $false}
  $surface=Window-SurfaceText $p
  if($profile.Id-eq"tongdaxin"){
    if(Test-LoginWindow $p $profile){return $false}
    return [bool]($surface-match"分析图表|行情报价|自选股|沪深|上证指数|板块指数|\[[^\]]+\]")
  }
  [bool]($surface.Trim())
}

function Add-Candidate($exe,$launch,$label,$source,[int]$score,[int]$processId=0,$forced="") {
  $exe=Convert-Exe $exe
  if($exe -and -not(Test-Path -LiteralPath $exe -PathType Leaf)){$exe=""}
  if($exe-and[IO.Path]::GetFileName($exe)-match'(?i)unins|uninstall|setup|remove|卸载'){return}
  $launch=[Environment]::ExpandEnvironmentVariables([string]$launch).Trim('"')
  if($launch -and -not(Test-Path -LiteralPath $launch -PathType Leaf)){$launch=""}
  if(-not $exe -and -not $launch -and $processId-le 0){return}
  $p=Profile-For $exe $label $forced
  if(-not $p){return}
  $key=($(if($exe){$exe}elseif($launch){$launch}else{"pid:$processId"})).ToLowerInvariant()+"|"+$p.Id
  $old=$script:candidates|Where-Object Key -eq $key|Select-Object -First 1
  $total=$score+[int]$p.Priority
  if($old){if($total-gt$old.Score){$old.Score=$total;$old.Source=$source;$old.Pid=$processId};return}
  $script:candidates+=,[pscustomobject]@{Key=$key;Exe=$exe;Launch=$(if($launch){$launch}else{$exe});Label=$label;Source=$source;Pid=$processId;Profile=$p;Score=$total}
}

function Add-Running {
  $fg=Foreground-Pid
  foreach($proc in @(Get-Process -ErrorAction SilentlyContinue|Where-Object{$_.MainWindowHandle-ne 0})){
    if($excludedProcesses -contains ([string]$proc.ProcessName).ToLowerInvariant()){continue}
    $path=Process-Path $proc;$label=Process-Label $proc;$p=Profile-For $path $label
    if($p){Add-Candidate $path $path $label $(if($proc.Id-eq$fg){"当前前台软件"}else{"当前运行实例"}) $(if($proc.Id-eq$fg){1000}else{900}) $proc.Id $p.Id}
  }
}

function Add-Configured {
  $override=Convert-Exe $env:A_SHARE_REVIEW_STOCK_APP
  if($override-and(Test-Path -LiteralPath $override -PathType Leaf)){
    $label=if($env:A_SHARE_REVIEW_STOCK_APP_NAME){$env:A_SHARE_REVIEW_STOCK_APP_NAME}else{[IO.Path]::GetFileNameWithoutExtension($override)}
    $p=Profile-For $override $label $env:A_SHARE_REVIEW_STOCK_APP_KIND
    Add-Candidate $override $override $label "本机环境配置" 1100 0 $(if($p){$p.Id}else{"custom"})
  }
  if(Test-Path -LiteralPath $choicePath -PathType Leaf){try{$s=Get-Content -LiteralPath $choicePath -Raw -Encoding UTF8|ConvertFrom-Json;Add-Candidate $s.executablePath $s.launchPath $s.appName "本机上次成功选择" 720 0 $s.appId}catch{}}
}

function Add-Shortcuts {
  $roots=@((Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs"),(Join-Path $env:ProgramData "Microsoft\Windows\Start Menu\Programs"),[Environment]::GetFolderPath("Desktop"),[Environment]::GetFolderPath("CommonDesktopDirectory"))|Where-Object{$_-and(Test-Path -LiteralPath $_ -PathType Container)}|Sort-Object -Unique
  $shell=New-Object -ComObject WScript.Shell
  foreach($root in $roots){foreach($lnk in @(Get-ChildItem -LiteralPath $root -Filter "*.lnk" -Recurse -ErrorAction SilentlyContinue|Where-Object{$_.BaseName-match$displayPattern})){
    try{$target=Convert-Exe ($shell.CreateShortcut($lnk.FullName).TargetPath);if($target){Add-Candidate $target $lnk.FullName $lnk.BaseName "本机开始菜单或桌面" 650}}catch{}
  }}
}

function Add-Registry {
  $exeNames=@($profiles|ForEach-Object{$_.Exe}|Sort-Object -Unique)
  foreach($root in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths","HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths")){
    foreach($name in $exeNames){try{$p=Convert-Exe (Get-ItemPropertyValue -LiteralPath (Join-Path $root $name) -Name "(default)" -ErrorAction Stop);if($p){Add-Candidate $p $p $name "本机应用注册表" 620}}catch{}}
  }
  foreach($root in @("HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*","HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*")){
    foreach($item in @(Get-ItemProperty $root -ErrorAction SilentlyContinue|Where-Object{$_.DisplayName-match$displayPattern})){
      $label=[string]$item.DisplayName;$profile=Profile-For "" $label;if(-not$profile){continue}
      $icon=Convert-Exe $item.DisplayIcon
      if($icon-and[IO.Path]::GetFileName($icon)-notmatch"(?i)^(unins|uninstall|setup|update|launcher|crash|helper|service)"){Add-Candidate $icon $icon $label "本机安装信息" 590 0 $profile.Id}
      $dir=[Environment]::ExpandEnvironmentVariables([string]$item.InstallLocation).Trim('"')
      if($dir-and(Test-Path -LiteralPath $dir -PathType Container)){
        foreach($name in $profile.Exe){$p=Join-Path $dir $name;if(Test-Path -LiteralPath $p -PathType Leaf){Add-Candidate $p $p $label "本机安装目录" 580 0 $profile.Id}}
        if($profile.Id-eq"broker"){
          foreach($e in @(Get-ChildItem -LiteralPath $dir -Filter "*.exe" -File -ErrorAction SilentlyContinue|Where-Object{$_.Name-notmatch"(?i)unins|uninstall|setup|update|launcher|crash|helper|service"}|Select-Object -First 30)){
            $text="$label $($e.VersionInfo.ProductName) $($e.VersionInfo.FileDescription)";if($text-match$brokerPattern){Add-Candidate $e.FullName $e.FullName $label "本机券商安装目录" 520 0 "broker"}
          }
        }
      }
    }
  }
}

function Add-CommonPaths {
  $roots=@($env:LOCALAPPDATA,$env:ProgramFiles,${env:ProgramFiles(x86)},"C:\股票","D:\股票","D:\软件","E:\股票")|Where-Object{$_-and(Test-Path -LiteralPath $_ -PathType Container)}|Sort-Object -Unique
  $folderRe="通达信|同花顺|东方财富|大智慧|指南针|股票|证券|new_tdx|tdx|eastmoney|hexin|dzh|compass"
  foreach($root in $roots){$dirs=@($root);$dirs+=@(Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue|Where-Object{$_.Name-match$folderRe}|Select-Object -First 80|ForEach-Object{$_.FullName})
    foreach($dir in $dirs|Sort-Object -Unique){foreach($profile in $profiles|Where-Object{$_.Exe.Count-gt 0}){foreach($name in $profile.Exe){$p=Join-Path $dir $name;if(Test-Path -LiteralPath $p -PathType Leaf){Add-Candidate $p $p $profile.Name "本机常用安装目录" 430 0 $profile.Id}}}}
  }
}

function Find-StockApps {
  $script:candidates=@();Load-FeatureUsage;Add-Running;Add-Configured;Add-Shortcuts;Add-Registry;Add-CommonPaths
  $preferredId=([string]$PreferredApp).Trim().ToLowerInvariant()
  $pool=if($StrictPreferred-and$preferredId){@($script:candidates|Where-Object{$_.Profile.Id-eq$preferredId})}else{@($script:candidates)}
  $foreground=Foreground-Pid
  foreach($candidate in $pool){
    $usage=Candidate-Usage $candidate;$process=Matching-Process $candidate
    $isRunning=[bool]$process;$isForeground=[bool]($process-and$process.Id-eq$foreground)
    $reason=if($usage.Count-gt0){"Windows应用使用记录 $($usage.Count) 次"}elseif($isForeground){"当前前台软件"}elseif($isRunning){"当前正在运行"}elseif($candidate.Source-eq"本机上次成功选择"){"本机上次成功选择"}else{"本机安装识别优先级"}
    $candidate|Add-Member -NotePropertyName UsageCount -NotePropertyValue ([int]$usage.Count) -Force
    $candidate|Add-Member -NotePropertyName UsageCategories -NotePropertyValue @($usage.Categories) -Force
    $candidate|Add-Member -NotePropertyName IsRunning -NotePropertyValue $isRunning -Force
    $candidate|Add-Member -NotePropertyName IsForeground -NotePropertyValue $isForeground -Force
    $candidate|Add-Member -NotePropertyName Preferred -NotePropertyValue ([bool]($preferredId-and$candidate.Profile.Id-eq$preferredId)) -Force
    $candidate|Add-Member -NotePropertyName SelectionReason -NotePropertyValue $reason -Force
  }
  Sort-CandidatesByUsage $pool
}

function Matching-Process($candidate) {
  if($candidate.Pid){$p=Get-Process -Id $candidate.Pid -ErrorAction SilentlyContinue;if($p){return $p}}
  $all=@(Get-Process -ErrorAction SilentlyContinue)
  if($candidate.Exe){$p=$all|Where-Object{(Process-Path $_)-eq$candidate.Exe-and$_.MainWindowHandle-ne 0}|Select-Object -First 1;if($p){return $p}}
  foreach($p in $all|Where-Object{$_.MainWindowHandle-ne 0}){$profile=Profile-For (Process-Path $p) (Process-Label $p);if($profile-and$profile.Id-eq$candidate.Profile.Id){return $p}}
  $null
}

function Wait-ReadyWindow($candidate,[int]$preferred=0,[int]$timeoutSeconds=20) {
  $deadline=(Get-Date).AddSeconds([Math]::Max(1,$timeoutSeconds));$last=$null
  do{
    if($preferred){$p=Get-Process -Id $preferred -ErrorAction SilentlyContinue;if($p){$last=$p;if(Test-ReadyWindow $p $candidate.Profile){return $p}}}
    $p=Matching-Process $candidate;if($p){$last=$p;if(Test-ReadyWindow $p $candidate.Profile){return $p}}
    Start-Sleep -Milliseconds 400
  }while((Get-Date)-lt$deadline)
  if($last-and(Test-LoginWindow $last $candidate.Profile)){
    throw "通达信已启动，但仍停留在登录窗口。请先在通达信完成登录；登录后再次点击，程序会直接定位到对应日K页面"
  }
  $null
}

function Activate-App($process,$appName) {
  $shell=New-Object -ComObject WScript.Shell
  for($i=0;$i-lt30;$i++){try{$process.Refresh();if($process.MainWindowHandle-ne 0){[LocalStockWindowApi]::ShowWindowAsync($process.MainWindowHandle,9)|Out-Null;[LocalStockWindowApi]::SetForegroundWindow($process.MainWindowHandle)|Out-Null;Start-Sleep -Milliseconds 180};if($process.Id-and$shell.AppActivate([int]$process.Id)){return $shell};if($process.MainWindowTitle-and$shell.AppActivate($process.MainWindowTitle)){return $shell}}catch{};Start-Sleep -Milliseconds 300}
  throw "$appName 已启动，但窗口暂时无法操作。请完成该软件登录并显示行情主窗口后重试。"
}

function Normalize-SectorName($text) {
  (([string]$text).Trim()-replace'[ⅠⅡⅢⅣⅤ]+$',''-replace'(概念|板块)$','').Trim()
}

function Resolve-TdxSectorCode($stockCode,$stockName,$appPath="") {
  if($stockCode-match'^88\d{4}$'){return $stockCode}
  $target=Normalize-SectorName $stockName
  if(-not$target-or-not$appPath){return ""}
  $installDir=Split-Path -Parent $appPath
  $roots=@($installDir,(Split-Path -Parent $installDir))|Where-Object{$_}|Select-Object -Unique
  $fallback=""
  foreach($root in $roots){
    foreach($name in @("tdxzs.cfg","tdxzs3.cfg")){
      $cfg=Join-Path $root "T0002\hq_cache\$name"
      if(-not(Test-Path -LiteralPath $cfg -PathType Leaf)){continue}
      try{$text=[Text.Encoding]::GetEncoding(936).GetString([IO.File]::ReadAllBytes($cfg))}catch{continue}
      foreach($line in $text-split"\r?\n"){
        $parts=$line.Trim()-split'\|'
        if($parts.Count-lt2){continue}
        $candidateName=Normalize-SectorName $parts[0]
        $candidateCode=([string]$parts[1]).Trim()
        if($candidateName-ne$target-or$candidateCode-notmatch'^88\d{4}$'){continue}
        if($candidateCode-match'^880\d{3}$'){return $candidateCode}
        if(-not$fallback){$fallback=$candidateCode}
      }
    }
  }
  $fallback
}

function Search-Query($profile,$stockCode,$marketText,$stockName,$appPath="") {
  if($marketText-eq"sector"){
    if($profile.Id-eq"tongdaxin"){
      $resolved=Resolve-TdxSectorCode $stockCode $stockName $appPath
      if($resolved){return $resolved}
    }
    if($stockName){return $stockName}
    return $stockCode
  }
  $stockCode
}

function Tdx-InternalUrl($stockCode) {
  if($stockCode-match'^\d{6}$'){"http://www.treeid/code_$stockCode"}else{""}
}

function Invoke-TdxDirectNavigation($stockCode) {
  $url=Tdx-InternalUrl $stockCode
  if(-not$url){return [pscustomobject]@{Attempted=$false;Success=$false;Method="keyboard";Url="";Detail="目标没有通达信六位代码"}}
  try{
    $body=[ordered]@{id=1;method="exec_to_tdx";params=[ordered]@{url=$url}}|ConvertTo-Json -Depth 5 -Compress
    $response=Invoke-RestMethod -Uri "http://127.0.0.1:17709/" -Method Post -ContentType "application/json; charset=utf-8" -Body $body -TimeoutSec 2
    $json=$response|ConvertTo-Json -Depth 8 -Compress
    $success=[bool]($json-match'"ErrorId"\s*:\s*"?0"?'-or$json-match'"Value"\s*:\s*(?:1|2)')
    [pscustomobject]@{Attempted=$true;Success=$success;Method="tongdaxinOfficialExec";Url=$url;Detail=$json}
  }catch{
    [pscustomobject]@{Attempted=$true;Success=$false;Method="keyboard";Url=$url;Detail=$_.Exception.Message}
  }
}

function Paste-Text($shell,$text) {
  Add-Type -AssemblyName System.Windows.Forms;$had=$false;$saved=""
  try{$had=[Windows.Forms.Clipboard]::ContainsText();if($had){$saved=[Windows.Forms.Clipboard]::GetText()};[Windows.Forms.Clipboard]::SetText([string]$text);$shell.SendKeys("^v");Start-Sleep -Milliseconds 280}finally{try{if($had){[Windows.Forms.Clipboard]::SetText($saved)}else{[Windows.Forms.Clipboard]::Clear()}}catch{}}
}

function Send-DailyKShortcut($shell,$profile) {
  if($profile.Mode-eq"05"){$shell.SendKeys("05");Start-Sleep -Milliseconds 180;$shell.SendKeys("{ENTER}")}else{$shell.SendKeys("{F5}")}
  Start-Sleep -Milliseconds 700
}

function Send-Search($shell,$profile,$query) {
  if($query-match'^\d{6}$'){$shell.SendKeys($query)}else{Paste-Text $shell $query}
  Start-Sleep -Milliseconds 260;$shell.SendKeys("{ENTER}");Start-Sleep -Milliseconds 750
  Send-DailyKShortcut $shell $profile
}

function Send-AlternativeSearch($shell,$profile,$query) {
  if($profile.Id-eq"tongdaxin"){Send-Search $shell $profile $query;return}
  $shell.SendKeys("^f");Start-Sleep -Milliseconds 300
  if($query-match'^\d{6}$'){$shell.SendKeys($query)}else{Paste-Text $shell $query}
  Start-Sleep -Milliseconds 240;$shell.SendKeys("{ENTER}");Start-Sleep -Milliseconds 650;$shell.SendKeys("{F5}")
}

function Normalize-WindowText($text){(([string]$text)-replace'[\s\p{P}\p{S}]','').ToUpperInvariant()}
function Navigation-Tokens($stockCode,$stockName,$marketText) {
  $tokens=@();$name=Normalize-WindowText $stockName
  if($name){$tokens+=$name;$plain=$name-replace'^\*?ST','';if($plain.Length-ge 2){$tokens+=$plain};if($marketText-eq"sector"){$base=Normalize-WindowText (Normalize-SectorName $stockName);if($base.Length-ge 2){$tokens+=$base}}}
  if(-not$tokens-and$stockCode){$tokens+=(Normalize-WindowText $stockCode)}
  @($tokens|Where-Object{$_.Length-ge 2}|Select-Object -Unique)
}

function Title-Target($title) {
  $match=[regex]::Match([string]$title,'\[(?:分析图表|技术分析|日线|日K|K线)\s*[-—:：]?\s*(?<target>[^\]]+)\]')
  if($match.Success){Normalize-WindowText $match.Groups["target"].Value}else{""}
}

function Match-TitleTarget($title,$stockCode,$stockName,$marketText) {
  $observed=Title-Target $title
  if(-not$observed){return ""}
  foreach($token in @(Navigation-Tokens $stockCode $stockName $marketText)){if($observed-eq$token){return $token}}
  ""
}

function Navigation-Observation($process,$profile,$stockCode,$stockName,$marketText) {
  $p=Refresh-Process $process;$title=if($p){[string]$p.MainWindowTitle}else{""};$surface=Window-SurfaceText $p;$normalized=Normalize-WindowText $surface
  $matched=""
  if($profile.Id-eq"tongdaxin"){$matched=Match-TitleTarget $title $stockCode $stockName $marketText}else{foreach($token in @(Navigation-Tokens $stockCode $stockName $marketText)){if($normalized.Contains($token)){$matched=$token;break}}}
  $dailyK=[bool]($normalized-match"分析图表|日线|日K|K线|MACD|MA5")
  if($profile.Id-ne"tongdaxin"-and$matched){$dailyK=$true}
  [pscustomobject]@{Verified=[bool]($matched-and$dailyK);TargetMatched=[bool]$matched;PageMatched=$dailyK;Matched=$matched;ObservedTarget=(Title-Target $title);Page="dailyK";Title=$title}
}

function Wait-Navigation($process,$profile,$stockCode,$stockName,$marketText,[int]$timeoutMilliseconds=6000) {
  $deadline=(Get-Date).AddMilliseconds([Math]::Max(500,$timeoutMilliseconds));$observation=$null
  do{$observation=Navigation-Observation $process $profile $stockCode $stockName $marketText;if($observation.Verified){return $observation};Start-Sleep -Milliseconds 250}while((Get-Date)-lt$deadline)
  if($observation){$observation}else{[pscustomobject]@{Verified=$false;TargetMatched=$false;PageMatched=$false;Matched="";Page="dailyK";Title=""}}
}

function Save-Choice($candidate) {
  try{if(-not(Test-Path -LiteralPath $stateDir -PathType Container)){New-Item -ItemType Directory -Path $stateDir -Force|Out-Null};[ordered]@{appId=$candidate.Profile.Id;appName=$candidate.Profile.Name;executablePath=$candidate.Exe;launchPath=$candidate.Launch;source=$candidate.Source;savedAt=Get-Date -Format "yyyy-MM-dd HH:mm:ss"}|ConvertTo-Json|Set-Content -LiteralPath $choicePath -Encoding UTF8}catch{}
}

function Run-SelfTest {
  foreach($s in @(@("C:\x\Tdxw.exe","","tongdaxin"),@("C:\x\hexin.exe","","ths"),@("C:\x\mainfree.exe","","eastmoney"),@("C:\x\dzh2.exe","","dazhihui"),@("C:\x\x.exe","指南针全赢","compass"),@("C:\x\x.exe","中信证券至信版","broker"))){$p=Profile-For $s[0] $s[1];if(-not$p-or$p.Id-ne$s[2]){throw "软件识别自检失败：$($s-join'|')"}}
  $tdx=$profiles|Where-Object Id -eq tongdaxin|Select-Object -First 1;$ths=$profiles|Where-Object Id -eq ths|Select-Object -First 1
  if((Search-Query $tdx "880123" "sector" "通信设备")-ne"880123"){throw "通达信板块代码自检失败"};if((Search-Query $ths "BK1036" "sector" "通信设备")-ne"通信设备"){throw "跨软件板块名称自检失败"};if((Search-Query $ths "600000" "stock" "浦发银行")-ne"600000"){throw "个股代码自检失败"};if((Tdx-InternalUrl "600000")-ne"http://www.treeid/code_600000"){throw "通达信官方页面地址自检失败"}
  if((Normalize-SectorName "银行Ⅱ")-ne"银行"){throw "板块名称标准化自检失败"};if((Match-TitleTarget "通达信金融终端 - [分析图表-平安银行]" "BK0475" "银行Ⅱ" "sector")){throw "板块标题误命中拦截自检失败"};if((Match-TitleTarget "通达信金融终端 - [分析图表-银行]" "BK0475" "银行Ⅱ" "sector")-ne"银行"){throw "板块标题精确命中自检失败"}
  $ranked=Sort-CandidatesByUsage @(
    [pscustomobject]@{UsageCount=3;IsForeground=$true;IsRunning=$true;Preferred=$false;Score=999;Profile=[pscustomobject]@{Priority=100};Name="低频"},
    [pscustomobject]@{UsageCount=21;IsForeground=$false;IsRunning=$false;Preferred=$false;Score=1;Profile=[pscustomobject]@{Priority=1};Name="高频"}
  )
  if($ranked[0].Name-ne"高频"){throw "设备使用频率排序自检失败"}
  [pscustomobject]@{ok=$true;selfTest=$true;supported=@($profiles|ForEach-Object{$_.Name});selectionPolicy="windowsFeatureUsageSingleCandidate";selectedCandidateCount=1;webFallback=$false;directNavigationRequired=$true;targetPage="dailyK";navigationRequiresVerification=$true}
}

function Invoke-Open {
  $rawCode=([string]$Code).Trim().ToUpperInvariant();$marketText=([string]$Market).Trim().ToLowerInvariant();$stockName=([string]$Name).Trim()
  $stockCode=if($marketText-eq"sector"){if($rawCode-match'^(88\d{4}|BK\d{4})$'){$rawCode}elseif($rawCode-match'^\d{6}$'){$rawCode}else{""}}else{($rawCode-replace"\D","")}
  if($marketText-ne"sector"-and$stockCode-notmatch'^\d{6}$'){throw "股票代码无效：$Code"}
  if($marketText-eq"sector"-and-not$stockCode-and-not$stockName){throw "板块代码和名称均为空"}
  $candidates=@(Find-StockApps)
  if(-not$candidates.Count){
    if($StrictPreferred-and$PreferredApp-eq"tongdaxin"){throw "自用版已固定使用通达信，但这台电脑未检测到通达信"}
    throw "未在这台电脑检测到受支持的股票软件"
  }
  $candidate=$candidates[0]
  if($DryRun){
    $query=Search-Query $candidate.Profile $stockCode $marketText $stockName $candidate.Exe;$existing=Matching-Process $candidate
    return [pscustomobject]@{ok=$true;mode="localApp";code=$stockCode;market=$marketText;name=$stockName;query=$query;localApp=$candidate.Profile.Name;localAppPath=$candidate.Exe;discoverySource=$candidate.Source;usageCount=$candidate.UsageCount;selectionReason=$candidate.SelectionReason;existingProcessId=$(if($existing){$existing.Id}else{$null});willLaunch=-not[bool]$existing;requiresReadyWindow=$true;directNavigationRequired=$true;requiresTargetVerification=$true;targetPage="dailyK";webFallback=$false;candidateCount=$candidates.Count;selectedCandidateCount=1;candidates=@($candidates|Select-Object -First 8|ForEach-Object{[pscustomobject]@{app=$_.Profile.Name;source=$_.Source;usageCount=$_.UsageCount;selectionReason=$_.SelectionReason;running=$_.IsRunning;selected=[bool]($_.Key-eq$candidate.Key);path=$_.Exe}});dryRun=$true}
  }
  $query=Search-Query $candidate.Profile $stockCode $marketText $stockName $candidate.Exe
  if(-not$query){throw "已选定 $($candidate.Profile.Name)，但缺少可搜索代码或名称"}
  $launched=$false;$proc=Matching-Process $candidate
  try{
    if($proc){$proc=Wait-ReadyWindow $candidate $proc.Id 4;if(-not$proc){throw "$($candidate.Profile.Name) 当前没有可操作的行情主窗口"}}
    if(-not$proc){$launch=if($candidate.Launch){$candidate.Launch}else{$candidate.Exe};if(-not$launch){throw "已识别 $($candidate.Profile.Name)，但缺少可启动路径"};$cwd=if($candidate.Exe){Split-Path -Parent $candidate.Exe}else{$env:USERPROFILE};$started=Start-Process -FilePath $launch -WorkingDirectory $cwd -PassThru;$launched=$true;$proc=Wait-ReadyWindow $candidate $(if($started){$started.Id}else{0}) 30;if(-not$proc){throw "$($candidate.Profile.Name) 启动后没有检测到已登录的行情主窗口"}}
    $shell=Activate-App $proc $candidate.Profile.Name;$observation=$null;$navigationMethod="keyboard"
    if($candidate.Profile.Id-eq"tongdaxin"){
      $direct=Invoke-TdxDirectNavigation $query
      if($direct.Success){$navigationMethod=$direct.Method;Start-Sleep -Milliseconds 650;$shell=Activate-App $proc $candidate.Profile.Name;Send-DailyKShortcut $shell $candidate.Profile;$observation=Wait-Navigation $proc $candidate.Profile $stockCode $stockName $marketText 5000}
    }
    if((-not $observation)-or(-not $observation.Verified)){$navigationMethod="keyboard";$shell=Activate-App $proc $candidate.Profile.Name;Send-Search $shell $candidate.Profile $query;$observation=Wait-Navigation $proc $candidate.Profile $stockCode $stockName $marketText 6000}
    if(-not$observation.Verified){$shell=Activate-App $proc $candidate.Profile.Name;Send-AlternativeSearch $shell $candidate.Profile $query;$observation=Wait-Navigation $proc $candidate.Profile $stockCode $stockName $marketText 5000}
    if(-not$observation.Verified){throw "$($candidate.Profile.Name) 已启动，但未能确认进入 $stockName $stockCode 对应的日K页面"}
    Save-Choice $candidate;Write-RunLog "本机股票软件日K跳转并验证：$stockCode $stockName；唯一软件：$($candidate.Profile.Name)；使用记录：$($candidate.UsageCount)；选择依据：$($candidate.SelectionReason)；查询：$query；标题：$($observation.Title)；来源：$($candidate.Source)；新启动：$launched"
    return [pscustomobject]@{ok=$true;mode="localApp";code=$stockCode;market=$marketText;name=$stockName;query=$query;localApp=$candidate.Profile.Name;localAppPath=$candidate.Exe;discoverySource=$candidate.Source;usageCount=$candidate.UsageCount;selectionReason=$candidate.SelectionReason;candidateCount=$candidates.Count;selectedCandidateCount=1;processId=$proc.Id;launched=$launched;directNavigation=$true;navigationMethod=$navigationMethod;targetPage="dailyK";verifiedTarget=$true;verifiedPage=$true;verifiedBy="targetAndDailyKWindow";matchedTarget=$observation.Matched;observedWindowTitle=$observation.Title;dryRun=$false;message="已按本机使用频率选择$($candidate.Profile.Name)，并直接定位到 $stockName $stockCode 日K页面"}
  }catch{
    $reason=$_.Exception.Message
    Write-RunLog "唯一首选股票软件跳转未通过：$($candidate.Profile.Name)；使用记录：$($candidate.UsageCount)；$reason；未启动其他候选"
    throw "已按本机使用频率选定 $($candidate.Profile.Name)，但未完成目标日K跳转：$reason。为避免同时打开多个软件，本次不会继续启动其他候选。"
  }
}

try{$result=if($SelfTest){Run-SelfTest}else{Invoke-Open};$result|ConvertTo-Json -Depth 6 -Compress;exit 0}catch{$message=$_.Exception.Message;$errorCode=if($message-match"登录窗口|完成登录"){"TRADING_APP_LOGIN_REQUIRED"}else{"TRADING_APP_TARGET_NOT_REACHED"};Write-RunLog "本机股票软件跳转失败：$message";[pscustomobject]@{ok=$false;errorCode=$errorCode;code=([string]$Code-replace"\D","");name=$Name;targetPage="dailyK";directNavigation=$false;verifiedTarget=$false;verifiedPage=$false;message=$message}|ConvertTo-Json -Compress;[Console]::Error.WriteLine($message);exit 1}
