#Requires -Version 7.0
# 运行态杀软验证：通过 /IT 计划任务把 GUI 进程放到 Session 1，
# 再用当前 Session 0 的权限跨会话观察它的模块映射与 Defender 反应。
param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\dist\webview-shell.exe'),
    [string]$TaskName = 'wv-avrt'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$mp = 'C:\ProgramData\Microsoft\Windows Defender\Platform\CurrentVersion\MpCmdRun.exe'
$Exe = (Resolve-Path $Exe).Path

# 带 HOLD=1 的启动器，保证窗口存活 25 秒
$launcher = Join-Path ([System.IO.Path]::GetTempPath()) 'avrt-hold.cmd'
@(
    '@echo off',
    'set HOLD=1',
    """$Exe"""
) | Set-Content -Path $launcher -Encoding ASCII

& schtasks.exe /end /tn $TaskName 2>&1 | Out-Null
& schtasks.exe /delete /tn $TaskName /f 2>&1 | Out-Null
& schtasks.exe /create /tn $TaskName /tr "`"$launcher`"" /sc ONCE /sd 2020/01/01 /st 00:00 /it /f 2>&1 | Out-Null

$before = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
Write-Host ("threat detections before: {0}" -f $before.Count)

& schtasks.exe /run /tn $TaskName 2>&1 | Out-Null
Write-Host 'task started, waiting for process...'

$target = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $target = Get-Process -Name 'webview-shell' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($target) { break }
}

try {
    if (-not $target) {
        Write-Host 'TARGET PROCESS NOT FOUND'
        & schtasks.exe /query /tn $TaskName /fo LIST /v 2>&1 | Select-String 'Last Result|Status'
        exit 2
    }

    Write-Host ''
    Write-Host ("=== target: pid={0} session={1} ws={2:N0} KB ===" -f $target.Id, $target.SessionId, ($target.WorkingSet64 / 1KB))

    Write-Host ''
    Write-Host '=== memory-mapped native modules of interest ==='
    try {
        $mods = $target.Modules | Where-Object { $_.ModuleName -match 'shell|bun|WebView|webview' }
        if ($mods) {
            foreach ($m in $mods) {
                Write-Host ("  {0,-40} {1,12:N0} bytes  base=0x{2:X16}" -f $m.ModuleName, $m.ModuleMemorySize, $m.BaseAddress.ToInt64())
            }
        } else {
            Write-Host '  (no modules matching shell|bun|WebView)'
        }
        Write-Host ("  total modules: {0}" -f $target.Modules.Count)
    } catch {
        Write-Host ("  module enumeration failed: {0}" -f $_.Exception.Message)
    }

    Write-Host ''
    Write-Host '=== WebView2 child processes (same session) ==='
    $wv = Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CreationDate -gt (Get-Date).AddMinutes(-2) }
    Write-Host ("  count: {0}" -f @($wv).Count)

    Write-Host ''
    Write-Host '=== scan while running (file + in-memory) ==='
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    & $mp -Scan -ScanType 3 -File $Exe 2>&1 | ForEach-Object { Write-Host ("  {0}" -f $_) }
    $sw.Stop()
    Write-Host ("  exit={0} elapsed={1:N1}s" -f $LASTEXITCODE, $sw.Elapsed.TotalSeconds)
} finally {
    Write-Host ''
    Write-Host '=== cleanup ==='
    & schtasks.exe /end /tn $TaskName 2>&1 | Out-Null
    & schtasks.exe /delete /tn $TaskName /f 2>&1 | Out-Null
    Get-Process -Name 'webview-shell' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $launcher -Force -ErrorAction SilentlyContinue

    $after = @(Get-MpThreatDetection -ErrorAction SilentlyContinue)
    Write-Host ("threat detections after : {0}" -f $after.Count)
    foreach ($d in $after) {
        Write-Host ("  {0}  ThreatID={1}  {2}" -f $d.InitialDetectionTime, $d.ThreatID, $d.Resources)
    }

    Write-Host ''
    Write-Host '=== Defender Operational log (last 15 min, detection/action events) ==='
    $found = $false
    try {
        $evts = Get-WinEvent -FilterHashtable @{
            LogName   = 'Microsoft-Windows-Windows Defender/Operational'
            StartTime = (Get-Date).AddMinutes(-15)
        } -ErrorAction Stop | Where-Object { $_.Id -in 1006, 1007, 1015, 1116, 1117, 1121, 1122 }
        foreach ($e in $evts) {
            $found = $true
            Write-Host ("  [{0}] id={1} {2}" -f $e.TimeCreated.ToString('HH:mm:ss'), $e.Id, (($e.Message -split "`r?`n")[0]))
        }
    } catch {
        Write-Host ("  no matching events ({0})" -f $_.Exception.Message)
    }
    if (-not $found) { Write-Host '  (no detection/action events in window)' }
}
