#Requires -Version 7.0
# 把自签证书装入 CurrentUser 的 Root + TrustedPublisher，验证签名链路本身有效
# 注意：这条路径仅适用于本机自测；真实分发必须用公共 CA 的代码签名证书。
param(
    [string]$Subject = 'CN=WebView Shell Dev',
    # Root 写入需要管理员权限；普通权限下会自动降级并报告
    [string[]]$Stores = @('TrustedPublisher', 'Root')
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$cert = Get-ChildItem Cert:\CurrentUser\My |
    Where-Object { $_.Subject -eq $Subject -and $_.HasPrivateKey } |
    Select-Object -First 1
if (-not $cert) { throw "cert not found: $Subject" }

Write-Host ("cert: {0} ({1})" -f $cert.Subject, $cert.Thumbprint)

$der = $cert.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert)

foreach ($storeName in $Stores) {
    $store = New-Object System.Security.Cryptography.X509Certificates.X509Store($storeName, 'CurrentUser')
    $store.Open('ReadWrite')
    try {
        $already = $store.Certificates | Where-Object { $_.Thumbprint -eq $cert.Thumbprint }
        if ($already) {
            Write-Host ("  {0,-18} already present" -f $storeName)
        } else {
            $toAdd = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2(, $der)
            try {
                $store.Add($toAdd)
                Write-Host ("  {0,-18} added" -f $storeName)
            } catch {
                # Root 存储写入需要管理员；在普通权限下会被拒（不支持该请求）
                Write-Host ("  {0,-18} FAILED: {1}" -f $storeName, $_.Exception.Message)
            } finally {
                $toAdd.Dispose()
            }
        }
    } finally {
        $store.Close()
    }
}
