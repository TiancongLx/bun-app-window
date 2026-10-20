#Requires -Version 7.0
param([string]$Out = 'C:\Users\root\_Projects\bunframe\build\win.png')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -Namespace Cap -Name W -MemberDefinition @'
[DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
public static extern IntPtr FindWindowW(string lpClassName, string lpWindowName);

[DllImport("user32.dll")]
public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

[DllImport("user32.dll")]
public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

[DllImport("user32.dll")]
public static extern IntPtr GetForegroundWindow();

[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }
'@

[void][Cap.W]::SetProcessDPIAware()

$screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
Write-Host "screen=$($screen.Width)x$($screen.Height)"

$hwnd = [Cap.W]::FindWindowW('webview_shell', $null)
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host 'window NOT found by class'
} else {
    $r = New-Object Cap.W+RECT
    [void][Cap.W]::GetWindowRect($hwnd, [ref]$r)
    Write-Host ("window rect: {0},{1} {2}x{3} (hwnd={4})" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top), $hwnd)

    $w = $r.Right - $r.Left
    $h = $r.Bottom - $r.Top
    if ($w -gt 0 -and $h -gt 0) {
        $bmp = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $hdc = $g.GetHdc()
        $ok = [Cap.W]::PrintWindow($hwnd, $hdc, 2)
        $g.ReleaseHdc($hdc)
        $g.Dispose()
        $bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
        $bmp.Dispose()
        Write-Host "printwindow=$ok saved=$Out"
    }
}

$fg = [Cap.W]::GetForegroundWindow()
$rf = New-Object Cap.W+RECT
[void][Cap.W]::GetWindowRect($fg, [ref]$rf)
Write-Host ("foreground hwnd={0} rect={1},{2}" -f $fg, $rf.Left, $rf.Top)
