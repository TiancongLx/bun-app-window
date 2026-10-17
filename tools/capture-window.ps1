#Requires -Version 7.0
<#
.SYNOPSIS
  在交互式会话内截取目标窗口内容（不干扰用户当前会话）。

.DESCRIPTION
  实测结论：PrintWindow + PW_RENDERFULLCONTENT(2) 能完整捕获 WebView2 渲染内容，
  即使窗口被其它窗口完全遮挡（对比：不带 flag 只得到 5.8% 非黑像素）。
  因此不再需要「最小化遮挡窗口」——那会打断用户正在使用的远程会话。

  窗口尺寸按物理像素读取（进程需 DPI 感知），输出与窗口客户区等大的图。

.PARAMETER Pid
  目标进程 ID；与 -Class 二选一或同时给。

.PARAMETER Class
  目标窗口类名，例如 webview_shell。

.PARAMETER Shot
  截图输出路径；省略则只做定位与状态检查。

.PARAMETER Fallback
  当 PrintWindow 结果为空（非黑像素占比过低）时，退回全屏 CopyFromScreen。

.PARAMETER MinNonBlackPercent
  判定 PrintWindow 是否成功的阈值（默认 1%）。
#>
param(
    [int]$TargetPid = 0,
    [string]$Class = '',
    [string]$Shot = '',
    [switch]$Fallback,
    [double]$MinNonBlackPercent = 1.0,
    [int]$WaitMs = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -Namespace Shot -Name Api -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

# 必须 DPI 感知：否则 GetWindowRect 返回逻辑像素，位图尺寸与内容错配
[void][Shot.Api]::SetProcessDPIAware()

$PW_RENDERFULLCONTENT = 2

function Get-TopLevelWindows {
    $list = New-Object System.Collections.ArrayList
    $cb = [Shot.Api+EnumProc]{
        param($h, $l)
        $p = 0
        [void][Shot.Api]::GetWindowThreadProcessId($h, [ref]$p)
        $c = New-Object System.Text.StringBuilder 512
        $t = New-Object System.Text.StringBuilder 512
        [void][Shot.Api]::GetClassNameW($h, $c, 512)
        [void][Shot.Api]::GetWindowTextW($h, $t, 512)
        $r = New-Object Shot.Api+RECT
        [void][Shot.Api]::GetWindowRect($h, [ref]$r)
        [void]$list.Add([pscustomobject]@{
            Handle  = $h
            Class   = $c.ToString()
            Title   = $t.ToString()
            Pid     = $p
            Visible = [Shot.Api]::IsWindowVisible($h)
            Iconic  = [Shot.Api]::IsIconic($h)
            Left = $r.Left; Top = $r.Top
            Width = ($r.Right - $r.Left); Height = ($r.Bottom - $r.Top)
        })
        return $true
    }
    [void][Shot.Api]::EnumWindows($cb, [IntPtr]::Zero)
    return $list
}

# ---------- 定位目标窗口 ----------

$deadline = (Get-Date).AddMilliseconds(6000 + $WaitMs)
$target = $null
while ((Get-Date) -lt $deadline) {
    $wins = Get-TopLevelWindows
    $target = $wins | Where-Object {
        $_.Visible -and
        $_.Width -gt 0 -and $_.Height -gt 0 -and
        ((-not $TargetPid) -or $_.Pid -eq $TargetPid) -and
        ((-not $Class) -or $_.Class -eq $Class)
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

$result = [ordered]@{
    ok     = $true
    target = @{
        class = $target.Class
        title = $target.Title
        pid   = $target.Pid
        rect  = "$($target.Left),$($target.Top) $($target.Width)x$($target.Height)"
    }
    method = $null
    shot   = $null
}

# ---------- 截图 ----------

if ($Shot) {
    $dir = Split-Path -Parent $Shot
    if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    Add-Type -AssemblyName System.Drawing

    $w = $target.Width
    $h = $target.Height

    # A) PrintWindow：不干扰用户会话，可捕获被遮挡的 WebView2 内容
    $bmp = New-Object System.Drawing.Bitmap $w, $h
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $hdc = $g.GetHdc()
    $okPw = [Shot.Api]::PrintWindow($target.Handle, $hdc, $PW_RENDERFULLCONTENT)
    $g.ReleaseHdc($hdc)
    $g.Dispose()

    # 采样判定是否真的画出了内容
    $nonBlack = 0; $total = 0
    $stepX = [Math]::Max(1, [int]($w / 60))
    $stepY = [Math]::Max(1, [int]($h / 40))
    for ($y = 0; $y -lt $h; $y += $stepY) {
        for ($x = 0; $x -lt $w; $x += $stepX) {
            $px = $bmp.GetPixel($x, $y)
            $total++
            if ($px.R -gt 20 -or $px.G -gt 20 -or $px.B -gt 20) { $nonBlack++ }
        }
    }
    $pct = if ($total) { 100.0 * $nonBlack / $total } else { 0 }
    $usedMethod = 'printwindow'

    if ($okPw -and $pct -ge $MinNonBlackPercent) {
        $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
    } else {
        $bmp.Dispose()
        if (-not $Fallback) {
            $result.ok = $false
            $result.error = "PrintWindow produced no content (nonBlack=$([math]::Round($pct,1))%, ok=$okPw); pass -Fallback to capture the full screen instead"
            $result | ConvertTo-Json -Depth 4
            exit 4
        }
        $bmp = $null

        # B) 退回全屏截图（会包含桌面，但能保证有内容）
        Add-Type -AssemblyName System.Windows.Forms
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g2 = [System.Drawing.Graphics]::FromImage($bmp)
        $g2.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $g2.Dispose()
        $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
        $w = $b.Width; $h = $b.Height
        $usedMethod = 'copyfromscreen'
    }

    $result.method = $usedMethod
    $result.shot = @{ path = $Shot; width = $w; height = $h; nonBlackPercent = [math]::Round($pct, 1) }
    $bmp.Dispose()
}

$result | ConvertTo-Json -Depth 4
