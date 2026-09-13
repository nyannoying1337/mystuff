# Creates (or rotates) the invite key for watching live, and prints the invite link.
#   1. generates a random key and puts it on your clipboard,
#   2. wrangler asks for the secret value: press Ctrl+V, then Enter,
#   3. the clipboard is cleared and the invite link is printed.
# Running it again gives a new link and disconnects everyone using the old one.
#
#   powershell -ExecutionPolicy Bypass -File setup-view-key.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$site = "https://nyannoying.de"

$bytes = New-Object byte[] 18
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
# URL-safe, no padding: fits cleanly in a link
$key = [Convert]::ToBase64String($bytes).Replace("+", "-").Replace("/", "_").TrimEnd("=")

Write-Host "The new invite key is on your clipboard." -ForegroundColor Yellow
Write-Host "When wrangler asks for the secret value: press Ctrl+V, then Enter." -ForegroundColor Yellow
Write-Host "(If it asks you to log in first, allow it in the browser.)" -ForegroundColor Yellow
Write-Host ""
Set-Clipboard -Value $key
Push-Location (Join-Path $root "worker")
try {
    npx --yes wrangler@4 secret put VIEW_KEY
    if ($LASTEXITCODE -ne 0) { throw "wrangler secret put failed" }
} finally {
    Set-Clipboard -Value " "
    Pop-Location
}

Write-Host ""
Write-Host "Checking the Worker accepts it..."
$ok = $false
foreach ($attempt in 1..6) {
    try {
        Invoke-RestMethod -Uri "https://status-api.nyannoying.de/status?key=$key" | Out-Null
        $ok = $true
        break
    } catch {
        # 404 "never reported" still means the key was accepted
        if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 404) { $ok = $true; break }
        Start-Sleep -Seconds 5
    }
}

Write-Host ""
if ($ok) {
    Write-Host "Invite link (share it with the people who may watch):" -ForegroundColor Green
    Write-Host "  $site/#key=$key" -ForegroundColor Green
} else {
    Write-Host "The Worker didn't accept the key yet. Wait a minute; the link will be:" -ForegroundColor Yellow
    Write-Host "  $site/#key=$key"
}
$key = $null
