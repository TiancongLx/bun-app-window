#Requires -Version 7.0
# 杀软行为验证：对未签名 / 已签名 exe 做 Defender 自定义扫描，并检查威胁历史
param(
    [string]$Root = (Join-Path $PSScriptRoot '..')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$mp = 'C:\ProgramData\Microsoft\Windows Defender\Platform\CurrentVersion\MpCmdRun.exe'
if (-not (Test-Path $mp)) { throw "MpCmdRun not found: $mp" }

$targets = @(
    (Join-Path $Root 'dist\bun-app-window.exe'),
    (Join-Path $Root 'dist\bun-app-window.signed.exe'),
    (Join-Path $Root 'build\libshell.dll')
) |
    Where-Object { Test-Path $_ } |
    ForEach-Object { (Resolve-Path $_).Path }   # MpCmdRun 不认含 ".." 的路径，会直接跳过

Write-Host '=== targets ==='
foreach ($t in $targets) {
    $f = Get-Item $t
    $sig = Get-AuthenticodeSignature $t
    Write-Host ("  {0,-34} {1,13:N0} bytes  sig={2}" -f $f.Name, $f.Length, $sig.Status)
}
Write-Host ''

$before = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
Write-Host ("threat detections before: {0}" -f $before.Count)
Write-Host ''

foreach ($t in $targets) {
    Write-Host ("=== scan: {0} ===" -f (Split-Path $t -Leaf))
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    # -DisableRemediation：只检测不处置，避免扫描过程改动样本
    & $mp -Scan -ScanType 3 -File $t -DisableRemediation 2>&1 |
        ForEach-Object { Write-Host ("  {0}" -f $_) }
    $code = $LASTEXITCODE
    $sw.Stop()
    Write-Host ("  exit={0} elapsed={1:N1}s" -f $code, $sw.Elapsed.TotalSeconds)
    Write-Host ''
}

Write-Host '=== threat detections after ==='
$after = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
Write-Host ("count: {0}" -f $after.Count)
if ($after.Count -gt 0) {
    $after | Select-Object -Last 10 | ForEach-Object {
        Write-Host ("  {0}  {1}  {2}" -f $_.InitialDetectionTime, $_.ThreatID, $_.Resources)
    }
}

Write-Host ''
Write-Host '=== Defender exclusions (context) ==='
$pref = Get-MpPreference
if ($pref.ExclusionPath) {
    $pref.ExclusionPath | ForEach-Object { Write-Host ("  path: {0}" -f $_) }
} else {
    Write-Host '  (no path exclusions)'
}
if ($pref.ExclusionProcess) {
    $pref.ExclusionProcess | ForEach-Object { Write-Host ("  proc: {0}" -f $_) }
} else {
    Write-Host '  (no process exclusions)'
}
