# PowerShell sibling of mise/tasks/github/e2e-labels.
#MISE description="Dry-run, check, or synchronize catalog-derived E2E labels"
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

& mise -E web-e2e exec -- `
    node .github/scripts/sync-e2e-labels.mjs @args
exit $LASTEXITCODE
