#Requires -Version 7.0
<#
.SYNOPSIS
  在交互式会话内让目标窗口可见并截图。

.DESCRIPTION
  本机实测 SetWindowPos(HWND_TOPMOST) 与 SetWindowLong(WS_EX_TOPMOST) 都返回成功
  但 z 序与 exstyle 完全不变（z 序被策略锁定），因此不依赖 topmost。

  注意：本脚本会最小化遮挡窗口，**会打断用户当前会话**（例如正在使用的远程 PWA）。
  仅在你本人就在这台机器前、需要肉眼确认视觉效果时使用。
  远程调试请用 capture-window.ps1：它走 PrintWindow(PW_RENDERFULLCONTENT)，
  能捕获被完全遮挡的 WebView2 内容，不需要移动任何窗口。

.PARAMETER TargetPid
  目标进程 ID；与 -Class 二选一或同时给。

.PARAMETER Class
  目标窗口类名（例如 webview_shell）。

.PARAMETER Shot
  截图输出路径；省略则只做聚焦。

.PARAMETER KeepOthers
  不最小化其它窗口，只做置前尝试。
#>
param(
    [int]$TargetPid = 0,
    [string]$Class = '',
    [string]$Shot = '',
    [switch]$KeepOthers,
    [int]$WaitMs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Focus -Name Api -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll", SetLastError = true)]
public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

[void][Focus.Api]::SetProcessDPIAware()

$SW_MINIMIZE = 6
$SW_SHOW = 5
$SW_RESTORE = 9
$SWP_NOSIZE = 0x1
$SWP_NOMOVE = 0x2
$SWP_NOACTIVATE = 0x10
$HWND_TOPMOST = [IntPtr](-1)

# 这些系统类不参与最小化
$systemClasses = @(
    'Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd',
    'IME', 'MSCTFIME UI', 'Windows.UI.Core.CoreWindow', 'ForegroundStaging'
)

function Get-TopLevelWindows {
    $list = New-Object System.Collections.ArrayList
    $cb = [Focus.Api+EnumProc]{
        param($h, $l)
        $p = 0
        [void][Focus.Api]::GetWindowThreadProcessId($h, [ref]$p)
        $c = New-Object System.Text.StringBuilder 512
        $t = New-Object System.Text.StringBuilder 512
        [void][Focus.Api]::GetClassNameW($h, $c, 512)
        [void][Focus.Api]::GetWindowTextW($h, $t, 512)
        $r = New-Object Focus.Api+RECT
        [void][Focus.Api]::GetWindowRect($h, [ref]$r)
        [void]$list.Add([pscustomobject]@{
            Handle  = $h
            Class   = $c.ToString()
            Title   = $t.ToString()
            Pid     = $p
            Visible = [Focus.Api]::IsWindowVisible($h)
            Iconic  = [Focus.Api]::IsIconic($h)
            Left = $r.Left; Top = $r.Top
            Width = ($r.Right - $r.Left); Height = ($r.Bottom - $r.Top)
        })
        return $true
    }
    [void][Focus.Api]::EnumWindows($cb, [IntPtr]::Zero)
    return $list
}

# ---------- 等目标窗口出现 ----------

$deadline = (Get-Date).AddMilliseconds(6000 + $WaitMs)
$target = $null
while ((Get-Date) -lt $deadline) {
    $wins = Get-TopLevelWindows | Where-Object { $_.Visible -and $_.Width -gt 0 -and $_.Height -gt 0 }
    $target = $wins | Where-Object {
        ((-not $TargetPid) -or $_.Pid -eq $TargetPid) -and ((-not $Class) -or $_.Class -eq $Class)
    } | Select-Object -First 1
    if ($target) { break }
    Start-Sleep -Milliseconds 250
}

if (-not $target) {
    $visible = (Get-TopLevelWindows | Where-Object { $_.Visible } |
        Select-Object -First 15 | ForEach-Object { "$($_.Class) pid=$($_.Pid)" }) -join '; '
    [pscustomobject]@{ ok = $false; error = 'target window not found'; visible = $visible } | ConvertTo-Json -Depth 3
    exit 2
}

# ---------- 处理遮挡 ----------

$minimized = New-Object System.Collections.ArrayList

if (-not $KeepOthers) {
    $t = $target
    $tRight = $t.Left + $t.Width
    $tBottom = $t.Top + $t.Height

    $allVisible = Get-TopLevelWindows | Where-Object { $_.Visible -and -not $_.Iconic }
    foreach ($w in $allVisible) {
        if ($w.Handle -eq $t.Handle) { continue }
        if ($w.Pid -eq $PID) { continue }
        if ($systemClasses -contains $w.Class) { continue }
        if ($w.Width -le 0 -or $w.Height -le 0) { continue }

        $wRight = $w.Left + $w.Width
        $wBottom = $w.Top + $w.Height
        $noOverlap = ($wRight -le $t.Left) -or ($w.Left -ge $tRight) -or ($wBottom -le $t.Top) -or ($w.Top -ge $tBottom)
        if ($noOverlap) { continue }

        [void][Focus.Api]::ShowWindow($w.Handle, $SW_MINIMIZE)
        [void]$minimized.Add("$($w.Class) pid=$($w.Pid)")
    }
}

# ---------- 置前 ----------

if ($target.Iconic) { [void][Focus.Api]::ShowWindow($target.Handle, $SW_RESTORE) }
[void][Focus.Api]::ShowWindow($target.Handle, $SW_SHOW)
# topmost 在本机不生效，仍尝试一次（换环境可能有效）
[void][Focus.Api]::SetWindowPos($target.Handle, $HWND_TOPMOST, 0, 0, 0, 0, ($SWP_NOSIZE -bor $SWP_NOMOVE -bor $SWP_NOACTIVATE))

Start-Sleep -Milliseconds 700

# ---------- 截图（全屏） ----------

$shotInfo = $null
if ($Shot) {
    $dir = Split-Path -Parent $Shot
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $g.Dispose()
    $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $shotInfo = @{ path = $Shot; width = $b.Width; height = $b.Height }
}

$fg = [Focus.Api]::GetForegroundWindow()

[pscustomobject]@{
    ok                 = $true
    target             = @{ class = $target.Class; title = $target.Title; pid = $target.Pid; rect = "$($target.Left),$($target.Top) $($target.Width)x$($target.Height)" }
    minimized          = @($minimized)
    foregroundIsTarget = ($fg -eq $target.Handle)
    shot               = $shotInfo
} | ConvertTo-Json -Depth 4
