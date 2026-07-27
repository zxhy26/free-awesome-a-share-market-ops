$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$AppRoot = Join-Path $RepositoryRoot "app"
$PrivateKey = Get-ChildItem -LiteralPath $RepositoryRoot -Recurse -Force -File |
  Where-Object { $_.Name -eq "会员私钥.pem" }

if ($PrivateKey) {
  throw "A signing private key was found in the public source tree."
}

$SensitivePattern = 'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY|api[_-]?key\s*[:=]\s*\S{8,}|client[_-]?secret\s*[:=]\s*\S{8,}|access[_-]?token\s*[:=]\s*\S{8,}|bearer\s+[A-Za-z0-9._-]{20,}'
$TextFiles = Get-ChildItem -LiteralPath $RepositoryRoot -Recurse -Force -File |
  Where-Object {
    $_.FullName -ne $PSCommandPath -and
    $_.Extension -in ".js", ".json", ".html", ".css", ".md", ".ps1", ".cs", ".yml", ".yaml", ".txt"
  }

foreach ($File in $TextFiles) {
  $Matches = Select-String -LiteralPath $File.FullName -Pattern $SensitivePattern -CaseSensitive:$false
  if ($Matches) {
    throw "Potentially sensitive information found: $($File.FullName)"
  }
}

$MembershipService = Join-Path $AppRoot "backend\会员授权服务.js"
$PaymentConfig = Join-Path $AppRoot "data\会员支付配置.json"
$RequiredProtectedPaths = @(
  "/app/pages/policy-news.html",
  "/app/pages/next-week-events.html",
  "/app/pages/derivatives.html",
  "/app/pages/history.html",
  "/app/pages/stock-search.html",
  "/app/data/policy-news.json",
  "/app/data/derivatives.json",
  "/app/data/history-index.json"
)

$MembershipSource = Get-Content -LiteralPath $MembershipService -Raw -Encoding UTF8
foreach ($ProtectedPath in $RequiredProtectedPaths) {
  if (-not $MembershipSource.Contains($ProtectedPath)) {
    throw "Required protected route mapping is missing: $ProtectedPath"
  }
}

$ServiceSource = Get-Content -LiteralPath (Join-Path $AppRoot "backend\复盘同步服务.js") -Raw -Encoding UTF8
if ($ServiceSource.Contains('Access-Control-Allow-Origin", "*"')) {
  throw "The local service must not expose wildcard CORS."
}
if (-not $ServiceSource.Contains('url.pathname.startsWith("/app/data/")')) {
  throw "Protected member data must return an authorization response instead of redirecting to HTML."
}
foreach ($MutationPath in @("/refresh", "/policy-refresh", "/next-week-events-refresh", "/derivatives-refresh", "/quant-refresh", "/stock-open")) {
  if (-not $ServiceSource.Contains($MutationPath)) {
    throw "A required local mutation route is missing: $MutationPath"
  }
}

$Config = Get-Content -LiteralPath $PaymentConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Config.monthlyPrice -ne 72 -or $Config.annualPrice -ne 699) {
  throw "Runtime configuration does not match the expected release baseline."
}

$QrFiles = @(
  $Config.wechatQr,
  $Config.alipayQr,
  $Config.creatorWechatQr
)
foreach ($QrFile in $QrFiles) {
  $QrPath = Join-Path $AppRoot ($QrFile -replace "/", "\")
  if (-not (Test-Path -LiteralPath $QrPath -PathType Leaf)) {
    throw "A required runtime asset is missing: $QrFile"
  }
}

Write-Output "Public source audit passed: no signing private key was found and required runtime safeguards are intact."
