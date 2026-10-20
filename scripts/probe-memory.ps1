#Requires -Version 7.0
# 精查：libshell 到底以什么形式存在于目标进程内存中
# 1) 全量模块枚举（不过滤）
# 2) 用 VirtualQuery 遍历目标进程地址空间，找包含 "MZ"/"PE" 的私有映射
# 3) 与磁盘上的 libshell.dll 做特征比对
param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\dist\bun-app-window.exe'),
    [string]$Dll = (Join-Path $PSScriptRoot '..\build\libshell.dll'),
    [string]$TaskName = 'wv-memprobe'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

$Exe = (Resolve-Path $Exe).Path
$Dll = (Resolve-Path $Dll).Path

$launcher = Join-Path ([System.IO.Path]::GetTempPath()) 'memprobe-hold.cmd'
@('@echo off', 'set HOLD=1', """$Exe""") | Set-Content -Path $launcher -Encoding ASCII

& schtasks.exe /end /tn $TaskName 2>&1 | Out-Null
& schtasks.exe /delete /tn $TaskName /f 2>&1 | Out-Null
& schtasks.exe /create /tn $TaskName /tr "`"$launcher`"" /sc ONCE /sd 2020/01/01 /st 00:00 /it /f 2>&1 | Out-Null
& schtasks.exe /run /tn $TaskName 2>&1 | Out-Null

$target = $null
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    $target = Get-Process -Name 'bun-app-window' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($target) { break }
}

try {
    if (-not $target) { Write-Host 'TARGET NOT FOUND'; exit 2 }
    Write-Host ("target pid={0} session={1}" -f $target.Id, $target.SessionId)
    Write-Host ''

    Write-Host '=== ALL loaded modules (name | size) ==='
    $mods = @($target.Modules)
    Write-Host ("count = {0}" -f $mods.Count)
    $mods | Sort-Object ModuleName | ForEach-Object {
        Write-Host ("  {0,-46} {1,12:N0}  0x{2:X}" -f $_.ModuleName, $_.ModuleMemorySize, $_.BaseAddress.ToInt64())
    }

    Write-Host ''
    Write-Host '=== does any module name contain "shell"? ==='
    $hit = $mods | Where-Object { $_.ModuleName -like '*shell*' }
    if ($hit) {
        $hit | ForEach-Object { Write-Host ("  HIT: {0} ({1:N0} bytes)" -f $_.ModuleName, $_.ModuleMemorySize) }
    } else {
        Write-Host '  NONE  => libshell 未注册为常规模块'
    }

    Write-Host ''
    Write-Host '=== disk libshell.dll fingerprint ==='
    $diskBytes = [System.IO.File]::ReadAllBytes($Dll)
    Write-Host ("  size = {0:N0}" -f $diskBytes.Length)
    $diskLfanew = [BitConverter]::ToInt32($diskBytes, 0x3C)
    Write-Host ("  e_lfanew = 0x{0:X}  signature = 0x{1:X8}" -f $diskLfanew, [BitConverter]::ToUInt32($diskBytes, $diskLfanew))
    # 导出名特征：shell_debug_dpi
    $needle = [System.Text.Encoding]::ASCII.GetBytes('shell_debug_dpi')
    $idx = -1
    for ($i = 0; $i -le $diskBytes.Length - $needle.Length; $i++) {
        $ok = $true
        for ($j = 0; $j -lt $needle.Length; $j++) {
            if ($diskBytes[$i + $j] -ne $needle[$j]) { $ok = $false; break }
        }
        if ($ok) { $idx = $i; break }
    }
    Write-Host ("  'shell_debug_dpi' string offset = 0x{0:X}" -f $idx)

    Write-Host ''
    Write-Host '=== scan target process memory for the export-name signature ==='
    Write-Host '  (在目标进程地址空间中搜索 "shell_debug_dpi" 字节序列)'
    $found = $false
    try {
        # 借助 P/Invoke 做 ReadProcessMemory 扫描
        Add-Type -Namespace MemScan -Name Api -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)]
public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
[DllImport("kernel32.dll", SetLastError=true)]
public static extern bool VirtualQueryEx(IntPtr h, IntPtr addr, out MEMORY_BASIC_INFORMATION mbi, IntPtr len);
[DllImport("kernel32.dll")]
public static extern bool CloseHandle(IntPtr h);

[StructLayout(LayoutKind.Sequential)]
public struct MEMORY_BASIC_INFORMATION {
  public IntPtr BaseAddress;
  public IntPtr AllocationBase;
  public uint AllocationProtect;
  public IntPtr RegionSize;
  public uint State;
  public uint Protect;
  public uint Type;
}
'@

        # PROCESS_QUERY_INFORMATION(0x400) | PROCESS_VM_READ(0x10)
        $hProc = [MemScan.Api]::OpenProcess(0x410, $false, $target.Id)
        if ($hProc -eq [IntPtr]::Zero) {
            Write-Host ("  OpenProcess failed: {0}" -f [System.Runtime.InteropServices.Marshal]::GetLastWin32Error())
        } else {
            $needleStr = 'shell_debug_dpi'
            $needleBytes = [System.Text.Encoding]::ASCII.GetBytes($needleStr)
            $addr = [IntPtr]::Zero
            $mbiSize = [System.Runtime.InteropServices.Marshal]::SizeOf([type]'MemScan.Api+MEMORY_BASIC_INFORMATION')
            $scannedRegions = 0
            $scannedBytes = 0
            $maxScan = 512MB

            while ($scannedBytes -lt $maxScan) {
                $mbi = New-Object MemScan.Api+MEMORY_BASIC_INFORMATION
                $q = [MemScan.Api]::VirtualQueryEx($hProc, $addr, [ref]$mbi, [IntPtr]$mbiSize)
                if ($q -eq $false) { break }

                $regionSize = [int64]$mbi.RegionSize
                # MEM_COMMIT = 0x1000；只读 + 可执行(0x20 0x40 0x80) 都扫
                if ($mbi.State -eq 0x1000 -and $regionSize -gt 0 -and $regionSize -le 64MB) {
                    $buf = New-Object byte[] $regionSize
                    $read = [IntPtr]::Zero
                    $ok = [MemScan.Api]::ReadProcessMemory($hProc, $mbi.BaseAddress, $buf, [IntPtr]$regionSize, [ref]$read)
                    if ($ok -and $read.ToInt64() -gt 0) {
                        $len = [int]$read.ToInt64()
                        $scannedRegions++
                        $scannedBytes += $len
                        # 简单子串搜索
                        $first = $needleBytes[0]
                        for ($i = 0; $i -le $len - $needleBytes.Length; $i++) {
                            if ($buf[$i] -ne $first) { continue }
                            $match = $true
                            for ($j = 1; $j -lt $needleBytes.Length; $j++) {
                                if ($buf[$i + $j] -ne $needleBytes[$j]) { $match = $false; break }
                            }
                            if ($match) {
                                $found = $true
                                $va = $mbi.BaseAddress.ToInt64() + $i
                                Write-Host ("  FOUND 'shell_debug_dpi' at VA 0x{0:X}  (region base 0x{1:X}, protect 0x{2:X})" -f $va, $mbi.BaseAddress.ToInt64(), $mbi.Protect)
                                break
                            }
                        }
                    }
                }

                $addr = [IntPtr]($mbi.BaseAddress.ToInt64() + $regionSize)
                if ($addr.ToInt64() -le 0 -or $addr.ToInt64() -gt 0x7FFFFFFFFFFF) { break }
            }
            [void][MemScan.Api]::CloseHandle($hProc)
            Write-Host ("  scanned regions={0} bytes={1:N0}" -f $scannedRegions, $scannedBytes)
            if (-not $found) { Write-Host '  NOT FOUND in memory' }
        }
    } catch {
        Write-Host ("  memory scan failed: {0}" -f $_.Exception.Message)
    }
} finally {
    & schtasks.exe /end /tn $TaskName 2>&1 | Out-Null
    & schtasks.exe /delete /tn $TaskName /f 2>&1 | Out-Null
    Get-Process -Name 'bun-app-window' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Remove-Item $launcher -Force -ErrorAction SilentlyContinue
    Write-Host ''
    Write-Host 'cleanup done'
}
