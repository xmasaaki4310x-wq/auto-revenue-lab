$ErrorActionPreference = "Stop"

$node = "C:\Users\Owner\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $node)) {
  $node = "node"
}

Write-Host "Rakuten API local test"
Write-Host "Paste values from Rakuten Developers. They are set only for this PowerShell process."

$env:RAKUTEN_APPLICATION_ID = (Read-Host "Application ID").Trim()
$env:RAKUTEN_ACCESS_KEY = (Read-Host "Access Key").Trim()
$env:RAKUTEN_AFFILIATE_ID = (Read-Host "Affiliate ID").Trim()
$keyword = Read-Host "Keyword [coffee]"
if ([string]::IsNullOrWhiteSpace($keyword)) {
  $keyword = "coffee"
}
$env:RAKUTEN_TEST_KEYWORD = $keyword.Trim()
$includeAffiliate = Read-Host "Include Affiliate ID? [Y/n]"
if ($includeAffiliate -match "^[nN]") {
  $env:RAKUTEN_TEST_INCLUDE_AFFILIATE = "0"
} else {
  $env:RAKUTEN_TEST_INCLUDE_AFFILIATE = "1"
}

& $node "scripts/test-rakuten-api.mjs"
