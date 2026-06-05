# Creates a Windows desktop shortcut for launching Odysseus.
# Run from the Odysseus project root, next to app.py.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$RunScript = Join-Path $ProjectRoot 'run-odysseus-desktop.ps1'

if (-not (Test-Path (Join-Path $ProjectRoot 'app.py'))) {
    throw "This script must live in the Odysseus project root next to app.py. Current path: $ProjectRoot"
}

if (-not (Test-Path $RunScript)) {
    throw "Missing run-odysseus-desktop.ps1 next to this installer. Expected: $RunScript"
}

# Unblock scripts if they came from a downloaded zip.
try {
    Unblock-File -Path $RunScript -ErrorAction SilentlyContinue
    Unblock-File -Path $MyInvocation.MyCommand.Path -ErrorAction SilentlyContinue
} catch {}

$Desktop = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $Desktop 'Run Odysseus.lnk'
$IconPath = Join-Path $ProjectRoot 'static\favicon.ico'
if (-not (Test-Path $IconPath)) {
    $IconPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
}

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$Shortcut.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$RunScript`""
$Shortcut.WorkingDirectory = $ProjectRoot
$Shortcut.WindowStyle = 1
$Shortcut.Description = 'Run the local Odysseus web app and open it in the browser.'
$Shortcut.IconLocation = $IconPath
$Shortcut.Save()

Write-Host ''
Write-Host 'Created desktop shortcut:' $ShortcutPath
Write-Host ''
Write-Host 'Double-click "Run Odysseus" on your desktop to start Odysseus.'
Write-Host ''
