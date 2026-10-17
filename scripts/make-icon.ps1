#Requires -Version 7.0
# 生成多尺寸 ICO（PNG 载荷，Vista+ 支持），供 bun build --windows-icon 使用
param(
    [string]$Out = (Join-Path $PSScriptRoot 'assets\app.ico'),
    [int[]]$Sizes = @(16, 24, 32, 48, 64, 128, 256)
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Drawing

New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size, ([System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.Clear([System.Drawing.Color]::Transparent)

    $s = [single]$size
    # 外圆角方块（品牌色渐变）
    $pad = $s * 0.06
    $rect = New-Object System.Drawing.RectangleF $pad, $pad, ($s - 2 * $pad), ($s - 2 * $pad)
    $r = $s * 0.22
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc($rect.X, $rect.Y, $d, $d, 180, 90)
    $path.AddArc($rect.Right - $d, $rect.Y, $d, $d, 270, 90)
    $path.AddArc($rect.Right - $d, $rect.Bottom - $d, $d, $d, 0, 90)
    $path.AddArc($rect.X, $rect.Bottom - $d, $d, $d, 90, 90)
    $path.CloseFigure()

    $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
        $rect,
        [System.Drawing.Color]::FromArgb(255, 32, 36, 48),
        [System.Drawing.Color]::FromArgb(255, 16, 18, 24),
        45.0)
    $g.FillPath($brush, $path)

    # 内层窗口框：上边为标题栏，含三个点
    $inset = $s * 0.20
    $frect = New-Object System.Drawing.RectangleF $inset, ($inset * 1.05), ($s - 2 * $inset), ($s - 2 * $inset * 1.05)
    $fr = $s * 0.07
    $fpath = New-Object System.Drawing.Drawing2D.GraphicsPath
    $fd = $fr * 2
    $fpath.AddArc($frect.X, $frect.Y, $fd, $fd, 180, 90)
    $fpath.AddArc($frect.Right - $fd, $frect.Y, $fd, $fd, 270, 90)
    $fpath.AddArc($frect.Right - $fd, $frect.Bottom - $fd, $fd, $fd, 0, 90)
    $fpath.AddArc($frect.X, $frect.Bottom - $fd, $fd, $fd, 90, 90)
    $fpath.CloseFigure()

    $stroke = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(255, 126, 226, 168)), ($s * 0.055)
    $stroke.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
    $g.DrawPath($stroke, $fpath)

    # 标题栏分隔线
    $barY = $frect.Y + $frect.Height * 0.26
    $g.DrawLine($stroke, $frect.X, $barY, $frect.Right, $barY)

    # 三个窗口按钮点（仅在 >=24px 时绘制，避免糊成一团）
    if ($size -ge 24) {
        $dot = $s * 0.028
        $cy = $frect.Y + $frect.Height * 0.13
        $cx0 = $frect.Right - $frect.Width * 0.10
        $dotBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(230, 200, 210, 220))
        for ($i = 0; $i -lt 3; $i++) {
            $cx = $cx0 - $i * ($dot * 3.0)
            $g.FillEllipse($dotBrush, ($cx - $dot), ($cy - $dot), ($dot * 2), ($dot * 2))
        }
        $dotBrush.Dispose()
    }

    $stroke.Dispose()
    $brush.Dispose()
    $path.Dispose()
    $fpath.Dispose()

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose()
    $bmp.Dispose()
    # 必须显式转 [byte[]]：PowerShell 函数返回数组会被展开成 Object[]，
    # 直接交给 BinaryWriter.Write 会绑定到错误的重载（写出 1 字节）。
    return , [byte[]]$ms.ToArray()
}

$pngs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($sz in $Sizes) {
    $bytes = [byte[]](New-IconPng $sz)
    if ($bytes.Length -lt 60) { throw "png for ${sz}px is suspiciously small: $($bytes.Length) bytes" }
    $pngs.Add($bytes)
    Write-Host ("  {0,3}px -> {1,6:N0} bytes" -f $sz, $bytes.Length)
}

# 组装 ICO：ICONDIR + N × ICONDIRENTRY + 各 PNG 数据
$ms = New-Object System.IO.MemoryStream
$bw = New-Object System.IO.BinaryWriter $ms

$bw.Write([uint16]0)          # reserved
$bw.Write([uint16]1)          # type = icon
$bw.Write([uint16]$Sizes.Count)

$offset = 6 + 16 * $Sizes.Count
for ($i = 0; $i -lt $Sizes.Count; $i++) {
    $sz = $Sizes[$i]
    $img = $pngs[$i]
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # width（0 表示 256）
    $bw.Write([byte]($(if ($sz -ge 256) { 0 } else { $sz })))  # height
    $bw.Write([byte]0)        # color count
    $bw.Write([byte]0)        # reserved
    $bw.Write([uint16]1)      # planes
    $bw.Write([uint16]32)     # bpp
    $bw.Write([uint32]$img.Length)
    $bw.Write([uint32]$offset)
    $offset += $img.Length
}
foreach ($img in $pngs) { $bw.Write($img) }

$bw.Flush()
[System.IO.File]::WriteAllBytes($Out, $ms.ToArray())
$bw.Dispose()
$ms.Dispose()

$f = Get-Item $Out
Write-Host ("icon: {0} ({1:N0} bytes, sizes: {2})" -f $f.FullName, $f.Length, ($Sizes -join ', '))

# 回读校验：System.Drawing 能否解析
$ico = New-Object System.Drawing.Icon $Out
Write-Host ("readback: {0}x{1}" -f $ico.Width, $ico.Height)
$ico.Dispose()
