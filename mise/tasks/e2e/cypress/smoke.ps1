# PowerShell sibling of mise/tasks/e2e/cypress/smoke.
#MISE description="Run the Cypress browser-independent smoke scenario"
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT
& mise -E web-e2e exec -- node tests/e2e/cypress/task.mjs smoke @args
exit $LASTEXITCODE
