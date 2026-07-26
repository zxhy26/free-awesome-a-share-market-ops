[CmdletBinding()]
param(
  [string]$Code = "",
  [string]$Market = "",
  [string]$Name = "",
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

function Test-ReadyWindow($process,$profile) {
  $p=Refresh-Process $process
  if(-not$p-or$p.MainWindowHandle-eq 0){return $false}
  $class=Window-Class $p
  $surface=Window-SurfaceText $p
  if($profile.Id-eq"tongdaxin"){
    if($class-eq"#32770"){return $false}
    if($surface-match"账号|密码|用户登录|登录通达信"){return $false}
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

function Find-StockApp {
  $script:candidates=@();Add-Running;Add-Configured;Add-Shortcuts;Add-Registry;Add-CommonPaths
  $script:candidates|Sort-Object @{Expression="Score";Descending=$true},@{Expression={$_.Profile.Priority};Descending=$true}|Select-Object -First 1
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
  if($last-and$candidate.Profile.Id-eq"tongdaxin"-and(Window-Class $last)-eq"#32770"){
    throw "通达信已启动，但仍停留在登录窗口。为避免把股票代码输入账号栏，本次没有执行软件内跳转"
  }
  $null
}

function Activate-App($process,$appName) {
  $shell=New-Object -ComObject WScript.Shell
  for($i=0;$i-lt30;$i++){try{$process.Refresh();if($process.MainWindowHandle-ne 0){[LocalStockWindowApi]::ShowWindowAsync($process.MainWindowHandle,9)|Out-Null;[LocalStockWindowApi]::SetForegroundWindow($process.MainWindowHandle)|Out-Null;Start-Sleep -Milliseconds 180};if($process.Id-and$shell.AppActivate([int]$process.Id)){return $shell};if($process.MainWindowTitle-and$shell.AppActivate($process.MainWindowTitle)){return $shell}}catch{};Start-Sleep -Milliseconds 300}
  throw "$appName 已启动，但窗口暂时无法操作。请完成该软件登录并显示行情主窗口后重试。"
}

function Search-Query($profile,$stockCode,$marketText,$stockName) {
  if($marketText-eq"sector"){if($profile.Id-eq"tongdaxin"-and$stockCode-match'^880\d{3}$'){return $stockCode};if($stockName){return $stockName};return $stockCode};$stockCode
}

function Paste-Text($shell,$text) {
  Add-Type -AssemblyName System.Windows.Forms;$had=$false;$saved=""
  try{$had=[Windows.Forms.Clipboard]::ContainsText();if($had){$saved=[Windows.Forms.Clipboard]::GetText()};[Windows.Forms.Clipboard]::SetText([string]$text);$shell.SendKeys("^v");Start-Sleep -Milliseconds 280}finally{try{if($had){[Windows.Forms.Clipboard]::SetText($saved)}else{[Windows.Forms.Clipboard]::Clear()}}catch{}}
}

function Send-Search($shell,$profile,$query) {
  if($query-match'^\d{6}$'){$shell.SendKeys($query)}else{Paste-Text $shell $query}
  Start-Sleep -Milliseconds 260;$shell.SendKeys("{ENTER}");Start-Sleep -Milliseconds 750
  if($profile.Mode-eq"05"){$shell.SendKeys("05");Start-Sleep -Milliseconds 160;$shell.SendKeys("{ENTER}")}else{$shell.SendKeys("{F5}")}
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
  if($name){$tokens+=$name;$plain=$name-replace'^\*?ST','';if($plain.Length-ge 2){$tokens+=$plain};if($marketText-eq"sector"){$base=$name-replace'[ⅠⅡⅢⅣⅤ]+$','';$base=$base-replace'概念$','';if($base.Length-ge 2){$tokens+=$base}}}
  if(-not$tokens-and$stockCode){$tokens+=(Normalize-WindowText $stockCode)}
  @($tokens|Where-Object{$_.Length-ge 2}|Select-Object -Unique)
}

function Navigation-Observation($process,$stockCode,$stockName,$marketText) {
  $p=Refresh-Process $process;$title=if($p){[string]$p.MainWindowTitle}else{""};$surface=Window-SurfaceText $p;$normalized=Normalize-WindowText $surface
  foreach($token in @(Navigation-Tokens $stockCode $stockName $marketText)){if($normalized.Contains($token)){return [pscustomobject]@{Verified=$true;Matched=$token;Title=$title}}}
  [pscustomobject]@{Verified=$false;Matched="";Title=$title}
}

function Wait-Navigation($process,$stockCode,$stockName,$marketText,[int]$timeoutMilliseconds=6000) {
  $deadline=(Get-Date).AddMilliseconds([Math]::Max(500,$timeoutMilliseconds));$observation=$null
  do{$observation=Navigation-Observation $process $stockCode $stockName $marketText;if($observation.Verified){return $observation};Start-Sleep -Milliseconds 250}while((Get-Date)-lt$deadline)
  if($observation){$observation}else{[pscustomobject]@{Verified=$false;Matched="";Title=""}}
}

function Save-Choice($candidate) {
  try{if(-not(Test-Path -LiteralPath $stateDir -PathType Container)){New-Item -ItemType Directory -Path $stateDir -Force|Out-Null};[ordered]@{appId=$candidate.Profile.Id;appName=$candidate.Profile.Name;executablePath=$candidate.Exe;launchPath=$candidate.Launch;source=$candidate.Source;savedAt=Get-Date -Format "yyyy-MM-dd HH:mm:ss"}|ConvertTo-Json|Set-Content -LiteralPath $choicePath -Encoding UTF8}catch{}
}

function Web-Url($stockCode,$stockName,$marketText) {
  $code=([string]$stockCode).Trim().ToUpperInvariant()
  if($marketText-eq"sector"-and$code-match'^BK\d{4}$'){return "https://quote.eastmoney.com/bk/90.$code.html"}
  if($marketText-ne"sector"-and$code-match'^\d{6}$'){
    if($code-match'^(4|8|92)'){return "https://quote.eastmoney.com/bj/$code.html"}
    if($code-match'^(5|6|9)'){return "https://quote.eastmoney.com/sh$code.html"}
    return "https://quote.eastmoney.com/sz$code.html"
  }
  $key=if($marketText-eq"sector"){($(if($stockName){$stockName}else{$stockCode}))+" 板块 日K"}else{($(if($stockCode){$stockCode}else{$stockName}))+" 股票 日K"}
  "https://so.eastmoney.com/web/s?keyword="+[Uri]::EscapeDataString($key)
}

function Open-Web($stockCode,$stockName,$marketText,$reason) {
  $url=Web-Url $stockCode $stockName $marketText;if(-not$DryRun){Start-Process -FilePath $url|Out-Null};Write-RunLog "本机股票软件不可用，改用东方财富网页：$stockCode $stockName；原因：$reason"
  [pscustomobject]@{ok=$true;mode="webFallback";code=$stockCode;market=$marketText;name=$stockName;localApp="默认浏览器";discoverySource="东方财富精确行情页兜底";url=$url;targetUrlExact=($url-notmatch'/web/s\?');verifiedTarget=$false;dryRun=[bool]$DryRun;message="本机股票软件未能确认进入对应页面，已打开 $stockName $stockCode 的具体行情页";fallbackReason=$reason}
}

function Run-SelfTest {
  foreach($s in @(@("C:\x\Tdxw.exe","","tongdaxin"),@("C:\x\hexin.exe","","ths"),@("C:\x\mainfree.exe","","eastmoney"),@("C:\x\dzh2.exe","","dazhihui"),@("C:\x\x.exe","指南针全赢","compass"),@("C:\x\x.exe","中信证券至信版","broker"))){$p=Profile-For $s[0] $s[1];if(-not$p-or$p.Id-ne$s[2]){throw "软件识别自检失败：$($s-join'|')"}}
  $tdx=$profiles|Where-Object Id -eq tongdaxin|Select-Object -First 1;$ths=$profiles|Where-Object Id -eq ths|Select-Object -First 1
  if((Search-Query $tdx "880123" "sector" "通信设备")-ne"880123"){throw "通达信板块代码自检失败"};if((Search-Query $ths "BK1036" "sector" "通信设备")-ne"通信设备"){throw "跨软件板块名称自检失败"};if((Search-Query $ths "600000" "stock" "浦发银行")-ne"600000"){throw "个股代码自检失败"}
  $stockUrl=Web-Url "600000" "浦发银行" "stock";$bjUrl=Web-Url "920266" "生物谷" "stock";$sectorUrl=Web-Url "BK1238" "IT服务Ⅱ" "sector"
  if($stockUrl-ne'https://quote.eastmoney.com/sh600000.html'-or$bjUrl-ne'https://quote.eastmoney.com/bj/920266.html'-or$sectorUrl-ne'https://quote.eastmoney.com/bk/90.BK1238.html'){throw "精确网页兜底自检失败"}
  [pscustomobject]@{ok=$true;selfTest=$true;supported=@($profiles|ForEach-Object{$_.Name});fallback=$stockUrl;sectorFallback=$sectorUrl;navigationRequiresVerification=$true}
}

function Invoke-Open {
  $rawCode=([string]$Code).Trim().ToUpperInvariant();$marketText=([string]$Market).Trim().ToLowerInvariant();$stockName=([string]$Name).Trim()
  $stockCode=if($marketText-eq"sector"){if($rawCode-match'^(880\d{3}|BK\d{4})$'){$rawCode}elseif($rawCode-match'^\d{6}$'){$rawCode}else{""}}else{($rawCode-replace"\D","")}
  if($marketText-ne"sector"-and$stockCode-notmatch'^\d{6}$'){throw "股票代码无效：$Code"}
  if($marketText-eq"sector"-and-not$stockCode-and-not$stockName){throw "板块代码和名称均为空"}
  $candidate=Find-StockApp
  if(-not$candidate){if($NoWebFallback){throw "未在这台电脑检测到受支持的股票软件"};return Open-Web $stockCode $stockName $marketText "未检测到受支持的股票软件"}
  $query=Search-Query $candidate.Profile $stockCode $marketText $stockName
  if(-not$query){if($NoWebFallback){throw "没有可供本机股票软件搜索的代码或名称"};return Open-Web $stockCode $stockName $marketText "缺少可搜索的代码或名称"}
  $existing=Matching-Process $candidate
  if($DryRun){return [pscustomobject]@{ok=$true;mode="localApp";code=$stockCode;market=$marketText;name=$stockName;query=$query;localApp=$candidate.Profile.Name;localAppPath=$candidate.Exe;discoverySource=$candidate.Source;existingProcessId=$(if($existing){$existing.Id}else{$null});willLaunch=-not[bool]$existing;requiresReadyWindow=$true;requiresTargetVerification=$true;fallbackUrl=(Web-Url $stockCode $stockName $marketText);candidateCount=$script:candidates.Count;candidates=@($script:candidates|Sort-Object Score -Descending|Select-Object -First 8|ForEach-Object{[pscustomobject]@{app=$_.Profile.Name;source=$_.Source;running=[bool]$_.Pid;path=$_.Exe}});dryRun=$true}}
  $launched=$false;$proc=$existing
  try{
    if($proc){$proc=Wait-ReadyWindow $candidate $proc.Id 4;if(-not$proc){throw "$($candidate.Profile.Name) 当前没有可操作的行情主窗口"}}
    if(-not$proc){$launch=if($candidate.Launch){$candidate.Launch}else{$candidate.Exe};if(-not$launch){throw "已识别 $($candidate.Profile.Name)，但缺少可启动路径"};$cwd=if($candidate.Exe){Split-Path -Parent $candidate.Exe}else{$env:USERPROFILE};$started=Start-Process -FilePath $launch -WorkingDirectory $cwd -PassThru;$launched=$true;$proc=Wait-ReadyWindow $candidate $(if($started){$started.Id}else{0}) 30;if(-not$proc){throw "$($candidate.Profile.Name) 启动后没有检测到已登录的行情主窗口"}}
    $shell=Activate-App $proc $candidate.Profile.Name;Send-Search $shell $candidate.Profile $query;$observation=Wait-Navigation $proc $stockCode $stockName $marketText 6000
    if(-not$observation.Verified){$shell=Activate-App $proc $candidate.Profile.Name;Send-AlternativeSearch $shell $candidate.Profile $query;$observation=Wait-Navigation $proc $stockCode $stockName $marketText 5000}
    if(-not$observation.Verified){throw "$($candidate.Profile.Name) 已启动，但未能确认进入 $stockName $stockCode 对应的日K页面"}
    Save-Choice $candidate;Write-RunLog "本机股票软件日K跳转并验证：$stockCode $stockName；软件：$($candidate.Profile.Name)；查询：$query；标题：$($observation.Title)；来源：$($candidate.Source)；新启动：$launched"
    return [pscustomobject]@{ok=$true;mode="localApp";code=$stockCode;market=$marketText;name=$stockName;query=$query;localApp=$candidate.Profile.Name;localAppPath=$candidate.Exe;discoverySource=$candidate.Source;processId=$proc.Id;launched=$launched;verifiedTarget=$true;verifiedBy="windowTitleOrControls";matchedTarget=$observation.Matched;observedWindowTitle=$observation.Title;dryRun=$false;message="已在当前$($candidate.Profile.Name)中打开 $stockName $stockCode 日K（页面已验证）"}
  }catch{if($NoWebFallback){throw};return Open-Web $stockCode $stockName $marketText $_.Exception.Message}
}

try{$result=if($SelfTest){Run-SelfTest}else{Invoke-Open};$result|ConvertTo-Json -Depth 6 -Compress;exit 0}catch{$message=$_.Exception.Message;Write-RunLog "本机股票软件跳转失败：$message";[pscustomobject]@{ok=$false;code=([string]$Code-replace"\D","");name=$Name;message=$message}|ConvertTo-Json -Compress;[Console]::Error.WriteLine($message);exit 1}