#Requires -Version 7.0
<#
.SYNOPSIS
  系统级 Computer Use 端到端验证（在交互式会话内）

.DESCRIPTION
  验证链：找到窗口 → 提前台 → SendInput 注入 → UIA 读回 → 截屏

  靶子用 tools/cu-target.ps1 起的 WinForms 窗口：
  经典 Win32 窗口、有 TextBox、完全可控。
  （不用 notepad：Win11 是 WinUI3 打包应用，启动器/窗口分属不同进程；
    不用 cmd：Win11 默认由 Windows Terminal 承载，窗口不属于 cmd 进程。）

  判定标准不是「API 返回成功」，而是「注入的文字出现在目标控件里」。
#>
param(
    [switch]$SkipScreenshot,
    [string]$Shot = "$env:TEMP\cu-proof.png",
    [string]$Title = 'CU-TARGET'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Continue'

Add-Type -AssemblyName System.Drawing, System.Windows.Forms

Add-Type -Namespace CU -Name U32 -MemberDefinition @'
public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassNameW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, System.Text.StringBuilder sb, int max);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int cmd);
[DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int cbSize);

[StructLayout(LayoutKind.Sequential)]
public struct RECT { public int Left, Top, Right, Bottom; }

[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

[StructLayout(LayoutKind.Sequential)]
public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
  [FieldOffset(0)] public MOUSEINPUT mi;
  [FieldOffset(0)] public KEYBDINPUT ki;
  [FieldOffset(0)] public HARDWAREINPUT hi;
}

[StructLayout(LayoutKind.Sequential)]
public struct INPUT { public uint type; public INPUTUNION u; }
'@

Add-Type -Namespace CU -Name K32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@

# 关键：PowerShell 里对嵌套值类型字段赋值（$in.u.ki.wScan = x）会静默失效，
# 因为 $in.u 返回的是 union 的副本。因此 SendInput 的 INPUT 数组必须在 C# 里构造。
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

namespace CU {
  [StructLayout(LayoutKind.Sequential)]
  public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }

  [StructLayout(LayoutKind.Sequential)]
  public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }

  [StructLayout(LayoutKind.Explicit)]
  public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }

  [StructLayout(LayoutKind.Sequential)]
  public struct INPUT { public uint type; public INPUTUNION u; }

  public static class Sender {
    const uint INPUT_KEYBOARD = 1;
    const uint INPUT_MOUSE = 0;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const uint KEYEVENTF_UNICODE = 0x0004;
    const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
    const uint MOUSEEVENTF_LEFTUP = 0x0004;
    const uint MOUSEEVENTF_ABSOLUTE = 0x8000;
    const uint MOUSEEVENTF_MOVE = 0x0001;

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int nIndex);

    public static int InputSize() { return Marshal.SizeOf(typeof(INPUT)); }

    // Unicode 字符串注入：每个字符 down+up
    public static uint SendText(string text) {
      if (string.IsNullOrEmpty(text)) return 0;
      var arr = new INPUT[text.Length * 2];
      for (int i = 0; i < text.Length; i++) {
        var kd = new KEYBDINPUT();
        kd.wVk = 0;
        kd.wScan = text[i];
        kd.dwFlags = KEYEVENTF_UNICODE;
        arr[i * 2] = new INPUT();
        arr[i * 2].type = INPUT_KEYBOARD;
        arr[i * 2].u.ki = kd;

        var ku = new KEYBDINPUT();
        ku.wVk = 0;
        ku.wScan = text[i];
        ku.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;
        arr[i * 2 + 1] = new INPUT();
        arr[i * 2 + 1].type = INPUT_KEYBOARD;
        arr[i * 2 + 1].u.ki = ku;
      }
      return SendInput((uint)arr.Length, arr, InputSize());
    }

    // 单键（如 VK_RETURN=0x0D）
    public static uint SendKey(int vk) {
      var arr = new INPUT[2];
      var kd = new KEYBDINPUT(); kd.wVk = (ushort)vk;
      arr[0] = new INPUT(); arr[0].type = INPUT_KEYBOARD; arr[0].u.ki = kd;
      var ku = new KEYBDINPUT(); ku.wVk = (ushort)vk; ku.dwFlags = KEYEVENTF_KEYUP;
      arr[1] = new INPUT(); arr[1].type = INPUT_KEYBOARD; arr[1].u.ki = ku;
      return SendInput(2, arr, InputSize());
    }

    // 屏幕坐标点击（内部换算成绝对坐标 0..65535）
    public static uint ClickAt(int screenX, int screenY) {
      int w = GetSystemMetrics(0);
      int h = GetSystemMetrics(1);
      int nx = (int)Math.Round(screenX * 65535.0 / Math.Max(1, w - 1));
      int ny = (int)Math.Round(screenY * 65535.0 / Math.Max(1, h - 1));

      var arr = new INPUT[3];
      var mv = new MOUSEINPUT();
      mv.dx = nx; mv.dy = ny;
      mv.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE;
      arr[0] = new INPUT(); arr[0].type = INPUT_MOUSE; arr[0].u.mi = mv;

      var dn = new MOUSEINPUT();
      dn.dx = nx; dn.dy = ny;
      dn.dwFlags = MOUSEEVENTF_LEFTDOWN | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
      arr[1] = new INPUT(); arr[1].type = INPUT_MOUSE; arr[1].u.mi = dn;

      var up = new MOUSEINPUT();
      up.dx = nx; up.dy = ny;
      up.dwFlags = MOUSEEVENTF_LEFTUP | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE;
      arr[2] = new INPUT(); arr[2].type = INPUT_MOUSE; arr[2].u.mi = up;

      return SendInput(3, arr, InputSize());
    }
  }
}
'@ -ErrorAction Stop

