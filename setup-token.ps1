# Creates the shared push token in one go:
#   1. generates a random token,
#   2. stores it as the Worker's PUSH_TOKEN secret,
#   3. writes it into agent/config.toml (created from the example if missing),
#   4. checks the Worker accepts it.
# The token is never printed. Run it again any time to rotate the token.
#
#   powershell -ExecutionPolicy Bypass -File setup-token.ps1

$ErrorActionPreference = "Stop"
$root = $PSScriptRoot

$bytes = New-Object byte[] 32
[Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
$token = -join ($bytes | ForEach-Object { $_.ToString("x2") })

Write-Host "Storing PUSH_TOKEN as a Worker secret..."
Push-Location (Join-Path $root "worker")
try {
    # stdin, so the token never appears on the command line or in history
    $token | npx --yes wrangler@4 secret put PUSH_TOKEN | Out-Host
    if ($LASTEXITCODE -ne 0) {
        # Some terminals make wrangler treat piped input as "non-interactive"
        # and ignore the browser login. Run it interactively instead and let
        # the user paste the token from the clipboard into its hidden prompt.
        Write-Host ""
        Write-Host "Piping didn't work in this terminal. The token is now on your clipboard." -ForegroundColor Yellow
        Write-Host "When wrangler asks for the secret value: press Ctrl+V, then Enter." -ForegroundColor Yellow
        Write-Host "(If it asks you to log in first, allow it in the browser.)" -ForegroundColor Yellow
        Write-Host ""
        Set-Clipboard -Value $token
        try {
            npx --yes wrangler@4 secret put PUSH_TOKEN
            if ($LASTEXITCODE -ne 0) { throw "wrangler secret put failed" }
        } finally {
            Set-Clipboard -Value " "  # don't leave the token lying around
            Write-Host "Clipboard cleared."
        }
    }
} finally {
    Pop-Location
}

$config = Join-Path $root "agent\config.toml"
if (-not (Test-Path $config)) {
    Copy-Item (Join-Path $root "agent\config.example.toml") $config
}
$text = [IO.File]::ReadAllText($config)
$pattern = [regex]'(?m)^token\s*=\s*"[^"]*"'
if (-not $pattern.IsMatch($text)) { throw "no 'token = ...' line found in $config" }
$text = $pattern.Replace($text, "token = `"$token`"", 1)
[IO.File]::WriteAllText($config, $text, (New-Object Text.UTF8Encoding $false))
Write-Host "Wrote the token into agent\config.toml"

$url = ([regex]'(?m)^url\s*=\s*"([^"]*)"').Match($text).Groups[1].Value.TrimEnd("/")
Write-Host "Checking $url accepts it (secrets can take a few seconds to apply)..."
$ok = $false
foreach ($attempt in 1..6) {
    try {
        $body = '{"player":{"online":false},"note":"setup-token check"}'
        Invoke-RestMethod -Method Post -Uri "$url/status" -Body $body -ContentType "application/json" `
            -Headers @{ Authorization = "Bearer $token" } | Out-Null
        $ok = $true
        break
    } catch {
        Start-Sleep -Seconds 5
    }
}
$token = $null
if ($ok) { Write-Host "OK - the Worker accepted the token." -ForegroundColor Green }
else { Write-Host "The Worker did not accept the token yet. Wait a minute and run the agent with --once to check." -ForegroundColor Yellow }
