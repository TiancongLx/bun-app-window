#Requires -Version 7.0
param(
    [string]$Root = (Join-Path $PSScriptRoot '..'),
    [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$wv = Join-Path $Root 'vendor\webview'
$sdk = Join-Path $Root 'vendor\webview2'
$out = Join-Path $Root 'build'
New-Item -ItemType Directory -Force -Path $out | Out-Null

if ($Clean -and (Test-Path $out)) {
    Get-ChildItem -File $out | Remove-Item -Force
}

foreach ($p in @(
    (Join-Path $wv 'core\include\webview\webview.h'),
    (Join-Path $wv 'compatibility\mingw\include\EventToken.h'),
    (Join-Path $sdk 'build\native\include\WebView2.h')
)) {
    if (-not (Test-Path $p)) { throw "missing prerequisite: $p" }
}

$includes = @(
    (Join-Path $wv 'core\include'),
    (Join-Path $wv 'compatibility\mingw\include'),
    (Join-Path $sdk 'build\native\include')
) | ForEach-Object { "-I$_" }

$libs = @('advapi32', 'ole32', 'oleaut32', 'uuid', 'shell32', 'shlwapi', 'user32', 'version', 'dwmapi') |
    ForEach-Object { "-l$_" }

$args = @(
    '-std=c++17', '-O2', '-shared',
    '-static-libgcc', '-static-libstdc++',
    '-DWEBVIEW_STATIC', '-DUNICODE', '-D_UNICODE',
    '-Wall', '-Wextra',
    '-Wno-unknown-pragmas', '-Wno-unused-parameter'
) + $includes + @(
    (Join-Path $PSScriptRoot 'shell.cc'),
    '-o', (Join-Path $out 'libshell.dll')
) + $libs

Write-Host ('clang++ ' + ($args -join ' '))
Write-Host ''
& clang++.exe @args
if ($LASTEXITCODE -ne 0) { throw "clang++ failed: $LASTEXITCODE" }

$dll = Join-Path $out 'libshell.dll'

# 同时产出一份到 dist/：包分发从这里取（package.json 的 files 与 embedded 入口都指向 dist）
$distDir = Join-Path $Root 'dist'
New-Item -ItemType Directory -Force -Path $distDir | Out-Null
Copy-Item $dll (Join-Path $distDir 'libshell.dll') -Force

Write-Host ''
Write-Host ('built: {0} ({1:N0} bytes)' -f $dll, (Get-Item $dll).Length)
Write-Host ('staged: {0}' -f (Join-Path $distDir 'libshell.dll'))
Write-Host ''
Write-Host '=== exported symbols ==='
& llvm-nm.exe --defined-only --extern-only --demangle $dll 2>&1 | Select-String 'shell_'
Write-Host ''
Write-Host '=== runtime deps ==='
& llvm-objdump.exe -p $dll 2>&1 | Select-String 'DLL Name'
