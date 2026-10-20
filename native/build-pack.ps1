#Requires -Version 7.0
# 打包单文件 exe：DLL 与 UI 通过 type:"file" 嵌入，运行时解析到 B:\~BUN\root
param(
    [string]$Root = (Join-Path $PSScriptRoot '..'),
    [switch]$KeepConsole
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$dist = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$out = Join-Path $dist 'bun-app-window.exe'

$common = @(
    'build', '--compile', '--minify',
    '--windows-title', 'WebView Shell',
    '--windows-description', 'Native shell for Bun + WebView2',
    '--windows-publisher', 'bun-app-window',
    '--windows-version', '0.2.0.0'
)
$iconPath = Join-Path $Root 'assets\app.ico'
if (Test-Path $iconPath) {
    $common += '--windows-icon', $iconPath
} else {
    Write-Warning "icon not found: $iconPath (run make-icon.ps1 first)"
}
if (-not $KeepConsole) { $common += '--windows-hide-console' }

$args = $common + @((Join-Path $Root 'src\host.ts'), '--outfile', $out)

Push-Location $Root
try {
    Write-Host ('bun ' + ($args -join ' '))
    & bun.exe @args
    if ($LASTEXITCODE -ne 0) { throw "bun build failed: $LASTEXITCODE" }
} finally {
    Pop-Location
}

$f = Get-Item $out
Write-Host ''
Write-Host ('built: {0}' -f $f.FullName)
Write-Host ('size : {0:N0} bytes ({1:N1} MiB)' -f $f.Length, ($f.Length / 1MB))
Write-Host ''
Write-Host '=== PE subsystem ==='
# 2 = GUI (no console), 3 = console
& llvm-objdump.exe -p $out 2>&1 | Select-String 'Subsystem'
Write-Host ''
Write-Host '=== embedded assets (DLL / HTML) ==='
& rg.exe -a -o 'libshell-[a-z0-9]{8}\.dll|index-[a-z0-9]{8}\.html' $out 2>&1 | Select-Object -First 4

Write-Host ''
Write-Host '=== PE resources (icon / version) ==='
$sig = Get-AuthenticodeSignature $out
Write-Host ("signature: {0}" -f $sig.Status)
