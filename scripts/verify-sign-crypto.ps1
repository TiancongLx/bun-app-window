#Requires -Version 7.0
# 纯密码学验证：跳过信任链，只校验 PKCS#7 签名数学正确性与内容未篡改
# 这是「签名可否被验签」的判据，与「证书是否受信任」是两件事。
param([string]$Exe)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Security

function Get-AuthenticodePkcs7([string]$path) {
    # 从 PE 安全目录里取出 WIN_CERTIFICATE 的 PKCS#7 blob
    $bytes = [System.IO.File]::ReadAllBytes($path)
    if ($bytes.Length -lt 0x40) { throw 'file too small' }

    $peOff = [BitConverter]::ToInt32($bytes, 0x3C)
    if ([BitConverter]::ToUInt32($bytes, $peOff) -ne 0x00004550) { throw 'not a PE file' }

    $optOff = $peOff + 24
    $magic = [BitConverter]::ToUInt16($bytes, $optOff)
    $isPe32Plus = ($magic -eq 0x20B)

    # 数据目录表：PE32 从 optOff+96 开始，PE32+ 从 optOff+112 开始；第 5 项(索引4)是安全目录
    $ddOff = $optOff + $(if ($isPe32Plus) { 112 } else { 96 })
    $secOff = $ddOff + 4 * 8
    $secRva = [BitConverter]::ToUInt32($bytes, $secOff)
    $secSize = [BitConverter]::ToUInt32($bytes, $secOff + 4)
    if ($secRva -eq 0 -or $secSize -eq 0) { return $null }

    # 安全目录的 RVA 实际是文件偏移
    $dwLength = [BitConverter]::ToUInt32($bytes, $secRva)
    $wRevision = [BitConverter]::ToUInt16($bytes, $secRva + 4)
    $wType = [BitConverter]::ToUInt16($bytes, $secRva + 6)
    # wType 0x0002 = WIN_CERT_TYPE_PKCS_SIGNED_DATA
    if ($wType -ne 0x0002) { throw "unexpected WIN_CERT type: 0x{0:X4}" -f $wType }

    $blobLen = $dwLength - 8
    $blob = New-Object byte[] $blobLen
    [Array]::Copy($bytes, $secRva + 8, $blob, 0, $blobLen)
    return [pscustomobject]@{ Blob = $blob; TotalBytes = $dwLength; Revision = $wRevision }
}

Write-Host ("file: {0}" -f $Exe)
$pk = Get-AuthenticodePkcs7 $Exe
if (-not $pk) { throw 'no Authenticode signature present' }
Write-Host ("PKCS#7 blob : {0:N0} bytes (WIN_CERTIFICATE {1:N0} bytes, rev 0x{2:X4})" -f $pk.Blob.Length, $pk.TotalBytes, $pk.Revision)
Write-Host ''

$cms = New-Object System.Security.Cryptography.Pkcs.SignedCms
$cms.Decode($pk.Blob)
Write-Host ("signers     : {0}" -f $cms.SignerInfos.Count)
Write-Host ("digest alg  : {0}" -f $cms.SignerInfos[0].DigestAlgorithm.FriendlyName)
Write-Host ("signer cert : {0}" -f $cms.SignerInfos[0].Certificate.Subject)
Write-Host ("certs in bag: {0}" -f $cms.Certificates.Count)
foreach ($c in $cms.Certificates) { Write-Host ("              - {0}" -f $c.Subject) }
Write-Host ''

# verifySignatureOnly = true：只验证签名数学正确性，不验证证书链
$ok = $false
$err = $null
try {
    $cms.CheckSignature($true)
    $ok = $true
} catch {
    $err = $_.Exception.Message
}
Write-Host ("crypto-only verify : {0}" -f $(if ($ok) { 'VALID (signature matches content)' } else { "INVALID: $err" }))

# 对比：包含证书链验证
$okChain = $false
$errChain = $null
try {
    $cms.CheckSignature($false)
    $okChain = $true
} catch {
    $errChain = $_.Exception.Message
}
Write-Host ("with chain verify  : {0}" -f $(if ($okChain) { 'VALID' } else { "INVALID: $errChain" }))
Write-Host ''

# 篡改检测：改一个字节后再验签，必须失败
Write-Host '=== tamper detection ==='
$tmp = Join-Path ([System.IO.Path]::GetTempPath()) ("tamper-" + [guid]::NewGuid().ToString('N') + '.exe')
Copy-Item $Exe $tmp -Force
try {
    $b = [System.IO.File]::ReadAllBytes($tmp)
    # 改动 .text 区里的一个字节（RVA 0x400 之后），不碰签名目录
    $target = 0x500
    $b[$target] = $b[$target] -bxor 0xFF
    [System.IO.File]::WriteAllBytes($tmp, $b)

    $sig2 = Get-AuthenticodeSignature $tmp
    Write-Host ("after tampering, Status : {0}" -f $sig2.Status)
    Write-Host ("after tampering, message: {0}" -f $sig2.StatusMessage)

    # 用 tampered 文件的 PKCS#7 再跑一次纯密码学校验。
    # 预期仍为 VALID：PKCS#7 里签的是「签名时刻算出的 PE 摘要」，
    # CheckSignature(true) 只校验该 blob 自身的签名数学正确性，
    # 并不会重新计算磁盘上 PE 的哈希。真正的文件完整性判定由
    # Authenticode 引擎（WinVerifyTrust）完成，即上面的 Get-AuthenticodeSignature。
    $pk2 = Get-AuthenticodePkcs7 $tmp
    $cms2 = New-Object System.Security.Cryptography.Pkcs.SignedCms
    $cms2.Decode($pk2.Blob)
    try {
        $cms2.CheckSignature($true)
        Write-Host 'crypto-only verify on tampered : VALID (expected: blob signature intact)'
    } catch {
        Write-Host ("crypto-only verify on tampered : INVALID ({0})" -f $_.Exception.Message)
    }
    Write-Host '  => 篡改判定以上面的 HashMismatch 为准，而非本项。'
} finally {
    Remove-Item $tmp -Force -ErrorAction SilentlyContinue
}
