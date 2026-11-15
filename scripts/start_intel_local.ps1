param(
    [ValidateSet(5, 10, 15)][int]$MaximumRadiusKm = 15,
    [int]$Port = 8000,
    [switch]$DisablePreparation
)

$ErrorActionPreference = 'Stop'
$lumenRoot = Split-Path -Parent $PSScriptRoot
$lumenPython = Join-Path $lumenRoot '.venv/Scripts/python.exe'
if (-not (Test-Path -LiteralPath $lumenPython)) { throw 'Create the project Python environment first.' }
if (-not (Test-Path -LiteralPath (Join-Path $lumenRoot 'apps/web/dist/index.html'))) {
    throw 'Build the web application with npm run build first.'
}
$env:LUMEN_MAXIMUM_RADIUS_KM = "$MaximumRadiusKm"
$env:LUMEN_BACKGROUND_PREPARATION = $(if ($DisablePreparation) { '0' } else { '1' })
$env:LUMEN_REUSE_WORKER = '1'
& $lumenPython -m uvicorn app.main:app --app-dir (Join-Path $lumenRoot 'backend') --host 127.0.0.1 --port $Port