[void][CU.U32]::SetProcessDPIAware()

function Find-WindowByTitle([string]$needle) {
    $script:hit = [IntPtr]::Zero
    $cb = [CU.U32+EnumProc]{
        param($h, $l)
        if ([CU.U32]::IsWindowVisible($h)) {
            $sb = New-Object System.Text.StringBuilder 512
            [void][CU.U32]::GetWindowTextW($h, $sb, 512)
            if ($sb.ToString() -like "*$needle*") { $script:hit = $h }
        }
        return $true
    }
    [void][CU.U32]::EnumWindows($cb, [IntPtr]::Zero)
    return $script:hit
}

$sid = (Get-Process -Id $PID).SessionId
$elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Write-Host "=== session=$sid user=$env:USERNAME elevated=$elevated ==="

# ---------- 1. 启动靶子 ----------
Write-Host ''
Write-Host '--- 1. 启动 WinForms 靶子 ---'
$targetScript = Join-Path $PSScriptRoot 'cu-target.ps1'
$tp = Start-Process pwsh.exe -ArgumentList @(
    '-NoProfile', '-NoLogo', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass', '-File', $targetScript, '-Title', $Title
) -PassThru

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 250
    $hwnd = Find-WindowByTitle $Title
    if ($hwnd -ne [IntPtr]::Zero) { break }
}
if ($hwnd -eq [IntPtr]::Zero) {
    Write-Host '  [FAIL] target window not found'
    if (-not $tp.HasExited) { $tp.Kill() }
    exit 2
}

$wpid = 0
[void][CU.U32]::GetWindowThreadProcessId($hwnd, [ref]$wpid)
$cls = New-Object System.Text.StringBuilder 256
[void][CU.U32]::GetClassNameW($hwnd, $cls, 256)
Write-Host ("  hwnd=0x{0:X} pid={1} class={2}" -f $hwnd.ToInt64(), $wpid, $cls.ToString())

# ---------- 2. EnumWindows ----------
Write-Host ''
Write-Host '--- 2. EnumWindows ---'
$script:visible = 0
$script:found = $false
$cb2 = [CU.U32+EnumProc]{
    param($h, $l)
    if ([CU.U32]::IsWindowVisible($h)) {
        $script:visible++
        if ($h -eq $hwnd) { $script:found = $true }
    }
    return $true
}
[void][CU.U32]::EnumWindows($cb2, [IntPtr]::Zero)
Write-Host ("  visible top-level windows : {0}" -f $script:visible)
Write-Host ("  target found in enum      : {0}" -f $script:found)

# ---------- 3. 前台激活 ----------
Write-Host ''
Write-Host '--- 3. 前台激活 ---'
$fgBefore = [CU.U32]::GetForegroundWindow()
$fgTid = 0
[void][CU.U32]::GetWindowThreadProcessId($fgBefore, [ref]$fgTid)
$myTid = [CU.K32]::GetCurrentThreadId()
Write-Host ("  foreground before         : 0x{0:X} (tid {1})" -f $fgBefore.ToInt64(), $fgTid)

[void][CU.U32]::ShowWindow($hwnd, 6)   # SW_MINIMIZE
Start-Sleep -Milliseconds 120
[void][CU.U32]::ShowWindow($hwnd, 9)   # SW_RESTORE
Start-Sleep -Milliseconds 200

$attached = $false
if ($fgTid -ne 0 -and $fgTid -ne $myTid) {
    $attached = [CU.U32]::AttachThreadInput($myTid, $fgTid, $true)
}
[void][CU.U32]::BringWindowToTop($hwnd)
$fgOk = [CU.U32]::SetForegroundWindow($hwnd)
if ($attached) { [void][CU.U32]::AttachThreadInput($myTid, $fgTid, $false) }
Start-Sleep -Milliseconds 400

$fgAfter = [CU.U32]::GetForegroundWindow()
Write-Host ("  AttachThreadInput         : {0}" -f $attached)
Write-Host ("  SetForegroundWindow       : {0}" -f $fgOk)
Write-Host ("  is target foreground      : {0}" -f ($fgAfter -eq $hwnd))

