$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$distDir = Join-Path $root "dist"
$appDir = Join-Path $distDir "host-app"
$scriptsDir = Join-Path $appDir "scripts"

Write-Host "[build] cleaning dist folder..."
if (Test-Path $distDir) {
  Remove-Item -Recurse -Force $distDir
}

Write-Host "[build] installing dependencies..."
Push-Location $root
npm install
if ($LASTEXITCODE -ne 0) {
  throw "npm install failed with exit code $LASTEXITCODE"
}

Write-Host "[build] packaging executable..."
npx pkg . --targets node18-win-x64 --output (Join-Path $distDir "remote-agent.exe")
if ($LASTEXITCODE -ne 0) {
  throw "pkg build failed with exit code $LASTEXITCODE"
}

Write-Host "[build] assembling host-app bundle..."
New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null

Copy-Item -Path (Join-Path $root "scripts\windowsInputBridge.ps1") -Destination $scriptsDir -Force

$sourceEnvPath = Join-Path $root ".env"
if (Test-Path $sourceEnvPath) {
  Copy-Item -Path $sourceEnvPath -Destination (Join-Path $appDir ".env") -Force
} else {
@"
REMOTE_SERVER_URL=https://calling-app-backend-1.onrender.com
REMOTE_HOST_ID=host1
REMOTE_FPS=6
REMOTE_CONTROL_TOKEN=change-me
"@ | Set-Content -Path (Join-Path $appDir ".env") -Encoding ASCII
}

@"
REMOTE_SERVER_URL=https://calling-app-backend-1.onrender.com
REMOTE_HOST_ID=host1
REMOTE_FPS=6
REMOTE_CONTROL_TOKEN=change-me
"@ | Set-Content -Path (Join-Path $appDir ".env.template") -Encoding ASCII

@"
@echo off
setlocal
cd /d "%~dp0"
if not exist ".env" (
  if exist ".env.template" (
    copy ".env.template" ".env" >nul
    echo [host-app] .env was missing and was restored from .env.template.
  ) else (
    echo [host-app] .env not found.
    pause
    exit /b 1
  )
)
remote-agent.exe
"@ | Set-Content -Path (Join-Path $appDir "start-agent.bat") -Encoding ASCII

Move-Item -Path (Join-Path $distDir "remote-agent.exe") -Destination (Join-Path $appDir "remote-agent.exe") -Force

Write-Host "[build] done."
Write-Host "[build] output: $appDir"
Pop-Location
