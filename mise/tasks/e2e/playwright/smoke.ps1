# PowerShell sibling of mise/tasks/e2e/playwright/smoke.
#MISE description="Run the Playwright browser smoke scenario"
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

& mise -E web-e2e exec -- `
    node tests/e2e/playwright/harness.mjs scenario smoke @args
exit $LASTEXITCODE
