#MISE description="Reject Cypress smoke on Windows pending #15 validation"
$ErrorActionPreference = "Stop"

throw "Cypress E2E is unsupported on Windows until #15 adds native hosted validation; no child process was started."
