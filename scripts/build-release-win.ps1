$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDir = Join-Path $root "dist"
$appDir = Join-Path $distDir "host-app"
$zipPath = Join-Path $distDir "host-app-win.zip"

Push-Location $root

Write-Host "[release] building host app..."
npm run build:win
if ($LASTEXITCODE -ne 0) {
  throw "build:win failed with exit code $LASTEXITCODE"
}

if (-not (Test-Path $appDir)) {
  throw "Expected output directory not found: $appDir"
}

if (Test-Path $zipPath) {
  Remove-Item -Force $zipPath
}

Write-Host "[release] creating zip..."
Compress-Archive -Path (Join-Path $appDir "*") -DestinationPath $zipPath -Force

Write-Host "[release] done."
Write-Host "[release] artifact: $zipPath"

Pop-Location
