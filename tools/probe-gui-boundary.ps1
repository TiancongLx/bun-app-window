#Requires -Version 7.0
# 探测 GUI 相关 API 在当前会话中的可用性
# 用于对比 Session 0（服务会话）与 Session 1（交互式会话）的能力边界
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

Add-Type -Namespace GuiProbe -Name Api -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll")] public static extern IntPtr OpenWindowStationW(string name, bool inherit, uint access);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();
'@

[void][GuiProbe.Api]::SetProcessDPIAware()

function Line($k, $v) { Write-Host ("{0,-32} {1}" -f $k, $v) }

$sid = (Get-Process -Id $PID).SessionId
Write-Host "=== 当前会话 ID: $sid ==="
Write-Host ''

# ---- 1. 顶层窗口枚举 ----
$wins = New-Object System.Collections.ArrayList
$cb = [GuiProbe.Api+EnumProc]{
    param($h, $l)
    if ([GuiProbe.Api]::IsWindowVisible($h)) {
        $p = 0
        [void][GuiProbe.Api]::GetWindowThreadProcessId($h, [ref]$p)
        $c = New-Object System.Text.StringBuilder 256
        [void][GuiProbe.Api]::GetClassNameW($h, $c, 256)
        [void]$script:wins.Add("$($c.ToString()) pid=$p")
    }
    return $true
}
[void][GuiProbe.Api]::EnumWindows($cb, [IntPtr]::Zero)

Write-Host '--- 1. EnumWindows（可见顶层窗口）---'
Line 'count' $wins.Count
$wins | Select-Object -First 8 | ForEach-Object { Write-Host "    $_" }
Write-Host ''

# ---- 2. 前台窗口 ----
Write-Host '--- 2. GetForegroundWindow ---'
$fg = [GuiProbe.Api]::GetForegroundWindow()
Line 'hwnd' ("0x{0:X}" -f $fg.ToInt64())
if ($fg -ne [IntPtr]::Zero) {
    $p = 0
    [void][GuiProbe.Api]::GetWindowThreadProcessId($fg, [ref]$p)
    Line 'pid' $p
} else {
    Line 'note' 'no foreground window in this session'
}
Write-Host ''

# ---- 3. 输入桌面 ----
Write-Host '--- 3. OpenInputDesktop（能否访问交互式输入桌面）---'
$desk = [GuiProbe.Api]::OpenInputDesktop(0, $false, 0x0100)  # DESKTOP_READOBJECTS
$err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
Line 'handle' ("0x{0:X}" -f $desk.ToInt64())
Line 'lastError' $err
if ($desk -ne [IntPtr]::Zero) { Line 'result' 'AVAILABLE'; [void][System.Runtime.InteropServices.Win32]::CloseHandle($desk) }
else { Line 'result' 'UNAVAILABLE (session has no interactive input desktop)' }
Write-Host ''

# ---- 4. 窗口站 ----
Write-Host '--- 4. OpenWindowStation("WinSta0") ---'
$ws = [GuiProbe.Api]::OpenWindowStationW('WinSta0', $false, 0x0001)
Line 'handle' ("0x{0:X}" -f $ws.ToInt64())
Line 'lastError' ([System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
Line 'result' $(if ($ws -ne [IntPtr]::Zero) { 'accessible' } else { 'denied / not visible from this session' })
Write-Host ''

# ---- 5. 屏幕捕获 ----
Write-Host '--- 5. CopyFromScreen（屏幕捕获）---'
try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    Line 'screen bounds' "$($b.Width)x$($b.Height) at $($b.X),$($b.Y)"
    $bmp = New-Object System.Drawing.Bitmap ([Math]::Max(1,$b.Width)), ([Math]::Max(1,$b.Height))
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $g.Dispose()
    # 采样判断是否有内容
    $nonBlack = 0; $total = 0
    $stepX = [Math]::Max(1, [int]($b.Width / 40)); $stepY = [Math]::Max(1, [int]($b.Height / 30))
    for ($y = 0; $y -lt $b.Height; $y += $stepY) {
        for ($x = 0; $x -lt $b.Width; $x += $stepX) {
            $px = $bmp.GetPixel($x, $y); $total++
            if ($px.R -gt 20 -or $px.G -gt 20 -or $px.B -gt 20) { $nonBlack++ }
        }
    }
    $pct = if ($total) { [math]::Round(100.0 * $nonBlack / $total, 1) } else { 0 }
    Line 'nonBlackPercent' "$pct%"
    Line 'verdict' $(if ($pct -gt 1) { 'captured something' } else { 'BLANK (black frame)' })
    $bmp.Dispose()
} catch {
    Line 'ERROR' $_.Exception.Message
}
Write-Host ''

# ---- 6. UI Automation ----
Write-Host '--- 6. UI Automation（跨会话可达性）---'
try {
    $uia = New-Object -ComObject 'UIAutomationClient.CUIAutomation'
    $root = $uia.GetRootElement()
    Line 'root element' $(if ($root) { $root.CurrentName + ' / ' + $root.CurrentClassName } else { 'null' })
    $cond = $uia.CreateTrueCondition()
    $children = $root.FindAll(4, $cond)   # TreeScope_Children = 4
    Line 'top-level children' $children.Length
    $named = 0
    for ($i = 0; $i -lt [Math]::Min($children.Length, 10); $i++) {
        $c = $children.GetElement($i)
        if ($c.CurrentName) { $named++ ; Write-Host ("    - {0} ({1})" -f $c.CurrentName, $c.CurrentClassName) }
    }
    Line 'named children (of first 10)' $named
} catch {
    Line 'ERROR' $_.Exception.Message
}
Write-Host ''

# ---- 7. WTS 会话信息 ----
Write-Host '--- 7. WTS 会话信息 ---'
Line 'active console session' ([GuiProbe.Api]::WTSGetActiveConsoleSessionId())
Line 'self session' $sid
