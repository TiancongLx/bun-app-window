#Requires -Version 7.0
<#
.SYNOPSIS
    一处输入、两处落盘地升级版本号。

.DESCRIPTION
    版本号有两处会进入构建产物，必须同时修改：

        package.json             npm 发布用
        native/build-pack.ps1    exe 的 PE 版本资源（--windows-version）

    手工改一处、漏一处不会报错，只会静默漂移（npm 上是 0.2.0，
    exe 属性页写着 0.1.0.0）。本脚本消除这个漂移面。

    CHANGELOG.md 不自动改写：版本段落的结构由人决定，脚本不去猜。

    写盘使用 UTF-8（无 BOM）并保留原换行符，符合仓库 .gitattributes 约定
    （LF + UTF-8 no BOM）。

.PARAMETER Version
    目标版本号，形如 1.2.3 或 1.2.3-beta.1。PE 四段版本固定取前三段补 .0。

.PARAMETER Root
    仓库根目录，默认脚本所在目录的上一级。

.PARAMETER DryRun
    只显示将要产生的改动，不写盘。

.EXAMPLE
    pwsh -File scripts/bump-version.ps1 0.2.0

.EXAMPLE
    pwsh -File scripts/bump-version.ps1 0.2.0 -DryRun
#>
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string]$Version,

    [string]$Root = (Join-Path $PSScriptRoot '..'),

    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# ---- 校验输入 ----------------------------------------------------------------

if ($Version -notmatch '^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$') {
    throw "版本号必须形如 1.2.3 或 1.2.3-beta.1，收到：$Version"
}

$major = $Matches[1]
$minor = $Matches[2]
$patch = $Matches[3]

# PE 版本资源只有四段数字，不承载 prerelease；前三段跟随 semver，第四段固定 0
$peVersion = "$major.$minor.$patch.0"

$utf8NoBom = [System.Text.UTF8Encoding]::new($false)

# ---- package.json ------------------------------------------------------------

$pkgPath = Join-Path $Root 'package.json'
if (-not (Test-Path $pkgPath)) { throw "找不到 package.json：$pkgPath" }

$pkgRaw = [System.IO.File]::ReadAllText($pkgPath)
$pkgPattern = '(?m)^(\s*"version"\s*:\s*")[^"]+(")'
if ($pkgRaw -notmatch $pkgPattern) { throw "package.json 里定位不到 version 字段" }

$oldSemver = ([regex]::Match($pkgRaw, $pkgPattern)).Groups[0].Value.Trim()
$pkgNew = $pkgRaw -replace $pkgPattern, ('${1}' + $Version + '${2}')

# ---- native/build-pack.ps1 ---------------------------------------------------

$packPath = Join-Path $Root 'native/build-pack.ps1'
if (-not (Test-Path $packPath)) { throw "找不到 build-pack.ps1：$packPath" }

$packRaw = [System.IO.File]::ReadAllText($packPath)
$packPattern = "(?m)^(\s*'--windows-version'\s*,\s*')[^']+(')"
if ($packRaw -notmatch $packPattern) { throw "build-pack.ps1 里定位不到 --windows-version" }

$packNew = $packRaw -replace $packPattern, ('${1}' + $peVersion + '${2}')

# ---- 落盘或预演 --------------------------------------------------------------

Write-Host ''
Write-Host "目标版本：$Version（exe PE 版本：$peVersion）"
Write-Host ''
Write-Host "  package.json          $oldSemver"
Write-Host "                     -> `"version`": `"$Version`""
Write-Host "  native/build-pack.ps1 -> '--windows-version', '$peVersion'"
Write-Host ''

if ($DryRun) {
    Write-Host '（DryRun：未写入任何文件）' -ForegroundColor Yellow
    exit 0
}

if ($pkgNew -eq $pkgRaw -and $packNew -eq $packRaw) {
    Write-Host '两处均已是目标版本，无改动。' -ForegroundColor Yellow
    exit 0
}

if ($pkgNew -ne $pkgRaw) {
    [System.IO.File]::WriteAllText($pkgPath, $pkgNew, $utf8NoBom)
    Write-Host "已写入 $pkgPath"
}
if ($packNew -ne $packRaw) {
    [System.IO.File]::WriteAllText($packPath, $packNew, $utf8NoBom)
    Write-Host "已写入 $packPath"
}

Write-Host ''
Write-Host '下一步：'
Write-Host '  1. 在 CHANGELOG.md 里为新版本补一段（Unreleased 内容下移）'
Write-Host '  2. bun check && bun test    # version.test.ts 会复验两处一致'
Write-Host "  3. git commit -m `"chore: 版本号升至 $Version`""
Write-Host "  4. bun publish              # 会弹 passkey 2FA，需人工确认"
Write-Host "  5. git tag v$Version && git push --tags"
Write-Host ''
