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
$keyword = Read-Host "Keyword [水]"
if ([string]::IsNullOrWhiteSpace($keyword)) {
  $keyword = "水"
}
$env:RAKUTEN_TEST_KEYWORD = $keyword.Trim()

& $node "scripts/test-rakuten-api.mjs"
