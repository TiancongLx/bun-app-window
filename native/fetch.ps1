#Requires -Version 7.0
param(
    [string]$Root = (Join-Path $PSScriptRoot '..'),
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$vendor = Join-Path $Root 'vendor'
$wvDir = Join-Path $vendor 'webview'
$nugetDir = Join-Path $vendor 'webview2'
New-Item -ItemType Directory -Force -Path $vendor | Out-Null

# 1) webview/webview 源码
if (-not (Test-Path (Join-Path $wvDir '.git'))) {
    Write-Host '[1/3] clone webview/webview ...'
    & git.exe clone --depth 1 https://github.com/webview/webview.git $wvDir 2>&1 | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "git clone failed: $LASTEXITCODE" }
} else {
    Write-Host '[1/3] webview 已存在，跳过'
}

# 2) WebView2 SDK (NuGet 包就是 zip)
$pkg = Join-Path $vendor 'Microsoft.Web.WebView2.1.0.1150.38.nupkg'
if (-not (Test-Path $pkg) -or $Force) {
    Write-Host '[2/3] download WebView2 SDK ...'
    & aria2c.exe --console-log-level=warn --summary-interval=0 --max-tries=3 `
        -d $vendor -o (Split-Path $pkg -Leaf) `
        'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.1150.38'
    if ($LASTEXITCODE -ne 0) { throw "aria2c failed: $LASTEXITCODE" }
} else {
    Write-Host '[2/3] WebView2 包已存在，跳过'
}

# 3) 解压
$sdkProbe = Join-Path $nugetDir 'build\native\include\WebView2.h'
if (-not (Test-Path $sdkProbe) -or $Force) {
    Write-Host '[3/3] extract ...'
    if (Test-Path $nugetDir) { Remove-Item -Recurse -Force $nugetDir }
    & 7z.exe x $pkg "-o$nugetDir" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z failed: $LASTEXITCODE" }
} else {
    Write-Host '[3/3] 已解压，跳过'
}

# 报告
Write-Host ''
Write-Host '=== webview HEAD ==='
& git.exe -C $wvDir log -1 --format='%H %ad %s' --date=short
Write-Host ''
Write-Host '=== compat mingw ==='
Get-ChildItem -Recurse -File (Join-Path $wvDir 'compatibility\mingw\include') |
    ForEach-Object { $_.FullName.Substring($wvDir.Length + 1) }
Write-Host ''
Write-Host '=== WebView2 headers ==='
Get-ChildItem -File (Join-Path $nugetDir 'build\native\include') |
    ForEach-Object { '{0,-34} {1,10:N0}' -f $_.Name, $_.Length }
Write-Host ''
Write-Host '=== WebView2 loader (x64) ==='
Get-ChildItem -File (Join-Path $nugetDir 'build\native\x64') -ErrorAction SilentlyContinue |
    ForEach-Object { '{0,-34} {1,12:N0}' -f $_.Name, $_.Length }
Write-Host ''
Write-Host '=== webview 版本 ==='
Select-String -Path (Join-Path $wvDir 'core\include\webview\version.h') -Pattern 'WEBVIEW_VERSION_(MAJOR|MINOR|PATCH)' |
    ForEach-Object { $_.Line.Trim() }
