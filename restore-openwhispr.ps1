# OpenWhispr NPU Build - Restore Script
# Restores the app from the backup zip in Documents\OpenWhispr-Backup.
# Run as your normal user — no elevation needed for LOCALAPPDATA install.
# Usage:  Right-click → "Run with PowerShell"  (or: pwsh -File restore-openwhispr.ps1)

$installDir = "$env:LOCALAPPDATA\Programs\OpenWhispr"
$zipFile    = "$env:USERPROFILE\Documents\OpenWhispr-Backup\OpenWhispr-NPU-backup.zip"

if (-not (Test-Path $zipFile)) {
    Write-Error "Backup zip not found at $zipFile — rebuild with: npm run pack (in the openwhispr repo)"
    exit 1
}

# Kill running instance
Get-Process | Where-Object { $_.Name -match "OpenWhispr|electron" } | ForEach-Object {
    Write-Host "Stopping $($_.Name) (PID $($_.Id))..."
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Get-Process | Where-Object { $_.Name -eq "python" } | ForEach-Object {
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

Write-Host "Removing existing install at $installDir ..."
if (Test-Path $installDir) { Remove-Item $installDir -Recurse -Force }
New-Item -ItemType Directory -Path $installDir -Force | Out-Null

Write-Host "Extracting backup..."
Expand-Archive -Path $zipFile -DestinationPath $installDir -Force

Write-Host ""
Write-Host "Done. Launch: $installDir\OpenWhispr.exe"
