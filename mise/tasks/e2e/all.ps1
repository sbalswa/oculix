# PowerShell sibling of mise/tasks/e2e/all.
#MISE description="Run the four Phase 1 E2E tool aggregates on Ubuntu"
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

$isUbuntu = $IsLinux -and (
    Select-String `
        -Path "/etc/os-release" `
        -Pattern '^ID="?ubuntu"?$' `
        -Quiet
)
if (-not $isUbuntu) {
    throw "e2e:all currently supports the Phase 1 Ubuntu capabilities only."
}

$task = Join-Path $env:MISE_PROJECT_ROOT "mise/tasks/e2e/all"
& bash $task
exit $LASTEXITCODE
