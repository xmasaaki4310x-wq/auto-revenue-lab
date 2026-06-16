$ErrorActionPreference = "Stop"

$node = "C:\Users\Owner\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if (-not (Test-Path $node)) {
  $node = "node"
}

Write-Host "Rakuten exact URL test"
Write-Host "Paste the full URL that succeeded in Rakuten API Test Form."
Write-Host "The URL contains your key, so do not screenshot or share the pasted value."

$env:RAKUTEN_TEST_URL = (Read-Host "Succeeded API URL").Trim()

& $node "scripts/test-rakuten-api.mjs"
