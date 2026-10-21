# PowerShell sibling of mise/tasks/e2e/selenium/smoke.
#MISE description="Run the Selenium browser-independent smoke scenario"
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

& mise -E web-e2e exec -- npm ci --prefix tests/e2e/selenium
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& mise -E web-e2e exec -- `
    npm --prefix tests/e2e/selenium run smoke -- @args
exit $LASTEXITCODE
