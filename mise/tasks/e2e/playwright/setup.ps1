# PowerShell sibling of mise/tasks/e2e/playwright/setup.
#MISE description="Provision Playwright dependencies and the selected browser"
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

& mise -E web-e2e exec -- `
    node tests/e2e/playwright/harness.mjs prepare @args
exit $LASTEXITCODE
