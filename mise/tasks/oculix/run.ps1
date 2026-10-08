# PowerShell sibling of mise/tasks/oculix/run (no shebang / not executable on
# Unix so mise pairs it as one oculix:run task; Windows selects this file).
$ErrorActionPreference = "Stop"

if (-not $env:MISE_PROJECT_ROOT) {
    throw "MISE_PROJECT_ROOT is required"
}
Set-Location -LiteralPath $env:MISE_PROJECT_ROOT

$script = if ($args.Count -gt 0) {
    $args[0]
} else {
    "tests/e2e/oculix/basic.sikuli"
}
$oculixDirectory = & mise where http:oculixide
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}

$temporaryBase = if ($env:RUNNER_TEMP) {
    $env:RUNNER_TEMP
} else {
    Join-Path $HOME "tmp"
}
$temporaryDirectory = Join-Path $temporaryBase "oculix"
[System.IO.Directory]::CreateDirectory($temporaryDirectory) | Out-Null

$jars = @(Get-ChildItem -LiteralPath $oculixDirectory -Filter "*.jar" -File)
if ($jars.Count -ne 1) {
    throw "Expected exactly one Oculix jar in ${oculixDirectory}; found $($jars.Count)."
}

& java "-Djava.io.tmpdir=$temporaryDirectory" `
    -jar $jars[0].FullName -c -r $script
exit $LASTEXITCODE
