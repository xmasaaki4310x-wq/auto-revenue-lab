$ErrorActionPreference = "Stop"

Write-Host "Rakuten exact URL test with PowerShell and curl.exe"
Write-Host "Paste the full URL that succeeded in Rakuten API Test Form."
Write-Host "The URL contains your key, so do not screenshot or share the pasted value."

$url = (Read-Host "Succeeded API URL").Trim()

Write-Host ""
Write-Host "Test A: PowerShell Invoke-WebRequest"
try {
  $response = Invoke-WebRequest -UseBasicParsing -Uri $url -Headers @{
    "User-Agent" = "Mozilla/5.0"
  }
  Write-Host ("status: " + [int]$response.StatusCode)
  $json = $response.Content | ConvertFrom-Json
  Write-Host ("count: " + $json.count)
  Write-Host ("items returned: " + $json.Items.Count)
} catch {
  if ($_.Exception.Response) {
    Write-Host ("status: " + [int]$_.Exception.Response.StatusCode)
  }
  Write-Host ("error: " + $_.Exception.Message)
}

Write-Host ""
Write-Host "Test B: curl.exe"
try {
  $curlOutput = & curl.exe -s -L -A "Mozilla/5.0" -w "`nHTTP_STATUS:%{http_code}" $url
  $statusLine = $curlOutput | Select-String -Pattern "HTTP_STATUS:"
  $body = ($curlOutput -replace "HTTP_STATUS:\d+\s*$", "").Trim()
  Write-Host $statusLine
  if ($body.StartsWith("{")) {
    $json = $body | ConvertFrom-Json
    if ($json.count -ne $null) {
      Write-Host ("count: " + $json.count)
      Write-Host ("items returned: " + $json.Items.Count)
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
} catch {
  Write-Host ("error: " + $_.Exception.Message)
}
