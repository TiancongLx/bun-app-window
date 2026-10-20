#Requires -Version 7.0
# 代码签名验证：自签证书 → 签名 exe → Authenticode 校验
# 注意：这是「流程可行性」验证，不是「受信任分发」验证。
# 自签证书没有公共信任链，普通用户机器上仍会触发 SmartScreen / 未知发布者。
param(
    [string]$Exe = (Join-Path $PSScriptRoot '..\dist\bunframe.exe'),
    [string]$SignedOut = (Join-Path $PSScriptRoot '..\dist\bunframe.signed.exe')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Show-Sig([string]$path, [string]$label) {
    $sig = Get-AuthenticodeSignature $path
    Write-Host ("[{0}] {1}" -f $label, (Split-Path $path -Leaf))
    Write-Host ("  Status      : {0}" -f $sig.Status)
    Write-Host ("  StatusMsg   : {0}" -f $sig.StatusMessage)
    if ($sig.SignerCertificate) {
        Write-Host ("  Signer      : {0}" -f $sig.SignerCertificate.Subject)
        Write-Host ("  Thumbprint  : {0}" -f $sig.SignerCertificate.Thumbprint)
        Write-Host ("  NotAfter    : {0}" -f $sig.SignerCertificate.NotAfter)
    }
    if ($sig.TimeStamperCertificate) {
        Write-Host ("  Timestamper : {0}" -f $sig.TimeStamperCertificate.Subject)
    }
    Write-Host ''
    return $sig
}

Write-Host '=== 1. 签名前状态 ==='
$before = Show-Sig $Exe 'before'

if ($before.Status -ne 'NotSigned') {
    Write-Host 'already signed, aborting'
    exit 0
}

Write-Host '=== 2. 创建自签代码签名证书（仅本机 CurrentUser\My） ==='
$existing = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq 'CN=WebView Shell Dev' -and $_.HasPrivateKey } |
    Select-Object -First 1

if ($existing) {
    Write-Host ("reuse existing: {0}" -f $existing.Thumbprint)
    $cert = $existing
} else {
    $cert = New-SelfSignedCertificate `
        -Type CodeSigningCert `
        -Subject 'CN=WebView Shell Dev' `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -NotAfter (Get-Date).AddYears(2) `
        -KeyUsage DigitalSignature `
        -KeyExportPolicy Exportable
    Write-Host ("created: {0}" -f $cert.Thumbprint)
}
Write-Host ("  Subject  : {0}" -f $cert.Subject)
Write-Host ("  NotAfter : {0}" -f $cert.NotAfter)
Write-Host ''

Write-Host '=== 3. 签名（复制到新文件，不覆盖原始产物） ==='
Copy-Item $Exe $SignedOut -Force
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$result = Set-AuthenticodeSignature -FilePath $SignedOut -Certificate $cert `
    -HashAlgorithm SHA256 -TimestampServer 'http://timestamp.digicert.com' `
    -ErrorAction Continue
$sw.Stop()

Write-Host ("Set-AuthenticodeSignature: {0} ({1} ms)" -f $result.Status, $sw.ElapsedMilliseconds)
if ($result.StatusMessage) { Write-Host ("  msg: {0}" -f $result.StatusMessage) }
Write-Host ''

Write-Host '=== 4. 签名后校验 ==='
$after = Show-Sig $SignedOut 'after'

Write-Host '=== 5. 体积与哈希 ==='
foreach ($p in @($Exe, $SignedOut)) {
    $f = Get-Item $p
    $h = (Get-FileHash $p -Algorithm SHA256).Hash
    Write-Host ("{0,-34} {1,13:N0} bytes  sha256={2}" -f $f.Name, $f.Length, $h.Substring(0, 32))
}
$delta = (Get-Item $SignedOut).Length - (Get-Item $Exe).Length
Write-Host ("signature overhead: {0:N0} bytes" -f $delta)
