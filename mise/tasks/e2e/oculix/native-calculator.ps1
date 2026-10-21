# PowerShell sibling of mise/tasks/e2e/oculix/native-calculator.
#MISE description="Run the Oculix native Calculator scenario"
$ErrorActionPreference = "Stop"

& mise run oculix:run tests/e2e/oculix/native-calculator.sikuli
exit $LASTEXITCODE
