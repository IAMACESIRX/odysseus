# Run Odysseus from a desktop shortcut.
# Keep this file in the Odysseus project root next to app.py.

$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $ProjectRoot

$Host.UI.RawUI.WindowTitle = 'Odysseus Server'

function Test-CommandExists {
    param([string]$Name)
    $null -ne (Get-Command $Name -ErrorAction SilentlyContinue)
}

function Open-OdysseusWhenReady {
    param(
        [string]$Url = 'http://127.0.0.1:7000',
        [int]$TimeoutSeconds = 45
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
            if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
                Start-Process $Url
                return
            }
        } catch {
            Start-Sleep -Milliseconds 700
        }
    }

    Start-Process $Url
}

Write-Host ''
Write-Host '========================================'
Write-Host 'Starting Odysseus'
Write-Host 'Project:' $ProjectRoot
Write-Host 'URL: http://127.0.0.1:7000'
Write-Host '========================================'
Write-Host ''

# If Odysseus already has a Windows launcher, prefer it.
$Launcher = Join-Path $ProjectRoot 'launch-windows.ps1'
if (Test-Path $Launcher) {
    Write-Host 'Using launch-windows.ps1'
    Start-Job -ScriptBlock { param($url) Start-Sleep -Seconds 3; Start-Process $url } -ArgumentList 'http://127.0.0.1:7000' | Out-Null
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $Launcher
    exit $LASTEXITCODE
}

# Otherwise activate a virtual environment if present.
$VenvActivate = Join-Path $ProjectRoot '.venv\Scripts\Activate.ps1'
if (-not (Test-Path $VenvActivate)) {
    $VenvActivate = Join-Path $ProjectRoot 'venv\Scripts\Activate.ps1'
}

if (Test-Path $VenvActivate) {
    Write-Host 'Activating virtual environment:' $VenvActivate
    . $VenvActivate
} else {
    Write-Host 'No .venv or venv activation script found. Using system Python.'
}

# Open the browser once the local server responds.
Start-Job -ScriptBlock {
    param($root)
    Set-Location $root
    function Wait-And-Open {
        $url = 'http://127.0.0.1:7000'
        $deadline = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $deadline) {
            try {
                $r = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
                if ($r.StatusCode -ge 200 -and $r.StatusCode -lt 500) {
                    Start-Process $url
                    return
                }
            } catch {
                Start-Sleep -Milliseconds 700
            }
        }
        Start-Process $url
    }
    Wait-And-Open
} -ArgumentList $ProjectRoot | Out-Null

# Prefer py launcher when available because Python 3.11+ can be selected reliably.
if (Test-CommandExists 'py') {
    py -3.11 -m uvicorn app:app --host 127.0.0.1 --port 7000
    if ($LASTEXITCODE -eq 0) { exit 0 }
    Write-Host 'py -3.11 failed or Python 3.11 not found; falling back to python.'
}

python -m uvicorn app:app --host 127.0.0.1 --port 7000
exit $LASTEXITCODE
