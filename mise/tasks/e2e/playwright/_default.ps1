# PowerShell sibling of mise/tasks/e2e/playwright/_default.
#MISE description="Run all Playwright E2E scenarios in order"
$ErrorActionPreference = "Stop"

& mise run e2e:playwright:smoke @args
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& mise run e2e:playwright:web-calculator @args
exit $LASTEXITCODE
