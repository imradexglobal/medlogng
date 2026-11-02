param([Parameter(Mandatory = $true)][string]$OutputPath)
$ErrorActionPreference = 'Stop'

$rsa = [System.Security.Cryptography.RSA]::Create(2048)
$subject = [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=127.0.0.1')
$request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  $subject,
  $rsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$request.CertificateExtensions.Add($san.Build())
$certificate = $request.CreateSelfSigned((Get-Date).AddDays(-1), (Get-Date).AddDays(1))
try {
  [System.IO.File]::WriteAllBytes($OutputPath, $certificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
} finally {
  $certificate.Dispose()
  $rsa.Dispose()
}
