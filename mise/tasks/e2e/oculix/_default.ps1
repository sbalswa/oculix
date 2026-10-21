# PowerShell sibling of mise/tasks/e2e/oculix/_default.
# Phase 1 web-calculator is Ubuntu-only. Matrix CI calls its parameterized
# leaf directly, so the Windows aggregate retains smoke and native-calculator.
#MISE description="Run supported Oculix E2E scenarios in order"
$ErrorActionPreference = "Stop"

& mise run e2e:oculix:smoke
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

& mise run e2e:oculix:native-calculator
exit $LASTEXITCODE
