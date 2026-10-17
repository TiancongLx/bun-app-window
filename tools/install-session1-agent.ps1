#Requires -Version 7.0
<#
.SYNOPSIS
  注册 session1-agent 为登录触发任务，使 GUI 调试可在交互式会话中进行。

.DESCRIPTION
  OTT 以服务形态运行在 Session 0，那里没有交互式桌面，WebView2 无法创建 controller。
  本脚本在 Session 1（用户 console 会话）注册一个登录触发的常驻代理，
  Session 0 通过 127.0.0.1 HTTP 把命令派发进去执行。

  代理以当前用户身份运行，不涉及提权，不改动 OTT 服务形态。

.PARAMETER Start
  注册后立即启动（不等下一次登录）。

.PARAMETER Uninstall
  停止并移除任务与代理进程，保留配置与日志。

.EXAMPLE
  pwsh -File tools\install-session1-agent.ps1 -Start
#>
param(
    [switch]$Start,
    [switch]$Uninstall,
    [string]$TaskName = 'session1-agent'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$agentTs = Join-Path $PSScriptRoot 'session1-agent.ts'
$configDir = Join-Path $env:USERPROFILE '.config\session1-agent'
$launcher = Join-Path $configDir 'launch.vbs'
$portFile = Join-Path $configDir 'port'
$tokenFile = Join-Path $configDir 'token'

function Get-AgentHealth {
    if (-not (Test-Path $portFile)) { return $null }
    $port = (Get-Content $portFile -Raw).Trim()
    if (-not $port) { return $null }
    try {
        return Invoke-RestMethod -Uri "http://127.0.0.1:$port/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

# ---------- 卸载 ----------

if ($Uninstall) {
    Write-Host '[uninstall] stopping agent'
    $health = Get-AgentHealth
    if ($health) {
        try { Stop-Process -Id $health.pid -Force -ErrorAction Stop } catch { }
    }
    Get-Process -Name 'bun' -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -like '*bun*' } |
        ForEach-Object {
            # 只杀我们的代理，按命令行区分
            $cl = (Get-CimInstance Win32_Process -Filter "ProcessId=$($_.Id)" -ErrorAction SilentlyContinue).CommandLine
            if ($cl -and $cl -like '*session1-agent*') {
                Write-Host "  kill pid=$($_.Id)"
                try { Stop-Process -Id $_.Id -Force } catch { }
            }
        }

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "[uninstall] task removed: $TaskName"
    }
    Remove-Item $portFile -Force -ErrorAction SilentlyContinue
    Write-Host '[uninstall] done (config and log kept)'
    return
}

# ---------- 前置检查 ----------

if (-not (Test-Path $agentTs)) { throw "agent not found: $agentTs" }

$bun = (Get-Command bun.exe -ErrorAction SilentlyContinue)?.Source
if (-not $bun) { throw 'bun.exe not found in PATH' }
Write-Host ("bun    : {0}" -f $bun)
Write-Host ("agent  : {0}" -f $agentTs)

New-Item -ItemType Directory -Force -Path $configDir | Out-Null

# ---------- 生成隐藏启动器 ----------

# 用 VBS 的 Run(cmd, 0, False)：窗口状态 0 = 隐藏，不等待返回。
# 直接用计划任务指向 bun.exe 会弹出控制台窗口。
$vbs = @"
' 由 install-session1-agent.ps1 自动生成，请勿手工修改
Dim sh
Set sh = CreateObject("WScript.Shell")
sh.Run """$bun"" run ""$agentTs""", 0, False
"@
Set-Content -Path $launcher -Value $vbs -Encoding ASCII
Write-Host ("launcher: {0}" -f $launcher)

# ---------- 注册登录触发任务 ----------

if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$launcher`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description 'Session 1 执行代理：让 Session 0 的 OTT 能在交互式会话中调试 GUI' `
    -Force | Out-Null

Write-Host ("[ok] task registered: {0} (trigger: at logon of {1})" -f $TaskName, $env:USERNAME)

# ---------- 立即启动 ----------

if ($Start) {
    Write-Host '[start] launching agent in interactive session'
    Start-ScheduledTask -TaskName $TaskName

    $deadline = (Get-Date).AddSeconds(20)
    $health = $null
    while ((Get-Date) -lt $deadline) {
        Start-Sleep -Milliseconds 700
        $health = Get-AgentHealth
        if ($health) { break }
    }

    if (-not $health) {
        Write-Host '[fail] agent did not become healthy'
        Write-Host '       check: ~/.config/session1-agent/agent.log'
        exit 1
    }

    Write-Host ''
    Write-Host '=== agent health ==='
    $health | Format-List
    if ($health.sessionId -ne 1) {
        Write-Host ''
        Write-Host ("[warn] agent is in session {0}, expected 1" -f $health.sessionId)
        Write-Host '       若为 0，说明任务未在交互式会话中启动；确认当前用户已登录 console 会话'
        exit 2
    }
    Write-Host '[ok] agent is in session 1 — GUI debugging available'
}
