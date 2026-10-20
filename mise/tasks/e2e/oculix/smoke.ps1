# PowerShell sibling of mise/tasks/e2e/oculix/smoke.
#MISE description="Run the Oculix smoke scenario"
$ErrorActionPreference = "Stop"

& mise run oculix:run tests/e2e/oculix/smoke.sikuli
exit $LASTEXITCODE