# ---------- 4. 鼠标点击输入框 ----------
Write-Host ''
Write-Host '--- 4. SendInput 鼠标点击（聚焦 TextBox）---'
$r = New-Object CU.U32+RECT
[void][CU.U32]::GetWindowRect($hwnd, [ref]$r)
$cx = [int](($r.Left + $r.Right) / 2)
$cy = [int]($r.Top + ($r.Bottom - $r.Top) * 0.55)
Write-Host ("  window rect               : {0},{1} {2}x{3}" -f $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top))
Write-Host ("  click at                  : {0},{1}" -f $cx, $cy)
$sentMouse = [CU.Sender]::ClickAt($cx, $cy)
Write-Host ("  mouse events sent         : {0}" -f $sentMouse)
Start-Sleep -Milliseconds 400

# ---------- 5. 键盘注入 ----------
Write-Host ''
Write-Host '--- 5. SendInput 键盘注入 ---'
$marker = "CU-PROOF-$([guid]::NewGuid().ToString('N').Substring(0,10))"
Write-Host ("  injecting                 : {0}" -f $marker)
$sentText = [CU.Sender]::SendText($marker)
Write-Host ("  keyboard events sent      : {0}" -f $sentText)
Start-Sleep -Milliseconds 800

# ---------- 6. 决定性验证：UIA 读回 ----------
Write-Host ''
Write-Host '--- 6. 决定性验证：UIA 读回 TextBox 内容 ---'
$readBack = $null
try {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes -ErrorAction Stop
    $auto = [System.Windows.Automation.AutomationElement]

    $winCond = New-Object System.Windows.Automation.PropertyCondition($auto::ProcessIdProperty, [int]$wpid)
    $win = $auto::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $winCond)

    if ($win) {
        Write-Host ("  window element            : '{0}'" -f $win.Current.Name)
        $editCond = New-Object System.Windows.Automation.PropertyCondition(
            $auto::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)
        $edit = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $editCond)

        if ($edit) {
            $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
            $readBack = $vp.Current.Value
            Write-Host ("  UIA read                  : '{0}'" -f $readBack)
            Write-Host ("  MATCH                     : {0}" -f ($readBack -eq $marker))

            # UIA 写操作（不依赖前台）
            $uiaText = "UIA-WRITE-$([guid]::NewGuid().ToString('N').Substring(0,6))"
            $vp.SetValue($uiaText)
            Start-Sleep -Milliseconds 300
            Write-Host ("  UIA SetValue              : '{0}'" -f $uiaText)
            Write-Host ("  UIA write verified        : {0}" -f ($vp.Current.Value -eq $uiaText))
        } else {
            Write-Host '  [WARN] Edit control not found'
        }
    } else {
        Write-Host '  [WARN] window not found via UIA'
    }
} catch {
    Write-Host ("  UIA ERROR                 : {0}" -f $_.Exception.Message.Split([char]10)[0])
}

# ---------- 7. 截屏 ----------
if (-not $SkipScreenshot) {
    Write-Host ''
    Write-Host '--- 7. CopyFromScreen ---'
    try {
        $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
        $g = [System.Drawing.Graphics]::FromImage($bmp)
        $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
        $g.Dispose()
        $bmp.Save($Shot, [System.Drawing.Imaging.ImageFormat]::Png)
        $nonBlack = 0; $total = 0
        $sx = [Math]::Max(1, [int]($b.Width / 60)); $sy = [Math]::Max(1, [int]($b.Height / 40))
        for ($y = 0; $y -lt $b.Height; $y += $sy) {
            for ($x = 0; $x -lt $b.Width; $x += $sx) {
                $px = $bmp.GetPixel($x, $y); $total++
                if ($px.R -gt 20 -or $px.G -gt 20 -or $px.B -gt 20) { $nonBlack++ }
            }
        }
        $pct = if ($total) { [math]::Round(100.0 * $nonBlack / $total, 1) } else { 0 }
        $bmp.Dispose()
        Write-Host ("  screen                    : {0}x{1}" -f $b.Width, $b.Height)
        Write-Host ("  nonBlackPercent           : {0}%" -f $pct)
        Write-Host ("  saved                     : {0}" -f $Shot)
    } catch {
        Write-Host ("  ERROR                     : {0}" -f $_.Exception.Message.Split([char]10)[0])
    }
}

# ---------- 清理 ----------
Write-Host ''
if (-not $tp.HasExited) { try { $tp.Kill() } catch { } }
# 兜底：按窗口标题找残留的靶子进程并终止
$stray = Find-WindowByTitle $Title
if ($stray -ne [IntPtr]::Zero) {
    $sp = 0
    [void][CU.U32]::GetWindowThreadProcessId($stray, [ref]$sp)
    try { Stop-Process -Id ([int]$sp) -Force -ErrorAction SilentlyContinue } catch { }
}
Write-Host '--- cleanup done ---'

Write-Host ''
Write-Host '=== 摘要 ==='
Write-Host ("  session                   : {0}" -f $sid)
Write-Host ("  EnumWindows 可见窗口      : {0}" -f $script:visible)
Write-Host ("  前台激活成功              : {0}" -f ($fgAfter -eq $hwnd))
Write-Host ("  SendInput 键盘事件        : {0}" -f $sentText)
Write-Host ("  UIA/注入 读回匹配         : {0}" -f ($readBack -eq $marker))
