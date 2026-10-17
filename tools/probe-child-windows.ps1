#Requires -Version 7.0
# 枚举目标进程的顶层窗口与子窗口（含 WebView2 widget）的实际矩形
param([Parameter(Mandatory)][int]$TargetPid)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -Namespace CW -Name Api -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr parent, EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
'@

[void][CW.Api]::SetProcessDPIAware()

function Describe([IntPtr]$h, [string]$indent) {
    $c = New-Object System.Text.StringBuilder 256
    $t = New-Object System.Text.StringBuilder 256
    [void][CW.Api]::GetClassNameW($h, $c, 256)
    [void][CW.Api]::GetWindowTextW($h, $t, 256)
    $wr = New-Object CW.Api+RECT
    $cr = New-Object CW.Api+RECT
    [void][CW.Api]::GetWindowRect($h, [ref]$wr)
    [void][CW.Api]::GetClientRect($h, [ref]$cr)
    $vis = [CW.Api]::IsWindowVisible($h)
    Write-Host ("{0}{1,-30} visible={2,-5} win={3}x{4} client={5}x{6}" -f `
        $indent, $c.ToString(), $vis,
        ($wr.Right - $wr.Left), ($wr.Bottom - $wr.Top),
        ($cr.Right - $cr.Left), ($cr.Bottom - $cr.Top))
    if ($t.Length -gt 0) { Write-Host ("{0}  title: {1}" -f $indent, $t.ToString()) }
}

$tops = New-Object System.Collections.ArrayList
$cb = [CW.Api+EnumProc]{
    param($h, $l)
    $p = 0
    [void][CW.Api]::GetWindowThreadProcessId($h, [ref]$p)
    if ($p -eq $TargetPid) { [void]$tops.Add($h) }
    return $true
}
[void][CW.Api]::EnumWindows($cb, [IntPtr]::Zero)

Write-Host "pid=$TargetPid  top-level windows: $($tops.Count)"
foreach ($h in $tops) {
    Describe $h ''
    $script:kids = New-Object System.Collections.ArrayList
    $cbk = [CW.Api+EnumProc]{
        param($ch, $l)
        [void]$script:kids.Add($ch)
        return $true
    }
    [void][CW.Api]::EnumChildWindows($h, $cbk, [IntPtr]::Zero)
    Write-Host ("  child windows: {0}" -f $kids.Count)
    foreach ($k in $kids) { Describe $k '    ' }
}
