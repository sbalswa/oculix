# PowerShell sibling of mise/tasks/e2e/oculix/_default.
#MISE description="Run all Oculix E2E scenarios in order"
$ErrorActionPreference = "Stop"

& mise run e2e:oculix:smoke
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& mise run e2e:oculix:native-calculator
exit $LASTEXITCODE
