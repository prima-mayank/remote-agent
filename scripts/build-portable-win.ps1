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

function Get-EnvValue {
  param(
    [string]$FilePath,
    [string]$Key
  )

  if (-not (Test-Path $FilePath)) {
    return ""
  }

  $escapedKey = [regex]::Escape($Key)
  $line = Get-Content $FilePath |
    Where-Object { $_ -match "^\s*$escapedKey\s*=" } |
    Select-Object -First 1

  if (-not $line) {
    return ""
  }

  return ($line -replace "^\s*$escapedKey\s*=\s*", "").Trim()
}

$resolvedServerUrl = "https://calling-app-backend-1.onrender.com"
$envServerUrl = ""
if (Test-Path $sourceEnvPath) {
  $envServerUrl = Get-EnvValue -FilePath $sourceEnvPath -Key "REMOTE_SERVER_URL"
}
if (-not [string]::IsNullOrWhiteSpace($env:REMOTE_AGENT_BUILD_SERVER_URL)) {
  $resolvedServerUrl = $env:REMOTE_AGENT_BUILD_SERVER_URL.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($envServerUrl)) {
  $resolvedServerUrl = $envServerUrl
} elseif (-not [string]::IsNullOrWhiteSpace($env:REMOTE_SERVER_URL)) {
  $resolvedServerUrl = $env:REMOTE_SERVER_URL.Trim()
}

$resolvedFps = "10"
$envFps = ""
if (Test-Path $sourceEnvPath) {
  $envFps = Get-EnvValue -FilePath $sourceEnvPath -Key "REMOTE_FPS"
}
if (-not [string]::IsNullOrWhiteSpace($env:REMOTE_AGENT_BUILD_FPS)) {
  $resolvedFps = $env:REMOTE_AGENT_BUILD_FPS.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($envFps)) {
  $resolvedFps = $envFps
} elseif (-not [string]::IsNullOrWhiteSpace($env:REMOTE_FPS)) {
  $resolvedFps = $env:REMOTE_FPS.Trim()
}

$resolvedPerfMode = "auto"
$envPerfMode = ""
if (Test-Path $sourceEnvPath) {
  $envPerfMode = Get-EnvValue -FilePath $sourceEnvPath -Key "REMOTE_PERF_MODE"
}
if (-not [string]::IsNullOrWhiteSpace($env:REMOTE_AGENT_BUILD_PERF_MODE)) {
  $resolvedPerfMode = $env:REMOTE_AGENT_BUILD_PERF_MODE.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($envPerfMode)) {
  $resolvedPerfMode = $envPerfMode
} elseif (-not [string]::IsNullOrWhiteSpace($env:REMOTE_PERF_MODE)) {
  $resolvedPerfMode = $env:REMOTE_PERF_MODE.Trim()
}

$resolvedRemoteControlToken = ""
$envToken = ""
if (Test-Path $sourceEnvPath) {
  $envToken = Get-EnvValue -FilePath $sourceEnvPath -Key "REMOTE_CONTROL_TOKEN"
}
if (-not [string]::IsNullOrWhiteSpace($env:REMOTE_AGENT_BUILD_REMOTE_CONTROL_TOKEN)) {
  $resolvedRemoteControlToken = $env:REMOTE_AGENT_BUILD_REMOTE_CONTROL_TOKEN.Trim()
} elseif (-not [string]::IsNullOrWhiteSpace($envToken)) {
  $resolvedRemoteControlToken = $envToken
} elseif (-not [string]::IsNullOrWhiteSpace($env:REMOTE_CONTROL_TOKEN)) {
  $resolvedRemoteControlToken = $env:REMOTE_CONTROL_TOKEN.Trim()
}

if ([string]::IsNullOrWhiteSpace($resolvedRemoteControlToken)) {
  $resolvedRemoteControlToken = "change-me"
  Write-Warning "[build] REMOTE_CONTROL_TOKEN not found in env vars or remote-agent/.env. Using placeholder 'change-me'."
}

$generatedEnvBody = @"
REMOTE_SERVER_URL=$resolvedServerUrl
REMOTE_HOST_ID=
REMOTE_FPS=$resolvedFps
REMOTE_PERF_MODE=$resolvedPerfMode
REMOTE_CONTROL_TOKEN=$resolvedRemoteControlToken
# REMOTE_DEBUG=1
"@

# By default, do NOT ship a developer's local `.env` inside the portable bundle.
# If you intentionally want to embed your local `.env`, set `REMOTE_AGENT_COPY_ENV=1` when running the build.
$copyLocalEnv = ($env:REMOTE_AGENT_COPY_ENV -eq "1")
if ($copyLocalEnv -and (Test-Path $sourceEnvPath)) {
  Copy-Item -Path $sourceEnvPath -Destination (Join-Path $appDir ".env") -Force
} else {
  $generatedEnvBody | Set-Content -Path (Join-Path $appDir ".env") -Encoding ASCII
}

$generatedEnvBody | Set-Content -Path (Join-Path $appDir ".env.template") -Encoding ASCII

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
set "HOSTAPP_COMMAND=\"%~f0\" \"%%1\""
reg add "HKCU\Software\Classes\hostapp" /ve /d "URL:Calling App Host Launcher" /f >nul 2>&1
reg add "HKCU\Software\Classes\hostapp" /v "URL Protocol" /d "" /f >nul 2>&1
reg add "HKCU\Software\Classes\hostapp\DefaultIcon" /ve /d "\"%~dp0remote-agent.exe\",0" /f >nul 2>&1
reg add "HKCU\Software\Classes\hostapp\shell\open\command" /ve /d "%HOSTAPP_COMMAND%" /f >nul 2>&1
if "%~1"=="" (
  remote-agent.exe
) else (
  remote-agent.exe "%~1"
)
"@ | Set-Content -Path (Join-Path $appDir "start-agent.bat") -Encoding ASCII

Move-Item -Path (Join-Path $distDir "remote-agent.exe") -Destination (Join-Path $appDir "remote-agent.exe") -Force

Write-Host "[build] done."
Write-Host "[build] output: $appDir"
Pop-Location
