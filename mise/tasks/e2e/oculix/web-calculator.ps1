# PowerShell sibling of mise/tasks/e2e/oculix/web-calculator.
# Phase 1 is Ubuntu-only; Windows rejects the capability before launch.
#MISE description="Run the Oculix web calculator scenario for a capability"
#USAGE flag "--os <os>" help="Capability operating system"
#USAGE flag "--browser <browser>" help="Capability browser"
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$cliOs = $env:usage_os
$cliBrowser = $env:usage_browser
$environmentOs = $env:E2E_OS
$environmentBrowser = $env:E2E_BROWSER
if ($cliOs -and $environmentOs -and $cliOs -ne $environmentOs) {
    throw "Conflicting OS inputs: --os '${cliOs}' and E2E_OS '${environmentOs}'."
}
if (
    $cliBrowser -and
    $environmentBrowser -and
    $cliBrowser -ne $environmentBrowser
) {
    throw (
        "Conflicting browser inputs: --browser '${cliBrowser}' and " +
        "E2E_BROWSER '${environmentBrowser}'."
    )
}

$selectedOs = if ($cliOs) { $cliOs } else { $environmentOs }
$selectedBrowser = if ($cliBrowser) { $cliBrowser } else { $environmentBrowser }
if (-not $selectedOs) {
    throw "Select an OS with --os or E2E_OS."
}
if (-not $selectedBrowser) {
    throw "Select a browser with --browser or E2E_BROWSER."
}

$capability = "${selectedOs}-${selectedBrowser}"
if ($capability -ne "ubuntu-chromium") {
    throw "Unsupported Oculix web-calculator capability: ${capability}."
}
if (-not $IsLinux) {
    throw "Oculix web-calculator capability ubuntu-chromium requires Linux."
}
$osReleasePath = "/etc/os-release"
if (-not (Test-Path -LiteralPath $osReleasePath -PathType Leaf)) {
    throw "Oculix web-calculator requires ${osReleasePath}."
}
$idLine = Get-Content -LiteralPath $osReleasePath |
    Where-Object { $_ -match "^ID=" } |
    Select-Object -First 1
if ($null -eq $idLine) {
    throw "${osReleasePath} does not declare ID."
}
$hostOs = $idLine.Substring(3).Trim().Trim('"')
if ($hostOs -ne $selectedOs) {
    throw "Declared OS '${selectedOs}' does not match host OS '${hostOs}'."
}

$task = Join-Path $env:MISE_PROJECT_ROOT "mise/tasks/e2e/oculix/web-calculator"
& bash $task
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
