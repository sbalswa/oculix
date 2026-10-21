# PowerShell sibling of mise/tasks/e2e/playwright/web-calculator.
#MISE description="Run the Playwright web calculator scenario"
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

& mise -E web-e2e exec -- `
    node tests/e2e/playwright/harness.mjs scenario web-calculator @args
exit $LASTEXITCODE
