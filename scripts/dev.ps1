# Local dev helper for people who work on multiple Discord bots.
#
# This loads `.env` and `.env.local` into the current PowerShell process before
# starting the app, so per-repo creds win over any user/machine environment vars.

[CmdletBinding()]
param(
  [switch]$Mock,
  [switch]$SkipDocker,
  [switch]$PrintEnv
)

$ErrorActionPreference = "Stop"

function Import-DotenvFile {
  param([string]$Path)

  $vars = @{}
  if (-not (Test-Path -LiteralPath $Path)) {
    return $vars
  }

  foreach ($rawLine in Get-Content -LiteralPath $Path) {
    $line = $rawLine.Trim()
    if ($line.Length -eq 0) { continue }
    if ($line.StartsWith("#")) { continue }
    if ($line.StartsWith("export ")) { $line = $line.Substring(7).Trim() }

    $eqIndex = $line.IndexOf("=")
    if ($eqIndex -lt 1) { continue }

    $key = $line.Substring(0, $eqIndex).Trim()
    $value = $line.Substring($eqIndex + 1).Trim()
    if ($key.Length -eq 0) { continue }

    if (
      ($value.StartsWith('"') -and $value.EndsWith('"')) -or
      ($value.StartsWith("'") -and $value.EndsWith("'"))
    ) {
      $value = $value.Substring(1, $value.Length - 2)
    }

    $vars[$key] = $value
  }

  return $vars
}

function Set-EnvVars {
  param([hashtable]$Vars)

  foreach ($key in $Vars.Keys) {
    Set-Item -Path "Env:$key" -Value $Vars[$key]
  }
}

function Format-EnvValue {
  param([string]$Key, [string]$Value)

  $redact = @(
    "DISCORD_BOT_TOKEN",
    "DISCORD_CLIENT_SECRET",
    "OPENAI_API_KEY",
    "LANGFUSE_SECRET_KEY",
    "OAUTH_SECRET",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET"
  )
  if ($redact -contains $Key) { return "(redacted)" }
  return $Value
}

$repoRoot = Split-Path -Parent $PSScriptRoot
Set-Location -LiteralPath $repoRoot

# Base env, then local overrides.
$envVars = @{}
$baseVars = Import-DotenvFile -Path ".env"
foreach ($k in $baseVars.Keys) { $envVars[$k] = $baseVars[$k] }

$localVars = Import-DotenvFile -Path ".env.local"
foreach ($k in $localVars.Keys) { $envVars[$k] = $localVars[$k] }

Set-EnvVars -Vars $envVars

if ($PrintEnv) {
  $keys = @(
    "DISCORD_CLIENT_ID",
    "DISCORD_BOT_TOKEN",
    "OPENAI_API_KEY",
    "USE_LOCAL_DYNAMODB",
    "ENABLE_OAUTH",
    "PORT"
  )
  Write-Host "Loaded env (from .env / .env.local):"
  foreach ($key in $keys) {
    $value = (Get-Item -Path "Env:$key" -ErrorAction SilentlyContinue).Value
    if ($null -eq $value -or $value -eq "") {
      Write-Host ("- {0}=<unset>" -f $key)
      continue
    }
    Write-Host ("- {0}={1}" -f $key, (Format-EnvValue -Key $key -Value $value))
  }
}

$command = "yarn dev"
if ($Mock) {
  $command = "yarn dev:mock"
}
if ($SkipDocker) {
  if ($Mock) {
    $command = "yarn start:mock"
  } else {
    $command = "yarn start"
  }
}

Write-Host ("Running: {0}" -f $command)
cmd.exe /c $command
