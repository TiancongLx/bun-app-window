#Requires -Version 7.0
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# 开发态运行器（禁用 .cmd/.bat：批处理会吞掉退出码，也不便于传参）
# 用法：pwsh -NoProfile -ExecutionPolicy Bypass -File run.ps1
# 保持窗口不退出由 -Hold 控制（原 run-hold.cmd 的 HOLD=1）
param(
    [switch]$Hold
)

$repo = $PSScriptRoot
$bun = 'C:\Users\root\scoop\shims\bun.exe'

if (-not (Test-Path $bun)) { throw "bun.exe 缺失：$bun" }

if ($Hold) {
    $env:HOLD = '1'
    Write-Output '[run] HOLD=1（窗口保持）'
}

& $bun run (Join-Path $repo 'src/host.ts')
$rc = $LASTEXITCODE

if ($Hold) {
    Write-Output ("[run] 退出码 " + $rc + "；按回车关闭…")
    [void](Read-Host)
}
exit $rc
