#Requires -Version 7.0
<#
.SYNOPSIS
    补齐重建 libshell.dll 所需的三份输入。

.DESCRIPTION
    `vendor/` 在仓库里不是一整块，三份输入的来源各不相同：

        vendor/webview/core/include/webview/webview.h              入库，随 clone 到位
        vendor/webview/compatibility/mingw/include/EventToken.h    入库，随 clone 到位
        vendor/webview2/build/native/include/WebView2.h            未入库，由 nupkg 解压

    默认行为是「只补齐缺的」，且尽量离线：前两份通常已在 `vendor/webview` 里；
    第三份从同样已入库的 `vendor/Microsoft.Web.WebView2.<ver>.nupkg` 解压，不联网。
    clone 上游源码属于例外，必须显式加 `-Webview`——它会覆盖 `vendor/webview` 下
    145 个受版本控制的文件，`git diff` 会实实在在地变。

    旧版的判据是「`vendor/webview` 下有没有 `.git`」，而入库的拷贝没有 `.git`。
    于是每次运行都尝试 clone 到一个非空目录，`git` 返回 128，脚本在第 1 步就
    `throw`，第 3 步的解压永远不执行——新机器 clone 后重建原生层会卡死在这里。
    新版改为按 `build.ps1` 真正需要的文件判断，与它自己的三条前置校验逐条对应。

.PARAMETER Root
    仓库根目录。默认脚本所在目录的上一级。

.PARAMETER Webview
    重新 clone 上游 webview/webview 源码，覆盖 `vendor/webview`。需要联网。
    入库的文件会随之变化，`git diff` 可见——升级上游版本时这是预期行为。

.PARAMETER Sdk
    重新下载 WebView2 nupkg 并解压，覆盖 `vendor/webview2`。需要联网。

.PARAMETER Force
    等价于 `-Webview -Sdk`，保留旧版「三步全跑」的语义。

.EXAMPLE
    pwsh -File native/fetch.ps1
    只补齐缺的输入。缺 WebView2 头时从本地 nupkg 解压，全程不联网。

.EXAMPLE
    pwsh -File native/fetch.ps1 -Sdk
    重新下载并解压 SDK（怀疑 `vendor/webview2` 被改坏时）。

.EXAMPLE
    pwsh -File native/fetch.ps1 -Force
    连上游源码一起重拉。

.NOTES
    退出码：0 = 三份输入齐备；1 = 有输入缺失且未获授权补齐；2 = 环境问题。
