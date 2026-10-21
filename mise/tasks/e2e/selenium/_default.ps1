# PowerShell sibling of mise/tasks/e2e/selenium/_default.
#MISE description="Run all Selenium E2E scenarios in order"
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
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& mise -E web-e2e exec -- `
    node tests/e2e/fixtures/web-calculator/lifecycle.mjs `
    npm --prefix tests/e2e/selenium run web-calculator -- @args
exit $LASTEXITCODE
