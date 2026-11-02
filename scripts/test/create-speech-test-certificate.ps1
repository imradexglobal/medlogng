param(
  [Parameter(Mandatory = $true)][string]$OutputPath,
  [Parameter(Mandatory = $true)][string]$CertificatePath
)
$ErrorActionPreference = 'Stop'

# Create a short-lived test CA and a localhost server certificate signed by it.
# The client test supplies the exported CA as its trust root; it still verifies
# chain, certificate validity and the 127.0.0.1 subjectAltName.
$caRsa = [System.Security.Cryptography.RSA]::Create(2048)
$caRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=MediLog Test CA'),
  $caRsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($true, $false, 0, $true))
$caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyCertSign -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::CrlSign, $true))
$caRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509SubjectKeyIdentifierExtension]::new($caRequest.PublicKey, $false))
$caCertificate = $caRequest.CreateSelfSigned((Get-Date).AddDays(-1), (Get-Date).AddDays(30))

$serverRsa = [System.Security.Cryptography.RSA]::Create(2048)
$serverRequest = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new(
  [System.Security.Cryptography.X509Certificates.X500DistinguishedName]::new('CN=127.0.0.1'),
  $serverRsa,
  [System.Security.Cryptography.HashAlgorithmName]::SHA256,
  [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
)
$serverRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509BasicConstraintsExtension]::new($false, $false, 0, $true))
$serverRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509KeyUsageExtension]::new(
  [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::DigitalSignature -bor [System.Security.Cryptography.X509Certificates.X509KeyUsageFlags]::KeyEncipherment, $true))
$eku = [System.Security.Cryptography.OidCollection]::new()
[void]$eku.Add([System.Security.Cryptography.Oid]::new('1.3.6.1.5.5.7.3.1'))
$serverRequest.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($eku, $true))
$san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
$san.AddIpAddress([System.Net.IPAddress]::Parse('127.0.0.1'))
$serverRequest.CertificateExtensions.Add($san.Build())
$serial = [byte[]]::new(16)
$rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($serial)
$serial[0] = $serial[0] -band 0x7f
$unsignedCertificate = $serverRequest.Create($caCertificate, (Get-Date).AddDays(-1), (Get-Date).AddDays(7), $serial)
$serverCertificate = [System.Security.Cryptography.X509Certificates.RSACertificateExtensions]::CopyWithPrivateKey($unsignedCertificate, $serverRsa)

try {
  [System.IO.File]::WriteAllBytes($OutputPath, $serverCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Pfx))
  [System.IO.File]::WriteAllBytes($CertificatePath, $caCertificate.Export([System.Security.Cryptography.X509Certificates.X509ContentType]::Cert))
} finally {
  $serverCertificate.Dispose()
  $unsignedCertificate.Dispose()
  $caCertificate.Dispose()
  $serverRsa.Dispose()
  $caRsa.Dispose()
  $rng.Dispose()
}
