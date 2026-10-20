#Requires -Version 7.0
<#
.SYNOPSIS
    本地质量门禁。本仓库不使用远端 CI，所有门禁在此执行。

.DESCRIPTION
    本仓库没有 GitHub Actions：账户 billing lock 导致 runner 无法分配，
    且项目本身是 Windows x64 单平台、单人开发、零外部服务依赖，
    远端 CI 的边际价值低于它的维护成本。门禁改在本地执行。

    三个阶段，前两个与原本的 ci.yml 完全一致：

        bun check    类型检查
        bun test     行为测试
        消费方验收    scripts/verify-pack.ts —— 打包、装进临时工程、再检查

    第三个阶段补的是 ci.yml 从来就测不到的一段：仓库内的 bun test 走
    「源码 + 本地 dist」，看不见「作为 tarball 被第三方安装」的真实链路。
    exports 拼错、files 漏项、类型声明缺位，这三种故障在仓库内全绿，
    在 npm 上装起来就炸。它离线可跑，约 0.4 秒。

    -Clean 模式额外价值：在 %TEMP% 里 clone 一份干净副本再跑，
    消除 .build / node_modules / vendor\webview2 等本地残留掩盖问题的可能。
    实测 2 秒内完成（clone 0.4s + install 0.9s + 门禁 0.5s）。

    本脚本不修改 package.json 的 scripts：AGENTS.md 限定 scripts 只能有
    build:native / build:exe / demo / pack 四项，另立入口会破坏该约束。

.PARAMETER Clean
    在 %TEMP% 下 clone 干净副本执行门禁，结束后删除副本。

.PARAMETER KeepClone
    与 -Clean 同用，保留克隆副本供排查（会打印路径）。

.PARAMETER SkipTest
    只跑类型检查，跳过行为测试与消费方验收。

.PARAMETER SkipPack
    跳过消费方验收。仅用于 verify-pack 本身正在改动时自举，
    或临时绕过环境问题（需要 tar 与可写 %TEMP%）——不要把它当默认值。

.EXAMPLE
    pwsh -File scripts/gate.ps1

.EXAMPLE
    pwsh -File scripts/gate.ps1 -Clean

.NOTES
    退出码：0 = 全部通过，1 = 门禁失败，2 = 环境问题。
#>
param(
    [switch]$Clean,
    [switch]$KeepClone,
    [switch]$SkipTest,
    [switch]$SkipPack
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path

function Write-Step([string]$text) {
    Write-Host ''
    Write-Host "=== $text ===" -ForegroundColor Cyan
}

function Invoke-Gate([string]$workDir) {
    if (-not (Test-Path (Join-Path $workDir 'package.json'))) {
        Write-Host "not a package root: $workDir" -ForegroundColor Red
        return $false
    }

    Push-Location $workDir
    try {
        Write-Step 'bun check'
        $sw = [System.Diagnostics.Stopwatch]::StartNew()
        # 必须 | Out-Host：否则 bun 的输出会进入函数返回值管道，
        # 调用方拿到的是「输出数组 + $false」，而非空数组在布尔上下文恒为真，
        # 失败会被静默吞掉（曾实测：rc=1 却报 GATE PASSED）。
        & bun check 2>&1 | Out-Host
        $checkRc = $LASTEXITCODE
        $sw.Stop()
        if ($checkRc -ne 0) {
            Write-Host ("type check FAILED (rc=$checkRc, {0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Red
            return $false
        }
        Write-Host ("type check ok ({0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green

        if ($SkipTest) {
            Write-Host 'bun test skipped (-SkipTest)' -ForegroundColor Yellow
            return $true
        }

        Write-Step 'bun test'
        $sw.Restart()
        & bun test 2>&1 | Out-Host
        $testRc = $LASTEXITCODE
        $sw.Stop()
        if ($testRc -ne 0) {
            Write-Host ("tests FAILED (rc=$testRc, {0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Red
            return $false
        }
        Write-Host ("tests ok ({0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green

        if ($SkipPack) {
            Write-Host 'pack verification skipped (-SkipPack)' -ForegroundColor Yellow
            return $true
        }

        Write-Step 'pack verification'
        $sw.Restart()
        & bun run (Join-Path $workDir 'scripts/verify-pack.ts') 2>&1 | Out-Host
        $packRc = $LASTEXITCODE
        $sw.Stop()
        if ($packRc -ne 0) {
            Write-Host ("pack verification FAILED (rc=$packRc, {0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Red
            return $false
        }
        Write-Host ("pack verification ok ({0:N1}s)" -f $sw.Elapsed.TotalSeconds) -ForegroundColor Green
        return $true
    } finally {
        Pop-Location
    }
}

# ---- 干净副本模式 ------------------------------------------------------------

if ($Clean) {
    # 干净副本只包含已提交内容。有未提交改动时结果不代表工作区现状，必须先说清。
    Push-Location $root
    try {
        $dirty = & git status --porcelain
        $headSha = (& git rev-parse --short HEAD)
    } finally {
        Pop-Location
    }
    if ($dirty) {
        Write-Host ''
        Write-Host 'WARNING: working tree has uncommitted changes.' -ForegroundColor Yellow
        Write-Host '         -Clean clones HEAD only; those changes are NOT included.' -ForegroundColor Yellow
        foreach ($line in ($dirty -split "`n" | Where-Object { $_ })) {
            Write-Host "         $line" -ForegroundColor Yellow
        }
        Write-Host '         Run without -Clean to verify the working tree as-is.' -ForegroundColor Yellow
    }

    $stamp = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss')
    $probe = Join-Path ([System.IO.Path]::GetTempPath()) "baw-gate-$stamp"

    Write-Step "clean clone HEAD($headSha) -> $probe"
    $total = [System.Diagnostics.Stopwatch]::StartNew()

    # file:// 前缀：本地路径直接 clone 时 git 会忽略 --depth 并告警
    $srcUrl = 'file:///' + ($root -replace '\\', '/')
    & git clone --quiet --depth 1 $srcUrl $probe
    if ($LASTEXITCODE -ne 0) {
        Write-Host "git clone failed (rc=$LASTEXITCODE)" -ForegroundColor Red
        exit 2
    }

    Push-Location $probe
    try {
        Write-Step 'bun install --frozen-lockfile'
        & bun install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) {
            Write-Host "bun install failed (rc=$LASTEXITCODE)" -ForegroundColor Red
            exit 2
        }
    } finally {
        Pop-Location
    }

    $ok = Invoke-Gate $probe
    $total.Stop()

    if ($KeepClone) {
        Write-Host ''
        Write-Host "clone kept at: $probe" -ForegroundColor Yellow
    } else {
        Remove-Item $probe -Recurse -Force -ErrorAction SilentlyContinue
        Write-Host ''
        Write-Host 'clean clone removed'
    }

    Write-Host ''
    Write-Host ("total: {0:N1}s" -f $total.Elapsed.TotalSeconds)
    if ($ok) { Write-Host 'GATE PASSED (clean)' -ForegroundColor Green; exit 0 }
    Write-Host 'GATE FAILED (clean)' -ForegroundColor Red
    exit 1
}

# ---- 本地模式 ----------------------------------------------------------------

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$ok = Invoke-Gate $root
$sw.Stop()

Write-Host ''
Write-Host ("total: {0:N1}s" -f $sw.Elapsed.TotalSeconds)
if ($ok) {
    Write-Host 'GATE PASSED' -ForegroundColor Green
    exit 0
}
Write-Host 'GATE FAILED' -ForegroundColor Red
exit 1
