#Requires -Version 7.0
param([string]$Out = 'C:\Users\root\_Projects\bunframe\build\window.png')
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms, System.Drawing

# 必须先声明 DPI 感知：否则 Screen.Bounds 返回逻辑尺寸（1536x960），
# CopyFromScreen 会按逻辑矩形去截物理屏幕，只拿到左上角四分之一。
Add-Type -Namespace Cap -Name D -MemberDefinition @'
[DllImport("user32.dll")]
public static extern bool SetProcessDPIAware();
'@
[void][Cap.D]::SetProcessDPIAware()

$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose()
$bmp.Dispose()

Write-Host "saved $Out ($($b.Width)x$($b.Height))"
