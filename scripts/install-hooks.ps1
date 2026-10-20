#Requires -Version 7.0
<#
.SYNOPSIS
    安装 Git 钩子。新机器 clone 后执行一次。

.DESCRIPTION
    Git 不允许跟踪 .git/hooks/ 里的文件，所以钩子无法随仓库分发。
    本脚本把仓库内的钩子模板复制到 .git/hooks/ 并标记为可执行，
    让门禁在任何机器上都能一致地恢复。

    目前只安装 pre-push：它在推送前转调 scripts/gate.ps1。

.PARAMETER Force
    覆盖已存在的同名钩子（默认不覆盖，避免冲掉本地自定义）。

.EXAMPLE
    pwsh -File scripts/install-hooks.ps1

.EXAMPLE
    pwsh -File scripts/install-hooks.ps1 -Force
#>
param(
    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$gitDir = Join-Path $root '.git'

if (-not (Test-Path $gitDir)) {
    Write-Host "not a git repository: $root" -ForegroundColor Red
    exit 2
}

# 尊重 core.hooksPath：配了就装到那里，否则用默认 .git/hooks
Push-Location $root
try {
    $custom = & git config --get core.hooksPath
} finally {
    Pop-Location
}

$hooksDir = if ($custom) {
    if ([System.IO.Path]::IsPathRooted($custom)) { $custom } else { Join-Path $root $custom }
} else {
    Join-Path $gitDir 'hooks'
}

if (-not (Test-Path $hooksDir)) {
    New-Item -ItemType Directory -Force -Path $hooksDir | Out-Null
}

Write-Host "hooks dir: $hooksDir"

$content = @'
#!/bin/sh
# pre-push —— 本地推送门禁
#
# 本仓库不使用远端 CI（账户 billing lock，且项目是单平台单人开发）。
# 门禁逻辑的唯一事实源是 scripts/gate.ps1，本钩子只做转调，不复制逻辑，
# 以免两处判定标准漂移。
#
# 归属：位于 .git/hooks/，不纳入版本控制，不随仓库分发。
#       新机器 clone 后需手动创建，或用 scripts/install-hooks.ps1。
# 绕过：git push --no-verify
# 移除：删除本文件即可，无其他副作用。

cd "$(git rev-parse --show-toplevel)" || exit 1

if [ ! -f scripts/gate.ps1 ]; then
    echo "[pre-push] scripts/gate.ps1 不存在，跳过门禁。" >&2
    echo "[pre-push] 若这是刚 clone 的仓库，请确认脚本已就位。" >&2
    exit 0
fi

pwsh -NoProfile -ExecutionPolicy Bypass -File scripts/gate.ps1
rc=$?

if [ "$rc" -ne 0 ]; then
    echo "[pre-push] 门禁未通过，推送已取消。" >&2
    echo "[pre-push] 修好后重推，或 git push --no-verify 临时绕过。" >&2
    exit 1
fi

exit 0
'@

$target = Join-Path $hooksDir 'pre-push'

# 统一 LF + UTF-8 无 BOM：.git/hooks 下的 sh 脚本若带 CR 会无法执行。
# 归一化必须在内容比较之前完成，否则 here-string 的 CRLF 与磁盘上的 LF
# 永远不相等，每次都会误判为「内容不同」。
$normalized = ($content -replace "`r`n", "`n")

if ((Test-Path $target) -and (-not $Force)) {
    $existing = (Get-Content $target -Raw) -replace "`r`n", "`n"
    if ($existing -eq $normalized) {
        Write-Host 'pre-push: already up to date' -ForegroundColor Green
        exit 0
    }
    Write-Host 'pre-push: exists with different content, not overwriting (use -Force)' -ForegroundColor Yellow
    exit 0
}

[System.IO.File]::WriteAllText($target, $normalized, [System.Text.UTF8Encoding]::new($false))

Write-Host 'pre-push: installed' -ForegroundColor Green
Write-Host ''
Write-Host '验证：git push --dry-run   （应看到 gate 输出）'
