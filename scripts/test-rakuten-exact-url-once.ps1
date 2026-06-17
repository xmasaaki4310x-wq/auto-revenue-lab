$ErrorActionPreference = "Stop"

Write-Host "Rakuten exact URL one-shot test"
Write-Host "Paste the full URL that succeeded in Rakuten API Test Form."
Write-Host "The URL contains your key, so do not screenshot or share the pasted value."
Write-Host "Run this after waiting 5 minutes if you recently saw HTTP 429."

$url = (Read-Host "Succeeded API URL").Trim()
$bodyFile = Join-Path $env:TEMP ("rakuten-api-body-" + [Guid]::NewGuid().ToString() + ".json")

try {
  $status = & curl.exe -s -L -A "Mozilla/5.0" -o $bodyFile -w "%{http_code}" $url
  Write-Host ("status: " + $status)

  $body = Get-Content -Raw -Encoding UTF8 $bodyFile
  if ($body.Trim().StartsWith("{")) {
    $json = $body | ConvertFrom-Json
    if ($json.count -ne $null) {
      Write-Host ("count: " + $json.count)
      Write-Host ("items returned: " + $json.Items.Count)
      if ($json.Items.Count -gt 0) {
        $first = $json.Items[0].Item
        if ($first -eq $null) {
          $first = $json.Items[0]
        }
        Write-Host ("first item: " + $first.itemName)
        Write-Host ("has affiliateUrl: " + [bool]$first.affiliateUrl)
      }
    } else {
      $errorText = "unknown"
      if ($json.error) {
        $errorText = $json.error
      } elseif ($json.message) {
        $errorText = $json.message
      }
      $description = ""
      if ($json.error_description) {
        $description = $json.error_description
      }
      Write-Host ("error: " + $errorText)
      Write-Host ("error_description: " + $description)
    }
  } else {
    Write-Host $body.Substring(0, [Math]::Min(500, $body.Length))
  }
} finally {
  if (Test-Path $bodyFile) {
    Remove-Item -LiteralPath $bodyFile -Force
  }
}