#>
param(
    [string]$Root = (Join-Path $PSScriptRoot '..'),
    [switch]$Webview,
    [switch]$Sdk,
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($Force) {
    $Webview = $true
    $Sdk = $true
}

$vendor  = Join-Path $Root 'vendor'
$wvDir   = Join-Path $vendor 'webview'
$sdkDir  = Join-Path $vendor 'webview2'
$pkgName = 'Microsoft.Web.WebView2.1.0.1150.38.nupkg'
$pkg     = Join-Path $vendor $pkgName
$pkgUrl  = 'https://www.nuget.org/api/v2/package/Microsoft.Web.WebView2/1.0.1150.38'
$wvRepo  = 'https://github.com/webview/webview.git'

# 判据与 native/build.ps1 的前置校验一一对应：那里缺哪个就报哪个，这里补的就是哪个
$probeWebview = Join-Path $wvDir 'core\include\webview\webview.h'
$probeEvent   = Join-Path $wvDir 'compatibility\mingw\include\EventToken.h'
$probeSdk     = Join-Path $sdkDir 'build\native\include\WebView2.h'

function Write-Step([string]$Text) {
    Write-Host ''
    Write-Host "=== $Text ===" -ForegroundColor Cyan
}

function Assert-Tool([string]$Name, [string]$Hint) {
    if (Get-Command $Name -ErrorAction SilentlyContinue) {
        return
    }
    Write-Host ''
    Write-Host "missing tool: $Name" -ForegroundColor Red
    if ($Hint) { Write-Host "  $Hint" -ForegroundColor Red }
    exit 2
}

function Install-Webview {
    Write-Step 'clone webview/webview (需要联网)'
    Assert-Tool 'git.exe' 'webview 源码需由 git 拉取'

    New-Item -ItemType Directory -Force -Path $vendor | Out-Null
    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $staging = Join-Path ([System.IO.Path]::GetTempPath()) "baw-webview-$stamp"

    try {
        & git.exe clone --depth 1 $wvRepo $staging 2>&1 | Out-Host
        if ($LASTEXITCODE -ne 0) { throw "git clone failed: $LASTEXITCODE" }

        # 入库的 vendor/webview 是「无 .git 的纯文件拷贝」。留下 .git 会让父仓库多出
        # 一个嵌套仓库，git status 的语义随环境而变（与 .gitignore 第 4 行那条
        # 「不依赖用户环境的全局配置」同一个取向）。这里保留内容、剥掉仓库元信息。
        $nested = Join-Path $staging '.git'
        if (Test-Path $nested) { Remove-Item -Recurse -Force $nested }

        if (Test-Path $wvDir) { Remove-Item -Recurse -Force $wvDir }
        Move-Item $staging $wvDir
    } finally {
        if (Test-Path $staging) { Remove-Item -Recurse -Force $staging -ErrorAction SilentlyContinue }
    }
}

function Install-Sdk([bool]$Redownload) {
    Write-Step 'WebView2 SDK'

    if (-not (Test-Path $pkg) -or $Redownload) {
        Assert-Tool 'aria2c.exe' 'WebView2 nupkg 不在仓库里，需由 aria2c 下载'
        Write-Host "downloading $pkgName ..."
        & aria2c.exe --console-log-level=warn --summary-interval=0 --max-tries=3 `
            -d $vendor -o $pkgName $pkgUrl
        if ($LASTEXITCODE -ne 0) { throw "aria2c failed: $LASTEXITCODE" }
    } else {
        Write-Host "$pkgName 已在仓库内，跳过下载"
    }

    Assert-Tool '7z.exe' 'nupkg 是 zip 容器，需由 7z 解压'
    Write-Host 'extracting ...'
    if (Test-Path $sdkDir) { Remove-Item -Recurse -Force $sdkDir }
    & 7z.exe x $pkg "-o$sdkDir" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7z failed: $LASTEXITCODE" }
}

# ---- 1. 上游 webview 源码 ----------------------------------------------------

$wvOk = (Test-Path $probeWebview) -and (Test-Path $probeEvent)

if ($Webview) {
    Install-Webview
} elseif ($wvOk) {
    Write-Host '[1/2] webview 源码完整，跳过'
} elseif (-not (Test-Path $wvDir)) {
    # 目录整个不在：没有可保护的内容，直接补齐
    Install-Webview
} else {
    # 目录在但不完整。补齐要覆盖现有内容，必须显式授权，不做静默删除。
    Write-Step 'vendor/webview 存在但不完整'
    if (-not (Test-Path $probeWebview)) {
        Write-Host '  缺 core/include/webview/webview.h' -ForegroundColor Yellow
    }
    if (-not (Test-Path $probeEvent)) {
        Write-Host '  缺 compatibility/mingw/include/EventToken.h' -ForegroundColor Yellow
    }
    Write-Host ''
    Write-Host '补齐需要重新 clone 上游源码（联网，且会覆盖现有目录）。' -ForegroundColor Yellow
    Write-Host '确认后重跑：pwsh -File native/fetch.ps1 -Webview' -ForegroundColor Yellow
    exit 1
}

# ---- 2. WebView2 SDK --------------------------------------------------------

$sdkOk = Test-Path $probeSdk

if ($Sdk) {
    Install-Sdk $true
} elseif ($sdkOk) {
    Write-Host '[2/2] WebView2 SDK 已解压，跳过'
} else {
    # nupkg 在仓库里就离线解压；不在才需要联网下载
    $offline = Test-Path $pkg
    if ($offline) {
        Write-Host '[2/2] WebView2 头文件缺失，从仓库内 nupkg 离线解压'
    } else {
        Write-Host '[2/2] WebView2 头文件与 nupkg 均缺失，需下载' -ForegroundColor Yellow
    }
    Install-Sdk $false
}

# ---- 3. 汇总 ----------------------------------------------------------------

Write-Step 'summary'

$inputs = @(
    [pscustomobject]@{ Name = 'webview.h';   Path = $probeWebview; Rel = 'webview/core/include/webview/webview.h' },
    [pscustomobject]@{ Name = 'EventToken.h'; Path = $probeEvent;  Rel = 'webview/compatibility/mingw/include/EventToken.h' },
    [pscustomobject]@{ Name = 'WebView2.h';   Path = $probeSdk;    Rel = 'webview2/build/native/include/WebView2.h' }
)

$allOk = $true
foreach ($item in $inputs) {
    $ok = Test-Path $item.Path
    if (-not $ok) { $allOk = $false }
    $mark = if ($ok) { 'ok  ' } else { 'MISS' }
    $size = if ($ok) { '{0,10:N0} B' -f (Get-Item $item.Path).Length } else { '' }
    Write-Host ('  {0} {1,-56} {2}' -f $mark, $item.Rel, $size)
}

$versionFile = Join-Path $wvDir 'core\include\webview\version.h'
if (Test-Path $versionFile) {
    # 只认 `#define WEBVIEW_VERSION_X 12` 这种取值行；`#ifndef` 守卫行不含数字，一并排除
    $versions = Select-String -Path $versionFile -Pattern '^\s*#define\s+WEBVIEW_VERSION_(MAJOR|MINOR|PATCH)\s+\d+' |
        ForEach-Object { $_.Line.Trim() }
    if ($versions) {
        Write-Host ''
        Write-Host '  upstream version:'
        foreach ($line in $versions) { Write-Host "    $line" }
    }
}

Write-Host ''
if (-not $allOk) {
    Write-Host 'FETCH FAILED: not all inputs are present' -ForegroundColor Red
    exit 1
}
Write-Host 'FETCH OK' -ForegroundColor Green
exit 0
