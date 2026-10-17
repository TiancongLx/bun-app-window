#Requires -Version 7.0
# 测试靶子：一个可控的经典 Win32（WinForms）窗口
# 主验证脚本据此做「注入 → 读回」的闭环
param([string]$Title = 'CU-TARGET')

Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Windows.Forms, System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.StartPosition = 'Manual'
$form.Location = New-Object System.Drawing.Point 120, 120
$form.Size = New-Object System.Drawing.Size 760, 520
$form.TopMost = $false

$tb = New-Object System.Windows.Forms.TextBox
$tb.Name = 'targetBox'
$tb.Multiline = $true
$tb.Location = New-Object System.Drawing.Point 20, 60
$tb.Size = New-Object System.Drawing.Size 700, 400
$tb.Font = New-Object System.Drawing.Font 'Consolas', 14
$form.Controls.Add($tb)

$lbl = New-Object System.Windows.Forms.Label
$lbl.Text = 'Computer-Use target window'
$lbl.Location = New-Object System.Drawing.Point 20, 18
$lbl.Size = New-Object System.Drawing.Size 500, 28
$lbl.Font = New-Object System.Drawing.Font 'Segoe UI', 11
$form.Controls.Add($lbl)

# 存活上限，防止残留
$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 120000
$timer.Add_Tick({ $form.Close() })
$timer.Start()

[void]$form.ShowDialog()
