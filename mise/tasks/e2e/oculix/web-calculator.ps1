# PowerShell sibling of mise/tasks/e2e/oculix/web-calculator.
# Phase 1 is Ubuntu-only; Windows rejects the capability before launch.
#MISE description="Run the Oculix web calculator scenario for a capability"
#USAGE flag "--os <os>" required=#true help="Capability operating system" {
#USAGE   choices "ubuntu"
#USAGE }
#USAGE flag "--browser <browser>" required=#true help="Capability browser" {
#USAGE   choices "chromium"
#USAGE }
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$selectedOs = $env:usage_os
$selectedBrowser = $env:usage_browser
$capability = "${selectedOs}-${selectedBrowser}"
if ($capability -ne "ubuntu-chromium") {
    throw "Unsupported Oculix web-calculator capability: ${capability}."
}
if (-not $IsLinux) {
    throw "Oculix web-calculator capability ubuntu-chromium requires Linux."
}

$task = Join-Path $env:MISE_PROJECT_ROOT "mise/tasks/e2e/oculix/web-calculator"
& bash $task
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
