@echo off
:: OpenWhispr first-run setup. Run this once after extracting the zip.
:: It does three things:
::   1. Strips Mark-of-the-Web from every extracted file (so SmartScreen
::      stops blocking OpenWhispr.exe and the bundled binaries).
::   2. Creates a Start Menu shortcut so you can launch via Windows search.
::   3. Launches OpenWhispr.
:: Re-running it later is harmless — Unblock-File is idempotent and the
:: shortcut creation is skipped if it already exists.

title OpenWhispr Setup

echo.
echo Setting up OpenWhispr (one-time, ~5 seconds)...
echo.

powershell.exe -ExecutionPolicy Bypass -NoProfile -Command "& { $d = '%~dp0'.TrimEnd('\'); Get-ChildItem -LiteralPath $d -Recurse -Force | Unblock-File; $lnk = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\OpenWhispr.lnk'; if (-not (Test-Path $lnk)) { $shell = New-Object -ComObject WScript.Shell; $sc = $shell.CreateShortcut($lnk); $sc.TargetPath = (Join-Path $d 'OpenWhispr.exe'); $sc.WorkingDirectory = $d; $sc.IconLocation = (Join-Path $d 'OpenWhispr.exe'); $sc.Save(); Write-Host 'Start Menu shortcut created.' } else { Write-Host 'Start Menu shortcut already present.' } }"

echo.
echo Launching OpenWhispr...
start "" "%~dp0OpenWhispr.exe"

exit
