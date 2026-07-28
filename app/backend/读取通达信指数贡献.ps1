param(
    [string]$OutputPath = "",
    [string]$TradeDate = "",
    [int]$DialogTimeoutSeconds = 12,
    [int]$DataTimeoutSeconds = 90
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path (Split-Path -Parent $PSScriptRoot) "data\index-contribution.json"
}
if ([string]::IsNullOrWhiteSpace($TradeDate)) {
    $indicesPath = Join-Path (Split-Path -Parent $PSScriptRoot) "data\indices.json"
    if (Test-Path -LiteralPath $indicesPath) {
        try {
            $TradeDate = (Get-Content -LiteralPath $indicesPath -Raw -Encoding UTF8 | ConvertFrom-Json).tradeDate
        } catch {
            $TradeDate = ""
        }
    }
}
function Get-EffectiveTradeDate {
    $now = Get-Date
    $candidate = if ($now.Hour -lt 9) { $now.Date.AddDays(-1) } else { $now.Date }
    while ($candidate.DayOfWeek -in @([DayOfWeek]::Saturday, [DayOfWeek]::Sunday)) {
        $candidate = $candidate.AddDays(-1)
    }
    return $candidate.ToString("yyyy-MM-dd")
}

$effectiveTradeDate = Get-EffectiveTradeDate
if ($TradeDate -notmatch '^\d{4}-\d{2}-\d{2}$' -or $TradeDate -lt $effectiveTradeDate) {
    $TradeDate = $effectiveTradeDate
}

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class TdxContributionNative
{
    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct GUITHREADINFO
    {
        public int cbSize;
        public int flags;
        public IntPtr hwndActive;
        public IntPtr hwndFocus;
        public IntPtr hwndCapture;
        public IntPtr hwndMenuOwner;
        public IntPtr hwndMoveSize;
        public IntPtr hwndCaret;
        public RECT rcCaret;
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool EnumChildWindows(IntPtr parent, EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int maxCount);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool GetGUIThreadInfo(uint threadId, ref GUITHREADINFO info);

    [DllImport("user32.dll")]
    public static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindow(IntPtr hWnd, int command);

    [DllImport("user32.dll")]
    public static extern int GetDlgCtrlID(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern IntPtr GetParent(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool PostMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", EntryPoint = "SendMessageW")]
    public static extern IntPtr SendMessage(IntPtr hWnd, uint message, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint allocationType, uint protect);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint freeType);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr written);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, int size, out IntPtr read);

    [DllImport("kernel32.dll", SetLastError = true)]
    public static extern bool IsWow64Process(IntPtr process, out bool wow64);

    public static string WindowText(IntPtr hWnd)
    {
        var text = new StringBuilder(1024);
        GetWindowText(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static string WindowClass(IntPtr hWnd)
    {
        var text = new StringBuilder(256);
        GetClassName(hWnd, text, text.Capacity);
        return text.ToString();
    }

    public static IntPtr[] TopWindowsForProcess(uint processId)
    {
        var result = new List<IntPtr>();
        EnumWindows((hWnd, _) =>
        {
            uint owner;
            GetWindowThreadProcessId(hWnd, out owner);
            if (owner == processId) result.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }

    public static IntPtr[] ChildWindows(IntPtr parent)
    {
        var result = new List<IntPtr>();
        EnumChildWindows(parent, (hWnd, _) =>
        {
            result.Add(hWnd);
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@

$WM_CHAR = 0x0102
$WM_KEYDOWN = 0x0100
$WM_KEYUP = 0x0101
$WM_CLOSE = 0x0010
$WM_LBUTTONDOWN = 0x0201
$WM_LBUTTONUP = 0x0202
$BM_CLICK = 0x00F5
$VK_RETURN = 0x0D
$MK_LBUTTON = 0x0001
$LVM_FIRST = 0x1000
$LVM_GETITEMCOUNT = $LVM_FIRST + 4
$LVM_GETITEMTEXTW = $LVM_FIRST + 115
$TCM_FIRST = 0x1300
$TCM_GETITEMCOUNT = $TCM_FIRST + 4
$TCM_GETITEMRECT = $TCM_FIRST + 10
$TCM_GETCURSEL = $TCM_FIRST + 11
$PROCESS_ACCESS = 0x0008 -bor 0x0010 -bor 0x0020 -bor 0x0400
$MEM_COMMIT_RESERVE = 0x3000
$MEM_RELEASE = 0x8000
$PAGE_READWRITE = 0x04

function Get-WindowText([IntPtr]$Handle) {
    return [TdxContributionNative]::WindowText($Handle)
}

function Get-TopWindow {
    param(
        [uint32]$ProcessId,
        [string]$TitlePattern
    )
    foreach ($handle in [TdxContributionNative]::TopWindowsForProcess($ProcessId)) {
        if ((Get-WindowText $handle) -match $TitlePattern) {
            return $handle
        }
    }
    return [IntPtr]::Zero
}

function Find-ChildByClass {
    param(
        [IntPtr]$Parent,
        [string]$ClassName
    )
    foreach ($handle in [TdxContributionNative]::ChildWindows($Parent)) {
        if ([TdxContributionNative]::WindowClass($handle) -eq $ClassName) {
            return $handle
        }
    }
    return [IntPtr]::Zero
}

function Find-MainTabControl {
    param([IntPtr]$Parent)
    $bestHandle = [IntPtr]::Zero
    $bestCount = 0
    foreach ($handle in [TdxContributionNative]::ChildWindows($Parent)) {
        if ([TdxContributionNative]::WindowClass($handle) -ne "SysTabControl32") { continue }
        $count = [int][TdxContributionNative]::SendMessage($handle, $TCM_GETITEMCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
        if ($count -gt $bestCount) {
            $bestHandle = $handle
            $bestCount = $count
        }
    }
    if ($bestCount -lt 10) { return [IntPtr]::Zero }
    return $bestHandle
}

function Close-ContributionDialog {
    param([IntPtr]$Dialog)
    if ($Dialog -eq [IntPtr]::Zero -or -not [TdxContributionNative]::IsWindow($Dialog)) { return }
    foreach ($handle in [TdxContributionNative]::ChildWindows($Dialog)) {
        if ([TdxContributionNative]::WindowClass($handle) -eq "Button" -and (Get-WindowText $handle) -eq "关闭") {
            [void][TdxContributionNative]::PostMessage($handle, $BM_CLICK, [IntPtr]::Zero, [IntPtr]::Zero)
            Start-Sleep -Milliseconds 250
            break
        }
    }
    if ([TdxContributionNative]::IsWindow($Dialog)) {
        [void][TdxContributionNative]::PostMessage($Dialog, $WM_CLOSE, [IntPtr]::Zero, [IntPtr]::Zero)
    }
}

function New-StatusPayload {
    param(
        [string]$Status,
        [string]$Message,
        [hashtable]$Indices = @{}
    )
    $now = Get-Date
    return [ordered]@{
        version = 1
        tradeDate = $TradeDate
        fetchedAt = $now.ToString("yyyy/MM/dd HH:mm:ss")
        source = [ordered]@{
            provider = "通达信"
            screen = ".929 贡献度排名"
            status = $Status
            message = $Message
            tradeDateBasis = "通达信实时榜单抓取日（按A股交易时段）"
        }
        indices = $Indices
    }
}

function Write-Payload {
    param([object]$Payload)
    $directory = Split-Path -Parent $OutputPath
    if (-not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Path $directory -Force | Out-Null
    }
    $temporary = "$OutputPath.tmp"
    $json = $Payload | ConvertTo-Json -Depth 10
    [System.IO.File]::WriteAllText($temporary, $json, [System.Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $OutputPath -Force
}

function Fail-Unavailable {
    param(
        [string]$Message,
        [int]$ExitCode = 2
    )
    $payload = New-StatusPayload -Status "unavailable" -Message $Message
    Write-Payload $payload
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 6)
    exit $ExitCode
}

function Send-TdxShortcut {
    param(
        [IntPtr]$MainWindow,
        [uint32]$ThreadId
    )
    foreach ($character in ".929".ToCharArray()) {
        $gui = [TdxContributionNative+GUITHREADINFO]::new()
        $gui.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][TdxContributionNative+GUITHREADINFO])
        [void][TdxContributionNative]::GetGUIThreadInfo($ThreadId, [ref]$gui)
        $target = if ($gui.hwndFocus -ne [IntPtr]::Zero) { $gui.hwndFocus } else { $MainWindow }
        [void][TdxContributionNative]::PostMessage($target, $WM_CHAR, [IntPtr][int][char]$character, [IntPtr]::Zero)
        Start-Sleep -Milliseconds 90
    }
    $gui = [TdxContributionNative+GUITHREADINFO]::new()
    $gui.cbSize = [Runtime.InteropServices.Marshal]::SizeOf([type][TdxContributionNative+GUITHREADINFO])
    [void][TdxContributionNative]::GetGUIThreadInfo($ThreadId, [ref]$gui)
    $target = if ($gui.hwndFocus -ne [IntPtr]::Zero) { $gui.hwndFocus } else { $MainWindow }
    [void][TdxContributionNative]::PostMessage($target, $WM_KEYDOWN, [IntPtr]$VK_RETURN, [IntPtr]::Zero)
    [void][TdxContributionNative]::PostMessage($target, $WM_KEYUP, [IntPtr]$VK_RETURN, [IntPtr]::Zero)
}

function Open-RemoteBuffer {
    param([uint32]$ProcessId)
    $processHandle = [TdxContributionNative]::OpenProcess($PROCESS_ACCESS, $false, $ProcessId)
    if ($processHandle -eq [IntPtr]::Zero) {
        throw "无法读取通达信列表，OpenProcess 错误 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $memorySize = [UIntPtr]::new([uint64]2048)
    $memory = [TdxContributionNative]::VirtualAllocEx($processHandle, [IntPtr]::Zero, $memorySize, $MEM_COMMIT_RESERVE, $PAGE_READWRITE)
    if ($memory -eq [IntPtr]::Zero) {
        [void][TdxContributionNative]::CloseHandle($processHandle)
        throw "无法分配通达信读取缓冲区，错误 $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
    $wow64 = $false
    [void][TdxContributionNative]::IsWow64Process($processHandle, [ref]$wow64)
    return [ordered]@{
        Process = $processHandle
        Memory = $memory
        Is32Bit = [Environment]::Is64BitOperatingSystem -and $wow64
    }
}

function Close-RemoteBuffer {
    param([hashtable]$Remote)
    if ($null -eq $Remote) { return }
    if ($Remote.Memory -ne [IntPtr]::Zero) {
        [void][TdxContributionNative]::VirtualFreeEx($Remote.Process, $Remote.Memory, [UIntPtr]::Zero, $MEM_RELEASE)
    }
    if ($Remote.Process -ne [IntPtr]::Zero) {
        [void][TdxContributionNative]::CloseHandle($Remote.Process)
    }
}

function Write-RemoteBytes {
    param(
        [hashtable]$Remote,
        [IntPtr]$Address,
        [byte[]]$Bytes
    )
    $written = [IntPtr]::Zero
    if (-not [TdxContributionNative]::WriteProcessMemory($Remote.Process, $Address, $Bytes, $Bytes.Length, [ref]$written)) {
        throw "写入通达信读取缓冲区失败"
    }
}

function Read-RemoteBytes {
    param(
        [hashtable]$Remote,
        [IntPtr]$Address,
        [int]$Length
    )
    $bytes = [byte[]]::new($Length)
    $read = [IntPtr]::Zero
    if (-not [TdxContributionNative]::ReadProcessMemory($Remote.Process, $Address, $bytes, $Length, [ref]$read)) {
        throw "读取通达信缓冲区失败"
    }
    return $bytes
}

function Set-Int32 {
    param([byte[]]$Buffer, [int]$Offset, [int]$Value)
    [BitConverter]::GetBytes($Value).CopyTo($Buffer, $Offset)
}

function Set-UInt32 {
    param([byte[]]$Buffer, [int]$Offset, [uint32]$Value)
    [BitConverter]::GetBytes($Value).CopyTo($Buffer, $Offset)
}

function Set-Pointer {
    param([byte[]]$Buffer, [int]$Offset, [IntPtr]$Value, [bool]$Is32Bit)
    if ($Is32Bit) {
        [BitConverter]::GetBytes([uint32]$Value.ToInt64()).CopyTo($Buffer, $Offset)
    } else {
        [BitConverter]::GetBytes([int64]$Value.ToInt64()).CopyTo($Buffer, $Offset)
    }
}

function Get-ListViewText {
    param(
        [IntPtr]$ListView,
        [int]$ItemIndex,
        [int]$SubItemIndex,
        [hashtable]$Remote
    )
    $structureSize = if ($Remote.Is32Bit) { 60 } else { 88 }
    $textOffset = 512
    $textAddress = [IntPtr]::new($Remote.Memory.ToInt64() + $textOffset)
    $item = [byte[]]::new($structureSize)
    Set-UInt32 $item 0 1
    Set-Int32 $item 4 $ItemIndex
    Set-Int32 $item 8 $SubItemIndex
    if ($Remote.Is32Bit) {
        Set-Pointer $item 20 $textAddress $true
        Set-Int32 $item 24 512
    } else {
        Set-Pointer $item 24 $textAddress $false
        Set-Int32 $item 32 512
    }
    Write-RemoteBytes $Remote $Remote.Memory $item
    Write-RemoteBytes $Remote $textAddress ([byte[]]::new(1024))
    [void][TdxContributionNative]::SendMessage($ListView, $LVM_GETITEMTEXTW, [IntPtr]$ItemIndex, $Remote.Memory)
    $bytes = Read-RemoteBytes $Remote $textAddress 1024
    $text = [System.Text.Encoding]::Unicode.GetString($bytes)
    $nullIndex = $text.IndexOf([char]0)
    if ($nullIndex -ge 0) { $text = $text.Substring(0, $nullIndex) }
    return $text.Trim()
}

function Select-Tab {
    param(
        [IntPtr]$TabControl,
        [int]$TabIndex,
        [hashtable]$Remote
    )
    Write-RemoteBytes $Remote $Remote.Memory ([byte[]]::new(16))
    $ok = [TdxContributionNative]::SendMessage($TabControl, $TCM_GETITEMRECT, [IntPtr]$TabIndex, $Remote.Memory).ToInt64()
    if ($ok -eq 0) { throw "无法定位通达信贡献度标签 $TabIndex" }
    $rectBytes = Read-RemoteBytes $Remote $Remote.Memory 16
    $left = [BitConverter]::ToInt32($rectBytes, 0)
    $top = [BitConverter]::ToInt32($rectBytes, 4)
    $right = [BitConverter]::ToInt32($rectBytes, 8)
    $bottom = [BitConverter]::ToInt32($rectBytes, 12)
    $x = [Math]::Max(1, [int](($left + $right) / 2))
    $y = [Math]::Max(1, [int](($top + $bottom) / 2))
    $lParam = [IntPtr](($y -shl 16) -bor ($x -band 0xFFFF))
    [void][TdxContributionNative]::SendMessage($TabControl, $WM_LBUTTONDOWN, [IntPtr]$MK_LBUTTON, $lParam)
    [void][TdxContributionNative]::SendMessage($TabControl, $WM_LBUTTONUP, [IntPtr]::Zero, $lParam)
}

function Wait-ListReady {
    param(
        [IntPtr]$ListView,
        [hashtable]$Remote,
        [int]$TimeoutSeconds,
        [int]$MinimumCount,
        [int]$MaximumCount
    )
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $notBefore = (Get-Date).AddMilliseconds(1800)
    $lastObserved = "count=0"
    while ((Get-Date) -lt $deadline) {
        $count = [int][TdxContributionNative]::SendMessage($ListView, $LVM_GETITEMCOUNT, [IntPtr]::Zero, [IntPtr]::Zero).ToInt64()
        $lastObserved = "count=$count"
        if ($count -ge $MinimumCount -and $count -le $MaximumCount) {
            $first = Get-ListViewText $ListView 0 0 $Remote
            $points = Get-ListViewText $ListView 0 2 $Remote
            $signature = "$count|$first"
            $lastObserved = "count=$count, first=$first, points=$points"
            if ($first -match '^\d{6}$' -and -not [string]::IsNullOrWhiteSpace($points)) {
                if ((Get-Date) -ge $notBefore) {
                    return [ordered]@{ Count = $count; Signature = $signature }
                }
            }
        }
        Start-Sleep -Milliseconds 500
    }
    throw "通达信贡献度列表在 $TimeoutSeconds 秒内未完成加载（$lastObserved，预期数量 $MinimumCount-$MaximumCount）"
}

function Convert-Number {
    param([string]$Text)
    $clean = ($Text -replace '[,%]', '').Trim()
    if ($clean -in @("", "--", "-")) { return $null }
    $value = 0.0
    $styles = [Globalization.NumberStyles]::Float -bor [Globalization.NumberStyles]::AllowThousands
    if ([double]::TryParse($clean, $styles, [Globalization.CultureInfo]::InvariantCulture, [ref]$value)) {
        return $value
    }
    return $null
}

function Read-ContributionRow {
    param(
        [IntPtr]$ListView,
        [int]$ItemIndex,
        [hashtable]$Remote
    )
    $cells = for ($column = 0; $column -lt 9; $column++) {
        Get-ListViewText $ListView $ItemIndex $column $Remote
    }
    if ($cells[0] -notmatch '^\d{6}$') { return $null }
    $points = Convert-Number $cells[2]
    if ($null -eq $points) { return $null }
    return [ordered]@{
        code = $cells[0]
        name = $cells[1]
        points = [Math]::Round($points, 4)
        changePct = Convert-Number $cells[3]
        volumeRatio = Convert-Number $cells[4]
        preClose = Convert-Number $cells[5]
        calculationSharesWan = Convert-Number $cells[6]
        weightPct = Convert-Number $cells[7]
        rank = Convert-Number $cells[8]
    }
}

function Read-ContributionRanking {
    param(
        [IntPtr]$ListView,
        [int]$ItemCount,
        [hashtable]$Remote
    )
    $indices = New-Object System.Collections.Generic.List[int]
    $edgeCount = [Math]::Min(40, $ItemCount)
    for ($i = 0; $i -lt $edgeCount; $i++) { $indices.Add($i) }
    for ($i = [Math]::Max(0, $ItemCount - $edgeCount); $i -lt $ItemCount; $i++) {
        if (-not $indices.Contains($i)) { $indices.Add($i) }
    }
    $rows = foreach ($itemIndex in $indices) {
        Read-ContributionRow $ListView $itemIndex $Remote
    }
    $positive = @($rows | Where-Object { $null -ne $_ -and $_.points -gt 0 } | Sort-Object { [double]$_['points'] } -Descending | Select-Object -First 10)
    $negative = @($rows | Where-Object { $null -ne $_ -and $_.points -lt 0 } | Sort-Object { [double]$_['points'] } | Select-Object -First 10)
    return [ordered]@{
        positive = $positive
        negative = $negative
        constituentCount = $ItemCount
    }
}

$tdx = Get-Process -Name "TdxW" -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $tdx) {
    Fail-Unavailable "通达信未运行，无法读取原生指数贡献度。"
}

$mainWindow = [IntPtr]$tdx.MainWindowHandle
$mainTitle = Get-WindowText $mainWindow
$allTitles = @([TdxContributionNative]::TopWindowsForProcess([uint32]$tdx.Id) | ForEach-Object { Get-WindowText $_ })
if (($allTitles -join "|") -match '登录|验证码|用户验证|选择帐号|选择账号') {
    Fail-Unavailable "通达信尚未完成登录，未读取指数贡献度。"
}
if ($mainTitle -notmatch '通达信') {
    Fail-Unavailable "当前通达信窗口尚未进入行情界面。"
}

$dialog = Get-TopWindow -ProcessId ([uint32]$tdx.Id) -TitlePattern '^贡献度排名'
$createdByScript = $false
if ($dialog -ne [IntPtr]::Zero -and [TdxContributionNative]::IsWindowVisible($dialog)) {
    Fail-Unavailable "通达信贡献度排名窗口正在由用户使用，本次后台读取已跳过。"
}

$remote = $null
try {
    if ($dialog -eq [IntPtr]::Zero) {
        $processId = [uint32]0
        $threadId = [TdxContributionNative]::GetWindowThreadProcessId($mainWindow, [ref]$processId)
        Send-TdxShortcut -MainWindow $mainWindow -ThreadId $threadId
        $deadline = (Get-Date).AddSeconds($DialogTimeoutSeconds)
        while ((Get-Date) -lt $deadline) {
            $dialog = Get-TopWindow -ProcessId ([uint32]$tdx.Id) -TitlePattern '^贡献度排名'
            if ($dialog -ne [IntPtr]::Zero) {
                [void][TdxContributionNative]::ShowWindow($dialog, 0)
                $createdByScript = $true
                break
            }
            Start-Sleep -Milliseconds 20
        }
    }
    if ($dialog -eq [IntPtr]::Zero) {
        Fail-Unavailable "未能打开通达信 .929 贡献度排名，请确认客户端处于行情界面。"
    }
    [void][TdxContributionNative]::ShowWindow($dialog, 0)

    $tabControl = Find-MainTabControl $dialog
    $listView = Find-ChildByClass $dialog "SysListView32"
    if ($tabControl -eq [IntPtr]::Zero -or $listView -eq [IntPtr]::Zero) {
        throw "通达信贡献度排名控件结构与预期不一致"
    }

    $remote = Open-RemoteBuffer ([uint32]$tdx.Id)
    $definitions = @(
        [ordered]@{ Code = "000001"; Name = "上证指数"; Tab = 0; MinimumCount = 1000; MaximumCount = 5000 },
        [ordered]@{ Code = "399001"; Name = "深证成指"; Tab = 1; MinimumCount = 400; MaximumCount = 650 },
        [ordered]@{ Code = "000300"; Name = "沪深300"; Tab = 3; MinimumCount = 250; MaximumCount = 350 },
        [ordered]@{ Code = "399006"; Name = "创业板指"; Tab = 4; MinimumCount = 80; MaximumCount = 150 },
        [ordered]@{ Code = "000688"; Name = "科创50"; Tab = 5; MinimumCount = 40; MaximumCount = 70 },
        [ordered]@{ Code = "000905"; Name = "中证500"; Tab = 7; MinimumCount = 450; MaximumCount = 550 },
        [ordered]@{ Code = "899050"; Name = "北证50"; Tab = 9; MinimumCount = 40; MaximumCount = 70 }
    )
    $indices = [ordered]@{}
    foreach ($definition in $definitions) {
        $tabControl = Find-MainTabControl $dialog
        $listView = Find-ChildByClass $dialog "SysListView32"
        if ($tabControl -eq [IntPtr]::Zero -or $listView -eq [IntPtr]::Zero) {
            throw "通达信贡献度排名控件在切换指数时失效"
        }
        Select-Tab $tabControl $definition.Tab $remote
        Start-Sleep -Milliseconds 250
        $listView = Find-ChildByClass $dialog "SysListView32"
        if ($listView -eq [IntPtr]::Zero) {
            throw "通达信贡献度列表在切换指数后失效"
        }
        $ready = Wait-ListReady $listView $remote $DataTimeoutSeconds $definition.MinimumCount $definition.MaximumCount
        $ranking = Read-ContributionRanking $listView $ready.Count $remote
        $indices[$definition.Code] = [ordered]@{
            code = $definition.Code
            name = $definition.Name
            positive = $ranking.positive
            negative = $ranking.negative
            constituentCount = $ranking.constituentCount
        }
    }

    $payload = New-StatusPayload -Status "ok" -Message "已读取通达信 .929 原生贡献点数。" -Indices $indices
    Write-Payload $payload
    Write-Output ($payload | ConvertTo-Json -Compress -Depth 10)
} catch {
    $payload = New-StatusPayload -Status "error" -Message $_.Exception.Message
    Write-Payload $payload
    Write-Error $_.Exception.Message
    exit 1
} finally {
    Close-RemoteBuffer $remote
    if ($createdByScript -and $dialog -ne [IntPtr]::Zero -and [TdxContributionNative]::IsWindow($dialog)) {
        Close-ContributionDialog $dialog
    }
}
