$ErrorActionPreference = "Stop"

$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ".."))
$AppRoot = Join-Path $RepositoryRoot "app"
$PrivateKey = Get-ChildItem -LiteralPath $RepositoryRoot -Recurse -Force -File |
  Where-Object { $_.Name -eq "会员私钥.pem" }

if ($PrivateKey) {
  throw "公开源码中发现会员签发私钥。"
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
    throw "疑似敏感信息：$($File.FullName)"
  }
}

$MembershipService = Join-Path $AppRoot "backend\会员授权服务.js"
$PaymentConfig = Join-Path $AppRoot "data\会员支付配置.json"
$RequiredProtectedPaths = @(
  "/app/pages/policy-news.html",
  "/app/pages/next-week-events.html",
  "/app/pages/derivatives.html",
  "/app/pages/history.html",
  "/app/pages/stock-search.html"
)

$MembershipSource = Get-Content -LiteralPath $MembershipService -Raw -Encoding UTF8
foreach ($ProtectedPath in $RequiredProtectedPaths) {
  if (-not $MembershipSource.Contains($ProtectedPath)) {
    throw "会员保护映射缺失：$ProtectedPath"
  }
}

$Config = Get-Content -LiteralPath $PaymentConfig -Raw -Encoding UTF8 | ConvertFrom-Json
if ($Config.monthlyPrice -ne 72 -or $Config.annualPrice -ne 699) {
  throw "会员价格与发布规则不一致。"
}

$QrFiles = @(
  $Config.wechatQr,
  $Config.alipayQr,
  $Config.creatorWechatQr
)
foreach ($QrFile in $QrFiles) {
  $QrPath = Join-Path $AppRoot ($QrFile -replace "/", "\")
  if (-not (Test-Path -LiteralPath $QrPath -PathType Leaf)) {
    throw "会员二维码缺失：$QrFile"
  }
}

Write-Output "公开源码检查通过：无签发私钥，会员边界与支付配置完整。"
