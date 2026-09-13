# Starts the mc-status agent whenever you log in to Windows.
#
#   powershell -ExecutionPolicy Bypass -File agent\install-windows.ps1
#
# Runs as your user with no console window; logs go to agent\agent.log.
# To remove it again:
#   Unregister-ScheduledTask -TaskName "mc-status agent" -Confirm:$false

param(
    [string]$Python = (Join-Path $PSScriptRoot ".venv\Scripts\pythonw.exe"),
    [string]$Config = (Join-Path $PSScriptRoot "config.toml")
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Python)) {
    throw "No Python at $Python. Create the venv first: python -m venv agent\.venv; agent\.venv\Scripts\pip install -r agent\requirements.txt"
}
if (-not (Test-Path $Config)) {
    throw "No config at $Config. Copy config.example.toml to config.toml and fill it in."
}

$agent = Join-Path $PSScriptRoot "agent.py"
$log = Join-Path $PSScriptRoot "agent.log"
$action = New-ScheduledTaskAction -Execute $Python `
    -Argument "`"$agent`" --config `"$Config`" --log-file `"$log`"" `
    -WorkingDirectory $PSScriptRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName "mc-status agent" -Action $action -Trigger $trigger -Settings $settings `
    -Description "Pushes Minecraft and machine status to the mc-status Worker." -Force | Out-Null
Start-ScheduledTask -TaskName "mc-status agent"
Write-Host "mc-status agent installed and started. Log: $log"
