#Requires -Version 7.0
# 从 exe 的 PE 资源里提取图标，证明 --windows-icon 真的生效
param([string]$Exe, [string]$Out)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

Add-Type -Namespace ShellExtract -Name IconApi -MemberDefinition @'
[DllImport("shell32.dll", CharSet = CharSet.Unicode)]
public static extern uint ExtractIconExW(string szFile, int nIconIndex, IntPtr[] phiconLarge, IntPtr[] phiconSmall, uint nIcons);

[DllImport("user32.dll")]
public static extern bool DestroyIcon(IntPtr hIcon);
'@

$large = New-Object IntPtr[] 1
$small = New-Object IntPtr[] 1
$count = [ShellExtract.IconApi]::ExtractIconExW($Exe, 0, $large, $small, 1)
Write-Host "icons extracted: $count"

if ($count -lt 1 -or $large[0] -eq [IntPtr]::Zero) {
    Write-Host 'NO ICON FOUND'
    exit 2
}

$ico = [System.Drawing.Icon]::FromHandle($large[0])
Write-Host ("icon: {0}x{1}" -f $ico.Width, $ico.Height)

$bmp = $ico.ToBitmap()
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
$ico.Dispose()
[void][ShellExtract.IconApi]::DestroyIcon($large[0])
if ($small[0] -ne [IntPtr]::Zero) { [void][ShellExtract.IconApi]::DestroyIcon($small[0]) }

Write-Host "saved: $Out"
